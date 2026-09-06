/**
 * `resolveAuthor` decides who wrote a message and, just as often, that nobody
 * did and the row must go. Everything downstream trusts its answer, so each
 * branch here is a security boundary rather than a formatting choice:
 *
 *  - on a gated stream the transport publisher is the channel's shared
 *    identity and asserts nothing about authorship;
 *  - the admin stream is the exception, published under the owner's own
 *    account, and the namespace prefix is the authority;
 *  - live delivery cuts a member whose gate access has lapsed, while a
 *    storage resend is exempt, because retention is the proof of past
 *    membership.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const signerMock = vi.hoisted(() => ({ recover: null }));
vi.mock('../../src/js/envelopeSigner.js', () => ({
    recoverEnvelopeSigner: (...args) => signerMock.recover(...args),
}));

const accessMock = vi.hoisted(() => ({ check: null }));
vi.mock('../../src/js/gate.js', () => ({
    gateManager: { checkAccessOrNull: (...args) => accessMock.check(...args) },
}));

const { streamrController } = await import('../../src/js/streamr.js');

const OWNER = '0x' + 'aa'.repeat(20);
const GATE = '0x' + 'bb'.repeat(20);
const MEMBER = '0x' + 'cc'.repeat(20);

const MESSAGE = `${OWNER}/room-1`;
const ADMIN = `${OWNER}/room-3`;
const KEYS = `${OWNER}/room-4`;

const gated = (over = {}) => ({ messageStreamId: MESSAGE, gate: { address: GATE }, ...over });

describe('resolveAuthor', () => {
    beforeEach(() => {
        signerMock.recover = vi.fn(() => MEMBER.toLowerCase());
        accessMock.check = vi.fn(async () => true);
        vi.spyOn(streamrController, '_gatedChannelFor').mockResolvedValue(null);
    });

    afterEach(() => vi.restoreAllMocks());

    it('passes the transport publisher through on an ungated stream', async () => {
        expect(await streamrController.resolveAuthor(MESSAGE, {}, MEMBER)).toBe(MEMBER);
    });

    it('answers null when an ungated stream has no publisher at all', async () => {
        expect(await streamrController.resolveAuthor(MESSAGE, {}, undefined)).toBeNull();
    });

    it('leaves authorship to the seal on a members-only content stream', async () => {
        streamrController._gatedChannelFor.mockResolvedValue(gated({ wireIdentity: 'sealed' }));

        // The shared publish key is the publisher here; this stage neither
        // confirms nor drops, it just gets out of the way.
        expect(await streamrController.resolveAuthor(MESSAGE, {}, GATE)).toBe(GATE);
        expect(signerMock.recover).not.toHaveBeenCalled();
    });

    it('still judges the admin stream on a members-only channel', async () => {
        streamrController._gatedChannelFor.mockResolvedValue(gated({ wireIdentity: 'sealed' }));
        signerMock.recover = vi.fn(() => OWNER.toLowerCase());

        // Published under the owner's own account and signed by it.
        expect(await streamrController.resolveAuthor(ADMIN, {}, OWNER)).toBe(OWNER.toLowerCase());
    });

    it('drops a foreign publisher on a gated stream', async () => {
        streamrController._gatedChannelFor.mockResolvedValue(gated());

        expect(await streamrController.resolveAuthor(MESSAGE, {}, MEMBER)).toBeNull();
    });

    it('accepts the owner publishing the admin stream as themselves', async () => {
        streamrController._gatedChannelFor.mockResolvedValue(gated());
        signerMock.recover = vi.fn(() => OWNER.toLowerCase());

        expect(await streamrController.resolveAuthor(ADMIN, {}, OWNER)).toBe(OWNER.toLowerCase());
    });

    /**
     * The claim is not the proof. Gated reads are raw and skip the
     * envelope-authenticity check, so an envelope that merely NAMES the owner
     * as publisher would otherwise hand a forged snapshot full moderation
     * authority — bans, hidden messages and pins for everyone who reads it.
     */
    it('drops an admin message that names the owner but is signed by someone else', async () => {
        streamrController._gatedChannelFor.mockResolvedValue(gated());
        signerMock.recover = vi.fn(() => MEMBER.toLowerCase());

        expect(await streamrController.resolveAuthor(ADMIN, {}, OWNER)).toBeNull();
    });

    it('recovers the envelope signer when the channel identity published', async () => {
        streamrController._gatedChannelFor.mockResolvedValue(gated());

        expect(await streamrController.resolveAuthor(MESSAGE, { sig: 1 }, GATE)).toBe(MEMBER.toLowerCase());
        expect(signerMock.recover).toHaveBeenCalledWith({ sig: 1 });
    });

    it('drops an envelope whose signature cannot be recovered', async () => {
        streamrController._gatedChannelFor.mockResolvedValue(gated());
        signerMock.recover = vi.fn(() => null);

        expect(await streamrController.resolveAuthor(MESSAGE, {}, GATE)).toBeNull();
    });

    it('drops a clone-published admin message that is not signed by the admin', async () => {
        streamrController._gatedChannelFor.mockResolvedValue(gated());

        expect(await streamrController.resolveAuthor(ADMIN, {}, GATE)).toBeNull();
    });

    it('accepts a clone-published admin message signed by the admin', async () => {
        streamrController._gatedChannelFor.mockResolvedValue(gated());
        signerMock.recover = vi.fn(() => OWNER.toLowerCase());

        expect(await streamrController.resolveAuthor(ADMIN, {}, GATE)).toBe(OWNER.toLowerCase());
    });

    it('cuts a live message from someone whose gate access has lapsed', async () => {
        streamrController._gatedChannelFor.mockResolvedValue(gated());
        accessMock.check = vi.fn(async () => false);

        expect(await streamrController.resolveAuthor(MESSAGE, {}, GATE, { live: true })).toBeNull();
    });

    it('keeps a live message when the gate cannot be read, rather than guessing', async () => {
        streamrController._gatedChannelFor.mockResolvedValue(gated());
        accessMock.check = vi.fn(async () => null);

        expect(await streamrController.resolveAuthor(MESSAGE, {}, GATE, { live: true }))
            .toBe(MEMBER.toLowerCase());
    });

    it('exempts stored history from the access cut', async () => {
        streamrController._gatedChannelFor.mockResolvedValue(gated());
        accessMock.check = vi.fn(async () => false);

        expect(await streamrController.resolveAuthor(MESSAGE, {}, GATE)).toBe(MEMBER.toLowerCase());
        expect(accessMock.check).not.toHaveBeenCalled();
    });

    it('exempts the admin and keys streams from the access cut even when live', async () => {
        streamrController._gatedChannelFor.mockResolvedValue(gated());
        signerMock.recover = vi.fn(() => OWNER.toLowerCase());
        accessMock.check = vi.fn(async () => false);

        expect(await streamrController.resolveAuthor(ADMIN, {}, GATE, { live: true })).toBe(OWNER.toLowerCase());
        expect(await streamrController.resolveAuthor(KEYS, {}, GATE, { live: true })).toBe(OWNER.toLowerCase());
        expect(accessMock.check).not.toHaveBeenCalled();
    });
});
