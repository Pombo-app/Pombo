/**
 * Tests for walletFlows.js - Wallet connection flows and callback wiring
 *
 * These tests focus on the pure logic and delegation patterns, not the DOM
 * modals (which require heavy browser mocking and are better tested via E2E).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
        generateLocalWallet: vi.fn(),
        importPrivateKey: vi.fn(),
        loadWalletEncrypted: vi.fn(),
        saveWalletEncrypted: vi.fn()
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        isStorageUnlocked: vi.fn().mockReturnValue(false),
        importAccountBackup: vi.fn(),
        cache: {}
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        loadChannels: vi.fn(),
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

vi.mock('../../src/js/ui/modalUtils.js', () => ({
    createModalFromTemplate: vi.fn(),
    closeModal: vi.fn(),
    setupModalCloseHandlers: vi.fn(),
    setupPasswordToggle: vi.fn(),
    $: vi.fn(),
    getPasswordStrengthHtml: vi.fn(() => ''),
    setupPasswordStrengthValidation: vi.fn()
}));

import { walletFlows } from '../../src/js/walletFlows.js';
import { authManager } from '../../src/js/auth.js';
import { uiController } from '../../src/js/ui.js';

// ─── Callback Wiring ──────────────────────────────────────────

describe('walletFlows.init (callback wiring)', () => {
    const mockCallbacks = {
        disconnectWallet: vi.fn(),
        onWalletConnected: vi.fn(),
        fallbackToGuest: vi.fn()
    };

    beforeEach(() => {
        vi.clearAllMocks();
        walletFlows.init(mockCallbacks);
    });

    it('should store disconnectWallet callback', () => {
        expect(walletFlows._disconnectWallet).toBe(mockCallbacks.disconnectWallet);
    });

    it('should store onWalletConnected callback', () => {
        expect(walletFlows._onWalletConnected).toBe(mockCallbacks.onWalletConnected);
    });

    it('should store fallbackToGuest callback', () => {
        expect(walletFlows._fallbackToGuest).toBe(mockCallbacks.fallbackToGuest);
    });
});

// ─── connectWallet branching ───────────────────────────────────

describe('walletFlows.connectWallet', () => {
    const mockCallbacks = {
        disconnectWallet: vi.fn(),
        onWalletConnected: vi.fn(),
        fallbackToGuest: vi.fn()
    };

    beforeEach(() => {
        vi.clearAllMocks();
        walletFlows.init(mockCallbacks);
    });

    it('should fallback to guest when no wallet connected after flow', async () => {
        // Simulate: not guest, no saved wallets, showCreateWalletModal completes without connecting
        authManager.isGuestMode.mockReturnValue(false);
        authManager.listSavedWallets.mockReturnValue([]);
        authManager.getAddress.mockReturnValue(null);

        // Mock showCreateWalletModal to resolve immediately (user cancelled)
        walletFlows.showCreateWalletModal = vi.fn().mockRejectedValue(new Error('cancelled'));

        await walletFlows.connectWallet();

        expect(mockCallbacks.fallbackToGuest).toHaveBeenCalledWith(
            'Continuing as Guest - connect an Account to save your data'
        );
    });

    it('should not fallback when address exists after flow', async () => {
        authManager.isGuestMode.mockReturnValue(false);
        authManager.listSavedWallets.mockReturnValue([]);
        authManager.getAddress.mockReturnValue('0xabc123');

        walletFlows.showCreateWalletModal = vi.fn().mockResolvedValue();

        await walletFlows.connectWallet();

        expect(mockCallbacks.fallbackToGuest).not.toHaveBeenCalled();
    });

    it('should show create modal when guest mode is active', async () => {
        authManager.isGuestMode.mockReturnValue(true);
        authManager.getAddress.mockReturnValue('0xguest');

        walletFlows.showCreateWalletModal = vi.fn().mockResolvedValue();

        await walletFlows.connectWallet();

        expect(walletFlows.showCreateWalletModal).toHaveBeenCalled();
    });

    it('should show unlock modal when saved wallets exist', async () => {
        const wallets = [{ address: '0x111', name: 'Test' }];
        authManager.isGuestMode.mockReturnValue(false);
        authManager.listSavedWallets.mockReturnValue(wallets);
        authManager.getAddress.mockReturnValue('0x111');

        walletFlows.showUnlockWalletModal = vi.fn().mockResolvedValue();

        await walletFlows.connectWallet();

        expect(walletFlows.showUnlockWalletModal).toHaveBeenCalledWith(wallets);
    });

    it('should show error notification on unexpected error', async () => {
        authManager.isGuestMode.mockReturnValue(false);
        authManager.listSavedWallets.mockReturnValue([]);
        authManager.getAddress.mockReturnValue('0xabc');

        walletFlows.showCreateWalletModal = vi.fn().mockRejectedValue(new Error('Network down'));

        await walletFlows.connectWallet();

        expect(uiController.showNotification).toHaveBeenCalledWith(
            'Failed to connect: Network down', 'error'
        );
    });

    it('should silently swallow "cancelled" errors', async () => {
        authManager.isGuestMode.mockReturnValue(false);
        authManager.listSavedWallets.mockReturnValue([]);
        authManager.getAddress.mockReturnValue('0xabc');

        walletFlows.showCreateWalletModal = vi.fn().mockRejectedValue(new Error('cancelled'));

        await walletFlows.connectWallet();

        expect(uiController.showNotification).not.toHaveBeenCalledWith(
            expect.stringContaining('Failed'), expect.any(String)
        );
    });
});

// ─── switchWallet guard logic ──────────────────────────────────

describe('walletFlows.switchWallet', () => {
    const mockCallbacks = {
        disconnectWallet: vi.fn().mockResolvedValue(),
        onWalletConnected: vi.fn().mockResolvedValue(),
        fallbackToGuest: vi.fn()
    };

    beforeEach(() => {
        vi.clearAllMocks();
        walletFlows.init(mockCallbacks);
    });

    it('should do nothing when only one wallet saved', async () => {
        authManager.listSavedWallets.mockReturnValue([{ address: '0x111' }]);

        await walletFlows.switchWallet();

        expect(mockCallbacks.disconnectWallet).not.toHaveBeenCalled();
    });

    it('should do nothing when no other wallets available', async () => {
        authManager.listSavedWallets.mockReturnValue([
            { address: '0xabc' },
            { address: '0xdef' }
        ]);
        authManager.getAddress.mockReturnValue('0xabc');

        // Mock selector to return null (cancelled)
        walletFlows.showWalletSelector = vi.fn().mockResolvedValue(null);

        await walletFlows.switchWallet();

        expect(mockCallbacks.disconnectWallet).not.toHaveBeenCalled();
    });

    it('should disconnect with skipFallback before switching', async () => {
        authManager.listSavedWallets.mockReturnValue([
            { address: '0xabc' },
            { address: '0xdef' }
        ]);
        authManager.getAddress.mockReturnValue('0xabc');

        walletFlows.showWalletSelector = vi.fn().mockResolvedValue('0xdef');
        walletFlows.showSecureInput = vi.fn().mockResolvedValue('password123');
        walletFlows.loadWalletWithProgress = vi.fn().mockResolvedValue();

        await walletFlows.switchWallet();

        expect(mockCallbacks.disconnectWallet).toHaveBeenCalledWith({ skipFallback: true });
        expect(walletFlows.loadWalletWithProgress).toHaveBeenCalledWith('password123', '0xdef');
        expect(uiController.showNotification).toHaveBeenCalledWith('Account switched', 'success');
    });

    it('should not proceed if password prompt cancelled', async () => {
        authManager.listSavedWallets.mockReturnValue([
            { address: '0xabc' },
            { address: '0xdef' }
        ]);
        authManager.getAddress.mockReturnValue('0xabc');

        walletFlows.showWalletSelector = vi.fn().mockResolvedValue('0xdef');
        walletFlows.showSecureInput = vi.fn().mockResolvedValue(null);

        await walletFlows.switchWallet();

        expect(mockCallbacks.disconnectWallet).not.toHaveBeenCalled();
    });
});
