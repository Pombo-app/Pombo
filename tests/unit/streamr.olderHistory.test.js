/**
 * Scroll-up pagination (`fetchOlderHistory`).
 *
 * The hazards this covers are the ones the method's own comments name, each
 * of which has bitten before: a truncated range response latching
 * `hasMore: false` for the rest of the session, an exclusive upper bound
 * skipping messages that share the boundary millisecond, and trusting the
 * resend iterator's order and so slicing away the half of the page that sits
 * next to the cursor.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

// Raw resends verify the envelope signature; these fixtures are plain
// objects with no signature, so the check is stubbed to accept and the
// real recovery keeps its own dedicated tests.
vi.mock('../../src/js/envelopeSigner.js', async (importOriginal) => ({
    ...(await importOriginal()),
    verifyEnvelopeAuthenticity: () => true,
}));

const { streamrController } = await import('../../src/js/streamr.js');

const AUTHOR = '0x' + '11'.repeat(20);
const STREAM = '0xaaa/older-history-1';
const P_MESSAGES = 0;
const P_CONTROL = 1;

const text = (ts, over = {}) => ({
    content: { type: 'text', id: 'id-' + ts, text: 'm' + ts, sender: AUTHOR, timestamp: ts, ...over },
    timestamp: ts,
    publisherId: AUTHOR,
});

async function* streamOf(...messages) {
    for (const m of messages) yield m;
}

/** Returns the resend calls it recorded, and serves `pages` one call at a time. */
function serve(...pages) {
    const calls = [];
    let i = 0;
    streamrController.client = {
        resend: vi.fn(async (streamDef, options) => {
            calls.push({ streamDef, options });
            const page = pages[Math.min(i, pages.length - 1)];
            i++;
            return streamOf(...page);
        }),
    };
    return calls;
}

