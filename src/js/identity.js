/**
 * Identity Module
 * Handles identity verification, ENS resolution, and trusted contacts
 * 
 * Trust Levels:
 * - 0: Unknown (signature valid but not in contacts)
 * - 1: ENS Verified (has ENS name)
 * - 2: Trusted Contact (manually added)
 * - -1: Invalid (signature failed)
 */

import { authManager } from './auth.js';
import { secureStorage } from './secureStorage.js';
import { Logger } from './logger.js';
import { cryptoWorkerPool } from './workers/cryptoWorkerPool.js';
import { CONFIG } from './config.js';
import { applyAccount } from './publisherProof.js';

// ENS cache duration
const ENS_CACHE_DURATION = CONFIG.identity.ensCacheDurationMs;

// Shorter cache for null results — retry sooner (ENS records may be propagating)
const ENS_NULL_CACHE_DURATION = CONFIG.identity.ensNullCacheDurationMs;

// Message timestamp tolerance - prevents replay attacks
const MESSAGE_TIMESTAMP_TOLERANCE = CONFIG.identity.messageTimestampToleranceMs;

// Ethereum mainnet providers for ENS (fallback order)
const ENS_PROVIDER_URLS = CONFIG.network.ensProviderUrls;

// How long to skip a provider after it fails
const PROVIDER_COOLDOWN_MS = CONFIG.identity.providerCooldownMs;

// Gap between background queue lookups — keeps a busy channel from bursting
const ENS_QUEUE_GAP_MS = CONFIG.identity.ensQueueGapMs;

class IdentityManager {
    constructor() {
        this.ensCache = new Map();
        this.ensAvatarCache = new Map(); // address -> { url: string|null, timestamp: number }
        this.trustedContacts = new Map();
        this.onTrustedContactsChanged = null;
        this.ensProviders = [];
        this.providerHealth = new Map(); // url -> { failedAt: timestamp }
        this.pendingENSLookups = new Map(); // address -> Promise (in-flight dedup)
        this.pendingAvatarLookups = new Map(); // address -> Promise (in-flight dedup)
        this.username = null;
        this.MAX_ENS_CACHE_SIZE = CONFIG.identity.maxEnsCacheSize;

        // Background ENS resolution (see queueENSResolution). Kept out of the
        // verification path so seeing a message never triggers an RPC call.
        this._ensQueue = new Set();     // pending addresses (lowercased)
        this._ensQueueRunning = false;
        this.onENSResolved = null;      // (address, name) => void — UI patch hook
    }

    /**
     * Initialize identity manager
     */
    async init() {
        this.loadTrustedContacts();
        this.loadENSCache();
        this.loadUsername();
        
        // Clear null cache entries on startup to give providers a fresh chance
        // (previous session may have cached nulls due to broken providers)
        let nullsCleared = 0;
        for (const [key, value] of this.ensCache) {
            if (!value.name) {
                this.ensCache.delete(key);
                nullsCleared++;
            }
        }
        if (nullsCleared > 0) {
            Logger.info(`ENS: Cleared ${nullsCleared} stale null cache entries`);
        }
        if (this.ensCache.size > 0) {
            Logger.info(`ENS: ${this.ensCache.size} cached names loaded`);
        }

        // Initialize ENS providers (Ethereum mainnet, multiple for fallback)
        // staticNetwork skips eth_chainId probe; batchMaxCount:1 avoids batch rejections on free tiers
        this.ensProviders = [];
        this.providerHealth = new Map();
        this.pendingENSLookups = new Map();
        const mainnet = ethers.Network.from('mainnet');
        for (const url of ENS_PROVIDER_URLS) {
            try {
                const provider = new ethers.JsonRpcProvider(url, mainnet, {
                    staticNetwork: mainnet,
                    batchMaxCount: 1
                });
                provider._ensUrl = url; // tag for health tracking
                this.ensProviders.push(provider);
            } catch (error) {
                Logger.warn('Failed to create ENS provider:', url, error);
            }
        }
        Logger.info(`ENS: ${this.ensProviders.length} providers initialized`);
    }

    // ==================== USERNAME ====================

    /**
     * Get the current username
     * @returns {string|null}
     */
    getUsername() {
        return this.username;
    }

    /**
     * Set the username
     * @param {string} name - Username to set
     */
    async setUsername(name) {
        const trimmed = name ? name.trim() : null;
        this.username = trimmed ? trimmed.substring(0, 18) : null;
        return this.saveUsername();
    }

    /**
     * Save username to secure storage
     */
    async saveUsername() {
        if (!secureStorage.isStorageUnlocked()) {
            return false;
        }
        await secureStorage.setUsername(this.username);
        return true;
    }

    /**
     * Load username from secure storage
     */
    loadUsername() {
        try {
            if (!secureStorage.isStorageUnlocked()) {
                this.username = null;
                return;
            }
            this.username = secureStorage.getUsername() || null;
        } catch (error) {
            Logger.error('Failed to load username:', error);
        }
    }

    // ==================== MESSAGE SIGNING ====================

    /**
     * Create signed message payload
     * @param {string} text - Message text
     * @param {string} channelId - Channel ID for context
     * @param {Object|null} replyTo - Reply context (optional)
     * @returns {Promise<Object>} - Signed message object
     */
    async createSignedMessage(text, channelId, replyTo = null) {
        return applyAccount({
            type: 'text', // Explicit type for history filtering
            id: this.generateMessageId(),
            text: text,
            senderName: this.username || null,
            timestamp: Date.now(),
            replyTo: replyTo // Reply context (null if not a reply)
        }, authManager.getAddress());
    }

