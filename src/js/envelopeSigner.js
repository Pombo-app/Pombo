/**
 * Envelope signer recovery — authorship for gated channels (N-C).
 *
 * In a gated channel every member publishes as the gate clone, so the
 * on-wire `publisherId` names the CONTRACT, not the author. The author is
 * whoever signed the Streamr envelope: the SDK validated that signature
 * against the gate's isValidSignature (ERC-1271) before the message reached
 * us, so recovering the signer here yields an address the chain has already
 * vouched for (everMember ∧ ¬erased, or a current holder).
 *
 * The digest is rebuilt exactly as the SDK builds it for MESSAGE-type
 * messages (createSignaturePayload, @streamr/sdk v103):
 *
 *   payload = utf8(streamId + partition + timestamp + sequenceNumber
 *                  + publisherId + msgChainId
 *                  [+ prevTimestamp + prevSequenceNumber])
 *             ‖ content bytes
 *   digest  = keccak256("\x19Ethereum Signed Message:\n" + len(payload)
 *             ‖ payload)                       // ethers.hashMessage
 *   signer  = ecrecover(digest, signature)     // 65-byte r‖s‖v(27/28)
 *
 * ⚠️ This mirrors SDK internals that carry no stability guarantee. The SDK is
 * pinned, and the vitest parity suite builds real messages with the SDK's own
 * MessageSigner and asserts recovery — an SDK upgrade that changes the layout
 * fails the suite loudly instead of silently mis-attributing authors.
 */

import { Logger } from './logger.js';

// Recovery is ~0.5ms of secp256k1; a busy channel replays history in bursts.
// Keyed by digest ‖ signature: the pair fully determines the recovered
// address, so the cache can never be poisoned by re-attaching a signature to
// different content (the SDK drops those upstream, but the cache must not
// depend on that).
const recoveryCache = new Map();
const RECOVERY_CACHE_MAX = 500;

function toHex(bytes) {
    return ethers.hexlify(bytes);
}

/**
 * The raw protocol StreamMessage, whichever shape the SDK handed us.
 *
 * Live subscriptions and resend iterators surface the public `Message`
 * wrapper (parsed content, flat fields) that carries the raw StreamMessage
 * in its internal `streamMessage` property — the raw one has the messageId,
 * the byte content and the signature this module needs.
 */
function unwrap(streamMessage) {
    return streamMessage?.streamMessage ?? streamMessage;
}

/**
 * Rebuild the SDK's signature payload for a MESSAGE-type StreamMessage.
 * @returns {Uint8Array|null} null when the message shape is not recoverable
 */
export function buildEnvelopePayload(message) {
    const streamMessage = unwrap(message);
    const id = streamMessage?.messageId;
    const content = streamMessage?.content;
    if (!id || !(content instanceof Uint8Array)) return null;

    const prev = streamMessage.prevMsgRef;
    const header = `${id.streamId}${id.streamPartition}${id.timestamp}`
        + `${id.sequenceNumber}${id.publisherId}${id.msgChainId}`
        + (prev ? `${prev.timestamp}${prev.sequenceNumber}` : '');

    const headerBytes = new TextEncoder().encode(header);
    const payload = new Uint8Array(headerBytes.length + content.length);
    payload.set(headerBytes, 0);
    payload.set(content, headerBytes.length);
    return payload;
}

/**
 * Recover the address that signed a StreamMessage's envelope.
 *
 * Only MESSAGE-type messages (all Pombo traffic goes out as MESSAGE with
 * EncryptionType.NONE — publishAs guarantees it). Returns null on any
 * malformed input; the caller treats null as "drop the message".
 *
 * @param {Object} message - SDK StreamMessage OR public Message wrapper, as seen at ingest
 * @returns {string|null} Lowercase 0x address, or null
 */
/**
 * The single authenticity check every RAW read goes through on NON-gated
 * streams: the envelope must be signed by the key it claims as publisher.
 * It replaces the SDK validation that `raw` turns off — without it a raw
 * reader would accept an envelope carrying someone else's publisherId,
 * which is authorship forgery on every stream where the publisher IS the
 * author. Gated streams never use this: there the publisher is the clone
 * for everyone and the author is the recovered signer itself
 * (resolveAuthor), so signer == publisherId would reject every message.
 *
 * @param {Object} message - SDK StreamMessage OR public Message wrapper
 * @returns {boolean} true when the envelope is authentically the publisher's
 */
export function verifyEnvelopeAuthenticity(message) {
    const signer = recoverEnvelopeSigner(message);
    if (!signer) return false;
    const streamMessage = unwrap(message);
    const publisherId = typeof message?.getPublisherId === 'function'
        ? message.getPublisherId()
        : (streamMessage?.messageId?.publisherId ?? message?.publisherId);
    return !!publisherId && signer === String(publisherId).toLowerCase();
}

export function recoverEnvelopeSigner(message) {
    try {
        const streamMessage = unwrap(message);
        const signature = streamMessage?.signature;
        if (!(signature instanceof Uint8Array) || signature.length !== 65) return null;

        const payload = buildEnvelopePayload(streamMessage);
        if (!payload) return null;

        const digest = ethers.hashMessage(payload);
        const cacheKey = digest + toHex(signature);
        const cached = recoveryCache.get(cacheKey);
        if (cached !== undefined) return cached;

        const signer = ethers.recoverAddress(digest, toHex(signature)).toLowerCase();

        if (recoveryCache.size >= RECOVERY_CACHE_MAX) {
            recoveryCache.delete(recoveryCache.keys().next().value);
        }
        recoveryCache.set(cacheKey, signer);
        return signer;
    } catch (error) {
        Logger.debug('envelopeSigner: recovery failed:', error.message);
        return null;
    }
}
