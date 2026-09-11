/**
 * DM Manager Tests
 * Tests for the DMManager class (dm.js)
 * Covers: init, destroy, routing, conversations, sentMessages integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock all dependencies before importing dm.js
vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock('../../src/js/config.js', async () => {
    const actual = await vi.importActual('../../src/js/config.js');
    return {
        ...actual,
        CONFIG: {
            ...actual.CONFIG,
            dm: {
                ...actual.CONFIG.dm,
                streamPrefix: 'Pombo-DM',
                maxConversations: 100,
                maxSentMessages: 200,
                inboxHistoryCount: 100,
                searchWindowMs: 7 * 24 * 60 * 60 * 1000
            },
            app: { ...actual.CONFIG.app, name: 'Pombo', version: '1.0' }
        }
    };
});

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getAddress: vi.fn().mockReturnValue('0xmyaddress1234567890abcdef12345678'),
        isGuestMode: vi.fn().mockReturnValue(false),
        wallet: { privateKey: '0xfakeprivatekey1234567890abcdef' }
    }
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        createSignedMessage: vi.fn().mockImplementation(async (text, channelId, replyTo) => ({
            id: `msg-${Date.now()}`,
            sender: '0xmyaddress1234567890abcdef12345678',
            text,
            channelId,
            replyTo: replyTo || null,
            timestamp: Date.now(),
            signature: '0xfakesig'
        })),
        getTrustLevel: vi.fn().mockResolvedValue('self'),
        resolveENS: vi.fn().mockResolvedValue(null),
        resolveAddress: vi.fn().mockResolvedValue(null)
    }
}));

vi.mock('../../src/js/relayManager.js', () => ({
    relayManager: {
        enabled: false,
        subscribeToChannel: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        getSentMessages: vi.fn().mockReturnValue([]),
        addSentMessage: vi.fn().mockResolvedValue(undefined),
        getTrustedContacts: vi.fn().mockReturnValue({}),
        getSentReactions: vi.fn().mockReturnValue({}),
        isBlocked: vi.fn().mockReturnValue(false),
        getDMLeftAt: vi.fn().mockReturnValue(null),
        clearDMLeftAt: vi.fn().mockResolvedValue(undefined),
        updateSentMessage: vi.fn().mockResolvedValue(undefined),
        removeSentMessage: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        getDMInboxId: vi.fn((addr) => `${addr.toLowerCase()}/Pombo-DM-1`),
        getDMEphemeralId: vi.fn((addr) => `${addr.toLowerCase()}/Pombo-DM-2`),
        createDMInbox: vi.fn().mockResolvedValue({
            messageStreamId: '0xmyaddress1234567890abcdef12345678/Pombo-DM-1',
            ephemeralStreamId: '0xmyaddress1234567890abcdef12345678/Pombo-DM-2'
        }),
        subscribeWithHistory: vi.fn().mockResolvedValue({ id: 'mock-sub' }),
        subscribeToPartition: vi.fn().mockResolvedValue({ id: 'mock-partition-sub' }),
        isSubscribedToPartition: vi.fn().mockReturnValue(false),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        publishMessage: vi.fn().mockResolvedValue(undefined),
        publishAs: vi.fn().mockResolvedValue({ messageId: { publisherId: '0xEphemeral' } }),
        getDMPublicKey: vi.fn().mockResolvedValue('0x02peerpubkey'),
        setDMEncryptionKey: vi.fn().mockResolvedValue(undefined),
        setDMPublishKey: vi.fn().mockResolvedValue(undefined),
        addDMDecryptKey: vi.fn().mockResolvedValue(undefined),
        unsubscribeFromPartition: vi.fn().mockResolvedValue(undefined),
        diagnoseInbox: vi.fn().mockResolvedValue({ ok: true }),
        repairInbox: vi.fn().mockResolvedValue({
            messageStreamId: '0xmyaddress1234567890abcdef12345678/Pombo-DM-1',
            ephemeralStreamId: '0xmyaddress1234567890abcdef12345678/Pombo-DM-2'
        }),
        fetchOlderHistoryWindowed: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
        client: {
            getStream: vi.fn().mockRejectedValue(new Error('not found'))
        }
    },
    STREAM_CONFIG: {
        MESSAGE_STREAM: {
            MESSAGES: 0,
            NOTIFICATIONS: 3
        },
        EPHEMERAL_STREAM: {
            CONTROL: 0,
            MEDIA_SIGNALS: 1,
            MEDIA_DATA: 2
        }
    }
}));

vi.mock('../../src/js/dmCrypto.js', () => ({
    dmCrypto: {
        getMyPublicKey: vi.fn().mockReturnValue('0x02abc123'),
        getSharedKey: vi.fn().mockResolvedValue('mock-aes-key'),
        encrypt: vi.fn().mockImplementation(async (msg) => ({ ct: 'enc', iv: 'iv', e: 'aes-256-gcm', _original: msg })),
        decrypt: vi.fn().mockImplementation(async (env) => env._original || { text: 'decrypted' }),
        encryptBinary: vi.fn().mockImplementation(async (data) => new Uint8Array([0xFF, ...data])),
        decryptBinary: vi.fn().mockImplementation(async (data) => data.slice(1)),
        isEncrypted: vi.fn().mockReturnValue(false),
        // Sealed sender (v2). Defaults to false so these tests keep exercising
        // the plaintext / v1 paths; individual tests flip it when they need v2.
        isSealed: vi.fn().mockReturnValue(false),
        // Sealed binary (P7). Same default: off unless a test opts in.
        isSealedBinary: vi.fn().mockReturnValue(false),
        openBinary: vi.fn().mockResolvedValue({
            sender: '0xPeerSender',
            bytes: new Uint8Array([10, 20, 30])
        }),
        createBinarySealer: vi.fn().mockResolvedValue({
            ephemeralPublicKey: '0x02eph',
            ephemeralPrivateKey: '0x' + '22'.repeat(32),
            seal: vi.fn().mockImplementation(async (b) => new Uint8Array([0x02, ...b]))
        }),
        seal: vi.fn().mockImplementation(async (msg) => ({
            envelope: { v: 2, epk: '0x02eph', ct: 'sealed', iv: 'iv', e: 'aes-256-gcm', _original: msg },
            ephemeralPrivateKey: '0x' + '11'.repeat(32)
        })),
        open: vi.fn().mockImplementation(async (env) => ({
            sender: '0xPeerSender',
            message: env._original || { text: 'opened' }
        })),
        peerPublicKeys: new Map(),
        sharedKeys: new Map(),
        clear: vi.fn()
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        channels: new Map(),
        saveChannels: vi.fn().mockResolvedValue(undefined),
        setCurrentChannel: vi.fn(),
        notifyHandlers: vi.fn(),
        handleControlMessage: vi.fn(),
        handleOverrideMessage: vi.fn(),
        storeReaction: vi.fn(),
        sendWakeSignals: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/media.js', () => ({
    mediaController: {
        handleMediaMessage: vi.fn(),
        hasActiveDMTransfers: vi.fn().mockReturnValue(false)
    }
}));
vi.mock('../../src/js/storageEndpoints.js', () => ({
    storageEndpoints: { providersWith: vi.fn().mockResolvedValue([]) }
}));
const purgeGroupsMock = vi.fn();
const eraseMessageMock = vi.fn();
vi.mock('../../src/js/storagePurge.js', () => ({
    purgeGroups: (...a) => purgeGroupsMock(...a),
    eraseMessage: (...a) => eraseMessageMock(...a),
    keySigner: (privateKey) => ({ address: `signer:${privateKey}`, sign: async () => '0xsig' })
}));

vi.mock('../../src/js/notifications.js', () => ({
    notificationManager: {
        handleNotification: vi.fn(),
        isMuted: vi.fn().mockReturnValue(false)
    }
}));

// Exposed by streamr-bundle.js in the browser. sealAndPublish turns the
// ephemeral private key from seal() into a Streamr signing identity.
globalThis.EthereumKeyPairIdentity = {
    fromPrivateKey: vi.fn((pk) => ({
        getUserId: async () => '0xEphemeral',
        getSignatureType: () => 2,
        _privateKey: pk
    }))
};

import { dmManager } from '../../src/js/dm.js';
import { authManager } from '../../src/js/auth.js';
import { streamrController } from '../../src/js/streamr.js';
import { channelManager } from '../../src/js/channels.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { dmCrypto } from '../../src/js/dmCrypto.js';
import { relayManager } from '../../src/js/relayManager.js';
import { mediaController } from '../../src/js/media.js';
import { notificationManager } from '../../src/js/notifications.js';

describe('DMManager', () => {
    beforeEach(() => {
        // Reset DMManager state
        dmManager.inboxMessageStreamId = null;
        dmManager.inboxEphemeralStreamId = null;
        dmManager.inboxSubscription = null;
        dmManager.inboxEphemeralSubscription = null;
        dmManager.inboxNotificationSub = null;
        dmManager.conversations.clear();
        dmManager.inboxReady = false;
        dmManager.handlers = [];

        // Reset mocked map
        channelManager.channels.clear();

        // Reset mocks
        vi.clearAllMocks();
    });

    // ==================== init() ====================
    describe('init()', () => {
        it('should skip init for guest mode', async () => {
            authManager.isGuestMode.mockReturnValue(true);

            await dmManager.init();

            expect(dmManager.inboxMessageStreamId).toBeNull();
            authManager.isGuestMode.mockReturnValue(false);
        });

        it('should skip init when no address', async () => {
            authManager.getAddress.mockReturnValue(null);

            await dmManager.init();

            expect(dmManager.inboxMessageStreamId).toBeNull();
            authManager.getAddress.mockReturnValue('0xmyaddress1234567890abcdef12345678');
        });

        it('should set inbox stream IDs on init', async () => {
            // Inbox doesn't exist
            streamrController.client.getStream.mockRejectedValue(new Error('not found'));

            await dmManager.init();

            expect(dmManager.inboxMessageStreamId).toBe('0xmyaddress1234567890abcdef12345678/Pombo-DM-1');
            expect(dmManager.inboxEphemeralStreamId).toBe('0xmyaddress1234567890abcdef12345678/Pombo-DM-2');
        });

        it('should auto-subscribe when inbox exists', async () => {
            streamrController.client.getStream.mockResolvedValue({ id: 'mock-stream' });

            await dmManager.init();

            expect(dmManager.inboxReady).toBe(true);
            expect(streamrController.subscribeWithHistory).toHaveBeenCalled();
        });

        it('should rebuild conversations from existing DM channels', async () => {
            // Add a DM channel to the channelManager before init
            channelManager.channels.set('0xpeer/Pombo-DM-1', {
                type: 'dm',
                peerAddress: '0xpeer',
                messageStreamId: '0xpeer/Pombo-DM-1'
            });

            streamrController.client.getStream.mockRejectedValue(new Error('not found'));

            await dmManager.init();

            expect(dmManager.conversations.has('0xpeer')).toBe(true);
            expect(dmManager.conversations.get('0xpeer')).toBe('0xpeer/Pombo-DM-1');
        });
    });

    // ==================== destroy() ====================
    describe('destroy()', () => {
        it('should clear all state', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            dmManager.inboxEphemeralStreamId = 'test/Pombo-DM-2';
            dmManager.inboxSubscription = { id: 'sub' };
            dmManager.inboxEphemeralSubscription = { id: 'sub2' };
            dmManager.inboxReady = true;
            dmManager.conversations.set('0xpeer', 'stream-1');
            dmManager.handlers.push(() => {});

            await dmManager.destroy();

            expect(dmManager.inboxMessageStreamId).toBeNull();
            expect(dmManager.inboxEphemeralStreamId).toBeNull();
            expect(dmManager.inboxSubscription).toBeNull();
            expect(dmManager.inboxEphemeralSubscription).toBeNull();
            expect(dmManager.inboxReady).toBe(false);
            expect(dmManager.conversations.size).toBe(0);
            expect(dmManager.handlers).toHaveLength(0);
        });

        it('should call unsubscribe for message inbox', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            dmManager.inboxSubscription = { id: 'sub' };

            await dmManager.destroy();

            expect(streamrController.unsubscribe).toHaveBeenCalledWith('test/Pombo-DM-1');
        });

        it('should call unsubscribe for ephemeral inbox', async () => {
            dmManager.inboxEphemeralStreamId = 'test/Pombo-DM-2';
            dmManager.inboxEphemeralSubscription = { id: 'sub2' };

            await dmManager.destroy();

            expect(streamrController.unsubscribe).toHaveBeenCalledWith('test/Pombo-DM-2');
        });

        it('should survive unsubscribe errors', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            dmManager.inboxSubscription = { id: 'sub' };
            streamrController.unsubscribe.mockRejectedValue(new Error('Already closed'));

            await dmManager.destroy();

            // Should not throw
            expect(dmManager.inboxSubscription).toBeNull();
        });

        it('should clear dmCrypto caches on destroy', async () => {
            await dmManager.destroy();
            expect(dmCrypto.clear).toHaveBeenCalled();
        });
    });

    // ==================== subscribeDMEphemeral / unsubscribeDMEphemeral ====================
    describe('subscribeDMEphemeral()', () => {
        it('should subscribe to DM-2 on demand', async () => {
            dmManager.inboxEphemeralStreamId = '0xmy/Pombo-DM-2';

            await dmManager.subscribeDMEphemeral();

            // P0: control partition via subscribeWithHistory
            expect(streamrController.subscribeWithHistory).toHaveBeenCalledWith(
                '0xmy/Pombo-DM-2', 0, expect.any(Function), 0, null
            );
            // P1: media signals, P2: media data via subscribeToPartition
            expect(streamrController.subscribeToPartition).toHaveBeenCalledWith(
                '0xmy/Pombo-DM-2', 1, expect.any(Function), null
            );
            expect(streamrController.subscribeToPartition).toHaveBeenCalledWith(
                '0xmy/Pombo-DM-2', 2, expect.any(Function), null
            );
            expect(dmManager.inboxEphemeralSubscription).toBeTruthy();
        });

        it('should skip if already subscribed', async () => {
            dmManager.inboxEphemeralStreamId = '0xmy/Pombo-DM-2';
            dmManager.inboxEphemeralSubscription = { id: 'existing' };

            await dmManager.subscribeDMEphemeral();

            expect(streamrController.subscribeWithHistory).not.toHaveBeenCalled();
        });

        it('should skip if no ephemeral stream ID', async () => {
            dmManager.inboxEphemeralStreamId = null;

            await dmManager.subscribeDMEphemeral();

            expect(streamrController.subscribeWithHistory).not.toHaveBeenCalled();
        });

        it('should survive subscribe failure', async () => {
            dmManager.inboxEphemeralStreamId = '0xmy/Pombo-DM-2';
            streamrController.subscribeWithHistory.mockRejectedValueOnce(new Error('network error'));

            await dmManager.subscribeDMEphemeral();

            expect(dmManager.inboxEphemeralSubscription).toBeNull();
        });
    });

    describe('subscribeDMEphemeral() re-entry', () => {
        // The media partitions can survive a teardown now, so re-opening a DM must not
        // subscribe them a second time — subscribeToPartition does not dedupe.
        it('should not re-subscribe media partitions that are still live', async () => {
            dmManager.inboxEphemeralStreamId = '0xmy/Pombo-DM-2';
            dmManager.inboxEphemeralSubscription = null;
            streamrController.isSubscribedToPartition.mockReturnValue(true);

            await dmManager.subscribeDMEphemeral();

            // Control is always re-subscribed; the media partitions are not
            expect(streamrController.subscribeWithHistory).toHaveBeenCalled();
            expect(streamrController.subscribeToPartition).not.toHaveBeenCalled();

            streamrController.isSubscribedToPartition.mockReturnValue(false);
        });
    });

    describe('unsubscribeDMEphemeral()', () => {
        it('should unsubscribe from DM-2', async () => {
            dmManager.inboxEphemeralStreamId = '0xmy/Pombo-DM-2';
            dmManager.inboxEphemeralSubscription = { id: 'sub' };

            await dmManager.unsubscribeDMEphemeral();

            expect(streamrController.unsubscribe).toHaveBeenCalledWith('0xmy/Pombo-DM-2');
            expect(dmManager.inboxEphemeralSubscription).toBeNull();
        });

        it('should skip if not subscribed', async () => {
            dmManager.inboxEphemeralSubscription = null;

            await dmManager.unsubscribeDMEphemeral();

            expect(streamrController.unsubscribe).not.toHaveBeenCalled();
        });

        // Navigating out of a DM used to drop the whole ephemeral stream, which is
        // where a seeder hears piece requests — the peer's download stalled instantly
        // and only resumed when the user came back to the conversation.
        it('should keep the media partitions alive while a DM transfer is active', async () => {
            dmManager.inboxEphemeralStreamId = '0xmy/Pombo-DM-2';
            dmManager.inboxEphemeralSubscription = { id: 'sub' };
            mediaController.hasActiveDMTransfers.mockReturnValueOnce(true);

            await dmManager.unsubscribeDMEphemeral();

            // Only control (presence/typing) goes; P1/P2 stay up
            expect(streamrController.unsubscribeFromPartition).toHaveBeenCalledWith('0xmy/Pombo-DM-2', 0);
            expect(streamrController.unsubscribe).not.toHaveBeenCalled();
        });

        it('should drop the whole stream when no DM transfer is active', async () => {
            dmManager.inboxEphemeralStreamId = '0xmy/Pombo-DM-2';
            dmManager.inboxEphemeralSubscription = { id: 'sub' };
            mediaController.hasActiveDMTransfers.mockReturnValueOnce(false);

            await dmManager.unsubscribeDMEphemeral();

            expect(streamrController.unsubscribe).toHaveBeenCalledWith('0xmy/Pombo-DM-2');
        });

        // Disconnect is not navigation: preserving partitions there would leak them
        it('should drop everything when forced, even with an active transfer', async () => {
            dmManager.inboxEphemeralStreamId = '0xmy/Pombo-DM-2';
            dmManager.inboxEphemeralSubscription = { id: 'sub' };
            mediaController.hasActiveDMTransfers.mockReturnValueOnce(true);

            await dmManager.unsubscribeDMEphemeral({ force: true });

            expect(streamrController.unsubscribe).toHaveBeenCalledWith('0xmy/Pombo-DM-2');
            expect(streamrController.unsubscribeFromPartition).not.toHaveBeenCalled();
        });

        it('should survive unsubscribe errors', async () => {
            dmManager.inboxEphemeralStreamId = '0xmy/Pombo-DM-2';
            dmManager.inboxEphemeralSubscription = { id: 'sub' };
            streamrController.unsubscribe.mockRejectedValueOnce(new Error('fail'));

            await dmManager.unsubscribeDMEphemeral();

            expect(dmManager.inboxEphemeralSubscription).toBeNull();
        });
    });

    // ==================== routeInboxMessage() ====================
    describe('routeInboxMessage()', () => {
        /**
         * A stray that is already stored cannot be re-routed, so the timeline
         * refuses it at the display boundary too.
         */
        it('keeps a foreign sender out of the timeline it was stored in', async () => {
            const peer = '0xpeer777777777777777777777777777777777777';
            const streamId = peer + '/Pombo-DM-1';
            const channel = { messageStreamId: streamId, type: 'dm', peerAddress: peer, messages: [
                { id: 'ok', text: 'from the peer', _dmReceived: true, account: peer, timestamp: 2 },
                { id: 'stray', text: 'from someone else', _dmReceived: true,
                  account: '0xstranger88888888888888888888888888888888', timestamp: 1 }
            ] };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peer, streamId);

            await dmManager.loadDMTimeline(peer);

            expect(channel.messages.map(m => m.id)).toEqual(['ok']);
        });

        /**
         * The map that used to answer this question is rebuilt from each
         * record's peerAddress, so a record whose two halves disagree made
         * every incoming message from that peer land in another room.
         */
        it('repairs a record whose peerAddress does not match its own stream', () => {
            const peer = '0xpeer555555555555555555555555555555555555';
            const streamId = peer + '/Pombo-DM-1';
            const record = { messageStreamId: streamId, type: 'dm',
                peerAddress: '0xsomeoneelse6666666666666666666666666666', messages: [] };
            channelManager.channels.set(streamId, record);

            dmManager.loadConversationsFromChannels();

            expect(record.peerAddress).toBe(peer);
            expect(dmManager.conversations.get(peer)).toBe(streamId);
            expect(dmManager.conversations.get('0xsomeoneelse6666666666666666666666666666')).toBeUndefined();
        });

        it('should ignore messages without account', async () => {
            await dmManager.routeInboxMessage({});
            await dmManager.routeInboxMessage(null);

            expect(channelManager.notifyHandlers).not.toHaveBeenCalled();
        });

        it('should ignore messages from self', async () => {
            await dmManager.routeInboxMessage({
                account: '0xmyaddress1234567890abcdef12345678',
                id: 'msg-1',
                text: 'echo'
            });

            expect(channelManager.notifyHandlers).not.toHaveBeenCalled();
        });

        it('should route message to existing conversation', async () => {
            const peerAddress = '0xpeer111111111111111111111111111111111111';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            await dmManager.routeInboxMessage({
                account: peerAddress,
                id: 'msg-remote-1',
                text: 'Hello!',
                timestamp: Date.now()
            });

            expect(channel.messages).toHaveLength(1);
            expect(channel.messages[0].text).toBe('Hello!');
            expect(channel.messages[0]._dmReceived).toBe(true);
            expect(channelManager.notifyHandlers).toHaveBeenCalledWith('message', expect.any(Object));
        });

        /**
         * The conversation is derived from the sender, never looked up: a
         * record carried over from an older build can pair a peer address
         * with someone else's stream, and every message from that peer used
         * to be filed in that other conversation.
         */
        it('files a message under its sender even when the map points elsewhere', async () => {
            const peerAddress = '0xpeer333333333333333333333333333333333333';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const strangerStreamId = '0xstranger44444444444444444444444444444444/Pombo-DM-1';
            const mine = { messageStreamId: streamId, type: 'dm', peerAddress, messages: [] };
            const stranger = {
                messageStreamId: strangerStreamId, type: 'dm', peerAddress, messages: []
            };
            channelManager.channels.set(streamId, mine);
            channelManager.channels.set(strangerStreamId, stranger);
            // The state a bad record leaves behind: the peer points at the
            // stranger's conversation.
            dmManager.conversations.set(peerAddress, strangerStreamId);

            await dmManager.routeInboxMessage({
                account: peerAddress, id: 'msg-derived-1', text: 'mine', timestamp: Date.now()
            });

            expect(mine.messages.map(m => m.id)).toEqual(['msg-derived-1']);
            expect(stranger.messages).toHaveLength(0);
        });

        it('should deduplicate messages with same id', async () => {
            const peerAddress = '0xpeer222222222222222222222222222222222222';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: [{ id: 'dup-1', text: 'Already here', timestamp: 1 }]
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            await dmManager.routeInboxMessage({
                account: peerAddress,
                id: 'dup-1',
                text: 'Already here',
                timestamp: 1
            });

            // Should still be 1, not 2
            expect(channel.messages).toHaveLength(1);
        });

        it('should decrypt encrypted messages and strip sender flags', async () => {
            const peerAddress = '0xpeer333333333333333333333333333333333333';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            // Simulate encrypted envelope with sender flags baked in
            dmCrypto.isEncrypted.mockReturnValueOnce(true);
            dmCrypto.decrypt.mockResolvedValueOnce({
                id: 'enc-msg-1',
                text: 'Secret!',
                timestamp: Date.now(),
                sender: peerAddress,
                pending: true,       // sender-side flag (should be stripped)
                _dmSent: true        // sender-side flag (should be stripped)
            });

            await dmManager.routeInboxMessage({
                account: peerAddress,
                ct: 'ciphertext',
                iv: 'iv',
                e: 'aes-256-gcm'
            });

            expect(dmCrypto.decrypt).toHaveBeenCalled();
            expect(channel.messages).toHaveLength(1);
            expect(channel.messages[0].text).toBe('Secret!');
            expect(channel.messages[0]._dmReceived).toBe(true);
            // Sender-side flags must be stripped
            expect(channel.messages[0]._dmSent).toBeUndefined();
            expect(channel.messages[0].pending).toBeUndefined();
            // account must be restored from envelope
            expect(channel.messages[0].account).toBe(peerAddress);
        });

        it('should silently drop messages that fail to decrypt', async () => {
            const peerAddress = '0xpeer444444444444444444444444444444444444';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            dmCrypto.isEncrypted.mockReturnValueOnce(true);
            dmCrypto.decrypt.mockRejectedValueOnce(new Error('Bad ciphertext'));

            await dmManager.routeInboxMessage({
                account: peerAddress,
                ct: 'corrupt',
                iv: 'iv',
                e: 'aes-256-gcm'
            });

            expect(channel.messages).toHaveLength(0);
        });

        it('should route reactions to handleControlMessage instead of messages', async () => {
            const peerAddress = '0xpeer444444444444444444444444444444444444';
            const channel = {
                type: 'dm',
                peerAddress: peerAddress,
                messageStreamId: `${peerAddress}/Pombo-DM-1`,
                messages: [],
                reactions: {}
            };
            channelManager.channels.set(`${peerAddress}/Pombo-DM-1`, channel);
            dmManager.conversations.set(peerAddress, `${peerAddress}/Pombo-DM-1`);

            await dmManager.routeInboxMessage({
                account: peerAddress,
                type: 'reaction',
                messageId: 'msg1',
                emoji: '👍',
                action: 'add',
                timestamp: Date.now()
            });

            // Should NOT be added as a message
            expect(channel.messages).toHaveLength(0);
            // Should be routed to handleControlMessage
            expect(channelManager.handleControlMessage).toHaveBeenCalledWith(
                `${peerAddress}/Pombo-DM-1`,
                expect.objectContaining({
                    type: 'reaction',
                    messageId: 'msg1',
                    emoji: '👍',
                    account: peerAddress
                })
            );
        });

        it('should ignore messages from blocked peers', async () => {
            const peerAddress = '0xblocked11111111111111111111111111111111';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            secureStorage.isBlocked.mockReturnValueOnce(true);

            await dmManager.routeInboxMessage({
                account: peerAddress,
                id: 'blocked-msg-1',
                text: 'You should not see this',
                timestamp: Date.now()
            });

            expect(channel.messages).toHaveLength(0);
            expect(channelManager.notifyHandlers).not.toHaveBeenCalled();
        });

        it('should ignore messages older than dmLeftAt timestamp', async () => {
            const peerAddress = '0xleft22222222222222222222222222222222222222';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            const leaveTs = 1000000;
            secureStorage.getDMLeftAt.mockReturnValueOnce(leaveTs);

            await dmManager.routeInboxMessage({
                account: peerAddress,
                id: 'old-msg',
                text: 'Old message',
                timestamp: leaveTs - 100 // older than leave
            });

            expect(channel.messages).toHaveLength(0);
            expect(secureStorage.clearDMLeftAt).not.toHaveBeenCalled();
        });

        it('should resurface conversation when message is newer than dmLeftAt', async () => {
            const peerAddress = '0xleft33333333333333333333333333333333333333';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            const leaveTs = 1000000;
            secureStorage.getDMLeftAt.mockReturnValueOnce(leaveTs);

            await dmManager.routeInboxMessage({
                account: peerAddress,
                id: 'new-msg',
                text: 'New message!',
                timestamp: leaveTs + 500 // newer than leave
            });

            expect(secureStorage.clearDMLeftAt).toHaveBeenCalledWith(peerAddress);
            expect(channel.messages).toHaveLength(1);
            expect(channel.messages[0].text).toBe('New message!');
        });
    });

    // ==================== routeInboxControl() ====================
    describe('routeInboxControl()', () => {
        it('should ignore messages without account', async () => {
            await dmManager.routeInboxControl({});
            await dmManager.routeInboxControl(null);

            expect(channelManager.handleControlMessage).not.toHaveBeenCalled();
        });

        it('should ignore messages from self', async () => {
            await dmManager.routeInboxControl({
                account: '0xmyaddress1234567890abcdef12345678',
                type: 'typing'
            });

            expect(channelManager.handleControlMessage).not.toHaveBeenCalled();
        });

        it('should ignore messages from unknown senders', async () => {
            await dmManager.routeInboxControl({
                account: '0xunknown',
                type: 'typing'
            });

            expect(channelManager.handleControlMessage).not.toHaveBeenCalled();
        });

        it('should ignore control messages from blocked peers', async () => {
            const peerAddress = '0xblocked55555555555555555555555555555555';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            dmManager.conversations.set(peerAddress, streamId);
            // Control is derived from the sender now, so the conversation
            // has to exist rather than merely be in the map.
            channelManager.channels.set(streamId, { messageStreamId: streamId, type: 'dm', peerAddress, messages: [] });

            secureStorage.isBlocked.mockReturnValueOnce(true);

            await dmManager.routeInboxControl({
                account: peerAddress,
                type: 'typing',
                isTyping: true
            });

            expect(channelManager.handleControlMessage).not.toHaveBeenCalled();
        });

        it('should ignore control messages from soft-left peers', async () => {
            const peerAddress = '0xleft66666666666666666666666666666666666';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            dmManager.conversations.set(peerAddress, streamId);
            // Control is derived from the sender now, so the conversation
            // has to exist rather than merely be in the map.
            channelManager.channels.set(streamId, { messageStreamId: streamId, type: 'dm', peerAddress, messages: [] });

            secureStorage.getDMLeftAt.mockReturnValueOnce(1000);

            await dmManager.routeInboxControl({
                account: peerAddress,
                type: 'typing',
                isTyping: true
            });

            expect(channelManager.handleControlMessage).not.toHaveBeenCalled();
        });

        it('should forward plaintext control message to channelManager', async () => {
            const peerAddress = '0xpeer333333333333333333333333333333333333';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            dmManager.conversations.set(peerAddress, streamId);
            // Control is derived from the sender now, so the conversation
            // has to exist rather than merely be in the map.
            channelManager.channels.set(streamId, { messageStreamId: streamId, type: 'dm', peerAddress, messages: [] });

            const data = { account: peerAddress, type: 'typing', isTyping: true };
            await dmManager.routeInboxControl(data);

            expect(channelManager.handleControlMessage).toHaveBeenCalledWith(streamId, data);
        });

        it('should decrypt encrypted typing and inject user field', async () => {
            const peerAddress = '0xpeer333333333333333333333333333333333333';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            dmManager.conversations.set(peerAddress, streamId);
            // Control is derived from the sender now, so the conversation
            // has to exist rather than merely be in the map.
            channelManager.channels.set(streamId, { messageStreamId: streamId, type: 'dm', peerAddress, messages: [] });

            dmCrypto.isEncrypted.mockReturnValueOnce(true);
            dmCrypto.decrypt.mockResolvedValueOnce({ type: 'typing', timestamp: 12345 });

            await dmManager.routeInboxControl({
                account: peerAddress,
                ct: 'enc', iv: 'iv', e: 'aes-256-gcm'
            });

            expect(dmCrypto.decrypt).toHaveBeenCalled();
            expect(channelManager.handleControlMessage).toHaveBeenCalledWith(
                streamId,
                expect.objectContaining({
                    type: 'typing',
                    account: peerAddress,
                    user: peerAddress
                })
            );
        });

        it('should decrypt encrypted presence and inject userId/address', async () => {
            const peerAddress = '0xpeer333333333333333333333333333333333333';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            dmManager.conversations.set(peerAddress, streamId);
            // Control is derived from the sender now, so the conversation
            // has to exist rather than merely be in the map.
            channelManager.channels.set(streamId, { messageStreamId: streamId, type: 'dm', peerAddress, messages: [] });

            dmCrypto.isEncrypted.mockReturnValueOnce(true);
            dmCrypto.decrypt.mockResolvedValueOnce({ type: 'presence', nickname: 'Bob', lastActive: 99999 });

            await dmManager.routeInboxControl({
                account: peerAddress,
                ct: 'enc', iv: 'iv', e: 'aes-256-gcm'
            });

            expect(channelManager.handleControlMessage).toHaveBeenCalledWith(
                streamId,
                expect.objectContaining({
                    type: 'presence',
                    account: peerAddress,
                    userId: peerAddress,
                    address: peerAddress,
                    nickname: 'Bob'
                })
            );
        });

        it('should silently drop ephemeral that fails to decrypt', async () => {
            const peerAddress = '0xpeer333333333333333333333333333333333333';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            dmManager.conversations.set(peerAddress, streamId);
            // Control is derived from the sender now, so the conversation
            // has to exist rather than merely be in the map.
            channelManager.channels.set(streamId, { messageStreamId: streamId, type: 'dm', peerAddress, messages: [] });

            dmCrypto.isEncrypted.mockReturnValueOnce(true);
            dmCrypto.decrypt.mockRejectedValueOnce(new Error('Bad key'));

            await dmManager.routeInboxControl({
                account: peerAddress,
                ct: 'corrupt', iv: 'iv', e: 'aes-256-gcm'
            });

            expect(channelManager.handleControlMessage).not.toHaveBeenCalled();
        });
    });

    // ==================== subscribeToInbox() ====================
    describe('subscribeToInbox()', () => {
        it('should not subscribe if inbox not initialized', async () => {
            dmManager.inboxMessageStreamId = null;

            await dmManager.subscribeToInbox();

            expect(streamrController.subscribeWithHistory).not.toHaveBeenCalled();
        });

        it('should not double-subscribe', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            dmManager.inboxSubscription = { id: 'existing' };

            await dmManager.subscribeToInbox();

            expect(streamrController.subscribeWithHistory).not.toHaveBeenCalled();
        });

        it('should subscribe to message stream and notification partition', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            dmManager.inboxEphemeralStreamId = 'test/Pombo-DM-2';

            await dmManager.subscribeToInbox();

            // P0 messages via subscribeWithHistory
            expect(streamrController.subscribeWithHistory).toHaveBeenCalledTimes(1);
            expect(dmManager.inboxSubscription).toBeDefined();
            // P3 notifications via subscribeToPartition
            expect(streamrController.subscribeToPartition).toHaveBeenCalledWith(
                'test/Pombo-DM-1',
                3, // NOTIFICATIONS partition
                expect.any(Function),
                null
            );
            expect(dmManager.inboxNotificationSub).toBeDefined();
            expect(dmManager.inboxEphemeralSubscription).toBeNull();
        });

        it('should not subscribe to ephemeral at inbox level (on-demand only)', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            dmManager.inboxEphemeralStreamId = 'test/Pombo-DM-2';

            await dmManager.subscribeToInbox();

            // DM-1 P0 + P3, DM-2 is on-demand
            expect(streamrController.subscribeWithHistory).toHaveBeenCalledTimes(1);
            expect(dmManager.inboxSubscription).toEqual({ id: 'mock-sub' });
            expect(dmManager.inboxEphemeralSubscription).toBeNull();
        });
    });

    // ==================== routeNotification() ====================
    describe('routeNotification()', () => {
        it('should ignore messages without account', async () => {
            await dmManager.routeNotification({});
            expect(notificationManager.handleNotification).not.toHaveBeenCalled();
        });

        it('should ignore own messages', async () => {
            await dmManager.routeNotification({
                account: '0xmyaddress1234567890abcdef12345678'
            });
            expect(notificationManager.handleNotification).not.toHaveBeenCalled();
        });

        it('should ignore blocked peers', async () => {
            secureStorage.isBlocked.mockReturnValueOnce(true);
            await dmManager.routeNotification({
                account: '0xblockedpeer00000000000000000000000000000'
            });
            expect(notificationManager.handleNotification).not.toHaveBeenCalled();
        });

        it('should decrypt and delegate to notificationManager', async () => {
            const data = {
                account: '0xpeer111111111111111111111111111111111111',
                type: 'CHANNEL_INVITE',
                inviteId: 'inv_1'
            };

            await dmManager.routeNotification(data);

            expect(notificationManager.handleNotification).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'CHANNEL_INVITE', inviteId: 'inv_1' })
            );
        });
    });

    // ==================== getOrCreateConversation() ====================
    describe('getOrCreateConversation()', () => {
        beforeEach(() => {
            dmManager.inboxMessageStreamId = '0xmyaddress1234567890abcdef12345678/Pombo-DM-1';
        });

        it('should return existing conversation', async () => {
            const peerAddress = '0xpeer444444444444444444444444444444444444';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = { messageStreamId: streamId, type: 'dm', peerAddress };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            const result = await dmManager.getOrCreateConversation(peerAddress);

            expect(result).toBe(channel);
            // Should NOT call saveChannels (not creating new)
            expect(channelManager.saveChannels).not.toHaveBeenCalled();
        });

        it('should create new conversation for unknown peer', async () => {
            const peerAddress = '0xNewPeer5555555555555555555555555555555555';

            const result = await dmManager.getOrCreateConversation(peerAddress);

            expect(result).toBeDefined();
            expect(result.type).toBe('dm');
            expect(result.peerAddress).toBe(peerAddress.toLowerCase());
            expect(result.messageStreamId).toBe(`${peerAddress.toLowerCase()}/Pombo-DM-1`);
            expect(channelManager.saveChannels).toHaveBeenCalled();
            expect(dmManager.conversations.has(peerAddress.toLowerCase())).toBe(true);
        });

        it('should clean up stale entry and recreate conversation', async () => {
            const peerAddress = '0xstale00000000000000000000000000000000000';
            const streamId = `${peerAddress.toLowerCase()}/Pombo-DM-1`;

            // Stale entry: conversations map has it, but channelManager lost the channel
            dmManager.conversations.set(peerAddress.toLowerCase(), streamId);
            // channelManager.channels does NOT have streamId

            const result = await dmManager.getOrCreateConversation(peerAddress);

            expect(result).toBeDefined();
            expect(result.type).toBe('dm');
            expect(channelManager.saveChannels).toHaveBeenCalled();
            // Should have recreated in channelManager
            expect(channelManager.channels.has(streamId)).toBe(true);
        });

        it('should NOT load sent messages on creation (deferred to loadDMTimeline)', async () => {
            const peerAddress = '0xpeer666666666666666666666666666666666666';
            secureStorage.getSentMessages.mockReturnValue([
                { id: 'sent-1', text: 'Hi', timestamp: 1 }
            ]);

            const result = await dmManager.getOrCreateConversation(peerAddress);

            // Messages are loaded via loadDMTimeline(), not here
            expect(result.messages).toHaveLength(0);
            secureStorage.getSentMessages.mockReturnValue([]);
        });
    });

    // ==================== sendMessage() ====================
    describe('sendMessage()', () => {
        it('should throw for non-DM channel', async () => {
            channelManager.channels.set('regular-stream', { type: 'open' });

            await expect(dmManager.sendMessage('regular-stream', 'Hello'))
                .rejects.toThrow('DM channel not found');
        });

        it('should publish message to peer inbox', async () => {
            const peerAddress = '0xpeer777777777777777777777777777777777777';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            });

            await dmManager.sendMessage(streamId, 'Hello peer!');

            // Sealed sender: the envelope goes out under a throwaway identity,
            // so the inbox stream no longer carries the sender-recipient edge.
            expect(dmCrypto.seal).toHaveBeenCalled();
            expect(streamrController.publishAs).toHaveBeenCalledWith(
                expect.anything(),                                  // ephemeral identity
                streamId,
                expect.any(Number),
                expect.objectContaining({ v: 2, epk: expect.any(String) })
            );
        });

        it('should strip local-only flags from encrypted payload', async () => {
            const peerAddress = '0xpeerbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            });

            await dmManager.sendMessage(streamId, 'Clean payload');

            // Verify seal was called with a clean message (no sender-only flags)
            const sealedInput = dmCrypto.seal.mock.calls[0][0];
            expect(sealedInput.text).toBe('Clean payload');
            expect(sealedInput.pending).toBeUndefined();
            expect(sealedInput._dmSent).toBeUndefined();
            expect(sealedInput.verified).toBeUndefined();
        });

        it('should persist sent message to secureStorage', async () => {
            const peerAddress = '0xpeer888888888888888888888888888888888888';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            });

            await dmManager.sendMessage(streamId, 'Saved locally');

            expect(secureStorage.addSentMessage).toHaveBeenCalledWith(
                streamId,
                expect.objectContaining({ text: 'Saved locally' })
            );
        });

        it('should add message to channel.messages immediately', async () => {
            const peerAddress = '0xpeer999999999999999999999999999999999999';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            };
            channelManager.channels.set(streamId, channel);

            await dmManager.sendMessage(streamId, 'Instant');

            expect(channel.messages).toHaveLength(1);
            expect(channel.messages[0]._dmSent).toBe(true);
        });

        it('should throw when peer public key not available (no plaintext fallback)', async () => {
            const peerAddress = '0xpeeraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            });

            streamrController.getDMPublicKey.mockResolvedValueOnce(null);
            dmCrypto.peerPublicKeys.clear();

            await expect(dmManager.sendMessage(streamId, 'Should fail'))
                .rejects.toThrow('peer public key not available');

            // Must NOT have published anything
            expect(streamrController.publishAs).not.toHaveBeenCalled();
        });

        it('should throw when wallet private key is missing', async () => {
            const peerAddress = '0xpeeraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            });

            const original = authManager.wallet;
            authManager.wallet = null;

            await expect(dmManager.sendMessage(streamId, 'Should fail'))
                .rejects.toThrow('wallet private key not available');

            expect(streamrController.publishAs).not.toHaveBeenCalled();
            authManager.wallet = original;
        });

        it('should notify message_failed on encryption error', async () => {
            const peerAddress = '0xpeeraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            });

            streamrController.getDMPublicKey.mockResolvedValueOnce(null);
            dmCrypto.peerPublicKeys.clear();

            await expect(dmManager.sendMessage(streamId, 'Fail')).rejects.toThrow();

            expect(channelManager.notifyHandlers).toHaveBeenCalledWith(
                'message_failed',
                expect.objectContaining({ error: expect.stringContaining('peer public key') })
            );
        });

        it('should send wake signals after sending', async () => {
            const peerAddress = '0xpeeraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: []
            });

            await dmManager.sendMessage(streamId, 'Wake up!');

            expect(channelManager.sendWakeSignals).toHaveBeenCalledWith(streamId);
        });
    });

    // ==================== loadDMTimeline() ====================
    describe('loadDMTimeline()', () => {
        it('should merge sent and received messages', async () => {
            const peerAddress = '0xpeerbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: [
                    { id: 'recv-1', text: 'From peer', timestamp: 2, _dmReceived: true },
                    { id: 'recv-2', text: 'From peer 2', timestamp: 4, _dmReceived: true }
                ]
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            secureStorage.getSentMessages.mockReturnValue([
                { id: 'sent-1', text: 'From me', timestamp: 1 },
                { id: 'sent-2', text: 'From me 2', timestamp: 3 }
            ]);

            await dmManager.loadDMTimeline(peerAddress);

            expect(channel.messages).toHaveLength(4);
            // Should be sorted by timestamp
            expect(channel.messages[0].id).toBe('sent-1');
            expect(channel.messages[1].id).toBe('recv-1');
            expect(channel.messages[2].id).toBe('sent-2');
            expect(channel.messages[3].id).toBe('recv-2');

            secureStorage.getSentMessages.mockReturnValue([]);
        });

        it('should deduplicate by id', async () => {
            const peerAddress = '0xpeercccccccccccccccccccccccccccccccccc';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: [
                    { id: 'dup-1', text: 'Received copy', timestamp: 1, _dmReceived: true }
                ]
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            secureStorage.getSentMessages.mockReturnValue([
                { id: 'dup-1', text: 'Sent copy', timestamp: 1 }
            ]);

            await dmManager.loadDMTimeline(peerAddress);

            // Should only have 1 message (deduplicated)
            expect(channel.messages).toHaveLength(1);

            secureStorage.getSentMessages.mockReturnValue([]);
        });

        it('should do nothing for unknown conversation', async () => {
            await dmManager.loadDMTimeline('0xunknownpeer');
            // No crash
        });

        it('should merge sent reactions from local storage', async () => {
            const peerAddress = '0xpeerdddddddddddddddddddddddddddddddddd';
            const streamId = `${peerAddress}/Pombo-DM-1`;
            const channel = {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: [{ id: 'msg-1', text: 'Hello', timestamp: 1, _dmReceived: true }],
                reactions: { 'msg-1': { '👍': ['0xotherpeer'] } }
            };
            channelManager.channels.set(streamId, channel);
            dmManager.conversations.set(peerAddress, streamId);

            // Mock: we sent a reaction locally
            secureStorage.getSentReactions.mockReturnValue({
                'msg-1': { '👍': ['0xmyaddress1234567890abcdef12345678'], '❤️': ['0xmyaddress1234567890abcdef12345678'] }
            });

            await dmManager.loadDMTimeline(peerAddress);

            // Should merge without duplicates
            expect(channel.reactions['msg-1']['👍']).toContain('0xotherpeer');
            expect(channel.reactions['msg-1']['👍']).toContain('0xmyaddress1234567890abcdef12345678');
            expect(channel.reactions['msg-1']['👍']).toHaveLength(2);
            expect(channel.reactions['msg-1']['❤️']).toContain('0xmyaddress1234567890abcdef12345678');

            secureStorage.getSentReactions.mockReturnValue({});
        });
    });

    // ==================== Event handlers ====================
    describe('onEvent / notifyHandlers', () => {
        it('should register and call event handlers', () => {
            const handler = vi.fn();
            dmManager.onEvent(handler);

            dmManager.notifyHandlers('test_event', { data: 'value' });

            expect(handler).toHaveBeenCalledWith('test_event', { data: 'value' });
        });

        it('should survive handler errors', () => {
            const badHandler = vi.fn().mockImplementation(() => { throw new Error('Handler error'); });
            const goodHandler = vi.fn();
            dmManager.onEvent(badHandler);
            dmManager.onEvent(goodHandler);

            dmManager.notifyHandlers('event', {});

            expect(goodHandler).toHaveBeenCalled();
        });
    });

    // ==================== isDMChannel() ====================
    describe('isDMChannel()', () => {
        it('should return true for DM channels', () => {
            channelManager.channels.set('dm-stream', { type: 'dm' });
            expect(dmManager.isDMChannel('dm-stream')).toBe(true);
        });

        it('should return false for non-DM channels', () => {
            channelManager.channels.set('open-stream', { type: 'open' });
            expect(dmManager.isDMChannel('open-stream')).toBe(false);
        });

        it('should return false for unknown channels', () => {
            expect(dmManager.isDMChannel('nonexistent')).toBeFalsy();
        });
    });

    // ==================== getConversations() ====================
    describe('getConversations()', () => {
        it('should return empty array when no conversations', () => {
            expect(dmManager.getConversations()).toEqual([]);
        });

        it('should return conversations sorted by last message (newest first)', () => {
            const channelA = { messageStreamId: 'a', messages: [{ timestamp: 100 }], createdAt: 50 };
            const channelB = { messageStreamId: 'b', messages: [{ timestamp: 300 }], createdAt: 60 };
            const channelC = { messageStreamId: 'c', messages: [], createdAt: 200 };

            channelManager.channels.set('a', channelA);
            channelManager.channels.set('b', channelB);
            channelManager.channels.set('c', channelC);

            dmManager.conversations.set('0xpeer-a', 'a');
            dmManager.conversations.set('0xpeer-b', 'b');
            dmManager.conversations.set('0xpeer-c', 'c');

            const result = dmManager.getConversations();

            expect(result).toHaveLength(3);
            // B (300) > C (200 createdAt) > A (100)
            expect(result[0]).toBe(channelB);
            expect(result[1]).toBe(channelC);
            expect(result[2]).toBe(channelA);
        });

        it('should clean up orphaned conversation entries', () => {
            // Setup: conversation map has entry, but channel doesn't exist in channelManager
            dmManager.conversations.set('0xorphanpeer', 'orphan-stream-id');
            // channelManager.channels does NOT have 'orphan-stream-id'

            const result = dmManager.getConversations();

            expect(result).toHaveLength(0);
            expect(dmManager.conversations.has('0xorphanpeer')).toBe(false);
        });
    });

    // ==================== startDM() ====================
    describe('startDM()', () => {
        beforeEach(() => {
            dmManager.inboxMessageStreamId = '0xmyaddress1234567890abcdef12345678/Pombo-DM-1';
        });

        it('should reject DM to self', async () => {
            authManager.getAddress.mockReturnValue('0x1234567890abcdef1234567890abcdef12345678');
            await expect(dmManager.startDM('0x1234567890abcdef1234567890abcdef12345678'))
                .rejects.toThrow('Cannot send a DM to yourself');
            authManager.getAddress.mockReturnValue('0xmyaddress1234567890abcdef12345678');
        });

        it('should reject invalid address', async () => {
            await expect(dmManager.startDM('not-an-address'))
                .rejects.toThrow('Invalid Ethereum address');
        });

        it('should create conversation and switch channel', async () => {
            const peerAddress = '0xdddddddddddddddddddddddddddddddddddddddd';

            // Peer's inbox must exist for startDM to proceed
            streamrController.client.getStream.mockResolvedValueOnce({ id: `${peerAddress.toLowerCase()}/Pombo-DM-1` });

            const result = await dmManager.startDM(peerAddress);

            expect(result).toBeDefined();
            expect(result.type).toBe('dm');
            expect(channelManager.setCurrentChannel).toHaveBeenCalled();
            expect(channelManager.notifyHandlers).toHaveBeenCalledWith('channelSwitched', expect.any(Object));
        });
    });

    // ==================== hasInbox() ====================
    describe('hasInbox()', () => {
        beforeEach(() => {
            // Reset positive-result cache (singleton persists across tests)
            dmManager._inboxExistsCache = null;
        });

        it('should return false when inbox not initialized', async () => {
            dmManager.inboxMessageStreamId = null;
            expect(await dmManager.hasInbox()).toBe(false);
        });

        it('should return true when stream exists', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            streamrController.client.getStream.mockResolvedValue({ id: 'test/Pombo-DM-1' });

            expect(await dmManager.hasInbox()).toBe(true);
        });

        it('should cache a positive result and skip the network check', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            streamrController.client.getStream.mockResolvedValue({ id: 'test/Pombo-DM-1' });

            await dmManager.hasInbox();
            streamrController.client.getStream.mockClear();

            expect(await dmManager.hasInbox()).toBe(true);
            expect(streamrController.client.getStream).not.toHaveBeenCalled();
        });

        it('should re-check on every call after a negative result', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            streamrController.client.getStream.mockRejectedValue(new Error('not found'));

            expect(await dmManager.hasInbox()).toBe(false);

            streamrController.client.getStream.mockResolvedValue({ id: 'test/Pombo-DM-1' });
            expect(await dmManager.hasInbox()).toBe(true);
        });

        it('should return false when stream does not exist', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            streamrController.client.getStream.mockRejectedValue(new Error('not found'));

            expect(await dmManager.hasInbox()).toBe(false);
        });
    });

    // ==================== createInbox() ====================
    describe('createInbox()', () => {
        it('should create inbox and subscribe', async () => {
            const result = await dmManager.createInbox();

            expect(result.messageStreamId).toContain('Pombo-DM-1');
            expect(result.ephemeralStreamId).toContain('Pombo-DM-2');
            expect(dmManager.inboxReady).toBe(true);
            expect(streamrController.subscribeWithHistory).toHaveBeenCalled();
        });
    });

    // ==================== subscribeInboxPush() ====================
    describe('subscribeInboxPush()', () => {
        beforeEach(() => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            relayManager.enabled = true;
            relayManager.subscribeToChannel.mockClear();
            
            // Mock localStorage
            global.localStorage = {
                getItem: vi.fn(),
                setItem: vi.fn(),
                removeItem: vi.fn()
            };
        });

        afterEach(() => {
            relayManager.enabled = false;
        });

        it('should skip if no inbox stream ID', async () => {
            dmManager.inboxMessageStreamId = null;

            await dmManager.subscribeInboxPush();

            expect(relayManager.subscribeToChannel).not.toHaveBeenCalled();
        });

        it('should skip if relay manager is not enabled', async () => {
            relayManager.enabled = false;

            await dmManager.subscribeInboxPush();

            expect(relayManager.subscribeToChannel).not.toHaveBeenCalled();
        });

        it('should skip if user preference is disabled (no force)', async () => {
            global.localStorage.getItem.mockReturnValue('false');

            await dmManager.subscribeInboxPush();

            expect(relayManager.subscribeToChannel).not.toHaveBeenCalled();
        });

        it('should skip if user preference is not set (no force)', async () => {
            global.localStorage.getItem.mockReturnValue(null);

            await dmManager.subscribeInboxPush();

            expect(relayManager.subscribeToChannel).not.toHaveBeenCalled();
        });

        it('should subscribe if user preference is enabled', async () => {
            global.localStorage.getItem.mockReturnValue('true');

            await dmManager.subscribeInboxPush();

            expect(relayManager.subscribeToChannel).toHaveBeenCalledWith('test/Pombo-DM-1');
        });

        it('should subscribe when force=true ignoring preference', async () => {
            global.localStorage.getItem.mockReturnValue('false');

            await dmManager.subscribeInboxPush(true);

            expect(relayManager.subscribeToChannel).toHaveBeenCalledWith('test/Pombo-DM-1');
        });

        it('should use lowercase address for preference key', async () => {
            authManager.getAddress.mockReturnValue('0xMYADDRESS1234');
            global.localStorage.getItem.mockReturnValue('true');

            await dmManager.subscribeInboxPush();

            expect(global.localStorage.getItem).toHaveBeenCalledWith('pombo_dm_push_0xmyaddress1234');
        });
    });

    // ==================== routeInboxMedia() ====================
    describe('routeInboxMedia()', () => {
        const peerAddress = '0xpeeraddress1234567890abcdef12345678';
        const peerInboxId = `${peerAddress}/Pombo-DM-1`;

        beforeEach(() => {
            // Setup a conversation
            dmManager.conversations.set(peerAddress, peerInboxId);
            channelManager.channels.set(peerInboxId, {
                messageStreamId: peerInboxId,
                type: 'dm',
                peerAddress
            });
            streamrController.getDMPublicKey.mockResolvedValue('0x02peerpubkey');
        });

        afterEach(() => {
            // isSealed is consulted twice per call, so mockReturnValueOnce is not
            // enough — reset it here or later suites route down the sealed path.
            dmCrypto.isSealed.mockReturnValue(false);
            dmCrypto.isSealedBinary.mockReturnValue(false);
            if (dmManager.openDMEnvelope.mockRestore) dmManager.openDMEnvelope.mockRestore();
        });

        it('should open a sealed binary piece and route it by the proved sender', async () => {
            // Binary carries no JSON, so the proof rides inside the ciphertext.
            // Opening yields the real sender; the publisherId is a throwaway.
            const sealedPiece = new Uint8Array([0x02, ...new Array(200).fill(7)]);
            dmCrypto.isSealedBinary.mockReturnValue(true);
            dmCrypto.openBinary.mockResolvedValue({
                sender: peerAddress,
                bytes: new Uint8Array([10, 20, 30])
            });

            await dmManager.routeInboxMedia(sealedPiece, '0xthrowawaypublisher00000000000000000000');

            expect(dmCrypto.decryptBinary).not.toHaveBeenCalled();
            expect(mediaController.handleMediaMessage).toHaveBeenCalledWith(
                peerInboxId, new Uint8Array([10, 20, 30]), peerAddress
            );
        });

        it('should fall back to legacy when a binary only looks sealed', async () => {
            // A v1 binary starts with a random IV byte, so 1 in 256 matches the
            // version check. Failing to open must not drop the piece.
            const legacyPiece = new Uint8Array([0x02, ...new Array(200).fill(3)]);
            dmCrypto.isSealedBinary.mockReturnValue(true);
            dmCrypto.openBinary.mockRejectedValue(new Error('bad auth tag'));
            dmCrypto.decryptBinary.mockResolvedValue(new Uint8Array([1, 2, 3]));

            await dmManager.routeInboxMedia(legacyPiece, peerAddress);

            expect(dmCrypto.decryptBinary).toHaveBeenCalled();
            expect(mediaController.handleMediaMessage).toHaveBeenCalledWith(
                peerInboxId, new Uint8Array([1, 2, 3]), peerAddress
            );
        });

        it('should forward JSON signal to mediaController', async () => {
            const data = { type: 'image_request', imageId: 'img-1', account: peerAddress };
            await dmManager.routeInboxMedia(data);

            expect(mediaController.handleMediaMessage).toHaveBeenCalledWith(
                peerInboxId, data, peerAddress
            );
        });

        it('should open a sealed signal before resolving the conversation', async () => {
            // The publisherId on a sealed signal is a throwaway key. Resolving
            // the conversation from it finds nothing, so the signal must be
            // opened first and routed by the sender proved inside.
            const envelope = { v: 2, epk: '0x02epk', ct: 'sealed', iv: 'iv', e: 'aes-256-gcm' };
            dmCrypto.isSealed.mockReturnValue(true);
            vi.spyOn(dmManager, 'openDMEnvelope').mockResolvedValue({
                type: 'source_announce', fileId: 'f1', account: peerAddress
            });

            await dmManager.routeInboxMedia(envelope, '0xthrowawaypublisher00000000000000000000');

            expect(dmManager.openDMEnvelope).toHaveBeenCalledWith(envelope);
            expect(mediaController.handleMediaMessage).toHaveBeenCalledWith(
                peerInboxId,
                expect.objectContaining({ type: 'source_announce', fileId: 'f1' }),
                peerAddress
            );
        });

        it('should drop a sealed signal it cannot open', async () => {
            dmCrypto.isSealed.mockReturnValue(true);
            vi.spyOn(dmManager, 'openDMEnvelope').mockResolvedValue(null);

            await dmManager.routeInboxMedia({ v: 2, ct: 'nope' }, peerAddress);

            expect(mediaController.handleMediaMessage).not.toHaveBeenCalled();
        });

        it('should forward binary data with ECDH decryption to mediaController', async () => {
            const binaryData = new Uint8Array([0x01, 10, 20, 30]);
            // decryptBinary mock strips first byte
            dmCrypto.decryptBinary.mockResolvedValue(new Uint8Array([10, 20, 30]));

            await dmManager.routeInboxMedia(binaryData, peerAddress);

            expect(dmCrypto.decryptBinary).toHaveBeenCalledWith(binaryData, 'mock-aes-key');
            expect(mediaController.handleMediaMessage).toHaveBeenCalledWith(
                peerInboxId, new Uint8Array([10, 20, 30]), peerAddress
            );
        });

        it('should decrypt encrypted JSON signal with ECDH key', async () => {
            const envelope = { ct: 'enc', iv: 'iv', e: 'aes-256-gcm', account: peerAddress };
            dmCrypto.isEncrypted.mockReturnValue(true);
            dmCrypto.decrypt.mockResolvedValue({ type: 'piece_request', fileId: 'f1' });

            await dmManager.routeInboxMedia(envelope);

            expect(dmCrypto.getSharedKey).toHaveBeenCalled();
            expect(dmCrypto.decrypt).toHaveBeenCalledWith(envelope, 'mock-aes-key');
            const calledData = mediaController.handleMediaMessage.mock.calls[0][1];
            expect(calledData.type).toBe('piece_request');
            expect(calledData.account).toBe(peerAddress);
        });

        it('should decrypt binary with ECDH decryptBinary', async () => {
            const encrypted = new Uint8Array([0xFF, 0x01, 10, 20]);
            dmCrypto.decryptBinary.mockResolvedValue(new Uint8Array([0x01, 10, 20]));

            await dmManager.routeInboxMedia(encrypted, peerAddress);

            expect(dmCrypto.decryptBinary).toHaveBeenCalledWith(encrypted, 'mock-aes-key');
            const calledData = mediaController.handleMediaMessage.mock.calls[0][1];
            expect(calledData).toEqual(new Uint8Array([0x01, 10, 20]));
        });

        it('should ignore messages from self', async () => {
            const data = { type: 'image_request', account: '0xmyaddress1234567890abcdef12345678' };
            await dmManager.routeInboxMedia(data);

            expect(mediaController.handleMediaMessage).not.toHaveBeenCalled();
        });

        it('should ignore messages without account', async () => {
            await dmManager.routeInboxMedia({});

            expect(mediaController.handleMediaMessage).not.toHaveBeenCalled();
        });

        it('should ignore messages from blocked senders', async () => {
            secureStorage.isBlocked.mockReturnValue(true);
            const data = { type: 'image_request', account: peerAddress };
            await dmManager.routeInboxMedia(data);

            expect(mediaController.handleMediaMessage).not.toHaveBeenCalled();
            secureStorage.isBlocked.mockReturnValue(false);
        });

        it('should ignore messages from unknown senders', async () => {
            const data = { type: 'image_request', account: '0xunknownpeer' };
            await dmManager.routeInboxMedia(data);

            expect(mediaController.handleMediaMessage).not.toHaveBeenCalled();
        });

        it('should silently skip decryption when peer public key unavailable', async () => {
            dmCrypto.peerPublicKeys.clear();
            streamrController.getDMPublicKey.mockResolvedValue(null);
            const data = { type: 'source_announce', account: peerAddress };
            await dmManager.routeInboxMedia(data);

            expect(dmCrypto.decrypt).not.toHaveBeenCalled();
            expect(mediaController.handleMediaMessage).toHaveBeenCalled();
        });

        it('should return early on decryption failure', async () => {
            const envelope = { ct: 'bad', iv: 'iv', e: 'aes-256-gcm', account: peerAddress };
            dmCrypto.isEncrypted.mockReturnValue(true);
            dmCrypto.decrypt.mockRejectedValue(new Error('Auth tag mismatch'));

            await dmManager.routeInboxMedia(envelope);

            expect(mediaController.handleMediaMessage).not.toHaveBeenCalled();
        });
    });

    // ==================== diagnoseInbox() / repairInbox() ====================
    describe('diagnoseInbox()', () => {
        beforeEach(() => {
            authManager.getAddress.mockReturnValue('0xmyaddress1234567890abcdef12345678');
        });

        it('should throw if no wallet connected', async () => {
            authManager.getAddress.mockReturnValueOnce(null);
            await expect(dmManager.diagnoseInbox()).rejects.toThrow('No wallet connected');
        });

        it('should delegate to streamrController.diagnoseInbox', async () => {
            streamrController.diagnoseInbox.mockResolvedValueOnce({ ok: true, missing: [] });
            const result = await dmManager.diagnoseInbox();
            expect(streamrController.diagnoseInbox).toHaveBeenCalledWith(
                '0xmyaddress1234567890abcdef12345678'
            );
            expect(result).toEqual({ ok: true, missing: [] });
        });
    });

    describe('repairInbox()', () => {
        it('should run repair, set state and re-subscribe', async () => {
            const diagnosis = { missing: ['storage'] };
            const onStep = vi.fn();
            const result = await dmManager.repairInbox(diagnosis, {}, onStep);

            expect(streamrController.repairInbox).toHaveBeenCalledWith(
                diagnosis, '0x02abc123', {}, onStep
            );
            expect(dmManager.inboxReady).toBe(true);
            expect(dmManager.inboxMessageStreamId).toContain('Pombo-DM-1');
            expect(result.messageStreamId).toContain('Pombo-DM-1');
            // re-subscribe attempted
            expect(streamrController.subscribeWithHistory).toHaveBeenCalled();
        });

        it('should default onStep to a no-op when omitted', async () => {
            const diagnosis = { missing: [] };
            await expect(dmManager.repairInbox(diagnosis, {})).resolves.toBeDefined();
        });
    });

    // ==================== subscribeNotifications / unsubscribeNotifications ====================
    describe('subscribeNotifications()', () => {
        it('should no-op if no inbox', async () => {
            await dmManager.subscribeNotifications();
            expect(streamrController.subscribeToPartition).not.toHaveBeenCalled();
        });

        it('should no-op if already subscribed', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            dmManager.inboxNotificationSub = { id: 'existing' };
            await dmManager.subscribeNotifications();
            expect(streamrController.subscribeToPartition).not.toHaveBeenCalled();
        });

        it('should subscribe to notification partition (P3)', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            await dmManager.subscribeNotifications();
            expect(streamrController.subscribeToPartition).toHaveBeenCalledWith(
                'test/Pombo-DM-1', 3, expect.any(Function), null
            );
            expect(dmManager.inboxNotificationSub).toBeTruthy();

            // Invoke the captured callback to cover the inline arrow
            const cb = streamrController.subscribeToPartition.mock.calls[0][2];
            await cb({ /* no account */ }); // returns early — covers route
        });

        it('should handle subscribeToPartition error gracefully', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            streamrController.subscribeToPartition.mockRejectedValueOnce(new Error('boom'));
            await dmManager.subscribeNotifications();
            expect(dmManager.inboxNotificationSub).toBeNull();
        });
    });

    describe('unsubscribeNotifications()', () => {
        it('should no-op if not subscribed', async () => {
            dmManager.inboxNotificationSub = null;
            await dmManager.unsubscribeNotifications();
            expect(streamrController.unsubscribeFromPartition).not.toHaveBeenCalled();
        });

        it('should unsubscribe from P3 and clear state', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            dmManager.inboxNotificationSub = { id: 'sub' };
            await dmManager.unsubscribeNotifications();
            expect(streamrController.unsubscribeFromPartition).toHaveBeenCalledWith(
                'test/Pombo-DM-1', 3
            );
            expect(dmManager.inboxNotificationSub).toBeNull();
        });

        it('should survive unsubscribe errors', async () => {
            dmManager.inboxMessageStreamId = 'test/Pombo-DM-1';
            dmManager.inboxNotificationSub = { id: 'sub' };
            streamrController.unsubscribeFromPartition.mockRejectedValueOnce(new Error('fail'));
            await dmManager.unsubscribeNotifications();
            expect(dmManager.inboxNotificationSub).toBeNull();
        });
    });

    // ==================== sendEdit / sendDelete ====================
    describe('sendEdit()', () => {
        const peerAddress = '0xpeeredit11111111111111111111111111111111';
        const streamId = `${peerAddress}/Pombo-DM-1`;

        beforeEach(() => {
            authManager.getAddress.mockReturnValue('0xmyaddress1234567890abcdef12345678');
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: [{
                    id: 'm-1',
                    sender: '0xmyaddress1234567890abcdef12345678',
                    text: 'hello',
                    timestamp: 1
                }]
            });
        });

        it('should throw if channel missing or not a DM', async () => {
            await expect(dmManager.sendEdit('nope', 'm-1', 'x'))
                .rejects.toThrow('DM channel not found');
        });

        it('should throw if message not found', async () => {
            await expect(dmManager.sendEdit(streamId, 'no-such', 'x'))
                .rejects.toThrow('Message not found');
        });

        it('should throw when editing someone else\'s message', async () => {
            const ch = channelManager.channels.get(streamId);
            ch.messages[0].sender = '0xotherpeer';
            await expect(dmManager.sendEdit(streamId, 'm-1', 'x'))
                .rejects.toThrow('Can only edit your own messages');
        });

        it('should publish edit override and apply locally', async () => {
            await dmManager.sendEdit(streamId, 'm-1', '  edited  ');
            const ch = channelManager.channels.get(streamId);
            expect(ch.messages[0].text).toBe('edited');
            expect(ch.messages[0]._edited).toBe(true);
            expect(secureStorage.updateSentMessage).toHaveBeenCalledWith(
                streamId, 'm-1', expect.objectContaining({ text: 'edited', _edited: true })
            );
            expect(streamrController.publishAs).toHaveBeenCalled();
        });

        it('should throw when peer pub key is missing', async () => {
            streamrController.getDMPublicKey.mockResolvedValueOnce(null);
            dmCrypto.peerPublicKeys.clear();
            await expect(dmManager.sendEdit(streamId, 'm-1', 'x'))
                .rejects.toThrow('peer public key not available');
        });

        it('should not mutate local state when publish fails', async () => {
            streamrController.publishAs.mockRejectedValueOnce(new Error('network down'));

            await expect(dmManager.sendEdit(streamId, 'm-1', 'new text'))
                .rejects.toThrow('network down');

            // Publish-first: local state must be untouched on failure
            const ch = channelManager.channels.get(streamId);
            expect(ch.messages[0].text).toBe('hello');
            expect(ch.messages[0]._edited).toBeUndefined();
            expect(secureStorage.updateSentMessage).not.toHaveBeenCalled();
        });
    });

    describe('sendDelete()', () => {
        const peerAddress = '0xpeerdel111111111111111111111111111111111';
        const streamId = `${peerAddress}/Pombo-DM-1`;

        beforeEach(() => {
            authManager.getAddress.mockReturnValue('0xmyaddress1234567890abcdef12345678');
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: [{
                    id: 'm-1',
                    sender: '0xmyaddress1234567890abcdef12345678',
                    text: 'hello',
                    timestamp: 1
                }]
            });
        });

        it('should throw if channel missing or not a DM', async () => {
            await expect(dmManager.sendDelete('nope', 'm-1'))
                .rejects.toThrow('DM channel not found');
        });

        it('should throw if message not found', async () => {
            await expect(dmManager.sendDelete(streamId, 'no-such'))
                .rejects.toThrow('Message not found');
        });

        it('should throw when deleting someone else\'s message', async () => {
            const ch = channelManager.channels.get(streamId);
            ch.messages[0].sender = '0xotherpeer';
            await expect(dmManager.sendDelete(streamId, 'm-1'))
                .rejects.toThrow('Can only delete your own messages');
        });

        it('should remove message locally and publish delete override', async () => {
            await dmManager.sendDelete(streamId, 'm-1');
            const ch = channelManager.channels.get(streamId);
            expect(ch.messages).toHaveLength(0);
            expect(secureStorage.removeSentMessage).toHaveBeenCalledWith(streamId, 'm-1');
            expect(streamrController.publishAs).toHaveBeenCalled();
        });

        it('should throw when peer pub key is missing', async () => {
            streamrController.getDMPublicKey.mockResolvedValueOnce(null);
            dmCrypto.peerPublicKeys.clear();
            await expect(dmManager.sendDelete(streamId, 'm-1'))
                .rejects.toThrow('peer public key not available');
        });

        it('should not remove the message locally when publish fails', async () => {
            streamrController.publishAs.mockRejectedValueOnce(new Error('network down'));

            await expect(dmManager.sendDelete(streamId, 'm-1'))
                .rejects.toThrow('network down');

            // Publish-first: local state must be untouched on failure
            const ch = channelManager.channels.get(streamId);
            expect(ch.messages).toHaveLength(1);
            expect(secureStorage.removeSentMessage).not.toHaveBeenCalled();
        });
    });

    describe('purge in DMs', () => {
        const peerAddress = '0xpeerpurge11111111111111111111111111111';
        const streamId = `${peerAddress}/Pombo-DM-1`;
        const me = '0xmyaddress1234567890abcdef12345678';
        const provider = { nodeAddress: '0xprov', urls: ['https://p.example'] };

        beforeEach(() => {
            purgeGroupsMock.mockReset();
            eraseMessageMock.mockReset();
            authManager.getAddress.mockReturnValue(me);
            dmManager.sentRows.clear();
            dmManager.inboxMessageStreamId = `${me}/Pombo-DM-1`;
            dmManager.inboxPurgeProviders = [provider];
            channelManager.channels.set(streamId, {
                streamId,
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                purgeProviders: [provider],
                messages: [
                    { id: 'm-1', sender: me, text: 'mine', timestamp: 1 },
                    { id: 'r-1', sender: peerAddress, text: 'theirs', timestamp: 2, _dmReceived: true, _timestamp: 700, _seq: 0 }
                ]
            });
        });

        it('remembers the row and key of each sealed publish, and deleting purges them chunks first', async () => {
            streamrController.publishAs.mockResolvedValueOnce({ messageId: { publisherId: '0xE', timestamp: 555 } });
            await dmManager.sealAndPublish(streamId, peerAddress, { id: 'm-1', type: 'text', text: 'mine' });
            dmManager.rememberFileRows('m-1', [
                { streamId, partition: 4, timestamp: 900, sequenceNumber: 0 },
                { streamId, partition: 5, timestamp: 901, sequenceNumber: 0 }
            ], '0x' + '33'.repeat(32));
            expect(dmManager.canPurge(streamId, 'm-1')).toBe(true);
            expect(dmManager.canPurge(streamId, 'r-1')).toBe(false);

            purgeGroupsMock.mockResolvedValue({ providers: 1, erasedOn: 1, forbiddenOn: 0, unreachable: 0, targets: 3 });
            const outcome = await dmManager.sendDelete(streamId, 'm-1');
            expect(outcome).toMatchObject({ erasedOn: 1 });
            expect(purgeGroupsMock).toHaveBeenCalledTimes(1);
            const [sid, groups] = purgeGroupsMock.mock.calls[0];
            expect(sid).toBe(streamId);
            expect(groups.map((g) => [g.partition, g.targets, g.signer.address])).toEqual([
                [4, [{ timestamp: 900, sequenceNumber: 0 }], 'signer:0x' + '33'.repeat(32)],
                [5, [{ timestamp: 901, sequenceNumber: 0 }], 'signer:0x' + '33'.repeat(32)],
                [0, [{ timestamp: 555, sequenceNumber: 0 }], 'signer:0x' + '11'.repeat(32)]
            ]);
            expect(dmManager.canPurge(streamId, 'm-1')).toBe(false);
        });

        it('deleting a message sent in another session publishes the override and leaves storage alone', async () => {
            const outcome = await dmManager.sendDelete(streamId, 'm-1');
            expect(outcome).toBeNull();
            expect(purgeGroupsMock).not.toHaveBeenCalled();
            expect(streamrController.publishAs).toHaveBeenCalled();
        });

        it('keeps the rows of a message whose purge no provider carried out', async () => {
            streamrController.publishAs.mockResolvedValueOnce({ messageId: { publisherId: '0xE', timestamp: 555 } });
            await dmManager.sealAndPublish(streamId, peerAddress, { id: 'm-1', type: 'text', text: 'mine' });
            purgeGroupsMock.mockResolvedValue({ providers: 1, erasedOn: 0, forbiddenOn: 0, unreachable: 1, targets: 1 });
            const outcome = await dmManager.sendDelete(streamId, 'm-1');
            expect(outcome).toMatchObject({ unreachable: 1 });
            expect(dmManager.rowsOf('m-1')).toHaveLength(1);
        });

        it('erasing a received message purges the own inbox as its owner and drops it from this device', async () => {
            eraseMessageMock.mockResolvedValue({ providers: 1, erasedOn: 1, forbiddenOn: 0, unreachable: 0, targets: 1 });
            const outcome = await dmManager.eraseReceived(streamId, 'r-1');
            expect(outcome).toMatchObject({ erasedOn: 1 });
            const [inbox, msg, signer] = eraseMessageMock.mock.calls[0];
            expect(inbox).toMatchObject({ messageStreamId: `${me}/Pombo-DM-1`, streamId: `${me}/Pombo-DM-1`, peerAddress });
            expect(msg).toMatchObject({ id: 'r-1', _timestamp: 700, _seq: 0 });
            expect(signer.address).toBe(me);
            const ch = channelManager.channels.get(streamId);
            expect(ch.messages.map((m) => m.id)).toEqual(['m-1']);
            expect(ch._deletedIds.has('r-1')).toBe(true);
            expect(channelManager.notifyHandlers).toHaveBeenCalledWith('message_deleted', { streamId, targetId: 'r-1' });
        });

        it('keeps a received message that no provider erased', async () => {
            eraseMessageMock.mockResolvedValue({ providers: 1, erasedOn: 0, forbiddenOn: 1, unreachable: 0, targets: 1 });
            await dmManager.eraseReceived(streamId, 'r-1');
            expect(channelManager.channels.get(streamId).messages).toHaveLength(2);
        });

        it('drops a live DM dated ahead of the clock or of its own envelope, and keeps one within skew', async () => {
            const sealed = (message, extra = {}) => {
                dmCrypto.isSealed.mockReturnValueOnce(true);
                dmCrypto.open.mockResolvedValueOnce({ sender: peerAddress, message });
                return dmManager.routeInboxMessage({ v: 2, epk: '0x02eph', ct: 'c', iv: 'i', e: 'aes-256-gcm', ...extra });
            };
            await sealed({ id: 'f-1', type: 'text', text: 'future', timestamp: Date.now() + 3600000 });
            await sealed({ id: 'f-2', type: 'text', text: 'ahead of envelope', timestamp: Date.now() - 1000 }, { _timestamp: Date.now() - 600000, _seq: 0 });
            await sealed({ id: 'ok-1', type: 'text', text: 'fine', timestamp: Date.now() + 60000 }, { _timestamp: Date.now(), _seq: 0 });
            const ids = channelManager.channels.get(streamId).messages.map((m) => m.id);
            expect(ids).not.toContain('f-1');
            expect(ids).not.toContain('f-2');
            expect(ids).toContain('ok-1');
        });

        it('carries the storage coordinates of a sealed envelope onto the opened message', async () => {
            dmCrypto.isSealed.mockReturnValueOnce(true);
            dmCrypto.open.mockResolvedValueOnce({ sender: peerAddress, message: { id: 'r-2', type: 'text', text: 'sealed', timestamp: 3 } });
            await dmManager.routeInboxMessage({ v: 2, epk: '0x02eph', ct: 'c', iv: 'i', e: 'aes-256-gcm', _timestamp: 800, _seq: 1 });
            const ch = channelManager.channels.get(streamId);
            expect(ch.messages.find((m) => m.id === 'r-2')).toMatchObject({ _timestamp: 800, _seq: 1, _dmReceived: true });
        });
    });

    // ==================== fetchOlderDMMessages() ====================
    describe('fetchOlderDMMessages()', () => {
        const peerAddress = '0xpeerolder11111111111111111111111111111111';
        const streamId = `${peerAddress}/Pombo-DM-1`;

        beforeEach(() => {
            authManager.getAddress.mockReturnValue('0xmyaddress1234567890abcdef12345678');
            dmCrypto.isEncrypted.mockReturnValue(false);
            streamrController.getDMPublicKey.mockResolvedValue('0x02peerpubkey');
            dmManager.inboxMessageStreamId = '0xmyaddress1234567890abcdef12345678/Pombo-DM-1';
            dmManager.conversations.set(peerAddress, streamId);
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress,
                messages: [],
                hasMoreHistory: true
            });
            streamrController.fetchOlderHistoryWindowed.mockResolvedValue({
                messages: [], hasMore: false
            });
        });

        it('should return empty when no conversation registered', async () => {
            const result = await dmManager.fetchOlderDMMessages('0xunknownpeer');
            expect(result).toEqual({ loaded: 0, hasMore: false, noResultsInWindow: false });
        });

        it('should return empty when channel missing', async () => {
            channelManager.channels.delete(streamId);
            const result = await dmManager.fetchOlderDMMessages(peerAddress);
            expect(result).toEqual({ loaded: 0, hasMore: false, noResultsInWindow: false });
        });

        it('should return empty when inbox not initialized', async () => {
            dmManager.inboxMessageStreamId = null;
            const result = await dmManager.fetchOlderDMMessages(peerAddress);
            expect(result).toEqual({ loaded: 0, hasMore: false, noResultsInWindow: false });
        });

        it('should add new peer messages to channel', async () => {
            streamrController.fetchOlderHistoryWindowed.mockResolvedValueOnce({
                messages: [{
                    publisherId: peerAddress,
                    content: { id: 'old-1', text: 'old', timestamp: 100 }
                }],
                hasMore: true
            });
            const result = await dmManager.fetchOlderDMMessages(peerAddress);
            const ch = channelManager.channels.get(streamId);
            expect(ch.messages).toHaveLength(1);
            expect(ch.messages[0].id).toBe('old-1');
            expect(ch.messages[0]._dmReceived).toBe(true);
            expect(ch.oldestTimestamp).toBe(100);
            expect(result).toEqual({ loaded: 1, hasMore: true, noResultsInWindow: false });
        });

        it('should skip own and other-peer messages', async () => {
            streamrController.fetchOlderHistoryWindowed.mockResolvedValueOnce({
                messages: [
                    { publisherId: '0xmyaddress1234567890abcdef12345678', content: { id: 'mine', text: 'x', timestamp: 1 } },
                    { publisherId: '0xotherpeer', content: { id: 'other', text: 'y', timestamp: 2 } },
                    { publisherId: null, content: { id: 'noid', timestamp: 3 } }
                ],
                hasMore: true
            });
            const result = await dmManager.fetchOlderDMMessages(peerAddress);
            expect(result.loaded).toBe(0);
            expect(result.noResultsInWindow).toBe(true);
        });

        it('should deduplicate by id', async () => {
            const ch = channelManager.channels.get(streamId);
            ch.messages.push({ id: 'dup-1', text: 'existing', timestamp: 5 });
            streamrController.fetchOlderHistoryWindowed.mockResolvedValueOnce({
                messages: [{
                    publisherId: peerAddress,
                    content: { id: 'dup-1', text: 'duplicate', timestamp: 5 }
                }],
                hasMore: false
            });
            const result = await dmManager.fetchOlderDMMessages(peerAddress);
            expect(result.loaded).toBe(0);
            expect(ch.messages).toHaveLength(1);
        });

        it('should route reactions via channelManager.storeReaction', async () => {
            streamrController.fetchOlderHistoryWindowed.mockResolvedValueOnce({
                messages: [{
                    publisherId: peerAddress,
                    content: { type: 'reaction', messageId: 'm-1', emoji: '👍', action: 'add' }
                }],
                hasMore: false
            });
            await dmManager.fetchOlderDMMessages(peerAddress);
            expect(channelManager.storeReaction).toHaveBeenCalledWith(
                expect.any(Object), 'm-1', '👍', peerAddress, 'add'
            );
        });

        it('should respect abort signal before fetching', async () => {
            const ac = new AbortController();
            streamrController.fetchOlderHistoryWindowed.mockImplementationOnce(async () => {
                ac.abort();
                return { messages: [{ publisherId: peerAddress, content: { id: 'x', timestamp: 1 } }], hasMore: true };
            });
            const result = await dmManager.fetchOlderDMMessages(peerAddress, ac.signal);
            expect(result.loaded).toBe(0);
        });

        it('should return safe defaults on error', async () => {
            streamrController.fetchOlderHistoryWindowed.mockRejectedValueOnce(new Error('network'));
            const result = await dmManager.fetchOlderDMMessages(peerAddress);
            expect(result).toEqual({ loaded: 0, hasMore: true, noResultsInWindow: false });
        });
    });

    // ==================== Inline subscription callbacks ====================
    describe('subscribeToInbox() callback wiring', () => {
        it('should wire routeInboxMessage and routeNotification callbacks', async () => {
            dmManager.inboxMessageStreamId = '0xmy/Pombo-DM-1';
            dmManager.conversations.set('0xpeerwire1', 'stream');
            await dmManager.subscribeToInbox();

            // Message stream callback (subscribeWithHistory call)
            const msgCb = streamrController.subscribeWithHistory.mock.calls[0][2];
            expect(typeof msgCb).toBe('function');
            await msgCb({ /* no account */ }); // exits early but executes the arrow

            // Notification stream callback (subscribeToPartition call)
            const notifCall = streamrController.subscribeToPartition.mock.calls.find(
                c => c[0] === '0xmy/Pombo-DM-1'
            );
            expect(notifCall).toBeDefined();
            const notifCb = notifCall[2];
            await notifCb({}); // no account — early return covers arrow
        });
    });

    describe('subscribeDMEphemeral() callback wiring', () => {
        it('should wire control and media partition callbacks', async () => {
            dmManager.inboxEphemeralStreamId = '0xmy/Pombo-DM-2';
            await dmManager.subscribeDMEphemeral();

            // Control callback (subscribeWithHistory)
            const controlCall = streamrController.subscribeWithHistory.mock.calls.find(
                c => c[0] === '0xmy/Pombo-DM-2'
            );
            expect(controlCall).toBeDefined();
            const controlCb = controlCall[2];
            await controlCb({}); // early-return covers arrow

            // Media P1 callback
            const p1Call = streamrController.subscribeToPartition.mock.calls.find(
                c => c[0] === '0xmy/Pombo-DM-2' && c[1] === 1
            );
            expect(p1Call).toBeDefined();
            await p1Call[2]({});

            // Media P2 callback (with account)
            const p2Call = streamrController.subscribeToPartition.mock.calls.find(
                c => c[0] === '0xmy/Pombo-DM-2' && c[1] === 2
            );
            expect(p2Call).toBeDefined();
            await p2Call[2]({}, 'someSender');
        });
    });
});
