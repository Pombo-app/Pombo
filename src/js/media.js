/**
 * Media Controller
 * Handles image and video file sharing via Streamr
 * 
 * Image: Direct base64 encoding (for small images)
 * Video: Chunked P2P transfer with hash verification
 */

import { Logger } from './logger.js';
import { cryptoManager } from './crypto.js';
import { streamrController, deriveEphemeralId, STREAM_CONFIG } from './streamr.js';
import { authManager } from './auth.js';
import { identityManager } from './identity.js';
import { channelManager } from './channels.js';
import { secureStorage } from './secureStorage.js';
import { dmManager } from './dm.js';
import { dmCrypto } from './dmCrypto.js';
import { CONFIG as APP_CONFIG } from './config.js';
import { getChannelIdentity } from './channelIdentity.js';
import { recoverPublisherAccount } from './publisherProof.js';
import { usesEpochKeys } from './epochKeyManager.js';

// === CONFIGURATION ===
const CONFIG = {
    // Image settings
    IMAGE_MAX_WIDTH: APP_CONFIG.media.imageMaxWidth,
    IMAGE_MAX_HEIGHT: APP_CONFIG.media.imageMaxHeight,
    IMAGE_QUALITY: APP_CONFIG.media.imageQuality,
    IMAGE_MAX_ASSEMBLED_BYTES: APP_CONFIG.media.imageMaxAssembledBytes,
    IMAGE_GIF_MAX_ASSEMBLED_BYTES: APP_CONFIG.media.imageGifMaxAssembledBytes,
    IMAGE_PAYLOAD_MAX_BYTES: APP_CONFIG.media.imagePayloadMaxBytes,
    IMAGE_PAYLOAD_SAFETY_MARGIN_BYTES: APP_CONFIG.media.imagePayloadSafetyMarginBytes,
    IMAGE_CHUNK_INITIAL_RAW_BYTES: APP_CONFIG.media.imageChunkInitialRawBytes,
    IMAGE_CHUNK_MIN_RAW_BYTES: APP_CONFIG.media.imageChunkMinRawBytes,
    IMAGE_ASSEMBLY_TTL_MS: APP_CONFIG.media.imageAssemblyTtlMs,
    JPEG_INITIAL_QUALITY: APP_CONFIG.media.jpegInitialQuality,
    JPEG_MIN_QUALITY: APP_CONFIG.media.jpegMinQuality,
    WEBP_INITIAL_QUALITY: APP_CONFIG.media.webpInitialQuality,
    WEBP_MIN_QUALITY: APP_CONFIG.media.webpMinQuality,
    IMAGE_RESOLUTION_SCALES: APP_CONFIG.media.imageResolutionScales,
    ALLOW_JPEG_TO_WEBP_FALLBACK: APP_CONFIG.media.allowJpegToWebpFallback,
    FORCE_PNG_TO_WEBP_ON_OVERFLOW: APP_CONFIG.media.forcePngToWebpOnOverflow,
    FAIL_GIF_ON_OVERFLOW: APP_CONFIG.media.failGifOnOverflow,
    LEGACY_IMAGE_READ_ENABLED: APP_CONFIG.media.legacyImageReadEnabled,
    LEGACY_INLINE_IMAGE_WRITE_ENABLED: APP_CONFIG.media.legacyInlineImageWriteEnabled,
    ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    
    // Video/File settings
    // Note: video/quicktime (.mov) is only supported in Safari, not Chrome/Firefox
    // We allow upload but may need to show download link instead of player
    ALLOWED_VIDEO_TYPES: ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v', 'video/ogg'],
    // Browser-playable formats (for showing player vs download link)
    PLAYABLE_VIDEO_TYPES: ['video/mp4', 'video/webm', 'video/ogg', 'video/x-m4v', 'video/m4v'],

    PIECE_SIZE: APP_CONFIG.media.pieceSize,
    PIECE_SEND_DELAY: APP_CONFIG.media.pieceSendDelayMs,
    CONCURRENT_SENDS: APP_CONFIG.media.concurrentSends || 3,
    PIECE_REQUEST_TIMEOUT: APP_CONFIG.media.pieceRequestTimeoutMs,
    MAX_PIECE_FAILURES: APP_CONFIG.media.maxPieceFailures,
    MAX_SEEDER_STRIKES: APP_CONFIG.media.maxSeederStrikes,
    SPEED_WINDOW_MS: APP_CONFIG.media.speedWindowMs,
    LEECHER_TIMEOUT_MS: APP_CONFIG.media.leecherTimeoutMs,
    UPLOAD_STATS_INTERVAL_MS: APP_CONFIG.media.uploadStatsIntervalMs,
    MAX_FILE_SIZE: APP_CONFIG.media.maxFileSize,

    // Adaptive request window (AIMD) — see config.js for the rationale
    PIECE_WINDOW_START: APP_CONFIG.media.pieceWindowStart,
    PIECE_WINDOW_MIN: APP_CONFIG.media.pieceWindowMin,
    PIECE_WINDOW_MAX: APP_CONFIG.media.pieceWindowMax,
    PIECE_WINDOW_BACKOFF_COOLDOWN: APP_CONFIG.media.pieceWindowBackoffCooldownMs,
    
    // Seeder Discovery settings
    MIN_SEEDERS: APP_CONFIG.media.minSeeders,
    PREFERRED_SEEDERS: APP_CONFIG.media.preferredSeeders,
    SEEDER_REQUEST_INTERVAL: APP_CONFIG.media.seederRequestIntervalMs,
    SEEDER_DISCOVERY_TIMEOUT: APP_CONFIG.media.seederDiscoveryTimeoutMs,
    SEEDER_REFRESH_INTERVAL: APP_CONFIG.media.seederRefreshIntervalMs,
    MAX_SEEDER_REQUESTS: APP_CONFIG.media.maxSeederRequests,
    
    // Seeding Persistence settings
    MAX_SEED_STORAGE: APP_CONFIG.media.maxSeedStorage,
    SEED_FILES_EXPIRE_DAYS: APP_CONFIG.media.seedFilesExpireDays,
    PIECE_EXPIRE_DAYS: APP_CONFIG.media.pieceExpireDays,
    AUTO_SEED_ON_JOIN: true,               // Re-announce as seeder when joining channel
    PERSIST_PUBLIC_CHANNELS: true,         // Persist files from public channels
    PERSIST_PRIVATE_CHANNELS: true         // Don't persist files from private channels (privacy)
};

// ==================== BINARY PROTOCOL ====================
// Binary encoding for MEDIA_DATA partition (partition 2)
// Format: [1 byte type] [header bytes] [payload]
const BINARY_MSG_TYPE = {
    FILE_PIECE: 0x01,
    // 0x02 is dmCrypto's sealed binary envelope — never reuse it here.
    // A channel piece carries the publisher proof inline instead: there is no
    // single recipient to seal to, and the channel password (or nothing, in a
    // public channel) is already the confidentiality boundary.
    FILE_PIECE_SIGNED: 0x03
};

// 65-byte serialized secp256k1 signature
const PROOF_BYTES = 65;

// Local hex conversion: pulling in ethers here would make the binary frame
// depend on the wallet library for nothing more than slicing a hex string.
function hexToBytes(hex) {
    const clean = String(hex).replace(/^0x/, '');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return out;
}

function bytesToHex(bytes) {
    return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

const STORED_IMAGE_PROTOCOL_VERSION = 2;
const STORED_IMAGE_TRANSPORT = 'chunked';

function isStoredImageChunkMessage(data) {
    return !!(
        data
        && data.type === 'image_chunk'
        && data.v === STORED_IMAGE_PROTOCOL_VERSION
        && typeof data.imageId === 'string'
        && Number.isInteger(data.chunkIndex)
        && data.chunkIndex >= 0
        && typeof data.chunkHash === 'string'
        && typeof data.data === 'string'
    );
}

function isStoredChunkedImageManifest(data) {
    return !!(
        data
        && data.type === 'image'
        && data.transport === STORED_IMAGE_TRANSPORT
        && data.v === STORED_IMAGE_PROTOCOL_VERSION
        && typeof data.imageId === 'string'
        && Number.isInteger(data.chunkCount)
        && data.chunkCount > 0
        && Array.isArray(data.chunkHashes)
        && data.chunkHashes.length === data.chunkCount
        && typeof data.finalMime === 'string'
        && typeof data.assembledSha256 === 'string'
    );
}

/**
 * Encode a file_piece as Uint8Array for binary transport.
 * Format: [1B type=0x01] [36B fileId UTF-8] [4B pieceIndex uint32BE] [N bytes raw data]
 * @param {string} fileId - File ID (UUID, 36 chars)
 * @param {number} pieceIndex - Piece index
 * @param {ArrayBuffer|Uint8Array} data - Raw piece data
 * @returns {Uint8Array}
 */
function encodeFilePiece(fileId, pieceIndex, data) {
    const fileIdBytes = new TextEncoder().encode(fileId); // 36 bytes for UUID
    const dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const buf = new Uint8Array(1 + 36 + 4 + dataBytes.byteLength);
    buf[0] = BINARY_MSG_TYPE.FILE_PIECE;
    buf.set(fileIdBytes.slice(0, 36), 1);
    // pieceIndex as uint32 big-endian at offset 37
    const view = new DataView(buf.buffer);
    view.setUint32(37, pieceIndex, false);
    buf.set(dataBytes, 41);
    return buf;
}

/**
 * Decode a file_piece from binary.
 * @param {Uint8Array} buf - Binary buffer
 * @returns {{ type: string, fileId: string, pieceIndex: number, data: Uint8Array }}
 */
function decodeFilePiece(buf) {
    const fileId = new TextDecoder().decode(buf.slice(1, 37));
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const pieceIndex = view.getUint32(37, false);
    const data = buf.slice(41);
    return { type: 'file_piece', fileId, pieceIndex, data };
}



/**
 * Decode any binary media message.
 * @param {Uint8Array} buf - Binary buffer
 * @returns {Object} Decoded message with type field
 */
/**
 * Encode a file_piece that names its publisher.
 * Format: [1B type=0x03] [65B proof] [36B fileId] [4B pieceIndex] [N bytes data]
 *
 * The proof binds the ephemeral publisher to the real account exactly as the
 * JSON `proof` field does — binary just has nowhere to put a field.
 */
function encodeSignedFilePiece(proof, fileId, pieceIndex, data) {
    const proofBytes = hexToBytes(proof);
    const piece = encodeFilePiece(fileId, pieceIndex, data);

    const buf = new Uint8Array(1 + PROOF_BYTES + piece.byteLength - 1);
    buf[0] = BINARY_MSG_TYPE.FILE_PIECE_SIGNED;
    buf.set(proofBytes, 1);
    buf.set(piece.subarray(1), 1 + PROOF_BYTES);
    return buf;
}

function decodeSignedFilePiece(buf) {
    if (buf.byteLength < 1 + PROOF_BYTES + 40) return null;

    const proof = bytesToHex(buf.slice(1, 1 + PROOF_BYTES));

    // Rebuild the unsigned frame so decoding stays in one place
    const inner = new Uint8Array(buf.byteLength - PROOF_BYTES);
    inner[0] = BINARY_MSG_TYPE.FILE_PIECE;
    inner.set(buf.subarray(1 + PROOF_BYTES), 1);

    return { ...decodeFilePiece(inner), proof };
}

/**
 * Decode any binary media message.
 * @param {Uint8Array} buf - Binary buffer
 * @returns {Object} Decoded message with type field
 */
function decodeBinaryMedia(buf) {
    if (!buf || buf.length === 0) return null;
    switch (buf[0]) {
        case BINARY_MSG_TYPE.FILE_PIECE: return decodeFilePiece(buf);
        case BINARY_MSG_TYPE.FILE_PIECE_SIGNED: return decodeSignedFilePiece(buf);
        default: return null;
    }
}

/**
 * Adaptive retransmission timeout for piece requests, following the shape of
 * TCP's RTO estimator (RFC 6298): a smoothed round-trip time plus four times
 * its variance, doubled on every timeout and re-measured from every success.
 * Port of the Android PieceTimeout (core/PieceTimeout.kt) — keep in sync.
 *
 * A FIXED timeout is the wrong tool here and measurably so. 5s suits two desktops
 * on a LAN; on a mobile path where a 220KB piece legitimately takes 3-4.5s, that
 * constant declares failure on pieces still in flight. The damage compounds — the
 * window halves, the piece is asked for again, and the duplicate answer competes
 * with the pieces still coming, on the very link that is already the bottleneck
 * (measured live: a seeder sending the same piece six times over 5G).
 */
class PieceRtoEstimator {
    constructor(initialMs = 5000, minMs = 3000, maxMs = 60000) {
        this.initialMs = initialMs;
        this.minMs = minMs;
        this.maxMs = maxMs;
        this.srtt = -1;        // smoothed round-trip time
        this.rttvar = 0;       // round-trip time variation
        this.backoff = 1;
        this.minRtt = Infinity;
    }

    /** Current timeout to arm a request with. */
    currentMs() {
        const base = this.srtt < 0 ? this.initialMs : this.srtt + 4 * this.rttvar;
        return Math.min(this.maxMs, Math.max(this.minMs, Math.round(base * this.backoff)));
    }

    /**
     * A piece arrived after rttMs. Clears the backoff — the path is working,
     * so whatever made us double the timeout has passed.
     */
    onSample(rttMs) {
        if (rttMs <= 0) return;
        if (rttMs < this.minRtt) this.minRtt = rttMs;
        if (this.srtt < 0) {
            // First measurement seeds the estimator (RFC 6298 rule 2.2)
            this.srtt = rttMs;
            this.rttvar = rttMs / 2;
        } else {
            // Variance FIRST and from the OLD srtt; updating srtt first would make
            // the estimator track its own output and collapse the variance
            this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - rttMs);
            this.srtt = 0.875 * this.srtt + 0.125 * rttMs;
        }
        this.backoff = 1;
    }

    /**
     * A request timed out: double the wait, up to the ceiling. A timeout gives no
     * round-trip sample (the answer may be late or never coming), so the only
     * honest response is to wait longer next time.
     */
    onTimeout() {
        if (this.currentMs() < this.maxMs) this.backoff = Math.min(this.backoff * 2, 64);
    }

    /**
     * Whether the round-trip has inflated well past the path's best — the
     * delay-based congestion signal (Vegas/BBR style). Needed because once the
     * timeout is measured rather than fixed, timeouts become rare by construction
     * and nothing else would stop the window inflating into a self-made queue.
     * The loose factor keeps normal jitter from reading as congestion.
     */
    isCongested(factor = 2.0) {
        if (this.srtt < 0 || this.minRtt === Infinity) return false;
        return this.srtt > this.minRtt * factor;
    }
}

class MediaController {
    constructor() {
        // Image cache: imageId -> base64 data (LRU eviction when over byte limit)
        this.imageCache = new Map();
        this.imageCacheBytes = 0;
        this.MAX_IMAGE_CACHE_BYTES = APP_CONFIG.media.maxImageCacheBytes;
        this.pendingImageAssemblies = new Map();

        // Tombstone set: imageIds whose owning message was deleted in this
        // session. Blocks every late-arrival path (chunk register, manifest
        // register, getImage, recoverImage, handleImageData) so a paginated
        // resend or a stuck-placeholder recover cannot resurrect a deleted
        // image. Per-session (not persisted) — same lifetime as imageCache.
        this.deletedImageIds = new Set();
        
        // Local files being seeded: fileId -> { file, metadata, streamId }
        this.localFiles = new Map();
        
        // Downloaded file URLs: fileId -> blob URL
        this.downloadedUrls = new Map();
        
        // Incoming file transfers: fileId -> transfer state
        this.incomingFiles = new Map();
        
        // File seeders: fileId -> Set of seeder IDs
        this.fileSeeders = new Map();
        
        // File worker for hashing
        this.fileWorker = null;
        
        // Event handlers
        this.handlers = {
            onImageReceived: null,
            onFileAnnounced: null,
            onFileProgress: null,
            onFileComplete: null,
            onFileError: null,
            onUploadProgress: null,
            onSeederUpdate: null
        };
        
        // IndexedDB for large file storage
        this.db = null;
        
        // Track total persisted storage size
        this.persistedStorageSize = 0;
        
        // Current owner address (for filtering seed files)
        this.currentOwnerAddress = null;
        
        // Piece send queue for throttling
        this.pieceSendQueue = [];
        this.activeSends = 0;
        this.lastPieceSentTime = 0;

        // Serving stats per file: upload rate and who is currently pulling from us
        this.uploads = new Map();
        this.lastUploadStatsAt = 0;
    }

    /**
     * Initialize media controller
     */
    async init() {
        await this.initIndexedDB();
        this.initFileWorker();
        await this.cleanupStalePieces();
        // Note: Don't load seed files here - wait for wallet connection
        // await this.loadPersistedSeedFiles();
        Logger.info('Media controller initialized (waiting for wallet connection)');
    }

    /**
     * Set owner address and load their seed files
     * Called when wallet connects
     * @param {string} address - Wallet address
     */
    async setOwner(address) {
        this.currentOwnerAddress = address?.toLowerCase() || null;
        
        if (this.currentOwnerAddress) {
            await this.loadPersistedSeedFiles();
            Logger.info('Media controller: owner set to', this.currentOwnerAddress.slice(0, 8) + '...');
        }
    }

