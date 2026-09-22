/**
 * An admin that mints or rotates seals the new epoch key to its own account
 * on -4/P1, so any later session of that account adopts it from storage
 * without a request and without a responder. Rotation first reads the
 * announces storage holds, so a second admin device numbers above them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { epochKeyCrypto } = await import('../../src/js/epochKeyCrypto.js');
const { streamrController } = await import('../../src/js/streamr.js');
const { authManager } = await import('../../src/js/auth.js');
const { KEYS_STREAM } = await import('../../src/js/streamConstants.js');

const VEC = {
    accountPriv: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    spk: '0x02ba5734d8f7091719471e7f7ed6b9df170dc70cc661ca05e688601ad984f068b0',
    epochKey: '0x4242424242424242424242424242424242424242424242424242424242424242',
    keyId: '3.deadbeef42'
};
const ACCOUNT = ethers.computeAddress(VEC.spk).toLowerCase();
const GATE = '0x' + 'ab'.repeat(20);
const STREAM = `${ACCOUNT}/self-wrap-1`;
const channel = {
    messageStreamId: STREAM,
    keysStreamId: STREAM.replace(/-1$/, '-4'),
    type: 'gated',
    gate: { address: GATE },
    members: [],
    createdAt: Date.now() - 7 * 24 * 3600 * 1000
};

describe('epoch keys sealed to the admin\'s own account', () => {
    let published;
    let stored;   // partition → entries storage serves

    beforeEach(() => {
        published = [];
        stored = new Map();
        epochKeyManager.state.clear();
        authManager.wallet = { privateKey: VEC.accountPriv };
        vi.spyOn(authManager, 'getAddress').mockReturnValue(ACCOUNT);
        vi.spyOn(streamrController, 'publishKeysMessage')
            .mockImplementation(async (_sid, msg) => { published.push(msg); });
        vi.spyOn(streamrController, 'resendKeysMessages')
            .mockImplementation(async (_sid, { partition }) => stored.get(partition) || []);
        vi.spyOn(streamrController, 'getStreamPartitionCount').mockResolvedValue(1);
        vi.spyOn(epochKeyManager, '_persist').mockResolvedValue(undefined);
        vi.spyOn(epochKeyManager, '_loadPersisted').mockImplementation(() => {});
        vi.spyOn(epochKeyManager, '_ensureAnnounceRetained').mockResolvedValue(undefined);
        vi.spyOn(epochKeyManager, '_maybePublishHello').mockResolvedValue(undefined);
        vi.spyOn(epochKeyManager, '_armScheduledRotation').mockImplementation(() => {});
        vi.spyOn(epochKeyManager, '_maybeReannounceAging').mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        epochKeyManager.state.clear();
        epochKeyManager.onKeysAdopted = null;
        authManager.wallet = null;
    });

    const announces = () => published.filter((m) => m.t === 'key_announce');
    const selfWraps = () => published.filter((m) => m.t === 'key_wrap' && m.requestId === 'self');

    function seedEpoch(epoch = 1) {
        const s = epochKeyManager._getState(STREAM);
        s.loaded = true;
        s.currentEpoch = epoch;
        s.epochs = new Map([[`${epoch}.seed`, { epoch, keyHex: '0x' + '11'.repeat(32), keyHash: '0xseed' }]]);
        s.announces = new Map([[epoch, { keyId: `${epoch}.seed`, keyHash: '0xseed', validFrom: 1 }]]);
        return s;
    }

    it('rotation seals the new key to the account, and the account key opens it', async () => {
        const s = seedEpoch(1);

        const epoch = await epochKeyManager.rotateEpoch(channel);

        expect(epoch).toBe(2);
        expect(announces()).toHaveLength(1);
        expect(selfWraps()).toHaveLength(1);
        const wrap = selfWraps()[0];
        expect(wrap).toMatchObject({ v: 2, requestId: 'self', keyId: announces()[0].keyId, epoch: 2 });
        expect(wrap.tag).toBe(await epochKeyCrypto.computeWrapTagV2('self', wrap.keyId));
        const opened = await epochKeyCrypto.unwrapEpochKeyStatic(
            { epk: wrap.epk, iv: wrap.iv, ct: wrap.ct }, VEC.accountPriv);
        expect(opened).toBe(s.epochs.get(wrap.keyId).keyHex);
    });

    it('rotation numbers above an announce that only storage holds', async () => {
        seedEpoch(1);
        stored.set(KEYS_STREAM.KEY_EXCHANGE, [{
            data: { t: 'key_announce', epoch: 5, keyId: '5.elsewhere', keyHash: '0x' + 'ab'.repeat(32), validFrom: 2 },
            publisherId: ACCOUNT,
            timestamp: 2
        }]);

        const epoch = await epochKeyManager.rotateEpoch(channel);

        expect(epoch).toBe(6);
        expect(announces()[0].epoch).toBe(6);
    });

    it('a fresh admin session adopts the stored self wrap without asking anyone', async () => {
        const keyHash = (await epochKeyCrypto.computeKeyHash(VEC.epochKey)).toLowerCase();
        stored.set(KEYS_STREAM.KEY_EXCHANGE, [{
            data: { t: 'key_announce', epoch: 3, keyId: VEC.keyId, keyHash, validFrom: 3 },
            publisherId: ACCOUNT,
            timestamp: 3
        }]);
        stored.set(KEYS_STREAM.REQUESTS, [{
            data: {
                t: 'key_wrap', v: 2, requestId: 'self', keyId: VEC.keyId, epoch: 3,
                tag: await epochKeyCrypto.computeWrapTagV2('self', VEC.keyId),
                ...await epochKeyCrypto.wrapEpochKeyToStatic(VEC.epochKey, VEC.spk)
            },
            publisherId: ACCOUNT,
            timestamp: 4
        }]);

        await epochKeyManager.ensureChannelKeys(channel);

        const s = epochKeyManager._getState(STREAM);
        expect(s.epochs.get(VEC.keyId)?.keyHex).toBe(VEC.epochKey);
        expect(s.currentEpoch).toBe(3);
        expect(published.filter((m) => m.t === 'key_request')).toHaveLength(0);
    });

    it('a member ignores an admin\'s self wrap', async () => {
        vi.spyOn(epochKeyManager, 'isOwnAdmin').mockReturnValue(false);
        const s = epochKeyManager._getState(STREAM);
        const keyHash = (await epochKeyCrypto.computeKeyHash(VEC.epochKey)).toLowerCase();
        s.announces = new Map([[3, { keyId: VEC.keyId, keyHash, validFrom: 3 }]]);
        s.currentEpoch = 3;

        await epochKeyManager._handleWrapV2(channel, s, {
            t: 'key_wrap', v: 2, requestId: 'self', keyId: VEC.keyId, epoch: 3,
            tag: await epochKeyCrypto.computeWrapTagV2('self', VEC.keyId),
            ...await epochKeyCrypto.wrapEpochKeyToStatic(VEC.epochKey, VEC.spk)
        });

        expect(s.epochs.has(VEC.keyId)).toBe(false);
    });

    it('tells the app when a key was adopted, so the other devices get synced', async () => {
        seedEpoch(1);
        const adopted = [];
        epochKeyManager.onKeysAdopted = (streamId, keyId) => adopted.push({ streamId, keyId });

        await epochKeyManager.rotateEpoch(channel);

        expect(adopted).toHaveLength(1);
        expect(adopted[0]).toEqual({ streamId: STREAM, keyId: announces()[0].keyId });
    });
});
