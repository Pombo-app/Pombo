/**
 * A wrap that arrives before the announce that legitimises it.
 *
 * The responder answers a key request as soon as it hears it, so on a cold
 * subscribe the wrap regularly overtakes the announce. Dropping it cost a
 * measured 35s stall on a device: the key only landed when a later retry
 * happened to arrive after the announce.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock('../../src/js/auth.js', () => ({ authManager: { getAddress: () => '0xme', wallet: null } }));
vi.mock('../../src/js/streamr.js', () => ({ streamrController: {}, STREAM_CONFIG: {} }));
vi.mock('../../src/js/secureStorage.js', () => ({ secureStorage: { get: vi.fn(), set: vi.fn() } }));

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');

const state = () => ({ parkedWraps: new Map() });
const wrap = (epoch, keyId) => ({ epoch, keyId, requestId: 'r1', tag: 't' });

describe('parked wraps', () => {
    let s;
    beforeEach(() => { s = state(); });

    it('holds a wrap until its announce arrives', () => {
        epochKeyManager._parkWrap(s, wrap(2, 'k2'));
        expect(s.parkedWraps.get(2)).toHaveLength(1);
        expect(s.parkedWraps.get(2)[0].keyId).toBe('k2');
    });

    it('ignores a wrap with no epoch to wait on', () => {
        epochKeyManager._parkWrap(s, wrap(0, 'k0'));
        epochKeyManager._parkWrap(s, { keyId: 'k' });
        expect(s.parkedWraps.size).toBe(0);
    });

    it('bounds the wait list per epoch', () => {
        for (let i = 0; i < 50; i++) epochKeyManager._parkWrap(s, wrap(1, `k${i}`));
        expect(s.parkedWraps.get(1)).toHaveLength(4);
    });

    it('bounds the number of epochs, dropping the oldest', () => {
        for (let epoch = 1; epoch <= 40; epoch++) epochKeyManager._parkWrap(s, wrap(epoch, `k${epoch}`));
        expect(s.parkedWraps.size).toBe(8);
        expect(s.parkedWraps.has(1)).toBe(false);
        expect(s.parkedWraps.has(40)).toBe(true);
    });
});
