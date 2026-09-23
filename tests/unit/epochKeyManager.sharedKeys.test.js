/**
 * Who receives each shared key of a Sealed channel. In a read-only channel the
 * publish key IS the write capability, so only the owner and the moderators
 * get it; the interactions key goes to every member, because reacting and
 * showing presence is all the participation a read-only member has.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { gateManager } = await import('../../src/js/gate.js');
const { streamrController } = await import('../../src/js/streamr.js');
const { epochKeyCrypto } = await import('../../src/js/epochKeyCrypto.js');

const ADMIN = '0x' + 'aa'.repeat(20);
const GATE = '0x' + 'ab'.repeat(20);
const REQUESTER = '0x' + '11'.repeat(20);
const STREAM = `${ADMIN}/sealed-1`;
const channel = {
    messageStreamId: STREAM, keysStreamId: `${ADMIN}/sealed-4`,
    gate: { address: GATE }, wireIdentity: 'sealed'
};

describe('shared keys in a Sealed channel', () => {
    let published;

    beforeEach(() => {
        epochKeyManager.state.clear();
        published = [];
        vi.spyOn(streamrController, 'publishKeysMessage').mockImplementation(async (_, msg) => { published.push(msg); });
        vi.spyOn(epochKeyCrypto, 'computeWrapTag').mockResolvedValue('tag');
        vi.spyOn(epochKeyCrypto, 'wrapEpochKey').mockResolvedValue({ epk: 'e', iv: 'i', ct: 'c' });
        vi.spyOn(gateManager, 'checkAccessQuorum').mockResolvedValue({ access: true });
        const s = epochKeyManager._getState(STREAM);
        s.currentEpoch = 1;
        s.epochs = new Map([['1.k', { epoch: 1, keyHex: '11'.repeat(32) }]]);
        s.pubKey = { keyId: 'p1.k', keyHex: '22'.repeat(32), address: '0x' + '22'.repeat(20), rev: 1 };
        s.pubAnnounce = { keyId: 'p1.k', keyHash: '0xp', address: s.pubKey.address, rev: 1 };
        s.intKey = { keyId: 'i1.k', keyHex: '33'.repeat(32), address: '0x' + '33'.repeat(20), rev: 1 };
        s.intAnnounce = { keyId: 'i1.k', keyHash: '0xi', address: s.intKey.address, rev: 1 };
    });

    afterEach(() => {
        vi.restoreAllMocks();
        epochKeyManager.state.clear();
    });

    const request = { requestId: 'req-1', pubkey: 'aa'.repeat(33), fromEpoch: 1, requester: REQUESTER };
    const sharedKeysSent = () => published
        .filter((m) => m.t === 'pub_wrap')
        .map((m) => (m.k === 'i' ? 'interactions' : 'publish'))
        .sort();

    it('gives a moderator of a read-only channel both keys', async () => {
        vi.spyOn(gateManager, 'getGateInfo').mockResolvedValue({ readOnly: true });
        vi.spyOn(gateManager, 'canModerate').mockResolvedValue(true);

        await epochKeyManager._answerRequest(channel, request);

        expect(gateManager.canModerate).toHaveBeenCalledWith(GATE, REQUESTER);
        expect(sharedKeysSent()).toEqual(['interactions', 'publish']);
    });

    it('gives a plain member of a read-only channel the interactions key only', async () => {
        vi.spyOn(gateManager, 'getGateInfo').mockResolvedValue({ readOnly: true });
        vi.spyOn(gateManager, 'canModerate').mockResolvedValue(false);

        await epochKeyManager._answerRequest(channel, request);

        expect(sharedKeysSent()).toEqual(['interactions']);
        expect(published.some((m) => m.t === 'key_wrap')).toBe(true);
    });

    it('withholds the publish key when the gate cannot be read, and still hands out the interactions key', async () => {
        vi.spyOn(gateManager, 'getGateInfo').mockRejectedValue(new Error('rpc down'));
        vi.spyOn(gateManager, 'canModerate').mockResolvedValue(true);

        await epochKeyManager._answerRequest(channel, request);

        expect(sharedKeysSent()).toEqual(['interactions']);
    });

    it('gives every member both keys when the channel is not read-only', async () => {
        vi.spyOn(gateManager, 'getGateInfo').mockResolvedValue({ readOnly: false });
        vi.spyOn(gateManager, 'canModerate').mockResolvedValue(false);

        await epochKeyManager._answerRequest(channel, request);

        expect(sharedKeysSent()).toEqual(['interactions', 'publish']);
    });

    describe('who may hold the publish key of a read-only channel', () => {
        it('the owner, without asking for the moderator flag', async () => {
            vi.spyOn(gateManager, 'getGateInfo').mockResolvedValue({ owner: REQUESTER });
            const isModerator = vi.spyOn(gateManager, '_isModerator').mockResolvedValue(false);

            expect(await gateManager.canModerate(GATE, REQUESTER)).toBe(true);
            expect(isModerator).not.toHaveBeenCalled();
        });

        it('a moderator', async () => {
            vi.spyOn(gateManager, 'getGateInfo').mockResolvedValue({ owner: ADMIN });
            vi.spyOn(gateManager, '_isModerator').mockResolvedValue(true);

            expect(await gateManager.canModerate(GATE, REQUESTER)).toBe(true);
        });

        it('not a plain member', async () => {
            vi.spyOn(gateManager, 'getGateInfo').mockResolvedValue({ owner: ADMIN });
            vi.spyOn(gateManager, '_isModerator').mockResolvedValue(false);

            expect(await gateManager.canModerate(GATE, REQUESTER)).toBe(false);
        });
    });

    describe('a member missing only the interactions key', () => {
        beforeEach(() => {
            vi.spyOn(epochKeyManager, '_persist').mockResolvedValue(undefined);
            const s = epochKeyManager.state.get(STREAM);
            s.announces = new Map([[1, { keyId: '1.k' }]]);
            s.intKey = null;
        });

        it('asks for it', async () => {
            await epochKeyManager._sendKeyRequest(channel, epochKeyManager.state.get(STREAM));

            expect(published.some((m) => m.t === 'key_request')).toBe(true);
        });

        it('keeps asking while it waits', async () => {
            expect(await epochKeyManager.retryRequestIfWaiting(channel)).toBe(true);
            expect(published.some((m) => m.t === 'key_request')).toBe(true);
        });
    });

    it('hands out no shared key on a record that does not say Sealed', async () => {
        vi.spyOn(gateManager, 'getGateInfo').mockResolvedValue({ readOnly: false });

        await epochKeyManager._answerRequest({ ...channel, wireIdentity: null }, request);

        expect(sharedKeysSent()).toEqual([]);
        expect(published.some((m) => m.t === 'key_wrap')).toBe(true);
    });
});
