/**
 * The question `raw: true` turns off.
 *
 * The transport layer relays without consulting the registry and a storage
 * node keeps whatever reaches it, so a raw resend can hand back a message the
 * on-chain ACL refuses — that is how an announcements channel ended up serving
 * a stranger's message to every Pombo client while every SDK client dropped it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const { streamrController } = await import('../../src/js/streamr.js');

const OWNER = '0x7556cd24d1c22835472b9ae89c2b4548fe2c6134';
const STRANGER = '0x302688aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa375b';
const STREAM = `${OWNER}/f8ff52b571dc6b85-1`;

const msg = (publisherId) => ({ getPublisherId: () => publisherId });

const withPermissions = (rows) => {
    streamrController._writers.clear();
    streamrController._writerFetches.clear();
    streamrController.getStreamPermissions = vi.fn().mockResolvedValue(rows);
};

describe('publisherMayWrite', () => {
    beforeEach(() => {
        streamrController._writers = new Map();
        streamrController._writerFetches = new Map();
    });

    it('refuses a stranger on a stream whose publish is not public', async () => {
        withPermissions([
            { public: true, permissions: ['subscribe'] },
            { userId: OWNER, permissions: ['edit', 'delete', 'publish', 'subscribe', 'grant'] }
        ]);
        expect(await streamrController.publisherMayWrite(STREAM, msg(STRANGER))).toBe(false);
    });

    it('accepts the owner of that same stream', async () => {
        withPermissions([
            { public: true, permissions: ['subscribe'] },
            { userId: OWNER, permissions: ['publish', 'subscribe'] }
        ]);
        expect(await streamrController.publisherMayWrite(STREAM, msg(OWNER))).toBe(true);
    });

    it('accepts anyone when publish is public', async () => {
        withPermissions([{ public: true, permissions: ['subscribe', 'publish'] }]);
        expect(await streamrController.publisherMayWrite(STREAM, msg(STRANGER))).toBe(true);
    });

    it('accepts a specifically granted writer', async () => {
        withPermissions([
            { public: true, permissions: ['subscribe'] },
            { userId: OWNER, permissions: ['publish'] },
            { userId: STRANGER.toUpperCase(), permissions: ['publish'] }
        ]);
        expect(await streamrController.publisherMayWrite(STREAM, msg(STRANGER))).toBe(true);
    });

    it('reads the registry once per stream, not once per message', async () => {
        withPermissions([
            { public: true, permissions: ['subscribe'] },
            { userId: OWNER, permissions: ['publish'] }
        ]);
        await streamrController.publisherMayWrite(STREAM, msg(OWNER));
        await streamrController.publisherMayWrite(STREAM, msg(OWNER));
        await streamrController.publisherMayWrite(STREAM, msg(OWNER));
        expect(streamrController.getStreamPermissions).toHaveBeenCalledTimes(1);
    });

    it('keeps the message when the registry is unreadable', async () => {
        streamrController._writers.clear();
        streamrController.getStreamPermissions = vi.fn().mockRejectedValue(new Error('RPC down'));
        // An outage must not blank a channel: this filter is against junk, not
        // a confidentiality boundary.
        expect(await streamrController.publisherMayWrite(STREAM, msg(STRANGER))).toBe(true);
    });

    it('keeps the message when the permission list comes back empty', async () => {
        // Every real stream lists its owner, so [] is the SDK failing to read.
        withPermissions([]);
        expect(await streamrController.publisherMayWrite(STREAM, msg(STRANGER))).toBe(true);
    });

    it('refuses a message with no publisher at all', async () => {
        withPermissions([{ public: true, permissions: ['subscribe', 'publish'] }]);
        expect(await streamrController.publisherMayWrite(STREAM, {})).toBe(false);
    });
});
