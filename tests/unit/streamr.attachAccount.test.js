/**
 * streamr.js — attachAccount (D10)
 *
 * `attachAccount` is the single place where "who sent this" is decided. Every
 * consumer downstream reads `data.account`: isOwn, message grouping, reaction
 * dedup, edit/delete authorship, bans, presence.
 *
 * Two properties are load-bearing and pinned here:
 *
 *  1. The field is `account`, never `senderId`. The rename is the safety
 *     mechanism — once Fase 4 makes publisherId an ephemeral key, a consumer
 *     still reading `senderId` gets `undefined` and fails loudly instead of
 *     silently attributing messages to a throwaway address.
 *
 *  2. It falls back to publisherId. Pre-migration messages carry no proof and
 *     their publisherId IS the sender's wallet, so both formats land in the
 *     same identifier space and history needs no migration (D10b).
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import { streamrController } from '../../src/js/streamr.js';
import { createPublisherProof, clearPublisherProofCache } from '../../src/js/publisherProof.js';

globalThis.ethers = ethers;

describe('attachAccount (D10)', () => {
    let data;

    beforeEach(() => {
        data = { type: 'text', text: 'hello' };
        clearPublisherProofCache();
    });

    it('stamps the publisher as the account', () => {
        streamrController.attachAccount(data, '0xAbC123');
        expect(data.account).toBe('0xAbC123');
    });

    it('never writes the legacy senderId field', () => {
        // The whole point of D10: a stale consumer must break, not silently
        // read a value that means something different after Fase 4.
        streamrController.attachAccount(data, '0xAbC123');
        expect(data.senderId).toBeUndefined();
        expect(Object.keys(data)).not.toContain('senderId');
    });

    it('returns the same object, mutated in place', () => {
        const returned = streamrController.attachAccount(data, '0xAbC');
        expect(returned).toBe(data);
    });

    it('leaves the payload untouched when there is no publisher', () => {
        streamrController.attachAccount(data, undefined);
        expect(data.account).toBeUndefined();
        streamrController.attachAccount(data, null);
        expect(data.account).toBeUndefined();
        streamrController.attachAccount(data, '');
        expect(data.account).toBeUndefined();
    });

    it('survives non-object payloads without throwing', () => {
        // Binary frames and malformed messages reach this path too
        expect(() => streamrController.attachAccount(null, '0xA')).not.toThrow();
        expect(() => streamrController.attachAccount(undefined, '0xA')).not.toThrow();
        expect(() => streamrController.attachAccount('a string', '0xA')).not.toThrow();
        expect(streamrController.attachAccount(null, '0xA')).toBeNull();
    });

    it('drops the send state and verdict the sender shipped', () => {
        Object.assign(data, {
            pending: true, failed: true, failError: 'x', delivered: true, undelivered: true,
            _dmSent: true, verified: { valid: true, trustLevel: 2 }
        });
        streamrController.attachAccount(data, '0xAbC123');
        for (const field of ['pending', 'failed', 'failError', 'delivered', 'undelivered', '_dmSent', 'verified']) {
            expect(data).not.toHaveProperty(field);
        }
    });

    it('keeps the fields a legacy message is verified against', () => {
        Object.assign(data, { signature: '0xsig', channelId: '0xowner/chan-1' });
        streamrController.attachAccount(data, '0xAbC123');
        expect(data.signature).toBe('0xsig');
        expect(data.channelId).toBe('0xowner/chan-1');
    });

    it('overwrites a spoofed account supplied by the sender', () => {
        // `account` is derived from the transport, never trusted from the wire.
        // A payload that ships its own must not win.
        data.account = '0xVictim';
        streamrController.attachAccount(data, '0xRealPublisher');
        expect(data.account).toBe('0xRealPublisher');
    });

    describe('with a publisher proof (Fase 4)', () => {
        let account, ephemeral;

        beforeAll(() => {
            account = new ethers.Wallet('0x' + '11'.repeat(32));
            ephemeral = new ethers.Wallet('0x' + '44'.repeat(32));
        });

        it('resolves to the proved account, not the ephemeral publisher', () => {
            data.proof = createPublisherProof(account.privateKey, ephemeral.address);

            streamrController.attachAccount(data, ephemeral.address);

            expect(data.account).toBe(account.address.toLowerCase());
        });

        it('falls back to the publisher when the proof does not recover', () => {
            // A forged proof lands on the ephemeral address — an identity that
            // owns nothing and matches nobody. It must never resolve to a real
            // account, and must never throw.
            data.proof = 'garbage';

            streamrController.attachAccount(data, ephemeral.address);

            expect(data.account).toBe(ephemeral.address);
        });

        it('ignores a proof lifted from another publisher', () => {
            const other = new ethers.Wallet('0x' + '55'.repeat(32));
            data.proof = createPublisherProof(account.privateKey, other.address);

            streamrController.attachAccount(data, ephemeral.address);

            expect(data.account).not.toBe(account.address.toLowerCase());
        });

        it('still falls back for messages published before the migration', () => {
            // D10b: no proof, and publisherId IS the wallet.
            streamrController.attachAccount(data, account.address);
            expect(data.account).toBe(account.address);
        });
    });
});
