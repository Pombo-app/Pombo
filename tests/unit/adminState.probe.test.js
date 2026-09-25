/**
 * The poll of an open channel's moderation reads the newest -3 row first.
 * Only an owner's snapshot or manifest at a rev already held ends the poll
 * there; anything else reads the window exactly as before, so a probe can
 * save a read but never hide a change.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const OWNER = '0x' + 'aa'.repeat(20);
const STREAM = `${OWNER}/room-1`;

vi.mock('../../src/js/auth.js', () => ({ authManager: { getAddress: () => '0x' + 'bb'.repeat(20) } }));
vi.mock('../../src/js/streamr.js', () => ({
    streamrController: { probeAdminState: vi.fn(), resendAdminState: vi.fn() },
    STREAM_CONFIG: { ADMIN_HISTORY_COUNT: 10 },
    deriveEphemeralId: (id) => id.replace(/-1$/, '-2'),
    deriveAdminId: (id) => id.replace(/-1$/, '-3')
}));

const { AdminState } = await import('../../src/js/channels/AdminState.js');
const { streamrController } = await import('../../src/js/streamr.js');

const snapshot = (rev) => ({
    type: 'ADMIN_STATE', rev, ts: rev * 100, createdBy: OWNER,
    state: { bannedMembers: [], hiddenMessageIds: [`m-${rev}`], pins: [] }
});

describe('refreshAdminState probe', () => {
    let admin;
    let channel;
    let manager;

    beforeEach(() => {
        vi.clearAllMocks();
        channel = { messageStreamId: STREAM, createdBy: OWNER, adminLoaded: true, adminRev: 5, adminTs: 500 };
        manager = { channels: new Map([[STREAM, channel]]), notifyHandlers: vi.fn() };
        admin = new AdminState(manager);
        for (const m of ['_isValidAdminState', '_normalizeAdminState', 'applyAdminState']) manager[m] = admin[m].bind(admin);
        streamrController.resendAdminState.mockResolvedValue(snapshot(6));
    });

    const probe = (row) => streamrController.probeAdminState.mockResolvedValue(row);

    it("stops at the owner's snapshot at a rev already held", async () => {
        probe({ type: 'ADMIN_STATE', rev: 5, ts: 500, publisherId: OWNER });

        expect(await admin.refreshAdminState(STREAM)).toBe(false);
        expect(streamrController.resendAdminState).not.toHaveBeenCalled();
    });

    it("stops at the owner's manifest at a rev already held", async () => {
        probe({ type: 'admin_manifest', rev: 5, ts: 500, publisherId: OWNER });

        expect(await admin.refreshAdminState(STREAM)).toBe(false);
        expect(streamrController.resendAdminState).not.toHaveBeenCalled();
    });

    it('reads the window for a newer rev', async () => {
        probe({ type: 'admin_manifest', rev: 6, ts: 600, publisherId: OWNER });

        expect(await admin.refreshAdminState(STREAM)).toBe(true);
        expect(streamrController.resendAdminState).toHaveBeenCalledWith(`${OWNER}/room-3`, { historyCount: 5, password: null });
        expect(channel.adminRev).toBe(6);
    });

    it('reads the window when the newest row is not the owner\'s', async () => {
        probe({ type: 'ADMIN_STATE', rev: 5, ts: 500, publisherId: '0x' + 'cc'.repeat(20) });

        expect(await admin.refreshAdminState(STREAM)).toBe(true);
        expect(streamrController.resendAdminState).toHaveBeenCalledTimes(1);
    });

    it('reads the window when the probe has nothing to say', async () => {
        probe(null);

        expect(await admin.refreshAdminState(STREAM)).toBe(true);
        expect(streamrController.resendAdminState).toHaveBeenCalledTimes(1);
    });

    it('takes the owner from the stream namespace when the record has no createdBy', async () => {
        delete channel.createdBy;
        probe({ type: 'ADMIN_STATE', rev: 5, ts: 500, publisherId: OWNER });

        expect(await admin.refreshAdminState(STREAM)).toBe(false);
        expect(streamrController.resendAdminState).not.toHaveBeenCalled();
    });
});
