import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/js/ui/PinnedBannerUI.js', () => ({ pinnedBannerUI: { update: vi.fn() } }));
vi.mock('../../src/js/ui/SubscriptionBannerUI.js', () => ({ subscriptionBannerUI: { update: vi.fn() } }));

const { channelViewUI } = await import('../../src/js/ui/ChannelViewUI.js');
const { composerDrafts } = await import('../../src/js/composerDrafts.js');

const REPLY = { id: 'm1', text: 'hi', sender: '0x1', senderName: 'Bob' };

function setup(openStream) {
    const chatAreaUI = {
        hideTypingIndicator: vi.fn(),
        cancelReply: vi.fn(),
        cancelEdit: vi.fn(),
        getReplyingTo: vi.fn(() => REPLY),
        getEditingMessage: vi.fn(() => null),
        hideLoadingMoreIndicator: vi.fn(),
        _cancelPendingAutoLoad: vi.fn(),
        isLoadingMore: false
    };
    const setReplyingTo = vi.fn();
    channelViewUI.setDependencies({
        channelManager: { currentChannel: openStream, setCurrentChannel: vi.fn(), getCurrentChannel: () => null },
        previewModeUI: { isInPreviewMode: () => false },
        chatAreaUI,
        inputUI: { messageInput: { textContent: 'answer' }, clear: vi.fn() },
        getAccount: () => '0xme',
        setReplyingTo,
        stopAccessHeartbeat: vi.fn()
    });
    return { chatAreaUI, setReplyingTo };
}

describe('channelViewUI.selectChannel and the composer', () => {
    beforeEach(() => composerDrafts.clear());

    it('keeps the reply when the open conversation is selected again', async () => {
        const { chatAreaUI, setReplyingTo } = setup('chan-1');
        await channelViewUI.selectChannel('chan-1');
        expect(chatAreaUI.cancelReply).not.toHaveBeenCalled();
        expect(setReplyingTo).not.toHaveBeenCalled();
        expect(composerDrafts.take('0xme', 'chan-1')).toBeNull();
    });

    it('moves the reply into the draft of the conversation being left', async () => {
        const { chatAreaUI, setReplyingTo } = setup('chan-1');
        await channelViewUI.selectChannel('chan-2');
        expect(chatAreaUI.cancelReply).toHaveBeenCalled();
        expect(setReplyingTo).toHaveBeenCalledWith(null);
        expect(composerDrafts.take('0xme', 'chan-1')).toEqual({ text: 'answer', replyTo: REPLY, editing: null });
    });
});
