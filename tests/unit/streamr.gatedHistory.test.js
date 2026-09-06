/**
 * Gated-channel history policy:
 *
 *  - Every history read of a gated channel (-1 content/control, -3 admin
 *    state and channel image, scroll-up ranges) uses the SDK's RAW resend:
 *    the stored envelopes come back unvalidated, so the SDK never re-checks
 *    them against the PRESENT gate state — retention is the proof of past
 *    membership, and an ex-member's history survives. Authorship is
 *    recovered client-side (resolveAuthor) and a null author drops the row.
 *  - Ungated channels keep the validated (non-raw) resend.
 *  - The gate contract's join() is no longer used anywhere: history validity
 *    does not come from everMember, so registering membership buys nothing.
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
const { gateManager } = await import('../../src/js/gate.js');

const GATE = '0x' + 'ab'.repeat(20);
const AUTHOR = '0x' + '11'.repeat(20);
const STREAM = '0xaaa/gated-history-1';
const ADMIN_STREAM = '0xaaa/gated-history-3';

function textMessage(ts) {
    return {
        content: { type: 'text', id: 'id-' + ts, text: 'hello', sender: AUTHOR, timestamp: ts },
        timestamp: ts,
        publisherId: GATE,
        streamMessage: {}
    };
}

async function* streamOf(...messages) {
    for (const message of messages) yield message;
}

describe('gated history goes through the raw resend', () => {
    let resendCalls;

    beforeEach(() => {
        resendCalls = [];
        streamrController.client = {
            resend: vi.fn(async (streamDef, options) => {
                resendCalls.push({ streamDef, options });
                return streamOf(textMessage(1000));
            })
        };
        vi.spyOn(streamrController, 'resolveAuthor').mockResolvedValue(AUTHOR);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        streamrController.client = null;
    });

    it('fetchHistoryAsync: gated resend is raw and rows reach the handler', async () => {
        vi.spyOn(streamrController, '_gatedChannelFor')
            .mockResolvedValue({ messageStreamId: STREAM, gate: { address: GATE } });

        const handled = [];
        await streamrController.fetchHistoryAsync(STREAM, 0, 50, (content) => handled.push(content));

        expect(resendCalls).toHaveLength(1);
        expect(resendCalls[0].options).toMatchObject({ last: 50, raw: true });
        expect(handled).toHaveLength(1);
        expect(handled[0].account).toBe(AUTHOR);
    });

    it('fetchHistoryAsync: ungated reads raw too, guarded by the envelope check', async () => {
        vi.spyOn(streamrController, '_gatedChannelFor').mockResolvedValue(null);

        await streamrController.fetchHistoryAsync(STREAM, 0, 50, () => {});

        expect(resendCalls).toHaveLength(1);
        expect(resendCalls[0].options.raw).toBe(true);
    });

    it('fetchHistoryAsync: a row without a resolvable author is dropped', async () => {
        vi.spyOn(streamrController, '_gatedChannelFor')
            .mockResolvedValue({ messageStreamId: STREAM, gate: { address: GATE } });
        streamrController.resolveAuthor.mockResolvedValue(null);

        const handled = [];
        await streamrController.fetchHistoryAsync(STREAM, 0, 50, (content) => handled.push(content));

        expect(handled).toHaveLength(0);
    });

    it('fetchOlderHistory: gated range resend is raw', async () => {
        vi.spyOn(streamrController, '_gatedChannelFor')
            .mockResolvedValue({ messageStreamId: STREAM, gate: { address: GATE } });

        await streamrController.fetchOlderHistory(STREAM, 0, 2000, 50);

        expect(resendCalls.length).toBeGreaterThan(0);
        expect(resendCalls[0].options.raw).toBe(true);
        expect(resendCalls[0].options.to).toEqual({ timestamp: 2000 });
    });

    it('resendAdminState: gated resend is raw', async () => {
        vi.spyOn(streamrController, '_gatedChannelFor')
            .mockResolvedValue({ messageStreamId: STREAM, gate: { address: GATE } });

        await streamrController.resendAdminState(ADMIN_STREAM);

        expect(resendCalls).toHaveLength(1);
        expect(resendCalls[0].options.raw).toBe(true);
    });

    it('resendChannelImage: gated resend is raw', async () => {
        vi.spyOn(streamrController, '_gatedChannelFor')
            .mockResolvedValue({ messageStreamId: STREAM, gate: { address: GATE } });

        await streamrController.resendChannelImage(ADMIN_STREAM);

        expect(resendCalls).toHaveLength(1);
        expect(resendCalls[0].options.raw).toBe(true);
    });

    it('resendChannelImage: ungated reads raw too', async () => {
        vi.spyOn(streamrController, '_gatedChannelFor').mockResolvedValue(null);

        await streamrController.resendChannelImage(ADMIN_STREAM);

        expect(resendCalls[0].options.raw).toBe(true);
    });
});

describe('gate join() is gone', () => {
    it('gateManager no longer exposes join', () => {
        expect(gateManager.join).toBeUndefined();
    });
});
