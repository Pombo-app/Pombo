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
import { subscriptionBannerUI } from '../../src/js/ui/SubscriptionBannerUI.js';

const MESSAGES = [{ id: 'm1', text: 'hello', sender: '0xabc', timestamp: 1_789_000_000_000 }];

/** The strip fixed above the messages, then the scrolled list, as one string. */
function render({ hasMoreHistory, historyError, historyReadFailed = false, historyRetrying = false, overridesOwed = false, messages = MESSAGES }) {
    const channel = {
        streamId: '0xowner/chan-1',
        name: 'Chan',
        messages,
        hasMoreHistory,
        historyError,
        historyReadFailed,
        historyRetrying,
        overridesOwed
    };
    chatAreaUI.setDependencies({
        getActiveChannel: () => channel,
        channelManager: { getCurrentChannel: () => channel },
        authManager: { getAddress: () => '0xabc' }
    });
    chatAreaUI.renderMessages(messages);
    return document.getElementById('history-status-strip').innerHTML
        + document.getElementById('messages-area').innerHTML;
}

const PAGE = `
    <div id="history-status-strip" class="hidden"></div>
    <div id="messages-area" style="height: 500px; overflow-y: auto;"></div>
    <div id="message-input" contenteditable="true"></div>
`;

const claimsTheStart = (html) => html.includes('beginning of conversation');

describe('the start-of-history line', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        subscriptionBannerUI.stateOf.mockReturnValue('active');
        chatAreaUI.isLoadingMore = false;
        chatAreaUI._channelSwitching = false;
        chatAreaUI._loadOp = null;
        document.body.innerHTML = PAGE;
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

    it('stays away when the reads of the open gave up over what the cache holds', () => {
        expect(claimsTheStart(render({ hasMoreHistory: false, historyError: null, historyReadFailed: true }))).toBe(false);
    });

    it('stays away while the reads of the open are being read again', () => {
        expect(claimsTheStart(render({ hasMoreHistory: false, historyError: null, historyRetrying: true }))).toBe(false);
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

describe('the line for edits and deletions that did not come back', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        subscriptionBannerUI.stateOf.mockReturnValue('active');
        document.body.innerHTML = PAGE;
        chatAreaUI.init({
            messagesArea: document.getElementById('messages-area'),
            messageInput: document.getElementById('message-input')
        });
    });

    it('says they are still loading while they are read again', () => {
        const html = render({ hasMoreHistory: true, historyError: null, overridesOwed: true, historyRetrying: true });
        expect(html).toContain('Loading edits and deletions…');
    });

    it('says they could not be loaded once the reads gave up', () => {
        const html = render({ hasMoreHistory: false, historyError: null, overridesOwed: true, historyReadFailed: true });
        expect(html).toContain('Edits and deletions could not be loaded. Reopen the channel');
        expect(html).not.toContain('Loading edits and deletions');
    });

    it('is absent when they came back', () => {
        expect(render({ hasMoreHistory: true, historyError: null })).not.toContain('overrides-owed-banner');
    });

    it('sits in the strip above the messages, not in the list that scrolls', () => {
        render({ hasMoreHistory: true, historyError: null, overridesOwed: true, historyRetrying: true });
        const strip = document.getElementById('history-status-strip');
        expect(strip.classList.contains('hidden')).toBe(false);
        expect(strip.innerHTML).toContain('overrides-owed-banner');
        expect(document.getElementById('messages-area').innerHTML).not.toContain('overrides-owed-banner');
        // The floating pinned pill clears the strip by this height.
        expect(strip.parentElement.style.getPropertyValue('--history-strip-height')).toMatch(/^\d+px$/);
    });

    it('leaves an empty channel to its empty state, with the strip hidden', () => {
        render({ hasMoreHistory: true, historyError: null, overridesOwed: true, historyRetrying: true });
        render({ hasMoreHistory: false, historyError: null, overridesOwed: true, historyReadFailed: true, messages: [] });
        const strip = document.getElementById('history-status-strip');
        expect(strip.classList.contains('hidden')).toBe(true);
        expect(strip.innerHTML).toBe('');
    });
});

describe('the refusal banner over the messages', () => {
    const refused = { hasMoreHistory: false, historyError: { status: 403, signed: true, at: Date.now() } };

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = PAGE;
        chatAreaUI.init({
            messagesArea: document.getElementById('messages-area'),
            messageInput: document.getElementById('message-input')
        });
    });

    it('tells a moderator the node is behind, not that their access ended', () => {
        subscriptionBannerUI.stateOf.mockReturnValue(null);
        subscriptionBannerUI.hasAccess.mockReturnValue(true);
        const html = render(refused);
        expect(html).toContain('Channel history is temporarily unavailable');
        expect(html).not.toContain('Your access to this channel has ended');
    });

    it('tells a member of a token gate who lost access that it ended', () => {
        subscriptionBannerUI.stateOf.mockReturnValue(null);
        subscriptionBannerUI.hasAccess.mockReturnValue(false);
        expect(render(refused)).toContain('Your access to this channel has ended');
    });
});
