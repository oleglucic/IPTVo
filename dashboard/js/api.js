/* API Client - Handles all server communication */

class APIClient {
    constructor() {
        this.baseURL = '';
        this.token = null;
    }

    setToken(token) {
        this.token = token;
    }

    clearToken() {
        this.token = null;
    }

    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers
        };

        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        // Add timeout using AbortController
        const timeoutMs = options.timeout || 15000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const config = {
            ...options,
            headers,
            signal: controller.signal
        };

        try {
            const response = await fetch(url, config);
            clearTimeout(timeoutId);

            if (!response.ok) {
                // Try to parse error response, fallback to statusText
                let errorMessage;
                try {
                    const data = await response.json();
                    errorMessage = data.error || response.statusText || `HTTP ${response.status}`;
                } catch {
                    // Response body is not JSON or empty
                    errorMessage = response.statusText || `HTTP ${response.status}`;
                }
                throw new Error(errorMessage);
            }

            const data = await response.json();
            return data;
        } catch (error) {
            clearTimeout(timeoutId);

            if (error.name === 'AbortError') {
                throw new Error('Request timeout - please try again');
            }
            if (error instanceof TypeError && error.message.includes('fetch')) {
                throw new Error('Network error - check your connection');
            }
            throw error;
        }
    }

    // Auth endpoints
    async register(username, password, config = {}, turnstileToken = '') {
        return this.request('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({ username, password, config, 'cf-turnstile-response': turnstileToken })
        });
    }

    async login(username, password, turnstileToken = '') {
        return this.request('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password, 'cf-turnstile-response': turnstileToken })
        });
    }

    async validate() {
        return this.request('/api/auth/validate', {
            method: 'GET'
        });
    }

    async logout() {
        return this.request('/api/auth/logout', {
            method: 'POST'
        });
    }

    async updateConfig(config) {
        return this.request('/api/auth/config', {
            method: 'PUT',
            body: JSON.stringify({ config })
        });
    }

    async changePassword(currentPassword, newPassword) {
        return this.request('/api/auth/password', {
            method: 'PUT',
            body: JSON.stringify({ currentPassword, newPassword })
        });
    }

    async deleteAccount(password) {
        return this.request('/api/auth/account', {
            method: 'DELETE',
            body: JSON.stringify({ password })
        });
    }

    async getGroups(config) {
        return this.request('/api/get-groups', {
            method: 'POST',
            body: JSON.stringify(config)
        });
    }

    async getLogoProxyURL() {
        return this.request('/api/logo-proxy-url', {
            method: 'GET'
        });
    }

    async getReleases() {
        return this.request('/api/releases', {
            method: 'GET'
        });
    }

    async testConfig(config) {
        return this.request('/api/test-config', {
            method: 'POST',
            body: JSON.stringify(config)
        });
    }

    // Community channel matching
    async getUnmatchedChannels() {
        return this.request('/api/unmatched-channels', {
            method: 'GET'
        });
    }

    async searchCommunityChannels(query, scope) {
        const params = new URLSearchParams({ q: query, scope: scope || 'global' });
        return this.request(`/api/community-search?${params.toString()}`, {
            method: 'GET'
        });
    }

    async submitCommunityMatch(payload) {
        return this.request('/api/community-match', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    }

    async getHealth() {
        return this.request('/health', {
            method: 'GET'
        });
    }

    async getDetailedHealth() {
        return this.request('/health/detailed', {
            method: 'GET'
        });
    }
}

// Export singleton
export const api = new APIClient();