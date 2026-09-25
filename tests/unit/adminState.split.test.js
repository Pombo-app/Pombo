/**
 * Publishing an ADMIN_STATE that no longer fits one wire message.
 *
 * Past the DataChannel's max-message-size the SDK throws where the publisher
 * never sees it and the snapshot is simply gone. So the snapshot is measured
 * as it will travel: whole when it fits, as it always was; split into a run
 * when it does not; refused, with the owner told, past the cap.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const OWNER = '0x' + 'aa'.repeat(20);

vi.mock('../../src/js/auth.js', () => ({
    authManager: { getAddress: () => '0x' + 'aa'.repeat(20) }
}));

/** Epoch-envelope-like inflation: base64 over the ciphertext. */
const inflate = (row) => Math.ceil(JSON.stringify(row).length * 1.4);

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        adminWireBytes: vi.fn(async (_id, row) => inflate(row)),
        channelWireBytes: vi.fn(async (_id, signal) => inflate(signal)),
        publishAdminState: vi.fn(async () => ({ timestamp: Date.now() })),
        publishControl: vi.fn(async () => ({ timestamp: Date.now() }))
    },
    STREAM_CONFIG: { ADMIN_HISTORY_COUNT: 10 },
    deriveEphemeralId: (id) => id.replace(/-1$/, '-2'),
    deriveAdminId: (id) => id.replace(/-1$/, '-3')
}));

const { AdminState } = await import('../../src/js/channels/AdminState.js');
const { streamrController } = await import('../../src/js/streamr.js');
const { adminStatePoller } = await import('../../src/js/adminStatePoller.js');
const { CONFIG } = await import('../../src/js/config.js');
const { joinFramed, ADMIN_FRAME } = await import('../../src/js/syncChunks.js');

const STREAM = `${OWNER}/room-1`;

describe('ADMIN_STATE publish on the wire', () => {
    let admin;
    let manager;
    let channel;

    beforeEach(() => {
        vi.clearAllMocks();
        channel = {
            messageStreamId: STREAM,
            createdBy: OWNER,
            adminLoaded: true,
            adminRev: 7,
            adminSnapshot: { bannedMembers: [], hiddenMessageIds: [], pins: [], absorbedThrough: 0 }
        };
        manager = {
            channels: new Map([[STREAM, channel]]),
            notifyHandlers: vi.fn(),
            adminConfirm: { track: vi.fn() }
        };
        admin = new AdminState(manager);
        for (const m of ['_isValidAdminState', '_normalizeAdminState', 'applyAdminState', '_publishAdminStateInner']) {
            manager[m] = admin[m].bind(admin);
        }
    });

    const pinOf = (chars) => ({ targetId: 'm-1', pinnedAt: 1, snapshot: { text: 'p'.repeat(chars) } });
    const published = () => streamrController.publishAdminState.mock.calls.map(c => c[1]);
    const signalled = async () => {
        await vi.waitFor(() => expect(streamrController.publishControl).toHaveBeenCalled());
        return streamrController.publishControl.mock.calls[0][1];
    };

    it('sends a snapshot that fits as one message, and puts it on the signal', async () => {
        const out = await admin.publishAdminState(STREAM, { patch: { pins: [pinOf(100)] } });

        expect(published()).toHaveLength(1);
        expect(published()[0]).toMatchObject({ type: 'ADMIN_STATE', rev: 8 });
        expect(out.messages).toHaveLength(1);
        expect((await signalled()).snapshot).toMatchObject({ type: 'ADMIN_STATE', rev: 8 });
    });

    it('splits a snapshot past the budget into a run every row of which fits', async () => {
        const out = await admin.publishAdminState(STREAM, { patch: { pins: [pinOf(300 * 1024)] } });

        const rows = published();
        const budget = CONFIG.media.imagePayloadMaxBytes - CONFIG.media.imagePayloadSafetyMarginBytes;
        expect(rows.length).toBeGreaterThan(2);
        expect(rows.at(-1)).toMatchObject({ type: 'admin_manifest', rev: 8, chunkCount: rows.length - 1 });
        for (const row of rows) expect(inflate(row)).toBeLessThanOrEqual(budget);
        const [joined] = joinFramed(rows, ADMIN_FRAME);
        expect(joined.payload).toMatchObject({ type: 'ADMIN_STATE', rev: 8 });
        expect(joined.payload.state.pins[0].snapshot.text).toHaveLength(300 * 1024);
        expect(out.messages).toHaveLength(rows.length);
        expect(out.published).toBe(out.messages.at(-1));
    });

    it('signals a split snapshot by its rev only', async () => {
        await admin.publishAdminState(STREAM, { patch: { pins: [pinOf(300 * 1024)] } });

        const signal = await signalled();
        expect(signal).toEqual({ type: 'admin_invalidate', rev: 8, ts: expect.any(Number) });
    });

    it('leaves the snapshot off a signal that would not fit, though the -3 row did', async () => {
        streamrController.channelWireBytes.mockResolvedValueOnce(Number.MAX_SAFE_INTEGER);

        await admin.publishAdminState(STREAM, { patch: { pins: [pinOf(100)] } });

        expect(published()).toHaveLength(1);
        expect((await signalled()).snapshot).toBeUndefined();
    });

    it('refuses a snapshot past the cap: nothing published, nothing applied', async () => {
        const chars = (CONFIG.subscriptions.adminStateMaxChunks + 1) * 160 * 1024;

        await expect(admin.publishAdminState(STREAM, { patch: { pins: [pinOf(chars)] } }))
            .rejects.toMatchObject({ code: 'ADMIN_STATE_TOO_LARGE' });

        expect(streamrController.publishAdminState).not.toHaveBeenCalled();
        expect(streamrController.publishControl).not.toHaveBeenCalled();
        expect(channel.adminRev).toBe(7);
        expect(manager.adminConfirm.track).not.toHaveBeenCalled();
    });

    it('tracks the rev and ts the run carries, like a whole snapshot', async () => {
        await admin.publishAdminState(STREAM, { patch: { pins: [pinOf(300 * 1024)] } });

        const manifest = published().at(-1);
        expect(manager.adminConfirm.track).toHaveBeenCalledWith(STREAM,
            expect.objectContaining({ rev: 8, ts: manifest.ts }));
    });
});