    /**
     * Create a signed chunked-image manifest payload.
     * @param {Object} input
     * @param {string} input.imageId
     * @param {string} input.channelId
     * @param {string} input.originalMime
     * @param {string} input.finalMime
     * @param {number} input.finalSizeBytes
     * @param {number} input.chunkCount
     * @param {string[]} input.chunkHashes
     * @param {string} input.assembledSha256
     * @param {boolean} [input.preservedOriginal=false]
     * @param {string|null} [input.convertedTo=null]
     * @param {number|null} [input.qualityUsed=null]
     * @returns {Promise<Object>}
     */
    async createSignedImageManifest({
        imageId,
        channelId,
        originalMime,
        finalMime,
        finalSizeBytes,
        chunkCount,
        chunkHashes,
        assembledSha256,
        preservedOriginal = false,
        convertedTo = null,
        qualityUsed = null
    }) {
        return applyAccount({
            type: 'image',
            transport: 'chunked',
            v: 2,
            id: this.generateMessageId(),
            imageId,
            senderName: this.username || null,
            timestamp: Date.now(),
            originalMime,
            finalMime,
            finalSizeBytes,
            chunkCount,
            chunkHashes,
            assembledSha256,
            preservedOriginal: !!preservedOriginal,
            convertedTo: convertedTo || null,
            qualityUsed: Number.isFinite(qualityUsed) ? qualityUsed : null
        }, authManager.getAddress());
    }

    /**
     * Create a signed file (file_announce) manifest.
     *
     * The announcement carries the piece hashes every downloader verifies against,
     * so those hashes must be covered by the signature. Signing an empty-text
     * message and attaching the metadata afterwards authenticates nothing about
     * the file.
     *
     * Note there is deliberately no whole-file hash: pieceHashes + pieceCount +
     * fileSize already commit to the content, and crypto.subtle.digest cannot be
     * fed incrementally, so a whole-file digest would force the entire file into
     * memory on the sender.
     *
     * @param {Object} input
     * @param {string} input.channelId - Channel ID
     * @param {Object} input.metadata - File metadata from the hashing worker
     * @returns {Promise<Object>}
     */
    async createSignedFileManifest({ channelId, metadata }) {
        return applyAccount({
            type: 'file_announce',
            v: 2,
            id: this.generateMessageId(),
            senderName: this.username || null,
            timestamp: Date.now(),
            metadata,
            replyTo: null
        }, authManager.getAddress());
    }

    /**
     * Create deterministic hash for file (file_announce) manifests.
     *
     * Fields are listed explicitly rather than hashing the metadata object whole:
     * it fixes the canonical order (so other clients can reproduce it byte for
     * byte) and stops a future field from silently changing the hash.
     *
     * @param {Object} input
     * @returns {string}
     */
    createFileManifestHash({ id, sender, timestamp, channelId, metadata }) {
        const data = JSON.stringify({
            protocol: 'POMBO',
            version: 2,
            type: 'file_announce',
            id,
            sender: sender.toLowerCase(),
            timestamp,
            channelId,
            fileId: metadata?.fileId ?? null,
            fileName: metadata?.fileName ?? null,
            fileSize: metadata?.fileSize ?? null,
            fileType: metadata?.fileType ?? null,
            pieceCount: metadata?.pieceCount ?? null,
            pieceHashes: metadata?.pieceHashes ?? []
        });
        return ethers.keccak256(ethers.toUtf8Bytes(data));
    }

    /**
     * Create a signed storage-file (storage_file_announce) manifest.
     *
     * Persistent File Sharing: chunks already live on the channel's storage
     * nodes when this is published; the manifest is what receivers trust to
     * locate them (partition layout, timestamps window) and to decrypt them
     * (encSalt on password channels), so all of it is under the signature.
     *
     * Unlike the mesh manifest there are no piece hashes: integrity comes from
     * AES-GCM authentication on sealed channels. transferId + sizes + chunk
     * layout are signed so a forged announce cannot redirect a download.
     *
     * @param {Object} input
     * @param {string} input.channelId - Channel ID
     * @param {Object} input.metadata - Storage transfer metadata
     * @param {string|null} [input.id] - Reuse a message id (the sender's optimistic
     *   bubble is pushed at upload start; signing at completion must keep the same
     *   id so the published echo dedupes against it)
     * @returns {Promise<Object>}
     */
    async createSignedStorageFileManifest({ channelId, metadata, id = null }) {
        return applyAccount({
            type: 'storage_file_announce',
            v: 1,
            id: id || this.generateMessageId(),
            senderName: this.username || null,
            timestamp: Date.now(),
            metadata,
            replyTo: null
        }, authManager.getAddress());
    }

    /**
     * Deterministic hash for storage-file (storage_file_announce) manifests.
     * Fields listed explicitly to fix the canonical order — same rule as
     * createFileManifestHash.
     *
     * @param {Object} input
     * @returns {string}
     */
    createStorageFileManifestHash({ id, sender, timestamp, channelId, metadata }) {
        const data = JSON.stringify({
            protocol: 'POMBO',
            version: 1,
            type: 'storage_file_announce',
            id,
            sender: sender.toLowerCase(),
            timestamp,
            channelId,
            transferId: metadata?.transferId ?? null,
            fileName: metadata?.fileName ?? null,
            fileType: metadata?.fileType ?? null,
            originalSize: metadata?.originalSize ?? null,
            compressedSize: metadata?.compressedSize ?? null,
            compression: metadata?.compression ?? null,
            totalChunks: metadata?.totalChunks ?? null,
            chunkDataSize: metadata?.chunkDataSize ?? null,
            chunkPartitions: metadata?.chunkPartitions ?? null,
            firstChunkPartition: metadata?.firstChunkPartition ?? null,
            firstChunkTs: metadata?.firstChunkTs ?? null,
            lastChunkTs: metadata?.lastChunkTs ?? null,
            storedChunks: metadata?.storedChunks ?? null,
            encSalt: metadata?.encSalt ?? null
        });
        return ethers.keccak256(ethers.toUtf8Bytes(data));
    }

