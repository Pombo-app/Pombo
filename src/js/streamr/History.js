/**
 * Reading the past: the initial page a channel opens with, the scroll-up
 * pager, the bounded window the DM inbox walks, and the preview lookup the
 * sidebar makes.
 *
 * All four talk to storage through a resend and then do the same work on what
 * comes back: decrypt, unseal, recover the author, and decide what a given
 * partition is allowed to carry. That work is message logic, not transport,
 * which is why it lives beside the transport rather than inside it.
 */

import { Logger } from '../logger.js';
import { cryptoManager } from '../crypto.js';
import { CONFIG } from '../config.js';
import { STREAM_CONFIG } from '../streamConfig.js';
import { isMessageStream } from '../streamConstants.js';
import { verifyEnvelopeAuthenticity } from '../envelopeSigner.js';

export class History {
    /**
     * Calls back into `controller` on purpose: while the controller is still
     * the entry point, anything that replaces one of its methods has to keep
     * intercepting the calls this class makes. The SDK client is read off it
     * too, never cached, because it is replaced on every reconnect.
     * @param {Object} controller - the streamr controller
     */
    constructor(controller) {
        this.controller = controller;
    }

    /**
     * Resend the most-recent N entries from MESSAGE STREAM partition 0
     * (content) for a "latest message preview" lookup.
     *
     * Returns entries newest-first. Entries are returned ONLY if they map to
     * a renderable preview type:
     *   - text
     *   - image
     *   - file_announce
     *   - reaction 
     *
     *
     * Each returned entry has the publisher injected as `_publisherId` so
     * callers can attribute reactions (which carry no `sender` field).
     *
     * @param {string} messageStreamId - Message Stream ID (ends with -1)
     * @param {Object} [options]
     * @param {number} [options.last=CONFIG.channels.latestMessageFetchLast] - How many to fetch
     * @param {string|null} [options.password=null]
     * @returns {Promise<Array<Object>>} - Newest-first array of preview-eligible entries
     */
    async resendLatestContentMessages(messageStreamId, { last = null, password = null } = {}) {
        if (!this.controller.client) {
            throw new Error('Streamr client not initialized');
        }
        if (!isMessageStream(messageStreamId)) {
            Logger.warn('Invalid messageStreamId (should end with -1):', messageStreamId);
        }

        const fetchLast = Math.max(1, last || CONFIG.channels?.latestMessageFetchLast || 2);
        const partition = STREAM_CONFIG.MESSAGE_STREAM.MESSAGES;
        const entries = [];
        const gatedChannel = await this.controller._gatedChannelFor(messageStreamId);

        try {
            // Raw: skips the SDK's validation/ordering pipeline — resilience
            // on half-connected nodes. Authenticity is re-established below:
            // gated entries never render here (epoch envelopes carry no
            // preview type), non-gated ones must pass the envelope check.
            const resend = await this.controller.client.resend(
                { streamId: messageStreamId, partition },
                { last: fetchLast, raw: true }
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
                    Logger.warn('resendLatestContentMessages iteration error:', iterError.message);
                    continue;
                }

                try {
                    if (!gatedChannel && (!verifyEnvelopeAuthenticity(message)
                        || !await this.controller.publisherMayWrite(messageStreamId, message))) continue;
                    let content = message.content || message;
                    // Encrypted entries arrive as base64/JSON string when password channel
                    if (typeof content === 'string') {
                        if (!password) continue;
                        try {
                            content = await cryptoManager.decryptJSON(content, password);
                        } catch {
                            continue;
                        }
                    }
                    if (!content || typeof content !== 'object') continue;
                    const t = content.type;
                    // Skip overrides for the preview path
                    if (t === 'edit' || t === 'delete') continue;
                    // Only accept known preview-renderable types
                    if (t !== 'text' && t !== 'image' && t !== 'file_announce' && t !== 'storage_file_announce' && t !== 'reaction') {
                        continue;
                    }

                    let publisherId = null;
                    if (typeof message.getPublisherId === 'function') {
                        publisherId = message.getPublisherId() || null;
                    }
                    let timestamp = null;
                    if (typeof message.getTimestamp === 'function') {
                        timestamp = message.getTimestamp();
                    } else {
                        timestamp = message.timestamp || content.timestamp || null;
                    }

                    entries.push({
                        ...content,
                        _publisherId: publisherId,
                        _timestamp: timestamp
                    });
                } catch (e) {
                    Logger.debug('resendLatestContentMessages entry processing error:', e.message);
                    continue;
                }
            }
        } catch (error) {
            Logger.warn('resendLatestContentMessages error:', error.message);
            return [];
        }

