/**
 * A re-key whose grant lands while the call fails must not cost the owner the
 * key: the new key is written down before the grant is sent, and the chain
 * decides which of the two keys survives, in the call or on the next open.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { streamrController } = await import('../../src/js/streamr.js');
const { authManager } = await import('../../src/js/auth.js');
const { secureStorage } = await import('../../src/js/secureStorage.js');

const ADMIN = '0x' + 'aa'.repeat(20);
const GATE = '0x' + 'ab'.repeat(20);
const STREAM = `${ADMIN}/sealed-1`;
const channel = {
    messageStreamId: STREAM, keysStreamId: `${ADMIN}/sealed-4`,
    ephemeralStreamId: `${ADMIN}/sealed-2`, interactionsStreamId: `${ADMIN}/sealed-5`,
    type: 'gated', gate: { address: GATE }, wireIdentity: 'sealed', members: []
};
const OLD_INT = { keyId: 'i1.k', keyHex: '0x' + '33'.repeat(32), address: '0x' + '33'.repeat(20), rev: 1 };
const OLD_PUB = { keyId: 'p1.k', keyHex: '0x' + '44'.repeat(32), address: '0x' + '44'.repeat(20), rev: 1 };
const PENDING_INT = {
    keyId: 'i2.k', keyHex: '0x' + '55'.repeat(32), address: '0x' + '55'.repeat(20), rev: 2,
    oldAddress: OLD_INT.address
};
const HOUR = 60 * 60 * 1000;
const UNSETTLED = 'The interactions key reset has not finished. It retries when you open the channel.';

const announced = (key) => ({
    keyId: key.keyId, keyHash: '0xh', address: key.address, rev: key.rev,
    publisher: ADMIN, timestamp: Date.now()
});

describe('recovering a re-key', () => {
    let store;
    let published;
    let warnings;

    const record = () => store.get(STREAM);
    const state = () => epochKeyManager.state.get(STREAM);
    const restart = () => {
        epochKeyManager.state.clear();
        epochKeyManager.loadPersistedState(STREAM);
        return state();
    };
    const seed = (extra = {}) => {
        store.set(STREAM, JSON.parse(JSON.stringify({
            epochs: {}, announces: {}, currentEpoch: 0,
            intKey: OLD_INT, intAnnounce: announced(OLD_INT),
            pubKey: OLD_PUB, pubAnnounce: announced(OLD_PUB),
            ...extra
        })));
    };

    beforeEach(() => {
        epochKeyManager.state.clear();
        store = new Map();
        published = [];
        warnings = [];
        vi.spyOn(secureStorage, 'getEpochKeys').mockImplementation((id) => store.get(id) || null);
        vi.spyOn(secureStorage, 'setEpochKeys').mockImplementation(async (id, data) => {
            store.set(id, JSON.parse(JSON.stringify(data)));
        });
        vi.spyOn(authManager, 'getAddress').mockReturnValue(ADMIN);
        vi.spyOn(epochKeyManager, '_ensureAnnounceRetained').mockResolvedValue(undefined);
        vi.spyOn(streamrController, 'publishKeysMessage').mockImplementation(async (_, msg) => {
            published.push(msg);
        });
        epochKeyManager.setGateWarningHandler((_, warning) => warnings.push(warning));
        seed();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        epochKeyManager.setGateWarningHandler(null);
        epochKeyManager.state.clear();
    });

    describe('in the reset call', () => {
        it('writes the new key down before the grant is sent', async () => {
            let seenAtGrant = null;
            vi.spyOn(streamrController, 'rekeyInteractionsGrants').mockImplementation(async (_, next) => {
                seenAtGrant = { next, record: record() };
            });

            await epochKeyManager.rekeyInteractionsKey(channel);

            expect(seenAtGrant.record.intKeyPending).toMatchObject({
                address: seenAtGrant.next, rev: 2, oldAddress: OLD_INT.address
            });
            expect(seenAtGrant.record.intKey.keyId).toBe(OLD_INT.keyId);
            expect(record().intKeyPending).toBeUndefined();
            expect(record().intKey.address).toBe(seenAtGrant.next);
        });

        it('keeps the new key when the grant landed but the call failed', async () => {
            vi.spyOn(streamrController, 'rekeyInteractionsGrants').mockRejectedValue(new Error('receipt 503'));
            vi.spyOn(streamrController, 'rekeyGrantsState').mockResolvedValue({ next: [true, true], old: [false, false] });

            const rev = await epochKeyManager.rekeyInteractionsKey(channel);

            expect(rev).toBe(2);
            expect(state().intKey.rev).toBe(2);
            expect(published).toEqual([expect.objectContaining({ t: 'pub_announce', k: 'i', rev: 2, keyId: state().intKey.keyId })]);
            expect(record().intKey.keyId).toBe(state().intKey.keyId);
            expect(record().intKeyPending).toBeUndefined();
        });

        it('keeps the old key, and the new one pending, when the grant never landed', async () => {
            vi.spyOn(streamrController, 'rekeyInteractionsGrants').mockRejectedValue(new Error('tx reverted'));
            vi.spyOn(streamrController, 'rekeyGrantsState').mockResolvedValue({ next: [false, false], old: [true, true] });

            await expect(epochKeyManager.rekeyInteractionsKey(channel)).rejects.toThrow('tx reverted');

            expect(state().intKey).toEqual(OLD_INT);
            expect(record().intKeyPending.rev).toBe(2);
            expect(published).toEqual([]);
        });

        it('keeps the new key pending when the chain cannot be read', async () => {
            vi.spyOn(streamrController, 'rekeyInteractionsGrants').mockRejectedValue(new Error('receipt 503'));
            vi.spyOn(streamrController, 'rekeyGrantsState').mockRejectedValue(new Error('rpc down'));

            await expect(epochKeyManager.rekeyInteractionsKey(channel)).rejects.toThrow('receipt 503');

            expect(state().intKey).toEqual(OLD_INT);
            expect(record().intKeyPending.rev).toBe(2);
        });

        it('revokes an unsettled earlier key too, and goes above its rev', async () => {
            seed({ intKeyPending: { ...PENDING_INT, mintedAt: Date.now() } });
            restart();
            vi.spyOn(streamrController, 'rekeyGrantsState').mockResolvedValue({ next: [false, false], old: [true, true] });
            const grants = vi.spyOn(streamrController, 'rekeyInteractionsGrants').mockResolvedValue(undefined);

            const rev = await epochKeyManager.rekeyInteractionsKey(channel);

            expect(rev).toBe(3);
            expect(grants.mock.calls[0][2]).toEqual([OLD_INT.address, PENDING_INT.address]);
        });

        it('refuses to reset over an unsettled key while the chain cannot be read', async () => {
            seed({ intKeyPending: { ...PENDING_INT, mintedAt: Date.now() } });
            restart();
            vi.spyOn(streamrController, 'rekeyGrantsState').mockRejectedValue(new Error('rpc down'));
            const grants = vi.spyOn(streamrController, 'rekeyInteractionsGrants');

            await expect(epochKeyManager.rekeyInteractionsKey(channel)).rejects.toThrow('chain cannot be read');

            expect(grants).not.toHaveBeenCalled();
            expect(record().intKeyPending.keyId).toBe(PENDING_INT.keyId);
        });

        it('recovers the publish key the same way', async () => {
            vi.spyOn(streamrController, 'rekeySharedPublishGrants').mockRejectedValue(new Error('receipt 503'));
            const read = vi.spyOn(streamrController, 'rekeyGrantsState').mockResolvedValue({ next: [true, true], old: [false, false] });

            const rev = await epochKeyManager.rekeyPublishKey(channel);

            expect(rev).toBe(2);
            expect(read.mock.calls[0][1]).toBe('pub');
            expect(state().pubKey.rev).toBe(2);
            expect(published[0]).not.toHaveProperty('k');
        });
    });

    describe('after a restart with a key pending', () => {
        it('promotes it when the chain holds its grant', async () => {
            seed({ intKeyPending: { ...PENDING_INT, mintedAt: Date.now() - 5 * HOUR } });
            const s = restart();
            vi.spyOn(streamrController, 'rekeyGrantsState').mockResolvedValue({ next: [true, true], old: [false, false] });

            await epochKeyManager._settleRekeys(channel, s);

            expect(s.intKey.keyId).toBe(PENDING_INT.keyId);
            expect(published).toEqual([expect.objectContaining({ k: 'i', keyId: PENDING_INT.keyId, rev: 2 })]);
            expect(record().intKeyPending).toBeUndefined();
            expect(warnings).toEqual([]);
        });

        it('keeps it while the grant may still land', async () => {
            seed({ intKeyPending: { ...PENDING_INT, mintedAt: Date.now() - HOUR / 2 } });
            const s = restart();
            vi.spyOn(streamrController, 'rekeyGrantsState').mockResolvedValue({ next: [false, false], old: [true, true] });

            await epochKeyManager._settleRekeys(channel, s);

            expect(s.intKey.keyId).toBe(OLD_INT.keyId);
            expect(record().intKeyPending.keyId).toBe(PENDING_INT.keyId);
            expect(warnings).toEqual([]);
        });

        it('drops it once the grant clearly never landed', async () => {
            seed({ intKeyPending: { ...PENDING_INT, mintedAt: Date.now() - 2 * HOUR } });
            const s = restart();
            vi.spyOn(streamrController, 'rekeyGrantsState').mockResolvedValue({ next: [false, false], old: [true, true] });

            await epochKeyManager._settleRekeys(channel, s);

            expect(s.intKey.keyId).toBe(OLD_INT.keyId);
            expect(record().intKeyPending).toBeUndefined();
            expect(published).toEqual([]);
        });

        it('keeps it and warns when the chain cannot be read', async () => {
            seed({ intKeyPending: { ...PENDING_INT, mintedAt: Date.now() - 2 * HOUR } });
            const s = restart();
            vi.spyOn(streamrController, 'rekeyGrantsState').mockRejectedValue(new Error('rpc down'));

            await epochKeyManager._settleRekeys(channel, s);

            expect(record().intKeyPending.keyId).toBe(PENDING_INT.keyId);
            expect(warnings).toEqual([UNSETTLED]);
        });

        it('keeps it and warns when neither key holds the grant', async () => {
            seed({ intKeyPending: { ...PENDING_INT, mintedAt: Date.now() - 2 * HOUR } });
            const s = restart();
            vi.spyOn(streamrController, 'rekeyGrantsState').mockResolvedValue({ next: [false, false], old: [false, false] });

            await epochKeyManager._settleRekeys(channel, s);

            expect(record().intKeyPending.keyId).toBe(PENDING_INT.keyId);
            expect(warnings).toEqual([UNSETTLED]);
        });

        it('adopts it without the chain when another device already announced it', async () => {
            seed({
                intKeyPending: { ...PENDING_INT, mintedAt: Date.now() },
                intAnnounce: announced(PENDING_INT)
            });
            const s = restart();
            const read = vi.spyOn(streamrController, 'rekeyGrantsState');

            await epochKeyManager._settleRekeys(channel, s);

            expect(read).not.toHaveBeenCalled();
            expect(s.intKey.keyId).toBe(PENDING_INT.keyId);
            expect(published).toEqual([]);
        });

        it('drops it without the chain when a later re-key superseded it', async () => {
            const later = { keyId: 'i3.x', address: '0x' + '66'.repeat(20), rev: 3 };
            seed({ intKeyPending: { ...PENDING_INT, mintedAt: Date.now() }, intAnnounce: announced(later) });
            const s = restart();
            const read = vi.spyOn(streamrController, 'rekeyGrantsState');

            await epochKeyManager._settleRekeys(channel, s);

            expect(read).not.toHaveBeenCalled();
            expect(record().intKeyPending).toBeUndefined();
        });

        it('settles it when the owner opens the channel', async () => {
            seed({
                epochs: { 'e1.k': { keyHex: '0x' + '77'.repeat(32), keyHash: '0xe', epoch: 1 } },
                announces: { 1: { keyId: 'e1.k', keyHash: '0xe', publisher: ADMIN, timestamp: Date.now(), validFrom: Date.now() } },
                currentEpoch: 1,
                intKeyPending: { ...PENDING_INT, mintedAt: Date.now() }
            });
            vi.spyOn(streamrController, 'resendKeysMessages').mockResolvedValue([]);
            vi.spyOn(epochKeyManager, '_maybeReannounceAging').mockResolvedValue(undefined);
            vi.spyOn(epochKeyManager, '_armScheduledRotation').mockImplementation(() => {});
            vi.spyOn(streamrController, 'rekeyGrantsState').mockResolvedValue({ next: [true, true], old: [false, false] });

            await epochKeyManager.ensureChannelKeys(channel);

            expect(state().intKey.keyId).toBe(PENDING_INT.keyId);
            expect(published.filter((m) => m.k === 'i')).toEqual([expect.objectContaining({ keyId: PENDING_INT.keyId, rev: 2 })]);
        });
    });

});

describe('reading a re-key off the chain', () => {
    it('asks for PUBLISH of both keys on each stream the shared key writes to', async () => {
        const hasPermission = vi.fn(async ({ streamId, userId }) =>
            userId === '0xnew' && streamId.endsWith('-5'));
        const previous = streamrController.client;
        streamrController.client = { hasPermission };
        try {
            const grants = await streamrController.rekeyGrantsState(channel, 'int', '0xNEW', '0xOLD');
            expect(grants).toEqual({ next: [true, false], old: [false, false] });
        } finally {
            streamrController.client = previous;
        }
        expect(hasPermission.mock.calls.map(([q]) => [q.streamId.slice(-2), q.userId, q.permission]))
            .toEqual([['-5', '0xnew', 'publish'], ['-5', '0xold', 'publish'],
                ['-2', '0xnew', 'publish'], ['-2', '0xold', 'publish']]);
    });
});
