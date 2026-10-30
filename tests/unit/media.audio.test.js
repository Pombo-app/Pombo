/**
 * Voice messages over the stored-image transport: manifest shape, send
 * states, retry, and the round trip through chunk assembly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        publishMessage: vi.fn().mockResolvedValue(undefined),
        epochWireBytes: vi.fn().mockResolvedValue(1000)
    },
    deriveEphemeralId: vi.fn((id) => `ephemeral-${id}`),
    STREAM_CONFIG: { MESSAGE_STREAM: { MESSAGES: 0 }, EPHEMERAL_STREAM: { PARTITIONS: 3 } }
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: { getAddress: vi.fn().mockReturnValue('0xme'), wallet: { privateKey: '0xpk' } }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        getChannel: vi.fn(),
        notifyHandlers: vi.fn(),
        sendWakeSignals: vi.fn().mockResolvedValue(undefined),
        messageFlow: { keepForRetry: vi.fn().mockResolvedValue(undefined) }
    }
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        createAudioManifest: vi.fn(async (input) => ({
            type: 'audio', transport: 'chunked', v: 2, id: 'audio-msg-1',
            text: '🎤 Voice message', sender: '0xme', timestamp: 1000,
            ...input, durationMs: Math.round(input.durationMs)
        })),
        getTrustLevel: vi.fn().mockResolvedValue(0)
    }
}));

vi.mock('../../src/js/logger.js', () => ({
    Logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        addSentMessage: vi.fn().mockResolvedValue(undefined),
        saveImageToLedger: vi.fn().mockResolvedValue(true),
        removeFailedOutbox: vi.fn().mockResolvedValue(undefined),
        getImageBlob: vi.fn().mockResolvedValue(null)
    }
}));

vi.mock('../../src/js/channelIdentity.js', () => ({
    getChannelIdentity: vi.fn(),
    dropChannelIdentity: vi.fn(),
    clearChannelIdentities: vi.fn()
}));

vi.mock('../../src/js/dm.js', () => ({
    dmManager: {
        sealFor: vi.fn(async (peer, payload) => ({
            envelope: { v: 2, ct: JSON.stringify(payload) },
            ephemeralPrivateKey: '0xeph'
        })),
        publishSealed: vi.fn().mockResolvedValue(undefined),
        rememberRow: vi.fn()
    }
}));

vi.mock('../../src/js/utils/network.js', () => ({
    NO_NETWORK: 'No network',
    isOffline: vi.fn(() => false)
}));

import { mediaController } from '../../src/js/media.js';
import { streamrController } from '../../src/js/streamr.js';
import { channelManager } from '../../src/js/channels.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { dmManager } from '../../src/js/dm.js';
import { isOffline } from '../../src/js/utils/network.js';

const STREAM = '0xowner/abc-1';

function audioBlob(size = 300 * 1024) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = i % 251;
    return new Blob([bytes], { type: 'audio/webm' });
}

describe('voice messages', () => {
    let channel;

    beforeEach(() => {
        vi.clearAllMocks();
        mediaController.imageCache.clear();
        mediaController.imageCacheBytes = 0;
        channel = { messageStreamId: STREAM, streamId: STREAM, type: 'public', messages: [] };
        channelManager.getChannel.mockImplementation((id) => (id === STREAM ? channel : null));
        isOffline.mockReturnValue(false);
    });

    describe('manifest predicate', () => {
        const base = {
            type: 'audio', transport: 'chunked', v: 2, imageId: 'a1', chunkCount: 1,
            chunkHashes: ['h'], finalMime: 'audio/webm', assembledSha256: 's', durationMs: 4200
        };

        it('accepts an audio manifest on the image transport', () => {
            expect(mediaController.isStoredChunkedImageManifest(base)).toBe(true);
        });

        it('requires a positive durationMs', () => {
            expect(mediaController.isStoredChunkedImageManifest({ ...base, durationMs: undefined })).toBe(false);
            expect(mediaController.isStoredChunkedImageManifest({ ...base, durationMs: 0 })).toBe(false);
        });

        it('requires an audio MIME', () => {
            expect(mediaController.isStoredChunkedImageManifest({ ...base, finalMime: 'image/png' })).toBe(false);
        });
    });

    describe('sendAudio', () => {
        it('publishes every chunk before the manifest and settles the bubble as sent', async () => {
            const message = await mediaController.sendAudio(STREAM, audioBlob(), { mime: 'audio/webm', durationMs: 4200.4 });

            const published = streamrController.publishMessage.mock.calls.map(c => c[1]);
            expect(published.length).toBeGreaterThan(2);
            expect(published.slice(0, -1).every(p => p.type === 'image_chunk' && p.imageId === message.imageId)).toBe(true);
            const manifest = published.at(-1);
            expect(manifest).toMatchObject({ type: 'audio', finalMime: 'audio/webm', durationMs: 4200, text: '🎤 Voice message' });
            expect(manifest.chunkCount).toBe(published.length - 1);
            expect(manifest).not.toHaveProperty('pending');
            expect(manifest).not.toHaveProperty('verified');

            expect(message.pending).toBe(false);
            expect(message.failed).toBe(false);
            expect(channel.messages).toContain(message);
            expect(mediaController.getImage(message.imageId)).toMatch(/^data:audio\/webm;base64,/);
            expect(secureStorage.saveImageToLedger).toHaveBeenCalledWith(message.imageId, expect.any(String), STREAM);
            expect(channelManager.notifyHandlers).toHaveBeenCalledWith('message_confirmed', expect.objectContaining({ messageId: message.id }));
        });

        it('shows the bubble as sending before the publish settles', async () => {
            let pendingSeen = null;
            channelManager.notifyHandlers.mockImplementation((event, data) => {
                if (event === 'message') pendingSeen = data.message.pending;
            });
            await mediaController.sendAudio(STREAM, audioBlob(1000), { mime: 'audio/webm', durationMs: 1000 });
            expect(pendingSeen).toBe(true);
        });

        it('seals every payload to the peer in a DM and keeps the sent copy', async () => {
            channel.type = 'dm';
            channel.peerAddress = '0xpeer';
            const message = await mediaController.sendAudio(STREAM, audioBlob(1000), { mime: 'audio/ogg', durationMs: 1000 });

            expect(streamrController.publishMessage).not.toHaveBeenCalled();
            expect(dmManager.publishSealed).toHaveBeenCalledTimes(2);
            expect(message._dmSent).toBe(true);
            expect(secureStorage.addSentMessage).toHaveBeenCalledWith(STREAM, message);
        });

        it('refuses a recording over 1MB before anything is shown', async () => {
            await expect(mediaController.sendAudio(STREAM, audioBlob(1024 * 1024 + 1), { mime: 'audio/webm', durationMs: 1000 }))
                .rejects.toThrow(/1MB/);
            expect(channel.messages).toHaveLength(0);
        });

        it('refuses a non-audio MIME', async () => {
            await expect(mediaController.sendAudio(STREAM, audioBlob(1000), { mime: 'image/png', durationMs: 1000 }))
                .rejects.toThrow();
        });

        it('marks the bubble failed and keeps it for a retry when the publish fails', async () => {
            streamrController.publishMessage.mockRejectedValueOnce(new Error('boom'));
            await expect(mediaController.sendAudio(STREAM, audioBlob(1000), { mime: 'audio/webm', durationMs: 1000 }))
                .rejects.toThrow('boom');

            const message = channel.messages[0];
            expect(message.failed).toBe(true);
            expect(message.pending).toBe(false);
            expect(message.failError).toBe('boom');
            expect(channelManager.messageFlow.keepForRetry).toHaveBeenCalledWith(STREAM, message);
            expect(channelManager.notifyHandlers).toHaveBeenCalledWith('message_failed', expect.objectContaining({ messageId: message.id }));
        });
    });

    describe('resendAudio', () => {
        it('republishes chunks and manifest under the same id', async () => {
            streamrController.publishMessage.mockRejectedValueOnce(new Error('offline'));
            await expect(mediaController.sendAudio(STREAM, audioBlob(1000), { mime: 'audio/webm', durationMs: 1000 })).rejects.toThrow();
            const failed = channel.messages[0];
            streamrController.publishMessage.mockClear();

            const resent = await mediaController.resendAudio(STREAM, failed.id);

            expect(resent).toBe(failed);
            expect(failed.failed).toBe(false);
            expect(failed.pending).toBe(false);
            const published = streamrController.publishMessage.mock.calls.map(c => c[1]);
            expect(published.map(p => p.type)).toEqual(['image_chunk', 'audio']);
            expect(published[1].id).toBe(failed.id);
            expect(channel.messages).toHaveLength(1);
        });

        it('rebuilds the chunks from the ledger when the cache lost the bytes', async () => {
            streamrController.publishMessage.mockRejectedValueOnce(new Error('offline'));
            await expect(mediaController.sendAudio(STREAM, audioBlob(1000), { mime: 'audio/webm', durationMs: 1000 })).rejects.toThrow();
            const failed = channel.messages[0];
            const dataUrl = mediaController.getImage(failed.imageId);
            mediaController.imageCache.clear();
            secureStorage.getImageBlob.mockResolvedValueOnce(dataUrl);

            await mediaController.resendAudio(STREAM, failed.id);
            expect(failed.failed).toBe(false);
        });

        it('fails again, still retryable, when the bytes are gone', async () => {
            streamrController.publishMessage.mockRejectedValueOnce(new Error('offline'));
            await expect(mediaController.sendAudio(STREAM, audioBlob(1000), { mime: 'audio/webm', durationMs: 1000 })).rejects.toThrow();
            const failed = channel.messages[0];
            mediaController.imageCache.clear();

            await expect(mediaController.resendAudio(STREAM, failed.id)).rejects.toThrow(/no longer available/);
            expect(failed.failed).toBe(true);
        });

        it('does nothing for a message that did not fail', async () => {
            const sent = await mediaController.sendAudio(STREAM, audioBlob(1000), { mime: 'audio/webm', durationMs: 1000 });
            expect(await mediaController.resendAudio(STREAM, sent.id)).toBeNull();
        });
    });

    describe('receiving', () => {
        it('assembles the chunks of an audio manifest into a playable data URL', async () => {
            await mediaController.sendAudio(STREAM, audioBlob(), { mime: 'audio/webm', durationMs: 3000 });
            const published = streamrController.publishMessage.mock.calls.map(c => c[1]);
            const manifest = published.at(-1);
            const original = mediaController.getImage(manifest.imageId);
            mediaController.imageCache.clear();

            for (const chunk of published.slice(0, -1)) {
                await mediaController.registerStoredImageChunk(STREAM, chunk);
            }
            expect(await mediaController.registerStoredImageManifest(STREAM, manifest)).toBe(true);
            expect(mediaController.getImage(manifest.imageId)).toBe(original);
        });
    });
});