    /**
     * Create deterministic message hash for signing/verification
     * Uses keccak256 for cryptographic security and collision resistance
     * @param {string} id - Message ID
     * @param {string} text - Message content
     * @param {string} sender - Sender address
     * @param {number} timestamp - Message timestamp
     * @param {string} channelId - Channel ID
     * @returns {string} - Keccak256 hash of the message data
     */
    createMessageHash(id, text, sender, timestamp, channelId) {
        // Use structured data encoding to prevent delimiter injection attacks
        const data = JSON.stringify({
            protocol: 'POMBO',
            version: 1,
            id: id,
            text: text,
            sender: sender.toLowerCase(),
            timestamp: timestamp,
            channelId: channelId
        });
        // Use keccak256 for cryptographic hash
        return ethers.keccak256(ethers.toUtf8Bytes(data));
    }

    /**
     * Create deterministic hash for chunked image manifests.
     * @param {Object} input
     * @returns {string}
     */
    createImageManifestHash({
        id,
        imageId,
        sender,
        timestamp,
        channelId,
        originalMime,
        finalMime,
        finalSizeBytes,
        chunkCount,
        chunkHashes,
        assembledSha256,
        preservedOriginal = false,
        convertedTo = null,
        qualityUsed = null
    }) {
        const data = JSON.stringify({
            protocol: 'POMBO',
            version: 2,
            type: 'image',
            transport: 'chunked',
            id,
            imageId,
            sender: sender.toLowerCase(),
            timestamp,
            channelId,
            originalMime,
            finalMime,
            finalSizeBytes,
            chunkCount,
            chunkHashes,
            assembledSha256,
            preservedOriginal: !!preservedOriginal,
            convertedTo: convertedTo || null,
            qualityUsed: Number.isFinite(qualityUsed) ? Number(qualityUsed.toFixed(3)) : null
        });
        return ethers.keccak256(ethers.toUtf8Bytes(data));
    }

    /**
     * Validate message timestamp is within acceptable window
     * Prevents replay attacks with old messages
     * @param {number} messageTimestamp - Timestamp from message
     * @returns {Object} - { valid: boolean, error?: string }
     */
    validateTimestamp(messageTimestamp) {
        const now = Date.now();
        const diff = Math.abs(now - messageTimestamp);
        
        if (diff > MESSAGE_TIMESTAMP_TOLERANCE) {
            const direction = messageTimestamp < now ? 'old' : 'future';
            const minutes = Math.round(diff / 60000);
            return {
                valid: false,
                error: `Message timestamp too ${direction} (${minutes} min)`
            };
        }
        
        return { valid: true };
    }

