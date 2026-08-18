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

        const config = {
            ...options,
            headers
        };

        try {
            const response = await fetch(url, config);
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || `HTTP ${response.status}`);
            }

            return data;
        } catch (error) {
            if (error instanceof TypeError && error.message.includes('fetch')) {
                throw new Error('Network error - check your connection');
            }
            throw error;
        }
    }

    // Auth endpoints
    async register(username, password, config = {}) {
        return this.request('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({ username, password, config })
        });
    }

    async login(username, password) {
        return this.request('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
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

    async testConfig(config) {
        return this.request('/api/test-config', {
            method: 'POST',
            body: JSON.stringify(config)
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