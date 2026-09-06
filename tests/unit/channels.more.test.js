/**
 * channels.js Additional Tests
 * Covers: joinChannel, sendReaction, sendTypingIndicator, preloadDeletePermission, publishWithRetry retry
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../src/js/config.js', () => ({
    CONFIG: {
        channels: {
            reactionDebounceMs: 100,
            maxRetries: 3,
            retryDelayMs: 50,
            presenceIntervalMs: 30000,
            loadMoreCount: 20
        },
        ui: { maxMessages: 1000, messagesBatch: 50 },
        dm: { maxSentMessages: 200 },
        relay: {},
        app: { version: '1.0.0' }
    }
}));

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        isInitialized: vi.fn().mockReturnValue(true),
        getCurrentAddress: vi.fn().mockReturnValue('0x123'),
        createStream: vi.fn(),
        subscribe: vi.fn(),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        publish: vi.fn(),
        publishMessage: vi.fn().mockResolvedValue(undefined),
        publishControl: vi.fn().mockResolvedValue(undefined),
        publishReaction: vi.fn().mockResolvedValue(undefined),
        enableStorage: vi.fn().mockResolvedValue({ success: true }),
        getStoredMessages: vi.fn().mockResolvedValue([]),
        getStreamMetadata: vi.fn().mockResolvedValue(null),
        hasPermission: vi.fn().mockResolvedValue(true),
        hasPublishPermission: vi.fn().mockResolvedValue({ hasPermission: true, rpcError: false }),
        hasDeletePermission: vi.fn().mockResolvedValue(false),
        grantPublicPermissions: vi.fn(),
        grantPermissionsToAddresses: vi.fn().mockResolvedValue(undefined),
        revokePermissionsFromAddresses: vi.fn().mockResolvedValue(undefined),
        updatePermissions: vi.fn().mockResolvedValue(undefined),
        deleteStream: vi.fn().mockResolvedValue(undefined),
        resend: vi.fn(),
        unsubscribeFromDualStream: vi.fn().mockResolvedValue(undefined),
        fetchOlderHistory: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
        subscribeToDualStream: vi.fn().mockResolvedValue(undefined),
        resendAdminState: vi.fn().mockResolvedValue(null),
        publishAdminState: vi.fn().mockResolvedValue(undefined),
        publishPasswordChallenge: vi.fn().mockResolvedValue(undefined),
        verifyPasswordChallenge: vi.fn().mockResolvedValue({ found: true, valid: true }),
        setDMPublishKey: vi.fn().mockResolvedValue(undefined),
        checkPermissions: vi.fn().mockResolvedValue({ canSubscribe: true, canPublish: true, isOwner: false })
    },
    STREAM_CONFIG: {
        partitions: 1,
        LOAD_MORE_COUNT: 20,
        INITIAL_MESSAGES: 50,
        ADMIN_HISTORY_COUNT: 10,
        MESSAGE_STREAM: { MESSAGES: 0 },
        EPHEMERAL_STREAM: { CONTROL: 0, MEDIA_SIGNALS: 1, MEDIA_DATA: 2 },
        ADMIN_STREAM: { MODERATION: 0 }
    },
    deriveEphemeralId: vi.fn((id) => `${id}-ephemeral`),
    deriveMessageId: vi.fn((id) => `${id}-message`),
    deriveAdminId: vi.fn((id) => `${id}-admin`),
    deriveKeysId: vi.fn((id) => `${id}-keys`),
    deriveInteractionsId: vi.fn((id) => `${id}-interactions`)
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getAddress: vi.fn().mockReturnValue('0xmyaddress'),
        getCurrentAddress: vi.fn().mockReturnValue('0xmyaddress'),
        getWalletAddress: vi.fn().mockReturnValue('0xmyaddress'),
        isConnected: vi.fn().mockReturnValue(true),
        wallet: { privateKey: '0xprivatekey' }
    }
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        getUserNickname: vi.fn().mockReturnValue('TestUser'),
        getUsername: vi.fn().mockReturnValue('TestUser'),
        getCurrentIdentity: vi.fn().mockReturnValue({ nickname: 'TestUser', address: '0xmyaddress' }),
        generateSignature: vi.fn().mockResolvedValue('sig123'),
        verifyMessage: vi.fn().mockResolvedValue({ valid: true, trustLevel: 1 }),
        createSignedMessage: vi.fn().mockResolvedValue({ id: 'msg_signed', text: 'hello', sender: '0xmyaddress', timestamp: Date.now() }),
        getTrustLevel: vi.fn().mockResolvedValue(1)
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        isStorageUnlocked: vi.fn().mockReturnValue(true),
        getChannels: vi.fn().mockReturnValue([]),
        saveChannels: vi.fn(),
        setChannels: vi.fn(),
        getChannel: vi.fn(),
        setChannel: vi.fn(),
        clearSentMessages: vi.fn().mockResolvedValue(undefined),
        clearSentReactions: vi.fn().mockResolvedValue(undefined),
        removeFromChannelOrder: vi.fn().mockResolvedValue(undefined),
        setDMLeftAt: vi.fn().mockResolvedValue(undefined),
        setChannelLeftAt: vi.fn().mockResolvedValue(undefined),
        clearChannelLeftAt: vi.fn().mockResolvedValue(undefined),
        getChannelsLeftAt: vi.fn().mockReturnValue({}),
        addBlockedPeer: vi.fn().mockResolvedValue(undefined),
        addToChannelOrder: vi.fn().mockResolvedValue(undefined),
        addSentMessage: vi.fn().mockResolvedValue(undefined),
        addSentReaction: vi.fn().mockResolvedValue(undefined),
        getSentMessages: vi.fn().mockReturnValue([]),
        getSentReactions: vi.fn().mockReturnValue({})
    }
}));

vi.mock('../../src/js/graph.js', () => ({
    graphAPI: {
        getPublicPomboChannels: vi.fn().mockResolvedValue([]),
        getStreamMetadata: vi.fn(),
        getStreamMembers: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        getStream: vi.fn().mockResolvedValue(null),
        detectStreamType: vi.fn().mockResolvedValue('public'),
        clearCache: vi.fn()
    }
}));

vi.mock('../../src/js/gate.js', () => ({
    gateManager: {
        checkAccess: vi.fn().mockResolvedValue(true),
        getGateInfo: vi.fn().mockResolvedValue({ readOnly: false, wireIdentityName: 'visible' }),
        canModerate: vi.fn().mockResolvedValue(false)
    },
    GATE_MODE: { NONE: 0, TOKEN: 1, NFT: 2, PAID: 3 }
}));

vi.mock('../../src/js/relayManager.js', () => ({
    relayManager: {
        sendPushNotification: vi.fn(),
        enabled: false,
        subscribeToChannel: vi.fn().mockResolvedValue(true),
        subscribeToNativeChannel: vi.fn().mockResolvedValue(true),
        sendChannelWakeSignal: vi.fn().mockResolvedValue(undefined),
        sendNativeChannelWakeSignal: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/dm.js', () => ({
    dmManager: {
        subscribeDMEphemeral: vi.fn().mockResolvedValue(undefined),
        unsubscribeDMEphemeral: vi.fn().mockResolvedValue(undefined),
        loadDMTimeline: vi.fn(),
        getPeerPublicKey: vi.fn().mockResolvedValue('peerPubKey123'),
        sealAndPublish: vi.fn().mockResolvedValue({ messageId: { publisherId: '0xEphemeral' } }),
        isDMChannel: vi.fn().mockReturnValue(false),
        conversations: new Map()
    }
}));

vi.mock('../../src/js/dmCrypto.js', () => ({
    dmCrypto: {
        getSharedKey: vi.fn().mockResolvedValue('aesKey'),
        encrypt: vi.fn().mockResolvedValue({ ct: 'encrypted', iv: 'iv', e: 'aes-256-gcm' }),
        peerPublicKeys: new Map()
    }
}));

vi.mock('../../src/js/utils/chainErrors.js', () => ({
    parseChainError: vi.fn((err) => err)
}));

vi.mock('../../src/js/media.js', () => ({
    mediaController: {
        handleMediaMessage: vi.fn()
    }
}));

import { channelManager } from '../../src/js/channels.js';
import { authManager } from '../../src/js/auth.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { graphAPI } from '../../src/js/graph.js';
import { streamrController } from '../../src/js/streamr.js';
import { dmManager } from '../../src/js/dm.js';
import { dmCrypto } from '../../src/js/dmCrypto.js';
import { relayManager } from '../../src/js/relayManager.js';
import { Logger } from '../../src/js/logger.js';

describe('ChannelManager - Additional Coverage', () => {
    beforeEach(() => {
        channelManager.channels.clear();
        channelManager.currentChannel = null;
        channelManager.switchGeneration = 0;
        channelManager.pendingVerifications.clear();
        channelManager.messageHandlers = [];
        channelManager.processingMessages.clear();
        channelManager.sendingMessages.clear();
        channelManager.pendingReactions.clear();
        channelManager.onlineUsers.clear();
        channelManager.onlineUsersHandlers = [];
        channelManager.presenceInterval = null;
        vi.clearAllMocks();
        // Re-set default mock return values after clearAllMocks
        authManager.getAddress.mockReturnValue('0xmyaddress');
        authManager.wallet = { privateKey: '0xprivatekey' };
        dmManager.getPeerPublicKey.mockResolvedValue('peerPubKey123');
    });

    afterEach(() => {
        if (channelManager.presenceInterval) {
            clearInterval(channelManager.presenceInterval);
            channelManager.presenceInterval = null;
        }
    });

    // ==================== joinChannel ====================
    describe('joinChannel', () => {
        const streamId = '0xowner/test-channel-1';

        it('returns existing channel if already joined', async () => {
            const existing = { messageStreamId: streamId, name: 'test' };
            channelManager.channels.set(streamId, existing);

            const result = await channelManager.joinChannel(streamId);
            expect(result).toBe(existing);
            expect(streamrController.checkPermissions).not.toHaveBeenCalled();
        });

        it('throws when user has no permissions', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: false,
                canPublish: false,
                isOwner: false
            });

            await expect(channelManager.joinChannel(streamId))
                .rejects.toThrow('do not have permission');
        });

        it('joins channel with full permissions and Graph info', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: true, isOwner: false
            });
            graphAPI.detectStreamType.mockResolvedValue('public');
            graphAPI.getStreamMembers.mockResolvedValue({
                ok: true,
                data: [
                    { address: '0xowner', isOwner: true },
                    { address: '0xmyaddress', isOwner: false }
                ]
            });
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);

            const channel = await channelManager.joinChannel(streamId);

            expect(channel.messageStreamId).toBe(streamId);
            expect(channel.type).toBe('public');
            expect(channel.createdBy).toBe('0xowner');
            expect(channelManager.channels.has(streamId)).toBe(true);
        });

        it('persists to storage and channel order', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: true, isOwner: false
            });
            graphAPI.detectStreamType.mockResolvedValue('public');
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);

            await channelManager.joinChannel(streamId);

            expect(secureStorage.addToChannelOrder).toHaveBeenCalledWith(streamId);
        });

        it('reads readOnly off the stream when the caller does not know it', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: false, isOwner: false
            });
            graphAPI.detectStreamType.mockResolvedValue('public');
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);

            const channel = await channelManager.joinChannel(streamId);

            expect(channel.readOnly).toBe(true);
        });

        it('keeps readOnly false for a writable channel', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: true, isOwner: false
            });
            graphAPI.detectStreamType.mockResolvedValue('public');
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);

            const channel = await channelManager.joinChannel(streamId);

            expect(channel.readOnly).toBe(false);
        });

        it('does not mark a gated channel read-only: the grants belong to the clone', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: false, canPublish: false, isOwner: false
            });
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);

            const channel = await channelManager.joinChannel(streamId, null, {
                type: 'gated', gateAddress: '0xGATE'
            });

            expect(channel.readOnly).toBe(false);
        });

        it('rejects when Graph fails and no password identifies the type', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: true, isOwner: false
            });
            graphAPI.detectStreamType.mockRejectedValue(new Error('Graph unavailable'));
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);

            await expect(channelManager.joinChannel(streamId))
                .rejects.toThrow('Could not determine the channel type');
        });

        it('infers password type when Graph fails and password provided', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: true, isOwner: false
            });
            graphAPI.detectStreamType.mockRejectedValue(new Error('fail'));
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);

            const channel = await channelManager.joinChannel(streamId, 'mypassword');

            expect(channel.type).toBe('password');
            expect(channel.password).toBe('mypassword');
        });

        it('rejects unknown type without password', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: true, isOwner: false
            });
            graphAPI.detectStreamType.mockResolvedValue('unknown');
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);

            await expect(channelManager.joinChannel(streamId))
                .rejects.toThrow('Could not determine the channel type');
        });

        it('defaults unknown type to password when password provided', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: true, isOwner: false
            });
            graphAPI.detectStreamType.mockResolvedValue('unknown');
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);

            const channel = await channelManager.joinChannel(streamId, 'pass');

            expect(channel.type).toBe('password');
        });

        it('marks write-only channels correctly', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: false, canPublish: true, isOwner: false
            });
            graphAPI.detectStreamType.mockResolvedValue('public');
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);

            const channel = await channelManager.joinChannel(streamId);

            expect(channel.writeOnly).toBe(true);
            expect(Logger.info).toHaveBeenCalledWith(expect.stringContaining('Write-only'));
        });

        it('skips subscription for write-only channels', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: false, canPublish: true, isOwner: false
            });
            graphAPI.detectStreamType.mockResolvedValue('public');
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            const subSpy = vi.spyOn(channelManager, 'subscribeToChannel');

            await channelManager.joinChannel(streamId);

            expect(subSpy).not.toHaveBeenCalled();
        });

        it('notifies handlers on join', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: true, isOwner: false
            });
            graphAPI.detectStreamType.mockResolvedValue('public');
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);
            const notifySpy = vi.spyOn(channelManager, 'notifyHandlers');

            await channelManager.joinChannel(streamId);

            expect(notifySpy).toHaveBeenCalledWith('channelJoined', expect.objectContaining({
                streamId,
                permissions: expect.objectContaining({ canPublish: true, canSubscribe: true })
            }));
        });

        it('auto-enables per-channel relay notifications for gated channel', async () => {
            relayManager.enabled = true;
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: true, isOwner: false
            });
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);

            await channelManager.joinChannel(streamId, null, { type: 'gated' });

            expect(relayManager.subscribeToNativeChannel).toHaveBeenCalledWith(streamId);
            relayManager.enabled = false;
        });

        it('auto-enables relay notifications for public channel', async () => {
            relayManager.enabled = true;
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: true, isOwner: false
            });
            graphAPI.detectStreamType.mockResolvedValue('public');
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);

            await channelManager.joinChannel(streamId);

            expect(relayManager.subscribeToChannel).toHaveBeenCalledWith(streamId);
            relayManager.enabled = false;
        });

        it('handles relay subscription failure gracefully', async () => {
            relayManager.enabled = true;
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: true, isOwner: false
            });
            graphAPI.detectStreamType.mockResolvedValue('public');
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);
            relayManager.subscribeToChannel.mockRejectedValue(new Error('relay fail'));

            // Should not throw
            const channel = await channelManager.joinChannel(streamId);
            expect(channel).toBeDefined();
            expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to auto-enable'), expect.any(String));
            relayManager.enabled = false;
        });

        it('uses provided type and createdBy from options', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: true, isOwner: false
            });
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);

            const channel = await channelManager.joinChannel(streamId, null, {
                type: 'public',
                createdBy: '0xcreator'
            });

            expect(channel.type).toBe('public');
            expect(channel.createdBy).toBe('0xcreator');
        });

        it('uses localName for channel name if provided', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: true, isOwner: false
            });
            graphAPI.detectStreamType.mockResolvedValue('public');
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);

            const channel = await channelManager.joinChannel(streamId, null, {
                localName: 'My Custom Name'
            });

            expect(channel.name).toBe('My Custom Name');
        });

        it('sets classification from options', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: true, isOwner: false
            });
            graphAPI.detectStreamType.mockResolvedValue('public');
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);

            const channel = await channelManager.joinChannel(streamId, null, {
                classification: 'work'
            });

            expect(channel.classification).toBe('work');
        });

        it('caches publish permission on join', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: true, isOwner: false
            });
            graphAPI.detectStreamType.mockResolvedValue('public');
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);

            const channel = await channelManager.joinChannel(streamId);

            expect(channel._publishPermCache).toBeDefined();
            expect(channel._publishPermCache.canPublish).toBe(true);
            expect(channel._publishPermCache.address).toBe('0xmyaddress');
        });

        it('logs read-only access warning', async () => {
            streamrController.checkPermissions.mockResolvedValue({
                canSubscribe: true, canPublish: false, isOwner: false
            });
            graphAPI.detectStreamType.mockResolvedValue('public');
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            vi.spyOn(channelManager, 'subscribeToChannel').mockResolvedValue(undefined);

            await channelManager.joinChannel(streamId);

            expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining('read-only access'));
        });
    });

    // ==================== sendReaction ====================
    describe('sendReaction', () => {
        const streamId = 'stream-react-1';
        const messageId = 'msg-1';

        beforeEach(() => {
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'public',
                password: null,
                peerAddress: null,
                writeOnly: false
            });
        });

        it('publishes reaction for regular channel', async () => {
            await channelManager.sendReaction(streamId, messageId, '👍');

            expect(streamrController.publishReaction).toHaveBeenCalledWith(
                streamId,
                expect.objectContaining({
                    type: 'reaction',
                    action: 'add',
                    messageId,
                    emoji: '👍'
                }),
                null
            );
        });

        it('publishes remove reaction', async () => {
            await channelManager.sendReaction(streamId, messageId, '👍', true);

            expect(streamrController.publishReaction).toHaveBeenCalledWith(
                streamId,
                expect.objectContaining({ action: 'remove' }),
                null
            );
        });

        it('skips duplicate pending reactions', async () => {
            // Simulate a pending reaction
            channelManager.pendingReactions.add(`${streamId}:${messageId}:👍:add`);

            await channelManager.sendReaction(streamId, messageId, '👍');

            expect(streamrController.publishReaction).not.toHaveBeenCalled();
        });

        it('returns early if channel not found', async () => {
            channelManager.channels.clear();

            await channelManager.sendReaction(streamId, messageId, '👍');

            expect(streamrController.publishReaction).not.toHaveBeenCalled();
        });

        it('encrypts reaction for DM channel', async () => {
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress: '0xpeer',
                password: null,
                writeOnly: false
            });

            await channelManager.sendReaction(streamId, messageId, '❤️');

            expect(dmManager.sealAndPublish).toHaveBeenCalledWith(
                streamId,
                '0xpeer',
                expect.objectContaining({ type: 'reaction' }),
                expect.any(Number)
            );
            expect(dmManager.getPeerPublicKey).not.toHaveBeenCalled();
        });

        it('persists DM reaction locally', async () => {
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress: '0xpeer',
                password: null,
                writeOnly: false
            });

            await channelManager.sendReaction(streamId, messageId, '❤️');

            expect(secureStorage.addSentReaction).toHaveBeenCalledWith(
                streamId, messageId, '❤️', '0xmyaddress', 'add'
            );
        });

        it('still sends when the peer public key is unavailable', async () => {
            // Used to bail out with a warning. Sealed sender needs only the
            // recipient's key, which sealAndPublish resolves itself — a missing
            // peer key no longer silences reactions, presence or typing.
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'dm',
                peerAddress: '0xpeer',
                password: null,
                writeOnly: false
            });
            dmManager.getPeerPublicKey.mockResolvedValue(null);

            await channelManager.sendReaction(streamId, messageId, '❤️');

            expect(dmManager.sealAndPublish).toHaveBeenCalled();
        });

        it('persists reaction locally for write-only channel', async () => {
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'public',
                password: null,
                peerAddress: null,
                writeOnly: true
            });

            await channelManager.sendReaction(streamId, messageId, '🎉');

            expect(secureStorage.addSentReaction).toHaveBeenCalled();
        });

        it('removes pending key after debounce', async () => {
            vi.useFakeTimers();

            await channelManager.sendReaction(streamId, messageId, '👍');

            const key = `${streamId}:${messageId}:👍:add`;
            expect(channelManager.pendingReactions.has(key)).toBe(true);

            await vi.advanceTimersByTimeAsync(200);

            expect(channelManager.pendingReactions.has(key)).toBe(false);
            vi.useRealTimers();
        });

        it('handles publish error and still debounces', async () => {
            vi.useFakeTimers();
            streamrController.publishReaction.mockRejectedValue(new Error('net err'));

            await channelManager.sendReaction(streamId, messageId, '👎');

            expect(Logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to send reaction'), expect.any(Error));

            const key = `${streamId}:${messageId}:👎:add`;
            await vi.advanceTimersByTimeAsync(200);
            expect(channelManager.pendingReactions.has(key)).toBe(false);
            vi.useRealTimers();
        });
    });

    // ==================== sendTypingIndicator ====================
    describe('sendTypingIndicator', () => {
        const streamId = 'stream-typing-1';

        it('returns early if channel not found', async () => {
            await channelManager.sendTypingIndicator('nonexistent');
            expect(streamrController.publishControl).not.toHaveBeenCalled();
        });

        it('sends typing to non-DM channel', async () => {
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                ephemeralStreamId: `${streamId}-eph`,
                type: 'public',
                password: 'pass123',
                peerAddress: null
            });

            await channelManager.sendTypingIndicator(streamId);

            expect(streamrController.publishControl).toHaveBeenCalledWith(
                `${streamId}-eph`,
                expect.objectContaining({ type: 'typing' }),
                'pass123'
            );
        });

        it('encrypts typing for DM channel', async () => {
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                ephemeralStreamId: `${streamId}-eph`,
                type: 'dm',
                peerAddress: '0xpeer',
                password: null
            });

            await channelManager.sendTypingIndicator(streamId);

            expect(dmManager.sealAndPublish).toHaveBeenCalledWith(
                `${streamId}-eph`,
                '0xpeer',
                expect.objectContaining({ type: 'typing' }),
                expect.any(Number)
            );
            expect(dmManager.getPeerPublicKey).not.toHaveBeenCalled();
        });

        it('skips DM typing when no private key', async () => {
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                ephemeralStreamId: `${streamId}-eph`,
                type: 'dm',
                peerAddress: '0xpeer',
                password: null
            });
            authManager.wallet = {};

            await channelManager.sendTypingIndicator(streamId);

            expect(dmCrypto.getSharedKey).not.toHaveBeenCalled();
        });

        it('skips DM typing when no peer public key', async () => {
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                ephemeralStreamId: `${streamId}-eph`,
                type: 'dm',
                peerAddress: '0xpeer',
                password: null
            });
            dmManager.getPeerPublicKey.mockResolvedValue(null);

            await channelManager.sendTypingIndicator(streamId);

            expect(dmCrypto.encrypt).not.toHaveBeenCalled();
        });

        it('catches and logs errors', async () => {
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                ephemeralStreamId: `${streamId}-eph`,
                type: 'public',
                password: null,
                peerAddress: null
            });
            streamrController.publishControl.mockRejectedValue(new Error('ctrl fail'));

            await channelManager.sendTypingIndicator(streamId);

            expect(Logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to send typing'), expect.any(Error));
        });
    });

    // ==================== preloadDeletePermission ====================
    describe('preloadDeletePermission', () => {
        const streamId = 'stream-del-1';

        it('returns early if channel not found', () => {
            channelManager.preloadDeletePermission('nonexistent');
            expect(streamrController.hasDeletePermission).not.toHaveBeenCalled();
        });

        it('returns early if no address', () => {
            channelManager.channels.set(streamId, { messageStreamId: streamId });
            authManager.getAddress.mockReturnValue(null);

            channelManager.preloadDeletePermission(streamId);

            expect(streamrController.hasDeletePermission).not.toHaveBeenCalled();
        });

        it('skips if already cached for same address', () => {
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                _deletePermCache: { address: '0xmyaddress', canDelete: true }
            });

            channelManager.preloadDeletePermission(streamId);

            expect(streamrController.hasDeletePermission).not.toHaveBeenCalled();
        });

        it('fetches and caches delete permission on success', async () => {
            channelManager.channels.set(streamId, { messageStreamId: streamId });

            let thenCb;
            streamrController.hasDeletePermission.mockImplementation(() => ({
                then: (cb) => { thenCb = cb; return { catch: () => {} }; }
            }));

            channelManager.preloadDeletePermission(streamId);
            thenCb(true);

            const ch = channelManager.channels.get(streamId);
            expect(ch._deletePermCache).toBeDefined();
            expect(ch._deletePermCache.canDelete).toBe(true);
            expect(ch._deletePermCache.address).toBe('0xmyaddress');
        });

        it('logs warning on permission check failure', async () => {
            channelManager.channels.set(streamId, { messageStreamId: streamId });

            let catchCb;
            streamrController.hasDeletePermission.mockImplementation(() => ({
                then: () => ({ catch: (cb) => { catchCb = cb; } })
            }));

            channelManager.preloadDeletePermission(streamId);
            catchCb(new Error('rpc fail'));

            expect(Logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Failed to preload DELETE'),
                expect.any(String)
            );
        });

        it('re-fetches if cached for different address', async () => {
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                _deletePermCache: { address: '0xother', canDelete: false }
            });

            let thenCb;
            streamrController.hasDeletePermission.mockImplementation(() => ({
                then: (cb) => { thenCb = cb; return { catch: () => {} }; }
            }));

            channelManager.preloadDeletePermission(streamId);
            thenCb(true);

            const ch = channelManager.channels.get(streamId);
            expect(ch._deletePermCache.address).toBe('0xmyaddress');
        });
    });

    // ==================== publishWithRetry ====================
    describe('publishWithRetry', () => {
        it('publishes message on success', async () => {
            await channelManager.publishWithRetry('stream-1', { id: 'msg-1' }, 'pass');

            expect(streamrController.publishMessage).toHaveBeenCalledWith('stream-1', { id: 'msg-1' }, 'pass');
        });

        it('retries on failure and succeeds', async () => {
            vi.useFakeTimers();
            streamrController.publishMessage
                .mockRejectedValueOnce(new Error('fail1'))
                .mockResolvedValueOnce(undefined);

            const promise = channelManager.publishWithRetry('stream-1', { id: 'msg-1' });
            await vi.advanceTimersByTimeAsync(100);
            await promise;

            expect(streamrController.publishMessage).toHaveBeenCalledTimes(2);
            vi.useRealTimers();
        });

        it('throws after max retries exhausted', async () => {
            // Use minimal delay to avoid unhandled rejection with fake timers
            channelManager.RETRY_DELAY = 1;
            streamrController.publishMessage.mockRejectedValue(new Error('persistent fail'));

            await expect(channelManager.publishWithRetry('stream-1', { id: 'msg-1' }))
                .rejects.toThrow('persistent fail');

            // 1 initial + MAX_RETRIES retries
            expect(streamrController.publishMessage).toHaveBeenCalledTimes(4);
        });

        it('logs warning on each retry', async () => {
            vi.useFakeTimers();
            streamrController.publishMessage
                .mockRejectedValueOnce(new Error('fail'))
                .mockResolvedValueOnce(undefined);

            const promise = channelManager.publishWithRetry('stream-1', { id: 'msg-1' });
            await vi.advanceTimersByTimeAsync(100);
            await promise;

            expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining('retrying'));
            vi.useRealTimers();
        });
    });
});
