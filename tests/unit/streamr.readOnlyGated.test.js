/**
 * Read-only gated channels, Everyone mode.
 *
 * The gate hands the same publish grant to every member — its contract sees a
 * hash, never a stream, so readOnly cannot be enforced there and is a
 * declaration. "Members do not post" therefore holds only if readers cut it,
 * which is what resolveAuthor does here. Members-only mode needs no cut: the
 * publish key never reaches a plain member.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const canModerate = vi.fn();
const checkAccessOrNull = vi.fn().mockResolvedValue(true);
vi.mock('../../src/js/gate.js', () => ({
    gateManager: {
        canModerate: (...a) => canModerate(...a),
        checkAccessOrNull: (...a) => checkAccessOrNull(...a)
    },
    GATE_MODE: { NONE: 0, TOKEN: 1, NFT: 2, PAID: 3 }
}));

vi.mock('../../src/js/envelopeSigner.js', () => ({
    verifyEnvelopeAuthenticity: () => true,
    recoverEnvelopeSigner: (m) => m.__signer
}));

const { streamrController } = await import('../../src/js/streamr.js');

const OWNER = '0x' + 'aa'.repeat(20);
const GATE = '0x' + 'bb'.repeat(20);
const MEMBER = '0x' + 'cc'.repeat(20);
const MODERATOR = '0x' + 'dd'.repeat(20);
const STREAM = `${OWNER}/room-1`;

const message = (signer) => ({ __signer: signer, getPublisherId: () => GATE });

const channelIs = (extra) => {
    streamrController._gatedChannelFor = vi.fn().mockResolvedValue({
        messageStreamId: STREAM,
        gate: { address: GATE },
        wireIdentity: 'visible',
        ...extra
    });
};

describe('resolveAuthor on a read-only gated channel', () => {
    beforeEach(() => {
        canModerate.mockReset();
        checkAccessOrNull.mockResolvedValue(true);
    });

    it('drops a plain member', async () => {
        channelIs({ readOnly: true });
        canModerate.mockResolvedValue(false);
        expect(await streamrController.resolveAuthor(STREAM, message(MEMBER), GATE)).toBeNull();
    });

    it('keeps the owner', async () => {
        channelIs({ readOnly: true });
        canModerate.mockResolvedValue(true);
        expect(await streamrController.resolveAuthor(STREAM, message(OWNER), GATE)).toBe(OWNER);
    });

    it('keeps a moderator', async () => {
        channelIs({ readOnly: true });
        canModerate.mockResolvedValue(true);
        expect(await streamrController.resolveAuthor(STREAM, message(MODERATOR), GATE)).toBe(MODERATOR);
    });

    it('leaves an ordinary gated channel alone', async () => {
        channelIs({ readOnly: false });
        canModerate.mockResolvedValue(false);
        expect(await streamrController.resolveAuthor(STREAM, message(MEMBER), GATE)).toBe(MEMBER);
        expect(canModerate).not.toHaveBeenCalled();
    });

    it('never cuts the keys stream, where members must speak', async () => {
        channelIs({ readOnly: true });
        canModerate.mockResolvedValue(false);
        const keys = STREAM.replace(/-1$/, '-4');
        expect(await streamrController.resolveAuthor(keys, message(MEMBER), GATE)).toBe(MEMBER);
    });
});