        // Resend yields oldest-first within the requested window — sort
        // newest-first defensively before returning.
        entries.sort((a, b) => (b._timestamp || 0) - (a._timestamp || 0));

        Logger.debug('resendLatestContentMessages result:', {
            messageStreamId: String(messageStreamId).slice(-30),
            count: entries.length,
            top: entries[0]?.type
        });
        return entries;
    }

    /**
     * Fetch older historical messages from MESSAGE STREAM (for lazy loading / pagination)
     * Uses timestamp-based pagination to get messages older than a given point
     * In dual-stream architecture, only messageStream has stored history
     * 
     * @param {string} messageStreamId - Message Stream ID (should end with -1)
     * @param {number} partition - Partition number (should be 0)
     * @param {number} beforeTimestamp - Unix timestamp (ms) - fetch messages before this
     * @param {number} count - Number of messages to fetch
     * @param {string} password - Password for encrypted channels (optional)
     * @returns {Promise<{messages: Array, hasMore: boolean}>} - Messages and pagination info
     */
    async fetchOlderHistory(messageStreamId, partition = 0, beforeTimestamp, count = STREAM_CONFIG.LOAD_MORE_COUNT, password = null, signal = null, allowOverridesInContentPartition = false) {
        if (!this.controller.client) {
            throw new Error('Client not initialized');
        }
        
        // Ephemeral message types that should NEVER be loaded from history
        const EPHEMERAL_TYPES = ['presence', 'typing'];
        
        // Valid content message types for partition 0
        const isValidContentMessage = (msg) => {
            if (msg?.type === 'text') return true;
            if (msg?.id && msg?.text && msg?.sender && msg?.timestamp && !msg?.type) return true;
            if (msg?.type === 'reaction') return true;
            if (msg?.type === 'image' && msg?.imageId) return true;
            if (msg?.type === 'image_chunk' && msg?.imageId && Number.isInteger(msg?.chunkIndex) && typeof msg?.data === 'string') return true;
            if (msg?.type === 'file_announce' && msg?.metadata) return true;
            if (msg?.type === 'storage_file_announce' && msg?.metadata) return true;
            if (allowOverridesInContentPartition && msg?.type === 'edit' && msg?.targetId) return true;
            if (allowOverridesInContentPartition && msg?.type === 'delete' && msg?.targetId) return true;
            return false;
        };

        // Valid override message types for partition 1
        const isValidOverrideMessage = (msg) => {
            if (msg?.type === 'edit' && msg?.targetId) return true;
            if (msg?.type === 'delete' && msg?.targetId) return true;
            return false;
        };
        
        // Single range-resend pass. Extracted so exhaustion claims can be
        // CONFIRMED with a second pass on a fresh storage connection: range
        // resends can be silently truncated (WS drop mid-iteration → short
        // response, no error). Without confirmation, one truncated response
        // falsely latches `hasMore: false` and kills scroll-up pagination
        // for the rest of the session.
        const collectRange = async () => {
            // Gated: raw resend — same reason as fetchHistoryAsync (the SDK
            // validator re-checks stored envelopes against the present gate
            // state and erases ex-members' history; authorship comes from the
            // envelope signature client-side).
            const gatedChannel = await this.controller._gatedChannelFor(messageStreamId);

            // Streamr SDK resend with range: from epoch to beforeTimestamp (inclusive).
            // We use an INCLUSIVE upper bound and rely on caller-side dedup by msg.id to drop
            // the boundary message we already loaded. Using `beforeTimestamp - 1` here would
            // permanently skip any sibling messages that share the exact same millisecond
            // timestamp as the boundary message but were dropped by the slice() below — a
            // deterministic gap in the middle of the loaded history.
            const resend = await this.controller.client.resend(
                { streamId: messageStreamId, partition: partition },
                {
                    from: { timestamp: 0 },
                    to: { timestamp: beforeTimestamp },
                    raw: true
                }
            );
            
            // Collect all messages in range; ordering is enforced explicitly after the loop.
            const collected = [];
            
            // Manual iteration to catch decrypt errors per-message
            const iterator = resend[Symbol.asyncIterator]();
            let iteratorDone = false;
            let decryptErrors = 0;
            let epochWaiting = 0;

            while (!iteratorDone) {
                // Early exit if fetch was aborted (e.g. channel switch)
                if (signal?.aborted) {
                    Logger.debug('fetchOlderHistory aborted for', messageStreamId.slice(-20));
                    break;
                }
                
                let message;
                try {
                    const result = await iterator.next();
                    iteratorDone = result.done;
                    if (iteratorDone) break;
                    message = result.value;
                } catch (iterError) {
                    if (iterError.code === 'DECRYPT_ERROR' || iterError.message?.includes('encryption key')) {
                        decryptErrors++;
                        continue;
                    }
                    Logger.warn('fetchOlderHistory iteration error:', iterError.message);
                    continue;
                }
                
                try {
                    // Non-gated raw: the envelope check replaces the SDK
                    // validation raw turned off (gated authorship comes from
                    // resolveAuthor below).
                    if (!gatedChannel && (!verifyEnvelopeAuthenticity(message)
                        || !await this.controller.publisherMayWrite(messageStreamId, message))) continue;
                    let content = message.content || message;

                    // Decrypt if password provided
                    if (password && typeof content === 'string') {
                        try {
                            content = await cryptoManager.decryptJSON(content, password);
                        } catch (decryptError) {
                            continue; // Skip messages we can't decrypt
                        }
                    }

                    const historyTimestamp = typeof message.getTimestamp === 'function'
                        ? message.getTimestamp()
                        : message.timestamp;

                    // Epoch envelope (gated): unknown kid → skip, not error (§7.9)
                    let innerAuthor = null;
                    if (this.controller.isEpochEnvelope(content)) {
                        const opened = await this.controller.openEpochEnvelope(messageStreamId, content,
                            { live: false, timestamp: historyTimestamp });
                        if (opened === null) {
                            epochWaiting++;
                            continue;
                        }
                        content = opened;

                        // Members-only: the author comes from the wrapper
                        // inside the seal, never from the transport. History
                        // is exempt from the access cut (retention is the
                        // proof of past membership), but never from
                        // verification.
                        const modeChannel = await this.controller._gatedChannelFor(messageStreamId);
                        if (modeChannel?.wireIdentity === 'sealed') {
                            const authored = await this.controller._openAuthorship(modeChannel, content);
                            if (!authored) continue;
                            content = authored.payload;
                            innerAuthor = authored.author;
                        }
                    }

                    // Inject account from StreamMessage metadata (gated: the
                    // envelope signer, via resolveAuthor — D10c)
                    if (typeof content === 'object') {
                        const transportPublisher = typeof message.getPublisherId === 'function'
                            ? message.getPublisherId()
                            : message.publisherId;
                        const publisherId = innerAuthor ?? await this.controller.resolveAuthor(
                            messageStreamId, message, transportPublisher);
                        if (!publisherId) continue;
                        const messageTimestamp = historyTimestamp;
                        if (publisherId) {
                            this.controller.attachAccount(content, publisherId);
                            if (!content.sender) content.sender = publisherId;
                            content._publisherId = publisherId;
                        }
                        if (!content.timestamp && messageTimestamp) {
                            content.timestamp = messageTimestamp;
                        }
                        if (messageTimestamp) {
                            content._timestamp = messageTimestamp;
                        }
                    }
                    
                    // Skip ephemeral messages
                    if (content?.type && EPHEMERAL_TYPES.includes(content.type)) {
                        continue;
                    }
                    
                    // For partition 0: only accept content message types
                    if (partition === STREAM_CONFIG.MESSAGE_STREAM.MESSAGES && !isValidContentMessage(content)) {
                        continue;
                    }

                    // For partition 1: only accept override message types
                    if (partition === STREAM_CONFIG.MESSAGE_STREAM.CONTROL && !isValidOverrideMessage(content)) {
                        continue;
                    }
                    
                    collected.push(content);
                } catch (e) {
                    Logger.warn('Error processing historical message:', e.message);
                }
            }
            
            if (decryptErrors > 0) {
                Logger.debug(`fetchOlderHistory: skipped ${decryptErrors} messages (decrypt error)`);
            }
            if (epochWaiting > 0) {
                Logger.info(`fetchOlderHistory: ${epochWaiting} messages waiting for epoch key on ${messageStreamId.slice(-20)}`);
            }

            return collected;
        };

        // Dedup key for merging two passes — either pass may have holes.
        const msgKey = (m) => m?.id
            || (m?.type === 'image_chunk' && m?.imageId != null ? `chunk:${m.imageId}:${m.chunkIndex}` : null)
            || `${m?.type}:${m?._timestamp || m?.timestamp || ''}:${m?.account || ''}:${m?.messageId || m?.targetId || ''}:${m?.emoji || ''}:${m?.action || ''}`;
        
        try {
            Logger.debug(`Fetching ${count} older messages before ${new Date(beforeTimestamp).toISOString()}`);
            
            let allMessages = await collectRange();
            
            // Exhaustion claimed (range returned ≤ count messages)? Confirm on a
            // fresh connection before trusting it — one truncated response would
            // permanently disable pagination for the session. At the TRUE end of
            // history the confirmation pass is cheap (returns the same few
            // messages). Both passes are unioned since each may have holes.
            if (allMessages.length <= count && !signal?.aborted) {
                try {
                    const confirm = await collectRange();
                    if (confirm.length !== allMessages.length) {
                        Logger.info(
                            `fetchOlderHistory: confirmation pass returned ${confirm.length} vs ${allMessages.length} messages — first response was truncated (storage WS drop)`
                        );
                    }
                    const byKey = new Map();
                    for (const m of allMessages) byKey.set(msgKey(m), m);
                    for (const m of confirm) {
                        const k = msgKey(m);
                        if (!byKey.has(k)) byKey.set(k, m);
                    }
                    allMessages = Array.from(byKey.values());
                } catch (confirmError) {
                    Logger.debug('fetchOlderHistory: confirmation pass failed (keeping first result):', confirmError.message);
                }
            }
            
            // Sort by timestamp ASC explicitly. The Streamr SDK resend iterator order
            // is not guaranteed (in practice, range queries can deliver newest-first),
            // so we MUST NOT assume `allMessages` is already oldest-first. Without this
            // sort, `slice(length - count)` would keep the wrong half of the range —
            // dropping a deterministic block of messages in the middle of the history
            // (the messages immediately below the cursor) while keeping the oldest ones.
            const getTs = (m) => m._timestamp || m.timestamp || 0;
            allMessages.sort((a, b) => getTs(a) - getTs(b));
            
            // Take the most recent N messages (largest timestamps still below cursor).
            // These are the messages adjacent to the current view — the next page going back.
            const startIndex = Math.max(0, allMessages.length - count);
            const resultMessages = allMessages.slice(startIndex);
            
            // hasMore is true if there were more messages than we're returning
            const hasMore = allMessages.length > count;
            
            // Caller (channels.loadMoreHistory) emits the canonical user-facing log with
            // P0/P1 breakdown — keep this one at debug level to avoid duplicate noise.
            Logger.debug(`fetchOlderHistory partition ${partition}: ${resultMessages.length} messages (hasMore: ${hasMore})`);
            
            return {
                messages: resultMessages,
                hasMore: hasMore
            };
        } catch (error) {
            Logger.warn('Older history fetch error:', error.message);
            return { messages: [], hasMore: false };
        }
    }

    /**
     * Fetch older history using a bounded time window instead of scanning from epoch.
     * Used for DM inbox pagination where scanning from epoch is too expensive.
     * 
     * @param {string} streamId - Stream ID
     * @param {number} partition - Partition number
     * @param {number} beforeTimestamp - Fetch messages before this timestamp (ms)
     * @param {number} windowMs - Time window size in ms (e.g. 7 days)
     * @param {AbortSignal} [signal] - Optional abort signal
     * @param {string} [password] - Channel password for payload decryption (optional)
     * @returns {Promise<{messages: Array, hasMore: boolean, windowStart: number}>}
     */
    async fetchOlderHistoryWindowed(streamId, partition, beforeTimestamp, windowMs, signal = null, password = null) {
        if (!this.controller.client) {
            throw new Error('Client not initialized');
        }

        const windowStart = Math.max(0, beforeTimestamp - windowMs);
        const windowEnd = beforeTimestamp - 1;
        const messages = [];

        try {
            Logger.debug(`fetchOlderHistoryWindowed: ${new Date(windowStart).toISOString()} → ${new Date(windowEnd).toISOString()}`);

            // Raw — DM inboxes are never gated, so every entry must pass the
            // envelope-authenticity check below (the sealed DM adds its own
            // proof downstream; this is the replay defence raw turned off).
            const resend = await this.controller.client.resend(
                { streamId, partition },
                {
                    from: { timestamp: windowStart },
                    to: { timestamp: windowEnd },
                    raw: true
                }
            );

            const iterator = resend[Symbol.asyncIterator]();
            let iteratorDone = false;

            while (!iteratorDone) {
                if (signal?.aborted) {
                    Logger.debug('fetchOlderHistoryWindowed aborted');
                    break;
                }

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
                    Logger.warn('fetchOlderHistoryWindowed iteration error:', iterError.message);
                    continue;
                }

                try {
                    if (!verifyEnvelopeAuthenticity(message)
                        || !await this.controller.publisherMayWrite(streamId, message)) continue;
                    let content = message.content || message;

                    // Decrypt payload for password-encrypted channels. DM inbox
                    // callers pass no password (E2E envelopes decrypt downstream).
                    if (password && typeof content === 'string') {
                        try {
                            content = await cryptoManager.decryptJSON(content, password);
                        } catch (decryptError) {
                            continue; // Skip messages we can't decrypt
                        }
                    }

                    const publisherId = typeof message.getPublisherId === 'function'
                        ? message.getPublisherId()
                        : message.publisherId;

                    messages.push({
                        content,
                        publisherId,
                        timestamp: message.timestamp
                    });
                } catch (e) {
                    Logger.warn('fetchOlderHistoryWindowed: error processing message:', e.message);
                }
            }

            // hasMore = true if windowStart > 0 (there could be older messages)
            const hasMore = windowStart > 0;

            Logger.info(`fetchOlderHistoryWindowed: ${messages.length} messages in window, hasMore: ${hasMore}`);

            return { messages, hasMore, windowStart };
        } catch (error) {
            Logger.warn('fetchOlderHistoryWindowed error:', error.message);
            return { messages: [], hasMore: windowStart > 0, windowStart };
        }
    }

    /**
     * Fetch history asynchronously and pass to handler
     * Fails gracefully if CORS or other issues occur
     * @private
     * @param {string} streamId - Stream ID
     * @param {number} partition - Partition number
     * @param {number} count - Number of messages to fetch
     * @param {Function} handler - Message handler
     * @param {string} password - Password for decryption (optional)
     */
    async fetchHistoryAsync(streamId, partition, count, handler, password = null, onHistoryComplete = null, allowOverridesInContentPartition = false, opts = {}) {
        // opts.quiet: suppress info-level logs (used by high-frequency callers
        // like the background activity poller)
        const quiet = !!opts.quiet;
        // Declared outside the try block so the finally handler can report the
        // real count to onHistoryComplete (scoping bug fix: it previously read
        // an out-of-scope variable via typeof and always reported 0)
        let rawCount = 0;
        try {
            Logger.debug(`Fetching ${count} historical messages for partition ${partition}${password ? ' (encrypted)' : ''}...`);

            // Gated history reads the raw envelopes: the SDK's validator
            // re-checks every stored message against the PRESENT gate state
            // (isValidSignature), which erases ex-members' history. Retention
            // is the proof of past membership — the storage node validated at
            // ingest — so the client only recovers authorship from the
            // envelope signature (resolveAuthor) and lets kid freshness cut
            // stale-key spam. Live subscriptions stay strictly validated.
            const gatedChannel = await this.controller._gatedChannelFor(streamId);

            // Streamr SDK resend: must await before iterating. Raw on every
            // channel kind — non-gated entries pass the envelope check below.
            const resend = await this.controller.client.resend(
                { streamId, partition },
                { last: count, raw: true }
            );
            
            Logger.debug(`Resend object received for partition ${partition}:`, typeof resend);
            
            // Consume the async iterator and process each message
            let msgCount = 0;
            let skippedCount = 0;
            
            // Ephemeral message types that should NEVER be loaded from history
            const EPHEMERAL_TYPES = ['presence', 'typing'];
            
            // Helper to check if message looks like a text message
            const isTextMessage = (msg) => {
                // Has explicit text type ('text' or 'message')
                if (msg?.type === 'text' || msg?.type === 'message') return true;
                // OR has text message structure (id, text, sender, timestamp) without explicit type
                if (msg?.id && msg?.text && msg?.sender && msg?.timestamp && !msg?.type) return true;
                return false;
            };
            
            // Helper to check if message is a reaction
            const isReaction = (msg) => msg?.type === 'reaction';
            
            // Helper to check if message is an image
            const isImageMessage = (msg) => msg?.type === 'image' && msg?.imageId;

            // Helper to check if message is a stored image chunk
            const isImageChunkMessage = (msg) => {
                return msg?.type === 'image_chunk'
                    && msg?.imageId
                    && Number.isInteger(msg?.chunkIndex)
                    && typeof msg?.data === 'string';
            };
            
            // Helper to check if message is a file/video announcement (mesh or storage)
            const isVideoMessage = (msg) => (msg?.type === 'file_announce' || msg?.type === 'storage_file_announce') && msg?.metadata;
            
            // Helper to check if message is an E2E encrypted envelope (DM messages)
            // These are decrypted downstream by routeInboxMessage, not here
            // Format: { ct: base64, iv: base64, e: 'aes-256-gcm' }
            const isEncryptedEnvelope = (msg) => !!(msg && typeof msg.ct === 'string' && typeof msg.iv === 'string' && msg.e === 'aes-256-gcm');
            
            // Valid content message types for message partition 0 (stored content)
            const isValidContentMessage = (msg) => {
                return isTextMessage(msg)
                    || isReaction(msg)
                    || isImageMessage(msg)
                    || isImageChunkMessage(msg)
                    || isVideoMessage(msg)
                    || isEncryptedEnvelope(msg);
            };

            // Valid override message types for message partition 1 (stored control)
            const isValidOverrideMessage = (msg) => {
                return (msg?.type === 'edit' && msg?.targetId) || (msg?.type === 'delete' && msg?.targetId);
            };
            
            // Use manual iteration to catch decryption errors per-message
            // (for-await-of would throw on first decrypt error, aborting the loop)
            const iterator = resend[Symbol.asyncIterator]();
            let iteratorDone = false;
            let decryptErrors = 0;
            
            while (!iteratorDone) {
                let message;
                try {
                    const result = await iterator.next();
                    iteratorDone = result.done;
                    if (iteratorDone) break;
                    message = result.value;
                } catch (iterError) {
                    // SDK decrypt error for missing GroupKey - try recovery for DM streams
                    if (iterError.code === 'DECRYPT_ERROR' || iterError.message?.includes('encryption key')) {
                        decryptErrors++;
                        if (decryptErrors <= 3) {
                            Logger.debug('History decrypt error (likely old GroupKey):', iterError.message?.substring(0, 80));
                        }
                        continue; // Try next message
                    }
                    // Other iterator errors - log and try to continue
                    Logger.warn('History iteration error:', iterError.message);
                    continue;
                }
                
                rawCount++;
                try {
                    // Non-gated raw: the envelope check replaces the SDK
                    // validation raw turned off (gated authorship comes from
                    // resolveAuthor below).
                    if (!gatedChannel && (!verifyEnvelopeAuthenticity(message)
                        || !await this.controller.publisherMayWrite(streamId, message))) {
                        skippedCount++;
                        continue;
                    }
                    let content = message.content || message;

                    // Decrypt if password provided (for encrypted channels)
                    if (password && typeof content === 'string') {
                        try {
                            content = await cryptoManager.decryptJSON(content, password);
                        } catch (decryptError) {
                            // Log first few decrypt failures for debugging
                            if (rawCount <= 3) {
                                Logger.debug(`Failed to decrypt message ${rawCount}:`, decryptError.message);
                            }
                            skippedCount++;
                            continue;
                        }
                    }

                    const historyTimestamp = typeof message.getTimestamp === 'function'
                        ? message.getTimestamp()
                        : message.timestamp;

                    // Epoch envelope (gated): unknown kid → skip, not error (§7.9)
                    let innerAuthor = null;
                    if (this.controller.isEpochEnvelope(content)) {
                        const opened = await this.controller.openEpochEnvelope(streamId, content,
                            { live: false, timestamp: historyTimestamp });
                        if (opened === null) {
                            skippedCount++;
                            continue;
                        }
                        content = opened;

                        // Members-only: the author comes from the wrapper
                        // inside the seal, never from the transport.
                        const modeChannel = await this.controller._gatedChannelFor(streamId);
                        if (modeChannel?.wireIdentity === 'sealed') {
                            const authored = await this.controller._openAuthorship(modeChannel, content);
                            if (!authored) {
                                skippedCount++;
                                continue;
                            }
                            content = authored.payload;
                            innerAuthor = authored.author;
                        }
                    }

                    // Inject account from StreamMessage (same as realtime handler;
                    // gated: the envelope signer, via resolveAuthor — D10c).
                    // Also surface broker timestamps (same as fetchOlderHistory) so
                    // consumers can rely on `timestamp`/`_timestamp` fallbacks.
                    if (typeof content === 'object') {
                        const transportPublisher = typeof message.getPublisherId === 'function'
                            ? message.getPublisherId()
                            : message.publisherId;
                        const publisherId = innerAuthor ?? await this.controller.resolveAuthor(
                            streamId, message, transportPublisher);
                        if (!publisherId) {
                            skippedCount++;
                            continue;
                        }
                        const messageTimestamp = historyTimestamp;
                        if (publisherId) {
                            this.controller.attachAccount(content, publisherId);
                        }
                        if (!content.timestamp && messageTimestamp) {
                            content.timestamp = messageTimestamp;
                        }
                        if (messageTimestamp) {
                            content._timestamp = messageTimestamp;
                        }
                    }
                    
                    // Log first few messages for debugging
                    if (rawCount <= 3) {
                        Logger.debug(`History message ${rawCount} from partition ${partition}:`, JSON.stringify(content).slice(0, 200));
                    }
                    
                    // Skip ephemeral messages (presence, typing) - they don't belong in history
                    if (content?.type && EPHEMERAL_TYPES.includes(content.type)) {
                        skippedCount++;
                        continue;
                    }
                    
                    // Partition-specific content/override filters apply ONLY to the
                    // dual-stream messageStream (-1). Other streams (admin -3, DM, etc.)
                    // share the same partition numbers but carry different payload
                    // shapes (e.g. ADMIN_STATE) and must bypass these filters.
                    const isMsgStream = isMessageStream(streamId);

                    // For message stream partition 0: accept only content messages
                    if (isMsgStream && partition === STREAM_CONFIG.MESSAGE_STREAM.MESSAGES) {
                        const allowLegacyOverride = allowOverridesInContentPartition
                            && (content?.type === 'edit' || content?.type === 'delete');
                        if (!isValidContentMessage(content) && !allowLegacyOverride) {
                            skippedCount++;
                            continue;
                        }
                    }

                    // For message stream partition 1: accept only edit/delete overrides
                    if (isMsgStream && partition === STREAM_CONFIG.MESSAGE_STREAM.CONTROL) {
                        if (!isValidOverrideMessage(content)) {
                            skippedCount++;
                            continue;
                        }
                    }
                    
                    await handler(content);
                    msgCount++;
                } catch (e) {
                    Logger.warn('Error processing historical message:', e.message);
                }
            }
            
            if (decryptErrors > 0) {
                // NOTE: must keep Logger as `this` — a detached method reference
                // ((quiet ? Logger.debug : Logger.info)(...)) loses the binding
                // and throws "Cannot read properties of undefined (currentLevel)"
                if (quiet) Logger.debug(`History: skipped ${decryptErrors} messages (old GroupKey encryption)`);
                else Logger.info(`History: skipped ${decryptErrors} messages (old GroupKey encryption)`);
            }
            
            if (msgCount > 0) {
                const summary = `Loaded ${msgCount} historical messages for partition ${partition}` + 
                    (skippedCount > 0 ? ` (skipped ${skippedCount} ephemeral)` : '');
                if (quiet) Logger.debug(summary);
                else Logger.info(summary);
            } else {
                Logger.debug(`No historical messages for partition ${partition}` +
                    (skippedCount > 0 ? ` (skipped ${skippedCount} ephemeral)` : '') +
                    ` (raw received: ${rawCount})`);
            }
        } catch (error) {
            // CORS errors and other network issues are caught here
            Logger.warn(`History fetch failed for partition ${partition} (may be CORS on localhost):`, error.message);
        } finally {
            // Signal that initial history fetch is complete (success or failure).
            // Pass `loaded`/`requested` so callers can detect exhaustion (when
            // fewer raw messages came back than requested → no more history
            // exists in storage). Used by `channels.onHistoryComplete` to flip
            // `hasMoreHistory=false` deterministically.
            if (onHistoryComplete) {
                try {
                    await onHistoryComplete({ loaded: rawCount, requested: count });
                } catch (e) { Logger.warn('onHistoryComplete error:', e); }
            }
        }
    }
}
