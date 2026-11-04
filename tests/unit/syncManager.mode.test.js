/**
 * SyncManager sync-mode tests
 * Which unprompted sync triggers each mode lets through
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing syncManager
vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock('../../src/js/config.js', () => ({
    CONFIG: {
        dm: {
            maxSentMessages: 200
        }
    }
}));

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        getDMInboxId: vi.fn().mockReturnValue('0xabc/Pombo-DM-1'),
        publish: vi.fn().mockResolvedValue(undefined),
        fetchPartitionHistory: vi.fn().mockResolvedValue([]),
        setDMPublishKey: vi.fn().mockResolvedValue(undefined),
        addDMDecryptKey: vi.fn().mockResolvedValue(undefined)
    },
    STREAM_CONFIG: {
        MESSAGE_STREAM: {
            PARTITIONS: 1,
            DM_PARTITIONS: 3,
            MESSAGES: 0,
            SYNC: 1,
            SYNC_BLOBS: 2
        }
    }
}));

vi.mock('../../src/js/dm.js', () => ({
    dmManager: {
        hasInbox: vi.fn().mockResolvedValue(true),
        sealAndPublish: vi.fn().mockResolvedValue({ messageId: { publisherId: '0xEphemeral' } })
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        exportForSync: vi.fn().mockReturnValue({
            sentMessages: {},
            sentReactions: {},
            channels: [],
            blockedPeers: [],
            dmLeftAt: {},
            trustedContacts: {},
            ensCache: {},
            username: null,
            graphApiKey: null
        }),
        exportForBackup: vi.fn().mockReturnValue({
            sentMessages: {},
            sentReactions: {},
            channels: [],
            blockedPeers: [],
            dmLeftAt: {},
            trustedContacts: {},
            ensCache: {},
            username: null,
            graphApiKey: null
        }),
        importFromSync: vi.fn().mockResolvedValue({
            hasChanges: false,
            channelsUpdated: false,
            contactsUpdated: false,
            blockedPeersUpdated: false,
            usernameUpdated: false
        }),
        getUnsyncedImages: vi.fn().mockReturnValue({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }) }),
        decryptBlob: vi.fn().mockResolvedValue('base64data'),
        markImageSynced: vi.fn().mockResolvedValue(undefined),
        saveImageToLedger: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        isGuestMode: vi.fn().mockReturnValue(false),
        getAddress: vi.fn().mockReturnValue('0xabc123'),
        wallet: null  // Will be set per test
    }
}));

vi.mock('../../src/js/dmCrypto.js', () => ({
    dmCrypto: {
        getMyPublicKey: vi.fn().mockReturnValue('0x02abcdef'),
        deriveSharedKey: vi.fn().mockResolvedValue({ type: 'secret' }),
        encrypt: vi.fn().mockResolvedValue({ ct: 'encrypted', iv: 'iv123', e: 'aes-256-gcm' }),
        decrypt: vi.fn().mockImplementation(async (env) => env._decrypted || { type: 'sync', v: 1, ts: Date.now(), data: {} }),
        isEncrypted: vi.fn().mockReturnValue(true),
        // Sealed sender (v2). Default off — legacy self-ECDH still has to work
        // for sync history already in storage.
        isSealed: vi.fn().mockReturnValue(false),
        open: vi.fn().mockResolvedValue({ sender: '0xabc123', message: { type: 'sync', v: 1 } })
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        reloadChannelsFromSync: vi.fn().mockReturnValue({
            currentChannelRemoved: false,
            totalChannels: 0
        })
    }
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        loadTrustedContacts: vi.fn(),
        loadUsername: vi.fn()
    }
}));

vi.mock('../../src/js/epochKeyManager.js', () => ({
    epochKeyManager: {
        applyPersisted: vi.fn().mockReturnValue(false)
    }
}));

vi.mock('../../src/js/media.js', () => ({
    mediaController: {
        handleMediaMessage: vi.fn()
    }
}));

import { syncManager, SYNC_MODES } from '../../src/js/syncManager.js';
import { authManager } from '../../src/js/auth.js';

describe('syncManager sync mode', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        syncManager.cancelAutoPush();
        syncManager.isSyncing = false;
        syncManager.handlers = [];
        authManager.isGuestMode.mockReturnValue(false);
        authManager.getAddress.mockReturnValue('0xabc123');
        localStorage.clear();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('getSyncMode / setSyncMode', () => {
        it('defaults to automatic when nothing is stored', () => {
            expect(syncManager.getSyncMode()).toBe(SYNC_MODES.AUTOMATIC);
        });

        it('round-trips a stored mode', () => {
            expect(syncManager.setSyncMode(SYNC_MODES.MANUAL_ONLY)).toBe(true);
            expect(syncManager.getSyncMode()).toBe(SYNC_MODES.MANUAL_ONLY);
        });

        it('rejects an unknown mode without touching storage', () => {
            syncManager.setSyncMode(SYNC_MODES.NOT_ON_START);
            expect(syncManager.setSyncMode('whenever')).toBe(false);
            expect(syncManager.getSyncMode()).toBe(SYNC_MODES.NOT_ON_START);
        });

        it('falls back to automatic on a mode written by a newer build', () => {
            localStorage.setItem('pombo_sync_mode_0xabc123', 'on_wifi_only');
            expect(syncManager.getSyncMode()).toBe(SYNC_MODES.AUTOMATIC);
        });

        it('keeps the mode per account', () => {
            syncManager.setSyncMode(SYNC_MODES.MANUAL_ONLY);
            authManager.getAddress.mockReturnValue('0xdef456');
            expect(syncManager.getSyncMode()).toBe(SYNC_MODES.AUTOMATIC);
        });

        it('cancels a pending auto-push when switching to manual only', () => {
            syncManager.scheduleAutoPush(15000);
            expect(syncManager.autoPushTimeout).not.toBe(null);

            syncManager.setSyncMode(SYNC_MODES.MANUAL_ONLY);

            expect(syncManager.autoPushTimeout).toBe(null);
        });
    });

    describe('isAutoSyncAllowed', () => {
        it('allows every trigger on automatic', () => {
            for (const trigger of ['start', 'foreground', 'change', 'hide']) {
                expect(syncManager.isAutoSyncAllowed(trigger)).toBe(true);
            }
        });

        it('blocks only the connect run on skip-on-start', () => {
            syncManager.setSyncMode(SYNC_MODES.NOT_ON_START);
            expect(syncManager.isAutoSyncAllowed('start')).toBe(false);
            expect(syncManager.isAutoSyncAllowed('foreground')).toBe(true);
            expect(syncManager.isAutoSyncAllowed('change')).toBe(true);
            expect(syncManager.isAutoSyncAllowed('hide')).toBe(true);
        });

        it('blocks every trigger on manual only', () => {
            syncManager.setSyncMode(SYNC_MODES.MANUAL_ONLY);
            for (const trigger of ['start', 'foreground', 'change', 'hide']) {
                expect(syncManager.isAutoSyncAllowed(trigger)).toBe(false);
            }
        });
    });

    describe('gated triggers', () => {
        it('records the change but skips the push on manual only', () => {
            syncManager.setSyncMode(SYNC_MODES.MANUAL_ONLY);

            syncManager.scheduleAutoPush(15000);

            expect(syncManager.isDirty()).toBe(true);
            expect(syncManager.autoPushTimeout).toBe(null);
        });

        it('still schedules the push on skip-on-start', () => {
            syncManager.setSyncMode(SYNC_MODES.NOT_ON_START);

            syncManager.scheduleAutoPush(15000);

            expect(syncManager.autoPushTimeout).not.toBe(null);
        });

        it('skips the unload flush on manual only', async () => {
            syncManager.setSyncMode(SYNC_MODES.MANUAL_ONLY);
            const pushSync = vi.spyOn(syncManager, 'pushSync').mockResolvedValue({});

            await syncManager.forcePushNow();

            expect(pushSync).not.toHaveBeenCalled();
            pushSync.mockRestore();
        });

        it('flushes on unload in the other modes', async () => {
            syncManager.setSyncMode(SYNC_MODES.NOT_ON_START);
            const pushSync = vi.spyOn(syncManager, 'pushSync').mockResolvedValue({});

            await syncManager.forcePushNow();

            expect(pushSync).toHaveBeenCalled();
            pushSync.mockRestore();
        });
    });
});
