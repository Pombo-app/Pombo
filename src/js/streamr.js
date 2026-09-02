/**
 * Streamr Controller
 * Manages Streamr client connection, subscriptions, and publishing
 * 
 * DUAL-STREAM ARCHITECTURE (v0):
 * Each channel uses 2 streams:
 * 
 * Message Stream (suffix -1): WITH STORAGE
 * - Partition 0: Content messages (text, reactions, images, video announcements)
 * - Partition 1: Control overrides (edit, delete)
 * 
 * Ephemeral Stream (suffix -2): NO STORAGE
 * - Partition 0: Control/Metadata (presence, typing)
 * - Partition 1: Media signals (P2P coordination: requests, discovery)
 * - Partition 2: Media data (P2P heavy payloads: file pieces, image data) [Binary]
 * 
 * Admin Stream (suffix -3): WITH STORAGE, OWNER-ONLY WRITES
 * - Partition 0: Moderation (bannedMembers, hiddenMessageIds, pins)
 * - Partition 1: Channel image (reserved)
 * - Partition 2: Password challenge (reserved)
 */

import { Logger } from './logger.js';
import { cryptoManager } from './crypto.js';
import { CONFIG, getRpcEndpoints } from './config.js';
import { executeWithRetry, executeWithRetryAndVerify } from './utils/retry.js';
import { isRpcError, createPermissionResult } from './utils/rpcErrors.js';
import { authManager } from './auth.js';
import {
    recoverPublisherAccount, applyAccount, stripLocalFields, clearPublisherProofCache
} from './publisherProof.js';
import {
    getChannelIdentity, dropChannelIdentity, clearChannelIdentities
} from './channelIdentity.js';
import { recoverEnvelopeSigner } from './envelopeSigner.js';
import {
    MESSAGE_STREAM as MESSAGE_STREAM_CONSTANTS,
    EPHEMERAL_STREAM as EPHEMERAL_STREAM_CONSTANTS,
    ADMIN_STREAM as ADMIN_STREAM_CONSTANTS,
    KEYS_STREAM as KEYS_STREAM_CONSTANTS,
    PASSWORD_CHALLENGE_MAGIC,
    deriveEphemeralId as _deriveEphemeralId,
    deriveMessageId as _deriveMessageId,
    deriveAdminId as _deriveAdminId,
    deriveKeysId as _deriveKeysId,
    isMessageStream as _isMessageStream,
    isEphemeralStream as _isEphemeralStream,
    isAdminStream as _isAdminStream,
    isKeysStream as _isKeysStream
} from './streamConstants.js';

// === STREAM CONFIG (DUAL-STREAM ARCHITECTURE) ===
import { STREAM_CONFIG } from './streamConfig.js';
import { History } from './streamr/History.js';
import { MessagePipeline } from './streamr/MessagePipeline.js';

// === ID DERIVATION FUNCTIONS ===
// Re-exported from streamConstants.js; kept as local names for readability
// and to preserve the historical call-site surface of this module.
const deriveEphemeralId = _deriveEphemeralId;
const deriveMessageId = _deriveMessageId;
const deriveAdminId = _deriveAdminId;
const deriveKeysId = _deriveKeysId;
const isMessageStream = _isMessageStream;
const isEphemeralStream = _isEphemeralStream;
const isAdminStream = _isAdminStream;
const isKeysStream = _isKeysStream;

const isIpLiteralHost = (hostname) => {
    if (!hostname) {
        return false;
    }

    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
        return true;
    }

    return hostname.includes(':');
};

export const isWebSafeStorageNodeUrl = (value) => {
    try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase();

        if (url.protocol !== 'https:') {
            return false;
        }

        if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
            return false;
        }

        if (isIpLiteralHost(hostname)) {
            return false;
        }

        return true;
    } catch {
        return false;
    }
};

class StreamrController {
    constructor() {
        this.client = null;
        this.subscriptions = new Map(); // streamId -> { partition -> subscription }
        this.channels = new Map(); // streamId -> channel config
        this.address = null;
        this.mediaHandlers = new Map(); // ephemeralStreamId -> { handler, password }
        this.history = new History(this);
        this.messages = new MessagePipeline(this);
    }

    async validateCustomStorageNodeAddress(nodeAddress) {
        if (!this.client) {
            throw new Error('Client not initialized');
        }

        if (!/^0x[a-fA-F0-9]{40}$/.test(nodeAddress)) {
            throw new Error('Invalid custom storage node address');
        }

        const metadata = await this.client.getStorageNodeMetadata(nodeAddress);
        const urls = Array.isArray(metadata?.urls) ? metadata.urls.filter((url) => typeof url === 'string' && url.length > 0) : [];

        if (!urls.length) {
            throw new Error('Custom storage node has no published URLs');
        }

        const webSafeUrl = urls.find((url) => isWebSafeStorageNodeUrl(url));
        if (!webSafeUrl) {
            throw new Error('Custom storage node must publish at least one HTTPS hostname URL');
        }

        return {
            metadata,
            urls,
            webSafeUrl
        };
    }

    /**
     * Initialize Streamr client with signer
     * @param {Object} signer - Ethers signer from wallet (must have privateKey)
     */
    async init(signer) {
        try {
            // Get StreamrClient from the global window object (exposed by the
            // self-hosted vendor bundle — see src/streamr-bundle.js)
            if (!window.StreamrClient) {
                throw new Error('StreamrClient not found. Make sure the Streamr SDK is loaded.');
            }

            if (!signer.privateKey) {
                throw new Error('Signer must have a privateKey');
            }

            this.client = new StreamrClient({
                auth: {
                    privateKey: signer.privateKey
                },
                // Telemetry OFF. The SDK enables it by default whenever auth.ethereum is
                // undefined — which is our case, since we pass a raw privateKey. Left on, the
                // client publishes to streamr.eth/metrics/nodes/firehose/{min,hour,day} every
                // 60s, signed with the user's real address, on a public indexed stream. That
                // alone is enough for anyone to build a presence timeline of every Pombo user,
                // and it would defeat every other privacy measure in this file.
                metrics: false,
                // Pombo publishes NOTHING under the SDK's group-key AES any
                // more (DMs/channels/admin all seal at the app layer, NONE on
                // the wire). Only legacy rows and foreign streams remain
                // SDK-encrypted, and each used to cost the default 30s
                // key-request timeout inside a resend. Fail those fast.
                encryption: { keyRequestTimeout: 3000 },
                // Network layer tuning for media transfer
                network: {
                    controlLayer: {
                        maxMessageSize: 1048576,                    // 1MB max message (default is lower)
                        webrtcDatachannelBufferThresholdLow: 65536,  // 64KB low water mark (default 32KB)
                        webrtcDatachannelBufferThresholdHigh: 262144  // 256KB high water mark (default 128KB)
                    }
                },
                // RPC endpoints from centralized config
                contracts: {
                    ethereumNetwork: {
                        chainId: CONFIG.network.chainId,
                        // Disable highGasPriceStrategy to avoid gasstation.polygon.technology errors
                        highGasPriceStrategy: false
                    },
                    rpcs: getRpcEndpoints(),
                    // Use first RPC that responds (faster, less reliable for consensus)
                    rpcQuorum: 1
                }
            });
            
            this.address = await this.client.getAddress();
            Logger.info('Streamr client initialized with address:', this.address);

            // Account identity for publishAs-based ACCOUNT publishes (keys
            // stream). The -4 stream must publish as the account — its grant is
            // per member address — but with encryptionType NONE: client.publish
            // would force the SDK's AES + group-key exchange on a members-only
            // stream (§3.4), reintroducing for the key-distribution protocol the
            // very publisher-online dependency it exists to remove. In-memory
            // only, same exposure as the client's own auth config.
            this._accountIdentity = window.EthereumKeyPairIdentity
                ? window.EthereumKeyPairIdentity.fromPrivateKey(signer.privateKey)
                : null;

            // Note: warmupNetwork() is called separately by app.js with the appropriate streamId
            // based on whether there's a deep link or not

            return true;
        } catch (error) {
            Logger.error('Failed to initialize Streamr client:', error);
            throw error;
        }
    }

    /**
     * Pre-warm the network node for faster first subscription.
     * Subscribes briefly to a stream to force node startup.
     * @param {string} [streamId] - Optional stream ID to warm up with (uses push stream if not provided)
     */
    async warmupNetwork(streamId = null) {
        if (!this.client) return;
        
        try {
            // Use provided streamId or fall back to push stream
            const warmupStreamId = streamId || CONFIG.push.pushStreamId;
            
            // Subscribe and immediately unsubscribe - just to trigger node startup
            const sub = await this.client.subscribe(warmupStreamId, () => {});
            await sub.unsubscribe();
            
            Logger.debug('Network node pre-warmed via', streamId ? 'target stream' : 'push stream');
        } catch (err) {
            // Non-critical - node will start on first subscribe anyway
            Logger.debug('Network warmup skipped:', err.message);
        }
    }

