/**
 * Tests for backupImport.js — shared account-backup data import
 * (Connect-modal restore + Settings import).
 */

import { describe, it, expect, vi } from 'vitest';
import { importBackupData } from '../../src/js/backupImport.js';

const makeDeps = (cacheOverrides = {}) => {
    const cache = { channels: [], channelsLeftAt: {}, ...cacheOverrides };
    const secureStorage = {
        cache,
        isStorageUnlocked: vi.fn().mockReturnValue(true),
        saveToStorage: vi.fn().mockResolvedValue(undefined)
    };
    const channelManager = {
        reloadChannelsFromSync: vi.fn(),
        onChannelsSaved: vi.fn()
    };
    const identityManager = {
        loadUsername: vi.fn(),
        loadTrustedContacts: vi.fn()
    };
    return { secureStorage, channelManager, identityManager, cache };
};

// Android's Channel.toJson() serializes absent optionals as JSON null and
// carries fields the web never persists (keysStreamId, storageProvider).
const androidChannel = (id, name, extra = {}) => ({
    peerAddress: null,
    messageStreamId: id,
    ephemeralStreamId: `${id}-e`,
    adminStreamId: `${id}-3`,
    keysStreamId: '',
    name,
    type: 'public',
    gate: null,
    createdAt: 1700000000000,
    createdBy: null,
    joinedAt: null,
    password: null,
    members: [],
    storageEnabled: false,
    storageProvider: 'streamr',
    storageDays: null,
    exposure: 'hidden',
    description: '',
    language: '',
    category: '',
    classification: null,
    readOnly: false,
    writeOnly: false,
    metaUpdatedAt: null,
    ...extra
});

