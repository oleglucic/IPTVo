/* Main Application Entry Point */

import state, { getters, mutations, detectTimezoneOffset } from './state.js';
import { api } from './api.js';
import { toast } from './toast.js';

// DOM Elements
const elements = {};

/**
 * Cache references to the DOM elements used by the application.
 */
function cacheElements() {
    // Intro / welcome
    elements.introView = document.getElementById('introView');
    elements.introVersion = document.getElementById('introVersion');
    elements.introYear = document.getElementById('introYear');

    // Auth
    elements.authModal = document.getElementById('authModal');
    elements.authTabs = document.getElementById('authTabs');
    elements.loginForm = document.getElementById('loginForm');
    elements.registerForm = document.getElementById('registerForm');
    elements.loginError = document.getElementById('loginError');
    elements.registerError = document.getElementById('registerError');

    // Changelog
    elements.changelogModal = document.getElementById('changelogModal');
    elements.changelogList = document.getElementById('changelogList');

    // Main App
    elements.mainApp = document.getElementById('mainApp');
    elements.currentUser = document.getElementById('currentUser');
    elements.userAvatar = document.getElementById('userAvatar');
    elements.userMenuBtn = document.querySelector('[data-action="toggle-user-menu"]');
    elements.userDropdown = document.querySelector('.user-dropdown');

    // Navigation
    elements.stepLinks = document.querySelectorAll('[data-action="navigate-step"]');
    elements.stepPanels = document.querySelectorAll('.step-panel');
    elements.sidebarToggle = document.getElementById('sidebarToggle');
    elements.configSidebar = document.getElementById('configSidebar');
    elements.sidebarOverlay = document.getElementById('sidebarOverlay');
    elements.stepPrevBtns = document.querySelectorAll('[data-action="prev-step"]');
    elements.stepNextBtns = document.querySelectorAll('[data-action="next-step"]');

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

/**
 * Switches the authentication modal to the selected tab.
 * @param {string} tab - The identifier of the tab to display.
 */
function showAuthTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
        btn.setAttribute('aria-selected', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.hidden = panel.id !== `${tab}Panel`;
    });
}

/**
 * Authenticates the user and initializes the application with the returned account data.
 * @param {SubmitEvent} e - The login form submission event.
 */
/**
 * Collects the current Turnstile token for the given action. The widget stores
 * its response in a hidden input named `cf-turnstile-response` inside its
 * container; read it from the active form (login or register panel).
 * Returns '' if the widget isn't present (e.g. local dev without the widget).
 */
function getTurnstileToken() {
    try {
        const input = document.querySelector('.tab-panel:not([hidden]) .cf-turnstile input[name="cf-turnstile-response"]') ||
                      document.querySelector('.cf-turnstile input[name="cf-turnstile-response"]');
        return typeof window.turnstile === 'object' && input ? (input.value || '') : '';
    } catch {
        return '';
    }
}

/**
 * Resets the Turnstile widget in a panel so a retry produces a fresh token
 * (tokens are single-use — after a failed submit the widget must reset).
 * No-ops when the widget/script isn't present.
 */
function resetTurnstile(action) {
    try {
        if (typeof window.turnstile !== 'object') return;
        const container = document.getElementById(`${action}Panel`);
        (container ? container.querySelectorAll('.cf-turnstile') : []).forEach(el => {
            window.turnstile.reset(el);
        });
    } catch {
        // best-effort reset — ignore
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const formData = new FormData(elements.loginForm);
    const username = formData.get('username');
    const password = formData.get('password');

    elements.loginError.hidden = true;
    elements.loginError.textContent = '';

    try {
        // Turnstile token (empty on local dev where the secret is unset is fine)
        const ttToken = getTurnstileToken();
        const { userId, username: userDisplay, token, config } = await api.login(username, password, ttToken);
        mutations.setAuth({ userId, username: userDisplay, config }, token);
        closeAuthModal();
        await initializeApp();
        toast.success('Welcome back!', `Signed in as ${username}`);
    } catch (error) {
        resetTurnstile('login');
        elements.loginError.textContent = error.message;
        elements.loginError.hidden = false;
    }
}

/**
 * Registers a new user and initializes the authenticated application.
 * @param {SubmitEvent} e - The registration form submission event.
 */
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
        const ttToken = getTurnstileToken();
        const { userId, username: userDisplay, token } = await api.register(username, password, {}, ttToken);
        mutations.setAuth({ userId, username: userDisplay, config: {} }, token);
        closeAuthModal();
        await initializeApp();
        toast.success('Account created!', `Welcome, ${username}`);
    } catch (error) {
        resetTurnstile('register');
        elements.registerError.textContent = error.message;
        elements.registerError.hidden = false;
    }
}

