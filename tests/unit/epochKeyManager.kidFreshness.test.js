/**
 * Kid freshness rule (N-C, §7.11) — what stops readable spam with old epoch
 * keys in gated channels, where sticky signatures mean an ex-member still
 * authors valid envelopes.
 *
 * Live: only the current epoch (previous tolerated briefly after rotation).
 * History: the kid must be the one in force at the message timestamp.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { CONFIG } = await import('../../src/js/config.js');

const NOW = 1_755_000_000_000;
const TOL = CONFIG.gate.kidFreshnessToleranceMs;

/** Channel state with 3 epochs: e1@t=1000h, e2@t=2000h, e3(current)@rotatedAt */
function makeState({ rotatedAt = NOW - 1000 } = {}) {
    return {
        currentEpoch: 3,
        announces: new Map([
            [1, { keyId: 'kid-1', validFrom: NOW - 3_600_000 * 3, timestamp: NOW - 3_600_000 * 3 }],
            [2, { keyId: 'kid-2', validFrom: NOW - 3_600_000 * 2, timestamp: NOW - 3_600_000 * 2 }],
            [3, { keyId: 'kid-3', validFrom: rotatedAt, timestamp: rotatedAt }]
        ]),
        epochs: new Map([
            ['kid-1', { epoch: 1, keyHex: '0x' + '11'.repeat(32) }],
            ['kid-2', { epoch: 2, keyHex: '0x' + '22'.repeat(32) }],
            ['kid-3', { epoch: 3, keyHex: '0x' + '33'.repeat(32) }]
        ])
    };
}

describe('epochKeyManager._kidIsFresh', () => {
    beforeAll(() => vi.useFakeTimers());
    afterEach(() => vi.setSystemTime(NOW));
    beforeAll(() => vi.setSystemTime(NOW));

    it('current epoch kid is always fresh (live and history)', () => {
        const s = makeState();
        expect(epochKeyManager._kidIsFresh(s, 'kid-3', s.epochs.get('kid-3'), { live: true })).toBe(true);
        expect(epochKeyManager._kidIsFresh(s, 'kid-3', s.epochs.get('kid-3'), { timestamp: NOW })).toBe(true);
    });

    it('live: previous epoch tolerated right after a rotation', () => {
        const s = makeState({ rotatedAt: NOW - TOL / 2 });
        expect(epochKeyManager._kidIsFresh(s, 'kid-2', s.epochs.get('kid-2'), { live: true })).toBe(true);
    });

    it('live: previous epoch rejected once the tolerance passes', () => {
        const s = makeState({ rotatedAt: NOW - TOL - 1 });
        expect(epochKeyManager._kidIsFresh(s, 'kid-2', s.epochs.get('kid-2'), { live: true })).toBe(false);
    });

    it('live: epochs older than the previous are always rejected', () => {
        const s = makeState({ rotatedAt: NOW - 1000 });
        expect(epochKeyManager._kidIsFresh(s, 'kid-1', s.epochs.get('kid-1'), { live: true })).toBe(false);
    });

    it('history: accepts the kid in force at the message timestamp', () => {
        const s = makeState();
        const duringEpoch2 = NOW - 3_600_000 * 2 + 60_000;
        expect(epochKeyManager._kidIsFresh(s, 'kid-2', s.epochs.get('kid-2'), { timestamp: duringEpoch2 })).toBe(true);
    });

    it('history: rejects a kid used outside its epoch window', () => {
        const s = makeState();
        const duringEpoch2 = NOW - 3_600_000 * 2 + 60_000;
        expect(epochKeyManager._kidIsFresh(s, 'kid-1', s.epochs.get('kid-1'), { timestamp: duringEpoch2 })).toBe(false);
    });

    it('history: rejects a non-current kid when no timestamp is available', () => {
        const s = makeState();
        expect(epochKeyManager._kidIsFresh(s, 'kid-2', s.epochs.get('kid-2'), {})).toBe(false);
    });

    it('without a current announce there is no anchor — accepts', () => {
        const s = makeState();
        s.announces.delete(3);
        expect(epochKeyManager._kidIsFresh(s, 'kid-1', s.epochs.get('kid-1'), { live: true })).toBe(true);
    });
});

describe('epochKeyManager.getKeyForKid (freshness wiring)', () => {
    it('returns FALSE (drop, not request) on a gated freshness violation', async () => {
        const streamId = '0xaaa/gated-test-1';
        const s = makeState({ rotatedAt: NOW - TOL - 1 });
        epochKeyManager.state.set(streamId, s);
        const result = await epochKeyManager.getKeyForKid(streamId, 'kid-1', { live: true });
        expect(result).toBe(false);
        epochKeyManager.state.delete(streamId);
    });

    it('returns null for an unknown kid (caller requests the key)', async () => {
        const streamId = '0xaaa/gated-test-2';
        epochKeyManager.state.set(streamId, makeState());
        const result = await epochKeyManager.getKeyForKid(streamId, 'kid-unknown', { live: true });
        expect(result).toBe(null);
        epochKeyManager.state.delete(streamId);
    });

    /**
     * A rotation is two clocks. The rotator stamps validFrom with its own, the
     * author stamps the message with theirs, so an author who had already
     * adopted the new epoch can land just BEFORE its announce. Measured on a
     * real channel at ~2s, and every such message was unreadable for good.
     */
    describe('a message that beat its own announce', () => {
        it('opens when the gap is the clock skew of a rotation', () => {
            const s = makeState();
            const rotatedAt = s.announces.get(3).validFrom;
            expect(epochKeyManager._kidIsFresh(s, 'kid-3', s.epochs.get('kid-3'),
                { live: false, timestamp: rotatedAt - 2251 })).toBe(true);
        });

        it('opens right up to the tolerance', () => {
            const s = makeState();
            const rotatedAt = s.announces.get(3).validFrom;
            expect(epochKeyManager._kidIsFresh(s, 'kid-3', s.epochs.get('kid-3'),
                { live: false, timestamp: rotatedAt - TOL })).toBe(true);
        });

        it('stays shut beyond it — that is backdating, not skew', () => {
            const s = makeState();
            const rotatedAt = s.announces.get(3).validFrom;
            expect(epochKeyManager._kidIsFresh(s, 'kid-3', s.epochs.get('kid-3'),
                { live: false, timestamp: rotatedAt - TOL - 1 })).toBe(false);
        });

        it('never re-opens an OLDER kid, which is what the rule is for', () => {
            const s = makeState();
            // kid-1 long retired: its window closed when epoch 2 began.
            expect(epochKeyManager._kidIsFresh(s, 'kid-1', s.epochs.get('kid-1'),
                { live: false, timestamp: NOW - 1000 })).toBe(false);
        });
    });

});
