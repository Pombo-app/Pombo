/**
 * Epoch Key Manager — protocol state machine for the keys stream (-4).
 *
 * Owns, per gated channel: the adopted epoch keys (kid → key), the announces
 * seen so far, and the in-flight KEY_REQUEST. The crypto lives in
 * epochKeyCrypto; the transport (publish, resend) in streamr.js.
 *
 * Protocol (UNIFIED_IMPLEMENTATION_PLAN.md §5.4, §7.9, D12–D14):
 *
 *   KEY_ANNOUNCE  { t, epoch, keyId, keyHash, validFrom }
 *     Only the admin set may announce. v1 admin set = the stream's namespace
 *     address — the ONE address that could have created the stream, which is
 *     the only admin claim that cannot be spoofed by an invite payload.
 *     Conflict rule (D13): higher epoch wins; same epoch → older transport
 *     timestamp wins; tie → lower publisher address.
 *
 *   KEY_REQUEST   { t, requestId, pubkey, fromEpoch }
 *     `pubkey` is a fresh per-request keypair (D12) held in memory only —
 *     never persisted, never reused. Answered live AND from storage (N-B):
 *     a member coming online later scans recent stored requests that no wrap
 *     covers yet and answers them — the requester holds the pair while
 *     waiting, so timing no longer has to coincide.
 *
 *   KEY_WRAP      { t, requestId, keyId, epoch, tag, epk, iv, ct }
 *     Any member holding the key may answer (k-of-n), but politely (N-B
 *     anti-stampede, §7.10): rank = hash(identity ‖ requestId) mod N orders
 *     the members without coordination; each waits rank × 2s and stays
 *     silent for epochs some observed wrap already covers. Addressed by
 *     tag = sha256(requestPubkey ‖ keyId) — O(1) match, no membership signal.
 *     The unwrapped key is adopted ONLY if sha256(key) equals the keyHash of
 *     the matching announce: a malicious wrapper can waste bandwidth, never
 *     poison a key.
 *
 * Epoch keys are channel keys, not identities: they persist in secureStorage
 * (encrypted at rest, out of the service worker's reach) so a session restart
 * does not cost a request round-trip. History policy: every retained epoch is
 * handed out to whoever passes the current gate, regardless of gate mode —
 * holding access is the condition; an unreadable gate fails closed to the
 * current epoch only.
 */

import { Logger } from './logger.js';
import { secureStorage } from './secureStorage.js';
import { epochKeyCrypto } from './epochKeyCrypto.js';
import { streamrController } from './streamr.js';
import { cryptoManager } from './crypto.js';
import { authManager } from './auth.js';
import { CONFIG } from './config.js';
import { KEYS_MSG_TYPE, KEYS_STREAM } from './streamConstants.js';
import { gateManager } from './gate.js';
import { dmCrypto } from './dmCrypto.js';
import { authorship } from './authorship.js';
import { keysRetentionDays } from './streamRetention.js';
import { identityManager } from './identity.js';

/**
 * Channels running the epoch-key protocol (gated, N-A/N-C): the gate clone
 * publishes for everyone (ERC-1271) and KEY_REQUESTs are answered only after
 * a gate check.
 */
export const usesEpochKeys = (channel) =>
    !!channel?.gate?.address && !!channel?.keysStreamId;

/**
 * Members-only author visibility: -1/-2 publish under the channel's SHARED
 * publish key (the transport says nothing about authorship; identity lives
 * inside the epoch seal). Everyone-mode channels — and every channel created
 * before the mode existed — publish via the gate clone as always.
 */
export const usesSharedPublish = (channel) =>
    usesEpochKeys(channel) && channel?.wireIdentity === 'sealed';

// Re-request backoff: a pending request younger than this is not superseded.
const REQUEST_MIN_INTERVAL_MS = 60 * 1000;

// A KEY_REQUEST from a cold node can miss every live subscriber (§7.2 R2:
// join registers interest, broadcast can still shout into an empty room).
// Waiting the full minute to retry turns that loss into a 60s blank channel
// — measured on Android. Retry fast while the topology warms, then back off.
const REQUEST_RETRY_FAST_MS = 10 * 1000;
const REQUEST_FAST_ATTEMPTS = 4;

// How much -4 history to scan for announces on channel open. Rotations are
// event-driven (ban) plus the weekly cadence (N-D) — ~52 announces/year plus
// wraps, still inside this window for the storage retention that actually
// bounds what a resend returns.
const KEYS_HISTORY_COUNT = 1000;

// N-B anti-stampede (§7.10): rank × this = how long an answerer waits before
// checking whether someone with a lower rank already covered the request.
const RANK_STEP_MS = 2000;
// Rank domain cap: with member counts beyond this the tail ranks add latency
// without adding meaningful redundancy.
const RANK_MAX = 8;

// Stored-request answering, requests WITHOUT a static pubkey only: the
// requester holds the ephemeral pair in memory, so a wrap for a long-gone
// request is dead bytes. Requests that carry `spk` have no window — the v2
// wrap opens with the account key in any later session, so any retained
// uncovered request is worth answering.
const REQUEST_ANSWER_WINDOW_MS = 10 * 60 * 1000;

// Observed-wrap suppression memory (requestId → Set(keyId)), bounded.
const SEEN_WRAPS_MAX = 100;

// Persisted pending-request ids (wrap v2). Bounded: a wrap for a request this
// old answers a question nobody is asking any more, and the ids sync across
// devices, so the set must stay small.
const PENDING_REQUEST_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_REQUESTS_MAX = 8;

// Roster (-4/P1) read cache: the members panel refreshes freely; the resend
// behind it should not.
const ROSTER_CACHE_TTL_MS = 60 * 1000;
const ROSTER_HISTORY_COUNT = 500;

// N-D (§7.12): gated channels rotate on a cadence — selling the asset or a
// lapsed subscription only cuts reads at the NEXT rotation, so without a
// schedule the cut never lands. Weekly for every gate mode.
const ROTATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// Failed or not-yet-due scheduled rotations re-check on this fallback.
const ROTATION_RETRY_MS = 60 * 60 * 1000;
/** Wraps held for an announce that has not arrived; memory only. */
const PARKED_WRAPS_PER_EPOCH = 4;
const PARKED_EPOCHS = 8;

class EpochKeyManager {
    constructor() {
        // messageStreamId → channel key state
        this.state = new Map();
        // messageStreamId → Set<callback(kid)> fired when a key is adopted
        this.listeners = new Map();
    }

    // ==================== STATE ====================

    _getState(messageStreamId) {
        let s = this.state.get(messageStreamId);
        if (!s) {
            s = {
                // keyId → { keyHex, keyHash, epoch, cryptoKey: Promise<CryptoKey>|null }
                epochs: new Map(),
                // epoch → { keyId, keyHash, validFrom, publisher, timestamp }
                announces: new Map(),
                // epoch → NEWEST valid announce timestamp seen. The conflict
                // rule (D13) deliberately keeps the OLDEST announce, so the
                // TTL re-announce check cannot read s.announces — it would
                // republish on every open. This map tracks freshness instead.
                announceFreshness: new Map(),
                currentEpoch: 0,
                // { requestId, privateKey, publicKey, fromEpoch, sentAt } — memory only (D12)
                pendingRequest: null,
                // requestId → { fromEpoch, sentAt } — PERSISTED. Holds no key
                // material (D12 intact by construction): a v2 wrap for any of
                // these ids opens with the account's static key, in any
                // session of any device.
                pendingRequests: new Map(),
                // Epochs we already published a MEMBER_HELLO for — persisted,
                // so reopening the channel does not re-hello.
                helloEpochs: new Set(),
                // Last hello this device published: the name it carried and
                // its timestamp, which the next one chains as `prev`.
                helloName: null,
                helloTs: 0,
                // -4 partition probe: null = unknown, 0 = no roster partition,
                // 1 = the stream was created with P1
                rosterPartition: null,
                // { at, members } — getRosterMembers result cache
                rosterCache: null,
                // Members-only mode: the channel's SHARED publish key.
                // { keyId, keyHex, address, rev } — persisted + synced (it is
                // channel key material, like the epoch keys). Never rotates
                // by routine; a re-key bumps rev.
                pubKey: null,
                // Latest pub_announce accepted: { keyId, keyHash, address,
                // rev, publisher, timestamp } — the trust anchor pub wraps
                // are verified against. Persisted (public data, warm start).
                pubAnnounce: null,
                // Newest pub_announce timestamp seen in storage — drives the
                // TTL re-announce, exactly like announceFreshness.
                pubAnnounceFreshness: 0,
                // Session pseudonym for our own publishes in this channel:
                // { privateKey, publicKey, bindProof } — MEMORY ONLY. Members
                // resolve the account from the bind proof, so a fresh
                // pseudonym per session costs nothing.
                pseudonym: null,
                // Consecutive unanswered requests — drives the retry backoff
                requestAttempts: 0,
                // requestId → Set(keyId) of wraps OBSERVED (live or history) —
                // the N-B suppression signal: stay silent for covered epochs
                seenWraps: new Map(),
                // Addresses seen authoring a KEY_REQUEST (live or -4 history).
                // Every reader of a gated channel must request keys, so this
                // enumerates members for TOKEN/NFT/PAID gates where holding
                // or pay() bypasses the owner — no indexer, no event scan.
                seenRequesters: new Set(),
                // epoch → wraps that arrived before the announce that
                // legitimises them. A responder answers a request as soon as
                // it hears it, so on a cold subscribe the wrap regularly
                // overtakes the announce; dropping it cost a 35s stall.
                parkedWraps: new Map(),
                loaded: false
            };
            this.state.set(messageStreamId, s);
        }
        return s;
    }

