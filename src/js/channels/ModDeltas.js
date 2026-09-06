/**
 * Moderator deltas: publishing them on -1/P2, collecting the ones that
 * arrive, and folding them onto the owner's snapshot.
 *
 * A moderator cannot publish ADMIN_STATE — the -3 is owner-only publish — so
 * this is how their moderation reaches everyone while the owner is away. The
 * owner later "officialises" by absorbing the deltas into a snapshot, which
 * is what makes them permanent even if the moderator is later dismissed.
 */
import { Logger } from '../logger.js';
import { streamrController, STREAM_CONFIG } from '../streamr.js';
import { authManager } from '../auth.js';
import { buildModAction, verifyModAction, MOD_ACTION_TYPE } from './modAction.js';
import { composeModeration } from './modComposition.js';

export class ModDeltas {
    constructor(manager) {
        this.manager = manager;
        /** messageStreamId -> Map(deltaKey -> payload) */
        this.deltas = new Map();
        /** messageStreamId -> lowercase moderator addresses, refreshed from the gate */
        this.moderators = new Map();
    }

    _key(d) {
        return `${d.ts}|${d.mod}|${d.op}|${d.target}`;
    }

    _bucket(messageStreamId) {
        let bucket = this.deltas.get(messageStreamId);
        if (!bucket) {
            bucket = new Map();
            this.deltas.set(messageStreamId, bucket);
        }
        return bucket;
    }

    /**
     * A MOD_ACTION arrived (live or from history). Verified here, filtered by
     * the moderator set at composition time — a delta whose author was
     * dismissed since stops counting without having to be deleted.
     * @returns {boolean} true when the delta was accepted into the set
     */
    ingest(messageStreamId, payload) {
        const signer = verifyModAction(messageStreamId, payload);
        if (!signer) {
            Logger.debug('MOD_ACTION rejected — signature does not verify');
            return false;
        }
        const bucket = this._bucket(messageStreamId);
        const key = this._key({ ...payload, mod: signer });
        if (bucket.has(key)) return false;
        bucket.set(key, { ...payload, mod: signer });
        this._resolveModerator(messageStreamId, signer);
        this._recompose(messageStreamId);
        return true;
    }

