/**
 * "— beginning of conversation —" is a claim about someone else's history, so
 * it may only appear when the client actually reached the start. A refused
 * storage read also clears `hasMoreHistory`, and printing the line there told
 * the reader the conversation began at whatever the local cache happened to
 * hold.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/ui/NotificationUI.js', () => ({
    notificationUI: { showLoadingMoreIndicator: vi.fn(), hideLoadingMoreIndicator: vi.fn() }
}));
vi.mock('../../src/js/ui/MessageRenderer.js', () => ({
    messageRenderer: {
        buildMessageHTML: vi.fn(() => '<div class="message-entry">msg</div>'),
        buildMessageGroupOpenHTML: vi.fn(() => '<div class="message-group">'),
        buildMessageGroupCloseHTML: vi.fn(() => '</div>'),
        renderDateSeparator: vi.fn(() => '')
    }
}));
vi.mock('../../src/js/ui/ReactionManager.js', () => ({
    reactionManager: { attachReactionListeners: vi.fn(), loadFromChannelState: vi.fn() }
}));
vi.mock('../../src/js/ui/MediaHandler.js', () => ({
    mediaHandler: { attachLightboxListeners: vi.fn() }
}));
vi.mock('../../src/js/ui/PreviewModeUI.js', () => ({
    previewModeUI: { getPreviewChannel: vi.fn(() => null), isInPreviewMode: vi.fn(() => false) }
}));
vi.mock('../../src/js/ui/PinnedBannerUI.js', () => ({
    pinnedBannerUI: { update: vi.fn() }
}));
vi.mock('../../src/js/ui/SubscriptionBannerUI.js', () => ({
    subscriptionBannerUI: { update: vi.fn(), stateOf: vi.fn(() => 'active') }
}));
vi.mock('../../src/js/ui/MessageGrouper.js', () => ({
    analyzeMessageGroups: vi.fn(() => []),
    getGroupPositionClass: vi.fn(() => ''),
    analyzeSpacing: vi.fn(() => []),
    getSpacingClass: vi.fn(() => ''),
    shouldGroup: vi.fn(() => false)
}));
vi.mock('../../src/js/ui/utils.js', () => ({
    escapeHtml: vi.fn(s => s || ''),
    formatAddress: vi.fn(a => a ? a.substring(0, 8) : '')
}));
vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        getENSAvatarUrl: vi.fn(() => null),
        getUserNickname: vi.fn(() => null),
        getCachedENSAvatar: vi.fn(() => null)
    }
}));
vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import { chatAreaUI } from '../../src/js/ui/ChatAreaUI.js';
import { subscriptionBannerUI } from '../../src/js/ui/SubscriptionBannerUI.js';

const MESSAGES = [{ id: 'm1', text: 'hello', sender: '0xabc', timestamp: 1_789_000_000_000 }];

function render({ hasMoreHistory, historyError }) {
    const channel = {
        streamId: '0xowner/chan-1',
        name: 'Chan',
        messages: MESSAGES,
        hasMoreHistory,
        historyError
    };
    chatAreaUI.setDependencies({
        getActiveChannel: () => channel,
        channelManager: { getCurrentChannel: () => channel },
        authManager: { getAddress: () => '0xabc' }
    });
    chatAreaUI.renderMessages(MESSAGES);
    return document.getElementById('messages-area').innerHTML;
}

const claimsTheStart = (html) => html.includes('beginning of conversation');

describe('the start-of-history line', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        subscriptionBannerUI.stateOf.mockReturnValue('active');
        chatAreaUI.isLoadingMore = false;
        chatAreaUI._channelSwitching = false;
        chatAreaUI._loadOp = null;
        document.body.innerHTML = `
            <div id="messages-area" style="height: 500px; overflow-y: auto;"></div>
            <div id="message-input" contenteditable="true"></div>
        `;
        chatAreaUI.init({
            messagesArea: document.getElementById('messages-area'),
            messageInput: document.getElementById('message-input')
        });
    });

    it('appears once the client has really reached the start', () => {
        expect(claimsTheStart(render({ hasMoreHistory: false, historyError: null }))).toBe(true);
    });

    it('stays away while there is more to page in', () => {
        expect(claimsTheStart(render({ hasMoreHistory: true, historyError: null }))).toBe(false);
    });

    it('stays away when the storage node refused the read', () => {
        const html = render({
            hasMoreHistory: false,
            historyError: { status: 403, signed: true, at: Date.now() }
        });
        expect(claimsTheStart(html)).toBe(false);
        expect(html).toContain('history-error-banner');
    });

    it('stays away on a lapsed gate, where the subscription strip explains instead', () => {
        subscriptionBannerUI.stateOf.mockReturnValue('expired');
        const html = render({
            hasMoreHistory: false,
            historyError: { status: 403, signed: true, at: Date.now() }
        });
        expect(claimsTheStart(html)).toBe(false);
        expect(html).not.toContain('history-error-banner');
    });
});
