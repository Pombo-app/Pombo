/**
 * `fetchHistoryAsync` is the initial history read a channel does on open.
 *
 * Two things here are load-bearing beyond the obvious. It reports
 * `loaded`/`requested` from the RAW count, not from what survived filtering,
 * because that is how the caller decides there is nothing older to scroll to;
 * reporting the filtered count would claim more history exists whenever a
 * page was mostly ephemeral. And it always reports, success or failure, so a
 * channel whose storage is unreachable does not sit forever behind a spinner.
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

const OWNER = '0x' + '77'.repeat(20);
const AUTHOR = '0x' + '88'.repeat(20);
const MESSAGE = `${OWNER}/initial-1`;
const ADMIN = `${OWNER}/initial-3`;

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
    timestamp: ts,
    getTimestamp: () => ts,
    getPublisherId: () => AUTHOR,
});

describe('fetchHistoryAsync', () => {
    beforeEach(() => {
        vi.spyOn(streamrController, '_gatedChannelFor').mockResolvedValue(null);
        vi.spyOn(streamrController, 'resolveAuthor').mockResolvedValue(AUTHOR);
        vi.spyOn(streamrController, 'isEpochEnvelope').mockReturnValue(false);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        streamrController.client = null;
    });

    it('asks storage for the last N of the partition', async () => {
        const calls = serve(row(100, { type: 'text', id: 'a', text: 'x', sender: AUTHOR, timestamp: 100 }));

        await streamrController.fetchHistoryAsync(MESSAGE, 0, 40, () => {});

        expect(calls[0].streamDef).toEqual({ streamId: MESSAGE, partition: 0 });
        expect(calls[0].options.last).toBe(40);
    });

    it('reports what storage gave, not what survived the filters', async () => {
        // Three raw rows, only one of which a content partition will keep.
        serve(
            row(100, { type: 'text', id: 'a', text: 'x', sender: AUTHOR, timestamp: 100 }),
            row(110, { type: 'presence', sender: AUTHOR }),
            row(120, { type: 'typing', sender: AUTHOR }),
        );
        const handler = vi.fn();
        const done = vi.fn();

        await streamrController.fetchHistoryAsync(MESSAGE, 0, 40, handler, null, done);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(done).toHaveBeenCalledWith({ loaded: 3, requested: 40, readError: null });
    });

    it('still reports when storage is unreachable, so the channel does not hang', async () => {
        streamrController.client = { resend: vi.fn(async () => { throw new Error('CORS'); }) };
        const done = vi.fn();

        await streamrController.fetchHistoryAsync(MESSAGE, 0, 40, () => {}, null, done);

        expect(done).toHaveBeenCalledWith({ loaded: 0, requested: 40, readError: null });
    });

    it('survives a completion callback that throws', async () => {
        serve();

        await expect(streamrController.fetchHistoryAsync(MESSAGE, 0, 40, () => {}, null, () => {
            throw new Error('caller blew up');
        })).resolves.toBeUndefined();
    });

    it('keeps the content partition to content, and the control partition to overrides', async () => {
        const text = row(100, { type: 'text', id: 'a', text: 'x', sender: AUTHOR, timestamp: 100 });
        const edit = row(200, { type: 'edit', targetId: 'a' });

        serve(text, edit);
        let seen = [];
        await streamrController.fetchHistoryAsync(MESSAGE, 0, 40, (c) => seen.push(c.type));
        expect(seen).toEqual(['text']);

        serve(text, edit);
        seen = [];
        await streamrController.fetchHistoryAsync(MESSAGE, 1, 40, (c) => seen.push(c.type));
        expect(seen).toEqual(['edit']);
    });

    it('lets the caller admit legacy overrides that were written to the content partition', async () => {
        serve(row(200, { type: 'edit', targetId: 'a' }));
        const seen = [];

        await streamrController.fetchHistoryAsync(MESSAGE, 0, 40, (c) => seen.push(c.type), null, null, true);

        expect(seen).toEqual(['edit']);
    });

    it('does not apply the message-stream filters to other streams', async () => {
        // ADMIN_STATE shares partition 0 but is not a content message.
        serve(row(100, { type: 'ADMIN_STATE', rev: 1, state: {} }));
        const seen = [];

        await streamrController.fetchHistoryAsync(ADMIN, 0, 40, (c) => seen.push(c.type));

        expect(seen).toEqual(['ADMIN_STATE']);
    });

    it('drops a row whose author cannot be recovered', async () => {
        streamrController.resolveAuthor.mockResolvedValue(null);
        serve(row(100, { type: 'text', id: 'a', text: 'x', sender: AUTHOR, timestamp: 100 }));
        const handler = vi.fn();

        await streamrController.fetchHistoryAsync(MESSAGE, 0, 40, handler);

        expect(handler).not.toHaveBeenCalled();
    });

    it('skips a sealed row whose epoch key we do not hold', async () => {
        streamrController.isEpochEnvelope.mockReturnValue(true);
        vi.spyOn(streamrController, 'openEpochEnvelope').mockResolvedValue(null);
        serve(row(100, { e: 1, kid: 'unknown' }));
        const handler = vi.fn();

        await streamrController.fetchHistoryAsync(MESSAGE, 0, 40, handler);

        expect(handler).not.toHaveBeenCalled();
    });

    it('decrypts a password channel and skips what the password does not open', async () => {
        vi.spyOn(cryptoManager, 'decryptJSON')
            .mockImplementationOnce(async () => ({ type: 'text', id: 'a', text: 'opened', sender: AUTHOR, timestamp: 100 }))
            .mockImplementationOnce(async () => { throw new Error('bad password'); });
        serve(row(100, 'cipher-a'), row(110, 'cipher-b'));
        const seen = [];

        await streamrController.fetchHistoryAsync(MESSAGE, 0, 40, (c) => seen.push(c.text), 'pw');

        expect(seen).toEqual(['opened']);
    });

    it('a handler that throws does not abort the rest of the page', async () => {
        serve(
            row(100, { type: 'text', id: 'a', text: 'x', sender: AUTHOR, timestamp: 100 }),
            row(110, { type: 'text', id: 'b', text: 'y', sender: AUTHOR, timestamp: 110 }),
        );
        const seen = [];

        await streamrController.fetchHistoryAsync(MESSAGE, 0, 40, (c) => {
            seen.push(c.id);
            if (c.id === 'a') throw new Error('render blew up');
        });

        expect(seen).toEqual(['a', 'b']);
    });
});
