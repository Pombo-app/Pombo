/**
 * `subscribeToPartition` is the second live pipeline, the one the media
 * partitions and other on-demand subscriptions use. It carries the same
 * invariants as the one `subscribeWithHistory` installs, and it is worth
 * testing separately precisely because it is a copy: a rule fixed in one
 * pipeline and forgotten in the other is exactly the kind of drift that
 * survives a refactor unnoticed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { streamrController } = await import('../../src/js/streamr.js');
const { cryptoManager } = await import('../../src/js/crypto.js');

const OWNER = '0x' + 'de'.repeat(20);
const AUTHOR = '0x' + 'ef'.repeat(20);
const OTHER = '0x' + 'ba'.repeat(20);
const GATE = '0x' + 'fe'.repeat(20);
const STREAM = `${OWNER}/partition-2`;

function wire() {
    const state = { options: null, onMessage: null };
    streamrController.client = {
        subscribe: vi.fn(async (options, onMessage) => {
            state.options = options;
            state.onMessage = onMessage;
            return { id: 'partition-sub' };
        }),
    };
    return state;
}

const envelope = (over = {}) => ({ getPublisherId: () => AUTHOR, getTimestamp: () => 900, ...over });

describe('subscribeToPartition', () => {
    beforeEach(() => {
        streamrController.subscriptions = new Map();
        vi.spyOn(streamrController, '_gatedChannelFor').mockResolvedValue(null);
        vi.spyOn(streamrController, 'resolveAuthor').mockResolvedValue(AUTHOR);
        vi.spyOn(streamrController, 'isEpochEnvelope').mockReturnValue(false);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        streamrController.client = null;
    });

    it('refuses to run without a client', async () => {
        streamrController.client = null;
        await expect(streamrController.subscribeToPartition(STREAM, 1, () => {}))
            .rejects.toThrow('Streamr client not initialized');
    });

    it('subscribes once per partition and hands the same subscription back', async () => {
        wire();

        const first = await streamrController.subscribeToPartition(STREAM, 1, () => {});
        const again = await streamrController.subscribeToPartition(STREAM, 1, () => {});

        expect(again).toBe(first);
        expect(streamrController.client.subscribe).toHaveBeenCalledTimes(1);
    });

    it('keeps partitions of the same stream apart', async () => {
        wire();

        await streamrController.subscribeToPartition(STREAM, 1, () => {});
        await streamrController.subscribeToPartition(STREAM, 2, () => {});

        expect(streamrController.client.subscribe).toHaveBeenCalledTimes(2);
        expect(Object.keys(streamrController.subscriptions.get(STREAM))).toEqual(['1', '2']);
    });

    it('proves access through the gate contract on a gated stream', async () => {
        streamrController._gatedChannelFor.mockResolvedValue({ gate: { address: GATE } });
        const state = wire();

        await streamrController.subscribeToPartition(STREAM, 1, () => {});

        expect(state.options.erc1271Contract).toBe(GATE);
    });

    it('attaches the author and delivers the message', async () => {
        const state = wire();
        const handler = vi.fn();
        await streamrController.subscribeToPartition(STREAM, 1, handler);

        await state.onMessage({ type: 'media_signal' }, envelope());

        expect(handler.mock.calls[0][0]).toMatchObject({ type: 'media_signal', account: AUTHOR });
    });

    it('drops a message whose author cannot be recovered', async () => {
        streamrController.resolveAuthor.mockResolvedValue(null);
        const state = wire();
        const handler = vi.fn();
        await streamrController.subscribeToPartition(STREAM, 1, handler);

        await state.onMessage({ type: 'media_signal' }, envelope());

        expect(handler).not.toHaveBeenCalled();
    });

    it('decrypts a password channel before dispatching', async () => {
        vi.spyOn(cryptoManager, 'decryptJSON').mockResolvedValue({ type: 'media_signal', from: 'peer' });
        const state = wire();
        const handler = vi.fn();
        await streamrController.subscribeToPartition(STREAM, 1, handler, 'pw');

        await state.onMessage('cipher', envelope());

        expect(handler.mock.calls[0][0]).toMatchObject({ from: 'peer' });
    });

    it('skips a sealed message whose epoch key we do not hold', async () => {
        streamrController.isEpochEnvelope.mockReturnValue(true);
        vi.spyOn(streamrController, 'openEpochEnvelope').mockResolvedValue(null);
        const state = wire();
        const handler = vi.fn();
        await streamrController.subscribeToPartition(STREAM, 1, handler);

        await state.onMessage({ e: 1, kid: 'unknown' }, envelope());

        expect(handler).not.toHaveBeenCalled();
    });

    it('takes the author from inside the seal on a members-only channel', async () => {
        streamrController.isEpochEnvelope.mockReturnValue(true);
        vi.spyOn(streamrController, 'openEpochEnvelope').mockResolvedValue({ type: 'media_signal' });
        streamrController._gatedChannelFor.mockResolvedValue({ gate: { address: GATE }, wireIdentity: 'sealed' });
        vi.spyOn(streamrController, '_openAuthorship')
            .mockResolvedValue({ payload: { type: 'media_signal' }, author: OTHER });
        const state = wire();
        const handler = vi.fn();
        await streamrController.subscribeToPartition(STREAM, 1, handler);

        await state.onMessage({ e: 1 }, envelope());

        expect(handler.mock.calls[0][0].account).toBe(OTHER);
    });

    it('drops a members-only message whose authorship does not verify', async () => {
        streamrController.isEpochEnvelope.mockReturnValue(true);
        vi.spyOn(streamrController, 'openEpochEnvelope').mockResolvedValue({ type: 'media_signal' });
        streamrController._gatedChannelFor.mockResolvedValue({ gate: { address: GATE }, wireIdentity: 'sealed' });
        vi.spyOn(streamrController, '_openAuthorship').mockResolvedValue(null);
        const state = wire();
        const handler = vi.fn();
        await streamrController.subscribeToPartition(STREAM, 1, handler);

        await state.onMessage({ e: 1 }, envelope());

        expect(handler).not.toHaveBeenCalled();
    });

    it('hands binary media over with its publisher alongside', async () => {
        vi.spyOn(streamrController, '_openBinaryMediaPayload').mockResolvedValue({ chunk: 7 });
        const state = wire();
        const handler = vi.fn();
        await streamrController.subscribeToPartition(STREAM, 2, handler);

        await state.onMessage(new Uint8Array([9]), envelope());

        expect(handler).toHaveBeenCalledWith({ chunk: 7 }, AUTHOR);
    });

    it('drops binary media whose author cannot be recovered', async () => {
        vi.spyOn(streamrController, '_openBinaryMediaPayload').mockResolvedValue({ chunk: 7 });
        streamrController.resolveAuthor.mockResolvedValue(null);
        const state = wire();
        const handler = vi.fn();
        await streamrController.subscribeToPartition(STREAM, 2, handler);

        await state.onMessage(new Uint8Array([9]), envelope());

        expect(handler).not.toHaveBeenCalled();
    });

    it('survives a handler that throws', async () => {
        const state = wire();
        await streamrController.subscribeToPartition(STREAM, 1, () => { throw new Error('boom'); });

        await expect(state.onMessage({ type: 'media_signal' }, envelope())).resolves.toBeUndefined();
    });
});
