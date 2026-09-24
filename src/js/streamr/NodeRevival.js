/**
 * Rebuilds the Streamr client when its node failed to start (twin of the
 * Android NodeRevival). The SDK starts the node once per client and keeps a
 * failed start for the client's whole life: every publish and subscribe then
 * fails at once, and only a new client starts again.
 *
 * One rebuild at a time, and only after a real request got through: the first
 * at once, the next ones on a backoff. The browser coming back online, or the
 * page back in view, skips what is left of the wait.
 */

import { Logger } from '../logger.js';

export const NODE_REVIVAL_DELAYS_MS = [15000, 30000, 60000, 120000, 300000];
export const NODE_REPORT_TIMEOUT_MS = 180000;

export class NodeRevival {
    /**
     * @param {Object} host
     * @param {() => Promise<boolean>} host.networkUp - a real request; navigator.onLine is true behind a captive portal
     * @param {() => Promise<void>} host.rebuild - new client; its node's start comes back as onAlive/onDead
     * @param {Object} [options]
     * @param {number[]} [options.delaysMs]
     * @param {number} [options.reportTimeoutMs]
     */
    constructor(host, { delaysMs = NODE_REVIVAL_DELAYS_MS, reportTimeoutMs = NODE_REPORT_TIMEOUT_MS } = {}) {
        this.host = host;
        this.delaysMs = delaysMs;
        this.reportTimeoutMs = reportTimeoutMs;
        this.dead = false;
        this.failures = 0;
        this.busy = false;
        this.rebuilding = false;
        this.waitTimer = null;
        this.watchdog = null;
    }

    onDead() {
        this.dead = true;
        if (this.rebuilding) {
            this.rebuilding = false;
            this.busy = false;
            this.failures++;
            clearTimeout(this.watchdog);
            this.watchdog = null;
        }
        if (!this.busy) this._schedule();
    }

    onAlive() {
        this.dead = false;
        this.rebuilding = false;
        this.busy = false;
        this.failures = 0;
        clearTimeout(this.waitTimer);
        this.waitTimer = null;
        clearTimeout(this.watchdog);
        this.watchdog = null;
    }

    /** Logged out: nothing left to revive. */
    stop() {
        this.onAlive();
    }

    /** Back online or back in view: no reason to wait longer. */
    kick() {
        if (!this.dead || this.busy) return;
        clearTimeout(this.waitTimer);
        this.waitTimer = null;
        this._attempt();
    }

    _schedule() {
        clearTimeout(this.waitTimer);
        const delay = this.failures === 0
            ? 0
            : this.delaysMs[Math.min(this.failures - 1, this.delaysMs.length - 1)];
        this.waitTimer = setTimeout(() => {
            this.waitTimer = null;
            this._attempt();
        }, delay);
    }

    async _attempt() {
        if (!this.dead || this.busy) return;
        this.busy = true;
        let up = false;
        try { up = await this.host.networkUp(); } catch { up = false; }
        if (!this.dead) {
            this.busy = false;
            return;
        }
        if (!up) {
            this.busy = false;
            this.failures++;
            this._schedule();
            return;
        }
        this.rebuilding = true;
        // A start that never reports would block every later rebuild.
        this.watchdog = setTimeout(() => {
            if (this.rebuilding) this.onDead();
        }, this.reportTimeoutMs);
        try {
            await this.host.rebuild();
        } catch (e) {
            Logger.warn('Streamr client rebuild failed:', e?.message || e);
            if (this.rebuilding) this.onDead();
        }
    }
}