/**
 * Opens the authentication modal and resets its forms and error messages.
 */
function openAuthModal() {
    elements.authModal.hidden = false;
    document.body.style.overflow = 'hidden';
    showAuthTab('login');
    elements.loginForm.reset();
    elements.registerForm.reset();
    elements.loginError.hidden = true;
    elements.registerError.hidden = true;
}

/**
 * Closes the authentication modal. For unauthenticated users on the welcome page,
 * allows closing to return to the welcome page.
 */
function closeAuthModal() {
    elements.authModal.hidden = true;
    document.body.style.overflow = '';
}

/**
 * Signs the user out and returns the interface to its unauthenticated state.
 */
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

/**
 * Changes the authenticated user's password after validating the new password length.
 */
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

/**
 * Permanently deletes the authenticated user's account after explicit confirmation.
 */
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

/**
 * Toggles the visibility of the user dropdown menu and updates its accessibility state.
 */
function toggleUserDropdown() {
    const isOpen = !elements.userDropdown.hidden;
    elements.userDropdown.hidden = isOpen;
    elements.userMenuBtn.setAttribute('aria-expanded', !isOpen);
}

/**
 * Closes the user account dropdown menu.
 */
function closeUserDropdown() {
    elements.userDropdown.hidden = true;
    elements.userMenuBtn.setAttribute('aria-expanded', 'false');
}

/**
 * Switches the wizard to the specified configuration step and updates navigation state.
 * @param {number} step - The step number to activate.
 */
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

    // Re-evaluate action buttons so controls reflect the current config
    // (e.g. "Refresh" enables once a provider URL is entered).
    updateProviderFields();

    // Groups load themselves when the user reaches the channels step with a
    // configured provider — no explicit "Load Groups" press required. A manual
    // "Refresh" button remains for re-fetching.
    if (step === 2) maybeAutoLoadGroups().catch(() => {});
}

/**
 * Loads the provider's channel groups automatically when appropriate.
 *
 * Fires when the user is on the Groups step, has a configured provider, and groups
 * have not been loaded yet (or were invalidated by a provider change). Safe to call
 * repeatedly: it no-ops while groups are already loaded or a load is in flight.
 */
async function maybeAutoLoadGroups() {
    if (state.currentStep !== 2) return;
    if (!getters.isProviderConfigured()) return;
    if (state.groupsLoaded || state.isLoadingGroups) return;
    await handleLoadGroups();
}

/**
 * The subset of config fields that identify the IPTV provider. Changing any of
 * them invalidates previously loaded groups, so an in-flight groups response
 * for an old identity must be discarded rather than applied.
 * @returns {object} A snapshot of the current provider identity.
 */
function currentProviderIdentity() {
    return {
        type: state.config.type,
        m3uUrl: state.config.m3uUrl,
        xtreamUrl: state.config.xtreamUrl,
        username: state.config.username,
        password: state.config.password
    };
}

/**
 * Compares two provider identities after an asynchronous load.
 * @param {object|null} a - The identity captured when the load started.
 * @param {object} b - The current identity.
 * @returns {boolean} True if the provider is unchanged.
 */
function sameProviderIdentity(a, b) {
    if (!a || !b) return false;
    return a.type === b.type &&
        a.m3uUrl === b.m3uUrl &&
        a.xtreamUrl === b.xtreamUrl &&
        a.username === b.username &&
        a.password === b.password;
}

