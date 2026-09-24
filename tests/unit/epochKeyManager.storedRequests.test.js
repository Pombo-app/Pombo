/**
 * Stored key requests pile up: a member who waits asks again every minute, and
 * every session of every responder reads them back from -4. Each account is
 * answered through its newest request, and a new session must remember every
 * wrap it reads, or the -4 fills with the same wraps again.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { streamrController } = await import('../../src/js/streamr.js');
const { KEYS_STREAM } = await import('../../src/js/streamConstants.js');

const ADMIN = '0x' + 'aa'.repeat(20);
const ALICE = '0x' + 'a1'.repeat(20);
const CAROL = '0x' + 'c3'.repeat(20);
const GATE = '0x' + 'ab'.repeat(20);
const STREAM = `${ADMIN}/stored-1`;
const channel = {
    messageStreamId: STREAM, keysStreamId: `${ADMIN}/stored-4`, type: 'gated', gate: { address: GATE }, members: []
};
const HOUR = 3600 * 1000;

const request = (requestId, publisherId, timestamp, { spk = true } = {}) => ({
    data: {
        t: 'key_request', requestId, pubkey: '0x04' + 'cd'.repeat(64), fromEpoch: 1,
        ...(spk ? { spk: '0x02' + 'ef'.repeat(32) } : {})
    },
    publisherId,
    timestamp
});

describe('which stored key requests get an answer', () => {
    let s;

    beforeEach(() => {
        epochKeyManager.state.clear();
        s = epochKeyManager._getState(STREAM);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        epochKeyManager.state.clear();
    });

    it('answers each account through its newest request only', () => {
        const now = Date.now();
        const stored = [
            request('a-old', ALICE, now - 5 * HOUR),
            request('c-only', CAROL, now - 3 * HOUR),
            request('a-mid', ALICE, now - 2 * HOUR),
            request('a-new', ALICE, now - 1 * HOUR)
        ];

        const picked = epochKeyManager._storedRequestsToAnswer(s, stored, now).map(e => e.data.requestId);

        expect(picked.sort()).toEqual(['a-new', 'c-only']);
    });

    it('keeps the answer window for requests without a static key', () => {
        const now = Date.now();
        const stored = [
            request('v1-recent', ALICE, now - 60 * 1000, { spk: false }),
            request('v1-stale', CAROL, now - HOUR, { spk: false })
        ];

        const picked = epochKeyManager._storedRequestsToAnswer(s, stored, now).map(e => e.data.requestId);

        expect(picked).toEqual(['v1-recent']);
    });

    it('never picks a request this session sent', () => {
        const now = Date.now();
        s.ownRequestIds.add('mine');
        const stored = [request('mine', ADMIN, now)];

        expect(epochKeyManager._storedRequestsToAnswer(s, stored, now)).toEqual([]);
    });

    it('remembers every wrap one -4 read can hold', () => {
        for (let i = 0; i < 600; i++) epochKeyManager._recordSeenWrap(s, `r${i}`, '1.k');

        expect(s.seenWraps.has('r0')).toBe(true);
        expect(s.seenWraps.get('r599').has('1.k')).toBe(true);
    });

    it('a new session reading 150 answered requests answers none of them again', async () => {
        const now = Date.now();
        const exchange = [];
        for (let i = 0; i < 150; i++) {
            const who = '0x' + i.toString(16).padStart(40, '0');
            exchange.push(request(`r${i}`, who, now - HOUR + i));
            exchange.push({ data: { t: 'key_wrap', v: 2, requestId: `r${i}`, keyId: '1.k', epoch: 1 },
                publisherId: ADMIN, timestamp: now - HOUR + i + 1 });
        }
        vi.spyOn(streamrController, 'resendKeysMessages').mockImplementation(async (_id, { partition }) =>
            partition === KEYS_STREAM.REQUESTS ? exchange : []);
        vi.spyOn(epochKeyManager, '_loadPersisted').mockImplementation((_id, st) => {
            st.epochs = new Map([['1.k', { epoch: 1, keyHex: '11'.repeat(32), keyHash: '0xk' }]]);
            st.announces = new Map([[1, { keyId: '1.k', keyHash: '0xk', validFrom: 1 }]]);
            st.currentEpoch = 1;
        });
        vi.spyOn(epochKeyManager, '_persist').mockResolvedValue(undefined);
        vi.spyOn(epochKeyManager, '_sendKeyRequest').mockResolvedValue(undefined);
        vi.spyOn(epochKeyManager, '_scheduleAnswer').mockImplementation((ch, req) => {
            epochKeyManager._answerRequest(ch, req);
        });
        const hasUnwrapped = vi.spyOn(epochKeyManager, '_hasUnwrappedFor');

        await epochKeyManager.ensureChannelKeys(channel);

        expect(hasUnwrapped).toHaveBeenCalledTimes(150);
        expect(hasUnwrapped.mock.results.every(r => r.value === false)).toBe(true);
    });
});
