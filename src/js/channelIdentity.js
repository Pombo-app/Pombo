/**
 * Per-channel ephemeral publishing identity (D2).
 *
 * A channel session publishes under one throwaway key. Everything that channel
 * sends — messages, edits, reactions, presence, media signals, pieces — goes out
 * under it, with the real account named by a proof in the payload.
 *
 * ONE KEY PER CHANNEL, not per message: inside a channel the pseudonym is not
 * hiding anything from members, who read the proof anyway. Its job is to stop a
 * network observer, who sees publisherId on every message of every stream
 * without joining anything, from stitching a social graph together. Rotating
 * per message would cost an ECDSA key per message and buy nothing.
 *
 * ONE KEY PER CHANNEL, not per account: the whole point is that two channels
 * cannot be tied to the same person by their publisher.
 *
 * NEVER PERSISTED. The key lives in memory and dies with the session, so
 * yesterday's pseudonym cannot be linked to today's.
 *
 * LIFETIME IS THE SUBSCRIPTION, NOT THE VIEW. Rotation happens when the channel
 * is really left, not when the user switches tabs — a background upload or
 * download keeps publishing under the identity its peers already know. Callers
 * must therefore drop the identity from the same place they tear the
 * subscription down, never from a UI handler.
 */

import { Logger } from './logger.js';
import { authManager } from './auth.js';
import { createPublisherProof } from './publisherProof.js';

// Base channel id → { identity, publisherId, proof }
const identities = new Map();

/**
 * Every stream of a channel shares one identity, so they must key to the
 * same entry: -1 message, -2 ephemeral, -3 admin, -4 keys, -5 interactions.
 *
 * @param {string} streamId - Any of the channel's stream IDs
 * @returns {string|null} The channel's base ID
 */
export function baseChannelId(streamId) {
    if (!streamId) return null;
    return String(streamId).replace(/-[12345]$/, '');
}

/**
 * The channel's ephemeral identity, created on first use.
 *
 * @param {string} streamId - Any of the channel's stream IDs
 * @returns {{identity: Object, publisherId: string, proof: string}}
 */
export function getChannelIdentity(streamId) {
    const key = baseChannelId(streamId);
    if (!key) throw new Error('Cannot build channel identity: no stream id');

    const existing = identities.get(key);
    if (existing) return existing;

    const EthereumKeyPairIdentity = window.EthereumKeyPairIdentity;
    if (!EthereumKeyPairIdentity) {
        throw new Error('EthereumKeyPairIdentity not exposed — check streamr-bundle.js');
    }

    const accountKey = authManager.wallet?.privateKey;
    if (!accountKey) throw new Error('Cannot build channel identity: no private key');

    // crypto.getRandomValues, not ethers.Wallet.createRandom(): under jsdom the
    // latter returns a Node Buffer that fails ethers' own cross-realm check.
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const ephemeralPrivateKey = '0x' + Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0')).join('');

    const identity = EthereumKeyPairIdentity.fromPrivateKey(ephemeralPrivateKey);
    const publisherId = new ethers.Wallet(ephemeralPrivateKey).address;

    // One proof per key, reused by every message: the digest covers only the
    // publisher, so it does not change until the identity rotates.
    const entry = {
        identity,
        publisherId,
        proof: createPublisherProof(accountKey, publisherId),
        // Signs for the pseudonym outside the SDK: a storage purge of an own
        // message must come from the key that published it. Memory only.
        wallet: new ethers.Wallet(ephemeralPrivateKey)
    };

    identities.set(key, entry);
    Logger.debug('Channel identity created for', key, '→', publisherId);
    return entry;
}

/**
 * Forget a channel's identity so the next entry gets a fresh pseudonym.
 *
 * Call this where the subscription is torn down. Calling it on a view switch
 * would re-pseudonymise mid-transfer, and peers already hold the old publisher.
 *
 * @param {string} streamId - Any of the channel's stream IDs
 */
export function dropChannelIdentity(streamId) {
    const key = baseChannelId(streamId);
    if (key && identities.delete(key)) {
        Logger.debug('Channel identity dropped for', key);
    }
}

/**
 * Drop every identity. Called on disconnect/logout.
 */
export function clearChannelIdentities() {
    identities.clear();
}

/**
 * @param {string} streamId - Any of the channel's stream IDs
 * @returns {boolean} true if this channel already has an identity
 */
export function hasChannelIdentity(streamId) {
    return identities.has(baseChannelId(streamId));
}
