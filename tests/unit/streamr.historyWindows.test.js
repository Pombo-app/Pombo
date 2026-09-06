/**
 * The two bounded history reads that do not scan from epoch:
 *
 *  - `fetchOlderHistoryWindowed`, the DM inbox pager, which walks fixed time
 *    windows backwards and reports "there may be more" purely from where the
 *    window landed, never from what it found.
 *  - `resendLatestContentMessages`, the sidebar preview read, which must
 *    return only what a preview can render and must not let an edit or a
 *    delete masquerade as the latest message.
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
const { cryptoManager } = await import('../../src/js/crypto.js');

const AUTHOR = '0x' + '22'.repeat(20);
const STREAM = '0xbbb/windows-1';

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

const row = (ts, content, over = {}) => ({
    content,
    timestamp: ts,
    getPublisherId: () => AUTHOR,
    getTimestamp: () => ts,
    ...over,
});

afterEach(() => {
    vi.restoreAllMocks();
    streamrController.client = null;
});

describe('fetchOlderHistoryWindowed', () => {
    it('refuses to run without a client', async () => {
        streamrController.client = null;
        await expect(streamrController.fetchOlderHistoryWindowed(STREAM, 0, 1000, 100))
            .rejects.toThrow('Client not initialized');
    });

    it('asks for one window that stops just short of the cursor', async () => {
        const calls = serve();

        const out = await streamrController.fetchOlderHistoryWindowed(STREAM, 0, 10_000, 3_000);

        expect(calls[0].options.from).toEqual({ timestamp: 7_000 });
        // Exclusive here, unlike the epoch scan: the caller already holds the
        // boundary message and pages strictly backwards.
        expect(calls[0].options.to).toEqual({ timestamp: 9_999 });
        expect(out.windowStart).toBe(7_000);
    });

    it('never walks past the epoch', async () => {
        const calls = serve();

        const out = await streamrController.fetchOlderHistoryWindowed(STREAM, 0, 1_000, 5_000);

        expect(calls[0].options.from).toEqual({ timestamp: 0 });
        expect(out.windowStart).toBe(0);
        // Nothing older than the epoch, so this is the end of the line.
        expect(out.hasMore).toBe(false);
    });

    it('claims more history whenever the window stopped above the epoch, even on an empty window', async () => {
        serve();

        const out = await streamrController.fetchOlderHistoryWindowed(STREAM, 0, 10_000, 3_000);

        expect(out.messages).toEqual([]);
        expect(out.hasMore).toBe(true);
    });

    it('hands back the envelope as it came, with publisher and timestamp', async () => {
        serve(row(8_000, { type: 'dm', body: 'sealed' }));

        const out = await streamrController.fetchOlderHistoryWindowed(STREAM, 0, 10_000, 3_000);

        expect(out.messages).toEqual([
            { content: { type: 'dm', body: 'sealed' }, publisherId: AUTHOR, timestamp: 8_000 },
        ]);
    });

    it('decrypts a password channel and skips what the password does not open', async () => {
        vi.spyOn(cryptoManager, 'decryptJSON')
            .mockImplementationOnce(async () => ({ type: 'text', text: 'opened' }))
            .mockImplementationOnce(async () => { throw new Error('bad password'); });
        serve(row(8_000, 'cipher-a'), row(8_100, 'cipher-b'));

        const out = await streamrController.fetchOlderHistoryWindowed(STREAM, 0, 10_000, 3_000, null, 'pw');

        expect(out.messages).toHaveLength(1);
        expect(out.messages[0].content).toEqual({ type: 'text', text: 'opened' });
    });

    it('keeps the window bounds when the resend fails outright', async () => {
        streamrController.client = { resend: vi.fn(async () => { throw new Error('storage down'); }) };

        const out = await streamrController.fetchOlderHistoryWindowed(STREAM, 0, 10_000, 3_000);

        expect(out).toEqual({ messages: [], hasMore: true, windowStart: 7_000 });
    });

    it('stops on abort', async () => {
        const controller = new AbortController();
        let served = 0;
        streamrController.client = {
            resend: vi.fn(async () => ({
                [Symbol.asyncIterator]: () => ({
                    next: async () => {
                        served++;
                        if (served === 2) controller.abort();
                        return { done: false, value: row(8_000 + served, { type: 'dm' }) };
                    },
                }),
            })),
        };

        const out = await streamrController.fetchOlderHistoryWindowed(STREAM, 0, 10_000, 3_000, controller.signal);

        expect(served).toBe(2);
        expect(out.messages).toHaveLength(2);
    });
});

describe('resendLatestContentMessages', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('refuses to run without a client', async () => {
        streamrController.client = null;
        await expect(streamrController.resendLatestContentMessages(STREAM))
            .rejects.toThrow('Streamr client not initialized');
    });

    it('reads the tail of the content partition', async () => {
        const calls = serve();

        await streamrController.resendLatestContentMessages(STREAM, { last: 5 });

        expect(calls[0].streamDef).toEqual({ streamId: STREAM, partition: 0 });
        expect(calls[0].options).toEqual({ last: 5, raw: true });
    });

    it('asks for at least one message however small the caller goes', async () => {
        const calls = serve();

        await streamrController.resendLatestContentMessages(STREAM, { last: 0 });

        expect(calls[0].options.last).toBeGreaterThanOrEqual(1);
    });

    it('returns newest first whatever order storage delivered', async () => {
        serve(
            row(100, { type: 'text', text: 'older' }),
            row(300, { type: 'text', text: 'newest' }),
            row(200, { type: 'text', text: 'middle' }),
        );

        const out = await streamrController.resendLatestContentMessages(STREAM);

        expect(out.map((e) => e.text)).toEqual(['newest', 'middle', 'older']);
        expect(out[0]._publisherId).toBe(AUTHOR);
        expect(out[0]._timestamp).toBe(300);
    });

    it('never lets an edit or a delete stand in as the latest message', async () => {
        serve(
            row(100, { type: 'text', text: 'real' }),
            row(200, { type: 'edit', targetId: 'x', text: 'edited' }),
            row(300, { type: 'delete', targetId: 'x' }),
        );

        const out = await streamrController.resendLatestContentMessages(STREAM);

        expect(out.map((e) => e.type)).toEqual(['text']);
    });

    it('keeps only what a preview can render', async () => {
        serve(
            row(100, { type: 'text', text: 'a' }),
            row(110, { type: 'image', imageId: 'i' }),
            row(120, { type: 'file_announce', metadata: {} }),
            row(130, { type: 'storage_file_announce', metadata: {} }),
            row(140, { type: 'reaction', emoji: '🔥' }),
            row(150, { type: 'presence' }),
            row(160, { type: 'image_chunk', imageId: 'i', chunkIndex: 0, data: 'x' }),
        );

        const out = await streamrController.resendLatestContentMessages(STREAM);

        expect(out.map((e) => e.type).sort()).toEqual(
            ['file_announce', 'image', 'reaction', 'storage_file_announce', 'text']
        );
    });

    it('drops encrypted entries when no password was given', async () => {
        serve(row(100, 'cipher'));

        const out = await streamrController.resendLatestContentMessages(STREAM);

        expect(out).toEqual([]);
    });

    it('opens encrypted entries when the password is given', async () => {
        vi.spyOn(cryptoManager, 'decryptJSON').mockResolvedValue({ type: 'text', text: 'opened' });
        serve(row(100, 'cipher'));

        const out = await streamrController.resendLatestContentMessages(STREAM, { password: 'pw' });

        expect(out.map((e) => e.text)).toEqual(['opened']);
    });

    it('answers with nothing when the resend fails', async () => {
        streamrController.client = { resend: vi.fn(async () => { throw new Error('storage down'); }) };

        expect(await streamrController.resendLatestContentMessages(STREAM)).toEqual([]);
    });
});
