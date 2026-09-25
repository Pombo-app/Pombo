/**
 * A published ADMIN_STATE is read back from storage until it is there;
 * missing, it is republished under the next rev a bounded number of times,
 * and a newer snapshot from another device of the owner is adopted instead.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const OWNER = '0x' + 'aa'.repeat(20);
const STREAM = `${OWNER}/room-1`;
const ADMIN = `${OWNER}/room-3`;

const resendAdminState = vi.fn();
vi.mock('../../src/js/streamr.js', () => ({
    streamrController: { resendAdminState: (...args) => resendAdminState(...args) },
    STREAM_CONFIG: { ADMIN_HISTORY_COUNT: 10 },
    deriveAdminId: (id) => id.replace(/-1$/, '-3')
}));
vi.mock('../../src/js/auth.js', () => ({ authManager: { getAddress: () => OWNER } }));
const resolveStorage = vi.fn();
vi.mock('../../src/js/storageEndpoints.js', () => ({
    storageEndpoints: { resolve: (...args) => resolveStorage(...args) }
}));

const { AdminStateConfirm } = await import('../../src/js/channels/AdminStateConfirm.js');
const { CONFIG } = await import('../../src/js/config.js');

const onStorage = (rev, ts) => ({ type: 'ADMIN_STATE', rev, ts, createdBy: OWNER, state: { bannedMembers: [], hiddenMessageIds: [], pins: [] } });

let manager;
let channel;
let confirm;
let nextRev;

beforeEach(() => {
    localStorage.clear();
    resendAdminState.mockReset();
    resolveStorage.mockReset();
    resolveStorage.mockResolvedValue([{ nodeAddress: '0x1', urls: ['https://node.example'] }]);
    nextRev = 1;
    channel = {
        messageStreamId: STREAM,
        adminStreamId: ADMIN,
        password: null,
        adminSnapshot: { bannedMembers: [{ address: '0xbad', sinceEpoch: null }], hiddenMessageIds: [], pins: [] }
    };
    manager = {
        channels: new Map([[STREAM, channel]]),
        notifyHandlers: vi.fn(),
        handleAdminMessage: vi.fn(),
        // The serialised publish: bumps the rev and tracks it, as the real one does.
        publishAdminState: vi.fn(async (id) => {
            const rev = ++nextRev;
            confirm.track(id, { rev, ts: rev * 100 });
            return { rev };
        })
    };
    confirm = new AdminStateConfirm(manager, { sleep: async () => {} });
});

const settle = () => confirm.loops.get(STREAM) || Promise.resolve();

describe('AdminStateConfirm', () => {
    it('clears the pending publish once storage serves it', async () => {
        resendAdminState.mockResolvedValue(onStorage(1, 100));
        confirm.track(STREAM, { rev: 1, ts: 100, envelopeTs: 101 });
        expect(confirm.pending(STREAM)).toMatchObject({ rev: 1, ts: 100, envelopeTs: 101, republished: 0 });
        await settle();
        expect(confirm.pending(STREAM)).toBeNull();
        expect(manager.publishAdminState).not.toHaveBeenCalled();
        expect(manager.notifyHandlers).not.toHaveBeenCalled();
        expect(resendAdminState).toHaveBeenCalledWith(ADMIN, { historyCount: 10, password: null });
    });

    it('keeps reading while storage still serves an older snapshot, then republishes the current one', async () => {
        // Four reads see the previous rev, the republish (rev 2) lands at the first read after it.
        resendAdminState.mockImplementation(async () => (nextRev >= 2 ? onStorage(2, 200) : onStorage(0, 50)));
        confirm.track(STREAM, { rev: 1, ts: 100 });
        await settle();
        expect(manager.publishAdminState).toHaveBeenCalledTimes(1);
        expect(manager.publishAdminState).toHaveBeenCalledWith(STREAM, { state: channel.adminSnapshot });
        expect(confirm.pending(STREAM)).toBeNull();
        expect(manager.notifyHandlers).not.toHaveBeenCalled();
    });

    it('treats the same rev with an older ts as not landed', async () => {
        resendAdminState.mockImplementation(async () => (nextRev >= 2 ? onStorage(2, 200) : onStorage(1, 90)));
        confirm.track(STREAM, { rev: 1, ts: 100 });
        await settle();
        expect(manager.publishAdminState).toHaveBeenCalledTimes(1);
        expect(confirm.pending(STREAM)).toBeNull();
    });

    it('stops after the republish limit, keeps the entry pending and tells the owner', async () => {
        resendAdminState.mockResolvedValue(null);
        confirm.track(STREAM, { rev: 1, ts: 100 });
        await settle();
        const limit = CONFIG.subscriptions.adminConfirmRepublishLimit;
        expect(manager.publishAdminState).toHaveBeenCalledTimes(limit);
        expect(confirm.pending(STREAM)).toMatchObject({ rev: 1 + limit, republished: limit, stalled: true });
        expect(manager.notifyHandlers).toHaveBeenCalledWith('admin_state_unconfirmed', { streamId: STREAM, rev: 1 + limit });
        expect(resendAdminState).toHaveBeenCalledTimes((limit + 1) * CONFIG.subscriptions.adminConfirmDelaysMs.length);
    });

    it('says the snapshot is too large rather than promising a retry that cannot land', async () => {
        resendAdminState.mockResolvedValue(null);
        manager.publishAdminState.mockRejectedValue(
            Object.assign(new Error('too large'), { code: 'ADMIN_STATE_TOO_LARGE' }));
        confirm.track(STREAM, { rev: 1, ts: 100 });
        await settle();
        expect(confirm.pending(STREAM)).toBeNull();
        expect(manager.notifyHandlers).toHaveBeenCalledWith('admin_state_too_large', { streamId: STREAM, rev: 1 });
        expect(manager.notifyHandlers).not.toHaveBeenCalledWith('admin_state_unconfirmed', expect.anything());
    });

    it('adopts a newer snapshot published from another device instead of republishing over it', async () => {
        const theirs = onStorage(5, 999);
        resendAdminState.mockResolvedValue(theirs);
        confirm.track(STREAM, { rev: 1, ts: 100 });
        await settle();
        expect(manager.handleAdminMessage).toHaveBeenCalledWith(STREAM, theirs);
        expect(manager.publishAdminState).not.toHaveBeenCalled();
        expect(confirm.pending(STREAM)).toBeNull();
        expect(manager.notifyHandlers).toHaveBeenCalledWith('admin_state_superseded', { streamId: STREAM, rev: 5 });
    });

    it('adopts the same rev when the other device published it later', async () => {
        const theirs = onStorage(1, 150);
        resendAdminState.mockResolvedValue(theirs);
        confirm.track(STREAM, { rev: 1, ts: 100 });
        await settle();
        expect(manager.handleAdminMessage).toHaveBeenCalledWith(STREAM, theirs);
        expect(manager.publishAdminState).not.toHaveBeenCalled();
    });

    it('follows a newer publish of ours made while waiting, without republishing the old one', async () => {
        resendAdminState
            .mockImplementationOnce(async () => { confirm.track(STREAM, { rev: 2, ts: 200 }); return null; })
            .mockResolvedValue(onStorage(2, 200));
        confirm.track(STREAM, { rev: 1, ts: 100 });
        await settle();
        expect(manager.publishAdminState).not.toHaveBeenCalled();
        expect(confirm.pending(STREAM)).toBeNull();
    });

    it('a read that fails is just a read that found nothing', async () => {
        resendAdminState
            .mockRejectedValueOnce(new Error('node down'))
            .mockResolvedValue(onStorage(1, 100));
        confirm.track(STREAM, { rev: 1, ts: 100 });
        await settle();
        expect(confirm.pending(STREAM)).toBeNull();
        expect(manager.publishAdminState).not.toHaveBeenCalled();
    });

    it('resume() picks a stalled entry up again with fresh republishes', async () => {
        resendAdminState.mockResolvedValue(null);
        confirm.track(STREAM, { rev: 1, ts: 100 });
        await settle();
        expect(confirm.pending(STREAM).stalled).toBe(true);

        // Next open: storage answers now.
        const rev = confirm.pending(STREAM).rev;
        resendAdminState.mockResolvedValue(onStorage(rev, rev * 100));
        confirm.resume(STREAM);
        await settle();
        expect(confirm.pending(STREAM)).toBeNull();
    });

    it('resume() without a pending entry does nothing', async () => {
        confirm.resume(STREAM);
        expect(confirm.loops.size).toBe(0);
        expect(resendAdminState).not.toHaveBeenCalled();
    });

    it('has nothing to confirm on an admin stream without storage', async () => {
        resolveStorage.mockResolvedValue([]);
        confirm.track(STREAM, { rev: 1, ts: 100 });
        await settle();
        expect(resolveStorage).toHaveBeenCalledWith(ADMIN);
        expect(confirm.pending(STREAM)).toBeNull();
        expect(resendAdminState).not.toHaveBeenCalled();
        expect(manager.publishAdminState).not.toHaveBeenCalled();
        expect(manager.notifyHandlers).not.toHaveBeenCalled();
    });

    it('confirms anyway when the storage providers cannot be resolved', async () => {
        resolveStorage.mockRejectedValue(new Error('client not ready'));
        resendAdminState.mockResolvedValue(onStorage(1, 100));
        confirm.track(STREAM, { rev: 1, ts: 100 });
        await settle();
        expect(confirm.pending(STREAM)).toBeNull();
        expect(resendAdminState).toHaveBeenCalled();
    });

    it('drops the entry when the channel is gone', async () => {
        manager.channels.delete(STREAM);
        confirm.track(STREAM, { rev: 1, ts: 100 });
        await settle();
        expect(confirm.pending(STREAM)).toBeNull();
        expect(resendAdminState).not.toHaveBeenCalled();
    });

    it('keeps pending entries per account', () => {
        confirm.track(STREAM, { rev: 3, ts: 300 });
        const map = JSON.parse(localStorage.getItem('pombo_admin_pending'));
        expect(Object.keys(map)).toEqual([`${OWNER.toLowerCase()}|${STREAM}`]);
    });
});