    /**
     * Generate unique message ID
     */
    generateMessageId() {
        const random = crypto.getRandomValues(new Uint8Array(16));
        return Array.from(random).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Verify message signature
     * Uses Web Worker for CPU-intensive ECDSA signature recovery
     * @param {Object} message - Message object with signature
     * @param {string} channelId - Channel ID (optional)
     * @returns {Object} - Verification result { valid, recoveredAddress, trustLevel, ensName }
     */
    async verifyMessage(message, channelId = null, options = {}) {
        const { skipTimestampCheck = false } = options;
        
        try {
            // No app-layer signature is the CURRENT format, not a failure (D6).
            //
            // Two signatures used to cover the same claim. Streamr signs the
            // envelope, authenticating the ephemeral publisher; the proof in the
            // payload authenticates the account behind it, and streamr.js
            // verified it at ingest before this message reached anyone. Signing
            // the body a third time added no authority — it only put `sender`
            // and `signature` in the clear, re-exposing the very address the
            // ephemeral publisher exists to hide.
            //
            // `account` is therefore already cryptographically established here.
            // Trusting it is not a weakening: refusing it would reject every
            // message the app now produces.
            if (!message.signature) {
                if (!message.account) {
                    return { valid: false, error: 'No account', trustLevel: -1 };
                }

                if (!skipTimestampCheck) {
                    const timestampResult = this.validateTimestamp(message.timestamp);
                    if (!timestampResult.valid) {
                        return {
                            valid: false,
                            error: timestampResult.error,
                            trustLevel: -1,
                            isReplayAttempt: true
                        };
                    }
                }

                const ens = this.getCachedENS(message.account);
                return {
                    valid: true,
                    recoveredAddress: message.account,
                    trustLevel: this._getTrustLevelSync(message.account, ens),
                    ensName: ens
                };
            }

            // Everything below is the legacy path: messages published before the
            // migration, still readable from storage. Kept only for history.

            // Validate timestamp to prevent replay attacks (fast, main thread)
            if (!skipTimestampCheck) {
                const timestampResult = this.validateTimestamp(message.timestamp);
                if (!timestampResult.valid) {
                    return {
                        valid: false,
                        error: timestampResult.error,
                        trustLevel: -1,
                        isReplayAttempt: true
                    };
                }
            }

            // Create message hash (fast, main thread)
            const isChunkedImageManifest = message?.type === 'image' && message?.transport === 'chunked';
            const isFileManifest = message?.type === 'file_announce' && !!message?.metadata;
            const isStorageFileManifest = message?.type === 'storage_file_announce' && !!message?.metadata;

            const messageHash = isStorageFileManifest
                ? this.createStorageFileManifestHash({
                    id: message.id,
                    sender: message.sender,
                    timestamp: message.timestamp,
                    channelId: message.channelId,
                    metadata: message.metadata
                })
                : isFileManifest
                ? this.createFileManifestHash({
                    id: message.id,
                    sender: message.sender,
                    timestamp: message.timestamp,
                    channelId: message.channelId,
                    metadata: message.metadata
                })
                : isChunkedImageManifest
                ? this.createImageManifestHash({
                    id: message.id,
                    imageId: message.imageId,
                    sender: message.sender,
                    timestamp: message.timestamp,
                    channelId: message.channelId,
                    originalMime: message.originalMime,
                    finalMime: message.finalMime,
                    finalSizeBytes: message.finalSizeBytes,
                    chunkCount: message.chunkCount,
                    chunkHashes: message.chunkHashes,
                    assembledSha256: message.assembledSha256,
                    preservedOriginal: message.preservedOriginal,
                    convertedTo: message.convertedTo,
                    qualityUsed: message.qualityUsed
                })
                : this.createMessageHash(
                    message.id,
                    message.text,
                    message.sender,
                    message.timestamp,
                    message.channelId
                );

            // Verify signature in worker (CPU-intensive ECDSA recovery)
            const verification = await cryptoWorkerPool.execute('VERIFY_SIGNATURE', {
                messageHash,
                signature: message.signature,
                expectedSender: message.sender
            });
            
            if (!verification.valid) {
                return {
                    valid: false,
                    error: verification.error || 'Signature mismatch',
                    claimedSender: message.sender,
                    actualSigner: verification.recoveredAddress,
                    trustLevel: -1
                };
            }

            // ENS is read from cache only — NEVER resolved here.
            //
            // This runs for every message the user sees, including history that
            // may never be rendered. Resolving here meant handing the full list
            // of people you talk to, in the clear, to whichever public RPC
            // answered — a social-graph leak entirely outside Streamr's reach.
            //
            // Resolution is now lazy: the UI calls queueENSResolution() for the
            // senders it actually paints, and re-renders when a name lands. The
            // UI already tolerates ENS arriving late (see ChannelListUI's
            // _resolvePreviewSenders and ChatAreaUI's _resolveMessageAvatars).
            const ensName = this.getCachedENS(verification.recoveredAddress);
            const trustLevel = this._getTrustLevelSync(verification.recoveredAddress, ensName);

            return {
                valid: true,
                recoveredAddress: verification.recoveredAddress,
                trustLevel: trustLevel,
                ensName: ensName
            };
        } catch (error) {
            Logger.error('Signature verification failed:', error);
            return {
                valid: false,
                error: error.message,
                trustLevel: -1
            };
        }
    }

    // ==================== ENS RESOLUTION ====================

    /**
     * Read a still-valid ENS name from cache. Never touches the network.
     *
     * Used by the hot verification path, which must not make an RPC call per
     * message seen. Honours the same TTLs as resolveENS (24h positive,
     * 15min null) so a stale entry doesn't pin a wrong name forever.
     *
     * @param {string} address - Ethereum address
     * @returns {string|null} - ENS name, or null if unknown / expired / absent
     */
    getCachedENS(address) {
        if (!address || typeof address !== 'string') return null;
        const cached = this.ensCache.get(address.toLowerCase());
        if (!cached) return null;
        const duration = cached.name ? ENS_CACHE_DURATION : ENS_NULL_CACHE_DURATION;
        if (Date.now() - cached.timestamp >= duration) return null;
        return cached.name;
    }

    /**
     * Queue a low-priority background ENS resolution.
     *
     * The UI calls this for addresses it is actually painting. Requests are
     * serialized with a small gap so that opening a busy channel doesn't fire
     * fifty lookups at once — which, with decoys enabled, would be two hundred
     * requests and would get the free RPC tiers to rate-limit us.
     *
     * Fire-and-forget: resolution lands in the cache and `onENSResolved` lets
     * the UI patch what it already rendered.
     *
     * @param {string} address - Ethereum address
     */
    queueENSResolution(address) {
        if (!address || typeof address !== 'string') return;
        const normalized = address.toLowerCase();

        // Skip anything already answered within its TTL — including a cached
        // "no ENS", otherwise addresses without a name would be re-queried on
        // every render.
        const cached = this.ensCache.get(normalized);
        if (cached) {
            const duration = cached.name ? ENS_CACHE_DURATION : ENS_NULL_CACHE_DURATION;
            if (Date.now() - cached.timestamp < duration) return;
        }

        if (this._ensQueue.has(normalized)) return;
        this._ensQueue.add(normalized);
        this._drainENSQueue();
    }

    /**
     * Serialized drain of the background resolution queue.
     * @private
     */
    async _drainENSQueue() {
        if (this._ensQueueRunning) return;
        this._ensQueueRunning = true;
        try {
            while (this._ensQueue.size > 0) {
                const next = this._ensQueue.values().next().value;
                this._ensQueue.delete(next);
                let name = null;
                try {
                    name = await this.resolveENS(next);
                } catch (error) {
                    Logger.debug('ENS queue: lookup failed for', next, error.message);
                }
                if (name) {
                    try {
                        this.onENSResolved?.(next, name);
                    } catch (error) {
                        Logger.debug('ENS queue: handler threw (non-critical):', error.message);
                    }
                }
                if (this._ensQueue.size > 0) {
                    await new Promise(resolve => setTimeout(resolve, ENS_QUEUE_GAP_MS));
                }
            }
        } finally {
            this._ensQueueRunning = false;
        }
    }

    /**
     * Reverse-lookup `address`, buried among throwaway ones.
     *
     * The RPC operator sees N+1 addresses per query and cannot tell which one
     * we care about — the same k-anonymity trick already used for push
     * notification tags (see pushProtocol.js).
     *
     * All N+1 go out **concurrently and in shuffled order**. Issuing the real
     * one first and the decoys after would leave the ordering as a giveaway,
     * and the decoys would buy nothing.
     *
     * Decoys are inert: their results are discarded and their failures
     * swallowed, so a dud decoy can never put a working provider into cooldown
     * or land in ensCache. Only the real lookup's outcome propagates.
     *
     * @private
     * @param {Object} provider - ethers provider to query
     * @param {string} address - The address we actually care about
     * @param {boolean} withCover - false to skip the decoys entirely
     * @returns {Promise<string|null>} - ENS name for `address`, or null
     */
    async _lookupWithDecoys(provider, address, withCover = true) {
        const count = withCover ? (CONFIG.identity.ensDecoyCount || 0) : 0;
        if (count <= 0) {
            return provider.lookupAddress(address);
        }

        const slots = [{ real: true, addr: address }];
        try {
            for (let i = 0; i < count; i++) {
                slots.push({ real: false, addr: ethers.hexlify(ethers.randomBytes(20)) });
            }
        } catch {
            // No RNG available — resolve without cover rather than not at all.
            return provider.lookupAddress(address);
        }

        // Fisher-Yates with crypto randomness, so the position of the real
        // address is not derivable from a predictable PRNG sequence.
        const rand = crypto.getRandomValues(new Uint32Array(slots.length));
        for (let i = slots.length - 1; i > 0; i--) {
            const j = rand[i] % (i + 1);
            [slots[i], slots[j]] = [slots[j], slots[i]];
        }

        let realResult = null;
        let realError = null;
        await Promise.all(slots.map(async (slot) => {
            try {
                const result = await provider.lookupAddress(slot.addr);
                if (slot.real) realResult = result;
            } catch (error) {
                if (slot.real) realError = error;
            }
        }));

        if (realError) throw realError;
        return realResult;
    }

    /**
     * Resolve ENS name for an address
     * @param {string} address - Ethereum address
     * @returns {Promise<string|null>} - ENS name or null
     */
    async resolveENS(address) {
        const normalizedAddress = address.toLowerCase();
        
        // Check cache first (positive results: 24h, null results: 1h)
        const cached = this.ensCache.get(normalizedAddress);
        if (cached) {
            const cacheDuration = cached.name ? ENS_CACHE_DURATION : ENS_NULL_CACHE_DURATION;
            if (Date.now() - cached.timestamp < cacheDuration) {
                return cached.name;
            }
        }

        // In-flight deduplication: if a lookup for this address is already running, reuse it
        if (this.pendingENSLookups.has(normalizedAddress)) {
            return this.pendingENSLookups.get(normalizedAddress);
        }

        const lookupPromise = this._doResolveENS(address, normalizedAddress);
        this.pendingENSLookups.set(normalizedAddress, lookupPromise);

        try {
            return await lookupPromise;
        } finally {
            this.pendingENSLookups.delete(normalizedAddress);
        }
    }

    /**
     * Internal ENS lookup with provider fallback and health tracking
     * @private
     */
    async _doResolveENS(address, normalizedAddress) {
        // Prune expired entries periodically to prevent unbounded growth
        if (this.ensCache.size > this.MAX_ENS_CACHE_SIZE) {
            this.pruneExpiredENSEntries();
        }

        if (this.ensProviders.length === 0) {
            return null;
        }

        const now = Date.now();
        const nullProviders = []; // track which providers returned null
        let coverUsed = false;    // decoys are fired once per resolution, not per provider

        // Try ALL providers — some have broken ENS resolution (return null even for valid names)
        // A positive result from ANY provider wins immediately
        for (const provider of this.ensProviders) {
            const url = provider._ensUrl;
            const health = this.providerHealth.get(url);
            if (health && now - health.failedAt < PROVIDER_COOLDOWN_MS) {
                continue; // skip provider in cooldown
            }

            try {
                // Cover traffic goes out ONCE per resolution, not once per
                // provider. _doResolveENS walks all providers on a null result,
                // so decoying every attempt meant 4x5 = 20 requests to answer
                // "does this address have ENS?" — enough to get 429'd off the
                // free tiers, which made real lookups fail at random.
                const name = await this._lookupWithDecoys(provider, address, !coverUsed);
                coverUsed = true;

                // Provider worked — clear any cooldown
                this.providerHealth.delete(url);

                if (name) {
                    // Got a positive result — cache and return immediately
                    this.ensCache.set(normalizedAddress, {
                        name: name,
                        timestamp: Date.now()
                    });

                    Logger.info(`ENS: ${address.slice(0,8)}... → ${name} via ${url}${nullProviders.length ? ` (${nullProviders.length} other providers returned null)` : ''}`);

                    // Persist cache — fire-and-forget, never kills a successful lookup
                    this.saveENSCache().catch(e => {
                        Logger.debug('ENS cache save failed (non-critical):', e.message);
                    });
                    
                    return name;
                }

                // Provider returned null — don't trust it alone, try ALL others
                nullProviders.push(url);
                Logger.debug(`ENS: ${address.slice(0,8)}... → null from ${url}, trying next...`);
            } catch (error) {
                // Mark provider as failed for cooldown period
                this.providerHealth.set(url, { failedAt: Date.now() });
                Logger.debug('ENS lookup failed with', url, '— trying next...', error.message);
            }
        }

        // All providers returned null or failed — cache null with short duration
        this.ensCache.set(normalizedAddress, {
            name: null,
            timestamp: Date.now()
        });
        if (nullProviders.length > 0) {
            Logger.info(`ENS: ${address.slice(0,8)}... → (no Primary Name) — ${nullProviders.length} providers confirmed null`);
        } else {
            Logger.warn('ENS lookup failed for', address, '(all providers exhausted)');
        }
        return null;
    }

    /**
     * Resolve address from ENS name
     * @param {string} ensName - ENS name (e.g., "vitalik.eth")
     * @returns {Promise<string|null>} - Address or null
     */
    async resolveAddress(ensName) {
        if (this.ensProviders.length === 0) {
            return null;
        }

        const now = Date.now();
        for (const provider of this.ensProviders) {
            const url = provider._ensUrl;
            const health = this.providerHealth.get(url);
            if (health && now - health.failedAt < PROVIDER_COOLDOWN_MS) {
                continue;
            }

            try {
                const result = await provider.resolveName(ensName);
                this.providerHealth.delete(url);
                return result;
            } catch (error) {
                this.providerHealth.set(url, { failedAt: Date.now() });
                Logger.debug('ENS resolve failed with', url, '— trying next...', error.message);
            }
        }
        Logger.warn('ENS resolve failed for', ensName, '(all providers exhausted)');
        return null;
    }

    // ==================== ENS AVATAR ====================

    /**
     * Resolve ENS avatar URL for an address
     * @param {string} address - Ethereum address
     * @returns {Promise<string|null>} - Avatar URL or null
     */
    async resolveENSAvatar(address) {
        const normalizedAddress = address.toLowerCase();

        // Check memory cache
        const cached = this.ensAvatarCache.get(normalizedAddress);
        if (cached) {
            const cacheDuration = cached.url ? ENS_CACHE_DURATION : ENS_NULL_CACHE_DURATION;
            if (Date.now() - cached.timestamp < cacheDuration) {
                return cached.url;
            }
        }

        // Check localStorage (available pre-login for unlock/switch modals)
        const stored = localStorage.getItem(CONFIG.storageKeys.ensAvatar(normalizedAddress));
        if (stored) {
            this.ensAvatarCache.set(normalizedAddress, { url: stored, timestamp: Date.now() });
            return stored;
        }

        // In-flight dedup
        if (this.pendingAvatarLookups.has(normalizedAddress)) {
            return this.pendingAvatarLookups.get(normalizedAddress);
        }

        const lookupPromise = this._doResolveENSAvatar(address, normalizedAddress);
        this.pendingAvatarLookups.set(normalizedAddress, lookupPromise);

        try {
            return await lookupPromise;
        } finally {
            this.pendingAvatarLookups.delete(normalizedAddress);
        }
    }

    /**
     * Internal ENS avatar lookup with provider fallback
     * @private
     */
    async _doResolveENSAvatar(address, normalizedAddress) {
        // First resolve ENS name (required for avatar lookup)
        const ensName = await this.resolveENS(address);
        if (!ensName) {
            this.ensAvatarCache.set(normalizedAddress, { url: null, timestamp: Date.now() });
            return null;
        }

        const now = Date.now();
        for (const provider of this.ensProviders) {
            const url = provider._ensUrl;
            const health = this.providerHealth.get(url);
            if (health && now - health.failedAt < PROVIDER_COOLDOWN_MS) {
                continue;
            }

            try {
                // Read the avatar text record directly from the resolver
                const resolver = await provider.getResolver(ensName);
                if (!resolver) continue;
                const avatarRecord = await resolver.getText('avatar');
                this.providerHealth.delete(url);

                if (!avatarRecord) continue;

                let avatarUrl = avatarRecord;

                // Convert IPFS URIs to HTTPS gateway URLs
                if (avatarUrl.startsWith('ipfs://')) {
                    const cid = avatarUrl.slice(7);
                    avatarUrl = `${CONFIG.identity.ipfsGateway}${cid}`;
                }

                // Validate URL: only allow HTTPS and data URIs
                if (!avatarUrl.startsWith('https://') && !avatarUrl.startsWith('data:')) {
                    Logger.debug(`ENS avatar: rejected non-HTTPS URL for ${ensName}: ${avatarUrl.slice(0, 60)}`);
                    continue;
                }

                this.ensAvatarCache.set(normalizedAddress, { url: avatarUrl, timestamp: Date.now() });
                localStorage.setItem(CONFIG.storageKeys.ensAvatar(normalizedAddress), avatarUrl);
                Logger.info(`ENS avatar: ${ensName} → ${avatarUrl.slice(0, 80)}`);
                return avatarUrl;
            } catch (error) {
                this.providerHealth.set(url, { failedAt: Date.now() });
                Logger.debug('ENS avatar lookup failed with', url, '—', error.message);
            }
        }

        // No avatar found
        this.ensAvatarCache.set(normalizedAddress, { url: null, timestamp: Date.now() });
        return null;
    }

    /**
     * Get cached ENS avatar URL synchronously (for pre-login UI)
     * @param {string} address - Ethereum address
     * @returns {string|null}
     */
    getCachedENSAvatar(address) {
        const normalizedAddress = address.toLowerCase();
        const cached = this.ensAvatarCache.get(normalizedAddress);
        if (cached?.url) return cached.url;
        return localStorage.getItem(CONFIG.storageKeys.ensAvatar(normalizedAddress));
    }

    // ==================== TRUSTED CONTACTS ====================

    /**
     * Add a trusted contact
     * @param {string} address - Ethereum address
     * @param {string} nickname - Optional nickname
     * @param {string} notes - Optional notes
     */
    async addTrustedContact(address, nickname = null, notes = null) {
        const normalizedAddress = address.toLowerCase();
        const existing = this.trustedContacts.get(normalizedAddress);
        const timestamp = Date.now();
        
        this.trustedContacts.set(normalizedAddress, {
            address: address,
            nickname: this.normalizeTrustedContactNickname(nickname),
            notes: notes ?? existing?.notes ?? null,
            addedAt: existing?.addedAt ?? timestamp,
            addedBy: existing?.addedBy ?? authManager.getAddress(),
            updatedAt: timestamp
        });
        
        await this.saveTrustedContacts();
        this.onTrustedContactsChanged?.({ type: 'add', address: normalizedAddress });
        Logger.info('Added trusted contact:', address);
    }

    /**
     * Update a trusted contact nickname.
     * Empty values clear the nickname and fall back to ENS / short address.
     * @param {string} address - Ethereum address
     * @param {string|null} nickname - Updated nickname
     */
    async updateTrustedContact(address, nickname = null) {
        const normalizedAddress = address.toLowerCase();
        const existing = this.trustedContacts.get(normalizedAddress);
        if (!existing) {
            throw new Error('Contact not found');
        }

        this.trustedContacts.set(normalizedAddress, {
            ...existing,
            nickname: this.normalizeTrustedContactNickname(nickname),
            updatedAt: Date.now()
        });

        await this.saveTrustedContacts();
        this.onTrustedContactsChanged?.({ type: 'update', address: normalizedAddress });
        Logger.info('Updated trusted contact:', address);
    }

    /**
     * Remove a trusted contact
     * @param {string} address - Ethereum address
     */
    async removeTrustedContact(address) {
        const normalizedAddress = address.toLowerCase();
        if (!this.trustedContacts.delete(normalizedAddress)) return;
        await this.saveTrustedContacts();
        this.onTrustedContactsChanged?.({ type: 'remove', address: normalizedAddress });
        Logger.info('Removed trusted contact:', address);
    }

    /**
     * Check if address is a trusted contact
     * @param {string} address - Ethereum address
     * @returns {Object|null} - Contact info or null
     */
    getTrustedContact(address) {
        return this.trustedContacts.get(address.toLowerCase()) || null;
    }

    /**
     * Get all trusted contacts
     * @returns {Array} - Array of contact objects
     */
    getAllTrustedContacts() {
        return Array.from(this.trustedContacts.values());
    }

    // ==================== TRUST LEVEL CALCULATION ====================

    /**
     * Get trust level for an address
     * @param {string} address - Ethereum address
     * @returns {Promise<number>} - Trust level (0-2, -1 for invalid)
     */
    async getTrustLevel(address) {
        const ensName = await this.resolveENS(address);
        return this._getTrustLevelSync(address, ensName);
    }

    /**
     * Synchronous trust level check (when ENS result is already known)
     * @private
     */
    _getTrustLevelSync(address, ensName) {
        const normalizedAddress = address.toLowerCase();
        
        // Check trusted contacts
        if (this.trustedContacts.has(normalizedAddress)) {
            return 2; // Trusted contact
        }
        
        if (ensName) {
            return 1; // ENS verified
        }
        
        return 0; // Unknown but valid signature
    }

    /**
     * Get trust level label
     * @param {number} level - Trust level
     * @returns {Object} - { label, icon, color }
     */
    getTrustLevelInfo(level) {
        const levels = {
            [-1]: { label: 'Invalid Signature', icon: '<svg class="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>', color: 'red', bgColor: 'bg-red-900/30', textColor: 'text-red-400' },
            [0]: { label: 'Valid Signature', icon: '<svg class="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>', color: 'green', bgColor: '', textColor: 'text-green-400' },
            [1]: { label: 'ENS Verified', icon: '<svg class="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12.75L11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 01-1.043 3.296 3.745 3.745 0 01-3.296 1.043A3.745 3.745 0 0112 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 01-3.296-1.043 3.745 3.745 0 01-1.043-3.296A3.745 3.745 0 013 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 011.043-3.296 3.746 3.746 0 013.296-1.043A3.746 3.746 0 0112 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 013.296 1.043 3.746 3.746 0 011.043 3.296A3.745 3.745 0 0121 12z"/></svg>', color: 'green', bgColor: '', textColor: 'text-green-400' },
            [2]: { label: 'Trusted Contact', icon: '<svg class="w-3.5 h-3.5 inline" fill="currentColor" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l2.082 5.007 5.404.433c1.164.093 1.636 1.545.749 2.305l-4.117 3.527 1.257 5.273c.271 1.136-.964 2.033-1.96 1.425L12 18.354 7.373 21.18c-.996.608-2.231-.29-1.96-1.425l1.257-5.273-4.117-3.527c-.887-.76-.415-2.212.749-2.305l5.404-.433 2.082-5.006z" clip-rule="evenodd"/></svg>', color: 'yellow', bgColor: '', textColor: 'text-yellow-400' }
        };
        return levels[level] || levels[0];
    }

    // ==================== PERSISTENCE ====================

    async saveTrustedContacts() {
        if (!secureStorage.isStorageUnlocked()) {
            Logger.warn('Cannot save contacts - secure storage not unlocked');
            return;
        }
        const data = Object.fromEntries(this.trustedContacts.entries());
        await secureStorage.setTrustedContacts(data);
    }

    /**
     * Normalize user-entered contact nickname.
     * Empty values are stored as null so UI falls back automatically.
     * @param {string|null} nickname
     * @returns {string|null}
     */
    normalizeTrustedContactNickname(nickname) {
        if (typeof nickname !== 'string') return null;
        const trimmed = nickname.trim();
        return trimmed || null;
    }

    loadTrustedContacts() {
        try {
            if (!secureStorage.isStorageUnlocked()) {
                return;
            }
            const data = secureStorage.getTrustedContacts();
            if (data && typeof data === 'object') {
                this.trustedContacts = new Map(
                    Object.entries(data).filter(([, contact]) => (
                        contact
                        && typeof contact === 'object'
                        && typeof contact.address === 'string'
                    ))
                );
            }
        } catch (error) {
            Logger.error('Failed to load trusted contacts:', error);
        }
    }

    /**
     * Remove expired entries from ENS cache to prevent unbounded memory growth
     */
    pruneExpiredENSEntries() {
        const now = Date.now();
        for (const [addr, entry] of this.ensCache) {
            const duration = entry.name ? ENS_CACHE_DURATION : ENS_NULL_CACHE_DURATION;
            if (now - entry.timestamp > duration) {
                this.ensCache.delete(addr);
            }
        }
        // If still over limit after pruning expired, evict oldest entries
        if (this.ensCache.size > this.MAX_ENS_CACHE_SIZE) {
            const sorted = [...this.ensCache.entries()]
                .sort((a, b) => a[1].timestamp - b[1].timestamp);
            const toRemove = sorted.slice(0, this.ensCache.size - this.MAX_ENS_CACHE_SIZE);
            for (const [addr] of toRemove) {
                this.ensCache.delete(addr);
            }
        }
        Logger.debug(`ENS cache pruned to ${this.ensCache.size} entries`);
    }

    async saveENSCache() {
        if (!secureStorage.isStorageUnlocked()) {
            return;
        }
        // Prune before persisting to avoid saving stale entries
        this.pruneExpiredENSEntries();
        const data = Object.fromEntries(this.ensCache.entries());
        await secureStorage.setENSCache(data);
    }

    loadENSCache() {
        try {
            if (!secureStorage.isStorageUnlocked()) {
                return;
            }
            const data = secureStorage.getENSCache();
            if (data && typeof data === 'object') {
                this.ensCache = new Map(Object.entries(data));
            }
        } catch (error) {
            Logger.error('Failed to load ENS cache:', error);
        }
    }

    // ==================== DISPLAY HELPERS ====================

    /**
     * Synchronous display-name resolver for hot UI paths (sidebar / Explore
     * preview lines). Falls back without making network calls:
     *   1. Cached ENS name (if positive entry, regardless of TTL — preview
     *      doesn't need to be authoritative).
     *   2. Trusted contact nickname.
     *   3. Shortened address `0x12…ab`.
     *
     * @param {string} address
     * @returns {string}
     */
    getCachedDisplayName(address) {
        if (!address || typeof address !== 'string') return '';
        const norm = address.toLowerCase();
        const cached = this.ensCache.get(norm);
        if (cached && cached.name) return cached.name;
        const contact = this.getTrustedContact(address);
        if (contact && contact.nickname) return contact.nickname;
        return `${address.slice(0, 6)}…${address.slice(-4)}`;
    }

    /**
     * Get display name for an address (ENS > Nickname > Short address)
     * @param {string} address - Ethereum address
     * @returns {Promise<string>} - Display name
     */
    async getDisplayName(address) {
        // Check for ENS name
        const ensName = await this.resolveENS(address);
        if (ensName) {
            return ensName;
        }
        
        // Check for trusted contact nickname
        const contact = this.getTrustedContact(address);
        if (contact && contact.nickname) {
            return contact.nickname;
        }
        
        // Return shortened address
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    /**
     * Get full identity info for display
     * @param {string} address - Ethereum address  
     * @param {Object} verificationResult - Result from verifyMessage
     * @returns {Promise<Object>} - Full identity info for UI
     */
    async getIdentityInfo(address, verificationResult = null) {
        const ensName = verificationResult?.ensName || await this.resolveENS(address);
        const trustLevel = verificationResult?.trustLevel ?? await this.getTrustLevel(address);
        const trustInfo = this.getTrustLevelInfo(trustLevel);
        const contact = this.getTrustedContact(address);
        const displayName = ensName || contact?.nickname || `${address.slice(0, 6)}...${address.slice(-4)}`;
        
        return {
            address: address,
            displayName: displayName,
            ensName: ensName,
            nickname: contact?.nickname,
            trustLevel: trustLevel,
            trustInfo: trustInfo,
            isTrusted: trustLevel >= 2,
            hasENS: !!ensName,
            signatureValid: verificationResult?.valid ?? null
        };
    }
}

// Export singleton instance
export const identityManager = new IdentityManager();