    /**
     * Get the address of the connected account
     * @returns {Promise<string>} - Ethereum address
     */
    async getAddress() {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }
        return this.address;
    }

    /**
     * Sanitize a string for use in Streamr stream path
     * Only allows alphanumeric, hyphen, underscore
     * @param {string} name - Original name
     * @returns {string} - Sanitized name safe for stream path
     */
    sanitizeStreamPath(name) {
        if (!name) return 'channel';
        
        // Replace spaces with hyphens, remove invalid chars
        let sanitized = name
            .replace(/\s+/g, '-')           // spaces -> hyphens
            .replace(/[^a-zA-Z0-9_-]/g, '') // remove all except alphanumeric, _, -
            .replace(/-+/g, '-')            // multiple hyphens -> single
            .replace(/^-|-$/g, '');         // trim hyphens from ends
        
        // Ensure not empty after sanitization
        if (!sanitized) {
            sanitized = 'channel';
        }
        
        // Limit length (Streamr has path limits)
        if (sanitized.length > 50) {
            sanitized = sanitized.substring(0, 50);
        }
        
        return sanitized;
    }

    /**
     * Create a new channel with triple-stream architecture
     * Creates 3 streams: Message stream (with storage), Ephemeral stream (no storage), Admin stream (with storage, owner-only writes)
     * 
     * @param {string} channelName - Name of the channel
     * @param {string} creatorAddress - Creator's Ethereum address
     * @param {string} type - Channel type: 'public', 'password', 'gated'
     * @param {Object} options - Additional options { exposure: 'visible'|'hidden' }
     * @returns {Promise<Object>} - Stream info with messageStreamId, ephemeralStreamId, adminStreamId
     */
    async createStream(channelName, creatorAddress, type = 'public', options = {}) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        // Use the address for the stream namespace
        const ownerAddress = this.address;
        
        // Generate unique base ID (8 char random hex)
        const randomHash = cryptoManager.generateRandomHex(8);
        const baseStreamPath = `${ownerAddress}/${randomHash}`;
        
        // Stream IDs (triple-stream; gated channels add a 4th for epoch keys)
        const messageStreamId = `${baseStreamPath}-1`;
        const ephemeralStreamId = `${baseStreamPath}-2`;
        const adminStreamId = `${baseStreamPath}-3`;
        const keysStreamId = `${baseStreamPath}-4`;

        // Build metadata for The Graph indexing (abbreviated keys per MIGRATION_PLAN)
        // Channels default to hidden unless specified
        // NOTE: declared outside the try block because the recovery path in the
        // catch handler also needs readOnly/ephemeralMetadata (scoping bug fix)
        const exposure = options.exposure || 'hidden';
        const readOnly = options.readOnly || false;
        const metadata = JSON.stringify({
            a: 'pombo',           // app
            v: '1',               // version
            n: exposure === 'hidden' ? null : channelName,  // name
            t: type,              // type: public|password|gated
            e: exposure,          // exposure: visible|hidden
            r: readOnly,          // readOnly
            // Gated channels (N-C): the PomboGate clone address. Joiners and
            // The Graph read the gate from here; everything else about the
            // gate (mode, token, price) is read from the chain.
            g: type === 'gated' ? options.gateAddress : undefined,
            // Author visibility: 1 = Members only (messages publish under the
            // channel's shared key; authorship sealed inside the epoch
            // envelope). Absent = Everyone — which is what every channel
            // created before the flag existed is. IMMUTABLE post-creation:
            // flipping it would break validation of the mixed history.
            m: type === 'gated' && options.authorMode === 'members' ? 1 : undefined,
            // Only include metadata if visible
            d: exposure === 'visible' ? (options.description || '') : undefined,  // description
            l: exposure === 'visible' ? (options.language || 'en') : undefined,   // language
            c: exposure === 'visible' ? (options.category || 'general') : undefined,  // category
            ts: Date.now()        // createdAt
        });

        if (type === 'gated' && !options.gateAddress) {
            throw new Error('createStream: gated channel requires options.gateAddress');
        }

        const ephemeralMetadata = JSON.stringify({
            a: 'pombo',           // app
            v: '1',               // version
            ln: messageStreamId   // linkedTo (parentStream)
        });

        const adminMetadata = JSON.stringify({
            a: 'pombo',           // app
            v: '1',               // version
            ln: messageStreamId,  // linkedTo (parentStream)
            k: 'admin'            // kind
        });

        const keysMetadata = JSON.stringify({
            a: 'pombo',           // app
            v: '1',               // version
            ln: messageStreamId,  // linkedTo (parentStream)
            k: 'keys'             // kind
        });

        try {
            Logger.debug('Creating triple-stream channel:', { messageStreamId, ephemeralStreamId, adminStreamId });
            Logger.debug('   Owner address:', ownerAddress);
            Logger.debug('   Original name:', channelName);
            Logger.debug('   Type:', type);

            // === SERIAL CREATION: Streams must be created one after another ===
            // Note: Parallel creation causes REPLACEMENT_UNDERPRICED error due to nonce conflicts
            
            // Helper function to create stream with retry and verification
            const createStreamWithRetry = async (streamId, streamMetadata, streamDescription, partitionCount, maxRetries = 7) => {
                return executeWithRetryAndVerify(
                    `createStream(${streamDescription})`,
                    async () => {
                        const stream = await this.client.createStream({
                            id: streamId,
                            description: streamMetadata,
                            partitions: partitionCount
                        });
                        Logger.info(`✓ Stream created: ${stream.id}`);
                        return stream;
                    },
                    async () => {
                        // Check if stream was actually created despite error
                        const existingStream = await this.client.getStream(streamId);
                        if (existingStream) {
                            Logger.info(`✓ Stream exists (created despite error): ${existingStream.id}`);
                            return existingStream;
                        }
                        return null;
                    },
                    { maxRetries }
                );
            };
            
            // Optional progress callback — invoked once after each successful on-chain step
            // (public/password: 3 createStream + 3 setPermissions = 6 invocations;
            //  gated adds the keys stream: 4 createStream + 4 setPermissions = 8).
            const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

            // Step 1: Create MESSAGE STREAM first (sequential to avoid nonce conflicts)
            Logger.info('Creating message stream...');
            const startTime = Date.now();
            
            const messageStream = await createStreamWithRetry(messageStreamId, metadata, 'message', STREAM_CONFIG.MESSAGE_STREAM.PARTITIONS);  // 11 partitions for channels (content + control + 9 storage-file chunks)
            try { onProgress(); } catch (_) { /* progress callback errors must not break creation */ }
            
            // Step 2: Create EPHEMERAL STREAM (3 partitions: control + media signals + media data)
            Logger.info('Creating ephemeral stream...');
            const ephemeralStream = await createStreamWithRetry(ephemeralStreamId, ephemeralMetadata, 'ephemeral', STREAM_CONFIG.EPHEMERAL_STREAM.PARTITIONS);
            try { onProgress(); } catch (_) { /* see above */ }

            // Step 3: Create ADMIN STREAM (3 partitions reserved by protocol; only P0 used now)
            Logger.info('Creating admin stream...');
            const adminStream = await createStreamWithRetry(adminStreamId, adminMetadata, 'admin', STREAM_CONFIG.ADMIN_STREAM.PARTITIONS);
            try { onProgress(); } catch (_) { /* see above */ }

            // Step 3b: Create KEYS STREAM (gated channels only — epoch-key distribution).
            // Lives outside -3 on purpose: any member must be able to publish
            // KEY_REQUEST/KEY_WRAP here, while -3 stays owner-only publish.
            let keysStream = null;
            if (type === 'gated') {
                Logger.info('Creating keys stream...');
                keysStream = await createStreamWithRetry(keysStreamId, keysMetadata, 'keys', STREAM_CONFIG.KEYS_STREAM.PARTITIONS);
                try { onProgress(); } catch (_) { /* see above */ }
            }

            const createTime = ((Date.now() - startTime) / 1000).toFixed(1);
            Logger.info(`✓ All streams created in ${createTime}s`);

            // Step 4: Set permissions on streams (SEQUENTIAL - blockchain tx nonce conflicts if parallel)
            Logger.info('Setting permissions on streams...');
            const permStartTime = Date.now();
            
            if (type === 'public' || type === 'password') {
                // For read-only channels:
                // - Message stream (-1): public subscribe only (read-only)
                // - Ephemeral stream (-2): public subscribe AND publish (for presence/online members)
                const messageGrantFn = readOnly 
                    ? (stream) => this.grantPublicReadOnlyPermissions(stream)
                    : (stream) => this.grantPublicPermissions(stream);
                
                // Ephemeral stream always gets full public permissions (presence data)
                const ephemeralGrantFn = (stream) => this.grantPublicPermissions(stream);
                
                // Admin stream: public subscribe only; only owner publishes
                const adminGrantFn = (stream) => this.grantPublicReadOnlyPermissions(stream);
                
                // Sequential to avoid nonce conflicts. Progress is reported regardless
                // of success: the user has already paid the time cost for the attempt.
                try {
                    await messageGrantFn(messageStream);
                    Logger.info('✓ Message stream: public permissions set');
                } catch (e) {
                    Logger.error('✗ Message stream permissions failed:', e.message);
                } finally {
                    try { onProgress(); } catch (_) { /* ignore */ }
                }
                
                try {
                    await ephemeralGrantFn(ephemeralStream);
                    Logger.info('✓ Ephemeral stream: public permissions set');
                } catch (e) {
                    Logger.error('✗ Ephemeral stream permissions failed:', e.message);
                } finally {
                    try { onProgress(); } catch (_) { /* ignore */ }
                }

                try {
                    await adminGrantFn(adminStream);
                    Logger.info('✓ Admin stream: public read-only permissions set (owner-only publish)');
                } catch (e) {
                    Logger.error('✗ Admin stream permissions failed:', e.message);
                } finally {
                    try { onProgress(); } catch (_) { /* ignore */ }
                }
                
                const permTime = ((Date.now() - permStartTime) / 1000).toFixed(1);
                Logger.info(`Permissions configured in ${permTime}s`);
                
            } else if (type === 'gated') {
                // ONE grantee for every stream: the gate clone (N-C, Q7). No
                // per-member grants ever — members prove access through the
                // contract (publish/subscribe with erc1271Contract), so
                // membership changes are gate transactions, not stream txs.
                //
                // -3 is the exception: the clone is SUBSCRIBE-only there.
                // Members read moderation through it (erc1271 subscribe), but
                // PUBLISH stays the owner's — the creator keeps their registry
                // permissions — so the transport enforces owner-only admin
                // writes. The owner publishes -3 as the ACCOUNT; their address
                // is the streamId prefix, so this leaks nothing new.
                const gateMembers = [options.gateAddress];
                // Members-only author visibility: -1/-2 additionally grant
                // the SHARED publish key's address — every member publishes
                // under it, so the transport carries no authorship. -4 keeps
                // clone-only (KEY_REQUESTs must name the requester so the
                // gate check works) and -3 stays owner-published.
                //
                // The shared key only ever writes: reading is the clone's job
                // (members subscribe through ERC-1271), so it gets PUBLISH
                // alone. Same grant shape on re-key. And the inverse holds
                // too: with a shared key present nothing publishes through
                // the clone on -1/-2, so the clone is SUBSCRIBE-only there —
                // a publish grant it never uses would only let a modified
                // client self-identify on the wire.
                const contentMembers = options.publishKeyAddress
                    ? [
                        { userId: options.gateAddress, permissions: ['subscribe'] },
                        { userId: options.publishKeyAddress, permissions: ['publish'] }
                    ]
                    : gateMembers;
                for (const [stream, label] of [
                    [messageStream, 'Message'],
                    [ephemeralStream, 'Ephemeral'],
                    [adminStream, 'Admin'],
                    [keysStream, 'Keys']
                ]) {
                    if (!stream) continue;
                    try {
                        // Visible gated channels are storefronts: -3 gains
                        // public SUBSCRIBE so non-members (Explore) can read
                        // the channel image. P0 (ADMIN_STATE) stays an epoch
                        // envelope — the public only ever sees ciphertext.
                        // Hidden channels keep the clone as the sole grantee.
                        const perms = stream === adminStream
                            ? (exposure === 'visible'
                                ? {
                                    public: true, publicPermissions: ['subscribe'],
                                    members: gateMembers, memberPermissions: ['subscribe']
                                }
                                : { public: false, members: gateMembers, memberPermissions: ['subscribe'] })
                            : {
                                public: false,
                                members: (stream === messageStream || stream === ephemeralStream)
                                    ? contentMembers : gateMembers
                            };
                        await this.setStreamPermissions(stream.id, perms);
                        Logger.info(`✓ ${label} stream: gate clone permissions set`);
                    } catch (e) {
                        Logger.error(`✗ ${label} stream permissions failed:`, e.message);
                    } finally {
                        try { onProgress(); } catch (_) { /* ignore */ }
                    }
                }

                const permTime = ((Date.now() - permStartTime) / 1000).toFixed(1);
                Logger.info(`Permissions configured in ${permTime}s`);
            }

            const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
            Logger.info(`✓ Channel creation complete in ${totalTime}s total`);

            return {
                messageStreamId: messageStream.id,
                ephemeralStreamId: ephemeralStream.id,
                adminStreamId: adminStream.id,
                keysStreamId: keysStream ? keysStream.id : null,
                type: type,
                name: channelName
            };
        } catch (error) {
            Logger.warn('Create stream error:', error.message);
            
            // Check if streams were actually created despite error
            // Handle partial creation - message stream might exist even if ephemeral failed
            try {
                let existingMessageStream = null;
                let existingEphemeralStream = null;
                
                try {
                    existingMessageStream = await this.client.getStream(messageStreamId);
                    Logger.debug('Message stream exists');
                } catch (e) {
                    Logger.debug('Message stream does not exist');
                }
                
                try {
                    existingEphemeralStream = await this.client.getStream(ephemeralStreamId);
                    Logger.debug('Ephemeral stream exists');
                } catch (e) {
                    Logger.debug('Ephemeral stream does not exist');
                }
                
                // If at least message stream exists, configure permissions
                if (existingMessageStream) {
                    Logger.info('Configuring permissions on existing stream(s)...');
                    
                    // Use correct permission function based on readOnly flag
                    // Message stream: read-only if readOnly flag set
                    // Ephemeral stream: always full permissions (presence/online members)
                    const messageGrantFn = readOnly 
                        ? (stream) => this.grantPublicReadOnlyPermissions(stream)
                        : (stream) => this.grantPublicPermissions(stream);
                    const ephemeralGrantFn = (stream) => this.grantPublicPermissions(stream);
                    
                    if (type === 'public' || type === 'password') {
                        await messageGrantFn(existingMessageStream).catch(e => Logger.warn('Message perm error:', e.message));
                        if (existingEphemeralStream) {
                            await ephemeralGrantFn(existingEphemeralStream).catch(e => Logger.warn('Ephemeral perm error:', e.message));
                        }
                    }
                    
                    // If both streams exist, return success
                    if (existingEphemeralStream) {
                        Logger.info('Both streams exist with permissions configured');
                        return {
                            messageStreamId: existingMessageStream.id,
                            ephemeralStreamId: existingEphemeralStream.id,
                            type: type,
                            name: channelName
                        };
                    }
                    
                    // Only message stream exists - try to create ephemeral again
                    Logger.info('Attempting to create missing ephemeral stream...');
                    try {
                        const newEphemeralStream = await this.client.createStream({
                            id: ephemeralStreamId,
                            description: ephemeralMetadata,
                            partitions: STREAM_CONFIG.EPHEMERAL_STREAM.PARTITIONS
                        });
                        
                        if (type === 'public' || type === 'password') {
                            await ephemeralGrantFn(newEphemeralStream).catch(e => Logger.warn('Ephemeral perm error:', e.message));
                        }
                        
                        Logger.info('✓ Ephemeral stream created successfully on retry');
                        return {
                            messageStreamId: existingMessageStream.id,
                            ephemeralStreamId: newEphemeralStream.id,
                            type: type,
                            name: channelName
                        };
                    } catch (retryError) {
                        Logger.warn('Failed to create ephemeral stream on retry:', retryError.message);
                        // Return with just the message stream - channel will work in degraded mode
                        Logger.warn('Channel created in degraded mode (no ephemeral stream)');
                        return {
                            messageStreamId: existingMessageStream.id,
                            ephemeralStreamId: null,
                            type: type,
                            name: channelName
                        };
                    }
                }
            } catch (e) {
                Logger.debug('Recovery attempt failed:', e.message);
            }
            
            Logger.error('Failed to create streams:', error);
            throw error;
        }
    }

    /**
     * Set stream permissions using client.setPermissions (single batch transaction)
     * Grants permissions to public and/or specific members
     * @param {string} streamId - Stream ID
     * @param {Object} options - Permission options
     * @param {boolean} options.public - Whether to grant public permissions
     * @param {string[]} options.members - Array of member addresses
     * @param {string[]} options.memberPermissions - Permissions to grant per member
     *   (default: ['subscribe', 'publish']). Use ['subscribe'] for read-only members
     *   (e.g. admin stream `-3` where only owner publishes).
     * @param {string[]} options.publicPermissions - Permissions to grant publicly
     *   (default: ['subscribe', 'publish']).
     * @param {number} retries - Number of retry attempts
     */
    async setStreamPermissions(streamId, options = {}, retries = 7) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        const memberPermissions = options.memberPermissions || ['subscribe', 'publish'];
        const publicPermissions = options.publicPermissions || ['subscribe', 'publish'];
        const assignments = [];

        // Add public permissions if requested
        if (options.public) {
            assignments.push({
                public: true,
                permissions: publicPermissions
            });
        }

        // Add member permissions. An entry may be a bare address (gets
        // memberPermissions) or { userId, permissions } when one grantee needs
        // a narrower set than the rest of the same batch.
        if (options.members && options.members.length > 0) {
            Logger.debug('Granting permissions to', options.members.length, 'members:', memberPermissions);

            for (const member of options.members) {
                const entry = typeof member === 'string' ? { userId: member } : member;
                // Normalize to lowercase (Streamr uses lowercase internally)
                const normalizedMember = entry.userId.toLowerCase();

                Logger.debug('Granting permissions to member:', normalizedMember);

                assignments.push({
                    userId: normalizedMember,
                    permissions: entry.permissions || memberPermissions
                });
            }

            Logger.debug('All member permissions granted');
        }

        if (assignments.length === 0) {
            Logger.debug('No permissions to set (owner-only)');
            return;
        }

        await executeWithRetry('setStreamPermissions', async () => {
            await this.client.setPermissions({
                streamId: streamId,
                assignments: assignments
            });
            Logger.debug('Permissions set successfully (batch)');
        }, { maxRetries: retries });
    }

    /**
     * Grant public SUBSCRIBE and PUBLISH permissions to a stream
     * Uses setPermissions for single transaction
     * @param {Object} stream - Stream object (or streamId string)
     */
    async grantPublicPermissions(stream, retries = 7) {
        // If string passed, get the stream object
        const streamId = typeof stream === 'string' ? stream : stream.id;

        await executeWithRetry('grantPublicPermissions', async () => {
            await this.client.setPermissions({
                streamId: streamId,
                assignments: [{
                    public: true,
                    permissions: ['subscribe', 'publish']
                }]
            });
            Logger.debug('Public permissions granted successfully');
        }, { maxRetries: retries });
    }

    /**
     * Grant public SUBSCRIBE only permissions (read-only channel)
     * @param {Object} stream - Stream object (or streamId string)
     */
    async grantPublicReadOnlyPermissions(stream, retries = 7) {
        const streamId = typeof stream === 'string' ? stream : stream.id;

        await executeWithRetry('grantPublicReadOnlyPermissions', async () => {
            await this.client.setPermissions({
                streamId: streamId,
                assignments: [{
                    public: true,
                    permissions: ['subscribe']
                }]
            });
            Logger.debug('Public read-only permissions granted successfully');
        }, { maxRetries: retries });
    }

    /**
     * Grant many-to-one permissions 
     * Used for DM inboxes: anyone can write, only owner can read
     * @param {Object} stream - Stream object (or streamId string)
     */
    async grantManyToOnePermissions(stream, retries = 7) {
        const streamId = typeof stream === 'string' ? stream : stream.id;

        await executeWithRetry('grantManyToOnePermissions', async () => {
            await this.client.setPermissions({
                streamId: streamId,
                assignments: [{
                    public: true,
                    permissions: ['publish']  // Only PUBLISH, not SUBSCRIBE
                }]
            });
            Logger.debug('Many-to-one permissions granted (public publish, owner-only subscribe)');
        }, { maxRetries: retries });
    }

    /**
     * Get the deterministic DM inbox (message) stream ID for an address
     * @param {string} address - Ethereum address
     * @returns {string} - Stream ID: {address}/Pombo-DM-1
     */
    getDMInboxId(address) {
        return `${address.toLowerCase()}/${CONFIG.dm.streamPrefix}-1`;
    }

    /**
     * Get the deterministic DM ephemeral stream ID for an address
     * @param {string} address - Ethereum address
     * @returns {string} - Stream ID: {address}/Pombo-DM-2
     */
    getDMEphemeralId(address) {
        return `${address.toLowerCase()}/${CONFIG.dm.streamPrefix}-2`;
    }

    /**
     * Fetch the public key stored in a DM inbox stream's metadata.
     * @param {string} address - Ethereum address of the inbox owner
     * @returns {Promise<string|null>} - Compressed public key hex, or null if not found
     */
    async getDMPublicKey(address) {
        const streamId = this.getDMInboxId(address);
        try {
            const stream = await this.client.getStream(streamId);
            if (!stream) {
                Logger.warn('DM: getStream returned null for', streamId);
                return null;
            }
            const desc = await stream.getDescription();
            if (!desc) return null;
            const meta = JSON.parse(desc);
            const pk = meta.pk || null;
            if (!pk) return null;
            // The stream namespace proves ownership on-chain, but this READ
            // travels through a user-chosen RPC with automatic failover to
            // public endpoints — a hostile RPC forging `pk` here would be a
            // full DM MITM. The key must BE the address.
            try {
                if (ethers.computeAddress(pk).toLowerCase() !== String(address).toLowerCase()) {
                    Logger.warn('DM: inbox metadata public key does not match its owner — rejecting', address);
                    return null;
                }
            } catch {
                Logger.warn('DM: malformed public key in inbox metadata — rejecting', address);
                return null;
            }
            return pk;
        } catch (e) {
            Logger.warn('DM: Could not fetch public key for', address, ':', e.message);
            return null;
        }
    }

    /**
     * Create the DM inbox for the current user (dual-stream: message + ephemeral)
     * Idempotent — if streams already exist, returns their IDs without recreating.
     * Permissions: public SUBSCRIBE + PUBLISH (Streamr is a blind pipe; E2E encryption at app layer)
     * @param {string} publicKey - Owner's compressed public key (hex, for ECDH)
     * @param {Object} options - Storage options
     * @param {string} options.storageProvider - 'streamr' or 'custom' (default: 'streamr')
     * @param {string} [options.customStorageAddress] - EVM address of the custom storage node (required if provider is 'custom')
     * @param {number} options.storageDays - Retention days (default: 180)
     * @returns {Promise<{messageStreamId: string, ephemeralStreamId: string}>}
     */
    async createDMInbox(publicKey, options = {}) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        const myAddress = this.address;
        const messageStreamId = this.getDMInboxId(myAddress);
        const ephemeralStreamId = this.getDMEphemeralId(myAddress);

        Logger.info('Creating DM inbox:', { messageStreamId, ephemeralStreamId, options });

        const metadata = JSON.stringify({
            a: CONFIG.app.name,
            v: CONFIG.app.version,
            t: 'dm-inbox',
            pk: publicKey
        });

        const ephemeralMetadata = JSON.stringify({
            a: CONFIG.app.name,
            v: CONFIG.app.version,
            ln: messageStreamId
        });

        // Helper: get existing stream or create new one
        const getOrCreate = async (streamId, desc, partitions) => {
            try {
                const existing = await this.client.getStream(streamId);
                Logger.info(`DM stream already exists: ${streamId}`);
                // Update metadata if public key is missing (upgrade path for pre-E2E inboxes)
                if (publicKey && streamId === messageStreamId) {
                    try {
                        const currentDesc = await existing.getDescription();
                        const meta = currentDesc ? JSON.parse(currentDesc) : {};
                        if (!meta.pk) {
                            meta.pk = publicKey;
                            await existing.setDescription(JSON.stringify(meta));
                            Logger.info('DM: Updated inbox metadata with public key');
                        }
                    } catch (metaErr) {
                        Logger.debug('DM: Could not update stream metadata:', metaErr.message);
                    }
                }
                return existing;
            } catch (e) {
                // Stream doesn't exist — create it
                Logger.info(`Creating DM stream: ${streamId}`);
                return executeWithRetryAndVerify(
                    `createDMStream(${streamId})`,
                    async () => {
                        const stream = await this.client.createStream({
                            id: streamId,
                            description: desc,
                            partitions
                        });
                        return stream;
                    },
                    async () => {
                        const s = await this.client.getStream(streamId);
                        return s || null;
                    },
                    { maxRetries: 7 }
                );
            }
        };

        // Optional progress callback — invoked once after each on-chain step.
        // Worst case (fresh inbox, Streamr storage): 6 steps total
        //   (2× createStream + 2× setPermissions + addToStorageNode + setStorageDayCount).
        // If a stream already exists, that "create" step is essentially free but we
        // still report progress so the UI ring reflects work completed.
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

        // Step 1: Create/get message stream (sequential to avoid nonce conflicts)
        const messageStream = await getOrCreate(
            messageStreamId,
            metadata,
            STREAM_CONFIG.MESSAGE_STREAM.DM_PARTITIONS  // 13 partitions: messages + sync + sync_blobs + notifications + 9 storage-file chunks
        );
        try { onProgress(); } catch (_) { /* progress callback errors must not break flow */ }

        // Step 2: Create/get ephemeral stream
        const ephemeralStream = await getOrCreate(
            ephemeralStreamId,
            ephemeralMetadata,
            STREAM_CONFIG.EPHEMERAL_STREAM.PARTITIONS
        );
        try { onProgress(); } catch (_) { /* see above */ }

        // Step 3: Set many-to-one permissions (public PUBLISH, owner-only SUBSCRIBE)
        // Protects social graph: only inbox owner can see who writes to them
        try {
            await this.grantManyToOnePermissions(messageStream);
            Logger.info('✓ DM message stream: many-to-one permissions set (public publish, owner subscribe)');
        } catch (e) {
            Logger.error('✗ DM message stream permissions failed:', e.message);
        } finally {
            try { onProgress(); } catch (_) { /* ignore */ }
        }

        try {
            await this.grantManyToOnePermissions(ephemeralStream);
            Logger.info('✓ DM ephemeral stream: many-to-one permissions set');
        } catch (e) {
            Logger.error('✗ DM ephemeral stream permissions failed:', e.message);
        } finally {
            try { onProgress(); } catch (_) { /* ignore */ }
        }

        // Step 4: Enable storage on message stream with user-selected options
        try {
            await this.enableStorage(messageStreamId, {
                storageProvider: options.storageProvider,
                customStorageAddress: options.customStorageAddress,
                storageDays: options.storageDays,
                onProgress
            });
            Logger.info('✓ DM inbox storage enabled');
        } catch (e) {
            Logger.warn('DM inbox storage failed (continuing):', e.message);
        }

        Logger.info('✓ DM inbox ready:', messageStreamId);
        return { messageStreamId, ephemeralStreamId };
    }

    /**
     * Diagnose the health of a DM inbox — checks streams, permissions, metadata, storage.
     * Read-only (no gas). Safe to call repeatedly.
     * @param {string} address - Ethereum address of the inbox owner
     * @returns {Promise<Object>} Diagnosis report
     */
    async diagnoseInbox(address) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        const messageStreamId = this.getDMInboxId(address);
        const ephemeralStreamId = this.getDMEphemeralId(address);

        const report = {
            messageStream: { id: messageStreamId, exists: false, partitions: null, partitionsCorrect: false, metadataOk: false, publicKeyPresent: false },
            ephemeralStream: { id: ephemeralStreamId, exists: false, partitions: null },
            permissions: { messagePublicPublish: false, ephemeralPublicPublish: false },
            storage: { enabled: false, provider: null, storageDays: null }
        };

        // Check message stream
        let messageStream = null;
        try {
            messageStream = await this.client.getStream(messageStreamId);
            report.messageStream.exists = true;
            const partitions = await messageStream.getPartitionCount();
            report.messageStream.partitions = typeof partitions === 'bigint' ? Number(partitions) : partitions;
            report.messageStream.partitionsCorrect = report.messageStream.partitions >= STREAM_CONFIG.MESSAGE_STREAM.DM_PARTITIONS;

            // Check metadata
            try {
                const desc = await messageStream.getDescription();
                if (desc) {
                    const meta = JSON.parse(desc);
                    report.messageStream.metadataOk = !!(meta.a && meta.t === 'dm-inbox');
                    report.messageStream.publicKeyPresent = !!meta.pk;
                }
            } catch (e) {
                Logger.debug('Diagnose: Could not parse message stream metadata:', e.message);
            }
        } catch (e) {
            Logger.debug('Diagnose: Message stream not found:', e.message);
        }

        // Check ephemeral stream
        let ephemeralStream = null;
        try {
            ephemeralStream = await this.client.getStream(ephemeralStreamId);
            report.ephemeralStream.exists = true;
            const partitions = await ephemeralStream.getPartitionCount();
            report.ephemeralStream.partitions = typeof partitions === 'bigint' ? Number(partitions) : partitions;
        } catch (e) {
            Logger.debug('Diagnose: Ephemeral stream not found:', e.message);
        }

        // Check permissions (public publish)
        const StreamPermission = window.StreamPermission;
        if (StreamPermission) {
            if (messageStream) {
                try {
                    report.permissions.messagePublicPublish = await messageStream.hasPermission({
                        permission: StreamPermission.PUBLISH,
                        public: true
                    });
                } catch (e) {
                    Logger.debug('Diagnose: Could not check message stream permissions:', e.message);
                }
            }
            if (ephemeralStream) {
                try {
                    report.permissions.ephemeralPublicPublish = await ephemeralStream.hasPermission({
                        permission: StreamPermission.PUBLISH,
                        public: true
                    });
                } catch (e) {
                    Logger.debug('Diagnose: Could not check ephemeral stream permissions:', e.message);
                }
            }
        }

        // Check storage on message stream
        if (report.messageStream.exists) {
            try {
                const storageInfo = await this.getStreamStorageInfo(messageStreamId);
                report.storage.enabled = storageInfo.enabled;
                report.storage.storageDays = storageInfo.storageDays;
                if (storageInfo.enabled && storageInfo.nodes?.length > 0) {
                    const nodeAddr = typeof storageInfo.nodes[0] === 'string'
                        ? storageInfo.nodes[0].toLowerCase()
                        : String(storageInfo.nodes[0]).toLowerCase();
                    const streamrAddr = (STREAM_CONFIG.NODE_ADDRESS || '').toLowerCase();
                    report.storage.provider = (streamrAddr && nodeAddr === streamrAddr) ? 'streamr' : 'custom';
                    report.storage.nodeAddress = nodeAddr;
                }
            } catch (e) {
                Logger.debug('Diagnose: Could not check storage:', e.message);
            }
        }

        Logger.info('DM inbox diagnosis:', report);
        return report;
    }

    /**
     * Repair a DM inbox based on diagnosis — only executes steps that are missing/broken.
     * @param {Object} diagnosis - Result from diagnoseInbox()
     * @param {string} publicKey - Owner's compressed public key (hex)
     * @param {Object} options - Storage options { storageProvider, storageDays }
     * @param {Function} onStep - Progress callback: (stepName, status) where status = 'start'|'ok'|'skip'|'fail'
     * @returns {Promise<Object>} Repair result with per-step status
     */
    async repairInbox(diagnosis, publicKey, options = {}, onStep = () => {}) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        const messageStreamId = diagnosis.messageStream.id;
        const ephemeralStreamId = diagnosis.ephemeralStream.id;

        const result = {
            messageStream: 'skip',
            ephemeralStream: 'skip',
            partitions: 'skip',
            metadata: 'skip',
            messagePermissions: 'skip',
            ephemeralPermissions: 'skip',
            storage: 'skip'
        };

        const metadata = JSON.stringify({
            a: CONFIG.app.name,
            v: CONFIG.app.version,
            t: 'dm-inbox',
            pk: publicKey
        });

        const ephemeralMetadata = JSON.stringify({
            a: CONFIG.app.name,
            v: CONFIG.app.version,
            ln: messageStreamId
        });

        // Step 1: Create message stream if missing
        let messageStream = null;
        if (!diagnosis.messageStream.exists) {
            onStep('messageStream', 'start');
            try {
                messageStream = await executeWithRetryAndVerify(
                    'repairCreateMessageStream',
                    async () => this.client.createStream({
                        id: messageStreamId,
                        description: metadata,
                        partitions: STREAM_CONFIG.MESSAGE_STREAM.DM_PARTITIONS
                    }),
                    async () => {
                        const s = await this.client.getStream(messageStreamId);
                        return s || null;
                    },
                    { maxRetries: 7 }
                );
                result.messageStream = 'ok';
                onStep('messageStream', 'ok');
            } catch (e) {
                result.messageStream = 'fail';
                onStep('messageStream', 'fail');
                Logger.error('Repair: Failed to create message stream:', e.message);
            }
        } else {
            try { messageStream = await this.client.getStream(messageStreamId); } catch (e) { /* noop */ }
            onStep('messageStream', 'skip');
        }

        // Step 1b: Fix partition count if too low (e.g. 3 → 4 for notifications)
        if (messageStream && diagnosis.messageStream.exists && !diagnosis.messageStream.partitionsCorrect) {
            onStep('partitions', 'start');
            try {
                const currentMeta = await messageStream.getMetadata();
                await messageStream.setMetadata({ ...currentMeta, partitions: STREAM_CONFIG.MESSAGE_STREAM.DM_PARTITIONS });
                result.partitions = 'ok';
                onStep('partitions', 'ok');
            } catch (e) {
                result.partitions = 'fail';
                onStep('partitions', 'fail');
                Logger.error('Repair: Failed to update partition count:', e.message);
            }
        } else {
            onStep('partitions', 'skip');
        }

        // Step 2: Create ephemeral stream if missing
        let ephemeralStream = null;
        if (!diagnosis.ephemeralStream.exists) {
            onStep('ephemeralStream', 'start');
            try {
                ephemeralStream = await executeWithRetryAndVerify(
                    'repairCreateEphemeralStream',
                    async () => this.client.createStream({
                        id: ephemeralStreamId,
                        description: ephemeralMetadata,
                        partitions: STREAM_CONFIG.EPHEMERAL_STREAM.PARTITIONS
                    }),
                    async () => {
                        const s = await this.client.getStream(ephemeralStreamId);
                        return s || null;
                    },
                    { maxRetries: 7 }
                );
                result.ephemeralStream = 'ok';
                onStep('ephemeralStream', 'ok');
            } catch (e) {
                result.ephemeralStream = 'fail';
                onStep('ephemeralStream', 'fail');
                Logger.error('Repair: Failed to create ephemeral stream:', e.message);
            }
        } else {
            try { ephemeralStream = await this.client.getStream(ephemeralStreamId); } catch (e) { /* noop */ }
            onStep('ephemeralStream', 'skip');
        }

        // Step 3: Fix metadata (missing public key)
        if (messageStream && publicKey && !diagnosis.messageStream.publicKeyPresent) {
            onStep('metadata', 'start');
            try {
                const desc = await messageStream.getDescription();
                const meta = desc ? JSON.parse(desc) : { a: CONFIG.app.name, v: CONFIG.app.version, t: 'dm-inbox' };
                meta.pk = publicKey;
                await messageStream.setDescription(JSON.stringify(meta));
                result.metadata = 'ok';
                onStep('metadata', 'ok');
            } catch (e) {
                result.metadata = 'fail';
                onStep('metadata', 'fail');
                Logger.error('Repair: Failed to update metadata:', e.message);
            }
        } else {
            onStep('metadata', 'skip');
        }

        // Step 4: Fix permissions on message stream
        if (messageStream && !diagnosis.permissions.messagePublicPublish) {
            onStep('messagePermissions', 'start');
            try {
                await this.grantManyToOnePermissions(messageStream);
                result.messagePermissions = 'ok';
                onStep('messagePermissions', 'ok');
            } catch (e) {
                result.messagePermissions = 'fail';
                onStep('messagePermissions', 'fail');
                Logger.error('Repair: Failed to set message stream permissions:', e.message);
            }
        } else {
            onStep('messagePermissions', 'skip');
        }

        // Step 5: Fix permissions on ephemeral stream
        if (ephemeralStream && !diagnosis.permissions.ephemeralPublicPublish) {
            onStep('ephemeralPermissions', 'start');
            try {
                await this.grantManyToOnePermissions(ephemeralStream);
                result.ephemeralPermissions = 'ok';
                onStep('ephemeralPermissions', 'ok');
            } catch (e) {
                result.ephemeralPermissions = 'fail';
                onStep('ephemeralPermissions', 'fail');
                Logger.error('Repair: Failed to set ephemeral stream permissions:', e.message);
            }
        } else {
            onStep('ephemeralPermissions', 'skip');
        }

        // Step 6: Enable storage if missing
        if (messageStream && !diagnosis.storage.enabled) {
            onStep('storage', 'start');
            try {
                await this.enableStorage(messageStreamId, {
                    storageProvider: options.storageProvider,
                    customStorageAddress: options.customStorageAddress,
                    storageDays: options.storageDays
                });
                result.storage = 'ok';
                onStep('storage', 'ok');
            } catch (e) {
                result.storage = 'fail';
                onStep('storage', 'fail');
                Logger.error('Repair: Failed to enable storage:', e.message);
            }
        } else {
            onStep('storage', 'skip');
        }

        Logger.info('DM inbox repair result:', result);
        return { messageStreamId, ephemeralStreamId, steps: result };
    }

    /**
     * Get list of addresses with permissions on a stream
     * @param {string} streamId - Stream ID
     * @returns {Promise<Array>} - Array of permission objects
     */
    async getStreamPermissions(streamId) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        try {
            const stream = await this.client.getStream(streamId);
            const permissions = [];
            
            // Try different methods depending on SDK version
            if (typeof stream.getPermissions === 'function') {
                const result = stream.getPermissions();
                
                // Check if it's an async iterator
                if (result && typeof result[Symbol.asyncIterator] === 'function') {
                    for await (const permission of result) {
                        permissions.push(permission);
                    }
                } 
                // Check if it's a promise
                else if (result && typeof result.then === 'function') {
                    const perms = await result;
                    if (Array.isArray(perms)) {
                        return perms;
                    }
                }
                // Check if it's already an array
                else if (Array.isArray(result)) {
                    return result;
                }
            }
            
            // Fallback: try hasPermission for known addresses
            if (permissions.length === 0) {
                Logger.debug('getPermissions not available, using fallback');
                // Return empty - will use local cache
                return [];
            }
            
            return permissions;
        } catch (error) {
            Logger.error('Failed to get stream permissions:', error);
            throw error;
        }
    }

    /**
     * Check if current user has DELETE permission on a stream
     * Uses Streamr SDK hasPermission for real-time on-chain check
     * @param {string} streamId - Stream ID
     * @returns {Promise<boolean>}
     */
    /**
     * DELETE permission of the current wallet on a stream.
     * @returns {Promise<boolean|null>} true/false = a real answer; null =
     *   UNKNOWN (no client yet, or the read failed). Callers must never
     *   cache null as "no" — a transient failure cached as false hid the
     *   admin surface for the whole session.
     */
    async hasDeletePermission(streamId) {
        // Namespace owner: nobody else can create streams under that
        // address, so their DELETE is true by construction — no RPC, no
        // race with client startup, nothing to go stale.
        const wallet = authManager.getAddress?.();
        if (wallet && streamId.split('/')[0]?.toLowerCase() === wallet.toLowerCase()) {
            return true;
        }

        if (!this.client) {
            return null;
        }

        try {
            const stream = await this.client.getStream(streamId);
            const StreamPermission = window.StreamPermission;
            const currentAddress = await this.client.getAddress();
            if (!currentAddress) {
                return null;
            }
            if (!StreamPermission) {
                Logger.warn('StreamPermission not available, falling back to streamId check');
                return streamId.split('/')[0]?.toLowerCase() === currentAddress.toLowerCase();
            }

            const hasDelete = await stream.hasPermission({
                permission: StreamPermission.DELETE,
                userId: currentAddress,
                allowPublic: false
            });

            Logger.debug('hasDeletePermission check:', { streamId, currentAddress: currentAddress.slice(0,10), hasDelete });
            return hasDelete;
        } catch (error) {
            Logger.error('Failed to check DELETE permission:', error);
            return null;
        }
    }

    /**
     * Update channel metadata (name and/or description) in the stream's on-chain
     * metadata (admin only). Values live in the Pombo metadata JSON stored in the
     * stream description (keys 'n' = name, 'd' = description).
     * Both fields are written in a SINGLE on-chain transaction.
     * Requires EDIT permission on the stream.
     * @param {string} streamId - Message stream ID
     * @param {Object} updates - { name?: string, description?: string }
     * @returns {Promise<boolean>}
     */
    async updateStreamMetadata(streamId, updates = {}) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        const stream = await this.client.getStream(streamId);
        if (!stream) {
            throw new Error('Stream not found');
        }

        // Parse existing Pombo metadata from the stream description
        let meta = {};
        try {
            const desc = await stream.getDescription();
            meta = desc ? JSON.parse(desc) : {};
        } catch (e) {
            Logger.warn('updateStreamMetadata: could not parse existing metadata:', e.message);
            meta = {};
        }

        if (typeof updates.name === 'string') meta.n = updates.name;
        if (typeof updates.description === 'string') meta.d = updates.description;

        // Single on-chain transaction: updates stream metadata
        await stream.setDescription(JSON.stringify(meta));
        Logger.info('✓ Stream metadata updated on-chain:', { streamId, updates });
        return true;
    }

    /**
     * Get storage information for a stream from the Streamr SDK.
     *
     * `ok` says whether the chain actually answered. Everything else is only
     * meaningful when it did: an unreachable RPC returns the same empty shape
     * a stream with no storage would.
     *
     * @param {string} streamId - Stream ID
     * @returns {Promise<{ok: boolean, enabled: boolean, nodes: string[], storageDays: number|null}>}
     */
    async getStreamStorageInfo(streamId) {
        if (!this.client) {
            return { enabled: false, nodes: [], storageDays: null };
        }

        try {
            const stream = await this.client.getStream(streamId);
            
            // Get storage nodes assigned to this stream
            // getStorageNodes() returns an array-like synchronously
            const storageNodesResult = stream.getStorageNodes();
            
            // Handle different return types (could be array, promise, or async iterable)
            let storageNodes = [];
            if (Array.isArray(storageNodesResult)) {
                storageNodes = storageNodesResult;
            } else if (storageNodesResult && typeof storageNodesResult.then === 'function') {
                // It's a promise
                storageNodes = await storageNodesResult;
            } else if (storageNodesResult && typeof storageNodesResult[Symbol.asyncIterator] === 'function') {
                // It's an async iterable
                for await (const node of storageNodesResult) {
                    storageNodes.push(node);
                }
            } else if (storageNodesResult && typeof storageNodesResult[Symbol.iterator] === 'function') {
                // It's a sync iterable
                storageNodes = [...storageNodesResult];
            }
            
            const enabled = storageNodes.length > 0;
            
            // Get storage day count if storage is enabled
            let storageDays = null;
            if (enabled) {
                try {
                    const result = await stream.getStorageDayCount();
                    if (result !== null && result !== undefined) {
                        storageDays = typeof result === 'bigint' ? Number(result) : result;
                    }
                } catch (e) {
                    // May fail if TTL not set on this storage node
                }
            }
            
            return { ok: true, enabled, nodes: storageNodes, storageDays };
        } catch (error) {
            Logger.error('Failed to get stream storage info:', error);
            // `ok: false` is not "no nodes": callers that would skip a write,
            // or call a node missing, must treat it as nothing known.
            return { ok: false, enabled: false, nodes: [], storageDays: null };
        }
    }

    /**
     * Check if current user has PUBLISH permission on a stream
     * Uses Streamr SDK hasPermission for real-time on-chain check
     * @param {string} streamId - Stream ID
     * @param {boolean} allowPublic - Whether to include public permissions (default: true)
     * @returns {Promise<{hasPermission: boolean|null, rpcError: boolean, errorMessage?: string}>}
     *          hasPermission: true/false/null (null = unknown due to RPC error)
     */
    async hasPublishPermission(streamId, allowPublic = true) {
        if (!this.client) {
            return createPermissionResult(false, false);
        }

        // Gated (N-C): the stream grant belongs to the gate clone; a member's
        // write ability is the CURRENT gate plus the read-only filter — the
        // same condition the contract's isValidSignature applies at ingest,
        // so the composer never promises a publish the network would refuse.
        const gatedChannel = await this._gatedChannelFor(streamId);
        if (gatedChannel) {
            try {
                const { gateManager } = await import('./gate.js');
                const address = authManager.getAddress();
                const [ok, info] = await Promise.all([
                    gateManager.checkAccess(gatedChannel.gate.address, address),
                    gateManager.getGateInfo(gatedChannel.gate.address)
                ]);
                const mayWrite = ok && (!info.readOnly
                    || await gateManager.canModerate(gatedChannel.gate.address, address));
                return createPermissionResult(mayWrite, false);
            } catch (error) {
                return createPermissionResult(null, true, error.message);
            }
        }

        try {
            const stream = await this.client.getStream(streamId);
            const StreamPermission = window.StreamPermission;
            
            if (!StreamPermission) {
                Logger.warn('StreamPermission not available');
                return createPermissionResult(false, false);
            }

            const currentAddress = await this.client.getAddress();
            if (!currentAddress) {
                return createPermissionResult(false, false);
            }

            const hasPublish = await stream.hasPermission({
                permission: StreamPermission.PUBLISH,
                userId: currentAddress,
                allowPublic: allowPublic
            });
            
            Logger.debug('hasPublishPermission check:', { streamId, currentAddress: currentAddress.slice(0,10), hasPublish, allowPublic });
            return createPermissionResult(hasPublish, false);
        } catch (error) {
            // Check if this is an RPC/network error vs actual permission error
            if (isRpcError(error)) {
                Logger.warn('RPC error checking PUBLISH permission:', error.message);
                return createPermissionResult(null, true, error.message);
            }
            Logger.error('Failed to check PUBLISH permission:', error);
            return createPermissionResult(false, false);
        }
    }

    /**
     * Check if current user has SUBSCRIBE permission on a stream
     * Uses Streamr SDK hasPermission for real-time on-chain check
     * @param {string} streamId - Stream ID
     * @param {boolean} allowPublic - Whether to include public permissions (default: true)
     * @returns {Promise<boolean>}
     */
    async hasSubscribePermission(streamId, allowPublic = true) {
        if (!this.client) {
            return false;
        }

        // Gated (N-C): read ability is the current gate, same as publish
        const gatedChannel = await this._gatedChannelFor(streamId);
        if (gatedChannel) {
            try {
                const { gateManager } = await import('./gate.js');
                return await gateManager.checkAccess(
                    gatedChannel.gate.address, authManager.getAddress());
            } catch {
                return false;
            }
        }

        try {
            const stream = await this.client.getStream(streamId);
            const StreamPermission = window.StreamPermission;
            
            if (!StreamPermission) {
                Logger.warn('StreamPermission not available');
                return false;
            }

            const currentAddress = await this.client.getAddress();
            if (!currentAddress) {
                return false;
            }

            const hasSubscribe = await stream.hasPermission({
                permission: StreamPermission.SUBSCRIBE,
                userId: currentAddress,
                allowPublic: allowPublic
            });
            
            Logger.debug('hasSubscribePermission check:', { streamId, currentAddress: currentAddress.slice(0,10), hasSubscribe, allowPublic });
            return hasSubscribe;
        } catch (error) {
            Logger.error('Failed to check SUBSCRIBE permission:', error);
            return false;
        }
    }

    /**
     * Check all permissions for current user on a stream
     * Uses Streamr SDK hasPermission for real-time on-chain checks
     * @param {string} streamId - Stream ID
     * @returns {Promise<Object>} - { canPublish, canSubscribe, canGrant, canEdit, canDelete, isOwner }
     */
    async checkPermissions(streamId) {
        if (!this.client) {
            return { canPublish: false, canSubscribe: false, canGrant: false, canEdit: false, canDelete: false, isOwner: false };
        }

        try {
            const stream = await this.client.getStream(streamId);
            const StreamPermission = window.StreamPermission;
            const currentAddress = await this.client.getAddress();
            
            if (!StreamPermission || !currentAddress) {
                Logger.warn('StreamPermission or address not available');
                return { canPublish: false, canSubscribe: false, canGrant: false, canEdit: false, canDelete: false, isOwner: false };
            }

            // Check all permissions in parallel
            const [canPublish, canSubscribe, canGrant, canEdit, canDelete] = await Promise.all([
                stream.hasPermission({ permission: StreamPermission.PUBLISH, userId: currentAddress, allowPublic: true }),
                stream.hasPermission({ permission: StreamPermission.SUBSCRIBE, userId: currentAddress, allowPublic: true }),
                stream.hasPermission({ permission: StreamPermission.GRANT, userId: currentAddress, allowPublic: false }),
                stream.hasPermission({ permission: StreamPermission.EDIT, userId: currentAddress, allowPublic: false }),
                stream.hasPermission({ permission: StreamPermission.DELETE, userId: currentAddress, allowPublic: false })
            ]);

            // Owner has all admin permissions
            const isOwner = canGrant && canEdit && canDelete;

            Logger.debug('checkPermissions result:', { 
                streamId, 
                currentAddress: currentAddress.slice(0,10), 
                canPublish, canSubscribe, canGrant, canEdit, canDelete, isOwner 
            });

            return { canPublish, canSubscribe, canGrant, canEdit, canDelete, isOwner };
        } catch (error) {
            Logger.error('Failed to check permissions:', error);
            return { canPublish: false, canSubscribe: false, canGrant: false, canEdit: false, canDelete: false, isOwner: false };
        }
    }

    /**
     * Delete a stream (only owner can delete)
     * For dual-stream architecture, deletes message stream (-1), ephemeral stream (-2)
     * and admin stream (-3) so no orphan streams are left on the network.
     * @param {string} streamId - Stream ID (can be either messageStreamId or ephemeralStreamId)
     * @param {number} retries - Number of retry attempts per stream
     * @returns {Promise<void>}
     */
    async deleteStream(streamId, retries = 7) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        // Derive all stream IDs (message + ephemeral + admin + keys)
        let messageStreamId, ephemeralStreamId, adminStreamId, keysStreamId;

        if (isMessageStream(streamId)) {
            messageStreamId = streamId;
        } else if (isEphemeralStream(streamId)) {
            messageStreamId = deriveMessageId(streamId);
        } else {
            throw new Error('Invalid stream ID format - must end with -1 or -2');
        }

        ephemeralStreamId = deriveEphemeralId(messageStreamId);
        adminStreamId = deriveAdminId(messageStreamId);
        keysStreamId = deriveKeysId(messageStreamId);

        // Helper: detect "stream does not exist" — idempotent success case.
        // The stream may have been deleted in a previous attempt or never existed
        // (e.g. legacy channels without -3). Either way, no retry is needed.
        const isStreamGoneError = (err) => {
            const msg = String(err?.reason || err?.message || err || '');
            return /streamDoesNotExist|stream.*does.*not.*exist|stream.*not.*found/i.test(msg);
        };

        // Helper function to delete a single stream with retries
        const deleteWithRetry = async (sid, description) => {
            try {
                await executeWithRetry(`delete(${description})`, async () => {
                    try {
                        await this.client.deleteStream(sid);
                        Logger.info(`✓ ${description} deleted:`, sid);
                    } catch (err) {
                        if (isStreamGoneError(err)) {
                            Logger.info(`✓ ${description} already gone (idempotent):`, sid);
                            return; // treat as success, stop retrying
                        }
                        throw err;
                    }
                }, { maxRetries: retries });
                return { success: true };
            } catch (error) {
                if (isStreamGoneError(error)) {
                    Logger.info(`✓ ${description} already gone (idempotent):`, sid);
                    return { success: true };
                }
                Logger.error(`All delete attempts failed for ${description}:`, sid);
                return { success: false, error };
            }
        };

        try {
            Logger.info('Deleting channel streams...', { messageStreamId, ephemeralStreamId, adminStreamId });

            // Unsubscribe from message + ephemeral first
            await this.unsubscribeFromDualStream(messageStreamId).catch(e =>
                Logger.warn('Unsubscribe warning:', e.message)
            );
            // Unsubscribe from admin stream too (best-effort)
            if (adminStreamId) {
                await this.unsubscribe(adminStreamId).catch(e =>
                    Logger.warn('Admin unsubscribe warning:', e.message)
                );
            }
            // And the keys stream (-4), when the channel has one
            if (keysStreamId) {
                await this.unsubscribe(keysStreamId).catch(e =>
                    Logger.warn('Keys unsubscribe warning:', e.message)
                );
            }

            // Delete sequentially (preserves wallet nonce ordering):
            // message (primary) → ephemeral → admin → keys.
            const msgResult = await deleteWithRetry(messageStreamId, 'message stream');

            if (ephemeralStreamId) {
                await deleteWithRetry(ephemeralStreamId, 'ephemeral stream');
            }

            if (adminStreamId) {
                // Admin stream may not exist on legacy channels created before
                // the -3 feature; failures here are non-critical (logged, not thrown).
                await deleteWithRetry(adminStreamId, 'admin stream');
            }

            if (keysStreamId) {
                // Keys stream exists only on gated channels; the idempotent
                // "already gone" path absorbs every other type.
                await deleteWithRetry(keysStreamId, 'keys stream');
            }

            // Throw if message stream failed (primary stream)
            if (!msgResult.success) {
                throw msgResult.error;
            }

        } catch (error) {
            Logger.error('Failed to delete streams:', error);
            throw error;
        }
    }

    /**
     * Subscribe to a simple single-partition stream (e.g., notifications)
     * For dual-stream channels, use subscribeToDualStream() instead
     * @param {string} streamId - Stream ID
     * @param {Function} handler - Message handler function
     * @param {string} password - Password for encrypted channels (optional)
     */
    async subscribeSimple(streamId, handler, password = null) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        // Use partition 0 for simple streams
        return await this.subscribeToPartition(streamId, 0, handler, password);
    }

    /**
     * Publish message to a specific partition
     * @param {string} streamId - Stream ID
     * @param {number} partition - Partition number
     * @param {Object} data - Data to publish
     * @param {string} password - Password for encrypted channels (optional)
     */
    async publish(streamId, partition, data, password = null) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        try {
            let payload = data;

            // Encrypt if password provided
            if (password) {
                if (data instanceof Uint8Array) {
                    payload = await cryptoManager.encryptBinary(data, password);
                } else {
                    payload = await cryptoManager.encryptJSON(data, password);
                }
            }

            const pubMsg = await this.client.publish({
                streamId: streamId,
                partition: partition
            }, payload);

            Logger.debug(`Published to ${streamId} partition ${partition}`);
            // The SDK message carries the publish timestamp — storage verify
            // reads match stored messages by it.
            return pubMsg;
        } catch (error) {
            Logger.error('Failed to publish:', error);
            throw error;
        }
    }

    /**
     * Stamp the resolved account onto a received payload.
     *
     * THE single place where "who sent this" is decided. Everything downstream —
     * isOwn, message grouping, reaction dedup, edit/delete authorship, bans,
     * presence — must read `data.account` and nothing else.
     *
     * The rule, and it lives here and nowhere else:
     *
     *     account = proof ? ecrecover(proof) : publisherId
     *
     * The fallback is what keeps pre-migration history working: old messages
     * have no proof, and their publisherId is the wallet — so both formats land
     * in the same identifier space and nothing needs migrating. See D10/D10b.
     *
     * A proof that does not recover falls back too, which is deliberate: it
     * lands on the ephemeral address, an identity that owns nothing and matches
     * nobody. Forging a proof therefore buys an attacker a name that no ban, no
     * grouping and no ownership check will ever agree with.
     *
     * The field was deliberately RENAMED from `account` rather than
     * dual-written. A consumer that still reads `account` now gets `undefined`
     * and fails loudly, instead of silently comparing against an ephemeral key
     * once Fase 4 lands.
     *
     * @param {Object} data - Received payload (mutated in place)
     * @param {string} publisherId - On-wire publisher of the message
     * @returns {Object} - The same object, for chaining
     */
    attachAccount(data, publisherId) {
        if (!data || typeof data !== 'object' || !publisherId) return data;
        const account = (data.proof && recoverPublisherAccount(publisherId, data.proof))
            || publisherId;

        // `sender` no longer travels on the wire (D6) — it duplicated the proof
        // in the clear. It stays as a DERIVED alias because ~85 call sites read
        // it, and rewriting them buys nothing: both names resolve to the same
        // account. Unlike the `senderId` → `account` rename (D10), there is no
        // silent-wrongness risk to protect against here, precisely because this
        // is assigned FROM the verified account rather than from the transport.
        //
        // Legacy messages carry their own `sender`; overwriting it is a no-op,
        // since back then publisherId WAS the wallet.
        return applyAccount(data, account);
    }

    /**
     * The gated channel a stream belongs to, or null.
     *
     * Lazy channelManager import (static would be circular). Any failure means
     * "not gated", which is correct: a channel we do not know cannot have a
     * gate we should trust.
     *
     * @param {string} streamId - Any of the channel's streams (-1..-4)
     * @returns {Promise<Object|null>} The channel object when it has a gate
     */
    async _gatedChannelFor(streamId) {
        try {
            const { channelManager } = await import('./channels.js');
            const base = String(streamId).replace(/-[1234]$/, '');
            const channel = channelManager?.channels?.get(base + '-1')
                // Gated previews (Explore browse) live outside the map —
                // without this fallback the preview's subscribes lose the
                // erc1271 option and its ingest loses resolveAuthor.
                ?? (channelManager?.previewChannel?.messageStreamId === base + '-1'
                    ? channelManager.previewChannel : null);
            return channel?.gate?.address ? channel : null;
        } catch {
            return null;
        }
    }

    /**
     * Resolve the AUTHENTICATED author of a received message.
     *
     * Ungated streams: the transport publisherId (attachAccount then applies
     * the proof rule on top). Gated streams: the on-wire publisher is the gate
     * clone for every member, so authorship comes from the ecrecover of the
     * envelope signature — the very signature the SDK already validated
     * against the gate's isValidSignature (N-C; D10c applies).
     *
     * Returns null when the author cannot be established — the caller MUST
     * drop the message. That covers: a gated message whose envelope does not
     * recover, and a message on a gated ADMIN stream (-3) whose signer is not
     * the channel admin (with the clone holding the publish grant, the
     * transport no longer enforces owner-only writes — this check replaces it).
     *
     * `live: true` (subscription handlers only, never resends) additionally
     * drops authors whose CURRENT gate access has lapsed — the transport
     * accepts an expired subscriber's messages until the next rotation
     * (membership is sticky by design, §7.11), so honest clients cut them at
     * ingest. Fail-OPEN: an unreachable chain renders the message rather
     * than hiding legitimate traffic; the fail-closed side stays in the key
     * layer. Storage resends are exempt on purpose — without storedAt (Q11)
     * a resent message's write-time cannot be judged.
     *
     * @param {string} streamId
     * @param {Object} streamMessage - Raw SDK StreamMessage
     * @param {string} publisherId - Transport publisher already read off it
     * @param {Object} [options]
     * @param {boolean} [options.live=false] - Live delivery (not a resend)
     * @returns {Promise<string|null>} Author address, or null to drop
     */
    async resolveAuthor(streamId, streamMessage, publisherId, { live = false } = {}) {
        const channel = await this._gatedChannelFor(streamId);
        if (!channel) return publisherId ?? null;

        // Members-only author visibility (-1/-2 only; -3 stays the owner's
        // account and -4 must name the requester): the transport asserts
        // NOTHING about authorship — it is the shared publish key for
        // everyone. The author comes from the wrapper inside the epoch seal
        // (_openAuthorship, after decrypt); this stage neither confirms nor
        // drops.
        if (channel.authorMode === 'members'
                && !isAdminStream(streamId) && !isKeysStream(streamId)) {
            return publisherId ?? null;
        }

        const gateAddress = channel.gate.address.toLowerCase();
        if ((publisherId || '').toLowerCase() !== gateAddress) {
            // -3 as the ACCOUNT: the owner publishes the admin stream under
            // their own address — the transport already validated the plain
            // EVM signature, and the namespace prefix IS the authority.
            // (Clone-published -3 below stays for pre-switch history.)
            if (isAdminStream(streamId)) {
                const admin = (channel.messageStreamId?.split('/')[0] || '').toLowerCase();
                if ((publisherId || '').toLowerCase() === admin) return admin;
            }
            // Not published through the clone — a foreign publisher on a gated
            // stream has no business here (permissions are clone-only).
            return null;
        }
        const signer = recoverEnvelopeSigner(streamMessage);
        if (!signer) {
            Logger.warn(`resolveAuthor: unrecoverable envelope on gated ${streamId} — dropping`);
            return null;
        }
        if (isAdminStream(streamId)) {
            const admin = (channel.messageStreamId?.split('/')[0] || '').toLowerCase();
            if (signer !== admin) {
                Logger.warn(`resolveAuthor: non-admin ${signer} on gated admin stream — dropping`);
                return null;
            }
        }
        if (live && !isAdminStream(streamId) && !isKeysStream(streamId)) {
            const { gateManager } = await import('./gate.js');
            const access = await gateManager.checkAccessOrNull(channel.gate.address, signer);
            if (access === false) {
                Logger.info(`resolveAuthor: lapsed gate access for ${signer} — dropping live message`);
                return null;
            }
        }
        return signer;
    }

    /**
     * Members-only ingest, the half that runs AFTER the epoch seal opens:
     * verify the authorship wrapper (pseudonym signature per message + bind
     * proof to the account) and hand back the payload with its author. Null
     * means drop — a sealed message without a valid wrapper has no author.
     *
     * `live: true` additionally drops authors whose CURRENT gate access has
     * lapsed — the shared key accepts an expired member's publishes until a
     * re-key, so honest clients cut them here, exactly like the Everyone
     * mode cuts them in resolveAuthor. Fail-OPEN on an unreachable chain,
     * same stance. History is exempt — retention is the proof (G6 applies to
     * both modes).
     *
     * @param {Object} channel - The gated Members-only channel
     * @param {Object} sealed - The decrypted epoch plaintext (the wrapper)
     * @param {Object} [options]
     * @param {boolean} [options.live=false]
     * @returns {Promise<{author: string, payload: Object}|null>}
     */
    async _openAuthorship(channel, sealed, { live = false } = {}) {
        const { authorship } = await import('./authorship.js');
        const opened = authorship.open(channel.messageStreamId, sealed);
        if (!opened) {
            Logger.warn('authorship: unverifiable wrapper on', channel.messageStreamId.slice(-20), '— dropping');
            return null;
        }
        if (live) {
            const { gateManager } = await import('./gate.js');
            const access = await gateManager.checkAccessOrNull(channel.gate.address, opened.author);
            if (access === false) {
                Logger.info(`authorship: lapsed gate access for ${opened.author} — dropping live message`);
                return null;
            }
        }
        return opened;
    }

    /**
     * Publish channel traffic under the channel's ephemeral publisher (D1 + D2).
     *
     * THE single place where "who we appear to be" is decided, mirroring
     * attachAccount on the way in. Every channel publish must come through here,
     * or that stream's `publisherId` silently reverts to the user's wallet and
     * the social-graph leak reopens for that message type alone.
     *
     * The proof goes INSIDE the payload, so in a password channel it is sealed
     * by the channel's AES layer along with everything else — the receive path
     * decrypts before calling attachAccount, so it is read at the right moment
     * in both channel kinds.
     *
     * ⚠️ NOT for the admin stream. Publishing ADMIN_STATE or the password
     * challenge is gated by the owner's on-chain permission, which a throwaway
     * key does not have — those must keep publishing as the account (D3).
     *
     * @param {string} streamId - Channel stream to publish on
     * @param {number} partition
     * @param {Object} data - Payload; the proof is added here, not by callers
     * @param {string|null} password - Channel password, when encrypted
     * @returns {Promise<Object>} The published StreamMessage
     */
    async publishAsChannel(streamId, partition, data, password = null) {
        if (isAdminStream(streamId)) {
            throw new Error(
                `publishAsChannel refuses the admin stream (${streamId}): ` +
                'an ephemeral key holds no on-chain permission. See D3.');
        }

        // Gated and read-only channels keep the PRIMARY identity on the base
        // path (D3): their publish grant is on-chain — the gate clone for
        // gated, owner-only for read-only — and a throwaway key holds none,
        // so an ephemeral publish is rejected network-wide.
        //
        // GATED channels encrypt with the channel's EPOCH KEY (N-A) and go
        // out via publishAs with encryptionType NONE — the SDK's group-key
        // layer is exactly the per-publisher, publisher-must-be-online
        // dependency the epoch protocol replaces. Fail-closed: no epoch key
        // yet means NO publish, never a plaintext or SDK-keyed fallback.
        //
        // READ-ONLY channels stay on this.publish: their -1 is public
        // subscribe, so the SDK sends NONE and content is meant to be public.
        //
        // channelManager owns the registry; import it lazily (a static import
        // would be circular — channels.js imports this module). Any failure
        // falls through to the ephemeral path, which is correct for
        // public/password.
        let channelManager = null;
        try {
            ({ channelManager } = await import('./channels.js'));
        } catch { /* registry unavailable → ephemeral (public/password) */ }

        if (channelManager?.usesAccountPublish?.(streamId)) {
            const base = String(streamId).replace(/-[1234]$/, '');
            const channel = channelManager.channels?.get(base + '-1');
            if (channel?.type === 'gated' || channel?.gate?.address) {
                // Errors here MUST propagate: falling through to the ephemeral
                // path would put an unencrypted payload under a key that holds
                // no grant. Loud failure over silent leak.
                //
                // Epoch encryption plus, inside publishEpochEncrypted, the
                // ERC-1271 transport (the account signs, the gate clone is
                // the on-wire publisher).
                return this.publishEpochEncrypted(channel, streamId, partition, data);
            }
            return this.publish(streamId, partition, data, password);
        }

        const { identity, proof } = getChannelIdentity(streamId);

        const payload = { ...stripLocalFields(data), proof };

        const content = password
            ? await cryptoManager.encryptJSON(payload, password)
            : payload;

        return this.publishAs(identity, streamId, partition, content);
    }

    /**
     * Publish under an identity that is not the client's own.
     *
     * `client.publish()` bakes in two things this needs to override:
     *
     *   1. It derives `publisherId` from the client identity, so every message
     *      carries the user's wallet address in the clear — the social-graph
     *      leak this whole effort exists to close.
     *   2. Its MessageFactory forces `EncryptionType.AES` whenever the stream
     *      is not publicly subscribable, then needs a group key for it. The SDK
     *      indexes those keys by `${publisherId}::${keyId}`, so an ephemeral
     *      publisher would cost a decrypt-error round-trip per new key.
     *
     * Building the StreamMessage by hand sidesteps both. Encryption stays where
     * it already effectively is — the app layer (dmCrypto / cryptoManager).
     *
     * ⚠️ `getNode()` is marked @deprecated/@hidden in the SDK. It is exported and
     * typed, but carries no stability guarantee: pin the SDK version and let
     * the smoke test fail loudly on upgrade.
     *
     * ⚠️ `broadcast()` does NOT join the stream partition — verified in the SDK
     * source. Publishing to a stream we are not subscribed to (a peer's DM
     * inbox) needs the explicit join below, or there are no neighbours to
     * propagate to.
     *
     * @param {Object} identity - Streamr Identity that signs (e.g. EthereumKeyPairIdentity)
     * @param {string} streamId - Target stream ID
     * @param {number} partition - Target partition
     * @param {Object|Uint8Array} data - Payload; encrypt before calling if needed
     * @param {Object} [options]
     * @param {string} [options.publisherId] - Override the on-wire publisher
     *   (used by gated channels to publish as the gate contract). Defaults to
     *   the signing identity's own user ID.
     * @param {number} [options.signatureType] - Defaults to the identity's own.
     *   Gated channels pass `SignatureType.ERC_1271`.
     * @param {string} [options.msgChainId] - Defaults to a fresh random chain.
     * @param {number} [options.timestamp] - Defaults to now.
     * @returns {Promise<Object>} - The published StreamMessage
     */
    async publishAs(identity, streamId, partition, data, options = {}) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }
        const {
            MessageID, MessageSigner, StreamMessageType, ContentType, EncryptionType
        } = window;
        if (!MessageID || !MessageSigner) {
            throw new Error('SDK message primitives not exposed — check streamr-bundle.js');
        }

        const isBinary = data instanceof Uint8Array;
        const content = isBinary ? data : new TextEncoder().encode(JSON.stringify(data));

        const messageId = new MessageID(
            streamId,
            partition,
            options.timestamp ?? Date.now(),
            0,
            options.publisherId ?? await identity.getUserId(),
            options.msgChainId ?? cryptoManager.generateRandomHex(10)
        );

        const message = await new MessageSigner(identity).createSignedMessage({
            messageId,
            content,
            contentType: isBinary ? ContentType.BINARY : ContentType.JSON,
            // Never AES: the app already encrypts what needs encrypting, and the
            // SDK's own layer would drag the group-key exchange back in.
            encryptionType: EncryptionType.NONE,
            messageType: StreamMessageType.MESSAGE
        }, options.signatureType ?? identity.getSignatureType());

        const node = this.client.getNode();
        const streamPartId = messageId.getStreamPartID();

        // Wait for at least one neighbour before broadcasting. Joining only
        // registers interest in the stream part — it does not guarantee anyone
        // is connected yet, so broadcasting straight after can shout into an
        // empty room. This matters most for DMs, where we publish to a peer's
        // inbox we never subscribe to and therefore have no standing topology.
        //
        // Best-effort: on timeout we publish anyway. The smoke test showed a
        // message still reaching the storage node from a cold node, so giving
        // up here would be worse than trying.
        try {
            await node.join(streamPartId, {
                minCount: STREAM_CONFIG.PUBLISH_MIN_NEIGHBORS,
                timeout: STREAM_CONFIG.PUBLISH_NEIGHBOR_TIMEOUT_MS
            });
        } catch (error) {
            Logger.debug(`publishAs: no neighbours on ${streamPartId} yet (${error.message}) — publishing anyway`);
        }

        await node.broadcast(message);

        Logger.debug(`publishAs → ${streamId} p${partition} as ${messageId.publisherId}`);

        // Expose `.timestamp` like client.publish() does. Callers use it to
        // locate what they just published in storage — announce confirmation
        // and chunk verification both match on it. A StreamMessage only offers
        // getTimestamp()/messageId.timestamp, so without this the checks read
        // `undefined` and silently conclude nothing was stored.
        try { message.timestamp = messageId.timestamp; } catch { /* frozen: callers fall back */ }
        return message;
    }

    // ==================== KEYS STREAM (-4) ====================

    /**
     * Publish an epoch-key protocol message (KEY_ANNOUNCE / KEY_REQUEST /
     * KEY_WRAP) on a channel's keys stream.
     *
     * Publishes AS THE ACCOUNT — the -4 grant is per member address, and a
     * throwaway key holds none (D3). Refuses loudly rather than falling back:
     * a silent identity substitution here would be rejected network-wide and
     * the key exchange would just stall.
     *
     * @param {string} keysStreamId - Keys stream ID (ends with -4)
     * @param {Object} data - Protocol message ({ t: KEYS_MSG_TYPE.*, ... })
     * @returns {Promise<Object>} The published StreamMessage
     */
    async publishKeysMessage(keysStreamId, data, partition = STREAM_CONFIG.KEYS_STREAM.KEY_EXCHANGE) {
        if (!isKeysStream(keysStreamId)) {
            throw new Error(`publishKeysMessage expects a keys stream (-4), got: ${keysStreamId}`);
        }
        if (!this._accountIdentity) {
            throw new Error('Account identity unavailable — EthereumKeyPairIdentity not exposed, check streamr-bundle.js');
        }
        // Gated channels: the -4 grant is on the clone, not per member — the
        // account signs and the clone is the on-wire publisher, exactly like
        // -1/-2. epochKeyManager receives the recovered signer as the
        // publisher (resolveAuthor in the -4 ingest), so its identity checks
        // keep working unchanged.
        const channel = await this._gatedChannelFor(keysStreamId);
        return this.publishAs(
            this._accountIdentity,
            keysStreamId,
            partition,
            data,
            this._gateTransportOptions(channel)
        );
    }

    /**
     * Publish a gated-channel payload encrypted with the current epoch key.
     *
     * Wire envelope: { e: 'epoch-aes-gcm', k: <kid>, ct, iv } — `k` in the
     * clear is what lets receivers pick the key (and history readers filter
     * what they cannot open) without trial decryption.
     *
     * Fail-closed: without a current epoch key this THROWS. A gated channel
     * has no legitimate plaintext path and no SDK-keyed path.
     *
     * @param {Object} channel - Channel object (gated)
     * @param {string} streamId - Target stream (-1 or -2 of this channel)
     * @param {number} partition
     * @param {Object} data - Plaintext payload
     * @returns {Promise<Object>} The published StreamMessage
     */
    async publishEpochEncrypted(channel, streamId, partition, data) {
        if (!this._accountIdentity) {
            throw new Error('Account identity unavailable — check streamr-bundle.js');
        }
        const { epochKeyManager } = await import('./epochKeyManager.js');
        const { epochKeyCrypto } = await import('./epochKeyCrypto.js');

        let key = await epochKeyManager.getCurrentKey(channel.messageStreamId);
        if (!key) {
            // One recovery attempt: cold open may not have run the key
            // bootstrap/request yet.
            await epochKeyManager.ensureChannelKeys(channel);
            key = await epochKeyManager.getCurrentKey(channel.messageStreamId);
        }
        if (!key) {
            throw new Error(
                `No epoch key for ${channel.messageStreamId} — cannot publish on a gated channel without one (waiting for KEY_WRAP)`);
        }

        const payload = stripLocalFields(data);

        // Members-only author visibility: the plaintext becomes an authorship
        // wrapper (pseudonym signature per message + account bind proof) and
        // the transport publisher becomes the channel's SHARED key — the wire
        // says nothing about who wrote this. Fail-closed on both halves: no
        // publish key or no wallet means NO publish, never a fallback to the
        // clone (which would put the account on the wire).
        const { usesSharedPublish } = await import('./epochKeyManager.js');
        if (usesSharedPublish(channel)) {
            const pubKey = await epochKeyManager.ensurePublishKey(channel);
            if (!pubKey) {
                throw new Error(
                    `No publish key for ${channel.messageStreamId} — cannot publish on a Members-only channel without one (waiting for PUB_WRAP)`);
            }
            const auth = epochKeyManager.getAuthorship(channel);
            if (!auth) {
                throw new Error('No wallet available to bind the channel pseudonym');
            }
            const { authorship } = await import('./authorship.js');
            const wrapper = authorship.seal(
                channel.messageStreamId, payload,
                { privateKey: auth.privateKey, publicKey: auth.publicKey },
                auth.bindProof);
            const sealedWrapper = await epochKeyCrypto.encryptWithEpochKey(wrapper, key.cryptoKey);
            const envelope = { e: 'epoch-aes-gcm', k: key.kid, ct: sealedWrapper.ct, iv: sealedWrapper.iv };
            return this.publishAs(
                this._sharedPublishIdentity(pubKey), streamId, partition, envelope);
        }

        const sealed = await epochKeyCrypto.encryptWithEpochKey(payload, key.cryptoKey);
        const envelope = { e: 'epoch-aes-gcm', k: key.kid, ct: sealed.ct, iv: sealed.iv };

        return this.publishAs(
            this._accountIdentity, streamId, partition, envelope,
            this._gateTransportOptions(channel, streamId)
        );
    }

    /**
     * Re-key a Members-only channel's shared publish grants: the new key's
     * address gains publish+subscribe on -1/-2 and the old one loses
     * everything — one setPermissions tx per stream (an assignment with an
     * empty permission list clears that user). The admin escape valve
     * against ex-key-holder abuse; exceptional, never routine.
     */
    async rekeySharedPublishGrants(channel, newAddress, oldAddress) {
        for (const streamId of [channel.messageStreamId, channel.ephemeralStreamId]) {
            if (!streamId) continue;
            const assignments = [
                // PUBLISH alone: the shared key writes, the clone reads.
                { userId: newAddress.toLowerCase(), permissions: ['publish'] },
                ...(oldAddress ? [{ userId: oldAddress.toLowerCase(), permissions: [] }] : [])
            ];
            await executeWithRetry(`rekeySharedPublishGrants(${streamId.slice(-20)})`, async () => {
                await this.client.setPermissions({ streamId, assignments });
            });
        }
    }

    /**
     * Identity for the channel's SHARED publish key, cached per keyId — a
     * re-key changes the keyId and naturally mints the replacement.
     */
    _sharedPublishIdentity(pubKey) {
        if (!window.EthereumKeyPairIdentity) {
            throw new Error('EthereumKeyPairIdentity not exposed — check streamr-bundle.js');
        }
        this._pubIdentities ??= new Map();
        let identity = this._pubIdentities.get(pubKey.keyId);
        if (!identity) {
            identity = window.EthereumKeyPairIdentity.fromPrivateKey(pubKey.keyHex);
            this._pubIdentities.set(pubKey.keyId, identity);
        }
        return identity;
    }

    /**
     * Publish a binary MEDIA_DATA frame sealed with the current epoch key.
     *
     * The binary sibling of publishEpochEncrypted, with the same identity
     * rules: the gate clone is the on-wire publisher (ERC-1271) — a
     * channel-ephemeral key holds no grant, so the channel pseudonym cannot
     * carry epoch pieces. Same fail-closed stance: no epoch key means NO
     * publish.
     *
     * @param {Object} channel - Channel object (gated)
     * @param {string} ephemeralStreamId - The channel's -2 stream
     * @param {Uint8Array} data - Plaintext binary frame
     * @returns {Promise<Object>} The published StreamMessage
     */
    async publishMediaDataEpoch(channel, ephemeralStreamId, data) {
        if (!this._accountIdentity) {
            throw new Error('Account identity unavailable — check streamr-bundle.js');
        }
        const { epochKeyManager } = await import('./epochKeyManager.js');
        const { epochKeyCrypto } = await import('./epochKeyCrypto.js');

        let key = await epochKeyManager.getCurrentKey(channel.messageStreamId);
        if (!key) {
            await epochKeyManager.ensureChannelKeys(channel);
            key = await epochKeyManager.getCurrentKey(channel.messageStreamId);
        }
        if (!key) {
            throw new Error(
                `No epoch key for ${channel.messageStreamId} — cannot send media on an epoch channel without one`);
        }

        const sealed = await epochKeyCrypto.sealBinaryWithEpochKey(data, key.cryptoKey, key.kid);

        // Members-only: binary frames carry no authorship wrapper (their
        // trust anchor is the content hash from an AUTHORED announce), but
        // the transport must still be the shared key — the clone path would
        // stamp the sender's account onto every piece.
        const { usesSharedPublish } = await import('./epochKeyManager.js');
        if (usesSharedPublish(channel)) {
            const pubKey = await epochKeyManager.ensurePublishKey(channel);
            if (!pubKey) {
                throw new Error(
                    `No publish key for ${channel.messageStreamId} — cannot send media on a Members-only channel without one`);
            }
            return this.publishAs(
                this._sharedPublishIdentity(pubKey), ephemeralStreamId,
                STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_DATA, sealed);
        }

        return this.publishAs(
            this._accountIdentity, ephemeralStreamId,
            STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_DATA, sealed,
            this._gateTransportOptions(channel, ephemeralStreamId)
        );
    }

    /**
     * Open a raw MEDIA_DATA payload as far as the transport layer can.
     *
     * Epoch envelopes (0x04) resolve their kid exactly like openEpochEnvelope:
     * an unknown kid is NOT an error — note it (rate-limited KEY_REQUEST) and
     * drop; pieces are live-only, the leecher's timeout re-requests them once
     * the key lands. The 0x04 probe runs only without a password: password and
     * epoch channels are disjoint, and encryptBinary output starts with random
     * salt that would collide with the version byte 1 time in 256.
     *
     * @param {string} streamId - Stream the payload arrived on (-2)
     * @param {Uint8Array} content - Raw payload
     * @param {string|null} password - Channel password, if any
     * @returns {Promise<Uint8Array|null>} plaintext frame, or null to skip
     */
    async _openBinaryMediaPayload(streamId, content, password) {
        if (password) {
            return await cryptoManager.decryptBinary(content, password);
        }
        const { epochKeyCrypto } = await import('./epochKeyCrypto.js');
        if (!epochKeyCrypto.isBinaryEpochEnvelope(content)) return content;

        const parsed = epochKeyCrypto.parseBinaryEpochEnvelope(content);
        if (!parsed) return null;
        const messageStreamId = String(streamId).replace(/-[234]$/, '-1');
        const { epochKeyManager } = await import('./epochKeyManager.js');
        const key = await epochKeyManager.getKeyForKid(messageStreamId, parsed.kid, { live: true });
        if (key === false) return null;
        if (!key) {
            epochKeyManager.noteMissingKid(messageStreamId, parsed.kid);
            return null;
        }
        try {
            return await epochKeyCrypto.decryptBinaryWithEpochKey(parsed, key);
        } catch (e) {
            Logger.warn(`Epoch binary envelope failed to open (kid ${parsed.kid}):`, e.message);
            return null;
        }
    }

    /**
     * publishAs options for a channel's transport identity.
     *
     * Gated channels publish as the GATE CLONE with an ERC-1271 signature —
     * the account key signs the envelope, the clone is the on-wire publisher,
     * and receivers recover authorship from that signature (resolveAuthor).
     *
     * The admin stream (-3) is the exception even in gated channels: its only
     * legitimate writer is the owner, whose address is already the streamId
     * prefix — publishing as the ACCOUNT (plain EVM) lets the network enforce
     * owner-only writes there (new channels grant the clone subscribe-only on
     * -3; old channels' clone grant stays, covered by the ingest check).
     */
    _gateTransportOptions(channel, streamId = null) {
        if (streamId && isAdminStream(streamId)) return {};
        if (!channel?.gate?.address) {
            // A gated channel without its gate address (repair pending) must
            // fail LOUDLY: publishing as the account or an ephemeral key would
            // just be rejected by the network (only the clone holds a grant).
            if (channel?.type === 'gated') {
                throw new Error('Gate address unknown for this channel (repair pending) — cannot publish');
            }
            return {};
        }
        const { SignatureType } = window;
        if (SignatureType?.ERC_1271 === undefined) {
            throw new Error('SignatureType not exposed — check streamr-bundle.js');
        }
        return {
            publisherId: channel.gate.address.toLowerCase(),
            signatureType: SignatureType.ERC_1271
        };
    }

    /**
     * @param {*} content - Parsed message content
     * @returns {boolean} true if this is an epoch-encrypted envelope
     */
    isEpochEnvelope(content) {
        return !!(content && content.e === 'epoch-aes-gcm'
            && typeof content.k === 'string'
            && typeof content.ct === 'string'
            && typeof content.iv === 'string');
    }

    /**
     * Open an epoch envelope from a channel's -1 or -2 stream.
     *
     * Returns the plaintext object, or NULL when we do not (yet) hold the
     * key — an unknown `kid` is NOT an error (§7.9): the missing key is noted
     * (which rate-limits a KEY_REQUEST) and the caller skips the message.
     * Storage-backed messages are recovered by the refresh that runs when the
     * key is adopted; ephemeral ones (presence) self-heal on the next beat.
     *
     * @param {string} streamId - Stream the message arrived on (-1 or -2)
     * @param {Object} content - Envelope ({ e, k, ct, iv })
     * @param {Object} [context] - Kid freshness inputs (gated channels)
     * @param {number} [context.timestamp] - The message's transport timestamp
     * @param {boolean} [context.live] - true on live subscriptions
     * @returns {Promise<Object|null>}
     */
    async openEpochEnvelope(streamId, content, context = {}) {
        const messageStreamId = String(streamId).replace(/-[234]$/, '-1');
        const { epochKeyManager } = await import('./epochKeyManager.js');
        const key = await epochKeyManager.getKeyForKid(messageStreamId, content.k, context);
        if (key === false) {
            // Kid freshness violation (gated): a readable key used outside its
            // epoch's validity — stale-key spam, not a missing key. Drop
            // silently, and do NOT request anything.
            return null;
        }
        if (!key) {
            epochKeyManager.noteMissingKid(messageStreamId, content.k);
            return null;
        }
        const { epochKeyCrypto } = await import('./epochKeyCrypto.js');
        try {
            return await epochKeyCrypto.decryptWithEpochKey({ ct: content.ct, iv: content.iv }, key);
        } catch (e) {
            Logger.warn(`Epoch envelope failed to open (kid ${content.k}):`, e.message);
            return null;
        }
    }

    /**
     * One-shot resend of a channel's keys stream (-4).
     *
     * Returns raw protocol entries with their transport publisher and
     * timestamp — the caller (epochKeyManager) validates KEY_ANNOUNCE
     * authority against the admin set and applies the conflict rule (D13),
     * so both must travel with the payload.
     *
     * @param {string} keysStreamId - Keys stream ID (ends with -4)
     * @param {Object} [options]
     * @param {number} [options.last=1000] - How many entries to fetch
     * @returns {Promise<Array<{data: Object, publisherId: string, timestamp: number}>>}
     */
    async resendKeysMessages(keysStreamId, { last = 1000, partition = STREAM_CONFIG.KEYS_STREAM.KEY_EXCHANGE } = {}) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }
        if (!isKeysStream(keysStreamId)) {
            Logger.warn('Invalid keysStreamId (should end with -4):', keysStreamId);
        }

        const entries = [];
        try {
            // Raw: skips the SDK's validation/ordering pipeline. Gap-filling
            // rides the mesh, so on a half-connected node an ordered resend
            // silently stalls or returns empty while plain HTTP works — the
            // same lesson that moved gated history to raw. -4 authority never
            // came from the validator anyway: resolveAuthor recovers the
            // envelope signer below and the key layer verifies key hashes.
            const resend = await this.client.resend(
                { streamId: keysStreamId, partition },
                { last, raw: true }
            );

            for await (const message of resend) {
                try {
                    const content = message.content || message;
                    // P0 carries typed protocol messages; the roster partition
                    // carries epoch envelopes (no `t` until decrypted)
                    if (!content || typeof content !== 'object') continue;
                    if (typeof content.t !== 'string' && content.e !== 'epoch-aes-gcm') continue;
                    const transportPublisher = typeof message.getPublisherId === 'function'
                        ? message.getPublisherId()
                        : (message.publisherId ?? null);
                    // Gated: authorship = envelope signer (see subscribeToKeysStream)
                    const publisherId = await this.resolveAuthor(
                        keysStreamId, message, transportPublisher);
                    if (!publisherId) continue;
                    entries.push({
                        data: content,
                        publisherId,
                        timestamp: typeof message.getTimestamp === 'function'
                            ? message.getTimestamp()
                            : (message.timestamp ?? 0)
                    });
                } catch (e) {
                    Logger.debug('resendKeysMessages entry error:', e.message);
                }
            }
        } catch (error) {
            // No storage attached yet / empty stream — the caller treats an
            // empty list as "no announces", which is the correct cold start
            Logger.debug('resendKeysMessages error:', error.message);
        }
        return entries;
    }

    /**
     * Live subscription to a channel's keys stream (-4).
     *
     * Raw handler on purpose: the epoch protocol validates KEY_ANNOUNCE
     * authority by transport publisher and orders conflicts by transport
     * timestamp (D13), so both must reach the handler unmangled — this does
     * NOT go through attachAccount.
     *
     * @param {string} keysStreamId - Keys stream ID (ends with -4)
     * @param {Function} handler - (data, publisherId, timestamp) => void
     */
    async subscribeToKeysStream(keysStreamId, handler) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }
        if (!isKeysStream(keysStreamId)) {
            throw new Error(`subscribeToKeysStream expects a keys stream (-4), got: ${keysStreamId}`);
        }

        let partitionSubs = this.subscriptions.get(keysStreamId);
        if (!partitionSubs) {
            partitionSubs = {};
            this.subscriptions.set(keysStreamId, partitionSubs);
        }
        const partition = STREAM_CONFIG.KEYS_STREAM.KEY_EXCHANGE;
        if (partitionSubs[partition]) {
            Logger.debug('Already subscribed to keys stream:', keysStreamId);
            return partitionSubs[partition];
        }

        const gatedChannel = await this._gatedChannelFor(keysStreamId);
        partitionSubs[partition] = await this.client.subscribe(
            {
                streamId: keysStreamId, partition,
                // Gated: prove access via the gate (our wallet signs, the
                // contract's isValidSignature vouches) — no per-member grant.
                ...(gatedChannel ? { erc1271Contract: gatedChannel.gate.address } : {})
            },
            async (content, streamMessage) => {
                try {
                    if (!content || typeof content !== 'object') return;
                    const transportPublisher = typeof streamMessage?.getPublisherId === 'function'
                        ? streamMessage.getPublisherId()
                        : streamMessage?.publisherId;
                    // Gated: the clone publishes for everyone — the epoch
                    // protocol's identity checks (admin set, own-request skip,
                    // checkAccess) need the AUTHOR, i.e. the envelope signer.
                    const publisherId = await this.resolveAuthor(
                        keysStreamId, streamMessage, transportPublisher);
                    if (!publisherId) return;
                    const timestamp = typeof streamMessage?.getTimestamp === 'function'
                        ? streamMessage.getTimestamp()
                        : (streamMessage?.timestamp ?? Date.now());
                    await handler(content, publisherId, timestamp);
                } catch (error) {
                    Logger.error('Failed to process keys stream message:', error);
                }
            }
        );

        Logger.debug('Subscribed to keys stream:', keysStreamId);
        return partitionSubs[partition];
    }

    /**
     * Publish to the shared push stream under a THROWAWAY key.
     *
     * Registration and wake signals used to go out under the account
     * (`client.publish`), which pinned the wallet onto a public, indexed
     * stream: "X uses Pombo" on every registration, and "X was active at T0"
     * on every wake — a timing side-channel back onto the sealed DM that wake
     * announces. The relay keys on (tag, token) and validates wake by PoW; it
     * never reads the publisher, so a fresh ephemeral key per publish costs
     * nothing and closes the leak. No proof, no identity in the payload — the
     * push stream carries neither.
     *
     * @param {Object} payload - registration or wake-signal object
     */
    async publishToPushStream(payload) {
        const EthereumKeyPairIdentity = window.EthereumKeyPairIdentity;
        if (!EthereumKeyPairIdentity) {
            throw new Error('EthereumKeyPairIdentity not exposed — check streamr-bundle.js');
        }
        // Registrations carry the push endpoint/FCM token — sealed to the
        // relay's static key (§9.1 #3), so they never cross the observable
        // stream in the clear. Wake signals are 1-byte k-anonymous tags and
        // stay in the clear — they carry nothing sensitive and must stay
        // cheap. FAIL-CLOSED: no plaintext fallback, or a hostile Graph/RPC
        // could strip the key and downgrade every registration; the caller's
        // re-registration cadence retries a transient failure.
        if (payload?.type === 'registration') {
            const relayPk = await this._getRelayPublicKey();
            const { dmCrypto } = await import('./dmCrypto.js');
            const { envelope, ephemeralPrivateKey } = await dmCrypto.sealToPublicKey(
                payload, relayPk, 'pombo-push-sealed-v1');
            const identity = EthereumKeyPairIdentity.fromPrivateKey(ephemeralPrivateKey);
            return this.publishAs(identity, CONFIG.push.pushStreamId, 0,
                { type: 'sealed', ...envelope });
        }
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const ephemeralPrivateKey = '0x' + Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0')).join('');
        const identity = EthereumKeyPairIdentity.fromPrivateKey(ephemeralPrivateKey);
        return this.publishAs(identity, CONFIG.push.pushStreamId, 0, payload);
    }

    /**
     * The push relay's static public key, from the push stream's on-chain
     * metadata, PINNED to the known relay address (computeAddress(pk) must
     * recover it — the mirror of the DM peer-key pin, §9.1 #2: tampered
     * metadata or a hostile Graph endpoint yields a key that fails the pin
     * and is rejected, never a silent MITM on every push endpoint).
     * Cached for the session — the key only changes with a relay migration.
     * @returns {Promise<string>} Compressed secp256k1 public key
     */
    async _getRelayPublicKey() {
        if (this._relayPublicKey) return this._relayPublicKey;
        const { graphAPI } = await import('./graph.js');
        const stream = await graphAPI.getStream(CONFIG.push.pushStreamId);
        const outer = JSON.parse(stream?.metadata || '{}');
        const meta = JSON.parse(outer.description || '{}');
        const pk = typeof meta.pk === 'string' ? meta.pk : null;
        if (!pk) throw new Error('Push stream metadata carries no relay key');
        const owner = ethers.computeAddress(pk).toLowerCase();
        const known = (CONFIG.push.relays || []).some(
            (r) => r.address?.toLowerCase() === owner);
        if (!known) {
            throw new Error(`Relay key pin failed: ${owner} is not a configured relay`);
        }
        this._relayPublicKey = pk;
        return pk;
    }

    /**
     * Publish a storage-file chunk to a message-stream chunk partition.
     *
     * Chunks are pre-sealed by the storage engine with a per-file key (one
     * PBKDF2/ECDH derivation per file, random IV per chunk) — the documented
     * exception to the publish() sealing rule, which derives a fresh key per
     * message and would spend minutes of pure PBKDF2 on a large file.
     * Payload goes out as a bare Uint8Array with binary contentType.
     *
     * @param {string} messageStreamId - Message stream ID (ends with -1)
     * @param {number} partition - Chunk partition
     * @param {Uint8Array} data - Sealed (or public-plaintext) chunk payload
     * @returns {Promise<Object>} - SDK publish result (carries .timestamp)
     */
    async publishStorageChunk(messageStreamId, partition, data, identity = null) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }
        // DM transfers pass a throwaway identity so the chunks do not carry the
        // sender's address. One identity is reused for the whole transfer:
        // chunks of a file are obviously related anyway (same partitions, same
        // window), so a key per chunk would buy nothing and cost thousands of
        // signatures.
        if (identity) {
            const msg = await this.publishAs(identity, messageStreamId, partition, data);
            // Normalise to client.publish()'s shape. Callers read `.timestamp`
            // to record the chunk's position, and the download path locates
            // chunks by that timestamp window — a StreamMessage has no such
            // property, so returning it raw would silently fall back to
            // Date.now() and drift the window.
            return { timestamp: msg.messageId.timestamp, message: msg };
        }
        // Gated channels: client.publish on a members-only stream would wrap
        // the chunk in the SDK's group-key AES — the HTTP hex reader then
        // returns ciphertext, and the group-key exchange is the very
        // publisher-online dependency the epoch protocol replaces. publishAs
        // sends encryptionType NONE (the chunk is already epoch-sealed) under
        // the clone — so verify must expect the GATE address for gated rows.
        let channelManager = null;
        try { ({ channelManager } = await import('./channels.js')); } catch { /* early boot */ }
        if (channelManager?.usesAccountPublish?.(messageStreamId)) {
            const base = String(messageStreamId).replace(/-[1234]$/, '');
            const channel = channelManager.channels?.get(base + '-1');
            if (channel?.type === 'gated' || channel?.gate?.address) {
                // Members-only: chunks travel under the shared key too — the
                // clone path would stamp the uploader's account onto them.
                const { epochKeyManager, usesSharedPublish } = await import('./epochKeyManager.js');
                if (usesSharedPublish(channel)) {
                    const pubKey = await epochKeyManager.ensurePublishKey(channel);
                    if (!pubKey) {
                        throw new Error(
                            `No publish key for ${channel.messageStreamId} — cannot upload on a Members-only channel without one`);
                    }
                    const msg = await this.publishAs(
                        this._sharedPublishIdentity(pubKey), messageStreamId, partition, data);
                    return { timestamp: msg.messageId.timestamp, message: msg };
                }
                const msg = await this.publishAs(
                    this._accountIdentity, messageStreamId, partition, data,
                    this._gateTransportOptions(channel));
                return { timestamp: msg.messageId.timestamp, message: msg };
            }
        }
        return await this.client.publish(
            { streamId: messageStreamId, partition },
            data,
            { contentType: 'binary' }
        );
    }

    /**
     * Get partition count for a stream.
     * @param {string} streamId - Stream ID
     * @returns {Promise<number>} - Partition count
     */
    async getStreamPartitionCount(streamId) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        const stream = await this.client.getStream(streamId);
        const partitions = await stream.getPartitionCount();
        return typeof partitions === 'bigint' ? Number(partitions) : partitions;
    }

    /**
     * Publish a text message to MESSAGE STREAM (partition 0 - stored)
     * In dual-stream architecture: caller must pass messageStreamId
     * @param {string} messageStreamId - Message Stream ID (ends with -1)
     * @param {Object} message - Message object
     * @param {string} password - Password for encrypted channels (optional)
     */
    async publishMessage(messageStreamId, message, password = null) {
        Logger.debug('publishMessage called - sending to messageStream partition 0:', { messageStreamId, messageId: message?.id });
        
        return await this.publishAsChannel(
            messageStreamId, STREAM_CONFIG.MESSAGE_STREAM.MESSAGES, message, password);
    }

    /**
     * Publish control/metadata to EPHEMERAL STREAM (partition 0 - ephemeral)
     * In dual-stream architecture: caller must pass ephemeralStreamId
     * @param {string} ephemeralStreamId - Ephemeral Stream ID (ends with -2)
     * @param {Object} control - Control data (presence, typing)
     * @param {string} password - Password for encrypted channels (optional)
     */
    async publishControl(ephemeralStreamId, control, password = null) {
        return await this.publishAsChannel(
            ephemeralStreamId, STREAM_CONFIG.EPHEMERAL_STREAM.CONTROL, control, password);
    }

    /**
     * Publish reaction to MESSAGE STREAM (partition 0 - stored with messages)
     * In dual-stream architecture: caller must pass messageStreamId
     * @param {string} messageStreamId - Message Stream ID (ends with -1)
     * @param {Object} reaction - Reaction data
     * @param {string} password - Password for encrypted channels (optional)
     */
    async publishReaction(messageStreamId, reaction, password = null) {
        Logger.debug('publishReaction called - sending to messageStream partition 0:', { messageStreamId, messageId: reaction?.messageId });
        return await this.publishAsChannel(
            messageStreamId, STREAM_CONFIG.MESSAGE_STREAM.MESSAGES, reaction, password);
    }

    /**
     * Publish media signal to EPHEMERAL STREAM (partition 1 - lightweight P2P coordination)
     * For: piece_request, source_request, source_announce (JSON)
     * @param {string} ephemeralStreamId - Ephemeral Stream ID (ends with -2)
     * @param {Object} signal - Signal data (requests, announcements)
     * @param {string} password - Password for encrypted channels (optional)
     */
    async publishMediaSignal(ephemeralStreamId, signal, password = null) {
        return await this.publishAsChannel(
            ephemeralStreamId, STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_SIGNALS, signal, password);
    }

    /**
     * Publish media data to EPHEMERAL STREAM (partition 2 - heavy P2P payloads)
     * For: file_piece (Binary - Uint8Array)
     * @param {string} ephemeralStreamId - Ephemeral Stream ID (ends with -2)
     * @param {Uint8Array} data - Binary payload
     * @param {string} password - Password for encrypted channels (optional)
     */
    async publishMediaData(ephemeralStreamId, data, password = null) {
        return await this.publish(ephemeralStreamId, STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_DATA, data, password);
    }

    /**
     * Publish already-sealed binary media under a throwaway identity.
     *
     * The sealed envelope carries its own encryption and identity proof, so this
     * takes no password: `publishAs` sends with encryptionType NONE.
     *
     * @param {string} ephemeralStreamId - Ephemeral Stream ID (ends with -2)
     * @param {Uint8Array} data - Sealed binary payload
     * @param {Object} identity - EthereumKeyPairIdentity for the transfer
     */
    async publishMediaDataAs(ephemeralStreamId, data, identity) {
        return await this.publishAs(
            identity, ephemeralStreamId, STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_DATA, data);
    }

    /**
     * Publish notification to MESSAGE STREAM (partition 3 - notifications/invites)
     * For: channel invites and other notifications (E2E encrypted at app layer)
     * @param {string} messageStreamId - Message Stream ID (ends with -1)
     * @param {Object} data - Encrypted notification payload
     * @param {string} password - Password (null for DMs — encryption is E2E app-layer)
     */
    async publishNotification(messageStreamId, data, password = null) {
        return await this.publish(messageStreamId, STREAM_CONFIG.MESSAGE_STREAM.NOTIFICATIONS, data, password);
    }

    /**
     * Publish ADMIN_STATE snapshot to ADMIN STREAM (partition 0 - moderation)
     * Only the channel owner can successfully publish (enforced by stream permissions).
     * In `password` channels the snapshot is encrypted with the channel password.
     *
     * @param {string} adminStreamId - Admin stream ID (ends with -3)
     * @param {Object} state - Full ADMIN_STATE message ({ type, v, rev, ts, createdBy, state })
     * @param {string} password - Password for encrypted channels (optional)
     */
    async publishAdminState(adminStreamId, state, password = null) {
        Logger.debug('publishAdminState called - sending to adminStream partition 0:', { adminStreamId, rev: state?.rev });
        // GATED channels: epoch envelope + account + NONE. Members hold the
        // epoch key; the -3 owner-only publish permission is still enforced
        // on-chain (the account signs).
        try {
            const { channelManager } = await import('./channels.js');
            const base = String(adminStreamId).replace(/-[1234]$/, '');
            const channel = channelManager.channels?.get(base + '-1');
            if (channel?.type === 'gated' || channel?.gate?.address) {
                // -3 publishes as the ACCOUNT on gated too (_gateTransportOptions):
                // owner-only writes are the transport's job again. resolveAuthor
                // keeps validating clone-published -3 for pre-switch history.
                return await this.publishEpochEncrypted(
                    channel, adminStreamId, STREAM_CONFIG.ADMIN_STREAM.MODERATION, state);
            }
        } catch (e) {
            if (String(e?.message || '').includes('No epoch key')) throw e;
            /* registry unavailable → legacy path */
        }
        return await this.publish(adminStreamId, STREAM_CONFIG.ADMIN_STREAM.MODERATION, state, password);
    }

    /**
     * One-shot resend of ADMIN STREAM partition 0 (moderation).
     * Used by the resend-based admin-state model: instead of holding a live
     * subscription on -3, callers fetch the latest snapshot on channel open
     * and on each polling tick, complemented by a low-latency invalidation
     * signal published on the ephemeral -2/P0 control partition.
     *
     * Returns the highest-`rev` snapshot from the resend window, or `null`
     * if the stream has no ADMIN_STATE published yet (or all entries failed
     * to decrypt). Does NOT register anything in `this.subscriptions`.
     *
     * @param {string} adminStreamId - Admin stream ID (ends with -3)
     * @param {Object} [options]
     * @param {number} [options.historyCount=ADMIN_HISTORY_COUNT] Last N to fetch
     * @param {string|null} [options.password=null] Channel password (encrypted channels)
     * @returns {Promise<Object|null>} Latest ADMIN_STATE or null
     */
    async resendAdminState(adminStreamId, { historyCount, password = null } = {}) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }
        if (!isAdminStream(adminStreamId)) {
            Logger.warn('Invalid adminStreamId (should end with -3):', adminStreamId);
        }

        const last = historyCount ?? STREAM_CONFIG.ADMIN_HISTORY_COUNT;
        const partition = STREAM_CONFIG.ADMIN_STREAM.MODERATION;

        let latest = null;

        try {
            // Gated: raw resend — the SDK validator re-checks stored envelopes
            // against the present gate state; authorship is established
            // client-side by resolveAuthor (admin-only on -3) instead.
            const gatedChannel = await this._gatedChannelFor(adminStreamId);
            const resend = await this.client.resend(
                { streamId: adminStreamId, partition },
                { last, ...(gatedChannel ? { raw: true } : {}) }
            );

            const iterator = resend[Symbol.asyncIterator]();
            let iteratorDone = false;

            while (!iteratorDone) {
                let message;
                try {
                    const result = await iterator.next();
                    iteratorDone = result.done;
                    if (iteratorDone) break;
                    message = result.value;
                } catch (iterError) {
                    if (iterError.code === 'DECRYPT_ERROR' || iterError.message?.includes('encryption key')) {
                        continue;
                    }
                    Logger.warn('resendAdminState iteration error:', iterError.message);
                    continue;
                }

                try {
                    let content = message.content || message;
                    if (password && typeof content === 'string') {
                        try {
                            content = await cryptoManager.decryptJSON(content, password);
                        } catch (decryptError) {
                            continue;
                        }
                    }
                    // Gated: ADMIN_STATE arrives as an epoch envelope. History
                    // context so entries sealed under an older epoch open in
                    // that epoch's validity window instead of being dropped.
                    if (this.isEpochEnvelope(content)) {
                        const historyTimestamp = typeof message.getTimestamp === 'function'
                            ? message.getTimestamp()
                            : message.timestamp;
                        const opened = await this.openEpochEnvelope(adminStreamId, content,
                            { live: false, timestamp: historyTimestamp });
                        if (opened === null) continue;
                        content = opened;
                    }
                    if (!content || typeof content !== 'object') continue;
                    if (content.type && content.type !== 'ADMIN_STATE') continue;

                    // Inject publisher info so caller can validate sender == createdBy.
                    // Gated: the clone publishes for everyone — resolveAuthor swaps in
                    // the envelope signer and DROPS non-admin writes on -3 (D10c).
                    {
                        const transportPublisher = typeof message.getPublisherId === 'function'
                            ? message.getPublisherId() : message.publisherId;
                        const publisherId = await this.resolveAuthor(
                            adminStreamId, message, transportPublisher);
                        if (!publisherId) continue;
                        if (!content.createdBy) content.createdBy = publisherId;
                    }

                    const incomingRev = typeof content.rev === 'number' ? content.rev : 0;
                    const incomingTs = typeof content.ts === 'number' ? content.ts : 0;
                    const latestRev = latest ? (latest.rev || 0) : -1;
                    const latestTs = latest ? (latest.ts || 0) : 0;
                    if (incomingRev > latestRev || (incomingRev === latestRev && incomingTs > latestTs)) {
                        latest = content;
                    }
                } catch (e) {
                    Logger.debug('resendAdminState entry processing error:', e.message);
                    continue;
                }
            }
        } catch (error) {
            Logger.warn('resendAdminState error:', error.message);
            return null;
        }

        Logger.debug('resendAdminState result:', {
            adminStreamId: adminStreamId.slice(-30),
            found: !!latest,
            rev: latest?.rev
        });
        return latest;
    }

    /**
     * Publish CHANNEL_IMAGE to ADMIN STREAM partition 1.
     * Only the channel owner can successfully publish (enforced by stream
     * permissions). Encryption is *opt-in* (caller decides), independent of
     * channel type — by default this is published unencrypted so other
     * surfaces (sidebar, Explore) can read the image without the channel
     * password.
     *
     * @param {string} adminStreamId - Admin stream ID (ends with -3)
     * @param {Object} payload - { type:'CHANNEL_IMAGE', v, rev, ts, createdBy, encrypted, mime, hash, data }
     * @param {string|null} [password=null] - Pass channel password ONLY when caller wants encryption
     */
    async publishChannelImage(adminStreamId, payload, password = null) {
        Logger.debug('publishChannelImage called - adminStream partition 1:', {
            adminStreamId: String(adminStreamId).slice(-30),
            rev: payload?.rev,
            encrypted: !!password
        });
        // Gated: epoch envelope, same reason as publishAdminState — without
        // it the SDK forces AES on the members-only -3 and the image never
        // opens for anyone who cannot reach the owner's group key.
        try {
            const { channelManager } = await import('./channels.js');
            const base = String(adminStreamId).replace(/-[1234]$/, '');
            const channel = channelManager.channels?.get(base + '-1');
            // Visible channels are storefronts: the image IS the marketing and
            // publishes in the CLEAR so non-members (Explore) can render it.
            // Hidden channels keep their image sealed (epoch/password).
            if (channel?.exposure === 'visible') {
                const clear = { ...payload, encrypted: false };
                if (channel?.gate?.address) {
                    // -3 publishes as the ACCOUNT in gated too — owner-only
                    // writes are the transport's again (_gateTransportOptions)
                    return await this.publishAs(
                        this._accountIdentity, adminStreamId,
                        STREAM_CONFIG.ADMIN_STREAM.CHANNEL_IMAGE, clear,
                        this._gateTransportOptions(channel, adminStreamId));
                }
                return await this.publish(adminStreamId, STREAM_CONFIG.ADMIN_STREAM.CHANNEL_IMAGE, clear);
            }
            if (channel?.type === 'gated' || channel?.gate?.address) {
                return await this.publishEpochEncrypted(
                    channel, adminStreamId, STREAM_CONFIG.ADMIN_STREAM.CHANNEL_IMAGE, payload);
            }
        } catch (e) {
            if (String(e?.message || '').includes('No epoch key')) throw e;
            /* registry unavailable → legacy path */
        }
        return await this.publish(adminStreamId, STREAM_CONFIG.ADMIN_STREAM.CHANNEL_IMAGE, payload, password);
    }

    /**
     * One-shot resend of ADMIN STREAM partition 1 (channel image).
     * Always returns only the most-recent published entry (last:1) — image
     * is single-valued; older revs are irrelevant.
     *
     * @param {string} adminStreamId - Admin stream ID (ends with -3)
     * @param {Object} [options]
     * @param {string|null} [options.password=null] - Channel password (used if entry is encrypted)
     * @returns {Promise<Object|null>} Latest CHANNEL_IMAGE payload or null
     */
    async resendChannelImage(adminStreamId, { password = null } = {}) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }
        if (!isAdminStream(adminStreamId)) {
            Logger.warn('Invalid adminStreamId (should end with -3):', adminStreamId);
        }

        const partition = STREAM_CONFIG.ADMIN_STREAM.CHANNEL_IMAGE;
        let latest = null;

        try {
            // Gated: raw resend — the SDK validator re-checks stored envelopes
            // against the present gate state; the owner check below (envelope
            // signer must be the namespace owner) is the real authority here.
            const gatedChannel = await this._gatedChannelFor(adminStreamId);
            const resend = await this.client.resend(
                { streamId: adminStreamId, partition },
                { last: 1, ...(gatedChannel ? { raw: true } : {}) }
            );

            const iterator = resend[Symbol.asyncIterator]();
            let iteratorDone = false;

            while (!iteratorDone) {
                let message;
                try {
                    const result = await iterator.next();
                    iteratorDone = result.done;
                    if (iteratorDone) break;
                    message = result.value;
                } catch (iterError) {
                    if (iterError.code === 'DECRYPT_ERROR' || iterError.message?.includes('encryption key')) {
                        continue;
                    }
                    Logger.warn('resendChannelImage iteration error:', iterError.message);
                    continue;
                }

                try {
                    let content = message.content || message;
                    // Encrypted entries arrive as base64/JSON string; non-encrypted as object.
                    if (typeof content === 'string') {
                        if (!password) continue; // can't decrypt, skip
                        try {
                            content = await cryptoManager.decryptJSON(content, password);
                        } catch (decryptError) {
                            continue;
                        }
                    }
                    // Gated: CHANNEL_IMAGE arrives as an epoch envelope. History
                    // context so an image sealed under an older epoch opens in
                    // that epoch's validity window instead of being dropped.
                    if (this.isEpochEnvelope(content)) {
                        const historyTimestamp = typeof message.getTimestamp === 'function'
                            ? message.getTimestamp()
                            : message.timestamp;
                        const opened = await this.openEpochEnvelope(adminStreamId, content,
                            { live: false, timestamp: historyTimestamp });
                        if (opened === null) continue;
                        content = opened;
                    }
                    if (!content || typeof content !== 'object') continue;
                    if (content.type && content.type !== 'CHANNEL_IMAGE') continue;

                    // Gated: resolveAuthor swaps in the envelope signer and
                    // drops non-admin writes on -3 (D10c)
                    {
                        const transportPublisher = typeof message.getPublisherId === 'function'
                            ? message.getPublisherId() : message.publisherId;
                        const publisherId = await this.resolveAuthor(
                            adminStreamId, message, transportPublisher);
                        if (!publisherId) continue;
                        // -3 authority for channels we have NOT joined
                        // (Explore fetch of a visible gated storefront):
                        // resolveAuthor passes the clone through when no
                        // channel object exists, and the clone's grant is
                        // every member's — the envelope signer must still be
                        // the namespace owner or any member could plant an
                        // image on the card.
                        const owner = adminStreamId.split('/')[0].toLowerCase();
                        if (publisherId.toLowerCase() !== owner) {
                            const signer = recoverEnvelopeSigner(message);
                            if ((signer || '').toLowerCase() !== owner) continue;
                        }
                        if (!content.createdBy) content.createdBy = owner;
                    }

                    latest = content;
                } catch (e) {
                    Logger.debug('resendChannelImage entry processing error:', e.message);
                    continue;
                }
            }
        } catch (error) {
            Logger.warn('resendChannelImage error:', error.message);
            return null;
        }

        Logger.debug('resendChannelImage result:', {
            adminStreamId: String(adminStreamId).slice(-30),
            found: !!latest,
            hash: latest?.hash?.slice(0, 8),
            rev: latest?.rev
        });
        return latest;
    }

    /**
     * Publish PASSWORD_CHALLENGE to ADMIN STREAM partition 2.
     *
     * Encrypts a known magic plaintext with the channel password using the
     * normal `publish()` encryption path (PBKDF2 + AES-GCM via cryptoManager).
     * Verifying a candidate password later is just "try to decrypt and
     * check the magic field matches". Single-shot per channel (immutable in
     * this scope — no rotation).
     *
     * Permissions on `-3` already restrict publish to the owner, so only the
     * channel creator can establish the canonical challenge.
     *
     * @param {string} adminStreamId - Admin stream ID (ends with -3)
     * @param {string} password - Channel password (required)
     */
    async publishPasswordChallenge(adminStreamId, password) {
        if (!password || typeof password !== 'string') {
            throw new Error('publishPasswordChallenge requires a non-empty password');
        }
        const payload = {
            type: 'PASSWORD_CHALLENGE',
            v: 1,
            magic: PASSWORD_CHALLENGE_MAGIC,
            ts: Date.now()
        };
        Logger.debug('publishPasswordChallenge called - adminStream partition 2:', {
            adminStreamId: String(adminStreamId).slice(-30)
        });
        return await this.publish(
            adminStreamId,
            STREAM_CONFIG.ADMIN_STREAM.PASSWORD_CHALLENGE,
            payload,
            password
        );
    }

    /**
     * Verify a candidate password against the PASSWORD_CHALLENGE blob
     * published on ADMIN STREAM partition 2.
     *
     * Fetches the most recent entry on -3/P2 and attempts to decrypt it with
     * the candidate password. Success iff decrypt succeeds AND payload shape
     * matches (`type === 'PASSWORD_CHALLENGE'` and `magic === MAGIC`).
     *
     * Optional retry/backoff handles storage propagation: right after a
     * channel is created the storage node may not yet have retained the
     * challenge, so a transient `{found:false}` is expected. Callers that
     * want to fail-closed on `!found` should pass retries > 0.
     *
     * Returns:
     *   - { found: false, valid: false, ts: 0 } when no challenge was ever
     *     published (or storage never retained one, after retries exhausted).
     *   - { found: true,  valid: true,  ts } when password is correct.
     *   - { found: true,  valid: false, ts: 0 } when password is wrong.
     *
     * `ts` is the payload timestamp of the retained challenge (0 when absent
     * or undecryptable) — the TTL-republish check on owner open compares it
     * against the channel's retention (docs/TTL_REPUBLISH_PLAN.md).
     *
     * @param {string} adminStreamId - Admin stream ID (ends with -3)
     * @param {string} password - Candidate password
     * @param {Object} [options]
     * @param {number} [options.retries=0] Extra attempts after the first if `!found`
     * @param {number} [options.retryDelayMs=1500] Delay between attempts
     * @returns {Promise<{found: boolean, valid: boolean, ts: number}>}
     */
    async verifyPasswordChallenge(adminStreamId, password, { retries = 0, retryDelayMs = 1500 } = {}) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }
        if (!_isAdminStream(adminStreamId)) {
            Logger.warn('Invalid adminStreamId (should end with -3):', adminStreamId);
        }
        if (!password || typeof password !== 'string') {
            return { found: false, valid: false, ts: 0 };
        }

        const partition = STREAM_CONFIG.ADMIN_STREAM.PASSWORD_CHALLENGE;
        const maxAttempts = Math.max(1, 1 + Math.max(0, retries));

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            let rawContent = null;
            try {
                const resend = await this.client.resend(
                    { streamId: adminStreamId, partition },
                    { last: 1 }
                );

                const iterator = resend[Symbol.asyncIterator]();
                let iteratorDone = false;

                while (!iteratorDone) {
                    let message;
                    try {
                        const result = await iterator.next();
                        iteratorDone = result.done;
                        if (iteratorDone) break;
                        message = result.value;
                    } catch (iterError) {
                        Logger.warn('verifyPasswordChallenge iteration error:', iterError.message);
                        continue;
                    }
                    rawContent = message?.content ?? message;
                }
            } catch (error) {
                Logger.warn('verifyPasswordChallenge resend error:', error.message);
                // Treat infra error like "not found" for retry purposes.
                rawContent = null;
            }

            if (rawContent == null) {
                if (attempt < maxAttempts - 1) {
                    Logger.debug(`verifyPasswordChallenge: no entry yet (attempt ${attempt + 1}/${maxAttempts}), retrying in ${retryDelayMs}ms`);
                    await new Promise(r => setTimeout(r, retryDelayMs));
                    continue;
                }
                Logger.debug('verifyPasswordChallenge: no challenge published on -3/P2', {
                    adminStreamId: String(adminStreamId).slice(-30),
                    attempts: maxAttempts
                });
                return { found: false, valid: false, ts: 0 };
            }

            // Challenge is always published encrypted, so resend returns a string.
            // If we get an object, the publisher published in clear — treat as
            // malformed and reject (cannot prove password knowledge).
            if (typeof rawContent !== 'string') {
                Logger.warn('verifyPasswordChallenge: challenge entry was not encrypted; treating as invalid');
                return { found: true, valid: false, ts: 0 };
            }

            let decoded = null;
            try {
                decoded = await cryptoManager.decryptJSON(rawContent, password);
            } catch (decryptError) {
                return { found: true, valid: false, ts: 0 };
            }

            const ok = !!decoded
                && typeof decoded === 'object'
                && decoded.type === 'PASSWORD_CHALLENGE'
                && decoded.magic === PASSWORD_CHALLENGE_MAGIC;

            return {
                found: true,
                valid: !!ok,
                ts: ok && typeof decoded.ts === 'number' ? decoded.ts : 0
            };
        }

        return { found: false, valid: false, ts: 0 };
    }

    // Lives in streamr/History.js; the controller keeps the entry points
    // its callers already use.

    resendLatestContentMessages(messageStreamId, options = {}) { return this.history.resendLatestContentMessages(messageStreamId, options); }
    fetchOlderHistory(messageStreamId, partition = 0, beforeTimestamp, count = STREAM_CONFIG.LOAD_MORE_COUNT, password = null, signal = null, allowOverridesInContentPartition = false) { return this.history.fetchOlderHistory(messageStreamId, partition, beforeTimestamp, count, password, signal, allowOverridesInContentPartition); }
    fetchOlderHistoryWindowed(streamId, partition, beforeTimestamp, windowMs, signal = null, password = null) { return this.history.fetchOlderHistoryWindowed(streamId, partition, beforeTimestamp, windowMs, signal, password); }
    fetchHistoryAsync(streamId, partition, count, handler, password = null, onHistoryComplete = null, allowOverridesInContentPartition = false, opts = {}) { return this.history.fetchHistoryAsync(streamId, partition, count, handler, password, onHistoryComplete, allowOverridesInContentPartition, opts); }

    /**
     * Unsubscribe from a stream
     * @param {string} streamId - Stream ID
     */
    async unsubscribe(streamId) {
        const partitionSubs = this.subscriptions.get(streamId);

        if (partitionSubs) {
            for (const partition in partitionSubs) {
                await partitionSubs[partition].unsubscribe();
            }

            this.subscriptions.delete(streamId);
            Logger.debug('Unsubscribed from stream:', streamId);
        }
    }

    /**
     * Subscribe to a specific partition only (lazy/on-demand loading)
     * @param {string} streamId - Stream ID
     * @param {number} partition - Partition number
     * @param {Function} handler - Message handler
     * @param {string} password - Optional password for encrypted channels
     * @returns {Promise<Object>} - Subscription object
     */
    async subscribeToPartition(streamId, partition, handler, password = null) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        // Get or create partition map for this stream
        let partitionSubs = this.subscriptions.get(streamId);
        if (!partitionSubs) {
            partitionSubs = {};
            this.subscriptions.set(streamId, partitionSubs);
        }

        // Skip if already subscribed to this partition
        if (partitionSubs[partition]) {
            Logger.debug(`Already subscribed to ${streamId} partition ${partition}`);
            return partitionSubs[partition];
        }

        const messageHandler = this.messages.makeHandler(streamId, handler, password, `partition ${partition} message:`);

        const gatedChannel = await this._gatedChannelFor(streamId);
        partitionSubs[partition] = await this.client.subscribe({
            streamId: streamId,
            partition: partition,
            // Gated: prove access via the gate contract (no per-member grant)
            ...(gatedChannel ? { erc1271Contract: gatedChannel.gate.address } : {})
        }, messageHandler);

        Logger.debug(`Subscribed to ${streamId} partition ${partition}`);
        return partitionSubs[partition];
    }

    /**
     * Unsubscribe from a specific partition only
     * @param {string} streamId - Stream ID
     * @param {number} partition - Partition number
     */
    async unsubscribeFromPartition(streamId, partition) {
        const partitionSubs = this.subscriptions.get(streamId);
        
        if (partitionSubs && partitionSubs[partition]) {
            try {
                await partitionSubs[partition].unsubscribe();
                delete partitionSubs[partition];
                Logger.debug(`Unsubscribed from ${streamId} partition ${partition}`);
                
                // Clean up if no partitions remain
                if (Object.keys(partitionSubs).length === 0) {
                    this.subscriptions.delete(streamId);
                }
            } catch (error) {
                Logger.warn(`Failed to unsubscribe from partition ${partition}:`, error);
            }
        }
    }

    /**
     * Check if subscribed to a specific partition
     * @param {string} streamId - Stream ID
     * @param {number} partition - Partition number
     * @returns {boolean}
     */
    isSubscribedToPartition(streamId, partition) {
        const partitionSubs = this.subscriptions.get(streamId);
        return partitionSubs && partitionSubs[partition] !== undefined;
    }

    /**
     * Ensure media partitions are subscribed (lazy load when needed)
     * In dual-stream architecture: subscribes to ephemeralStream partitions 1 (signals) and 2 (data)
     * Uses stored media handler from subscribeToDualStream() if no handler is provided.
     * @param {string} ephemeralStreamId - Ephemeral Stream ID (ends with -2)
     * @param {Function} [handler] - Media message handler (optional, uses stored handler)
     * @param {string} [password] - Optional password (optional, uses stored password)
     */
    async ensureMediaSubscription(ephemeralStreamId, handler, password) {
        // Resolve handler/password from stored media handlers if not explicitly provided
        if (!handler) {
            const stored = this.mediaHandlers.get(ephemeralStreamId);
            if (!stored) {
                Logger.warn('ensureMediaSubscription: no handler stored for', ephemeralStreamId);
                return;
            }
            handler = stored.handler;
            if (password === undefined) password = stored.password;
        }

        const signalPartition = STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_SIGNALS;
        const dataPartition = STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_DATA;
        
        const promises = [];
        if (!this.isSubscribedToPartition(ephemeralStreamId, signalPartition)) {
            promises.push(this.subscribeToPartition(ephemeralStreamId, signalPartition, handler, password));
        }
        if (!this.isSubscribedToPartition(ephemeralStreamId, dataPartition)) {
            promises.push(this.subscribeToPartition(ephemeralStreamId, dataPartition, handler, password));
        }
        if (promises.length > 0) {
            Logger.info('Lazy-subscribing to media partitions P1+P2:', ephemeralStreamId);
            await Promise.all(promises);
        }
    }

    /**
     * Disconnect Streamr client
     */
    async disconnect() {
        if (this.client) {
            // Unsubscribe from all streams
            for (const streamId of this.subscriptions.keys()) {
                try {
                    await this.unsubscribe(streamId);
                } catch (e) {
                    Logger.warn(`Unsubscribe failed for ${streamId} during disconnect:`, e.message);
                }
            }

            try {
                await this.client.destroy();
            } catch (e) {
                Logger.warn('Streamr client destroy error (ignored):', e.message);
            }
            this.client = null;
            Logger.info('Streamr client disconnected');
        }
        
        this.address = null;
        
        // Clear DM key tracking

        // Recovered accounts are keyed by ephemeral publishers that die with the
        // session — keeping them would only grow.
        clearPublisherProofCache();

        // Pseudonyms must never outlive a session, or yesterday's can be tied
        // to today's (D2).
        clearChannelIdentities();
    }

    /**
     * Reconnect Streamr client with new RPC endpoints
     * Gets signer from authManager (avoids storing private key)
     * Note: Active subscriptions are cleared - user needs to rejoin channels
     * @returns {Promise<boolean>} - Success status
     */
    async reconnect() {
        const signer = authManager.getSigner();
        if (!signer) {
            Logger.warn('Cannot reconnect: no signer available from authManager');
            return false;
        }

        try {
            Logger.info('Reconnecting Streamr client with new RPC endpoints...');
            
            // Disconnect current client (clears subscriptions)
            await this.disconnect();
            
            // Re-initialize with fresh signer (will use new RPC endpoints)
            await this.init(signer);
            
            Logger.info('Streamr client reconnected successfully');
            return true;
        } catch (error) {
            Logger.error('Failed to reconnect Streamr client:', error);
            return false;
        }
    }

    // ==================== Storage Methods ====================

    /**
     * Enable storage for a MESSAGE STREAM only
     * In dual-stream architecture, storage is ONLY enabled for messageStream (-1)
     * The ephemeralStream (-2) is intentionally NOT stored for privacy
     * 
     * @param {string} messageStreamId - Message Stream ID (must end with -1)
     * @param {Object} options - Storage options
     * @param {string} options.storageProvider - 'streamr' or 'custom' (default: from config)
     * @param {string} [options.customStorageAddress] - EVM address of the custom storage node (required if provider is 'custom')
     * @param {number} options.storageDays - Retention days (default: 180)
     * @param {number} retries - Number of retry attempts
     * @returns {Promise<{success: boolean, provider: string, storageDays: number|null, retentionApplied: boolean}>}
     *          `success` covers the storage node assignment; `storageDays` is
     *          the retention that ACTUALLY landed, null when it did not.
     */
    async enableStorage(messageStreamId, options = {}, retries = 7) {
        if (!this.client) {
            throw new Error('Client not initialized');
        }

        // Safety check: only enable storage for streams that should persist
        // (-1 message, -3 admin, -4 keys). The keys stream MUST persist — a
        // joiner pulls KEY_ANNOUNCEs from storage, and requests/wraps survive
        // there until the counterpart comes online. Only -2 stays unstored.
        if (!isMessageStream(messageStreamId) && !isAdminStream(messageStreamId) && !isKeysStream(messageStreamId)) {
            Logger.warn('enableStorage called on non-persistent stream, ignoring:', messageStreamId);
            return { success: false, provider: null, storageDays: null };
        }

        const providerId = options.storageProvider || STREAM_CONFIG.DEFAULT_STORAGE_PROVIDER;
        const providerConfig = providerId === 'custom'
            ? STREAM_CONFIG.STORAGE_PROVIDERS.CUSTOM
            : STREAM_CONFIG.STORAGE_PROVIDERS.STREAMR;

        const nodeAddress = providerId === 'custom'
            ? providerConfig.getNodeAddress(options.customStorageAddress)
            : providerConfig.getNodeAddress();

        if (!nodeAddress) {
            Logger.error('Missing storage node address for provider:', providerId);
            return { success: false, provider: providerId, storageDays: null };
        }

        if (providerId === 'custom' && !/^0x[a-fA-F0-9]{40}$/.test(nodeAddress)) {
            Logger.error('Invalid custom storage node address:', nodeAddress);
            return { success: false, provider: providerId, storageDays: null };
        }

        if (providerId === 'custom') {
            try {
                await this.validateCustomStorageNodeAddress(nodeAddress);
            } catch (validationError) {
                Logger.error('Custom storage node validation failed:', validationError.message);
                return { success: false, provider: providerId, storageDays: null };
            }
        }

        const storageDays = providerConfig.supportsTTL
            ? (options.storageDays || providerConfig.defaultDays)
            : null;

        Logger.debug('Enabling storage:', {
            streamId: messageStreamId,
            provider: providerId,
            nodeAddress: nodeAddress.slice(0, 12) + '...',
            storageDays
        });

        try {
            await executeWithRetry('enableStorage', async () => {
                const stream = await this.client.getStream(messageStreamId);
                await stream.addToStorageNode(nodeAddress);
                try { options.onProgress?.(); } catch (_) { /* progress callback errors must not break flow */ }
                Logger.info('Storage enabled:', { stream: messageStreamId, provider: providerId });
            }, { maxRetries: retries });
        } catch (error) {
            Logger.error('All storage attempts failed for:', messageStreamId);
            return { success: false, provider: providerId, storageDays: null, retentionApplied: false };
        }

        // Retention is a SECOND transaction and fails on its own. It gets its
        // own retry, and when it never lands the caller is told so instead of
        // being handed back the value it asked for.
        let retentionApplied = false;
        if (storageDays && providerConfig.supportsTTL) {
            try {
                await executeWithRetry('setStorageDayCount', async () => {
                    const stream = await this.client.getStream(messageStreamId);
                    await stream.setStorageDayCount(storageDays);
                }, { maxRetries: retries });
                retentionApplied = true;
                Logger.debug('Storage days set to:', storageDays);
            } catch (ttlError) {
                Logger.warn('Retention NOT applied on', messageStreamId, '— the stream keeps the node default:', ttlError.message);
            } finally {
                try { options.onProgress?.(); } catch (_) { /* ignore */ }
            }
        }

        return {
            success: true,
            provider: providerId,
            storageDays: retentionApplied ? storageDays : null,
            retentionApplied,
            nodeAddress: nodeAddress
        };
    }

    /**
     * Add a single storage node to a stream (no retention change unless `storageDays` provided).
     * Used by the Channel Settings UI to grow storage redundancy on existing channels
     * without going through the full `enableStorage` create-time flow.
     *
     * @param {string} streamId - Stored stream only: -1 message, -3 admin, -4 keys
     * @param {Object} options
     * @param {string} [options.storageProvider='streamr'] - 'streamr' or 'custom'
     * @param {string} [options.customStorageAddress] - EVM address (required if provider is 'custom')
     * @param {number} [options.storageDays] - Optional retention to set after add
     * @returns {Promise<{success: boolean, nodeAddress: string|null, error?: string}>}
     */
    async addStorageNodeToStream(streamId, options = {}) {
        if (!this.client) {
            throw new Error('Client not initialized');
        }

        if (!isMessageStream(streamId) && !isAdminStream(streamId) && !isKeysStream(streamId)) {
            return { success: false, nodeAddress: null, error: 'Storage not allowed on this stream' };
        }

        const providerId = options.storageProvider || STREAM_CONFIG.DEFAULT_STORAGE_PROVIDER;
        const providerConfig = providerId === 'custom'
            ? STREAM_CONFIG.STORAGE_PROVIDERS.CUSTOM
            : STREAM_CONFIG.STORAGE_PROVIDERS.STREAMR;

        const nodeAddress = providerId === 'custom'
            ? providerConfig.getNodeAddress(options.customStorageAddress)
            : providerConfig.getNodeAddress();

        if (!nodeAddress) {
            return { success: false, nodeAddress: null, error: 'Missing storage node address' };
        }

        if (!/^0x[a-fA-F0-9]{40}$/.test(nodeAddress)) {
            return { success: false, nodeAddress, error: 'Invalid storage node address' };
        }

        if (providerId === 'custom') {
            try {
                await this.validateCustomStorageNodeAddress(nodeAddress);
            } catch (validationError) {
                return { success: false, nodeAddress, error: validationError.message };
            }
        }

        try {
            const stream = await this.client.getStream(streamId);
            await stream.addToStorageNode(nodeAddress);
            if (typeof options.storageDays === 'number' && options.storageDays > 0 && providerConfig.supportsTTL) {
                try {
                    await stream.setStorageDayCount(options.storageDays);
                } catch (ttlError) {
                    Logger.warn('addStorageNodeToStream: could not set storage days:', ttlError.message);
                }
            }
            Logger.info('Storage node added:', { stream: streamId, nodeAddress });
            return { success: true, nodeAddress };
        } catch (error) {
            Logger.error('Failed to add storage node:', error.message);
            return { success: false, nodeAddress, error: error.message };
        }
    }

    /**
     * Remove a storage node from a stream.
     *
     * @param {string} streamId - Stream ID
     * @param {string} nodeAddress - EVM address of the storage node to remove
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    async removeStorageFromStream(streamId, nodeAddress) {
        if (!this.client) {
            throw new Error('Client not initialized');
        }

        if (!nodeAddress || !/^0x[a-fA-F0-9]{40}$/.test(nodeAddress)) {
            return { success: false, error: 'Invalid storage node address' };
        }

        try {
            const stream = await this.client.getStream(streamId);
            await stream.removeFromStorageNode(nodeAddress);
            Logger.info('Storage node removed:', { stream: streamId, nodeAddress });
            return { success: true };
        } catch (error) {
            Logger.error('Failed to remove storage node:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * Update storage days for a stream (only works with Streamr storage node)
     * @param {string} messageStreamId - Message Stream ID
     * @param {number} days - Number of days to retain messages
     * @returns {Promise<boolean>} - Success status
     */
    async setStorageDays(messageStreamId, days) {
        if (!this.client) {
            throw new Error('Client not initialized');
        }
        
        try {
            const stream = await this.client.getStream(messageStreamId);
            await stream.setStorageDayCount(days);
            Logger.info('Storage days updated:', { streamId: messageStreamId, days });
            return true;
        } catch (error) {
            Logger.error('Failed to set storage days:', error.message);
            return false;
        }
    }

    /**
     * Get current storage days for a stream
     * @param {string} messageStreamId - Message Stream ID
     * @returns {Promise<number|null>} - Storage days or null
     */
    async getStorageDays(messageStreamId) {
        if (!this.client) {
            throw new Error('Client not initialized');
        }
        
        try {
            const stream = await this.client.getStream(messageStreamId);
            const days = await stream.getStorageDayCount();
            return days;
        } catch (error) {
            Logger.warn('Failed to get storage days:', error.message);
            return null;
        }
    }

    /**
     * Fetch historical messages from MESSAGE STREAM
     * In dual-stream architecture, only messageStream has storage
     * 
     * @param {string} messageStreamId - Message Stream ID (must end with -1)
     * @param {number} partition - Partition number (should be 0 for messages)
     * @param {number} count - Number of messages to fetch
     * @returns {Promise<Array>} - Array of message contents
     */
    async fetchHistory(messageStreamId, partition = 0, count = STREAM_CONFIG.INITIAL_MESSAGES) {
        if (!this.client) {
            throw new Error('Client not initialized');
        }
        
        const messages = [];
        
        try {
            // Streamr SDK resend for partitioned history:
            // pass stream definition as first arg: { streamId, partition }
            const resend = await this.client.resend(
                { streamId: messageStreamId, partition: partition },
                { last: count }
            );
            
            // Manual iteration to catch decrypt errors per-message
            const iterator = resend[Symbol.asyncIterator]();
            let iteratorDone = false;
            let decryptErrors = 0;
            
            while (!iteratorDone) {
                try {
                    const result = await iterator.next();
                    iteratorDone = result.done;
                    if (!iteratorDone) {
                        messages.push(result.value.content);
                    }
                } catch (iterError) {
                    if (iterError.code === 'DECRYPT_ERROR' || iterError.message?.includes('encryption key')) {
                        decryptErrors++;
                        continue;
                    }
                    Logger.warn('fetchHistory iteration error:', iterError.message);
                    continue;
                }
            }
            
            if (decryptErrors > 0) {
                Logger.debug(`fetchHistory: skipped ${decryptErrors} messages (decrypt error)`);
            }
            Logger.debug(`Fetched ${messages.length} messages from partition ${partition}`);
            return messages;
        } catch (error) {
            Logger.warn('History fetch error:', error.message);
            return messages;
        }
    }

    /**
     * Fetch history from a specific partition with full message metadata.
     * Used for sync to get publisherId for sender verification.
     * @param {string} streamId - Stream ID
     * @param {number} partition - Partition number
     * @param {number} limit - Max messages to fetch
     * @returns {Promise<Array<{content: Object, publisherId: string, timestamp: number}>>}
     */
    async fetchPartitionHistory(streamId, partition, limit = 10) {
        if (!this.client) {
            throw new Error('Client not initialized');
        }

        // Single resend pass with per-message error handling.
        const collectOnce = async () => {
            const messages = [];

            Logger.info(`fetchPartitionHistory: resending from ${streamId} partition ${partition}, last ${limit}`);

            // Streamr SDK v103+: first arg is { streamId, partition }, second is resend options
            const resend = await this.client.resend(
                { streamId: streamId, partition: partition },
                { last: limit }
            );

            // Manual iteration to catch errors per-message
            const iterator = resend[Symbol.asyncIterator]();
            let iteratorDone = false;

            while (!iteratorDone) {
                try {
                    const result = await iterator.next();
                    iteratorDone = result.done;

                    if (!iteratorDone && result.value) {
                        const msg = result.value;
                        // Get publisherId - v103+ uses getPublisherId() method
                        const publisherId = typeof msg.getPublisherId === 'function'
                            ? msg.getPublisherId()
                            : msg.publisherId;

                        // Sequence number disambiguates messages published in the
                        // same millisecond (e.g. sync blob chunks) for dedup keys
                        const sequenceNumber = typeof msg.getSequenceNumber === 'function'
                            ? msg.getSequenceNumber()
                            : msg.sequenceNumber;

                        messages.push({
                            content: msg.content,
                            publisherId: publisherId,
                            timestamp: msg.timestamp,
                            sequenceNumber: sequenceNumber,
                            signature: msg.signature
                        });
                    }
                } catch (iterError) {
                    Logger.warn('fetchPartitionHistory: iteration error', iterError.message, iterError.code);
                    // Continue to next message
                    continue;
                }
            }

            Logger.info(`fetchPartitionHistory: ${messages.length} messages from partition ${partition}`);
            return messages;
        };

        // Identity key for cross-pass dedup. sequenceNumber (or signature as
        // fallback) disambiguates same-millisecond messages.
        const messageKey = (msg) =>
            `${msg.publisherId}:${msg.timestamp}:${msg.sequenceNumber ?? msg.signature ?? ''}`;

        try {
            const first = await collectOnce();
            if (first.length >= limit) {
                return first;
            }

            // A short result may be a silently-truncated range resend (WS drop
            // mid-iteration returns a short response with NO error — known
            // storage node behavior) or genuine exhaustion. Confirm with a
            // second pass and union both by message identity.
            Logger.info(`fetchPartitionHistory: short result (${first.length}/${limit}), running confirmation pass`);
            let second = [];
            try {
                second = await collectOnce();
            } catch (confirmError) {
                Logger.warn('fetchPartitionHistory: confirmation pass failed', confirmError.message);
            }

            if (!second.length) {
                return first;
            }

            const byKey = new Map();
            for (const msg of [...first, ...second]) {
                byKey.set(messageKey(msg), msg);
            }
            const union = Array.from(byKey.values()).sort((a, b) => a.timestamp - b.timestamp);

            if (union.length !== first.length) {
                Logger.warn(`fetchPartitionHistory: confirmation pass recovered ${union.length - first.length} missing messages`);
            }
            return union;
        } catch (error) {
            Logger.error('fetchPartitionHistory error:', error);
            return [];
        }
    }

    /**
     * Subscribe to stream with historical resend
     * First subscribes for real-time, then attempts to fetch history separately
     * Falls back gracefully if history fetch fails (e.g., CORS issues on localhost)
     * @param {string} streamId - Stream ID
     * @param {number} partition - Partition number
     * @param {Function} handler - Message handler
     * @param {number} historyCount - Number of historical messages to fetch (0 = no history)
     * @param {string} password - Password for encrypted channels (optional)
     * @returns {Promise<Object>} - Subscription object
     */
    async subscribeWithHistory(streamId, partition, handler, historyCount = STREAM_CONFIG.INITIAL_MESSAGES, password = null, onHistoryComplete = null, allowOverridesInContentPartition = false) {
        if (!this.client) {
            throw new Error('Client not initialized');
        }
        
        const messageHandler = this.messages.makeHandler(streamId, handler, password, 'message:');
        const errorHandler = async (error) => {
            // Decrypt errors for missing GroupKeys
            if (error.code === 'DECRYPT_ERROR' || error.message?.includes('encryption key')) {
                // Nothing to recover any more. Everything Pombo publishes now
                // goes out with encryptionType NONE and is sealed at the app
                // layer, so a DECRYPT_ERROR means an SDK-encrypted message we
                // have no key for — foreign traffic, or history from before the
                // hardcoded key was removed. Both are correctly ignored.
                Logger.debug('SDK decrypt error (not ours):', error.message?.substring(0, 100));
            } else {
                Logger.warn('Subscription error:', error.message || error);
            }
        };

        // First, subscribe for real-time messages (this always works)
        const gatedChannel = await this._gatedChannelFor(streamId);
        const subscription = await this.client.subscribe(
            {
                streamId: streamId,
                partition: partition,
                // Gated: prove access via the gate contract (no per-member grant)
                ...(gatedChannel ? { erc1271Contract: gatedChannel.gate.address } : {})
            },
            messageHandler,
            errorHandler
        );
        
        Logger.debug(`Subscribed to`, streamId, 'partition', partition);
        
        // Only fetch history if historyCount > 0 (skip for ephemeral partitions like control)
        if (historyCount > 0) {
            // Fetch history separately (may fail due to CORS on localhost)
            // This is non-blocking and fails gracefully
            // Pass password for decryption of encrypted channels
            this.fetchHistoryAsync(streamId, partition, historyCount, handler, password, onHistoryComplete, allowOverridesInContentPartition);
        } else if (onHistoryComplete) {
            // No history to fetch, signal completion immediately
            try { onHistoryComplete({ loaded: 0, requested: 0 }); } catch (e) { Logger.warn('onHistoryComplete error:', e); }
        }
        
        return subscription;
    }
    

    /**
     * Subscribe to dual-stream channel (message + ephemeral streams)
     * 
    * Message Stream (-1):
    *   - Partition 0: Content messages (WITH history)
    *   - Partition 1: Control overrides edit/delete (WITH history)
     * 
    * Ephemeral Stream (-2):
    *   - Partition 0: Control/metadata (presence, typing) - NO history
    *   - Partition 1: Media signals (P2P coordination) - NO history
    *   - Partition 2: Media data (binary chunks) - NO history
     * 
     * @param {string} messageStreamId - Message Stream ID (ends with -1)
     * @param {string} ephemeralStreamId - Ephemeral Stream ID (ends with -2)
    * @param {Object} handlers - { onMessage, onOverride, onControl, onMedia }
     * @param {string} password - Password for encrypted channels (optional)
     * @param {number} historyCount - Number of historical messages to fetch
     * @returns {Promise<boolean>} - Success
     */
    async subscribeToDualStream(messageStreamId, ephemeralStreamId, handlers, password = null, historyCount = STREAM_CONFIG.INITIAL_MESSAGES, onHistoryComplete = null) {
        if (!this.client) {
            throw new Error('Streamr client not initialized');
        }

        // Validate stream IDs
        if (!isMessageStream(messageStreamId)) {
            Logger.warn('Invalid messageStreamId (should end with -1):', messageStreamId);
        }
        if (!isEphemeralStream(ephemeralStreamId)) {
            Logger.warn('Invalid ephemeralStreamId (should end with -2):', ephemeralStreamId);
        }

        const shouldTrackHistory = !!onHistoryComplete && historyCount > 0;
        const trackedHistoryPartitions = [];
        if (shouldTrackHistory && handlers.onMessage) {
            trackedHistoryPartitions.push(STREAM_CONFIG.MESSAGE_STREAM.MESSAGES);
        }
        if (shouldTrackHistory && handlers.onOverride) {
            trackedHistoryPartitions.push(STREAM_CONFIG.MESSAGE_STREAM.CONTROL);
        }

        let pendingHistoryCompletions = trackedHistoryPartitions.length;
        let historyCompleteSignaled = false;
        const completedHistoryPartitions = new Set();
        // Aggregate per-partition stats so the final `onHistoryComplete` can
        // tell callers whether the storage resend was exhaustive (loaded <
        // requested) — needed to flip `hasMoreHistory=false` deterministically
        // even when the iterator never signals `done` (e.g. legacy single-
        // partition channels).
        const historyStats = {
            content: { loaded: 0, requested: 0 },
            control: { loaded: 0, requested: 0 },
        };

        const maybeSignalHistoryComplete = async () => {
            if (historyCompleteSignaled || !onHistoryComplete) return;
            if (pendingHistoryCompletions === 0) {
                historyCompleteSignaled = true;
                try {
                    await onHistoryComplete({
                        contentLoaded: historyStats.content.loaded,
                        contentRequested: historyStats.content.requested,
                        controlLoaded: historyStats.control.loaded,
                        controlRequested: historyStats.control.requested,
                    });
                } catch (e) { Logger.warn('onHistoryComplete error:', e); }
            }
        };

        const completeHistoryPartition = async (partition, partitionLabel, stats) => {
            if (!shouldTrackHistory) return;
            if (completedHistoryPartitions.has(partition)) return;
            completedHistoryPartitions.add(partition);
            pendingHistoryCompletions = Math.max(0, pendingHistoryCompletions - 1);
            if (stats && partition === STREAM_CONFIG.MESSAGE_STREAM.MESSAGES) {
                historyStats.content = {
                    loaded: stats.loaded ?? 0,
                    requested: stats.requested ?? 0,
                };
            } else if (stats && partition === STREAM_CONFIG.MESSAGE_STREAM.CONTROL) {
                historyStats.control = {
                    loaded: stats.loaded ?? 0,
                    requested: stats.requested ?? 0,
                };
            }
            Logger.debug(`History complete for ${partitionLabel}. Pending: ${pendingHistoryCompletions}`);
            await maybeSignalHistoryComplete();
        };

        const makePartitionHistoryCallback = (partition, partitionLabel) => {
            if (!shouldTrackHistory) return null;
            let called = false;
            return async (stats) => {
                if (called) return;
                called = true;
                await completeHistoryPartition(partition, partitionLabel, stats);
            };
        };

        try {
            // 1. Subscribe to MESSAGE STREAM (with storage)
            let msgSubs = this.subscriptions.get(messageStreamId);
            if (!msgSubs) {
                msgSubs = {};
                this.subscriptions.set(messageStreamId, msgSubs);
            }

            // Partition 0: Content messages WITH history
            if (handlers.onMessage) {
                if (!msgSubs[STREAM_CONFIG.MESSAGE_STREAM.MESSAGES]) {
                    Logger.debug('Subscribing to messageStream partition 0 (content) with history');
                    msgSubs[STREAM_CONFIG.MESSAGE_STREAM.MESSAGES] = await this.subscribeWithHistory(
                        messageStreamId,
                        STREAM_CONFIG.MESSAGE_STREAM.MESSAGES,
                        handlers.onMessage,
                        historyCount,
                        password,
                        makePartitionHistoryCallback(STREAM_CONFIG.MESSAGE_STREAM.MESSAGES, 'messageStream P0'),
                        handlers.allowOverridesInContentPartition === true
                    );
                } else {
                    await completeHistoryPartition(STREAM_CONFIG.MESSAGE_STREAM.MESSAGES, 'messageStream P0 (already subscribed)');
                }
            }

            // Partition 1: Control overrides WITH history
            if (handlers.onOverride) {
                if (!msgSubs[STREAM_CONFIG.MESSAGE_STREAM.CONTROL]) {
                    Logger.debug('Subscribing to messageStream partition 1 (control overrides) with history');
                    msgSubs[STREAM_CONFIG.MESSAGE_STREAM.CONTROL] = await this.subscribeWithHistory(
                        messageStreamId,
                        STREAM_CONFIG.MESSAGE_STREAM.CONTROL,
                        handlers.onOverride,
                        historyCount,
                        password,
                        makePartitionHistoryCallback(STREAM_CONFIG.MESSAGE_STREAM.CONTROL, 'messageStream P1'),
                        false
                    );
                } else {
                    await completeHistoryPartition(STREAM_CONFIG.MESSAGE_STREAM.CONTROL, 'messageStream P1 (already subscribed)');
                }
            }

            Logger.info('Subscribed to message stream:', messageStreamId);

            // 2. Subscribe to EPHEMERAL STREAM (no storage)
            if (!this.subscriptions.has(ephemeralStreamId)) {
                const ephSubs = {};
                
                // Partition 0: Control (presence, typing) - NO history
                if (handlers.onControl) {
                    Logger.debug('Subscribing to ephemeralStream partition 0 (control) - no history');
                    ephSubs[STREAM_CONFIG.EPHEMERAL_STREAM.CONTROL] = await this.subscribeWithHistory(
                        ephemeralStreamId,
                        STREAM_CONFIG.EPHEMERAL_STREAM.CONTROL,
                        handlers.onControl,
                        0, // NO history - ephemeral
                        password,
                        null,
                        false
                    );
                }
                
                // Store media handler for lazy P1/P2 subscription via ensureMediaSubscription()
                // Partitions 1 (signals) and 2 (data) are NOT subscribed here — they are
                // subscribed on-demand when a download starts or a file is sent.
                if (handlers.onMedia) {
                    this.mediaHandlers.set(ephemeralStreamId, { handler: handlers.onMedia, password });
                    Logger.debug('Media handler stored for lazy P1/P2 subscription:', ephemeralStreamId);
                }
                
                this.subscriptions.set(ephemeralStreamId, ephSubs);
                Logger.info('Subscribed to ephemeral stream:', ephemeralStreamId);
            }

            // If no history callbacks were registered, complete immediately.
            await maybeSignalHistoryComplete();

            return true;
        } catch (error) {
            Logger.error('Failed to subscribe to dual-stream:', error);
            throw error;
        }
    }

    /**
     * Unsubscribe from dual-stream channel
     * @param {string} messageStreamId - Message Stream ID
     * @param {string} ephemeralStreamId - Ephemeral Stream ID
     */
    async unsubscribeFromDualStream(messageStreamId, ephemeralStreamId) {
        // Clean up stored media handler
        this.mediaHandlers.delete(ephemeralStreamId);

        await Promise.allSettled([
            this.unsubscribe(messageStreamId),
            this.unsubscribe(ephemeralStreamId)
        ]);

        // Rotate the pseudonym (D2). THIS is the right place and the only one:
        // it is where the channel is really left, both streams and all. Doing it
        // from a UI handler would re-pseudonymise on a tab switch, mid-transfer,
        // while peers still hold the publisher they were given.
        //
        // Deliberately NOT in unsubscribeMediaPartitions(): that keeps P0 alive
        // for a backgrounded channel, which is exactly the case that must keep
        // its identity.
        dropChannelIdentity(messageStreamId);

        Logger.debug('Unsubscribed from dual-stream:', messageStreamId);
    }

    /**
     * Unsubscribe only from media partitions (P1 signals + P2 data), keeping P0 control alive.
     * Used when no active media transfers remain on a background channel.
     * @param {string} ephemeralStreamId - Ephemeral Stream ID (ends with -2)
     */
    async unsubscribeMediaPartitions(ephemeralStreamId) {
        await Promise.allSettled([
            this.unsubscribeFromPartition(ephemeralStreamId, STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_SIGNALS),
            this.unsubscribeFromPartition(ephemeralStreamId, STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_DATA)
        ]);
        Logger.debug('Unsubscribed from media partitions P1+P2:', ephemeralStreamId);
    }

    // ==================== End Storage/Subscription Methods ====================
}

// Export singleton instance and config
export const streamrController = new StreamrController();
export { STREAM_CONFIG, deriveEphemeralId, deriveMessageId, deriveAdminId, deriveKeysId, isMessageStream, isEphemeralStream, isAdminStream, isKeysStream };
