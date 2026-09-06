/**
 * The live message pipeline that `subscribeWithHistory` installs.
 *
 * This is the seam where transport ends and message logic begins: the
 * subscription hands over raw envelopes, and everything after it is decrypt,
 * unseal, authorship and dispatch. The invariants below are the ones that
 * decide whether a message reaches the UI at all, so they are worth pinning
 * before that code moves house.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { streamrController } = await import('../../src/js/streamr.js');
const { cryptoManager } = await import('../../src/js/crypto.js');

const AUTHOR = '0x' + '33'.repeat(20);
const OTHER = '0x' + '44'.repeat(20);
const GATE = '0x' + '55'.repeat(20);
const STREAM = '0xccc/pipeline-1';

/** Installs a subscribe stub and returns what the pipeline was wired with. */
function wire() {
    const state = { options: null, onMessage: null, onError: null, subscription: { id: 'sub' } };
    streamrController.client = {
        subscribe: vi.fn(async (options, onMessage, onError) => {
            state.options = options;
            state.onMessage = onMessage;
            state.onError = onError;
            return state.subscription;
        }),
    };
    return state;
}

const envelope = (over = {}) => ({
    getPublisherId: () => AUTHOR,
    getTimestamp: () => 1000,
    ...over,
});

describe('subscribeWithHistory', () => {
    beforeEach(() => {
        vi.spyOn(streamrController, '_gatedChannelFor').mockResolvedValue(null);
        vi.spyOn(streamrController, 'resolveAuthor').mockResolvedValue(AUTHOR);
        vi.spyOn(streamrController, 'fetchHistoryAsync').mockResolvedValue(undefined);
        vi.spyOn(streamrController, 'isEpochEnvelope').mockReturnValue(false);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        streamrController.client = null;
    });

    it('refuses to run without a client', async () => {
        streamrController.client = null;
        await expect(streamrController.subscribeWithHistory(STREAM, 0, () => {}))
            .rejects.toThrow('Client not initialized');
    });

    it('proves access through the gate contract on a gated stream, and not otherwise', async () => {
        streamrController._gatedChannelFor.mockResolvedValue({ gate: { address: GATE } });
        let state = wire();
        await streamrController.subscribeWithHistory(STREAM, 0, () => {}, 0);
        expect(state.options.erc1271Contract).toBe(GATE);

        streamrController._gatedChannelFor.mockResolvedValue(null);
        state = wire();
        await streamrController.subscribeWithHistory(STREAM, 0, () => {}, 0);
        expect(state.options.erc1271Contract).toBeUndefined();
    });

    it('returns the live subscription and asks for history when there is history to ask for', async () => {
        const state = wire();

        const sub = await streamrController.subscribeWithHistory(STREAM, 0, () => {}, 25, null, null, true);

        expect(sub).toBe(state.subscription);
        expect(streamrController.fetchHistoryAsync).toHaveBeenCalledWith(
            STREAM, 0, 25, expect.any(Function), null, null, true
        );
    });

    it('signals completion at once on a partition with no stored history', async () => {
        wire();
        const done = vi.fn();

        await streamrController.subscribeWithHistory(STREAM, 1, () => {}, 0, null, done);

        expect(streamrController.fetchHistoryAsync).not.toHaveBeenCalled();
        expect(done).toHaveBeenCalledWith({ loaded: 0, requested: 0 });
    });

    it('a completion callback that throws does not take the subscription down', async () => {
        wire();

        await expect(streamrController.subscribeWithHistory(STREAM, 1, () => {}, 0, null, () => {
            throw new Error('handler blew up');
        })).resolves.toBeDefined();
    });

    describe('the live message path', () => {
        it('attaches the author and delivers the message', async () => {
            const state = wire();
            const handler = vi.fn();
            await streamrController.subscribeWithHistory(STREAM, 0, handler, 0);

            await state.onMessage({ type: 'text', text: 'hi' }, envelope());

            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler.mock.calls[0][0]).toMatchObject({ type: 'text', text: 'hi', account: AUTHOR });
        });

        it('drops a message whose author cannot be recovered', async () => {
            streamrController.resolveAuthor.mockResolvedValue(null);
            const state = wire();
            const handler = vi.fn();
            await streamrController.subscribeWithHistory(STREAM, 0, handler, 0);

            await state.onMessage({ type: 'text', text: 'hi' }, envelope());

            expect(handler).not.toHaveBeenCalled();
        });

        it('decrypts a password channel before dispatching', async () => {
            vi.spyOn(cryptoManager, 'decryptJSON').mockResolvedValue({ type: 'text', text: 'opened' });
            const state = wire();
            const handler = vi.fn();
            await streamrController.subscribeWithHistory(STREAM, 0, handler, 0, 'pw');

            await state.onMessage('cipher', envelope());

            expect(handler.mock.calls[0][0]).toMatchObject({ text: 'opened' });
        });

        it('skips a sealed message whose epoch key we do not hold', async () => {
            streamrController.isEpochEnvelope.mockReturnValue(true);
            vi.spyOn(streamrController, 'openEpochEnvelope').mockResolvedValue(null);
            const state = wire();
            const handler = vi.fn();
            await streamrController.subscribeWithHistory(STREAM, 0, handler, 0);

            await state.onMessage({ e: 1, kid: 'unknown' }, envelope());

            expect(handler).not.toHaveBeenCalled();
        });

        it('takes the author from inside the seal on a members-only channel', async () => {
            streamrController.isEpochEnvelope.mockReturnValue(true);
            vi.spyOn(streamrController, 'openEpochEnvelope').mockResolvedValue({ type: 'text', text: 'sealed' });
            streamrController._gatedChannelFor.mockResolvedValue({ gate: { address: GATE }, wireIdentity: 'sealed' });
            vi.spyOn(streamrController, '_openAuthorship')
                .mockResolvedValue({ payload: { type: 'text', text: 'sealed' }, author: OTHER });
            const state = wire();
            const handler = vi.fn();
            await streamrController.subscribeWithHistory(STREAM, 0, handler, 0);

            await state.onMessage({ e: 1 }, envelope());

            // The transport publisher is the channel identity; the real author
            // is the one the wrapper names.
            expect(handler.mock.calls[0][0].account).toBe(OTHER);
            expect(streamrController.resolveAuthor).not.toHaveBeenCalled();
        });

        it('drops a members-only message whose authorship does not verify', async () => {
            streamrController.isEpochEnvelope.mockReturnValue(true);
            vi.spyOn(streamrController, 'openEpochEnvelope').mockResolvedValue({ type: 'text' });
            streamrController._gatedChannelFor.mockResolvedValue({ gate: { address: GATE }, wireIdentity: 'sealed' });
            vi.spyOn(streamrController, '_openAuthorship').mockResolvedValue(null);
            const state = wire();
            const handler = vi.fn();
            await streamrController.subscribeWithHistory(STREAM, 0, handler, 0);

            await state.onMessage({ e: 1 }, envelope());

            expect(handler).not.toHaveBeenCalled();
        });

        it('hands binary media over with its publisher alongside', async () => {
            vi.spyOn(streamrController, '_openBinaryMediaPayload').mockResolvedValue({ chunk: 1 });
            const state = wire();
            const handler = vi.fn();
            await streamrController.subscribeWithHistory(STREAM, 3, handler, 0);

            await state.onMessage(new Uint8Array([1, 2, 3]), envelope());

            expect(handler).toHaveBeenCalledWith({ chunk: 1 }, AUTHOR);
        });

        it('drops binary media it cannot open', async () => {
            vi.spyOn(streamrController, '_openBinaryMediaPayload').mockResolvedValue(null);
            const state = wire();
            const handler = vi.fn();
            await streamrController.subscribeWithHistory(STREAM, 3, handler, 0);

            await state.onMessage(new Uint8Array([1]), envelope());

            expect(handler).not.toHaveBeenCalled();
        });

        it('survives a handler that throws', async () => {
            const state = wire();
            await streamrController.subscribeWithHistory(STREAM, 0, () => { throw new Error('render blew up'); }, 0);

            await expect(state.onMessage({ type: 'text' }, envelope())).resolves.toBeUndefined();
        });

        it('swallows the SDK decrypt errors that belong to foreign traffic', async () => {
            const state = wire();
            await streamrController.subscribeWithHistory(STREAM, 0, () => {}, 0);

            await expect(state.onError(Object.assign(new Error('no encryption key'), { code: 'DECRYPT_ERROR' })))
                .resolves.toBeUndefined();
            await expect(state.onError(new Error('something else'))).resolves.toBeUndefined();
        });
    });
});
