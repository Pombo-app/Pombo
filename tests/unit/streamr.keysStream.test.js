/**
 * The keys stream (-4) reads: the resend a cold start uses to find the epoch
 * announces it missed, and the live subscription that carries them afterwards.
 *
 * Both read the stream RAW and recover authorship themselves. That is not an
 * optimisation: on a gated channel the clone publishes for everyone, so the
 * transport publisher is the same address for every member, and the epoch
 * protocol's identity checks would be meaningless without the envelope signer
 * underneath.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { streamrController } = await import('../../src/js/streamr.js');

const OWNER = '0x' + '99'.repeat(20);
const AUTHOR = '0x' + 'ab'.repeat(20);
const GATE = '0x' + 'cd'.repeat(20);
const KEYS = `${OWNER}/keys-4`;
const NOT_KEYS = `${OWNER}/keys-1`;

async function* streamOf(...messages) {
    for (const m of messages) yield m;
}

function serve(...messages) {
    const calls = [];
    streamrController.client = {
        resend: vi.fn(async (streamDef, options) => {
            calls.push({ streamDef, options });
            return streamOf(...messages);
        }),
    };
    return calls;
}

const row = (ts, content) => ({
    content,
    getTimestamp: () => ts,
    getPublisherId: () => GATE,
});

describe('resendKeysMessages', () => {
    beforeEach(() => {
        vi.spyOn(streamrController, 'resolveAuthor').mockResolvedValue(AUTHOR);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        streamrController.client = null;
    });

    it('refuses to run without a client', async () => {
        streamrController.client = null;
        await expect(streamrController.resendKeysMessages(KEYS)).rejects.toThrow('Streamr client not initialized');
    });

    it('reads raw, because an ordered resend stalls on a half-connected node', async () => {
        const calls = serve();

        await streamrController.resendKeysMessages(KEYS, { last: 50 });

        expect(calls[0].options).toEqual({ last: 50, raw: true });
    });

    it('keeps typed protocol messages and sealed roster envelopes, and nothing else', async () => {
        serve(
            row(100, { t: 'KEY_ANNOUNCE', kid: 'k1' }),
            row(110, { e: 'epoch-aes-gcm', ct: 'x' }),
            row(120, { some: 'other shape' }),
            row(130, 'a string'),
            row(140, null),
        );

        const out = await streamrController.resendKeysMessages(KEYS);

        expect(out.map((e) => e.data.t ?? e.data.e)).toEqual(['KEY_ANNOUNCE', 'epoch-aes-gcm']);
    });

    it('names the envelope signer as the author, not the transport publisher', async () => {
        serve(row(100, { t: 'KEY_ANNOUNCE' }));

        const out = await streamrController.resendKeysMessages(KEYS);

        expect(out[0].publisherId).toBe(AUTHOR);
        expect(out[0].timestamp).toBe(100);
    });

    it('drops an entry whose author cannot be recovered', async () => {
        streamrController.resolveAuthor.mockResolvedValue(null);
        serve(row(100, { t: 'KEY_ANNOUNCE' }));

        expect(await streamrController.resendKeysMessages(KEYS)).toEqual([]);
    });

    it('treats a cold stream with no storage as simply having no announces', async () => {
        streamrController.client = { resend: vi.fn(async () => { throw new Error('no storage assigned'); }) };

        expect(await streamrController.resendKeysMessages(KEYS)).toEqual([]);
    });
});

describe('subscribeToKeysStream', () => {
    let subscribeArgs;

    beforeEach(() => {
        subscribeArgs = null;
        streamrController.subscriptions = new Map();
        streamrController.client = {
            subscribe: vi.fn(async (options, onMessage) => {
                subscribeArgs = { options, onMessage };
                return { id: 'keys-sub' };
            }),
        };
        vi.spyOn(streamrController, 'resolveAuthor').mockResolvedValue(AUTHOR);
        vi.spyOn(streamrController, '_gatedChannelFor').mockResolvedValue(null);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        streamrController.client = null;
    });

    it('refuses anything that is not a keys stream', async () => {
        await expect(streamrController.subscribeToKeysStream(NOT_KEYS, () => {}))
            .rejects.toThrow(/expects a keys stream/);
    });

    it('refuses to run without a client', async () => {
        streamrController.client = null;
        await expect(streamrController.subscribeToKeysStream(KEYS, () => {}))
            .rejects.toThrow('Streamr client not initialized');
    });

    it('proves access through the gate on a gated channel', async () => {
        streamrController._gatedChannelFor.mockResolvedValue({ gate: { address: GATE } });

        await streamrController.subscribeToKeysStream(KEYS, () => {});

        expect(subscribeArgs.options.erc1271Contract).toBe(GATE);
    });

    it('subscribes both cadences once, and is idempotent afterwards', async () => {
        // P0 carries the announces and P1 the request/answer traffic, so a
        // channel opens two subscriptions on the -4 and neither is repeated.
        const first = await streamrController.subscribeToKeysStream(KEYS, () => {});
        const again = await streamrController.subscribeToKeysStream(KEYS, () => {});

        expect(again).toBe(first);
        expect(streamrController.client.subscribe).toHaveBeenCalledTimes(2);
        const partitions = streamrController.client.subscribe.mock.calls.map(c => c[0].partition);
        expect(partitions.sort()).toEqual([0, 1]);
    });

    it('delivers the message with its author and timestamp', async () => {
        const handler = vi.fn();
        await streamrController.subscribeToKeysStream(KEYS, handler);

        await subscribeArgs.onMessage({ t: 'KEY_ANNOUNCE' }, { getPublisherId: () => GATE, getTimestamp: () => 4242 });

        expect(handler).toHaveBeenCalledWith({ t: 'KEY_ANNOUNCE' }, AUTHOR, 4242);
    });

    it('drops a message whose author cannot be recovered', async () => {
        streamrController.resolveAuthor.mockResolvedValue(null);
        const handler = vi.fn();
        await streamrController.subscribeToKeysStream(KEYS, handler);

        await subscribeArgs.onMessage({ t: 'KEY_ANNOUNCE' }, { getPublisherId: () => GATE });

        expect(handler).not.toHaveBeenCalled();
    });

    it('ignores a payload that is not an object', async () => {
        const handler = vi.fn();
        await streamrController.subscribeToKeysStream(KEYS, handler);

        await subscribeArgs.onMessage('not an object', {});

        expect(handler).not.toHaveBeenCalled();
    });

    it('survives a handler that throws', async () => {
        await streamrController.subscribeToKeysStream(KEYS, () => { throw new Error('key handling blew up'); });

        await expect(subscribeArgs.onMessage({ t: 'KEY_ANNOUNCE' }, { getPublisherId: () => GATE }))
            .resolves.toBeUndefined();
    });
});
