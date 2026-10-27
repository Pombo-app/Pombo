/**
 * An empty message area must never claim more than it knows: a slow load says
 * it is slow (and offers to retry) rather than "No messages yet", and an empty
 * DM invites the first message.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
    subscriptionBannerUI: { update: vi.fn(), stateOf: vi.fn(() => 'active'), hasAccess: vi.fn(() => true) }
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

const PAGE = `
    <div id="history-status-strip" class="hidden"></div>
    <div id="messages-area" style="height: 500px; overflow-y: auto;"></div>
    <div id="message-input" contenteditable="true"></div>
`;

let switchGeneration = 0;
const reopenChannel = vi.fn();

function render(fields) {
    const channel = { streamId: '0xowner/chan-1', name: 'Chan', messages: [], ...fields };
    chatAreaUI.setDependencies({
        getActiveChannel: () => channel,
        channelManager: { getCurrentChannel: () => channel, switchGeneration },
        authManager: { getAddress: () => '0xabc' },
        reopenChannel
    });
    chatAreaUI.renderMessages([]);
    return document.getElementById('messages-area').innerHTML;
}

const loading = { initialLoadInProgress: true, hasMoreHistory: true };

describe('empty message area', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        switchGeneration++;
        chatAreaUI.isLoadingMore = false;
        chatAreaUI._channelSwitching = false;
        chatAreaUI._loadOp = null;
        chatAreaUI._loadingSince = null;
        document.body.innerHTML = PAGE;
        chatAreaUI.init({
            messagesArea: document.getElementById('messages-area'),
            messageInput: document.getElementById('message-input')
        });
    });

    afterEach(() => vi.useRealTimers());

    it('says it is slow after 30 s of loading, never that the channel is empty', () => {
        expect(render(loading)).toContain('Loading messages');
        vi.advanceTimersByTime(29_999);
        expect(document.getElementById('messages-area').innerHTML).toContain('Loading messages');
        vi.advanceTimersByTime(1);
        const html = document.getElementById('messages-area').innerHTML;
        expect(html).toContain('Taking longer than usual');
        expect(html).not.toContain('No messages yet');
    });

    it('keeps the 30 s from the first render across re-renders of the same open', () => {
        render(loading);
        vi.advanceTimersByTime(20_000);
        render(loading);
        vi.advanceTimersByTime(10_000);
        expect(document.getElementById('messages-area').innerHTML).toContain('Taking longer than usual');
    });

    it('Try again reopens the channel and shows the spinner again', () => {
        render(loading);
        vi.advanceTimersByTime(30_000);
        document.getElementById('messages-retry-btn').click();
        expect(reopenChannel).toHaveBeenCalledTimes(1);
        expect(document.getElementById('messages-area').innerHTML).toContain('Loading messages');
    });

    it('an empty DM offers to say hello into the composer, without sending', () => {
        const html = render({ type: 'dm', hasMoreHistory: false });
        expect(html).toContain('No messages yet');
        document.getElementById('dm-say-hello-btn').click();
        expect(document.getElementById('message-input').textContent).toBe('Hello 👋');
    });

    it('an empty channel keeps its plain line', () => {
        const html = render({ type: 'public', hasMoreHistory: false });
        expect(html).toContain('No messages yet. Start the conversation!');
        expect(html).not.toContain('dm-say-hello-btn');
    });
});