/**
 * Syncs provider-specific fields and every action button (Refresh,
 * Export, Save, Select/Deselect All) with the current configuration.
 * Called on navigation, form input, and after async operations so the
 * wizard never leaves an actionable control stuck disabled.
 * Detects provider identity changes and invalidates cached groups when needed.
 */
function updateProviderFields() {
    const type = state.config.type;
    elements.m3uFields.hidden = type !== 'm3u';
    elements.xtreamFields.hidden = type !== 'xtream';

    // Detect if the provider identity has changed (URL, type, username, or password)
    // and invalidate groups if it has
    const currentIdentity = currentProviderIdentity();

    if (!state.lastProviderIdentity) {
        state.lastProviderIdentity = currentIdentity;
    } else {
        const identityChanged = (
            currentIdentity.type !== state.lastProviderIdentity.type ||
            currentIdentity.m3uUrl !== state.lastProviderIdentity.m3uUrl ||
            currentIdentity.xtreamUrl !== state.lastProviderIdentity.xtreamUrl ||
            currentIdentity.username !== state.lastProviderIdentity.username ||
            currentIdentity.password !== state.lastProviderIdentity.password
        );

        if (identityChanged) {
            // Invalidate existing groups
            mutations.setAvailableGroups([]);
            mutations.setConfigField('selectedGroups', []);
            mutations.setGroupsLoaded(false);
            state.lastProviderIdentity = currentIdentity;
        }
    }

    const configured = getters.isProviderConfigured();
    elements.loadGroupsBtn.disabled = !configured;
    elements.exportBtn.disabled = !configured;
    elements.saveConfigBtn.disabled = !configured;
    elements.selectAllGroups.disabled = state.filteredGroups.length === 0;
    elements.deselectAllGroups.disabled = state.filteredGroups.length === 0;
}

/**
 * Updates the provider configuration from submitted form data.
 * @param {SubmitEvent} e - The provider configuration form submission event.
 */
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

/**
 * Tests the configured provider connection and displays the result.
 */
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
        updateProviderFields();
    }
}

/**
 * Loads available groups from the configured provider and displays them.
 */