    _loadPersisted(messageStreamId, s) {
        const persisted = secureStorage.getEpochKeys(messageStreamId);
        if (!persisted) return;
        for (const [keyId, entry] of Object.entries(persisted.epochs || {})) {
            if (!s.epochs.has(keyId)) {
                s.epochs.set(keyId, { ...entry, cryptoKey: null });
            }
        }
        // Announces persist too (public data): with them AND the keys a
        // restarted session encrypts/decrypts IMMEDIATELY — the -4 resend
        // becomes a background reconcile instead of the open's critical path.
        for (const [epochStr, ann] of Object.entries(persisted.announces || {})) {
            const epoch = parseInt(epochStr, 10);
            if (Number.isInteger(epoch) && !s.announces.has(epoch)) {
                s.announces.set(epoch, ann);
            }
        }
        if (typeof persisted.currentEpoch === 'number' && persisted.currentEpoch > s.currentEpoch) {
            s.currentEpoch = persisted.currentEpoch;
        }
        const maxAnnounced = Math.max(0, ...s.announces.keys());
        if (maxAnnounced > s.currentEpoch) s.currentEpoch = maxAnnounced;
        const cutoff = Date.now() - PENDING_REQUEST_MAX_AGE_MS;
        for (const [requestId, entry] of Object.entries(persisted.pendingRequests || {})) {
            if ((entry?.sentAt || 0) < cutoff) continue;
            if (!s.pendingRequests.has(requestId)) {
                s.pendingRequests.set(requestId, { fromEpoch: entry.fromEpoch, sentAt: entry.sentAt });
            }
        }
        if (typeof persisted.helloName === 'string') s.helloName = persisted.helloName;
        if (Number.isFinite(persisted.helloTs)) s.helloTs = persisted.helloTs;
        for (const epoch of persisted.helloEpochs || []) {
            if (Number.isInteger(epoch)) s.helloEpochs.add(epoch);
        }
        // Requesters persist for the same reason the announces do: they are
        // the members panel's candidate pool, and a banned member stops
        // requesting, so a session that forgets them can never ask the gate
        // about them again.
        for (const addr of persisted.seenRequesters || []) {
            if (/^0x[0-9a-f]{40}$/.test(addr)) s.seenRequesters.add(addr);
        }
        // Higher rev wins — a persisted re-key must never regress to the
        // key it replaced.
        if (persisted.pubKey && (persisted.pubKey.rev || 0) > (s.pubKey?.rev || 0)) {
            s.pubKey = { ...persisted.pubKey };
        }
        if (persisted.pubAnnounce && (persisted.pubAnnounce.rev || 0) > (s.pubAnnounce?.rev || 0)) {
            s.pubAnnounce = { ...persisted.pubAnnounce };
        }
        if (persisted.intKey && (persisted.intKey.rev || 0) > (s.intKey?.rev || 0)) {
            s.intKey = { ...persisted.intKey };
        }
        if (persisted.intAnnounce && (persisted.intAnnounce.rev || 0) > (s.intAnnounce?.rev || 0)) {
            s.intAnnounce = { ...persisted.intAnnounce };
        }
    }

    async _persist(messageStreamId, s) {
        const epochs = {};
        for (const [keyId, entry] of s.epochs) {
            epochs[keyId] = { keyHex: entry.keyHex, keyHash: entry.keyHash, epoch: entry.epoch };
        }
        const announces = {};
        for (const [epoch, ann] of s.announces) {
            announces[epoch] = {
                keyId: ann.keyId, keyHash: ann.keyHash,
                publisher: ann.publisher, timestamp: ann.timestamp, validFrom: ann.validFrom
            };
        }
        const cutoff = Date.now() - PENDING_REQUEST_MAX_AGE_MS;
        const pendingRequests = {};
        for (const [requestId, entry] of s.pendingRequests) {
            if ((entry?.sentAt || 0) < cutoff) { s.pendingRequests.delete(requestId); continue; }
            pendingRequests[requestId] = { fromEpoch: entry.fromEpoch, sentAt: entry.sentAt };
        }
        await secureStorage.setEpochKeys(messageStreamId, {
            epochs, announces, currentEpoch: s.currentEpoch,
            pendingRequests, helloEpochs: Array.from(s.helloEpochs),
            helloName: s.helloName || null, helloTs: s.helloTs || 0,
            seenRequesters: Array.from(s.seenRequesters),
            ...(s.pubKey ? { pubKey: { ...s.pubKey } } : {}),
            ...(s.pubAnnounce ? {
                pubAnnounce: {
                    keyId: s.pubAnnounce.keyId, keyHash: s.pubAnnounce.keyHash,
                    address: s.pubAnnounce.address, rev: s.pubAnnounce.rev,
                    publisher: s.pubAnnounce.publisher, timestamp: s.pubAnnounce.timestamp
                }
            } : {}),
            ...(s.intKey ? { intKey: { ...s.intKey } } : {}),
            ...(s.intAnnounce ? {
                intAnnounce: {
                    keyId: s.intAnnounce.keyId, keyHash: s.intAnnounce.keyHash,
                    address: s.intAnnounce.address, rev: s.intAnnounce.rev,
                    publisher: s.intAnnounce.publisher, timestamp: s.intAnnounce.timestamp
                }
            } : {})
        });
    }

    /**
     * Load persisted state without any network work — the fast path a channel
     * open uses to decide whether the blocking ensure is needed at all.
     */
    loadPersistedState(messageStreamId) {
        const s = this._getState(messageStreamId);
        if (!s.loaded) {
            this._loadPersisted(messageStreamId, s);
            s.loaded = true;
        }
    }

    /**
     * Re-pull persisted keys into every already-hydrated in-memory state.
     * A sync pull can land keys for channels this session loaded before the
     * pull ran — loadPersistedState is once-per-channel, so without this the
     * synced keys only take effect after a restart. _loadPersisted unions
     * (never overwrites), so adopted keys are untouched.
     */
    refreshPersisted() {
        for (const [messageStreamId, s] of this.state) {
            if (s.loaded) this._loadPersisted(messageStreamId, s);
        }
    }

    /** Does the channel hold a usable current key right now? */
    hasCurrentKey(messageStreamId) {
        const s = this.state.get(messageStreamId);
        if (!s || s.currentEpoch === 0) return false;
        const announce = s.announces.get(s.currentEpoch);
        return !!(announce && s.epochs.has(announce.keyId));
    }

    // ==================== SHARED PUBLISH KEY (Members-only) ====================

    /**
     * Fresh publish keypair for a new Members-only channel. Its ADDRESS gets
     * the PUBLISH grants in the creation batch; the private half is
     * distributed to members via PUB_WRAPs on -4.
     */
    mintPublishKey(rev = 1) {
        const keyHex = dmCrypto.generateEphemeralPrivateKey();
        const address = ethers.computeAddress(new ethers.SigningKey(keyHex).publicKey).toLowerCase();
        return { keyId: `p${rev}.${cryptoManager.generateRandomHex(6)}`, keyHex, address, rev };
    }

    /**
     * Fresh interactions keypair (Sealed channels). Same mechanics as the
     * publish key, different POLICY: it goes to every member with access,
     * read-only included — reactions and presence are theirs even where
     * messages are not.
     */
    mintInteractionsKey(rev = 1) {
        const keyHex = dmCrypto.generateEphemeralPrivateKey();
        const address = ethers.computeAddress(new ethers.SigningKey(keyHex).publicKey).toLowerCase();
        return { keyId: `i${rev}.${cryptoManager.generateRandomHex(6)}`, keyHex, address, rev };
    }

    /** Creation-time adopt of a freshly minted interactions key. */
    async adoptInteractionsKey(channel, intKey) {
        const s = this._getState(channel.messageStreamId);
        if (!s.loaded) {
            this._loadPersisted(channel.messageStreamId, s);
            s.loaded = true;
        }
        s.intKey = { ...intKey };
        await this._persist(channel.messageStreamId, s);
    }

    /** The held interactions key ({keyId, keyHex, address, rev}) or null. */
    getInteractionsKey(messageStreamId) {
        return this.state.get(messageStreamId)?.intKey || null;
    }

    /** Creation-time adopt of a freshly minted publish key (admin device). */
    async adoptPublishKey(channel, pubKey) {
        const s = this._getState(channel.messageStreamId);
        if (!s.loaded) {
            this._loadPersisted(channel.messageStreamId, s);
            s.loaded = true;
        }
        s.pubKey = { ...pubKey };
        await this._persist(channel.messageStreamId, s);
    }

    /** The held publish key ({keyId, keyHex, address, rev}) or null. */
    getPublishKey(messageStreamId) {
        return this.state.get(messageStreamId)?.pubKey || null;
    }

    /**
     * getPublishKey with ONE recovery attempt, mirroring the epoch-key
     * recovery in the publish funnels. A member can hold the epoch key
     * (reads decrypt fine) while the PUB_WRAP never arrived — a state the
     * epoch-gated recovery never enters, so without this nothing would ever
     * request the missing publish key and the channel would stay unwritable.
     * The wrap arrives asynchronously: the caller may still come up empty
     * this time, but the request is now in flight for the next attempt.
     */
    async ensurePublishKey(channel) {
        let pubKey = this.getPublishKey(channel.messageStreamId);
        if (!pubKey) {
            await this.ensureChannelKeys(channel);
            pubKey = this.getPublishKey(channel.messageStreamId);
        }
        return pubKey;
    }

    /**
     * The admin escape valve (Members-only): replace the shared publish key
     * when ex-key-holders abuse it. Exceptional, never routine — rotation
     * stays zero-tx. The new key announces at rev+1, which supersedes
     * everywhere (state, persistence, sync); the old address loses its
     * grants on-chain, and members pick up the replacement through the
     * normal request cycle.
     * @returns {Promise<number>} the new rev
     */
    async rekeyPublishKey(channel) {
        if (!usesSharedPublish(channel)) {
            throw new Error('rekeyPublishKey: not a Members-only channel');
        }
        if (!this.isOwnAdmin(channel)) {
            throw new Error('rekeyPublishKey: only the channel admin can re-key');
        }
        const s = this._getState(channel.messageStreamId);
        if (!s.loaded) {
            this._loadPersisted(channel.messageStreamId, s);
            s.loaded = true;
        }
        const oldAddress = s.pubKey?.address || s.pubAnnounce?.address || null;
        const rev = Math.max(s.pubKey?.rev || 0, s.pubAnnounce?.rev || 0) + 1;
        const pubKey = this.mintPublishKey(rev);

        // Chain first: a published announce for a key the network rejects
        // would strand every member on an unusable key.
        await streamrController.rekeySharedPublishGrants(channel, pubKey.address, oldAddress);

        s.pubKey = { ...pubKey };
        const announce = {
            t: KEYS_MSG_TYPE.PUB_ANNOUNCE,
            keyId: pubKey.keyId,
            keyHash: await epochKeyCrypto.computeKeyHash(pubKey.keyHex),
            addr: pubKey.address,
            rev
        };
        await streamrController.publishKeysMessage(channel.keysStreamId, announce);
        this._applyPubAnnounce(channel, s, announce, authManager.getAddress(), Date.now());
        s.pubAnnounceFreshness = Date.now();
        await this._persist(channel.messageStreamId, s);
        Logger.info(`epochKeys: publish key re-keyed to rev ${rev} on`, channel.keysStreamId.slice(-30));
        // Members cannot write until this announce is readable from storage —
        // verify retention exactly like a fresh epoch announce.
        this._ensureAnnounceRetained(channel, announce).catch(() => {});
        return rev;
    }

    /**
     * Session authorship material for our own publishes in a Members-only
     * channel: pseudonym keypair + account bind proof, minted lazily once
     * per session per channel. Memory only — members resolve the ACCOUNT
     * from the bind proof, so pseudonym churn across sessions is invisible.
     * @returns {{privateKey, publicKey, bindProof}|null} null without a wallet
     */
    getAuthorship(channel) {
        const s = this._getState(channel.messageStreamId);
        if (s.pseudonym) return s.pseudonym;
        const accountKey = authManager.wallet?.privateKey;
        if (!accountKey) return null;
        const pseudonym = authorship.generatePseudonym();
        const bindProof = authorship.createBindProof(
            channel.messageStreamId, pseudonym.publicKey, accountKey);
        s.pseudonym = { ...pseudonym, bindProof };
        return s.pseudonym;
    }

