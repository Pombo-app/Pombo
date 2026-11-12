/**
 * A real channel image on an Explore card opens full size; tapping it must not
 * also open the channel, and a generated avatar stays inert.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/js/exploreCuration.js', () => ({
    loadCurationManifest: vi.fn(async () => ({})),
    applyCuration: vi.fn(channels => channels)
}));

vi.mock('../../src/js/channelImageManager.js', () => ({
    channelImageManager: {
        getCached: vi.fn(() => null),
        get: vi.fn(async () => null)
    }
}));

vi.mock('../../src/js/channelLatestMessageManager.js', () => ({
    channelLatestMessageManager: {
        getCached: vi.fn(() => null),
        get: vi.fn(async () => null),
        subscribe: vi.fn(() => () => {})
    }
}));

vi.mock('../../src/js/streamConstants.js', () => ({
    deriveAdminId: vi.fn(() => 'admin-1')
}));

vi.mock('../../src/js/ui/AvatarGenerator.js', () => ({
    getAvatarHtml: vi.fn(() => '<div class="generated-avatar"></div>')
}));

vi.mock('../../src/js/ui/channelPreviewFormatter.js', () => ({
    formatPreviewLine: vi.fn(() => '')
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: { ensCache: new Map(), resolveENS: vi.fn(async () => null) }
}));

vi.mock('../../src/js/channelEntry.js', () => ({
    openUnjoinedChannel: vi.fn(async () => {})
}));

import { exploreUI } from '../../src/js/ui/ExploreUI.js';
import { channelImageManager } from '../../src/js/channelImageManager.js';
import { openUnjoinedChannel } from '../../src/js/channelEntry.js';

const CHANNEL = { streamId: '0xabc/ch-1', name: 'Pigeons', type: 'public' };
const IMAGE = 'data:image/jpeg;base64,AAAA';

describe('Explore card channel image', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        channelImageManager.getCached.mockReturnValue(null);
        exploreUI.deps = {};
        exploreUI._exploreResolvedImages = new Set(['admin-1']);
        exploreUI._explorePreviewResolved = new Set([CHANNEL.streamId]);
        document.body.innerHTML = exploreUI.getTemplate(true);
    });

    it('marks a real image as zoomable and does not open the channel when it is tapped', async () => {
        channelImageManager.getCached.mockReturnValue({ dataUrl: IMAGE });
        exploreUI.renderChannelsList([CHANNEL]);

        const img = document.querySelector('.explore-channel-item img[data-zoom-image]');
        expect(img?.getAttribute('src')).toBe(IMAGE);
        expect(img.getAttribute('aria-label')).toBe('View channel image');
        img.click();
        await Promise.resolve();

        expect(openUnjoinedChannel).not.toHaveBeenCalled();
    });

    it('still opens the channel from the rest of the card', async () => {
        channelImageManager.getCached.mockReturnValue({ dataUrl: IMAGE });
        exploreUI.renderChannelsList([CHANNEL]);

        document.querySelector('.explore-channel-item h4').click();

        await vi.waitFor(() => expect(openUnjoinedChannel).toHaveBeenCalledTimes(1));
    });

    it('leaves a generated avatar inert', () => {
        exploreUI.renderChannelsList([CHANNEL]);

        expect(document.querySelector('.explore-channel-item .generated-avatar')).not.toBeNull();
        expect(document.querySelector('[data-zoom-image]')).toBeNull();
    });
});
