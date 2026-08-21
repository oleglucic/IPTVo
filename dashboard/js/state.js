/* State Management - Centralized application state */

import { api } from './api.js';

// State object
const state = {
    // Auth
    user: null,
    token: null,
    isAuthenticated: false,

    // Configuration
    config: {
        type: 'm3u',
        m3uUrl: '',
        xtreamUrl: '',
        username: '',
        password: '',
        timezoneOffset: 0,
        iptvOrgEnabled: true,
        matchConfidence: 85,
        aiEnabled: false,
        openrouterKey: '',
        aiModel: 'openrouter/free',
        selectedGroups: []
    },

    // UI State
    currentStep: 1,
    availableGroups: [],
    filteredGroups: [],
    groupSearch: '',
    connectionTestResult: null,
    isLoadingGroups: false,
    isSaving: false,
    isTestingConnection: false,
    groupsLoaded: false,

    // Version
    version: '0.0.1'
};

// Detect the browser's UTC offset in hours (matches the timezoneOffset field used by EPG).
export function detectTimezoneOffset() {
    return -new Date().getTimezoneOffset() / 60;
}

// Derived state getters
export const getters = {
    getConfigForAPI() {
        const cfg = { ...state.config };
        // Only include relevant fields based on type
        if (cfg.type === 'm3u') {
            delete cfg.xtreamUrl;
            delete cfg.username;
            delete cfg.password;
        } else {
            delete cfg.m3uUrl;
        }
        // The parser filters the selected groups via `include`/`exclude`. The
        // dashboard tracks the same choice as `selectedGroups` (UI-only name),
        // so map it to the field the backend actually reads, then drop the alias.
        cfg.include = (cfg.selectedGroups || []).filter(Boolean);
        delete cfg.selectedGroups;
        // The parser gates iptv-org matching on `config.iptvOrg` (legacy key),
        // but the dashboard exposes it as `iptvOrgEnabled`. Alias before send.
        cfg.iptvOrg = cfg.iptvOrgEnabled;
        delete cfg.iptvOrgEnabled;
        return cfg;
    },

    getSelectedGroups() {
        return state.config.selectedGroups || [];
    },

    isProviderConfigured() {
        if (state.config.type === 'm3u') {
            return !!state.config.m3uUrl;
        }
        return !!state.config.xtreamUrl && !!state.config.username && !!state.config.password;
    },

    isAIConfigured() {
        return state.config.aiEnabled && !!state.config.openrouterKey;
    }
};

// State mutations
export const mutations = {
    setAuth(user, token) {
        state.user = user;
        state.token = token;
        state.isAuthenticated = true;
        api.setToken(token);
        // Persist to sessionStorage
        sessionStorage.setItem('iptvo_token', token);
        sessionStorage.setItem('iptvo_user', JSON.stringify(user));
    },

    clearAuth() {
        state.user = null;
        state.token = null;
        state.isAuthenticated = false;
        api.clearToken();
        sessionStorage.removeItem('iptvo_token');
        sessionStorage.removeItem('iptvo_user');
    },

    setConfig(config) {
        const next = { ...config };
        // The server persists the group selection under `include` (the field the
        // parser filters on); the dashboard tracks it as `selectedGroups` (UI-only
        // name). Coerce on load so the checkboxes reflect what is actually saved,
        // and a later save does not wipe it with an empty selection.
        if (Array.isArray(next.include)) {
            next.selectedGroups = [...next.include];
            delete next.include;
        }
        // The parser exposes the iptv-org toggle as `iptvOrg`; the dashboard
        // tracks it as `iptvOrgEnabled`. Coerce on load so the checkbox reflects
        // what is actually saved and a later save does not wipe it.
        if (typeof next.iptvOrg !== 'undefined') {
            next.iptvOrgEnabled = next.iptvOrg;
            delete next.iptvOrg;
        }
        state.config = { ...state.config, ...next };
    },

    setConfigField(field, value) {
        state.config[field] = value;
    },

    setCurrentStep(step) {
        state.currentStep = Math.max(1, Math.min(5, step));
    },

    setAvailableGroups(groups) {
        state.availableGroups = groups;
        state.filteredGroups = groups;
    },

    setGroupSearch(query) {
        state.groupSearch = query;
        const lowerQuery = query.toLowerCase();
        state.filteredGroups = state.availableGroups.filter(g =>
            g.name.toLowerCase().includes(lowerQuery)
        );
    },

    toggleGroup(groupName) {
        const idx = state.config.selectedGroups.indexOf(groupName);
        if (idx === -1) {
            state.config.selectedGroups.push(groupName);
        } else {
            state.config.selectedGroups.splice(idx, 1);
        }
    },

    selectAllGroups() {
        state.config.selectedGroups = state.filteredGroups.map(g => g.name);
    },

    deselectAllGroups() {
        state.config.selectedGroups = [];
    },

    setConnectionTestResult(result) {
        state.connectionTestResult = result;
    },

    setLoadingGroups(loading) {
        state.isLoadingGroups = loading;
    },

    setGroupsLoaded(loaded) {
        state.groupsLoaded = loaded;
    },

    setSaving(saving) {
        state.isSaving = saving;
    },

    setTestingConnection(testing) {
        state.isTestingConnection = testing;
    },

    resetConfig() {
        state.config = {
            type: 'm3u',
            m3uUrl: '',
            xtreamUrl: '',
            username: '',
            password: '',
            timezoneOffset: 0,
            iptvOrgEnabled: true,
            matchConfidence: 85,
            aiEnabled: false,
            openrouterKey: '',
            aiModel: 'openrouter/free',
            selectedGroups: []
        };
        state.availableGroups = [];
        state.filteredGroups = [];
        state.connectionTestResult = null;
        state.groupsLoaded = false;
    },

    loadPersistedAuth() {
        const token = sessionStorage.getItem('iptvo_token');
        const userStr = sessionStorage.getItem('iptvo_user');
        if (token && userStr) {
            try {
                const user = JSON.parse(userStr);
                state.user = user;
                state.token = token;
                state.isAuthenticated = true;
                api.setToken(token);
            } catch {
                this.clearAuth();
            }
        }
    }
};

// Subscribe to state changes (simple observer pattern)
const subscribers = new Set();

/**
 * Registers a callback to receive state updates after mutations.
 * @param {Function} callback - The function invoked with the current state after each mutation.
 * @return {Function} A function that unregisters the callback.
 */
export function subscribe(callback) {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
}

/**
 * Notifies all registered subscribers with the current application state.
 */
function notify() {
    subscribers.forEach(cb => cb(state));
}

// Proxy to auto-notify on mutations
const originalMutations = { ...mutations };
Object.keys(mutations).forEach(key => {
    mutations[key] = function(...args) {
        originalMutations[key].apply(this, args);
        notify();
    };
});

export default state;