    /**
     * Register a callback fired whenever a key is adopted for a channel —
     * the hook the receive path uses to retro-decrypt "waiting for key"
     * messages (Passo 5).
     */
    onKeyAdopted(messageStreamId, callback) {
        if (!this.listeners.has(messageStreamId)) {
            this.listeners.set(messageStreamId, new Set());
        }
        this.listeners.get(messageStreamId).add(callback);
    }

    _notifyAdopted(messageStreamId, keyId) {
        const subs = this.listeners.get(messageStreamId);
        if (!subs) return;
        for (const cb of subs) {
            try { cb(keyId); } catch (e) { Logger.warn('epoch key listener error:', e.message); }
        }
    }

    /**
     * Drop a channel's runtime and persisted key state (on leave/delete).
     */
    async forgetChannel(messageStreamId) {
        const s = this.state.get(messageStreamId);
        if (s?.rotationTimer) clearTimeout(s.rotationTimer);
        this.state.delete(messageStreamId);
        this.listeners.delete(messageStreamId);
        await secureStorage.clearEpochKeys(messageStreamId);
    }

    /** Clear runtime state (logout). Persisted keys stay encrypted at rest. */
    clear() {
        for (const s of this.state.values()) {
            if (s.rotationTimer) clearTimeout(s.rotationTimer);
        }
        this.state.clear();
        this.listeners.clear();
    }

    // ==================== ADMIN SET (D13) ====================

    /**
     * v1 admin set: the stream's namespace address, and nothing else.
     * `createdBy` can be empty AND arrives via invite payloads, which an
     * inviter controls — the namespace is the only claim bound on-chain
     * (nobody else can create streams under that address).
     * Multi-admin later = widening this set; the message format is untouched.
     */
    _adminSet(channel) {
        const ns = (channel.messageStreamId?.split('/')[0] || '').toLowerCase();
        return ns.length === 42 ? new Set([ns]) : new Set();
    }

    _isAdmin(channel, address) {
        return !!address && this._adminSet(channel).has(address.toLowerCase());
    }

    /** Is the current account this channel's admin? */
    isOwnAdmin(channel) {
        return this._isAdmin(channel, authManager.getAddress());
    }

    // ==================== LIFECYCLE ====================

    /**
     * Bring a gated channel's key state up to date. Called on channel
     * open/subscribe. Pulls announces from -4 storage, bootstraps epoch 1 if
     * we are the admin of a virgin channel, or requests missing keys.
     * @param {Object} channel - Channel object (messageStreamId, keysStreamId, type)
     */
    async ensureChannelKeys(channel) {
        if (!usesEpochKeys(channel)) return;
        const s = this._getState(channel.messageStreamId);

        if (!s.loaded) {
            this._loadPersisted(channel.messageStreamId, s);
            s.loaded = true;
        }

        // Reconcile with -4 storage (announces are public; the storage node is
        // their system of record — persisted copies are a warm-start cache).
        // Two partitions, two cadences: P0 holds the announces, P1 the
        // requests and the wraps that answer them.
        const [announces, exchange] = await Promise.all([
            streamrController.resendKeysMessages(
                channel.keysStreamId,
                { last: KEYS_HISTORY_COUNT, partition: KEYS_STREAM.KEY_EXCHANGE }),
            streamrController.resendKeysMessages(
                channel.keysStreamId,
                { last: KEYS_HISTORY_COUNT, partition: KEYS_STREAM.REQUESTS })
        ]);
        const entries = [...announces, ...exchange];
        let changed = false;
        const storedRequests = [];
        const storedV2Wraps = [];
        const storedV2PubWraps = [];
        for (const { data, publisherId, timestamp } of entries) {
            if (data.t === KEYS_MSG_TYPE.KEY_ANNOUNCE) {
                if (this._applyAnnounce(channel, s, data, publisherId, timestamp)) changed = true;
            } else if (data.t === KEYS_MSG_TYPE.PUB_ANNOUNCE) {
                if (this._applyPubAnnounce(channel, s, data, publisherId, timestamp)) changed = true;
            } else if (data.t === KEYS_MSG_TYPE.PUB_WRAP) {
                if (typeof data.requestId === 'string' && typeof data.keyId === 'string') {
                    this._recordSeenWrap(s, data.requestId, data.keyId);
                    if (data.v === 2 && (s.pendingRequests.has(data.requestId)
                            || s.pendingRequest?.requestId === data.requestId)) {
                        storedV2PubWraps.push(data);
                    }
                }
            } else if (data.t === KEYS_MSG_TYPE.KEY_WRAP) {
                // Coverage bookkeeping: a stored wrap means someone already
                // answered — its epochs need no re-answering from us
                if (typeof data.requestId === 'string' && typeof data.keyId === 'string') {
                    this._recordSeenWrap(s, data.requestId, data.keyId);
                    // A retained v2 wrap for one of OUR requests opens with the
                    // account key even though the requesting session is gone —
                    // collected here, adopted after every announce is applied.
                    if (data.v === 2 && (s.pendingRequests.has(data.requestId)
                            || s.pendingRequest?.requestId === data.requestId)) {
                        storedV2Wraps.push(data);
                    }
                }
            } else if (data.t === KEYS_MSG_TYPE.KEY_REQUEST) {
                storedRequests.push({ data, publisherId, timestamp });
                this._recordRequester(s, publisherId, channel.messageStreamId);
            }
        }
        if (changed) await this._persist(channel.messageStreamId, s);
        for (const data of storedV2Wraps) {
            try {
                await this._handleWrapV2(channel, s, data);
            } catch (e) {
                Logger.warn('epochKeys: stored v2 wrap adoption failed:', e.message);
            }
        }
        for (const data of storedV2PubWraps) {
            try {
                await this._handlePubWrap(channel, s, data);
            } catch (e) {
                Logger.warn('epochKeys: stored pub wrap adoption failed:', e.message);
            }
        }

        // N-B: answer stored requests that no wrap covers yet — a member
        // arriving later serves whoever is still waiting, so requester and
        // key-holder no longer have to coincide in time. Requests carrying a
        // static pubkey have no age limit (the v2 wrap opens in any later
        // session); without one, only recent requests — the ephemeral pair
        // lives in memory only, so a wrap for an old request is dead bytes.
        if (s.epochs.size > 0) {
            const me = (authManager.getAddress() || '').toLowerCase();
            const now = Date.now();
            for (const { data, publisherId, timestamp } of storedRequests) {
                if (this._isOwnRequest(s, data.requestId)) continue;
                const hasStatic = typeof data.spk === 'string';
                if (!hasStatic && now - (timestamp || 0) > REQUEST_ANSWER_WINDOW_MS) continue;
                if (typeof data.pubkey !== 'string' || typeof data.requestId !== 'string') continue;
                const rank = await this._rankFor(data.requestId, (channel.members || []).length);
                this._scheduleAnswer(channel, {
                    requestId: data.requestId, pubkey: data.pubkey, fromEpoch: data.fromEpoch,
                    spk: data.spk, requester: publisherId
                }, rank * RANK_STEP_MS);
            }
        }

        if (s.announces.size === 0) {
            if (this.isOwnAdmin(channel)) {
                await this._bootstrapFirstEpoch(channel, s);
                this._armScheduledRotation(channel, s);
                await this._maybeAnnouncePub(channel, s);
                await this._maybeAnnounceInteractions(channel, s);
            } else {
                Logger.info('epochKeys: no announce yet on', channel.keysStreamId.slice(-30),
                    '— waiting for the admin');
            }
            return;
        }

        if (this.isOwnAdmin(channel)) {
            await this._maybeReannounceAging(channel, s);
            this._armScheduledRotation(channel, s);
            await this._maybeAnnouncePub(channel, s);
            await this._maybeAnnounceInteractions(channel, s);
        }

        if (this._missingEpochs(s).length > 0 || this._needsPubKey(channel, s)
                || this._needsInteractionsKey(channel, s)) {
            await this._sendKeyRequest(channel, s);
        }
    }

    /** A Members-only channel is not writable until the announced publish
     *  key (at its announced rev) is held. In a read-only channel a plain
     *  member never qualifies for that key, so once the role is known
     *  (channels.js reconciles it from the gate) they stop asking for a
     *  wrap nobody may answer. Unknown role keeps asking — harmless, the
     *  responders refuse. */
    _needsPubKey(channel, s) {
        if (channel?.readOnly && channel._selfMayPublishReadOnly === false) return false;
        return usesSharedPublish(channel) && !!s.pubAnnounce
            && s.pubKey?.keyId !== s.pubAnnounce.keyId;
    }

    /** The interactions key has no read-only exemption: every member with
     *  access holds it, which is what makes reactions and presence work in a
     *  channel where they cannot post. */
    _needsInteractionsKey(channel, s) {
        return usesSharedPublish(channel) && !!s.intAnnounce
            && s.intKey?.keyId !== s.intAnnounce.keyId;
    }

    /**
     * Admin-side self-heal for the publish-key anchor: announce the held key
     * whenever storage has no fresh copy — idempotent by construction (same
     * keyId/keyHash/addr/rev), exactly like the epoch re-announce.
     */
    async _maybeAnnounceInteractions(channel, s) {
        if (!usesSharedPublish(channel) || !s.intKey) return;
        if (s.intAnnounce && s.intAnnounce.rev > s.intKey.rev) return;
        const retentionMs = keysRetentionDays(channel) * 86_400_000;
        const freshest = s.intAnnounceFreshness || 0;
        if (freshest && Date.now() - freshest < retentionMs * CONFIG.storage.ttlRepublishAgeFraction) return;

        const announce = {
            t: KEYS_MSG_TYPE.PUB_ANNOUNCE,
            k: 'i',
            keyId: s.intKey.keyId,
            keyHash: await epochKeyCrypto.computeKeyHash(s.intKey.keyHex),
            addr: s.intKey.address,
            rev: s.intKey.rev
        };
        await streamrController.publishKeysMessage(channel.keysStreamId, announce);
        this._applyPubAnnounce(channel, s, announce, authManager.getAddress(), Date.now());
        s.intAnnounceFreshness = Date.now();
        await this._persist(channel.messageStreamId, s);
        Logger.info('epochKeys: interactions key announced on', channel.keysStreamId.slice(-30));
        this._ensureAnnounceRetained(channel, announce).catch(() => {});
    }

