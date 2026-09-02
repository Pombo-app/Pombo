/**
 * The Graph API Module
 * Provides access to Streamr subgraph data for stream/channel information
 * 
 * Subgraph: https://thegraph.com/explorer/subgraphs/EGWFdhhiWypDuz22Uy7b3F69E9MEkyfU9iAQMttkH5Rj
 * 
 * Features:
 * - Get stream permissions (detect public vs members-only)
 * - Get stream members
 * - Check user access to stream
 * - Get stream metadata
 */

import { secureStorage } from './secureStorage.js';
import { Logger } from './logger.js';
import { CONFIG } from './config.js';
import { NetworkError, Ok, Err } from './utils/errors.js';

// Default API key (fallback if user doesn't provide their own)
const DEFAULT_API_KEY = 'f56ddaf00b5cbe1eeb1bc003072b5422';

// Subgraph ID on Arbitrum One
const SUBGRAPH_ID = 'EGWFdhhiWypDuz22Uy7b3F69E9MEkyfU9iAQMttkH5Rj';

class GraphAPI {
    constructor() {
        this.cache = new Map();
        this.CACHE_DURATION = CONFIG.graph.cacheDurationMs;

        // Whether the last real query worked, for Settings to report without
        // making a call of its own. Null until the app has asked for anything.
        this.lastQueryOk = null;
    }

    /**
     * Get the API key (user's or default)
     * @returns {string} - The Graph API key
     */
    getApiKey() {
        if (secureStorage.isStorageUnlocked()) {
            const userKey = secureStorage.getGraphApiKey();
            if (userKey && userKey.trim()) {
                return userKey.trim();
            }
        }
        return DEFAULT_API_KEY;
    }

    /**
     * Set user's API key
     * @param {string} apiKey - The Graph API key
     */
    async setApiKey(apiKey) {
        if (secureStorage.isStorageUnlocked()) {
            await secureStorage.setGraphApiKey(apiKey);
            Logger.info('Graph API key updated');
        }
    }

    /**
     * Check if using default API key
     * @returns {boolean}
     */
    isUsingDefaultKey() {
        return this.getApiKey() === DEFAULT_API_KEY;
    }

    /**
     * Get the subgraph endpoint URL
     * @returns {string}
     */
    getEndpoint() {
        return `https://gateway.thegraph.com/api/${this.getApiKey()}/subgraphs/id/${SUBGRAPH_ID}`;
    }

    /**
     * Execute a GraphQL query
     * @param {string} query - GraphQL query string
     * @param {Object} variables - Query variables (optional)
     * @returns {Promise<Object>} - Query result
     */
    async query(query, variables = {}) {
        try {
            const response = await fetch(this.getEndpoint(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query, variables })
            });

            if (!response.ok) {
                throw new Error(`Graph API error: ${response.status} ${response.statusText}`);
            }

            const result = await response.json();

            if (result.errors) {
                Logger.error('GraphQL errors:', result.errors);
                throw new Error(result.errors[0]?.message || 'GraphQL query failed');
            }