    /**
     * Reset all in-memory state (on disconnect)
     * Does NOT clear persisted files - just unloads from memory
     */
    reset() {
        // Cancel any pending download timers first
        for (const [fileId, transfer] of this.incomingFiles) {
            if (transfer.seederDiscoveryTimer) {
                clearTimeout(transfer.seederDiscoveryTimer);
            }
            if (transfer.noSeederRetryTimer) {
                clearTimeout(transfer.noSeederRetryTimer);
            }
            // Also clear any piece request timeouts
            if (transfer.requestsInFlight) {
                for (const [pieceIndex, request] of transfer.requestsInFlight) {
                    if (request.timeoutId) {
                        clearTimeout(request.timeoutId);
                    }
                }
            }
        }
        
        // Revoke all blob URLs to prevent memory leaks
        for (const url of this.downloadedUrls.values()) {
            URL.revokeObjectURL(url);
        }
        
        // Clear all maps
        this.imageCache.clear();
        this.imageCacheBytes = 0;
        for (const pending of this.pendingImageAssemblies.values()) {
            if (pending.timerId) {
                clearTimeout(pending.timerId);
            }
        }
        this.pendingImageAssemblies.clear();
        this.deletedImageIds.clear();
        this.localFiles.clear();
        this.downloadedUrls.clear();
        this.incomingFiles.clear();
        this.fileSeeders.clear();
        
        // Clear piece send queue
        this.pieceSendQueue = [];
        this.activeSends = 0;
        this.lastPieceSentTime = 0;
        for (const state of this.uploads.values()) {
            if (state.decayTimer) clearInterval(state.decayTimer);
        }
        this.uploads.clear();
        this.lastUploadStatsAt = 0;
        
        // Reset owner
        this.currentOwnerAddress = null;
        this.persistedStorageSize = 0;
        
        Logger.info('Media controller reset');
    }

    /**
     * Get ECDH AES key for DM channels (for encrypting media on -2).
     * Returns null for non-DM channels (password encryption handled separately).
     * @param {string} messageStreamId - Channel message stream ID
     * @returns {Promise<CryptoKey|null>}
     */
    /**
     * The binary sealer for one transfer, created on first use.
     *
     * Cached on the localFile entry, keyed by channel: a seeder can serve the
     * same file to several peers, and each needs its own sealer because the AES
     * key is derived against THAT peer's public key. Living on the entry means
     * it is discarded with the file, with no separate cleanup to forget.
     *
     * Concurrency: pieces are sent with bounded parallelism, so several sends
     * can miss the cache at once. Storing the PROMISE rather than the resolved
     * sealer makes them all wait on the same ECDH instead of racing to create
     * one key each — which would silently break the per-transfer guarantee.
     *
     * @param {Object} localFile - Entry from this.localFiles
     * @param {string} messageStreamId - Channel the pieces are going to
     * @param {string} dmPeer - Peer address
     */
    _binarySealerFor(localFile, messageStreamId, dmPeer) {
        if (!localFile.binarySealers) localFile.binarySealers = new Map();

        let pending = localFile.binarySealers.get(messageStreamId);
        if (!pending) {
            pending = dmManager.createBinarySealer(dmPeer);
            localFile.binarySealers.set(messageStreamId, pending);
            // A failed sealer must not be cached, or the transfer never recovers
            pending.catch(() => localFile.binarySealers.delete(messageStreamId));
        }
        return pending;
    }

    /**
     * Run a P2P task that nobody awaits, turning a rejection into a log line.
     *
     * The signal handlers and the download loop dispatch without `await`, so an
     * exception becomes an unhandled promise: the transfer stalls and nothing
     * says why. That matters more since sealing replaced the old ECDH path —
     * `sealFor` RAISES when the peer's public key is unavailable, where the old
     * code returned null and quietly fell back to publishing in the clear.
     * Raising is right; disappearing is not.
     *
     * @param {string} label - What was being attempted, for the log
     * @param {Promise} promise - The unawaited task
     */
    fireAndForget(label, promise) {
        Promise.resolve(promise).catch(error => {
            Logger.warn(`Media P2P: ${label} failed —`, error?.message || error);
        });
    }

    /**
     * Peer address for a DM channel, or null when the channel is not a DM.
     * The signal path needs the peer, not a precomputed key: sealing derives
     * its own key from a throwaway ephemeral pair on every send.
     */
    _getDMPeer(messageStreamId) {
        const channel = channelManager.getChannel(messageStreamId);
        if (channel?.type !== 'dm' || !channel.peerAddress) return null;
        return channel.peerAddress;
    }

    /**
     * Initialize IndexedDB for file storage (v3)
     */
    async initIndexedDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('PomboMediaDB', 3);