    async _maybeAnnouncePub(channel, s) {
        if (!usesSharedPublish(channel) || !s.pubKey) return;
        if (s.pubAnnounce && s.pubAnnounce.rev > s.pubKey.rev) return;   // we hold the superseded key
        const retentionMs = keysRetentionDays(channel) * 86_400_000;
        const freshest = s.pubAnnounceFreshness || 0;
        if (freshest && Date.now() - freshest < retentionMs * CONFIG.storage.ttlRepublishAgeFraction) return;

        const announce = {
            t: KEYS_MSG_TYPE.PUB_ANNOUNCE,
            keyId: s.pubKey.keyId,
            keyHash: await epochKeyCrypto.computeKeyHash(s.pubKey.keyHex),
            addr: s.pubKey.address,
            rev: s.pubKey.rev
        };
        await streamrController.publishKeysMessage(channel.keysStreamId, announce);
        this._applyPubAnnounce(channel, s, announce, authManager.getAddress(), Date.now());
        s.pubAnnounceFreshness = Date.now();
        await this._persist(channel.messageStreamId, s);
        Logger.info('epochKeys: publish key announced on', channel.keysStreamId.slice(-30));
        this._ensureAnnounceRetained(channel, announce).catch(() => {});
    }

    /**
     * TTL-aware re-announce (same pattern as the -3 artifacts' ttlRepublish):
     * the CURRENT epoch's announce ages out of storage retention if no
     * rotation happens for that long, and a joiner then has no keyHash anchor
     * even with every member online. Republish the SAME keyId/keyHash when
     * the freshest retained copy nears the TTL — idempotent by construction.
     */
    async _maybeReannounceAging(channel, s) {
        const announce = s.announces.get(s.currentEpoch);
        if (!announce) return;
        const entry = s.epochs.get(announce.keyId);
        if (!entry) return;                                  // no key held — nothing to anchor
        // freshest == 0: the announce exists only in OUR persisted state — the
        // storage lost it (or the resend failed; republishing then is a
        // harmless duplicate). Otherwise republish when nearing the TTL.
        const freshest = s.announceFreshness.get(s.currentEpoch) || 0;
        const retentionMs = keysRetentionDays(channel) * 86_400_000;
        if (freshest && Date.now() - freshest < retentionMs * CONFIG.storage.ttlRepublishAgeFraction) return;

        // CONSISTENT BY CONSTRUCTION across the admin's devices: this only
        // ever republishes the PERSISTED keyId/keyHash — two devices doing it
        // concurrently emit identical content. Minting happens nowhere here.
        const reannounce = {
            t: KEYS_MSG_TYPE.KEY_ANNOUNCE,
            epoch: s.currentEpoch,
            keyId: announce.keyId,
            keyHash: entry.keyHash,
            validFrom: Date.now()
        };
        await streamrController.publishKeysMessage(channel.keysStreamId, reannounce);
        s.announceFreshness.set(s.currentEpoch, Date.now());
        Logger.info(`epochKeys: re-announced epoch ${s.currentEpoch} (announce ${freshest ? 'nearing storage TTL' : 'missing from storage'}) on`,
            channel.keysStreamId.slice(-30));
        this._ensureAnnounceRetained(channel, reannounce).catch(() => {});
    }

