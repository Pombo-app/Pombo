/**
 * A gated channel's history re-read once the storage node serves it again.
 *
 * A refusal recorded while access had lapsed outlived the renewal: the
 * timeline kept saying the history was unavailable until the channel was
 * reopened. The re-read takes its verdict from the content read, and a clean
 * read reopens only the paging a refusal had closed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { channelManager } = await import('../../src/js/channels.js');
const { streamrController, STREAM_CONFIG } = await import('../../src/js/streamr.js');
const { channelImageManager } = await import('../../src/js/channelImageManager.js');
const { CONFIG } = await import('../../src/js/config.js');

const ID = '0xowner/room-1';
const REFUSAL = { status: 403, signed: true };
const DEBOUNCE_MS = 1500;

function gated(extra = {}) {
    const channel = {
        messageStreamId: ID,
        streamId: ID,
        adminStreamId: '0xowner/room-3',
        gate: { address: '0xgate' },
        messages: [],
        _controlPartitionSupported: false,
        ...extra
    };
    channelManager.channels.set(ID, channel);
    return channel;
}

describe('history refresh', () => {
    // What the content read reports; undefined = it never reported at all
    let verdict;
    let contentReads;

    beforeEach(() => {
        vi.useFakeTimers();
        verdict = null;
        contentReads = 0;
        vi.spyOn(streamrController, 'fetchHistoryAsync').mockImplementation(
            async (id, partition, count, handler, password, done) => {
                if (id !== ID || partition !== STREAM_CONFIG.MESSAGE_STREAM.MESSAGES) return;
                contentReads++;
                if (verdict !== undefined) await done?.({ loaded: 0, requested: count, readError: verdict });
            });
        for (const method of ['flushBatchVerification', 'awaitAllFlushes', 'refreshAdminState']) {
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
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('clears a refusal and reopens paging once the node serves the read', async () => {
        const channel = gated({ historyError: REFUSAL, hasMoreHistory: false });

        await channelManager._runHistoryRefresh(ID);

        expect(channel.historyError).toBeNull();
        expect(channel.hasMoreHistory).toBe(true);
        expect(channelManager.notifyHandlers).toHaveBeenCalledWith('initial_history_complete', { streamId: ID });
    });

    it('records a refusal and closes paging while the node still refuses', async () => {
        const channel = gated({ historyError: null, hasMoreHistory: true });
        verdict = REFUSAL;

        await channelManager._runHistoryRefresh(ID);

        expect(channel.historyError).toEqual(REFUSAL);
        expect(channel.hasMoreHistory).toBe(false);
    });

    it('leaves an exhausted history exhausted on a clean read', async () => {
        const channel = gated({ historyError: null, hasMoreHistory: false });

        await channelManager._runHistoryRefresh(ID);

        expect(channel.historyError).toBeNull();
        expect(channel.hasMoreHistory).toBe(false);
    });

    it('changes nothing when the read never reported', async () => {
        const channel = gated({ historyError: REFUSAL, hasMoreHistory: false });
        verdict = undefined;

        await channelManager._runHistoryRefresh(ID);

        expect(channel.historyError).toEqual(REFUSAL);
        expect(channel.hasMoreHistory).toBe(false);
    });

    it('after a renewal, reads now and once more while the node still refused', async () => {
        const channel = gated({ historyError: REFUSAL, hasMoreHistory: false });
        channelManager.currentChannel = ID;
        verdict = REFUSAL;

        channelManager.refreshHistoryAfterRenewal(ID);
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
        expect(contentReads).toBe(1);
        expect(channel.historyError).toEqual(REFUSAL);

        verdict = null;
        await vi.advanceTimersByTimeAsync(CONFIG.subscriptions.renewalHistoryRetryMs);
        expect(contentReads).toBe(2);
        expect(channel.historyError).toBeNull();
        expect(channel.hasMoreHistory).toBe(true);

        await vi.advanceTimersByTimeAsync(CONFIG.subscriptions.renewalHistoryRetryMs * 2);
        expect(contentReads).toBe(2);
    });

    it('after a renewal the node served at once, reads only once', async () => {
        const channel = gated({ historyError: REFUSAL, hasMoreHistory: false });
        channelManager.currentChannel = ID;

        channelManager.refreshHistoryAfterRenewal(ID);
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + CONFIG.subscriptions.renewalHistoryRetryMs * 2);

        expect(contentReads).toBe(1);
        expect(channel.historyError).toBeNull();
    });

    it('does not retry for a channel the user has left', async () => {
        gated({ historyError: REFUSAL, hasMoreHistory: false });
        channelManager.currentChannel = ID;
        verdict = REFUSAL;

        channelManager.refreshHistoryAfterRenewal(ID);
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
        channelManager.currentChannel = '0xowner/other-1';
        await vi.advanceTimersByTimeAsync(CONFIG.subscriptions.renewalHistoryRetryMs * 2);

        expect(contentReads).toBe(1);
    });
});
