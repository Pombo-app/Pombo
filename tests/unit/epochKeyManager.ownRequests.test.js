/**
 * A session must not answer the key request it sent itself, and must answer
 * the one another device of the same account sent. Request ids travel in the
 * device sync so a later wrap opens anywhere, which makes them no evidence of
 * who sent them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { streamrController } = await import('../../src/js/streamr.js');
const { secureStorage } = await import('../../src/js/secureStorage.js');

const ADMIN = '0x' + 'aa'.repeat(20);
const GATE = '0x' + 'ab'.repeat(20);
const STREAM = `${ADMIN}/own-1`;
const channel = { messageStreamId: STREAM, keysStreamId: `${ADMIN}/own-4`, gate: { address: GATE } };

describe('requests from this session and from the account\'s other devices', () => {
    let s;
    let scheduled;

    beforeEach(() => {
        epochKeyManager.state.clear();
        vi.spyOn(streamrController, 'publishKeysMessage').mockResolvedValue(undefined);
        vi.spyOn(epochKeyManager, '_persist').mockResolvedValue(undefined);
        scheduled = vi.spyOn(epochKeyManager, '_scheduleAnswer').mockImplementation(() => {});
        s = epochKeyManager._getState(STREAM);
        s.epochs = new Map([['1.k', { epoch: 1, keyHex: '11'.repeat(32) }]]);
        s.announces = new Map([
            [1, { keyId: '1.k' }],
            [2, { keyId: '2.k' }]
        ]);
        s.currentEpoch = 2;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        epochKeyManager.state.clear();
    });

    const request = (requestId) => ({ t: 'key_request', requestId, pubkey: '0x04' + 'cd'.repeat(64), fromEpoch: 1 });

    it('answers a request another device sent, even once its id has synced here', async () => {
        vi.spyOn(secureStorage, 'getEpochKeys').mockReturnValue({
            pendingRequests: { 'other-device': { fromEpoch: 2, sentAt: Date.now() } }
        });
        epochKeyManager._loadPersisted(STREAM, s);
        expect(s.pendingRequests.has('other-device')).toBe(true);

        await epochKeyManager._handleRequest(channel, s, request('other-device'), ADMIN);

        expect(scheduled).toHaveBeenCalledTimes(1);
    });

    it('does not answer the request this session sent', async () => {
        await epochKeyManager._sendKeyRequest(channel, s);
        const sent = streamrController.publishKeysMessage.mock.calls
            .map(([, msg]) => msg).find((msg) => msg.t === 'key_request');

        await epochKeyManager._handleRequest(channel, s, request(sent.requestId), ADMIN);

        expect(scheduled).not.toHaveBeenCalled();
    });
});
