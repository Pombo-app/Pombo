/**
 * What an ADMIN_STATE and a control signal weigh on the wire.
 *
 * Past the DataChannel's max-message-size the transport throws inside the
 * SDK, where the publisher never sees it, so the snapshot is split by these
 * numbers. They mirror publishAdminState and publishAsChannel branch for
 * branch; what pins them is that measure and publish agree.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const ACCOUNT_KEY = '0x' + '11'.repeat(32);

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        wallet: { privateKey: '0x' + '11'.repeat(32) },
        getAddress: () => new ethers.Wallet('0x' + '11'.repeat(32)).address,
        isConnected: () => true
    }
}));

const { streamrController } = await import('../../src/js/streamr.js');
const { cryptoManager } = await import('../../src/js/crypto.js');
const { epochKeyCrypto } = await import('../../src/js/epochKeyCrypto.js');
const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { channelManager } = await import('../../src/js/channels.js');
const { clearChannelIdentities } = await import('../../src/js/channelIdentity.js');

const snapshot = {
    type: 'ADMIN_STATE', v: 1, rev: 3, ts: 1789000000000, createdBy: '0xowner',
    state: { bannedMembers: [], hiddenMessageIds: ['m-1'], pins: [{ targetId: 'm-2', snapshot: { text: 'olá "pin" 🐦' } }] }
};

const bytes = (content) => new TextEncoder().encode(JSON.stringify(content)).length;

describe('encryptedLength', () => {
    it('is the length encrypt() returns, without deriving a key', async () => {
        for (const text of ['', 'a', 'ab', 'abc', 'olá 🐦 "x"', 'y'.repeat(4097)]) {
            const out = await cryptoManager.encrypt(text, 'pw');
            expect(cryptoManager.encryptedLength(new TextEncoder().encode(text).length)).toBe(out.length);
        }
    });
});

describe('wire bytes of the -3 and the -2', () => {
    let published;

    beforeAll(() => {
        window.EthereumKeyPairIdentity = {
            fromPrivateKey: (pk) => ({
                getUserId: async () => new ethers.Wallet(pk).address,
                getSignatureType: () => 'ECDSA_SECP256K1_EVM'
            })
        };
        window.SignatureType = { ERC_1271: 3, ECDSA_SECP256K1_EVM: 2 };
    });

    beforeEach(() => {
        published = [];
        clearChannelIdentities();
        channelManager.channels.clear();
        streamrController.client = {
            publish: vi.fn(async (_part, content) => { published.push(content); return { timestamp: 1 }; })
        };
        vi.spyOn(streamrController, 'publishAs').mockImplementation(
            async (_identity, _streamId, _partition, content) => { published.push(content); return { timestamp: 1 }; });
        streamrController._accountIdentity = window.EthereumKeyPairIdentity.fromPrivateKey(ACCOUNT_KEY);
    });

    describe('public channel', () => {
        it('measures the -3 publish', async () => {
            const measured = await streamrController.adminWireBytes('0xowner/pub-3', snapshot);
            await streamrController.publishAdminState('0xowner/pub-3', snapshot);
            expect(measured).toBe(bytes(published[0]));
        });

        it('measures the -2 publish, proof included', async () => {
            const signal = { type: 'admin_invalidate', rev: 3, ts: 1, snapshot };
            const measured = await streamrController.channelWireBytes('0xowner/pub-2', signal);
            await streamrController.publishAsChannel('0xowner/pub-2', 0, signal);
            expect(measured).toBe(bytes(published[0]));
        });
    });

    describe('password channel', () => {
        it('measures the -3 publish', async () => {
            const measured = await streamrController.adminWireBytes('0xowner/pw-3', snapshot, 'pw');
            await streamrController.publishAdminState('0xowner/pw-3', snapshot, 'pw');
            expect(measured).toBe(bytes(published[0]));
        });

        it('measures the -2 publish', async () => {
            const signal = { type: 'admin_invalidate', rev: 3, ts: 1, snapshot };
            const measured = await streamrController.channelWireBytes('0xowner/pw-2', signal, 'pw');
            await streamrController.publishAsChannel('0xowner/pw-2', 0, signal, 'pw');
            expect(measured).toBe(bytes(published[0]));
        });
    });

    describe('gated channel', () => {
        const channel = { messageStreamId: '0xowner/gated-1', type: 'gated', gate: { address: '0xgate' } };

        beforeEach(async () => {
            const key = { kid: '7.abcdef012345', cryptoKey: await epochKeyCrypto.importEpochKey(epochKeyCrypto.generateEpochKey()) };
            vi.spyOn(epochKeyManager, 'getCurrentKey').mockResolvedValue(key);
            channelManager.channels.set(channel.messageStreamId, channel);
        });

        it('measures the -3 publish', async () => {
            const measured = await streamrController.adminWireBytes('0xowner/gated-3', snapshot);
            await streamrController.publishAdminState('0xowner/gated-3', snapshot);
            expect(measured).toBe(bytes(published[0]));
        });

        it('measures the -2 publish', async () => {
            const signal = { type: 'admin_invalidate', rev: 3, ts: 1, snapshot };
            const measured = await streamrController.channelWireBytes('0xowner/gated-2', signal);
            await streamrController.publishAsChannel('0xowner/gated-2', 0, signal);
            expect(measured).toBe(bytes(published[0]));
        });

        it('tries to recover a missing key before sizing, as the publish does', async () => {
            epochKeyManager.getCurrentKey.mockResolvedValueOnce(null);
            const ensure = vi.spyOn(epochKeyManager, 'ensureChannelKeys').mockResolvedValue();

            await streamrController.adminWireBytes('0xowner/gated-3', snapshot);

            expect(ensure).toHaveBeenCalledWith(channel);
        });
    });
});
