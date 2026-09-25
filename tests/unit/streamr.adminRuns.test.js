/**
 * Reading an ADMIN_STATE that went out split.
 *
 * A snapshot too big for one wire message travels on the -3 as a run of
 * chunks closed by a manifest. The reader has to put it back together from
 * whatever window it read, never from rows of someone else, and never apply
 * a run that is missing a row.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/auth.js', () => ({
    authManager: { getSigner: vi.fn() }
}));

// Plain fixtures carry no signature; authority is resolveAuthor's, stubbed below.
vi.mock('../../src/js/envelopeSigner.js', async (importOriginal) => ({
    ...(await importOriginal()),
    verifyEnvelopeAuthenticity: () => true,
}));

import { streamrController, STREAM_CONFIG } from '../../src/js/streamr.js';
import { splitFramed, ADMIN_FRAME } from '../../src/js/syncChunks.js';

const OWNER = '0xowner';
const ADMIN = '0xowner/chan-3';

function iterator(messages) {
    let i = 0;
    return {
        [Symbol.asyncIterator]() {
            return { next: async () => (i < messages.length ? { done: false, value: messages[i++] } : { done: true }) };
        }
    };
}

const row = (content, publisherId = OWNER) => ({
    content, publisherId, timestamp: 1, getPublisherId: () => publisherId
});

const snapshot = (rev, ts, pinText = '') => ({
    type: 'ADMIN_STATE', v: 1, rev, ts, createdBy: OWNER,
    state: { bannedMembers: [], hiddenMessageIds: ['m-1'], pins: [{ targetId: 'm-9', snapshot: { text: pinText } }], absorbedThrough: 0 }
});

/** A snapshot split into `chunks` chunks plus its manifest, oldest row first. */
const run = (s, chunks, runId = 'r1') => {
    const size = JSON.stringify(s).length;
    return splitFramed(s, runId, ADMIN_FRAME, Math.ceil(size / chunks));
};

describe('resendAdminState with split snapshots', () => {
    let windows;   // what each resend returns, newest rows last, by `last`

    beforeEach(() => {
        windows = null;
        streamrController.client = {
            resend: vi.fn(async (_part, { last }) => iterator(windows(last)))
        };
        vi.spyOn(streamrController, '_gatedChannelFor').mockResolvedValue(null);
        vi.spyOn(streamrController, 'publisherMayWrite').mockResolvedValue(true);
        vi.spyOn(streamrController, 'resolveAuthor').mockImplementation(async (_s, _m, p) => p);
    });

    /** The -3 as a list of rows, read `last` at a time from the end. */
    const storage = (rows) => (last) => rows.slice(-last);

    it('joins a run into the snapshot it carried', async () => {
        const big = snapshot(5, 500, 'x'.repeat(900));
        windows = storage([row(snapshot(4, 400)), ...run(big, 3).map(r => row(r))]);

        const latest = await streamrController.resendAdminState(ADMIN, { historyCount: 10 });

        expect(latest).toEqual(big);
    });

    it('ranks a run against whole snapshots by rev', async () => {
        const big = snapshot(5, 500, 'x'.repeat(900));
        windows = storage([...run(big, 2).map(r => row(r)), row(snapshot(6, 600))]);

        const latest = await streamrController.resendAdminState(ADMIN, { historyCount: 10 });

        expect(latest.rev).toBe(6);
    });

    it('never completes a run with rows from another publisher', async () => {
        const big = snapshot(5, 500, 'x'.repeat(900));
        const rows = run(big, 3);
        windows = storage([
            row(snapshot(4, 400)),
            ...rows.map((r, i) => row(r, i === 1 ? '0xintruder' : OWNER))
        ]);

        const latest = await streamrController.resendAdminState(ADMIN, { historyCount: 10 });

        expect(latest.rev).toBe(4);
    });

    it('reads again, wider, when the newest run reaches past the window', async () => {
        const big = snapshot(5, 500, 'x'.repeat(900));
        windows = storage([row(snapshot(4, 400)), ...run(big, 6).map(r => row(r))]);

        const latest = await streamrController.resendAdminState(ADMIN, { historyCount: 5 });

        expect(latest).toEqual(big);
        expect(streamrController.client.resend).toHaveBeenCalledTimes(2);
        expect(streamrController.client.resend.mock.calls[1][1]).toEqual({ last: 5 + 6 + 1, raw: true });
    });

    it('does not read again for a run the window could hold: a lost row stays lost', async () => {
        const big = snapshot(5, 500, 'x'.repeat(900));
        const rows = run(big, 3);
        windows = storage([row(snapshot(4, 400)), ...rows.filter((_, i) => i !== 1).map(r => row(r))]);

        const latest = await streamrController.resendAdminState(ADMIN, { historyCount: 10 });

        expect(latest.rev).toBe(4);
        expect(streamrController.client.resend).toHaveBeenCalledTimes(1);
    });

    it('does not chase a cut run older than the snapshot it already has', async () => {
        const big = snapshot(5, 500, 'x'.repeat(900));
        windows = storage([...run(big, 6).map(r => row(r)), row(snapshot(6, 600))]);

        const latest = await streamrController.resendAdminState(ADMIN, { historyCount: 5 });

        expect(latest.rev).toBe(6);
        expect(streamrController.client.resend).toHaveBeenCalledTimes(1);
    });

    it('drops a run whose rows disagree with their manifest', async () => {
        const big = snapshot(5, 500, 'x'.repeat(900));
        const rows = run(big, 2);
        rows.forEach(r => { r.rev = 9; });
        windows = storage([row(snapshot(4, 400)), ...rows.map(r => row(r))]);

        const latest = await streamrController.resendAdminState(ADMIN, { historyCount: 10 });

        expect(latest.rev).toBe(4);
    });

    it('reads the moderation partition', async () => {
        windows = storage([]);
        await streamrController.resendAdminState(ADMIN, { historyCount: 5 });
        expect(streamrController.client.resend.mock.calls[0][0])
            .toEqual({ streamId: ADMIN, partition: STREAM_CONFIG.ADMIN_STREAM.MODERATION });
    });
});
