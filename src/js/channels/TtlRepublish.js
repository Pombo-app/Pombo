/**
 * TTL-aware republish of a channel's retained -3 artifacts when its owner
 * opens it (docs/TTL_REPUBLISH_PLAN.md).
 */

import { Logger } from '../logger.js';
import { CONFIG } from '../config.js';
import { streamrController } from '../streamr.js';
import { authManager } from '../auth.js';
import { readStreamRetention, pickRetention } from '../streamRetention.js';
import { channelImageManager } from '../channelImageManager.js';
import { epochKeyManager } from '../epochKeyManager.js';
import { shouldRepublish } from '../ttlRepublish.js';

export class TtlRepublish {
    /**
     * @param {Object} manager - the channel manager; publishAdminState stays
     *   its call so callers replacing it keep intercepting this one.
     */
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Retention of the ADMIN stream, which is what the purge applies to the
     * -3 artifacts. The chain is the system of record: `channel.storageDays`
     * is the retention REQUESTED at creation for the -1, is absent on joined
     * records, and diverges from the -3 whenever a partial update leaves the
     * two streams out of step.
     *
     * The resolved value is cached on the channel purely as a fallback for a
     * Graph outage — without it an unreachable Graph silently reinstates the
     * 180-day default and disarms the republish.
     *
     * Never throws: an unresolved retention must still let the caller run the
     * challenge redundancy check.
     *
     * @param {Object} channel - Channel object (the live record in `channels`)
     * @param {string} adminStreamId - Admin stream id (-3)
     * @returns {Promise<{storageDays: number, source: 'graph'|'cached'|'local'|'default'}>}
     * @private
     */
    async _resolveAdminRetention(channel, adminStreamId) {
        const days = await readStreamRetention(adminStreamId);
        if (days !== null && channel.adminStorageDays !== days) {
            channel.adminStorageDays = days;
            await this.manager.saveChannels();
        }
        return pickRetention([
            [days, 'graph'],
            [channel.adminStorageDays, 'cached'],
            [channel.storageDays, 'local']
        ]);
    }

