import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/js/ui/PinnedBannerUI.js', () => ({ pinnedBannerUI: { update: vi.fn() } }));
vi.mock('../../src/js/ui/SubscriptionBannerUI.js', () => ({ subscriptionBannerUI: { update: vi.fn() } }));

const { channelViewUI } = await import('../../src/js/ui/ChannelViewUI.js');

describe('channelViewUI.showExploreView', () => {
    it('titles the header Explore Channels in the mobile view too, so a later desktop view shows no stale channel', async () => {
        const el = () => document.createElement('div');
        const info = el();
        el().appendChild(info);
        const currentChannelName = el();
        currentChannelName.textContent = 'Last channel opened';
        channelViewUI.setDependencies({
            isMobileView: () => true,
            previewModeUI: { isInPreviewMode: () => false },
            headerUI: { clearChannelThumb: vi.fn() },
            exploreUI: { getTemplate: () => '', setupListeners: vi.fn(), resetFilters: vi.fn(), loadChannels: vi.fn(async () => {}) },
            secureStorage: { getNsfwEnabled: () => false }
        });
        channelViewUI.setElements({ currentChannelName, currentChannelInfo: info, messagesArea: el() });

        await channelViewUI.showExploreView();

        expect(currentChannelName.textContent).toBe('Explore Channels');
    });
});
