// Tests for dashboard/js/state.js (new centralized state module added in
// this PR). Loaded via the loadEsmModule helper since it uses browser ESM
// syntax and depends on `sessionStorage` plus the `api` module.

const { loadEsmModule } = require('../../test-helpers/loadEsm');

function makeSessionStorageMock() {
    const store = new Map();
    return {
        getItem: jest.fn(key => (store.has(key) ? store.get(key) : null)),
        setItem: jest.fn((key, value) => store.set(key, value)),
        removeItem: jest.fn(key => store.delete(key)),
        __store: store
    };
}

describe('dashboard/js/state.js', () => {
    let apiMock;
    let sessionStorageMock;
    let mod;
    let state;
    let getters;
    let mutations;
    let subscribe;

    beforeEach(() => {
        apiMock = { setToken: jest.fn(), clearToken: jest.fn() };
        sessionStorageMock = makeSessionStorageMock();

        mod = loadEsmModule('dashboard/js/state.js', {
            importMocks: { api: apiMock },
            globals: { sessionStorage: sessionStorageMock }
        });

        state = mod.default;
        getters = mod.getters;
        mutations = mod.mutations;
        subscribe = mod.subscribe;
    });

    describe('default state', () => {
        test('provides sensible defaults', () => {
            expect(state.isAuthenticated).toBe(false);
            expect(state.config.type).toBe('m3u');
            expect(state.config.selectedGroups).toEqual([]);
            expect(state.currentStep).toBe(1);
        });
    });

    describe('getters', () => {
        test('getConfigForAPI strips xtream-only fields for m3u type', () => {
            mutations.setConfig({ type: 'm3u', m3uUrl: 'http://x.m3u', xtreamUrl: 'http://y', username: 'u', password: 'p' });
            const cfg = getters.getConfigForAPI();
            expect(cfg.m3uUrl).toBe('http://x.m3u');
            expect(cfg).not.toHaveProperty('xtreamUrl');
            expect(cfg).not.toHaveProperty('username');
            expect(cfg).not.toHaveProperty('password');
        });

        test('getConfigForAPI strips m3uUrl for xtream type', () => {
            mutations.setConfig({ type: 'xtream', m3uUrl: 'http://x.m3u', xtreamUrl: 'http://y', username: 'u', password: 'p' });
            const cfg = getters.getConfigForAPI();
            expect(cfg).not.toHaveProperty('m3uUrl');
            expect(cfg.xtreamUrl).toBe('http://y');
            expect(cfg.username).toBe('u');
            expect(cfg.password).toBe('p');
        });

        test('getSelectedGroups returns the current selection', () => {
            mutations.toggleGroup('News');
            expect(getters.getSelectedGroups()).toEqual(['News']);
        });

        test('isProviderConfigured is true for m3u only when m3uUrl is set', () => {
            mutations.setConfigField('type', 'm3u');
            expect(getters.isProviderConfigured()).toBe(false);
            mutations.setConfigField('m3uUrl', 'http://playlist.m3u');
            expect(getters.isProviderConfigured()).toBe(true);
        });

        test('isProviderConfigured requires url/username/password for xtream', () => {
            mutations.setConfigField('type', 'xtream');
            mutations.setConfigField('xtreamUrl', 'http://panel');
            expect(getters.isProviderConfigured()).toBe(false);
            mutations.setConfigField('username', 'bob');
            expect(getters.isProviderConfigured()).toBe(false);
            mutations.setConfigField('password', 'secret');
            expect(getters.isProviderConfigured()).toBe(true);
        });

        test('isAIConfigured requires both aiEnabled and an openrouterKey', () => {
            expect(getters.isAIConfigured()).toBe(false);
            mutations.setConfigField('aiEnabled', true);
            expect(getters.isAIConfigured()).toBe(false);
            mutations.setConfigField('openrouterKey', 'sk-or-v1-xxx');
            expect(getters.isAIConfigured()).toBe(true);
        });
    });

    describe('mutations', () => {
        test('setAuth stores user/token, marks authenticated, and persists to sessionStorage', () => {
            mutations.setAuth({ userId: 'u1' }, 'tok-1');

            expect(state.user).toEqual({ userId: 'u1' });
            expect(state.token).toBe('tok-1');
            expect(state.isAuthenticated).toBe(true);
            expect(apiMock.setToken).toHaveBeenCalledWith('tok-1');
            expect(sessionStorageMock.setItem).toHaveBeenCalledWith('iptvo_token', 'tok-1');
            expect(sessionStorageMock.setItem).toHaveBeenCalledWith('iptvo_user', JSON.stringify({ userId: 'u1' }));
        });

        test('clearAuth resets auth state and clears sessionStorage', () => {
            mutations.setAuth({ userId: 'u1' }, 'tok-1');
            mutations.clearAuth();

            expect(state.user).toBeNull();
            expect(state.token).toBeNull();
            expect(state.isAuthenticated).toBe(false);
            expect(apiMock.clearToken).toHaveBeenCalled();
            expect(sessionStorageMock.removeItem).toHaveBeenCalledWith('iptvo_token');
            expect(sessionStorageMock.removeItem).toHaveBeenCalledWith('iptvo_user');
        });

        test('setConfig merges into existing config rather than replacing it', () => {
            mutations.setConfig({ m3uUrl: 'http://a' });
            mutations.setConfig({ username: 'bob' });
            expect(state.config.m3uUrl).toBe('http://a');
            expect(state.config.username).toBe('bob');
            expect(state.config.type).toBe('m3u'); // untouched default preserved
        });

        test('setConfig coerces a server-sent include array back into selectedGroups', () => {
            // The server persists the selection under `include`; on load the
            // dashboard must map it back so checkboxes reflect what is saved.
            mutations.setConfig({ include: ['News', 'Sports'] });
            expect(state.config.selectedGroups).toEqual(['News', 'Sports']);
            expect(state.config).not.toHaveProperty('include');
        });

        test('setConfig preserves selectedGroups when include is absent', () => {
            // A non-empty selection is tracked in the UI even when the stored
            // config carries no include field; loading other fields must not
            // wipe it.
            mutations.setConfigField('selectedGroups', ['News', 'Sports']);
            mutations.setConfig({ m3uUrl: 'http://a' });
            expect(state.config.selectedGroups).toEqual(['News', 'Sports']);
            expect(state.config).not.toHaveProperty('include');
        });

        test('setConfigField updates a single field', () => {
            mutations.setConfigField('timezoneOffset', 5.5);
            expect(state.config.timezoneOffset).toBe(5.5);
        });

        test('setCurrentStep clamps to the [1, 5] range', () => {
            mutations.setCurrentStep(3);
            expect(state.currentStep).toBe(3);
            mutations.setCurrentStep(0);
            expect(state.currentStep).toBe(1);
            mutations.setCurrentStep(99);
            expect(state.currentStep).toBe(5);
        });

        test('setAvailableGroups populates both available and filtered groups', () => {
            const groups = [{ name: 'News' }, { name: 'Sports' }];
            mutations.setAvailableGroups(groups);
            expect(state.availableGroups).toEqual(groups);
            expect(state.filteredGroups).toEqual(groups);
        });

        test('setGroupSearch filters groups case-insensitively', () => {
            mutations.setAvailableGroups([{ name: 'News' }, { name: 'Sports' }, { name: 'NEWS HD' }]);
            mutations.setGroupSearch('news');
            expect(state.filteredGroups.map(g => g.name)).toEqual(['News', 'NEWS HD']);
        });

        test('toggleGroup adds then removes a group name', () => {
            mutations.toggleGroup('News');
            expect(state.config.selectedGroups).toEqual(['News']);
            mutations.toggleGroup('News');
            expect(state.config.selectedGroups).toEqual([]);
        });

        test('selectAllGroups selects everything currently filtered, deselectAllGroups clears it', () => {
            mutations.setAvailableGroups([{ name: 'News' }, { name: 'Sports' }]);
            mutations.selectAllGroups();
            expect(state.config.selectedGroups).toEqual(['News', 'Sports']);
            mutations.deselectAllGroups();
            expect(state.config.selectedGroups).toEqual([]);
        });

        test('setConnectionTestResult / setLoadingGroups / setSaving / setTestingConnection toggle flags', () => {
            mutations.setConnectionTestResult({ ok: true });
            expect(state.connectionTestResult).toEqual({ ok: true });

            mutations.setLoadingGroups(true);
            expect(state.isLoadingGroups).toBe(true);

            mutations.setSaving(true);
            expect(state.isSaving).toBe(true);

            mutations.setTestingConnection(true);
            expect(state.isTestingConnection).toBe(true);
        });

        test('resetConfig restores defaults and clears groups/test result', () => {
            mutations.setConfig({ m3uUrl: 'http://a', aiEnabled: true });
            mutations.setAvailableGroups([{ name: 'News' }]);
            mutations.setConnectionTestResult({ ok: true });

            mutations.resetConfig();

            expect(state.config.m3uUrl).toBe('');
            expect(state.config.aiEnabled).toBe(false);
            expect(state.availableGroups).toEqual([]);
            expect(state.filteredGroups).toEqual([]);
            expect(state.connectionTestResult).toBeNull();
        });

        describe('loadPersistedAuth', () => {
            test('restores auth state from sessionStorage when present', () => {
                sessionStorageMock.setItem('iptvo_token', 'persisted-tok');
                sessionStorageMock.setItem('iptvo_user', JSON.stringify({ userId: 'u2' }));

                mutations.loadPersistedAuth();

                expect(state.isAuthenticated).toBe(true);
                expect(state.token).toBe('persisted-tok');
                expect(state.user).toEqual({ userId: 'u2' });
                expect(apiMock.setToken).toHaveBeenCalledWith('persisted-tok');
            });

            test('does nothing when no persisted session exists', () => {
                mutations.loadPersistedAuth();
                expect(state.isAuthenticated).toBe(false);
            });

            test('clears auth when the persisted user JSON is corrupted', () => {
                sessionStorageMock.setItem('iptvo_token', 'tok');
                sessionStorageMock.setItem('iptvo_user', 'not-json{{{');

                mutations.loadPersistedAuth();

                expect(state.isAuthenticated).toBe(false);
                expect(apiMock.clearToken).toHaveBeenCalled();
            });
        });
    });

    describe('subscribe/notify', () => {
        test('notifies subscribers with the current state after every mutation', () => {
            const cb = jest.fn();
            subscribe(cb);

            mutations.setCurrentStep(2);

            expect(cb).toHaveBeenCalledTimes(1);
            expect(cb).toHaveBeenCalledWith(state);
        });

        test('unsubscribing stops further notifications', () => {
            const cb = jest.fn();
            const unsubscribe = subscribe(cb);
            unsubscribe();

            mutations.setCurrentStep(2);

            expect(cb).not.toHaveBeenCalled();
        });
    });
});