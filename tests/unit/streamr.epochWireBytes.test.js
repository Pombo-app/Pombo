/**
 * What a gated payload actually weighs on the wire.
 *
 * The ciphertext travels base64 inside the epoch envelope, so a payload that
 * fits as plaintext can still be too big to send — and the transport refuses
 * it by throwing inside the SDK, where the publisher never sees it. Anything
 * that splits a payload has to count these bytes.
 *
 * `epochWireBytes` mirrors `publishEpochEncrypted`, so what pins it is that
 * the two agree: measure and publish must produce the same envelope.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const ACCOUNT_KEY = '0x' + '11'.repeat(32);
const STREAM = '0xowner/gated-1-1';

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        wallet: { privateKey: '0x' + '11'.repeat(32) },
        getAddress: () => new ethers.Wallet('0x' + '11'.repeat(32)).address,
        isConnected: () => true
    }
}));

const { streamrController } = await import('../../src/js/streamr.js');
const { epochKeyCrypto } = await import('../../src/js/epochKeyCrypto.js');
const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { channelManager } = await import('../../src/js/channels.js');

const channel = {
    messageStreamId: STREAM,
    type: 'gated',
    gate: { address: '0xgate' }
};

describe('epochWireBytes', () => {
    let published, key;

    beforeAll(async () => {
        window.EthereumKeyPairIdentity = {
            fromPrivateKey: (pk) => ({
                getUserId: async () => new ethers.Wallet(pk).address,
                getSignatureType: () => 'ECDSA_SECP256K1_EVM'
            })
        };
        window.SignatureType = { ERC_1271: 3, ECDSA_SECP256K1_EVM: 2 };
        const keyHex = epochKeyCrypto.generateEpochKey();
        key = { kid: '7.abcdef012345', cryptoKey: await epochKeyCrypto.importEpochKey(keyHex) };
    });

    beforeEach(() => {
        published = [];
        vi.spyOn(streamrController, 'publishAs').mockImplementation(
            async (identity, streamId, partition, content) => {
                published.push(content);
                return { timestamp: 1 };
            }
        );
        vi.spyOn(epochKeyManager, 'getCurrentKey').mockResolvedValue(key);
        channelManager.channels.set(STREAM, channel);
        streamrController.client = {};
        // publishAs is mocked, so the identity only has to exist.
        streamrController._accountIdentity =
            window.EthereumKeyPairIdentity.fromPrivateKey(ACCOUNT_KEY);
    });

    /** Bytes the publish handed the transport. */
    const publishedBytes = () =>
        new TextEncoder().encode(JSON.stringify(published[0])).length;

    it('agrees with the publish it mirrors', async () => {
        const payload = { type: 'image_chunk', imageId: 'i1', chunkIndex: 0, data: 'x'.repeat(4096) };

        const measured = await streamrController.epochWireBytes(channel, STREAM, payload);
        await streamrController.publishEpochEncrypted(channel, STREAM, 0, payload);

        expect(measured).toBe(publishedBytes());
    });

    it('counts the envelope, not the plaintext', async () => {
        const payload = { type: 'image_chunk', imageId: 'i1', chunkIndex: 0, data: 'y'.repeat(120 * 1024) };
        const plaintext = new TextEncoder().encode(JSON.stringify(payload)).length;

        const measured = await streamrController.epochWireBytes(channel, STREAM, payload);

        // base64 over the ciphertext: a third again, and never less than the
        // plaintext. Sizing the plaintext is what let oversized chunks out.
        expect(measured).toBeGreaterThan(plaintext * 1.3);
    });

    it('grows with the payload, so a split can converge', async () => {
        const of = (n) => streamrController.epochWireBytes(
            channel, STREAM, { type: 'image_chunk', data: 'z'.repeat(n) });

        const [small, big] = await Promise.all([of(1024), of(8192)]);
        expect(big).toBeGreaterThan(small);
    });

    it('refuses to size a channel with no epoch key, rather than guess', async () => {
        epochKeyManager.getCurrentKey.mockResolvedValue(null);
        await expect(streamrController.epochWireBytes(channel, STREAM, { text: 'hi' }))
            .rejects.toThrow('No epoch key');
    });
});
