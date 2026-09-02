/* Channel Matching — lets a user manually match channels iptv-org couldn't
   find, searching the shared community catalog (and a best-effort direct
   iptv-org lookup) or creating a brand new entry. See db.js's
   voteCommunityChannel for the consensus mechanics this feeds into. */

import { api } from './api.js';
import { toast } from './toast.js';

const els = {};
let unmatched = [];
let activeChannel = null;
let searchDebounceHandle = null;
let searchRequestToken = 0;

/**
 * Escapes special HTML characters in text for safe insertion into HTML.
 * (Kept local rather than imported — main.js's escapeHtml isn't exported.)
 * @param {*} text
 * @return {string}
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

function cacheElements() {
    els.list = document.getElementById('matchList');
    els.refreshBtn = document.getElementById('refreshUnmatchedBtn');
    els.countLabel = document.getElementById('unmatchedCountLabel');
    els.badge = document.getElementById('unmatchedBadge');

    els.modal = document.getElementById('matchModal');
    els.modalTitle = document.getElementById('matchModalTitle');
    els.modalSubtitle = document.getElementById('matchModalSubtitle');
    els.modalLogo = document.getElementById('matchModalLogo');
    // Same graceful-fallback need as the list items above: hide rather than
    // show a broken-image glyph if the logo URL 404s.
    els.modalLogo.addEventListener('error', () => { els.modalLogo.hidden = true; });
    els.searchInput = document.getElementById('matchSearchInput');
    els.searchResults = document.getElementById('matchSearchResults');
    els.createDetails = document.getElementById('matchCreateDetails');
    els.createName = document.getElementById('matchCreateName');
    els.createCategory = document.getElementById('matchCreateCategory');
    els.createSubmit = document.getElementById('matchCreateSubmit');
}

/**
 * Placeholder icon markup for a channel with no logo yet.
 */
