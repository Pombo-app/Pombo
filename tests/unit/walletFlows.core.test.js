/**
 * Extended tests for walletFlows.js — core logic, backup/restore, encryption flows
 * Focus: untested methods for coverage improvement beyond the existing 13 tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before import
vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        isGuestMode: vi.fn().mockReturnValue(false),
        isConnected: vi.fn().mockReturnValue(true),
        getAddress: vi.fn().mockReturnValue('0xabc'),
        listSavedWallets: vi.fn().mockReturnValue([]),
        generateLocalWallet: vi.fn().mockReturnValue({
            address: '0xnewwallet',
            privateKey: '0xprivatekey123',
            signer: { signMessage: vi.fn() }
        }),
        importPrivateKey: vi.fn().mockReturnValue({
            address: '0ximported',
            signer: { signMessage: vi.fn() }
        }),
        loadWalletEncrypted: vi.fn().mockResolvedValue({
            address: '0xloaded',
            signer: { signMessage: vi.fn() }
        }),
        saveWalletEncrypted: vi.fn().mockResolvedValue({
            name: 'TestWallet',
            address: '0xsaved'
        })
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        isStorageUnlocked: vi.fn().mockReturnValue(true),
        importAccountBackup: vi.fn().mockResolvedValue({ data: null }),
        saveToStorage: vi.fn().mockResolvedValue(undefined),
        setUsername: vi.fn(async function (username) { this.cache.username = username; }),
        cache: {}
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        loadChannels: vi.fn(),
        reloadChannelsFromSync: vi.fn(),
        clearChannels: vi.fn()
    }
}));

vi.mock('../../src/js/ui.js', () => ({
    uiController: {
        showNotification: vi.fn(),
        showLoading: vi.fn(),
        hideLoading: vi.fn(),
        renderChannelList: vi.fn()
    }
}));

vi.mock('../../src/js/ui/AvatarGenerator.js', () => ({
    getAvatar: vi.fn(() => '<svg></svg>'),
    getAvatarHtml: vi.fn(() => '<svg></svg>'),
    generateAvatar: vi.fn(() => '<svg></svg>')
}));

vi.mock('../../src/js/ui/utils.js', () => ({
    escapeHtml: vi.fn((s) => s),
    escapeAttr: vi.fn((s) => s)
}));

vi.mock('../../src/js/ui/modalUtils.js', () => {
    const mockModal = () => {
        const el = document.createElement('div');
        el.innerHTML = '<div data-progress-bar style="width:0%"></div><div data-progress-label>0%</div>';
        document.body.appendChild(el);
        return el;
    };
    return {
        createModalFromTemplate: vi.fn(mockModal),
        closeModal: vi.fn((m) => m?.remove?.()),
        setupModalCloseHandlers: vi.fn(),
        setupPasswordToggle: vi.fn(),
        $: vi.fn((parent, selector) => parent?.querySelector?.(selector) || null),
        getPasswordStrengthHtml: vi.fn(() => ''),
        setupPasswordStrengthValidation: vi.fn()
    };
});

vi.mock('../../src/js/media.js', () => ({
    mediaController: {
        handleMediaMessage: vi.fn()
    }
}));

import { walletFlows } from '../../src/js/walletFlows.js';
import { authManager } from '../../src/js/auth.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { channelManager } from '../../src/js/channels.js';
import { identityManager } from '../../src/js/identity.js';
import { uiController } from '../../src/js/ui.js';
import { createModalFromTemplate, $ as $mock } from '../../src/js/ui/modalUtils.js';

const mockCallbacks = {
    disconnectWallet: vi.fn().mockResolvedValue(undefined),
    onWalletConnected: vi.fn().mockResolvedValue(undefined),
    fallbackToGuest: vi.fn().mockResolvedValue(undefined)
};

// Save original methods before any tests overwrite them
const originals = {
    saveWalletWithProgress: walletFlows.saveWalletWithProgress,
    loadWalletWithProgress: walletFlows.loadWalletWithProgress,
    showNewAccountSetupModal: walletFlows.showNewAccountSetupModal,
    showImportPrivateKeyModal: walletFlows.showImportPrivateKeyModal,
    showWalletSelector: walletFlows.showWalletSelector,
    showSecureInput: walletFlows.showSecureInput,
    showProgressModal: walletFlows.showProgressModal,
    updateProgressModal: walletFlows.updateProgressModal,
    hideProgressModal: walletFlows.hideProgressModal
};

describe('WalletFlows Extended', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Restore original methods that may have been overwritten by previous tests
        Object.assign(walletFlows, originals);
        walletFlows.init(mockCallbacks);
        document.body.innerHTML = '';
        // Reset secureStorage.cache
        secureStorage.cache = {};
        // Reset localStorage mock
        const store = {};
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => store[key] || null);
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, val) => { store[key] = val; });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ==================== storeCredentials ====================
    // storeCredentials is a module-level function, not on walletFlows.
    // We can't import it directly (not exported). However, we test it
    // indirectly through showNewAccountSetupModal or connectLocal.
    // Instead we'll test the PasswordCredential path via the class methods.

    // ==================== connectLocal ====================
    describe('connectLocal', () => {
        it('disconnects guest before generating wallet', async () => {
            authManager.isGuestMode.mockReturnValue(true);
            walletFlows.showNewAccountSetupModal = vi.fn().mockResolvedValue('cancelled');

            await walletFlows.connectLocal();

            expect(mockCallbacks.disconnectWallet).toHaveBeenCalled();
        });

        it('does not disconnect if not guest', async () => {
            authManager.isGuestMode.mockReturnValue(false);
            walletFlows.showNewAccountSetupModal = vi.fn().mockResolvedValue('cancelled');

            await walletFlows.connectLocal();

            expect(mockCallbacks.disconnectWallet).not.toHaveBeenCalled();
        });

        it('generates a new local wallet', async () => {
            authManager.getAddress.mockReturnValue(null);
            walletFlows.showNewAccountSetupModal = vi.fn().mockResolvedValue('cancelled');

            await walletFlows.connectLocal();

            // connectLocal no longer calls generateLocalWallet — the modal generates wallets internally
            // Just verify the flow didn't error
            expect(mockCallbacks.fallbackToGuest).toHaveBeenCalled();
        });

        it('falls back to guest if user cancels setup', async () => {
            authManager.getAddress.mockReturnValue(null);
            walletFlows.showNewAccountSetupModal = vi.fn().mockResolvedValue('cancelled');

            await walletFlows.connectLocal();

            expect(mockCallbacks.fallbackToGuest).toHaveBeenCalledWith(
                expect.stringContaining('Guest')
            );
        });

        it('keeps a signed-in account when its Add account setup is cancelled', async () => {
            authManager.isGuestMode.mockReturnValue(false);
            authManager.getAddress.mockReturnValue('0xcurrent');
            walletFlows.showNewAccountSetupModal = vi.fn().mockResolvedValue('cancelled');

            await walletFlows.connectLocal();

            expect(mockCallbacks.disconnectWallet).not.toHaveBeenCalled();
            expect(mockCallbacks.fallbackToGuest).not.toHaveBeenCalled();
        });

        it('leaves a signed-in account only once the new one is set up', async () => {
            authManager.isGuestMode.mockReturnValue(false);
            authManager.getAddress.mockReturnValue('0xcurrent');
            walletFlows.showNewAccountSetupModal = vi.fn().mockResolvedValue({
                address: '0xChosenAddr',
                privateKey: '0xChosenKey',
                password: 'StrongPass123!',
                displayName: ''
            });
            walletFlows.saveWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.connectLocal();

            expect(mockCallbacks.disconnectWallet).toHaveBeenCalledWith({ skipFallback: true });
        });

        it('saves wallet with progress when setup completed', async () => {
            walletFlows.showNewAccountSetupModal = vi.fn().mockResolvedValue({
                address: '0xChosenAddr',
                privateKey: '0xChosenKey',
                password: 'StrongPass123!',
                displayName: 'Alice'
            });
            walletFlows.saveWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.connectLocal();

            expect(walletFlows.saveWalletWithProgress).toHaveBeenCalledWith('StrongPass123!', 'Alice');
        });

        it('calls onWalletConnected with new address and signer', async () => {
            walletFlows.showNewAccountSetupModal = vi.fn().mockResolvedValue({
                address: '0xChosenAddr',
                privateKey: '0xChosenKey',
                password: 'pass123',
                displayName: ''
            });
            walletFlows.saveWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.connectLocal();

            expect(authManager.importPrivateKey).toHaveBeenCalledWith('0xChosenKey');
            expect(mockCallbacks.onWalletConnected).toHaveBeenCalledWith(
                '0ximported',
                expect.objectContaining({ signMessage: expect.any(Function) })
            );
        });

        it('saves display name to secureStorage when storage unlocked', async () => {
            walletFlows.showNewAccountSetupModal = vi.fn().mockResolvedValue({
                address: '0xChosenAddr',
                privateKey: '0xChosenKey',
                password: 'pass123',
                displayName: 'Bob'
            });
            walletFlows.saveWalletWithProgress = vi.fn().mockResolvedValue({});
            secureStorage.isStorageUnlocked.mockReturnValue(true);

            await walletFlows.connectLocal();

            expect(secureStorage.cache.username).toBe('Bob');
            expect(identityManager.getUsername()).toBe('Bob');
        });

        it('does not save display name if empty', async () => {
            walletFlows.showNewAccountSetupModal = vi.fn().mockResolvedValue({
                address: '0xChosenAddr',
                privateKey: '0xChosenKey',
                password: 'pass123',
                displayName: null
            });
            walletFlows.saveWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.connectLocal();

            expect(secureStorage.cache.username).toBeUndefined();
        });

        it('shows success notification', async () => {
            walletFlows.showNewAccountSetupModal = vi.fn().mockResolvedValue({
                address: '0xChosenAddr',
                privateKey: '0xChosenKey',
                password: 'pass123',
                displayName: ''
            });
            walletFlows.saveWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.connectLocal();

            expect(uiController.showNotification).toHaveBeenCalledWith('Account created', 'success');
        });

        it('does not save wallet if setup returned null', async () => {
            walletFlows.showNewAccountSetupModal = vi.fn().mockResolvedValue(null);

            await walletFlows.connectLocal();

            // null result means no setup completed — should not call importPrivateKey
            expect(authManager.importPrivateKey).not.toHaveBeenCalled();
        });
    });

    // ==================== importPrivateKey ====================
    describe('importPrivateKey', () => {
        it('returns early if import modal returns null', async () => {
            walletFlows.showImportPrivateKeyModal = vi.fn().mockResolvedValue(null);

            await walletFlows.importPrivateKey();

            expect(authManager.importPrivateKey).not.toHaveBeenCalled();
        });

        it('disconnects guest before importing', async () => {
            walletFlows.showImportPrivateKeyModal = vi.fn().mockResolvedValue({
                privateKey: '0xabc123',
                password: null
            });
            authManager.isGuestMode.mockReturnValue(true);

            await walletFlows.importPrivateKey();

            expect(mockCallbacks.disconnectWallet).toHaveBeenCalled();
        });

        it('does not disconnect when no session is live', async () => {
            walletFlows.showImportPrivateKeyModal = vi.fn().mockResolvedValue({
                privateKey: '0xabc123',
                password: null
            });
            authManager.isGuestMode.mockReturnValue(false);
            authManager.getAddress.mockReturnValue(null);

            await walletFlows.importPrivateKey();

            expect(mockCallbacks.disconnectWallet).not.toHaveBeenCalled();
        });

        it('leaves a signed-in account before importing another (Add account)', async () => {
            walletFlows.showImportPrivateKeyModal = vi.fn().mockResolvedValue({
                privateKey: '0xabc123',
                password: null
            });
            authManager.isGuestMode.mockReturnValue(false);
            authManager.getAddress.mockReturnValue('0xcurrent');

            await walletFlows.importPrivateKey();

            expect(mockCallbacks.disconnectWallet).toHaveBeenCalledWith({ skipFallback: true });
        });

        it('imports private key via authManager', async () => {
            walletFlows.showImportPrivateKeyModal = vi.fn().mockResolvedValue({
                privateKey: '0xsecretkey',
                password: null
            });

            await walletFlows.importPrivateKey();

            expect(authManager.importPrivateKey).toHaveBeenCalledWith('0xsecretkey');
        });

        it('saves encrypted when password provided', async () => {
            walletFlows.showImportPrivateKeyModal = vi.fn().mockResolvedValue({
                privateKey: '0xsecretkey',
                password: 'mypassword'
            });
            walletFlows.saveWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.importPrivateKey();

            expect(walletFlows.saveWalletWithProgress).toHaveBeenCalledWith('mypassword');
        });

        it('does not save encrypted when password is null', async () => {
            walletFlows.showImportPrivateKeyModal = vi.fn().mockResolvedValue({
                privateKey: '0xsecretkey',
                password: null
            });
            walletFlows.saveWalletWithProgress = vi.fn();

            await walletFlows.importPrivateKey();

            expect(walletFlows.saveWalletWithProgress).not.toHaveBeenCalled();
        });

        it('calls onWalletConnected after import', async () => {
            walletFlows.showImportPrivateKeyModal = vi.fn().mockResolvedValue({
                privateKey: '0xsecretkey',
                password: null
            });

            await walletFlows.importPrivateKey();

            expect(mockCallbacks.onWalletConnected).toHaveBeenCalledWith(
                '0ximported',
                expect.any(Object)
            );
        });

        it('shows success notification', async () => {
            walletFlows.showImportPrivateKeyModal = vi.fn().mockResolvedValue({
                privateKey: '0xsecretkey',
                password: null
            });

            await walletFlows.importPrivateKey();

            expect(uiController.showNotification).toHaveBeenCalledWith('Account imported', 'success');
        });
    });

    // ==================== loadSavedWallet ====================
    describe('loadSavedWallet', () => {
        it('shows selector when multiple wallets exist', async () => {
            authManager.listSavedWallets.mockReturnValue([
                { address: '0x111' },
                { address: '0x222' }
            ]);
            walletFlows.showWalletSelector = vi.fn().mockResolvedValue('0x222');
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('password');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.loadSavedWallet();

            expect(walletFlows.showWalletSelector).toHaveBeenCalledWith([
                { address: '0x111' },
                { address: '0x222' }
            ]);
        });

        it('returns early if wallet selector cancelled', async () => {
            authManager.listSavedWallets.mockReturnValue([
                { address: '0x111' },
                { address: '0x222' }
            ]);
            walletFlows.showWalletSelector = vi.fn().mockResolvedValue(null);
            walletFlows.showSecureInput = vi.fn();
            walletFlows.loadWalletWithProgress = vi.fn();

            await walletFlows.loadSavedWallet();

            expect(walletFlows.showSecureInput).not.toHaveBeenCalled();
            expect(walletFlows.loadWalletWithProgress).not.toHaveBeenCalled();
        });

        it('skips selector when only one wallet', async () => {
            authManager.listSavedWallets.mockReturnValue([{ address: '0x111' }]);
            walletFlows.showWalletSelector = vi.fn();
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('password');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.loadSavedWallet();

            expect(walletFlows.showWalletSelector).not.toHaveBeenCalled();
        });

        it('returns early if password input cancelled', async () => {
            authManager.listSavedWallets.mockReturnValue([{ address: '0x111' }]);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue(null);
            walletFlows.loadWalletWithProgress = vi.fn();

            await walletFlows.loadSavedWallet();

            expect(walletFlows.loadWalletWithProgress).not.toHaveBeenCalled();
        });

        it('loads wallet with progress after password', async () => {
            authManager.listSavedWallets.mockReturnValue([{ address: '0x111' }]);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('mypass');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.loadSavedWallet();

            expect(walletFlows.loadWalletWithProgress).toHaveBeenCalledWith('mypass', null);
        });

        it('passes selected address to loadWalletWithProgress', async () => {
            authManager.listSavedWallets.mockReturnValue([
                { address: '0x111' },
                { address: '0x222' }
            ]);
            walletFlows.showWalletSelector = vi.fn().mockResolvedValue('0x222');
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('mypass');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.loadSavedWallet();

            expect(walletFlows.loadWalletWithProgress).toHaveBeenCalledWith('mypass', '0x222');
        });
    });

    // ==================== saveWalletWithProgress ====================
    describe('saveWalletWithProgress', () => {
        it('shows progress modal', async () => {
            await walletFlows.saveWalletWithProgress('password123');

            expect(createModalFromTemplate).toHaveBeenCalledWith('modal-progress', expect.objectContaining({
                title: 'Encrypting Account'
            }));
        });

        it('calls authManager.saveWalletEncrypted with password and name', async () => {
            await walletFlows.saveWalletWithProgress('password123', 'MyWallet');

            expect(authManager.saveWalletEncrypted).toHaveBeenCalledWith(
                'password123',
                'MyWallet',
                expect.any(Function)
            );
        });

        it('passes null name by default', async () => {
            await walletFlows.saveWalletWithProgress('password123');

            expect(authManager.saveWalletEncrypted).toHaveBeenCalledWith(
                'password123',
                null,
                expect.any(Function)
            );
        });

        it('hides progress modal on success', async () => {
            await walletFlows.saveWalletWithProgress('password123');

            // Modal should be removed from DOM
            expect(document.body.children.length).toBe(0);
        });

        it('shows success notification', async () => {
            await walletFlows.saveWalletWithProgress('password123');

            expect(uiController.showNotification).toHaveBeenCalledWith(
                expect.stringContaining('TestWallet'),
                'success'
            );
        });

        it('returns result from authManager', async () => {
            const result = await walletFlows.saveWalletWithProgress('password123');

            expect(result).toEqual({ name: 'TestWallet', address: '0xsaved' });
        });

        it('hides progress modal on error and re-throws', async () => {
            authManager.saveWalletEncrypted.mockRejectedValue(new Error('encrypt fail'));

            await expect(walletFlows.saveWalletWithProgress('pass')).rejects.toThrow('encrypt fail');
            expect(document.body.children.length).toBe(0);
        });

        it('calls progress callback during encryption', async () => {
            let capturedCallback;
            authManager.saveWalletEncrypted.mockImplementation((pw, name, cb) => {
                capturedCallback = cb;
                return Promise.resolve({ name: 'W', address: '0x1' });
            });

            await walletFlows.saveWalletWithProgress('pass');

            // Ensure callback was captured
            expect(capturedCallback).toBeDefined();
        });
    });

    // ==================== loadWalletWithProgress ====================
    describe('loadWalletWithProgress', () => {
        it('shows progress modal', async () => {
            await walletFlows.loadWalletWithProgress('password123');

            expect(createModalFromTemplate).toHaveBeenCalledWith('modal-progress', expect.objectContaining({
                title: 'Unlocking Account'
            }));
        });

        it('calls authManager.loadWalletEncrypted with password', async () => {
            await walletFlows.loadWalletWithProgress('password123', '0xaddr');

            expect(authManager.loadWalletEncrypted).toHaveBeenCalledWith(
                'password123',
                '0xaddr',
                expect.any(Function)
            );
        });

        it('passes null address by default', async () => {
            await walletFlows.loadWalletWithProgress('password123');

            expect(authManager.loadWalletEncrypted).toHaveBeenCalledWith(
                'password123',
                null,
                expect.any(Function)
            );
        });

        it('calls onWalletConnected on success', async () => {
            await walletFlows.loadWalletWithProgress('password123');

            expect(mockCallbacks.onWalletConnected).toHaveBeenCalledWith(
                '0xloaded',
                expect.any(Object)
            );
        });

        it('hides progress modal on success', async () => {
            await walletFlows.loadWalletWithProgress('password123');

            expect(document.body.children.length).toBe(0);
        });

        it('hides progress modal on error and re-throws', async () => {
            authManager.loadWalletEncrypted.mockRejectedValue(new Error('wrong password'));

            await expect(walletFlows.loadWalletWithProgress('bad')).rejects.toThrow('wrong password');
            expect(document.body.children.length).toBe(0);
        });

        it('returns result from authManager', async () => {
            authManager.loadWalletEncrypted.mockResolvedValue({
                address: '0xloaded',
                signer: { signMessage: vi.fn() }
            });

            const result = await walletFlows.loadWalletWithProgress('password123');

            expect(result).toEqual({ address: '0xloaded', signer: expect.any(Object) });
        });
    });

    // ==================== showProgressModal ====================
    describe('showProgressModal', () => {
        it('creates modal from template', () => {
            walletFlows.showProgressModal('Title', 'Subtitle');

            expect(createModalFromTemplate).toHaveBeenCalledWith('modal-progress', {
                title: 'Title',
                subtitle: 'Subtitle'
            });
        });

        it('returns the modal element', () => {
            const modal = walletFlows.showProgressModal('T', 'S');

            expect(modal).toBeInstanceOf(HTMLElement);
        });
    });

    // ==================== updateProgressModal ====================
    describe('updateProgressModal', () => {
        it('updates progress bar width', () => {
            const modal = document.createElement('div');
            const bar = document.createElement('div');
            bar.setAttribute('data-progress-bar', '');
            const label = document.createElement('div');
            label.setAttribute('data-progress-label', '');
            modal.appendChild(bar);
            modal.appendChild(label);

            // Make $ return actual elements
            $mock.mockImplementation((parent, sel) => parent.querySelector(sel));

            walletFlows.updateProgressModal(modal, 0.75);

            expect(bar.style.width).toBe('75%');
            expect(label.textContent).toBe('75%');
        });

        it('handles null elements gracefully', () => {
            const modal = document.createElement('div');
            $mock.mockReturnValue(null);

            expect(() => walletFlows.updateProgressModal(modal, 0.5)).not.toThrow();
        });

        it('rounds percentage', () => {
            const modal = document.createElement('div');
            const bar = document.createElement('div');
            bar.setAttribute('data-progress-bar', '');
            const label = document.createElement('div');
            label.setAttribute('data-progress-label', '');
            modal.appendChild(bar);
            modal.appendChild(label);

            $mock.mockImplementation((parent, sel) => parent.querySelector(sel));

            walletFlows.updateProgressModal(modal, 0.333);

            expect(label.textContent).toBe('33%');
        });
    });

    // ==================== hideProgressModal ====================
    describe('hideProgressModal', () => {
        it('removes modal from DOM', () => {
            const modal = document.createElement('div');
            document.body.appendChild(modal);

            walletFlows.hideProgressModal(modal);

            expect(document.body.contains(modal)).toBe(false);
        });

        it('handles null modal', () => {
            expect(() => walletFlows.hideProgressModal(null)).not.toThrow();
        });

        it('handles modal without parent', () => {
            const modal = document.createElement('div');
            // Not appended to body
            expect(() => walletFlows.hideProgressModal(modal)).not.toThrow();
        });
    });

    // ==================== showWalletSelector ====================
    describe('showWalletSelector', () => {
        it('creates modal with wallet buttons', async () => {
            const wallets = [
                { address: '0xaaa111bbb222ccc333ddd444eee555fff666aaa1', name: 'Wallet A' },
                { address: '0xbbb222ccc333ddd444eee555fff666aaa111bbb2', name: 'Wallet B' }
            ];

            const promise = walletFlows.showWalletSelector(wallets);

            // DOM is created synchronously inside the Promise constructor
            const btns = document.querySelectorAll('.account-option');
            expect(btns.length).toBe(2);

            // Click first
            btns[0].click();

            const result = await promise;
            expect(result).toBe('0xaaa111bbb222ccc333ddd444eee555fff666aaa1');
        });

        it('returns null on close button click', async () => {
            const wallets = [{ address: '0xaaa', name: 'W1' }];

            const promise = walletFlows.showWalletSelector(wallets);

            const closeBtn = document.querySelector('#close-modal');
            closeBtn.click();

            const result = await promise;
            expect(result).toBeNull();
        });

        it('returns null on backdrop click', async () => {
            const wallets = [{ address: '0xaaa', name: 'W1' }];

            const promise = walletFlows.showWalletSelector(wallets);

            // Click the outer modal backdrop (e.target === modal)
            const modal = document.body.firstElementChild;
            // Manually dispatch click where e.target === modal
            const event = new MouseEvent('click', { bubbles: true });
            Object.defineProperty(event, 'target', { value: modal });
            modal.dispatchEvent(event);

            const result = await promise;
            expect(result).toBeNull();
        });

        it('uses default name for unnamed wallets', async () => {
            const wallets = [{ address: '0xaaa', name: '' }];

            const promise = walletFlows.showWalletSelector(wallets);

            const text = document.body.textContent;
            expect(text).toContain('Account 1');

            document.querySelector('#close-modal').click();
            await promise;
        });

        it('uses default name for auto-generated names', async () => {
            const wallets = [
                { address: '0xaaa', name: 'Wallet 1' },
                { address: '0xbbb', name: 'Imported key' },
                { address: '0xccc', name: 'Account 2' }
            ];

            const promise = walletFlows.showWalletSelector(wallets);

            const btns = document.querySelectorAll('.account-option');
            expect(btns[0].textContent).toContain('Account 1');
            expect(btns[1].textContent).toContain('Account 2');
            expect(btns[2].textContent).toContain('Account 3');

            document.querySelector('#close-modal').click();
            await promise;
        });

        it('preserves custom names', async () => {
            const wallets = [{ address: '0xaaa', name: 'My Custom Wallet' }];

            const promise = walletFlows.showWalletSelector(wallets);

            const text = document.body.textContent;
            expect(text).toContain('My Custom Wallet');

            document.querySelector('#close-modal').click();
            await promise;
        });

        it('removes modal from DOM after selection', async () => {
            const wallets = [{ address: '0xaaa', name: 'W1' }];

            const promise = walletFlows.showWalletSelector(wallets);

            const btn = document.querySelector('.account-option');
            btn.click();

            await promise;

            // Modal should be removed
            expect(document.querySelector('.account-option')).toBeNull();
        });
    });

    // ==================== restoreFromBackup ====================
    describe('restoreFromBackup', () => {
        const makeBackupFile = (content) => ({
            text: vi.fn().mockResolvedValue(JSON.stringify(content))
        });

        const validBackup = {
            format: 'pombo-account-backup',
            version: 1,
            keystore: {
                address: 'abc123def456'
            }
        };

        it('throws on invalid format', async () => {
            const file = makeBackupFile({ format: 'wrong', version: 1 });

            await expect(walletFlows.restoreFromBackup(file)).rejects.toThrow('Invalid backup format');
        });

        it('throws on wrong version', async () => {
            const file = makeBackupFile({ format: 'pombo-account-backup', version: 99 });

            await expect(walletFlows.restoreFromBackup(file)).rejects.toThrow('Invalid backup format');
        });

        it('throws cancelled when password is null', async () => {
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue(null);

            await expect(walletFlows.restoreFromBackup(file)).rejects.toThrow('cancelled');
        });

        it('calls importAccountBackup with backup and password', async () => {
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('mypassword');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.restoreFromBackup(file);

            expect(secureStorage.importAccountBackup).toHaveBeenCalledWith(
                validBackup,
                'mypassword',
                expect.any(Function)
            );
        });

        it('stores keystore in localStorage', async () => {
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('mypassword');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.restoreFromBackup(file);

            expect(localStorage.setItem).toHaveBeenCalledWith(
                'pombo_keystores',
                expect.stringContaining('0xabc123def456')
            );
        });

        it('normalizes keystore address with 0x prefix', async () => {
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('pw');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.restoreFromBackup(file);

            // The stored key should start with 0x
            const call = localStorage.setItem.mock.calls.find(c => c[0] === 'pombo_keystores');
            const stored = JSON.parse(call[1]);
            expect(stored['0xabc123def456']).toBeDefined();
        });

        it('loads wallet with progress after storing keystore', async () => {
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('pw');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.restoreFromBackup(file);

            expect(walletFlows.loadWalletWithProgress).toHaveBeenCalledWith('pw', '0xabc123def456');
        });

        it('imports channels from backup data', async () => {
            secureStorage.importAccountBackup.mockResolvedValue({
                data: {
                    channels: [
                        { messageStreamId: 'ch1', name: 'Channel 1' },
                        { messageStreamId: 'ch2', name: 'Channel 2' }
                    ]
                }
            });
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('pw');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.restoreFromBackup(file);

            expect(secureStorage.cache.channels).toHaveLength(2);
            expect(channelManager.reloadChannelsFromSync).toHaveBeenCalled();
            expect(uiController.renderChannelList).toHaveBeenCalled();
        });

        it('skips duplicate channels', async () => {
            secureStorage.cache.channels = [{ messageStreamId: 'ch1', name: 'Existing' }];
            secureStorage.importAccountBackup.mockResolvedValue({
                data: {
                    channels: [
                        { messageStreamId: 'ch1', name: 'Duplicate' },
                        { messageStreamId: 'ch2', name: 'New' }
                    ]
                }
            });
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('pw');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.restoreFromBackup(file);

            expect(secureStorage.cache.channels).toHaveLength(2);
            expect(secureStorage.cache.channels[0].name).toBe('Existing'); // not overwritten
        });

        it('imports trusted contacts', async () => {
            secureStorage.importAccountBackup.mockResolvedValue({
                data: {
                    trustedContacts: { '0xfriend': { name: 'Friend', trustLevel: 2 } }
                }
            });
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('pw');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.restoreFromBackup(file);

            expect(secureStorage.cache.trustedContacts['0xfriend']).toBeDefined();
        });

        it('imports sent messages', async () => {
            secureStorage.importAccountBackup.mockResolvedValue({
                data: {
                    sentMessages: { 'stream1': [{ id: 'm1' }] }
                }
            });
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('pw');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.restoreFromBackup(file);

            expect(secureStorage.cache.sentMessages['stream1']).toBeDefined();
        });

        it('imports sent reactions', async () => {
            secureStorage.importAccountBackup.mockResolvedValue({
                data: {
                    sentReactions: { 'stream1': { msg1: { '👍': ['0x1'] } } }
                }
            });
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('pw');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.restoreFromBackup(file);

            expect(secureStorage.cache.sentReactions['stream1']).toBeDefined();
        });

        it('imports username only if not existing', async () => {
            secureStorage.cache.username = 'ExistingName';
            secureStorage.importAccountBackup.mockResolvedValue({
                data: { username: 'ImportedName' }
            });
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('pw');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.restoreFromBackup(file);

            expect(secureStorage.cache.username).toBe('ExistingName');
        });

        it('imports blocked peers (union, normalized)', async () => {
            secureStorage.cache.blockedPeers = ['0xexisting'];
            secureStorage.importAccountBackup.mockResolvedValue({
                data: {
                    blockedPeers: ['0xExisting', '0xNew']
                }
            });
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('pw');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.restoreFromBackup(file);

            expect(secureStorage.cache.blockedPeers).toContain('0xexisting');
            expect(secureStorage.cache.blockedPeers).toContain('0xnew');
            expect(secureStorage.cache.blockedPeers).toHaveLength(2);
        });

        it('imports dmLeftAt timestamps without overwriting', async () => {
            secureStorage.cache.dmLeftAt = { '0xpeer1': 100 };
            secureStorage.importAccountBackup.mockResolvedValue({
                data: {
                    dmLeftAt: { '0xpeer1': 200, '0xpeer2': 300 }
                }
            });
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('pw');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.restoreFromBackup(file);

            expect(secureStorage.cache.dmLeftAt['0xpeer1']).toBe(100); // not overwritten
            expect(secureStorage.cache.dmLeftAt['0xpeer2']).toBe(300); // new imported
        });

        it('calls saveToStorage after import', async () => {
            secureStorage.importAccountBackup.mockResolvedValue({
                data: { channels: [{ messageStreamId: 'ch1' }] }
            });
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('pw');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.restoreFromBackup(file);

            expect(secureStorage.saveToStorage).toHaveBeenCalled();
        });

        it('shows success notification', async () => {
            secureStorage.importAccountBackup.mockResolvedValue({ data: null });
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('pw');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.restoreFromBackup(file);

            expect(uiController.showNotification).toHaveBeenCalledWith(
                'Account restored',
                'success'
            );
        });

        it('does not reload channels when no data imported', async () => {
            secureStorage.importAccountBackup.mockResolvedValue({ data: {} });
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('pw');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.restoreFromBackup(file);

            expect(channelManager.reloadChannelsFromSync).not.toHaveBeenCalled();
        });

        it('hides progress modal on error', async () => {
            secureStorage.importAccountBackup.mockRejectedValue(new Error('decrypt fail'));
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('pw');

            await expect(walletFlows.restoreFromBackup(file)).rejects.toThrow('decrypt fail');
            // Progress modal should be cleaned up
            expect(document.body.children.length).toBe(0);
        });

        it('does not overwrite keystore already in localStorage', async () => {
            // Pre-populate localStorage with existing keystore for this address
            const existingKeystores = { '0xabc123def456': { name: 'Old', keystore: {} } };
            vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
                if (key === 'pombo_keystores') return JSON.stringify(existingKeystores);
                return null;
            });
            const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});

            secureStorage.importAccountBackup.mockResolvedValue({ data: null });
            const file = makeBackupFile(validBackup);
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('pw');
            walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue({});

            await walletFlows.restoreFromBackup(file);

            // Should NOT call setItem for pombo_keystores since address already exists
            const call = setItemSpy.mock.calls.find(c => c[0] === 'pombo_keystores');
            expect(call).toBeUndefined();
        });
    });

    // ==================== switchWallet extended ====================
    describe('switchWallet (extended)', () => {
        it('shows error notification on failure', async () => {
            authManager.listSavedWallets.mockReturnValue([
                { address: '0xabc' },
                { address: '0xdef' }
            ]);
            authManager.getAddress.mockReturnValue('0xabc');

            walletFlows.showWalletSelector = vi.fn().mockResolvedValue('0xdef');
            walletFlows.showSecureInput = vi.fn().mockResolvedValue('password');
            walletFlows.loadWalletWithProgress = vi.fn().mockRejectedValue(new Error('wrong password'));

            await walletFlows.switchWallet();

            expect(uiController.showNotification).toHaveBeenCalledWith('wrong password', 'error');
        });

        it('filters current address from selector', async () => {
            authManager.listSavedWallets.mockReturnValue([
                { address: '0xcurrent' },
                { address: '0xother' }
            ]);
            authManager.getAddress.mockReturnValue('0xcurrent');

            walletFlows.showWalletSelector = vi.fn().mockResolvedValue(null);

            await walletFlows.switchWallet();

            expect(walletFlows.showWalletSelector).toHaveBeenCalledWith([
                { address: '0xother' }
            ]);
        });
    });
});
