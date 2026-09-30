/**
 * What removing a member says about the channel key. Only the owner rotates
 * it: their own device does it now or owes it, and a moderator's removal is
 * left to the owner's next open.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock('../../src/js/ui/ModalManager.js', () => ({ modalManager: { show: vi.fn(), hide: vi.fn() } }));
vi.mock('../../src/js/relayManager.js', () => ({ relayManager: {} }));
vi.mock('../../src/js/graph.js', () => ({ graphAPI: {} }));
vi.mock('../../src/js/identity.js', () => ({ identityManager: { getCachedENS: vi.fn(() => null) } }));
vi.mock('../../src/js/media.js', () => ({ mediaController: {} }));
vi.mock('../../src/js/channelImageManager.js', () => ({ channelImageManager: {} }));

const { channelSettingsUI } = await import('../../src/js/ui/ChannelSettingsUI.js');

const CHANNEL = { streamId: '0xowner/room-1' };
const MEMBER = '0x03e2b466754f187f571ab48c69e3ab592e76d819';

describe('removing a member', () => {
    let channelManager;
    let showNotification;

    beforeEach(() => {
        channelManager = {
            getCurrentChannel: () => CHANNEL,
            removeMember: vi.fn().mockResolvedValue(true),
            isChannelOwner: vi.fn().mockReturnValue(true),
            isRotationOwed: vi.fn().mockReturnValue(false)
        };
        showNotification = vi.fn();
        channelSettingsUI.setDependencies({ channelManager, showLoading: vi.fn(), hideLoading: vi.fn(), showNotification });
        vi.spyOn(channelSettingsUI, 'loadMembers').mockResolvedValue(undefined);
    });

    it('tells the owner it is done when the key rotated', async () => {
        await channelSettingsUI.executeRemoveMember(MEMBER);
        expect(showNotification).toHaveBeenCalledWith('Member removed successfully!', 'success');
    });

    it('tells the owner the rotation is still owed', async () => {
        channelManager.isRotationOwed.mockReturnValue(true);
        await channelSettingsUI.executeRemoveMember(MEMBER);
        expect(showNotification).toHaveBeenCalledWith(
            'Member removed. The channel key rotates the next time the app connects.', 'warning', 5000);
    });

    it('tells a moderator the owner rotates the key', async () => {
        channelManager.isChannelOwner.mockReturnValue(false);
        await channelSettingsUI.executeRemoveMember(MEMBER);
        expect(showNotification).toHaveBeenCalledWith(
            'Member removed. The key rotates when the owner next opens the channel.', 'info', 5000);
    });
});
