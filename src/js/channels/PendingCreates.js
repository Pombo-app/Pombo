/**
 * Channel creations started on this device and not finished (twin of the
 * Android PendingCreates). The record is written before the first
 * transaction, so a reload part way through leaves a creation to finish or
 * discard instead of a paid channel nobody holds; the chain says which.
 */

import { Logger } from '../logger.js';

/** Nothing on chain after this long: whatever was sent is not landing. */
export const PENDING_CREATE_MAX_AGE_MS = 60 * 60 * 1000;

export const PENDING_STATE = Object.freeze({
    RUNNING: 'running',
    RESUMABLE: 'resumable',
    WAITING: 'waiting',
    UNREADABLE: 'unreadable',
    DISCARDED: 'discarded'
});

const BIGINT_OPTIONS = ['gateMinBalance', 'gatePrice', 'gateDuration'];

/** The creation options as a stored record holds them: no callbacks, uint256 values as decimal strings. */
export function packCreateOptions(options = {}) {
    const packed = {};
    for (const [key, value] of Object.entries(options)) {
        if (typeof value === 'function' || value === undefined) continue;
        packed[key] = typeof value === 'bigint' ? value.toString() : value;
    }
    return packed;
}

export function unpackCreateOptions(packed = {}) {
    const options = { ...packed };
    for (const key of BIGINT_OPTIONS) {
        if (options[key] != null) options[key] = BigInt(options[key]);
    }
    return options;
}

export class PendingCreates {
    /**
     * @param {Object} host
     * @param {() => Object[]} host.records - the account's stored records
     * @param {(record: Object) => Promise<void>} host.put
     * @param {(basePath: string) => Promise<void>} host.remove
     * @param {(streamId: string) => Promise<boolean>} host.streamExists - throws when the chain cannot be read
     * @param {(record: Object) => Promise<string|null>} host.findGate - the clone the creation deployed; throws when the chain cannot be read
     * @param {() => number} [host.now]
     */
    constructor(host) {
        this.host = host;
        this.now = host.now || (() => Date.now());
        this.running = new Set();   // basePaths this session is creating
        this.states = new Map();    // basePath → last PENDING_STATE
    }

    list() {
        return this.host.records();
    }

    get(basePath) {
        return this.list().find(r => r.basePath === basePath) || null;
    }

    /** The records the chain shows started, for Finish / Discard. */
    resumable() {
        return this.list().filter(r => this.states.get(r.basePath) === PENDING_STATE.RESUMABLE);
    }

    async begin(record) {
        this.running.add(record.basePath);
        await this.host.put(record);
    }

    /** @returns {boolean} false when this session is already creating it */
    claim(basePath) {
        if (this.running.has(basePath)) return false;
        this.running.add(basePath);
        return true;
    }

    async update(record) {
        await this.host.put(record);
    }

    async complete(basePath) {
        await this.host.remove(basePath);
        this.states.delete(basePath);
        this.running.delete(basePath);
    }

    release(basePath) {
        this.running.delete(basePath);
    }

    async discard(basePath) {
        if (this.running.has(basePath)) throw new Error('This channel is still being created');
        await this.host.remove(basePath);
        this.states.delete(basePath);
    }

    /**
     * What the chain holds of one record. Anything of it there (the gate
     * clone, or the -1 for channels without one) makes it resumable; nothing
     * after PENDING_CREATE_MAX_AGE_MS drops the record.
     * @returns {Promise<string>} PENDING_STATE
     */
    async reconcile(record) {
        if (this.running.has(record.basePath)) return PENDING_STATE.RUNNING;
        let landed;
        try {
            if (record.type === 'gated') {
                let gateAddress = record.gateAddress;
                if (!gateAddress) {
                    gateAddress = await this.host.findGate(record);
                    if (gateAddress) {
                        if (this.running.has(record.basePath) || !this.get(record.basePath)) {
                            return PENDING_STATE.RUNNING;
                        }
                        await this.host.put({ ...record, gateAddress });
                    }
                }
                landed = !!gateAddress;
            } else {
                landed = await this.host.streamExists(`${record.basePath}-1`);
            }
        } catch (e) {
            Logger.warn('Interrupted channel creation unsettled, chain unreadable:', e?.message);
            return this._set(record, PENDING_STATE.UNREADABLE);
        }
        if (landed) return this._set(record, PENDING_STATE.RESUMABLE);
        if (this.now() - (record.startedAt || 0) < PENDING_CREATE_MAX_AGE_MS) {
            return this._set(record, PENDING_STATE.WAITING);
        }
        if (this.running.has(record.basePath)) return PENDING_STATE.RUNNING;
        await this.host.remove(record.basePath);
        this.states.delete(record.basePath);
        Logger.info('Interrupted channel creation never reached the chain, dropped:', record.basePath);
        return PENDING_STATE.DISCARDED;
    }

    /** @returns {Promise<Map<string, string>>} basePath → PENDING_STATE */
    async reconcileAll() {
        const states = new Map();
        for (const record of this.list()) {
            states.set(record.basePath, await this.reconcile(record));
        }
        return states;
    }

    _set(record, state) {
        this.states.set(record.basePath, state);
        return state;
    }
}
