/**
 * Extended tests for channels.js - Members, Presence, Delete, Leave, Sync
 * Focus: untested methods for coverage improvement
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all dependencies before importing
vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
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
        enableStorage: vi.fn().mockResolvedValue({ success: true }),
        getStoredMessages: vi.fn().mockResolvedValue([]),
        getStreamMetadata: vi.fn().mockResolvedValue(null),
        hasPermission: vi.fn().mockResolvedValue(true),
        hasPublishPermission: vi.fn().mockResolvedValue({ hasPermission: true, rpcError: false }),
        hasDeletePermission: vi.fn().mockResolvedValue(false),
        grantPublicPermissions: vi.fn(),
        grantPermissionsToAddresses: vi.fn().mockResolvedValue(undefined),
        revokePermissionsFromAddresses: vi.fn().mockResolvedValue(undefined),
        setStreamPermissions: vi.fn().mockResolvedValue(undefined),
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
    deriveKeysId: vi.fn((id) => `${id}-keys`)
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
        getSentMessages: vi.fn().mockReturnValue([]),
        getSentReactions: vi.fn().mockReturnValue({}),
        getEpochKeys: vi.fn().mockReturnValue(null),
        setEpochKeys: vi.fn().mockResolvedValue(undefined),
        clearEpochKeys: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/graph.js', () => ({
    graphAPI: {
        getPublicPomboChannels: vi.fn().mockResolvedValue([]),
        getStreamMetadata: vi.fn(),
        getStreamMembers: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        getStream: vi.fn().mockResolvedValue(null),
        detectStreamType: vi.fn().mockResolvedValue('unknown'),
        clearCache: vi.fn()
    }
}));

vi.mock('../../src/js/relayManager.js', () => ({
    relayManager: {
        sendPushNotification: vi.fn(),
        enabled: false,
        subscribeToChannel: vi.fn().mockResolvedValue(true),
        subscribeToNativeChannel: vi.fn().mockResolvedValue(true)
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
        encrypt: vi.fn().mockResolvedValue({ encrypted: true }),
        peerPublicKeys: new Map()
    }
}));

vi.mock('../../src/js/media.js', () => ({
    mediaController: {
        handleMediaMessage: vi.fn()
    }
}));

vi.mock('../../src/js/gate.js', () => ({
    GATE_MODE: Object.freeze({ NONE: 0, TOKEN_BALANCE: 1, NFT_OWNERSHIP: 2, PAID: 3 }),
    WIRE_IDENTITY: Object.freeze({ VISIBLE: 0, SEALED: 1 }),
    gateManager: {
        createGate: vi.fn().mockResolvedValue('0xgate'),
        allow: vi.fn().mockResolvedValue(true),
        allowBatch: vi.fn().mockResolvedValue(true),
        revokeAllow: vi.fn().mockResolvedValue(true),
        ban: vi.fn().mockResolvedValue(true),
        unban: vi.fn().mockResolvedValue(true),
        checkAccess: vi.fn().mockResolvedValue(true),
        getGateInfo: vi.fn().mockResolvedValue({
            owner: '0xowner', mode: 0, modeName: 'none', token: null,
            minBalance: 0n, price: 0n, duration: 0n,
            wireIdentity: 0, wireIdentityName: 'visible', readOnly: false
        }),
        listMembers: vi.fn().mockResolvedValue([]),
        getGateMembers: vi.fn().mockResolvedValue([]),
        setModerator: vi.fn().mockResolvedValue(true),
        canModerate: vi.fn().mockResolvedValue(false)
    }
}));

vi.mock('../../src/js/epochKeyManager.js', () => ({
    usesEpochKeys: vi.fn().mockReturnValue(false),
    epochKeyManager: {
        rotateEpoch: vi.fn().mockResolvedValue(undefined),
        getSeenRequesters: vi.fn().mockReturnValue([]),
        getRosterMembers: vi.fn().mockResolvedValue([]),
        onKeyAdopted: vi.fn(),
        handleKeysMessage: vi.fn(),
        forgetChannel: vi.fn().mockResolvedValue(undefined),
        ensureChannelKeys: vi.fn().mockResolvedValue(undefined),
        getWaitingInfo: vi.fn().mockReturnValue({ waiting: false })
    }
}));

// Import after mocks
import { channelManager } from '../../src/js/channels.js';
import { authManager } from '../../src/js/auth.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { graphAPI } from '../../src/js/graph.js';
import { streamrController, deriveEphemeralId } from '../../src/js/streamr.js';
import { identityManager } from '../../src/js/identity.js';
import { dmManager } from '../../src/js/dm.js';
import { dmCrypto } from '../../src/js/dmCrypto.js';

describe('ChannelManager Extended', () => {
    beforeEach(() => {
        channelManager.channels.clear();
        channelManager.currentChannel = null;
        channelManager.switchGeneration = 0;
        channelManager.historyAbortController = null;
        channelManager.pendingVerifications.clear();
        channelManager.messageHandlers = [];
        channelManager.processingMessages.clear();
        channelManager.sendingMessages.clear();
        channelManager.pendingReactions.clear();
        channelManager.onlineUsers.clear();
        channelManager.onlineUsersHandlers = [];
        channelManager.presenceInterval = null;
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (channelManager.presenceInterval) {
            clearInterval(channelManager.presenceInterval);
            channelManager.presenceInterval = null;
        }
    });

    // ==================== addMember ====================
    describe('addMember', () => {
        const streamId = 'stream-gated-1';

        beforeEach(async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            gateManager.allow.mockClear();
            gateManager.allow.mockResolvedValue(true);
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'gated',
                gate: { address: '0xgate' },
                members: ['0xmyaddress'],
                ephemeralStreamId: `${streamId}-ephemeral`,
                createdBy: '0xmyaddress'
            });
        });

        it('allows the member on the gate in one transaction', async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            await channelManager.addMember(streamId, '0xnewmember');

            expect(gateManager.allow).toHaveBeenCalledWith('0xgate', '0xnewmember');
        });

        it('updates local members list', async () => {
            await channelManager.addMember(streamId, '0xnewmember');

            const channel = channelManager.channels.get(streamId);
            expect(channel.members).toContain('0xnewmember');
        });

        it('saves channels after update', async () => {
            const saveSpy = vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            await channelManager.addMember(streamId, '0xnewmember');
            expect(saveSpy).toHaveBeenCalled();
        });

        it('returns true on success', async () => {
            const result = await channelManager.addMember(streamId, '0xnewmember');
            expect(result).toBe(true);
        });

        it('throws if channel not found', async () => {
            await expect(channelManager.addMember('nonexistent', '0x1')).rejects.toThrow('Channel not found');
        });

        it('throws if channel has no gate', async () => {
            channelManager.channels.set('public-ch', { type: 'public', members: [] });
            await expect(channelManager.addMember('public-ch', '0x1')).rejects.toThrow('gated channels');
        });

        it('throws if already a member', async () => {
            await expect(channelManager.addMember(streamId, '0xMyAddress')).rejects.toThrow('already a member');
        });

        it('throws chain error on gate failure', async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            gateManager.allow.mockRejectedValue(new Error('out of gas'));
            await expect(channelManager.addMember(streamId, '0xnew')).rejects.toThrow();
        });
    });

    // ==================== removeMember ====================
    describe('removeMember', () => {
        const streamId = 'stream-gated-2';

        beforeEach(async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            gateManager.revokeAllow.mockClear();
            gateManager.revokeAllow.mockResolvedValue(true);
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'gated',
                gate: { address: '0xgate' },
                members: ['0xmyaddress', '0xmember1', '0xmember2'],
                ephemeralStreamId: `${streamId}-ephemeral`,
                createdBy: '0xmyaddress'
            });
        });

        it('takes the member off the allowlist and rotates the epoch', async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
            await channelManager.removeMember(streamId, '0xmember1');

            // Removing carries no ban mark: a later allow() readmits them.
            expect(gateManager.revokeAllow).toHaveBeenCalledWith('0xgate', '0xmember1');
            expect(gateManager.ban).not.toHaveBeenCalled();
            expect(epochKeyManager.rotateEpoch).toHaveBeenCalled();
        });

        it('removes member from local list', async () => {
            await channelManager.removeMember(streamId, '0xmember1');

            const channel = channelManager.channels.get(streamId);
            expect(channel.members).not.toContain('0xmember1');
            expect(channel.members).toContain('0xmember2');
        });

        it('saves channels after update', async () => {
            const saveSpy = vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            await channelManager.removeMember(streamId, '0xmember1');
            expect(saveSpy).toHaveBeenCalled();
        });

        it('returns true on success', async () => {
            const result = await channelManager.removeMember(streamId, '0xmember1');
            expect(result).toBe(true);
        });

        it('throws if channel not found', async () => {
            await expect(channelManager.removeMember('nonexistent', '0x1')).rejects.toThrow('Channel not found');
        });

        it('throws if channel has no gate', async () => {
            channelManager.channels.set('public-ch', { type: 'public', members: ['0x1'] });
            await expect(channelManager.removeMember('public-ch', '0x1')).rejects.toThrow('gated channels');
        });

        it('removes an address the local cache never knew', async () => {
            // Membership is the contract's: the roster and the seen requesters
            // surface members this device never minted, and they must be
            // removable like any other.
            const { gateManager } = await import('../../src/js/gate.js');
            await expect(channelManager.removeMember(streamId, '0xnonmember')).resolves.toBe(true);
            expect(gateManager.revokeAllow).toHaveBeenCalledWith('0xgate', '0xnonmember');
        });

        it('throws if trying to remove the creator', async () => {
            await expect(channelManager.removeMember(streamId, '0xmyaddress')).rejects.toThrow('channel creator');
        });

        it('normalizes address for comparison', async () => {
            await channelManager.removeMember(streamId, '0xMember1'); // uppercase
            const channel = channelManager.channels.get(streamId);
            expect(channel.members).not.toContain('0xmember1');
        });
    });

    // ==================== ban levels ====================
    describe('ban enforcement levels', () => {
        const streamId = 'stream-gated-ban';

        beforeEach(async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            gateManager.ban.mockClear();
            gateManager.unban.mockClear();
            gateManager.getGateMembers.mockResolvedValue([]);
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                streamId,
                type: 'gated',
                gate: { address: '0xgate' },
                members: ['0xmyaddress', '0xmember1'],
                ephemeralStreamId: `${streamId}-ephemeral`,
                adminStreamId: `${streamId}-admin`,
                createdBy: '0xmyaddress',
                adminState: { bannedMembers: [], hiddenMessageIds: [], pins: [] }
            });
            vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
        });

        it('protocol level bans on the gate and rotates; client level does not', async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
            epochKeyManager.rotateEpoch.mockClear();

            await channelManager.banMemberLevels(streamId, '0xmember1', { protocol: true });
            expect(gateManager.ban).toHaveBeenCalledWith('0xgate', '0xmember1');
            expect(epochKeyManager.rotateEpoch).toHaveBeenCalled();

            gateManager.ban.mockClear();
            epochKeyManager.rotateEpoch.mockClear();
            const banSpy = vi.spyOn(channelManager, 'banMember').mockResolvedValue(true);
            await channelManager.banMemberLevels(streamId, '0xmember1', { client: true });
            expect(gateManager.ban).not.toHaveBeenCalled();
            expect(epochKeyManager.rotateEpoch).not.toHaveBeenCalled();
            expect(banSpy).toHaveBeenCalledWith(streamId, '0xmember1');
        });

        it('records the rotation so the deferred pass does not repeat it', async () => {
            await channelManager.banMemberLevels(streamId, '0xmember1', { protocol: true });
            expect(channelManager.channels.get(streamId).rotatedForNoAccess).toContain('0xmember1');
        });

        it('refuses to ban the channel creator', async () => {
            await expect(channelManager.banMemberLevels(streamId, '0xmyaddress', { protocol: true }))
                .rejects.toThrow('creator');
        });

        it('unban only pays for a transaction when the gate really has them banned', async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            await channelManager.unbanMemberLevels(streamId, '0xmember1');
            expect(gateManager.unban).not.toHaveBeenCalled();

            gateManager.getGateMembers.mockResolvedValue([{ address: '0xmember1', banned: true }]);
            const unbanSpy = vi.spyOn(channelManager, 'unbanMember').mockResolvedValue(true);
            channelManager.channels.get(streamId).adminState.bannedMembers = ['0xmember1'];
            await channelManager.unbanMemberLevels(streamId, '0xmember1');
            expect(gateManager.unban).toHaveBeenCalledWith('0xgate', '0xmember1');
            // The free client ban is always cleared alongside.
            expect(unbanSpy).toHaveBeenCalledWith(streamId, '0xmember1');
        });
    });

    // ==================== updateMemberPermissions ====================
    describe('updateMemberPermissions', () => {
        const streamId = 'stream-gated-3';

        beforeEach(async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            gateManager.setModerator.mockClear();
            gateManager.setModerator.mockResolvedValue(true);
            channelManager.channels.set(streamId, {
                type: 'gated',
                gate: { address: '0xgate' },
                members: ['0xmyaddress', '0xmember1']
            });
        });

        it('maps canGrant onto the gate moderator flag', async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            await channelManager.updateMemberPermissions(streamId, '0xmember1', { canGrant: true });

            expect(gateManager.setModerator).toHaveBeenCalledWith('0xgate', '0xmember1', true);
        });

        it('returns true on success', async () => {
            const result = await channelManager.updateMemberPermissions(streamId, '0xmember1', { canGrant: true });
            expect(result).toBe(true);
        });

        it('throws if channel not found', async () => {
            await expect(channelManager.updateMemberPermissions('nonexistent', '0x1', {})).rejects.toThrow('Channel not found');
        });

        it('throws if channel has no gate', async () => {
            channelManager.channels.set('pub', { type: 'public' });
            await expect(channelManager.updateMemberPermissions('pub', '0x1', {})).rejects.toThrow('gated');
        });

        it('throws chain error on failure', async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            gateManager.setModerator.mockRejectedValue(new Error('transaction failed'));
            await expect(channelManager.updateMemberPermissions(streamId, '0x1', {})).rejects.toThrow();
        });
    });

    // ==================== getChannelMembers ====================
    describe('getChannelMembers', () => {
        const streamId = 'stream-gated-4';

        beforeEach(async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            gateManager.getGateMembers.mockClear();
            gateManager.getGateMembers.mockResolvedValue([]);
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'gated',
                gate: { address: '0xgate' },
                members: ['0xlocalmember1'],
                createdBy: '0xowner'
            });
        });

        it('throws if channel not found', async () => {
            await expect(channelManager.getChannelMembers('nonexistent')).rejects.toThrow('Channel not found');
        });

        it('returns empty array for channels without a gate', async () => {
            channelManager.channels.set('pub', { type: 'public' });
            const result = await channelManager.getChannelMembers('pub');
            expect(result).toEqual([]);
        });

        it('annotates candidates through the gate contract', async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            gateManager.getGateMembers.mockResolvedValue([
                { address: '0xowner', isOwner: true, moderator: false, access: true },
                { address: '0xmember1', isOwner: false, moderator: false, access: true }
            ]);

            const members = await channelManager.getChannelMembers(streamId);

            expect(gateManager.getGateMembers).toHaveBeenCalledWith(
                '0xgate', expect.arrayContaining(['0xlocalmember1']));
            expect(members.length).toBeGreaterThanOrEqual(2);
        });

        it('maps the moderator flag onto canGrant', async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            gateManager.getGateMembers.mockResolvedValue([
                { address: '0xmod', isOwner: false, moderator: true, access: true }
            ]);

            const members = await channelManager.getChannelMembers(streamId);

            const mod = members.find(m => m.address.toLowerCase() === '0xmod');
            expect(mod.canGrant).toBe(true);
            expect(mod.isOwner).toBe(false);
        });

        it('filters banned and ex-members', async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            gateManager.getGateMembers.mockResolvedValue([
                { address: '0xbanned', isOwner: false, moderator: false, access: false }
            ]);

            const members = await channelManager.getChannelMembers(streamId);

            expect(members.find(m => m.address.toLowerCase() === '0xbanned')).toBeUndefined();
        });

        it('falls back to local cache when the chain is unreachable', async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            gateManager.getGateMembers.mockRejectedValue(new Error('rpc down'));

            const members = await channelManager.getChannelMembers(streamId);

            expect(members.find(m => m.address.toLowerCase() === '0xlocalmember1')).toBeDefined();
        });

        it('always includes owner with full permissions', async () => {
            const members = await channelManager.getChannelMembers(streamId);

            const owner = members.find(m => m.address.toLowerCase() === '0xowner');
            expect(owner).toBeDefined();
            expect(owner.isOwner).toBe(true);
            expect(owner.canGrant).toBe(true);
        });
    });

    // ==================== canAddMembers ====================
    describe('canAddMembers', () => {
        it('returns true for channel owner', async () => {
            channelManager.channels.set('stream-1', {
                type: 'gated',
                gate: { address: '0xgate' },
                members: ['0xmyaddress'],
                createdBy: '0xmyaddress'
            });

            const result = await channelManager.canAddMembers('stream-1');
            expect(result).toBe(true);
        });

        it('returns true for a gate moderator', async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            gateManager.canModerate.mockResolvedValue(true);
            channelManager.channels.set('stream-2', {
                type: 'gated',
                gate: { address: '0xgate' },
                members: ['0xmyaddress', '0xowner'],
                createdBy: '0xowner'
            });

            const result = await channelManager.canAddMembers('stream-2');
            expect(result).toBe(true);
        });

        it('returns false for a non-moderator member', async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            gateManager.canModerate.mockResolvedValue(false);
            channelManager.channels.set('stream-3', {
                type: 'gated',
                gate: { address: '0xgate' },
                members: ['0xmyaddress', '0xowner'],
                createdBy: '0xowner'
            });

            const result = await channelManager.canAddMembers('stream-3');
            expect(result).toBe(false);
        });

        it('returns false when the moderator check fails', async () => {
            const { gateManager } = await import('../../src/js/gate.js');
            gateManager.canModerate.mockRejectedValue(new Error('rpc down'));
            channelManager.channels.set('stream-4', {
                type: 'gated',
                gate: { address: '0xgate' },
                members: [],
                createdBy: '0xother'
            });

            const result = await channelManager.canAddMembers('stream-4');
            expect(result).toBe(false);
        });
    });

    // ==================== deleteChannel ====================
    describe('deleteChannel', () => {
        const streamId = '0xmyaddress/pombo/test-channel';

        beforeEach(() => {
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'password',
                createdBy: '0xmyaddress',
                members: ['0xmyaddress']
            });
        });

        it('deletes stream from network', async () => {
            await channelManager.deleteChannel(streamId);
            expect(streamrController.deleteStream).toHaveBeenCalledWith(streamId);
        });

        it('removes channel from local state', async () => {
            await channelManager.deleteChannel(streamId);
            expect(channelManager.channels.has(streamId)).toBe(false);
        });

        it('saves channels and removes from order', async () => {
            const saveSpy = vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            await channelManager.deleteChannel(streamId);
            expect(saveSpy).toHaveBeenCalled();
            expect(secureStorage.removeFromChannelOrder).toHaveBeenCalledWith(streamId);
        });

        it('cancels pending verifications', async () => {
            const cancelSpy = vi.spyOn(channelManager, 'cancelPendingVerifications');
            await channelManager.deleteChannel(streamId);
            expect(cancelSpy).toHaveBeenCalledWith(streamId);
        });

        it('clears current channel if deleting the active one', async () => {
            channelManager.currentChannel = streamId;
            await channelManager.deleteChannel(streamId);
            expect(channelManager.currentChannel).toBeNull();
        });

        it('does not clear current channel if different', async () => {
            channelManager.currentChannel = 'other-channel';
            await channelManager.deleteChannel(streamId);
            expect(channelManager.currentChannel).toBe('other-channel');
        });

        it('throws if not channel owner', async () => {
            channelManager.channels.set('other-stream', {
                type: 'password',
                createdBy: '0xotherowner',
                members: []
            });
            await expect(channelManager.deleteChannel('other-stream')).rejects.toThrow('owner');
        });

        it('proceeds with local delete even if network delete fails (non-gas error)', async () => {
            streamrController.deleteStream.mockRejectedValue(new Error('stream not found'));
            await channelManager.deleteChannel(streamId);
            // Should still remove locally
            expect(channelManager.channels.has(streamId)).toBe(false);
        });
    });

    // ==================== leaveChannel (non-DM path) ====================
    describe('leaveChannel (non-DM)', () => {
        const streamId = 'stream-public-1';

        beforeEach(() => {
            channelManager.channels.set(streamId, {
                messageStreamId: streamId,
                type: 'public',
                ephemeralStreamId: `${streamId}-ephemeral`,
                members: ['0xmyaddress']
            });
        });

        it('unsubscribes from dual stream', async () => {
            await channelManager.leaveChannel(streamId);
            expect(streamrController.unsubscribeFromDualStream).toHaveBeenCalledWith(streamId, `${streamId}-ephemeral`);
        });

        it('removes channel from map', async () => {
            await channelManager.leaveChannel(streamId);
            expect(channelManager.channels.has(streamId)).toBe(false);
        });

        it('saves channels and removes from order', async () => {
            const saveSpy = vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            await channelManager.leaveChannel(streamId);
            expect(saveSpy).toHaveBeenCalled();
            expect(secureStorage.removeFromChannelOrder).toHaveBeenCalledWith(streamId);
        });

        it('cancels pending verifications', async () => {
            const cancelSpy = vi.spyOn(channelManager, 'cancelPendingVerifications');
            await channelManager.leaveChannel(streamId);
            expect(cancelSpy).toHaveBeenCalledWith(streamId);
        });

        it('cleans up online users', async () => {
            channelManager.onlineUsers.set(streamId, new Map());
            await channelManager.leaveChannel(streamId);
            expect(channelManager.onlineUsers.has(streamId)).toBe(false);
        });

        it('clears current channel if leaving active one', async () => {
            channelManager.currentChannel = streamId;
            await channelManager.leaveChannel(streamId);
            expect(channelManager.currentChannel).toBeNull();
        });

        it('derives ephemeral ID if not on channel', async () => {
            const channel = channelManager.channels.get(streamId);
            delete channel.ephemeralStreamId;

            await channelManager.leaveChannel(streamId);

            expect(streamrController.unsubscribeFromDualStream).toHaveBeenCalledWith(streamId, `${streamId}-ephemeral`);
        });
    });

    // ==================== leaveAllChannels ====================
    describe('leaveAllChannels', () => {
        it('unsubscribes from all channels', async () => {
            channelManager.channels.set('ch1', { type: 'public' });
            channelManager.channels.set('ch2', { type: 'password' });

            await channelManager.leaveAllChannels();

            expect(streamrController.unsubscribe).toHaveBeenCalledWith('ch1');
            expect(streamrController.unsubscribe).toHaveBeenCalledWith('ch2');
        });

        it('clears all state', async () => {
            channelManager.channels.set('ch1', { type: 'public' });
            channelManager.currentChannel = 'ch1';
            channelManager.onlineUsers.set('ch1', new Map());
            channelManager.processingMessages.add('msg1');

            await channelManager.leaveAllChannels();

            expect(channelManager.channels.size).toBe(0);
            expect(channelManager.currentChannel).toBeNull();
            expect(channelManager.onlineUsers.size).toBe(0);
            expect(channelManager.processingMessages.size).toBe(0);
        });

        it('clears pending verification timers', async () => {
            const timer = setTimeout(() => {}, 99999);
            channelManager.pendingVerifications.set('ch1', { messages: [], timer });

            const clearSpy = vi.spyOn(global, 'clearTimeout');
            await channelManager.leaveAllChannels();

            expect(clearSpy).toHaveBeenCalledWith(timer);
            expect(channelManager.pendingVerifications.size).toBe(0);
        });

        it('swallows individual unsubscribe errors', async () => {
            channelManager.channels.set('ch1', { type: 'public' });
            channelManager.channels.set('ch2', { type: 'password' });
            streamrController.unsubscribe.mockRejectedValueOnce(new Error('fail'));

            // Should not throw
            await expect(channelManager.leaveAllChannels()).resolves.not.toThrow();

            // ch2 should still be unsubscribed
            expect(streamrController.unsubscribe).toHaveBeenCalledWith('ch2');
        });
    });

    // ==================== syncChannelFromGraph ====================
    describe('syncChannelFromGraph', () => {
        const streamId = 'stream-sync-1';

        beforeEach(() => {
            channelManager.channels.set(streamId, {
                type: 'public',
                members: [],
                createdBy: null
            });
        });

        it('returns null if channel not in map', async () => {
            const result = await channelManager.syncChannelFromGraph('nonexistent');
            expect(result).toBeNull();
        });

        it('fetches stream data, type, and members in parallel', async () => {
            graphAPI.getStream.mockResolvedValue({ id: streamId });
            graphAPI.detectStreamType.mockResolvedValue('password');
            graphAPI.getStreamMembers.mockResolvedValue({
                ok: true,
                data: [{ address: '0xowner', isOwner: true }]
            });

            await channelManager.syncChannelFromGraph(streamId);

            expect(graphAPI.getStream).toHaveBeenCalledWith(streamId);
            expect(graphAPI.detectStreamType).toHaveBeenCalledWith(streamId);
            expect(graphAPI.getStreamMembers).toHaveBeenCalledWith(streamId);
        });

        it('updates channel type from Graph', async () => {
            graphAPI.getStream.mockResolvedValue({ id: streamId });
            graphAPI.detectStreamType.mockResolvedValue('password');
            graphAPI.getStreamMembers.mockResolvedValue({ ok: true, data: [] });

            await channelManager.syncChannelFromGraph(streamId);

            const channel = channelManager.channels.get(streamId);
            expect(channel.type).toBe('password');
        });

        it('updates members and owner from Graph', async () => {
            graphAPI.getStream.mockResolvedValue({ id: streamId });
            graphAPI.detectStreamType.mockResolvedValue('password');
            graphAPI.getStreamMembers.mockResolvedValue({
                ok: true,
                data: [
                    { address: '0xOwner', isOwner: true },
                    { address: '0xMember1', isOwner: false }
                ]
            });

            await channelManager.syncChannelFromGraph(streamId);

            const channel = channelManager.channels.get(streamId);
            expect(channel.members).toContain('0xOwner');
            expect(channel.members).toContain('0xMember1');
            expect(channel.createdBy).toBe('0xOwner');
        });

        it('saves channels after sync', async () => {
            const saveSpy = vi.spyOn(channelManager, 'saveChannels').mockResolvedValue(undefined);
            graphAPI.getStream.mockResolvedValue({ id: streamId });
            graphAPI.detectStreamType.mockResolvedValue('public');
            graphAPI.getStreamMembers.mockResolvedValue({ ok: true, data: [] });

            await channelManager.syncChannelFromGraph(streamId);

            expect(saveSpy).toHaveBeenCalled();
        });

        it('returns channel unchanged on error', async () => {
            graphAPI.getStream.mockRejectedValue(new Error('network'));

            const result = await channelManager.syncChannelFromGraph(streamId);

            expect(result.type).toBe('public'); // unchanged
        });

        it('does not update type if detectStreamType returns unknown', async () => {
            graphAPI.getStream.mockResolvedValue({ id: streamId });
            graphAPI.detectStreamType.mockResolvedValue('unknown');
            graphAPI.getStreamMembers.mockResolvedValue({ ok: true, data: [] });

            const channelBefore = channelManager.channels.get(streamId);
            channelBefore.type = 'password';

            await channelManager.syncChannelFromGraph(streamId);

            expect(channelManager.channels.get(streamId).type).toBe('password');
        });
    });

    // ==================== publishPresence ====================
    describe('publishPresence', () => {
        it('does nothing if channel not found', async () => {
            await channelManager.publishPresence('nonexistent');
            expect(streamrController.publishControl).not.toHaveBeenCalled();
        });

        it('publishes presence to ephemeral stream for regular channel', async () => {
            channelManager.channels.set('stream-1', {
                type: 'public',
                ephemeralStreamId: 'stream-1-eph',
                password: null
            });

            await channelManager.publishPresence('stream-1');

            expect(streamrController.publishControl).toHaveBeenCalledWith(
                'stream-1-eph',
                expect.objectContaining({ type: 'presence', nickname: 'TestUser' }),
                null
            );
        });

        it('publishes with password for encrypted channels', async () => {
            channelManager.channels.set('stream-enc', {
                type: 'password',
                ephemeralStreamId: 'stream-enc-eph',
                password: 'secret123'
            });

            await channelManager.publishPresence('stream-enc');

            expect(streamrController.publishControl).toHaveBeenCalledWith(
                'stream-enc-eph',
                expect.objectContaining({ type: 'presence' }),
                'secret123'
            );
        });

        it('derives ephemeral ID if not on channel', async () => {
            channelManager.channels.set('stream-no-eph', {
                type: 'public',
                password: null
            });

            await channelManager.publishPresence('stream-no-eph');

            expect(streamrController.publishControl).toHaveBeenCalledWith(
                'stream-no-eph-ephemeral',
                expect.any(Object),
                null
            );
        });

        it('seals DM presence instead of encrypting to the peer key', async () => {
            channelManager.channels.set('dm-stream', {
                type: 'dm',
                peerAddress: '0xpeer',
                ephemeralStreamId: 'dm-eph'
            });

            await channelManager.publishPresence('dm-stream');

            expect(dmManager.sealAndPublish).toHaveBeenCalledWith(
                'dm-eph',
                '0xpeer',
                expect.objectContaining({ type: 'presence' }),
                expect.any(Number)
            );
            // The peer's public key is no longer needed. Depending on it meant
            // presence silently vanished whenever the peer's inbox metadata
            // lacked the key — which is exactly what happened in testing.
            expect(dmManager.getPeerPublicKey).not.toHaveBeenCalled();
        });

        it('silently fails DM presence without error', async () => {
            channelManager.channels.set('dm-stream', {
                type: 'dm',
                peerAddress: '0xpeer',
                ephemeralStreamId: 'dm-eph'
            });
            dmCrypto.encrypt.mockRejectedValue(new Error('encrypt fail'));

            // Should not throw
            await expect(channelManager.publishPresence('dm-stream')).resolves.not.toThrow();
        });

        it('silently handles publishControl error', async () => {
            channelManager.channels.set('stream-1', {
                type: 'public',
                ephemeralStreamId: 'stream-1-eph',
                password: null
            });
            streamrController.publishControl.mockRejectedValue(new Error('publish fail'));

            await expect(channelManager.publishPresence('stream-1')).resolves.not.toThrow();
        });
    });

    // ==================== startPresenceTracking ====================
    describe('startPresenceTracking', () => {
        it('publishes presence immediately', async () => {
            channelManager.channels.set('stream-1', {
                type: 'public',
                ephemeralStreamId: 'stream-1-eph',
                password: null
            });
            const spy = vi.spyOn(channelManager, 'publishPresence').mockResolvedValue(undefined);

            channelManager.startPresenceTracking('stream-1');

            expect(spy).toHaveBeenCalledWith('stream-1');
        });

        it('sets up interval', () => {
            channelManager.channels.set('stream-1', { type: 'public', password: null });
            vi.spyOn(channelManager, 'publishPresence').mockResolvedValue(undefined);

            channelManager.startPresenceTracking('stream-1');

            expect(channelManager.presenceInterval).not.toBeNull();
        });

        it('clears previous interval', () => {
            const clearSpy = vi.spyOn(global, 'clearInterval');
            const oldInterval = setInterval(() => {}, 99999);
            channelManager.presenceInterval = oldInterval;

            channelManager.channels.set('stream-1', { type: 'public', password: null });
            vi.spyOn(channelManager, 'publishPresence').mockResolvedValue(undefined);

            channelManager.startPresenceTracking('stream-1');

            expect(clearSpy).toHaveBeenCalledWith(oldInterval);
        });
    });

    // ==================== stopPresenceTracking ====================
    describe('stopPresenceTracking', () => {
        it('clears presence interval', () => {
            const interval = setInterval(() => {}, 99999);
            channelManager.presenceInterval = interval;
            const clearSpy = vi.spyOn(global, 'clearInterval');

            channelManager.stopPresenceTracking();

            expect(clearSpy).toHaveBeenCalledWith(interval);
            expect(channelManager.presenceInterval).toBeNull();
        });

        it('calls dmManager.unsubscribeDMEphemeral', () => {
            channelManager.stopPresenceTracking();
            expect(dmManager.unsubscribeDMEphemeral).toHaveBeenCalled();
        });

        it('handles null interval', () => {
            channelManager.presenceInterval = null;
            expect(() => channelManager.stopPresenceTracking()).not.toThrow();
        });
    });

    // ==================== handleMediaMessage ====================
    describe('handleMediaMessage', () => {
        it('notifies handlers for media messages', () => {
            const handler = vi.fn();
            channelManager.onMessage(handler);

            channelManager.handleMediaMessage('stream-1', { type: 'image_data', imageId: 'img1' });

            expect(handler).toHaveBeenCalledWith('media', expect.objectContaining({
                streamId: 'stream-1',
                media: { type: 'image_data', imageId: 'img1' }
            }));
        });

        it('skips presence messages', () => {
            const handler = vi.fn();
            channelManager.onMessage(handler);

            channelManager.handleMediaMessage('stream-1', { type: 'presence' });

            expect(handler).not.toHaveBeenCalled();
        });

        it('skips typing messages', () => {
            const handler = vi.fn();
            channelManager.onMessage(handler);

            channelManager.handleMediaMessage('stream-1', { type: 'typing' });

            expect(handler).not.toHaveBeenCalled();
        });

        it('skips reaction messages', () => {
            const handler = vi.fn();
            channelManager.onMessage(handler);

            channelManager.handleMediaMessage('stream-1', { type: 'reaction' });

            expect(handler).not.toHaveBeenCalled();
        });

        it('skips messages without type', () => {
            const handler = vi.fn();
            channelManager.onMessage(handler);

            channelManager.handleMediaMessage('stream-1', { data: 'raw' });

            expect(handler).not.toHaveBeenCalled();
        });

        it('skips when not connected', () => {
            authManager.isConnected.mockReturnValue(false);
            const handler = vi.fn();
            channelManager.onMessage(handler);

            channelManager.handleMediaMessage('stream-1', { type: 'image_data' });

            expect(handler).not.toHaveBeenCalled();
        });
    });

    // ==================== queueMessageForBatchVerification ====================
    describe('queueMessageForBatchVerification', () => {
        it('creates batch if none exists', () => {
            const channel = { messages: [] };
            channelManager.queueMessageForBatchVerification('stream-1', { id: 'msg1' }, channel);

            expect(channelManager.pendingVerifications.has('stream-1')).toBe(true);
            const batch = channelManager.pendingVerifications.get('stream-1');
            expect(batch.messages).toHaveLength(1);
        });

        it('adds to existing batch', () => {
            channelManager.pendingVerifications.set('stream-1', { messages: [{ data: {}, channel: {} }], timer: null });

            channelManager.queueMessageForBatchVerification('stream-1', { id: 'msg2' }, { messages: [] });

            const batch = channelManager.pendingVerifications.get('stream-1');
            expect(batch.messages).toHaveLength(2);
        });

        it('sets debounce timer', () => {
            vi.useFakeTimers();
            const channel = { messages: [] };

            channelManager.queueMessageForBatchVerification('stream-1', { id: 'msg1' }, channel);

            const batch = channelManager.pendingVerifications.get('stream-1');
            expect(batch.timer).not.toBeNull();
            vi.useRealTimers();
        });

        it('flushes immediately when batch is full', () => {
            const flushSpy = vi.spyOn(channelManager, 'flushBatchVerification').mockResolvedValue(undefined);
            const channel = { messages: [] };

            // Fill batch to max
            channelManager.pendingVerifications.set('stream-1', {
                messages: new Array(channelManager.BATCH_MAX_SIZE - 1).fill({ data: {}, channel }),
                timer: null
            });

            channelManager.queueMessageForBatchVerification('stream-1', { id: 'trigger' }, channel);

            expect(flushSpy).toHaveBeenCalledWith('stream-1');
        });

        it('resets timer on new message', () => {
            vi.useFakeTimers();
            const channel = { messages: [] };

            channelManager.queueMessageForBatchVerification('stream-1', { id: 'msg1' }, channel);
            const firstTimer = channelManager.pendingVerifications.get('stream-1').timer;

            channelManager.queueMessageForBatchVerification('stream-1', { id: 'msg2' }, channel);
            const secondTimer = channelManager.pendingVerifications.get('stream-1').timer;

            // Timer should be reset (different ID)
            expect(secondTimer).not.toBe(firstTimer);
            vi.useRealTimers();
        });
    });

    // ==================== subscribeToChannel ====================
    describe('subscribeToChannel', () => {
        it('loads from local storage for write-only channels', async () => {
            channelManager.channels.set('wo-stream', {
                type: 'public',
                writeOnly: true,
                messages: [],
                reactions: {},
                ephemeralStreamId: 'wo-stream-eph'
            });
            secureStorage.getSentMessages.mockReturnValue([
                { id: 'm1', text: 'hello', timestamp: Date.now() }
            ]);
            secureStorage.getSentReactions.mockReturnValue({ m1: { '👍': ['0x1'] } });

            await channelManager.subscribeToChannel('wo-stream');

            const channel = channelManager.channels.get('wo-stream');
            expect(channel.historyLoaded).toBe(true);
            expect(channel.hasMoreHistory).toBe(false);
            expect(channel.messages).toHaveLength(1);
            expect(channel.reactions).toEqual({ m1: { '👍': ['0x1'] } });
        });

        it('loads DM timeline for DM channels', async () => {
            channelManager.channels.set('dm-stream', {
                type: 'dm',
                peerAddress: '0xpeer',
                messages: []
            });

            await channelManager.subscribeToChannel('dm-stream');

            expect(dmManager.loadDMTimeline).toHaveBeenCalledWith('0xpeer');
            expect(dmManager.subscribeDMEphemeral).toHaveBeenCalled();
            const channel = channelManager.channels.get('dm-stream');
            expect(channel.historyLoaded).toBe(true);
        });

        it('subscribes to dual stream for regular channels', async () => {
            channelManager.channels.set('pub-stream', {
                type: 'public',
                messages: [],
                ephemeralStreamId: 'pub-stream-eph'
            });

            await channelManager.subscribeToChannel('pub-stream');

            expect(streamrController.subscribeToDualStream).toHaveBeenCalledWith(
                'pub-stream',
                'pub-stream-eph',
                expect.objectContaining({
                    onMessage: expect.any(Function),
                    onControl: expect.any(Function),
                    onMedia: expect.any(Function)
                }),
                undefined,
                expect.any(Number),
                expect.any(Function)
            );
        });

        it('passes password for encrypted channels', async () => {
            channelManager.channels.set('enc-stream', {
                type: 'password',
                password: 'secret',
                messages: [],
                ephemeralStreamId: 'enc-stream-eph'
            });

            await channelManager.subscribeToChannel('enc-stream', 'secret');

            expect(streamrController.subscribeToDualStream).toHaveBeenCalledWith(
                'enc-stream',
                'enc-stream-eph',
                expect.any(Object),
                'secret',
                expect.any(Number),
                expect.any(Function)
            );
        });

        it('unsubscribes from DM ephemeral for non-DM channels', async () => {
            channelManager.channels.set('pub-stream', {
                type: 'public',
                messages: [],
                ephemeralStreamId: 'pub-stream-eph'
            });

            await channelManager.subscribeToChannel('pub-stream');

            expect(dmManager.unsubscribeDMEphemeral).toHaveBeenCalled();
        });

        it('derives ephemeral ID if not stored', async () => {
            channelManager.channels.set('stream-no-eph', {
                type: 'public',
                messages: []
            });

            await channelManager.subscribeToChannel('stream-no-eph');

            expect(streamrController.subscribeToDualStream).toHaveBeenCalledWith(
                'stream-no-eph',
                'stream-no-eph-ephemeral',
                expect.any(Object),
                undefined,
                expect.any(Number),
                expect.any(Function)
            );
        });
    });

    // ==================== handlePresenceMessage ====================
    describe('handlePresenceMessage', () => {
        it('creates user tracking map if none exists', () => {
            channelManager.handlePresenceMessage('stream-1', {
                account: '0xuser1',
                nickname: 'User1',
                lastActive: Date.now()
            });

            expect(channelManager.onlineUsers.has('stream-1')).toBe(true);
            const users = channelManager.onlineUsers.get('stream-1');
            expect(users.has('0xuser1')).toBe(true);
        });

        it('updates existing user data', () => {
            channelManager.onlineUsers.set('stream-1', new Map());
            const now = Date.now();

            channelManager.handlePresenceMessage('stream-1', {
                account: '0xuser1',
                nickname: 'NewNick',
                lastActive: now
            });

            const user = channelManager.onlineUsers.get('stream-1').get('0xuser1');
            expect(user.nickname).toBe('NewNick');
            expect(user.lastActive).toBe(now);
        });

        it('prefers account over userId', () => {
            channelManager.handlePresenceMessage('stream-1', {
                account: '0xsender',
                userId: '0xuser',
                nickname: 'Nick'
            });

            const users = channelManager.onlineUsers.get('stream-1');
            expect(users.has('0xsender')).toBe(true);
            expect(users.has('0xuser')).toBe(false);
        });

        it('ignores messages without ID', () => {
            channelManager.handlePresenceMessage('stream-1', { nickname: 'NoId' });
            // Should create the Map but not add any users
            const users = channelManager.onlineUsers.get('stream-1');
            expect(users?.size || 0).toBe(0);
        });

        it('notifies online users handlers', () => {
            const handler = vi.fn();
            channelManager.onlineUsersHandlers.push(handler);

            channelManager.handlePresenceMessage('stream-1', {
                account: '0xuser1',
                nickname: 'User1'
            });

            expect(handler).toHaveBeenCalledWith('stream-1', expect.any(Array));
        });
    });

    // ==================== getOnlineUsers ====================
    describe('getOnlineUsers', () => {
        it('returns empty array if no tracking for stream', () => {
            expect(channelManager.getOnlineUsers('nonexistent')).toEqual([]);
        });

        it('returns only active users (within timeout)', () => {
            const now = Date.now();
            const users = new Map();
            users.set('0xactive', { lastActive: now, nickname: 'Active', address: '0xactive' });
            users.set('0xstale', { lastActive: now - 999999, nickname: 'Stale', address: '0xstale' });
            channelManager.onlineUsers.set('stream-1', users);

            const result = channelManager.getOnlineUsers('stream-1');

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('0xactive');
        });
    });

    // ==================== notifyOnlineUsersChange ====================
    describe('notifyOnlineUsersChange', () => {
        it('calls all registered handlers', () => {
            const handler1 = vi.fn();
            const handler2 = vi.fn();
            channelManager.onlineUsersHandlers.push(handler1, handler2);

            channelManager.notifyOnlineUsersChange('stream-1');

            expect(handler1).toHaveBeenCalledWith('stream-1', expect.any(Array));
            expect(handler2).toHaveBeenCalledWith('stream-1', expect.any(Array));
        });

        it('catches handler errors', () => {
            const badHandler = vi.fn(() => { throw new Error('boom'); });
            const goodHandler = vi.fn();
            channelManager.onlineUsersHandlers.push(badHandler, goodHandler);

            expect(() => channelManager.notifyOnlineUsersChange('stream-1')).not.toThrow();
            expect(goodHandler).toHaveBeenCalled();
        });
    });
});
