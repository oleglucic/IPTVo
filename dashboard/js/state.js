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
        aiModel: 'openai/gpt-4o-mini',
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

    // Version
    version: '0.0.1'
};

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
        state.config = { ...state.config, ...config };
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
            aiModel: 'openai/gpt-4o-mini',
            selectedGroups: []
        };
        state.availableGroups = [];
        state.filteredGroups = [];
        state.connectionTestResult = null;
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