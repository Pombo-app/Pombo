/**
 * The ban modal reports back once the ban went through, so the panel that
 * opened it can show the member gone from the members list. The gate's ban is
 * the owner's alone; a moderator hides by delta and never reaches the gate.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock('../../src/js/auth.js', () => ({ authManager: { getAddress: () => '0xowner' } }));
vi.mock('../../src/js/streamr.js', () => ({ streamrController: {} }));
vi.mock('../../src/js/ui/ConfirmDialogUI.js', () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock('../../src/js/epochKeyManager.js', () => ({ epochKeyManager: { currentEpoch: () => 3 } }));

const { ChannelModalsUI } = await import('../../src/js/ui/ChannelModalsUI.js');

const CHANNEL = { streamId: '0xowner/room-1', createdBy: '0xowner', gate: { address: '0xgate' } };
const MEMBER = '0x03e2b466754f187f571ab48c69e3ab592e76d819';

describe('ban modal', () => {
    let ui;
    let channelManager;
    let modalManager;

    beforeEach(() => {
        document.body.innerHTML = `
            <span id="ban-member-label"></span>
            <input type="checkbox" id="ban-level-client">
            <input type="checkbox" id="ban-level-protocol">
            <span id="ban-level-protocol-detail"></span>
            <input type="checkbox" id="ban-level-purge">
            <button id="confirm-ban-member-btn"></button>
        `;
        channelManager = {
            banMemberLevels: vi.fn().mockResolvedValue(true),
            isRotationOwed: vi.fn().mockReturnValue(false),
            isChannelOwner: vi.fn().mockReturnValue(true),
            isCachedModerator: vi.fn().mockReturnValue(false),
            publishModAction: vi.fn().mockResolvedValue(undefined)
        };
        modalManager = { show: vi.fn(), hide: vi.fn() };
        ui = new ChannelModalsUI();
        ui.setDependencies({
            channelManager,
            modalManager,
            notificationUI: { showLoadingToast: vi.fn(), hideLoadingToast: vi.fn() },
            showNotification: vi.fn()
        });
    });

    it('offers the gate to the owner', () => {
        ui.showBanMemberModal(MEMBER, CHANNEL);

        const protocol = document.getElementById('ban-level-protocol');
        expect(protocol.disabled).toBe(false);
        expect(protocol.checked).toBe(true);
    });

    it('never offers the gate to anyone else, and says why', async () => {
        channelManager.isChannelOwner.mockReturnValue(false);
        ui.showBanMemberModal(MEMBER, CHANNEL);

        const protocol = document.getElementById('ban-level-protocol');
        expect(protocol.disabled).toBe(true);
        expect(protocol.checked).toBe(false);
        expect(document.getElementById('ban-level-protocol-detail').textContent)
            .toBe('Only the channel creator can cut access.');

        protocol.checked = true;
        await document.getElementById('confirm-ban-member-btn').onclick();
        expect(channelManager.banMemberLevels).not.toHaveBeenCalled();
    });

    it('lets a moderator hide by delta, with no transaction', async () => {
        channelManager.isChannelOwner.mockReturnValue(false);
        channelManager.isCachedModerator.mockReturnValue(true);
        const onBanned = vi.fn();

        ui.showBanMemberModal(MEMBER, CHANNEL, { onBanned });

        await vi.waitFor(() => expect(onBanned).toHaveBeenCalledTimes(1));
        expect(channelManager.publishModAction).toHaveBeenCalledWith(CHANNEL.streamId, 'ban', MEMBER, 3);
        expect(channelManager.banMemberLevels).not.toHaveBeenCalled();
        expect(modalManager.show).not.toHaveBeenCalled();
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
