const axios = require('axios');
const { setOverride, getAllOverrides } = require('./db');
const { lookupChannel, lookupChannelFuzzy } = require('./iptvOrgRef');

/**
 * Sanitizes a value for safe logging.
 * @param {string} str - The value to sanitize.
 * @return {string} A printable ASCII string limited to 200 characters.
 */
function sanitizeForLog(str) {
    if (!str) return '';
    return String(str)
        .replace(/[\r\n\t]/g, '?')
        .replace(/[^\x20-\x7E]/g, '?')  // Keep only printable ASCII
        .substring(0, 200);  // Limit length
}

// In-memory runtime cache for AI overrides
const globalAiCache = new Map();

/**
 * Resolves channel names into canonical base names using OpenRouter.
 * @param {Array<{name: string, scope: string}>} batchItems - Channel names and their parser-derived scopes.
 * @param {string} apiKey - OpenRouter API key.
 * @param {string} [model] - OpenRouter model to use.
 * @return {Object<string, string> | {__rateLimited: true}} A mapping of raw channel names to canonical base names, or a rate-limit marker when processing must stop.
 */
async function processAiBatch(batchItems, apiKey, model) {
    if (!apiKey) return {};

    // batchItems: [{ name, scope }] — scope is parser-computed (from group-title), AI must NOT invent it
    const prompt = `You are a channel deduplication engine. I will give you an array of {name, scope} pairs from messy IPTV strings.
Some of these are duplicates or backups of the same station.
For each entry, return a clean, canonical BASE NAME ONLY (no country/scope prefix, no underscore prefix) using lowercase letters and numbers only, no spaces (e.g., "skysportsf1", "hbo"). Do NOT include the scope in your answer.
Ensure alternate links, backups, and quality variations of the identical station receive the EXACT same base name so they collapse together.

Return ONLY a raw JSON object where the key is the name and the value is the clean base name. No markdown.

Input: ${JSON.stringify(batchItems)}`;

    try {
        console.log(`[AI Curator] Resolving duplicates for a batch of ${sanitizeForLog(batchItems.length)} channels...`);
        const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: model || "openrouter/free",
            messages: [{ role: "user", content: prompt }]
        }, {
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "HTTP-Referer": "https://iptvo.local",
                "Content-Type": "application/json"
            }
        });

        // OpenRouter returns content:null for safety refusals (finish_reason
        // "safety") and JSON wrapped in prose for others. Never assume content
        // is a string — the refusal shape (no JSON inside) must not crash the
        // whole batch queue cycle.
        const rawContent = res.data?.choices?.[0]?.message?.content;
        if (typeof rawContent !== 'string' || !rawContent.trim()) {
            console.error('[AI Curator] Empty or non-string content in response (refusal/finish_reason=safety).');
            return {};
        }
        let content = rawContent.trim();
        content = content.replace(/```json/g, '').replace(/```/g, '');

        const jsonStart = content.indexOf("{");
        const jsonEnd = content.lastIndexOf("}");
        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
            content = content.substring(jsonStart, jsonEnd + 1);
        } else {
            console.error(`[AI Curator] No JSON object found in response. Raw snippet: ${sanitizeForLog(content.substring(0, 300))}`);
            return {};
        }

        try {
            const parsed = JSON.parse(content);
            // The AI must return a JSON object mapping names → base names; arrays
            // or null would downstream be treated as (garbage) name entries.
            return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        } catch {
            console.error(`[AI Curator] response was not valid JSON. Raw snippet: ${sanitizeForLog(content)}`);
            return {};
        }
    } catch (e) {
        const status = e.response ? e.response.status : null;
        if (status === 429 || status === 402) {
            console.error(`[AI Curator] Rate limit or payment required (status ${status}) - stopping this cycle.`);
            return { __rateLimited: true };
        }
        console.error("[AI Curator Error] Failed to process batch:", sanitizeForLog(e.message));
        return {};
    }
}

