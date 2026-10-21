/**
 * Finish and Discard on an interrupted channel creation. Finish runs under
 * the same progress ring as a creation; Discard asks first, because what
 * landed stays paid for.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock('../../src/js/auth.js', () => ({ authManager: { getAddress: () => '0xowner' } }));
vi.mock('../../src/js/streamr.js', () => ({ streamrController: {} }));

const { ChannelModalsUI } = await import('../../src/js/ui/ChannelModalsUI.js');

const RECORD = { basePath: '0xowner/abcd', name: 'Group', type: 'gated', members: [] };

describe('interrupted channel creation actions', () => {
    let ui;
    let channelManager;
    let notificationUI;
    let showNotification;
    let renderChannelList;

    beforeEach(() => {
        channelManager = {
            getInterruptedCreates: vi.fn(() => [RECORD]),
            finishPendingCreate: vi.fn(async (basePath, { onProgress }) => {
                onProgress();
                return { streamId: '0xowner/abcd-1' };
            }),
            discardPendingCreate: vi.fn().mockResolvedValue(undefined),
            reconcilePendingCreates: vi.fn().mockResolvedValue(new Map())
        };
        notificationUI = {
            showLoadingToast: vi.fn(),
            setLoadingProgress: vi.fn(),
            hideLoadingToast: vi.fn(),
            showConfirmToast: vi.fn().mockResolvedValue(true)
        };
        showNotification = vi.fn();
        renderChannelList = vi.fn();
        ui = new ChannelModalsUI();
        ui.setDependencies({ channelManager, notificationUI, showNotification, renderChannelList });
    });

    it('Finish runs under the creation progress ring, sized for a gated channel', async () => {
        await ui.finishInterruptedCreate(RECORD.basePath);

        expect(channelManager.finishPendingCreate).toHaveBeenCalledWith(RECORD.basePath, expect.any(Object));
        expect(notificationUI.showLoadingToast.mock.calls[0][2].steps).toBe(19);
        expect(notificationUI.setLoadingProgress).toHaveBeenCalledWith(1, 'Creating Channel...');
        expect(notificationUI.hideLoadingToast).toHaveBeenCalled();
        expect(showNotification).toHaveBeenCalledWith('Channel created successfully!', 'success', undefined);
    });

    it('a failed Finish says so and asks the chain again, so the row reflects it', async () => {
        channelManager.finishPendingCreate.mockRejectedValue(new Error('insufficient funds'));

        await ui.finishInterruptedCreate(RECORD.basePath);

        expect(showNotification).toHaveBeenCalledWith('Could not finish the channel: insufficient funds', 'error', undefined);
        await vi.waitFor(() => expect(renderChannelList).toHaveBeenCalled());
        expect(channelManager.reconcilePendingCreates).toHaveBeenCalled();
    });

    it('Discard asks first and keeps the creation when declined', async () => {
        notificationUI.showConfirmToast.mockResolvedValue(false);

        await ui.discardInterruptedCreate(RECORD.basePath);

        expect(notificationUI.showConfirmToast.mock.calls[0][1]).toContain('not refunded');
        expect(channelManager.discardPendingCreate).not.toHaveBeenCalled();
    });

    it('Discard drops the creation once confirmed', async () => {
        await ui.discardInterruptedCreate(RECORD.basePath);

        expect(channelManager.discardPendingCreate).toHaveBeenCalledWith(RECORD.basePath);
    });
});
