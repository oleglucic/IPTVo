/* Main Application Entry Point */

import { state, getters, mutations, subscribe } from './state.js';
import { api } from './api.js';
import { toast } from './toast.js';

// DOM Elements
const elements = {};

// Initialize DOM references
function cacheElements() {
    // Auth
    elements.authModal = document.getElementById('authModal');
    elements.authTabs = document.getElementById('authTabs');
    elements.loginForm = document.getElementById('loginForm');
    elements.registerForm = document.getElementById('registerForm');
    elements.loginError = document.getElementById('loginError');
    elements.registerError = document.getElementById('registerError');

    // Main App
    elements.mainApp = document.getElementById('mainApp');
    elements.currentUser = document.getElementById('currentUser');
    elements.userMenuBtn = document.querySelector('[data-action="toggle-user-menu"]');
    elements.userDropdown = document.querySelector('.user-dropdown');

    // Navigation
    elements.stepLinks = document.querySelectorAll('[data-action="navigate-step"]');
    elements.stepPanels = document.querySelectorAll('.step-panel');

    // Provider Form
    elements.providerForm = document.getElementById('providerForm');
    elements.m3uFields = document.getElementById('m3uFields');
    elements.xtreamFields = document.getElementById('xtreamFields');
    elements.testConnectionBtn = document.querySelector('[data-action="test-connection"]');
    elements.connectionTestResult = document.getElementById('connectionTestResult');

    // Groups
    elements.loadGroupsBtn = document.getElementById('loadGroupsBtn');
    elements.selectAllGroups = document.getElementById('selectAllGroups');
    elements.deselectAllGroups = document.getElementById('deselectAllGroups');
    elements.groupSearch = document.getElementById('groupSearch');
    elements.groupsList = document.getElementById('groupsList');

    // Matching & AI
    elements.iptvOrgEnabled = document.getElementById('iptvOrgEnabled');
    elements.matchConfidence = document.getElementById('matchConfidence');
    elements.aiEnabled = document.getElementById('aiEnabled');
    elements.openrouterFields = document.getElementById('openrouterFields');
    elements.aiModelFields = document.getElementById('aiModelFields');
    elements.openrouterKey = document.getElementById('openrouterKey');
    elements.aiModel = document.getElementById('aiModel');

    // Import/Export
    elements.exportBtn = document.getElementById('exportBtn');
    elements.importFile = document.getElementById('importFile');

    // Save & Install
    elements.saveConfigBtn = document.getElementById('saveConfigBtn');
    elements.saveStatus = document.getElementById('saveStatus');
    elements.installSection = document.getElementById('installSection');
    elements.addonUrl = document.getElementById('addonUrl');
    elements.copyUrlBtn = document.getElementById('copyUrlBtn');
    elements.stremioLink = document.getElementById('stremioLink');

    // User Menu Actions
    elements.logoutBtn = document.querySelector('[data-action="logout"]');
    elements.changePasswordBtn = document.querySelector('[data-action="change-password"]');
    elements.deleteAccountBtn = document.querySelector('[data-action="delete-account"]');

    // Version
    elements.appVersion = document.getElementById('appVersion');
}

// Auth Modal Handlers
function showAuthTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
        btn.setAttribute('aria-selected', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.hidden = panel.id !== `${tab}Panel`;
    });
}