describe('importBackupData', () => {
    it('imports Android-shaped channels into the cache and reloads the manager', async () => {
        const { secureStorage, channelManager, cache } = makeDeps();
        const data = { channels: [androidChannel('ch1', 'Alpha'), androidChannel('ch2', 'Beta')] };

        const summary = await importBackupData(data, { secureStorage, channelManager });

        expect(cache.channels.map(c => c.messageStreamId)).toEqual(['ch1', 'ch2']);
        expect(channelManager.reloadChannelsFromSync).toHaveBeenCalled();
        expect(secureStorage.saveToStorage).toHaveBeenCalled();
        expect(summary.channelsImported).toBe(2);
        expect(summary.changed).toBe(true);
    });

    it('updates the cache and the manager map before the first await', () => {
        // A concurrent saveChannels() persists the manager map wholesale over
        // the cache; if the map lagged the cache across an await, that save
        // would erase the imported channels.
        const { secureStorage, channelManager, cache } = makeDeps();
        const data = { channels: [androidChannel('ch1', 'Alpha')] };

        const pending = importBackupData(data, { secureStorage, channelManager });

        expect(cache.channels.map(c => c.messageStreamId)).toEqual(['ch1']);
        expect(channelManager.reloadChannelsFromSync).toHaveBeenCalled();
        return pending;
    });

    it('keeps the local entry when the backup carries the same channel (tie)', async () => {
        const local = androidChannel('ch1', 'Local name');
        const { secureStorage, channelManager, cache } = makeDeps({ channels: [local] });
        const data = { channels: [androidChannel('ch1', 'Backup name')] };

        const summary = await importBackupData(data, { secureStorage, channelManager });

        expect(cache.channels).toHaveLength(1);
        expect(cache.channels[0].name).toBe('Local name');
        expect(summary.channelsImported).toBe(0);
    });

    it('prefers the backup entry when its join is strictly newer', async () => {
        const local = androidChannel('ch1', 'Old join', { joinedAt: 1000 });
        const { secureStorage, channelManager, cache } = makeDeps({ channels: [local] });
        const data = { channels: [androidChannel('ch1', 'Re-joined', { joinedAt: 2000 })] };

        await importBackupData(data, { secureStorage, channelManager });

        expect(cache.channels[0].name).toBe('Re-joined');
    });

    it('honors a newer leave tombstone from the backup', async () => {
        const local = androidChannel('ch1', 'Left elsewhere', { joinedAt: 1000 });
        const { secureStorage, channelManager, cache } = makeDeps({ channels: [local] });
        const data = { channels: [], channelsLeftAt: { ch1: 2000 } };

        await importBackupData(data, { secureStorage, channelManager });

        expect(cache.channels).toHaveLength(0);
        expect(cache.channelsLeftAt.ch1).toBe(2000);
    });

    it('normalizes legacy entries keyed by streamId only', async () => {
        const { secureStorage, channelManager, cache } = makeDeps();
        const data = { channels: [{ streamId: 'legacy1', name: 'Legacy' }] };

        await importBackupData(data, { secureStorage, channelManager });

        expect(cache.channels[0].messageStreamId).toBe('legacy1');
    });

    it('does not import slice timestamps from the backup', async () => {
        const { secureStorage, channelManager, cache } = makeDeps({ sliceTs: { username: 42 } });
        const data = {
            channels: [androidChannel('ch1', 'Alpha')],
            sliceTs: { username: 9999999999999, trustedContacts: 9999999999999 }
        };

        await importBackupData(data, { secureStorage, channelManager });

        expect(cache.sliceTs).toEqual({ username: 42 });
    });

    it('imports the remaining slices with add-only semantics', async () => {
        const { secureStorage, channelManager, cache } = makeDeps({
            username: 'Kept',
            sentMessages: { s1: [{ id: 'local' }] },
            blockedPeers: ['0xexisting'],
            dmLeftAt: { '0xpeer1': 100 }
        });
        const data = {
            username: 'Ignored',
            trustedContacts: { '0xfriend': { address: '0xfriend' } },
            sentMessages: { s1: [{ id: 'backup' }], s2: [{ id: 'new' }] },
            sentReactions: { s2: { m1: { '👍': ['0x1'] } } },
            blockedPeers: ['0xExisting', '0xNew'],
            dmLeftAt: { '0xpeer1': 200, '0xpeer2': 300 }
        };

        const summary = await importBackupData(data, { secureStorage, channelManager });

        expect(cache.username).toBe('Kept');
        expect(cache.trustedContacts['0xfriend']).toBeDefined();
        expect(cache.sentMessages.s1[0].id).toBe('local');
        expect(cache.sentMessages.s2[0].id).toBe('new');
        expect(cache.sentReactions.s2).toBeDefined();
        expect(cache.blockedPeers).toEqual(['0xexisting', '0xnew']);
        expect(cache.dmLeftAt).toEqual({ '0xpeer1': 100, '0xpeer2': 300 });
        expect(summary.contactsImported).toBe(1);
        expect(summary.dmHistories).toBe(2);
    });

    it('does not restore a sent DM deleted here or in the backup, and keeps both deletion records', async () => {
        const { secureStorage, channelManager, cache } = makeDeps({
            sentDeletedAt: { s2: { gone: 500 } }
        });
        const data = {
            sentMessages: { s2: [{ id: 'gone' }, { id: 'kept' }, { id: 'also-gone' }] },
            sentDeletedAt: { s2: { 'also-gone': 600 } }
        };

        await importBackupData(data, { secureStorage, channelManager });

        expect(cache.sentMessages.s2.map(m => m.id)).toEqual(['kept']);
        expect(cache.sentDeletedAt).toEqual({ s2: { gone: 500, 'also-gone': 600 } });
    });

    it('reloads the identity manager for the slices it caches in memory', async () => {
        const { secureStorage, channelManager, identityManager } = makeDeps();
        const data = {
            username: 'Restored',
            trustedContacts: { '0xfriend': { address: '0xfriend' } }
        };

        const summary = await importBackupData(
            data,
            { secureStorage, channelManager, identityManager }
        );

        expect(summary.usernameImported).toBe(true);
        expect(identityManager.loadUsername).toHaveBeenCalledTimes(1);
        expect(identityManager.loadTrustedContacts).toHaveBeenCalledTimes(1);
    });

    it('leaves the identity manager alone when no cached slice changed', async () => {
        const { secureStorage, channelManager, identityManager } = makeDeps({
            username: 'Kept',
            trustedContacts: { '0xfriend': { address: '0xfriend' } }
        });
        const data = {
            username: 'Ignored',
            trustedContacts: { '0xfriend': { address: '0xfriend', nickname: 'Ignored' } }
        };

        const summary = await importBackupData(
            data,
            { secureStorage, channelManager, identityManager }
        );

        expect(summary.usernameImported).toBe(false);
        expect(identityManager.loadUsername).not.toHaveBeenCalled();
        expect(identityManager.loadTrustedContacts).not.toHaveBeenCalled();
    });

    it('schedules the post-save hook only when something changed', async () => {
        const { secureStorage, channelManager } = makeDeps();

        await importBackupData({}, { secureStorage, channelManager });
        expect(channelManager.onChannelsSaved).not.toHaveBeenCalled();
        expect(secureStorage.saveToStorage).not.toHaveBeenCalled();

        await importBackupData(
            { channels: [androidChannel('ch1', 'Alpha')] },
            { secureStorage, channelManager }
        );
        expect(channelManager.onChannelsSaved).toHaveBeenCalled();
        expect(secureStorage.saveToStorage).toHaveBeenCalled();
    });

    it('imports epoch keys for channels without local state', async () => {
        const { secureStorage, channelManager, cache } = makeDeps();
        const data = {
            epochKeys: {
                'ch-1': {
                    epochs: { kid1: { keyHex: '0xaa', keyHash: '0xhh', epoch: 1 } },
                    announces: { 1: { keyId: 'kid1', keyHash: '0xhh' } },
                    currentEpoch: 1
                }
            }
        };

        const summary = await importBackupData(data, { secureStorage, channelManager });

        expect(cache.epochKeys['ch-1'].epochs.kid1.keyHex).toBe('0xaa');
        expect(summary.changed).toBe(true);
        expect(secureStorage.saveToStorage).toHaveBeenCalled();
    });

    it('union-merges epoch keys, local wins per entry', async () => {
        const { secureStorage, channelManager, cache } = makeDeps({
            epochKeys: {
                'ch-1': {
                    epochs: { kid2: { keyHex: '0xlocal', keyHash: '0xh2', epoch: 2 } },
                    announces: { 2: { keyId: 'kid2' } },
                    currentEpoch: 2
                }
            }
        });
        const data = {
            epochKeys: {
                'ch-1': {
                    epochs: {
                        kid1: { keyHex: '0xold', keyHash: '0xh1', epoch: 1 },
                        kid2: { keyHex: '0xbackup', keyHash: '0xh2', epoch: 2 }
                    },
                    announces: { 1: { keyId: 'kid1' } },
                    currentEpoch: 1
                }
            }
        };

        await importBackupData(data, { secureStorage, channelManager });

        const merged = cache.epochKeys['ch-1'];
        expect(merged.epochs.kid1.keyHex).toBe('0xold');      // gap filled from backup
        expect(merged.epochs.kid2.keyHex).toBe('0xlocal');    // local entry kept
        expect(merged.announces[1].keyId).toBe('kid1');
        expect(merged.currentEpoch).toBe(2);                  // never regresses
    });

    it('returns an empty summary when data is null or storage is locked', async () => {
        const { secureStorage, channelManager } = makeDeps();

        expect((await importBackupData(null, { secureStorage, channelManager })).changed).toBe(false);

        secureStorage.isStorageUnlocked.mockReturnValue(false);
        const summary = await importBackupData(
            { channels: [androidChannel('ch1', 'Alpha')] },
            { secureStorage, channelManager }
        );
        expect(summary.changed).toBe(false);
        expect(channelManager.reloadChannelsFromSync).not.toHaveBeenCalled();
    });
});