describe('fetchOlderHistory', () => {
    beforeEach(() => {
        vi.spyOn(streamrController, '_gatedChannelFor').mockResolvedValue(null);
        vi.spyOn(streamrController, 'resolveAuthor').mockResolvedValue(AUTHOR);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        streamrController.client = null;
    });

    it('refuses to run without a client', async () => {
        streamrController.client = null;
        await expect(streamrController.fetchOlderHistory(STREAM, 0, 1000, 10))
            .rejects.toThrow('Client not initialized');
    });

    it('asks for the whole range up to and including the cursor', async () => {
        const calls = serve([text(500)]);

        await streamrController.fetchOlderHistory(STREAM, P_MESSAGES, 1000, 10);

        expect(calls[0].streamDef).toEqual({ streamId: STREAM, partition: P_MESSAGES });
        expect(calls[0].options.from).toEqual({ timestamp: 0 });
        // Inclusive: an exclusive bound would permanently skip siblings that
        // share the boundary millisecond.
        expect(calls[0].options.to).toEqual({ timestamp: 1000 });
    });

    it('reads raw on both gated and ungated channels', async () => {
        streamrController._gatedChannelFor.mockResolvedValue({ messageStreamId: STREAM, gate: { address: '0x1' } });
        let calls = serve([text(500)]);
        await streamrController.fetchOlderHistory(STREAM, P_MESSAGES, 1000, 10);
        expect(calls[0].options.raw).toBe(true);

        // Ungated reads raw too — the envelope-authenticity check replaces
        // the SDK validation that raw turns off.
        streamrController._gatedChannelFor.mockResolvedValue(null);
        calls = serve([text(500)]);
        await streamrController.fetchOlderHistory(STREAM, P_MESSAGES, 1000, 10);
        expect(calls[0].options.raw).toBe(true);
    });

    it('confirms a claimed exhaustion on a second pass and unions the two', async () => {
        // First pass truncated (one message), second pass complete (two).
        const calls = serve([text(100)], [text(100), text(200)]);

        const out = await streamrController.fetchOlderHistory(STREAM, P_MESSAGES, 1000, 10);

        expect(calls).toHaveLength(2);
        expect(out.messages.map((m) => m.id)).toEqual(['id-100', 'id-200']);
    });

    it('does not re-ask once the range already exceeds the page size', async () => {
        const calls = serve([text(100), text(200), text(300)]);

        const out = await streamrController.fetchOlderHistory(STREAM, P_MESSAGES, 1000, 2);

        expect(calls).toHaveLength(1);
        expect(out.hasMore).toBe(true);
    });

    it('keeps the newest page below the cursor whatever order the resend delivers', async () => {
        // Newest-first, which range queries do deliver in practice.
        const calls = serve([text(300), text(200), text(100)]);

        const out = await streamrController.fetchOlderHistory(STREAM, P_MESSAGES, 1000, 2);

        expect(calls).toHaveLength(1);
        expect(out.messages.map((m) => m.id)).toEqual(['id-200', 'id-300']);
        expect(out.hasMore).toBe(true);
    });

    it('reports no more history when the range fits in one page', async () => {
        serve([text(100), text(200)]);

        const out = await streamrController.fetchOlderHistory(STREAM, P_MESSAGES, 1000, 10);

        expect(out.hasMore).toBe(false);
        expect(out.messages).toHaveLength(2);
    });

    it('never returns presence or typing from storage', async () => {
        serve([
            text(100),
            { content: { type: 'presence', sender: AUTHOR, timestamp: 150 }, timestamp: 150, publisherId: AUTHOR },
            { content: { type: 'typing', sender: AUTHOR, timestamp: 160 }, timestamp: 160, publisherId: AUTHOR },
        ]);

        const out = await streamrController.fetchOlderHistory(STREAM, P_MESSAGES, 1000, 10);

        expect(out.messages.map((m) => m.type)).toEqual(['text']);
    });

    it('keeps the content partition free of overrides unless the caller allows them', async () => {
        const edit = { content: { type: 'edit', targetId: 'id-100', timestamp: 200 }, timestamp: 200, publisherId: AUTHOR };

        serve([text(100), edit]);
        let out = await streamrController.fetchOlderHistory(STREAM, P_MESSAGES, 1000, 10);
        expect(out.messages.map((m) => m.type)).toEqual(['text']);

        serve([text(100), edit]);
        out = await streamrController.fetchOlderHistory(STREAM, P_MESSAGES, 1000, 10, null, null, true);
        expect(out.messages.map((m) => m.type)).toEqual(['text', 'edit']);
    });

    it('keeps the control partition to overrides only', async () => {
        serve([
            text(100),
            { content: { type: 'delete', targetId: 'id-100', timestamp: 200 }, timestamp: 200, publisherId: AUTHOR },
        ]);

        const out = await streamrController.fetchOlderHistory(STREAM, P_CONTROL, 1000, 10);

        expect(out.messages.map((m) => m.type)).toEqual(['delete']);
    });

    it('drops a row whose author cannot be recovered', async () => {
        streamrController.resolveAuthor.mockResolvedValue(null);
        serve([text(100)]);

        const out = await streamrController.fetchOlderHistory(STREAM, P_MESSAGES, 1000, 10);

        expect(out.messages).toEqual([]);
    });

    it('skips what it cannot decrypt instead of failing the page', async () => {
        const boom = Object.assign(new Error('no encryption key'), { code: 'DECRYPT_ERROR' });
        streamrController.client = {
            resend: vi.fn(async () => ({
                [Symbol.asyncIterator]() {
                    let step = 0;
                    return {
                        next: async () => {
                            step++;
                            if (step === 1) throw boom;
                            if (step === 2) return { done: false, value: text(200) };
                            return { done: true };
                        },
                    };
                },
            })),
        };

        const out = await streamrController.fetchOlderHistory(STREAM, P_MESSAGES, 1000, 10);

        expect(out.messages.map((m) => m.id)).toEqual(['id-200']);
    });

    it('stops draining an endless resend once the fetch is aborted, and skips the confirmation pass', async () => {
        const controller = new AbortController();
        let served = 0;
        const resend = vi.fn(async () => ({
            [Symbol.asyncIterator]() {
                return {
                    next: async () => {
                        served++;
                        if (served === 2) controller.abort();
                        return { done: false, value: text(served * 100) };
                    },
                };
            },
        }));
        streamrController.client = { resend };

        const out = await streamrController.fetchOlderHistory(STREAM, P_MESSAGES, 1000, 10, null, controller.signal);

        // The stream never ends: only the abort gets us out of the loop.
        expect(served).toBe(2);
        // An aborted page must not trigger the exhaustion confirmation.
        expect(resend).toHaveBeenCalledTimes(1);
        expect(out.messages.map((m) => m.id)).toEqual(['id-100', 'id-200']);
    });

    it('answers with an empty page when the resend itself fails', async () => {
        streamrController.client = { resend: vi.fn(async () => { throw new Error('storage down'); }) };

        const out = await streamrController.fetchOlderHistory(STREAM, P_MESSAGES, 1000, 10);

        expect(out).toEqual({ messages: [], hasMore: false });
    });

    it('stamps the transport timestamp and publisher onto the row', async () => {
        serve([{ content: { type: 'text', id: 'bare', text: 'x', sender: AUTHOR }, timestamp: 777, publisherId: AUTHOR }]);

        const out = await streamrController.fetchOlderHistory(STREAM, P_MESSAGES, 1000, 10);

        expect(out.messages[0].timestamp).toBe(777);
        expect(out.messages[0]._timestamp).toBe(777);
        expect(out.messages[0]._publisherId).toBe(AUTHOR);
    });
});
