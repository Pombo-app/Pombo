/**
 * A read of the open that failed is not an empty channel: it is read again,
 * the -3 first, on a short backoff, and gives up only after the last attempt.
 * A cure replaces the client and re-reads the active channel itself, so a
 * retry that sees a new client stops instead of reading a second time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { channelManager } = await import('../../src/js/channels.js');
const { streamrController, STREAM_CONFIG } = await import('../../src/js/streamr.js');
const { channelImageManager } = await import('../../src/js/channelImageManager.js');

const ID = '0xowner/room-1';
const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];

function open() {
    const channel = {
        messageStreamId: ID,
        streamId: ID,
        adminStreamId: '0xowner/room-3',
        messages: [],
        hasMoreHistory: true,
        _controlPartitionSupported: false,
        _openReads: {}
    };
    channelManager.channels.set(ID, channel);
    channelManager.currentChannel = ID;
    return channel;
}

describe('reading the open again after a failed read', () => {
    let failing;
    let calls;

    beforeEach(() => {
        vi.useFakeTimers();
        failing = true;
        calls = [];
        streamrController.client = { id: 'first' };
        vi.spyOn(streamrController, 'fetchHistoryAsync').mockImplementation(
            async (id, partition, count, handler, password, done) => {
                if (id !== ID || partition !== STREAM_CONFIG.MESSAGE_STREAM.MESSAGES) return;
                calls.push('content');
                await done?.({ loaded: 0, requested: count, readError: null, failed: failing });
            });
        vi.spyOn(channelManager, 'refreshAdminState').mockImplementation(async () => { calls.push('admin'); });
        for (const method of ['flushBatchVerification', 'awaitAllFlushes']) {
            vi.spyOn(channelManager, method).mockResolvedValue(undefined);
        }
        vi.spyOn(channelManager, 'applyPendingOverrides').mockImplementation(() => {});
        vi.spyOn(channelManager, 'sortMessagesByTimestamp').mockImplementation(() => {});
        vi.spyOn(channelManager, 'notifyHandlers').mockImplementation(() => {});
        vi.spyOn(channelImageManager, 'get').mockResolvedValue(null);
    });

    afterEach(() => {
        channelManager.channels.delete(ID);
        channelManager.currentChannel = null;
        streamrController.client = null;
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('reads the -3 first, then the history, and stops once it came back', async () => {
        const channel = open();
        failing = false;

        channelManager._retryOpenReads(ID);
        expect(channel.historyRetrying).toBe(true);
        await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);

        expect(calls).toEqual(['admin', 'content']);
        expect(channel.historyRetrying).toBe(false);
        expect(channel.historyReadFailed).toBeFalsy();

        await vi.advanceTimersByTimeAsync(BACKOFF_MS[1] + BACKOFF_MS[2] + BACKOFF_MS[3]);
        expect(calls).toEqual(['admin', 'content']);
    });

    it('reopens the paging a paginate over the failing reads closed', async () => {
        const channel = open();
        channel.hasMoreHistory = false;
        failing = false;

        channelManager._retryOpenReads(ID);
        await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);

        expect(channel.hasMoreHistory).toBe(true);
    });

    it('gives up after the last attempt and closes paging', async () => {
        const channel = open();

        channelManager._retryOpenReads(ID);
        await vi.advanceTimersByTimeAsync(BACKOFF_MS.reduce((a, b) => a + b, 0));

        expect(calls.filter(c => c === 'content')).toHaveLength(BACKOFF_MS.length);
        expect(channel.historyRetrying).toBe(false);
        expect(channel.historyReadFailed).toBe(true);
        expect(channel.hasMoreHistory).toBe(false);
    });

    it('stops when a cure replaced the client, which re-reads on its own', async () => {
        const channel = open();

        channelManager._retryOpenReads(ID);
        streamrController.client = { id: 'rebuilt' };
        await vi.advanceTimersByTimeAsync(BACKOFF_MS.reduce((a, b) => a + b, 0));

        expect(calls).toEqual([]);
        expect(channel.historyReadFailed).toBeFalsy();
    });

    it('stops when the user left the channel, or opened it again', async () => {
        open();
        channelManager._retryOpenReads(ID);
        channelManager.currentChannel = '0xowner/other-1';
        await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);
        expect(calls).toEqual([]);

        const reopened = open();
        channelManager._retryOpenReads(ID);
        reopened._openReads = {};
        await vi.advanceTimersByTimeAsync(BACKOFF_MS[0]);
        expect(calls).toEqual([]);
    });
});
