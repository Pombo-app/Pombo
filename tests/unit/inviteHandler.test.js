/**
 * Tests for inviteHandler.js - Invite link detection, dialog and channel joining
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
        isConnected: vi.fn().mockReturnValue(false)
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        parseInviteLink: vi.fn(),
        joinChannel: vi.fn()
    }
}));

vi.mock('../../src/js/ui.js', () => ({
    uiController: {
        showLoading: vi.fn(),
        hideLoading: vi.fn(),
        showNotification: vi.fn(),
        renderChannelList: vi.fn()
    }
}));

vi.mock('../../src/js/notifications.js', () => ({
    notificationManager: {
        acceptInvite: vi.fn().mockResolvedValue(undefined),
        dismissInvite: vi.fn()
    }
}));

vi.mock('../../src/js/ui/utils.js', () => ({
    escapeHtml: vi.fn((str) => str)
}));

vi.mock('../../src/js/ui/sanitizer.js', () => ({
    sanitizeText: vi.fn((str) => str)
}));

vi.mock('../../src/js/ui/modalUtils.js', () => ({
    createModalFromTemplate: vi.fn(),
    bindData: vi.fn(),
    closeModal: vi.fn(),
    setupModalCloseHandlers: vi.fn(),
    $: vi.fn()
}));

vi.mock('../../src/js/media.js', () => ({
    mediaController: {
        handleMediaMessage: vi.fn()
    }
}));

import { inviteHandler } from '../../src/js/inviteHandler.js';
import { authManager } from '../../src/js/auth.js';
import { channelManager } from '../../src/js/channels.js';
import { uiController } from '../../src/js/ui.js';
import { notificationManager } from '../../src/js/notifications.js';
import { escapeHtml } from '../../src/js/ui/utils.js';

beforeEach(() => {
    vi.clearAllMocks();
    inviteHandler.pendingInvite = null;
});

// ─── getChannelTypeLabel ───────────────────────────────────────

describe('inviteHandler.getChannelTypeLabel', () => {
    it('should return "Public Channel" for public type', () => {
        expect(inviteHandler.getChannelTypeLabel('public')).toBe('Public Channel');
    });

    it('should return "Password Protected" for password type', () => {
        expect(inviteHandler.getChannelTypeLabel('password')).toBe('Password Protected');
    });

    it('should return "Gated Channel (on-chain)" for gated type', () => {
        expect(inviteHandler.getChannelTypeLabel('gated')).toBe('Gated Channel (on-chain)');
    });

    it('should escape unknown types to prevent XSS', () => {
        escapeHtml.mockReturnValue('&lt;script&gt;');
        const result = inviteHandler.getChannelTypeLabel('<script>');
        expect(escapeHtml).toHaveBeenCalledWith('<script>');
        expect(result).toBe('&lt;script&gt;');
    });

    it('should handle null/undefined type gracefully', () => {
        escapeHtml.mockReturnValue('Unknown');
        expect(inviteHandler.getChannelTypeLabel(null)).toBe('Unknown');
        expect(inviteHandler.getChannelTypeLabel(undefined)).toBe('Unknown');
    });
});

// ─── checkInviteLink ───────────────────────────────────────────

describe('inviteHandler.checkInviteLink', () => {
    let originalLocation;

    beforeEach(() => {
        originalLocation = window.location;
        delete window.location;
        window.location = {
            search: '',
            pathname: '/test',
            hash: ''
        };
        window.history.replaceState = vi.fn();
    });

    afterEach(() => {
        window.location = originalLocation;
    });

    it('should do nothing when no invite token in hash', async () => {
        window.location.hash = '';
        await inviteHandler.checkInviteLink();
        expect(channelManager.parseInviteLink).not.toHaveBeenCalled();
        expect(inviteHandler.pendingInvite).toBeNull();
    });

    it('should do nothing when invite code is invalid', async () => {
        window.location.hash = '#/invite/bad-code';
        channelManager.parseInviteLink.mockResolvedValue(null);

        await inviteHandler.checkInviteLink();
        expect(channelManager.parseInviteLink).toHaveBeenCalledWith('bad-code');
        expect(inviteHandler.pendingInvite).toBeNull();
    });

    it('should store pending invite when not connected', async () => {
        const inviteData = { name: 'Test', type: 'public', streamId: '0xabc/test-1' };
        window.location.hash = '#/invite/valid-code';
        channelManager.parseInviteLink.mockResolvedValue(inviteData);
        authManager.isConnected.mockReturnValue(false);

        await inviteHandler.checkInviteLink();

        expect(inviteHandler.pendingInvite).toEqual(inviteData);
        expect(window.history.replaceState).toHaveBeenCalled();
    });

    it('should clear URL after processing invite', async () => {
        const inviteData = { name: 'Test', type: 'public', streamId: '0xabc/test-1' };
        window.location.hash = '#/invite/v2/valid-code';
        channelManager.parseInviteLink.mockResolvedValue(inviteData);
        authManager.isConnected.mockReturnValue(false);

        await inviteHandler.checkInviteLink();

        expect(window.history.replaceState).toHaveBeenCalledWith(
            {}, document.title, '/test'
        );
    });
});

// ─── joinChannelFromInvite ─────────────────────────────────────

describe('inviteHandler.joinChannelFromInvite', () => {
    it('should join channel and show success notification', async () => {
        const inviteData = { streamId: '0xabc/test-1', password: 'pw', name: 'Test', type: 'public' };
        channelManager.joinChannel.mockResolvedValue(undefined);

        await inviteHandler.joinChannelFromInvite(inviteData);

        expect(uiController.showLoading).toHaveBeenCalledWith('Joining channel…');
        expect(channelManager.joinChannel).toHaveBeenCalledWith('0xabc/test-1', 'pw', {
            name: 'Test',
            type: 'public'
        });
        expect(uiController.renderChannelList).toHaveBeenCalled();
        expect(uiController.showNotification).toHaveBeenCalledWith('Joined channel', 'success');
        expect(uiController.hideLoading).toHaveBeenCalled();
    });

    it('should show error notification on failure', async () => {
        const inviteData = { streamId: '0xabc/test-1', name: 'Test', type: 'public' };
        channelManager.joinChannel.mockRejectedValue(new Error('No permission'));

        await inviteHandler.joinChannelFromInvite(inviteData);

        expect(uiController.showNotification).toHaveBeenCalledWith(
            'Failed to join channel: No permission', 'error'
        );
        expect(uiController.hideLoading).toHaveBeenCalled();
    });
});

// ─── acceptInvite / dismissInvite ──────────────────────────────

describe('inviteHandler.acceptInvite', () => {
    it('should delegate to notificationManager and re-render channels', async () => {
        await inviteHandler.acceptInvite('invite-123');
        expect(notificationManager.acceptInvite).toHaveBeenCalledWith('invite-123');
        expect(uiController.renderChannelList).toHaveBeenCalled();
    });
});

describe('inviteHandler.dismissInvite', () => {
    it('should delegate to notificationManager', () => {
        inviteHandler.dismissInvite('invite-456');
        expect(notificationManager.dismissInvite).toHaveBeenCalledWith('invite-456');
    });
});
