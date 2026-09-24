/**
 * SecureStorage Extended Tests
 * Covers: exportAccountBackup, importAccountBackup,
 * addSentReaction remove path, addSentMessage dedup,
 * locked-state guards for remaining setters,
 * saveToStorage error path, edge cases
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { secureStorage } from '../../src/js/secureStorage.js';

describe('secureStorage extended', () => {
    let originalCache, originalIsUnlocked, originalIsGuestMode, originalAddress, originalStorageKey, originalStateDB;

    beforeEach(() => {
        originalCache = secureStorage.cache;
        originalIsUnlocked = secureStorage.isUnlocked;
        originalIsGuestMode = secureStorage.isGuestMode;
        originalAddress = secureStorage.address;
        originalStorageKey = secureStorage.storageKey;
        originalStateDB = secureStorage.stateDB;
        localStorage.clear();
    });

    afterEach(() => {
        if (secureStorage.stateDB && secureStorage.stateDB !== originalStateDB) {
            secureStorage.stateDB.close();
        }
        secureStorage.cache = originalCache;
        secureStorage.isUnlocked = originalIsUnlocked;
        secureStorage.isGuestMode = originalIsGuestMode;
        secureStorage.address = originalAddress;
        secureStorage.storageKey = originalStorageKey;
        secureStorage.stateDB = originalStateDB;
        vi.restoreAllMocks();
    });

    // ==================== Locked-state guards (remaining setters) ====================
    describe('Locked-state guards', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0xLockTest');
        });

        // Getters when locked
        it('getENSCache returns empty object when locked', () => {
            secureStorage.isUnlocked = false;
            expect(secureStorage.getENSCache()).toEqual({});
        });

        it('getTrustedContacts returns empty object when locked', () => {
            secureStorage.isUnlocked = false;
            expect(secureStorage.getTrustedContacts()).toEqual({});
        });

        it('getNsfwEnabled returns false when locked', () => {
            secureStorage.isUnlocked = false;
            expect(secureStorage.getNsfwEnabled()).toBe(false);
        });

        it('getYouTubeEmbedsEnabled returns true when locked', () => {
            secureStorage.isUnlocked = false;
            expect(secureStorage.getYouTubeEmbedsEnabled()).toBe(true);
        });

        it('getGraphApiKey returns null when locked', () => {
            secureStorage.isUnlocked = false;
            expect(secureStorage.getGraphApiKey()).toBeNull();
        });

        it('getSessionData returns null when locked', () => {
            secureStorage.isUnlocked = false;
            expect(secureStorage.getSessionData()).toBeNull();
        });

        it('getSentMessages returns empty array when locked', () => {
            secureStorage.isUnlocked = false;
            expect(secureStorage.getSentMessages('any')).toEqual([]);
        });

        it('getSentReactions returns empty object when locked', () => {
            secureStorage.isUnlocked = false;
            expect(secureStorage.getSentReactions('any')).toEqual({});
        });

        it('getBlockedPeers returns empty array when locked', () => {
            secureStorage.isUnlocked = false;
            expect(secureStorage.getBlockedPeers()).toEqual([]);
        });

        it('getLastOpenedChannel returns null when locked', () => {
            secureStorage.isUnlocked = false;
            expect(secureStorage.getLastOpenedChannel()).toBeNull();
        });

        it('getChannelOrder returns empty array when locked', () => {
            secureStorage.isUnlocked = false;
            expect(secureStorage.getChannelOrder()).toEqual([]);
        });

        it('getDMLeftAt returns null when locked', () => {
            secureStorage.isUnlocked = false;
            expect(secureStorage.getDMLeftAt('0xpeer')).toBeNull();
        });

        it('getAllDMLeftAt returns empty object when locked', () => {
            secureStorage.isUnlocked = false;
            expect(secureStorage.getAllDMLeftAt()).toEqual({});
        });

        // Setters when locked - should be no-ops
        it('setNsfwEnabled does nothing when locked', async () => {
            await secureStorage.setNsfwEnabled(true);
            secureStorage.isUnlocked = false;
            await secureStorage.setNsfwEnabled(false);
            secureStorage.isUnlocked = true;
            expect(secureStorage.getNsfwEnabled()).toBe(true);
        });

        it('setYouTubeEmbedsEnabled does nothing when locked', async () => {
            await secureStorage.setYouTubeEmbedsEnabled(false);
            secureStorage.isUnlocked = false;
            await secureStorage.setYouTubeEmbedsEnabled(true);
            secureStorage.isUnlocked = true;
            expect(secureStorage.getYouTubeEmbedsEnabled()).toBe(false);
        });

        it('clearSessionData does nothing when locked', async () => {
            await secureStorage.setSessionData({ token: 'keep' });
            secureStorage.isUnlocked = false;
            await secureStorage.clearSessionData();
            secureStorage.isUnlocked = true;
            expect(secureStorage.getSessionData()).toEqual({ token: 'keep' });
        });

        it('setLastOpenedChannel does nothing when locked', async () => {
            await secureStorage.setLastOpenedChannel('ch-1');
            secureStorage.isUnlocked = false;
            await secureStorage.setLastOpenedChannel('ch-2');
            secureStorage.isUnlocked = true;
            expect(secureStorage.getLastOpenedChannel()).toBe('ch-1');
        });

        it('setChannelOrder does nothing when locked', async () => {
            await secureStorage.setChannelOrder(['a', 'b']);
            secureStorage.isUnlocked = false;
            await secureStorage.setChannelOrder(['c']);
            secureStorage.isUnlocked = true;
            expect(secureStorage.getChannelOrder()).toEqual(['a', 'b']);
        });

        it('addToChannelOrder does nothing when locked', async () => {
            await secureStorage.addToChannelOrder('ch-1');
            secureStorage.isUnlocked = false;
            await secureStorage.addToChannelOrder('ch-2');
            secureStorage.isUnlocked = true;
            expect(secureStorage.getChannelOrder()).toEqual(['ch-1']);
        });

        it('removeFromChannelOrder does nothing when locked', async () => {
            await secureStorage.setChannelOrder(['a', 'b', 'c']);
            secureStorage.isUnlocked = false;
            await secureStorage.removeFromChannelOrder('b');
            secureStorage.isUnlocked = true;
            expect(secureStorage.getChannelOrder()).toEqual(['a', 'b', 'c']);
        });

        it('addBlockedPeer does nothing when locked', async () => {
            secureStorage.isUnlocked = false;
            await secureStorage.addBlockedPeer('0xpeer');
            secureStorage.isUnlocked = true;
            secureStorage.cache = { blockedPeers: [] };
            expect(secureStorage.getBlockedPeers()).toEqual([]);
        });

        it('removeBlockedPeer does nothing when locked', async () => {
            await secureStorage.addBlockedPeer('0xpeer');
            secureStorage.isUnlocked = false;
            await secureStorage.removeBlockedPeer('0xpeer');
            secureStorage.isUnlocked = true;
            expect(secureStorage.getBlockedPeers()).toContain('0xpeer');
        });

        it('setDMLeftAt does nothing when locked', async () => {
            secureStorage.isUnlocked = false;
            await secureStorage.setDMLeftAt('0xpeer', 12345);
            secureStorage.isUnlocked = true;
            secureStorage.cache = { dmLeftAt: {} };
            expect(secureStorage.getDMLeftAt('0xpeer')).toBeNull();
        });

        it('clearDMLeftAt does nothing when locked', async () => {
            await secureStorage.setDMLeftAt('0xpeer', 100);
            secureStorage.isUnlocked = false;
            await secureStorage.clearDMLeftAt('0xpeer');
            secureStorage.isUnlocked = true;
            expect(secureStorage.getDMLeftAt('0xpeer')).toBe(100);
        });

        it('clearSentMessages does nothing when locked', async () => {
            await secureStorage.addSentMessage('stream-1', {
                id: 'msg-1', sender: '0x1', timestamp: 1, signature: '', channelId: 'stream-1', text: 'Hi'
            });
            secureStorage.isUnlocked = false;
            await secureStorage.clearSentMessages('stream-1');
            secureStorage.isUnlocked = true;
            expect(secureStorage.getSentMessages('stream-1')).toHaveLength(1);
        });

        it('clearSentReactions does nothing when locked', async () => {
            await secureStorage.addSentReaction('stream-1', 'msg-1', '👍', '0xuser');
            secureStorage.isUnlocked = false;
            await secureStorage.clearSentReactions('stream-1');
            secureStorage.isUnlocked = true;
            expect(Object.keys(secureStorage.getSentReactions('stream-1'))).toHaveLength(1);
        });

        it('addSentReaction does nothing when locked', async () => {
            secureStorage.isUnlocked = false;
            await secureStorage.addSentReaction('stream-1', 'msg-1', '👍', '0xuser');
            secureStorage.isUnlocked = true;
            secureStorage.cache = {};
            expect(secureStorage.getSentReactions('stream-1')).toEqual({});
        });
    });

    // ==================== addSentReaction remove path ====================
    describe('addSentReaction remove action', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0xReactionTest');
        });

        it('should remove a user from reaction', async () => {
            await secureStorage.addSentReaction('stream-1', 'msg-1', '👍', '0xUser1', 'add');
            await secureStorage.addSentReaction('stream-1', 'msg-1', '👍', '0xUser2', 'add');

            await secureStorage.addSentReaction('stream-1', 'msg-1', '👍', '0xUser1', 'remove');

            const reactions = secureStorage.getSentReactions('stream-1');
            expect(reactions['msg-1']['👍']).toEqual(['0xUser2']);
        });

        it('should delete emoji key when last user removed', async () => {
            await secureStorage.addSentReaction('stream-1', 'msg-1', '👍', '0xUser1', 'add');

            await secureStorage.addSentReaction('stream-1', 'msg-1', '👍', '0xUser1', 'remove');

            const reactions = secureStorage.getSentReactions('stream-1');
            expect(reactions['msg-1']).toBeUndefined();
        });

        it('should delete messageId key when no emojis remain', async () => {
            await secureStorage.addSentReaction('stream-1', 'msg-1', '👍', '0xUser1', 'add');
            await secureStorage.addSentReaction('stream-1', 'msg-1', '👍', '0xUser1', 'remove');

            const reactions = secureStorage.getSentReactions('stream-1');
            expect(reactions['msg-1']).toBeUndefined();
        });

        it('should handle remove for non-existent user (no-op)', async () => {
            await secureStorage.addSentReaction('stream-1', 'msg-1', '👍', '0xUser1', 'add');
            await secureStorage.addSentReaction('stream-1', 'msg-1', '👍', '0xNonExistent', 'remove');

            const reactions = secureStorage.getSentReactions('stream-1');
            expect(reactions['msg-1']['👍']).toEqual(['0xUser1']);
        });

        it('should normalize user for case-insensitive remove', async () => {
            await secureStorage.addSentReaction('stream-1', 'msg-1', '❤️', '0xAbCdEf', 'add');
            await secureStorage.addSentReaction('stream-1', 'msg-1', '❤️', '0xABCDEF', 'remove');

            const reactions = secureStorage.getSentReactions('stream-1');
            // Should have been removed since case-insensitive match
            expect(reactions['msg-1']).toBeUndefined();
        });

        it('should not add duplicate user on add action', async () => {
            await secureStorage.addSentReaction('stream-1', 'msg-1', '👍', '0xUser1', 'add');
            await secureStorage.addSentReaction('stream-1', 'msg-1', '👍', '0xUser1', 'add');

            const reactions = secureStorage.getSentReactions('stream-1');
            expect(reactions['msg-1']['👍']).toHaveLength(1);
        });
    });

    // ==================== addSentMessage deduplication ====================
    describe('addSentMessage deduplication', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0xDedupTest');
        });

        it('should not add message with same id twice', async () => {
            const msg = {
                id: 'msg-dup-1', sender: '0x1', timestamp: 1, signature: '', channelId: 'stream-1', text: 'First'
            };
            await secureStorage.addSentMessage('stream-1', msg);
            await secureStorage.addSentMessage('stream-1', { ...msg, text: 'Second attempt' });

            const stored = secureStorage.getSentMessages('stream-1');
            expect(stored).toHaveLength(1);
            expect(stored[0].text).toBe('First');
        });

        it('should add messages with different ids', async () => {
            await secureStorage.addSentMessage('stream-1', {
                id: 'msg-a', sender: '0x1', timestamp: 1, signature: '', channelId: 'stream-1', text: 'A'
            });
            await secureStorage.addSentMessage('stream-1', {
                id: 'msg-b', sender: '0x1', timestamp: 2, signature: '', channelId: 'stream-1', text: 'B'
            });

            expect(secureStorage.getSentMessages('stream-1')).toHaveLength(2);
        });

        it('should store replyTo field for text messages', async () => {
            await secureStorage.addSentMessage('stream-1', {
                id: 'reply-1', sender: '0x1', timestamp: 1, signature: '', channelId: 'stream-1',
                text: 'Reply text', replyTo: 'msg-original'
            });

            const stored = secureStorage.getSentMessages('stream-1');
            expect(stored[0].replyTo).toBe('msg-original');
        });

        it('should default replyTo to null when not provided', async () => {
            await secureStorage.addSentMessage('stream-1', {
                id: 'no-reply', sender: '0x1', timestamp: 1, signature: '', channelId: 'stream-1',
                text: 'No reply'
            });

            const stored = secureStorage.getSentMessages('stream-1');
            expect(stored[0].replyTo).toBeNull();
        });
    });

    // ==================== saveToStorage error path ====================
    describe('saveToStorage error path', () => {
        it('should throw StorageError when encrypt fails', async () => {
            secureStorage.isGuestMode = false;
            secureStorage.isUnlocked = true;
            secureStorage.address = '0xerror';
            secureStorage.cache = { channels: [] };
            secureStorage.storageKey = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
            );

            // Mock encrypt to fail
            vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(new Error('encrypt fail'));

            await expect(secureStorage.saveToStorage()).rejects.toThrow('Failed to save encrypted data');
        });

        it('should warn when not unlocked and no cache', async () => {
            secureStorage.isUnlocked = false;
            secureStorage.cache = null;
            // Should not throw - just warn
            await secureStorage.saveToStorage();
        });
    });

    // ==================== exportAccountBackup() ====================
    describe('exportAccountBackup()', () => {
        let testKey;

        beforeEach(async () => {
            secureStorage.initAsGuest('0xBackupTest');
            testKey = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
            );
            secureStorage.storageKey = testKey;

            // Set some data
            secureStorage.cache.channels = [{ streamId: 'ch-1', name: 'Test' }];
            secureStorage.cache.username = 'backupuser';
            secureStorage.cache.trustedContacts = { '0xfriend': { name: 'Friend' } };
        });

        it('should throw when storage not unlocked', async () => {
            secureStorage.isUnlocked = false;
            secureStorage.cache = null;

            await expect(secureStorage.exportAccountBackup({}, 'password'))
                .rejects.toThrow('Storage not unlocked');
        });

        it('should create backup with correct format', async () => {
            // Mock ethers (not available in test env)
            const mockEthers = {
                randomBytes: (n) => new Uint8Array(n).fill(42),
                toUtf8Bytes: (str) => new TextEncoder().encode(str),
                scrypt: vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32)),
                getBytes: (hex) => {
                    const bytes = new Uint8Array(32);
                    for (let i = 0; i < 32; i++) bytes[i] = 0xab;
                    return bytes;
                },
                hexlify: (arr) => '0x' + Array.from(arr instanceof ArrayBuffer ? new Uint8Array(arr) : arr).map(b => b.toString(16).padStart(2, '0')).join('')
            };

            // We need to mock crypto.subtle.importKey for the AES-GCM key import
            const mockCryptoKey = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 }, false, ['encrypt']
            );
            const importKeySpy = vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue(mockCryptoKey);
            const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt').mockResolvedValue(new ArrayBuffer(32));

            // Inject ethers mock into global
            const origEthers = globalThis.ethers;
            globalThis.ethers = mockEthers;

            try {
                const keystore = { address: '0xbackuptest', version: 3 };
                const backup = await secureStorage.exportAccountBackup(keystore, 'testpassword');

                expect(backup.format).toBe('pombo-account-backup');
                expect(backup.version).toBe(1);
                expect(backup.keystore).toBe(keystore);
                expect(backup.encryptedData).toBeDefined();
                expect(backup.encryptedData.kdf).toBe('scrypt');
                expect(backup.encryptedData.cipher).toBe('aes-256-gcm');
                expect(backup.encryptedData.kdfparams.n).toBe(131072);
                expect(backup.exportedAt).toBeDefined();
            } finally {
                globalThis.ethers = origEthers;
                importKeySpy.mockRestore();
                encryptSpy.mockRestore();
            }
        });

        it('applies the backup policy to the encrypted payload', async () => {
            const mockEthers = {
                randomBytes: (n) => new Uint8Array(n).fill(42),
                toUtf8Bytes: (str) => new TextEncoder().encode(str),
                scrypt: vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32)),
                getBytes: () => new Uint8Array(32).fill(0xab),
                hexlify: (arr) => '0x' + Array.from(arr instanceof ArrayBuffer ? new Uint8Array(arr) : arr).map(b => b.toString(16).padStart(2, '0')).join('')
            };

            secureStorage.cache.ensCache = { '0xa': 'a.eth' };
            secureStorage.cache.sliceTs = { username: 5 };
            secureStorage.cache.epochKeys = { 'ch-1': { epochs: {}, currentEpoch: 2 } };
            secureStorage.cache.sentMessages = {
                peerInbox: [
                    { id: 'm1', type: 'image', imageId: 'img-sent' },
                    { id: 'm2', type: 'text', text: 'hi' }
                ]
            };

            const blobsSpy = vi.spyOn(secureStorage, 'exportImageBlobs').mockResolvedValue([]);
            const mockCryptoKey = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 }, false, ['encrypt']
            );
            const importKeySpy = vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue(mockCryptoKey);
            let plaintext;
            const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (alg, key, pt) => {
                plaintext = pt;
                return new ArrayBuffer(32);
            });

            const origEthers = globalThis.ethers;
            globalThis.ethers = mockEthers;

            try {
                await secureStorage.exportAccountBackup({}, 'pass');

                const payload = JSON.parse(new TextDecoder().decode(plaintext));
                expect(payload.data.ensCache).toBeUndefined();
                expect(payload.data.sliceTs).toBeUndefined();
                expect(payload.data.epochKeys['ch-1'].currentEpoch).toBe(2);
                expect(payload.data.username).toBe('backupuser');
                // Media restricted to blobs the sent-message record references
                expect([...blobsSpy.mock.calls[0][0]]).toEqual(['img-sent']);
            } finally {
                globalThis.ethers = origEthers;
                importKeySpy.mockRestore();
                encryptSpy.mockRestore();
                blobsSpy.mockRestore();
            }
        });

        it('exports no media when includeSentDmMedia is off', async () => {
            const mockEthers = {
                randomBytes: (n) => new Uint8Array(n).fill(42),
                toUtf8Bytes: (str) => new TextEncoder().encode(str),
                scrypt: vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32)),
                getBytes: () => new Uint8Array(32).fill(0xab),
                hexlify: (arr) => '0x' + Array.from(arr instanceof ArrayBuffer ? new Uint8Array(arr) : arr).map(b => b.toString(16).padStart(2, '0')).join('')
            };
            const blobsSpy = vi.spyOn(secureStorage, 'exportImageBlobs').mockResolvedValue([]);
            const mockCryptoKey = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 }, false, ['encrypt']
            );
            const importKeySpy = vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue(mockCryptoKey);
            const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt').mockResolvedValue(new ArrayBuffer(32));

            const origEthers = globalThis.ethers;
            globalThis.ethers = mockEthers;

            try {
                await secureStorage.exportAccountBackup({}, 'pass', null, { includeSentDmMedia: false });
                expect(blobsSpy).not.toHaveBeenCalled();
            } finally {
                globalThis.ethers = origEthers;
                importKeySpy.mockRestore();
                encryptSpy.mockRestore();
                blobsSpy.mockRestore();
            }
        });

        it('should call progress callback during export', async () => {
            const mockEthers = {
                randomBytes: (n) => new Uint8Array(n).fill(42),
                toUtf8Bytes: (str) => new TextEncoder().encode(str),
                scrypt: vi.fn(async (pwd, salt, N, r, p, dkLen, cb) => {
                    if (cb) { cb(0.5); cb(1.0); }
                    return '0x' + 'ab'.repeat(32);
                }),
                getBytes: () => new Uint8Array(32).fill(0xab),
                hexlify: (arr) => '0x' + Array.from(arr instanceof ArrayBuffer ? new Uint8Array(arr) : arr).map(b => b.toString(16).padStart(2, '0')).join('')
            };

            const mockCryptoKey = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 }, false, ['encrypt']
            );
            const importKeySpy = vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue(mockCryptoKey);
            const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt').mockResolvedValue(new ArrayBuffer(32));

            const origEthers = globalThis.ethers;
            globalThis.ethers = mockEthers;

            try {
                const progressCb = vi.fn();
                await secureStorage.exportAccountBackup({}, 'pass', progressCb);

                expect(progressCb).toHaveBeenCalled();
                // Should have been called with values between 0 and 1
                const calls = progressCb.mock.calls.map(c => c[0]);
                expect(calls.some(v => v <= 0.5)).toBe(true);
                expect(calls.some(v => v >= 0.6)).toBe(true);
            } finally {
                globalThis.ethers = origEthers;
                importKeySpy.mockRestore();
                encryptSpy.mockRestore();
            }
        });
    });

    // ==================== importAccountBackup() ====================
    describe('importAccountBackup()', () => {
        it('should throw on invalid backup format', async () => {
            await expect(secureStorage.importAccountBackup({ format: 'wrong' }, 'pass'))
                .rejects.toThrow('Invalid backup format');
        });

        it('should throw on invalid backup version', async () => {
            await expect(secureStorage.importAccountBackup({ format: 'pombo-account-backup', version: 99 }, 'pass'))
                .rejects.toThrow('Invalid backup format');
        });

        it('should decrypt backup and return wallet + data', async () => {
            const mockWallet = { address: '0xrestoredwallet' };
            const decryptedData = {
                version: 1,
                exportedAt: '2024-01-01T00:00:00Z',
                address: '0xrestoredwallet',
                data: {
                    channels: [{ streamId: 'restored-ch' }],
                    username: 'restoreduser'
                }
            };

            const mockEthers = {
                Wallet: {
                    fromEncryptedJson: vi.fn().mockResolvedValue(mockWallet)
                },
                toUtf8Bytes: (str) => new TextEncoder().encode(str),
                scrypt: vi.fn().mockResolvedValue('0x' + 'cd'.repeat(32)),
                getBytes: (hex) => {
                    if (typeof hex === 'string') return new Uint8Array(32).fill(0xcd);
                    return hex;
                }
            };

            // Create real encrypted ciphertext
            const key = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
            );
            const iv = new Uint8Array(16).fill(0x01);
            const plaintext = new TextEncoder().encode(JSON.stringify(decryptedData));

            // Mock importKey to return a key that can decrypt
            const importKeySpy = vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue(key);
            const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt').mockResolvedValue(plaintext.buffer);

            const origEthers = globalThis.ethers;
            globalThis.ethers = mockEthers;

            try {
                const backup = {
                    format: 'pombo-account-backup',
                    version: 1,
                    keystore: { address: '0xrestoredwallet', crypto: {} },
                    encryptedData: {
                        kdf: 'scrypt',
                        kdfparams: { n: 131072, r: 8, p: 1, dklen: 32, salt: '0x' + 'aa'.repeat(32) },
                        cipher: 'aes-256-gcm',
                        cipherparams: { iv: '0x' + 'bb'.repeat(16) },
                        ciphertext: '0x' + 'cc'.repeat(64)
                    }
                };

                const result = await secureStorage.importAccountBackup(backup, 'testpass');

                expect(result.wallet).toBe(mockWallet);
                expect(result.keystore).toBe(backup.keystore);
                expect(result.data).toEqual(decryptedData.data);
                expect(result.address).toBe('0xrestoredwallet');
            } finally {
                globalThis.ethers = origEthers;
                importKeySpy.mockRestore();
                decryptSpy.mockRestore();
            }
        });

        it('should throw on incorrect password (wallet decrypt fails)', async () => {
            const mockEthers = {
                Wallet: {
                    fromEncryptedJson: vi.fn().mockRejectedValue(new Error('invalid password'))
                }
            };

            const origEthers = globalThis.ethers;
            globalThis.ethers = mockEthers;

            try {
                const backup = {
                    format: 'pombo-account-backup',
                    version: 1,
                    keystore: {},
                    encryptedData: {}
                };

                await expect(secureStorage.importAccountBackup(backup, 'wrongpass'))
                    .rejects.toThrow('Incorrect password or corrupted backup');
            } finally {
                globalThis.ethers = origEthers;
            }
        });

        it('should throw on data decryption failure', async () => {
            const mockWallet = { address: '0xtest' };
            const mockEthers = {
                Wallet: {
                    fromEncryptedJson: vi.fn().mockResolvedValue(mockWallet)
                },
                toUtf8Bytes: (str) => new TextEncoder().encode(str),
                scrypt: vi.fn().mockResolvedValue('0x' + 'cd'.repeat(32)),
                getBytes: () => new Uint8Array(32).fill(0xcd)
            };

            const mockKey = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 }, false, ['decrypt']
            );
            const importKeySpy = vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue(mockKey);
            const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt').mockRejectedValue(new Error('decrypt fail'));

            const origEthers = globalThis.ethers;
            globalThis.ethers = mockEthers;

            try {
                const backup = {
                    format: 'pombo-account-backup',
                    version: 1,
                    keystore: {},
                    encryptedData: {
                        kdfparams: { n: 131072, r: 8, p: 1, dklen: 32, salt: '0xaa' },
                        cipherparams: { iv: '0xbb' },
                        ciphertext: '0xcc'
                    }
                };

                await expect(secureStorage.importAccountBackup(backup, 'pass'))
                    .rejects.toThrow('Failed to decrypt backup data');
            } finally {
                globalThis.ethers = origEthers;
                importKeySpy.mockRestore();
                decryptSpy.mockRestore();
            }
        });

        it('should call progress callback during import', async () => {
            const mockWallet = { address: '0xprogress' };
            const decryptedData = {
                version: 1, exportedAt: '2024-01-01', address: '0xprogress',
                data: { channels: [] }
            };
            const mockEthers = {
                Wallet: {
                    fromEncryptedJson: vi.fn(async (json, pwd, cb) => {
                        if (cb) { cb(0.5); cb(1.0); }
                        return mockWallet;
                    })
                },
                toUtf8Bytes: (str) => new TextEncoder().encode(str),
                scrypt: vi.fn(async (pwd, salt, N, r, p, dkLen, cb) => {
                    if (cb) { cb(0.5); cb(1.0); }
                    return '0x' + 'ab'.repeat(32);
                }),
                getBytes: () => new Uint8Array(32).fill(0xab)
            };

            const key = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 }, false, ['decrypt']
            );
            const importKeySpy = vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue(key);
            const plaintext = new TextEncoder().encode(JSON.stringify(decryptedData));
            const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt').mockResolvedValue(plaintext.buffer);

            const origEthers = globalThis.ethers;
            globalThis.ethers = mockEthers;

            try {
                const progressCb = vi.fn();
                const backup = {
                    format: 'pombo-account-backup',
                    version: 1,
                    keystore: {},
                    encryptedData: {
                        kdfparams: { n: 131072, r: 8, p: 1, dklen: 32, salt: '0xaa' },
                        cipherparams: { iv: '0xbb' },
                        ciphertext: '0xcc'
                    }
                };

                await secureStorage.importAccountBackup(backup, 'pass', progressCb);

                expect(progressCb).toHaveBeenCalled();
                const calls = progressCb.mock.calls.map(c => c[0]);
                expect(calls.some(v => v <= 0.5)).toBe(true);
                expect(calls.some(v => v >= 0.85)).toBe(true);
            } finally {
                globalThis.ethers = origEthers;
                importKeySpy.mockRestore();
                decryptSpy.mockRestore();
            }
        });

        it('should import without progress callback', async () => {
            const mockWallet = { address: '0xnoprogress' };
            const decryptedData = {
                version: 1, exportedAt: '2024-01-01', address: '0xnoprogress',
                data: { channels: [] }
            };
            const mockEthers = {
                Wallet: {
                    fromEncryptedJson: vi.fn().mockResolvedValue(mockWallet)
                },
                toUtf8Bytes: (str) => new TextEncoder().encode(str),
                scrypt: vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32)),
                getBytes: () => new Uint8Array(32).fill(0xab)
            };

            const key = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 }, false, ['decrypt']
            );
            const importKeySpy = vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue(key);
            const plaintext = new TextEncoder().encode(JSON.stringify(decryptedData));
            const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt').mockResolvedValue(plaintext.buffer);

            const origEthers = globalThis.ethers;
            globalThis.ethers = mockEthers;

            try {
                const backup = {
                    format: 'pombo-account-backup',
                    version: 1,
                    keystore: {},
                    encryptedData: {
                        kdfparams: { n: 131072, r: 8, p: 1, dklen: 32, salt: '0xaa' },
                        cipherparams: { iv: '0xbb' },
                        ciphertext: '0xcc'
                    }
                };

                const result = await secureStorage.importAccountBackup(backup, 'pass', null);
                expect(result.wallet).toBe(mockWallet);
            } finally {
                globalThis.ethers = origEthers;
                importKeySpy.mockRestore();
                decryptSpy.mockRestore();
            }
        });
    });

    // ==================== getStats edge cases ====================
    describe('getStats edge cases', () => {
        it('should return null when cache is null', () => {
            secureStorage.isUnlocked = true;
            secureStorage.cache = null;
            expect(secureStorage.getStats()).toBeNull();
        });

        it('should handle missing optional cache fields', () => {
            secureStorage.isUnlocked = true;
            secureStorage.cache = { version: 2 };
            const stats = secureStorage.getStats();
            expect(stats.channels).toBe(0);
            expect(stats.contacts).toBe(0);
            expect(stats.ensEntries).toBe(0);
            expect(stats.hasUsername).toBe(false);
            expect(stats.hasApiKey).toBe(false);
        });
    });

    // ==================== exportForSync edge cases ====================
    describe('exportForSync edge cases', () => {
        it('should throw when cache is null', () => {
            secureStorage.isUnlocked = true;
            secureStorage.cache = null;
            expect(() => secureStorage.exportForSync()).toThrow('Storage not unlocked');
        });

        it('stamps values that carry no stamp with the floor, in both exports', () => {
            secureStorage.initAsGuest('0xStampFloor');
            secureStorage.cache.username = 'Bob';
            secureStorage.cache.trustedContacts = { '0x1': { nickname: 'c' } };
            secureStorage.cache.sliceTs = { trustedContacts: 5 };

            expect(secureStorage.exportForSync().sliceTs).toEqual({ trustedContacts: 5, username: 1 });
            expect(secureStorage.exportForBackup().sliceTs).toEqual({ trustedContacts: 5, username: 1 });
            expect(secureStorage.cache.sliceTs).toEqual({ trustedContacts: 5 });
        });
    });

    // ==================== importFromSync edge cases ====================
    describe('importFromSync edge cases', () => {
        it('should throw when cache is null', async () => {
            secureStorage.isUnlocked = true;
            secureStorage.cache = null;
            await expect(secureStorage.importFromSync({})).rejects.toThrow('Storage not unlocked');
        });

        it('reports the channel write synchronously, and only when channels change', async () => {
            secureStorage.initAsGuest('0xImportHook');
            const seen = [];
            const onChannelsWritten = () => seen.push(secureStorage.cache.channels.length);

            const first = secureStorage.importFromSync({ channels: [{ messageStreamId: 's/a-1' }] }, { onChannelsWritten });
            expect(seen).toEqual([1]);
            await first;
            await secureStorage.importFromSync({ channels: [{ messageStreamId: 's/a-1' }] }, { onChannelsWritten });
            expect(seen).toEqual([1]);
        });
    });

    // ==================== getChannelLastAccess emergency sync ====================
    describe('getChannelLastAccess emergency sync', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0xEmergencyTest');
        });

        it('should initialize channelLastAccess when null and emergency value exists', () => {
            secureStorage.cache.channelLastAccess = null;
            const timestamp = Date.now();
            localStorage.setItem('pombo_channel_access_ch-1', timestamp.toString());

            const result = secureStorage.getChannelLastAccess('ch-1');

            expect(result).toBe(timestamp);
            expect(secureStorage.cache.channelLastAccess).toBeDefined();
            expect(secureStorage.cache.channelLastAccess['ch-1']).toBe(timestamp);
        });

        it('should use cached value when it is newer than emergency', async () => {
            const newerTimestamp = Date.now();
            const olderTimestamp = newerTimestamp - 10000;
            
            await secureStorage.setChannelLastAccess('ch-1', newerTimestamp);
            localStorage.setItem('pombo_channel_access_ch-1', olderTimestamp.toString());

            const result = secureStorage.getChannelLastAccess('ch-1');

            expect(result).toBe(newerTimestamp);
        });
    });

    // ==================== setChannelLastAccess initializes map ====================
    describe('setChannelLastAccess initializes map', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0xInitMapTest');
        });

        it('should initialize channelLastAccess when null', async () => {
            secureStorage.cache.channelLastAccess = null;
            await secureStorage.setChannelLastAccess('ch-1', 12345);
            expect(secureStorage.cache.channelLastAccess['ch-1']).toBe(12345);
        });
    });

    // ==================== removeFromChannelOrder when channelOrder is null ====================
    describe('removeFromChannelOrder null check', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0xNullOrder');
        });

        it('should not throw when channelOrder is null/undefined', async () => {
            secureStorage.cache.channelOrder = null;
            await secureStorage.removeFromChannelOrder('ch-1');
            // No error
        });
    });

    // ==================== addBlockedPeer initializes array ====================
    describe('addBlockedPeer initializes array', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0xInitBlock');
        });

        it('should initialize blockedPeers when undefined', async () => {
            delete secureStorage.cache.blockedPeers;
            await secureStorage.addBlockedPeer('0xnew');
            expect(secureStorage.getBlockedPeers()).toContain('0xnew');
        });
    });

    // ==================== setDMLeftAt initializes map ====================
    describe('setDMLeftAt initializes map', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0xInitDM');
        });

        it('should initialize dmLeftAt when undefined', async () => {
            delete secureStorage.cache.dmLeftAt;
            await secureStorage.setDMLeftAt('0xpeer', 999);
            expect(secureStorage.getDMLeftAt('0xpeer')).toBe(999);
        });
    });

    // ==================== addSentMessage initializes structures ====================
    describe('addSentMessage initializes structures', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0xInitMsg');
        });

        it('should initialize sentMessages when undefined', async () => {
            delete secureStorage.cache.sentMessages;
            await secureStorage.addSentMessage('stream-1', {
                id: 'msg-1', sender: '0x1', timestamp: 1, signature: '', channelId: 'stream-1', text: 'Hi'
            });
            expect(secureStorage.getSentMessages('stream-1')).toHaveLength(1);
        });
    });

    // ==================== addSentReaction initializes structures ====================
    describe('addSentReaction initializes structures', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0xInitReact');
        });

        it('should initialize sentReactions when undefined', async () => {
            delete secureStorage.cache.sentReactions;
            await secureStorage.addSentReaction('stream-1', 'msg-1', '👍', '0xuser');
            const reactions = secureStorage.getSentReactions('stream-1');
            expect(reactions['msg-1']['👍']).toEqual(['0xuser']);
        });
    });

    // ==================== addSentMessage strips imageData after IDB save ====================
    describe('addSentMessage image strip', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0xImageStrip');
        });

        it('should strip imageData from cache after saving to IDB ledger', async () => {
            const saveImageSpy = vi.spyOn(secureStorage, 'saveImageToLedger').mockResolvedValue(true);

            await secureStorage.addSentMessage('stream-1', {
                id: 'img-1', sender: '0x1', timestamp: 1, signature: '', channelId: 'stream-1',
                type: 'image', imageId: 'imgid-1', imageData: 'data:image/jpeg;base64,bigdata'
            });

            const stored = secureStorage.getSentMessages('stream-1');
            expect(stored).toHaveLength(1);
            expect(stored[0].type).toBe('image');
            expect(stored[0].imageId).toBe('imgid-1');
            expect(stored[0].imageData).toBeUndefined();
            expect(saveImageSpy).toHaveBeenCalledWith('imgid-1', 'data:image/jpeg;base64,bigdata', 'stream-1');
        });

        it('should not strip imageData for non-image messages', async () => {
            await secureStorage.addSentMessage('stream-1', {
                id: 'txt-1', sender: '0x1', timestamp: 1, signature: '', channelId: 'stream-1',
                text: 'Hello world'
            });

            const stored = secureStorage.getSentMessages('stream-1');
            expect(stored[0].text).toBe('Hello world');
        });
    });

    // ==================== _trimImageDataFromCache forceAll ====================
    describe('_trimImageDataFromCache', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0xTrimTest');
            secureStorage.imageDB = {}; // simulate IDB available
            secureStorage.cache.sentMessages = {
                'stream-1': [
                    { id: 'img1', type: 'image', imageData: 'data1', timestamp: 1 },
                    { id: 'img2', type: 'image', imageData: 'data2', timestamp: 2 },
                    { id: 'img3', type: 'image', imageData: 'data3', timestamp: 3 },
                    { id: 'img4', type: 'image', imageData: 'data4', timestamp: 4 },
                ]
            };
        });

        it('should trim oldest half when forceAll=false and IDB available', () => {
            secureStorage._trimImageDataFromCache(false);
            const msgs = secureStorage.cache.sentMessages['stream-1'];
            // 4 images → trim 2 oldest
            expect(msgs[0].imageData).toBeUndefined();
            expect(msgs[1].imageData).toBeUndefined();
            expect(msgs[2].imageData).toBe('data3');
            expect(msgs[3].imageData).toBe('data4');
        });

        it('should trim all when forceAll=true', () => {
            secureStorage._trimImageDataFromCache(true);
            const msgs = secureStorage.cache.sentMessages['stream-1'];
            expect(msgs.every(m => m.imageData === undefined)).toBe(true);
        });

        it('should trim all when IDB unavailable regardless of forceAll', () => {
            secureStorage.imageDB = null;
            secureStorage._trimImageDataFromCache(false);
            const msgs = secureStorage.cache.sentMessages['stream-1'];
            expect(msgs.every(m => m.imageData === undefined)).toBe(true);
        });

        it('should be no-op when no image messages exist', () => {
            secureStorage.cache.sentMessages = {
                'stream-1': [{ id: 'txt1', type: 'text', text: 'hi', timestamp: 1 }]
            };
            secureStorage._trimImageDataFromCache(true);
            expect(secureStorage.cache.sentMessages['stream-1'][0].text).toBe('hi');
        });
    });
});
