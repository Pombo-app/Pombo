/**
 * A storage provider holds only what is published after the stream is assigned
 * to it: one added to a live channel lacks the -4 key anchors and the -3 until
 * the owner publishes them again.
 */

import { Logger } from '../logger.js';
import { CONFIG } from '../config.js';
import { streamrController, STREAM_CONFIG, deriveAdminId } from '../streamr.js';
import { authManager } from '../auth.js';
import { storageEndpoints } from '../storageEndpoints.js';
import { storedOn } from '../storagePurge.js';
import { epochKeyManager, usesEpochKeys } from '../epochKeyManager.js';

const STORAGE_KEY = 'pombo_storage_copy_pending';
const ADMIN = STREAM_CONFIG.ADMIN_STREAM;
const ITEMS = ['keys', 'admin', 'image', 'password'];
const READ_TIMEOUT_MS = 15000;
// The SDK picks a provider per read: a few tries find the one still holding it.
const IMAGE_READ_ATTEMPTS = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class StorageCopy {
    constructor(manager, { sleep: sleepImpl = sleep } = {}) {
        this.manager = manager;
        this.sleep = sleepImpl;
        this.runs = new Map();   // `${messageStreamId}|${node}` → running copy
    }

    /** The channel, when this account owns it: nobody else may publish any of it. */
    _ownedChannel(messageStreamId) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel || channel.type === 'dm') return null;
        return this.manager.isChannelOwner(messageStreamId) ? channel : null;
    }

    _adminStreamId(channel) {
        return channel.adminStreamId || deriveAdminId(channel.messageStreamId);
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
        catch (e) { Logger.debug('storage copy pending persist failed:', e?.message); }
    }

    pending(messageStreamId) {
        const nodes = this._loadMap()[this._key(messageStreamId)];
        return Array.isArray(nodes) ? nodes : [];
    }

    _setPending(messageStreamId, node, waiting) {
        const map = this._loadMap();
        const key = this._key(messageStreamId);
        const nodes = new Set(Array.isArray(map[key]) ? map[key] : []);
        if (waiting) nodes.add(node); else nodes.delete(node);
        if (nodes.size > 0) map[key] = [...nodes]; else delete map[key];
        this._saveMap(map);
    }

    /** Must run before the provider is added: once assigned, a read can land on it and find nothing. */
    async prepare(messageStreamId) {
        const channel = this._ownedChannel(messageStreamId);
        if (!channel) return null;
        const adminStreamId = this._adminStreamId(channel);
        const password = channel.password || null;
        if (!channel.adminLoaded) {
            await this.manager.bootstrapAdminState(messageStreamId, adminStreamId, password)
                .catch((e) => Logger.warn('storage copy: admin state not loaded:', e?.message));
        }
        if (usesEpochKeys(channel)) epochKeyManager.loadPersistedState(messageStreamId);
        return { image: await this._readImage(channel, 1) };
    }

    /** @returns {Promise<'present'|'unverifiable'|'missing'|'gone'|'failed'>} */
    copyTo(messageStreamId, nodeAddress, snapshot) {
        const node = String(nodeAddress).toLowerCase();
        const key = `${messageStreamId}|${node}`;
        if (this.runs.has(key)) return this.runs.get(key);
        this._setPending(messageStreamId, node, true);
        const run = this._copy(messageStreamId, node, snapshot)
            .catch((e) => {
                Logger.warn('storage copy stopped:', e?.message);
                return 'failed';
            })
            .finally(() => this.runs.delete(key));
        this.runs.set(key, run);
        return run;
    }

    resume(messageStreamId) {
        const nodes = this.pending(messageStreamId);
        if (nodes.length === 0 || !this._ownedChannel(messageStreamId)) return Promise.resolve();
        return this.prepare(messageStreamId)
            .then((snapshot) => Promise.all(nodes.map((node) => this.copyTo(messageStreamId, node, snapshot))))
            .catch((e) => Logger.warn('storage copy resume failed:', e?.message));
    }

    async ensureRemainingHold(messageStreamId, leavingAddress) {
        const channel = this._ownedChannel(messageStreamId);
        if (!channel) return;
        const leaving = String(leavingAddress).toLowerCase();
        const lacking = await this._lacking(channel, leaving);
        if (lacking.size === 0) return;

        this.manager.notifyHandlers('storage_copy_before_remove', { streamId: messageStreamId });
        const snapshot = { image: await this._readImage(channel) };
        for (const node of lacking) await this.copyTo(messageStreamId, node, snapshot);
        if ((await this._lacking(channel, leaving)).size > 0) {
            throw new Error('The storage provider that stays does not hold this channel\'s keys and settings yet, '
                + 'so the old one was not removed. Try again in a minute.');
        }
    }

    async _lacking(channel, leaving) {
        const adminStreamId = this._adminStreamId(channel);
        const keyIds = epochKeyManager.currentAnchorKeyIds(channel);
        const checks = [
            // The -3 is judged against the leaving provider itself: whatever
            // it serves there must still be served once it is gone.
            ...[ADMIN.MODERATION, ADMIN.CHANNEL_IMAGE, ADMIN.PASSWORD_CHALLENGE].map((partition) => ({
                streamId: adminStreamId,
                partition,
                count: 1,
                expected: async (gone) => {
                    const rows = await this._readLast(gone, adminStreamId, partition, 1);
                    if (rows) return rows.length > 0;
                    return partition === ADMIN.MODERATION ? (channel.adminRev || 0) > 0
                        : partition === ADMIN.PASSWORD_CHALLENGE && channel.type === 'password';
                },
                holds: (rows) => rows.length > 0
            }))
        ];
        if (keyIds.length > 0) {
            checks.push({
                streamId: channel.keysStreamId,
                partition: STREAM_CONFIG.KEYS_STREAM.KEY_EXCHANGE,
                count: 1000,
                expected: async () => true,
                holds: (rows) => keyIds.every((keyId) => rows.some((r) => r.content?.keyId === keyId))
            });
        }

        const lacking = new Set();
        for (const check of checks) {
            let providers;
            try {
                providers = await storageEndpoints.resolveFresh(check.streamId);
            } catch (e) {
                Logger.warn('storage copy: providers of', check.streamId.slice(-20), 'unknown:', e?.message);
                throw new Error('Could not check which storage providers this channel has, '
                    + 'so the old one was not removed. Try again in a minute.');
            }
            const gone = providers.find((p) => p.nodeAddress === leaving);
            const staying = providers.filter((p) => p.nodeAddress !== leaving);
            if (!gone) continue;
            if (staying.length === 0) {
                // The Graph can still miss a provider added moments ago; its pending copy names it.
                if (this.pending(channel.messageStreamId).some((node) => node !== leaving)) {
                    throw new Error('The copy to the new storage provider is not confirmed yet, '
                        + 'so the old one was not removed. Try again in a minute.');
                }
                continue;
            }
            if (!(await check.expected(gone))) continue;
            for (const provider of staying) {
                const rows = await this._readLast(provider, check.streamId, check.partition, check.count);
                const holds = !!rows && check.holds(rows);
                Logger.debug(`storage copy: ${provider.nodeAddress.slice(0, 10)} ${holds ? 'holds' : 'lacks'} `
                    + `${check.streamId.slice(-20)} P${check.partition}`);
                if (!holds) lacking.add(provider.nodeAddress);
            }
        }
        return lacking;
    }

    // Never through the SDK: its reads fail over to another provider, and this
    // answer has to come from this one.
    async _readLast(provider, streamId, partition, count) {
        for (const url of provider.urls) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), READ_TIMEOUT_MS);
            try {
                const resp = await fetch(
                    `${url}/streams/${encodeURIComponent(streamId)}/data/partitions/${partition}/last?count=${count}`,
                    { signal: ctrl.signal });
                if (!resp.ok) continue;
                const rows = await resp.json();
                if (!Array.isArray(rows)) continue;
                return rows.map((r) => {
                    if (typeof r?.content !== 'string') return r;
                    try { return { ...r, content: JSON.parse(r.content) }; } catch { return r; }
                });
            } catch (e) {
                Logger.debug(`storage copy: read at ${url} failed:`, e?.message);
            } finally {
                clearTimeout(timer);
            }
        }
        return null;
    }

    async _readImage(channel, attempts = IMAGE_READ_ATTEMPTS) {
        for (let i = 0; i < attempts; i++) {
            const image = await streamrController.resendChannelImage(this._adminStreamId(channel),
                { password: channel.password || null }).catch(() => null);
            if (image?.data && image?.hash) return image;
        }
        return null;
    }

    async _copy(messageStreamId, node, snapshot) {
        const label = `storage copy of ${messageStreamId.slice(-20)} to ${node.slice(0, 10)}`;
        let items = new Set(ITEMS);
        for (let round = 0; round <= CONFIG.subscriptions.storageCopyRepublishLimit; round++) {
            const channel = this._ownedChannel(messageStreamId);
            if (!channel) {
                this._setPending(messageStreamId, node, false);
                return 'gone';
            }
            const published = await this._publish(channel, snapshot, items);
            if (published.length === 0) {
                this._setPending(messageStreamId, node, false);
                Logger.info(`${label}: nothing to copy`);
                return 'present';
            }
            for (const delay of CONFIG.subscriptions.storageCopyDelaysMs) {
                await this.sleep(delay);
                const { missing, unverifiable } = await this._lookUp(published, node);
                if (unverifiable) {
                    this._setPending(messageStreamId, node, false);
                    Logger.warn(`${label}: the provider does not answer which rows it holds`);
                    this.manager.notifyHandlers('storage_copy_unverifiable', { streamId: messageStreamId, node });
                    return 'unverifiable';
                }
                if (missing.size === 0) {
                    this._setPending(messageStreamId, node, false);
                    Logger.info(`${label} confirmed`);
                    this.manager.notifyHandlers('storage_copy_confirmed', { streamId: messageStreamId, node });
                    return 'present';
                }
                items = missing;
            }
            Logger.warn(`${label}: still missing ${[...items].join(', ')}, publishing again`);
        }
        Logger.warn(`${label} never confirmed, kept pending`);
        this.manager.notifyHandlers('storage_copy_unconfirmed', { streamId: messageStreamId, node });
        return 'missing';
    }

    /**
     * @returns {Promise<Array<{item: string, streamId: string, partition: number, timestamp: number, sequenceNumber: number}|{item: string, failed: true}>>}
     */
    async _publish(channel, snapshot, items) {
        const adminStreamId = this._adminStreamId(channel);
        const password = channel.password || null;
        const out = [];
        const row = (item, streamId, partition, message) => {
            const timestamp = Number(message?.timestamp);
            if (!(timestamp > 0)) return { item, failed: true };
            const sequenceNumber = Number(message?.sequenceNumber ?? message?.getSequenceNumber?.() ?? 0);
            return { item, streamId, partition, timestamp, sequenceNumber };
        };
        const attempt = async (item, publish) => {
            try {
                out.push(...await publish());
            } catch (e) {
                Logger.warn(`storage copy: ${item} not published:`, e?.message);
                out.push({ item, failed: true });
            }
        };

        if (items.has('keys') && usesEpochKeys(channel)) {
            await attempt('keys', async () => (await epochKeyManager.republishAnchors(channel))
                .map((ref) => ({ item: 'keys', streamId: channel.keysStreamId, ...ref })));
        }
        if (items.has('admin') && (channel.adminRev || 0) > 0) {
            await attempt('admin', async () => {
                const { published } = await this.manager.publishAdminState(channel.messageStreamId, {
                    state: channel.adminSnapshot || channel.adminState
                });
                return [row('admin', adminStreamId, ADMIN.MODERATION, published)];
            });
        }
        if (items.has('image') && snapshot?.image && !(snapshot.image.encrypted && !password)) {
            await attempt('image', async () => [row('image', adminStreamId, ADMIN.CHANNEL_IMAGE,
                await this.manager.ttlRepublish.republishImage(channel, adminStreamId, snapshot.image, password))]);
        }
        if (items.has('password') && channel.type === 'password' && password) {
            await attempt('password', async () => [row('password', adminStreamId, ADMIN.PASSWORD_CHALLENGE,
                await streamrController.publishPasswordChallenge(adminStreamId, password))]);
        }
        return out;
    }

    /**
     * A provider that answers without the `stored` endpoint can never say which
     * rows it holds; one that does not answer only has them missing for now.
     * @returns {Promise<{missing: Set<string>, unverifiable: boolean}>}
     */
    async _lookUp(published, node) {
        const missing = new Set(published.filter((p) => p.failed).map((p) => p.item));
        const groups = new Map();
        for (const p of published) {
            if (p.failed) continue;
            const key = `${p.streamId}|${p.partition}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(p);
        }
        const signer = { address: authManager.getAddress(), sign: (m) => authManager.signMessage(m) };
        for (const rows of groups.values()) {
            const { streamId, partition } = rows[0];
            let provider = null;
            try {
                provider = (await storageEndpoints.probeStream(streamId, { force: true }))
                    .find((p) => p.nodeAddress === node) || null;
            } catch (e) {
                Logger.debug('storage copy: providers unresolved:', e?.message);
            }
            if (provider && !provider.features.has('stored')) {
                if (provider.answered) return { missing, unverifiable: true };
                provider = null;
            }
            const present = provider
                ? await storedOn([{ nodeAddress: provider.nodeAddress, urls: provider.urls.filter((u) => storageEndpoints.hasFeature(u, 'stored')) }],
                    streamId, partition, rows.map(({ timestamp, sequenceNumber }) => ({ timestamp, sequenceNumber })), signer)
                : null;
            for (const r of rows) {
                if (!present?.has(`${r.timestamp}:${r.sequenceNumber}`)) missing.add(r.item);
            }
        }
        return { missing, unverifiable: false };
    }
}