    /**
     * TTL-aware republish of the -3 artifacts on owner open
     * (docs/TTL_REPUBLISH_PLAN.md).
     *
     * The storage node's TTL purge deletes by message timestamp, and the -3
     * artifacts are published once and then only read — so an unmoderated
     * channel eventually loses its ADMIN_STATE (bans/pins vanish silently),
     * its CHANNEL_IMAGE, and its PASSWORD_CHALLENGE (channel becomes
     * unjoinable, joiners fail closed). Whenever the OWNER opens a channel,
     * compare each retained artifact's payload `ts` against the channel's
     * retention and republish anything past `ttlRepublishAgeFraction` of its
     * life. Republishing resets the retention clock, so this stays quiet for
     * the next ~80% of the TTL — it is NOT a per-open publish.
     *
     * The challenge branch also keeps the old redundancy semantics (missing
     * or invalid → republish), covering the create-time publish racing the
     * storage attachment.
     *
     * Must run AFTER bootstrapAdminState (reads channel.adminTs/adminRev).
     * Fire-and-forget from subscribeToChannel Step 1; never blocks the
     * render gate.
     *
     * @param {Object} channel - Channel object
     * @param {string} adminStreamId - Admin stream id (-3)
     * @param {string|null} pwd - Channel password (null for public channels)
     */
    async republishOnOpen(channel, adminStreamId, pwd) {
        if (!channel || !adminStreamId) return;
        if (channel.type === 'dm') return;
        // NOTE: deliberately NOT gated on channel.storageEnabled — the local
        // flag can be stale (joined channels, pre-flag records) while the
        // stream has storage on-chain. Each branch self-gates: nothing
        // retained → nothing republished (and a missing challenge must
        // republish regardless, the legacy redundancy semantics).
        const myAddress = authManager.getAddress();
        // Owner = createdBy when known, else the stream path prefix — streams
        // are created under the owner's address, and locally-joined password
        // channels may not carry createdBy (Android channelOwner() does the
        // same prefix fallback).
        const ownerAddress = channel.createdBy
            || (typeof channel.messageStreamId === 'string' && channel.messageStreamId.startsWith('0x')
                ? channel.messageStreamId.split('/')[0]
                : null);
        const isOwner = !!myAddress
            && !!ownerAddress
            && myAddress.toLowerCase() === ownerAddress.toLowerCase();

        // Resolved for the owner only: everyone else returns right below.
        const retention = isOwner
            ? await this._resolveAdminRetention(channel, adminStreamId)
            : { storageDays: null, source: 'not-owner' };
        const storageDays = retention.storageDays;
        const ageDays = (ts) => Math.round((Date.now() - ts) / 86_400_000);

        // One line per open stating the gate values — republishes are rare by
        // design, so without this the "nothing to do" paths are silent and
        // undiagnosable in the field. `thresholdDays` is the age at which a
        // retained artifact starts republishing.
        Logger.debug('TTL republish check', {
            streamId: channel.messageStreamId.slice(-20),
            type: channel.type,
            isOwner,
            hasPwd: !!pwd,
            adminRev: channel.adminRev || 0,
            adminAgeDays: channel.adminTs ? ageDays(channel.adminTs) : null,
            storageDays,
            retentionSource: retention.source,
            thresholdDays: storageDays
                ? Number((storageDays * (CONFIG.storage.ttlRepublishAgeFraction ?? 0.8)).toFixed(2))
                : null
        });

        // Only the owner can publish on -3 (on-chain permissions) — for
        // everyone else this whole check is a no-op.
        if (!isOwner) return;

        // Gated: the resends below open epoch envelopes, and this check can
        // fire before the open's epoch key setup has loaded the persisted
        // state — without this a cold session skipped the image republish
        // for a cycle.
        if (channel.gate?.address) {
            epochKeyManager.loadPersistedState(channel.messageStreamId);
        }

        // ADMIN_STATE (-3/P0): republish the current snapshot with rev+1 via
        // the normal publish path (serialization + ADMIN_INVALIDATE fan-out
        // included). Only when a snapshot is actually retained — an empty
        // state has nothing to preserve.
        if (channel.adminLoaded && (channel.adminRev || 0) > 0
            && shouldRepublish(channel.adminTs, storageDays)) {
            try {
                Logger.info('ADMIN_STATE nearing storage TTL — owner republishing', {
                    streamId: channel.messageStreamId.slice(-20),
                    ageDays: ageDays(channel.adminTs),
                    storageDays
                });
                await this.manager.publishAdminState(channel.messageStreamId, { state: channel.adminState });
            } catch (e) {
                Logger.debug('ADMIN_STATE TTL republish failed (will retry next open):', e?.message);
            }
        }

        // PASSWORD_CHALLENGE (-3/P2): missing OR invalid (legacy redundancy
        // semantics) OR too old → republish a fresh payload. Content is
        // immutable, so a fresh publish is always safe.
        if (channel.type === 'password' && pwd) {
            try {
                const res = await streamrController.verifyPasswordChallenge(adminStreamId, pwd);
                const tooOld = res.found && res.valid && shouldRepublish(res.ts, storageDays);
                if (!res.found) {
                    Logger.info('PASSWORD_CHALLENGE not retained on -3/P2 — owner republishing for redundancy');
                    await streamrController.publishPasswordChallenge(adminStreamId, pwd);
                } else if (!res.valid) {
                    // Should not happen (only owner can publish on -3), but if
                    // a stale/corrupt entry was retained, republish to restore
                    // a valid challenge.
                    Logger.warn('PASSWORD_CHALLENGE on -3/P2 did not verify with owner password — republishing');
                    await streamrController.publishPasswordChallenge(adminStreamId, pwd);
                } else if (tooOld) {
                    Logger.info('PASSWORD_CHALLENGE nearing storage TTL — owner republishing', {
                        ageDays: ageDays(res.ts),
                        storageDays
                    });
                    await streamrController.publishPasswordChallenge(adminStreamId, pwd);
                } else {
                    Logger.debug('PASSWORD_CHALLENGE retained and fresh — skipping republish');
                }
            } catch (e) {
                Logger.debug('PASSWORD_CHALLENGE redundancy check failed (will retry next open):', e?.message);
            }
        }

        // CHANNEL_IMAGE (-3/P1): republish the RETAINED payload verbatim with
        // rev+1 and a fresh ts. Deliberately resent here (last:1) instead of
        // trusting channelImageManager's cache — the cache survives a storage
        // purge (IDB), and resurrecting a purged image from local cache is a
        // recovery decision this path does not make (see plan §6).
        try {
            const payload = await streamrController.resendChannelImage(adminStreamId, { password: pwd });
            if (payload?.data && payload?.hash && shouldRepublish(payload.ts, storageDays)) {
                if (payload.encrypted && !pwd) {
                    Logger.debug('CHANNEL_IMAGE TTL republish skipped: encrypted payload without password');
                    return;
                }
                Logger.info('CHANNEL_IMAGE nearing storage TTL — owner republishing', {
                    streamId: channel.messageStreamId.slice(-20),
                    ageDays: ageDays(payload.ts),
                    storageDays
                });
                await this.republishImage(channel, adminStreamId, payload, pwd);
            }
        } catch (e) {
            Logger.debug('CHANNEL_IMAGE TTL republish failed (will retry next open):', e?.message);
        }
    }

    async republishImage(channel, adminStreamId, payload, pwd) {
        const freshPayload = {
            ...payload,
            rev: (typeof payload.rev === 'number' ? payload.rev : 0) + 1,
            ts: Date.now(),
            createdBy: payload.createdBy || authManager.getAddress()
        };
        const published = await streamrController.publishChannelImage(
            adminStreamId, freshPayload, payload.encrypted ? pwd : null);
        // Keep the local rev counter ahead of the retained entry so a
        // later image change never publishes a lower rev.
        channel.channelImageRev = Math.max(channel.channelImageRev || 0, freshPayload.rev);
        await channelImageManager.setLocal(adminStreamId, {
            hash: freshPayload.hash,
            dataUrl: freshPayload.data,
            encrypted: !!freshPayload.encrypted,
            ts: freshPayload.ts,
            rev: freshPayload.rev,
            owner: freshPayload.createdBy
        });
        return published;
    }
}
