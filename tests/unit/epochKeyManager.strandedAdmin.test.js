/**
 * A device with no announce to work from must still ask.
 *
 * The admin case is the one that stranded a real owner: a fresh device of
 * the channel owner cannot mint (that would fork the channel) and used to
 * return without asking either, so it waited for keys that nobody was ever
 * asked for. A member that already adopted keys is in the same position
 * when the announce has aged out of storage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { streamrController } = await import('../../src/js/streamr.js');

const GATE = '0x' + 'cd'.repeat(20);
const STREAM = '0x' + 'ef'.repeat(20) + '/stranded-1';
const channel = {
    messageStreamId: STREAM,
    keysStreamId: STREAM.replace('-1', '-4'),
    type: 'gated',
    gate: { address: GATE },
    members: [],
    createdAt: Date.now() - 7 * 24 * 3600 * 1000
};

describe('a device with no announce', () => {
    let published;

    beforeEach(() => {
        published = [];
        epochKeyManager.state?.delete?.(STREAM);
        vi.spyOn(streamrController, 'publishKeysMessage')
            .mockImplementation(async (_sid, msg) => { published.push(msg); });
        vi.spyOn(streamrController, 'resendKeysMessages').mockResolvedValue([]);
        vi.spyOn(epochKeyManager, '_persist').mockResolvedValue(undefined);
        vi.spyOn(epochKeyManager, '_loadPersisted').mockImplementation(() => {});
    });

    afterEach(() => vi.restoreAllMocks());

    const requests = () => published.filter((m) => m.t === 'key_request');

    it('asks when the admin cannot mint on an established channel', async () => {
        vi.spyOn(epochKeyManager, 'isOwnAdmin').mockReturnValue(true);
        // The guard refuses: an admin device holding nothing on a channel
        // older than the virginity window must not mint a rival epoch 1.
        vi.spyOn(epochKeyManager, '_bootstrapFirstEpoch').mockResolvedValue(undefined);

        await epochKeyManager.ensureChannelKeys(channel);

        expect(requests()).toHaveLength(1);
        expect(requests()[0].fromEpoch).toBe(1);
    });

    it('asks when a member holds keys but the announce is gone', async () => {
        vi.spyOn(epochKeyManager, 'isOwnAdmin').mockReturnValue(false);
        const s = epochKeyManager._getState(STREAM);
        s.loaded = true;
        s.epochs = new Map([['kid-1', { epoch: 1, keyHex: '11'.repeat(32) }]]);

        await epochKeyManager.ensureChannelKeys(channel);

        expect(requests()).toHaveLength(1);
    });

    it('stays quiet on a virgin channel it is not the admin of', async () => {
        vi.spyOn(epochKeyManager, 'isOwnAdmin').mockReturnValue(false);

        await epochKeyManager.ensureChannelKeys(channel);

        expect(requests()).toHaveLength(0);
    });
});

describe('a kid seen on the wire that no held key opens', () => {
    let published;

    beforeEach(() => {
        published = [];
        epochKeyManager.state?.delete?.(STREAM);
        vi.spyOn(streamrController, 'publishKeysMessage')
            .mockImplementation(async (_sid, msg) => { published.push(msg); });
        vi.spyOn(streamrController, 'resendKeysMessages').mockResolvedValue([]);
        vi.spyOn(epochKeyManager, '_persist').mockResolvedValue(undefined);
        vi.spyOn(epochKeyManager, '_loadPersisted').mockImplementation(() => {});
        vi.spyOn(epochKeyManager, 'isOwnAdmin').mockReturnValue(false);
    });

    afterEach(() => vi.restoreAllMocks());

    it('is asked for, even though no announce names that epoch', async () => {
        const s = epochKeyManager._getState(STREAM);
        s.loaded = true;
        // Announced and adopted agree — "missing epochs" is empty — yet the
        // wire carries epoch 9, whose announce never arrived.
        s.announces = new Map([[4, { epoch: 4, keyId: 'kid-4' }]]);
        s.epochs = new Map([['kid-4', { epoch: 4, keyHex: '44'.repeat(32) }]]);
        s.currentEpoch = 4;
        s.missingKids = new Set(['9.abcdef012345']);

        await epochKeyManager.ensureChannelKeys(channel);

        const requests = published.filter((m) => m.t === 'key_request');
        expect(requests).toHaveLength(1);
        expect(requests[0].fromEpoch).toBe(9);
    });
});