describe('reading the -3 after a snapshot-less signal', () => {
    const pollInterval = CONFIG.subscriptions.adminPollIntervalMs;

    // The regular poll is not what is under test: keep its ticks out of the count.
    beforeEach(() => { CONFIG.subscriptions.adminPollIntervalMs = 24 * 3600 * 1000; });

    afterEach(() => {
        vi.useRealTimers();
        adminStatePoller.stop();
        CONFIG.subscriptions.adminPollIntervalMs = pollInterval;
    });

    const [FIRST, SECOND] = CONFIG.subscriptions.adminSignalReadDelaysMs;

    /** An AdminState over one channel at rev 7, polled with `refresh`. */
    const polled = (streamId = STREAM) => {
        const channel = { messageStreamId: STREAM, adminRev: 7 };
        const admin = new AdminState({ channels: new Map([[STREAM, channel]]) });
        const refresh = vi.fn(async () => {});
        adminStatePoller.start(streamId, refresh);
        refresh.mockClear();
        return { admin, channel, refresh };
    };

    it('polls after storage has had time, however many signals arrive', async () => {
        vi.useFakeTimers();
        const { admin, refresh } = polled();

        admin.readAfterSignal(STREAM, 8);
        admin.readAfterSignal(STREAM, 8);
        await vi.advanceTimersByTimeAsync(FIRST - 1);
        expect(refresh).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(100);

        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('reads once more while the announced rev has not landed, and never again', async () => {
        vi.useFakeTimers();
        const { admin, refresh } = polled();

        admin.readAfterSignal(STREAM, 8);
        await vi.advanceTimersByTimeAsync(FIRST + SECOND + 100);
        expect(refresh).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(10 * (FIRST + SECOND));

        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('does not read again once the announced rev has landed', async () => {
        vi.useFakeTimers();
        const { admin, channel, refresh } = polled();

        admin.readAfterSignal(STREAM, 8);
        await vi.advanceTimersByTimeAsync(FIRST + 100);
        channel.adminRev = 8;
        await vi.advanceTimersByTimeAsync(SECOND + 100);

        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('leaves a channel that is no longer being polled alone', async () => {
        vi.useFakeTimers();
        const { admin, refresh } = polled(`${OWNER}/other-1`);

        admin.readAfterSignal(STREAM, 8);
        await vi.advanceTimersByTimeAsync(FIRST + SECOND + 100);

        expect(refresh).not.toHaveBeenCalled();
    });
});