    /**
     * Fire-and-forget retention loop for a just-published KEY_ANNOUNCE (same
     * pattern as the password challenge). A create-time publish can race the
     * storage node learning its -4 assignment, or leave a cold node before
     * any neighbour is connected (R2 publishes into an empty room) — either
     * way the announce is lost, a joiner never gets an anchor, and the
     * publishing session masks the missing-from-storage re-announce because
     * its own freshness entry looks recent. Verify by resend that the -4
     * actually returns the keyId; republish until it does.
     */
    async _ensureAnnounceRetained(channel, announce, { maxAttempts = 12, delayMs = 5000 } = {}) {
        const keysStreamId = channel.keysStreamId;
        if (!keysStreamId || !announce?.keyId) return;
        const tracked = (this._announceRetention ??= new Set());
        if (tracked.has(announce.keyId)) return;
        tracked.add(announce.keyId);
        try {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                await new Promise(r => setTimeout(r, delayMs));
                if (!this.state.has(channel.messageStreamId)) return;    // left/deleted
                try {
                    const entries = await streamrController.resendKeysMessages(keysStreamId,
                        { last: 100, partition: KEYS_STREAM.KEY_EXCHANGE });
                    const found = entries.some(({ data }) =>
                        data?.t === announce.t && data.keyId === announce.keyId);
                    if (found) {
                        Logger.info(`epochKeys: announce ${announce.keyId} retained on -4 (after ${attempt} cycle${attempt > 1 ? 's' : ''})`);
                        return;
                    }
                    await streamrController.publishKeysMessage(keysStreamId, announce);
                    Logger.debug(`epochKeys: announce ${announce.keyId} republished (retention attempt ${attempt}/${maxAttempts})`);
                } catch (e) {
                    Logger.debug(`epochKeys: announce retention cycle #${attempt} errored:`, e?.message);
                }
            }
            Logger.warn(`epochKeys: announce ${announce.keyId} STILL not retained after ${maxAttempts} attempts — the next channel open re-announces`);
        } finally {
            tracked.delete(announce.keyId);
        }
    }

    /**
     * Arm the weekly rotation timer (N-D, gated channels, admin-side). The
     * timer checks the CURRENT epoch's age on fire — a manual rotation (ban)
     * in between simply makes the check a no-op and the timer re-arm. If the
     * admin is offline past the due time, the epoch lives longer and the next
     * channel open rotates.
     */
    _armScheduledRotation(channel, s) {
        if (!channel.gate?.address || s.rotationTimer) return;
        const announce = s.announces.get(s.currentEpoch);
        if (!announce?.validFrom) return;
        const dueIn = Math.max(announce.validFrom + ROTATION_INTERVAL_MS - Date.now(), 0) + 1000;
        s.rotationTimer = setTimeout(async () => {
            s.rotationTimer = null;
            if (!this.state.has(channel.messageStreamId)) return;    // left/deleted
            try {
                const current = s.announces.get(s.currentEpoch);
                if (current?.validFrom
                        && Date.now() - current.validFrom >= ROTATION_INTERVAL_MS
                        && this.isOwnAdmin(channel)) {
                    await this.rotateEpoch(channel);
                }
                this._armScheduledRotation(channel, s);
            } catch (e) {
                Logger.warn('epochKeys: scheduled rotation failed (retrying later):', e.message);
                s.rotationTimer = setTimeout(() => {
                    s.rotationTimer = null;
                    this._armScheduledRotation(channel, s);
                }, ROTATION_RETRY_MS);
            }
        }, Math.min(dueIn, ROTATION_INTERVAL_MS));
    }

    /** Epoch numbers announced but not adopted. */
    _missingEpochs(s) {
        const adoptedEpochs = new Set([...s.epochs.values()].map(e => e.epoch));
        return [...s.announces.keys()].filter(epoch => !adoptedEpochs.has(epoch));
    }

    /**
     * Admin sees no announce in storage. Two cases:
     *
     *  - We hold persisted epoch keys → the announce was LOST (storage not yet
     *    attached at create time, or aged past retention). RE-ANNOUNCE the
     *    highest epoch we hold, same keyId/keyHash — idempotent self-heal, so
     *    existing ciphertext stays readable by everyone.
     *  - Virgin channel → create and announce epoch 1.
     */
    async _bootstrapFirstEpoch(channel, s) {
        if (s.epochs.size > 0) {
            let keyId = null, entry = null;
            for (const [id, e] of s.epochs) {
                if (!entry || e.epoch > entry.epoch) { keyId = id; entry = e; }
            }
            const announce = {
                t: KEYS_MSG_TYPE.KEY_ANNOUNCE,
                epoch: entry.epoch,
                keyId,
                keyHash: entry.keyHash,
                validFrom: Date.now()
            };
            await streamrController.publishKeysMessage(channel.keysStreamId, announce);
            this._applyAnnounce(channel, s, announce, authManager.getAddress(), announce.validFrom);
            Logger.info(`epochKeys: re-announced epoch ${entry.epoch} (announce was missing from storage) on`,
                channel.keysStreamId.slice(-30));
            this._ensureAnnounceRetained(channel, announce).catch(() => {});
            return;
        }

        // MINT GUARD (admin on two devices): a fresh admin device — no
        // persisted keys — on an ESTABLISHED channel must never mint a new
        // epoch 1: it would fork the channel. And it cannot recover from
        // member wraps either — without an announce there is no keyHash to
        // verify them against, and an admin re-announcing an unverified key
        // would launder it into the trust anchor. Virginity signal is
        // CREATION RECENCY: createdAt travels with the channel via sync, so
        // a second device inherits the original (old) date and refuses.
        const ageMs = Date.now() - (channel.createdAt || 0);
        if (!channel.createdAt || ageMs > 3_600_000) {
            Logger.warn('epochKeys: admin device holds NO epoch keys on an established channel',
                channel.messageStreamId.slice(-30),
                '— NOT minting (would fork the channel). Recover the keys on the original device.');
            return;
        }

        const keyHex = epochKeyCrypto.generateEpochKey();
        const keyHash = await epochKeyCrypto.computeKeyHash(keyHex);
        const keyId = `1.${cryptoManager.generateRandomHex(6)}`;
        const announce = {
            t: KEYS_MSG_TYPE.KEY_ANNOUNCE,
            epoch: 1,
            keyId,
            keyHash,
            validFrom: Date.now()
        };
        await streamrController.publishKeysMessage(channel.keysStreamId, announce);
        this._applyAnnounce(channel, s, announce, authManager.getAddress(), announce.validFrom);
        await this._adopt(channel, s, { keyId, keyHex, keyHash, epoch: 1 });
        Logger.info('epochKeys: bootstrapped epoch 1 on', channel.keysStreamId.slice(-30));
        this._ensureAnnounceRetained(channel, announce).catch(() => {});
    }

    /**
     * Admin action: rotate to a new epoch (e.g. after removing a member).
     * The new key applies to writes from now on; old epochs stay readable
     * for members (D14) and unreadable epochs stay ciphertext for ex-members.
     */
    async rotateEpoch(channel) {
        if (!usesEpochKeys(channel)) {
            throw new Error('rotateEpoch: channel has no epoch-key protocol');
        }
        if (!this.isOwnAdmin(channel)) {
            throw new Error('rotateEpoch: only the channel admin can announce a new epoch');
        }
        const s = this._getState(channel.messageStreamId);
        const epoch = Math.max(s.currentEpoch, ...[...s.announces.keys(), 0]) + 1;

        const keyHex = epochKeyCrypto.generateEpochKey();
        const keyHash = await epochKeyCrypto.computeKeyHash(keyHex);
        const keyId = `${epoch}.${cryptoManager.generateRandomHex(6)}`;
        const announce = {
            t: KEYS_MSG_TYPE.KEY_ANNOUNCE,
            epoch,
            keyId,
            keyHash,
            validFrom: Date.now()
        };
        await streamrController.publishKeysMessage(channel.keysStreamId, announce);
        this._applyAnnounce(channel, s, announce, authManager.getAddress(), announce.validFrom);
        await this._adopt(channel, s, { keyId, keyHex, keyHash, epoch });
        Logger.info(`epochKeys: rotated to epoch ${epoch} on`, channel.keysStreamId.slice(-30));
        this._ensureAnnounceRetained(channel, announce).catch(() => {});
        return epoch;
    }

    // ==================== PROTOCOL HANDLERS ====================

    /**
     * Ingest for -4 messages (live subscription).
     * @param {Object} channel
     * @param {Object} data - Parsed protocol message
     * @param {string} publisherId - Authenticated author: the recovered
     *   envelope signer (the clone publishes for everyone; streamr.js
     *   resolveAuthor swaps it in before this handler runs)
     * @param {number} timestamp - Transport timestamp
     */
    async handleKeysMessage(channel, data, publisherId, timestamp) {
        if (!data || typeof data.t !== 'string') return;
        const s = this._getState(channel.messageStreamId);

        switch (data.t) {
            case KEYS_MSG_TYPE.KEY_ANNOUNCE:
                await this._handleAnnounce(channel, s, data, publisherId, timestamp);
                break;
            case KEYS_MSG_TYPE.KEY_REQUEST:
                await this._handleRequest(channel, s, data, publisherId);
                break;
            case KEYS_MSG_TYPE.KEY_WRAP:
                await this._handleWrap(channel, s, data);
                break;
            case KEYS_MSG_TYPE.PUB_ANNOUNCE:
                if (this._applyPubAnnounce(channel, s, data, publisherId, timestamp)) {
                    await this._persist(channel.messageStreamId, s);
                    if (this._needsPubKey(channel, s)) {
                        await this._sendKeyRequest(channel, s);
                    }
                }
                break;
            case KEYS_MSG_TYPE.PUB_WRAP:
                await this._handlePubWrap(channel, s, data);
                break;
            default:
                Logger.debug('epochKeys: unknown message type', data.t);
        }
    }

    /**
     * Validate and apply a publish-key announce (Members-only channels).
     * Higher rev wins — a re-key is the admin's escape valve against
     * ex-key-holder abuse and must supersede everywhere; within the same rev
     * the epoch-announce conflict rule applies.
     */
    _applyPubAnnounce(channel, s, data, publisherId, timestamp) {
        if (!this._isAdmin(channel, publisherId)) {
            Logger.warn('epochKeys: PUB_ANNOUNCE from non-admin REJECTED:',
                publisherId, 'on', channel.messageStreamId.slice(-30));
            return false;
        }
        const rev = data.rev;
        if (!Number.isInteger(rev) || rev < 1) return false;
        if (typeof data.keyId !== 'string' || typeof data.keyHash !== 'string'
            || typeof data.addr !== 'string') return false;

        // Freshness follows the HIGHEST rev seen, never the stream: a retained
        // copy of a superseded announce must not mask a re-key announce that
        // storage lost, or no session would ever republish it and members
        // would stay unable to write until retention aged the old copy out.
        // Two shared keys travel on the same announce type, told apart by
        // `k`: content ('p', the default) and interactions ('i'). Same
        // mechanics, different distribution — see _answerRequest.
        const isInteractions = data.k === 'i';
        const slot = isInteractions ? 'intAnnounce' : 'pubAnnounce';
        const freshSlot = isInteractions ? 'intAnnounceFreshness' : 'pubAnnounceFreshness';
        const keySlot = isInteractions ? 'intKey' : 'pubKey';

        if (rev > (s[slot]?.rev ?? 0)) {
            s[freshSlot] = timestamp || 0;
        } else if (rev === (s[slot]?.rev ?? 0)
                && (timestamp || 0) > (s[freshSlot] || 0)) {
            s[freshSlot] = timestamp || 0;
        }

        const incoming = {
            keyId: data.keyId,
            keyHash: data.keyHash.toLowerCase(),
            address: data.addr.toLowerCase(),
            rev,
            publisher: (publisherId || '').toLowerCase(),
            timestamp: timestamp ?? 0
        };
        const existing = s[slot];
        if (existing) {
            if (existing.rev > rev) return false;
            if (existing.rev === rev) {
                const keep = existing.timestamp < incoming.timestamp
                    || (existing.timestamp === incoming.timestamp
                        && existing.publisher <= incoming.publisher);
                if (keep) return false;
            }
        }
        s[slot] = incoming;
        // A held key of an older keyId is superseded — stop publishing under
        // it and let the request cycle fetch the new one.
        if (s[keySlot] && s[keySlot].keyId !== incoming.keyId && (s[keySlot].rev || 0) < rev) {
            s[keySlot] = null;
        }
        return true;
    }

    /**
     * A publish-key wrap: same addressing as a KEY_WRAP (v1 ephemeral / v2
     * static), verified against the PUB_ANNOUNCE keyHash AND against the
     * announced address — the unwrapped secret must BE the announced
     * publisher key, or a malicious wrapper could hand us a key whose
     * messages the network would reject.
     */
    async _handlePubWrap(channel, s, data) {
        if (typeof data.requestId === 'string' && typeof data.keyId === 'string') {
            this._recordSeenWrap(s, data.requestId, data.keyId);
        }
        // Route by which announce claims this keyId — the wrap carries the
        // same `k` marker the announce did.
        const isInteractions = data.k === 'i';
        const announce = isInteractions ? s.intAnnounce : s.pubAnnounce;
        const keySlot = isInteractions ? 'intKey' : 'pubKey';
        if (!announce || data.keyId !== announce.keyId) return;
        if (s[keySlot]?.keyId === data.keyId) return;                     // already held
        if (typeof data.tag !== 'string') return;

        let keyHex;
        if (data.v === 2) {
            const mine = s.pendingRequests.has(data.requestId)
                || s.pendingRequest?.requestId === data.requestId;
            if (!mine) return;
            const expectedTag = await epochKeyCrypto.computeWrapTagV2(data.requestId, data.keyId);
            if (data.tag.toLowerCase() !== expectedTag.toLowerCase()) return;
            const accountKey = authManager.wallet?.privateKey;
            if (!accountKey) return;
            try {
                keyHex = await epochKeyCrypto.unwrapEpochKeyStatic(
                    { epk: data.epk, iv: data.iv, ct: data.ct }, accountKey);
            } catch (e) {
                Logger.warn('epochKeys: pub wrap failed to open:', e.message);
                return;
            }
        } else {
            const pending = s.pendingRequest;
            if (!pending || data.requestId !== pending.requestId) return;
            const expectedTag = await epochKeyCrypto.computeWrapTag(pending.publicKey, data.keyId);
            if (data.tag.toLowerCase() !== expectedTag.toLowerCase()) return;
            try {
                keyHex = await epochKeyCrypto.unwrapEpochKey(
                    { epk: data.epk, iv: data.iv, ct: data.ct }, pending.privateKey);
            } catch (e) {
                Logger.warn('epochKeys: pub wrap failed to open:', e.message);
                return;
            }
        }

        const keyHash = await epochKeyCrypto.computeKeyHash(keyHex);
        if (keyHash.toLowerCase() !== announce.keyHash) {
            Logger.warn('epochKeys: pub wrap REJECTED — keyHash mismatch');
            return;
        }
        let derived;
        try {
            derived = ethers.computeAddress(new ethers.SigningKey(keyHex).publicKey).toLowerCase();
        } catch {
            return;
        }
        if (derived !== announce.address) {
            Logger.warn('epochKeys: pub wrap REJECTED — key does not match the announced address');
            return;
        }

        s[keySlot] = { keyId: data.keyId, keyHex, address: announce.address, rev: announce.rev };
        await this._persist(channel.messageStreamId, s);
        this._notifyAdopted(channel.messageStreamId, data.keyId);
        Logger.info(`epochKeys: adopted the ${isInteractions ? 'interactions' : 'publish'} key on`,
            channel.messageStreamId.slice(-30));
    }

    /** Bounded: unverifiable material from strangers must not grow without end. */
    _parkWrap(s, data) {
        const epoch = Number(data?.epoch) || 0;
        if (epoch < 1) return;
        const forEpoch = s.parkedWraps.get(epoch) || [];
        if (forEpoch.length >= PARKED_WRAPS_PER_EPOCH) return;
        forEpoch.push(data);
        s.parkedWraps.set(epoch, forEpoch);
        while (s.parkedWraps.size > PARKED_EPOCHS) {
            s.parkedWraps.delete(s.parkedWraps.keys().next().value);
        }
    }

    async _handleAnnounce(channel, s, data, publisherId, timestamp) {
        const changed = this._applyAnnounce(channel, s, data, publisherId, timestamp);
        if (!changed) return;
        // The announce these were waiting for: replay before asking for what
        // we may already hold.
        const waiting = s.parkedWraps.get(Number(data?.epoch) || 0) || [];
        s.parkedWraps.delete(Number(data?.epoch) || 0);
        for (const wrap of waiting) await this._handleWrap(channel, s, wrap);
        // Pull model: a live announce for an epoch we lack triggers a request
        // (unless we just announced it ourselves and already hold the key).
        if (this._missingEpochs(s).length > 0) {
            await this._sendKeyRequest(channel, s);
        }
    }

    /**
     * Validate and apply an announce. Returns true if state changed.
     * D13 conflict rule lives here.
     */
    _applyAnnounce(channel, s, data, publisherId, timestamp) {
        if (!this._isAdmin(channel, publisherId)) {
            Logger.warn('epochKeys: KEY_ANNOUNCE from non-admin REJECTED:',
                publisherId, 'on', channel.messageStreamId.slice(-30));
            return false;
        }
        const epoch = data.epoch;
        if (!Number.isInteger(epoch) || epoch < 1) return false;
        if (typeof data.keyId !== 'string' || typeof data.keyHash !== 'string') return false;

        // Freshness bookkeeping for the TTL re-announce — tracks the NEWEST
        // valid copy even when the conflict rule below keeps an older one
        if ((timestamp || 0) > (s.announceFreshness.get(epoch) || 0)) {
            s.announceFreshness.set(epoch, timestamp || 0);
        }

        const incoming = {
            keyId: data.keyId,
            keyHash: data.keyHash.toLowerCase(),
            validFrom: data.validFrom ?? timestamp,
            publisher: (publisherId || '').toLowerCase(),
            timestamp: timestamp ?? 0
        };

        const existing = s.announces.get(epoch);
        if (existing) {
            // Same epoch: older timestamp wins; tie → lower publisher address
            const keep =
                existing.timestamp < incoming.timestamp
                || (existing.timestamp === incoming.timestamp
                    && existing.publisher <= incoming.publisher);
            if (keep) return false;
        }
        s.announces.set(epoch, incoming);
        if (epoch > s.currentEpoch) {
            s.currentEpoch = epoch;
        }
        return true;
    }

    /**
     * A live KEY_REQUEST: schedule an answer behind the anti-stampede rank
     * (§7.10). The clone's permission is everyone's, so the CURRENT gate is
     * checked against the requester (envelope signer) just before wrapping.
     */
    /** A request this session sent: answering it would be talking to itself. */
    _isOwnRequest(s, requestId) {
        if (typeof requestId !== 'string' || !requestId) return false;
        return s.pendingRequests?.has(requestId) === true
            || s.pendingRequest?.requestId === requestId;
    }

    async _handleRequest(channel, s, data, publisherId) {
        this._recordRequester(s, publisherId, channel.messageStreamId);
        // Skip only what THIS session asked for, by requestId. Skipping
        // every request from our own account left a second device of the
        // same account unable to ever get the keys: nobody else answers a
        // request that names an address they can see is not theirs.
        if (this._isOwnRequest(s, data.requestId)) return;
        if (typeof data.pubkey !== 'string' || typeof data.requestId !== 'string') return;
        if (s.epochs.size === 0) return;                                  // nothing to offer

        const rank = await this._rankFor(data.requestId, (channel.members || []).length);
        this._scheduleAnswer(channel, {
            requestId: data.requestId, pubkey: data.pubkey, fromEpoch: data.fromEpoch,
            spk: data.spk, requester: publisherId
        }, rank * RANK_STEP_MS);
    }

    /**
     * Anti-stampede rank (§7.10): hash(identity ‖ requestId) mod N orders the
     * members deterministically WITHOUT coordination — everyone computes their
     * own place in the queue from public data. Rank 0 answers immediately;
     * each higher rank waits one step and stays silent for covered epochs.
     */
    async _rankFor(requestId, memberCount) {
        const n = Math.max(1, Math.min(RANK_MAX, memberCount || 4));
        const me = (authManager.getAddress() || '').toLowerCase();
        const digest = new Uint8Array(await crypto.subtle.digest(
            'SHA-256', new TextEncoder().encode(`${me}|${requestId}`)));
        return digest[0] % n;
    }

    /** Fire-and-forget: NEVER delay inline — the -4 subscription callback must
     *  keep flowing, or the wraps whose arrival should silence us would queue
     *  up BEHIND our own wait. */
    _scheduleAnswer(channel, request, delayMs) {
        setTimeout(() => {
            this._answerRequest(channel, request).catch(e =>
                Logger.warn('epochKeys: scheduled answer failed:', e.message));
        }, delayMs);
    }

    /**
     * Answer with wraps for every epoch we hold that the requester asked
     * for, regardless of gate mode, MINUS the epochs an observed wrap
     * already covers — the suppression that turns thirty identical
     * envelopes into one.
     */
    async _answerRequest(channel, request) {
        const s = this.state.get(channel.messageStreamId);
        if (!s || s.epochs.size === 0) return;
        // No gate (repair pending) means no access check is possible — never
        // hand out keys on an unverifiable request.
        if (!channel.gate?.address) return;

        // The write-cut for ex-members lives HERE (N-C). The requester
        // authenticated as an author (sticky isValidSignature), but the epoch
        // key only goes to whoever passes the CURRENT gate — one cached
        // eth_call. Fail-closed inside checkAccess: RPC trouble means no wrap
        // from us; the requester's retry finds a healthier responder.
        if (!request.requester) return;
        const ok = await gateManager.checkAccess(channel.gate.address, request.requester);
        if (!ok) {
            Logger.info('epochKeys: KEY_REQUEST from', request.requester,
                'refused by gate', channel.gate.address.slice(0, 10));
            return;
        }

        // Every gate mode receives all retained epochs — holding access is
        // the condition, a paid subscription included. The gate read is a
        // readability probe (its result is unused): an unreadable gate fails
        // closed to the current epoch — missing old epochs get re-requested
        // once the RPC heals, leaked ones cannot be taken back.
        let currentEpochOnly = false;
        try {
            await gateManager.getGateInfo(channel.gate.address);
        } catch (e) {
            // debug, not warn: this fires on every answered request of a
            // dead pre-v3 channel and would flood the console
            Logger.debug('epochKeys: gate unreadable, answering current epoch only:', e.message);
            currentEpochOnly = true;
        }

        // Static pubkey (wrap v2): usable only when it provably belongs to
        // the requester — the request's envelope signature anchors the
        // account, and computeAddress(spk) must land on that same account.
        // Anything else is a forgery (wraps would open for whoever planted
        // the key) and downgrades the answer to v1.
        let staticKey = null;
        if (typeof request.spk === 'string') {
            try {
                if (ethers.computeAddress(request.spk).toLowerCase()
                        === (request.requester || '').toLowerCase()) {
                    staticKey = request.spk;
                } else {
                    Logger.warn('epochKeys: KEY_REQUEST spk does not match the requester — answering v1');
                }
            } catch { /* malformed pubkey — answer v1 */ }
        }

        const covered = s.seenWraps.get(request.requestId) || new Set();
        const fromEpoch = Number.isInteger(request.fromEpoch) ? request.fromEpoch : 1;

        let sent = 0;
        for (const [keyId, entry] of s.epochs) {
            if (entry.epoch < fromEpoch || covered.has(keyId)) continue;
            if (currentEpochOnly && entry.epoch !== s.currentEpoch) continue;
            try {
                const envelope = staticKey
                    ? {
                        t: KEYS_MSG_TYPE.KEY_WRAP,
                        v: 2,
                        requestId: request.requestId,
                        keyId,
                        epoch: entry.epoch,
                        tag: await epochKeyCrypto.computeWrapTagV2(request.requestId, keyId),
                        ...await epochKeyCrypto.wrapEpochKeyToStatic(entry.keyHex, staticKey)
                    }
                    : {
                        t: KEYS_MSG_TYPE.KEY_WRAP,
                        requestId: request.requestId,
                        keyId,
                        epoch: entry.epoch,
                        tag: await epochKeyCrypto.computeWrapTag(request.pubkey, keyId),
                        ...await epochKeyCrypto.wrapEpochKey(entry.keyHex, request.pubkey)
                    };
                await streamrController.publishKeysMessage(channel.keysStreamId, envelope);
                this._recordSeenWrap(s, request.requestId, keyId);
                sent += 1;
            } catch (e) {
                Logger.warn(`epochKeys: failed to wrap ${keyId} for request ${request.requestId}:`, e.message);
            }
        }

        // Members-only: the shared publish key rides along with the epochs —
        // a joiner needs both before the channel is writable for them. In a
        // read-only channel that key IS the write capability, so it only goes
        // to the owner and the moderators; everyone else reads with the epoch
        // keys alone. An unreadable gate fails closed for the capability.
        let mayHoldPublishKey = true;
        if (usesSharedPublish(channel)) {
            try {
                const info = await gateManager.getGateInfo(channel.gate.address);
                if (info.readOnly) {
                    mayHoldPublishKey = await gateManager.canModerate(
                        channel.gate.address, request.requester);
                }
            } catch (e) {
                Logger.debug('epochKeys: gate unreadable for the publish-key check — withholding it:', e.message);
                mayHoldPublishKey = false;
            }
        }
        if (mayHoldPublishKey && usesSharedPublish(channel) && s.pubKey
                && s.pubAnnounce?.keyId === s.pubKey.keyId
                && !covered.has(s.pubKey.keyId)) {
            try {
                const envelope = staticKey
                    ? {
                        t: KEYS_MSG_TYPE.PUB_WRAP,
                        v: 2,
                        requestId: request.requestId,
                        keyId: s.pubKey.keyId,
                        tag: await epochKeyCrypto.computeWrapTagV2(request.requestId, s.pubKey.keyId),
                        ...await epochKeyCrypto.wrapEpochKeyToStatic(s.pubKey.keyHex, staticKey)
                    }
                    : {
                        t: KEYS_MSG_TYPE.PUB_WRAP,
                        requestId: request.requestId,
                        keyId: s.pubKey.keyId,
                        tag: await epochKeyCrypto.computeWrapTag(request.pubkey, s.pubKey.keyId),
                        ...await epochKeyCrypto.wrapEpochKey(s.pubKey.keyHex, request.pubkey)
                    };
                await streamrController.publishKeysMessage(channel.keysStreamId, envelope);
                this._recordSeenWrap(s, request.requestId, s.pubKey.keyId);
                sent += 1;
            } catch (e) {
                Logger.warn(`epochKeys: failed to wrap the publish key for request ${request.requestId}:`, e.message);
            }
        }
        // The interactions key goes to EVERY member with access — no
        // read-only role check. That asymmetry with the publish key above is
        // the whole point: in a read-only channel members react and show
        // presence, they just do not post.
        if (usesSharedPublish(channel) && s.intKey
                && s.intAnnounce?.keyId === s.intKey.keyId
                && !covered.has(s.intKey.keyId)) {
            try {
                const envelope = staticKey
                    ? {
                        t: KEYS_MSG_TYPE.PUB_WRAP,
                        k: 'i',
                        v: 2,
                        requestId: request.requestId,
                        keyId: s.intKey.keyId,
                        tag: await epochKeyCrypto.computeWrapTagV2(request.requestId, s.intKey.keyId),
                        ...await epochKeyCrypto.wrapEpochKeyToStatic(s.intKey.keyHex, staticKey)
                    }
                    : {
                        t: KEYS_MSG_TYPE.PUB_WRAP,
                        k: 'i',
                        requestId: request.requestId,
                        keyId: s.intKey.keyId,
                        tag: await epochKeyCrypto.computeWrapTag(request.pubkey, s.intKey.keyId),
                        ...await epochKeyCrypto.wrapEpochKey(s.intKey.keyHex, request.pubkey)
                    };
                await streamrController.publishKeysMessage(channel.keysStreamId, envelope);
                this._recordSeenWrap(s, request.requestId, s.intKey.keyId);
                sent += 1;
            } catch (e) {
                Logger.warn(`epochKeys: failed to wrap the interactions key for request ${request.requestId}:`, e.message);
            }
        }
        if (sent > 0) {
            Logger.debug(`epochKeys: answered request ${request.requestId} with ${sent} ${staticKey ? 'v2 ' : ''}wrap(s)`);
        }
    }

    _recordRequester(s, publisherId, messageStreamId = null) {
        const addr = (publisherId || '').toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(addr)) return;
        if (s.seenRequesters.has(addr)) return;
        if (s.seenRequesters.size >= 500) return;
        s.seenRequesters.add(addr);
        // The members and banned panels read this pool; a candidate that
        // arrives with the -4 history lands after they rendered.
        if (messageStreamId) this.onRequestersChanged?.(messageStreamId);
    }

    /**
     * Member candidates observed on -4 (KEY_REQUEST authors) — the candidate
     * source for enumerating TOKEN/NFT/PAID gate members without an indexer.
     * Misses whoever paid/joined but never opened the channel.
     */
    getSeenRequesters(messageStreamId) {
        const s = this.state.get(messageStreamId);
        return s ? Array.from(s.seenRequesters) : [];
    }

    _recordSeenWrap(s, requestId, keyId) {
        let set = s.seenWraps.get(requestId);
        if (!set) {
            if (s.seenWraps.size >= SEEN_WRAPS_MAX) {
                const oldest = s.seenWraps.keys().next().value;
                s.seenWraps.delete(oldest);
            }
            set = new Set();
            s.seenWraps.set(requestId, set);
        }
        set.add(keyId);
    }

    /**
     * A wrap addressed to our pending request: O(1) tag check, unwrap, verify
     * against the announced keyHash, adopt. Verification failure is a warn and
     * a drop — never adoption.
     */
    async _handleWrap(channel, s, data) {
        // Suppression bookkeeping FIRST, for every well-formed wrap — this is
        // what lets higher-rank answerers stay silent (N-B)
        if (typeof data.requestId === 'string' && typeof data.keyId === 'string') {
            this._recordSeenWrap(s, data.requestId, data.keyId);
        }
        if (data.v === 2) {
            await this._handleWrapV2(channel, s, data);
            return;
        }
        const pending = s.pendingRequest;
        if (!pending) return;
        if (data.requestId !== pending.requestId) return;
        if (typeof data.keyId !== 'string' || typeof data.tag !== 'string') return;
        if (s.epochs.has(data.keyId)) return;                             // already adopted

        const expectedTag = await epochKeyCrypto.computeWrapTag(pending.publicKey, data.keyId);
        if (data.tag.toLowerCase() !== expectedTag.toLowerCase()) return; // not addressed to us

        const announce = s.announces.get(data.epoch);
        if (!announce || announce.keyId !== data.keyId) {
            this._parkWrap(s, data);
            return;
        }

        let keyHex;
        try {
            keyHex = await epochKeyCrypto.unwrapEpochKey(
                { epk: data.epk, iv: data.iv, ct: data.ct }, pending.privateKey);
        } catch (e) {
            Logger.warn('epochKeys: wrap failed to open:', e.message);
            return;
        }

        const keyHash = await epochKeyCrypto.computeKeyHash(keyHex);
        if (keyHash.toLowerCase() !== announce.keyHash) {
            Logger.warn('epochKeys: wrap REJECTED — keyHash mismatch for', data.keyId,
                '(malicious or corrupted wrap)');
            return;
        }

        await this._adopt(channel, s, {
            keyId: data.keyId, keyHex, keyHash: announce.keyHash, epoch: data.epoch
        });
        Logger.info(`epochKeys: adopted epoch ${data.epoch} (${data.keyId}) on`,
            channel.messageStreamId.slice(-30));
    }

    /**
     * A v2 wrap: addressed by requestId (any of OUR retained request ids —
     * this session's or a persisted one from an earlier session or another
     * device), sealed to the account's static key. Same trust chain as v1:
     * announce lookup, then keyHash verify — a malicious wrapper still cannot
     * poison a key.
     */
    async _handleWrapV2(channel, s, data) {
        if (typeof data.requestId !== 'string' || typeof data.keyId !== 'string'
            || typeof data.tag !== 'string') return;
        if (s.epochs.has(data.keyId)) return;                             // already adopted
        const mine = s.pendingRequests.has(data.requestId)
            || s.pendingRequest?.requestId === data.requestId;
        if (!mine) return;

        const expectedTag = await epochKeyCrypto.computeWrapTagV2(data.requestId, data.keyId);
        if (data.tag.toLowerCase() !== expectedTag.toLowerCase()) return;

        const announce = s.announces.get(data.epoch);
        if (!announce || announce.keyId !== data.keyId) {
            this._parkWrap(s, data);
            return;
        }

        const accountKey = authManager.wallet?.privateKey;
        if (!accountKey) return;

        let keyHex;
        try {
            keyHex = await epochKeyCrypto.unwrapEpochKeyStatic(
                { epk: data.epk, iv: data.iv, ct: data.ct }, accountKey);
        } catch (e) {
            Logger.warn('epochKeys: v2 wrap failed to open:', e.message);
            return;
        }

        const keyHash = await epochKeyCrypto.computeKeyHash(keyHex);
        if (keyHash.toLowerCase() !== announce.keyHash) {
            Logger.warn('epochKeys: v2 wrap REJECTED — keyHash mismatch for', data.keyId,
                '(malicious or corrupted wrap)');
            return;
        }

        await this._adopt(channel, s, {
            keyId: data.keyId, keyHex, keyHash: announce.keyHash, epoch: data.epoch
        });
        Logger.info(`epochKeys: adopted epoch ${data.epoch} (${data.keyId}) via v2 wrap on`,
            channel.messageStreamId.slice(-30));
    }

    /** The account's static compressed pubkey (the DM key), or null. */
    _myStaticPubkey() {
        try {
            const privateKey = authManager.wallet?.privateKey;
            return privateKey ? dmCrypto.getMyPublicKey(privateKey) : null;
        } catch {
            return null;
        }
    }

    /**
     * Publish a KEY_REQUEST with a fresh request keypair (D12 — the keypair
     * lives on the pending request, in memory, until superseded) plus the
     * account's static pubkey, so a v2 wrap answered days later still opens.
     * Only the request id persists — no key material.
     */
    async _sendKeyRequest(channel, s) {
        const interval = s.requestAttempts < REQUEST_FAST_ATTEMPTS
            ? REQUEST_RETRY_FAST_MS : REQUEST_MIN_INTERVAL_MS;
        if (s.pendingRequest && (Date.now() - s.pendingRequest.sentAt) < interval) {
            return;
        }
        const missing = this._missingEpochs(s);
        if (missing.length === 0 && !this._needsPubKey(channel, s)) return;

        const { privateKey, publicKey } = epochKeyCrypto.generateRequestKeypair();
        const requestId = cryptoManager.generateRandomHex(16);
        const fromEpoch = missing.length > 0 ? Math.min(...missing) : 1;
        const spk = this._myStaticPubkey();

        s.requestAttempts += 1;
        s.pendingRequest = { requestId, privateKey, publicKey, fromEpoch, sentAt: Date.now() };
        if (spk) {
            s.pendingRequests.set(requestId, { fromEpoch, sentAt: Date.now() });
            while (s.pendingRequests.size > PENDING_REQUESTS_MAX) {
                const oldest = s.pendingRequests.keys().next().value;
                s.pendingRequests.delete(oldest);
            }
            await this._persist(channel.messageStreamId, s);
        }

        await streamrController.publishKeysMessage(channel.keysStreamId, {
            t: KEYS_MSG_TYPE.KEY_REQUEST,
            requestId,
            pubkey: publicKey,
            fromEpoch,
            ...(spk ? { spk } : {})
        });
        // Wake any device running the key responder for this channel.
        // Fire-and-forget: the retained request stands on its own — the wake
        // only shortens the wait from "next sweep" to seconds.
        import('./relayManager.js').then(({ relayManager }) =>
            relayManager.sendKeysWakeSignal(channel.messageStreamId)
        ).catch(() => { /* push relay unavailable — the sweep still answers */ });
        Logger.info(`epochKeys: requested epochs ≥${fromEpoch} on`, channel.keysStreamId.slice(-30));
    }

    async _adopt(channel, s, { keyId, keyHex, keyHash, epoch }) {
        s.epochs.set(keyId, { keyHex, keyHash, epoch, cryptoKey: null });
        if (epoch > s.currentEpoch) {
            s.currentEpoch = epoch;
        }
        s.missingKids?.delete(keyId);
        s.requestAttempts = 0;   // future rotations start on the fast retry again
        // Retained request ids exist to catch late v2 wraps; once nothing is
        // missing they only invite redundant answers.
        if (s.pendingRequests.size > 0 && this._missingEpochs(s).length === 0) {
            s.pendingRequests.clear();
        }
        await this._persist(channel.messageStreamId, s);
        this._notifyAdopted(channel.messageStreamId, keyId);
        this._maybePublishHello(channel, s, keyId, epoch).catch(e =>
            Logger.debug('epochKeys: member hello failed:', e.message));
    }

    // ==================== ROSTER (-4/P1) ====================

    /**
     * Does this channel's -4 carry the roster partition? Resolved once per
     * session from the stream's on-chain partition count — channels created
     * before P1 existed answer no, and every roster path degrades to the
     * seenRequesters fallback.
     */
    async _rosterCapable(channel, s) {
        if (s.rosterPartition === null) {
            try {
                const count = await streamrController.getStreamPartitionCount(channel.keysStreamId);
                s.rosterPartition = count >= 2 ? 1 : 0;
            } catch {
                return false;    // unknown stays null — probe again next time
            }
        }
        return s.rosterPartition === 1;
    }

    /**
     * A MEMBER_HELLO per (epoch, name), sealed with that epoch's key and
     * published on first adoption — never for past epochs (a backfilled hello
     * would fake presence in a window the member did not live). The seal is
     * what keeps the roster private: the -4 resend is publicly readable over
     * HTTP.
     *
     * The name travels so a member who never wrote still has one. The old
     * hello is not removed — the -4 is append-only and only the node's TTL
     * deletes — but substitution is infeasible by construction: the roster
     * only accepts a hello whose envelope signer equals the declared account.
     * `prev` chains the previous hello's timestamp, which buys an auditable
     * trail for free.
     */
    async _maybePublishHello(channel, s, keyId, epoch) {
        // A preview shadow channel receives keys (live-holding gates answer
        // its requests) but peeking must not enter the roster.
        if (channel.preview) return;
        if (epoch !== s.currentEpoch) return;
        const name = this._myDisplayName();
        if (s.helloEpochs.has(epoch) && (s.helloName || null) === name) return;
        if (!(await this._rosterCapable(channel, s))) return;
        const account = (authManager.getAddress() || '').toLowerCase();
        const entry = s.epochs.get(keyId);
        if (!account || !entry) return;

        const spk = this._myStaticPubkey();
        const hello = {
            t: KEYS_MSG_TYPE.MEMBER_HELLO,
            account,
            ...(spk ? { spk } : {}),
            ts: Date.now(),
            ...(name ? { name } : {}),
            ...(s.helloTs ? { prev: s.helloTs } : {})
        };
        const sealed = await epochKeyCrypto.encryptWithEpochKey(
            hello, await this._cryptoKey(entry));
        await streamrController.publishKeysMessage(
            channel.keysStreamId,
            { e: 'epoch-aes-gcm', k: keyId, ct: sealed.ct, iv: sealed.iv },
            KEYS_STREAM.ROSTER);
        s.helloEpochs.add(epoch);
        s.helloName = name;
        s.helloTs = hello.ts;
        s.rosterCache = null;
        await this._persist(channel.messageStreamId, s);
        Logger.debug(`epochKeys: member hello published for epoch ${epoch} on`,
            channel.keysStreamId.slice(-30));
    }

    /** The display name that travels in the hello, or null. */
    _myDisplayName() {
        const name = (identityManager.getUsername?.() || '').trim();
        return name ? name.slice(0, 64) : null;
    }

    /**
     * The name changed: republish the hello wherever this account is already
     * in the roster. Without this a rename waited for the next rotation,
     * which on a quiet channel is a week.
     */
    async republishHelloForRename(channels) {
        const name = this._myDisplayName();
        for (const channel of channels) {
            if (!usesEpochKeys(channel) || channel.preview) continue;
            const s = this.state.get(channel.messageStreamId);
            if (!s || s.currentEpoch === 0) continue;
            if ((s.helloName || null) === name) continue;
            const announce = s.announces.get(s.currentEpoch);
            if (!announce || !s.epochs.has(announce.keyId)) continue;
            try {
                await this._maybePublishHello(channel, s, announce.keyId, s.currentEpoch);
            } catch (e) {
                Logger.debug('epochKeys: hello republish failed:', e.message);
            }
        }
    }

    /**
     * The roster as last read, without a network round trip — what the bubbles
     * consult while rendering. Null when nothing has been read yet.
     */
    getCachedRoster(messageStreamId) {
        return this.state.get(messageStreamId)?.rosterCache?.members || null;
    }

    /** The name this account announced in the roster, with when it said so. */
    getRosterName(messageStreamId, account) {
        const entry = this.getCachedRoster(messageStreamId)
            ?.find(m => m.account === String(account).toLowerCase());
        return entry?.name ? { name: entry.name, ts: entry.ts } : null;
    }

    /**
     * The channel roster: MEMBER_HELLO authors from -4/P1, deduped by account,
     * newest hello wins. Persistent and device-independent, unlike
     * seenRequesters — the candidate source the members panel unions in.
     * Every entry is authenticated: the hello opens with an epoch key valid at
     * its timestamp AND its envelope signer equals the declared account, so a
     * member cannot plant a hello for someone else.
     * @param {Object} channel
     * @returns {Promise<Array<{account: string, spk: string|null, ts: number}>>}
     */
    async getRosterMembers(channel) {
        if (!usesEpochKeys(channel)) return [];
        const s = this._getState(channel.messageStreamId);
        if (s.rosterCache && Date.now() - s.rosterCache.at < ROSTER_CACHE_TTL_MS) {
            return s.rosterCache.members;
        }
        if (!(await this._rosterCapable(channel, s))) {
            s.rosterCache = { at: Date.now(), members: [] };
            return [];
        }
        const members = new Map();
        try {
            const entries = await streamrController.resendKeysMessages(
                channel.keysStreamId,
                { last: ROSTER_HISTORY_COUNT, partition: KEYS_STREAM.ROSTER });
            for (const { data, publisherId, timestamp } of entries) {
                if (!data || data.e !== 'epoch-aes-gcm' || typeof data.k !== 'string') continue;
                const key = await this.getKeyForKid(
                    channel.messageStreamId, data.k, { timestamp });
                if (!key) continue;    // missing key, or stale-kid violation
                let hello;
                try {
                    hello = await epochKeyCrypto.decryptWithEpochKey(data, key);
                } catch {
                    continue;
                }
                if (hello?.t !== KEYS_MSG_TYPE.MEMBER_HELLO) continue;
                const account = (hello.account || '').toLowerCase();
                if (!/^0x[0-9a-f]{40}$/.test(account)) continue;
                if (account !== (publisherId || '').toLowerCase()) continue;
                const ts = hello.ts || timestamp || 0;
                const spk = typeof hello.spk === 'string' ? hello.spk : null;
                const name = typeof hello.name === 'string' && hello.name.trim()
                    ? hello.name.trim().slice(0, 64) : null;
                const prev = members.get(account);
                if (!prev) {
                    members.set(account, { account, spk, ts, name, nameTs: name ? ts : 0 });
                    continue;
                }
                if (ts > prev.ts) { prev.ts = ts; prev.spk = spk; }
                // A hello without a name does not erase one: the name comes
                // from the newest hello that actually carried it.
                if (name && ts >= prev.nameTs) { prev.name = name; prev.nameTs = ts; }
            }
        } catch (e) {
            Logger.warn('epochKeys: roster read failed:', e.message);
            return s.rosterCache?.members || [];
        }
        const list = Array.from(members.values())
            .map(({ account, spk, ts, name }) => ({ account, spk, ts, name: name || null }));
        s.rosterCache = { at: Date.now(), members: list };
        return list;
    }

    /**
     * Requester-side retry while early requests may have been lost to a cold
     * topology (§7.2 R2): re-send, respecting the fast backoff, until the keys
     * land. Returns true while the channel is still waiting.
     */
    async retryRequestIfWaiting(channel) {
        const s = this.state.get(channel.messageStreamId);
        if (!s) return false;
        if (this._missingEpochs(s).length === 0 && !this._needsPubKey(channel, s)) return false;
        await this._sendKeyRequest(channel, s);
        return true;
    }

    /**
     * Called by the ingest when a message carries a `kid` we do not hold.
     * Not an error (§7.9) — record it for the UI and refresh key state at
     * most once per interval (announce may not have been pulled yet, or the
     * wrap is still on its way).
     */
    noteMissingKid(messageStreamId, kid) {
        const s = this._getState(messageStreamId);
        if (!s.missingKids) s.missingKids = new Set();
        s.missingKids.add(kid);

        const now = Date.now();
        if (s.lastMissingRefresh && (now - s.lastMissingRefresh) < REQUEST_MIN_INTERVAL_MS) return;
        s.lastMissingRefresh = now;

        import('./channels.js').then(({ channelManager }) => {
            const channel = channelManager.channels?.get(messageStreamId)
                ?? (channelManager.previewChannel?.messageStreamId === messageStreamId
                    ? channelManager.previewChannel : null);
            if (usesEpochKeys(channel)) {
                this.ensureChannelKeys(channel).catch(e =>
                    Logger.warn('epochKeys: refresh after missing kid failed:', e.message));
            }
        }).catch(() => { /* channels module unavailable (early boot) */ });
    }

    /**
     * UI state: is this channel waiting for keys, and how many kids are open?
     * @returns {{waiting: boolean, missingKids: number, hasCurrentKey: boolean}}
     */
    getWaitingInfo(messageStreamId) {
        const s = this.state.get(messageStreamId);
        if (!s) return { waiting: false, missingKids: 0, hasCurrentKey: false };
        const announce = s.announces.get(s.currentEpoch);
        const hasCurrentKey = !!(announce && s.epochs.has(announce.keyId));
        const missingKids = s.missingKids?.size || 0;
        return {
            waiting: (!hasCurrentKey && s.announces.size > 0) || missingKids > 0,
            missingKids,
            hasCurrentKey
        };
    }

    // ==================== KEY ACCESS (Passo 5) ====================

    /**
     * The epoch in force, as a number. Moderation stamps a ban with it so the
     * ban applies from that epoch onward and leaves the author's earlier
     * messages alone.
     * @returns {number|null} null when the channel has no epoch yet
     */
    currentEpoch(messageStreamId) {
        const s = this.state.get(messageStreamId);
        return s && s.currentEpoch > 0 ? s.currentEpoch : null;
    }

    /**
     * When the scheduled rotation is due, in epoch millis. A due date in the
     * past is honest: the timer only fires while the admin is here, so an
     * absent admin leaves the epoch standing until the next channel open.
     * @returns {number|null} null when there is no announce to count from
     */
    nextRotationAt(messageStreamId) {
        const s = this.state.get(messageStreamId);
        const validFrom = s?.announces?.get(s.currentEpoch)?.validFrom;
        return validFrom ? validFrom + ROTATION_INTERVAL_MS : null;
    }

    /**
     * Key to encrypt with right now: the current epoch's.
     * @returns {Promise<{kid: string, cryptoKey: CryptoKey}|null>} null while waiting for a key
     */
    async getCurrentKey(messageStreamId) {
        const s = this.state.get(messageStreamId);
        if (!s || s.currentEpoch === 0) return null;
        const announce = s.announces.get(s.currentEpoch);
        if (!announce) return null;
        const entry = s.epochs.get(announce.keyId);
        if (!entry) return null;
        return { kid: announce.keyId, cryptoKey: await this._cryptoKey(entry) };
    }

    /**
     * Key for a received `kid`, or null if not (yet) held — the caller parks
     * the message as "waiting for key" and retries via onKeyAdopted.
     *
     * Returns FALSE (distinct from null) on a kid-freshness violation: the
     * key is held and would open the message, but its use is out of policy —
     * the caller drops the message without requesting anything.
     *
     * Kid freshness (N-C): sticky signatures mean an ex-member still authors
     * valid envelopes; what stops readable spam is that old epoch keys stop
     * being acceptable. Live traffic must use the CURRENT epoch (previous
     * epoch tolerated briefly around a rotation); history must use the epoch
     * that was in force at the message timestamp (the announces' validFrom
     * map).
     *
     * @param {string} messageStreamId
     * @param {string} kid
     * @param {Object} [context]
     * @param {boolean} [context.live] - true when the message arrived on a live subscription
     * @param {number} [context.timestamp] - transport timestamp of the message
     */
    async getKeyForKid(messageStreamId, kid, context = {}) {
        const s = this.state.get(messageStreamId);
        const entry = s?.epochs.get(kid);
        if (!entry) return null;
        if (!this._kidIsFresh(s, kid, entry, context)) return false;
        return this._cryptoKey(entry);
    }

    /** The kid-freshness rule. True = acceptable use of this key. */
    _kidIsFresh(s, kid, entry, { live, timestamp } = {}) {
        const currentAnnounce = s.announces.get(s.currentEpoch);
        if (!currentAnnounce) return true;               // no anchor yet — cannot judge
        if (kid === currentAnnounce.keyId) {
            // Current epoch — but a history timestamp from before the epoch
            // existed is backdating under the current key: the kid in
            // force then was an older one.
            if (live || !Number.isFinite(timestamp)) return true;
            const validFrom = currentAnnounce.validFrom ?? currentAnnounce.timestamp ?? 0;
            return timestamp >= validFrom - CONFIG.gate.kidFreshnessToleranceMs;
        }

        if (live) {
            // Previous epoch tolerated briefly after a rotation (messages in
            // flight, slow adopters). Anything older is stale-key spam.
            const tolerance = CONFIG.gate.kidFreshnessToleranceMs;
            const rotatedAt = currentAnnounce.validFrom ?? currentAnnounce.timestamp ?? 0;
            return entry.epoch === s.currentEpoch - 1
                && Date.now() - rotatedAt < tolerance;
        }

        // History: the kid must be the one in force at the message timestamp —
        // the announce with the highest validFrom that is <= ts. Without a
        // timestamp there is nothing to judge against; reject the odd kid.
        if (!Number.isFinite(timestamp)) return false;
        let epochInForce = 0;
        let bestValidFrom = -Infinity;
        for (const [epoch, announce] of s.announces) {
            const validFrom = announce.validFrom ?? announce.timestamp ?? 0;
            if (validFrom <= timestamp && validFrom > bestValidFrom) {
                bestValidFrom = validFrom;
                epochInForce = epoch;
            }
        }
        return entry.epoch === epochInForce;
    }

    _cryptoKey(entry) {
        if (!entry.cryptoKey) {
            entry.cryptoKey = epochKeyCrypto.importEpochKey(entry.keyHex);
        }
        return entry.cryptoKey;
    }
}

export const epochKeyManager = new EpochKeyManager();
