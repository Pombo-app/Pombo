/**
 * A held shared key whose rev no announce carries yet must be announced on the
 * next open, however fresh the announce of the older rev is.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { streamrController } = await import('../../src/js/streamr.js');
const { authManager } = await import('../../src/js/auth.js');

const ADMIN = '0x' + 'aa'.repeat(20);
const STREAM = `${ADMIN}/sealed-1`;
const channel = {
    messageStreamId: STREAM, keysStreamId: `${ADMIN}/sealed-4`,
    ephemeralStreamId: `${ADMIN}/sealed-2`, interactionsStreamId: `${ADMIN}/sealed-5`,
    type: 'gated', gate: { address: '0x' + 'ab'.repeat(20) }, wireIdentity: 'sealed'
};
const key = (prefix, rev, byte) => ({
    keyId: `${prefix}${rev}.k`, keyHex: '0x' + byte.repeat(32), address: '0x' + byte.repeat(20), rev
});
const announced = (k) => ({ keyId: k.keyId, keyHash: '0xh', address: k.address, rev: k.rev, publisher: ADMIN, timestamp: Date.now() });

describe('the shared-key announce self-heal', () => {
    let published;
    let s;

    beforeEach(() => {
        epochKeyManager.state.clear();
        published = [];
        vi.spyOn(authManager, 'getAddress').mockReturnValue(ADMIN);
        vi.spyOn(epochKeyManager, '_persist').mockResolvedValue(undefined);
        vi.spyOn(epochKeyManager, '_ensureAnnounceRetained').mockResolvedValue(undefined);
        vi.spyOn(streamrController, 'publishKeysMessage').mockImplementation(async (_, msg) => {
            published.push(msg);
        });
        s = epochKeyManager._getState(STREAM);
        s.loaded = true;
        s.intAnnounce = announced(key('i', 1, '33'));
        s.pubAnnounce = announced(key('p', 1, '44'));
        s.intAnnounceFreshness = Date.now();
        s.pubAnnounceFreshness = Date.now();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        epochKeyManager.state.clear();
    });

    it('announces an interactions key above the announced rev', async () => {
        s.intKey = key('i', 2, '55');

        await epochKeyManager._maybeAnnounceInteractions(channel, s);

        expect(published).toEqual([expect.objectContaining({ k: 'i', keyId: 'i2.k', rev: 2 })]);
    });

    it('announces a publish key above the announced rev', async () => {
        s.pubKey = key('p', 2, '88');

        await epochKeyManager._maybeAnnouncePub(channel, s);

        expect(published).toEqual([expect.objectContaining({ keyId: 'p2.k', rev: 2 })]);
    });

    it('stays quiet while the held key is the one freshly announced', async () => {
        s.intKey = key('i', 1, '33');
        s.pubKey = key('p', 1, '44');

        await epochKeyManager._maybeAnnounceInteractions(channel, s);
        await epochKeyManager._maybeAnnouncePub(channel, s);

        expect(published).toEqual([]);
    });
});
