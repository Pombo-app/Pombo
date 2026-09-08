/**
 * N-D gated-channel key policy:
 *
 *  - History scope in _answerRequest: EVERY gate mode (TOKEN/NFT/PAID/NONE)
 *    hands out every retained epoch — a paid subscription buys the past
 *    too. Only an unreadable gate fails closed to current-only.
 *  - rotateEpoch accepts any epoch-key channel — an earlier guard rejected
 *    gated channels, which silently disabled the post-ban rotation that cuts
 *    an ex-member's reads.
 *  - KEY_REQUEST authors are recorded as member candidates: holders and
 *    pay() members never pass through the owner, but every reader must
 *    request keys on -4 — the v0 enumeration source for TOKEN/NFT/PAID
 *    gates.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { gateManager, GATE_MODE } = await import('../../src/js/gate.js');
const { streamrController } = await import('../../src/js/streamr.js');
const { epochKeyCrypto } = await import('../../src/js/epochKeyCrypto.js');

const GATE = '0x' + 'ab'.repeat(20);
const REQUESTER = '0x' + '11'.repeat(20);

function seedState(streamId) {
    const s = epochKeyManager._getState(streamId);
    s.currentEpoch = 3;
    s.epochs = new Map([
        ['kid-1', { epoch: 1, keyHex: '11'.repeat(32) }],
        ['kid-2', { epoch: 2, keyHex: '22'.repeat(32) }],
        ['kid-3', { epoch: 3, keyHex: '33'.repeat(32) }]
    ]);
    return s;
}

describe('epochKeyManager._answerRequest (history scope)', () => {
    let published;

    beforeEach(() => {
        published = [];
        vi.spyOn(streamrController, 'publishKeysMessage')
            .mockImplementation(async (_sid, msg) => { published.push(msg); });
        vi.spyOn(epochKeyCrypto, 'computeWrapTag').mockResolvedValue('tag');
        vi.spyOn(epochKeyCrypto, 'wrapEpochKey').mockResolvedValue({ epk: 'e', iv: 'i', ct: 'c' });
        vi.spyOn(gateManager, 'checkAccessQuorum').mockResolvedValue({ access: true });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        epochKeyManager.state.clear();
    });

    const request = { requestId: 'req-1', pubkey: 'aa'.repeat(33), fromEpoch: 1, requester: REQUESTER };

    it('PAID gate: every retained epoch is wrapped (a subscription buys the past)', async () => {
        const streamId = '0xaaa/paid-answer';
        seedState(streamId);
        vi.spyOn(gateManager, 'getGateInfo').mockResolvedValue({ mode: GATE_MODE.PAID });

        const channel = { messageStreamId: streamId, keysStreamId: streamId + '-4', gate: { address: GATE } };
        await epochKeyManager._answerRequest(channel, request);

        expect(published.map(m => m.keyId).sort()).toEqual(['kid-1', 'kid-2', 'kid-3']);
    });

    it('TOKEN gate: every retained epoch is wrapped', async () => {
        const streamId = '0xaaa/token-answer';
        seedState(streamId);
        vi.spyOn(gateManager, 'getGateInfo').mockResolvedValue({ mode: GATE_MODE.TOKEN_BALANCE });

        const channel = { messageStreamId: streamId, keysStreamId: streamId + '-4', gate: { address: GATE } };
        await epochKeyManager._answerRequest(channel, request);

        expect(published.map(m => m.keyId).sort()).toEqual(['kid-1', 'kid-2', 'kid-3']);
    });

    it('unreadable gate config fails closed to current epoch only', async () => {
        const streamId = '0xaaa/failclosed-answer';
        seedState(streamId);
        vi.spyOn(gateManager, 'getGateInfo').mockRejectedValue(new Error('rpc down'));

        const channel = { messageStreamId: streamId, keysStreamId: streamId + '-4', gate: { address: GATE } };
        await epochKeyManager._answerRequest(channel, request);

        expect(published.map(m => m.keyId)).toEqual(['kid-3']);
    });

    it('channel without a gate is never answered (fail closed)', async () => {
        const streamId = '0xaaa/gateless-answer';
        seedState(streamId);
        const infoSpy = vi.spyOn(gateManager, 'getGateInfo');

        const channel = { messageStreamId: streamId, keysStreamId: streamId + '-4', type: 'gated' };
        await epochKeyManager._answerRequest(channel, request);

        expect(published).toEqual([]);
        expect(infoSpy).not.toHaveBeenCalled();
    });
});

describe('epochKeyManager.rotateEpoch (gated channels accepted)', () => {
    afterEach(() => epochKeyManager.state.clear());

    it('rejects channels without the epoch-key protocol', async () => {
        await expect(epochKeyManager.rotateEpoch({ type: 'public' }))
            .rejects.toThrow(/no epoch-key protocol/);
        await expect(epochKeyManager.rotateEpoch({ type: 'gated', keysStreamId: null }))
            .rejects.toThrow(/no epoch-key protocol/);
    });

    it('a gated channel passes the protocol guard (fails later on admin, not on type)', async () => {
        const channel = {
            messageStreamId: '0xaaa/gated-rotate',
            keysStreamId: '0xaaa/gated-rotate-4',
            type: 'gated',
            gate: { address: GATE }
        };
        await expect(epochKeyManager.rotateEpoch(channel))
            .rejects.toThrow(/only the channel admin/);
    });
});

describe('epochKeyManager seen requesters (N-D member candidates)', () => {
    afterEach(() => epochKeyManager.state.clear());

    it('records lowercase KEY_REQUEST authors, ignores junk', () => {
        const streamId = '0xaaa/seen-1';
        const s = epochKeyManager._getState(streamId);
        epochKeyManager._recordRequester(s, '0x' + 'AB'.repeat(20));
        epochKeyManager._recordRequester(s, 'not-an-address');
        epochKeyManager._recordRequester(s, null);
        expect(epochKeyManager.getSeenRequesters(streamId)).toEqual(['0x' + 'ab'.repeat(20)]);
    });

    it('is bounded at 500 addresses', () => {
        const streamId = '0xaaa/seen-2';
        const s = epochKeyManager._getState(streamId);
        for (let i = 0; i < 600; i++) {
            epochKeyManager._recordRequester(s, '0x' + String(i).padStart(40, '0'));
        }
        expect(epochKeyManager.getSeenRequesters(streamId).length).toBe(500);
    });

    it('returns [] for unknown channels', () => {
        expect(epochKeyManager.getSeenRequesters('0xaaa/none')).toEqual([]);
    });
});
