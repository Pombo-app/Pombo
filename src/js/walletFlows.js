/**
 * Wallet Flows Module
 * Handles all wallet connection flows, modals, backup/restore, and encryption UI.
 * Extracted from app.js to decompose the God Object.
 */

import { authManager } from './auth.js';
import { secureStorage } from './secureStorage.js';
import { channelManager } from './channels.js';
import { uiController } from './ui.js';
import { headerUI } from './ui/HeaderUI.js';
import { Logger } from './logger.js';
import { getAvatar, getAvatarHtml, generateAvatar } from './ui/AvatarGenerator.js';
import { escapeHtml, escapeAttr } from './ui/utils.js';
import { 
    createModalFromTemplate, 
    closeModal, 
    setupModalCloseHandlers,
    setupPasswordToggle,
    $,
    getPasswordStrengthHtml,
    setupPasswordStrengthValidation
} from './ui/modalUtils.js';
import { CONFIG } from './config.js';
import { identityManager } from './identity.js';
import { importBackupData } from './backupImport.js';

/**
 * Store credentials in browser's password manager using Credential Management API
 * This triggers the browser's "Save password?" prompt
 * @param {string} username - The username/identifier (wallet address)
 * @param {string} password - The password to store
 * @returns {Promise<boolean>} - True if saved successfully
 */
async function storeCredentials(username, password) {
    // Check if Credential Management API is supported
    if (!window.PasswordCredential || !navigator.credentials) {
        Logger.info('Credential Management API not supported');
        return false;
    }
    
    // Normalize address to lowercase to prevent duplicate entries
    const normalizedUsername = username.toLowerCase();
    
    try {
        const credential = new PasswordCredential({
            id: normalizedUsername,
            password: password,
            name: `Pombo Account (${normalizedUsername.slice(0, 6)}...${normalizedUsername.slice(-4)})`
        });
        
        // Store the credential - this triggers the browser's save prompt
        await navigator.credentials.store(credential);
        Logger.info('Credentials stored successfully');
        return true;
    } catch (error) {
        Logger.error('Failed to store credentials:', error);
        return false;
    }
}

class WalletFlows {
    /**
     * Initialize with App-level callbacks to avoid circular dependencies.
     * @param {Object} callbacks
     * @param {Function} callbacks.disconnectWallet - App.disconnectWallet(options)
     * @param {Function} callbacks.onWalletConnected - App.onWalletConnected(address, signer)
     * @param {Function} callbacks.fallbackToGuest - App.fallbackToGuest(message)
     */
    init({ disconnectWallet, onWalletConnected, fallbackToGuest }) {
        this._disconnectWallet = disconnectWallet;
        this._onWalletConnected = onWalletConnected;
        this._fallbackToGuest = fallbackToGuest;
    }

    /**
     * Release wallet-flow mobile UI locks before heavy session bootstrap completes.
     */
    releaseWalletFlowUI() {
        document.body.classList.remove('wallet-flow-open');
    }

    /**
     * Connect wallet (generate, import, or load saved)
     */
    async connectWallet() {
        // Hide mobile pill nav for the duration of the auth flow.
        // Restored in finally{} so it always re-appears, even on error/cancel.
        document.body.classList.add('wallet-flow-open');
        try {
            // If connected as Guest, show create/import modal to upgrade
            if (authManager.isGuestMode()) {
                await this.showCreateWalletModal();
                return;
            }
            
            // Check if there are saved wallets
            const savedWallets = authManager.listSavedWallets();
            
            if (savedWallets.length > 0) {
                // Show quick unlock or wallet selection
                await this.showUnlockWalletModal(savedWallets);
            } else {
                // No saved wallets - show create/import options
                await this.showCreateWalletModal();
            }
        } catch (error) {
            if (error.message !== 'cancelled') {
                console.error('Failed to connect wallet:', error);
                uiController.showNotification('Failed to connect: ' + error.message, 'error');
            }
        } finally {
            document.body.classList.remove('wallet-flow-open');
        }

        // If still not connected after modal flow, fallback to Guest
        if (!authManager.getAddress()) {
            await this._fallbackToGuest('Continuing as Guest - connect an Account to save your data');
        }
    }

    /**
     * Switch to another saved wallet
     */
    async switchWallet() {
        try {
            const savedWallets = authManager.listSavedWallets();
            if (savedWallets.length <= 1) return;

            // Show wallet selector (excluding current)
            const currentAddress = authManager.getAddress();
            const otherWallets = savedWallets.filter(w => w.address !== currentAddress);
            
            if (otherWallets.length === 0) return;

            const selectedAddress = await this.showWalletSelector(otherWallets);
            if (!selectedAddress) return;

            await this.switchToWallet(selectedAddress);
        } catch (error) {
            uiController.showNotification(error.message || 'Failed to switch account', 'error');
        }
    }

    /**
     * Unlock a saved account and make it the current one.
     * @param {string} address
     */
    async switchToWallet(address) {
        try {
            const password = await this.showSecureInput(
                'Unlock Account',
                'Enter password to unlock account:',
                'password',
                { walletAddress: address.toLowerCase() }
            );
            if (!password) return;

            // Disconnect current wallet first (skip fallback to guest since we're switching)
            await this._disconnectWallet({ skipFallback: true });

            await this.loadWalletWithProgress(password, address);
            uiController.showNotification('Account switched!', 'success');
        } catch (error) {
            uiController.showNotification(error.message || 'Failed to switch account', 'error');
        }
        if (!authManager.getAddress()) {
            await this._fallbackToGuest('Continuing as Guest');
        }
    }

    /**
     * Create, import or restore another account. The current session stays
     * up until the new account is ready, so cancelling changes nothing.
     */
    async addAccount() {
        document.body.classList.add('wallet-flow-open');
        try {
            await this.showCreateWalletModal();
        } catch (error) {
            if (error.message !== 'cancelled') {
                uiController.showNotification('Failed to add account: ' + error.message, 'error');
            }
        } finally {
            document.body.classList.remove('wallet-flow-open');
        }
        if (!authManager.getAddress()) {
            await this._fallbackToGuest('Continuing as Guest');
        }
    }

    /**
     * Lock the current account: end the session and ask for an unlock.
     */
    async lock() {
        await this._disconnectWallet({ skipFallback: true });
        await this.connectWallet();
    }

