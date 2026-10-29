/**
 * Decides when the app is offline, for the offline banner.
 *
 * The browser going offline or the Streamr node failing only makes the
 * connection suspect. While suspect, and only then, a storage node is probed
 * every PROBE_INTERVAL_MS; OFFLINE is declared once the suspicion has lasted
 * OFFLINE_AFTER_MS with no probe getting through. A probe that gets through,
 * or the node coming up, clears it. Never probes the RPC: offline must not
 * cost chain reads.
 */

export const PROBE_INTERVAL_MS = 15000;
export const OFFLINE_AFTER_MS = 60000;
export const ONLINE_SETTLE_MS = 2000;

export class ConnectionMonitor {
    /**
     * @param {Object} host
     * @param {() => Promise<boolean|null>} host.probe - true reached, false failed, null nothing to probe
     * @param {(offline: boolean) => void} host.onChange
     * @param {Object} [options]
     * @param {() => number} [options.now]
     * @param {number} [options.probeIntervalMs]
     * @param {number} [options.offlineAfterMs]
     */
    constructor(host, { now = Date.now, probeIntervalMs = PROBE_INTERVAL_MS, offlineAfterMs = OFFLINE_AFTER_MS } = {}) {
        this.host = host;
        this.now = now;
        this.probeIntervalMs = probeIntervalMs;
        this.offlineAfterMs = offlineAfterMs;
        this.browserOnline = true;
        this.nodeAlive = true;
        this.offline = false;
        this.suspectSince = null;
        this.timer = null;
        this.probing = false;
    }

    setBrowserOnline(online) {
        this.browserOnline = !!online;
        if (online && (this.suspect || this.offline) && !this.probing) {
            // Requests in flight when the network comes back are aborted.
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this._probe(), ONLINE_SETTLE_MS);
        }
        this._update();
    }

    setNodeAlive(alive) {
        this.nodeAlive = !!alive;
        if (alive) this._reached();
        this._update();
    }

    stop() {
        clearTimeout(this.timer);
        this.timer = null;
        this.suspectSince = null;
        this._setOffline(false);
    }

    get suspect() {
        return !this.browserOnline || !this.nodeAlive;
    }

    _update() {
        if (this.suspect || this.offline) {
            if (this.suspectSince === null) this.suspectSince = this.now();
            if (!this.timer && !this.probing) this._probe();
        } else {
            clearTimeout(this.timer);
            this.timer = null;
            this.suspectSince = null;
        }
    }

    async _probe() {
        this.timer = null;
        this.probing = true;
        const startedAt = this.now();
        let result;
        try {
            result = await this.host.probe();
        } catch {
            result = false;
        }
        this.probing = false;
        if (!(this.suspect || this.offline)) return;
        if (result === true) {
            this._reached();
        } else if ((result === false || !this.browserOnline)
            && this.now() - this.suspectSince >= this.offlineAfterMs) {
            this._setOffline(true);
        }
        if (this.suspect || this.offline) {
            const wait = Math.max(0, this.probeIntervalMs - (this.now() - startedAt));
            this.timer = setTimeout(() => this._probe(), wait);
        } else {
            this.suspectSince = null;
        }
    }

    _reached() {
        if (!this.browserOnline) return;
        this.suspectSince = this.suspect ? this.now() : null;
        this._setOffline(false);
    }

    _setOffline(offline) {
        if (this.offline === offline) return;
        this.offline = offline;
        this.host.onChange(offline);
    }
}
