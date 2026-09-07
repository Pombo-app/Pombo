/**
 * Keys-stream protocol v2: asynchronous wraps and the -4/P1 roster.
 *
 *  - KEY_WRAP v2: ECIES to the requester's STATIC account pubkey (`spk`
 *    carried inside the signed KEY_REQUEST), tag derived from the random
 *    requestId — never from the static key. Cross-client parity locked by
 *    fixed vectors (docs/GATED-CHANNELS-wrap-v2-vectors.json).
 *  - Responders answer v2 only when computeAddress(spk) matches the request's
 *    envelope signer; a forged or malformed spk downgrades to v1.
 *  - Wrap adoption matches persisted request ids and opens with the wallet
 *    key, so a wrap published days later (or for another device's request)
 *    still adopts.
 *  - MEMBER_HELLO: sealed with the epoch key, published once per epoch on
 *    P1; the roster reader trusts only hellos whose envelope signer equals
 *    the declared account.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { epochKeyCrypto } = await import('../../src/js/epochKeyCrypto.js');
const { streamrController } = await import('../../src/js/streamr.js');
const { gateManager } = await import('../../src/js/gate.js');
const { authManager } = await import('../../src/js/auth.js');
const { secureStorage } = await import('../../src/js/secureStorage.js');
const { KEYS_STREAM } = await import('../../src/js/streamConstants.js');

// Fixed parity vectors — the same values live in the Android EpochKeyCryptoTest.
const VEC = {
    accountPriv: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    spk: '0x02ba5734d8f7091719471e7f7ed6b9df170dc70cc661ca05e688601ad984f068b0',
    epochKey: '0x4242424242424242424242424242424242424242424242424242424242424242',
    requestId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    keyId: '3.deadbeef42',
    tag: '0xcdad7dad64d437644100796b2ed9b1fad92440e6a1d2a78b1f45b0eb5e3f1444',
    wrapped: {
        epk: '0x02824398a01a2ecd3553aa833574b540fd7cbead68c1c25b0f47cde96f3322ddc2',
        iv: 'AQIDBAUGBwgJCgsM',
        ct: 'EFk19R38/LdMzrfLDAdTnwmf03rAFhns0Ya9XUn26EsgGjhYyzPGniq3WwzP0JxX'
    }
};
const ACCOUNT = ethers.computeAddress(VEC.spk).toLowerCase();
const GATE = '0x' + 'ab'.repeat(20);
const STREAM = '0xaaa/async-wraps-1';

function channelFor(streamId) {
    return {
        messageStreamId: streamId,
        keysStreamId: streamId.replace(/-1$/, '-4'),
        type: 'gated',
        gate: { address: GATE }
    };
}

describe('epochKeyCrypto wrap v2 (parity vectors)', () => {
    it('computeWrapTagV2 matches the fixed vector', async () => {
        expect(await epochKeyCrypto.computeWrapTagV2(VEC.requestId, VEC.keyId)).toBe(VEC.tag);
    });

    it('unwrapEpochKeyStatic opens the fixed vector with the account key', async () => {
        expect(await epochKeyCrypto.unwrapEpochKeyStatic(VEC.wrapped, VEC.accountPriv))
            .toBe(VEC.epochKey);
    });

    it('wrapEpochKeyToStatic round-trips', async () => {
        const wrapped = await epochKeyCrypto.wrapEpochKeyToStatic(VEC.epochKey, VEC.spk);
        expect(await epochKeyCrypto.unwrapEpochKeyStatic(wrapped, VEC.accountPriv))
            .toBe(VEC.epochKey);
    });

    it('v1 and v2 wraps are domain-separated (v1 wrap never opens as v2)', async () => {
        const v1 = await epochKeyCrypto.wrapEpochKey(VEC.epochKey, VEC.spk);
        await expect(epochKeyCrypto.unwrapEpochKeyStatic(v1, VEC.accountPriv))
            .rejects.toThrow();
    });
});

describe('epochKeyManager v2 answers and adoption', () => {
    let published;

    beforeEach(() => {
        published = [];
        vi.spyOn(streamrController, 'publishKeysMessage')
            .mockImplementation(async (_sid, msg, partition) => { published.push({ msg, partition }); });
        vi.spyOn(gateManager, 'checkAccessQuorum').mockResolvedValue({ access: true });
        vi.spyOn(gateManager, 'getGateInfo').mockResolvedValue({ mode: 1 });
        vi.spyOn(secureStorage, 'setEpochKeys').mockResolvedValue();
        vi.spyOn(streamrController, 'getStreamPartitionCount').mockResolvedValue(1);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        epochKeyManager.state.clear();
        authManager.wallet = null;
    });

    function seedState(streamId) {
        const s = epochKeyManager._getState(streamId);
        s.currentEpoch = 1;
        s.epochs = new Map([['kid-1', { epoch: 1, keyHex: '0x' + '11'.repeat(32) }]]);
        s.announces = new Map([[1, { keyId: 'kid-1', keyHash: '0xhash', validFrom: 1 }]]);
        return s;
    }

    it('answers v2 when spk matches the requester', async () => {
        seedState(STREAM);
        await epochKeyManager._answerRequest(channelFor(STREAM), {
            requestId: VEC.requestId, pubkey: '0x02' + 'aa'.repeat(32), fromEpoch: 1,
            spk: VEC.spk, requester: ACCOUNT
        });
        expect(published).toHaveLength(1);
        expect(published[0].msg.v).toBe(2);
        expect(published[0].msg.tag)
            .toBe(await epochKeyCrypto.computeWrapTagV2(VEC.requestId, 'kid-1'));
    });

    it('downgrades to v1 when spk does not belong to the requester', async () => {
        seedState(STREAM);
        await epochKeyManager._answerRequest(channelFor(STREAM), {
            requestId: 'req-x', pubkey: VEC.spk, fromEpoch: 1,
            spk: VEC.spk, requester: '0x' + '99'.repeat(20)
        });
        expect(published).toHaveLength(1);
        expect(published[0].msg.v).toBeUndefined();
    });

    it('adopts a v2 wrap matched by a persisted request id, using the wallet key', async () => {
        const s = epochKeyManager._getState(STREAM);
        const keyHash = await epochKeyCrypto.computeKeyHash(VEC.epochKey);
        s.announces = new Map([[3, { keyId: VEC.keyId, keyHash: keyHash.toLowerCase(), validFrom: 1 }]]);
        s.currentEpoch = 3;
        s.pendingRequests.set(VEC.requestId, { fromEpoch: 1, sentAt: Date.now() });
        authManager.wallet = { privateKey: VEC.accountPriv };

        await epochKeyManager._handleWrapV2(channelFor(STREAM), s, {
            v: 2, requestId: VEC.requestId, keyId: VEC.keyId, epoch: 3,
            tag: VEC.tag, ...VEC.wrapped
        });

        expect(s.epochs.get(VEC.keyId)?.keyHex).toBe(VEC.epochKey);
        // Nothing missing any more — retained request ids are cleared
        expect(s.pendingRequests.size).toBe(0);
    });

    it('ignores a v2 wrap whose request id is not ours', async () => {
        const s = epochKeyManager._getState(STREAM);
        const keyHash = await epochKeyCrypto.computeKeyHash(VEC.epochKey);
        s.announces = new Map([[3, { keyId: VEC.keyId, keyHash: keyHash.toLowerCase(), validFrom: 1 }]]);
        authManager.wallet = { privateKey: VEC.accountPriv };

        await epochKeyManager._handleWrapV2(channelFor(STREAM), s, {
            v: 2, requestId: 'not-ours', keyId: VEC.keyId, epoch: 3,
            tag: await epochKeyCrypto.computeWrapTagV2('not-ours', VEC.keyId), ...VEC.wrapped
        });
        expect(s.epochs.has(VEC.keyId)).toBe(false);
    });

    it('KEY_REQUEST carries spk and persists the request id', async () => {
        const s = epochKeyManager._getState(STREAM);
        s.announces = new Map([[1, { keyId: 'kid-1', keyHash: '0xhash', validFrom: 1 }]]);
        s.currentEpoch = 1;
        authManager.wallet = { privateKey: VEC.accountPriv };

        await epochKeyManager._sendKeyRequest(channelFor(STREAM), s);

        expect(published).toHaveLength(1);
        expect(published[0].msg.spk).toBe(VEC.spk);
        expect(s.pendingRequests.has(published[0].msg.requestId)).toBe(true);
    });
});

describe('epochKeyManager roster (-4/P1)', () => {
    beforeEach(() => {
        vi.spyOn(secureStorage, 'setEpochKeys').mockResolvedValue();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        epochKeyManager.state.clear();
        authManager.wallet = null;
    });

    async function seedWithKey(streamId) {
        const s = epochKeyManager._getState(streamId);
        s.currentEpoch = 1;
        s.epochs = new Map([['kid-1', { epoch: 1, keyHex: VEC.epochKey, cryptoKey: null }]]);
        s.announces = new Map([[1, { keyId: 'kid-1', keyHash: '0xhash', validFrom: 1 }]]);
        return s;
    }

    it('publishes one sealed hello per epoch on P1 when the -4 has the partition', async () => {
        const published = [];
        vi.spyOn(streamrController, 'publishKeysMessage')
            .mockImplementation(async (_sid, msg, partition) => { published.push({ msg, partition }); });
        vi.spyOn(streamrController, 'getStreamPartitionCount').mockResolvedValue(2);
        vi.spyOn(authManager, 'getAddress').mockReturnValue(ACCOUNT);
        authManager.wallet = { privateKey: VEC.accountPriv };

        const s = await seedWithKey(STREAM);
        await epochKeyManager._maybePublishHello(channelFor(STREAM), s, 'kid-1', 1);
        await epochKeyManager._maybePublishHello(channelFor(STREAM), s, 'kid-1', 1);

        expect(published).toHaveLength(1);
        expect(published[0].partition).toBe(KEYS_STREAM.ROSTER);
        expect(published[0].msg.e).toBe('epoch-aes-gcm');
        expect(published[0].msg.k).toBe('kid-1');
        expect(s.helloEpochs.has(1)).toBe(true);
    });

    it('never publishes a hello on a single-partition -4 (pre-roster channel)', async () => {
        const published = [];
        vi.spyOn(streamrController, 'publishKeysMessage')
            .mockImplementation(async (_sid, msg, partition) => { published.push({ msg, partition }); });
        vi.spyOn(streamrController, 'getStreamPartitionCount').mockResolvedValue(1);
        vi.spyOn(authManager, 'getAddress').mockReturnValue(ACCOUNT);

        const s = await seedWithKey(STREAM);
        await epochKeyManager._maybePublishHello(channelFor(STREAM), s, 'kid-1', 1);
        expect(published).toHaveLength(0);
    });

    it('getRosterMembers returns hellos whose envelope signer matches the account, deduped', async () => {
        const s = await seedWithKey(STREAM);
        s.rosterPartition = 1;
        const key = await epochKeyCrypto.importEpochKey(VEC.epochKey);
        const sealedHello = async (account, ts) => {
            const sealed = await epochKeyCrypto.encryptWithEpochKey(
                { t: 'member_hello', account, ts }, key);
            return { e: 'epoch-aes-gcm', k: 'kid-1', ct: sealed.ct, iv: sealed.iv };
        };
        const other = '0x' + '55'.repeat(20);
        vi.spyOn(streamrController, 'resendKeysMessages').mockResolvedValue([
            { data: await sealedHello(ACCOUNT, 100), publisherId: ACCOUNT, timestamp: 100 },
            { data: await sealedHello(ACCOUNT, 200), publisherId: ACCOUNT, timestamp: 200 },
            // Planted hello: declared account differs from the envelope signer
            { data: await sealedHello(other, 300), publisherId: ACCOUNT, timestamp: 300 }
        ]);

        const members = await epochKeyManager.getRosterMembers(channelFor(STREAM));
        expect(members).toHaveLength(1);
        expect(members[0].account).toBe(ACCOUNT);
        expect(members[0].ts).toBe(200);
    });
});
