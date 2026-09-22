/**
 * Publisher proof — binding an ephemeral publisher to a real Pombo account.
 *
 * In channels the message is published under a throwaway key, so `publisherId`
 * says nothing about who wrote it. The proof inside the payload is what does:
 *
 *     proof = sign_account( keccak("POMBO_PUB_V1|<ephemeral address>") )
 *
 * Reading it is `ecrecover` against the SAME digest, rebuilt from the
 * publisherId that arrived on the wire. That binding is the whole security
 * argument, and it holds without any secret:
 *
 * - A proof cannot be lifted onto another publisher. Recomputing the digest
 *   with a different publisherId recovers a different, meaningless address —
 *   it does not "fail", it just stops naming the victim.
 * - Replaying a whole message elsewhere needs the ephemeral PRIVATE key to
 *   re-sign the Streamr envelope for the new stream, which the attacker does
 *   not have. The SDK validates that signature before we ever see the payload.
 *
 * DMs do NOT use this: there the proof travels inside the sealed envelope
 * (dmCrypto.seal), bound to the recipient, so it is not readable by observers.
 * Here the proof is public by design — in a channel, membership already
 * discloses who is speaking. See D1 and D11 in the implementation plan.
 *
 * One proof per ephemeral key, not per message: the digest only covers the
 * publisher, so it is computed once per channel session and reused.
 */

import { Logger } from './logger.js';

const PROOF_PREFIX = 'POMBO_PUB_V1';

// Recovery is ~0.5ms of secp256k1 and every message in a busy channel carries a
// proof, so cache by (publisherId, proof). Keyed by both: a publisher whose
// proof changes must not keep the old identity.
const recoveryCache = new Map();
const RECOVERY_CACHE_MAX = 500;

/**
 * The digest a publisher proof signs.
 * @param {string} publisherId - The ephemeral publisher address
 * @returns {string} keccak256 digest
 */
export function publisherBindDigest(publisherId) {
    return ethers.keccak256(ethers.toUtf8Bytes(
        `${PROOF_PREFIX}|${String(publisherId).toLowerCase()}`
    ));
}

/**
 * Sign a proof that `publisherId` is publishing on our behalf.
 *
 * @param {string} accountPrivateKey - The real account's private key
 * @param {string} publisherId - The ephemeral publisher address
 * @returns {string} 65-byte serialized signature
 */
export function createPublisherProof(accountPrivateKey, publisherId) {
    if (!accountPrivateKey) throw new Error('Cannot create publisher proof: no private key');
    if (!publisherId) throw new Error('Cannot create publisher proof: no publisher id');

    return new ethers.SigningKey(accountPrivateKey)
        .sign(publisherBindDigest(publisherId)).serialized;
}

/**
 * Recover the account a proof names, or null if it cannot be read.
 *
 * Returns null rather than throwing: a malformed proof is an untrusted input on
 * a public stream, not an exceptional condition.
 *
 * @param {string} publisherId - On-wire publisher of the message
 * @param {string} proof - Proof from the payload
 * @returns {string|null} Lowercased account address, or null
 */
export function recoverPublisherAccount(publisherId, proof) {
    if (!publisherId || typeof proof !== 'string') return null;

    const key = `${String(publisherId).toLowerCase()}|${proof}`;
    const cached = recoveryCache.get(key);
    if (cached !== undefined) return cached;

    let account = null;
    try {
        account = ethers.recoverAddress(publisherBindDigest(publisherId), proof).toLowerCase();
    } catch (error) {
        Logger.debug('Publisher proof could not be recovered:', error.message);
    }

    // Crude bound, not an LRU: entries are cheap and a channel session sees far
    // fewer distinct publishers than this. Clearing wholesale beats tracking
    // recency for something that costs 0.5ms to rebuild.
    if (recoveryCache.size >= RECOVERY_CACHE_MAX) recoveryCache.clear();
    recoveryCache.set(key, account);

    return account;
}

/**
 * Set the resolved account on a payload, keeping `sender` in step.
 *
 * `sender` stopped travelling on the wire with D6 — it duplicated the proof in
 * the clear — but ~85 call sites still read it, so it survives as an alias
 * derived from the verified account.
 *
 * An alias is only safe while it cannot drift, and there are SEVEN places that
 * decide an account: the ingest point plus every path that opens a sealed
 * envelope and replaces the throwaway publisher with the real sender. Assigning
 * in each of them is how the same bug arrives seven times — see D10c, which
 * catalogues that exact shape. This is the one place that assigns both.
 *
 * @param {Object} data - Payload (mutated in place)
 * @param {string} account - The resolved account
 * @returns {Object} The same object, for chaining
 */
export function applyAccount(data, account) {
    if (!data || typeof data !== 'object') return data;
    data.account = account;
    data.sender = account;
    return data;
}

/**
 * Drop the fields that must never reach the wire — the egress counterpart to
 * applyAccount.
 *
 * Two groups, for two different reasons:
 *
 * - LOCAL UI STATE (`verified`, `pending`, `_dmSent`) — meaningless on another
 *   machine. `verified` in particular must be re-derived per receiver; shipping
 *   ours would let a sender assert its own trust level.
 *
 * - IDENTITY (`sender`, `account`, `signature`, `channelId`) — removed by
 *   D6/D7. The builders stamp `sender`/`account` so a message renders locally
 *   the moment it is created, but on the wire they would put the author's
 *   address in the clear beside an ephemeral publisher, undoing the entire
 *   migration. The receiver re-derives both from the proof at ingest.
 *   `channelId` goes too: the Streamr MessageID already binds the stream, so it
 *   was only ever needed by the app-layer hash that D6 removed.
 *
 * @param {Object} data
 * @returns {Object} A copy safe to publish
 */
export function stripLocalFields(data) {
    if (!data || typeof data !== 'object') return data;
    const {
        verified, pending, failed, failError, delivered, undelivered, _dmSent,
        sender, account, signature, channelId,
        ...networkMessage
    } = data;
    return networkMessage;
}

/**
 * Drop cached recoveries. Called on disconnect/logout.
 */
export function clearPublisherProofCache() {
    recoveryCache.clear();
}
