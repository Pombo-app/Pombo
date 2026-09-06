/**
 * Sealed authorship — per-message identity that never touches the
 * transport.
 *
 * In a Sealed channel every message is published under the channel's
 * SHARED publish key, so the network learns nothing about who wrote what.
 * Authorship lives INSIDE the epoch-sealed plaintext instead, as a wrapper:
 *
 *   { v: 1, p: <payload JSON string>, pk, sig, bp }
 *
 *   pk   pseudonym: a compressed secp256k1 pubkey, session-local (never
 *        persisted — the account is what members see, recovered from bp)
 *   sig  pseudonym signature over keccak256(POMBO_MSG_V1|streamId|p) —
 *        MANDATORY per message: with only the bind proof, any member could
 *        paste someone else's proof onto their own messages (forgery)
 *   bp   bind proof: ACCOUNT signature over
 *        keccak256(POMBO_BIND_V1|streamId|pk) — ties the pseudonym to the
 *        account, channel-scoped so a proof can never be replanted elsewhere
 *
 * The payload travels as the exact STRING that was signed (`p`), parsed only
 * after verification — canonical-JSON reconstruction across platforms is a
 * parity trap this format refuses to enter.
 *
 * Only members can verify (the wrapper is inside the epoch seal), and no
 * member can forge: the pseudonym key signs every message, the account key
 * signs the pseudonym. Both are raw-digest secp256k1 signatures (RFC 6979).
 */

import { dmCrypto } from './dmCrypto.js';

const BIND_DOMAIN = 'POMBO_BIND_V1';
const MSG_DOMAIN = 'POMBO_MSG_V1';

class Authorship {
    /**
     * Fresh pseudonym keypair for this session's publishes in one channel.
     * Memory only — a restart mints a new one; members resolve the ACCOUNT
     * from the bind proof, so pseudonym churn is invisible to them.
     * @returns {{privateKey: string, publicKey: string}} hex; publicKey compressed
     */
    generatePseudonym() {
        const privateKey = dmCrypto.generateEphemeralPrivateKey();
        const publicKey = new ethers.SigningKey(privateKey).compressedPublicKey;
        return { privateKey, publicKey };
    }

    /** keccak256 digest binding a pseudonym to a channel. */
    bindDigest(messageStreamId, pseudonymPubkey) {
        return ethers.keccak256(ethers.toUtf8Bytes(
            `${BIND_DOMAIN}|${messageStreamId.toLowerCase()}|${pseudonymPubkey.toLowerCase()}`));
    }

    /** keccak256 digest a pseudonym signs per message. */
    msgDigest(messageStreamId, payloadString) {
        return ethers.keccak256(ethers.toUtf8Bytes(
            `${MSG_DOMAIN}|${messageStreamId.toLowerCase()}|${payloadString}`));
    }

    /**
     * Account signature tying `pseudonymPubkey` to the account, for this
     * channel. Computed once per session per channel.
     * @returns {string} 65-byte signature hex
     */
    createBindProof(messageStreamId, pseudonymPubkey, accountPrivateKey) {
        const digest = this.bindDigest(messageStreamId, pseudonymPubkey);
        return new ethers.SigningKey(accountPrivateKey).sign(digest).serialized;
    }

    /**
     * Build the authorship wrapper around a payload object.
     * @param {string} messageStreamId
     * @param {Object} payload - The message object (sealed afterwards by the caller)
     * @param {{privateKey: string, publicKey: string}} pseudonym
     * @param {string} bindProof - From createBindProof()
     * @returns {Object} wrapper { v, p, pk, sig, bp }
     */
    seal(messageStreamId, payload, pseudonym, bindProof) {
        const p = JSON.stringify(payload);
        const sig = new ethers.SigningKey(pseudonym.privateKey)
            .sign(this.msgDigest(messageStreamId, p)).serialized;
        return { v: 1, p, pk: pseudonym.publicKey, sig, bp: bindProof };
    }

    /** Does this epoch-sealed plaintext carry the authorship wrapper? */
    isWrapper(obj) {
        return !!(obj && obj.v === 1
            && typeof obj.p === 'string' && typeof obj.pk === 'string'
            && typeof obj.sig === 'string' && typeof obj.bp === 'string');
    }

    /**
     * Verify a wrapper and recover its author.
     *
     * The two recoveries are the whole trust chain: sig must recover to the
     * pseudonym (nobody signed this message but the pseudonym holder), bp
     * must recover to an account (nobody tied this pseudonym to the account
     * but the account holder). Any mismatch is a drop, never a fallback.
     *
     * What this guarantees — and what it does not: impersonating a CHOSEN
     * account is infeasible (a pasted bind proof recovers to garbage, never
     * to its owner, because the digest covers THIS pseudonym), but ecrecover
     * always yields some address, so a member can fabricate messages under
     * meaningless authors nobody controls. Live ingest cuts those with the
     * gate check on the author; in history they are member-origin spam for
     * moderation — the same class the mode's spam table already accepts.
     *
     * @param {string} messageStreamId
     * @param {Object} wrapper
     * @returns {{author: string, payload: Object}|null} lowercase author, parsed payload
     */
    open(messageStreamId, wrapper) {
        if (!this.isWrapper(wrapper)) return null;
        try {
            const signer = ethers.recoverAddress(
                this.msgDigest(messageStreamId, wrapper.p), wrapper.sig);
            if (signer.toLowerCase() !== ethers.computeAddress(wrapper.pk).toLowerCase()) {
                return null;
            }
            const author = ethers.recoverAddress(
                this.bindDigest(messageStreamId, wrapper.pk), wrapper.bp).toLowerCase();
            return { author, payload: JSON.parse(wrapper.p) };
        } catch {
            return null;
        }
    }
}

export const authorship = new Authorship();