async function handleLoadGroups() {
    if (!getters.isProviderConfigured() || state.isLoadingGroups) return;

    // Capture the provider before the async load. If it changes while the
    // request is in flight, updateProviderFields invalidates the groups; the
    // stale response below must be discarded, not applied under the new provider.
    const requestedIdentity = currentProviderIdentity();

    mutations.setLoadingGroups(true);
    elements.loadGroupsBtn.disabled = true;
    elements.loadGroupsBtn.innerHTML = `<svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle><path d="M12 2a10 10 0 0 1 10 10" stroke-opacity="1"></path></svg> Loading...`;

    try {
        const config = getters.getConfigForAPI();
        const { categories } = await api.getGroups(config);

        // Provider changed mid-flight: drop this response. updateProviderFields
        // already cleared the groups, and the user can navigate back to trigger
        // a fresh auto-load for the new provider.
        if (!sameProviderIdentity(requestedIdentity, currentProviderIdentity())) {
            console.log('[Groups] Discarded stale groups load (provider changed while fetching)');
            return;
        }

        const groups = categories.map(name => ({ name, count: 0 }));
        mutations.setAvailableGroups(groups);
        mutations.setGroupSearch('');
        mutations.setGroupsLoaded(true);

        renderGroups();
        elements.selectAllGroups.disabled = false;
        elements.deselectAllGroups.disabled = false;

        toast.success('Groups Loaded', `${groups.length} groups found`);
    } catch (error) {
        // On failure, groupsLoaded remains false so the empty state with "Go to Provider" CTA is preserved
        toast.error('Failed to Load Groups', error.message);

        // Render a retryable error state that preserves the "Go to Provider" action
        elements.groupsList.innerHTML = `
            <div class="groups-empty">
                <span class="groups-empty-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                </span>
                <p class="empty-state">Failed to load groups</p>
                <p class="groups-empty-hint">${escapeHtml(error.message)}</p>
                <button type="button" class="btn btn-secondary btn-sm" data-action="jump-step-1">Go to Provider</button>
            </div>
        `;

        // Re-bind the "Go to Provider" button
        elements.groupsList.querySelector('[data-action="jump-step-1"]')?.addEventListener('click', () => navigateToStep(1));
    } finally {
        mutations.setLoadingGroups(false);
        updateProviderFields();
        elements.loadGroupsBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg><span>Refresh</span>`;
    }
}

/**
 * Renders the filtered groups with selectable checkboxes and channel counts.
 */
function renderGroups() {
    // Before the user has loaded groups, keep the static guidance block
    // ("Go to Provider" CTA) intact — "No groups match your filter" would
    // be misleading when no provider has been configured yet.
    if (!state.groupsLoaded) {
        return;
    }
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

/**
 * Filters the displayed groups using the current search value.
 */
function filterGroups() {
    mutations.setGroupSearch(elements.groupSearch.value);
    renderGroups();
}

/**
 * Selects all currently available groups.
 */
function handleSelectAllGroups() {
    mutations.selectAllGroups();
    renderGroups();
}

/**
 * Deselects all groups and refreshes the group list.
 */
function handleDeselectAllGroups() {
    mutations.deselectAllGroups();
    renderGroups();
}

/**
 * Saves matching preferences and updates the displayed confidence percentage.
 */
function handleMatchingSettings() {
    mutations.setConfigField('iptvOrgEnabled', elements.iptvOrgEnabled.checked);
    mutations.setConfigField('matchConfidence', parseInt(elements.matchConfidence.value, 10));
    elements.matchConfidence.nextElementSibling.textContent = `${elements.matchConfidence.value}%`;
}

/**
 * Updates AI configuration settings and displays the related fields when AI is enabled.
 */
function handleAISettings() {
    const enabled = elements.aiEnabled.checked;
    mutations.setConfigField('aiEnabled', enabled);
    elements.openrouterFields.hidden = !enabled;
    elements.aiModelFields.hidden = !enabled;

    // Always capture both fields so enabling AI later keeps the user's chosen model,
    // and disabling AI doesn't silently drop the previous selection.
    mutations.setConfigField('openrouterKey', elements.openrouterKey.value);
    mutations.setConfigField('aiModel', elements.aiModel.value || 'openrouter/free');
}

/**
 * Exports the current configuration as a JSON file with sensitive values redacted.
 */
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

/**
 * Imports and applies a provider configuration from a selected JSON file.
 * @param {Event} e - The file input change event containing the configuration file.
 */
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
        // Reset provider identity tracking so updateProviderFields will detect the change
        state.lastProviderIdentity = null;
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

/**
 * Saves the provider configuration and displays installation links when successful.
 * Redirects to provider setup when the configuration is incomplete and displays an error when saving fails.
 */
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
        // Replace http(s):// with stremio:// for deep link
        elements.stremioLink.href = addonUrl.replace(/^https?:\/\//, 'stremio://');
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

/**
 * Copies the addon URL to the clipboard and reports the result.
 */
async function handleCopyUrl() {
    try {
        await navigator.clipboard.writeText(elements.addonUrl.value);
        toast.success('Copied!', 'Addon URL copied to clipboard');
    } catch {
        toast.error('Copy Failed', 'Could not copy to clipboard');
    }
}

/**
 * Initializes the authenticated application interface and loads the server version and user configuration.
 */
async function initializeApp() {
    showAuthState(true);
    const username = state.user?.username || state.user?.userId || 'User';
    elements.currentUser.textContent = username;
    elements.userAvatar.textContent = username.charAt(0).toUpperCase();

    // Version is fetched once at boot in init(); badges already set.

    // Load user config from server
    try {
        const { config, username } = await api.validate();
        if (username) {
            state.user = { ...state.user, username };
            elements.currentUser.textContent = username;
        }
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

/**
 * Toggles the interface between authenticated and unauthenticated states.
 * @param {boolean} authenticated - Whether the user is authenticated.
 */
function showAuthState(authenticated) {
    elements.introView.hidden = authenticated;
    elements.mainApp.hidden = !authenticated;
    elements.authModal.hidden = true;
    document.body.style.overflow = '';
}

/**
 * Synchronizes provider, matching, AI, group, export, and navigation controls with the current application state.
 */
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
    document.getElementById('timezoneOffset').value = state.config.timezoneOffset || detectTimezoneOffset();

    // Matching
    elements.iptvOrgEnabled.checked = state.config.iptvOrgEnabled;
    elements.matchConfidence.value = state.config.matchConfidence;
    elements.matchConfidence.nextElementSibling.textContent = `${state.config.matchConfidence}%`;

    // AI
    elements.aiEnabled.checked = state.config.aiEnabled;
    elements.openrouterFields.hidden = !state.config.aiEnabled;
    elements.aiModelFields.hidden = !state.config.aiEnabled;
    elements.openrouterKey.value = state.config.openrouterKey || '';
    elements.aiModel.value = state.config.aiModel || 'openrouter/free';

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

// Store the element that triggered the changelog modal
let changelogTrigger = null;
let changelogLoaded = false;

/**
 * Renders a GitHub release note (GFM-ish) as escaped, dependency-free HTML.
 * Splits section headers and bullets into clean blocks rather than injecting
 * a markdown renderer.
 */
function renderReleaseBody(body) {
    const lines = (body || '').split('\n');
    const out = [];
    let inList = false;

    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        const header = line.match(/^#{1,3}\s+(.*)$/);
        const bullet = line.match(/^[-*]\s+(.*)$/);

        if (header) {
            closeList();
            out.push(`<h3>${escapeHtml(header[1])}</h3>`);
        } else if (bullet) {
            if (!inList) { out.push('<ul>'); inList = true; }
            out.push(`<li>${escapeHtml(bullet[1])}</li>`);
        } else if (line) {
            closeList();
            out.push(`<p>${escapeHtml(line)}</p>`);
        }
    }
    closeList();
    return out.join('');
}

/**
 * Populates the changelog modal from the server's /api/releases feed (which
 * proxies GitHub releases) on first open. Falls back to a friendly notice.
 */
async function loadChangelog() {
    if (changelogLoaded) return;
    const list = elements.changelogList;
    if (!list) return;

    list.innerHTML = '<li class="changelog-entry">Loading recent releases…</li>';
    try {
        const { releases } = await api.getReleases();
        if (!Array.isArray(releases) || releases.length === 0) {
            list.innerHTML = '<li class="changelog-entry">No releases yet — the story starts here.</li>';
        } else {
            list.innerHTML = releases.map(r => `
                <li class="changelog-entry">
                    <span class="changelog-version">${escapeHtml(r.tagName || 'release')}</span>
                    ${renderReleaseBody(r.body)}
                </li>
            `).join('');
        }
        changelogLoaded = true;
    } catch {
        list.innerHTML = '<li class="changelog-entry">Couldn’t load the changelog — check your connection and try again.</li>';
    }
}

/**
 * Opens the changelog modal, moves focus into it, and sets up focus trapping.
 */
function openChangelog(triggerElement) {
    changelogTrigger = triggerElement || document.activeElement;
    elements.changelogModal.hidden = false;
    document.body.style.overflow = 'hidden';

    loadChangelog();

    // Move focus to the first focusable element in the modal
    const firstFocusable = elements.changelogModal.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (firstFocusable) {
        firstFocusable.focus();
    }
}

/**
 * Closes the changelog modal, restores body scrolling, and returns focus to the triggering element.
 */
function closeChangelog() {
    elements.changelogModal.hidden = true;
    if (elements.authModal.hidden) {
        document.body.style.overflow = '';
    }

    // Restore focus to the element that opened the modal
    if (changelogTrigger && changelogTrigger.focus) {
        changelogTrigger.focus();
    }
    changelogTrigger = null;
}

/**
 * Escapes special HTML characters in text for safe insertion into HTML.
 * @param {*} text - The text to escape.
 * @return {string} The HTML-escaped text.
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Registers event listeners for authentication, navigation, configuration, group management, import/export, saving, and keyboard shortcuts.
 */
function bindEvents() {
    // Auth
    elements.authTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab]');
        if (tab) showAuthTab(tab.dataset.tab);
    });

    elements.loginForm.addEventListener('submit', handleLogin);
    elements.registerForm.addEventListener('submit', handleRegister);

    // Intro / welcome actions
    document.querySelectorAll('[data-action="intro-get-started"], [data-action="intro-sign-in"]')
        .forEach(btn => btn.addEventListener('click', openAuthModal));

    // Auth modal close button
    document.querySelectorAll('[data-action="close-auth"]')
        .forEach(btn => btn.addEventListener('click', closeAuthModal));

    // Changelog open/close (intro header, intro footer, in-app footer)
    document.querySelectorAll('[data-action="open-changelog"]')
        .forEach(btn => btn.addEventListener('click', (e) => openChangelog(e.currentTarget)));
    document.querySelectorAll('[data-action="close-changelog"]')
        .forEach(btn => btn.addEventListener('click', closeChangelog));

    // Groups empty-state CTA → jump back to provider step
    document.querySelectorAll('[data-action="jump-step-1"]')
        .forEach(btn => btn.addEventListener('click', () => navigateToStep(1)));

    // Auth modal backdrop/close handling removed - modal should not be dismissible when unauthenticated

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
            closeSidebarDrawer();
        });
    });

    // Mobile drawer: hamburger opens/closes the sidebar
    const openSidebarDrawer = () => {
        elements.configSidebar.classList.add('open');
        elements.sidebarOverlay.classList.add('visible');
        elements.sidebarOverlay.hidden = false;
        elements.sidebarToggle.setAttribute('aria-expanded', 'true');
    };
    const closeSidebarDrawer = () => {
        elements.configSidebar.classList.remove('open');
        elements.sidebarOverlay.classList.remove('visible');
        elements.sidebarOverlay.hidden = true;
        elements.sidebarToggle.setAttribute('aria-expanded', 'false');
    };
    elements.sidebarToggle.addEventListener('click', () => {
        if (elements.configSidebar.classList.contains('open')) {
            closeSidebarDrawer();
        } else {
            openSidebarDrawer();
        }
    });
    elements.sidebarOverlay.addEventListener('click', closeSidebarDrawer);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeSidebarDrawer();
    });

    // Focus trap for changelog modal
    elements.changelogModal.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && !elements.changelogModal.hidden) {
            const focusableElements = elements.changelogModal.querySelectorAll(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            );
            const firstFocusable = focusableElements[0];
            const lastFocusable = focusableElements[focusableElements.length - 1];

            if (e.shiftKey) {
                // Shift+Tab: if on first element, move to last
                if (document.activeElement === firstFocusable) {
                    e.preventDefault();
                    lastFocusable.focus();
                }
            } else {
                // Tab: if on last element, move to first
                if (document.activeElement === lastFocusable) {
                    e.preventDefault();
                    firstFocusable.focus();
                }
            }
        }
    });

    // Prev/Next step navigation
    elements.stepPrevBtns.forEach(btn => {
        btn.addEventListener('click', () => navigateToStep(state.currentStep - 1));
    });
    elements.stepNextBtns.forEach(btn => {
        btn.addEventListener('click', () => navigateToStep(state.currentStep + 1));
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
            updateProviderFields();
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
            closeChangelog();
        }
        if (e.ctrlKey || e.metaKey) {
            if (e.key === 's') {
                e.preventDefault();
                if (!elements.mainApp.hidden) handleSaveConfig();
            }
        }
    });
}

/**
 * Initialize the application and restore the authenticated session when available.
 */
async function init() {
    cacheElements();
    bindEvents();

    // Fetch the server version once at boot so both the intro and the authed
    // app show the real version instead of the 0.0.1 fallback. Public endpoint.
    try {
        const { version } = await api.request('/api/version');
        state.version = version;
        if (elements.appVersion) elements.appVersion.textContent = `v${version}`;
        if (elements.introVersion) elements.introVersion.textContent = `v${version}`;
    } catch {
        // leave fallback badge as-is if the server is unreachable
    }

    mutations.loadPersistedAuth();

    if (state.isAuthenticated) {
        await initializeApp();
    } else {
        showAuthState(false);
        if (elements.introYear) elements.introYear.textContent = new Date().getFullYear();
    }
}

// Start
document.addEventListener('DOMContentLoaded', init);