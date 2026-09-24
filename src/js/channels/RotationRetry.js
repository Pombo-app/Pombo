/**
 * The epoch rotation owed after a ban or a removal (twin of the Android
 * RotationRetry). Until it goes out, the address cut on the gate still holds
 * the current key and reads everything published under it.
 *
 * It fails when the Streamr node failed to start, and the SDK keeps that
 * failure until the client is rebuilt: so the debt is kept on this device,
 * retried while the session lives, taken up again when the next session
 * connects, and settled before the admin's own sends.
 */

import { Logger } from '../logger.js';

export const ROTATION_RETRY_DELAYS_MS = [5000, 10000, 20000, 40000, 60000];
export const OWED_ROTATION_MESSAGE = 'Waiting to rotate the channel key. It rotates the next time the app connects.';

const STORAGE_KEY = 'pombo_rotation_owed';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RotationRetry {
    /**
     * @param {Object} host
     * @param {() => string|null} host.account
     * @param {(messageStreamId: string) => Promise<void>} host.rotate - throws when the announce did not go out
     * @param {(messageStreamId: string, addresses: string[]) => Promise<void>} host.covered - record them as rotated for
     * @param {(messageStreamId: string) => boolean} host.stillOwned - false once this account no longer owns a stored channel of that id
     * @param {Object} [options]
     * @param {(ms: number) => Promise<void>} [options.sleep] - injectable wait (tests)
     * @param {number[]} [options.delaysMs]
     */
    constructor(host, { sleep: sleepImpl = sleep, delaysMs = ROTATION_RETRY_DELAYS_MS } = {}) {
        this.host = host;
        this.sleep = sleepImpl;
        this.delaysMs = delaysMs;
        this.attempts = new Map();  // messageStreamId → the attempt in flight
        this.loops = new Set();
    }

    _key(messageStreamId) {
        return `${(this.host.account() || '').toLowerCase()}|${messageStreamId}`;
    }

    _loadMap() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
        catch { return {}; }
    }

    _owed(messageStreamId) {
        const list = this._loadMap()[this._key(messageStreamId)];
        return Array.isArray(list) ? list : [];
    }

    _update(messageStreamId, change) {
        const map = this._loadMap();
        const key = this._key(messageStreamId);
        const next = [...new Set(change(Array.isArray(map[key]) ? map[key] : []))];
        if (next.length > 0) map[key] = next;
        else delete map[key];
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); }
        catch (e) { Logger.warn('Owed rotation persist failed:', e?.message); }
    }

    isOwed(messageStreamId) {
        return this._owed(messageStreamId).length > 0;
    }

    /**
     * Rotate for the addresses now; on failure keep them owed and retry.
     * @returns {Promise<boolean>} true when the rotation went out now
     */
    async rotateFor(messageStreamId, addresses) {
        this._update(messageStreamId, (owed) => [...owed, ...addresses.map(a => a.toLowerCase())]);
        if (await this._attempt(messageStreamId)) return true;
        this._ensureLoop(messageStreamId);
        return false;
    }

    /** Take up what an earlier session left owed on these channels. */
    resume(messageStreamIds) {
        for (const messageStreamId of messageStreamIds) {
            if (!this.isOwed(messageStreamId)) continue;
            this._attempt(messageStreamId).then((done) => {
                if (!done) this._ensureLoop(messageStreamId);
            });
        }
    }

    /** Before the admin publishes: an owed rotation goes first, or the publish does not go. */
    async settle(messageStreamId) {
        if (!this.isOwed(messageStreamId)) return;
        if (!await this._attempt(messageStreamId)) throw new Error(OWED_ROTATION_MESSAGE);
    }

    _attempt(messageStreamId) {
        const previous = this.attempts.get(messageStreamId) || Promise.resolve();
        const next = previous.catch(() => {}).then(() => this._rotateOnce(messageStreamId));
        this.attempts.set(messageStreamId, next);
        next.finally(() => {
            if (this.attempts.get(messageStreamId) === next) this.attempts.delete(messageStreamId);
        }).catch(() => {});
        return next;
    }

    async _rotateOnce(messageStreamId) {
        const addresses = this._owed(messageStreamId);
        if (addresses.length === 0) return true;
        try {
            await this.host.rotate(messageStreamId);
        } catch (e) {
            Logger.warn(`Rotation owed to ${addresses.length} cut address(es) failed, retrying:`, e?.message);
            return false;
        }
        this._update(messageStreamId, (owed) => owed.filter(a => !addresses.includes(a)));
        Logger.info(`Rotated the epoch owed to ${addresses.length} cut address(es)`);
        try {
            await this.host.covered(messageStreamId, addresses);
        } catch (e) {
            Logger.warn('Recording the rotation failed:', e?.message);
        }
        return !this.isOwed(messageStreamId);
    }

    _ensureLoop(messageStreamId) {
        if (this.loops.has(messageStreamId)) return;
        this.loops.add(messageStreamId);
        (async () => {
            try {
                for (let round = 0; this.isOwed(messageStreamId); round++) {
                    await this.sleep(this.delaysMs[Math.min(round, this.delaysMs.length - 1)]);
                    if (!this.host.stillOwned(messageStreamId)) {
                        this._update(messageStreamId, () => []);
                        return;
                    }
                    await this._attempt(messageStreamId);
                }
            } finally {
                this.loops.delete(messageStreamId);
            }
        })();
    }
}
