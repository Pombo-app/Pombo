/**
 * Tests for identity.js - Identity verification and management
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing
vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getAddress: vi.fn(() => '0xTestUser'),
        signMessage: vi.fn(() => Promise.resolve('0xMockSignature'))
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        isStorageUnlocked: vi.fn(() => true),
        getUsername: vi.fn(() => null),
        setUsername: vi.fn(),
        getTrustedContacts: vi.fn(() => ({})),
        setTrustedContacts: vi.fn(),
        getENSCache: vi.fn(() => ({})),
        setENSCache: vi.fn()
    }
}));

vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
    }
}));

vi.mock('../../src/js/workers/cryptoWorkerPool.js', () => ({
    cryptoWorkerPool: {
        execute: vi.fn()
    }
}));

// Mock ethers globally
const mockEthers = {
    keccak256: vi.fn((data) => '0xMockHash'),
    toUtf8Bytes: vi.fn((str) => new Uint8Array([...str].map(c => c.charCodeAt(0)))),
    Network: {
        from: vi.fn(() => ({ name: 'mainnet', chainId: 1n }))
    },
    JsonRpcProvider: vi.fn().mockImplementation(() => ({
        lookupAddress: vi.fn(() => Promise.resolve(null)),
        resolveName: vi.fn(() => Promise.resolve(null))
    }))
};
globalThis.ethers = mockEthers;

import { identityManager } from '../../src/js/identity.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { authManager } from '../../src/js/auth.js';
import { cryptoWorkerPool } from '../../src/js/workers/cryptoWorkerPool.js';

describe('IdentityManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset internal state
        identityManager.trustedContacts = new Map();
        identityManager.ensCache = new Map();
        identityManager.username = null;
        
        // Reset mocks
        secureStorage.isStorageUnlocked.mockReturnValue(true);
        secureStorage.getTrustedContacts.mockReturnValue({});
        secureStorage.getENSCache.mockReturnValue({});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('validateTimestamp()', () => {
        it('should accept timestamp within tolerance', () => {
            const now = Date.now();
            const result = identityManager.validateTimestamp(now);
            expect(result.valid).toBe(true);
        });
        
        it('should accept timestamp 1 minute old', () => {
            const oneMinuteAgo = Date.now() - 60000;
            const result = identityManager.validateTimestamp(oneMinuteAgo);
            expect(result.valid).toBe(true);
        });
        
        it('should accept timestamp 4 minutes old', () => {
            const fourMinutesAgo = Date.now() - 4 * 60000;
            const result = identityManager.validateTimestamp(fourMinutesAgo);
            expect(result.valid).toBe(true);
        });
        
        it('should reject timestamp too old (> 5 minutes)', () => {
            const tenMinutesAgo = Date.now() - 10 * 60000;
            const result = identityManager.validateTimestamp(tenMinutesAgo);
            expect(result.valid).toBe(false);
            expect(result.error).toContain('old');
        });
        
        it('should reject timestamp in future (> 5 minutes)', () => {
            const tenMinutesFuture = Date.now() + 10 * 60000;
            const result = identityManager.validateTimestamp(tenMinutesFuture);
            expect(result.valid).toBe(false);
            expect(result.error).toContain('future');
        });
        
        it('should include minutes in error message', () => {
            const thirtyMinutesAgo = Date.now() - 30 * 60000;
            const result = identityManager.validateTimestamp(thirtyMinutesAgo);
            expect(result.error).toContain('30 min');
        });
    });

    describe('generateMessageId()', () => {
        it('should generate 32-character hex string', () => {
            const id = identityManager.generateMessageId();
            expect(id).toMatch(/^[0-9a-f]{32}$/);
        });
        
        it('should generate unique IDs', () => {
            const ids = new Set();
            for (let i = 0; i < 100; i++) {
                ids.add(identityManager.generateMessageId());
            }
            expect(ids.size).toBe(100);
        });
    });

    describe('getTrustLevelInfo()', () => {
        it('should return info for invalid signature (-1)', () => {
            const info = identityManager.getTrustLevelInfo(-1);
            expect(info.label).toBe('Invalid Signature');
            expect(info.color).toBe('red');
            expect(info.icon).toContain('svg');
        });
        
        it('should return info for valid signature (0)', () => {
            const info = identityManager.getTrustLevelInfo(0);
            expect(info.label).toBe('Valid Signature');
            expect(info.color).toBe('green');
        });
        
        it('should return info for ENS verified (1)', () => {
            const info = identityManager.getTrustLevelInfo(1);
            expect(info.label).toBe('ENS Verified');
            expect(info.color).toBe('green');
        });
        
        it('should return info for trusted contact (2)', () => {
            const info = identityManager.getTrustLevelInfo(2);
            expect(info.label).toBe('Trusted Contact');
            expect(info.color).toBe('yellow');
        });
        
        it('should return default info for unknown level', () => {
            const info = identityManager.getTrustLevelInfo(99);
            expect(info.label).toBe('Valid Signature');
        });
    });

    describe('Username management', () => {
        describe('getUsername()', () => {
            it('should return null initially', () => {
                expect(identityManager.getUsername()).toBe(null);
            });
            
            it('should return set username', () => {
                identityManager.username = 'Alice';
                expect(identityManager.getUsername()).toBe('Alice');
            });
        });

        describe('setUsername()', () => {
            it('should set username', async () => {
                await identityManager.setUsername('Bob');
                expect(identityManager.username).toBe('Bob');
            });
            
            it('should trim whitespace', async () => {
                await identityManager.setUsername('  Charlie  ');
                expect(identityManager.username).toBe('Charlie');
            });
            
            it('should set null for empty string', async () => {
                await identityManager.setUsername('');
                expect(identityManager.username).toBe(null);
            });
            
            it('should set null for null input', async () => {
                identityManager.username = 'Previous';
                await identityManager.setUsername(null);
                expect(identityManager.username).toBe(null);
            });
            
            it('should call saveUsername', async () => {
                const saveSpy = vi.spyOn(identityManager, 'saveUsername');
                await identityManager.setUsername('Dave');
                expect(saveSpy).toHaveBeenCalled();
            });
            
            it('should truncate username to 18 characters', async () => {
                await identityManager.setUsername('A'.repeat(25));
                expect(identityManager.username).toBe('A'.repeat(18));
            });
            
            it('should keep username at exactly 18 characters', async () => {
                await identityManager.setUsername('A'.repeat(18));
                expect(identityManager.username).toBe('A'.repeat(18));
            });
            
            it('should not truncate username under 18 characters', async () => {
                await identityManager.setUsername('ShortName');
                expect(identityManager.username).toBe('ShortName');
            });
            
            it('should trim then truncate', async () => {
                await identityManager.setUsername('  ' + 'A'.repeat(25) + '  ');
                expect(identityManager.username).toBe('A'.repeat(18));
            });
        });

        describe('loadUsername()', () => {
            it('should load username from storage', () => {
                secureStorage.getUsername.mockReturnValue('StoredUser');
                identityManager.loadUsername();
                expect(identityManager.username).toBe('StoredUser');
            });
            
            it('should handle null from storage', () => {
                secureStorage.getUsername.mockReturnValue(null);
                identityManager.loadUsername();
                expect(identityManager.username).toBe(null);
            });
            
            it('should not load if storage is locked', () => {
                secureStorage.isStorageUnlocked.mockReturnValue(false);
                identityManager.username = 'Previous';
                identityManager.loadUsername();
                expect(identityManager.username).toBe(null);
            });
        });
    });

    describe('Trusted contacts management', () => {
        describe('addTrustedContact()', () => {
            it('should add contact with nickname', async () => {
                await identityManager.addTrustedContact('0xABC', 'Alice', 'Friend');
                
                const contact = identityManager.trustedContacts.get('0xabc');
                expect(contact).toBeDefined();
                expect(contact.nickname).toBe('Alice');
                expect(contact.notes).toBe('Friend');
            });
            
            it('should normalize address to lowercase', async () => {
                await identityManager.addTrustedContact('0xABCDEF', 'Bob');
                
                expect(identityManager.trustedContacts.has('0xabcdef')).toBe(true);
            });
            
            it('should store null nickname when none is provided', async () => {
                await identityManager.addTrustedContact('0x123456789');
                
                const contact = identityManager.trustedContacts.get('0x123456789');
                expect(contact.nickname).toBe(null);
            });
            
            it('should record addedAt timestamp', async () => {
                const before = Date.now();
                await identityManager.addTrustedContact('0xTIME');
                const after = Date.now();
                
                const contact = identityManager.trustedContacts.get('0xtime');
                expect(contact.addedAt).toBeGreaterThanOrEqual(before);
                expect(contact.addedAt).toBeLessThanOrEqual(after);
            });
            
            it('should record addedBy address', async () => {
                await identityManager.addTrustedContact('0xNEW');
                
                const contact = identityManager.trustedContacts.get('0xnew');
                expect(contact.addedBy).toBe('0xTestUser');
            });
            
            it('should save contacts after adding', async () => {
                await identityManager.addTrustedContact('0xSAVE');
                expect(secureStorage.setTrustedContacts).toHaveBeenCalled();
            });
        });

        describe('removeTrustedContact()', () => {
            it('should remove existing contact', async () => {
                await identityManager.addTrustedContact('0xREMOVE', 'ToBeRemoved');
                expect(identityManager.trustedContacts.has('0xremove')).toBe(true);
                
                await identityManager.removeTrustedContact('0xREMOVE');
                expect(identityManager.trustedContacts.has('0xremove')).toBe(false);
            });
            
            it('should handle removing non-existent contact without saving or asking for a push', async () => {
                identityManager.onTrustedContactsChanged = vi.fn();
                vi.clearAllMocks();

                await identityManager.removeTrustedContact('0xNonExistent');

                expect(secureStorage.setTrustedContacts).not.toHaveBeenCalled();
                expect(identityManager.onTrustedContactsChanged).not.toHaveBeenCalled();
            });
            
            it('should save contacts after removing', async () => {
                await identityManager.addTrustedContact('0xSAVE2');
                vi.clearAllMocks();
                
                await identityManager.removeTrustedContact('0xSAVE2');
                expect(secureStorage.setTrustedContacts).toHaveBeenCalled();
            });
        });

        describe('updateTrustedContact()', () => {
            it('should update an existing nickname', async () => {
                await identityManager.addTrustedContact('0xEDIT', 'Before');

                await identityManager.updateTrustedContact('0xEDIT', 'After');

                expect(identityManager.getTrustedContact('0xedit')?.nickname).toBe('After');
            });

            it('should clear nickname when edited to empty', async () => {
                await identityManager.addTrustedContact('0xEDIT2', 'Before');

                await identityManager.updateTrustedContact('0xEDIT2', '   ');

                expect(identityManager.getTrustedContact('0xedit2')?.nickname).toBe(null);
            });

            it('should preserve addedAt and update updatedAt', async () => {
                await identityManager.addTrustedContact('0xEDIT3', 'Before');
                const before = identityManager.getTrustedContact('0xedit3');

                await identityManager.updateTrustedContact('0xEDIT3', 'After');

                const after = identityManager.getTrustedContact('0xedit3');
                expect(after.addedAt).toBe(before.addedAt);
                expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
            });
        });

        describe('getTrustedContact()', () => {
            it('should return contact if exists', async () => {
                await identityManager.addTrustedContact('0xEXISTS', 'Exists');
                
                const contact = identityManager.getTrustedContact('0xEXISTS');
                expect(contact).not.toBeNull();
                expect(contact.nickname).toBe('Exists');
            });
            
            it('should return null for non-existent contact', () => {
                const contact = identityManager.getTrustedContact('0xNOPE');
                expect(contact).toBe(null);
            });
            
            it('should be case-insensitive', async () => {
                await identityManager.addTrustedContact('0xMixedCase', 'Mixed');
                
                expect(identityManager.getTrustedContact('0xMIXEDCASE')).not.toBeNull();
                expect(identityManager.getTrustedContact('0xmixedcase')).not.toBeNull();
            });
        });

        describe('getAllTrustedContacts()', () => {
            it('should return empty array when no contacts', () => {
                const contacts = identityManager.getAllTrustedContacts();
                expect(contacts).toEqual([]);
            });
            
            it('should return all contacts', async () => {
                await identityManager.addTrustedContact('0x1', 'One');
                await identityManager.addTrustedContact('0x2', 'Two');
                await identityManager.addTrustedContact('0x3', 'Three');
                
                const contacts = identityManager.getAllTrustedContacts();
                expect(contacts).toHaveLength(3);
            });
            
            it('should return contact values', async () => {
                await identityManager.addTrustedContact('0xVAL', 'Value');
                
                const contacts = identityManager.getAllTrustedContacts();
                expect(contacts[0].nickname).toBe('Value');
            });
        });
    });

    describe('getTrustLevel()', () => {
        it('should return 2 for trusted contact', async () => {
            await identityManager.addTrustedContact('0xTRUSTED', 'Trusted');
            const level = await identityManager.getTrustLevel('0xTRUSTED');
            expect(level).toBe(2);
        });
        
        it('should return 0 for unknown address', async () => {
            const level = await identityManager.getTrustLevel('0xUNKNOWN');
            expect(level).toBe(0);
        });
        
        it('should be case-insensitive', async () => {
            await identityManager.addTrustedContact('0xCASE', 'Case');
            const level = await identityManager.getTrustLevel('0xcase');
            expect(level).toBe(2);
        });
    });

    describe('loadTrustedContacts()', () => {
        it('should load contacts from storage', () => {
            secureStorage.getTrustedContacts.mockReturnValue({
                '0xaddr1': { address: '0xaddr1', nickname: 'One', addedAt: 1000 },
                '0xaddr2': { address: '0xaddr2', nickname: 'Two', addedAt: 2000 }
            });
            
            identityManager.loadTrustedContacts();
            
            expect(identityManager.trustedContacts.size).toBe(2);
            expect(identityManager.trustedContacts.get('0xaddr1').nickname).toBe('One');
        });
        
        it('should handle empty storage', () => {
            secureStorage.getTrustedContacts.mockReturnValue({});
            identityManager.loadTrustedContacts();
            expect(identityManager.trustedContacts.size).toBe(0);
        });
        
        it('should handle null from storage', () => {
            secureStorage.getTrustedContacts.mockReturnValue(null);
            identityManager.loadTrustedContacts();
            expect(identityManager.trustedContacts.size).toBe(0);
        });
        
        it('should not load if storage is locked', () => {
            secureStorage.isStorageUnlocked.mockReturnValue(false);
            secureStorage.getTrustedContacts.mockReturnValue({ '0x1': {} });
            
            identityManager.loadTrustedContacts();
            expect(identityManager.trustedContacts.size).toBe(0);
        });
    });

    describe('ENS Cache', () => {
        describe('loadENSCache()', () => {
            it('should load cache from storage', () => {
                secureStorage.getENSCache.mockReturnValue({
                    '0xens1': { name: 'test.eth', timestamp: Date.now() }
                });
                
                identityManager.loadENSCache();
                expect(identityManager.ensCache.size).toBe(1);
            });
            
            it('should handle empty storage', () => {
                secureStorage.getENSCache.mockReturnValue({});
                identityManager.loadENSCache();
                expect(identityManager.ensCache.size).toBe(0);
            });
            
            it('should not load if storage is locked', () => {
                secureStorage.isStorageUnlocked.mockReturnValue(false);
                secureStorage.getENSCache.mockReturnValue({ '0x1': {} });
                
                identityManager.loadENSCache();
                expect(identityManager.ensCache.size).toBe(0);
            });
        });

        describe('saveENSCache()', () => {
            it('should save cache to storage', async () => {
                identityManager.ensCache.set('0xtest', { 
                    name: 'test.eth', 
                    timestamp: 123
                });
                
                await identityManager.saveENSCache();
                expect(secureStorage.setENSCache).toHaveBeenCalled();
            });
            
            it('should not save if storage is locked', async () => {
                secureStorage.isStorageUnlocked.mockReturnValue(false);
                identityManager.ensCache.set('0xtest', { name: 'test.eth' });
                
                await identityManager.saveENSCache();
                expect(secureStorage.setENSCache).not.toHaveBeenCalled();
            });
        });
    });

    describe('createMessageHash()', () => {
        it('should call ethers.keccak256', () => {
            identityManager.createMessageHash(
                'msg-id',
                'Hello',
                '0xSender',
                12345,
                'channel-1'
            );
            
            expect(mockEthers.keccak256).toHaveBeenCalled();
        });
        
        it('should normalize sender address to lowercase', () => {
            let capturedData;
            mockEthers.toUtf8Bytes.mockImplementation((str) => {
                capturedData = str;
                return new Uint8Array();
            });
            
            identityManager.createMessageHash(
                'id',
                'text',
                '0xABCDEF',
                1000,
                'ch'
            );
            
            expect(capturedData).toContain('0xabcdef');
        });
    });

    describe('saveTrustedContacts()', () => {
        it('should convert Map to object for storage', async () => {
            await identityManager.addTrustedContact('0xA', 'A');
            await identityManager.addTrustedContact('0xB', 'B');
            
            vi.clearAllMocks();
            await identityManager.saveTrustedContacts();
            
            expect(secureStorage.setTrustedContacts).toHaveBeenCalledWith(
                expect.objectContaining({
                    '0xa': expect.any(Object),
                    '0xb': expect.any(Object)
                })
            );
        });
        
        it('should not save if storage is locked', async () => {
            secureStorage.isStorageUnlocked.mockReturnValue(false);
            await identityManager.saveTrustedContacts();
            expect(secureStorage.setTrustedContacts).not.toHaveBeenCalled();
        });
    });

    describe('saveUsername()', () => {
        it('should save username to storage', async () => {
            identityManager.username = 'NewUser';
            const result = await identityManager.saveUsername();
            expect(secureStorage.setUsername).toHaveBeenCalledWith('NewUser');
            expect(result).toBe(true);
        });
        
        it('should not save if storage is locked', async () => {
            secureStorage.isStorageUnlocked.mockReturnValue(false);
            identityManager.username = 'Locked';
            const result = await identityManager.saveUsername();
            expect(secureStorage.setUsername).not.toHaveBeenCalled();
            expect(result).toBe(false);
        });

        it('should still update in-memory username when setUsername is called while locked', async () => {
            secureStorage.isStorageUnlocked.mockReturnValue(false);

            const result = await identityManager.setUsername('LockedName');

            expect(identityManager.username).toBe('LockedName');
            expect(result).toBe(false);
            expect(secureStorage.setUsername).not.toHaveBeenCalled();
        });
    });

    describe('getDisplayName()', () => {
        it('should return truncated address for unknown', async () => {
            const name = await identityManager.getDisplayName('0x1234567890abcdef1234567890abcdef12345678');
            expect(name).toContain('0x1234');
            expect(name.length).toBeLessThan(15);
        });
        
        it('should return contact nickname if trusted', async () => {
            await identityManager.addTrustedContact('0xKNOWN', 'Alice');
            const name = await identityManager.getDisplayName('0xKNOWN');
            expect(name).toBe('Alice');
        });
    });

    describe('getIdentityInfo()', () => {
        it('should return default info for unknown address', async () => {
            const info = await identityManager.getIdentityInfo('0xUNKNOWN123');
            expect(info.address).toBe('0xUNKNOWN123');
            expect(info.trustLevel).toBe(0);
            expect(info.trustInfo).toBeDefined();
        });
        
        it('should include ENS name if available', async () => {
            identityManager.ensCache.set('0xens', { 
                name: 'test.eth',
                timestamp: Date.now()
            });
            
            const info = await identityManager.getIdentityInfo('0xens');
            expect(info.ensName).toBe('test.eth');
        });
        
        it('should include trusted contact info', async () => {
            await identityManager.addTrustedContact('0xTRUSTED', 'TrustedUser');
            const info = await identityManager.getIdentityInfo('0xTRUSTED');
            
            expect(info.trustLevel).toBe(2);
            expect(info.displayName).toBe('TrustedUser');
        });
        
        it('should use verification result if provided', async () => {
            const verification = { valid: true, signer: '0xSIGNER' };
            const info = await identityManager.getIdentityInfo('0xADDR', verification);
            expect(info).toBeDefined();
        });
    });

    // File (file_announce) manifests carry the piece hashes every downloader
    // verifies against, so the signature has to cover them. keccak256 is mocked to a
    // constant, but toUtf8Bytes receives the canonical JSON — so we assert on exactly
    // what gets signed, which is the property that matters.
    describe('file manifest signing', () => {
        const metadata = {
            fileId: 'f-1',
            fileName: 'clip.mp4',
            fileSize: 1000,
            fileType: 'video/mp4',
            pieceCount: 2,
            pieceHashes: ['h0', 'h1']
        };

        const lastSignedPayload = () => JSON.parse(mockEthers.toUtf8Bytes.mock.calls.at(-1)[0]);

        beforeEach(() => {
            mockEthers.toUtf8Bytes.mockClear();
        });

        it('signs over the piece hashes, count and size', () => {
            identityManager.createFileManifestHash({
                id: 'm1', sender: '0xAbC', timestamp: 123, channelId: 'c1', metadata
            });

            const payload = lastSignedPayload();
            expect(payload.type).toBe('file_announce');
            expect(payload.pieceHashes).toEqual(['h0', 'h1']);
            expect(payload.pieceCount).toBe(2);
            expect(payload.fileSize).toBe(1000);
            expect(payload.fileId).toBe('f-1');
        });

        it('lowercases the sender so verification is case-insensitive', () => {
            identityManager.createFileManifestHash({
                id: 'm1', sender: '0xAbC', timestamp: 123, channelId: 'c1', metadata
            });

            expect(lastSignedPayload().sender).toBe('0xabc');
        });

        it('produces a different signed payload if a piece hash is tampered with', () => {
            identityManager.createFileManifestHash({
                id: 'm1', sender: '0xAbC', timestamp: 123, channelId: 'c1', metadata
            });
            const original = mockEthers.toUtf8Bytes.mock.calls.at(-1)[0];

            identityManager.createFileManifestHash({
                id: 'm1', sender: '0xAbC', timestamp: 123, channelId: 'c1',
                metadata: { ...metadata, pieceHashes: ['h0', 'TAMPERED'] }
            });

            expect(mockEthers.toUtf8Bytes.mock.calls.at(-1)[0]).not.toBe(original);
        });

        it('tolerates missing metadata fields without throwing', () => {
            expect(() => identityManager.createFileManifestHash({
                id: 'm1', sender: '0xAbC', timestamp: 123, channelId: 'c1', metadata: {}
            })).not.toThrow();

            expect(lastSignedPayload().pieceHashes).toEqual([]);
        });

        it('createSignedFileManifest returns a signed file_announce', async () => {
            const manifest = await identityManager.createSignedFileManifest({
                channelId: 'c1',
                metadata
            });

            expect(manifest.type).toBe('file_announce');
            expect(manifest.metadata).toBe(metadata);
            expect(manifest.sender).toBe('0xTestUser');  // local stamp, stripped at egress

            // D6/D7: neither travels on the wire any more.
            expect(manifest.signature).toBeUndefined();
            expect(manifest.channelId).toBeUndefined();
        });

        it('verifies a file_announce against the manifest hash, not the empty-text hash', async () => {
            cryptoWorkerPool.execute.mockResolvedValue({ valid: true, recoveredAddress: '0xTestUser' });

            await identityManager.verifyMessage({
                type: 'file_announce',
                id: 'm1',
                sender: '0xTestUser',
                timestamp: Date.now(),
                channelId: 'c1',
                signature: '0xsig',
                metadata
            }, 'c1');

            // The old path hashed { text: '' } and never touched the file metadata
            const payload = JSON.parse(mockEthers.toUtf8Bytes.mock.calls[0][0]);
            expect(payload.type).toBe('file_announce');
            expect(payload.pieceHashes).toEqual(['h0', 'h1']);
            expect(payload).not.toHaveProperty('text');
        });
    });

    describe('init()', () => {
        it('should load username and contacts on init', async () => {
            secureStorage.getUsername.mockReturnValue('InitUser');
            secureStorage.getTrustedContacts.mockReturnValue({
                '0xinit': { address: '0xinit', nickname: 'Init' }
            });
            
            await identityManager.init();
            
            expect(identityManager.username).toBe('InitUser');
            expect(identityManager.trustedContacts.size).toBe(1);
        });
    });
});
