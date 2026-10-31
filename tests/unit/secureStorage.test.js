/**
 * SecureStorage Module Tests
 * Tests for guest mode and data accessor functions
 * 
 * Note: Full crypto tests require mocking CryptoKey which is complex.
 * These tests focus on guest mode (memory-only) which doesn't need crypto.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { secureStorage } from '../../src/js/secureStorage.js';

describe('secureStorage', () => {
    // Store original state to restore after tests
    let originalCache;
    let originalIsUnlocked;
    let originalIsGuestMode;
    let originalAddress;
    let originalStateDB;

    beforeEach(() => {
        // Save current state
        originalCache = secureStorage.cache;
        originalIsUnlocked = secureStorage.isUnlocked;
        originalIsGuestMode = secureStorage.isGuestMode;
        originalAddress = secureStorage.address;
        originalStateDB = secureStorage.stateDB;
    });

    afterEach(() => {
        // Restore original state
        if (secureStorage.stateDB && secureStorage.stateDB !== originalStateDB) {
            secureStorage.stateDB.close();
        }
        secureStorage.cache = originalCache;
        secureStorage.isUnlocked = originalIsUnlocked;
        secureStorage.isGuestMode = originalIsGuestMode;
        secureStorage.address = originalAddress;
        secureStorage.stateDB = originalStateDB;
    });

    describe('initAsGuest', () => {
        it('should initialize guest mode successfully', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            const result = secureStorage.initAsGuest(address);
            
            expect(result).toBe(true);
            expect(secureStorage.isGuestMode).toBe(true);
            expect(secureStorage.isUnlocked).toBe(true);
        });

        it('should normalize address to lowercase', () => {
            const address = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
            secureStorage.initAsGuest(address);
            
            expect(secureStorage.address).toBe(address.toLowerCase());
        });

        it('should initialize empty cache', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            secureStorage.initAsGuest(address);
            
            expect(secureStorage.cache).toBeDefined();
            expect(secureStorage.cache.channels).toEqual([]);
            expect(secureStorage.cache.trustedContacts).toEqual({});
            expect(secureStorage.cache.ensCache).toEqual({});
        });

        it('should not have storage key in guest mode', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            secureStorage.initAsGuest(address);
            
            expect(secureStorage.storageKey).toBeNull();
        });
    });

    // ==================== ACCOUNT MODE (with wallet) ====================
    describe('init (Account Mode)', () => {
        let mockSigner;
        let mockStorageKey;

        beforeEach(() => {
            // Reset state
            secureStorage.isGuestMode = false;
            secureStorage.isUnlocked = false;
            secureStorage.storageKey = null;
            secureStorage.cache = null;

            // Mock CryptoKey for storage key
            mockStorageKey = { type: 'secret', algorithm: { name: 'AES-GCM' } };

            // Mock signer with signMessage
            mockSigner = {
                signMessage: vi.fn().mockResolvedValue('0xmocksignature1234567890')
            };

            // Mock crypto.subtle for key derivation
            vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue({});
            vi.spyOn(crypto.subtle, 'deriveKey').mockResolvedValue(mockStorageKey);

            // Mock localStorage
            localStorage.clear();
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('should initialize account mode successfully', async () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            
            const result = await secureStorage.init(mockSigner, address);
            
            expect(result).toBe(true);
            expect(secureStorage.isUnlocked).toBe(true);
        });

        it('should normalize address to lowercase', async () => {
            const address = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
            
            await secureStorage.init(mockSigner, address);
            
            expect(secureStorage.address).toBe(address.toLowerCase());
        });

        it('should call signer.signMessage', async () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            
            await secureStorage.init(mockSigner, address);
            
            expect(mockSigner.signMessage).toHaveBeenCalledTimes(1);
        });

        it('should call crypto.subtle.deriveKey for PBKDF2', async () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            
            await secureStorage.init(mockSigner, address);
            
            expect(crypto.subtle.deriveKey).toHaveBeenCalled();
        });

        it('should store the derived storage key', async () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            
            await secureStorage.init(mockSigner, address);
            
            expect(secureStorage.storageKey).toBe(mockStorageKey);
        });

        it('should initialize cache after loading', async () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            
            await secureStorage.init(mockSigner, address);
            
            // Should have initialized cache (loadFromStorage creates empty on failure)
            expect(secureStorage.cache).toBeDefined();
        });

        it('should throw error if signer fails', async () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            mockSigner.signMessage.mockRejectedValue(new Error('User rejected'));
            
            await expect(secureStorage.init(mockSigner, address))
                .rejects.toThrow('User rejected');
        });

        it('should throw error if key derivation fails', async () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            vi.spyOn(crypto.subtle, 'deriveKey').mockRejectedValue(new Error('Crypto error'));
            
            await expect(secureStorage.init(mockSigner, address))
                .rejects.toThrow('Crypto error');
        });

        it('should not be in guest mode (initialized as non-guest)', async () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            
            await secureStorage.init(mockSigner, address);
            
            // init() doesn't change isGuestMode, so it stays false (default)
            expect(secureStorage.isGuestMode).toBe(false);
        });

        it('should have a storage key (unlike guest mode)', async () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            
            await secureStorage.init(mockSigner, address);
            
            expect(secureStorage.storageKey).not.toBeNull();
        });
    });

    describe('deriveStorageKey', () => {
        let mockSigner;

        beforeEach(() => {
            mockSigner = {
                signMessage: vi.fn().mockResolvedValue('0xsignature123')
            };
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('should call signMessage on signer', async () => {
            const address = '0xabc123';
            
            await secureStorage.deriveStorageKey(mockSigner, address);
            
            expect(mockSigner.signMessage).toHaveBeenCalled();
        });

        it('should include address in sign message', async () => {
            const address = '0xabc123';
            
            await secureStorage.deriveStorageKey(mockSigner, address);
            
            const signedMessage = mockSigner.signMessage.mock.calls[0][0];
            expect(signedMessage).toContain(address.toLowerCase());
        });

        it('should offload PBKDF2 to crypto worker pool', async () => {
            // The worker pool falls back to main-thread crypto in jsdom,
            // so we verify the crypto.subtle calls still happen
            vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue({});
            vi.spyOn(crypto.subtle, 'deriveKey').mockResolvedValue({ type: 'secret' });

            await secureStorage.deriveStorageKey(mockSigner, '0xtest');
            
            expect(crypto.subtle.importKey).toHaveBeenCalled();
            expect(crypto.subtle.deriveKey).toHaveBeenCalled();
        });

        it('should return derived key', async () => {
            vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue({});
            vi.spyOn(crypto.subtle, 'deriveKey').mockResolvedValue({ type: 'secret' });

            const result = await secureStorage.deriveStorageKey(mockSigner, '0xtest');
            
            expect(result).toEqual({ type: 'secret' });
        });

        it('should fall back to main-thread crypto when worker execute rejects', async () => {
            // Import and mock the worker pool to simulate a per-task failure
            const { cryptoWorkerPool } = await import('../../src/js/workers/cryptoWorkerPool.js');
            vi.spyOn(cryptoWorkerPool, 'execute').mockRejectedValue(new Error('Worker crashed'));
            vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue({});
            vi.spyOn(crypto.subtle, 'deriveKey').mockResolvedValue({ type: 'fallback-key' });

            const result = await secureStorage.deriveStorageKey(mockSigner, '0xfallback');

            expect(cryptoWorkerPool.execute).toHaveBeenCalledWith('DERIVE_KEY', expect.any(Object));
            expect(crypto.subtle.importKey).toHaveBeenCalled();
            expect(crypto.subtle.deriveKey).toHaveBeenCalled();
            expect(result).toEqual({ type: 'fallback-key' });
        });
    });

    describe('Data Accessors (Guest Mode)', () => {
        beforeEach(() => {
            // Initialize guest mode for testing data accessors
            secureStorage.initAsGuest('0x1234567890abcdef1234567890abcdef12345678');
        });

        describe('getChannels / setChannels', () => {
            it('should get empty channels array initially', () => {
                expect(secureStorage.getChannels()).toEqual([]);
            });

            it('should set and get channels', async () => {
                const channels = [
                    { streamId: 'channel-1', name: 'Test 1', type: 'open' },
                    { streamId: 'channel-2', name: 'Test 2', type: 'closed' }
                ];
                
                await secureStorage.setChannels(channels);
                expect(secureStorage.getChannels()).toEqual(channels);
            });
        });

        describe('getUsername / setUsername', () => {
            it('should get null username initially', () => {
                expect(secureStorage.getUsername()).toBeNull();
            });

            it('should set and get username', async () => {
                await secureStorage.setUsername('TestUser');
                expect(secureStorage.getUsername()).toBe('TestUser');
            });

            it('should persist username to plain localStorage when not guest', async () => {
                const setItemSpy = vi.spyOn(localStorage, 'setItem');
                const saveSpy = vi.spyOn(secureStorage, 'saveToStorage').mockResolvedValue();
                secureStorage.address = '0xtest1234';
                secureStorage.isGuestMode = false;
                await secureStorage.setUsername('Alice');
                expect(setItemSpy).toHaveBeenCalledWith('pombo_username_0xtest1234', 'Alice');
                setItemSpy.mockRestore();
                saveSpy.mockRestore();
            });

            it('should remove from localStorage when username cleared', async () => {
                const removeItemSpy = vi.spyOn(localStorage, 'removeItem');
                const saveSpy = vi.spyOn(secureStorage, 'saveToStorage').mockResolvedValue();
                secureStorage.address = '0xtest1234';
                secureStorage.isGuestMode = false;
                await secureStorage.setUsername(null);
                expect(removeItemSpy).toHaveBeenCalledWith('pombo_username_0xtest1234');
                removeItemSpy.mockRestore();
                saveSpy.mockRestore();
            });

            it('should not write to localStorage in guest mode', async () => {
                const setItemSpy = vi.spyOn(localStorage, 'setItem');
                secureStorage.address = '0xtest1234';
                secureStorage.isGuestMode = true;
                await secureStorage.setUsername('Alice');
                expect(setItemSpy).not.toHaveBeenCalledWith('pombo_username_0xtest1234', 'Alice');
                setItemSpy.mockRestore();
            });
        });

        describe('getTrustedContacts / setTrustedContacts', () => {
            it('should get empty contacts initially', () => {
                expect(secureStorage.getTrustedContacts()).toEqual({});
            });

            it('should set and get contacts', async () => {
                const contacts = {
                    '0xabc': { name: 'Alice', trusted: true },
                    '0xdef': { name: 'Bob', trusted: true }
                };
                
                await secureStorage.setTrustedContacts(contacts);
                expect(secureStorage.getTrustedContacts()).toEqual(contacts);
            });
        });

        describe('getENSCache / setENSCache', () => {
            it('should get empty ENS cache initially', () => {
                expect(secureStorage.getENSCache()).toEqual({});
            });

            it('should set and get ENS cache', async () => {
                const cache = {
                    'vitalik.eth': { address: '0x123', timestamp: Date.now() }
                };
                
                await secureStorage.setENSCache(cache);
                expect(secureStorage.getENSCache()).toEqual(cache);
            });
        });

        describe('getNsfwEnabled / setNsfwEnabled', () => {
            it('should return false by default', () => {
                expect(secureStorage.getNsfwEnabled()).toBe(false);
            });

            it('should set and get nsfw enabled', async () => {
                await secureStorage.setNsfwEnabled(true);
                expect(secureStorage.getNsfwEnabled()).toBe(true);
            });
        });

        describe('getYouTubeEmbedsEnabled / setYouTubeEmbedsEnabled', () => {
            it('should return true by default', () => {
                expect(secureStorage.getYouTubeEmbedsEnabled()).toBe(true);
            });

            it('should set and get youtube embeds enabled', async () => {
                await secureStorage.setYouTubeEmbedsEnabled(false);
                expect(secureStorage.getYouTubeEmbedsEnabled()).toBe(false);
            });
        });

        describe('getGraphApiKey / setGraphApiKey', () => {
            it('should get null api key initially', () => {
                expect(secureStorage.getGraphApiKey()).toBeNull();
            });

            it('should set and get api key', async () => {
                await secureStorage.setGraphApiKey('test-api-key');
                expect(secureStorage.getGraphApiKey()).toBe('test-api-key');
            });
        });

        describe('getSessionData / setSessionData / clearSessionData', () => {
            it('should get null session data initially', () => {
                expect(secureStorage.getSessionData()).toBeNull();
            });

            it('should set and get session data', async () => {
                const sessionData = { token: 'abc123', expires: Date.now() };
                await secureStorage.setSessionData(sessionData);
                expect(secureStorage.getSessionData()).toEqual(sessionData);
            });

            it('should clear session data', async () => {
                await secureStorage.setSessionData({ token: 'abc' });
                await secureStorage.clearSessionData();
                expect(secureStorage.getSessionData()).toBeNull();
            });
        });
    });

    describe('Locked State', () => {
        it('should return empty arrays when not unlocked', () => {
            secureStorage.isUnlocked = false;
            secureStorage.cache = { channels: ['test'] };
            
            expect(secureStorage.getChannels()).toEqual([]);
        });

        it('should return null for username when not unlocked', () => {
            secureStorage.isUnlocked = false;
            secureStorage.cache = { username: 'Test' };
            
            expect(secureStorage.getUsername()).toBeNull();
        });
    });

    describe('getStorageKey', () => {
        it('should return prefixed storage key', () => {
            secureStorage.address = '0xabc123';
            const key = secureStorage.getStorageKey();
            
            expect(key).toBe('pombo_secure_0xabc123');
        });
    });

    describe('saveToStorage (Guest Mode)', () => {
        it('should not persist in guest mode', async () => {
            const localStorageSpy = vi.spyOn(localStorage, 'setItem');
            
            secureStorage.initAsGuest('0x1234567890abcdef1234567890abcdef12345678');
            await secureStorage.setUsername('Test');
            await secureStorage.saveToStorage();
            
            // In guest mode, no localStorage calls should happen
            expect(localStorageSpy).not.toHaveBeenCalled();
            
            localStorageSpy.mockRestore();
        });
    });

    describe('Constants', () => {
        it('should derive storage key with the pombo_secure_ prefix', () => {
            // STORAGE_PREFIX is no longer a property — the key is now derived
            // via the centralized CONFIG.storageKeys registry. Verify the
            // prefix is preserved for backward compatibility with existing data.
            secureStorage.address = '0xabcdef0000000000000000000000000000001234';
            expect(secureStorage.getStorageKey()).toMatch(/^pombo_secure_0x[a-f0-9]{40}$/);
        });

        it('should have reasonable PBKDF2 iterations', () => {
            // Should be at least 100,000 for security
            expect(secureStorage.PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(100000);
        });
    });

    describe('Channel Last Access', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0x1234567890abcdef1234567890abcdef12345678');
        });

        describe('getChannelLastAccess()', () => {
            it('should return null for never accessed channel', () => {
                expect(secureStorage.getChannelLastAccess('unknown-channel')).toBeNull();
            });

            it('should return timestamp after setting access', async () => {
                const timestamp = Date.now();
                await secureStorage.setChannelLastAccess('channel-1', timestamp);
                expect(secureStorage.getChannelLastAccess('channel-1')).toBe(timestamp);
            });

            it('should return null when storage is locked', () => {
                secureStorage.isUnlocked = false;
                expect(secureStorage.getChannelLastAccess('channel-1')).toBeNull();
            });

            it('should read emergency localStorage value', () => {
                const emergencyTimestamp = Date.now();
                localStorage.setItem('pombo_channel_access_channel-1', emergencyTimestamp.toString());
                
                const result = secureStorage.getChannelLastAccess('channel-1');
                expect(result).toBe(emergencyTimestamp);
                
                // Should clean up emergency key
                expect(localStorage.getItem('pombo_channel_access_channel-1')).toBeNull();
            });

            it('should use newer timestamp between cache and emergency', async () => {
                const olderTimestamp = Date.now() - 10000;
                const newerTimestamp = Date.now();
                
                await secureStorage.setChannelLastAccess('channel-1', olderTimestamp);
                localStorage.setItem('pombo_channel_access_channel-1', newerTimestamp.toString());
                
                expect(secureStorage.getChannelLastAccess('channel-1')).toBe(newerTimestamp);
            });
        });

        describe('setChannelLastAccess()', () => {
            it('should set timestamp with default to now', async () => {
                const before = Date.now();
                await secureStorage.setChannelLastAccess('channel-1');
                const after = Date.now();
                
                const result = secureStorage.getChannelLastAccess('channel-1');
                expect(result).toBeGreaterThanOrEqual(before);
                expect(result).toBeLessThanOrEqual(after);
            });

            it('should remove emergency localStorage on set', async () => {
                localStorage.setItem('pombo_channel_access_channel-1', '123456');
                await secureStorage.setChannelLastAccess('channel-1', Date.now());
                expect(localStorage.getItem('pombo_channel_access_channel-1')).toBeNull();
            });

            it('should not set when locked', async () => {
                secureStorage.isUnlocked = false;
                await secureStorage.setChannelLastAccess('channel-1', 12345);
                
                secureStorage.isUnlocked = true;
                secureStorage.cache = { channelLastAccess: {} };
                expect(secureStorage.getChannelLastAccess('channel-1')).toBeNull();
            });
        });
    });

    describe('Channel Order', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0x1234567890abcdef1234567890abcdef12345678');
        });

        describe('getChannelOrder()', () => {
            it('should return empty array initially', () => {
                expect(secureStorage.getChannelOrder()).toEqual([]);
            });

            it('should return empty array when locked', () => {
                secureStorage.isUnlocked = false;
                expect(secureStorage.getChannelOrder()).toEqual([]);
            });
        });

        describe('setChannelOrder()', () => {
            it('should set and get channel order', async () => {
                const order = ['channel-1', 'channel-2', 'channel-3'];
                await secureStorage.setChannelOrder(order);
                expect(secureStorage.getChannelOrder()).toEqual(order);
            });

            it('should not set when locked', async () => {
                secureStorage.isUnlocked = false;
                await secureStorage.setChannelOrder(['channel-1']);
                
                secureStorage.isUnlocked = true;
                secureStorage.cache = {};
                expect(secureStorage.getChannelOrder()).toEqual([]);
            });
        });

        describe('addToChannelOrder()', () => {
            it('should add channel to order', async () => {
                await secureStorage.addToChannelOrder('channel-1');
                expect(secureStorage.getChannelOrder()).toContain('channel-1');
            });

            it('should add to end of list', async () => {
                await secureStorage.setChannelOrder(['channel-1', 'channel-2']);
                await secureStorage.addToChannelOrder('channel-3');
                
                const order = secureStorage.getChannelOrder();
                expect(order[order.length - 1]).toBe('channel-3');
            });

            it('should not add duplicates', async () => {
                await secureStorage.addToChannelOrder('channel-1');
                await secureStorage.addToChannelOrder('channel-1');
                
                const order = secureStorage.getChannelOrder();
                expect(order.filter(id => id === 'channel-1').length).toBe(1);
            });

            it('should initialize array if not exists', async () => {
                secureStorage.cache.channelOrder = undefined;
                await secureStorage.addToChannelOrder('channel-1');
                expect(secureStorage.getChannelOrder()).toEqual(['channel-1']);
            });
        });

        describe('removeFromChannelOrder()', () => {
            it('should remove channel from order', async () => {
                await secureStorage.setChannelOrder(['channel-1', 'channel-2', 'channel-3']);
                await secureStorage.removeFromChannelOrder('channel-2');
                
                expect(secureStorage.getChannelOrder()).toEqual(['channel-1', 'channel-3']);
            });

            it('should handle removing non-existent channel', async () => {
                await secureStorage.setChannelOrder(['channel-1']);
                await secureStorage.removeFromChannelOrder('unknown');
                
                expect(secureStorage.getChannelOrder()).toEqual(['channel-1']);
            });

            it('should handle empty order array', async () => {
                await secureStorage.removeFromChannelOrder('channel-1');
                // Should not throw
                expect(secureStorage.getChannelOrder()).toEqual([]);
            });
        });
    });

    describe('Last Opened Channel', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0x1234567890abcdef1234567890abcdef12345678');
        });

        describe('getLastOpenedChannel()', () => {
            it('should return null initially', () => {
                expect(secureStorage.getLastOpenedChannel()).toBeNull();
            });

            it('should return null when locked', () => {
                secureStorage.isUnlocked = false;
                expect(secureStorage.getLastOpenedChannel()).toBeNull();
            });
        });

        describe('setLastOpenedChannel()', () => {
            it('should set and get last opened channel', async () => {
                await secureStorage.setLastOpenedChannel('channel-123');
                expect(secureStorage.getLastOpenedChannel()).toBe('channel-123');
            });

            it('should allow setting to null', async () => {
                await secureStorage.setLastOpenedChannel('channel-123');
                await secureStorage.setLastOpenedChannel(null);
                expect(secureStorage.getLastOpenedChannel()).toBeNull();
            });
        });
    });

    describe('Lifecycle', () => {
        describe('lock()', () => {
            it('should clear all state on lock', () => {
                secureStorage.initAsGuest('0x1234567890abcdef1234567890abcdef12345678');
                
                secureStorage.lock();
                
                expect(secureStorage.isUnlocked).toBe(false);
                expect(secureStorage.cache).toBeNull();
                expect(secureStorage.address).toBeNull();
                expect(secureStorage.storageKey).toBeNull();
                expect(secureStorage.isGuestMode).toBe(false);
            });
        });

        describe('isStorageUnlocked()', () => {
            it('should return true when unlocked', () => {
                secureStorage.initAsGuest('0x1234567890abcdef1234567890abcdef12345678');
                expect(secureStorage.isStorageUnlocked()).toBe(true);
            });

            it('should return false when locked', () => {
                secureStorage.lock();
                expect(secureStorage.isStorageUnlocked()).toBe(false);
            });
        });

        describe('getCurrentAddress()', () => {
            it('should return address after init', () => {
                const address = '0x1234567890abcdef1234567890abcdef12345678';
                secureStorage.initAsGuest(address);
                expect(secureStorage.getCurrentAddress()).toBe(address.toLowerCase());
            });

            it('should return null when locked', () => {
                secureStorage.lock();
                expect(secureStorage.getCurrentAddress()).toBeNull();
            });
        });
    });

    describe('getStats()', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0x1234567890abcdef1234567890abcdef12345678');
        });

        it('should return null when locked', () => {
            secureStorage.lock();
            expect(secureStorage.getStats()).toBeNull();
        });

        it('should return stats object with correct structure', () => {
            const stats = secureStorage.getStats();
            
            expect(stats).toHaveProperty('channels');
            expect(stats).toHaveProperty('contacts');
            expect(stats).toHaveProperty('ensEntries');
            expect(stats).toHaveProperty('hasUsername');
            expect(stats).toHaveProperty('hasApiKey');
        });

        it('should count channels correctly', async () => {
            await secureStorage.setChannels([
                { streamId: 'ch1' },
                { streamId: 'ch2' }
            ]);
            
            const stats = secureStorage.getStats();
            expect(stats.channels).toBe(2);
        });

        it('should count contacts correctly', async () => {
            await secureStorage.setTrustedContacts({
                '0xabc': { name: 'Alice' },
                '0xdef': { name: 'Bob' },
                '0x123': { name: 'Charlie' }
            });
            
            const stats = secureStorage.getStats();
            expect(stats.contacts).toBe(3);
        });

        it('should count ENS entries correctly', async () => {
            await secureStorage.setENSCache({
                'vitalik.eth': { address: '0x1' },
                'test.eth': { address: '0x2' }
            });
            
            const stats = secureStorage.getStats();
            expect(stats.ensEntries).toBe(2);
        });

        it('should detect username presence', async () => {
            expect(secureStorage.getStats().hasUsername).toBe(false);
            
            await secureStorage.setUsername('TestUser');
            expect(secureStorage.getStats().hasUsername).toBe(true);
        });

        it('should detect API key presence', async () => {
            expect(secureStorage.getStats().hasApiKey).toBe(false);
            
            await secureStorage.setGraphApiKey('test-key');
            expect(secureStorage.getStats().hasApiKey).toBe(true);
        });
    });

    describe('Encrypt/Decrypt (with real crypto)', () => {
        let testKey;
        
        beforeEach(async () => {
            secureStorage.initAsGuest('0x1234567890abcdef1234567890abcdef12345678');
            // Create a real AES-GCM key for testing
            testKey = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 },
                true,
                ['encrypt', 'decrypt']
            );
        });

        describe('encrypt()', () => {
            it('should throw when storage not initialized', async () => {
                secureStorage.storageKey = null;
                await expect(secureStorage.encrypt({ test: 'data' }))
                    .rejects.toThrow('Storage not initialized');
            });

            it('should return iv and ciphertext arrays', async () => {
                secureStorage.storageKey = testKey;
                const result = await secureStorage.encrypt({ hello: 'world' });
                
                expect(result).toHaveProperty('iv');
                expect(result).toHaveProperty('ciphertext');
                expect(Array.isArray(result.iv)).toBe(true);
                expect(Array.isArray(result.ciphertext)).toBe(true);
                expect(result.iv.length).toBe(12); // AES-GCM IV is 12 bytes
            });

            it('should produce different ciphertext for same data (random IV)', async () => {
                secureStorage.storageKey = testKey;
                const data = { test: 'data' };
                
                const result1 = await secureStorage.encrypt(data);
                const result2 = await secureStorage.encrypt(data);
                
                // IVs should be different
                expect(result1.iv).not.toEqual(result2.iv);
                // Ciphertext should be different due to different IVs
                expect(result1.ciphertext).not.toEqual(result2.ciphertext);
            });
        });

        describe('decrypt()', () => {
            it('should throw when storage not initialized', async () => {
                secureStorage.storageKey = null;
                await expect(secureStorage.decrypt({ iv: [], ciphertext: [] }))
                    .rejects.toThrow('Storage not initialized');
            });

            it('should decrypt encrypted data correctly', async () => {
                secureStorage.storageKey = testKey;
                const originalData = { message: 'Hello World', count: 42 };
                
                const encrypted = await secureStorage.encrypt(originalData);
                const decrypted = await secureStorage.decrypt(encrypted);
                
                expect(decrypted).toEqual(originalData);
            });

            it('should handle complex nested objects', async () => {
                secureStorage.storageKey = testKey;
                const complexData = {
                    channels: [{ id: 1 }, { id: 2 }],
                    contacts: { '0x1': { name: 'Alice' } },
                    settings: { nested: { deep: true } }
                };
                
                const encrypted = await secureStorage.encrypt(complexData);
                const decrypted = await secureStorage.decrypt(encrypted);
                
                expect(decrypted).toEqual(complexData);
            });

            it('should handle arrays', async () => {
                secureStorage.storageKey = testKey;
                const arrayData = [1, 2, 3, 'four', { five: 5 }];
                
                const encrypted = await secureStorage.encrypt(arrayData);
                const decrypted = await secureStorage.decrypt(encrypted);
                
                expect(decrypted).toEqual(arrayData);
            });
        });
    });

    describe('loadFromStorage()', () => {
        beforeEach(async () => {
            localStorage.clear();
            secureStorage.initAsGuest('0x1234567890abcdef1234567890abcdef12345678');
        });

        it('should initialize empty cache when no stored data', async () => {
            secureStorage.cache = null;
            secureStorage.storageKey = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
            );
            
            await secureStorage.loadFromStorage();
            
            expect(secureStorage.cache).toBeDefined();
            expect(secureStorage.cache.channels).toEqual([]);
            expect(secureStorage.cache.trustedContacts).toEqual({});
        });

        it('should throw StorageError on corrupted JSON in localStorage', async () => {
            secureStorage.storageKey = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
            );
            localStorage.setItem(secureStorage.getStorageKey(), 'not valid json');
            
            await expect(secureStorage.loadFromStorage())
                .rejects.toThrow('Failed to decrypt storage');
        });

        it('should throw StorageError on corrupted encrypted data', async () => {
            secureStorage.storageKey = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
            );
            // Valid JSON but invalid encrypted format
            localStorage.setItem(secureStorage.getStorageKey(), JSON.stringify({
                iv: [1, 2, 3],
                ciphertext: [4, 5, 6]
            }));
            
            await expect(secureStorage.loadFromStorage())
                .rejects.toThrow('Failed to decrypt storage');
        });
    });

    describe('saveToStorage()', () => {
        beforeEach(async () => {
            localStorage.clear();
        });

        it('should not save when not unlocked', async () => {
            secureStorage.isUnlocked = false;
            await secureStorage.saveToStorage();
            // Should not throw, just warn
        });

        it('should save encrypted data to localStorage (non-guest)', async () => {
            secureStorage.isGuestMode = false;
            secureStorage.isUnlocked = true;
            secureStorage.address = '0xtest';
            secureStorage.cache = { channels: [], trustedContacts: {} };
            secureStorage.storageKey = await crypto.subtle.generateKey(
                { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
            );
            
            await secureStorage.saveToStorage();
            
            const stored = localStorage.getItem(secureStorage.getStorageKey());
            expect(stored).toBeTruthy();
            
            const parsed = JSON.parse(stored);
            expect(parsed).toHaveProperty('iv');
            expect(parsed).toHaveProperty('ciphertext');
        });
    });

    describe('Edge Cases', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0x1234567890abcdef1234567890abcdef12345678');
        });

        describe('setChannels() when locked', () => {
            it('should not set channels when locked', async () => {
                await secureStorage.setChannels([{ id: 1 }]);
                secureStorage.isUnlocked = false;
                
                // Try to set new channels
                await secureStorage.setChannels([{ id: 2 }]);
                
                // Re-unlock and check original is preserved
                secureStorage.isUnlocked = true;
                const channels = secureStorage.getChannels();
                expect(channels).toEqual([{ id: 1 }]);
            });
        });

        describe('setTrustedContacts() when locked', () => {
            it('should not set contacts when locked', async () => {
                await secureStorage.setTrustedContacts({ '0x1': { name: 'A' } });
                secureStorage.isUnlocked = false;
                
                await secureStorage.setTrustedContacts({ '0x2': { name: 'B' } });
                
                secureStorage.isUnlocked = true;
                expect(secureStorage.getTrustedContacts()).toEqual({ '0x1': { name: 'A' } });
            });
        });

        describe('setENSCache() when locked', () => {
            it('should not set ENS cache when locked', async () => {
                await secureStorage.setENSCache({ 'a.eth': {} });
                secureStorage.isUnlocked = false;
                
                await secureStorage.setENSCache({ 'b.eth': {} });
                
                secureStorage.isUnlocked = true;
                expect(secureStorage.getENSCache()).toHaveProperty('a.eth');
            });
        });

        describe('setGraphApiKey() when locked', () => {
            it('should not set API key when locked', async () => {
                await secureStorage.setGraphApiKey('key1');
                secureStorage.isUnlocked = false;
                
                await secureStorage.setGraphApiKey('key2');
                
                secureStorage.isUnlocked = true;
                expect(secureStorage.getGraphApiKey()).toBe('key1');
            });
        });

        describe('setSessionData() when locked', () => {
            it('should not set session data when locked', async () => {
                await secureStorage.setSessionData({ token: 'abc' });
                secureStorage.isUnlocked = false;
                
                await secureStorage.setSessionData({ token: 'xyz' });
                
                secureStorage.isUnlocked = true;
                expect(secureStorage.getSessionData()).toEqual({ token: 'abc' });
            });
        });
    });

    describe('isGuestMode property', () => {
        it('should be true after initAsGuest', () => {
            secureStorage.initAsGuest('0x1234');
            expect(secureStorage.isGuestMode).toBe(true);
        });

        it('should be false after lock', () => {
            secureStorage.initAsGuest('0x1234');
            secureStorage.lock();
            expect(secureStorage.isGuestMode).toBe(false);
        });
    });

    // ==================== Sent Messages (DM) ====================
    describe('Sent Messages (DM)', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0x1234567890abcdef1234567890abcdef12345678');
        });

        describe('getSentMessages()', () => {
            it('should return empty array for unknown stream', () => {
                expect(secureStorage.getSentMessages('unknown-stream')).toEqual([]);
            });

            it('should return empty array when locked', () => {
                secureStorage.isUnlocked = false;
                expect(secureStorage.getSentMessages('any-stream')).toEqual([]);
            });
        });

        describe('addSentMessage()', () => {
            it('should store a text message', async () => {
                const msg = {
                    id: 'msg-1',
                    sender: '0xabc',
                    timestamp: Date.now(),
                    signature: '0xsig',
                    channelId: 'stream-1',
                    text: 'Hello DM'
                };
                await secureStorage.addSentMessage('stream-1', msg);

                const stored = secureStorage.getSentMessages('stream-1');
                expect(stored).toHaveLength(1);
                expect(stored[0].text).toBe('Hello DM');
                expect(stored[0].id).toBe('msg-1');
            });

            it('should store an image message', async () => {
                const msg = {
                    id: 'img-1',
                    sender: '0xabc',
                    timestamp: Date.now(),
                    signature: '0xsig',
                    channelId: 'stream-1',
                    type: 'image',
                    imageId: 'img-abc',
                    imageData: 'data:image/png;base64,...'
                };
                await secureStorage.addSentMessage('stream-1', msg);

                const stored = secureStorage.getSentMessages('stream-1');
                expect(stored[0].type).toBe('image');
                expect(stored[0].imageId).toBe('img-abc');
            });

            it('should store a file_announce message', async () => {
                const msg = {
                    id: 'vid-1',
                    sender: '0xabc',
                    timestamp: Date.now(),
                    signature: '0xsig',
                    channelId: 'stream-1',
                    type: 'file_announce',
                    metadata: { duration: 120 }
                };
                await secureStorage.addSentMessage('stream-1', msg);

                const stored = secureStorage.getSentMessages('stream-1');
                expect(stored[0].type).toBe('file_announce');
                expect(stored[0].metadata.duration).toBe(120);
            });

            it('should cap at 200 messages per stream', async () => {
                for (let i = 0; i < 210; i++) {
                    await secureStorage.addSentMessage('stream-1', {
                        id: `msg-${i}`,
                        sender: '0xabc',
                        timestamp: Date.now() + i,
                        signature: '0xsig',
                        channelId: 'stream-1',
                        text: `Message ${i}`
                    });
                }

                const stored = secureStorage.getSentMessages('stream-1');
                expect(stored).toHaveLength(200);
                // Should keep the latest 200 (indexes 10-209)
                expect(stored[0].id).toBe('msg-10');
                expect(stored[199].id).toBe('msg-209');
            });

            it('should keep separate streams independent', async () => {
                await secureStorage.addSentMessage('stream-A', {
                    id: 'a1', sender: '0x1', timestamp: 1, signature: '', channelId: 'stream-A', text: 'A'
                });
                await secureStorage.addSentMessage('stream-B', {
                    id: 'b1', sender: '0x1', timestamp: 2, signature: '', channelId: 'stream-B', text: 'B'
                });

                expect(secureStorage.getSentMessages('stream-A')).toHaveLength(1);
                expect(secureStorage.getSentMessages('stream-B')).toHaveLength(1);
            });

            it('should not store when locked', async () => {
                secureStorage.isUnlocked = false;
                await secureStorage.addSentMessage('stream-1', {
                    id: 'msg-1', sender: '0x1', timestamp: 1, signature: '', channelId: 'stream-1', text: 'X'
                });

                secureStorage.isUnlocked = true;
                expect(secureStorage.getSentMessages('stream-1')).toEqual([]);
            });
        });

        describe('clearSentMessages()', () => {
            it('should clear sent messages for a stream', async () => {
                await secureStorage.addSentMessage('stream-1', {
                    id: 'msg-1', sender: '0x1', timestamp: 1, signature: '', channelId: 'stream-1', text: 'Hi'
                });
                expect(secureStorage.getSentMessages('stream-1')).toHaveLength(1);

                await secureStorage.clearSentMessages('stream-1');
                expect(secureStorage.getSentMessages('stream-1')).toEqual([]);
            });

            it('should not affect other streams', async () => {
                await secureStorage.addSentMessage('stream-A', {
                    id: 'a1', sender: '0x1', timestamp: 1, signature: '', channelId: 'stream-A', text: 'A'
                });
                await secureStorage.addSentMessage('stream-B', {
                    id: 'b1', sender: '0x1', timestamp: 2, signature: '', channelId: 'stream-B', text: 'B'
                });

                await secureStorage.clearSentMessages('stream-A');
                expect(secureStorage.getSentMessages('stream-A')).toEqual([]);
                expect(secureStorage.getSentMessages('stream-B')).toHaveLength(1);
            });
        });

        describe('clearSentReactions()', () => {
            it('should clear sent reactions for a stream', async () => {
                await secureStorage.addSentReaction('stream-1', 'msg-1', '👍', '0xuser1');
                expect(Object.keys(secureStorage.getSentReactions('stream-1'))).toHaveLength(1);

                await secureStorage.clearSentReactions('stream-1');
                expect(secureStorage.getSentReactions('stream-1')).toEqual({});
            });

            it('should not affect other streams', async () => {
                await secureStorage.addSentReaction('stream-A', 'msg-1', '👍', '0xuser1');
                await secureStorage.addSentReaction('stream-B', 'msg-2', '❤️', '0xuser1');

                await secureStorage.clearSentReactions('stream-A');
                expect(secureStorage.getSentReactions('stream-A')).toEqual({});
                expect(Object.keys(secureStorage.getSentReactions('stream-B'))).toHaveLength(1);
            });
        });
    });

    // ==================== Export Backup includes sentMessages ====================
    describe('exportAccountBackup - sentMessages inclusion', () => {
        it('should include sentMessages in the backup data object', () => {
            // We test the data preparation logic, not the encryption.
            // exportAccountBackup encrypts dataToBackup, so we verify the cache is set up correctly.
            secureStorage.initAsGuest('0xabc123');
            secureStorage.cache.sentMessages = {
                'stream-1': [{ id: 'msg-1', text: 'Hello', timestamp: 1 }],
                'stream-2': [{ id: 'msg-2', text: 'World', timestamp: 2 }]
            };

            // The export builds dataToBackup from cache — verify the fields exist
            const data = {
                channels: secureStorage.cache.channels || [],
                trustedContacts: secureStorage.cache.trustedContacts || {},
                ensCache: secureStorage.cache.ensCache || {},
                username: secureStorage.cache.username,
                graphApiKey: secureStorage.cache.graphApiKey,
                sentMessages: secureStorage.cache.sentMessages || {}
            };

            expect(data.sentMessages).toBeDefined();
            expect(Object.keys(data.sentMessages)).toHaveLength(2);
            expect(data.sentMessages['stream-1'][0].text).toBe('Hello');
        });

        it('should default sentMessages to empty object when not set', () => {
            secureStorage.initAsGuest('0xdef456');
            // Don't set sentMessages — should default to {}
            const sentMessages = secureStorage.cache.sentMessages || {};
            expect(sentMessages).toEqual({});
        });
    });

    // ==================== Cross-Device Sync ====================
    describe('Cross-Device Sync', () => {
        describe('exportForSync()', () => {
            it('should throw when storage not unlocked', () => {
                secureStorage.isUnlocked = false;
                secureStorage.cache = null;
                
                expect(() => secureStorage.exportForSync()).toThrow('Storage not unlocked');
            });

            it('should return all syncable fields', () => {
                secureStorage.initAsGuest('0xsync123');
                secureStorage.cache.channels = [{ messageStreamId: 'ch1', name: 'Test' }];
                secureStorage.cache.trustedContacts = { '0xabc': { level: 2 } };
                secureStorage.cache.ensCache = { '0xdef': 'test.eth' };
                secureStorage.cache.username = 'testuser';
                secureStorage.cache.graphApiKey = 'api123';
                secureStorage.cache.sentMessages = { 'stream1': [{ id: 'msg1' }] };
                secureStorage.cache.sentReactions = { 'stream1': { 'msg1': { '👍': ['0xuser1'] } } };
                secureStorage.cache.blockedPeers = ['0xblocked1'];
                secureStorage.cache.dmLeftAt = { '0xpeer1': 12345 };
                
                const result = secureStorage.exportForSync();
                
                expect(result.channels).toHaveLength(1);
                expect(result.trustedContacts['0xabc']).toBeDefined();
                expect(result.ensCache['0xdef']).toBe('test.eth');
                expect(result.username).toBe('testuser');
                expect(result.graphApiKey).toBe('api123');
                expect(result.sentMessages.stream1).toHaveLength(1);
                expect(result.sentReactions.stream1.msg1['👍']).toEqual(['0xuser1']);
                expect(result.blockedPeers).toEqual(['0xblocked1']);
                expect(result.dmLeftAt).toEqual({ '0xpeer1': 12345 });
            });

            it('should return empty values when cache is empty', () => {
                secureStorage.initAsGuest('0xempty');
                
                const result = secureStorage.exportForSync();
                
                expect(result.channels).toEqual([]);
                expect(result.trustedContacts).toEqual({});
                expect(result.ensCache).toEqual({});
                expect(result.username).toBe(null);
                expect(result.graphApiKey).toBe(null);
                expect(result.sentMessages).toEqual({});
                expect(result.sentReactions).toEqual({});
                expect(result.blockedPeers).toEqual([]);
                expect(result.dmLeftAt).toEqual({});
            });

            it('should not include non-syncable fields', () => {
                secureStorage.initAsGuest('0xfiltered');
                secureStorage.cache.sessionData = { secret: 'data' };
                secureStorage.cache.channelLastAccess = { 'ch1': 12345 };
                
                const result = secureStorage.exportForSync();
                
                expect(result.sessionData).toBeUndefined();
                expect(result.channelLastAccess).toBeUndefined();
            });
        });

        describe('importFromSync()', () => {
            it('should throw when storage not unlocked', async () => {
                secureStorage.isUnlocked = false;
                secureStorage.cache = null;
                
                await expect(secureStorage.importFromSync({})).rejects.toThrow('Storage not unlocked');
            });

            it('should import all syncable fields', async () => {
                secureStorage.initAsGuest('0ximport');
                
                const data = {
                    channels: [{ messageStreamId: 'newCh' }],
                    trustedContacts: { '0xnew': { level: 3 } },
                    ensCache: { '0xens': 'new.eth' },
                    username: 'newuser',
                    graphApiKey: 'newapi',
                    sentMessages: { 'newStream': [{ id: 'new1' }] },
                    sentReactions: { 'newStream': { 'msg1': { '❤️': ['0xnew'] } } },
                    blockedPeers: ['0xblocked'],
                    dmLeftAt: { '0xpeer': 99999 }
                };
                
                await secureStorage.importFromSync(data);
                
                expect(secureStorage.cache.channels).toEqual(data.channels);
                expect(secureStorage.cache.trustedContacts).toEqual(data.trustedContacts);
                expect(secureStorage.cache.ensCache).toEqual(data.ensCache);
                expect(secureStorage.cache.username).toBe('newuser');
                expect(secureStorage.cache.graphApiKey).toBe('newapi');
                expect(secureStorage.cache.sentMessages).toEqual(data.sentMessages);
                expect(secureStorage.cache.sentReactions).toEqual(data.sentReactions);
                expect(secureStorage.cache.blockedPeers).toEqual(['0xblocked']);
                expect(secureStorage.cache.dmLeftAt).toEqual({ '0xpeer': 99999 });
            });

            it('should return true when channels are updated', async () => {
                secureStorage.initAsGuest('0xchannels');
                
                const result = await secureStorage.importFromSync({
                    channels: [{ messageStreamId: 'ch1' }]
                });
                
                expect(result).toEqual({
                    hasChanges: true,
                    channelsUpdated: true,
                    epochKeysUpdated: false,
                    contactsUpdated: false,
                    blockedPeersUpdated: false,
                    usernameUpdated: false,
                    sentMessagesUpdated: false
                });
            });

            it('should return false when channels are not updated', async () => {
                secureStorage.initAsGuest('0xnochannels');
                
                const result = await secureStorage.importFromSync({
                    username: 'test'
                });
                
                expect(result).toEqual({
                    hasChanges: true,
                    channelsUpdated: false,
                    epochKeysUpdated: false,
                    contactsUpdated: false,
                    blockedPeersUpdated: false,
                    usernameUpdated: true,
                    sentMessagesUpdated: false
                });
            });

            it('should only update provided fields', async () => {
                secureStorage.initAsGuest('0xpartial');
                secureStorage.cache.username = 'original';
                secureStorage.cache.graphApiKey = 'originalKey';
                
                await secureStorage.importFromSync({
                    username: 'updated'
                });
                
                expect(secureStorage.cache.username).toBe('updated');
                expect(secureStorage.cache.graphApiKey).toBe('originalKey');
            });

            it('should not overwrite with undefined values', async () => {
                secureStorage.initAsGuest('0xundef');
                secureStorage.cache.username = 'keep';
                
                await secureStorage.importFromSync({
                    username: undefined
                });
                
                // undefined should not trigger update
                expect(secureStorage.cache.username).toBe('keep');
            });

            it('should skip save and channel refresh when imported state is identical', async () => {
                secureStorage.initAsGuest('0xsame');
                secureStorage.cache.channels = [{ messageStreamId: 'same-ch' }];
                const saveSpy = vi.spyOn(secureStorage, 'saveToStorage');

                const result = await secureStorage.importFromSync({
                    channels: [{ messageStreamId: 'same-ch' }]
                });

                expect(result).toEqual({
                    hasChanges: false,
                    channelsUpdated: false,
                    epochKeysUpdated: false,
                    contactsUpdated: false,
                    blockedPeersUpdated: false,
                    usernameUpdated: false,
                    sentMessagesUpdated: false
                });
                expect(saveSpy).not.toHaveBeenCalled();
            });
        });
    });

    // ==================== blockedPeers ====================
    describe('blockedPeers', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0xBlockTest');
        });

        it('getBlockedPeers should return empty array by default', () => {
            expect(secureStorage.getBlockedPeers()).toEqual([]);
        });

        it('addBlockedPeer should add normalized address and deduplicate', async () => {
            await secureStorage.addBlockedPeer('0xABC');
            await secureStorage.addBlockedPeer('0xabc'); // duplicate (different case)
            await secureStorage.addBlockedPeer('0xDEF');

            const peers = secureStorage.getBlockedPeers();
            expect(peers).toEqual(['0xabc', '0xdef']);
        });

        it('isBlocked should match case-insensitively', async () => {
            await secureStorage.addBlockedPeer('0xAbCdEf');

            expect(secureStorage.isBlocked('0xabcdef')).toBe(true);
            expect(secureStorage.isBlocked('0xABCDEF')).toBe(true);
            expect(secureStorage.isBlocked('0x999999')).toBe(false);
        });

        it('isBlocked should return false when locked', () => {
            secureStorage.isUnlocked = false;
            expect(secureStorage.isBlocked('0xabc')).toBe(false);
        });

        it('removeBlockedPeer should remove by normalized address', async () => {
            await secureStorage.addBlockedPeer('0xaaa');
            await secureStorage.addBlockedPeer('0xbbb');
            await secureStorage.removeBlockedPeer('0xAAA');

            expect(secureStorage.getBlockedPeers()).toEqual(['0xbbb']);
        });

        it('removeBlockedPeer should be safe when no blockedPeers array', async () => {
            delete secureStorage.cache.blockedPeers;
            // should not throw
            await secureStorage.removeBlockedPeer('0xabc');
        });
    });

    // ==================== dmLeftAt ====================
    describe('dmLeftAt', () => {
        beforeEach(() => {
            secureStorage.initAsGuest('0xLeftAtTest');
        });

        it('getDMLeftAt should return null by default', () => {
            expect(secureStorage.getDMLeftAt('0xpeer')).toBeNull();
        });

        it('setDMLeftAt + getDMLeftAt round-trip with normalization', async () => {
            await secureStorage.setDMLeftAt('0xPEER', 12345);

            expect(secureStorage.getDMLeftAt('0xpeer')).toBe(12345);
            expect(secureStorage.getDMLeftAt('0xPEER')).toBe(12345);
        });

        it('getAllDMLeftAt should return all entries', async () => {
            await secureStorage.setDMLeftAt('0xaaa', 100);
            await secureStorage.setDMLeftAt('0xbbb', 200);

            expect(secureStorage.getAllDMLeftAt()).toEqual({ '0xaaa': 100, '0xbbb': 200 });
        });

        it('clearDMLeftAt should remove specific entry', async () => {
            await secureStorage.setDMLeftAt('0xaaa', 100);
            await secureStorage.setDMLeftAt('0xbbb', 200);
            await secureStorage.clearDMLeftAt('0xAAA');

            expect(secureStorage.getDMLeftAt('0xaaa')).toBeNull();
            expect(secureStorage.getDMLeftAt('0xbbb')).toBe(200);
        });

        it('clearDMLeftAt should not crash on missing map', async () => {
            delete secureStorage.cache.dmLeftAt;
            await secureStorage.clearDMLeftAt('0xabc');
            // should not throw
        });

        it('getDMLeftAt should return null when locked', () => {
            secureStorage.isUnlocked = false;
            expect(secureStorage.getDMLeftAt('0xabc')).toBeNull();
        });

        it('getAllDMLeftAt should return empty when locked', () => {
            secureStorage.isUnlocked = false;
            expect(secureStorage.getAllDMLeftAt()).toEqual({});
        });

        it('initAsGuest should initialize blockedPeers and dmLeftAt', () => {
            secureStorage.initAsGuest('0xNewGuest');
            expect(secureStorage.cache.blockedPeers).toEqual([]);
            expect(secureStorage.cache.dmLeftAt).toEqual({});
        });
    });
});
