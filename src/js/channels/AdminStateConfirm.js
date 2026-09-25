/**
 * Confirmation that a published ADMIN_STATE landed on storage.
 *
 * The publish goes out over the overlay and the client reports it sent
 * whether or not a storage node heard it: a snapshot published from a cold
 * session can be lost with nothing to show for it, and every other client
 * then keeps reading the previous one (a lifted ban that stays in force, a
 * pin that never appears). After each publish the -3 is read back, from the
 * same storage every reader uses, until the snapshot is there. When it is
 * not by the last delay the current snapshot is republished under the next
 * rev; a snapshot is complete, so the one that lands cures all before it.
 * After `adminConfirmRepublishLimit` republishes the owner is told and the
 * entry stays pending, picked up again when the channel is next opened.
 *
 * A snapshot the node holds with a higher rev, or the same rev from a later
 * publish, came from another device of the owner: it is adopted and the
 * pending one dropped, never republished over it.
 */

import { Logger } from '../logger.js';
import { CONFIG } from '../config.js';
import { streamrController, STREAM_CONFIG, deriveAdminId } from '../streamr.js';
import { authManager } from '../auth.js';
import { storageEndpoints } from '../storageEndpoints.js';

const STORAGE_KEY = 'pombo_admin_pending';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AdminStateConfirm {
    /**
     * @param {Object} manager - the channel manager; publishAdminState stays
     *   its call so callers replacing it keep intercepting the republish.
     * @param {Object} [options]
     * @param {(ms: number) => Promise<void>} [options.sleep] - injectable wait (tests)
     */
    constructor(manager, { sleep: sleepImpl = sleep } = {}) {
        this.manager = manager;
        this.sleep = sleepImpl;
        this.loops = new Map();   // messageStreamId → running confirmation
    }

    _key(messageStreamId) {
        return `${(authManager.getAddress() || '').toLowerCase()}|${messageStreamId}`;
    }

    _loadMap() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
        catch { return {}; }
    }

    _saveMap(map) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); }
        catch (e) { Logger.debug('admin pending persist failed:', e?.message); }
    }

    /** The publish of this channel still waiting for storage, or null. */
    pending(messageStreamId) {
        const entry = this._loadMap()[this._key(messageStreamId)];
        return (entry && typeof entry.rev === 'number') ? entry : null;
    }

    _setPending(messageStreamId, entry) {
        const map = this._loadMap();
        const key = this._key(messageStreamId);
        if (entry) map[key] = entry;
        else delete map[key];
        this._saveMap(map);
    }

    /**
     * Remember a publish that just went out and see it to storage.
     * @param {string} messageStreamId - Channel key (-1)
     * @param {{rev: number, ts: number, envelopeTs?: number|null}} published
     */
    track(messageStreamId, { rev, ts, envelopeTs = null }) {
        const prev = this.pending(messageStreamId);
        this._setPending(messageStreamId, {
            rev,
            ts,
            envelopeTs,
            republished: prev ? prev.republished : 0,
            since: prev ? prev.since : Date.now(),
            stalled: false
        });
        this._ensureLoop(messageStreamId);
    }

    /**
     * A channel with a pending publish was opened: wait for storage again,
     * with a fresh allowance of republishes.
     */
    resume(messageStreamId) {
        const entry = this.pending(messageStreamId);
        if (!entry) return;
        this._setPending(messageStreamId, { ...entry, republished: 0, stalled: false });
        this._ensureLoop(messageStreamId);
    }

    _ensureLoop(messageStreamId) {
        if (this.loops.has(messageStreamId)) return this.loops.get(messageStreamId);
        const run = this._loop(messageStreamId)
            .catch((e) => Logger.warn('ADMIN_STATE confirmation stopped:', e?.message))
            .finally(() => this.loops.delete(messageStreamId));
        this.loops.set(messageStreamId, run);
        return run;
    }

    async _loop(messageStreamId) {
        for (;;) {
            const pending = this.pending(messageStreamId);
            if (!pending || pending.stalled) return;
            const outcome = await this._awaitLanding(messageStreamId, pending);
            // A newer publish of ours took over: wait for that one instead.
            if (outcome === 'replaced') continue;
            if (outcome !== 'missing') return;
            const label = `ADMIN_STATE rev ${pending.rev} of ${messageStreamId.slice(-20)}`;
            if (pending.republished >= CONFIG.subscriptions.adminConfirmRepublishLimit) {
                this._setPending(messageStreamId, { ...pending, stalled: true });
                Logger.warn(`${label} never reached storage after ${pending.republished} republishes`);
                this.manager.notifyHandlers('admin_state_unconfirmed', { streamId: messageStreamId, rev: pending.rev });
                return;
            }
            const channel = this.manager.channels.get(messageStreamId);
            if (!channel) {
                this._setPending(messageStreamId, null);
                return;
            }
            this._setPending(messageStreamId, { ...pending, republished: pending.republished + 1 });
            Logger.warn(`${label} not on storage, republishing`);
            try {
                // The serialised publish tracks the new rev here on its way out.
                await this.manager.publishAdminState(messageStreamId, {
                    state: channel.adminSnapshot || channel.adminState || {}
                });
            } catch (e) {
                if (e?.code === 'ADMIN_STATE_TOO_LARGE') {
                    this._setPending(messageStreamId, null);
                    Logger.warn(`${label} cannot be republished: ${e.message}`);
                    this.manager.notifyHandlers('admin_state_too_large', { streamId: messageStreamId, rev: pending.rev });
                    return;
                }
                Logger.warn(`${label} republish failed, kept pending:`, e?.message);
                return;
            }
        }
    }

    /**
     * Read the -3 back at each configured delay until the pending snapshot
     * is there.
     * @returns {Promise<'landed'|'superseded'|'replaced'|'missing'|'gone'|'unverifiable'>}
     */
    async _awaitLanding(messageStreamId, pending) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) {
            this._setPending(messageStreamId, null);
            return 'gone';
        }
        const adminStreamId = channel.adminStreamId || deriveAdminId(messageStreamId);
        const label = `ADMIN_STATE rev ${pending.rev} of ${messageStreamId.slice(-20)}`;
        // An admin stream without storage has no node to read back from:
        // nothing to confirm, and nothing to republish.
        let providers = null;
        try { providers = await storageEndpoints.resolve(adminStreamId); }
        catch (e) { Logger.debug(`${label}: storage providers unresolved (${e?.message}), confirming anyway`); }
        if (providers && providers.length === 0) {
            this._setPending(messageStreamId, null);
            Logger.debug(`${label}: the admin stream has no storage, nothing to confirm`);
            return 'unverifiable';
        }
        for (const delay of CONFIG.subscriptions.adminConfirmDelaysMs) {
            await this.sleep(delay);
            const current = this.pending(messageStreamId);
            if (!current) return 'gone';
            if (current.rev !== pending.rev) return 'replaced';
            let latest = null;
            try {
                latest = await streamrController.resendAdminState(adminStreamId, {
                    historyCount: STREAM_CONFIG.ADMIN_HISTORY_COUNT,
                    password: channel.password || null
                });
            } catch (e) {
                Logger.debug(`${label}: confirmation read failed:`, e?.message);
            }
            if (!latest) continue;
            const rev = Number(latest.rev) || 0;
            const ts = Number(latest.ts) || 0;
            if (rev === pending.rev && ts === pending.ts) {
                this._setPending(messageStreamId, null);
                Logger.info(`${label} confirmed on storage`);
                return 'landed';
            }
            if (rev > pending.rev || (rev === pending.rev && ts > pending.ts)) {
                // Published after ours, from another device of the owner:
                // theirs is the channel's state now.
                this._setPending(messageStreamId, null);
                this.manager.handleAdminMessage(messageStreamId, latest);
                Logger.warn(`${label}: storage holds rev ${rev} published later elsewhere, adopted`);
                this.manager.notifyHandlers('admin_state_superseded', { streamId: messageStreamId, rev });
                return 'superseded';
            }
        }
        return 'missing';
    }
}
