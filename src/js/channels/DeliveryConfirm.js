/**
 * Reads a published message back from storage until it is there. DMs are
 * never read back (the sender cannot read the peer's inbox), and a message
 * whose reads all failed stays sent: an unreachable node proves nothing.
 */

import { Logger } from '../logger.js';
import { CONFIG } from '../config.js';
import { streamrController } from '../streamr.js';
import { storageEndpoints } from '../storageEndpoints.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const UNDELIVERED_REASON = 'Not delivered: the storage node did not record this message';

export class DeliveryConfirm {
    /**
     * @param {Object} manager - the channel manager (notifyHandlers)
     * @param {Object} [options]
     * @param {(ms: number) => Promise<void>} [options.sleep] - injectable wait (tests)
     * @param {() => number} [options.now] - injectable clock (tests)
     */
    constructor(manager, { sleep: sleepImpl = sleep, now = () => Date.now() } = {}) {
        this.manager = manager;
        this.sleep = sleepImpl;
        this.now = now;
        this.inFlight = new Map();   // messageStreamId → Map<messageId, entry>
        this.loops = new Map();      // messageStreamId → running loop
    }

    /**
     * Remember a publish that just went out and see it to storage.
     * @param {Object} channel - the channel published on
     * @param {Object} message - the timeline object, already marked sent
     * @param {Object} published - what the publish returned: envelope timestamp and on-wire publisher
     */
    track(channel, message, published) {
        if (!channel?.messageStreamId || !message?.id || channel.type === 'dm') return;
        const envelopeTs = Number(published?.timestamp
            ?? (typeof published?.getTimestamp === 'function' ? published.getTimestamp() : NaN));
        if (!Number.isFinite(envelopeTs) || envelopeTs <= 0) return;
        const publisherId = String(published?.publisherId
            ?? published?.messageId?.publisherId
            ?? (typeof published?.getPublisherId === 'function' ? published.getPublisherId() : '')
        ).toLowerCase();
        const streamId = channel.messageStreamId;
        if (!this.inFlight.has(streamId)) this.inFlight.set(streamId, new Map());
        this.inFlight.get(streamId).set(message.id, {
            message, envelopeTs, publisherId, since: this.now(), reads: 0, verified: false
        });
        this._ensureLoop(streamId);
    }

    /** Messages of a channel still waiting for storage. */
    pending(messageStreamId) {
        return this.inFlight.get(messageStreamId)?.size ?? 0;
    }

    _ensureLoop(messageStreamId) {
        if (this.loops.has(messageStreamId)) return this.loops.get(messageStreamId);
        const run = this._loop(messageStreamId)
            .catch((e) => Logger.warn('delivery confirmation stopped:', e?.message))
            .finally(() => this.loops.delete(messageStreamId));
        this.loops.set(messageStreamId, run);
        return run;
    }

    async _loop(messageStreamId) {
        const delays = CONFIG.subscriptions.deliveryConfirmDelaysMs;
        const label = `delivery on ${messageStreamId.slice(-20)}`;
        let providers = null;
        try { providers = await storageEndpoints.resolve(messageStreamId); }
        catch (e) { Logger.debug(`${label}: storage providers unresolved (${e?.message}), reading anyway`); }
        if (providers && providers.length === 0) {
            this.inFlight.delete(messageStreamId);
            Logger.debug(`${label}: the channel has no storage, nothing to confirm`);
            return;
        }
        const due = (entry) => entry.since + delays.slice(0, entry.reads + 1).reduce((a, b) => a + b, 0);
        const entries = this.inFlight.get(messageStreamId);
        while (entries && entries.size > 0) {
            let next = Infinity;
            for (const entry of entries.values()) next = Math.min(next, due(entry));
            const wait = next - this.now();
            if (wait > 0) await this.sleep(wait);
            const all = [...entries.values()];
            const dueNow = all.filter((entry) => due(entry) <= this.now());
            if (dueNow.length === 0) continue;

            let rows = null;
            try {
                rows = await streamrController.resendMessageEnvelopes(messageStreamId, {
                    from: Math.min(...all.map((entry) => entry.envelopeTs)) - 1,
                    to: Math.max(...all.map((entry) => entry.envelopeTs)) + 1
                });
            } catch (e) {
                Logger.debug(`${label}: confirmation read failed:`, e?.message);
            }
            for (const entry of dueNow) entry.reads += 1;
            if (rows) {
                for (const entry of all) {
                    entry.verified = true;
                    const landed = rows.some((row) => row.timestamp === entry.envelopeTs
                        && (!entry.publisherId || !row.publisherId || row.publisherId === entry.publisherId));
                    if (!landed) continue;
                    entries.delete(entry.message.id);
                    this._settle(messageStreamId, entry.message, 'delivered');
                }
            }
            for (const entry of dueNow) {
                if (!entries.has(entry.message.id) || entry.reads < delays.length) continue;
                entries.delete(entry.message.id);
                if (entry.verified) {
                    this._settle(messageStreamId, entry.message, 'undelivered');
                } else {
                    Logger.warn(`${label}: ${entry.message.id} unverifiable, storage never answered`);
                }
            }
        }
        this.inFlight.delete(messageStreamId);
    }

    _settle(messageStreamId, message, outcome) {
        if (outcome === 'delivered') {
            message.delivered = true;
            Logger.debug(`delivery: ${message.id} confirmed on storage`);
            this.manager.notifyHandlers('message_delivered', { streamId: messageStreamId, messageId: message.id, message });
            return;
        }
        message.failed = true;
        message.undelivered = true;
        message.failError = UNDELIVERED_REASON;
        Logger.warn(`delivery: ${message.id} never reached storage`);
        this.manager.notifyHandlers('message_failed', {
            streamId: messageStreamId, messageId: message.id, message, error: UNDELIVERED_REASON
        });
    }
}
