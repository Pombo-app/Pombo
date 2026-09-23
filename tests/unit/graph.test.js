/**
 * Graph API Module Tests
 * Tests for The Graph subgraph queries and caching
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing graphAPI
vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        isStorageUnlocked: vi.fn(() => false),
        getGraphApiKey: vi.fn(() => null),
        setGraphApiKey: vi.fn()
    }
}));

vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

// Import after mocks
import { graphAPI } from '../../src/js/graph.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { Logger } from '../../src/js/logger.js';

describe('GraphAPI', () => {
    let originalFetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        graphAPI.clearCache();
        vi.clearAllMocks();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    // ==================== API KEY MANAGEMENT ====================

    describe('getApiKey', () => {
        it('should return default key when storage is locked', () => {
            secureStorage.isStorageUnlocked.mockReturnValue(false);
            
            const apiKey = graphAPI.getApiKey();
            
            expect(apiKey).toBe('f56ddaf00b5cbe1eeb1bc003072b5422');
        });

        it('should return default key when user key is empty', () => {
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            secureStorage.getGraphApiKey.mockReturnValue('');
            
            const apiKey = graphAPI.getApiKey();
            
            expect(apiKey).toBe('f56ddaf00b5cbe1eeb1bc003072b5422');
        });

        it('should return user key when available', () => {
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            secureStorage.getGraphApiKey.mockReturnValue('user-custom-key');
            
            const apiKey = graphAPI.getApiKey();
            
            expect(apiKey).toBe('user-custom-key');
        });

        it('should trim whitespace from user key', () => {
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            secureStorage.getGraphApiKey.mockReturnValue('  my-key  ');
            
            const apiKey = graphAPI.getApiKey();
            
            expect(apiKey).toBe('my-key');
        });
    });

    describe('setApiKey', () => {
        it('should set API key when storage unlocked', async () => {
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            
            await graphAPI.setApiKey('new-api-key');
            
            expect(secureStorage.setGraphApiKey).toHaveBeenCalledWith('new-api-key');
            expect(Logger.info).toHaveBeenCalledWith('Graph API key updated');
        });

        it('should not set API key when storage locked', async () => {
            secureStorage.isStorageUnlocked.mockReturnValue(false);
            
            await graphAPI.setApiKey('new-api-key');
            
            expect(secureStorage.setGraphApiKey).not.toHaveBeenCalled();
        });
    });

    describe('isUsingDefaultKey', () => {
        it('should return true when using default key', () => {
            secureStorage.isStorageUnlocked.mockReturnValue(false);
            
            expect(graphAPI.isUsingDefaultKey()).toBe(true);
        });

        it('should return false when using custom key', () => {
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            secureStorage.getGraphApiKey.mockReturnValue('custom-key');
            
            expect(graphAPI.isUsingDefaultKey()).toBe(false);
        });
    });

    describe('getEndpoint', () => {
        it('should construct correct endpoint URL', () => {
            secureStorage.isStorageUnlocked.mockReturnValue(false);
            
            const endpoint = graphAPI.getEndpoint();
            
            expect(endpoint).toContain('gateway.thegraph.com');
            expect(endpoint).toContain('f56ddaf00b5cbe1eeb1bc003072b5422');
            expect(endpoint).toContain('EGWFdhhiWypDuz22Uy7b3F69E9MEkyfU9iAQMttkH5Rj');
        });

        it('should use custom API key in endpoint', () => {
            secureStorage.isStorageUnlocked.mockReturnValue(true);
            secureStorage.getGraphApiKey.mockReturnValue('my-custom-key');
            
            const endpoint = graphAPI.getEndpoint();
            
            expect(endpoint).toContain('my-custom-key');
        });
    });

    // ==================== QUERY EXECUTION ====================

    describe('query', () => {
        it('should execute GraphQL query successfully', async () => {
            const mockData = { stream: { id: 'test-stream' } };
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: mockData })
            });

            const result = await graphAPI.query('{ stream(id: "test") { id } }');

            expect(result).toEqual(mockData);
            expect(globalThis.fetch).toHaveBeenCalled();
        });

        it('should pass variables to query', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: {} })
            });

            await graphAPI.query('query($id: ID!) { stream(id: $id) { id } }', { id: 'stream-123' });

            const callBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
            expect(callBody.variables).toEqual({ id: 'stream-123' });
        });

        it('should throw on HTTP error', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error'
            });

            await expect(graphAPI.query('{ test }')).rejects.toThrow('Graph API error: 500');
        });

        it('should throw on GraphQL errors', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    errors: [{ message: 'Query failed' }]
                })
            });

            await expect(graphAPI.query('{ invalid }')).rejects.toThrow('Query failed');
        });

        it('should handle GraphQL errors without message', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    errors: [{}]
                })
            });

            await expect(graphAPI.query('{ invalid }')).rejects.toThrow('GraphQL query failed');
        });

        it('should throw on network error', async () => {
            globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

            await expect(graphAPI.query('{ test }')).rejects.toThrow('Network error');
        });

        it('should use correct headers', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: {} })
            });

            await graphAPI.query('{ test }');

            const callOptions = globalThis.fetch.mock.calls[0][1];
            expect(callOptions.method).toBe('POST');
            expect(callOptions.headers['Content-Type']).toBe('application/json');
        });
    });

    // ==================== CACHING ====================

    describe('getCached', () => {
        it('should return cached data if still valid', async () => {
            const fetchFn = vi.fn().mockResolvedValue('fresh-data');
            
            // First call - fetches
            const result1 = await graphAPI.getCached('test-key', fetchFn);
            expect(result1).toBe('fresh-data');
            expect(fetchFn).toHaveBeenCalledTimes(1);
            
            // Second call - uses cache
            const result2 = await graphAPI.getCached('test-key', fetchFn);
            expect(result2).toBe('fresh-data');
            expect(fetchFn).toHaveBeenCalledTimes(1);
        });

        it('should refetch after cache expires', async () => {
            const fetchFn = vi.fn()
                .mockResolvedValueOnce('first-data')
                .mockResolvedValueOnce('second-data');
            
            await graphAPI.getCached('expire-key', fetchFn);
            
            // Manually expire cache
            const cached = graphAPI.cache.get('expire-key');
            cached.timestamp = Date.now() - 60000; // 60s ago (beyond 30s cache)
            
            const result = await graphAPI.getCached('expire-key', fetchFn);
            expect(result).toBe('second-data');
            expect(fetchFn).toHaveBeenCalledTimes(2);
        });

        it('should use different keys for different data', async () => {
            const fetchFn1 = vi.fn().mockResolvedValue('data-1');
            const fetchFn2 = vi.fn().mockResolvedValue('data-2');
            
            const result1 = await graphAPI.getCached('key-1', fetchFn1);
            const result2 = await graphAPI.getCached('key-2', fetchFn2);
            
            expect(result1).toBe('data-1');
            expect(result2).toBe('data-2');
        });
    });

    describe('clearCache', () => {
        it('should clear all cached data', async () => {
            graphAPI.cache.set('key1', { data: 'test', timestamp: Date.now() });
            graphAPI.cache.set('key2', { data: 'test2', timestamp: Date.now() });
            
            graphAPI.clearCache();
            
            expect(graphAPI.cache.size).toBe(0);
        });
    });

    describe('CACHE_DURATION', () => {
        it('should have 30 second cache duration', () => {
            expect(graphAPI.CACHE_DURATION).toBe(30000);
        });
    });

    // ==================== STREAM QUERIES ====================

    describe('getStreamStorage', () => {
        const answer = (stream) => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { stream } })
            });
        };

        it('returns each storage node with its URLs, and the retention', async () => {
            answer({
                metadata: JSON.stringify({ partitions: 3, storageDays: 30 }),
                storageNodes: [
                    { id: '0xAB', metadata: JSON.stringify({ urls: ['https://a.example', 7] }) },
                    { id: '0xcd', metadata: 'not json' }
                ]
            });

            const result = await graphAPI.getStreamStorage('0xOwner/chan-1');

            expect(result).toEqual({
                nodes: [
                    { nodeAddress: '0xab', urls: ['https://a.example'] },
                    { nodeAddress: '0xcd', urls: [] }
                ],
                storageDays: 30
            });
        });

        it('asks again every time instead of answering from the cache', async () => {
            answer({ metadata: '{}', storageNodes: [] });

            await graphAPI.getStreamStorage('0xowner/chan-1');
            await graphAPI.getStreamStorage('0xowner/chan-1');

            expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        });

        it('knows no retention and no nodes for a stream The Graph does not have', async () => {
            answer(null);

            expect(await graphAPI.getStreamStorage('0xowner/gone-1')).toEqual({ nodes: [], storageDays: null });
        });

        it('throws when The Graph does not answer', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Unavailable' });

            await expect(graphAPI.getStreamStorage('0xowner/chan-1')).rejects.toThrow('Graph API error: 503');
        });
    });

    describe('getStream', () => {
        it('should fetch stream by ID', async () => {
            const mockStream = {
                id: '0x123/stream-name',
                metadata: '{}',
                createdAt: '1234567890',
                updatedAt: '1234567899'
            };
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { stream: mockStream } })
            });

            const result = await graphAPI.getStream('0x123/stream-name');

            expect(result).toEqual(mockStream);
        });

        it('should return null for non-existent stream', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { stream: null } })
            });

            const result = await graphAPI.getStream('non-existent');

            expect(result).toBeNull();
        });

        it('should lowercase stream ID in query', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { stream: null } })
            });

            await graphAPI.getStream('0xABC/Stream-Name');

            const callBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
            expect(callBody.variables.id).toBe('0xabc/stream-name');
        });

        it('should cache stream results', async () => {
            const mockStream = { id: 'cached-stream' };
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { stream: mockStream } })
            });

            await graphAPI.getStream('cached-stream');
            await graphAPI.getStream('cached-stream');

            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('getStreamPermissions', () => {
        it('should fetch stream permissions', async () => {
            const mockPermissions = [
                { id: '1', userAddress: '0x123', canEdit: true, canDelete: false }
            ];
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streamPermissions: mockPermissions } })
            });

            const result = await graphAPI.getStreamPermissions('test-stream');

            expect(result).toEqual(mockPermissions);
        });

        it('should return empty array if no permissions', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streamPermissions: null } })
            });

            const result = await graphAPI.getStreamPermissions('test-stream');

            expect(result).toEqual([]);
        });

        it('should cache permissions results', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streamPermissions: [] } })
            });

            await graphAPI.getStreamPermissions('cached-stream');
            await graphAPI.getStreamPermissions('cached-stream');

            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('detectStreamType', () => {
        it('should return type from metadata when available', async () => {
            const metadataInner = JSON.stringify({ app: 'pombo', type: 'password' });
            const metadataOuter = JSON.stringify({ description: metadataInner });
            
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({
                    data: { stream: { id: 'test', metadata: metadataOuter } }
                })
            });

            const result = await graphAPI.detectStreamType('test-stream');

            expect(result).toBe('password');
        });

        it('should detect public type from permissions', async () => {
            // First call for getStream (no pombo metadata)
            // Second call for getStreamPermissions
            let callCount = 0;
            globalThis.fetch = vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    // getStream - no pombo metadata
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ data: { stream: { id: 'test', metadata: '{}' } } })
                    });
                }
                // getStreamPermissions - has public permission
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        data: {
                            streamPermissions: [
                                { userAddress: '0x0000000000000000000000000000000000000000' }
                            ]
                        }
                    })
                });
            });

            graphAPI.clearCache();
            const result = await graphAPI.detectStreamType('test-stream');

            expect(result).toBe('public');
        });

        it('should return unknown when only member permissions exist', async () => {
            let callCount = 0;
            globalThis.fetch = vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ data: { stream: { id: 'test', metadata: '{}' } } })
                    });
                }
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        data: {
                            streamPermissions: [
                                { userAddress: '0x1234567890123456789012345678901234567890' }
                            ]
                        }
                    })
                });
            });

            graphAPI.clearCache();
            const result = await graphAPI.detectStreamType('test-stream');

            expect(result).toBe('unknown');
        });

        it('should return unknown when no permissions found', async () => {
            let callCount = 0;
            globalThis.fetch = vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ data: { stream: { id: 'test', metadata: '{}' } } })
                    });
                }
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ data: { streamPermissions: [] } })
                });
            });

            graphAPI.clearCache();
            const result = await graphAPI.detectStreamType('test-stream');

            expect(result).toBe('unknown');
        });

        it('should return unknown on error', async () => {
            globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

            graphAPI.clearCache();
            const result = await graphAPI.detectStreamType('test-stream');

            expect(result).toBe('unknown');
        });

        it('should detect public from null userAddress', async () => {
            let callCount = 0;
            globalThis.fetch = vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.resolve({
                        ok: true,
                        json: () => Promise.resolve({ data: { stream: { id: 'test', metadata: '{}' } } })
                    });
                }
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        data: {
                            streamPermissions: [{ userAddress: null }]
                        }
                    })
                });
            });

            graphAPI.clearCache();
            const result = await graphAPI.detectStreamType('test-stream');

            expect(result).toBe('public');
        });
    });

    describe('getStreamMembers', () => {
        it('should return members with permissions', async () => {
            const now = Math.floor(Date.now() / 1000);
            const mockPermissions = [
                {
                    userAddress: '0x123',
                    publishExpiration: null,
                    subscribeExpiration: null,
                    canGrant: true,
                    canEdit: true,
                    canDelete: true
                },
                {
                    userAddress: '0x456',
                    publishExpiration: String(now + 3600),
                    subscribeExpiration: String(now + 3600),
                    canGrant: false,
                    canEdit: false,
                    canDelete: false
                }
            ];
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streamPermissions: mockPermissions } })
            });

            const result = await graphAPI.getStreamMembers('test-stream');

            expect(result.ok).toBe(true);
            expect(result.data).toHaveLength(2);
            expect(result.data[0].address).toBe('0x123');
            expect(result.data[0].isOwner).toBe(true);
            expect(result.data[0].canPublish).toBe(true);
            expect(result.data[1].address).toBe('0x456');
            expect(result.data[1].isOwner).toBe(false);
        });

        it('should filter out public address', async () => {
            const mockPermissions = [
                { userAddress: '0x0000000000000000000000000000000000000000' },
                { userAddress: '0x123' }
            ];
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streamPermissions: mockPermissions } })
            });

            const result = await graphAPI.getStreamMembers('test-stream');

            expect(result.ok).toBe(true);
            expect(result.data).toHaveLength(1);
            expect(result.data[0].address).toBe('0x123');
        });

        it('should filter out null userAddress', async () => {
            const mockPermissions = [
                { userAddress: null },
                { userAddress: '0x789' }
            ];
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streamPermissions: mockPermissions } })
            });

            const result = await graphAPI.getStreamMembers('test-stream');

            expect(result.ok).toBe(true);
            expect(result.data).toHaveLength(1);
        });

        it('should handle expired permissions', async () => {
            const now = Math.floor(Date.now() / 1000);
            const mockPermissions = [
                {
                    userAddress: '0x123',
                    publishExpiration: String(now - 3600), // Expired 1h ago
                    subscribeExpiration: String(now + 3600), // Still valid
                    canGrant: false,
                    canEdit: false,
                    canDelete: false
                }
            ];
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streamPermissions: mockPermissions } })
            });

            const result = await graphAPI.getStreamMembers('test-stream');

            expect(result.ok).toBe(true);
            expect(result.data[0].canPublish).toBe(false);
            expect(result.data[0].canSubscribe).toBe(true);
        });

        it('should return Err result on error', async () => {
            globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

            graphAPI.clearCache();
            const result = await graphAPI.getStreamMembers('test-stream');

            expect(result.ok).toBe(false);
            expect(result.error).toBeDefined();
            expect(result.error.code).toBe('GRAPH_MEMBERS_FAILED');
        });
    });

    describe('getStreamOwner', () => {
        it('should return owner address', async () => {
            const mockPermissions = [
                { userAddress: '0x123', canGrant: true, canEdit: true, canDelete: true }
            ];
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streamPermissions: mockPermissions } })
            });

            const owner = await graphAPI.getStreamOwner('test-stream');

            expect(owner).toBe('0x123');
        });

        it('should return null if no owner found', async () => {
            const mockPermissions = [
                { userAddress: '0x123', canGrant: false, canEdit: true, canDelete: false }
            ];
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streamPermissions: mockPermissions } })
            });

            const owner = await graphAPI.getStreamOwner('test-stream');

            expect(owner).toBeNull();
        });

        it('should return null on error', async () => {
            globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

            graphAPI.clearCache();
            const owner = await graphAPI.getStreamOwner('test-stream');

            expect(owner).toBeNull();
        });
    });

    describe('searchStreams', () => {
        it('should search streams with default options', async () => {
            const mockStreams = [
                { id: 'stream1', metadata: '{}' },
                { id: 'stream2', metadata: '{}' }
            ];
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streams: mockStreams } })
            });

            const result = await graphAPI.searchStreams();

            expect(result.ok).toBe(true);
            expect(result.data).toEqual(mockStreams);
        });

        it('should search by owner', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streams: [] } })
            });

            await graphAPI.searchStreams({ owner: '0xABC' });

            const callBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
            expect(callBody.query).toContain('0xabc');
            expect(callBody.query).toContain('canEdit: true');
        });

        it('should apply pagination', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streams: [] } })
            });

            await graphAPI.searchStreams({ first: 10, skip: 20 });

            const callBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
            expect(callBody.query).toContain('first: 10');
            expect(callBody.query).toContain('skip: 20');
        });

        it('should return Err result on error', async () => {
            globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

            const result = await graphAPI.searchStreams();

            expect(result.ok).toBe(false);
            expect(result.error).toBeDefined();
            expect(result.error.code).toBe('GRAPH_SEARCH_FAILED');
        });
    });

    describe('getChannelInfo', () => {
        it('should return channel info for Pombo channel', async () => {
            const pomboMetadata = { a: 'pombo', n: 'Test Channel', t: 'public', d: 'Description' };
            const outerMetadata = { description: JSON.stringify(pomboMetadata) };
            const mockStream = {
                id: '0x123/channel-name',
                metadata: JSON.stringify(outerMetadata),
                createdAt: '1234567890',
                updatedAt: '1234567899'
            };
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { stream: mockStream } })
            });

            const result = await graphAPI.getChannelInfo('0x123/channel-name');

            expect(result.name).toBe('Test Channel');
            expect(result.type).toBe('public');
            expect(result.description).toBe('Description');
            expect(result.createdBy).toBe('0x123');
        });

        it('should return null for non-Pombo stream', async () => {
            const otherMetadata = { description: JSON.stringify({ app: 'other' }) };
            const mockStream = {
                id: '0x123/other-stream',
                metadata: JSON.stringify(otherMetadata)
            };
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { stream: mockStream } })
            });

            const result = await graphAPI.getChannelInfo('0x123/other-stream');

            expect(result).toBeNull();
        });

        it('should return null when stream not found', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { stream: null } })
            });

            const result = await graphAPI.getChannelInfo('non-existent');

            expect(result).toBeNull();
        });

        it('should handle invalid metadata gracefully', async () => {
            const mockStream = {
                id: '0x123/invalid',
                metadata: 'not-json'
            };
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { stream: mockStream } })
            });

            const result = await graphAPI.getChannelInfo('0x123/invalid');

            expect(result).toBeNull();
        });

        it('should cache channel info results', async () => {
            const pomboMetadata = { a: 'pombo', n: 'Cached Channel' };
            const mockStream = {
                id: 'cached-channel',
                metadata: JSON.stringify({ description: JSON.stringify(pomboMetadata) }),
                createdAt: '123',
                updatedAt: '456'
            };
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { stream: mockStream } })
            });

            await graphAPI.getChannelInfo('cached-channel');
            await graphAPI.getChannelInfo('cached-channel');

            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('getPublicPomboChannels', () => {
        it('should return public Pombo channels', async () => {
            const pomboMetadata = { a: 'pombo', e: 'visible', n: 'Public Channel', t: 'public' };
            const mockStreams = [
                {
                    id: '0x123/channel-1',
                    metadata: JSON.stringify({ description: JSON.stringify(pomboMetadata) }),
                    createdAt: '1234567890',
                    updatedAt: '1234567899'
                }
            ];
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streams: mockStreams } })
            });

            const result = await graphAPI.getPublicPomboChannels();

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Public Channel');
            expect(result[0].exposure).toBe('visible');
        });

        it('should skip ephemeral streams (-2)', async () => {
            const pomboMetadata = { a: 'pombo', e: 'visible' };
            const mockStreams = [
                {
                    id: '0x123/channel-2',
                    metadata: JSON.stringify({ description: JSON.stringify(pomboMetadata) })
                }
            ];
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streams: mockStreams } })
            });

            const result = await graphAPI.getPublicPomboChannels();

            expect(result).toHaveLength(0);
        });

        it('should skip non-visible channels', async () => {
            const pomboMetadata = { a: 'pombo', e: 'hidden' };
            const mockStreams = [
                {
                    id: '0x123/channel-1',
                    metadata: JSON.stringify({ description: JSON.stringify(pomboMetadata) }),
                    createdAt: '123',
                    updatedAt: '456'
                }
            ];
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streams: mockStreams } })
            });

            const result = await graphAPI.getPublicPomboChannels();

            expect(result).toHaveLength(0);
        });

        it('should skip non-Pombo streams', async () => {
            const mockStreams = [
                {
                    id: '0x123/other-app-1',
                    metadata: JSON.stringify({ description: JSON.stringify({ a: 'other-app' }) })
                }
            ];
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streams: mockStreams } })
            });

            const result = await graphAPI.getPublicPomboChannels();

            expect(result).toHaveLength(0);
        });

        it('should apply pagination', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streams: [] } })
            });

            await graphAPI.getPublicPomboChannels({ first: 25, skip: 50 });

            const callBody = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
            expect(callBody.query).toContain('first: 25');
            expect(callBody.query).toContain('skip: 50');
        });

        it('should return empty array on error', async () => {
            globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

            graphAPI.clearCache();
            const result = await graphAPI.getPublicPomboChannels();

            expect(result).toEqual([]);
        });

        it('should cache results', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { streams: [] } })
            });

            await graphAPI.getPublicPomboChannels({ first: 50, skip: 0 });
            await graphAPI.getPublicPomboChannels({ first: 50, skip: 0 });

            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('testConnection', () => {
        it('should return true on successful connection', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: { _meta: { block: { number: 12345 } } } })
            });

            const result = await graphAPI.testConnection();

            expect(result).toBe(true);
            expect(Logger.info).toHaveBeenCalled();
        });

        it('should return false on error', async () => {
            globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection failed'));

            const result = await graphAPI.testConnection();

            expect(result).toBe(false);
            expect(Logger.error).toHaveBeenCalled();
        });
    });
});
