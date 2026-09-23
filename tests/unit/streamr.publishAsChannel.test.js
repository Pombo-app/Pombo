/**
 * streamr.js — publishAsChannel (D1 + D2)
 *
 * The single egress point for channel traffic, mirroring attachAccount on the
 * way in. Two properties are load-bearing:
 *
 *  1. The wallet never appears as publisherId. Every channel publish goes out
 *     under the channel's throwaway key, with the account named by a proof in
 *     the payload — which a member reads and an observer of the network does
 *     not care about, because they cannot tie it to any other channel.
 *
 *  2. The admin stream is refused. Publishing ADMIN_STATE is gated by the
 *     owner's on-chain permission, which an ephemeral key does not hold (D3).
 *     Failing loudly here beats a moderation action that vanishes.
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

vi.mock('../../src/js/crypto.js', () => ({
    cryptoManager: {
        encryptJSON: vi.fn(async (data) => `ENC(${JSON.stringify(data)})`),
        generateRandomHex: () => 'abcdef'
    }
}));

const usesAccountPublish = vi.fn(() => false);
vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        channels: new Map(),
        previewChannel: null,
        usesAccountPublish: (...a) => usesAccountPublish(...a)
    }
}));

const { streamrController } = await import('../../src/js/streamr.js');
const { clearChannelIdentities } = await import('../../src/js/channelIdentity.js');
const { recoverPublisherAccount } = await import('../../src/js/publisherProof.js');

describe('publishAsChannel', () => {
    let account, published;

    beforeAll(() => {
        account = new ethers.Wallet(ACCOUNT_KEY);
        window.EthereumKeyPairIdentity = {
            fromPrivateKey: (pk) => ({
                getUserId: async () => new ethers.Wallet(pk).address,
                getSignatureType: () => 'ECDSA_SECP256K1_EVM'
            })
        };
    });

    beforeEach(() => {
        clearChannelIdentities();
        published = [];
        // publishAs is proven by its own smoke test against the real network;
        // here only what reaches it matters.
        vi.spyOn(streamrController, 'publishAs').mockImplementation(
            async (identity, streamId, partition, content) => {
                published.push({ identity, streamId, partition, content });
                return { timestamp: 1 };
            }
        );
        streamrController.client = {};
    });

    it('publishes under the channel identity, never the wallet', async () => {
        await streamrController.publishAsChannel('0xowner/chan-1', 0, { text: 'hi' });

        const publisherId = await published[0].identity.getUserId();
        expect(publisherId.toLowerCase()).not.toBe(account.address.toLowerCase());
    });

    it('attaches a proof that names the real account', async () => {
        await streamrController.publishAsChannel('0xowner/chan-1', 0, { text: 'hi' });

        const { content, identity } = published[0];
        expect(recoverPublisherAccount(await identity.getUserId(), content.proof))
            .toBe(account.address.toLowerCase());
    });

    it('reuses one publisher for the whole channel session', async () => {
        await streamrController.publishAsChannel('0xowner/chan-1', 0, { text: 'one' });
        await streamrController.publishAsChannel('0xowner/chan-2', 1, { type: 'typing' });

        const a = await published[0].identity.getUserId();
        const b = await published[1].identity.getUserId();
        expect(b).toBe(a);
    });

    it('seals the proof inside the channel password envelope', async () => {
        // In a password channel the proof must not sit outside the ciphertext:
        // it names the author to anyone watching, member or not.
        await streamrController.publishAsChannel('0xowner/chan-1', 0, { text: 'hi' }, 'pw');

        const { content } = published[0];
        expect(typeof content).toBe('string');
        expect(content).toContain('proof');
    });

    it('strips local-only UI state before publishing', async () => {
        await streamrController.publishAsChannel('0xowner/chan-1', 0, {
            text: 'hi', verified: true, pending: true, _dmSent: true
        });

        expect(published[0].content).not.toHaveProperty('verified');
        expect(published[0].content).not.toHaveProperty('pending');
        expect(published[0].content).not.toHaveProperty('_dmSent');
        expect(published[0].content.text).toBe('hi');
    });

    it('keeps the moderation display flag off the wire', async () => {
        await streamrController.publishAsChannel('0xowner/chan-1', 0, { text: 'hi', _hidden: false });

        expect(published[0].content).not.toHaveProperty('_hidden');
    });

    it('strips local state and identity on the account path of a read-only channel', async () => {
        usesAccountPublish.mockReturnValueOnce(true);
        const publish = vi.spyOn(streamrController, 'publish').mockResolvedValue({ timestamp: 1 });

        await streamrController.publishAsChannel('0xowner/chan-1', 0, {
            type: 'text', text: 'hi', pending: true, failed: false,
            verified: { valid: true, trustLevel: 0 },
            sender: account.address, account: account.address
        });

        expect(publish.mock.calls[0][2]).toEqual({ type: 'text', text: 'hi' });
        expect(published).toHaveLength(0);
        publish.mockRestore();
    });

    it('refuses the admin stream rather than publishing without permission', async () => {
        await expect(
            streamrController.publishAsChannel('0xowner/chan-3', 0, { type: 'ADMIN_STATE' })
        ).rejects.toThrow('admin stream');

        expect(published).toHaveLength(0);
    });
});
