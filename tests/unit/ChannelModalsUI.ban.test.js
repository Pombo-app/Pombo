/**
 * The ban modal reports back once the ban went through, so the panel that
 * opened it can show the member gone from the members list.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock('../../src/js/auth.js', () => ({ authManager: { getAddress: () => '0xowner' } }));
vi.mock('../../src/js/streamr.js', () => ({ streamrController: {} }));

const { ChannelModalsUI } = await import('../../src/js/ui/ChannelModalsUI.js');

const CHANNEL = { streamId: '0xowner/room-1', createdBy: '0xowner', gate: { address: '0xgate' } };
const MEMBER = '0x03e2b466754f187f571ab48c69e3ab592e76d819';

describe('ban modal', () => {
    let ui;
    let channelManager;

    beforeEach(() => {
        document.body.innerHTML = `
            <span id="ban-member-label"></span>
            <input type="checkbox" id="ban-level-client">
            <input type="checkbox" id="ban-level-protocol">
            <input type="checkbox" id="ban-level-purge">
            <button id="confirm-ban-member-btn"></button>
        `;
        channelManager = {
            banMemberLevels: vi.fn().mockResolvedValue(true),
            isRotationOwed: vi.fn().mockReturnValue(false)
        };
        ui = new ChannelModalsUI();
        ui.setDependencies({
            channelManager,
            modalManager: { show: vi.fn(), hide: vi.fn() },
            notificationUI: { showLoadingToast: vi.fn(), hideLoadingToast: vi.fn() },
            showNotification: vi.fn()
        });
    });

    it('tells the opener once the ban went through', async () => {
        const onBanned = vi.fn();
        ui.showBanMemberModal(MEMBER, CHANNEL, { onBanned });

        await document.getElementById('confirm-ban-member-btn').onclick();

        expect(channelManager.banMemberLevels).toHaveBeenCalled();
        expect(onBanned).toHaveBeenCalledTimes(1);
    });

    it('says nothing to the opener when the ban failed', async () => {
        channelManager.banMemberLevels.mockRejectedValue(new Error('user rejected'));
        const onBanned = vi.fn();
        ui.showBanMemberModal(MEMBER, CHANNEL, { onBanned });

        await document.getElementById('confirm-ban-member-btn').onclick();

        expect(onBanned).not.toHaveBeenCalled();
    });
});
