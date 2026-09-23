/**
 * Resetting the interactions key: the grants move on-chain before anyone is
 * told about the new key, the announce supersedes the old one by rev, and the
 * two streams the key writes to change in one transaction.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { streamrController } = await import('../../src/js/streamr.js');
const { authManager } = await import('../../src/js/auth.js');

const ADMIN = '0x' + 'aa'.repeat(20);
const GATE = '0x' + 'ab'.repeat(20);
const STREAM = `${ADMIN}/sealed-1`;
const channel = {
    messageStreamId: STREAM, keysStreamId: `${ADMIN}/sealed-4`,
    ephemeralStreamId: `${ADMIN}/sealed-2`, interactionsStreamId: `${ADMIN}/sealed-5`,
    gate: { address: GATE }, wireIdentity: 'sealed'
};
const OLD = { keyId: 'i1.k', keyHex: '33'.repeat(32), address: '0x' + '33'.repeat(20), rev: 1 };

describe('resetting the interactions key', () => {
    let calls;

    beforeEach(() => {
        epochKeyManager.state.clear();
        calls = [];
        vi.spyOn(authManager, 'getAddress').mockReturnValue(ADMIN);
        vi.spyOn(epochKeyManager, '_persist').mockResolvedValue(undefined);
        vi.spyOn(epochKeyManager, '_ensureAnnounceRetained').mockResolvedValue(undefined);
        vi.spyOn(streamrController, 'rekeyInteractionsGrants').mockImplementation(async (_, next, old) => {
            calls.push({ grants: { next, old } });
        });
        vi.spyOn(streamrController, 'publishKeysMessage').mockImplementation(async (_, msg) => {
            calls.push({ published: msg });
        });
        const s = epochKeyManager._getState(STREAM);
        s.loaded = true;
        s.intKey = { ...OLD };
        s.intAnnounce = { keyId: OLD.keyId, keyHash: '0xi', address: OLD.address, rev: 1 };
    });

    afterEach(() => {
        vi.restoreAllMocks();
        epochKeyManager.state.clear();
    });

    it('moves the grants first, then announces the new key at the next rev', async () => {
        const rev = await epochKeyManager.rekeyInteractionsKey(channel);

        const s = epochKeyManager.state.get(STREAM);
        expect(rev).toBe(2);
        expect(calls[0].grants).toEqual({ next: s.intKey.address, old: OLD.address });
        expect(calls[1].published).toMatchObject({ t: 'pub_announce', k: 'i', keyId: s.intKey.keyId, rev: 2 });
        expect(s.intKey.address).not.toBe(OLD.address);
        expect(s.intAnnounce.keyId).toBe(s.intKey.keyId);
    });

    it('announces nothing when the grants did not move', async () => {
        streamrController.rekeyInteractionsGrants.mockRejectedValueOnce(new Error('tx reverted'));

        await expect(epochKeyManager.rekeyInteractionsKey(channel)).rejects.toThrow('tx reverted');

        expect(calls.some((c) => c.published)).toBe(false);
        expect(epochKeyManager.state.get(STREAM).intKey).toEqual(OLD);
    });

    it('is refused on a channel that is not Sealed, and to anyone but the owner', async () => {
        await expect(epochKeyManager.rekeyInteractionsKey({ ...channel, wireIdentity: 'visible' }))
            .rejects.toThrow('not a Sealed channel');
        authManager.getAddress.mockReturnValue('0x' + '11'.repeat(20));
        await expect(epochKeyManager.rekeyInteractionsKey(channel)).rejects.toThrow('only the channel admin');
    });
});

describe('the interactions grants', () => {
    it('change on -5 and -2 in a single setPermissions call', async () => {
        const setPermissions = vi.fn().mockResolvedValue(undefined);
        const previous = streamrController.client;
        streamrController.client = { setPermissions };
        try {
            await streamrController.rekeyInteractionsGrants(channel, '0xNEW', '0xOLD');
        } finally {
            streamrController.client = previous;
        }

        expect(setPermissions).toHaveBeenCalledTimes(1);
        const items = setPermissions.mock.calls[0];
        expect(items.map((i) => i.streamId)).toEqual([channel.interactionsStreamId, channel.ephemeralStreamId]);
        expect(items[0].assignments).toEqual([
            { userId: '0xnew', permissions: ['publish'] },
            { userId: '0xold', permissions: [] }
        ]);
    });
});