const TV_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="2"></rect><polyline points="17 2 12 7 7 2"></polyline></svg>`;

function updateBadge() {
    const count = unmatched.length;
    if (els.badge) {
        els.badge.hidden = count === 0;
        els.badge.textContent = count > 99 ? '99+' : String(count);
    }
    if (els.countLabel) {
        els.countLabel.hidden = count === 0;
        els.countLabel.textContent = count === 1 ? '1 channel needs matching' : `${count} channels need matching`;
    }
}

function renderSkeleton() {
    els.list.innerHTML = `
        <div class="match-skeleton">
            <div class="match-skeleton-row"></div>
            <div class="match-skeleton-row"></div>
            <div class="match-skeleton-row"></div>
        </div>`;
}

function renderEmptyNoConfig() {
    els.list.innerHTML = `
        <div class="match-empty is-neutral">
            <span class="match-empty-icon">${TV_ICON}</span>
            <p class="empty-state">No channels loaded yet.</p>
            <p class="match-empty-hint">Finish setting up your provider and save your configuration first — then come back here to fix anything that didn't match automatically.</p>
            <button type="button" class="btn btn-secondary btn-sm" data-action="jump-step-1">Go to Provider</button>
        </div>`;
}

function renderAllMatched() {
    els.list.innerHTML = `
        <div class="match-empty is-success">
            <span class="match-empty-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
            </span>
            <p class="empty-state">Every channel is matched.</p>
            <p class="match-empty-hint">Nothing left to fix right now — check back after adding new channels to your provider.</p>
        </div>`;
}

function renderError() {
    els.list.innerHTML = `
        <div class="match-empty is-neutral">
            <span class="match-empty-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            </span>
            <p class="empty-state">Couldn't load your channels.</p>
            <p class="match-empty-hint">Something went wrong reaching the server. Try refreshing.</p>
            <button type="button" class="btn btn-secondary btn-sm" data-action="refresh-unmatched">Try again</button>
        </div>`;
}

function renderList() {
    if (unmatched.length === 0) {
        renderAllMatched();
        return;
    }

    els.list.innerHTML = unmatched.map(ch => `
        <div class="match-item" data-id="${escapeHtml(ch.id)}">
            ${ch.logo
                ? `<img class="match-item-logo" src="${escapeHtml(ch.logo)}" alt="" loading="lazy">`
                : `<span class="match-item-logo-placeholder">${TV_ICON}</span>`
            }
            <div class="match-item-info">
                <div class="match-item-name">${escapeHtml(ch.name)}</div>
                <div class="match-item-meta">
                    <span class="match-item-raw" title="${escapeHtml(ch.rawName)}">${escapeHtml(ch.rawName)}</span>
                    ${ch.scope && ch.scope !== 'global' ? `<span class="match-item-scope">${escapeHtml(ch.scope)}</span>` : ''}
                </div>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" data-action="open-match" data-id="${escapeHtml(ch.id)}">Match</button>
        </div>
    `).join('');

    // Swap a broken logo for the placeholder icon via a real event listener,
    // not an inline onerror="" attribute — TV_ICON's own SVG markup uses
    // double-quoted attributes (viewBox="...", etc.), which would collide
    // with and prematurely terminate a double-quoted onerror="..." HTML
    // attribute built by string interpolation, corrupting the markup.
    els.list.querySelectorAll('.match-item-logo').forEach(img => {
        img.addEventListener('error', () => {
            const placeholder = document.createElement('span');
            placeholder.className = 'match-item-logo-placeholder';
            placeholder.innerHTML = TV_ICON;
            img.replaceWith(placeholder);
        }, { once: true });
    });
}

async function loadUnmatched({ silent = false } = {}) {
    if (!silent) renderSkeleton();
    try {
        const data = await api.getUnmatchedChannels();
        unmatched = data.channels || [];
        renderList();
        updateBadge();
    } catch (e) {
        if (!silent) renderError();
    }
}

// ---- Match modal -----------------------------------------------------------

let modalTrigger = null;

function openModal(channelId) {
    const ch = unmatched.find(c => c.id === channelId);
    if (!ch) return;
    activeChannel = ch;
    modalTrigger = document.activeElement;

    els.modalTitle.textContent = 'Match a channel';
    els.modalSubtitle.textContent = ch.rawName;
    if (ch.logo) {
        els.modalLogo.src = ch.logo;
        els.modalLogo.hidden = false;
    } else {
        els.modalLogo.hidden = true;
    }

    els.searchInput.value = '';
    els.searchResults.innerHTML = '<p class="match-search-hint">Start typing a channel name to search iptv-org and the community catalog.</p>';
    els.createDetails.open = false;
    els.createName.value = ch.name || '';
    els.createCategory.value = '';

    els.modal.hidden = false;
    document.body.style.overflow = 'hidden';
    els.searchInput.focus();
}

function closeModal() {
    els.modal.hidden = true;
    document.body.style.overflow = '';
    activeChannel = null;
    if (searchDebounceHandle) clearTimeout(searchDebounceHandle);
    if (modalTrigger && modalTrigger.focus) modalTrigger.focus();
    modalTrigger = null;
}

function renderSearchResults(data) {
    const groups = [];

    if (data.iptvOrgSuggestion) {
        const s = data.iptvOrgSuggestion;
        groups.push(`
            <p class="match-result-group-label">From iptv-org</p>
            <button type="button" class="match-result-item" data-action="use-iptvorg" data-official-id="${escapeHtml(s.officialId)}">
                <div class="match-result-info">
                    <div class="match-result-name">${escapeHtml(s.name)}</div>
                    <div class="match-result-sub">${escapeHtml((s.country || 'global').toUpperCase())} · Official iptv-org entry</div>
                </div>
                <span class="match-result-arrow" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                </span>
            </button>
        `);
    }

    if (data.community && data.community.length > 0) {
        groups.push('<p class="match-result-group-label">Community matches</p>');
        for (const c of data.community) {
            const cats = (c.categories || []).join(', ');
            groups.push(`
                <button type="button" class="match-result-item" data-action="use-community" data-community-id="${c.id}">
                    <div class="match-result-info">
                        <div class="match-result-name">${escapeHtml(c.displayName)}</div>
                        <div class="match-result-sub">${escapeHtml((c.country || 'global').toUpperCase())}${cats ? ' · ' + escapeHtml(cats) : ''}</div>
                    </div>
                    <span class="match-result-arrow" aria-hidden="true">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                    </span>
                </button>
            `);
        }
    }

    if (groups.length === 0) {
        els.searchResults.innerHTML = '<p class="match-search-empty">No results. Try a shorter or different search — or add it as a new channel below.</p>';
        return;
    }

    els.searchResults.innerHTML = groups.join('');
}

function performSearch(query) {
    const token = ++searchRequestToken;
    api.searchCommunityChannels(query, activeChannel ? activeChannel.scope : 'global')
        .then(data => {
            if (token !== searchRequestToken) return; // a newer search superseded this one
            renderSearchResults(data);
        })
        .catch(() => {
            if (token !== searchRequestToken) return;
            els.searchResults.innerHTML = '<p class="match-search-empty">Search failed. Try again.</p>';
        });
}

function onSearchInput() {
    const q = els.searchInput.value.trim();
    if (searchDebounceHandle) clearTimeout(searchDebounceHandle);
    if (q.length < 2) {
        els.searchResults.innerHTML = '<p class="match-search-hint">Keep typing — at least 2 characters.</p>';
        return;
    }
    els.searchResults.innerHTML = '<p class="match-search-hint">Searching…</p>';
    searchDebounceHandle = setTimeout(() => performSearch(q), 300);
}

/**
 * Removes the matched channel from the visible list with a brief
 * "resolved" animation, then updates the badge/empty state.
 */
function resolveChannelLocally(channelId) {
    const el = els.list.querySelector(`.match-item[data-id="${CSS.escape(channelId)}"]`);
    unmatched = unmatched.filter(c => c.id !== channelId);
    updateBadge();
    if (!el) {
        renderList();
        return;
    }
    el.classList.add('is-matched');
    el.addEventListener('animationend', () => {
        if (unmatched.length === 0) renderAllMatched();
        else el.remove();
    }, { once: true });
}

async function submitMatch(payload) {
    const channel = activeChannel;
    if (!channel) return;
    try {
        const result = await api.submitCommunityMatch({
            rawName: channel.rawName,
            scope: channel.scope,
            ...payload
        });
        closeModal();
        resolveChannelLocally(channel.id);
        if (result.voteCount && !result.promoted) {
            // Clamp so an already-at-consensus count can never render a
            // negative "more agreeing votes" number if the server is a step
            // behind (e.g. a race between count and promotion).
            const remaining = Math.max(0, 3 - result.voteCount);
            toast.success('Matched!', `Applied for you now. ${remaining} more agreeing vote${remaining === 1 ? '' : 's'} will make it the default for everyone.`);
        } else {
            toast.success('Matched!', 'This channel now has a logo and schedule.');
        }
    } catch (e) {
        toast.error('Match failed', e.message || 'Please try again.');
    }
}

function handleCreateAndMatch() {
    const displayName = els.createName.value.trim();
    if (!displayName) {
        toast.warning('Name required', 'Give the channel a name before creating it.');
        els.createName.focus();
        return;
    }
    const categories = els.createCategory.value ? [els.createCategory.value] : [];
    submitMatch({ newChannel: { displayName, categories } });
}

// ---- Wiring -----------------------------------------------------------------

export function initMatching() {
    cacheElements();
    if (!els.list) return; // markup not present (shouldn't happen, but stay safe)

    els.refreshBtn.addEventListener('click', () => loadUnmatched());
    document.querySelectorAll('[data-action="refresh-unmatched"]').forEach(btn =>
        btn.addEventListener('click', () => loadUnmatched()));

    els.list.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="open-match"]');
        if (btn) openModal(btn.dataset.id);
    });

    document.querySelectorAll('[data-action="close-match-modal"]').forEach(el =>
        el.addEventListener('click', closeModal));

    els.modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });

    els.searchInput.addEventListener('input', onSearchInput);

    els.searchResults.addEventListener('click', (e) => {
        const iptvBtn = e.target.closest('[data-action="use-iptvorg"]');
        if (iptvBtn) {
            submitMatch({ iptvOrgOfficialId: iptvBtn.dataset.officialId });
            return;
        }
        const communityBtn = e.target.closest('[data-action="use-community"]');
        if (communityBtn) {
            submitMatch({ communityChannelId: Number(communityBtn.dataset.communityId) });
        }
    });

    els.createSubmit.addEventListener('click', handleCreateAndMatch);
}

/**
 * Called when the user navigates to the Channel Matching step. Loads data on
 * first visit; on later visits, silently refreshes in the background so a
 * stale list doesn't linger without a distracting reload flash.
 */
let hasLoadedOnce = false;
export async function onMatchingStepShown(hasSavedConfig) {
    if (!hasSavedConfig) {
        renderEmptyNoConfig();
        updateBadge();
        return;
    }
    await loadUnmatched({ silent: hasLoadedOnce });
    hasLoadedOnce = true;
}