            request.onerror = () => {
                Logger.warn('IndexedDB not available, using memory only');
                resolve();
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                Logger.debug('IndexedDB initialized (v3)');
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // v2: seedFiles store for persistent seeding
                if (!db.objectStoreNames.contains('seedFiles')) {
                    const seedStore = db.createObjectStore('seedFiles', { keyPath: 'fileId' });
                    seedStore.createIndex('streamId', 'streamId', { unique: false });
                    seedStore.createIndex('timestamp', 'timestamp', { unique: false });
                }

                // v3: pieces gain a timestamp index so abandoned partial downloads
                // can be swept. Pieces are scratch space for in-flight transfers, so
                // the store is recreated rather than migrated — dropping a partial
                // download only costs a re-download.
                if (event.oldVersion < 3) {
                    if (db.objectStoreNames.contains('pieces')) {
                        db.deleteObjectStore('pieces');
                    }
                    const pieceStore = db.createObjectStore('pieces', { keyPath: ['fileId', 'pieceIndex'] });
                    pieceStore.createIndex('timestamp', 'timestamp', { unique: false });
                }

                Logger.info('IndexedDB upgraded to v3');
            };
        });
    }

    /**
     * All piece records for one file.
     *
     * The store's key path is ['fileId', 'pieceIndex'], so a bound range over the
     * compound key selects exactly one file's pieces. Previously every lookup
     * opened a cursor over the whole store and filtered in JS, which grew with
     * every other download ever started.
     *
     * @param {string} fileId - File ID
     * @returns {IDBKeyRange}
     */
    pieceKeyRange(fileId) {
        return IDBKeyRange.bound([fileId, -Infinity], [fileId, Infinity]);
    }

    /**
     * Initialize Web Worker for file hashing
     */
    initFileWorker() {
        const workerCode = `
            async function calculateSHA256(buffer) {
                const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            }

            self.onmessage = async (event) => {
                const { fileData, tempId } = event.data;
                const PIECE_SIZE = ${CONFIG.PIECE_SIZE};
                const pieceHashes = [];
                
                // Hash one slice at a time. Reading the whole file into an ArrayBuffer
                // here meant a 500MB upload allocated 500MB in the worker before the
                // transfer even started; Blob.slice() reads only the piece it needs.
                for (let offset = 0; offset < fileData.size; offset += PIECE_SIZE) {
                    const end = Math.min(offset + PIECE_SIZE, fileData.size);
                    const slice = fileData.slice(offset, end);
                    const hash = await calculateSHA256(await slice.arrayBuffer());
                    pieceHashes.push(hash);
                }

                const metadata = {
                    fileId: crypto.randomUUID(),
                    fileName: fileData.name,
                    fileSize: fileData.size,
                    fileType: fileData.type,
                    pieceCount: pieceHashes.length,
                    pieceHashes: pieceHashes
                };
                
                self.postMessage({ status: 'complete', metadata, tempId });
            };
        `;

        const blob = new Blob([workerCode], { type: 'application/javascript' });
        this.fileWorker = new Worker(URL.createObjectURL(blob));
        
        this.fileWorker.onmessage = (event) => {
            this.handleWorkerMessage(event.data);
        };
        
        this.fileWorker.onerror = (error) => {
            Logger.error('File worker error:', error);
        };
    }

    /**
     * Handle message from file worker
     */
    async handleWorkerMessage(data) {
        const { status, metadata, tempId } = data;
        
        if (status === 'complete') {
            const tempRef = this.localFiles.get(tempId);
            if (!tempRef) {
                Logger.error('Could not find temp file reference:', tempId);
                return;
            }
            
            // Move from temp to final
            this.localFiles.delete(tempId);
            this.localFiles.set(metadata.fileId, {
                file: tempRef.file,
                metadata,
                streamId: tempRef.streamId,
                isPrivateChannel: tempRef.isPrivateChannel,
                persisted: false,
                callback: tempRef.callback
            });
            
            // Trigger callback to announce file
            if (tempRef.callback) {
                await tempRef.callback(metadata);
            }
            
            // Lazy-subscribe to media partitions P1+P2 (sender needs P1 to receive piece_requests)
            if (tempRef.streamId) {
                const ephemeralStreamId = deriveEphemeralId(tempRef.streamId);
                await streamrController.ensureMediaSubscription(ephemeralStreamId);
            }
            
            // Persist for seeding across sessions (after announcement)
            if (tempRef.streamId) {
                const persisted = await this.persistSeedFile(
                    metadata.fileId,
                    tempRef.file,
                    metadata,
                    tempRef.streamId,
                    tempRef.isPrivateChannel
                );
                if (persisted) {
                    const localFile = this.localFiles.get(metadata.fileId);
                    if (localFile) localFile.persisted = true;
                }
            }
        }
    }

    // ==================== IMAGE HANDLING ====================

    /**
     * Send an image
     * @param {string} messageStreamId - Channel message stream ID
     * @param {File} file - Image file
     * @param {string} password - Channel password (optional)
     * @returns {Promise<Object>} - Image message info
     */
    async sendImage(messageStreamId, file, password = null) {
        if (CONFIG.LEGACY_INLINE_IMAGE_WRITE_ENABLED) {
            return this.sendLegacyInlineImage(messageStreamId, file, password);
        }

        // Validate file type
        if (!CONFIG.ALLOWED_IMAGE_TYPES.includes(file.type)) {
            throw new Error(`Invalid image type. Allowed: ${CONFIG.ALLOWED_IMAGE_TYPES.join(', ')}`);
        }

        const channel = channelManager.getChannel(messageStreamId);
        if (!channel) {
            throw new Error('Channel not found');
        }

        // Sealed sender: every chunk and the manifest leave under their own
        // throwaway publisher. No shared key to precompute here, and no
        // setDMPublishKey — publishAs sends with encryptionType NONE, so the
        // SDK's group-key layer is never engaged.
        const dmPeer = (channel.type === 'dm' && channel.peerAddress) ? channel.peerAddress : null;

        const prepared = await this.prepareImageForStoredTransport(file);
        const imageId = crypto.randomUUID();
        const finalDataUrl = await this.blobToDataURL(prepared.blob);
        const chunkPayloads = await this.createStoredImageChunkPayloads({
            imageId,
            blob: prepared.blob,
            password,
            dmPeer,
            channel
        });

        const manifest = await this.createSignedStoredImageManifest({
            imageId,
            channelId: messageStreamId,
            originalMime: prepared.originalMime,
            finalMime: prepared.finalMime,
            finalSizeBytes: prepared.blob.size,
            chunkCount: chunkPayloads.length,
            chunkHashes: chunkPayloads.map(chunk => chunk.chunkHash),
            assembledSha256: prepared.sha256,
            preservedOriginal: prepared.preservedOriginal,
            convertedTo: prepared.convertedTo,
            qualityUsed: prepared.qualityUsed
        });

        await this.assertStoredImagePayloadFits(manifest, password, dmPeer, 'image manifest', channel);

        for (const chunkPayload of chunkPayloads) {
            await this.publishStoredImagePayload(messageStreamId, chunkPayload, password, dmPeer, channel);
        }
        await this.publishStoredImagePayload(messageStreamId, manifest, password, dmPeer, channel);

        this.cacheImage(imageId, finalDataUrl);

        const localMessage = {
            ...manifest,
            imageData: finalDataUrl,
            verified: {
                valid: true,
                trustLevel: await identityManager.getTrustLevel(manifest.sender)
            }
        };

        channel.messages.push(localMessage);
        channelManager.notifyHandlers('message', { streamId: messageStreamId, message: localMessage });

        if (channel.type === 'dm' || channel.writeOnly) {
            await secureStorage.addSentMessage(messageStreamId, localMessage);
        }

        Logger.debug('Chunked image message sent:', imageId, {
            chunkCount: manifest.chunkCount,
            finalMime: manifest.finalMime,
            originalMime: manifest.originalMime,
            finalSizeBytes: manifest.finalSizeBytes
        });

        return {
            messageId: manifest.id,
            imageId,
            data: finalDataUrl,
            originalMime: manifest.originalMime,
            finalMime: manifest.finalMime,
            preservedOriginal: manifest.preservedOriginal,
            convertedTo: manifest.convertedTo,
            chunkCount: manifest.chunkCount,
            finalSizeBytes: manifest.finalSizeBytes
        };
    }

    async sendLegacyInlineImage(messageStreamId, file, password = null) {
        // Validate file type
        if (!CONFIG.ALLOWED_IMAGE_TYPES.includes(file.type)) {
            throw new Error(`Invalid image type. Allowed: ${CONFIG.ALLOWED_IMAGE_TYPES.join(', ')}`);
        }

        // Resize and convert to base64
        const base64Data = await this.resizeImage(file);
        
        // Generate image ID
        const imageId = crypto.randomUUID();
        
        // Cache locally
        this.imageCache.set(imageId, base64Data);
        this.imageCacheBytes += base64Data.length * 2;
        this.evictImageCacheIfNeeded();
        
        // Create image message with data embedded (so storage backends can persist it)
        // This goes to messageStream so it's stored and retrievable from history
        const announcement = await identityManager.createSignedMessage('', messageStreamId);
        announcement.type = 'image';
        announcement.imageId = imageId;
        announcement.imageData = base64Data; // Include data for persistence
        // Keep the id from createSignedMessage (signed)
        const messageId = announcement.id;
        
        // Add verification info for local display
        announcement.verified = {
            valid: true,
            trustLevel: await identityManager.getTrustLevel(announcement.sender)
        };
        
        // Add to local channel messages & notify UI immediately (for sender)
        const channel = channelManager.getChannel(messageStreamId);
        if (channel) {
            channel.messages.push(announcement);
            channelManager.notifyHandlers('message', { streamId: messageStreamId, message: announcement });
        }
        
        // DM channels: E2E encrypt and always persist locally
        if (channel?.type === 'dm' && channel.peerAddress) {
            // Sealed sender: the announcement leaves under a throwaway publisher,
            // with our real address proved inside the envelope. sealAndPublish
            // raises on missing wallet key or unknown peer public key.
            const { verified, ...cleanAnnouncement } = announcement;
            await dmManager.sealAndPublish(messageStreamId, channel.peerAddress, cleanAnnouncement);
            await secureStorage.addSentMessage(messageStreamId, announcement);
        } else {
            // Regular channels: publish with optional Streamr-level encryption
            await streamrController.publishMessage(messageStreamId, announcement, password);
            // Persist locally for write-only channels
            if (channel?.writeOnly) {
                await secureStorage.addSentMessage(messageStreamId, announcement);
            }
        }
        
        Logger.debug('Legacy inline image message sent with data:', imageId);
        
        return { messageId, imageId, data: base64Data };
    }

    isStoredImageChunkMessage(data) {
        return isStoredImageChunkMessage(data);
    }

    isStoredChunkedImageManifest(data) {
        return isStoredChunkedImageManifest(data);
    }

    async registerStoredImageChunk(messageStreamId, chunk) {
        if (!isStoredImageChunkMessage(chunk)) {
            return false;
        }
        if (this.deletedImageIds.has(chunk.imageId)) {
            // Owning message was deleted in this session — drop the chunk
            // so a paginated history cannot resurrect the image.
            return false;
        }

        const pending = this.getOrCreatePendingImageAssembly(chunk.imageId, messageStreamId);
        const existing = pending.chunks.get(chunk.chunkIndex);
        if (!existing || existing.chunkHash !== chunk.chunkHash) {
            pending.chunks.set(chunk.chunkIndex, {
                chunkHash: chunk.chunkHash,
                data: chunk.data,
                timestamp: chunk.timestamp || Date.now()
            });
        }

        this.tryAssembleStoredImage(chunk.imageId).catch(error => {
            Logger.debug('Stored image chunk assembly deferred:', error?.message || error);
        });
        return true;
    }

    async registerStoredImageManifest(messageStreamId, manifest) {
        if (!isStoredChunkedImageManifest(manifest)) {
            return false;
        }
        if (this.deletedImageIds.has(manifest.imageId)) {
            return false;
        }

        const pending = this.getOrCreatePendingImageAssembly(manifest.imageId, messageStreamId);
        pending.manifest = manifest;
        pending.streamId = messageStreamId;

        await this.tryAssembleStoredImage(manifest.imageId);
        return true;
    }

    getOrCreatePendingImageAssembly(imageId, streamId = null) {
        let pending = this.pendingImageAssemblies.get(imageId);
        if (!pending) {
            pending = {
                streamId,
                manifest: null,
                chunks: new Map(),
                timerId: null
            };
            this.pendingImageAssemblies.set(imageId, pending);
        }
        if (streamId && !pending.streamId) {
            pending.streamId = streamId;
        }
        this.schedulePendingImageAssemblyExpiry(imageId, pending);
        return pending;
    }

    schedulePendingImageAssemblyExpiry(imageId, pending) {
        if (pending.timerId) {
            clearTimeout(pending.timerId);
        }
        pending.timerId = setTimeout(() => {
            this.clearPendingImageAssembly(imageId);
        }, CONFIG.IMAGE_ASSEMBLY_TTL_MS);
    }

    clearPendingImageAssembly(imageId) {
        const pending = this.pendingImageAssemblies.get(imageId);
        if (pending?.timerId) {
            clearTimeout(pending.timerId);
        }
        this.pendingImageAssemblies.delete(imageId);
    }

    async tryAssembleStoredImage(imageId) {
        const pending = this.pendingImageAssemblies.get(imageId);
        if (!pending?.manifest) {
            return false;
        }
        if (this.imageCache.has(imageId)) {
            this.clearPendingImageAssembly(imageId);
            return true;
        }

        const { manifest, chunks, streamId } = pending;
        if (chunks.size < manifest.chunkCount) {
            return false;
        }

        const chunkBuffers = [];
        let totalBytes = 0;

        for (let chunkIndex = 0; chunkIndex < manifest.chunkCount; chunkIndex++) {
            const expectedHash = manifest.chunkHashes[chunkIndex];
            const chunk = chunks.get(chunkIndex);
            if (!chunk || chunk.chunkHash !== expectedHash) {
                return false;
            }

            const chunkBuffer = this.base64ToArrayBuffer(chunk.data);
            if (!chunkBuffer) {
                Logger.warn('Stored image chunk decode failed:', imageId, chunkIndex);
                return false;
            }

            const actualHash = await this.sha256(chunkBuffer);
            if (actualHash !== expectedHash) {
                // Keep the chunk: a future redelivery will overwrite it via
                // `registerStoredImageChunk` and the next assembly may succeed.
                Logger.warn('Stored image chunk hash mismatch (kept for redelivery):', imageId, chunkIndex);
                return false;
            }

            const chunkBytes = new Uint8Array(chunkBuffer);
            chunkBuffers.push(chunkBytes);
            totalBytes += chunkBytes.byteLength;
        }

        const assembledLimit = manifest.finalMime === 'image/gif'
            ? CONFIG.IMAGE_GIF_MAX_ASSEMBLED_BYTES
            : CONFIG.IMAGE_MAX_ASSEMBLED_BYTES;
        if (totalBytes !== manifest.finalSizeBytes || totalBytes > assembledLimit) {
            Logger.warn('Stored image assembled size mismatch:', imageId, totalBytes, manifest.finalSizeBytes);
            return false;
        }

        const assembledBytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunkBytes of chunkBuffers) {
            assembledBytes.set(chunkBytes, offset);
            offset += chunkBytes.byteLength;
        }

        const assembledHash = await this.sha256(assembledBytes.buffer);
        if (assembledHash !== manifest.assembledSha256) {
            Logger.warn('Stored image assembled hash mismatch:', imageId);
            return false;
        }

        const dataUrl = await this.bytesToDataURL(assembledBytes, manifest.finalMime);
        this.handleImageData({ type: 'image_data', imageId, data: dataUrl });

        if (streamId) {
            try {
                await secureStorage.saveImageToLedger(imageId, dataUrl, streamId);
            } catch (error) {
                Logger.debug('Stored image ledger save skipped:', error?.message || error);
            }
        }

        this.clearPendingImageAssembly(imageId);
        return true;
    }

    async prepareImageForStoredTransport(file) {
        const originalMime = String(file.type || '').toLowerCase();
        if (!originalMime) {
            throw new Error('Image MIME type is required');
        }

        const isGif = originalMime === 'image/gif';
        const sizeLimit = isGif
            ? CONFIG.IMAGE_GIF_MAX_ASSEMBLED_BYTES
            : CONFIG.IMAGE_MAX_ASSEMBLED_BYTES;

        if (file.size <= sizeLimit) {
            const originalBytes = await this.blobToArrayBuffer(file);
            return {
                blob: file,
                originalMime,
                finalMime: originalMime,
                preservedOriginal: true,
                convertedTo: null,
                qualityUsed: null,
                sha256: await this.sha256(originalBytes)
            };
        }

        if (isGif && CONFIG.FAIL_GIF_ON_OVERFLOW) {
            const limitMb = Math.round(CONFIG.IMAGE_GIF_MAX_ASSEMBLED_BYTES / (1024 * 1024));
            throw new Error(`GIF image exceeds ${limitMb}MB and cannot be compressed without losing animation`);
        }

        const image = await this.loadImageFromBlob(file);
        let encoded = null;

        if (originalMime === 'image/jpeg' || originalMime === 'image/jpg') {
            encoded = await this.compressImageToTarget(image, 'image/jpeg', {
                initialQuality: CONFIG.JPEG_INITIAL_QUALITY,
                minQuality: CONFIG.JPEG_MIN_QUALITY
            });

            if (!encoded && CONFIG.ALLOW_JPEG_TO_WEBP_FALLBACK) {
                encoded = await this.compressImageToTarget(image, 'image/webp', {
                    initialQuality: CONFIG.WEBP_INITIAL_QUALITY,
                    minQuality: CONFIG.WEBP_MIN_QUALITY
                });
            }
        } else if (originalMime === 'image/webp') {
            encoded = await this.compressImageToTarget(image, 'image/webp', {
                initialQuality: CONFIG.WEBP_INITIAL_QUALITY,
                minQuality: CONFIG.WEBP_MIN_QUALITY
            });
        } else if (originalMime === 'image/png' && CONFIG.FORCE_PNG_TO_WEBP_ON_OVERFLOW) {
            encoded = await this.compressImageToTarget(image, 'image/webp', {
                initialQuality: CONFIG.WEBP_INITIAL_QUALITY,
                minQuality: CONFIG.WEBP_MIN_QUALITY
            });
        }

        if (!encoded) {
            throw new Error(`Failed to fit ${originalMime} image under 1MB`);
        }

        const encodedBytes = await this.blobToArrayBuffer(encoded.blob);
        return {
            blob: encoded.blob,
            originalMime,
            finalMime: encoded.mime,
            preservedOriginal: false,
            convertedTo: encoded.mime !== originalMime ? encoded.mime : null,
            qualityUsed: encoded.quality,
            sha256: await this.sha256(encodedBytes)
        };
    }

    async compressImageToTarget(image, outputMime, { initialQuality, minQuality }) {
        if (!this.supportsCanvasMime(outputMime)) {
            return null;
        }

        const limit = CONFIG.IMAGE_MAX_ASSEMBLED_BYTES;
        const maxQuality = Number(Math.min(1, Math.max(initialQuality, minQuality)).toFixed(3));
        const minQ = Number(minQuality.toFixed(3));

        for (const scale of CONFIG.IMAGE_RESOLUTION_SCALES) {
            const minBlob = await this.encodeImageToBlob(image, outputMime, minQ, scale);
            if (minBlob.size > limit) {
                continue;
            }

            const maxBlob = await this.encodeImageToBlob(image, outputMime, maxQuality, scale);
            if (maxBlob.size <= limit) {
                return { blob: maxBlob, mime: outputMime, quality: maxQuality };
            }

            let lo = minQ;
            let hi = maxQuality;
            let best = { blob: minBlob, quality: minQ };
            for (let i = 0; i < 6; i += 1) {
                const mid = Number(((lo + hi) / 2).toFixed(3));
                if (mid <= lo || mid >= hi) {
                    break;
                }
                const blob = await this.encodeImageToBlob(image, outputMime, mid, scale);
                if (blob.size <= limit) {
                    if (blob.size > best.blob.size) {
                        best = { blob, quality: mid };
                    }
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            return { blob: best.blob, mime: outputMime, quality: best.quality };
        }

        return null;
    }

    async encodeImageToBlob(image, outputMime, quality = null, scale = 1) {
        const sourceWidth = image?.naturalWidth || image?.width;
        const sourceHeight = image?.naturalHeight || image?.height;
        if (!sourceWidth || !sourceHeight) {
            throw new Error('Image dimensions unavailable');
        }

        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Canvas 2D context unavailable');
        }

        if (outputMime === 'image/jpeg') {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(image, 0, 0, width, height);

        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (!blob) {
                    reject(new Error(`Failed to encode image as ${outputMime}`));
                    return;
                }
                if (blob.type !== outputMime) {
                    reject(new Error(`${outputMime} encoding is not supported in this browser`));
                    return;
                }
                resolve(blob);
            }, outputMime, quality ?? undefined);
        });
    }

    supportsCanvasMime(mime) {
        const canvas = document.createElement('canvas');
        return canvas.toDataURL(mime).startsWith(`data:${mime}`);
    }

    loadImageFromBlob(blob) {
        return new Promise((resolve, reject) => {
            const objectUrl = URL.createObjectURL(blob);
            const image = new Image();
            image.onload = () => {
                URL.revokeObjectURL(objectUrl);
                resolve(image);
            };
            image.onerror = () => {
                URL.revokeObjectURL(objectUrl);
                reject(new Error('Failed to decode image'));
            };
            image.src = objectUrl;
        });
    }

    async createStoredImageChunkPayloads({ imageId, blob, password = null, dmPeer = null, channel = null }) {
        const sourceBytes = new Uint8Array(await this.blobToArrayBuffer(blob));
        const payloadLimit = Math.max(
            1024,
            CONFIG.IMAGE_PAYLOAD_MAX_BYTES - CONFIG.IMAGE_PAYLOAD_SAFETY_MARGIN_BYTES
        );
        const chunkPayloads = [];
        let offset = 0;
        let chunkIndex = 0;

        while (offset < sourceBytes.byteLength) {
            const remainingBytes = sourceBytes.byteLength - offset;
            const minRawChunkBytes = Math.min(CONFIG.IMAGE_CHUNK_MIN_RAW_BYTES, remainingBytes);
            let rawChunkBytes = Math.min(CONFIG.IMAGE_CHUNK_INITIAL_RAW_BYTES, remainingBytes);
            let payload = null;

            while (rawChunkBytes >= minRawChunkBytes) {
                const chunkBytes = sourceBytes.slice(offset, offset + rawChunkBytes);
                const candidate = {
                    type: 'image_chunk',
                    v: STORED_IMAGE_PROTOCOL_VERSION,
                    imageId,
                    chunkIndex,
                    timestamp: Date.now(),
                    chunkHash: await this.sha256(chunkBytes.buffer),
                    data: this.arrayBufferToBase64(chunkBytes)
                };

                const payloadBytes = await this.measureStoredImagePayloadBytes(candidate, password, dmPeer, channel);
                if (payloadBytes <= payloadLimit) {
                    payload = candidate;
                    offset += rawChunkBytes;
                    break;
                }

                const nextChunkBytes = Math.max(
                    minRawChunkBytes,
                    Math.floor(rawChunkBytes * 0.85)
                );
                if (nextChunkBytes === rawChunkBytes) {
                    if (rawChunkBytes === minRawChunkBytes) {
                        break;
                    }
                    rawChunkBytes -= 1;
                } else {
                    rawChunkBytes = nextChunkBytes;
                }
            }

            if (!payload) {
                throw new Error('Failed to fit image chunk inside 220KB payload limit');
            }

            chunkPayloads.push(payload);
            chunkIndex++;
        }

        return chunkPayloads;
    }

    async measureStoredImagePayloadBytes(payload, password = null, dmPeer = null, channel = null) {
        if (dmPeer) {
            // Sealing is the only honest way to size this: the envelope carries
            // an ephemeral public key and the sender proof on top of the
            // ciphertext, and a hardcoded overhead constant would drift the
            // moment the envelope format changes.
            const { envelope } = await dmManager.sealFor(dmPeer, payload);
            return new TextEncoder().encode(JSON.stringify(envelope)).length;
        }

        if (password) {
            const encryptedPayload = await cryptoManager.encryptJSON(payload, password);
            return new TextEncoder().encode(encryptedPayload).length;
        }

        // Same reason as the DM branch: a gated channel sends the epoch
        // envelope, base64 and all, not this plaintext.
        if (channel?.type === 'gated' || channel?.gate?.address) {
            return await streamrController.epochWireBytes(
                channel, channel.messageStreamId, payload);
        }

        return new TextEncoder().encode(JSON.stringify(payload)).length;
    }

    assertPayloadBytesFit(payloadBytes, label = 'image payload') {
        if (payloadBytes > CONFIG.IMAGE_PAYLOAD_MAX_BYTES) {
            throw new Error(`${label} exceeds ${Math.round(CONFIG.IMAGE_PAYLOAD_MAX_BYTES / 1024)}KB payload limit`);
        }
        return payloadBytes;
    }

    async assertStoredImagePayloadFits(payload, password = null, dmPeer = null, label = 'image payload', channel = null) {
        const payloadBytes = await this.measureStoredImagePayloadBytes(payload, password, dmPeer, channel);
        return this.assertPayloadBytesFit(payloadBytes, label);
    }

    async publishStoredImagePayload(messageStreamId, payload, password = null, dmPeer = null, channel = null) {
        if (dmPeer) {
            // Seal ONCE and publish that exact envelope. Sizing one envelope and
            // sending a freshly sealed second one would measure a different
            // ephemeral key than the one that goes on the wire.
            const sealed = await dmManager.sealFor(dmPeer, payload);
            this.assertPayloadBytesFit(
                new TextEncoder().encode(JSON.stringify(sealed.envelope)).length
            );
            await dmManager.publishSealed(messageStreamId, sealed);
            return;
        }

        await this.assertStoredImagePayloadFits(payload, password, null, 'image payload', channel);
        await streamrController.publishMessage(messageStreamId, payload, password);
    }

    blobToDataURL(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Failed to read blob as data URL'));
            reader.readAsDataURL(blob);
        });
    }

    async blobToArrayBuffer(blob) {
        if (blob?.arrayBuffer instanceof Function) {
            const result = await blob.arrayBuffer();
            if (result instanceof ArrayBuffer) {
                return result;
            }
            if (ArrayBuffer.isView(result)) {
                return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength);
            }
        }

        if (typeof Response === 'function') {
            try {
                return await new Response(blob).arrayBuffer();
            } catch {
                // Fall through to FileReader.
            }
        }

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                if (reader.result instanceof ArrayBuffer) {
                    resolve(reader.result);
                    return;
                }
                reject(new Error('Failed to read blob as ArrayBuffer'));
            };
            reader.onerror = () => reject(new Error('Failed to read blob as ArrayBuffer'));
            reader.readAsArrayBuffer(blob);
        });
    }

    async createSignedStoredImageManifest(input) {
        if (typeof identityManager.createSignedImageManifest === 'function') {
            return identityManager.createSignedImageManifest(input);
        }

        Logger.warn('identityManager.createSignedImageManifest missing; falling back to legacy message signing');
        const manifest = await identityManager.createSignedMessage('', input.channelId);
        manifest.type = 'image';
        manifest.transport = STORED_IMAGE_TRANSPORT;
        manifest.v = STORED_IMAGE_PROTOCOL_VERSION;
        manifest.imageId = input.imageId;
        manifest.originalMime = input.originalMime;
        manifest.finalMime = input.finalMime;
        manifest.finalSizeBytes = input.finalSizeBytes;
        manifest.chunkCount = input.chunkCount;
        manifest.chunkHashes = input.chunkHashes;
        manifest.assembledSha256 = input.assembledSha256;
        manifest.preservedOriginal = !!input.preservedOriginal;
        manifest.convertedTo = input.convertedTo || null;
        manifest.qualityUsed = Number.isFinite(input.qualityUsed) ? input.qualityUsed : null;
        return manifest;
    }

    async bytesToDataURL(bytes, mime) {
        const blob = new Blob([bytes], { type: mime });
        return this.blobToDataURL(blob);
    }

    /**
     * Legacy inline image resize helper
     * @param {File} file - Image file
     * @returns {Promise<string>} - Base64 data URL
     */
    resizeImage(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            
            reader.onload = (e) => {
                const img = new Image();
                
                img.onload = () => {
                    let { width, height } = img;
                    
                    // Calculate scale if resize needed
                    if (width > CONFIG.IMAGE_MAX_WIDTH || height > CONFIG.IMAGE_MAX_HEIGHT) {
                        const scaleW = CONFIG.IMAGE_MAX_WIDTH / width;
                        const scaleH = CONFIG.IMAGE_MAX_HEIGHT / height;
                        const scale = Math.min(scaleW, scaleH);
                        width = Math.round(width * scale);
                        height = Math.round(height * scale);
                    }
                    
                    // Always re-encode through canvas as JPEG to ensure
                    // consistent format and size (PNGs/WebPs can be huge)
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    
                    // Convert to JPEG
                    resolve(canvas.toDataURL('image/jpeg', CONFIG.IMAGE_QUALITY));
                };
                
                img.onerror = () => reject(new Error('Failed to load image'));
                img.src = e.target.result;
            };
            
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }

    /**
     * Load an image file into an HTMLImageElement for cropping / preview.
     * Preserves the original alpha-capability decision so callers can render
     * previews and final uploads with the same output format.
     *
     * @param {File} file - Source image file (jpg/png/gif/webp)
     * @returns {Promise<{ image: HTMLImageElement, preserveAlpha: boolean, src: string }>}
     */
    loadImageForCrop(file) {
        return new Promise((resolve, reject) => {
            if (!CONFIG.ALLOWED_IMAGE_TYPES.includes(file.type)) {
                reject(new Error(`Invalid image type. Allowed: ${CONFIG.ALLOWED_IMAGE_TYPES.join(', ')}`));
                return;
            }

            const preserveAlpha = file.type !== 'image/jpeg' && file.type !== 'image/jpg';
            const reader = new FileReader();
            reader.onload = (e) => {
                const src = e.target?.result;
                const img = new Image();
                img.onload = () => resolve({ image: img, preserveAlpha, src });
                img.onerror = () => reject(new Error('Failed to load image'));
                img.src = src;
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }

    /**
     * Calculate the square crop framing for a given image size, viewport,
     * zoom factor, and crop center. Used by both the interactive preview and
     * the final encoded upload so they stay pixel-accurate.
     *
     * @param {number} imageWidth - Source image width in px
     * @param {number} imageHeight - Source image height in px
     * @param {number} viewportSize - Square viewport/output size in px
     * @param {number} [zoom=1] - Zoom multiplier, where 1 is the minimum cover fit
     * @param {number|null} [centerX=null] - Crop center X in source-image pixels
     * @param {number|null} [centerY=null] - Crop center Y in source-image pixels
     * @returns {{
     *   zoom: number,
     *   scale: number,
     *   centerX: number,
     *   centerY: number,
     *   minCenterX: number,
     *   maxCenterX: number,
     *   minCenterY: number,
     *   maxCenterY: number,
     *   drawWidth: number,
     *   drawHeight: number,
     *   offsetX: number,
     *   offsetY: number
     * }}
     */
    getSquareCropFrame(imageWidth, imageHeight, viewportSize, zoom = 1, centerX = null, centerY = null) {
        const safeWidth = Number(imageWidth) || 0;
        const safeHeight = Number(imageHeight) || 0;
        const safeViewport = Number(viewportSize) || 0;
        if (!safeWidth || !safeHeight || !safeViewport) {
            throw new Error('Invalid crop frame dimensions');
        }

        const safeZoom = Math.max(0.5, Number.isFinite(zoom) ? zoom : 1);
        const baseScale = safeViewport / Math.min(safeWidth, safeHeight);
        const scale = baseScale * safeZoom;
        const halfViewportInImage = safeViewport / (2 * scale);

        const minCenterX = Math.min(halfViewportInImage, safeWidth - halfViewportInImage);
        const maxCenterX = Math.max(halfViewportInImage, safeWidth - halfViewportInImage);
        const minCenterY = Math.min(halfViewportInImage, safeHeight - halfViewportInImage);
        const maxCenterY = Math.max(halfViewportInImage, safeHeight - halfViewportInImage);

        const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
        const resolvedCenterX = clamp(centerX ?? safeWidth / 2, minCenterX, maxCenterX);
        const resolvedCenterY = clamp(centerY ?? safeHeight / 2, minCenterY, maxCenterY);
        const drawWidth = safeWidth * scale;
        const drawHeight = safeHeight * scale;
        const offsetX = (safeViewport / 2) - (resolvedCenterX * scale);
        const offsetY = (safeViewport / 2) - (resolvedCenterY * scale);

        return {
            zoom: safeZoom,
            scale,
            centerX: resolvedCenterX,
            centerY: resolvedCenterY,
            minCenterX,
            maxCenterX,
            minCenterY,
            maxCenterY,
            drawWidth,
            drawHeight,
            offsetX,
            offsetY
        };
    }

    /**
     * Render an image into a square crop output using an optional zoom/center.
     *
     * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap} image - Source image
     * @param {Object} [options]
     * @param {number} [options.size=512] - Output side length in px
     * @param {number} [options.quality=0.85] - JPEG quality 0..1 (ignored for PNG)
     * @param {number} [options.zoom=1] - Zoom multiplier, where 1 is minimum cover fit
     * @param {number|null} [options.centerX=null] - Crop center X in source pixels
     * @param {number|null} [options.centerY=null] - Crop center Y in source pixels
     * @param {boolean} [options.preserveAlpha=false] - Whether to emit PNG instead of JPEG
     * @returns {string} - data:image/(jpeg|png);base64,... URL
     */
    renderSquareCrop(image, {
        size = 512,
        quality = 0.85,
        zoom = 1,
        centerX = null,
        centerY = null,
        preserveAlpha = false
    } = {}) {
        const width = image?.naturalWidth || image?.videoWidth || image?.width;
        const height = image?.naturalHeight || image?.videoHeight || image?.height;
        const frame = this.getSquareCropFrame(width, height, size, zoom, centerX, centerY);
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        if (!preserveAlpha) {
            // JPEG output: paint white baseline so any source alpha doesn't
            // bleed through as black.
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, size, size);
        }

        ctx.drawImage(image, frame.offsetX, frame.offsetY, frame.drawWidth, frame.drawHeight);
        return preserveAlpha
            ? canvas.toDataURL('image/png')
            : canvas.toDataURL('image/jpeg', quality);
    }

    /**
     * Center-crop image to square and re-encode at fixed size.
     * Preserves transparency for source formats that support alpha
     * (PNG / WebP / GIF) by emitting PNG; opaque sources (JPEG) are
     * re-encoded as JPEG for smaller payloads.
     *
     * @param {File} file - Source image file (jpg/png/gif/webp)
     * @param {number} [size=512] - Output side length in px
     * @param {number} [quality=0.85] - JPEG quality 0..1 (ignored for PNG)
     * @returns {Promise<string>} - data:image/(jpeg|png);base64,... URL
     */
    cropAndResizeSquare(file, size = 512, quality = 0.85) {
        return this.loadImageForCrop(file)
            .then(({ image, preserveAlpha }) => this.renderSquareCrop(image, {
                size,
                quality,
                preserveAlpha
            }));
    }

    /**
     * Handle incoming image data
     * @param {Object} data - Image data message
     */
    handleImageData(data) {
        if (data.type !== 'image_data' || !data.imageId || !data.data) {
            return;
        }
        if (this.deletedImageIds.has(data.imageId)) {
            // Late assembly result for a tombstoned image — do not cache
            // and do not fan-out via onImageReceived.
            return;
        }
        
        // Cache the image. Replace-aware accounting: re-deliveries of an
        // already-cached image (blob sync, ledger loads, recovery passes)
        // must not inflate imageCacheBytes — phantom bytes eventually poison
        // the budget and evictImageCacheIfNeeded evicts EVERYTHING, leaving
        // guests (no ledger fallback) with permanent "Loading image".
        const previous = this.imageCache.get(data.imageId);
        if (previous) {
            this.imageCacheBytes -= previous.length * 2;
            if (this.imageCacheBytes < 0) this.imageCacheBytes = 0;
        }
        this.imageCache.set(data.imageId, data.data);
        this.imageCacheBytes += data.data.length * 2;
        this.evictImageCacheIfNeeded();
        Logger.debug('Image received:', data.imageId);
        
        // Notify handlers
        if (this.handlers.onImageReceived) {
            this.handlers.onImageReceived(data.imageId, data.data);
        }
    }

    /**
     * Get cached image data
     * @param {string} imageId - Image ID
     * @returns {string|null} - Base64 data or null
     */
    getImage(imageId) {
        if (imageId && this.deletedImageIds.has(imageId)) return null;
        return this.imageCache.get(imageId) || null;
    }

    /**
     * Heal a stuck image placeholder. Re-fires `onImageReceived` if the
     * image is already cached, or retries assembly if the pending state
     * is complete. Safe to call repeatedly — all branches are idempotent.
     * Used to recover from re-render races that orphan placeholders.
     * @param {string} imageId
     */
    recoverImage(imageId) {
        if (!imageId) return;
        if (this.deletedImageIds.has(imageId)) return;
        const cached = this.imageCache.get(imageId);
        if (cached) {
            // Defer so the caller's freshly-rendered placeholder is in the
            // DOM before `onImageReceived` queries for it.
            const fire = () => {
                if (this.handlers.onImageReceived) {
                    try {
                        this.handlers.onImageReceived(imageId, cached);
                    } catch (e) {
                        Logger.debug('recoverImage onImageReceived error:', e?.message || e);
                    }
                }
            };
            if (typeof queueMicrotask === 'function') queueMicrotask(fire);
            else setTimeout(fire, 0);
            return;
        }
        const pending = this.pendingImageAssemblies.get(imageId);
        if (pending?.manifest && pending.chunks.size >= pending.manifest.chunkCount) {
            this.tryAssembleStoredImage(imageId).catch(err => {
                Logger.debug('recoverImage assembly retry failed:', err?.message || err);
            });
        }
    }

    /**
     * Cache image data
     * @param {string} imageId - Image ID
     * @param {string} data - Base64 image data
     */
    cacheImage(imageId, data) {
        if (this.deletedImageIds.has(imageId)) return;
        if (!this.imageCache.has(imageId)) {
            this.imageCache.set(imageId, data);
            this.imageCacheBytes += data.length * 2;
            this.evictImageCacheIfNeeded();
            Logger.debug('Image cached from message:', imageId);
        }
    }

    /**
     * Mark an imageId as deleted. Called when the owning message is deleted
     * by its author. Evicts every local artifact (RAM cache, in-flight
     * assembly state, IndexedDB ledger) and records the imageId in a
     * tombstone set so that any late arrival (paginated chunk/manifest,
     * recoverImage retry, network re-publish) is rejected for the rest of
     * this session. Safe to call repeatedly.
     * @param {string} imageId
     */
    markImageDeleted(imageId) {
        if (!imageId) return;
        this.deletedImageIds.add(imageId);

        // Evict RAM cache
        if (this.imageCache.has(imageId)) {
            const cached = this.imageCache.get(imageId);
            this.imageCacheBytes -= (cached?.length || 0) * 2;
            if (this.imageCacheBytes < 0) this.imageCacheBytes = 0;
            this.imageCache.delete(imageId);
        }

        // Drop any in-flight chunked assembly state
        this.clearPendingImageAssembly(imageId);

        // Best-effort ledger purge \u2014 fire and forget. The tombstone above
        // already prevents `loadImageFromLedger` from serving the blob even
        // if the IDB delete is slow or fails.
        try {
            secureStorage.deleteImageFromLedger?.(imageId)?.catch?.(err => {
                Logger.debug('markImageDeleted ledger delete failed:', err?.message || err);
            });
        } catch (err) {
            Logger.debug('markImageDeleted ledger delete threw:', err?.message || err);
        }
    }

    /**
     * Evict oldest image cache entries when total size exceeds byte limit (LRU by insertion order)
     */
    evictImageCacheIfNeeded() {
        if (this.imageCacheBytes <= this.MAX_IMAGE_CACHE_BYTES) return;
        let evicted = 0;
        for (const [key, value] of this.imageCache) {
            if (this.imageCacheBytes <= this.MAX_IMAGE_CACHE_BYTES) break;
            this.imageCacheBytes -= value.length * 2; // base64 string ~2 bytes/char in JS
            this.imageCache.delete(key);
            evicted++;
        }
        // Self-heal accounting drift: if the map is empty the byte counter
        // MUST be zero. Otherwise leftover phantom bytes keep the counter
        // above the limit forever and every future insert is evicted
        // immediately (permanently poisoned cache).
        if (this.imageCache.size === 0 && this.imageCacheBytes !== 0) {
            Logger.warn(`Image cache accounting drift detected (~${(this.imageCacheBytes / 1024 / 1024).toFixed(1)}MB phantom) — resetting counter`);
            this.imageCacheBytes = 0;
        }
        Logger.debug(`Image cache evicted ${evicted} entries, ~${(this.imageCacheBytes / 1024 / 1024).toFixed(1)}MB remaining`);
    }

    /**
     * Get downloaded file URL
     * @param {string} fileId - File ID
     * @returns {string|null} - Blob URL or null
     */
    getDownloadedFile(fileId) {
        return this.downloadedUrls.get(fileId) || null;
    }

    /**
     * Get local file URL (for files we're seeding)
     * @param {string} fileId - File ID
     * @returns {string|null} - Blob URL or null
     */
    getLocalFileUrl(fileId) {
        const localFile = this.localFiles.get(fileId);
        if (!localFile || !localFile.file) return null;
        
        // Create and cache blob URL if not already cached
        if (!this.downloadedUrls.has(fileId)) {
            const url = URL.createObjectURL(localFile.file);
            this.downloadedUrls.set(fileId, url);
        }
        return this.downloadedUrls.get(fileId);
    }

    /**
     * Check if a file download is in progress
     * @param {string} fileId - File ID
     * @returns {boolean}
     */
    isDownloading(fileId) {
        return this.incomingFiles.has(fileId);
    }

    /**
     * Get download progress for an active transfer
     * @param {string} fileId - File ID
     * @returns {{ percent: number, received: number, total: number, fileSize: number }|null}
     */
    getDownloadProgress(fileId) {
        const transfer = this.incomingFiles.get(fileId);
        if (!transfer) return null;
        const { receivedCount, metadata } = transfer;
        const percent = metadata.pieceCount > 0 ? Math.round(receivedCount / metadata.pieceCount * 100) : 0;
        // Recomputed against the current clock, so a re-render during a stall shows
        // the rate decaying rather than the value frozen at the last delivery
        return {
            percent,
            received: receivedCount,
            total: metadata.pieceCount,
            fileSize: metadata.fileSize,
            bytesPerSec: this.getTransferRate(transfer),
            paused: !!transfer.paused
        };
    }

    /**
     * Check if we are seeding a file
     * @param {string} fileId - File ID
     * @returns {boolean}
     */
    isSeeding(fileId) {
        return this.localFiles.has(fileId);
    }

    /**
     * Get file URL (either downloaded or local)
     * @param {string} fileId - File ID
     * @returns {string|null} - Blob URL or null
     */
    getFileUrl(fileId) {
        return this.getDownloadedFile(fileId) || this.getLocalFileUrl(fileId);
    }

    /**
     * Check if there are active media transfers (downloads or seeds) for a given channel.
     * Used by subscriptionManager to decide whether to keep P1/P2 alive on channel switch.
     * @param {string} messageStreamId - Channel message stream ID
     * @returns {boolean}
     */
    hasActiveMediaTransfers(messageStreamId) {
        // Check active downloads
        for (const [, transfer] of this.incomingFiles) {
            if (transfer.streamId === messageStreamId) return true;
        }
        // Check active seeds (local files being served)
        for (const [, fileInfo] of this.localFiles) {
            if (fileInfo.streamId === messageStreamId) return true;
        }
        return false;
    }

    /**
     * Whether any DM conversation still has an active transfer.
     *
     * Every DM shares one ephemeral stream (derived from our own address), so this
     * guard has to span conversations rather than take a stream id like
     * hasActiveMediaTransfers() does. Asking "is *this* conversation idle?" would
     * tear the stream down and cut seeding for every other DM at the same time.
     *
     * @returns {boolean}
     */
    hasActiveDMTransfers() {
        const isDM = (streamId) => channelManager.getChannel(streamId)?.type === 'dm';

        for (const [, transfer] of this.incomingFiles) {
            if (isDM(transfer.streamId)) return true;
        }
        for (const [, fileInfo] of this.localFiles) {
            if (isDM(fileInfo.streamId)) return true;
        }
        return false;
    }

    // ==================== VIDEO/FILE HANDLING ====================

    /**
     * Send a video file (chunked transfer)
     * @param {string} messageStreamId - Channel message stream ID
     * @param {File} file - Video file
     * @param {string} password - Channel password (optional)
     * @returns {Promise<Object>} - File metadata
     */
    async sendVideo(messageStreamId, file, password = null) {
        // Only the type check is video-specific; everything downstream — hashing,
        // pieces, announce, seeding — has always been type-agnostic.
        if (!CONFIG.ALLOWED_VIDEO_TYPES.includes(file.type)) {
            throw new Error(`Invalid video type. Allowed: ${CONFIG.ALLOWED_VIDEO_TYPES.join(', ')}`);
        }

        return this.sendFile(messageStreamId, file, password);
    }

    /**
     * Share a file of any type (chunked P2P transfer)
     * @param {string} messageStreamId - Channel message stream ID
     * @param {File} file - File to share
     * @param {string} password - Channel password (optional)
     * @returns {Promise<Object>} - File metadata
     */
    async sendFile(messageStreamId, file, password = null) {
        // Validate file size
        if (file.size > CONFIG.MAX_FILE_SIZE) {
            throw new Error(`File too large. Max: ${CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB`);
        }

        // A zero-byte file hashes to zero pieces, which would announce a transfer
        // that can never complete
        if (file.size === 0) {
            throw new Error('File is empty');
        }

        return new Promise((resolve, reject) => {
            const tempId = 'temp-' + crypto.randomUUID();
            const isPrivateChannel = !!password
                || usesEpochKeys(channelManager.getChannel(messageStreamId));
            
            // Store temp reference with callback
            this.localFiles.set(tempId, {
                file: file,
                streamId: messageStreamId, // Store messageStreamId for seeding
                isPrivateChannel: isPrivateChannel,
                callback: async (metadata) => {
                    try {
                        // Sign the manifest itself: every downloader verifies pieces
                        // against metadata.pieceHashes, so those hashes must be inside
                        // the signature rather than attached to it afterwards.
                        const announcement = await identityManager.createSignedFileManifest({
                            channelId: messageStreamId,
                            metadata
                        });

                        // Add verification info for local display
                        announcement.verified = {
                            valid: true,
                            trustLevel: await identityManager.getTrustLevel(announcement.sender)
                        };
                        
                        // Add to local channel messages & notify UI immediately (for sender)
                        const channel = channelManager.getChannel(messageStreamId);
                        if (channel) {
                            channel.messages.push(announcement);
                            channelManager.notifyHandlers('message', { streamId: messageStreamId, message: announcement });
                        }
                        
                        // Publish announcement to messageStream (stored).
                        //
                        // DM: EVERYTHING on a DM channel travels inside the
                        // pair's ECDH envelope — the peer's inbox is a
                        // public-publish stream, and this announce was the one
                        // DM payload still going out unsealed, leaking the
                        // file's name, size and piece hashes to anyone
                        // watching. Same sealing as dm.js sendDMMessage; both
                        // receivers (web decryptDMEnvelope, Android
                        // routeInboxMessage) accept plain AND sealed, so this
                        // breaks nothing in flight.
                        if (channel?.type === 'dm' && channel.peerAddress) {
                            const { verified, ...cleanAnnouncement } = announcement;
                            await dmManager.sealAndPublish(
                                messageStreamId, channel.peerAddress, cleanAnnouncement);
                        } else {
                            await streamrController.publishMessage(messageStreamId, announcement, password);
                        }

                        // Persist locally for write-only channels
                        if (channel?.writeOnly) {
                            await secureStorage.addSentMessage(messageStreamId, announcement);
                        }

                        // A DM cannot be replayed from the peer's inbox, so the
                        // announcement is dropped on the next loadDMTimeline() and the
                        // conversation keeps no trace of what we shared.
                        //
                        // Persist it, minus the piece hashes: those exist only to verify
                        // a download and would put ~160KB into a single sync message for
                        // a 500MB file. What remains (id, name, size, type) is ~100 bytes
                        // and is enough for this device to re-render the real bubble
                        // while it still holds the file, and for any other device to show
                        // a placeholder. Their absence is what marks the record as lean.
                        //
                        // The signature is dropped with them: it covers pieceHashes, so
                        // keeping it would store one that can never verify.
                        if (channel?.type === 'dm') {
                            const { pieceHashes, ...leanMetadata } = metadata;
                            await secureStorage.addSentMessage(messageStreamId, {
                                ...announcement,
                                metadata: leanMetadata,
                                signature: null
                            });
                        }
                        
                        Logger.info('Video announced:', metadata.fileId, metadata.fileName);
                        
                        resolve({ messageId: announcement.id, metadata });
                    } catch (error) {
                        reject(error);
                    }
                }
            });
            
            // Send to worker for hashing
            this.fileWorker.postMessage({ fileData: file, tempId });
        });
    }

    /**
     * Handle incoming media message (dispatch to appropriate handler)
     * @param {string} messageStreamId - Channel message stream ID
     * @param {Object} data - Media data
     */
    handleMediaMessage(messageStreamId, data, account) {
        // Handle binary data from MEDIA_DATA partition
        if (data instanceof Uint8Array) {
            const decoded = decodeBinaryMedia(data);
            if (!decoded) {
                Logger.debug('Unknown binary media message');
                return;
            }
            // Same rule as streamr.attachAccount, applied where binary forced the
            // proof out of the payload and into the frame: a proof that recovers
            // names the account, anything else falls back to the transport.
            // A DM piece arrives already opened, with `account` proved — it has
            // no inline proof and must not be second-guessed here.
            if (account) {
                decoded.account = (decoded.proof
                    && recoverPublisherAccount(account, decoded.proof)) || account;
            }
            return this.handleMediaMessage(messageStreamId, decoded);
        }
        
        if (!data || !data.type) return;

        switch (data.type) {
            case 'piece_request':
                this.fireAndForget('handlePieceRequest',
                    this.handlePieceRequest(messageStreamId, data));
                break;

            case 'file_piece':
                this.fireAndForget('handleFilePiece',
                    this.handleFilePiece(messageStreamId, data));
                break;

            case 'source_request':
                this.fireAndForget('handleSourceRequest',
                    this.handleSourceRequest(messageStreamId, data));
                break;

            case 'source_announce':
                this.handleSourceAnnounce(data);
                break;
                
            default:
                Logger.debug('Unknown media type:', data.type);
        }
    }

    /**
     * Start downloading a file
     * @param {string} messageStreamId - Channel message stream ID
     * @param {Object} metadata - File metadata from announcement
     * @param {string} password - Channel password (optional)
     */
    async startDownload(messageStreamId, metadata, password = null) {
        const { fileId, fileName, fileSize, fileType, pieceCount, pieceHashes } = metadata;
        
        if (this.incomingFiles.has(fileId)) {
            Logger.warn('Download already in progress:', fileId);
            return;
        }
        
        // Lazy-subscribe to media partitions P1+P2 (needed for piece_request/file_piece)
        const ephemeralStreamId = deriveEphemeralId(messageStreamId);
        await streamrController.ensureMediaSubscription(ephemeralStreamId);
        
        // Initialize transfer state
        const transfer = {
            metadata,
            streamId: messageStreamId, // Store messageStreamId for channel lookup and seeding
            password,
            isPrivateChannel: !!password
                || usesEpochKeys(channelManager.getChannel(messageStreamId)),
            pieceStatus: new Array(pieceCount).fill('pending'),
            requestsInFlight: new Map(),
            pieceFailures: new Map(),
            // Seeders that already served a given piece corrupt, and a running tally
            // per seeder across the whole transfer
            pieceExclusions: new Map(),
            seederStrikes: new Map(),
            // Survives across manageDownload() calls so retries actually rotate
            seederCursor: 0,
            receivedCount: 0,
            pieces: new Array(pieceCount).fill(null),
            useIndexedDB: this.db && fileSize > 10 * 1024 * 1024, // Use IndexedDB for files > 10MB
            // Seeder discovery tracking
            seederRequestCount: 0,
            lastSeederRequest: 0,
            seederDiscoveryTimer: null,
            noSeederRetryTimer: null,
            downloadStarted: false,
            // Set by pauseDownload()/resumeDownload() — see cancelDownload's
            // doc comment for why pause keeps everything cancelDownload deletes.
            paused: false,
            // Adaptive request window (AIMD): grows per delivered piece, halves on timeout
            window: CONFIG.PIECE_WINDOW_START,
            lastWindowBackoffAt: 0,
            // Measured per transfer: paths differ per peer and per network
            rto: new PieceRtoEstimator(CONFIG.PIECE_REQUEST_TIMEOUT)
        };
        
        this.incomingFiles.set(fileId, transfer);
        this.fileSeeders.set(fileId, new Set());

        // Resume: pieces from a previous session survive in IndexedDB (reset() keeps
        // them deliberately — only cancelDownload clears them). Rehydrate the piece
        // index so we request just what is missing instead of re-downloading everything.
        if (transfer.useIndexedDB) {
            const restored = await this.restorePiecesFromIndexedDB(fileId, transfer);

            if (restored > 0) {
                Logger.info(`Resuming ${fileId.slice(0, 8)}: ${restored}/${pieceCount} pieces already local`);

                if (this.handlers.onFileProgress) {
                    const progress = Math.round((restored / pieceCount) * 100);
                    this.handlers.onFileProgress(fileId, progress, restored, pieceCount, fileSize);
                }

                // Fully downloaded last session but never assembled — no network needed.
                if (restored === pieceCount) {
                    Logger.info('All pieces already local, assembling without download:', fileId);
                    await this.assembleFile(fileId);
                    return;
                }
            }
        }

        // Start parallel seeder discovery
        this.startSeederDiscovery(fileId);

        Logger.info('Started download:', fileId, fileName);
    }

    /**
     * Start parallel seeder discovery with retries
     */
    async startSeederDiscovery(fileId) {
        const transfer = this.incomingFiles.get(fileId);
        if (!transfer) return;
        
        const seeders = this.fileSeeders.get(fileId);
        
        // Request seeders immediately
        await this.requestFileSources(transfer.streamId, fileId, transfer.password);
        transfer.seederRequestCount++;
        transfer.lastSeederRequest = Date.now();
        
        // Setup discovery timer for retries
        const discoveryLoop = async () => {
            const currentTransfer = this.incomingFiles.get(fileId);
            if (!currentTransfer || currentTransfer.paused) return; // Completed, cancelled, or paused

            // Push-mode already started — no more discovery needed
            if (currentTransfer.downloadStarted) return;
            
            const currentSeeders = this.fileSeeders.get(fileId);
            const seederCount = currentSeeders?.size || 0;
            const now = Date.now();
            
            // Check if we need more seeders
            const needMoreSeeders = seederCount < CONFIG.PREFERRED_SEEDERS;
            const canRequestMore = currentTransfer.seederRequestCount < CONFIG.MAX_SEEDER_REQUESTS;
            const enoughTimePassed = (now - currentTransfer.lastSeederRequest) >= CONFIG.SEEDER_REQUEST_INTERVAL;
            
            if (needMoreSeeders && canRequestMore && enoughTimePassed) {
                Logger.debug(`Requesting more seeders for ${fileId} (current: ${seederCount}, requests: ${currentTransfer.seederRequestCount})`);
                await this.requestFileSources(currentTransfer.streamId, fileId, currentTransfer.password);
                currentTransfer.seederRequestCount++;
                currentTransfer.lastSeederRequest = now;
            }
            
            // Continue discovery if download is in progress (for resilience)
            if (!currentTransfer.downloadStarted || seederCount < CONFIG.PREFERRED_SEEDERS) {
                const discoveryElapsed = now - (currentTransfer.downloadStartTime || now);
                if (discoveryElapsed < CONFIG.SEEDER_DISCOVERY_TIMEOUT) {
                    currentTransfer.seederDiscoveryTimer = setTimeout(discoveryLoop, CONFIG.SEEDER_REQUEST_INTERVAL);
                } else if (!currentTransfer.downloadStarted && seederCount === 0) {
                    Logger.warn(`No seeders found for ${fileId} after ${CONFIG.SEEDER_DISCOVERY_TIMEOUT}ms`);
                    // Try one last time with broadcast
                    await this.requestFileSources(currentTransfer.streamId, fileId, currentTransfer.password);
                }
            }
        };
        
        // Mark download start time
        transfer.downloadStartTime = Date.now();
        
        // Start the discovery loop after initial delay
        transfer.seederDiscoveryTimer = setTimeout(discoveryLoop, CONFIG.SEEDER_REQUEST_INTERVAL);
    }

    /**
     * Append a delivery sample for rate measurement.
     *
     * The rate is measured, never derived from the request window. window * pieceSize
     * / RTT models what the protocol *should* achieve and diverges from reality
     * exactly when it matters — retries, duplicate deliveries from several seeders,
     * or a sender-side bottleneck. index.storage.html reaches the same conclusion:
     * it computes the modelled figure but labels it "theoretical" and keeps it well
     * away from the measured speed.
     *
     * @param {Object} transfer - Transfer state
     * @param {number} byteCount - Bytes just delivered
     */
    recordThroughput(transfer, byteCount) {
        transfer.bytesTransferred = (transfer.bytesTransferred || 0) + byteCount;
        transfer.speedSamples = transfer.speedSamples || [];
        transfer.speedSamples.push({ at: Date.now(), bytes: transfer.bytesTransferred });
    }

    /**
     * Per-file upload bookkeeping, created on first use.
     * @param {string} fileId - File ID
     * @returns {Object} { speedSamples, bytesTransferred, leechers }
     */
    uploadStateFor(fileId) {
        let state = this.uploads.get(fileId);
        if (!state) {
            state = { speedSamples: [], bytesTransferred: 0, leechers: new Map() };
            this.uploads.set(fileId, state);
        }
        return state;
    }

    /**
     * Note that a peer asked us for a piece.
     *
     * There is no join or leave on a swarm, so a leecher is simply someone who has
     * asked recently — the count ages out rather than being explicitly removed.
     *
     * @param {string} fileId - File ID
     * @param {string} peerId - Requesting peer address
     */
    recordLeecher(fileId, peerId) {
        if (!peerId) return;
        this.uploadStateFor(fileId).leechers.set(peerId.toLowerCase(), Date.now());
    }

    /**
     * Upload rate and current leecher count for a file we are serving.
     *
     * @param {string} fileId - File ID
     * @param {number} [now] - Clock override, for tests
     * @returns {{bytesPerSec: number|null, leechers: number}}
     */
    getUploadStats(fileId, now = Date.now()) {
        const state = this.uploads.get(fileId);
        if (!state) return { bytesPerSec: null, leechers: 0 };

        const cutoff = now - CONFIG.LEECHER_TIMEOUT_MS;
        for (const [peer, lastAt] of state.leechers) {
            if (lastAt < cutoff) state.leechers.delete(peer);
        }

        return {
            bytesPerSec: this.getTransferRate(state, now),
            leechers: state.leechers.size
        };
    }

    /**
     * Sliding-window transfer rate in bytes per second.
     *
     * The span is capped by `now` rather than by the newest sample, so a stall drags
     * the rate toward zero instead of freezing it at whatever was flowing before
     * everything stopped — samples only arrive on delivery, so without this the
     * display would keep reporting a healthy rate for a dead transfer.
     *
     * @param {Object} transfer - Transfer state
     * @param {number} [now] - Clock override, for tests
     * @returns {number|null} Bytes per second, or null until there is a second to measure
     */
    getTransferRate(transfer, now = Date.now()) {
        const samples = transfer?.speedSamples;
        if (!samples || samples.length < 2) return null;

        // Prune against the second sample so the window still spans the full period
        const cutoff = now - CONFIG.SPEED_WINDOW_MS;
        while (samples.length > 2 && samples[1].at <= cutoff) samples.shift();

        const first = samples[0];
        const last = samples[samples.length - 1];
        const span = (Math.max(now, last.at) - first.at) / 1000;
        if (span < 1) return null;

        return Math.round((last.bytes - first.bytes) / span);
    }

    /**
     * Widen the request window after a successful delivery (additive increase).
     * @param {Object} transfer - Transfer state
     */
    growWindow(transfer) {
        transfer.window = Math.min(CONFIG.PIECE_WINDOW_MAX, transfer.window + 1);
    }

    /**
     * Halve the request window after a timeout (multiplicative decrease).
     *
     * The cooldown matters: every outstanding request expires at roughly the same
     * moment, so a single stall produces a burst of timeouts. Without it the window
     * would collapse to the floor on the first hiccup instead of backing off once.
     *
     * @param {Object} transfer - Transfer state
     */
    shrinkWindow(transfer) {
        const now = Date.now();
        if (now - (transfer.lastWindowBackoffAt || 0) < CONFIG.PIECE_WINDOW_BACKOFF_COOLDOWN) {
            return;
        }

        transfer.lastWindowBackoffAt = now;
        transfer.window = Math.max(CONFIG.PIECE_WINDOW_MIN, Math.floor(transfer.window / 2));
        Logger.debug(`Request window backed off to ${transfer.window}`);
    }

    /**
     * Choose a seeder for a piece, skipping any that already served it corrupt.
     *
     * The cursor lives on the transfer rather than being reset per call. It used to
     * restart at zero every time, which meant a retried piece — usually the only
     * pending one, since the window is otherwise full — went back to the same peer
     * every time. A bad seeder at the head of the set could never be rotated away
     * from, so the failure cap fired instead of the transfer healing itself.
     *
     * @param {Object} transfer - Transfer state
     * @param {string[]} seederArray - Known seeders
     * @param {number} pieceIndex - Piece to request
     * @returns {string|null} null when every known seeder is excluded for this piece
     */
    pickSeederFor(transfer, seederArray, pieceIndex) {
        if (seederArray.length === 0) return null;

        const excluded = transfer.pieceExclusions?.get(pieceIndex);
        transfer.seederCursor = transfer.seederCursor || 0;

        for (let attempt = 0; attempt < seederArray.length; attempt++) {
            const candidate = seederArray[transfer.seederCursor % seederArray.length];
            transfer.seederCursor++;

            if (!excluded || !excluded.has(candidate)) return candidate;
        }

        return null;
    }

    /**
     * Attribute a corrupt piece to the peer that served it.
     *
     * Two levels, because they solve different problems. The per-piece exclusion
     * makes the retry land somewhere else by construction rather than by luck. The
     * strike count catches a peer that is broken rather than unlucky — exclusion
     * alone would let it ruin every other piece in turn, one at a time.
     *
     * @param {Object} transfer - Transfer state
     * @param {string} fileId - File ID
     * @param {number} pieceIndex - Piece that failed
     * @param {string} account - Peer that published the bad piece
     */
    blameSeeder(transfer, fileId, pieceIndex, account) {
        const seederId = account.toLowerCase();

        let excluded = transfer.pieceExclusions?.get(pieceIndex);
        if (!excluded) {
            excluded = new Set();
            transfer.pieceExclusions?.set(pieceIndex, excluded);
        }
        excluded.add(seederId);

        const strikes = (transfer.seederStrikes?.get(seederId) || 0) + 1;
        transfer.seederStrikes?.set(seederId, strikes);

        if (strikes < CONFIG.MAX_SEEDER_STRIKES) return;

        const seeders = this.fileSeeders.get(fileId);
        if (seeders?.delete(seederId)) {
            Logger.warn(`Dropped seeder ${seederId.slice(0, 10)} after ${strikes} bad pieces`);

            if (this.handlers.onSeederUpdate) {
                this.handlers.onSeederUpdate(fileId, seeders.size);
            }
        }
    }

    /**
     * Manage download - request missing pieces with round-robin load balancing
     */
    manageDownload(fileId) {
        const transfer = this.incomingFiles.get(fileId);
        if (!transfer || transfer.paused) return;

        const seeders = this.fileSeeders.get(fileId);
        if (!seeders || seeders.size === 0) {
            // No seeders yet - seeder discovery will trigger us when ready
            if (transfer.downloadStarted) {
                // We had seeders but lost them - request more
                Logger.debug(`Lost all seeders for ${fileId}, requesting more...`);
                this.fireAndForget('requestFileSources (lost seeders)',
                    this.requestFileSources(transfer.streamId, fileId, transfer.password));
            }
            // Keep a single pending retry. manageDownload() is re-entered on every
            // delivery and every timeout, so scheduling one timer per call would
            // pile up hundreds of them while we wait for a seeder.
            if (!transfer.noSeederRetryTimer) {
                transfer.noSeederRetryTimer = setTimeout(() => {
                    transfer.noSeederRetryTimer = null;
                    this.manageDownload(fileId);
                }, 1000);
            }
            return;
        }

        const seederArray = Array.from(seeders);

        // Fill the adaptive window. requestPiece() marks the piece and registers it
        // in requestsInFlight synchronously, so this bound holds even though the
        // publish itself is async.
        for (let i = 0; i < transfer.pieceStatus.length; i++) {
            if (transfer.requestsInFlight.size >= transfer.window) break;

            if (transfer.pieceStatus[i] === 'pending') {
                const seederId = this.pickSeederFor(transfer, seederArray, i);

                if (!seederId) {
                    // Every known seeder has served this piece corrupt. Forgetting the
                    // exclusions beats deadlocking on it, and a wider search may turn
                    // up a peer that can actually serve it.
                    Logger.warn(`All seeders excluded for piece ${i}, retrying them and widening the search`);
                    transfer.pieceExclusions?.delete(i);
                    this.fireAndForget('requestFileSources (all seeders excluded)',
                        this.requestFileSources(transfer.streamId, fileId, transfer.password));
                    continue;
                }

                this.fireAndForget(`requestPiece ${i}`,
                    this.requestPiece(fileId, i, seederId));
            }
        }
        
        // Periodic seeder refresh during slow downloads
        const now = Date.now();
        if (transfer.lastSeederRequest && 
            (now - transfer.lastSeederRequest) > CONFIG.SEEDER_REFRESH_INTERVAL &&
            seeders.size < CONFIG.PREFERRED_SEEDERS &&
            transfer.seederRequestCount < CONFIG.MAX_SEEDER_REQUESTS) {
            Logger.debug(`Refreshing seeders for slow download ${fileId}`);
            this.fireAndForget('requestFileSources (slow-download refresh)',
                this.requestFileSources(transfer.streamId, fileId, transfer.password));
            transfer.seederRequestCount++;
            transfer.lastSeederRequest = now;
        }
    }

    /**
     * Request a specific piece from a seeder
     * Requests go to ephemeralStream (not stored)
     */
    async requestPiece(fileId, pieceIndex, seederId) {
        const transfer = this.incomingFiles.get(fileId);
        if (!transfer) return;
        
        transfer.pieceStatus[pieceIndex] = 'requested';
        
        const timeoutId = setTimeout(() => {
            // Request timed out - reset if still waiting or processing
            const status = transfer.pieceStatus[pieceIndex];
            if (status === 'requested' || status === 'processing') {
                transfer.rto.onTimeout();
                Logger.debug(`Piece ${pieceIndex} timed out (was ${status}), ` +
                    `next wait ${transfer.rto.currentMs()}ms`);
                transfer.pieceStatus[pieceIndex] = 'pending';
                transfer.requestsInFlight.delete(pieceIndex);
                // A timeout is the congestion signal: back off, then retry
                this.shrinkWindow(transfer);
                this.manageDownload(fileId);
            }
        }, transfer.rto.currentMs());

        transfer.requestsInFlight.set(pieceIndex, { seederId, timeoutId, sentAt: Date.now() });
        
        // Derive ephemeral stream ID for P2P request
        const ephemeralStreamId = deriveEphemeralId(transfer.streamId);
        
        const request = {
            type: 'piece_request',
            fileId,
            pieceIndex,
            targetSeederId: seederId
        };
        
        // DM channels: sealed sender — the signal goes out under a throwaway
        // publisher, with our address proved inside the envelope.
        const dmPeer = this._getDMPeer(transfer.streamId);
        if (dmPeer) {
            await dmManager.sealAndPublish(
                ephemeralStreamId, dmPeer, request,
                STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_SIGNALS);
        } else {
            await streamrController.publishMediaSignal(ephemeralStreamId, request, transfer.password);
        }
    }

    /**
     * Handle piece request (we are a seeder)
     * Note: Addresses must be normalized to lowercase for comparison
     * because Streamr metadata.publisherId is always lowercase
     * @param {string} messageStreamId - Channel message stream ID
     */
    async handlePieceRequest(messageStreamId, data) {
        const myAddress = authManager.getAddress()?.toLowerCase();
        const targetAddress = data.targetSeederId?.toLowerCase();

        if (!myAddress || targetAddress !== myAddress) {
            // Not for us - ignore silently
            return;
        }
        
        const localFile = this.localFiles.get(data.fileId);
        if (!localFile) {
            Logger.warn('piece_request for unknown file:', data.fileId?.slice(0, 8));
            return;
        }
        
        // The request's publisher is the leecher pulling from us
        this.recordLeecher(data.fileId, data.account);

        Logger.debug('Sending piece', data.pieceIndex, 'of', data.fileId?.slice(0, 8));
        await this.sendPiece(messageStreamId, data.fileId, data.pieceIndex);
    }

    /**
     * Send a file piece (queued with throttling)
     * Piece data is encrypted with channel password for private channels
     * Pieces go to ephemeralStream (not stored)
     * @param {string} messageStreamId - Channel message stream ID
     */
    async sendPiece(messageStreamId, fileId, pieceIndex) {
        // Queue the piece send request
        return new Promise((resolve) => {
            this.pieceSendQueue.push({ messageStreamId, fileId, pieceIndex, resolve });
            this.processPieceQueue();
        });
    }

    /**
     * Process the piece send queue with bounded concurrency
     * Allows up to CONCURRENT_SENDS parallel Streamr publishes to hide network latency
     */
    async processPieceQueue() {
        while (this.pieceSendQueue.length > 0 && this.activeSends < CONFIG.CONCURRENT_SENDS) {
            const { messageStreamId, fileId, pieceIndex, resolve } = this.pieceSendQueue.shift();
            
            // Throttle: wait for minimum delay since last send
            const now = Date.now();
            const elapsed = now - this.lastPieceSentTime;
            if (elapsed < CONFIG.PIECE_SEND_DELAY) {
                await new Promise(r => setTimeout(r, CONFIG.PIECE_SEND_DELAY - elapsed));
            }
            this.lastPieceSentTime = Date.now();
            
            // Launch send concurrently (don't await)
            this.activeSends++;
            // The queue must drain either way, so a failed send still resolves —
            // but it must not vanish. Silently swallowing here is what makes a
            // stalled download unexplainable from BOTH sides: the leecher just
            // times out, and the seeder shows nothing at all.
            this._sendPieceImmediate(messageStreamId, fileId, pieceIndex)
                .then(() => resolve())
                .catch(error => {
                    Logger.warn(
                        `Media P2P: failed to send piece ${pieceIndex} of ${fileId} —`,
                        error?.message || error);
                    resolve();
                })
                .finally(() => {
                    this.activeSends--;
                    this.processPieceQueue(); // drain next from queue
                });
        }
    }

    /**
     * Actually send a file piece (internal, called by queue processor)
     * Pieces go to ephemeralStream (not stored)
     * @param {string} messageStreamId - Channel message stream ID
     */
    async _sendPieceImmediate(messageStreamId, fileId, pieceIndex) {
        const localFile = this.localFiles.get(fileId);
        if (!localFile) return;
        
        const { file, metadata } = localFile;
        const start = pieceIndex * CONFIG.PIECE_SIZE;
        const end = Math.min(start + CONFIG.PIECE_SIZE, file.size);
        
        const chunk = file.slice(start, end);
        const arrayBuffer = await chunk.arrayBuffer();
        
        // Get channel password for encryption
        const channel = channelManager.getChannel(messageStreamId);
        const password = channel?.password || null;
        
        // Derive ephemeral stream ID for P2P data
        const ephemeralStreamId = deriveEphemeralId(messageStreamId);
        
        // DM channels: sealed sender. The piece goes out under the transfer's
        // throwaway publisher, with our address proved inside the ciphertext.
        const dmPeer = this._getDMPeer(messageStreamId);
        if (dmPeer) {
            const sealer = await this._binarySealerFor(localFile, messageStreamId, dmPeer);
            const sealed = await sealer.seal(
                encodeFilePiece(fileId, pieceIndex, arrayBuffer));
            await streamrController.publishMediaDataAs(
                ephemeralStreamId, sealed, sealer.identity);
            Logger.debug('Sent piece (binary sealed)', pieceIndex, 'of', fileId);
        } else if (usesEpochKeys(channel)) {
            // Gated channels: the piece is sealed with the epoch key, no
            // inline proof — authorship comes from the same place as the
            // channel's messages (envelope signer via resolveAuthor). The
            // channel pseudonym cannot carry these: an ephemeral key holds
            // no grant.
            const payload = encodeFilePiece(fileId, pieceIndex, arrayBuffer);
            await streamrController.publishMediaDataEpoch(channel, ephemeralStreamId, payload);
            Logger.debug('Sent piece (binary epoch)', pieceIndex, 'of', fileId);
        } else {
            // Channels: the piece carries the proof inline. There is no single
            // recipient to seal to, and the channel password — or nothing, in a
            // public channel — is already the confidentiality boundary.
            const { identity, proof } = getChannelIdentity(ephemeralStreamId);
            let payload = encodeSignedFilePiece(proof, fileId, pieceIndex, arrayBuffer);
            if (password) {
                payload = await cryptoManager.encryptBinary(payload, password);
            }
            await streamrController.publishMediaDataAs(ephemeralStreamId, payload, identity);
            Logger.debug('Sent piece (binary signed)', pieceIndex, 'of', fileId,
                password ? '(encrypted)' : '');
        }
        this.recordThroughput(this.uploadStateFor(fileId), arrayBuffer.byteLength);
        this.emitUploadStats(fileId);
    }

    /**
     * Publish serving stats, throttled.
     *
     * A piece leaves every few milliseconds under a wide window, so emitting per
     * piece would repaint the bubble far faster than anyone can read it.
     *
     * @param {string} fileId - File ID
     */
    emitUploadStats(fileId) {
        if (!this.handlers.onUploadProgress) return;

        const state = this.uploadStateFor(fileId);
        const now = Date.now();

        // Throttled per file — serving two files at once should not starve one of them
        if (now - (state.lastEmitAt || 0) >= CONFIG.UPLOAD_STATS_INTERVAL_MS) {
            state.lastEmitAt = now;
            const { bytesPerSec, leechers } = this.getUploadStats(fileId, now);
            this.handlers.onUploadProgress(fileId, bytesPerSec, leechers);
        }

        this.scheduleUploadDecay(fileId);
    }

    /**
     * Keep republishing serving stats after the last piece goes out.
     *
     * The rate decays with the clock, but only if something recomputes it. Pieces
     * stop the moment a leecher finishes, so without this the bubble would keep
     * displaying whatever was flowing at that instant, forever.
     *
     * @param {string} fileId - File ID
     */
    scheduleUploadDecay(fileId) {
        const state = this.uploadStateFor(fileId);
        if (state.decayTimer) return;

        state.decayTimer = setInterval(() => {
            const { bytesPerSec, leechers } = this.getUploadStats(fileId);

            if (this.handlers.onUploadProgress) {
                this.handlers.onUploadProgress(fileId, bytesPerSec, leechers);
            }

            // Idle: nothing flowing and nobody asking. Stop until a piece goes out again.
            if (!bytesPerSec && leechers === 0) {
                clearInterval(state.decayTimer);
                state.decayTimer = null;
            }
        }, CONFIG.UPLOAD_STATS_INTERVAL_MS);
    }

    /**
     * Handle received file piece
     * @param {string} messageStreamId - Channel message stream ID
     */
    async handleFilePiece(messageStreamId, data) {
        // Skip our own pieces (self-filtering)
        const myAddress = authManager.getAddress()?.toLowerCase();
        const senderAddress = data.account?.toLowerCase();
        
        if (senderAddress === myAddress) {
            return;
        }
        
        const transfer = this.incomingFiles.get(data.fileId);
        if (!transfer) {
            return;
        }
        
        const { fileId, pieceIndex } = data;
        
        // Skip if piece already done
        if (transfer.pieceStatus[pieceIndex] === 'done') {
            Logger.debug('Piece already done, skipping:', pieceIndex);
            return;
        }
        // In push-mode, accept pieces that are 'pending' (not yet requested)
        // In request-mode, only accept 'requested' pieces
        const status = transfer.pieceStatus[pieceIndex];
        if (status !== 'requested' && status !== 'pending' && status !== 'processing') {
            Logger.debug('Piece in unexpected state:', pieceIndex, status);
            return;
        }
        
        // Mark as processing to prevent race conditions
        transfer.pieceStatus[pieceIndex] = 'processing';
        
        // Decode piece (Uint8Array from binary protocol, or base64 legacy)
        let pieceBuffer;
        if (data.data instanceof Uint8Array) {
            pieceBuffer = data.data.buffer.byteLength === data.data.length 
                ? data.data.buffer 
                : data.data.buffer.slice(data.data.byteOffset, data.data.byteOffset + data.data.byteLength);
        } else {
            pieceBuffer = this.base64ToArrayBuffer(data.data);
        }
        if (!pieceBuffer) {
            this.registerPieceFailure(transfer, fileId, pieceIndex, 'decode failed', data.account);
            return;
        }

        // Verify hash
        const receivedHash = await this.sha256(pieceBuffer);
        if (receivedHash !== transfer.metadata.pieceHashes[pieceIndex]) {
            this.registerPieceFailure(transfer, fileId, pieceIndex, 'hash mismatch', data.account);
            return;
        }
        
        // Clear timeout
        const request = transfer.requestsInFlight.get(pieceIndex);
        if (request) {
            clearTimeout(request.timeoutId);
            transfer.requestsInFlight.delete(pieceIndex);
            // Feed the RTT estimator. Only pieces still marked in flight count: one
            // that already timed out has no honest round-trip to report (we stopped
            // waiting), and folding a late arrival in as a sample would teach the
            // estimator the very delay it is meant to detect.
            if (request.sentAt) {
                transfer.rto.onSample(Date.now() - request.sentAt);
            }
        }
        
        // Store piece
        if (transfer.useIndexedDB) {
            await this.savePieceToIndexedDB(fileId, pieceIndex, new Uint8Array(pieceBuffer));
        } else {
            transfer.pieces[pieceIndex] = new Uint8Array(pieceBuffer);
        }
        
        transfer.pieceStatus[pieceIndex] = 'done';
        transfer.receivedCount++;

        this.recordThroughput(transfer, pieceBuffer.byteLength);
        const bytesPerSec = this.getTransferRate(transfer);

        // Notify progress with file size for MB display
        const progress = Math.round((transfer.receivedCount / transfer.metadata.pieceCount) * 100);
        if (this.handlers.onFileProgress) {
            this.handlers.onFileProgress(fileId, progress, transfer.receivedCount, transfer.metadata.pieceCount, transfer.metadata.fileSize, bytesPerSec);
        }
        
        // Check if complete - verify all pieces are done
        const doneCount = transfer.pieceStatus.filter(s => s === 'done').length;
        if (doneCount === transfer.metadata.pieceCount) {
            await this.assembleFile(fileId);
        } else {
            // Grow only while the path is not already queueing. Growing on every
            // delivery regardless is how the window inflates past what the link can
            // carry: throughput stops improving, round-trips triple, and the only
            // thing that would pull it back — a timeout — has been tuned out of
            // existence by the RTO estimator. Rising delay is the earlier signal.
            if (transfer.rto.isCongested()) {
                transfer.window = Math.max(CONFIG.PIECE_WINDOW_MIN, transfer.window - 1);
            } else {
                this.growWindow(transfer);
            }
            this.manageDownload(fileId);
        }
    }

    /**
     * Assemble completed file
     */
    async assembleFile(fileId) {
        const transfer = this.incomingFiles.get(fileId);
        if (!transfer) return;
        
        // Double-check all pieces are done
        const doneCount = transfer.pieceStatus.filter(s => s === 'done').length;
        const expectedCount = transfer.metadata.pieceCount;
        
        if (doneCount !== expectedCount) {
            Logger.error(`Assembly aborted: only ${doneCount}/${expectedCount} pieces done`);
            // Re-trigger download for missing pieces
            this.manageDownload(fileId);
            return;
        }
        
        Logger.info('Assembling file:', fileId, `(${expectedCount} pieces, ${transfer.metadata.fileSize} bytes)`);
        
        let blob;
        
        if (transfer.useIndexedDB) {
            blob = await this.assembleFromIndexedDB(fileId, transfer.metadata);
        } else {
            // Combine all pieces in order
            const totalSize = transfer.pieces.reduce((sum, p) => sum + (p?.length || 0), 0);

            // Verify total size matches expected
            if (totalSize !== transfer.metadata.fileSize) {
                Logger.warn(`Size mismatch: got ${totalSize}, expected ${transfer.metadata.fileSize}`);
            }

            for (let i = 0; i < transfer.pieces.length; i++) {
                if (!transfer.pieces[i]) {
                    Logger.error(`Missing piece at index ${i} during assembly!`);
                }
            }

            // Blob concatenates the parts itself, so we never allocate a contiguous
            // copy of the whole file (peak RAM used to be ~2x the file size).
            // filter() drops missing pieces, matching the old skip-and-continue behaviour;
            // a null left in the array would be stringified to "null" and corrupt the file.
            blob = new Blob(transfer.pieces.filter(Boolean), { type: transfer.metadata.fileType });
        }
        
        // Every piece was hash-verified on arrival, so a size mismatch here means
        // pieces went missing between verification and assembly — the file is not
        // what the sender announced. Refuse it instead of handing the UI a blob
        // that looks fine and plays as a truncated or corrupt file.
        if (!blob || blob.size !== transfer.metadata.fileSize) {
            this.failDownload(
                fileId,
                `Assembled file is ${blob?.size ?? 0} bytes, expected ${transfer.metadata.fileSize}`
            );
            return;
        }

        Logger.info(`File assembled correctly: ${blob.size} bytes`);

        // Create object URL
        const url = URL.createObjectURL(blob);
        
        // Cache the download URL for later access
        this.downloadedUrls.set(fileId, url);
        
        // Register as a local file *before* notifying: the completion handler paints
        // the bubble, and it asks isSeeding() to decide on the green icon, the serving
        // statistics and the "seeding..." line. Setting this afterwards left the fresh
        // bubble looking like a plain download until something re-rendered it.
        this.localFiles.set(fileId, {
            file: blob,
            metadata: transfer.metadata,
            streamId: transfer.streamId,
            persisted: false
        });

        // Notify completion
        if (this.handlers.onFileComplete) {
            this.handlers.onFileComplete(fileId, transfer.metadata, url, blob);
        }

        // Announce as seeder
        await this.announceFileSource(transfer.streamId, fileId, transfer.password);
        
        // Persist for seeding across sessions
        const persisted = await this.persistSeedFile(
            fileId, 
            blob, 
            transfer.metadata, 
            transfer.streamId,
            transfer.isPrivateChannel
        );
        if (persisted) {
            const localFile = this.localFiles.get(fileId);
            if (localFile) localFile.persisted = true;
        }
        
        // Clean up seeder discovery timer
        if (transfer.seederDiscoveryTimer) {
            clearTimeout(transfer.seederDiscoveryTimer);
        }
        if (transfer.noSeederRetryTimer) {
            clearTimeout(transfer.noSeederRetryTimer);
        }

        // Clean up transfer state
        this.incomingFiles.delete(fileId);
        if (this.db) {
            await this.clearFileFromIndexedDB(fileId);
        }
        
        Logger.info('File complete:', transfer.metadata.fileName);
    }

    /**
     * Request file sources (seeders)
     * Requests go to ephemeralStream (not stored)
     * @param {string} messageStreamId - Channel message stream ID
     */
    async requestFileSources(messageStreamId, fileId, password = null) {
        const ephemeralStreamId = deriveEphemeralId(messageStreamId);
        const request = {
            type: 'source_request',
            fileId
        };

        // DM channels: sealed sender (see requestPiece)
        const dmPeer = this._getDMPeer(messageStreamId);
        if (dmPeer) {
            await dmManager.sealAndPublish(
                ephemeralStreamId, dmPeer, request,
                STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_SIGNALS);
        } else {
            await streamrController.publishMediaSignal(ephemeralStreamId, request, password);
        }
        Logger.debug('Requested sources for:', fileId);
    }

    /**
     * Handle source request
     * Respond with seeder announcement (encrypted if private channel)
     * Response goes to ephemeralStream (not stored)
     */
    async handleSourceRequest(messageStreamId, data) {
        if (this.localFiles.has(data.fileId)) {
            // Get channel password for encryption
            const channel = channelManager.getChannel(messageStreamId);
            const password = channel?.password || null;
            await this.announceFileSource(messageStreamId, data.fileId, password);
        }
    }

    /**
     * Announce as file source (seeder)
     * Announcements go to ephemeralStream (not stored)
     * @param {string} messageStreamId - Channel message stream ID
     */
    async announceFileSource(messageStreamId, fileId, password = null) {
        const ephemeralStreamId = deriveEphemeralId(messageStreamId);
        const localFile = this.localFiles.get(fileId);
        const announce = {
            type: 'source_announce',
            fileId,
            pieceCount: localFile?.metadata?.pieceCount || 0
        };

        // DM channels: sealed sender (see requestPiece)
        const dmPeer = this._getDMPeer(messageStreamId);
        if (dmPeer) {
            await dmManager.sealAndPublish(
                ephemeralStreamId, dmPeer, announce,
                STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_SIGNALS);
        } else {
            await streamrController.publishMediaSignal(ephemeralStreamId, announce, password);
        }
        Logger.debug('Announced as source for:', fileId);
    }

    /**
     * Handle source announcement
     * Note: Normalize account to lowercase for consistent comparison
     */
    handleSourceAnnounce(data) {
        const seeders = this.fileSeeders.get(data.fileId);
        if (seeders && data.account) {
            // Normalize to lowercase for consistent address comparison
            const normalizedSenderId = data.account.toLowerCase();
            seeders.add(normalizedSenderId);
            
            Logger.debug('Seeder announced for file:', data.fileId, 'seeder:', normalizedSenderId);
            
            if (this.handlers.onSeederUpdate) {
                this.handlers.onSeederUpdate(data.fileId, seeders.size);
            }
            
            // Start download when we have enough seeders
            const transfer = this.incomingFiles.get(data.fileId);
            if (transfer && !transfer.downloadStarted && transfer.pieceStatus && seeders.size >= CONFIG.MIN_SEEDERS) {
                transfer.downloadStarted = true;
                
                // Stop discovery loop — we have a seeder. manageDownload() keeps
                // topping the seeder set up while the transfer runs.
                if (transfer.seederDiscoveryTimer) {
                    clearTimeout(transfer.seederDiscoveryTimer);
                    transfer.seederDiscoveryTimer = null;
                }

                Logger.info(`Download started for ${data.fileId} (${data.pieceCount} pieces)`);
                this.manageDownload(data.fileId);
            }
        }
    }

    /**
     * Record a bad delivery of a piece and either retry it or give up.
     *
     * Without a cap, a seeder serving corrupt data for one piece keeps the
     * transfer retrying that piece forever — the piece is reset to 'pending' and
     * immediately re-requested, with nothing tracking that it already failed.
     *
     * @param {Object} transfer - Transfer state
     * @param {string} fileId - File ID
     * @param {number} pieceIndex - Piece that failed
     * @param {string} reason - Why it failed (for the log)
     */
    registerPieceFailure(transfer, fileId, pieceIndex, reason, account = null) {
        const failures = (transfer.pieceFailures?.get(pieceIndex) || 0) + 1;
        transfer.pieceFailures?.set(pieceIndex, failures);

        Logger.error(`Piece ${pieceIndex} failed (${reason}), attempt ${failures}`);

        // Blame the publisher of the bad bytes, not whoever we happened to ask: a late
        // reply from a previous seeder can land after we already retried elsewhere.
        if (account) {
            this.blameSeeder(transfer, fileId, pieceIndex, account);
        }

        if (failures >= CONFIG.MAX_PIECE_FAILURES) {
            this.failDownload(fileId, `Piece ${pieceIndex} could not be verified after ${failures} attempts`);
            return;
        }

        transfer.pieceStatus[pieceIndex] = 'pending';
        this.manageDownload(fileId);
    }

    /**
     * Abort a download that cannot complete, and tell the UI why.
     * Tears down the same state as a user-initiated cancel, so a retry starts clean.
     *
     * @param {string} fileId - File ID
     * @param {string} message - Human-readable reason
     */
    failDownload(fileId, message) {
        Logger.error(`Download failed for ${fileId}: ${message}`);
        this.cancelDownload(fileId);

        if (this.handlers.onFileError) {
            this.handlers.onFileError(fileId, message);
        }
    }

    /**
     * Cancel a download
     */
    cancelDownload(fileId) {
        const transfer = this.incomingFiles.get(fileId);
        if (!transfer) return;
        
        // Clear seeder discovery timer
        if (transfer.seederDiscoveryTimer) {
            clearTimeout(transfer.seederDiscoveryTimer);
        }
        
        // Clear the pending no-seeder retry
        if (transfer.noSeederRetryTimer) {
            clearTimeout(transfer.noSeederRetryTimer);
        }
        
        // Clear all piece request timeouts. Guarded because failDownload() can
        // route here from any stage of a transfer, including before requests start.
        if (transfer.requestsInFlight) {
            for (const [, request] of transfer.requestsInFlight) {
                clearTimeout(request.timeoutId);
            }
        }
        
        this.incomingFiles.delete(fileId);
        this.fileSeeders.delete(fileId);

        // Clean up IndexedDB
        if (this.db) {
            this.clearFileFromIndexedDB(fileId);
        }

        Logger.info('Download cancelled:', fileId);
    }

    /**
     * Pause a download: stop the discovery/request timers, but — unlike
     * cancelDownload — keep the transfer entry and its IndexedDB pieces
     * intact so resumeDownload() picks up exactly where this left off.
     */
    pauseDownload(fileId) {
        const transfer = this.incomingFiles.get(fileId);
        if (!transfer || transfer.paused) return;
        transfer.paused = true;

        if (transfer.seederDiscoveryTimer) {
            clearTimeout(transfer.seederDiscoveryTimer);
            transfer.seederDiscoveryTimer = null;
        }
        if (transfer.noSeederRetryTimer) {
            clearTimeout(transfer.noSeederRetryTimer);
            transfer.noSeederRetryTimer = null;
        }

        // Requests already sent get no further timeout handling — put their
        // pieces back to 'pending' so resumeDownload() re-requests them,
        // exactly like a timeout would, instead of leaving them stuck as
        // 'requested' forever with a dead timer.
        for (const [pieceIndex, request] of transfer.requestsInFlight) {
            clearTimeout(request.timeoutId);
            transfer.pieceStatus[pieceIndex] = 'pending';
        }
        transfer.requestsInFlight.clear();

        Logger.info('Download paused:', fileId);
    }

    /**
     * Resume a download paused by pauseDownload(): re-kicks seeder discovery
     * if needed and refills the request window from whatever is already
     * known — nothing already in IndexedDB gets re-fetched.
     */
    resumeDownload(fileId) {
        const transfer = this.incomingFiles.get(fileId);
        if (!transfer || !transfer.paused) return;
        transfer.paused = false;

        const seeders = this.fileSeeders.get(fileId);
        if (!seeders || seeders.size === 0) {
            this.fireAndForget('startSeederDiscovery (resume)', this.startSeederDiscovery(fileId));
        } else {
            this.manageDownload(fileId);
        }

        Logger.info('Download resumed:', fileId);
    }

    // ==================== INDEXEDDB HELPERS ====================

    async savePieceToIndexedDB(fileId, pieceIndex, data) {
        if (!this.db) return;
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('pieces', 'readwrite');
            const store = tx.objectStore('pieces');
            // timestamp drives the stale-download sweep (see cleanupStalePieces)
            const request = store.put({ fileId, pieceIndex, data, timestamp: Date.now() });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Restore already-downloaded pieces for a transfer from IndexedDB (resume).
     *
     * Pieces are hash-verified in handleFilePiece() *before* being stored, so a stored
     * piece was valid when written. We only re-check that each one still has the length
     * the manifest implies — enough to reject a stale or truncated store without
     * re-hashing the entire file on every resume.
     *
     * @param {string} fileId - File ID being resumed
     * @param {Object} transfer - Transfer state; pieceStatus/receivedCount are mutated
     * @returns {Promise<number>} Number of pieces restored
     */
    async restorePiecesFromIndexedDB(fileId, transfer) {
        if (!this.db) return 0;

        const { pieceCount, fileSize } = transfer.metadata;

        return new Promise((resolve) => {
            let restored = 0;

            // Keep the caller's progress counter in sync on every exit path
            const done = () => {
                transfer.receivedCount = restored;
                resolve(restored);
            };

            try {
                const tx = this.db.transaction('pieces', 'readonly');
                const store = tx.objectStore('pieces');
                const request = store.getAll(this.pieceKeyRange(fileId));

                request.onsuccess = () => {
                    for (const record of request.result || []) {
                        const idx = record.pieceIndex;
                        if (idx < 0 || idx >= pieceCount || transfer.pieceStatus[idx] !== 'pending') {
                            continue;
                        }

                        // Every piece is PIECE_SIZE except the last one
                        const expectedLength = Math.min(CONFIG.PIECE_SIZE, fileSize - idx * CONFIG.PIECE_SIZE);

                        if (record.data?.length === expectedLength) {
                            transfer.pieceStatus[idx] = 'done';
                            restored++;
                        } else {
                            Logger.warn(`Discarding stale piece ${idx} of ${fileId.slice(0, 8)}: got ${record.data?.length} bytes, expected ${expectedLength}`);
                        }
                    }

                    done();
                };

                // A failed read is not fatal — fall back to downloading from scratch
                request.onerror = () => {
                    Logger.warn('Failed to read persisted pieces, starting from scratch:', request.error);
                    done();
                };
            } catch (error) {
                Logger.warn('Failed to open pieces store for resume:', error);
                done();
            }
        });
    }

    async assembleFromIndexedDB(fileId, metadata) {
        if (!this.db) return null;
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('pieces', 'readonly');
            const store = tx.objectStore('pieces');
            const pieces = new Array(metadata.pieceCount).fill(null);
            let foundCount = 0;

            const request = store.getAll(this.pieceKeyRange(fileId));
            request.onsuccess = () => {
                for (const record of request.result || []) {
                    const idx = record.pieceIndex;
                    if (idx >= 0 && idx < metadata.pieceCount) {
                        pieces[idx] = record.data;
                        foundCount++;
                    }
                }

                // All pieces collected - verify we have them all
                if (foundCount !== metadata.pieceCount) {
                    Logger.error(`IndexedDB assembly: found ${foundCount}/${metadata.pieceCount} pieces`);
                }

                // Calculate total size and assemble
                const totalSize = pieces.reduce((sum, p) => sum + (p?.length || 0), 0);

                if (totalSize !== metadata.fileSize) {
                    Logger.warn(`IndexedDB size mismatch: got ${totalSize}, expected ${metadata.fileSize}`);
                }

                for (let i = 0; i < pieces.length; i++) {
                    if (!pieces[i]) {
                        Logger.error(`Missing piece at index ${i} in IndexedDB!`);
                    }
                }

                Logger.info(`Assembled from IndexedDB: ${totalSize} bytes, ${foundCount} pieces`);
                // Built straight from the parts — no contiguous full-file copy.
                // See assembleFile() for why missing pieces must be filtered out.
                resolve(new Blob(pieces.filter(Boolean), { type: metadata.fileType }));
            };
            request.onerror = () => reject(request.error);
        });
    }

    async clearFileFromIndexedDB(fileId) {
        if (!this.db) return;
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('pieces', 'readwrite');
            const store = tx.objectStore('pieces');
            
            // Scoped to this file's key range instead of walking every stored piece
            const request = store.delete(this.pieceKeyRange(fileId));
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Delete piece records left behind by downloads that were never finished.
     *
     * Pieces are only cleared on completion or explicit cancel, so a transfer
     * abandoned by closing the tab leaves its pieces behind forever. Resume made
     * these load-bearing, which makes sweeping them necessary rather than tidy.
     */
    async cleanupStalePieces() {
        if (!this.db) return;

        const cutoff = Date.now() - CONFIG.PIECE_EXPIRE_DAYS * 24 * 60 * 60 * 1000;

        return new Promise((resolve) => {
            try {
                const tx = this.db.transaction('pieces', 'readwrite');
                const store = tx.objectStore('pieces');
                const index = store.index('timestamp');
                const request = index.openCursor(IDBKeyRange.upperBound(cutoff));

                let removed = 0;
                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (!cursor) {
                        if (removed > 0) {
                            Logger.info(`Cleaned up ${removed} stale piece(s) from abandoned downloads`);
                        }
                        resolve();
                        return;
                    }

                    cursor.delete();
                    removed++;
                    cursor.continue();
                };

                request.onerror = () => {
                    Logger.warn('Stale piece cleanup failed:', request.error);
                    resolve();
                };
            } catch (error) {
                Logger.warn('Stale piece cleanup unavailable:', error);
                resolve();
            }
        });
    }

    // ==================== SEEDING PERSISTENCE ====================

    /**
     * Load persisted seed files from IndexedDB
     * Called on setOwner() to restore seeding capabilities for current user
     */
    async loadPersistedSeedFiles() {
        if (!this.db || !this.db.objectStoreNames.contains('seedFiles')) {
            Logger.debug('No seedFiles store available');
            return;
        }
        
        if (!this.currentOwnerAddress) {
            Logger.debug('No owner address set - skipping seed file load');
            return;
        }
        
        try {
            const seedFiles = await this.getAllSeedFiles();
            const now = Date.now();
            const expireMs = CONFIG.SEED_FILES_EXPIRE_DAYS * 24 * 60 * 60 * 1000;
            
            let loadedCount = 0;
            let expiredCount = 0;
            let skippedCount = 0;
            
            for (const record of seedFiles) {
                // Only load files owned by current user
                // Skip if: no owner (legacy file) OR owner is different
                const recordOwner = record.ownerAddress?.toLowerCase();
                if (!recordOwner || recordOwner !== this.currentOwnerAddress) {
                    skippedCount++;
                    continue;
                }
                
                // Check if expired
                if (now - record.timestamp > expireMs) {
                    await this.removeSeedFile(record.fileId);
                    expiredCount++;
                    continue;
                }

                // User-stopped seeds stay stopped across reloads — only an
                // explicit reseed (Transfers list) flips them back.
                if (record.active === false) {
                    skippedCount++;
                    continue;
                }

                // Restore to memory
                const blob = new Blob([record.fileData], { type: record.metadata.fileType });
                const url = URL.createObjectURL(blob);
                
                this.localFiles.set(record.fileId, {
                    file: blob,
                    metadata: record.metadata,
                    streamId: record.streamId,
                    persisted: true
                });
                
                this.downloadedUrls.set(record.fileId, url);
                this.persistedStorageSize += record.metadata.fileSize;
                loadedCount++;
            }
            
            if (loadedCount > 0 || expiredCount > 0 || skippedCount > 0) {
                Logger.info(`Seed files: loaded ${loadedCount}, expired ${expiredCount}, skipped ${skippedCount} (other users/legacy), storage: ${(this.persistedStorageSize / 1024 / 1024).toFixed(2)}MB`);
            }
        } catch (error) {
            Logger.error('Failed to load persisted seed files:', error);
        }
    }

    /**
     * Persist a file for seeding across sessions
     */
    async persistSeedFile(fileId, blob, metadata, streamId, isPrivateChannel = false) {
        if (!this.db || !this.db.objectStoreNames.contains('seedFiles')) {
            return false;
        }
        
        if (!this.currentOwnerAddress) {
            Logger.debug('No owner address set - skipping persistence');
            return false;
        }
        
        // Check if we should persist based on channel type
        if (isPrivateChannel && !CONFIG.PERSIST_PRIVATE_CHANNELS) {
            Logger.debug('Skipping persistence for private channel file:', fileId);
            return false;
        }
        
        if (!isPrivateChannel && !CONFIG.PERSIST_PUBLIC_CHANNELS) {
            Logger.debug('Skipping persistence for public channel file:', fileId);
            return false;
        }
        
        // Check storage quota
        const newTotalSize = this.persistedStorageSize + metadata.fileSize;
        if (newTotalSize > CONFIG.MAX_SEED_STORAGE) {
            // Try to free up space using LRU
            const freedSpace = await this.evictOldestSeedFiles(metadata.fileSize);
            if (freedSpace < metadata.fileSize) {
                Logger.warn(`Cannot persist file ${fileId}: storage quota exceeded`);
                return false;
            }
        }
        
        try {
            // Read blob as ArrayBuffer for storage
            const fileData = await blob.arrayBuffer();
            
            const record = {
                fileId,
                streamId,
                metadata,
                fileData,
                timestamp: Date.now(),
                ownerAddress: this.currentOwnerAddress // Associate with current user
            };
            
            await this.saveSeedFile(record);
            this.persistedStorageSize += metadata.fileSize;
            
            Logger.info(`Persisted seed file: ${metadata.fileName} (${(metadata.fileSize / 1024 / 1024).toFixed(2)}MB)`);
            return true;
        } catch (error) {
            Logger.error('Failed to persist seed file:', error);
            return false;
        }
    }

    /**
     * Save seed file to IndexedDB
     */
    async saveSeedFile(record) {
        if (!this.db) return;
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('seedFiles', 'readwrite');
            const store = tx.objectStore('seedFiles');
            const request = store.put(record);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get one seed file record from IndexedDB
     */
    async getSeedFile(fileId) {
        if (!this.db) return null;

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('seedFiles', 'readonly');
            const store = tx.objectStore('seedFiles');
            const request = store.get(fileId);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get all seed files from IndexedDB
     */
    async getAllSeedFiles() {
        if (!this.db) return [];
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('seedFiles', 'readonly');
            const store = tx.objectStore('seedFiles');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Get seed files for a specific stream/channel
     */
    async getSeedFilesByStream(streamId) {
        if (!this.db) return [];
        
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('seedFiles', 'readonly');
            const store = tx.objectStore('seedFiles');
            const index = store.index('streamId');
            const request = index.getAll(streamId);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Stops SERVING a file: out of localFiles (handlePieceRequest checks
     * membership there, so requests stop being answered) and the blob URL is
     * revoked — but the IndexedDB record stays, flagged inactive, so the
     * Transfers list can offer a reseed without a re-download. Reloads honor
     * the flag (loadPersistedSeedFiles skips inactive records); only
     * removeSeedFile actually forgets the file.
     */
    async stopSeeding(fileId) {
        const localFile = this.localFiles.get(fileId);
        if (localFile?.metadata?.fileSize) {
            this.persistedStorageSize -= localFile.metadata.fileSize;
        }
        const url = this.downloadedUrls.get(fileId);
        if (url) {
            URL.revokeObjectURL(url);
            this.downloadedUrls.delete(fileId);
        }
        this.localFiles.delete(fileId);

        const record = await this.getSeedFile(fileId).catch(() => null);
        if (record) {
            record.active = false;
            await this.saveSeedFile(record);
        }
        Logger.info('Stopped seeding (bytes kept):', fileId);
    }

    /**
     * Re-activates an inactive seed from its IndexedDB record: back into
     * localFiles, blob URL recreated, and the channel's seeds re-announced —
     * the reverse of stopSeeding, no re-download involved.
     * @returns {Promise<boolean>} false when the record is gone or foreign
     */
    async reseedFile(fileId) {
        if (this.localFiles.has(fileId)) return true;
        const record = await this.getSeedFile(fileId).catch(() => null);
        if (!record) return false;
        const owner = record.ownerAddress?.toLowerCase();
        if (!owner || owner !== this.currentOwnerAddress) return false;

        record.active = true;
        await this.saveSeedFile(record);

        const blob = new Blob([record.fileData], { type: record.metadata.fileType });
        this.localFiles.set(fileId, {
            file: blob,
            metadata: record.metadata,
            streamId: record.streamId,
            persisted: true
        });
        this.downloadedUrls.set(fileId, URL.createObjectURL(blob));
        this.persistedStorageSize += record.metadata.fileSize;

        const channel = channelManager.getChannel(record.streamId);
        await this.reannounceForChannel(record.streamId, channel?.password || null);
        Logger.info('Reseeding:', fileId, record.metadata.fileName);
        return true;
    }

    /**
     * Seed records held on disk for the current owner but not currently
     * served — the Transfers list's "inactive" rows. On the web this is
     * mostly user-stopped seeds: everything else loads at wallet connect.
     */
    async getInactiveSeedFiles() {
        if (!this.currentOwnerAddress) return [];
        const all = await this.getAllSeedFiles().catch(() => []);
        const now = Date.now();
        const expireMs = CONFIG.SEED_FILES_EXPIRE_DAYS * 24 * 60 * 60 * 1000;
        return all.filter(record =>
            record.ownerAddress?.toLowerCase() === this.currentOwnerAddress
            && now - record.timestamp <= expireMs
            && !this.localFiles.has(record.fileId));
    }

    /**
     * Remove seed file from IndexedDB
     */
    async removeSeedFile(fileId) {
        if (!this.db) return;
        
        // Update storage size
        const localFile = this.localFiles.get(fileId);
        if (localFile?.metadata?.fileSize) {
            this.persistedStorageSize -= localFile.metadata.fileSize;
        }
        
        // Remove blob URL
        const url = this.downloadedUrls.get(fileId);
        if (url) {
            URL.revokeObjectURL(url);
            this.downloadedUrls.delete(fileId);
        }
        
        // Remove from memory
        this.localFiles.delete(fileId);
        
        // Remove from IndexedDB
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('seedFiles', 'readwrite');
            const store = tx.objectStore('seedFiles');
            const request = store.delete(fileId);
            request.onsuccess = () => {
                Logger.debug('Removed seed file:', fileId);
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Evict oldest seed files to free up space (LRU)
     */
    async evictOldestSeedFiles(neededSpace) {
        if (!this.db) return 0;
        
        const seedFiles = await this.getAllSeedFiles();
        
        // Sort by timestamp (oldest first)
        seedFiles.sort((a, b) => a.timestamp - b.timestamp);
        
        let freedSpace = 0;
        
        for (const record of seedFiles) {
            if (freedSpace >= neededSpace) break;
            
            freedSpace += record.metadata.fileSize;
            await this.removeSeedFile(record.fileId);
            Logger.info(`Evicted old seed file: ${record.metadata.fileName}`);
        }
        
        return freedSpace;
    }

    /**
     * Re-announce as seeder for all persisted files in a channel
     * Called when joining a channel
     * @param {string} messageStreamId - Channel message stream ID
     */
    async reannounceForChannel(messageStreamId, password = null) {
        if (!CONFIG.AUTO_SEED_ON_JOIN) return;
        
        // Check if we have any files to seed for this channel
        let hasFiles = false;
        for (const [, fileInfo] of this.localFiles) {
            if (fileInfo.streamId === messageStreamId) { hasFiles = true; break; }
        }
        if (!hasFiles) return;
        
        // Lazy-subscribe to media partitions P1+P2 (seeder needs P1 to receive piece_requests)
        const ephemeralStreamId = deriveEphemeralId(messageStreamId);
        await streamrController.ensureMediaSubscription(ephemeralStreamId);
        
        let reannounced = 0;
        
        for (const [fileId, fileInfo] of this.localFiles) {
            // Check against messageStreamId (stored as streamId in localFiles)
            if (fileInfo.streamId === messageStreamId) {
                await this.announceFileSource(messageStreamId, fileId, password);
                reannounced++;
            }
        }
        
        if (reannounced > 0) {
            Logger.info(`Re-announced ${reannounced} seed files for channel`);
        }
    }

    /**
     * Get storage stats for UI
     */
    getStorageStats() {
        return {
            usedBytes: this.persistedStorageSize,
            maxBytes: CONFIG.MAX_SEED_STORAGE,
            usedMB: (this.persistedStorageSize / 1024 / 1024).toFixed(2),
            maxMB: (CONFIG.MAX_SEED_STORAGE / 1024 / 1024).toFixed(0),
            percentUsed: Math.round((this.persistedStorageSize / CONFIG.MAX_SEED_STORAGE) * 100),
            fileCount: this.localFiles.size
        };
    }

    /**
     * Clear all persisted seed files
     */
    async clearAllSeedFiles() {
        if (!this.db) return;
        
        const seedFiles = await this.getAllSeedFiles();
        for (const record of seedFiles) {
            await this.removeSeedFile(record.fileId);
        }
        
        this.persistedStorageSize = 0;
        Logger.info('Cleared all persisted seed files');
    }

    /**
     * Clear all persisted seed files for a specific owner (for delete account)
     * @param {string} address - Owner address to clear files for
     */
    async clearSeedFilesForOwner(address) {
        if (!this.db) return;
        
        const targetAddress = address?.toLowerCase();
        if (!targetAddress) return;
        
        const seedFiles = await this.getAllSeedFiles();
        let clearedCount = 0;
        
        for (const record of seedFiles) {
            const recordOwner = record.ownerAddress?.toLowerCase();
            if (recordOwner === targetAddress || !recordOwner) {
                // Clear files owned by this user or legacy files without owner
                await this.removeSeedFile(record.fileId);
                clearedCount++;
            }
        }
        
        if (clearedCount > 0) {
            Logger.info(`Cleared ${clearedCount} seed files for owner: ${targetAddress.slice(0, 8)}...`);
        }
    }

    // ==================== UTILITY FUNCTIONS ====================

    arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    base64ToArrayBuffer(base64) {
        try {
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return bytes.buffer;
        } catch (e) {
            Logger.error('Base64 decode error:', e);
            return null;
        }
    }

    async sha256(buffer) {
        let normalized = buffer;

        if (typeof normalized === 'string') {
            normalized = new TextEncoder().encode(normalized);
        } else if (normalized?.arrayBuffer instanceof Function) {
            normalized = new Uint8Array(await normalized.arrayBuffer());
        }

        if (ArrayBuffer.isView(normalized)) {
            normalized = new Uint8Array(
                normalized.buffer.slice(
                    normalized.byteOffset,
                    normalized.byteOffset + normalized.byteLength
                )
            );
        } else if (
            Object.prototype.toString.call(normalized) === '[object ArrayBuffer]' ||
            Object.prototype.toString.call(normalized) === '[object SharedArrayBuffer]'
        ) {
            normalized = new Uint8Array(normalized);
        } else if (normalized && typeof normalized.byteLength === 'number') {
            normalized = new Uint8Array(normalized);
        } else if (Array.isArray(normalized)) {
            normalized = Uint8Array.from(normalized);
        }

        const hashBuffer = await crypto.subtle.digest('SHA-256', normalized);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // ==================== EVENT HANDLERS ====================

    /**
     * Set handler for image received event
     * @param {Function} handler - (imageId, base64Data) => void
     */
    onImageReceived(handler) {
        this.handlers.onImageReceived = handler;
    }

    /**
     * Set handler for file progress event
     * @param {Function} handler - (fileId, percent, received, total) => void
     */
    onFileProgress(handler) {
        this.handlers.onFileProgress = handler;
    }

    /**
     * Set handler for file complete event
     * @param {Function} handler - (fileId, metadata, url, blob) => void
     */
    onFileComplete(handler) {
        this.handlers.onFileComplete = handler;
    }

    /**
     * Set handler for unrecoverable download failure
     * @param {Function} handler - (fileId, message) => void
     */
    onFileError(handler) {
        this.handlers.onFileError = handler;
    }

    /**
     * Set handler for serving stats while we seed a file
     * @param {Function} handler - (fileId, bytesPerSec, leechers) => void
     */
    onUploadProgress(handler) {
        this.handlers.onUploadProgress = handler;
    }

    /**
     * Set handler for seeder update event
     * @param {Function} handler - (fileId, seederCount) => void
     */
    onSeederUpdate(handler) {
        this.handlers.onSeederUpdate = handler;
    }

    /**
     * Get allowed image types
     */
    getAllowedImageTypes() {
        return CONFIG.ALLOWED_IMAGE_TYPES;
    }

    /**
     * Get allowed video types
     */
    getAllowedVideoTypes() {
        return CONFIG.ALLOWED_VIDEO_TYPES;
    }

    /**
     * Get max file size
     */
    getMaxFileSize() {
        return CONFIG.MAX_FILE_SIZE;
    }

    /**
     * Check if video type is playable in browser
     * @param {string} mimeType - Video MIME type
     * @returns {boolean}
     */
    isVideoPlayable(mimeType) {
        if (!mimeType) {
            Logger.warn('isVideoPlayable called with empty mimeType');
            return true; // Default to trying to play
        }
        
        // Normalize mime type (lowercase, trim)
        const normalizedMime = mimeType.toLowerCase().trim();
        
        // Check against known playable types
        if (CONFIG.PLAYABLE_VIDEO_TYPES.includes(normalizedMime)) {
            Logger.debug('Video playable (known type):', normalizedMime);
            return true;
        }
        
        // MP4 variants that are generally playable
        const mp4Variants = ['video/mp4', 'video/x-m4v', 'video/m4v', 'video/mpeg4'];
        if (mp4Variants.some(v => normalizedMime.includes('mp4') || normalizedMime.includes('m4v'))) {
            Logger.debug('Video playable (MP4 variant):', normalizedMime);
            return true;
        }
        
        // WebM is generally playable
        if (normalizedMime.includes('webm')) {
            Logger.debug('Video playable (WebM variant):', normalizedMime);
            return true;
        }
        
        // Additional browser capability check
        const video = document.createElement('video');
        const canPlay = video.canPlayType(normalizedMime);
        
        Logger.debug('Video playability check:', normalizedMime, 'canPlay:', canPlay);
        
        // Be more permissive - if browser says anything other than empty string, try it
        // Also, if we can't determine, default to trying (let the browser handle it)
        if (canPlay !== '') {
            return true;
        }
        
        // QuickTime (.mov) is NOT playable in most browsers
        if (normalizedMime.includes('quicktime') || normalizedMime.includes('mov')) {
            Logger.debug('Video not playable (QuickTime):', normalizedMime);
            return false;
        }
        
        // Default to trying to play - let the browser figure it out
        Logger.debug('Video playability unknown, defaulting to playable:', normalizedMime);
        return true;
    }

    /**
     * Get playable video types
     */
    getPlayableVideoTypes() {
        return CONFIG.PLAYABLE_VIDEO_TYPES;
    }
}

// Export singleton instance
export const mediaController = new MediaController();
export { CONFIG as MEDIA_CONFIG, PieceRtoEstimator };
