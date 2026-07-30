const axios = require('axios');
const { getOverride, setOverride, getAllOverrides } = require('./db');

// In-memory runtime cache for AI overrides
const globalAiCache = new Map();

/**
 * Asks OpenRouter AI to resolve messy channel strings into a unified canonical ID format.
 */
async function processAiBatch(batchItems) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return {};

    // batchItems: [{ name, scope }] — scope is parser-computed (from group-title), AI must NOT invent it
    const prompt = `You are a channel deduplication engine. I will give you an array of {name, scope} pairs from messy IPTV strings.
    Some of these are duplicates or backups of the same station.
    For each entry, return a clean, canonical BASE NAME ONLY (no country/scope prefix, no underscore prefix) using lowercase letters and numbers only, no spaces (e.g., "skysportsf1", "hbo"). Do NOT include the scope in your answer.
    Ensure alternate links, backups, and quality variations of the identical station receive the EXACT same base name so they collapse together.

    Return ONLY a raw JSON object where the key is the name and the value is the clean base name. No markdown.

    Input: ${JSON.stringify(batchItems)}`;

    try {
        console.log(`[AI Curator] Resolving duplicates for a batch of ${batchItems.length} channels...`);
        const res = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: "openrouter/free",
            messages: [{ role: "user", content: prompt }]
        }, {
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "HTTP-Referer": "https://iptvo.local",
                "Content-Type": "application/json"
            }
        });

        let content = res.data.choices[0].message.content.trim();
        content = content.replace(/```json/g, '').replace(/```/g, ''); 
        
        const jsonStart = content.indexOf("{");
        const jsonEnd = content.lastIndexOf("}");
        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
            content = content.substring(jsonStart, jsonEnd + 1);
        } else {
            console.error(`[AI Curator] No JSON object found in response. Raw snippet: ${content.substring(0, 300)}`);
        }

        return JSON.parse(content);
    } catch (e) {
        const status = e.response ? e.response.status : null;
        if (status === 429 || status === 402) {
            console.error(`[AI Curator] Rate limit or payment required (status ${status}) - stopping this cycle.`);
            return { __rateLimited: true };
        }
        console.error("[AI Curator Error] Failed to process batch:", e.message);
        return {};
    }
}

/**
 * Background worker that processes unmapped or highly duplicated strings
 * @param {Array<{rawName: string, baseCleanName: string, cId: string}>} dirtyChannels
 */
async function startAiQueue(dirtyChannels, configKey) {
    if (!process.env.OPENROUTER_API_KEY || !dirtyChannels || dirtyChannels.length === 0) return;

    console.log(`[AI Curator] Background queue triggered for ${dirtyChannels.length} stream evaluations...`);

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

    for (const ch of dirtyChannels) {
        const isAlt = /backup|alt|mirror/i.test(ch.rawName);
        const isShortOrUnknown = ch.baseCleanName === 'unknown' || ch.baseCleanName.length < 3;
        const hasBaseNameConflict = (rawNamesByBase.get(ch.baseCleanName)?.size || 0) > 1;
        const isOverMerged = (idCounts.get(ch.cId) || 0) > 3;

        // Check if DB already has mapping and confidence is low
        const existing = overridesMap.get(ch.rawName) || null;
        const isLowConfidence = existing && existing.confidence < 0.5;
        let priority = 0;
        if (isOverMerged) priority += 3;
        if (hasBaseNameConflict) priority += 2;
        if (isAlt) priority += 1;
        if (isLowConfidence) priority += 1;
        if (isShortOrUnknown) priority += 1;

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
        console.log(`[AI Curator] No flagged channels requiring processing for ${configKey}.`);
        return;
    }

    console.log(`[AI Curator] Flagged ${uniqueToProcess.length} channels for AI verification.`);

    for (let i = 0; i < uniqueToProcess.length; i += 100) {
        const batch = uniqueToProcess.slice(i, i + 100);
        const aiResults = await processAiBatch(batch);
            if (aiResults.__rateLimited) {
                console.log(`[AI Curator] Stopping early due to rate limit. Processed ${i} of ${uniqueToProcess.length} channels this cycle.`);
                break;
            }
        
        const batchScopeMap = new Map(batch.map(b => [b.name, b.scope]));
        for (const [raw, cleanBase] of Object.entries(aiResults)) {
            if (cleanBase && typeof cleanBase === 'string' && cleanBase.length > 0) {
                const scope = batchScopeMap.get(raw) || 'global';
                const sanitizedBase = cleanBase.replace(/[^a-z0-9]/g, '');
                const finalId = `${scope}_${sanitizedBase}`;
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
