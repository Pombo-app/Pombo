/**
 * A storage provider added to a channel holds nothing published before it was
 * assigned. The admin publishes the -4 anchors again: every epoch's announce
 * with the validFrom it was made with, the shared keys' announces, and a self
 * wrap per held key.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { streamrController } = await import('../../src/js/streamr.js');
const { authManager } = await import('../../src/js/auth.js');
const { KEYS_STREAM } = await import('../../src/js/streamConstants.js');

const PRIV = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ACCOUNT = new ethers.Wallet(PRIV).address.toLowerCase();
const STREAM = `${ACCOUNT}/anchors-1`;
const channel = {
    messageStreamId: STREAM,
    keysStreamId: STREAM.replace(/-1$/, '-4'),
    type: 'gated',
    gate: { address: '0x' + 'ab'.repeat(20) },
    members: []
};

describe('epochKeyManager.republishAnchors()', () => {
    let published;

    beforeEach(() => {
        published = [];
        epochKeyManager.state.clear();
        authManager.wallet = { privateKey: PRIV };
        vi.spyOn(authManager, 'getAddress').mockReturnValue(ACCOUNT);
        vi.spyOn(streamrController, 'publishKeysMessage').mockImplementation(async (_sid, msg) => {
            published.push(msg);
            return { timestamp: 5000 + published.length };
        });
        vi.spyOn(epochKeyManager, '_loadPersisted').mockImplementation(() => {});
        const s = epochKeyManager._getState(STREAM);
        s.loaded = true;
        s.currentEpoch = 3;
        s.announces = new Map([
            [3, { keyId: '3.c', keyHash: '0xh3', validFrom: 300 }],
            [1, { keyId: '1.a', keyHash: '0xh1', validFrom: 100 }]
        ]);
        s.epochs = new Map([['3.c', { epoch: 3, keyHex: '0x' + '33'.repeat(32), keyHash: '0xh3' }]]);
        s.pubAnnounce = { keyId: 'p2.x', keyHash: '0xpk', address: '0x' + '0c'.repeat(20), rev: 2 };
        s.intAnnounce = { keyId: 'i1.y', keyHash: '0xik', address: '0x' + '0d'.repeat(20), rev: 1 };
    });

    afterEach(() => {
        vi.restoreAllMocks();
        epochKeyManager.state.clear();
        authManager.wallet = null;
    });

    it('publishes every epoch\'s announce in order, each with its own validFrom', async () => {
        await epochKeyManager.republishAnchors(channel);

        const announces = published.filter((m) => m.t === 'key_announce');
        expect(announces).toEqual([
            { t: 'key_announce', epoch: 1, keyId: '1.a', keyHash: '0xh1', validFrom: 100 },
            { t: 'key_announce', epoch: 3, keyId: '3.c', keyHash: '0xh3', validFrom: 300 }
        ]);
    });

    it('publishes the publish and interactions key announces as they were announced', async () => {
        await epochKeyManager.republishAnchors(channel);

        const pubs = published.filter((m) => m.t === 'pub_announce');
        expect(pubs).toEqual([
            { t: 'pub_announce', keyId: 'p2.x', keyHash: '0xpk', addr: '0x' + '0c'.repeat(20), rev: 2 },
            { t: 'pub_announce', k: 'i', keyId: 'i1.y', keyHash: '0xik', addr: '0x' + '0d'.repeat(20), rev: 1 }
        ]);
    });

    it('seals every held key to the account again', async () => {
        await epochKeyManager.republishAnchors(channel);

        const wraps = published.filter((m) => m.t === 'key_wrap');
        expect(wraps).toHaveLength(1);
        expect(wraps[0]).toMatchObject({ v: 2, requestId: 'self', keyId: '3.c', epoch: 3 });
    });

    it('returns where each announce landed, for the caller to look up', async () => {
        const refs = await epochKeyManager.republishAnchors(channel);

        expect(refs).toEqual([5001, 5002, 5003, 5004].map((timestamp) => ({
            partition: KEYS_STREAM.KEY_EXCHANGE, timestamp, sequenceNumber: 0
        })));
    });

    it('publishes nothing for a member', async () => {
        vi.spyOn(epochKeyManager, 'isOwnAdmin').mockReturnValue(false);

        expect(await epochKeyManager.republishAnchors(channel)).toEqual([]);
        expect(published).toEqual([]);
    });
});
