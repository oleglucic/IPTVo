// Tests for dashboard/js/api.js (new APIClient added in this PR).
// The module uses browser-style `import`/`export` syntax, so it is loaded
// through the loadEsmModule test helper which evaluates the real source
// in-realm with a mocked `fetch` (the real Node AbortController is used).

const { loadEsmModule } = require('../../test-helpers/loadEsm');

function mockJsonResponse(body, { ok = true, status = 200, statusText = 'OK' } = {}) {
    return {
        ok,
        status,
        statusText,
        json: jest.fn().mockResolvedValue(body)
    };
}

describe('dashboard/js/api.js - APIClient', () => {
    let fetchMock;
    let apiModule;
    let api;

    beforeEach(() => {
        jest.useRealTimers();
        fetchMock = jest.fn();
        apiModule = loadEsmModule('dashboard/js/api.js', {
            globals: {
                fetch: fetchMock
            }
        });
        api = apiModule.api;
    });

    describe('token management', () => {
        test('setToken/clearToken update the internal token used for Authorization headers', async () => {
            fetchMock.mockResolvedValue(mockJsonResponse({ ok: true }));

            api.setToken('abc123');
            await api.getHealth();
            expect(fetchMock.mock.calls[0][1].headers['Authorization']).toBe('Bearer abc123');

            api.clearToken();
            await api.getHealth();
            expect(fetchMock.mock.calls[1][1].headers['Authorization']).toBeUndefined();
        });
    });

    describe('request()', () => {
        test('sends JSON content-type header and resolves with parsed body on success', async () => {
            fetchMock.mockResolvedValue(mockJsonResponse({ hello: 'world' }));

            const result = await api.request('/api/thing', { method: 'GET' });

            expect(result).toEqual({ hello: 'world' });
            const [, config] = fetchMock.mock.calls[0];
            expect(config.headers['Content-Type']).toBe('application/json');
            expect(config.signal).toBeDefined();
        });

        test('throws the server-provided error message on non-ok JSON response', async () => {
            fetchMock.mockResolvedValue(mockJsonResponse({ error: 'Invalid credentials' }, { ok: false, status: 401, statusText: 'Unauthorized' }));

            await expect(api.request('/api/thing')).rejects.toThrow('Invalid credentials');
        });

        test('falls back to statusText when an error response body is not JSON', async () => {
            const response = {
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                json: jest.fn().mockRejectedValue(new Error('not json'))
            };
            fetchMock.mockResolvedValue(response);

            await expect(api.request('/api/thing')).rejects.toThrow('Internal Server Error');
        });

        test('translates AbortError into a friendly timeout message', async () => {
            const abortError = new Error('The operation was aborted');
            abortError.name = 'AbortError';
            fetchMock.mockRejectedValue(abortError);

            await expect(api.request('/api/thing')).rejects.toThrow('Request timeout - please try again');
        });

        test('translates a fetch TypeError into a friendly network error message', async () => {
            const networkError = new TypeError('Failed to fetch');
            fetchMock.mockRejectedValue(networkError);

            await expect(api.request('/api/thing')).rejects.toThrow('Network error - check your connection');
        });

        test('rethrows unrelated errors unchanged', async () => {
            fetchMock.mockRejectedValue(new Error('Something else broke'));

            await expect(api.request('/api/thing')).rejects.toThrow('Something else broke');
        });

        test('merges custom headers with the default Content-Type header', async () => {
            fetchMock.mockResolvedValue(mockJsonResponse({}));

            await api.request('/api/thing', { headers: { 'X-Custom': '1' } });

            const [, config] = fetchMock.mock.calls[0];
            expect(config.headers['Content-Type']).toBe('application/json');
            expect(config.headers['X-Custom']).toBe('1');
        });
    });

    describe('endpoint helpers', () => {
        beforeEach(() => {
            fetchMock.mockResolvedValue(mockJsonResponse({ ok: true }));
        });

        test('register() posts username/password/config to /api/auth/register', async () => {
            await api.register('bob', 'pw', { type: 'm3u' });
            const [url, config] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/auth/register');
            expect(config.method).toBe('POST');
            expect(JSON.parse(config.body)).toEqual({ username: 'bob', password: 'pw', config: { type: 'm3u' } });
        });

        test('login() posts credentials to /api/auth/login', async () => {
            await api.login('bob', 'pw');
            const [url, config] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/auth/login');
            expect(JSON.parse(config.body)).toEqual({ username: 'bob', password: 'pw' });
        });

        test('validate() issues a GET to /api/auth/validate', async () => {
            await api.validate();
            const [url, config] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/auth/validate');
            expect(config.method).toBe('GET');
        });

        test('logout() posts to /api/auth/logout', async () => {
            await api.logout();
            const [url, config] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/auth/logout');
            expect(config.method).toBe('POST');
        });

        test('updateConfig() PUTs the config payload to /api/auth/config', async () => {
            await api.updateConfig({ type: 'xtream' });
            const [url, config] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/auth/config');
            expect(config.method).toBe('PUT');
            expect(JSON.parse(config.body)).toEqual({ config: { type: 'xtream' } });
        });

        test('changePassword() PUTs both passwords to /api/auth/password', async () => {
            await api.changePassword('old', 'new');
            const [url, config] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/auth/password');
            expect(JSON.parse(config.body)).toEqual({ currentPassword: 'old', newPassword: 'new' });
        });

        test('deleteAccount() sends DELETE with password to /api/auth/account', async () => {
            await api.deleteAccount('pw');
            const [url, config] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/auth/account');
            expect(config.method).toBe('DELETE');
            expect(JSON.parse(config.body)).toEqual({ password: 'pw' });
        });

        test('getGroups() posts config to /api/get-groups', async () => {
            await api.getGroups({ type: 'm3u', m3uUrl: 'http://x' });
            const [url, config] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/get-groups');
            expect(JSON.parse(config.body)).toEqual({ type: 'm3u', m3uUrl: 'http://x' });
        });

        test('getLogoProxyURL() issues a GET to /api/logo-proxy-url', async () => {
            await api.getLogoProxyURL();
            const [url, config] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/logo-proxy-url');
            expect(config.method).toBe('GET');
        });

        test('testConfig() posts config to /api/test-config', async () => {
            await api.testConfig({ type: 'xtream' });
            const [url, config] = fetchMock.mock.calls[0];
            expect(url).toBe('/api/test-config');
            expect(config.method).toBe('POST');
        });

        test('getHealth() issues a GET to /health', async () => {
            await api.getHealth();
            const [url, config] = fetchMock.mock.calls[0];
            expect(url).toBe('/health');
            expect(config.method).toBe('GET');
        });

        test('getDetailedHealth() issues a GET to /health/detailed', async () => {
            await api.getDetailedHealth();
            const [url, config] = fetchMock.mock.calls[0];
            expect(url).toBe('/health/detailed');
            expect(config.method).toBe('GET');
        });
    });
});