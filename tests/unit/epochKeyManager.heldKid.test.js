/**
 * A key on disk is a key held, even before anything opened its channel.
 * The background poll reads a channel's history before any open does; a kid
 * that looked missing then made the key responder ask for keys the device
 * holds, on every sweep, for the rest of the session.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { epochKeyCrypto } = await import('../../src/js/epochKeyCrypto.js');
const { streamrController } = await import('../../src/js/streamr.js');
const { secureStorage } = await import('../../src/js/secureStorage.js');

const OWNER = '0x' + 'ab'.repeat(20);
const STREAM = `${OWNER}/heldkid-1`;
const KID = '1.aaaaaaaaaaaa';
const KEY_HEX = '0x' + '11'.repeat(32);
const channel = {
    messageStreamId: STREAM,
    keysStreamId: STREAM.replace('-1', '-4'),
    type: 'gated',
    gate: { address: '0x' + 'cd'.repeat(20) },
    members: [],
    createdBy: OWNER,
    createdAt: Date.now()
};

describe('a kid whose key is on disk', () => {
    let published;

    beforeEach(() => {
        published = [];
        epochKeyManager.state.delete(STREAM);
        vi.spyOn(secureStorage, 'getEpochKeys').mockImplementation((id) => (id === STREAM ? {
            epochs: { [KID]: { keyHex: KEY_HEX, keyHash: 'hash-1', epoch: 1 } },
            announces: { 1: { keyId: KID, keyHash: 'hash-1', publisher: OWNER, timestamp: 1, validFrom: 1 } },
            currentEpoch: 1
        } : null));
        vi.spyOn(streamrController, 'publishKeysMessage')
            .mockImplementation(async (_sid, msg) => { published.push(msg); });
        vi.spyOn(streamrController, 'resendKeysMessages').mockResolvedValue([]);
        vi.spyOn(epochKeyManager, '_persist').mockResolvedValue(undefined);
        vi.spyOn(epochKeyManager, 'isOwnAdmin').mockReturnValue(false);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        epochKeyManager.state.delete(STREAM);
    });

    const requests = () => published.filter((m) => m.t === 'key_request');

    it('opens a message read before the channel was loaded, and asks for nothing', async () => {
        const sealed = await epochKeyCrypto.encryptWithEpochKey(
            { text: 'hello' }, await epochKeyCrypto.importEpochKey(KEY_HEX));
        const noted = vi.spyOn(epochKeyManager, 'noteMissingKid');

        const plain = await streamrController.openEpochEnvelope(
            STREAM, { e: 'epoch-aes-gcm', k: KID, ...sealed }, { live: true });
        await epochKeyManager.ensureChannelKeys(channel);

        expect(plain.text).toBe('hello');
        expect(noted).not.toHaveBeenCalled();
        expect(requests()).toHaveLength(0);
    });

    it('stops asking for a kid noted missing once its key is held', async () => {
        const s = epochKeyManager._getState(STREAM);
        s.missingKids = new Set([KID]);

        await epochKeyManager.ensureChannelKeys(channel);

        expect(requests()).toHaveLength(0);
        expect(s.missingKids.size).toBe(0);
    });

    it('still asks for a kid no held key opens', async () => {
        const s = epochKeyManager._getState(STREAM);
        s.missingKids = new Set([KID, '2.bbbbbbbbbbbb']);

        await epochKeyManager.ensureChannelKeys(channel);

        expect(requests()).toHaveLength(1);
        expect(requests()[0].fromEpoch).toBe(2);
        expect([...s.missingKids]).toEqual(['2.bbbbbbbbbbbb']);
    });
});