    /**
     * Show unlock wallet modal (when saved wallets exist)
     */
    async showUnlockWalletModal(wallets) {
        return new Promise((resolve, reject) => {
            const singleWallet = wallets.length === 1;
            const wallet = singleWallet ? wallets[0] : null;
            
            // Helper to get display name - prefer ENS, then username, then wallet name
            const getDisplayName = (w, index) => {
                // Check for ENS name stored in plain localStorage
                const ensName = localStorage.getItem(CONFIG.storageKeys.ens(w.address));
                if (ensName) return ensName;
                // Check for username stored in plain localStorage (set via settings or sync)
                const username = localStorage.getItem(CONFIG.storageKeys.username(w.address));
                if (username) return username;
                // If name looks like auto-generated default, show "Account N"
                const isDefaultName = !w.name || w.name.startsWith('Wallet ') || w.name.startsWith('Imported ') || w.name.startsWith('Account ');
                return isDefaultName ? `Account ${index + 1}` : w.name;
            };

            // Helper to check if wallet has ENS
            const hasENS = (w) => !!localStorage.getItem(CONFIG.storageKeys.ens(w.address));

            // Helper to get cached ENS avatar URL from localStorage
            const getENSAvatarUrl = (w) => localStorage.getItem(CONFIG.storageKeys.ensAvatar(w.address));
            
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50 animate-fadeIn';
            modal.innerHTML = `
                <div class="bg-[#111113] rounded-2xl w-[360px] max-w-[calc(100%-2rem)] overflow-hidden shadow-2xl border border-white/[0.06] animate-slideUp">
                    <!-- Header -->
                    <div class="px-5 pt-5 pb-3">
                        <div class="flex items-center justify-between">
                            <h3 class="text-[15px] font-medium text-white">Unlock Account</h3>
                            <button id="close-modal" class="text-white/30 hover:text-white transition p-1 -mr-1">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    
                    ${singleWallet ? `
                    <!-- Single Wallet Display -->
                    <div class="px-5 pb-4">
                        <div class="bg-white/[0.05] rounded-xl p-3 border border-white/[0.08]">
                            <div class="flex items-center gap-3">
                                <div class="w-14 h-14 rounded-full overflow-hidden flex-shrink-0">${getAvatarHtml(wallet.address, 56, 0.5, getENSAvatarUrl(wallet))}</div>
                                <div class="flex-1 min-w-0">
                                    <div class="text-[13px] font-medium text-white truncate flex items-center gap-1.5">${hasENS(wallet) ? '<svg class="flex-shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#4ade80" stroke-width="2" fill="none"/><path d="M7.5 12.5l3 3 6-6.5" stroke="#4ade80" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>' : ''}${escapeAttr(getDisplayName(wallet, 0))}</div>
                                    <div class="text-[11px] text-white/50 font-mono">${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                    ` : `
                    <!-- Multiple Wallets List -->
                    <div class="px-5 pb-4">
                        <div class="space-y-2 max-h-52 overflow-y-auto scrollbar-thin">
                            ${wallets.map((w, i) => `
                                <button class="wallet-item w-full bg-white/[0.05] hover:bg-white/[0.08] rounded-xl p-3 border border-white/[0.08] hover:border-white/[0.12] transition-all text-left ${i === 0 ? 'selected border-white/[0.12]' : ''}" data-address="${escapeAttr(w.address)}" data-name="${escapeAttr(w.name)}">
                                    <div class="flex items-center gap-3">
                                        <div class="w-14 h-14 rounded-full overflow-hidden flex-shrink-0">${getAvatarHtml(w.address, 56, 0.5, getENSAvatarUrl(w))}</div>
                                        <div class="flex-1 min-w-0">
                                            <div class="text-[13px] font-medium text-white truncate flex items-center gap-1">${hasENS(w) ? '<svg class="flex-shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#4ade80" stroke-width="2" fill="none"/><path d="M7.5 12.5l3 3 6-6.5" stroke="#4ade80" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>' : ''}${escapeAttr(getDisplayName(w, i))}</div>
                                            <div class="text-[11px] text-white/50 font-mono">${w.address.slice(0, 6)}...${w.address.slice(-4)}</div>
                                        </div>
                                        <div class="w-4 h-4 rounded-full border border-white/[0.12] group-[.selected]:bg-white flex items-center justify-center">
                                            <div class="w-2 h-2 rounded-full bg-white opacity-0 selected-dot"></div>
                                        </div>
                                    </div>
                                </button>
                            `).join('')}
                        </div>
                    </div>
                    `}
                    
                    <!-- Password Input Form -->
                    <form id="unlock-form" class="px-5 pb-4">
                        <!-- Hidden username field for browser password manager (uses wallet address) -->
                        <input type="text" id="wallet-username" name="username" 
                            class="hidden" 
                            autocomplete="username" 
                            value="${(singleWallet ? wallet.address : wallets[0].address).toLowerCase()}" 
                            tabindex="-1" aria-hidden="true">
                        <div class="relative">
                            <input type="password" id="wallet-password" name="password"
                                placeholder="Password"
                                class="w-full bg-white/[0.05] border border-white/[0.08] rounded-xl px-3 py-2.5 text-[13px] text-white placeholder-white/25 focus:outline-none focus:border-white/[0.15] transition"
                                autocomplete="current-password">
                            <button type="button" id="toggle-password" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/25 hover:text-white transition">
                                <svg id="eye-icon" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                </svg>
                            </button>
                        </div>
                        <p id="password-error" class="text-red-500 text-[11px] mt-1.5 hidden">Incorrect password</p>
                    
                        <!-- Actions -->
                        <div class="pt-4">
                            <button type="submit" id="unlock-btn" class="w-full bg-white hover:bg-[#e5e5e5] text-black text-[13px] font-medium py-2.5 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed">
                                Unlock
                            </button>
                        </div>
                    </form>
                    
                    <!-- Footer -->
                    <div class="border-t border-white/[0.06] px-5 py-3 bg-[#09090b]">
                        <div class="flex items-center justify-center gap-3 text-[12px]">
                            <button id="create-new-btn" class="text-white/30 hover:text-white transition">New account</button>
                            <span class="text-white/15">·</span>
                            <button id="import-btn" class="text-white/30 hover:text-white transition">Import</button>
                        </div>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            const unlockForm = modal.querySelector('#unlock-form');
            const passwordInput = modal.querySelector('#wallet-password');
            const usernameInput = modal.querySelector('#wallet-username');
            const unlockBtn = modal.querySelector('#unlock-btn');
            const togglePassword = modal.querySelector('#toggle-password');
            const passwordError = modal.querySelector('#password-error');
            const closeBtn = modal.querySelector('#close-modal');
            const createNewBtn = modal.querySelector('#create-new-btn');
            const importBtn = modal.querySelector('#import-btn');
            const walletItems = modal.querySelectorAll('.wallet-item');
            
            let selectedAddress = singleWallet ? wallet.address : wallets[0].address;
            let selectedName = singleWallet ? wallet.name : wallets[0].name;
            
            // Focus password input
            setTimeout(() => passwordInput.focus(), 100);
            
            // Wallet selection
            walletItems.forEach(item => {
                item.addEventListener('click', () => {
                    walletItems.forEach(w => w.classList.remove('selected', 'border-white/[0.12]'));
                    item.classList.add('selected', 'border-white/[0.12]');
                    selectedAddress = item.dataset.address;
                    selectedName = item.dataset.name;
                    // Update hidden username field for password manager (lowercase for consistency)
                    if (usernameInput) usernameInput.value = selectedAddress.toLowerCase();
                    passwordInput.focus();
                });
            });
            
            // Toggle password visibility
            setupPasswordToggle(togglePassword, passwordInput);
            
            const cleanup = () => {
                passwordInput.value = '';
                document.body.removeChild(modal);
            };
            
            // Unlock action
            const attemptUnlock = async () => {
                const password = passwordInput.value;
                if (!password) {
                    passwordInput.classList.add('border-red-500');
                    return;
                }
                
                unlockBtn.disabled = true;
                unlockBtn.innerHTML = '<svg class="animate-spin h-4 w-4 mx-auto text-black" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>';
                
                try {
                    cleanup();
                    await this.loadWalletWithProgress(password, selectedAddress);
                    resolve();
                } catch (error) {
                    // Re-show modal with error
                    document.body.appendChild(modal);
                    passwordError.classList.remove('hidden');
                    passwordInput.classList.add('border-red-500');
                    unlockBtn.disabled = false;
                    unlockBtn.textContent = 'Unlock';
                    passwordInput.value = '';
                    passwordInput.focus();
                }
            };
            
            // Form submit handler (supports browser password save prompt)
            unlockForm.addEventListener('submit', (e) => {
                e.preventDefault();
                attemptUnlock();
            });
            passwordInput.addEventListener('input', () => {
                passwordInput.classList.remove('border-red-500');
                passwordError.classList.add('hidden');
            });
            
            // Close modal
            closeBtn.addEventListener('click', () => {
                cleanup();
                reject(new Error('cancelled'));
            });
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    cleanup();
                    reject(new Error('cancelled'));
                }
            });
            
            // Create new / Import
            createNewBtn.addEventListener('click', async () => {
                cleanup();
                try {
                    await this.showCreateWalletModal();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
            
            importBtn.addEventListener('click', async () => {
                cleanup();
                try {
                    await this.importPrivateKey();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    /**
     * Show create wallet modal (when no saved wallets)
     */
    async showCreateWalletModal() {
        return new Promise((resolve, reject) => {
            const modal = createModalFromTemplate('modal-create-wallet');
            if (!modal) {
                reject(new Error('Template not found'));
                return;
            }

            const cleanup = () => closeModal(modal);

            setupModalCloseHandlers(modal, () => {
                cleanup();
                reject(new Error('cancelled'));
            });

            $(modal, '[data-action="create"]').addEventListener('click', async () => {
                cleanup();
                try {
                    await this.connectLocal();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });

            $(modal, '[data-action="import"]').addEventListener('click', async () => {
                cleanup();
                try {
                    await this.importPrivateKey();
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });

            // Restore from backup
            const restoreBtn = $(modal, '[data-action="restore"]');
            const restoreFileInput = $(modal, '[data-restore-input]');
            
            restoreBtn.addEventListener('click', () => {
                restoreFileInput.click();
            });

            restoreFileInput.addEventListener('change', async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                
                cleanup();
                try {
                    await this.restoreFromBackup(file);
                    resolve();
                } catch (err) {
                    if (err.message !== 'cancelled') {
                        uiController.showNotification('Restore failed: ' + err.message, 'error');
                    }
                    reject(err);
                }
            });
        });
    }

    /**
     * Restore account from backup file
     * @param {File} file - The backup JSON file
     */
    async restoreFromBackup(file) {
        const text = await file.text();
        const backup = JSON.parse(text);

        // Validate backup format
        if (backup.format !== 'pombo-account-backup' || backup.version !== 1) {
            throw new Error('Invalid backup format. Only pombo-account-backup v1 is supported.');
        }

        // Get password to decrypt
        const password = await this.showSecureInput(
            'Restore Account',
            'Enter the backup password:',
            'password'
        );
        if (!password) throw new Error('cancelled');

        // Show progress modal
        const progressModal = this.showProgressModal('Restoring Account', 'Unlocking your backup...');

        try {
            // Decrypt using the password (this verifies the password)
            const result = await secureStorage.importAccountBackup(
                backup,
                password,
                (progress) => this.updateProgressModal(progressModal, progress)
            );

            this.hideProgressModal(progressModal);

            // Save the keystore to localStorage (using same key as authManager)
            // Note: Keystore V3 address doesn't include 0x prefix, but we need it normalized
            const rawAddress = backup.keystore.address.toLowerCase();
            const keystoreAddress = rawAddress.startsWith('0x') ? rawAddress : `0x${rawAddress}`;
            const wallets = JSON.parse(localStorage.getItem(CONFIG.storageKeys.keystores) || '{}');
            if (!wallets[keystoreAddress]) {
                wallets[keystoreAddress] = {
                    name: result.data?.username || `Restored ${keystoreAddress.slice(0, 8)}`,
                    keystore: backup.keystore,
                    createdAt: Date.now(),
                    lastUsed: Date.now()
                };
                localStorage.setItem(CONFIG.storageKeys.keystores, JSON.stringify(wallets));
            } else if (result.data?.username) {
                // An entry left by an earlier restore keeps its fallback name
                // ("Restored 0x…") forever unless the backup's name replaces it.
                wallets[keystoreAddress].name = result.data.username;
                localStorage.setItem(CONFIG.storageKeys.keystores, JSON.stringify(wallets));
            }

            // Tear any live session down first (guest, or the account being
            // left by Add account), same as connectLocal/importPrivateKey —
            // onWalletConnected must not re-enter over a live client, or the
            // header never leaves guest state (body.guest-mode keeps
            // "Create Account" visible).
            if (authManager.getAddress()) {
                await this._disconnectWallet({ skipFallback: true });
            }

            // Now unlock the wallet with the same password
            await this.loadWalletWithProgress(password, keystoreAddress);

            // Now import data into secure storage (which is now unlocked)
            const data = result.data;
            if (data) {
                const summary = await importBackupData(data, {
                    secureStorage,
                    channelManager,
                    identityManager
                });

                // Import image blobs from backup into IDB ledger
                // (must happen AFTER loadWalletWithProgress → init → storageKey is set)
                if (result.imageBlobs && result.imageBlobs.length > 0) {
                    await secureStorage.importImageBlobs(result.imageBlobs);
                }

                if (summary.changed) {
                    uiController.renderChannelList();
                }

                // onWalletConnected painted the header BEFORE this import ran,
                // so the backup's display name never reached it — repaint now.
                // A later ENS resolution still overrides, same as on connect.
                if (secureStorage.cache.username) {
                    headerUI.updateDisplayName(secureStorage.cache.username);
                }
            }

            uiController.showNotification('Account restored successfully!', 'success');
        } catch (error) {
            this.hideProgressModal(progressModal);
            throw error;
        }
    }

    /**
     * Show secure input modal (for sensitive data like private keys)
     * @param {string} title - Modal title
     * @param {string} label - Input label
     * @param {string} inputType - Input type ('text' or 'password')
     * @param {Object} options - Optional settings
     * @param {string} options.walletAddress - Wallet address for password manager support
     * @returns {Promise<string|null>} - User input or null if cancelled
     */
    async showSecureInput(title, label, inputType = 'password', options = {}) {
        return new Promise((resolve) => {
            const modal = createModalFromTemplate('modal-secure-input', { title, label });
            
            const input = $(modal, '[data-secure-input]');
            const confirmBtn = $(modal, '[data-confirm]');
            const cancelBtn = $(modal, '[data-cancel]');
            const toggleBtn = $(modal, '[data-toggle-visibility]');
            const modalContent = $(modal, '[data-modal-content]');

            // Set input type
            input.type = inputType;
            
            // If walletAddress provided, enable password manager support
            if (options.walletAddress && inputType === 'password') {
                // Add hidden username field for password manager
                const usernameInput = document.createElement('input');
                usernameInput.type = 'text';
                usernameInput.name = 'username';
                usernameInput.autocomplete = 'username';
                usernameInput.value = options.walletAddress.toLowerCase();
                usernameInput.className = 'hidden';
                usernameInput.tabIndex = -1;
                usernameInput.setAttribute('aria-hidden', 'true');
                input.parentNode.insertBefore(usernameInput, input);
                
                // Enable browser password manager
                input.name = 'password';
                input.autocomplete = 'current-password';
            }
            
            // Hide toggle button if not password type
            if (inputType !== 'password' && toggleBtn) {
                toggleBtn.style.display = 'none';
            }

            input.focus();

            // Setup password toggle
            if (toggleBtn && inputType === 'password') {
                setupPasswordToggle(toggleBtn, input);
            }

            const cleanup = (value) => {
                input.value = '';
                if (modal.parentNode) modal.parentNode.removeChild(modal);
                resolve(value);
            };

            confirmBtn.addEventListener('click', () => cleanup(input.value || null));
            cancelBtn.addEventListener('click', () => cleanup(null));
            setupModalCloseHandlers(modal, () => cleanup(null));
            
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') cleanup(input.value || null);
            });
        });
    }

    /**
     * Generate local wallet
     */
    async connectLocal() {
        try {
            // If upgrading from Guest, disconnect first to cleanup client
            const wasGuest = authManager.isGuestMode();
            if (wasGuest) {
                await this._disconnectWallet();
            }

            // Show modal where user picks an avatar (= picks a wallet)
            const setupResult = await this.showNewAccountSetupModal();

            // User cancelled - connect as guest instead (an account still
            // signed in from Add account simply stays)
            if (setupResult === 'cancelled') {
                if (!authManager.getAddress()) {
                    await this._fallbackToGuest('Continuing as Guest - your data won\'t be saved');
                }
                return;
            }

            if (setupResult) {
                if (authManager.getAddress()) {
                    await this._disconnectWallet({ skipFallback: true });
                }
                // Set the chosen wallet in authManager
                const importResult = authManager.importPrivateKey(setupResult.privateKey);

                // Save wallet with password
                await this.saveWalletWithProgress(setupResult.password, setupResult.displayName);

                this.releaseWalletFlowUI();
                await this._onWalletConnected(importResult.address, importResult.signer);

                // Save display name to secureStorage (after it's initialized)
                if (setupResult.displayName && secureStorage.isStorageUnlocked()) {
                    secureStorage.cache.username = setupResult.displayName;
                    await secureStorage.saveToStorage();
                }

                uiController.showNotification('Account created!', 'success');
            }
        } catch (error) {
            throw error;
        }
    }

    /**
     * Show new account setup modal (Step 1: Choose Avatar, Step 2: Name + Key + Password, Step 3: Confirm Password)
     * @returns {Promise<{address: string, privateKey: string, password: string, displayName: string}|'cancelled'>}
     */
    async showNewAccountSetupModal() {
        return new Promise((resolve) => {
            // Generate initial set of wallets (each avatar = a real address)
            const AVATAR_COUNT = 6;
            let wallets = [];
            const regenerateWallets = () => {
                wallets = [];
                for (let i = 0; i < AVATAR_COUNT; i++) {
                    const w = ethers.Wallet.createRandom();
                    wallets.push({ address: w.address, privateKey: w.privateKey });
                }
            };
            regenerateWallets();

            let selectedIndex = 0;
            const getSelectedWallet = () => wallets[selectedIndex];

            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-3 sm:p-4';
            modal.innerHTML = `
                <style>#avatar-grid .avatar-option svg{width:100%;height:100%;display:block}</style>
                <div class="bg-[#111113] rounded-2xl shadow-2xl border border-white/[0.06] flex flex-col overflow-hidden" style="width:100%;max-width:420px;max-height:calc(100vh - 1.5rem)">
                    <!-- Step 1: Choose Avatar -->
                    <div id="step-avatar" class="flex flex-col min-h-0 h-full">
                        <!-- Header (fixed) -->
                        <div class="flex items-center border-b border-white/5 flex-shrink-0" style="padding:16px 20px;justify-content:space-between">
                            <div class="flex items-center gap-3">
                                <div class="rounded-xl bg-[#1a2f1a] flex items-center justify-center flex-shrink-0" style="width:36px;height:36px">
                                    <svg class="w-4 h-4 text-[#4ade80]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4.5 12.75l6 6 9-13.5"/>
                                    </svg>
                                </div>
                                <h3 class="font-medium text-white/90" style="font-size:1.1rem">Choose Your Avatar</h3>
                            </div>
                            <button id="shuffle-avatars" class="text-white/40 hover:text-white/80 transition rounded-lg hover:bg-white/[0.06]" style="padding:8px" title="Show more avatars">
                                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M20.016 4.66v4.993"/>
                                </svg>
                            </button>
                        </div>

                        <!-- Avatar Grid (scrollable) -->
                        <div class="flex-1 overflow-y-auto min-h-0" style="padding:20px">
                            <div id="avatar-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.625rem">
                                ${wallets.map((w, i) => `
                                    <button class="avatar-option group relative rounded-xl border-2 transition-all duration-150 ${i === 0 ? 'border-white/40 bg-white/[0.08]' : 'border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.12]'}" data-index="${i}" style="aspect-ratio:1;padding:10px">
                                        <div class="rounded-full overflow-hidden" style="width:100%;height:100%">${generateAvatar(w.address, 64, 0.5)}</div>
                                        <div class="avatar-check absolute w-5 h-5 rounded-full bg-white flex items-center justify-center ${i === 0 ? '' : 'hidden'}" style="top:6px;right:6px">
                                            <svg class="w-3 h-3 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4.5 12.75l6 6 9-13.5"/>
                                            </svg>
                                        </div>
                                    </button>
                                `).join('')}
                            </div>
                            
                            <!-- Info text -->
                            <p class="text-xs text-white/50 text-center" style="margin-top:14px">Your avatar is a unique visual identifier tied to your account.</p>
                        </div>

                        <!-- Footer (fixed) -->
                        <div class="border-t border-white/5 flex gap-3 flex-shrink-0" style="padding:14px 20px">
                            <button id="avatar-cancel-btn" class="flex-1 bg-white/5 hover:bg-white/10 text-white/70 text-sm font-medium py-3 rounded-xl transition border border-white/10">
                                Cancel
                            </button>
                            <button id="avatar-continue-btn" class="flex-1 bg-[#F6851B] hover:bg-[#e5780f] text-white text-sm font-medium py-3 rounded-xl transition">
                                Continue
                            </button>
                        </div>
                    </div>

                    <!-- Step 2: Account Details + Password -->
                    <div id="step-details" class="hidden flex-col min-h-0 h-full">
                        <!-- Header (fixed) -->
                        <div class="flex items-center border-b border-white/5 flex-shrink-0" style="padding:16px 20px">
                            <div class="flex items-center gap-3">
                                <div id="selected-avatar-preview" class="rounded-full overflow-hidden flex-shrink-0" style="width:38px;height:38px"></div>
                                <div>
                                    <h3 class="font-medium text-white/90" style="font-size:1.1rem">Set Up Account</h3>
                                    <p class="text-xs text-white/40">Secure your account with a password</p>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Content (scrollable) -->
                        <div class="flex-1 overflow-y-auto min-h-0 space-y-4" style="padding:20px">
                            <!-- Display Name -->
                            <div>
                                <label class="block text-xs font-medium text-white/40 uppercase tracking-wider mb-2">Display Name</label>
                                <input type="text" id="display-name-input" 
                                    class="w-full bg-white/5 border border-white/10 text-white px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-white/30 transition placeholder:text-white/20"
                                    placeholder="Your name (optional)" maxlength="32" autocomplete="off">
                            </div>
                            
                            <!-- Password -->
                            <div>
                                <label class="block text-xs font-medium text-white/40 uppercase tracking-wider mb-2">Password</label>
                                <div class="relative">
                                    <input type="password" id="password-input" 
                                        class="w-full bg-white/5 border border-white/10 text-white px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-white/30 transition placeholder:text-white/20" style="padding-right:2.75rem"
                                        placeholder="Min 12 chars, upper, lower, number" autocomplete="new-password">
                                    <button id="toggle-password" class="absolute top-1/2 -translate-y-1/2 text-white/40 hover:text-white/80 transition" style="right:12px">
                                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                        </svg>
                                    </button>
                                </div>
                                <!-- Password strength indicators -->
                                ${getPasswordStrengthHtml()}
                            </div>

                            <!-- Address -->
                            <div>
                                <label class="block text-xs font-medium text-white/40 uppercase tracking-wider mb-2">Address</label>
                                <div id="address-display" class="bg-white/5 border border-white/10 rounded-xl px-4 py-3 font-mono text-sm text-white/60 break-all">
                                </div>
                            </div>
                            
                            <!-- Private Key -->
                            <div>
                                <label class="block text-xs font-medium text-white/40 uppercase tracking-wider mb-2">Private Key</label>
                                <div class="bg-white/5 border border-white/10 rounded-xl px-4 py-3 relative">
                                    <div id="pk-hidden" class="font-mono text-sm text-white/30 select-none" style="padding-right:2rem">••••••••••••••••••••••••••••••••••••</div>
                                    <div id="pk-revealed" class="font-mono text-sm text-white/60 break-all hidden" style="padding-right:2rem"></div>
                                    <button id="toggle-pk" class="absolute top-1/2 -translate-y-1/2 text-white/40 hover:text-white/80 transition" style="right:12px">
                                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                        </svg>
                                    </button>
                                </div>
                                <button id="copy-pk" class="mt-2 w-full bg-white/5 hover:bg-white/10 border border-white/10 text-white/70 text-sm font-medium py-2.5 rounded-xl transition flex items-center justify-center gap-2">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"/>
                                    </svg>
                                    Copy Private Key
                                </button>
                            </div>
                            
                            <!-- Warning -->
                            <div class="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
                                <div class="flex gap-3">
                                    <svg class="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
                                    </svg>
                                    <div>
                                        <p class="text-amber-400 text-sm font-medium">Save your private key!</p>
                                        <p class="text-amber-400/60 text-xs mt-1">Store it safely offline. This is the only way to recover your account.</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Footer (fixed) -->
                        <div class="border-t border-white/5 flex gap-3 flex-shrink-0" style="padding:14px 20px">
                            <button id="details-back-btn" class="flex-1 bg-white/5 hover:bg-white/10 text-white/70 text-sm font-medium py-3 rounded-xl transition border border-white/10">
                                Back
                            </button>
                            <button id="details-continue-btn" disabled class="flex-1 bg-white/10 text-white/30 text-sm font-medium py-3 rounded-xl transition cursor-not-allowed">
                                Continue
                            </button>
                        </div>
                    </div>
                    
                    <!-- Step 3: Confirm Password -->
                    <div id="step-confirm" class="hidden flex-col min-h-0 h-full">
                        <!-- Header (fixed) -->
                        <div class="flex items-center border-b border-white/5 flex-shrink-0" style="padding:16px 20px">
                            <div>
                                <h3 class="font-medium text-white/90" style="font-size:1.1rem">Confirm Password</h3>
                                <p class="text-xs text-white/40 mt-0.5">Re-enter your password to confirm</p>
                            </div>
                        </div>
                        
                        <!-- Content wrapped in form for browser password save prompt -->
                        <form id="confirm-password-form" class="flex flex-col flex-1 min-h-0">
                            <!-- Hidden username field for browser password manager (uses wallet address) -->
                            <input type="text" id="new-account-username" name="username" 
                                class="hidden" 
                                autocomplete="username" 
                                value="" 
                                tabindex="-1" aria-hidden="true">
                            <div class="flex-1 overflow-y-auto min-h-0" style="padding:20px">
                                <div class="relative">
                                    <input type="password" id="confirm-password-input" name="password"
                                        class="w-full bg-white/5 border border-white/10 text-white px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-white/30 transition placeholder:text-white/20" style="padding-right:2.75rem"
                                        placeholder="Re-enter password" autocomplete="new-password">
                                    <button type="button" id="toggle-confirm-password" class="absolute top-1/2 -translate-y-1/2 text-white/40 hover:text-white/80 transition" style="right:12px">
                                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                        </svg>
                                    </button>
                                </div>
                                <p id="password-error" class="hidden text-xs text-red-400 mt-2">Passwords don't match</p>
                            </div>
                            
                            <!-- Footer (fixed) -->
                            <div class="border-t border-white/5 flex gap-3 flex-shrink-0" style="padding:14px 20px">
                                <button type="button" id="confirm-back-btn" class="flex-1 bg-white/5 hover:bg-white/10 text-white/70 text-sm font-medium py-3 rounded-xl transition border border-white/10">
                                    Back
                                </button>
                                <button type="submit" id="confirm-btn" class="flex-1 bg-[#F6851B] hover:bg-[#e5780f] text-white text-sm font-medium py-3 rounded-xl transition">
                                    Create Account
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            // ===== Step 1 (Avatar) Elements =====
            const stepAvatar = modal.querySelector('#step-avatar');
            const avatarGrid = modal.querySelector('#avatar-grid');
            const shuffleBtn = modal.querySelector('#shuffle-avatars');
            const avatarCancelBtn = modal.querySelector('#avatar-cancel-btn');
            const avatarContinueBtn = modal.querySelector('#avatar-continue-btn');

            // ===== Step 2 (Details) Elements =====
            const stepDetails = modal.querySelector('#step-details');
            const selectedAvatarPreview = modal.querySelector('#selected-avatar-preview');
            const addressDisplay = modal.querySelector('#address-display');
            const pkRevealed = modal.querySelector('#pk-revealed');
            const togglePkBtn = modal.querySelector('#toggle-pk');
            const pkHidden = modal.querySelector('#pk-hidden');
            const copyPkBtn = modal.querySelector('#copy-pk');
            const displayNameInput = modal.querySelector('#display-name-input');
            const passwordInput = modal.querySelector('#password-input');
            const togglePasswordBtn = modal.querySelector('#toggle-password');
            const detailsBackBtn = modal.querySelector('#details-back-btn');
            const detailsContinueBtn = modal.querySelector('#details-continue-btn');
            const newAccountUsername = modal.querySelector('#new-account-username');

            // ===== Step 3 (Confirm) Elements =====
            const stepConfirm = modal.querySelector('#step-confirm');
            const confirmPasswordInput = modal.querySelector('#confirm-password-input');
            const toggleConfirmPasswordBtn = modal.querySelector('#toggle-confirm-password');
            const confirmBackBtn = modal.querySelector('#confirm-back-btn');
            const passwordError = modal.querySelector('#password-error');

            // Helper to show/hide steps with correct flex display
            const showStep = (step) => { step.classList.remove('hidden'); step.style.display = 'flex'; };
            const hideStep = (step) => { step.classList.add('hidden'); step.style.display = ''; };

            // ===== Avatar Grid Logic =====
            const updateAvatarGrid = () => {
                avatarGrid.innerHTML = wallets.map((w, i) => `
                    <button class="avatar-option group relative rounded-xl border-2 transition-all duration-150 ${i === selectedIndex ? 'border-white/40 bg-white/[0.08]' : 'border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.12]'}" data-index="${i}" style="aspect-ratio:1;padding:10px">
                        <div class="rounded-full overflow-hidden" style="width:100%;height:100%">${generateAvatar(w.address, 64, 0.5)}</div>
                        <div class="avatar-check absolute w-5 h-5 rounded-full bg-white flex items-center justify-center ${i === selectedIndex ? '' : 'hidden'}" style="top:6px;right:6px">
                            <svg class="w-3 h-3 text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4.5 12.75l6 6 9-13.5"/>
                            </svg>
                        </div>
                    </button>
                `).join('');
                bindAvatarClicks();
            };

            const bindAvatarClicks = () => {
                avatarGrid.querySelectorAll('.avatar-option').forEach(btn => {
                    btn.addEventListener('click', () => {
                        selectedIndex = parseInt(btn.dataset.index);
                        // Update visual selection
                        avatarGrid.querySelectorAll('.avatar-option').forEach((b, i) => {
                            const isSelected = i === selectedIndex;
                            b.className = `avatar-option group relative flex items-center justify-center rounded-xl border-2 transition-all duration-150 ${isSelected ? 'border-white/40 bg-white/[0.08]' : 'border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.12]'}`;
                            const check = b.querySelector('.avatar-check');
                            if (check) check.classList.toggle('hidden', !isSelected);
                        });
                    });
                });
            };
            bindAvatarClicks();

            // Shuffle avatars
            shuffleBtn.addEventListener('click', () => {
                regenerateWallets();
                selectedIndex = 0;
                updateAvatarGrid();
            });

            // Cancel from avatar step
            avatarCancelBtn.addEventListener('click', () => {
                document.body.removeChild(modal);
                resolve('cancelled');
            });

            // Continue from avatar step to details step
            avatarContinueBtn.addEventListener('click', () => {
                const chosen = getSelectedWallet();
                hideStep(stepAvatar);
                showStep(stepDetails);
                // Show selected avatar in header
                selectedAvatarPreview.innerHTML = generateAvatar(chosen.address, 38, 0.5);
                // Populate address and private key
                addressDisplay.textContent = chosen.address;
                pkRevealed.textContent = chosen.privateKey;
                newAccountUsername.value = chosen.address.toLowerCase();
                // Reset pk visibility
                isPkRevealed = false;
                pkHidden.classList.remove('hidden');
                pkRevealed.classList.add('hidden');
                displayNameInput.focus();
            });

            // ===== Step 2 (Details) Logic =====
            
            // Setup password strength validation with callback to update continue button
            setupPasswordStrengthValidation(passwordInput, modal, (isValid) => {
                detailsContinueBtn.disabled = !isValid;
                detailsContinueBtn.className = isValid 
                    ? 'flex-1 bg-[#F6851B] hover:bg-[#e5780f] text-white text-sm font-medium py-3 rounded-xl transition'
                    : 'flex-1 bg-white/10 text-white/30 text-sm font-medium py-3 rounded-xl transition cursor-not-allowed';
            });

            // Back to avatar step
            detailsBackBtn.addEventListener('click', () => {
                hideStep(stepDetails);
                showStep(stepAvatar);
            });

            // Toggle private key visibility
            let isPkRevealed = false;
            togglePkBtn.addEventListener('click', () => {
                isPkRevealed = !isPkRevealed;
                pkHidden.classList.toggle('hidden', isPkRevealed);
                pkRevealed.classList.toggle('hidden', !isPkRevealed);
            });

            // Copy private key
            copyPkBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(getSelectedWallet().privateKey);
                    copyPkBtn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> Copied!`;
                    copyPkBtn.classList.add('text-emerald-400');
                    setTimeout(() => {
                        copyPkBtn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"/></svg> Copy Private Key`;
                        copyPkBtn.classList.remove('text-emerald-400');
                    }, 2000);
                } catch (err) {
                    // Fallback
                    const textarea = document.createElement('textarea');
                    textarea.value = getSelectedWallet().privateKey;
                    textarea.style.position = 'fixed';
                    textarea.style.opacity = '0';
                    document.body.appendChild(textarea);
                    textarea.select();
                    document.execCommand('copy');
                    document.body.removeChild(textarea);
                }
            });

            // Toggle password visibility
            setupPasswordToggle(togglePasswordBtn, passwordInput);

            // Continue to step 3
            detailsContinueBtn.addEventListener('click', () => {
                if (detailsContinueBtn.disabled) return;
                hideStep(stepDetails);
                showStep(stepConfirm);
                confirmPasswordInput.focus();
            });

            // ===== Step 3 (Confirm) Logic =====

            // Toggle confirm password visibility
            setupPasswordToggle(toggleConfirmPasswordBtn, confirmPasswordInput);

            // Back to step 2
            confirmBackBtn.addEventListener('click', () => {
                hideStep(stepConfirm);
                showStep(stepDetails);
                confirmPasswordInput.value = '';
                passwordError.classList.add('hidden');
            });

            // Confirm password form handler
            const confirmPasswordForm = modal.querySelector('#confirm-password-form');
            
            const handleConfirmPassword = async () => {
                if (confirmPasswordInput.value !== passwordInput.value) {
                    passwordError.classList.remove('hidden');
                    confirmPasswordInput.classList.add('border-red-400');
                    return;
                }

                const chosen = getSelectedWallet();

                const result = {
                    address: chosen.address,
                    privateKey: chosen.privateKey,
                    password: passwordInput.value,
                    displayName: displayNameInput.value.trim() || null
                };

                // Store credentials in browser's password manager (triggers save prompt)
                await storeCredentials(chosen.address, passwordInput.value);

                // Clear sensitive data
                passwordInput.value = '';
                confirmPasswordInput.value = '';

                document.body.removeChild(modal);
                resolve(result);
            };
            
            // Form submit for browser password save prompt
            confirmPasswordForm.addEventListener('submit', (e) => {
                e.preventDefault();
                handleConfirmPassword();
            });

            // Hide error on input
            confirmPasswordInput.addEventListener('input', () => {
                passwordError.classList.add('hidden');
                confirmPasswordInput.classList.remove('border-red-400');
            });

            passwordInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !detailsContinueBtn.disabled) detailsContinueBtn.click();
            });
        });
    }

    /**
     * Show Import Private Key modal with password setup
     * @returns {Promise<{privateKey: string, password: string|null}|null>}
     */
    async showImportPrivateKeyModal() {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4';
            modal.innerHTML = `
                <div class="bg-[#111113] rounded-2xl w-[420px] max-w-[95vw] shadow-2xl border border-white/[0.06] overflow-hidden">
                    <!-- Step 1: Import Private Key -->
                    <div id="step-1">
                        <!-- Header -->
                        <div class="flex items-center justify-between px-6 py-4 border-b border-white/5">
                            <div class="flex items-center gap-3">
                                <div class="w-9 h-9 rounded-xl bg-[#1a1f2e] flex items-center justify-center">
                                    <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/>
                                    </svg>
                                </div>
                                <div>
                                    <h3 class="text-lg font-medium text-white/90">Import Private Key</h3>
                                    <p class="text-xs text-white/40">Restore your account</p>
                                </div>
                            </div>
                            <button id="close-btn" class="text-white/40 hover:text-white/80 transition p-1">
                                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"/>
                                </svg>
                            </button>
                        </div>
                        
                        <!-- Content -->
                        <div class="p-6 space-y-4">
                            <!-- Private Key Input -->
                            <div>
                                <label class="block text-xs font-medium text-white/40 uppercase tracking-wider mb-2">Private Key</label>
                                <div class="relative">
                                    <input type="password" id="private-key-input" 
                                        class="w-full bg-white/5 border border-white/10 text-white px-4 py-3 rounded-xl text-sm font-mono focus:outline-none focus:border-white/30 transition placeholder:text-white/20 pr-11"
                                        placeholder="64 hex characters (with or without 0x)" autocomplete="off" spellcheck="false">
                                    <button id="toggle-pk" class="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/80 transition">
                                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                        </svg>
                                    </button>
                                </div>
                                <p id="pk-error" class="hidden text-xs text-red-400 mt-2">Invalid format - must be 64 hex characters</p>
                            </div>
                            
                            <!-- Divider -->
                            <div class="border-t border-white/5 pt-4">
                                <p class="text-xs text-white/40 mb-3">Set a password to save this account locally</p>
                            </div>
                            
                            <!-- Password -->
                            <div>
                                <label class="block text-xs font-medium text-white/40 uppercase tracking-wider mb-2">Password</label>
                                <div class="relative">
                                    <input type="password" id="password-input" 
                                        class="w-full bg-white/5 border border-white/10 text-white px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-white/30 transition placeholder:text-white/20 pr-11"
                                        placeholder="Min 12 chars, upper, lower, number" autocomplete="new-password">
                                    <button id="toggle-password" class="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/80 transition">
                                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                        </svg>
                                    </button>
                                </div>
                                <!-- Password strength indicators -->
                                ${getPasswordStrengthHtml()}
                            </div>
                        </div>
                        
                        <!-- Footer -->
                        <div class="px-6 py-4 border-t border-white/5 flex gap-3">
                            <button id="skip-btn" class="flex-1 bg-white/5 hover:bg-white/10 text-white/70 text-sm font-medium py-3 rounded-xl transition border border-white/10">
                                Continue without saving
                            </button>
                            <button id="save-btn" disabled class="flex-1 bg-white/10 text-white/30 text-sm font-medium py-3 rounded-xl transition cursor-not-allowed">
                                Save
                            </button>
                        </div>
                    </div>
                    
                    <!-- Step 2: Confirm Password -->
                    <div id="step-2" class="hidden">
                        <!-- Header -->
                        <div class="flex items-center justify-between px-6 py-4 border-b border-white/5">
                            <div>
                                <h3 class="text-lg font-medium text-white/90">Confirm Password</h3>
                                <p class="text-xs text-white/40 mt-0.5">Re-enter your password to confirm</p>
                            </div>
                        </div>
                        
                        <!-- Content wrapped in form for browser password save prompt -->
                        <form id="import-confirm-password-form">
                            <!-- Hidden username field for browser password manager -->
                            <input type="text" id="import-wallet-username" name="username" 
                                class="hidden" 
                                autocomplete="username" 
                                value="" 
                                tabindex="-1" aria-hidden="true">
                            <div class="p-6">
                                <div class="relative">
                                    <input type="password" id="confirm-password-input" name="password"
                                        class="w-full bg-white/5 border border-white/10 text-white px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-white/30 transition placeholder:text-white/20 pr-11"
                                        placeholder="Re-enter password" autocomplete="new-password">
                                    <button type="button" id="toggle-confirm-password" class="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/80 transition">
                                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                        </svg>
                                    </button>
                                </div>
                                <p id="password-error" class="hidden text-xs text-red-400 mt-2">Passwords don't match</p>
                            </div>
                            
                            <!-- Footer -->
                            <div class="px-6 py-4 border-t border-white/5 flex gap-3">
                                <button type="button" id="back-btn" class="flex-1 bg-white/5 hover:bg-white/10 text-white/70 text-sm font-medium py-3 rounded-xl transition border border-white/10">
                                    Back
                                </button>
                                <button type="submit" id="confirm-btn" class="flex-1 bg-[#F6851B] hover:bg-[#e5780f] text-white text-sm font-medium py-3 rounded-xl transition">
                                    Save
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            // Elements - Step 1
            const step1 = modal.querySelector('#step-1');
            const step2 = modal.querySelector('#step-2');
            const closeBtn = modal.querySelector('#close-btn');
            const privateKeyInput = modal.querySelector('#private-key-input');
            const togglePkBtn = modal.querySelector('#toggle-pk');
            const pkError = modal.querySelector('#pk-error');
            const passwordInput = modal.querySelector('#password-input');
            const togglePasswordBtn = modal.querySelector('#toggle-password');
            const skipBtn = modal.querySelector('#skip-btn');
            const saveBtn = modal.querySelector('#save-btn');
            
            // Elements - Step 2
            const confirmPasswordInput = modal.querySelector('#confirm-password-input');
            const toggleConfirmPasswordBtn = modal.querySelector('#toggle-confirm-password');
            const backBtn = modal.querySelector('#back-btn');
            const confirmBtn = modal.querySelector('#confirm-btn');
            const passwordError = modal.querySelector('#password-error');

            // Validation state
            let passwordValid = false;
            let isPkValid = false;

            // Normalize private key - add 0x if missing
            const normalizePrivateKey = (pk) => {
                pk = pk.trim();
                if (/^[a-fA-F0-9]{64}$/.test(pk)) {
                    return '0x' + pk;
                }
                return pk;
            };

            const validatePrivateKey = () => {
                const pk = normalizePrivateKey(privateKeyInput.value);
                // Valid: 64 hex chars with or without 0x prefix
                isPkValid = /^0x[a-fA-F0-9]{64}$/.test(pk);
                pkError.classList.toggle('hidden', isPkValid || privateKeyInput.value.trim().length === 0);
                privateKeyInput.classList.toggle('border-red-400', !isPkValid && privateKeyInput.value.trim().length > 0);
                updateSaveButton();
            };

            const updateSaveButton = () => {
                const allValid = isPkValid && passwordValid;
                saveBtn.disabled = !allValid;
                saveBtn.className = allValid 
                    ? 'flex-1 bg-[#F6851B] hover:bg-[#e5780f] text-white text-sm font-medium py-3 rounded-xl transition'
                    : 'flex-1 bg-white/10 text-white/30 text-sm font-medium py-3 rounded-xl transition cursor-not-allowed';
            };

            // Setup password strength validation with callback
            setupPasswordStrengthValidation(passwordInput, modal, (isValid) => {
                passwordValid = isValid;
                updateSaveButton();
            });

            const updateSkipButton = () => {
                skipBtn.disabled = !isPkValid;
                skipBtn.className = isPkValid 
                    ? 'flex-1 bg-white/5 hover:bg-white/10 text-white/70 text-sm font-medium py-3 rounded-xl transition border border-white/10'
                    : 'flex-1 bg-white/5 text-white/30 text-sm font-medium py-3 rounded-xl transition border border-white/10 cursor-not-allowed';
            };

            // Close button - return null
            closeBtn.addEventListener('click', () => {
                document.body.removeChild(modal);
                resolve(null);
            });

            // Click outside to close
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    document.body.removeChild(modal);
                    resolve(null);
                }
            });

            // Toggle private key visibility
            togglePkBtn.addEventListener('click', () => {
                privateKeyInput.type = privateKeyInput.type === 'password' ? 'text' : 'password';
            });

            // Private key validation on input
            privateKeyInput.addEventListener('input', () => {
                validatePrivateKey();
                updateSkipButton();
            });

            // Toggle password visibility
            setupPasswordToggle(togglePasswordBtn, passwordInput);

            // Skip - continue without saving
            skipBtn.addEventListener('click', () => {
                if (!isPkValid) return;
                const privateKey = normalizePrivateKey(privateKeyInput.value);
                privateKeyInput.value = '';
                passwordInput.value = '';
                document.body.removeChild(modal);
                resolve({ privateKey, password: null });
            });

            // Save - go to step 2
            saveBtn.addEventListener('click', () => {
                if (saveBtn.disabled) return;
                step1.classList.add('hidden');
                step2.classList.remove('hidden');
                // Update hidden username field with wallet address derived from private key
                try {
                    const wallet = new ethers.Wallet(normalizePrivateKey(privateKeyInput.value));
                    const importUsernameInput = modal.querySelector('#import-wallet-username');
                    if (importUsernameInput) importUsernameInput.value = wallet.address.toLowerCase();
                } catch (e) { /* ignore */ }
                confirmPasswordInput.focus();
            });

            // Toggle confirm password visibility
            setupPasswordToggle(toggleConfirmPasswordBtn, confirmPasswordInput);

            // Back to step 1
            backBtn.addEventListener('click', () => {
                step2.classList.add('hidden');
                step1.classList.remove('hidden');
                confirmPasswordInput.value = '';
                passwordError.classList.add('hidden');
            });

            // Confirm password form handler
            const importConfirmPasswordForm = modal.querySelector('#import-confirm-password-form');
            
            const handleImportConfirmPassword = async () => {
                if (confirmPasswordInput.value !== passwordInput.value) {
                    passwordError.classList.remove('hidden');
                    confirmPasswordInput.classList.add('border-red-400');
                    return;
                }

                // Get wallet address from private key for password manager
                let walletAddress = '';
                try {
                    const wallet = new ethers.Wallet(normalizePrivateKey(privateKeyInput.value));
                    walletAddress = wallet.address.toLowerCase();
                } catch (e) { /* ignore */ }

                const result = {
                    privateKey: normalizePrivateKey(privateKeyInput.value),
                    password: passwordInput.value
                };

                // Store credentials in browser's password manager (triggers save prompt)
                if (walletAddress) {
                    await storeCredentials(walletAddress, passwordInput.value);
                }

                // Clear sensitive data
                privateKeyInput.value = '';
                passwordInput.value = '';
                confirmPasswordInput.value = '';

                document.body.removeChild(modal);
                resolve(result);
            };
            
            // Form submit for browser password save prompt
            importConfirmPasswordForm.addEventListener('submit', (e) => {
                e.preventDefault();
                handleImportConfirmPassword();
            });

            // Hide error on input
            confirmPasswordInput.addEventListener('input', () => {
                passwordError.classList.add('hidden');
                confirmPasswordInput.classList.remove('border-red-400');
            });

            passwordInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !saveBtn.disabled) saveBtn.click();
            });

            privateKeyInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    if (!saveBtn.disabled) saveBtn.click();
                    else if (isPkValid) skipBtn.click();
                }
            });

            // Focus on private key input
            setTimeout(() => privateKeyInput.focus(), 100);
        });
    }

    /**
     * Save wallet with progress indicator (Keystore V3)
     * @param {string} password - Encryption password
     * @param {string} name - Optional wallet name
     */
    async saveWalletWithProgress(password, name = null) {
        const modal = this.showProgressModal('Encrypting Account', 'Using Keystore V3 with scrypt (n=262144)...');
        
        try {
            const result = await authManager.saveWalletEncrypted(password, name, (progress) => {
                this.updateProgressModal(modal, progress);
            });
            
            this.hideProgressModal(modal);
            uiController.showNotification(`Account "${result.name}" saved securely!`, 'success');
            return result;
        } catch (error) {
            this.hideProgressModal(modal);
            throw error;
        }
    }

    /**
     * Load wallet with progress indicator (Keystore V3)
     * @param {string} password - Decryption password
     * @param {string} address - Optional specific wallet address
     */
    async loadWalletWithProgress(password, address = null) {
        const modal = this.showProgressModal('Unlocking Account', 'Verifying your password...');
        
        try {
            const result = await authManager.loadWalletEncrypted(password, address, (progress) => {
                this.updateProgressModal(modal, progress);
            });
            
            this.hideProgressModal(modal);
            this.releaseWalletFlowUI();
            await this._onWalletConnected(result.address, result.signer);
            return result;
        } catch (error) {
            this.hideProgressModal(modal);
            throw error;
        }
    }

    /**
     * Show progress modal for encryption/decryption
     */
    showProgressModal(title, subtitle) {
        const modal = createModalFromTemplate('modal-progress', { title, subtitle });
        return modal;
    }

    /**
     * Update progress modal
     */
    updateProgressModal(modal, progress) {
        const percent = Math.round(progress * 100);
        const progressBar = $(modal, '[data-progress-bar]');
        const progressLabel = $(modal, '[data-progress-label]');
        
        if (progressBar) progressBar.style.width = `${percent}%`;
        if (progressLabel) progressLabel.textContent = `${percent}%`;
    }

    /**
     * Hide progress modal
     */
    hideProgressModal(modal) {
        if (modal && modal.parentNode) {
            modal.parentNode.removeChild(modal);
        }
    }

    /**
     * Show account selector for multiple saved accounts
     */
    async showWalletSelector(wallets) {
        // Helper to get display name - check ENS, username, then stored name
        const getDisplayName = (w, index) => {
            const ensName = localStorage.getItem(CONFIG.storageKeys.ens(w.address));
            if (ensName) return ensName;
            const username = localStorage.getItem(CONFIG.storageKeys.username(w.address));
            if (username) return username;
            const isDefaultName = !w.name || w.name.startsWith('Wallet ') || w.name.startsWith('Imported ') || w.name.startsWith('Account ');
            return isDefaultName ? `Account ${index + 1}` : w.name;
        };

        const hasENS = (w) => !!localStorage.getItem(CONFIG.storageKeys.ens(w.address));

        const getENSAvatarUrl = (w) => localStorage.getItem(CONFIG.storageKeys.ensAvatar(w.address));
        
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50 animate-fadeIn';
            modal.innerHTML = `
                <div class="bg-[#111113] rounded-2xl w-[360px] max-w-[calc(100%-2rem)] overflow-hidden shadow-2xl border border-white/[0.06] animate-slideUp">
                    <!-- Header -->
                    <div class="px-5 pt-5 pb-3">
                        <div class="flex items-center justify-between">
                            <h3 class="text-[15px] font-medium text-white">Select Account</h3>
                            <button id="close-modal" class="text-white/30 hover:text-white transition p-1 -mr-1">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    
                    <!-- Account List -->
                    <div class="px-5 pb-5">
                        <div class="space-y-2 max-h-60 overflow-y-auto scrollbar-thin">
                            ${wallets.map((w, i) => `
                                <button class="account-option w-full bg-white/[0.05] hover:bg-white/[0.08] rounded-xl p-3 border border-white/[0.08] hover:border-white/[0.12] transition-all text-left" data-address="${escapeAttr(w.address)}">
                                    <div class="flex items-center gap-3">
                                        <div class="w-14 h-14 rounded-full overflow-hidden flex-shrink-0">${getAvatarHtml(w.address, 56, 0.5, getENSAvatarUrl(w))}</div>
                                        <div class="flex-1 min-w-0">
                                            <div class="text-[13px] font-medium text-white truncate flex items-center gap-1.5">${hasENS(w) ? '<svg class="flex-shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" stroke="#4ade80" stroke-width="2" fill="none"/><path d="M7.5 12.5l3 3 6-6.5" stroke="#4ade80" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>' : ''}${escapeAttr(getDisplayName(w, i))}</div>
                                            <div class="text-[11px] text-white/50 font-mono">${w.address.slice(0, 6)}...${w.address.slice(-4)}</div>
                                        </div>
                                    </div>
                                </button>
                            `).join('')}
                        </div>
                    </div>
                </div>
            `;
            
            document.body.appendChild(modal);
            
            modal.querySelectorAll('.account-option').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const address = e.currentTarget.dataset.address;
                    document.body.removeChild(modal);
                    resolve(address);
                });
            });
            
            modal.querySelector('#close-modal').addEventListener('click', () => {
                document.body.removeChild(modal);
                resolve(null);
            });
            
            // Close on backdrop click
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    document.body.removeChild(modal);
                    resolve(null);
                }
            });
        });
    }

    /**
     * Import private key
     */
    async importPrivateKey() {
        try {
            const importResult = await this.showImportPrivateKeyModal();
            if (!importResult) return;

            const { privateKey, password } = importResult;

            // Disconnect the live session (guest, or the account being left by
            // Add account) to cleanup the client. Do this AFTER getting the
            // private key so user doesn't get disconnected if they cancel
            if (authManager.getAddress()) {
                await this._disconnectWallet({ skipFallback: true });
            }

            const result = authManager.importPrivateKey(privateKey);

            // Save encrypted if password was provided
            if (password) {
                await this.saveWalletWithProgress(password);
            }

            this.releaseWalletFlowUI();
            await this._onWalletConnected(result.address, result.signer);
            uiController.showNotification('Account imported!', 'success');
        } catch (error) {
            throw error;
        }
    }

    /**
     * Load saved wallet
     */
    async loadSavedWallet() {
        try {
            // Check if multiple wallets exist
            const savedWallets = authManager.listSavedWallets();
            let targetAddress = null;
            
            if (savedWallets.length > 1) {
                targetAddress = await this.showWalletSelector(savedWallets);
                if (!targetAddress) return;
            }
            
            const password = await this.showSecureInput(
                'Unlock Account',
                'Enter your account password:',
                'password',
                { walletAddress: (targetAddress || savedWallets[0]?.address)?.toLowerCase() }
            );
            if (!password) return;

            await this.loadWalletWithProgress(password, targetAddress);
        } catch (error) {
            throw error;
        }
    }
}

export const walletFlows = new WalletFlows();
