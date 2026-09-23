/**
 * Stream retention resolution, and the epoch-key re-announce that times
 * itself off the KEYS stream (-4).
 *
 * The purge applies each stream's own retention, so a channel's -1, -3 and
 * -4 can age out at different rates. Deciding the -4 re-announce with the
 * -1 value is how a gated channel silently loses its KEY_ANNOUNCE anchor.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

vi.mock('../../src/js/graph.js', () => ({
    graphAPI: { getStream: vi.fn() }
}));

const { readStreamRetention, pickRetention, keysRetentionDays, retentionInSync } =
    await import('../../src/js/streamRetention.js');
const { graphAPI } = await import('../../src/js/graph.js');
const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { streamrController } = await import('../../src/js/streamr.js');
const { CONFIG } = await import('../../src/js/config.js');

const DAY = 86_400_000;
const withRetention = (storageDays) => ({
    metadata: JSON.stringify({
        partitions: 2,
        description: '{"a":"pombo","k":"keys"}',
        ...(storageDays === undefined ? {} : { storageDays })
    })
});

describe('readStreamRetention()', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns the retention carried in the stream metadata', async () => {
        graphAPI.getStream.mockResolvedValue(withRetention(3));
        expect(await readStreamRetention('s-4')).toBe(3);
    });

    it('returns null when the metadata carries no retention', async () => {
        graphAPI.getStream.mockResolvedValue(withRetention(undefined));
        expect(await readStreamRetention('s-4')).toBeNull();
    });

    it('returns null for a non-positive retention rather than passing it on', async () => {
        graphAPI.getStream.mockResolvedValue(withRetention(0));
        expect(await readStreamRetention('s-4')).toBeNull();
    });

    it('never throws when the Graph is unreachable', async () => {
        graphAPI.getStream.mockRejectedValue(new Error('graph down'));
        expect(await readStreamRetention('s-4')).toBeNull();
    });

    it('never throws on unparseable metadata', async () => {
        graphAPI.getStream.mockResolvedValue({ metadata: 'not json' });
        expect(await readStreamRetention('s-4')).toBeNull();
    });

    it('does not query for a missing stream id', async () => {
        expect(await readStreamRetention(null)).toBeNull();
        expect(graphAPI.getStream).not.toHaveBeenCalled();
    });
});

describe('pickRetention()', () => {
    it('takes the first usable candidate in order', () => {
        expect(pickRetention([[null, 'a'], [7, 'b'], [30, 'c']]))
            .toEqual({ storageDays: 7, source: 'b' });
    });

    it('skips zero, negative and non-numeric candidates', () => {
        expect(pickRetention([[0, 'a'], [-1, 'b'], ['30', 'c'], [5, 'd']]))
            .toEqual({ storageDays: 5, source: 'd' });
    });

    it('falls back to the configured default', () => {
        expect(pickRetention([[null, 'a'], [undefined, 'b']]))
            .toEqual({ storageDays: CONFIG.storage.defaultRetentionDays, source: 'default' });
    });
});

describe('retentionInSync()', () => {
    it('agrees when every known value matches', () => {
        expect(retentionInSync([180, 180, 180])).toBe(true);
    });

    it('disagrees when one stream holds a different retention', () => {
        expect(retentionInSync([180, 180, 3])).toBe(false);
        expect(retentionInSync([3, 180, 180])).toBe(false);
    });

    // An unknown value is a stream the channel does not have, or a lookup
    // that failed. Neither contradicts anything, and reporting them as a
    // mismatch would put the badge on every channel with no keys stream.
    it('skips unknown values rather than counting them as a mismatch', () => {
        expect(retentionInSync([180, 180, null])).toBe(true);
        expect(retentionInSync([180, null, undefined])).toBe(true);
        expect(retentionInSync([180, 0, -1, '180'])).toBe(true);
    });

    it('agrees when nothing is known at all', () => {
        expect(retentionInSync([null, null, null])).toBe(true);
        expect(retentionInSync([])).toBe(true);
        expect(retentionInSync(null)).toBe(true);
    });
});

describe('keysRetentionDays()', () => {
    it('prefers the keys stream value over every other', () => {
        expect(keysRetentionDays({ keysStorageDays: 3, adminStorageDays: 30, storageDays: 180 })).toBe(3);
    });

    it('falls back to the admin value before the message one', () => {
        expect(keysRetentionDays({ adminStorageDays: 30, storageDays: 180 })).toBe(30);
    });

    it('falls back to the message value when nothing else is known', () => {
        expect(keysRetentionDays({ storageDays: 90 })).toBe(90);
    });

    it('falls back to the configured default on an empty record', () => {
        expect(keysRetentionDays({})).toBe(CONFIG.storage.defaultRetentionDays);
        expect(keysRetentionDays(null)).toBe(CONFIG.storage.defaultRetentionDays);
    });
});

describe('epochKeyManager._maybeReannounceAging()', () => {
    const CHANNEL = (extra = {}) => ({
        messageStreamId: 's-1', keysStreamId: 's-4', type: 'gated',
        gate: { address: '0x' + 'ab'.repeat(20) }, ...extra
    });

    function stateAgedDays(days) {
        return {
            currentEpoch: 2,
            announces: new Map([[2, { keyId: 'k2', epoch: 2 }]]),
            epochs: new Map([['k2', { keyHash: '0xhash' }]]),
            announceFreshness: new Map([[2, Date.now() - days * DAY]])
        };
    }

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(streamrController, 'publishKeysMessage').mockResolvedValue(undefined);
        vi.spyOn(epochKeyManager, '_ensureAnnounceRetained').mockResolvedValue(undefined);
    });

    it('re-announces against the KEYS retention, not the message one', async () => {
        // 2.9d is fresh under the -1's 180d (threshold 144d) and stale under
        // the -4's real 3d (threshold 2.4d).
        await epochKeyManager._maybeReannounceAging(
            CHANNEL({ storageDays: 180, keysStorageDays: 3 }), stateAgedDays(2.9));
        expect(streamrController.publishKeysMessage).toHaveBeenCalledWith(
            's-4', expect.objectContaining({ epoch: 2, keyId: 'k2', keyHash: '0xhash' }));
    });

    it('stays quiet while the announce is fresh for the keys retention', async () => {
        await epochKeyManager._maybeReannounceAging(
            CHANNEL({ storageDays: 3, keysStorageDays: 180 }), stateAgedDays(2.9));
        expect(streamrController.publishKeysMessage).not.toHaveBeenCalled();
    });

    it('uses the admin retention when the keys one was never resolved', async () => {
        await epochKeyManager._maybeReannounceAging(
            CHANNEL({ storageDays: 180, adminStorageDays: 3 }), stateAgedDays(2.9));
        expect(streamrController.publishKeysMessage).toHaveBeenCalled();
    });

    it('republishes an announce the storage never returned, whatever the retention', async () => {
        const s = stateAgedDays(0);
        s.announceFreshness.set(2, 0);
        await epochKeyManager._maybeReannounceAging(CHANNEL({ keysStorageDays: 180 }), s);
        expect(streamrController.publishKeysMessage).toHaveBeenCalled();
    });

    it('keeps the epoch\'s original validFrom, so its history stays inside the window', async () => {
        const s = stateAgedDays(0);
        s.announceFreshness.set(2, 0);
        const since = Date.now() - 40 * DAY;
        s.announces.get(2).validFrom = since;
        await epochKeyManager._maybeReannounceAging(CHANNEL({ keysStorageDays: 180 }), s);
        expect(streamrController.publishKeysMessage).toHaveBeenCalledWith(
            's-4', expect.objectContaining({ epoch: 2, validFrom: since }));
    });

    it('does nothing without a held key to anchor', async () => {
        const s = stateAgedDays(400);
        s.epochs.clear();
        await epochKeyManager._maybeReannounceAging(CHANNEL({ keysStorageDays: 3 }), s);
        expect(streamrController.publishKeysMessage).not.toHaveBeenCalled();
    });
});