            this.lastQueryOk = true;
            return result.data;
        } catch (error) {
            this.lastQueryOk = false;
            Logger.error('Graph API query failed:', error);
            throw error;
        }
    }

    /**
     * Get cached data or fetch fresh
     * @param {string} cacheKey - Cache key
     * @param {Function} fetchFn - Function to fetch data
     * @returns {Promise<any>}
     */
    async getCached(cacheKey, fetchFn) {
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
            return cached.data;
        }

        const data = await fetchFn();
        this.cache.set(cacheKey, { data, timestamp: Date.now() });
        return data;
    }

    /**
     * Clear cache
     */
    clearCache() {
        this.cache.clear();
    }

    // ==================== STREAM QUERIES ====================

    /**
     * Get stream information including permissions
     * @param {string} streamId - Stream ID
     * @returns {Promise<Object|null>} - Stream data or null if not found
     */
    async getStream(streamId) {
        const cacheKey = `stream:${streamId}`;
        
        return this.getCached(cacheKey, async () => {
            const query = `
                query GetStream($id: ID!) {
                    stream(id: $id) {
                        id
                        metadata
                        createdAt
                        updatedAt
                    }
                }
            `;

            const data = await this.query(query, { id: streamId.toLowerCase() });
            return data?.stream || null;
        });
    }

    /**
     * Get stream permissions using streamPermissions entity
     * @param {string} streamId - Stream ID
     * @returns {Promise<Array>} - Array of permission objects
     */
    async getStreamPermissions(streamId) {
        const cacheKey = `permissions:${streamId}`;
        
        return this.getCached(cacheKey, async () => {
            // Use streamId as-is (case-sensitive in subgraph)
            const query = `
                query GetStreamPermissions {
                    streamPermissions(
                        first: 100, 
                        where: { stream: "${streamId}" },
                        subgraphError: allow
                    ) {
                        id
                        userAddress
                        userId
                        canEdit
                        canDelete
                        canGrant
                        publishExpiration
                        subscribeExpiration
                    }
                }
            `;

            Logger.debug('Querying streamPermissions for:', streamId);
            Logger.debug('Query:', query);
            const data = await this.query(query);
            Logger.debug('Permissions response:', data);
            return data?.streamPermissions || [];
        });
    }

    /**
     * Detect stream/channel type from metadata (primary) or permissions (fallback)
     * @param {string} streamId - Stream ID
     * @returns {Promise<string>} - 'public' | 'password' | 'gated' | 'unknown'
     */
    async detectStreamType(streamId) {
        try {
            Logger.debug('Detecting stream type for:', streamId);
            
            // First, try to get type from metadata (most reliable)
            try {
                const stream = await this.getStream(streamId);
                if (stream?.metadata) {
                    const outerMetadata = JSON.parse(stream.metadata || '{}');
                    const pomboMetadata = JSON.parse(outerMetadata.description || '{}');
                    
                    if (pomboMetadata.app === 'pombo' && pomboMetadata.type) {
                        Logger.debug('Type from metadata:', pomboMetadata.type);
                        return pomboMetadata.type;
                    }
                }
            } catch (metaError) {
                Logger.debug('Could not get type from metadata:', metaError.message);
            }
            
            // Fallback: check permissions (can only detect public vs not)
            const permissions = await this.getStreamPermissions(streamId);
            Logger.debug('Permissions for type detection:', permissions);

            if (permissions.length === 0) {
                Logger.debug('No permissions found, returning unknown');
                return 'unknown';
            }

            // Check for public permissions (userAddress is null or 0x0...)
            const hasPublicPermission = permissions.some(p => {
                const addr = p.userAddress;
                const isPublic = addr === null ||
                    addr === '0x0000000000000000000000000000000000000000';
                return isPublic;
            });

            // If public permissions, could be 'public' or 'password' - default to 'public'
            // (metadata check above would have caught 'password' if available).
            // A members-only stream without Pombo metadata is not a channel
            // this client can classify — gated channels are recognised by
            // their gate metadata before type detection matters.
            const result = hasPublicPermission ? 'public' : 'unknown';
            Logger.debug('Detected type from permissions:', result);
            return result;
        } catch (error) {
            Logger.warn('Failed to detect stream type:', error);
            return 'unknown';
        }
    }

    /**
     * Get list of members (addresses with permissions) for a stream
     * @param {string} streamId - Stream ID
     * @returns {Promise<Result<Array>>} - Result with array of members, or error
     */
    async getStreamMembers(streamId) {
        try {
            const permissions = await this.getStreamPermissions(streamId);
            Logger.debug('Permissions for members:', permissions);
            
            const now = Math.floor(Date.now() / 1000);

            // Filter out public permissions and map to member format
            const members = permissions
                .filter(p => p.userAddress && p.userAddress !== '0x0000000000000000000000000000000000000000')
                .map(p => {
                    // Check expiration times (null/absent = unlimited)
                    const canPublish = p.publishExpiration == null ||
                        parseInt(p.publishExpiration) > now;
                    const canSubscribe = p.subscribeExpiration == null ||
                        parseInt(p.subscribeExpiration) > now;

                    return {
                        address: p.userAddress,
                        canPublish,
                        canSubscribe,
                        canGrant: p.canGrant || false,
                        canEdit: p.canEdit || false,
                        canDelete: p.canDelete || false,
                        // isOwner = has all admin permissions
                        isOwner: p.canGrant && p.canEdit && p.canDelete
                    };
                })
                // Revoking zeroes the on-chain entry but The Graph keeps it in
                // the index (SDK has the same workaround with a cleanup TODO).
                // An address with no effective permission is not a member.
                .filter(m => m.canPublish || m.canSubscribe || m.canGrant || m.canEdit || m.canDelete);
            return Ok(members);
        } catch (error) {
            Logger.warn('Failed to get stream members:', error);
            return Err(new NetworkError(
                'Failed to get stream members',
                'GRAPH_MEMBERS_FAILED',
                { cause: error }
            ));
        }
    }

    /**
     * Get stream owner address
     * @param {string} streamId - Stream ID
     * @returns {Promise<string|null>} - Owner address or null
     */
    async getStreamOwner(streamId) {
        try {
            const result = await this.getStreamMembers(streamId);
            const members = result.ok ? result.data : [];
            const owner = members.find(m => m.isOwner);
            return owner?.address || null;
        } catch (error) {
            Logger.warn('Failed to get stream owner:', error);
            return null;
        }
    }

    /**
     * Search for streams by various criteria
     * @param {Object} options - Search options
     * @param {string} options.owner - Filter by owner address
     * @param {number} options.first - Number of results (default: 20)
     * @param {number} options.skip - Offset for pagination (default: 0)
     * @returns {Promise<Array>} - Array of stream objects
     */
    async searchStreams(options = {}) {
        const { owner, first = 20, skip = 0 } = options;

        let whereClause = '';
        if (owner) {
            whereClause = `, where: { permissions_: { userAddress: "${owner.toLowerCase()}", canEdit: true } }`;
        }

        const query = `
            query SearchStreams {
                streams(first: ${first}, skip: ${skip}${whereClause}, orderBy: createdAt, orderDirection: desc) {
                    id
                    metadata
                    createdAt
                    updatedAt
                }
            }
        `;

        try {
            const data = await this.query(query);
            return Ok(data?.streams || []);
        } catch (error) {
            Logger.warn('Failed to search streams:', error);
            return Err(new NetworkError(
                'Failed to search streams',
                'GRAPH_SEARCH_FAILED',
                { cause: error }
            ));
        }
    }

    /**
     * Get channel info by streamId from The Graph
     * @param {string} streamId - The stream ID to look up
     * @returns {Promise<Object|null>} - Channel info or null if not found
     */
    async getChannelInfo(streamId) {
        const cacheKey = `channel_info:${streamId}`;

        return this.getCached(cacheKey, async () => {
            const query = `
                query GetChannelInfo {
                    stream(id: "${streamId}") {
                        id
                        metadata
                        createdAt
                        updatedAt
                    }
                }
            `;

            try {
                Logger.debug('Querying channel info from The Graph:', streamId);
                const data = await this.query(query);
                const stream = data?.stream;

                if (!stream) {
                    Logger.debug('Channel not found in The Graph:', streamId);
                    return null;
                }

                // Parse metadata (abbreviated keys: a=app, v=version, n=name, t=type, etc.)
                const outerMetadata = JSON.parse(stream.metadata || '{}');
                const pomboMetadata = JSON.parse(outerMetadata.description || '{}');

                if (pomboMetadata.a !== 'pombo') {
                    Logger.debug('Stream is not a Pombo channel:', streamId);
                    return null;
                }

                return {
                    streamId: stream.id,
                    // Preserve null if creator didn't set a name (hidden channels)
                    name: pomboMetadata.n,
                    // Fallback name for display purposes only
                    displayName: pomboMetadata.n || stream.id.split('/')[1]?.split('_')[0] || 'Unknown',
                    type: pomboMetadata.t || 'public',
                    description: pomboMetadata.d || '',
                    language: pomboMetadata.l || '',
                    category: pomboMetadata.c || '',
                    readOnly: pomboMetadata.r || false,
                    exposure: pomboMetadata.e || 'hidden',
                    createdAt: pomboMetadata.ts || parseInt(stream.createdAt) * 1000,
                    updatedAt: parseInt(stream.updatedAt) * 1000,
                    createdBy: stream.id.split('/')[0],
                    // Gated (N-D): the PomboGate clone — routes the Explore tap
                    gateAddress: /^0x[0-9a-f]{40}$/.test(String(pomboMetadata.g || '').toLowerCase())
                        ? String(pomboMetadata.g).toLowerCase() : null,
                    // Author visibility (`m: 1` = Members only; absent = Everyone)
                    wireIdentity: pomboMetadata.m === 1 ? 'sealed' : 'visible'
                };
            } catch (error) {
                Logger.warn('Failed to get channel info:', error);
                return null;
            }
        }, 60000); // Cache for 1 minute
    }

    /**
     * Get discoverable (exposure: visible) Pombo channels from The Graph,
     * whatever their access control — public, password or gated.
     * @param {Object} options - Query options
     * @param {number} options.first - Number of results (default: 50)
     * @param {number} options.skip - Offset for pagination (default: 0)
     * @returns {Promise<Array>} - Array of public Pombo channels
     */
    async getPublicPomboChannels(options = {}) {
        const { first = 50, skip = 0 } = options;
        const cacheKey = `pombo_public:${first}:${skip}`;

        return this.getCached(cacheKey, async () => {
            // Filter by metadata, NOT by public permissions: gated channels
            // grant every permission to their clone and none to the zero
            // address, so a permission filter can never list them. The exact
            // marker (`\"e\":\"visible\"`) cannot be expressed — graph-node
            // feeds _contains to a LIKE where backslash escapes — so the
            // subgraph narrows with two backslash-free substrings and the
            // loop below applies the exact a/e checks. Hidden channels never
            // carry "visible" anywhere (n/d/l/c are omitted when hidden).
            const query = `
                query GetPublicPomboChannels {
                    streams(
                        first: ${first},
                        skip: ${skip},
                        orderBy: updatedAt,
                        orderDirection: desc,
                        where: { and: [
                            { metadata_contains: "pombo" },
                            { metadata_contains: "visible" }
                        ] },
                        subgraphError: allow
                    ) {
                        id
                        metadata
                        createdAt
                        updatedAt
                    }
                }
            `;

            try {
                Logger.debug('Querying public Pombo channels from The Graph...');
                const data = await this.query(query);
                const streams = data?.streams || [];
                
                // Filter and transform to Pombo channel format
                // Only includes channels with exposure: "visible" and message streams (ending in -1)
                const channels = [];
                for (const stream of streams) {
                    try {
                        // Skip ephemeral streams (they end with -2)
                        if (stream.id.endsWith('-2')) continue;
                        
                        // Parse metadata - Streamr stores { partitions, description }
                        // Our Pombo JSON is inside the description field (abbreviated keys)
                        const outerMetadata = JSON.parse(stream.metadata || '{}');
                        const pomboMetadata = JSON.parse(outerMetadata.description || '{}');
                        
                        // Only include Pombo channels with exposure: "visible" (e='visible')
                        if (pomboMetadata.a === 'pombo' && pomboMetadata.e === 'visible') {
                            channels.push({
                                streamId: stream.id,
                                // Visible channels should always have a name, but preserve structure
                                name: pomboMetadata.n,
                                displayName: pomboMetadata.n || stream.id.split('/')[1]?.split('_')[0] || 'Unknown',
                                type: pomboMetadata.t || 'public',
                                exposure: pomboMetadata.e,
                                readOnly: pomboMetadata.r || false,
                                description: pomboMetadata.d || '',
                                language: pomboMetadata.l || 'en',
                                category: pomboMetadata.c || 'general',
                                createdAt: pomboMetadata.ts || parseInt(stream.createdAt) * 1000,
                                updatedAt: parseInt(stream.updatedAt) * 1000,
                                // Owner is the first part of streamId (address/path format)
                                createdBy: stream.id.split('/')[0],
                                // Gated (N-D): routes the Explore tap by mode
                                gateAddress: /^0x[0-9a-f]{40}$/.test(String(pomboMetadata.g || '').toLowerCase())
                                    ? String(pomboMetadata.g).toLowerCase() : null,
                                // Author visibility (`m: 1` = Members only)
                                wireIdentity: pomboMetadata.m === 1 ? 'sealed' : 'visible'
                            });
                        }
                    } catch (parseError) {
                        // Not a valid Pombo channel, skip
                        continue;
                    }
                }

                Logger.debug(`Found ${channels.length} public Pombo channels`);
                return channels;
            } catch (error) {
                Logger.warn('Failed to get public Pombo channels:', error);
                return [];
            }
        });
    }

    /**
     * Test API connection
     * @returns {Promise<boolean>} - True if connection successful
     */
    async testConnection() {
        try {
            const query = `{ _meta { block { number } } }`;
            const data = await this.query(query);
            Logger.info('Graph API connected, latest block:', data?._meta?.block?.number);
            return true;
        } catch (error) {
            Logger.error('Graph API connection failed:', error);
            return false;
        }
    }
}

// Export singleton instance
export const graphAPI = new GraphAPI();