async function handleLogin(e) {
    e.preventDefault();
    const formData = new FormData(elements.loginForm);
    const username = formData.get('username');
    const password = formData.get('password');

    elements.loginError.hidden = true;
    elements.loginError.textContent = '';

    try {
        const { userId, token, config } = await api.login(username, password);
        mutations.setAuth({ userId, config }, token);
        closeAuthModal();
        await initializeApp();
        toast.success('Welcome back!', `Signed in as ${username}`);
    } catch (error) {
        elements.loginError.textContent = error.message;
        elements.loginError.hidden = false;
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const formData = new FormData(elements.registerForm);
    const username = formData.get('username');
    const password = formData.get('password');
    const confirm = formData.get('passwordConfirm');

    elements.registerError.hidden = true;
    elements.registerError.textContent = '';

    if (password !== confirm) {
        elements.registerError.textContent = 'Passwords do not match';
        elements.registerError.hidden = false;
        return;
    }

    try {
        const { userId, token } = await api.register(username, password);
        mutations.setAuth({ userId, config: {} }, token);
        closeAuthModal();
        await initializeApp();
        toast.success('Account created!', `Welcome, ${username}`);
    } catch (error) {
        elements.registerError.textContent = error.message;
        elements.registerError.hidden = false;
    }
}

function openAuthModal() {
    elements.authModal.hidden = false;
    document.body.style.overflow = 'hidden';
    showAuthTab('login');
    elements.loginForm.reset();
    elements.registerForm.reset();
    elements.loginError.hidden = true;
    elements.registerError.hidden = true;
}

function closeAuthModal() {
    elements.authModal.hidden = true;
    document.body.style.overflow = '';
}

async function handleLogout() {
    closeUserDropdown();
    try {
        await api.logout();
    } catch {
        // Ignore server errors on logout
    }
    mutations.clearAuth();
    showAuthState(false);
    toast.info('Signed out', 'You have been signed out successfully');
}

async function handleChangePassword() {
    closeUserDropdown();
    const currentPassword = prompt('Enter your current password:');
    if (!currentPassword) return;

    const newPassword = prompt('Enter your new password (min 8 characters):');
    if (!newPassword || newPassword.length < 8) {
        toast.error('Invalid password', 'New password must be at least 8 characters');
        return;
    }

    try {
        await api.changePassword(currentPassword, newPassword);
        toast.success('Password changed', 'Your password has been updated');
    } catch (error) {
        toast.error('Failed to change password', error.message);
    }
}

async function handleDeleteAccount() {
    closeUserDropdown();
    const confirm = prompt('This will permanently delete your account and all data. Type "DELETE" to confirm:');
    if (confirm !== 'DELETE') {
        toast.info('Cancelled', 'Account deletion cancelled');
        return;
    }

    const password = prompt('Enter your password to confirm deletion:');
    if (!password) return;

    try {
        await api.deleteAccount(password);
        mutations.clearAuth();
        showAuthState(false);
        toast.success('Account deleted', 'Your account has been permanently deleted');
    } catch (error) {
        toast.error('Failed to delete account', error.message);
    }
}

// User Dropdown
function toggleUserDropdown() {
    const isOpen = !elements.userDropdown.hidden;
    elements.userDropdown.hidden = isOpen;
    elements.userMenuBtn.setAttribute('aria-expanded', !isOpen);
}

function closeUserDropdown() {
    elements.userDropdown.hidden = true;
    elements.userMenuBtn.setAttribute('aria-expanded', 'false');
}

// Navigation
function navigateToStep(step) {
    mutations.setCurrentStep(step);

    elements.stepLinks.forEach(link => {
        const linkStep = parseInt(link.getAttribute('href').replace('#step', ''), 10);
        link.classList.toggle('active', linkStep === step);
    });

    elements.stepPanels.forEach(panel => {
        panel.classList.toggle('active', panel.id === `step${step}`);
    });

    // Update step numbers
    document.querySelectorAll('.step-link').forEach(link => {
        const linkStep = parseInt(link.getAttribute('href').replace('#step', ''), 10);
        const numberEl = link.querySelector('.step-number');
        if (numberEl) {
            if (linkStep === step) {
                numberEl.textContent = linkStep;
            } else if (linkStep < step && getters.isProviderConfigured()) {
                numberEl.textContent = '✓';
            } else {
                numberEl.textContent = linkStep;
            }
        }
    });
}

// Provider Form
function updateProviderFields() {
    const type = state.config.type;
    elements.m3uFields.hidden = type !== 'm3u';
    elements.xtreamFields.hidden = type !== 'xtream';
    elements.loadGroupsBtn.disabled = !getters.isProviderConfigured();
}

async function handleProviderSubmit(e) {
    e.preventDefault();
    const formData = new FormData(elements.providerForm);

    mutations.setConfigField('type', formData.get('type'));
    mutations.setConfigField('m3uUrl', formData.get('m3uUrl') || '');
    mutations.setConfigField('xtreamUrl', formData.get('xtreamUrl') || '');
    mutations.setConfigField('username', formData.get('username') || '');
    mutations.setConfigField('password', formData.get('password') || '');
    mutations.setConfigField('timezoneOffset', parseFloat(formData.get('timezoneOffset')) || 0);

    updateProviderFields();
    elements.connectionTestResult.hidden = true;
}

async function handleTestConnection() {
    if (!getters.isProviderConfigured()) return;

    mutations.setTestingConnection(true);
    elements.testConnectionBtn.disabled = true;
    elements.connectionTestResult.hidden = true;

    try {
        const config = getters.getConfigForAPI();
        const result = await api.testConfig(config);

        const channelCount = result.channels || result.count || 0;
        const groupCount = result.groups || 0;

        elements.connectionTestResult.className = 'test-result success';
        elements.connectionTestResult.textContent = `✓ Connection successful! Found ${channelCount} channels in ${groupCount} groups.`;
        elements.connectionTestResult.hidden = false;

        toast.success('Connection Test Passed', `${channelCount} channels found`);
    } catch (error) {
        elements.connectionTestResult.className = 'test-result error';
        elements.connectionTestResult.textContent = `✗ Connection failed: ${error.message}`;
        elements.connectionTestResult.hidden = false;

        toast.error('Connection Test Failed', error.message);
    } finally {
        mutations.setTestingConnection(false);
        elements.testConnectionBtn.disabled = false;
    }
}

// Groups
async function handleLoadGroups() {
    if (!getters.isProviderConfigured() || state.isLoadingGroups) return;

    mutations.setLoadingGroups(true);
    elements.loadGroupsBtn.disabled = true;
    elements.loadGroupsBtn.innerHTML = `<svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle><path d="M12 2a10 10 0 0 1 10 10" stroke-opacity="1"></path></svg> Loading...`;

    try {
        const config = getters.getConfigForAPI();
        const { categories } = await api.getGroups(config);

        const groups = categories.map(name => ({ name, count: 0 }));
        mutations.setAvailableGroups(groups);
        mutations.setGroupSearch('');

        renderGroups();
        elements.selectAllGroups.disabled = false;
        elements.deselectAllGroups.disabled = false;

        toast.success('Groups Loaded', `${groups.length} groups found`);
    } catch (error) {
        toast.error('Failed to Load Groups', error.message);
        elements.groupsList.innerHTML = `<p class="empty-state">Error loading groups: ${escapeHtml(error.message)}</p>`;
    } finally {
        mutations.setLoadingGroups(false);
        elements.loadGroupsBtn.disabled = !getters.isProviderConfigured();
        elements.loadGroupsBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg><span>Load Groups</span>`;
    }
}

function renderGroups() {
    if (state.filteredGroups.length === 0) {
        elements.groupsList.textContent = '';
        const emptyState = document.createElement('p');
        emptyState.className = 'empty-state';
        emptyState.textContent = 'No groups match your filter.';
        elements.groupsList.appendChild(emptyState);
        return;
    }

    elements.groupsList.textContent = '';

    state.filteredGroups.forEach(group => {
        const isSelected = state.config.selectedGroups.includes(group.name);

        const label = document.createElement('label');
        label.className = 'group-item';
        label.setAttribute('role', 'option');
        label.setAttribute('aria-selected', isSelected.toString());

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = group.name;
        checkbox.checked = isSelected;
        checkbox.addEventListener('change', (e) => {
            mutations.toggleGroup(e.target.value);
            e.target.closest('.group-item').setAttribute('aria-selected', e.target.checked.toString());
        });

        const nameSpan = document.createElement('span');
        nameSpan.className = 'group-name';
        nameSpan.textContent = group.name;

        const countSpan = document.createElement('span');
        countSpan.className = 'group-count';
        countSpan.textContent = group.count || '?';

        label.appendChild(checkbox);
        label.appendChild(nameSpan);
        label.appendChild(countSpan);
        elements.groupsList.appendChild(label);
    });
}

function filterGroups() {
    mutations.setGroupSearch(elements.groupSearch.value);
    renderGroups();
}

function handleSelectAllGroups() {
    mutations.selectAllGroups();
    renderGroups();
}

function handleDeselectAllGroups() {
    mutations.deselectAllGroups();
    renderGroups();
}

// Matching & AI Settings
function handleMatchingSettings() {
    mutations.setConfigField('iptvOrgEnabled', elements.iptvOrgEnabled.checked);
    mutations.setConfigField('matchConfidence', parseInt(elements.matchConfidence.value, 10));
    elements.matchConfidence.nextElementSibling.textContent = `${elements.matchConfidence.value}%`;
}

function handleAISettings() {
    mutations.setConfigField('aiEnabled', elements.aiEnabled.checked);
    elements.openrouterFields.hidden = !elements.aiEnabled.checked;
    elements.aiModelFields.hidden = !elements.aiEnabled.checked;

    if (elements.aiEnabled.checked) {
        mutations.setConfigField('openrouterKey', elements.openrouterKey.value);
        mutations.setConfigField('aiModel', elements.aiModel.value);
    }
}

// Import/Export
function handleExport() {
    const config = {
        ...state.config,
        // Don't export sensitive data in plain text
        password: '[REDACTED]',
        openrouterKey: state.config.openrouterKey ? '[REDACTED]' : ''
    };

    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iptvo-config-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);

    toast.success('Configuration Exported', 'Config saved as JSON file');
}

function handleImport() {
    elements.importFile.click();
}

async function handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        const imported = JSON.parse(text);

        // Validate imported config
        if (!imported.type || !['m3u', 'xtream'].includes(imported.type)) {
            throw new Error('Invalid configuration format');
        }

        // Don't overwrite sensitive fields from import
        const sensitiveFields = ['password', 'openrouterKey'];
        sensitiveFields.forEach(field => {
            if (imported[field] === '[REDACTED]') {
                delete imported[field];
            }
        });

        mutations.setConfig(imported);
        updateProviderFields();
        updateFormFromState();
        renderGroups();

        toast.success('Configuration Imported', 'Settings loaded from file');
    } catch (error) {
        toast.error('Import Failed', error.message);
    } finally {
        elements.importFile.value = '';
    }
}

// Save & Install
async function handleSaveConfig() {
    if (!getters.isProviderConfigured()) {
        toast.error('Incomplete Configuration', 'Please configure your provider first');
        navigateToStep(1);
        return;
    }

    mutations.setSaving(true);
    elements.saveConfigBtn.disabled = true;
    elements.saveConfigBtn.innerHTML = `<svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle><path d="M12 2a10 10 0 0 1 10 10" stroke-opacity="1"></path></svg> Saving...`;
    elements.saveStatus.hidden = true;

    try {
        await api.updateConfig(state.config);

        // Build addon URL
        const protocol = window.location.protocol;
        const host = window.location.host;
        const userId = state.user?.userId;
        const addonUrl = userId
            ? `${protocol}//${host}/${userId}/manifest.json`
            : `${protocol}//${host}/configure`;

        elements.addonUrl.value = addonUrl;
        elements.stremioLink.href = `stremio://${encodeURIComponent(addonUrl)}`;
        elements.installSection.hidden = false;

        elements.saveStatus.className = 'save-status success';
        elements.saveStatus.textContent = 'Configuration saved successfully!';
        elements.saveStatus.hidden = false;

        toast.success('Configuration Saved', 'Your settings have been saved');
    } catch (error) {
        elements.saveStatus.className = 'save-status error';
        elements.saveStatus.textContent = `Failed to save: ${error.message}`;
        elements.saveStatus.hidden = false;

        toast.error('Save Failed', error.message);
    } finally {
        mutations.setSaving(false);
        elements.saveConfigBtn.disabled = false;
        elements.saveConfigBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg><span>Save Configuration</span>`;
    }
}

async function handleCopyUrl() {
    try {
        await navigator.clipboard.writeText(elements.addonUrl.value);
        toast.success('Copied!', 'Addon URL copied to clipboard');
    } catch {
        toast.error('Copy Failed', 'Could not copy to clipboard');
    }
}

// Initialize App after auth
async function initializeApp() {
    showAuthState(true);
    elements.currentUser.textContent = state.user?.userId || 'User';

    // Fetch version from server
    try {
        const { version } = await api.request('/api/version');
        state.version = version;
        elements.appVersion.textContent = `v${version}`;
    } catch {
        elements.appVersion.textContent = `v${state.version}`;
    }

    // Load user config from server
    try {
        const { config } = await api.validate();
        if (config) {
            // Merge with defaults, preserving sensitive fields
            const mergedConfig = { ...state.config, ...config };
            // Keep local password if server returned redacted
            if (config.password === '[REDACTED]') {
                mergedConfig.password = state.config.password;
            }
            if (config.openrouterKey === '[REDACTED]') {
                mergedConfig.openrouterKey = state.config.openrouterKey;
            }
            mutations.setConfig(mergedConfig);
            updateFormFromState();
        }
    } catch {
        // Validation failed, will redirect to auth
    }
}

function showAuthState(authenticated) {
    elements.authModal.hidden = authenticated;
    elements.mainApp.hidden = !authenticated;
    document.body.style.overflow = authenticated ? '' : 'hidden';
}

function updateFormFromState() {
    // Provider
    const typeRadios = elements.providerForm.querySelectorAll('input[name="type"]');
    typeRadios.forEach(radio => {
        radio.checked = radio.value === state.config.type;
    });
    elements.m3uFields.hidden = state.config.type !== 'm3u';
    elements.xtreamFields.hidden = state.config.type !== 'xtream';

    document.getElementById('m3uUrl').value = state.config.m3uUrl || '';
    document.getElementById('xtreamUrl').value = state.config.xtreamUrl || '';
    document.getElementById('xtreamUsername').value = state.config.username || '';
    document.getElementById('xtreamPassword').value = state.config.password || '';
    document.getElementById('timezoneOffset').value = state.config.timezoneOffset || 0;

    // Matching
    elements.iptvOrgEnabled.checked = state.config.iptvOrgEnabled;
    elements.matchConfidence.value = state.config.matchConfidence;
    elements.matchConfidence.nextElementSibling.textContent = `${state.config.matchConfidence}%`;

    // AI
    elements.aiEnabled.checked = state.config.aiEnabled;
    elements.openrouterFields.hidden = !state.config.aiEnabled;
    elements.aiModelFields.hidden = !state.config.aiEnabled;
    elements.openrouterKey.value = state.config.openrouterKey || '';
    elements.aiModel.value = state.config.aiModel || 'openai/gpt-4o-mini';

    // Groups
    renderGroups();
    elements.loadGroupsBtn.disabled = !getters.isProviderConfigured();
    elements.selectAllGroups.disabled = state.filteredGroups.length === 0;
    elements.deselectAllGroups.disabled = state.filteredGroups.length === 0;

    // Export
    elements.exportBtn.disabled = !getters.isProviderConfigured();

    // Navigation
    navigateToStep(1);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Event Listeners
function bindEvents() {
    // Auth
    elements.authTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab]');
        if (tab) showAuthTab(tab.dataset.tab);
    });

    elements.loginForm.addEventListener('submit', handleLogin);
    elements.registerForm.addEventListener('submit', handleRegister);

    elements.authModal.addEventListener('click', (e) => {
        if (e.target.dataset.action === 'close-auth' || e.target === elements.authModal.querySelector('.modal-backdrop')) {
            closeAuthModal();
        }
    });

    // User Menu
    elements.userMenuBtn.addEventListener('click', toggleUserDropdown);
    elements.logoutBtn.addEventListener('click', handleLogout);
    elements.changePasswordBtn.addEventListener('click', handleChangePassword);
    elements.deleteAccountBtn.addEventListener('click', handleDeleteAccount);

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
        if (!elements.userMenuBtn.contains(e.target) && !elements.userDropdown.contains(e.target)) {
            closeUserDropdown();
        }
    });

    // Navigation
    elements.stepLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const step = parseInt(link.getAttribute('href').replace('#step', ''), 10);
            navigateToStep(step);
        });
    });

    // Provider Form
    elements.providerForm.addEventListener('change', (e) => {
        if (e.target.name === 'type') {
            mutations.setConfigField('type', e.target.value);
            updateProviderFields();
        }
    });

    elements.providerForm.addEventListener('input', (e) => {
        if (['m3uUrl', 'xtreamUrl', 'username', 'password', 'timezoneOffset'].includes(e.target.name)) {
            const value = e.target.type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value;
            mutations.setConfigField(e.target.name, value);
        }
    });

    elements.providerForm.addEventListener('submit', handleProviderSubmit);
    elements.testConnectionBtn.addEventListener('click', handleTestConnection);

    // Groups
    elements.loadGroupsBtn.addEventListener('click', handleLoadGroups);
    elements.groupSearch.addEventListener('input', filterGroups);
    elements.selectAllGroups.addEventListener('click', handleSelectAllGroups);
    elements.deselectAllGroups.addEventListener('click', handleDeselectAllGroups);

    // Matching
    elements.iptvOrgEnabled.addEventListener('change', handleMatchingSettings);
    elements.matchConfidence.addEventListener('input', handleMatchingSettings);

    // AI
    elements.aiEnabled.addEventListener('change', handleAISettings);
    elements.openrouterKey.addEventListener('input', () => mutations.setConfigField('openrouterKey', elements.openrouterKey.value));
    elements.aiModel.addEventListener('change', () => mutations.setConfigField('aiModel', elements.aiModel.value));

    // Import/Export
    elements.exportBtn.addEventListener('click', handleExport);
    document.querySelector('[data-action="trigger-import"]').addEventListener('click', handleImport);
    elements.importFile.addEventListener('change', handleImportFile);

    // Save & Install
    elements.saveConfigBtn.addEventListener('click', handleSaveConfig);
    elements.copyUrlBtn.addEventListener('click', handleCopyUrl);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeAuthModal();
            closeUserDropdown();
        }
        if (e.ctrlKey || e.metaKey) {
            if (e.key === 's') {
                e.preventDefault();
                if (!elements.mainApp.hidden) handleSaveConfig();
            }
        }
    });
}

// Initialize
async function init() {
    cacheElements();
    bindEvents();
    mutations.loadPersistedAuth();

    if (state.isAuthenticated) {
        await initializeApp();
    } else {
        showAuthState(false);
        openAuthModal();
    }
}

// Start
document.addEventListener('DOMContentLoaded', init);