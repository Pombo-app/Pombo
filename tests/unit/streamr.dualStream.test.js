/**
 * `subscribeToDualStream` is the fan-out that opens a channel: content and
 * overrides on the stored stream, presence on the ephemeral one, and the
 * media partitions left for later.
 *
 * The part worth pinning is the history bookkeeping. `onHistoryComplete` must
 * fire exactly once, only after every partition it is waiting on has reported,
 * and it must carry the per-partition loaded/requested figures, because that
 * is what lets the caller decide there is no more history to scroll to even
 * when the resend iterator never signals done.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { streamrController } = await import('../../src/js/streamr.js');

const OWNER = '0x' + '66'.repeat(20);
const MESSAGE = `${OWNER}/dual-1`;
const EPHEMERAL = `${OWNER}/dual-2`;

/** Captures the per-partition history callbacks handed to subscribeWithHistory. */
function stubSubscribe() {
    const calls = [];
    vi.spyOn(streamrController, 'subscribeWithHistory').mockImplementation(
        async (streamId, partition, handler, historyCount, password, onDone, allowOverrides) => {
            calls.push({ streamId, partition, historyCount, password, onDone, allowOverrides });
            return { id: `${streamId}#${partition}` };
        }
    );
    return calls;
}

describe('subscribeToDualStream', () => {
    beforeEach(() => {
        streamrController.client = { subscribe: vi.fn() };
        streamrController.subscriptions = new Map();
        streamrController.mediaHandlers = new Map();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        streamrController.client = null;
    });

    it('refuses to run without a client', async () => {
        streamrController.client = null;
        await expect(streamrController.subscribeToDualStream(MESSAGE, EPHEMERAL, {}))
            .rejects.toThrow('Streamr client not initialized');
    });

    /**
     * Overrides first: the timeline renders as content batches land, so an
     * edit or a delete read AFTER its target would show the pre-override
     * state until the next paint.
     */
    it('opens overrides with history, then content, and presence without', async () => {
        const calls = stubSubscribe();

        await streamrController.subscribeToDualStream(
            MESSAGE, EPHEMERAL,
            { onMessage: () => {}, onOverride: () => {}, onControl: () => {} },
            'pw', 30
        );

        expect(calls.map((c) => [c.streamId, c.partition, c.historyCount])).toEqual([
            [MESSAGE, 1, 30],
            [MESSAGE, 0, 30],
            [EPHEMERAL, 0, 0],
        ]);
    });

    it('leaves the media partitions for later and just remembers the handler', async () => {
        stubSubscribe();
        const onMedia = () => {};

        await streamrController.subscribeToDualStream(
            MESSAGE, EPHEMERAL, { onMessage: () => {}, onMedia }, 'pw'
        );

        expect(streamrController.mediaHandlers.get(EPHEMERAL)).toEqual({ handler: onMedia, password: 'pw' });
    });

    it('passes the override allowance through to the content partition only', async () => {
        const calls = stubSubscribe();

        await streamrController.subscribeToDualStream(
            MESSAGE, EPHEMERAL,
            { onMessage: () => {}, onOverride: () => {}, allowOverridesInContentPartition: true }
        );

        // calls[0] is the control partition now, calls[1] the content one.
        expect(calls[0].allowOverrides).toBe(false);
        expect(calls[1].allowOverrides).toBe(true);
    });

    it('waits for both stored partitions before saying history is complete', async () => {
        const calls = stubSubscribe();
        const done = vi.fn();

        await streamrController.subscribeToDualStream(
            MESSAGE, EPHEMERAL, { onMessage: () => {}, onOverride: () => {} }, null, 30, done
        );

        expect(done).not.toHaveBeenCalled();
        await calls[0].onDone({ loaded: 3, requested: 30 });
        expect(done).not.toHaveBeenCalled();
        await calls[1].onDone({ loaded: 12, requested: 30 });

        expect(done).toHaveBeenCalledTimes(1);
        expect(done).toHaveBeenCalledWith({
            contentLoaded: 12, contentRequested: 30, controlLoaded: 3, controlRequested: 30, readError: null,
        });
    });

    it('signals completion once even if a partition reports twice', async () => {
        const calls = stubSubscribe();
        const done = vi.fn();

        await streamrController.subscribeToDualStream(
            MESSAGE, EPHEMERAL, { onMessage: () => {} }, null, 30, done
        );

        await calls[0].onDone({ loaded: 1, requested: 30 });
        await calls[0].onDone({ loaded: 99, requested: 30 });

        expect(done).toHaveBeenCalledTimes(1);
        expect(done.mock.calls[0][0].contentLoaded).toBe(1);
    });

    it('completes at once when there is no stored partition to wait for', async () => {
        stubSubscribe();
        const done = vi.fn();

        await streamrController.subscribeToDualStream(
            MESSAGE, EPHEMERAL, { onControl: () => {} }, null, 30, done
        );

        expect(done).toHaveBeenCalledTimes(1);
    });

    it('completes at once when the caller asked for no history', async () => {
        stubSubscribe();
        const done = vi.fn();

        await streamrController.subscribeToDualStream(
            MESSAGE, EPHEMERAL, { onMessage: () => {} }, null, 0, done
        );

        expect(done).toHaveBeenCalledTimes(1);
    });

    it('does not resubscribe a partition it already holds, and still completes', async () => {
        streamrController.subscriptions.set(MESSAGE, { 0: { id: 'existing' } });
        const calls = stubSubscribe();
        const done = vi.fn();

        await streamrController.subscribeToDualStream(
            MESSAGE, EPHEMERAL, { onMessage: () => {} }, null, 30, done
        );

        expect(calls).toHaveLength(0);
        expect(streamrController.subscriptions.get(MESSAGE)[0]).toEqual({ id: 'existing' });
        expect(done).toHaveBeenCalledTimes(1);
    });

    it('does not reopen the ephemeral stream it already holds', async () => {
        streamrController.subscriptions.set(EPHEMERAL, {});
        const calls = stubSubscribe();

        await streamrController.subscribeToDualStream(MESSAGE, EPHEMERAL, { onControl: () => {} });

        expect(calls).toHaveLength(0);
    });

    it('a completion callback that throws does not fail the subscription', async () => {
        const calls = stubSubscribe();

        await streamrController.subscribeToDualStream(
            MESSAGE, EPHEMERAL, { onMessage: () => {} }, null, 30,
            () => { throw new Error('caller blew up'); }
        );

        await expect(calls[0].onDone({ loaded: 1, requested: 30 })).resolves.toBeUndefined();
    });

    it('lets a subscription failure reach the caller', async () => {
        vi.spyOn(streamrController, 'subscribeWithHistory').mockRejectedValue(new Error('network down'));

        await expect(streamrController.subscribeToDualStream(MESSAGE, EPHEMERAL, { onMessage: () => {} }))
            .rejects.toThrow('network down');
    });
});
