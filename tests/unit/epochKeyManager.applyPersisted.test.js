/**
 * Imported epoch keys (backup import, sync pull) reach a channel this session
 * already opened: the hydrated state must take them in the same step as the
 * cache, or the next _persist writes the state back without them — for a paid
 * gate, past epochs are never served again.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { secureStorage } = await import('../../src/js/secureStorage.js');

const OWNER = '0x' + 'aa'.repeat(20);
const STREAM = `${OWNER}/imported-1`;
const OTHER = `${OWNER}/other-1`;
const K1 = { keyHex: '0x' + '11'.repeat(32), keyHash: '0xh1', epoch: 1 };
const K2 = { keyHex: '0x' + '22'.repeat(32), keyHash: '0xh2', epoch: 2 };

describe('applyPersisted', () => {
    let s;

    beforeEach(() => {
        secureStorage.initAsGuest(OWNER);
        epochKeyManager.state.clear();
        epochKeyManager.listeners.clear();
        epochKeyManager.loadPersistedState(STREAM);
        s = epochKeyManager.state.get(STREAM);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        epochKeyManager.state.clear();
        epochKeyManager.listeners.clear();
    });

    it('keeps an imported key through the next persist of an open channel', async () => {
        epochKeyManager.applyPersisted({ [STREAM]: { epochs: { k1: K1 }, currentEpoch: 1 } });

        await epochKeyManager._persist(STREAM, s);

        expect(s.epochs.has('k1')).toBe(true);
        expect(secureStorage.getEpochKeys(STREAM).epochs.k1.keyHex).toBe(K1.keyHex);
    });

    it('tells the channel about each key it did not hold, so waiting messages decrypt', () => {
        s.epochs.set('k1', { ...K1, cryptoKey: null });
        const adopted = vi.fn();
        epochKeyManager.onKeyAdopted(STREAM, adopted);

        epochKeyManager.applyPersisted({ [STREAM]: { epochs: { k1: K1, k2: K2 }, currentEpoch: 2 } });

        expect(adopted.mock.calls).toEqual([['k2']]);
        expect(s.currentEpoch).toBe(2);
    });

    it('clears a missing kid the imported key now opens', () => {
        s.missingKids = new Set(['k1']);

        epochKeyManager.applyPersisted({ [STREAM]: { epochs: { k1: K1 }, currentEpoch: 1 } });

        expect(s.missingKids.size).toBe(0);
    });

    it('writes per channel unless asked to replace the slice', () => {
        secureStorage.cache.epochKeys = { [OTHER]: { epochs: { k2: K2 } } };

        epochKeyManager.applyPersisted({ [STREAM]: { epochs: { k1: K1 } } });
        expect(Object.keys(secureStorage.cache.epochKeys).sort()).toEqual([OTHER, STREAM].sort());

        epochKeyManager.applyPersisted({ [STREAM]: { epochs: { k1: K1 } } }, { replace: true });
        expect(Object.keys(secureStorage.cache.epochKeys)).toEqual([STREAM]);
    });

    it('never drops a key the open channel already holds when the slice is replaced', () => {
        s.epochs.set('k2', { ...K2, cryptoKey: null });

        epochKeyManager.applyPersisted({ [STREAM]: { epochs: { k1: K1 } } }, { replace: true });

        expect([...s.epochs.keys()].sort()).toEqual(['k1', 'k2']);
    });

    it('reports no change and notifies nobody when the slice already matches', () => {
        secureStorage.cache.epochKeys = { [STREAM]: { epochs: { k1: K1 } } };
        const adopted = vi.fn();
        epochKeyManager.onKeyAdopted(STREAM, adopted);

        expect(epochKeyManager.applyPersisted({ [STREAM]: { epochs: { k1: K1 } } })).toBe(false);
        expect(adopted).not.toHaveBeenCalled();
    });

    it('leaves channels this session has not opened to load on open', () => {
        epochKeyManager.applyPersisted({ [OTHER]: { epochs: { k2: K2 } } });

        expect(epochKeyManager.state.has(OTHER)).toBe(false);
        epochKeyManager.loadPersistedState(OTHER);
        expect(epochKeyManager.state.get(OTHER).epochs.has('k2')).toBe(true);
    });
});