    /**
     * Is this signer a moderator right now? Asked per distinct signer instead
     * of enumerating the gate: there is no on-chain moderator list, and the
     * composition only ever needs the addresses that actually signed
     * something. Resolves in the background and recomposes on the answer, so
     * a delta from an unknown signer simply does not count until it is known.
     */
    _resolveModerator(messageStreamId, signer) {
        const address = String(signer).toLowerCase();
        let known = this.moderators.get(messageStreamId);
        if (!known) {
            known = { mods: new Set(), asked: new Set(), settled: new Set() };
            this.moderators.set(messageStreamId, known);
        }
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel?.gate?.address) return;
        if ((channel.createdBy || '').toLowerCase() === address) {
            known.mods.add(address);
            known.settled.add(address);
            return;
        }
        if (known.asked.has(address)) return;
        known.asked.add(address);
        import('../gate.js')
            .then(({ gateManager }) => gateManager._isModerator(channel.gate.address, address))
            .then(isMod => {
                known.settled.add(address);
                if (!isMod) return;
                known.mods.add(address);
                this._recompose(messageStreamId);
            })
            .catch(() => known.asked.delete(address));
    }

    /**
     * Signers of these deltas the gate has not answered for yet. An empty
     * list is what makes an absorb safe.
     */
    _unsettled(messageStreamId, deltas) {
        const known = this.moderators.get(messageStreamId);
        const settled = known?.settled || new Set();
        return [...new Set(deltas.map(d => String(d.mod).toLowerCase()))]
            .filter(signer => !settled.has(signer));
    }

    /** Fold the deltas back into the channel's rendered state. */
    _recompose(messageStreamId) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) return;
        this.manager.adminState.recompose(channel);
        this.manager.notifyHandlers('admin_state_updated', {
            streamId: messageStreamId,
            adminState: channel.adminState,
            rev: channel.adminRev
        });
    }

    /** Deltas held for a channel, oldest first. */
    all(messageStreamId) {
        return Array.from(this._bucket(messageStreamId).values());
    }

    /**
     * Deltas the owner has not ratified yet. Absorbing does not delete
     * anything — the -1/P2 is append-only and the snapshot's
     * `absorbedThrough` is what stops them counting — so this is what the
     * "confirm" surface has to measure, or it keeps offering work already done.
     */
    pending(channel) {
        const absorbed = Number(channel?.adminSnapshot?.absorbedThrough
            || channel?.adminState?.absorbedThrough) || 0;
        return this.all(channel.messageStreamId).filter(d => Number(d.ts) > absorbed);
    }

    /**
     * The effective moderation state: the owner's snapshot with the
     * unabsorbed deltas of CURRENT moderators applied on top.
     */
    effectiveState(channel) {
        const snapshot = channel?.adminSnapshot || channel?.adminState || {};
        const deltas = this.all(channel.messageStreamId);
        if (deltas.length === 0) return null;
        const known = this.moderators.get(channel.messageStreamId);
        return composeModeration(snapshot, deltas, known ? [...known.mods] : []);
    }

    /**
     * Re-ask the gate about every signer held, dropping what a dismissal has
     * invalidated. Called when the roles change, not per message.
     */
    async refreshModerators(channel) {
        if (!channel?.gate?.address) return;
        const signers = new Set(this.all(channel.messageStreamId)
            .map(d => String(d.mod).toLowerCase()));
        this.moderators.delete(channel.messageStreamId);
        for (const signer of signers) {
            this._resolveModerator(channel.messageStreamId, signer);
        }
        this._recompose(channel.messageStreamId);
    }

    /**
     * Publish a delta as a moderator. The owner does not take this path —
     * they own the snapshot, which is stronger and needs no ratification.
     * @param {string} messageStreamId
     * @param {string} op - hide | unhide | ban | unban
     * @param {string} target - message id, or address for ban/unban
     * @param {number|null} [sinceEpoch] - ban only; null hides everything
     */
    async publish(messageStreamId, op, target, sinceEpoch = null) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) throw new Error('Channel not found');
        const privateKey = authManager.wallet?.privateKey;
        if (!privateKey) throw new Error('No wallet available to sign the moderation action');

        const payload = buildModAction({
            streamId: messageStreamId, op, target, sinceEpoch, privateKey
        });
        // Apply locally first: the moderator sees their own action take effect
        // without waiting for the round trip, exactly like a sent message.
        this.ingest(messageStreamId, payload);
        await streamrController.publishAsChannel(
            messageStreamId,
            STREAM_CONFIG.MESSAGE_STREAM.MODERATION,
            payload,
            channel.password || null
        );
        Logger.info(`MOD_ACTION ${op} published on`, messageStreamId.slice(-20));
        return payload;
    }

    /**
     * Absorb the deltas into the owner's snapshot: what the owner ratifies
     * becomes their own word, permanent even if the moderator is dismissed
     * afterwards. `absorbedThrough` advances only to what was actually read,
     * so a delta still in flight is never silently reverted.
     */
    async absorb(messageStreamId) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) throw new Error('Channel not found');
        const deltas = this.pending(channel);
        if (deltas.length === 0) return null;

        // Every pending delta needs a settled verdict on its author first.
        // Absorbing while the gate has not answered writes absorbedThrough
        // over a composition that still counts nobody: the ratification
        // lands, the moderation it was ratifying disappears, and the delta
        // stops counting for good.
        const unsettled = this._unsettled(messageStreamId, deltas);
        if (unsettled.length > 0) {
            for (const signer of unsettled) this._resolveModerator(messageStreamId, signer);
            throw new Error('Still checking who moderates this channel — try again in a moment');
        }

        const effective = this.effectiveState(channel);
        if (!effective) return null;
        const absorbedThrough = deltas.reduce((max, d) => Math.max(max, Number(d.ts) || 0), 0);

        return this.manager.publishAdminState(messageStreamId, {
            patch: {
                hiddenMessageIds: effective.hiddenMessageIds,
                bannedMembers: effective.bannedMembers,
                absorbedThrough
            }
        });
    }

    /** Drop the cached deltas for a channel (leave/delete). */
    forget(messageStreamId) {
        this.deltas.delete(messageStreamId);
        this.moderators.delete(messageStreamId);
    }
}

export { MOD_ACTION_TYPE };