/**
 * Normalizes flagged channel names and persists their canonical ID overrides.
 * @param {Array<{rawName: string, baseCleanName: string, cId: string, countryScopeKey?: string}>} dirtyChannels - Channels requiring normalization.
 * @param {string} configKey - Configuration identifier used for processing context.
 * @param {string} openrouterKey - OpenRouter API key used for AI normalization.
 */
// Guard against several concurrent 55k-channel queues stacking up and
// starving the request-serving event loop. Only one cycle at a time; a new
// trigger while one is active is dropped rather than queued.
let aiQueueRunning = false;

async function startAiQueue(dirtyChannels, configKey, openrouterKey, model) {
    if (!openrouterKey || !dirtyChannels || dirtyChannels.length === 0) return;
    if (aiQueueRunning) {
        console.log(`[AI Curator] Skipping new queue: a cycle is already running for another config.`);
        return;
    }
    aiQueueRunning = true;

    try {
        await runAiQueue(dirtyChannels, configKey, openrouterKey, model);
    } finally {
        aiQueueRunning = false;
    }
}

async function runAiQueue(dirtyChannels, configKey, openrouterKey, model) {
    if (!openrouterKey || !dirtyChannels || dirtyChannels.length === 0) return;

    console.log(`[AI Curator] Background queue triggered for ${sanitizeForLog(dirtyChannels.length)} stream evaluations...`);

    // 1. Conflict & Filter Detection
    const rawNamesByBase = new Map();
    const idCounts = new Map();

    dirtyChannels.forEach(ch => {
        // Group by baseCleanName
        if (!rawNamesByBase.has(ch.baseCleanName)) {
            rawNamesByBase.set(ch.baseCleanName, new Set());
        }
        rawNamesByBase.get(ch.baseCleanName).add(ch.rawName);

        // Count occurrences of ID
        idCounts.set(ch.cId, (idCounts.get(ch.cId) || 0) + 1);
    });

    const channelsToProcess = [];
    const overridesMap = new Map((await getAllOverrides()).map(o => [o.raw_name, { canonical_id: o.canonical_id, confidence: parseFloat(o.confidence) }]));

    // Cap the per-call scan so a single 55k-channel config cannot peg one CPU
    // core for hours in an unyielding loop. 8000 covers the worst realistic
    // case in well under a minute while still resolving the highest-priority
    // (most-conflicted) channels first.
    const ordered = dirtyChannels
        .map(ch => {
            const isAlt = /backup|alt|mirror/i.test(ch.rawName);
            const isShortOrUnknown = ch.baseCleanName === 'unknown' || ch.baseCleanName.length < 3;
            const hasBaseNameConflict = (rawNamesByBase.get(ch.baseCleanName)?.size || 0) > 1;
            const isOverMerged = (idCounts.get(ch.cId) || 0) > 3;
            const existing = overridesMap.get(ch.rawName) || null;
            const isLowConfidence = existing && existing.confidence < 0.5;
            let priority = 0;
            if (isOverMerged) priority += 3;
            if (hasBaseNameConflict) priority += 2;
            if (isAlt) priority += 1;
            if (isLowConfidence) priority += 1;
            if (isShortOrUnknown) priority += 1;
            return { ch, priority };
        })
        .sort((a, b) => b.priority - a.priority);
    const cap = 8000;
    const scan = ordered.slice(0, cap);

    for (let idx = 0; idx < scan.length; idx++) {
        const { ch, priority } = scan[idx];

        // Let the event loop breathe so request handling never fully stalls.
        if (idx % 500 === 0) {
            await new Promise(r => setTimeout(r, 0));
        }

        const isAlt = /backup|alt|mirror/i.test(ch.rawName);
        const isShortOrUnknown = ch.baseCleanName === 'unknown' || ch.baseCleanName.length < 3;
        const hasBaseNameConflict = (rawNamesByBase.get(ch.baseCleanName)?.size || 0) > 1;
        const isOverMerged = (idCounts.get(ch.cId) || 0) > 3;

        // Check if DB already has mapping and confidence is low
        const existing = overridesMap.get(ch.rawName) || null;
        const isLowConfidence = existing && existing.confidence < 0.5;
        const wasAlreadyMapped = !!existing && !isLowConfidence;

        // Check if iptv-org can match this channel (using cleaned name and country scope)
        const hasIptvOrgMatch = !!(lookupChannel(ch.baseCleanName, ch.countryScopeKey) || lookupChannelFuzzy(ch.baseCleanName, ch.countryScopeKey));

        if (hasIptvOrgMatch) {
            // Already has authoritative match, skip AI
            continue;
        }
        // Skip channels already persisted as a high-confidence override
        if (wasAlreadyMapped) continue;

        if (isAlt || isShortOrUnknown || hasBaseNameConflict || isOverMerged || isLowConfidence || !existing) {
            channelsToProcess.push({ name: ch.rawName, scope: ch.countryScopeKey || 'global', priority });
        }
    }

    const scopeMap = new Map(channelsToProcess.map(c => [c.name, c.scope]));
    const priorityMap = new Map();
    for (const item of channelsToProcess) {
        const existingPriority = priorityMap.get(item.name);
        if (existingPriority === undefined || item.priority > existingPriority) {
            priorityMap.set(item.name, item.priority);
        }
    }
    const uniqueToProcess = [...priorityMap.entries()].sort((a, b) => b[1] - a[1]).map(entry => ({ name: entry[0], scope: scopeMap.get(entry[0]) || 'global' }));
    if (uniqueToProcess.length === 0) {
        console.log(`[AI Curator] No flagged channels requiring processing for ${sanitizeForLog(configKey)} (all handled by iptv-org).`);
        return;
    }

    console.log(`[AI Curator] Flagged ${sanitizeForLog(uniqueToProcess.length)} channels for AI verification (no iptv-org match).`);

    for (let i = 0; i < uniqueToProcess.length; i += 100) {
        const batch = uniqueToProcess.slice(i, i + 100);
        const aiResults = await processAiBatch(batch, openrouterKey, model);
            if (aiResults.__rateLimited) {
                console.log(`[AI Curator] Stopping early due to rate limit. Processed ${sanitizeForLog(i)} of ${sanitizeForLog(uniqueToProcess.length)} channels this cycle.`);
                break;
            }

        const batchScopeMap = new Map(batch.map(b => [b.name, b.scope]));
        for (const [raw, cleanBase] of Object.entries(aiResults)) {
            if (cleanBase && typeof cleanBase === 'string' && cleanBase.length > 0) {
                const scope = batchScopeMap.get(raw) || 'global';
                const sanitizedBase = cleanBase.replace(/[^a-z0-9]/g, '');

                // Try to match the AI-cleaned name against iptv-org again
                // This helps channels that weren't matched initially but might match after AI normalization
                const iptvOrgMatch = lookupChannel(sanitizedBase, scope) || lookupChannelFuzzy(sanitizedBase, scope);

                let finalId;
                if (iptvOrgMatch) {
                    // AI-cleaned name now matches iptv-org! Use authoritative ID
                    finalId = `${iptvOrgMatch.countryScopeKey || 'global'}_${iptvOrgMatch.officialId}`;
                    console.log(`[AI Curator] AI-cleaned "${sanitizeForLog(raw)}" -> "${sanitizeForLog(sanitizedBase)}" now matches iptv-org: ${sanitizeForLog(iptvOrgMatch.officialId)} (${sanitizeForLog(iptvOrgMatch.countryScopeKey)})`);
                } else {
                    // No iptv-org match yet, use AI-generated canonical ID
                    finalId = `${scope}_${sanitizedBase}`;
                }

                globalAiCache.set(raw, finalId);
                await setOverride(raw, finalId, 0.85);
            }
        }

        // Drip-feed delay to respect OpenRouter API limits
        if (i + 100 < uniqueToProcess.length) {
            await new Promise(resolve => setTimeout(resolve, 8000));
        }
    }
    console.log(`[AI Curator] Finished override database update. Next reload will use the new mappings.`);
}

module.exports = { startAiQueue, globalAiCache };