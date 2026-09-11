/**
 * Persistent File Sharing engine (storage-node transport).
 *
 * Ported from the index.storage.html POC (battle-tested: >1 MB/s uploads with
 * incremental verify & repair, resumable downloads). Reference engine with full
 * comments: extras/Stest.html. Differences from the POC:
 *
 *  - Partition mapping: chunks go on the channel's own message stream (-1),
 *    9 partitions starting at P2 (regular channels) / P4 (DM inboxes), chunk i →
 *    first + (i % 9). The announcement is a normal signed chat message on P0
 *    (type 'storage_file_announce') instead of a dedicated announce partition.
 *  - Storage node endpoints are resolved ON-CHAIN (storageEndpoints.js) instead
 *    of hardcoded URLs, and verify reads round-robin across every resolved node
 *    instead of pinning one.
 *  - Encryption (the POC had none): password channels seal each chunk with a
 *    per-FILE AES-GCM key (one PBKDF2; the salt travels in the signed announce),
 *    DMs seal with the pair's ECDH key. Public channels stay plaintext.
 *    SEALING NOTE: chat messages keep going through the publishContent single
 *    sealing point; chunks are the documented exception — they encrypt here
 *    with the per-file key (a per-message salt would cost one 310k-iteration
 *    PBKDF2 per chunk — minutes of pure key derivation on a big file).
 *  - Compression uses native CompressionStream/DecompressionStream ('deflate',
 *    zlib format — same wire format as the POC's pako default) so no new
 *    dependency enters the bundle. Browsers without it send files raw.
 *
 * Wire format per chunk (before sealing), identical to the POC:
 *   [4B metaLen BE][metaLen bytes meta JSON][4B totalChunks BE][4B chunkIndex BE][data]
 * Sealed channels wrap the WHOLE packed payload: [12B iv][ciphertext+authTag]
 * (transferId/index leak nothing when the header is inside the ciphertext).
 *
 * Download reads storage nodes over direct HTTP (streaming JSON parse) with an
 * SDK-resend fallback. DM transfers use the SDK-resend path exclusively: the
 * inbox stream is private at the Streamr layer, so direct HTTP would return
 * SDK-level ciphertext; upload verification still works over HTTP because it
 * matches publish TIMESTAMPS, never content.
 */

import { CONFIG as APP_CONFIG } from './config.js';
import { Logger } from './logger.js';
import { cryptoManager } from './crypto.js';
import { dmCrypto } from './dmCrypto.js';
import { authManager } from './auth.js';
import { identityManager } from './identity.js';
import { secureStorage } from './secureStorage.js';
import { streamrController } from './streamr.js';
import { storageEndpoints } from './storageEndpoints.js';
import { channelManager } from './channels.js';
import { getChannelIdentity } from './channelIdentity.js';
import { dmManager } from './dm.js';
import { STORAGE_FILE, MESSAGE_STREAM, storageChunkPartition } from './streamConstants.js';
import { storedOn, keySigner } from './storagePurge.js';
import { epochKeyManager, usesEpochKeys } from './epochKeyManager.js';
import { epochKeyCrypto } from './epochKeyCrypto.js';

const SM = APP_CONFIG.storageMedia;
const SEAL_OVERHEAD = 28;              // [12B iv] + 16B GCM tag
const RATE_WINDOW_MS = SM.rateWindowMs;
const RESUME_KEY_PREFIX = 'pomboStorageResume_';
const OPFS_PREFIX = 'psf_';

// ================= PURE HELPERS (exported for tests) =================

/**
 * Pack a chunk payload: [4B metaLen][meta][4B totalChunks][4B chunkIndex][data].
 * @param {Uint8Array} metaBytes - UTF-8 encoded chunk meta JSON
 * @param {number} totalChunks
 * @param {number} chunkIndex
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function packChunkPayload(metaBytes, totalChunks, chunkIndex, data) {
    const pay = new Uint8Array(4 + metaBytes.length + 4 + 4 + data.length);
    const v = new DataView(pay.buffer);
    let o = 0;
    v.setUint32(o, metaBytes.length, false); o += 4;
    pay.set(metaBytes, o); o += metaBytes.length;
    v.setUint32(o, totalChunks, false); o += 4;
    v.setUint32(o, chunkIndex, false); o += 4;
    pay.set(data, o);
    return pay;
}

/**
 * Unpack a chunk payload. Returns null on anything that is not a well-formed
 * binary_file_chunked v2 payload (warm-up pings, foreign messages…).
 * @param {Uint8Array} bin
 * @returns {{meta: Object, totalChunks: number, chunkIndex: number, chunkData: Uint8Array}|null}
 */
export function unpackChunkPayload(bin) {
    try {
        const d = bin instanceof Uint8Array ? bin : new Uint8Array(bin);
        if (d.length < 8) return null;
        const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
        const ml = v.getUint32(0, false);
        if (ml <= 0 || ml > d.length - 4) return null;
        const mb = d.slice(4, 4 + ml);
        const m = JSON.parse(new TextDecoder().decode(mb));
        if (m.type !== 'binary_file_chunked' || m.version !== 2) return null;
        if (d.length < 4 + ml + 4 + 4) return null;
        const totalChunks = v.getUint32(4 + ml, false);
        const chunkIndex = v.getUint32(4 + ml + 4, false);
        const chunkData = d.slice(4 + ml + 8);
        return { meta: m, totalChunks, chunkIndex, chunkData };
    } catch (e) {
        return null;
    }
}

/**
 * Fast hex → bytes (storage-node HTTP API returns binary contents hex-encoded,
 * contentType 1).
 */
export function hexToU8(hex) {
    const n = hex.length >> 1;
    const out = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 2) {
        const hi = hex.charCodeAt(j), lo = hex.charCodeAt(j + 1);
        out[i] = ((((hi & 0xf) + ((hi >> 6) * 9)) << 4) | ((lo & 0xf) + ((lo >> 6) * 9)));
    }
    return out;
}

/** Partition of chunk i per an announce's metadata (reader trusts the announce). */
export function partitionOfChunk(meta, i) {
    return storageChunkPartition(
        i,
        meta.firstChunkPartition ?? STORAGE_FILE.FIRST_CHUNK_PARTITION,
        meta.chunkPartitions ?? STORAGE_FILE.CHUNK_PARTITIONS
    );
}

/** One {partition, from, to} window per chunk partition of the announce. */
export function chunkWindowsFor(meta, fromT, toT) {
    const first = meta.firstChunkPartition ?? STORAGE_FILE.FIRST_CHUNK_PARTITION;
    const count = meta.chunkPartitions ?? STORAGE_FILE.CHUNK_PARTITIONS;
    return Array.from({ length: count }, (_, k) => ({ partition: first + k, from: fromT, to: toT }));
}

/** Merge overlapping same-partition windows (input must be sortable). */
export function mergeWindows(raw) {
    const sorted = [...raw].sort((a, b) => (a.partition - b.partition) || (a.from - b.from));
    const windows = [];
    for (const w of sorted) {
        const last = windows[windows.length - 1];
        if (last && w.partition === last.partition && w.from <= last.to) {
            last.to = Math.max(last.to, w.to);
        } else {
            windows.push({ ...w });
        }
    }
    return windows;
}

/**
 * Narrow re-request windows for missing chunks, estimated linearly between the
 * announced first/last chunk timestamps, merged per partition, plus a tail
 * window for chunks republished by verify & repair. Falls back to full ranges
 * when the estimate cannot work.
 */
export function buildMissingWindows(meta, missing, fromT, toT) {
    if (!meta.firstChunkTs || !meta.lastChunkTs || meta.totalChunks <= 1 || missing.length > meta.totalChunks * 0.3) {
        return chunkWindowsFor(meta, fromT, toT);
    }
    const interval = (meta.lastChunkTs - meta.firstChunkTs) / (meta.totalChunks - 1);
    const PAD = 30000;
    const raw = missing.map(i => {
        const est = meta.firstChunkTs + i * interval;
        return { partition: partitionOfChunk(meta, i), from: est - PAD, to: est + PAD };
    });
    const windows = mergeWindows(raw);
    const tailParts = new Set(missing.map(i => partitionOfChunk(meta, i)));
    for (const p of tailParts) windows.push({ partition: p, from: meta.lastChunkTs - 5000, to: toT });
    return windows;
}

// ================= ENVIRONMENT HELPERS =================

const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';

// Timer worker: setTimeout is throttled to 1/min in hidden tabs; a worker is not.
let timerWorker = null, timerSeq = 0;
const timerCbs = new Map();
function getTimerWorker() {
    if (timerWorker === null) {
        try {
            const src = 'onmessage=e=>{const{id,ms}=e.data;setTimeout(()=>postMessage(id),ms)}';
            timerWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
            timerWorker.onmessage = (e) => { const cb = timerCbs.get(e.data); if (cb) { timerCbs.delete(e.data); cb(); } };
            timerWorker.onerror = () => { timerWorker = false; };
        } catch (e) { timerWorker = false; }
    }
    return timerWorker;
}
function sleep(ms) {
    return new Promise(r => {
        const w = (ms > 0 && hasDom && document.hidden) ? getTimerWorker() : null;
        if (w) { const id = ++timerSeq; timerCbs.set(id, r); w.postMessage({ id, ms }); }
        else setTimeout(r, ms);
    });
}

// Sliding-window rate over the last RATE_WINDOW_MS: hist holds {time, value}
// samples of a monotonic counter. `now` caps the window so a stall drags the
// rate down instead of freezing it.
function windowedRate(hist, now, field = 'value') {
    if (!hist || hist.length < 2) return null;
    const cutoff = now - RATE_WINDOW_MS;
    while (hist.length > 2 && hist[1].time <= cutoff) hist.shift();
    const first = hist[0];
    const last = hist[hist.length - 1];
    const span = (Math.max(now, last.time) - first.time) / 1000;
    if (span < 1) return null;
    return (last[field] - first[field]) / span;
}

// Instant rate over the last ~1.5s of a {time, <field>} history (the POC's
// "hot" speed badge), vs windowedRate's smoother 10s average.
function instantRate(hist, now, field = 'bytes', windowMs = 1500) {
    if (!hist || hist.length < 2) return null;
    const cutoff = now - windowMs;
    let first = hist[0];
    for (let i = hist.length - 1; i >= 0; i--) {
        if (hist[i].time <= cutoff) { first = hist[i]; break; }
    }
    const last = hist[hist.length - 1];
    const span = (last.time - first.time) / 1000;
    if (span < 0.2) return null;
    return (last[field] - first[field]) / span;
}

function genId() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * qt-faststart in pure JS: moves the moov atom before mdat and patches the
 * stco/co64 offset tables so the browser can play the file progressively
 * (part of the POC's FIXED upload flow — runs on every MP4-like upload before
 * chunking; the download side merely consumes the resulting layout).
 * Returns { blob, changed, reason } — a virtual Blob of slices, zero mdat
 * copy; falls back to the original file on any doubt.
 * @param {Blob|File} file
 */
export async function makeFaststartSource(file) {
    const bail = (reason) => ({ blob: file, changed: false, reason });
    try {
        const boxes = [];
        let pos = 0;
        while (pos + 8 <= file.size) {
            const hdr = new DataView(await file.slice(pos, Math.min(pos + 16, file.size)).arrayBuffer());
            let size = hdr.getUint32(0, false);
            const type = String.fromCharCode(hdr.getUint8(4), hdr.getUint8(5), hdr.getUint8(6), hdr.getUint8(7));
            if (size === 1) {
                if (hdr.byteLength < 16) return bail('truncated 64-bit box');
                size = hdr.getUint32(8, false) * 4294967296 + hdr.getUint32(12, false);
            } else if (size === 0) {
                size = file.size - pos;
            }
            if (size < 8 || pos + size > file.size) return bail(`invalid box '${type}'`);
            boxes.push({ type, pos, size });
            pos += size;
        }
        const ftyp = boxes.find(b => b.type === 'ftyp');
        const moov = boxes.find(b => b.type === 'moov');
        const mdat = boxes.find(b => b.type === 'mdat');
        if (!moov || !mdat) return bail('no moov/mdat — not a classic MP4');
        if (moov.pos < mdat.pos) return bail('already faststart');
        if (boxes.some(b => b.type === 'mdat' && b.pos > moov.pos)) return bail('mdat after moov — unsupported layout');

        const moovBuf = new Uint8Array(await file.slice(moov.pos, moov.pos + moov.size).arrayBuffer());
        const dv = new DataView(moovBuf.buffer);
        const delta = moov.size;
        const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'mvex']);
        let overflow = false, cmov = false, patched = 0;
        const walk = (start, end) => {
            let p = start;
            while (p + 8 <= end && !overflow && !cmov) {
                let size = dv.getUint32(p, false);
                const type = String.fromCharCode(moovBuf[p + 4], moovBuf[p + 5], moovBuf[p + 6], moovBuf[p + 7]);
                let hs = 8;
                if (size === 1) { size = dv.getUint32(p + 8, false) * 4294967296 + dv.getUint32(p + 12, false); hs = 16; }
                else if (size === 0) size = end - p;
                if (size < hs || p + size > end) return;
                if (type === 'cmov') { cmov = true; return; }
                if (type === 'stco') {
                    const n = dv.getUint32(p + hs + 4, false);
                    for (let i = 0; i < n; i++) {
                        const o = p + hs + 8 + i * 4;
                        const v = dv.getUint32(o, false) + delta;
                        if (v > 0xFFFFFFFF) { overflow = true; return; }
                        dv.setUint32(o, v, false);
                    }
                    patched++;
                } else if (type === 'co64') {
                    const n = dv.getUint32(p + hs + 4, false);
                    for (let i = 0; i < n; i++) {
                        const o = p + hs + 8 + i * 8;
                        const v = dv.getUint32(o, false) * 4294967296 + dv.getUint32(o + 4, false) + delta;
                        dv.setUint32(o, Math.floor(v / 4294967296), false);
                        dv.setUint32(o + 4, v % 4294967296, false);
                    }
                    patched++;
                } else if (CONTAINERS.has(type)) {
                    walk(p + hs, p + size);
                }
                p += size;
            }
        };
        const moovHs = dv.getUint32(0, false) === 1 ? 16 : 8;
        walk(moovHs, moov.size);
        if (cmov) return bail('compressed moov (cmov) not supported');
        if (overflow) return bail('offsets would exceed 32 bits after patching');

        const parts = [];
        const ftypEnd = ftyp ? ftyp.pos + ftyp.size : 0;
        if (ftypEnd > 0) parts.push(file.slice(0, ftypEnd));
        parts.push(moovBuf);
        for (const b of boxes) {
            if (b === moov || b.pos < ftypEnd) continue;
            parts.push(file.slice(b.pos, b.pos + b.size));
        }
        return {
            blob: new Blob(parts, { type: file.type || 'video/mp4' }),
            changed: true,
            reason: `moov (${Math.round(moov.size / 1024)}KB) moved to the front · ${patched} offset table(s) patched`
        };
    } catch (e) {
        return bail(`parse error: ${e.message}`);
    }
}

const isMp4Like = (file) =>
    /\.(mp4|m4v|mov)$/i.test(file.name || '') || /video\/(mp4|quicktime)/i.test(file.type || '');

// Media/archives are already compressed — deflate gains ~0%. Those go raw:
// chunk N = bytes N*upc..(N+1)*upc of the file.
function shouldCompress(file) {
    if (typeof CompressionStream === 'undefined') return false;
    const t = (file.type || '').toLowerCase();
    if (/^(video|audio)\//.test(t)) return false;
    if (/^image\//.test(t) && !/svg|bmp|tiff/.test(t)) return false;
    if (/zip|gzip|compressed|x-7z|x-rar|x-bzip/.test(t)) return false;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return !['mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac',
        'jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'avif', 'zip', 'gz', '7z', 'rar', 'bz2', 'xz', 'zst'].includes(ext);
}

// Streamr publish() is fire-and-forget: resolving does NOT guarantee delivery
// or persistence. This retry only covers local/connection errors; persistence
// is confirmed later by verify & repair.
async function publishChunkWithRetry(streamId, partition, payload, attempts = 3, identity = null) {
    let lastErr;
    for (let a = 0; a < attempts; a++) {
        try { return await streamrController.publishStorageChunk(streamId, partition, payload, identity); }
        catch (e) { lastErr = e; await sleep(500 * (a + 1)); }
    }
    throw lastErr;
}

// ================= SCTP/WS RADAR + BACKPRESSURE =================
// Hooks the RTCDataChannels/WebSockets the SDK creates and watches the real
// outbound queue (bufferedAmount). publish() resolves into an internal buffer,
// so "bytes sent" lies above the uplink; the outbound queue does not.
const dcRadar = { channels: new Set(), sockets: new Set(), peakQ: 0, throttled: false, throttleCount: 0, lastWarnT: 0, installed: false };
function installDcRadar() {
    if (dcRadar.installed || typeof RTCPeerConnection === 'undefined') return;
    dcRadar.installed = true;
    const seenPc = new WeakSet();
    const track = (dc) => { if (dc && !dcRadar.channels.has(dc)) { dcRadar.channels.add(dc); dc.addEventListener('close', () => dcRadar.channels.delete(dc)); } };
    const hookPc = (pc) => { if (!seenPc.has(pc)) { seenPc.add(pc); pc.addEventListener('datachannel', (e) => track(e.channel)); } };
    const origCreate = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...a) { hookPc(this); const dc = origCreate.apply(this, a); track(dc); return dc; };
    const OrigPC = window.RTCPeerConnection;
    const Wrapped = function (...a) { const pc = new OrigPC(...a); hookPc(pc); return pc; };
    Wrapped.prototype = OrigPC.prototype;
    Object.setPrototypeOf(Wrapped, OrigPC);
    window.RTCPeerConnection = Wrapped;

    const hookSend = (proto, set) => {
        if (!proto || typeof proto.send !== 'function') return;
        const orig = proto.send;
        proto.send = function (...a) {
            if (!set.has(this)) { set.add(this); try { this.addEventListener('close', () => set.delete(this)); } catch (e) { /* not an EventTarget */ } }
            return orig.apply(this, a);
        };
    };
    hookSend(typeof RTCDataChannel !== 'undefined' && RTCDataChannel.prototype, dcRadar.channels);
    hookSend(typeof WebSocket !== 'undefined' && WebSocket.prototype, dcRadar.sockets);
}
if (hasDom) installDcRadar();

const dcQueuedBytes = () => {
    let q = 0;
    for (const dc of dcRadar.channels) { try { if (dc.readyState === 'open') q += dc.bufferedAmount; } catch (e) { /* detached */ } }
    for (const ws of dcRadar.sockets) { try { if (ws.readyState === 1) q += ws.bufferedAmount; } catch (e) { /* detached */ } }
    return q;
};

// Hard backpressure: queue > HIGH pauses ALL sends until < LOW. Caps overshoot
// at ~0.3s of uplink and makes silent SCTP-overflow losses impossible.
const DC_QUEUE_HIGH = 1.5 * 1024 * 1024, DC_QUEUE_LOW = 384 * 1024;
async function dcBackpressure() {
    const q = dcQueuedBytes();
    if (q > dcRadar.peakQ) dcRadar.peakQ = q;
    if (q < DC_QUEUE_HIGH) return;
    dcRadar.throttled = true;
    dcRadar.throttleCount++;
    if (Date.now() - dcRadar.lastWarnT > 5000) {
        dcRadar.lastWarnT = Date.now();
        Logger.warn(`Storage upload: wire saturated (outbound queue ${Math.round(dcQueuedBytes() / 1024)}KB) — sends paused until it drains`);
    }
    while (dcQueuedBytes() > DC_QUEUE_LOW) await sleep(50);
}

// ================= OPFS (disk staging) =================

let opfsDirPromise = null;
function getOpfsDir() {
    if (!opfsDirPromise) {
        opfsDirPromise = (async () => {
            try {
                if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) return null;
                const dir = await navigator.storage.getDirectory();
                const probe = await dir.getFileHandle('__psf_probe', { create: true });
                const w = await probe.createWritable();
                await w.close();
                await dir.removeEntry('__psf_probe');
                return dir;
            } catch (e) {
                opfsDirPromise = null;
                Logger.warn(`Storage transfer: OPFS unavailable (${e.message}) — memory fallback for this operation`);
                return null;
            }
        })();
    }
    return opfsDirPromise;
}

async function opfsCreate(name, presetSize) {
    const dir = await getOpfsDir();
    if (!dir) return null;
    try {
        const handle = await dir.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        if (presetSize) await writable.truncate(presetSize);
        return { handle, writable };
    } catch (e) {
        Logger.warn(`opfsCreate(${name}) failed: ${e.message} — falling back to memory`);
        return null;
    }
}

async function opfsDelete(name) {
    try { const dir = await getOpfsDir(); if (dir) await dir.removeEntry(name); } catch (e) { /* already gone */ }
}

async function opfsOpenExisting(name) {
    const dir = await getOpfsDir();
    if (!dir) return null;
    try {
        const handle = await dir.getFileHandle(name);
        const file = await handle.getFile();
        const writable = await handle.createWritable({ keepExistingData: true });
        return { handle, writable, size: file.size };
    } catch (e) { return null; }
}

/**
 * OPFS writer in a WORKER with a sync access handle — download staging.
 * createWritable({keepExistingData}) copies the whole (pre-allocated) file on
 * every resume checkpoint (O(n^2) I/O); the sync handle writes in place off the
 * main thread and checkpoints with an O(1) flush(). Returns null when unavailable.
 */
async function opfsCreateWorkerWriter(name, size, resume) {
    if (typeof Worker === 'undefined') return null;
    const dir = await getOpfsDir();
    if (!dir) return null;
    let handle;
    try { handle = await dir.getFileHandle(name, { create: !resume }); } catch (e) { return null; }
    const src = `
        let sync = null;
        onmessage = async (e) => {
            const d = e.data;
            try {
                if (d.init) {
                    const root = await navigator.storage.getDirectory();
                    const h = await root.getFileHandle(d.name, { create: true });
                    let mode = 'unsafe';
                    try { sync = await h.createSyncAccessHandle({ mode: 'readwrite-unsafe' }); }
                    catch (err) { mode = 'exclusive'; try { sync = await h.createSyncAccessHandle(); } catch (err2) { sync = null; } }
                    if (!sync) { postMessage({ type: 'init', ok: false }); return; }
                    if (!d.resume && d.size) sync.truncate(d.size);
                    postMessage({ type: 'init', ok: true, mode, size: sync.getSize() });
                } else if (d.type === 'write') {
                    const n = sync.write(d.data, { at: d.pos });
                    if (n !== d.data.length) throw new Error('short write: ' + n + '/' + d.data.length);
                    postMessage({ type: 'ack', bytes: d.data.length });
                } else if (d.type === 'flush') { sync.flush(); postMessage({ type: 'flushed' }); }
                else if (d.type === 'close') { sync.flush(); sync.close(); postMessage({ type: 'closed' }); }
                else if (d.type === 'abort') { try { if (sync) sync.close(); } catch (err) {} postMessage({ type: 'closed' }); }
            } catch (err) {
                postMessage({ type: 'error', message: String(err && err.message || err) });
                if (d && d.type === 'write') postMessage({ type: 'ack', bytes: d.data ? d.data.length : 0 });
                if (d && (d.type === 'close' || d.type === 'abort')) postMessage({ type: 'closed' });
            }
        };
    `;
    let w;
    try { w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); }
    catch (e) { return null; }
    return await new Promise((resolveInit) => {
        let pending = 0, errored = null, errCb = null;
        let drainWaiters = [], flushWaiters = [], closeWaiters = [];
        const fail = (msg) => {
            if (!errored) { errored = new Error(msg); if (errCb) errCb(errored); }
            drainWaiters.splice(0).forEach(x => x.res());
            flushWaiters.splice(0).forEach(res => res());
            closeWaiters.splice(0).forEach(res => res());
        };
        const st = {
            handle,
            size: 0,
            syncMode: null,
            pending: () => pending,
            onError: (fn) => { errCb = fn; if (errored) fn(errored); },
            drainBelow: (limit) => (pending <= limit || errored) ? Promise.resolve() : new Promise(res => drainWaiters.push({ limit, res })),
            flush: () => errored ? Promise.reject(errored) : new Promise((res) => { flushWaiters.push(res); w.postMessage({ type: 'flush' }); }),
            writable: {
                write: (op) => {
                    if (errored) return Promise.reject(errored);
                    pending += op.data.length;
                    try { w.postMessage({ type: 'write', pos: op.position, data: op.data }, [op.data.buffer]); }
                    catch (e) { w.postMessage({ type: 'write', pos: op.position, data: op.data }); }
                    return Promise.resolve();
                },
                close: () => new Promise((res) => { closeWaiters.push(res); w.postMessage({ type: 'close' }); setTimeout(res, 120000); }).then(() => { try { w.terminate(); } catch (e) { /* gone */ } }),
                abort: () => new Promise((res) => { closeWaiters.push(res); w.postMessage({ type: 'abort' }); setTimeout(res, 10000); }).then(() => { try { w.terminate(); } catch (e) { /* gone */ } })
            }
        };
        w.onerror = (e) => { resolveInit(null); fail((e && e.message) || 'worker error'); };
        w.onmessage = (e) => {
            const d = e.data;
            if (d.type === 'init') {
                if (!d.ok) { try { w.terminate(); } catch (e2) { /* gone */ } resolveInit(null); return; }
                st.syncMode = d.mode; st.size = d.size;
                resolveInit(st);
            } else if (d.type === 'ack') {
                pending -= d.bytes;
                drainWaiters = drainWaiters.filter(x => { if (pending <= x.limit) { x.res(); return false; } return true; });
            } else if (d.type === 'flushed') { const f = flushWaiters.shift(); if (f) f(); }
            else if (d.type === 'closed') { closeWaiters.splice(0).forEach(res => res()); }
            else if (d.type === 'error') { resolveInit(null); fail(d.message); }
        };
        w.postMessage({ init: true, name, size: size || 0, resume: !!resume });
    });
}

// Boot-time sweep of stale staging files (kept only while a resume record
// points at them, or for 30 min after last write).
async function sweepStaleStaging() {
    try {
        const dir = await getOpfsDir();
        if (!dir || !dir.entries) return;
        const keep = new Set();
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(RESUME_KEY_PREFIX)) {
                try { const m = JSON.parse(localStorage.getItem(k)); if (m && m.stagingName) keep.add(m.stagingName); } catch (e) { /* corrupt record */ }
            }
        }
        const stale = [];
        for await (const [name] of dir.entries()) {
            if (!name.startsWith(OPFS_PREFIX) || keep.has(name)) continue;
            try {
                const f = await (await dir.getFileHandle(name)).getFile();
                if (Date.now() - f.lastModified < 30 * 60000) continue;
            } catch (e) { /* unreadable → stale */ }
            stale.push(name);
        }
        for (const n of stale) { try { await dir.removeEntry(n); } catch (e) { /* locked */ } }
        if (stale.length) Logger.debug(`Storage transfer: swept ${stale.length} stale staging file(s)`);
    } catch (e) { /* OPFS unavailable */ }
}
if (hasDom) sweepStaleStaging();

// ================= RESUME METADATA (localStorage) =================

function resumeKeyFor(tid) { return `${RESUME_KEY_PREFIX}${tid}`; }
function getResumeMeta(tid) {
    if (!tid) return null;
    try { const s = localStorage.getItem(resumeKeyFor(tid)); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}
function saveResumeMeta(tid, meta) {
    if (!tid) return;
    try { localStorage.setItem(resumeKeyFor(tid), JSON.stringify(meta)); } catch (e) { Logger.warn(`resume meta save failed: ${e.message}`); }
}
function clearResumeMeta(tid) {
    if (!tid) return;
    try { localStorage.removeItem(resumeKeyFor(tid)); } catch (e) { /* private mode */ }
}

// ================= COMPRESSION (CompressionStream → OPFS) =================

/**
 * Compression in a WEB WORKER, streaming straight to OPFS with checkpoints —
 * deflate runs OFF the main thread (pipelined with publish it otherwise
 * becomes the upload bottleneck). Returns the final File, or null to fall back.
 * Uses native CompressionStream('deflate') — zlib format, POC-compatible.
 */
function compressFileToOpfsWorker(file, name, onProgress, hooks) {
    return new Promise((resolve) => {
        if (typeof Worker === 'undefined' || typeof CompressionStream === 'undefined'
            || typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) { resolve(null); return; }
        const src = `
            let stopFlag = false, useWritable = false;
            onmessage = async (e) => {
                if (e.data === 'stop') { stopFlag = true; return; }
                if (e.data === 'use-writable') { useWritable = true; return; }
                const { file, name, ckpt } = e.data;
                let root, handle;
                try {
                    root = await navigator.storage.getDirectory();
                    handle = await root.getFileHandle(name, { create: true });
                } catch (err) { postMessage({ type: 'error', message: String(err && err.message || err) }); return; }
                // FAST-PATH: sync access handle — in-place writes, checkpoint = flush() O(1).
                // The writable path copies the WHOLE file per checkpoint -> O(n^2).
                // 'readwrite-unsafe' allows concurrent reads from the main thread; probed
                // on the 1st checkpoint with an in-flight fallback to the writable path.
                let sync = null, writable = null, written = 0;
                try { sync = await handle.createSyncAccessHandle({ mode: 'readwrite-unsafe' }); } catch (err) {}
                if (!sync) { try { sync = await handle.createSyncAccessHandle(); } catch (err) {} }
                if (sync) { try { sync.truncate(0); } catch (err) {} }
                else {
                    try { writable = await handle.createWritable(); }
                    catch (err) { postMessage({ type: 'error', message: String(err && err.message || err) }); return; }
                }
                const switchToWritable = async () => {
                    if (!sync) return;
                    try { sync.flush(); sync.close(); } catch (err) {}
                    sync = null;
                    writable = await handle.createWritable({ keepExistingData: true });
                    await writable.seek(written);
                };
                try {
                    const cs = new CompressionStream('deflate');
                    const cw = cs.writable.getWriter();
                    let sinceCkpt = 0, probed = false, drainError = null;
                    const writeOut = async (buf) => {
                        if (sync) {
                            const n = sync.write(buf, { at: written });
                            if (n !== buf.length) throw new Error('short write: ' + n + '/' + buf.length);
                        } else await writable.write(buf);
                        written += buf.length; sinceCkpt += buf.length;
                    };
                    const checkpoint = async () => {
                        if (sync) sync.flush();
                        else { await writable.close(); writable = await handle.createWritable({ keepExistingData: true }); await writable.seek(written); }
                        sinceCkpt = 0;
                        const msg = { type: 'committed', bytes: written, m: sync ? 's' : 'w' };
                        if (sync && !probed) { msg.probe = true; probed = true; }
                        postMessage(msg);
                    };
                    // Drain task: pulls compressed output as it appears
                    const drain = (async () => {
                        const reader = cs.readable.getReader();
                        try {
                            for (;;) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                if (value && value.length) {
                                    await writeOut(value);
                                    if (sinceCkpt >= ckpt) await checkpoint();
                                }
                            }
                        } catch (err) { drainError = err; }
                    })();
                    const SLICE = 4 * 1024 * 1024;
                    if (file.size === 0) {
                        await cw.close();
                    } else {
                        for (let off = 0; off < file.size; off += SLICE) {
                            if (stopFlag) throw new Error('aborted');
                            if (drainError) throw drainError;
                            if (useWritable) { useWritable = false; await switchToWritable(); }
                            const end = Math.min(off + SLICE, file.size);
                            const buf = new Uint8Array(await file.slice(off, end).arrayBuffer());
                            await cw.write(buf);
                            postMessage({ type: 'progress', p: end / file.size });
                        }
                        await cw.close();
                    }
                    await drain;
                    if (drainError) throw drainError;
                    if (sync) { sync.flush(); sync.close(); } else await writable.close();
                    postMessage({ type: 'done', size: written });
                } catch (err) {
                    try { if (sync) sync.close(); } catch (e2) {}
                    try { if (writable) await writable.abort(); } catch (e2) {}
                    try { await root.removeEntry(name); } catch (e2) {}
                    postMessage({ type: 'error', message: String(err && err.message || err) });
                }
            };
        `;
        let w;
        try { w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); }
        catch (e) { resolve(null); return; }
        let mainHandle = null;
        const getMainHandle = async () => {
            if (!mainHandle) {
                const dir = await navigator.storage.getDirectory();
                mainHandle = await dir.getFileHandle(name);
            }
            return mainHandle;
        };
        const finish = (val) => { try { w.terminate(); } catch (e) { /* gone */ } resolve(val); };
        let probeFailed = false;
        w.onerror = (e) => { Logger.warn(`worker compression failed (${e.message || 'error'}) — fallback`); finish(null); };
        w.onmessage = async (e) => {
            const d = e.data;
            try {
                if (d.type === 'progress') {
                    if (onProgress) onProgress(d.p);
                    if (hooks && hooks.shouldStop && hooks.shouldStop()) w.postMessage('stop');
                } else if (d.type === 'committed') {
                    if (d.probe) {
                        let readable = false;
                        try { readable = (await (await getMainHandle()).getFile()).size >= d.bytes; } catch (err) { /* not readable */ }
                        if (!readable) {
                            probeFailed = true;
                            w.postMessage('use-writable');
                            Logger.warn('compression: concurrent read unavailable with sync handle — switching to writable (checkpoints copy the file)');
                            return;
                        }
                    }
                    if (probeFailed && d.m === 's') return;
                    if (hooks && hooks.onCommitted) hooks.onCommitted(d.bytes, await getMainHandle());
                } else if (d.type === 'done') {
                    const h = await getMainHandle();
                    finish(await h.getFile());
                } else if (d.type === 'error') {
                    if (!/aborted/.test(d.message)) Logger.warn(`worker compression failed (${d.message}) — fallback`);
                    finish(null);
                }
            } catch (err) { Logger.warn(`compression worker: ${err.message} — fallback`); finish(null); }
        };
        w.postMessage({ file, name, ckpt: 8 * 1024 * 1024 });
    });
}

/** Main-thread streaming compression to memory (no OPFS). Returns Uint8Array. */
async function compressFileStreaming(file, onProgress, shouldStop) {
    const SLICE = 4 * 1024 * 1024;
    const cs = new CompressionStream('deflate');
    const cw = cs.writable.getWriter();
    const parts = [];
    let total = 0;
    const drain = (async () => {
        const reader = cs.readable.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length) { parts.push(value); total += value.length; }
        }
    })();
    if (file.size === 0) {
        await cw.close();
    } else {
        for (let off = 0; off < file.size; off += SLICE) {
            if (shouldStop && shouldStop()) throw new Error('compression aborted');
            const end = Math.min(off + SLICE, file.size);
            const buf = new Uint8Array(await file.slice(off, end).arrayBuffer());
            await cw.write(buf);
            if (onProgress) onProgress(end / file.size);
            await sleep(0);
        }
        await cw.close();
    }
    await drain;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

// ================= DIRECT HTTP STORAGE READS =================

/**
 * Direct HTTP range read from a storage node, with STREAMING JSON parse (a
 * window can be tens of MB — waiting for the full body freezes progress) and
 * an inactivity watchdog. If onMessage returns a promise it is awaited =
 * reader backpressure.
 */
async function directFetchRange(base, sid, partition, fromTime, toTime, onMessage) {
    const url = `${base}/streams/${encodeURIComponent(sid)}/data/partitions/${partition}/range?fromTimestamp=${fromTime}&toTimestamp=${toTime}`;
    const ctrl = new AbortController();
    let t = setTimeout(() => ctrl.abort(), SM.directFetchTimeoutMs);
    const kick = () => { clearTimeout(t); t = setTimeout(() => ctrl.abort(), SM.directFetchTimeoutMs); };
    const emit = (m) => {
        if (!onMessage) return;
        let content = m.content;
        if (m.contentType === 1 && typeof content === 'string') content = hexToU8(content);
        else if (typeof content === 'string') { try { content = JSON.parse(content); } catch (e) { /* sealed string stays string */ } }
        return onMessage({ content, timestamp: m.timestamp, publisherId: m.publisherId });
    };
    try {
        const resp = await fetch(url, { signal: ctrl.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        kick();
        if (!resp.body || !resp.body.getReader) {
            const arr = await resp.json();
            if (!Array.isArray(arr)) throw new Error('unexpected endpoint response');
            for (const m of arr) { const r = emit(m); if (r && typeof r.then === 'function') await r; }
            return arr.length;
        }
        // Streaming top-level-array parse: track depth/strings, emit each object.
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '', scan = 0, depth = 0, objStart = -1, inStr = false, esc = false;
        let sawArray = false, n = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (value && value.length) kick();
            buf += done ? dec.decode() : dec.decode(value, { stream: true });
            for (; scan < buf.length; scan++) {
                const ch = buf[scan];
                if (inStr) {
                    if (esc) esc = false;
                    else if (ch === '\\') esc = true;
                    else if (ch === '"') inStr = false;
                    continue;
                }
                if (depth === 0) {
                    if (ch === '{') { objStart = scan; depth = 1; continue; }
                    if (ch === '[') { sawArray = true; continue; }
                    if (ch === ']' || ch === ',' || ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
                    throw new Error('unexpected endpoint response');
                }
                if (ch === '"') { inStr = true; continue; }
                if (ch === '{') { depth++; continue; }
                if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        const r = emit(JSON.parse(buf.slice(objStart, scan + 1)));
                        n++;
                        buf = buf.slice(scan + 1);
                        scan = -1; objStart = -1;
                        if (r && typeof r.then === 'function') { await r; kick(); }
                    }
                }
            }
            if (done) break;
        }
        if (!sawArray && n === 0 && buf.trim().length) throw new Error('unexpected endpoint response');
        return n;
    } finally { clearTimeout(t); }
}

/**
 * Metadata-only range read (Pombo-patched nodes): message metadata without the
 * payload hex — a full verify sweep costs KBs instead of ~2x the file.
 * Vanilla nodes answer HTTP 400; the caller marks the node and falls back.
 */
async function directFetchRangeMeta(base, sid, partition, fromTime, toTime) {
    const url = `${base}/streams/${encodeURIComponent(sid)}/data/partitions/${partition}/range?fromTimestamp=${fromTime}&toTimestamp=${toTime}&format=metadata`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60000);
    try {
        const resp = await fetch(url, { signal: ctrl.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const arr = await resp.json();
        if (!Array.isArray(arr)) throw new Error('unexpected endpoint response');
        return arr;
    } finally { clearTimeout(t); }
}

async function directFetchLast(base, sid, partition, count, onMessage) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
        const resp = await fetch(`${base}/streams/${encodeURIComponent(sid)}/data/partitions/${partition}/last?count=${count}`, { signal: ctrl.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const arr = await resp.json();
        if (!Array.isArray(arr)) throw new Error('unexpected endpoint response');
        for (const m of arr) {
            let content = m.content;
            if (m.contentType === 1 && typeof content === 'string') content = hexToU8(content);
            else if (typeof content === 'string') { try { content = JSON.parse(content); } catch (e) { /* sealed */ } }
            if (onMessage) onMessage({ content, timestamp: m.timestamp, publisherId: m.publisherId });
        }
        return arr.length;
    } finally { clearTimeout(t); }
}

/** SDK-resend window read (fallback when no HTTP endpoint works, and the DM path). */
async function sdkFetchWindow(sid, partition, fromTime, toTime, onMessage, idleTimeoutMs = SM.resendIdleTimeoutMs) {
    const client = streamrController.client;
    if (!client) throw new Error('Streamr client not initialized');
    const HARD_CAP_MS = 900000;
    let total = 0;
    await new Promise((res, rej) => {
        let done = false;
        let idleTimer = null;
        let hardTimer = null;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(idleTimer); clearTimeout(hardTimer);
            res();
        };
        const armIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                Logger.warn(`Storage resend idle for ${(idleTimeoutMs / 1000).toFixed(0)}s (${total} msgs received) — stopping`);
                finish();
            }, idleTimeoutMs);
        };
        hardTimer = setTimeout(() => {
            Logger.warn(`Storage resend hit the hard cap (${total} msgs) — stopping`);
            finish();
        }, HARD_CAP_MS);
        armIdle();
        // Raw, no envelope guard — this is the SDK fallback for the direct
        // HTTP window read above, which never validated either: chunk windows
        // are self-verifying downstream (per-file seal + assembled digest),
        // and on gated channels the publisher is the clone anyway.
        client.resend({ streamId: sid, partition }, { from: { timestamp: fromTime }, to: { timestamp: toTime }, raw: true })
            .then(sub => {
                armIdle();
                (async () => {
                    // Manual iterator: a DECRYPT_ERROR on one message must not
                    // abort the whole window (publisher-offline key gaps).
                    const iterator = sub[Symbol.asyncIterator]();
                    for (;;) {
                        let m;
                        try {
                            const r = await iterator.next();
                            if (r.done) break;
                            m = r.value;
                        } catch (e) {
                            if (e.code === 'DECRYPT_ERROR' || e.message?.includes('encryption key')) continue;
                            Logger.warn(`storage resend iter err: ${e.message}`);
                            continue;
                        }
                        if (done) break;
                        total++;
                        armIdle();
                        if (onMessage) {
                            const r = onMessage({ content: m.content, timestamp: m.timestamp, publisherId: m.publisherId });
                            if (r && typeof r.then === 'function') { await r; armIdle(); }
                        }
                    }
                    finish();
                })();
            })
            .catch(e => {
                if (!done) { done = true; clearTimeout(idleTimer); clearTimeout(hardTimer); rej(e); }
            });
    });
    return total;
}

/**
 * One window read: direct HTTP against `base` when given (with health notes),
 * SDK resend otherwise or on HTTP failure.
 */
async function fetchWindow(sid, w, onMessage, base) {
    if (base) {
        try {
            const n = await directFetchRange(base, sid, w.partition, w.from, w.to, onMessage);
            storageEndpoints.noteSuccess(base);
            return n;
        } catch (e) {
            storageEndpoints.noteFailure(base);
            Logger.warn(`direct read P${w.partition} @ ${base} failed (${e.message}) — falling back to SDK resend`);
        }
    }
    return await sdkFetchWindow(sid, w.partition, w.from, w.to, onMessage);
}

/**
 * Runs several {partition, from, to} window reads in parallel, round-robining
 * windows across the node rotation. Empty rotation → every window goes through
 * SDK resend.
 */
/**
 * @param {() => boolean} [shouldStop] - Checked between windows (not mid-fetch)
 *   so a pause takes effect within one window's worth of latency instead of
 *   waiting for the whole batch — see StorageMediaController.pauseDownload.
 */
async function fetchWindowsParallel(sid, windows, onMessage, concurrency, bases, shouldStop) {
    let next = 0;
    const worker = async () => {
        while (next < windows.length) {
            if (shouldStop?.()) return;
            const idx = next++;
            const w = windows[idx];
            const base = (bases && bases.length) ? bases[idx % bases.length] : null;
            try { await fetchWindow(sid, w, onMessage, base); }
            catch (e) { Logger.warn(`storage window P${w.partition} failed: ${e.message}`); }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, windows.length) }, worker));
}

// ================= CONTROLLER =================

class StorageMediaController {
    constructor() {
        // transferId → upload state {phase, percent, bytesSent, totalBytes, bytesPerSec, verifying}
        this.uploads = new Map();
        // transferId → download state {metadata, chunks:Map, totalChunks, status, bytesReceived, etaHistory, ...}
        this.downloads = new Map();
        // transferId → {url, blob, metadata} for completed downloads (session cache)
        this.completedFiles = new Map();
        // transferIds whose resume was requested but whose new downloadFile run
        // hasn't flipped the status back to 'downloading' yet (endpoint rotation
        // alone can take seconds) — the bell shows "Resuming…" off this
        this.resumingIds = new Set();
        // streamId → true once chunk partitions were warm-up pinged this session
        this.warmedUp = new Set();
        this.warmUpPromises = new Map();

        this.activeTransfers = 0;
        this.wakeLockSentinel = null;

        // UI callbacks (mesh mediaController contract)
        this.fileProgressCallback = null;   // (tid, percent, received, total, fileSize, bytesPerSec)
        this.fileCompleteCallback = null;   // (tid, metadata, url, blob)
        this.fileErrorCallback = null;      // (tid, message)
        this.uploadStatsCallback = null;    // (tid, statsSnapshot) — sender bubble stats line
        this.uploadCompleteCallback = null; // (tid, message) — sender bubble refresh

        if (hasDom) {
            window.addEventListener('beforeunload', (e) => {
                if (this.activeTransfers > 0) { e.preventDefault(); e.returnValue = ''; }
            });
        }
    }

    // ---- callback registration (single listener each, mesh-style) ----
    onFileProgress(cb) { this.fileProgressCallback = cb; }
    onFileComplete(cb) { this.fileCompleteCallback = cb; }
    onFileError(cb) { this.fileErrorCallback = cb; }
    onUploadStats(cb) { this.uploadStatsCallback = cb; }
    onUploadComplete(cb) { this.uploadCompleteCallback = cb; }

    // ---- renderer deps ----
    isUploading(tid) { return this.uploads.has(tid); }
    getUploadState(tid) { return this.uploads.get(tid) || null; }
    isDownloading(tid) { return this.downloads.get(tid)?.status === 'downloading'; }

    /**
     * Pauses a running storage download: the fetch loop stops between windows
     * (see fetchWindowsParallel's shouldStop) and preserves whatever is
     * already staged to disk, same as the "incomplete, preserve for retry"
     * path. [resumeDownload] continues from there.
     */
    pauseDownload(tid) {
        const transfer = this.downloads.get(tid);
        if (!transfer || transfer.status !== 'downloading') return;
        transfer.paused = true;
    }

    /**
     * Resumes a download [pauseDownload] stopped — deliberately does NOT go
     * through the UI's handleStorageFileDownload (which needs the transfer's
     * channel to be the one currently open): the Active Transfers list this
     * is called from is not scoped to any open channel, so the announce and
     * channel come from this controller's own cache instead. downloadFile()'s
     * own resume logic (backed by saveResumeMeta) picks up from the paused
     * point — nothing already staged gets re-fetched.
     */
    resumeDownload(tid) {
        const transfer = this.downloads.get(tid);
        if (!transfer) return;
        if (transfer.status === 'downloading') {
            // Pause was requested but the fetch loop has not unwound yet —
            // undo the request in place; the retry passes still ahead of the
            // loop pick the missing chunks back up, nothing to restart.
            transfer.paused = false;
            return;
        }
        if (transfer.status !== 'paused') return;
        this.resumingIds.add(tid);
        const channel = channelManager.getChannel(transfer.streamId);
        this.downloadFile(transfer.streamId, { metadata: transfer.metadata, timestamp: transfer.announceTs }, channel?.password)
            .catch(() => { /* surfaced via fileErrorCallback */ })
            .finally(() => this.resumingIds.delete(tid));
    }

    /** Whether a resumeDownload() is still spinning its new run up for [tid]. */
    isResuming(tid) { return this.resumingIds.has(tid); }

    /**
     * Cancels a storage download — mesh cancelDownload's meaning, "I do not
     * want this": unlike pauseDownload, the staged bytes and resume record
     * are deleted. A running fetch loop stops between windows (the same
     * brake pause uses) and finishes the cleanup itself; a paused one has
     * nothing running, so the cleanup happens here.
     */
    cancelDownload(tid) {
        const transfer = this.downloads.get(tid);
        if (!transfer) return;
        this.resumingIds.delete(tid);
        if (transfer.status === 'downloading') {
            transfer.cancelled = true;
            transfer.paused = true;
            return;
        }
        this.downloads.delete(tid);
        const meta = getResumeMeta(tid);
        if (meta?.stagingName) opfsDelete(meta.stagingName);
        clearResumeMeta(tid);
        Logger.info('Storage download cancelled:', tid);
    }

    getDownloadProgress(tid) {
        const t = this.downloads.get(tid);
        if (!t || (t.status !== 'downloading' && t.status !== 'paused')) return null;
        const received = t.chunks.size;
        const total = t.totalChunks;
        const now = performance.now();
        // Chunk rate over the 10s window drives the ETA (resumed chunks sit at
        // the history start, so only live throughput counts).
        const cps = windowedRate(t.etaHistory, now);
        return {
            percent: total > 0 ? Math.round((received / total) * 100) : 0,
            received,
            total,
            fileSize: t.metadata.originalSize,
            bytesPerSec: windowedRate(t.etaHistory, now, 'bytes'),
            instBps: instantRate(t.etaHistory, now),
            avgBps: t.firstByteTime ? t.bytesReceived / Math.max(0.001, (now - t.firstByteTime) / 1000) : null,
            etaSec: (cps && cps > 0) ? (total - received) / cps : null,
            phase: t.phase || null,
            resumedCount: t.resumedCount || 0,
            // The *request* flag, not t.status === 'paused' — that only
            // flips once the fetch loop actually unwinds (fetchWindowsParallel
            // checks it between windows, so a network read in flight can lag
            // a tap by a moment), which read as the pause button not responding.
            paused: !!t.paused
        };
    }
    getFileUrl(tid) { return this.completedFiles.get(tid)?.url || null; }
    hasResumeState(tid) {
        const m = getResumeMeta(tid);
        return !!(m && Array.isArray(m.indices) && m.totalChunks);
    }
    getResumePercent(tid) {
        const m = getResumeMeta(tid);
        if (!m || !Array.isArray(m.indices) || !m.totalChunks) return null;
        return Math.round(m.indices.length / m.totalChunks * 100);
    }

    // ---- wake lock ----
    async acquireWakeLock() {
        try {
            if (!hasDom || !navigator.wakeLock || this.wakeLockSentinel) return;
            this.wakeLockSentinel = await navigator.wakeLock.request('screen');
            this.wakeLockSentinel.addEventListener('release', () => { this.wakeLockSentinel = null; });
        } catch (e) { /* denied — non-fatal */ }
    }
    releaseWakeLock() {
        if (this.activeTransfers > 0) return;
        try { if (this.wakeLockSentinel) { this.wakeLockSentinel.release(); this.wakeLockSentinel = null; } } catch (e) { /* already released */ }
    }

    // ---- sealing context ----
    /**
     * Build the seal/open pair for a transfer.
     * direction 'send' | 'receive' only matters for DMs (which peer key to use).
     * @returns {{seal, open, encSalt, overhead}}
     */
    async makeSealer(channel, password, { encSaltB64 = null, peerAddress = null } = {}) {
        if (channel?.type === 'dm') {
            const privateKey = authManager.wallet?.privateKey;
            const peer = peerAddress || channel.peerAddress;
            if (!privateKey || !peer) throw new Error('DM storage transfer: encryption keys unavailable');
            const peerPubKey = await dmManager.getPeerPublicKey(peer);
            if (!peerPubKey) throw new Error('DM storage transfer: peer public key unavailable');
            const aesKey = await dmCrypto.getSharedKey(privateKey, peer, peerPubKey);
            return {
                seal: (bytes) => dmCrypto.encryptBinary(bytes, aesKey),
                open: (bytes) => dmCrypto.decryptBinary(bytes, aesKey),
                encSalt: null,
                overhead: SEAL_OVERHEAD
            };
        }
        if (password) {
            const salt = encSaltB64
                ? cryptoManager.base64ToArrayBuffer(encSaltB64)
                : cryptoManager.generateSalt();
            // ONE PBKDF2 per file: deriveKey caches on (password, salt).
            const key = await cryptoManager.deriveKey(password, salt);
            return {
                seal: (bytes) => cryptoManager.encryptBinaryWithKey(bytes, key),
                open: (bytes) => cryptoManager.decryptBinaryWithKey(bytes, key),
                encSalt: cryptoManager.arrayBufferToBase64(salt),
                overhead: SEAL_OVERHEAD
            };
        }
        if (usesEpochKeys(channel)) {
            // ONE epoch key per transfer, captured here: a rotation mid-upload
            // does not re-key chunks already out, exactly as it does not re-key
            // a sent message. Missing on the download side is fine — open()
            // resolves each chunk's kid on its own.
            let current = await epochKeyManager.getCurrentKey(channel.messageStreamId);
            if (!current) {
                await epochKeyManager.ensureChannelKeys(channel);
                current = await epochKeyManager.getCurrentKey(channel.messageStreamId);
            }
            const messageStreamId = channel.messageStreamId;
            return {
                seal: (bytes) => {
                    if (!current) {
                        throw new Error(`No epoch key for ${messageStreamId} — cannot store media on an epoch channel without one`);
                    }
                    return epochKeyCrypto.sealBinaryWithEpochKey(bytes, current.cryptoKey, current.kid);
                },
                // ts: the chunk's transport timestamp — on gated channels the
                // kid-freshness rule judges an old epoch's kid against the
                // announce in force at that moment (no ts = rejected).
                open: async (bytes, ts) => {
                    const parsed = epochKeyCrypto.parseBinaryEpochEnvelope(bytes);
                    if (!parsed) throw new Error('not an epoch envelope');
                    const key = await epochKeyManager.getKeyForKid(
                        messageStreamId, parsed.kid, { timestamp: ts });
                    if (key === false) throw new Error(`stale epoch kid ${parsed.kid}`);
                    if (!key) {
                        epochKeyManager.noteMissingKid(messageStreamId, parsed.kid);
                        throw new Error(`missing epoch key ${parsed.kid}`);
                    }
                    return epochKeyCrypto.decryptBinaryWithEpochKey(parsed, key);
                },
                encSalt: null,
                // [1B version][1B kidLen][kid][12B iv][16B tag] + headroom for
                // a longer kid if a rotation lands mid-transfer
                overhead: 30 + (current ? new TextEncoder().encode(current.kid).byteLength : 24) + 8
            };
        }
        return {
            seal: (bytes) => bytes,
            open: (bytes) => bytes,
            encSalt: null,
            overhead: 0
        };
    }

    // ---- partition warm-up ----
    /**
     * Each partition is a separate overlay and the FIRST publish triggers the
     * join — messages published before neighbours exist are silently lost.
     * A 1-byte ping per chunk partition + a wait fixes that. Once per session
     * per stream (re-armed if the client reconnects: callers clear warmedUp).
     */
    warmUpPartitions(sid, firstPartition, onStatus, identity = null) {
        if (!sid || this.warmedUp.has(sid)) return Promise.resolve();
        if (this.warmUpPromises.has(sid)) return this.warmUpPromises.get(sid);
        const p = (async () => {
            if (onStatus) onStatus('Preparing network…');
            const ping = new Uint8Array([0]);
            // Warm-up pings ride the SAME publisher as the chunks — otherwise
            // the wallet would appear on the channel's -1 stream just from
            // waking its partitions.
            await Promise.all(Array.from({ length: STORAGE_FILE.CHUNK_PARTITIONS }, (_, k) =>
                streamrController.publishStorageChunk(sid, firstPartition + k, ping, identity)
                    .catch(e => Logger.warn(`storage warm-up P${firstPartition + k} failed: ${e.message}`))
            ));
            await sleep(SM.warmUpWaitMs);
            this.warmedUp.add(sid);
        })().finally(() => this.warmUpPromises.delete(sid));
        this.warmUpPromises.set(sid, p);
        return p;
    }

    // ---- verify reads ----

    /**
     * Reads the given windows and returns the Set of chunk indices found for
     * this transfer, matching by publish TIMESTAMP (works even when the node
     * only holds SDK-layer ciphertext, e.g. DM inboxes). Fast path uses the
     * Pombo format=metadata patch when the node has it.
     *
     * @param {string} sid
     * @param {Array} windows - [{partition, from, to}]
     * @param {Map} tsIndex - `${partition}:${timestamp}` → chunkIndex
     * @param {string[]} bases - node rotation ([] → SDK resend)
     * @param {string} label
     * @param {Function} [onProgress] - (foundSoFar, winsDone, totalWins)
     * @param {Object} [stats] - Filled when given: {winsOk, winsFailed, rows,
     *   foreignRows}. Lets callers tell "read worked, chunk absent" apart from
     *   "read failed" — the auto-tune must NOT treat a failed read as loss.
     * @returns {Promise<Set<number>>}
     */
    async readStoredIndices(sid, windows, tsIndex, bases, label, onProgress, stats = null, expectedPublisher = null, storedKey = null) {
        const found = new Set();
        if (storedKey) {
            const present = await this.storedIndices(sid, windows, tsIndex, storedKey, label);
            if (present) {
                present.forEach((i) => found.add(i));
                if (onProgress) onProgress(found, windows.length, windows.length);
                return found;
            }
        }
        // Whose rows count as ours. Normally our wallet, but a DM transfer
        // publishes its chunks under a throwaway identity — verify has to look
        // for THAT address, or every chunk reads back as foreign and repair
        // concludes the whole upload is missing.
        const myAddress = (expectedPublisher || authManager.getAddress() || '').toLowerCase();
        let winsDone = 0;
        let next = 0;
        const matchTs = (partition, timestamp, publisherId) => {
            if (stats) stats.rows = (stats.rows || 0) + 1;
            if (myAddress && publisherId && String(publisherId).toLowerCase() !== myAddress) {
                if (stats) stats.foreignRows = (stats.foreignRows || 0) + 1;
                return;
            }
            const i = tsIndex.get(`${partition}:${timestamp}`);
            if (i !== undefined) found.add(i);
        };
        const noteWin = (ok) => {
            if (!stats) return;
            if (ok) stats.winsOk = (stats.winsOk || 0) + 1;
            else stats.winsFailed = (stats.winsFailed || 0) + 1;
        };
        const worker = async () => {
            while (next < windows.length) {
                const idx = next++;
                const w = windows[idx];
                const base = bases.length ? bases[idx % bases.length] : null;
                let done = false;
                if (base && storageEndpoints.supportsMetaFormat(base) !== false) {
                    try {
                        const arr = await directFetchRangeMeta(base, sid, w.partition, w.from, w.to);
                        for (const m of arr) matchTs(w.partition, m.timestamp, m.publisherId);
                        storageEndpoints.noteSuccess(base);
                        noteWin(true);
                        done = true;
                    } catch (e) {
                        if (/HTTP 400/.test(e.message)) {
                            storageEndpoints.setMetaFormatSupport(base, false);
                            Logger.warn(`format=metadata unavailable on ${base} — full reads for that node`);
                        } else {
                            storageEndpoints.noteFailure(base);
                            Logger.warn(`${label}: metadata read failed on ${base} (${e.message}) — full read`);
                        }
                    }
                }
                if (!done) {
                    try {
                        await fetchWindow(sid, w, (msg) => matchTs(w.partition, msg.timestamp, msg.publisherId), base);
                        noteWin(true);
                    } catch (e) {
                        noteWin(false);
                        Logger.warn(`${label}: window P${w.partition} read failed: ${e.message}`);
                    }
                }
                winsDone++;
                if (onProgress) onProgress(found, winsDone, windows.length);
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, windows.length) }, worker));
        return found;
    }

    // ================= UPLOAD =================

    /**
     * Share a file through the channel's storage nodes.
     *
     * Publishes chunks over the -1 chunk partitions with pacing/backpressure and
     * the POC's auto-tune oscillator, verifies persistence against every
     * resolved storage node (round-robin), repairs what is missing, then
     * publishes the signed announce on P0 and confirms it stored.
     *
     * @param {string} messageStreamId - Channel message stream ID (DM: peer inbox)
     * @param {File} file
     * @param {string|null} password - Channel password (null for public/DM)
     * @returns {Promise<{messageId: string, metadata: Object}>}
     */
    async sendFile(messageStreamId, file, password = null) {
        if (!file || file.size === 0) throw new Error('File is empty');

        const channel = channelManager.getChannel(messageStreamId);
        const isDM = channel?.type === 'dm';
        const firstChunkPartition = isDM
            ? STORAGE_FILE.DM_FIRST_CHUNK_PARTITION
            : STORAGE_FILE.FIRST_CHUNK_PARTITION;
        const chunkPartition = (i) => storageChunkPartition(i, firstChunkPartition);

        // Endpoint rotation for verify reads. Empty is allowed (verify falls
        // back to SDK resend reads) but on DM uploads the sender has no
        // subscribe permission on the peer's inbox, so HTTP is the only verify
        // path there — warn early instead of stalling later.
        const bases = await storageEndpoints.rotation(messageStreamId).catch((e) => {
            Logger.warn('storage endpoint resolution failed:', e.message);
            return [];
        });
        if (!bases.length) {
            if (isDM) throw new Error('No reachable storage endpoint for this inbox — persistent DM sharing needs one');
            Logger.warn('No storage HTTP endpoints — verify will use SDK resend reads (slower)');
        } else {
            Logger.info(`Storage upload verify endpoints (${bases.length}): ${bases.join(', ')}`);
        }

        const sealer = await this.makeSealer(channel, password);

        const tid = genId();
        const messageId = identityManager.generateMessageId();
        const maxB = SM.chunkKB * 1024;

        // Optimistic sender bubble: unsigned local copy, replaced in place by the
        // signed announce at completion (same id → the published echo dedupes).
        const draftMetadata = {
            transferId: tid,
            fileName: file.name,
            fileType: file.type || 'application/octet-stream',
            originalSize: file.size,
            compressedSize: null,
            compression: 'none',
            totalChunks: null,
            chunkDataSize: null,
            chunkPartitions: STORAGE_FILE.CHUNK_PARTITIONS,
            firstChunkPartition,
            firstChunkTs: null,
            lastChunkTs: null,
            storedChunks: null,
            encSalt: sealer.encSalt
        };
        const localMessage = {
            type: 'storage_file_announce',
            v: 1,
            id: messageId,
            sender: authManager.getAddress(),
            senderName: identityManager.username || null,
            timestamp: Date.now(),
            channelId: messageStreamId,
            metadata: draftMetadata,
            signature: null,
            replyTo: null,
            pending: true,
            verified: { valid: true, trustLevel: await identityManager.getTrustLevel(authManager.getAddress()) }
        };
        if (channel) {
            channel.messages.push(localMessage);
            channelManager.notifyHandlers('message', { streamId: messageStreamId, message: localMessage });
        }

        // Full POC-parity stats: percent + sent/total bytes + instant & average
        // speed + ETA + phase/stage. The renderer/ui compose the visible line
        // from snapshots of this object.
        const upState = {
            stage: 'processing',        // processing | sending | verifying | repairing | announce | done
            phase: 'Processing…',       // human label for non-sending stages
            percent: 0,
            bytesSent: 0,
            totalBytes: null,           // compressed size — null until compression finishes
            fileSize: file.size,
            instBps: null,              // ~1.5s window (the POC's "hot" badge)
            avgBps: null,               // whole-upload average
            etaSec: null,               // from the 10s chunk-rate window
            processingPct: null,        // pipelined compression % while still sending
            error: null
        };
        this.uploads.set(tid, upState);
        const emitStats = () => {
            try { this.uploadStatsCallback?.(tid, { ...upState }); } catch (e) { /* UI */ }
        };
        const emitPhase = (label, stage = null) => {
            upState.phase = label;
            if (stage) upState.stage = stage;
            emitStats();
        };
        const emitProgress = (percent, received, total, bytesPerSec) => {
            upState.percent = percent;
            try { this.fileProgressCallback?.(tid, percent, received, total, file.size, bytesPerSec); } catch (e) { /* UI */ }
            emitStats();
        };

        this.activeTransfers++;
        this.acquireWakeLock();
        let uploadOpfsName = null;

        try {
            const doCompress = shouldCompress(file);
            const compression = doCompress ? 'deflate' : 'none';

            let compSize = null;
            let tc = null;
            let compDone = false;
            let producerFailed = null;
            let committedBytes = 0;
            let committedHandle = null;
            let compPct = 0;
            let compStarvedSinceProbe = false;
            let producerP = null;
            let compFile = null, comp = null;
            let nextIdx = 0, doneCount = 0;
            let workerWakers = [];
            const wakeWorkers = () => { const w = workerWakers; workerWakers = []; for (const r of w) r(); };
            const waitMoreData = () => new Promise(r => workerWakers.push(r));
            const onCompProgress = (p) => {
                compPct = Math.round(p * 100);
                if (doneCount === 0) {
                    emitPhase(`Processing… ${compPct}%`, 'processing');
                    emitProgress(compPct, 0, 1, null);
                }
            };

            if (!doCompress) {
                compFile = file;
                // Fixed-flow faststart: MP4-likes are remuxed (moov first) before
                // chunking so the stored file can play progressively. Same total
                // size — boxes are only reordered — so chunk math is unaffected.
                if (SM.faststart !== false && isMp4Like(file)) {
                    emitPhase('Optimizing video for streaming…', 'processing');
                    const fs = await makeFaststartSource(file);
                    compFile = fs.blob;
                    if (fs.changed) {
                        Logger.info(`Faststart: converted (${fs.reason})`);
                    } else {
                        const already = /already faststart/.test(fs.reason);
                        Logger[already ? 'info' : 'warn'](`Faststart: no conversion (${fs.reason})`);
                    }
                }
                compSize = compFile.size;
                onCompProgress(1);
            }

            const startTs = Date.now();

            // Worst-case deflate size bound (zlib stored blocks + header slack) —
            // lets chunk math start before compression finishes (pipelined publish).
            const metaCompSize = doCompress ? (file.size + Math.ceil(file.size / 16384) * 5 + 64) : compSize;
            const chunkMeta = {
                type: 'binary_file_chunked', version: 2,
                fileName: file.name, fileType: file.type || 'application/octet-stream',
                originalSize: file.size, compressedSize: metaCompSize,
                compression, transferId: tid, timestamp: startTs
            };
            const mb = new TextEncoder().encode(JSON.stringify(chunkMeta));
            const oh = 4 + mb.length + 4 + 4;
            // Seal overhead comes OUT of the chunk budget — 240KB is a hard
            // browser ceiling (SCTP maxMessageSize), never add on top.
            const upc = maxB - oh - sealer.overhead;
            if (upc <= 0) throw new Error('Chunk size too small for metadata overhead');
            const estTc = Math.max(1, Math.ceil(metaCompSize / upc));
            if (!doCompress) {
                tc = Math.max(1, Math.ceil(compSize / upc));
                compDone = true;
            }

            const chunkStartOff = (i) => i * upc;
            const chunkEndOff = (i) => compSize == null ? (i + 1) * upc : Math.min(compSize, (i + 1) * upc);

            const readCompSlice = async (s, e) => {
                if (comp) return comp.subarray(s, e);
                for (let att = 0; ; att++) {
                    try {
                        const snap = compDone ? compFile : await committedHandle.getFile();
                        return new Uint8Array(await snap.slice(s, e).arrayBuffer());
                    } catch (err) {
                        if (att >= 4) throw err;
                        await sleep(100 * (att + 1));
                    }
                }
            };

            const buildPayload = async (i) => {
                const cd = await readCompSlice(chunkStartOff(i), chunkEndOff(i));
                const raw = packChunkPayload(mb, tc == null ? estTc : tc, i, cd);
                return await sealer.seal(raw);
            };

            if (doCompress) {
                uploadOpfsName = `${OPFS_PREFIX}up_${tid}.z`;
                producerP = (async () => {
                    try {
                        const compHooks = {
                            onCommitted: (bytes, handle) => { committedBytes = bytes; committedHandle = handle; wakeWorkers(); },
                            shouldStop: () => false
                        };
                        compFile = await compressFileToOpfsWorker(file, uploadOpfsName, onCompProgress, compHooks);
                        if (!compFile) { uploadOpfsName = null; comp = await compressFileStreaming(file, onCompProgress); }
                        compSize = compFile ? compFile.size : comp.length;
                        if (compSize > metaCompSize) throw new Error(`compressed size (${compSize}B) exceeded the estimated cap (${metaCompSize}B)`);
                        tc = Math.max(1, Math.ceil(compSize / upc));
                        compDone = true;
                        if (!compFile) Logger.warn(`OPFS unavailable — compressed in memory (${Math.round(compSize / 1024)}KB), no publish pipeline`);
                    } catch (e) {
                        producerFailed = e;
                        compDone = true;
                    } finally { wakeWorkers(); }
                })();
            }

            // Who publishes the chunks (and the warm-up pings). The announce
            // already goes out under the channel's ephemeral identity, so the
            // chunks must NOT fall back to the account — that would stamp the
            // wallet onto the channel's -1 stream next to an ephemeral
            // announce, linking wallet→channel. Four cases:
            //   DM            → a throwaway identity for the whole transfer
            //                   (sealed sender's per-message key would cost an
            //                   ECDH per chunk and buy nothing);
            //   public/pw     → the channel's own ephemeral identity, the SAME
            //                   pseudonym as the announce (one per channel);
            //   gated         → the clone (ERC-1271, inside publishStorageChunk)
            //                   — chunkIdentity stays null, verify expects the
            //                   gate address;
            //   read-only     → the account (D3) — chunkIdentity stays null,
            //                   and verify falls back to our wallet address.
            // chunkPublisher (whatever address the chunks carry) is what
            // verify must match; a wrong value makes every chunk read back as
            // foreign and repair concludes the upload is missing.
            let chunkIdentity = null;
            let chunkPublisher = null;
            let chunkPrivateKey = null;
            if (isDM) {
                const EthereumKeyPairIdentity = window.EthereumKeyPairIdentity;
                if (!EthereumKeyPairIdentity) {
                    throw new Error('EthereumKeyPairIdentity not exposed — check streamr-bundle.js');
                }
                chunkPrivateKey = dmCrypto.generateEphemeralPrivateKey();
                chunkIdentity = EthereumKeyPairIdentity.fromPrivateKey(chunkPrivateKey);
                chunkPublisher = await chunkIdentity.getUserId();
            } else if (channel?.wireIdentity === 'sealed') {
                // Sealed: chunks travel under the SHARED publish key —
                // that address is what the verify reads must match.
                const { epochKeyManager } = await import('./epochKeyManager.js');
                const pubKey = await epochKeyManager.ensurePublishKey(channel);
                if (!pubKey) {
                    throw new Error(
                        `No publish key for ${channel.messageStreamId} — cannot store media on a Sealed channel`);
                }
                chunkPublisher = pubKey.address;
            } else if (channel?.gate?.address) {
                // Gated: publishStorageChunk rides the clone (ERC-1271), so
                // that is the publisher the verify reads must match.
                chunkPublisher = channel.gate.address.toLowerCase();
            } else if (!channelManager.usesAccountPublish(messageStreamId)) {
                chunkIdentity = getChannelIdentity(messageStreamId).identity;
                chunkPublisher = await chunkIdentity.getUserId();
            }

            await this.warmUpPartitions(messageStreamId, firstChunkPartition, () => emitPhase('Preparing network…', 'processing'), chunkIdentity);

            let failedChunks = [];
            const firstChunkTs = Date.now();
            const uploadStart = performance.now();
            const publishStart = performance.now();

            const SEGMENT = 500;
            const segTimes = [];
            const chunkTs = [];
            const chunkTsHist = [];
            const stored = new Set();
            let totalBytesSent = 0;

            const tsIndexForVerify = () => {
                const m = new Map();
                for (let i = 0; i < chunkTsHist.length; i++) {
                    const hist = chunkTsHist[i];
                    if (!hist) continue;
                    const p = chunkPartition(i);
                    for (const t of hist) m.set(`${p}:${t}`, i);
                }
                return m;
            };

            const chunkRows = () => {
                const rows = [];
                for (let i = 0; i < chunkTsHist.length; i++) {
                    for (const t of (chunkTsHist[i] || [])) rows.push({ streamId: messageStreamId, partition: chunkPartition(i), timestamp: t, sequenceNumber: 0 });
                }
                return rows;
            };
            const announceRows = () => (dmManager.rowsOf?.(messageId) || []).filter((r) => r.partition === MESSAGE_STREAM.MESSAGES);

            const allPartitionWindows = (from, to) =>
                Array.from({ length: STORAGE_FILE.CHUNK_PARTITIONS }, (_, k) => ({ partition: firstChunkPartition + k, from, to }));

            const windowsForIndices = (indices) => {
                const PAD = 1500;
                const raw = [];
                for (const i of indices) {
                    const p = chunkPartition(i);
                    const hist = chunkTsHist[i];
                    if (hist && hist.length) {
                        for (const t of hist) raw.push({ partition: p, from: t - PAD, to: t + PAD });
                    } else {
                        const seg = segTimes[Math.floor(i / SEGMENT)];
                        raw.push(seg ? { partition: p, from: seg.fromTs - 5000, to: seg.toTs + 5000 }
                            : { partition: p, from: firstChunkTs - 5000, to: Date.now() + 1000 });
                    }
                }
                return mergeWindows(raw);
            };

            const speedHist = [];
            const etaHist = [];
            const noteBytes = (n) => {
                totalBytesSent += n;
                upState.bytesSent = totalBytesSent;
                const nowT = performance.now();
                speedHist.push({ time: nowT, bytes: totalBytesSent });
                while (speedHist.length > 2 && speedHist[0].time < nowT - 1500) speedHist.shift();
            };
            const noteSegment = (i) => {
                const s = Math.floor(i / SEGMENT);
                if (!segTimes[s]) segTimes[s] = { fromTs: Date.now(), toTs: Date.now() };
                segTimes[s].toTs = Date.now();
            };

            const thr = SM.throttleMs;
            const PARALLEL = Math.min(STORAGE_FILE.CHUNK_PARTITIONS, Math.max(1, SM.parallel));
            const AUTOTUNE = SM.autotune;
            const doVerify = SM.verify;
            const doSecondChance = SM.secondChance;

            let sendSpacing = thr / PARALLEL;
            const atFullStart = AUTOTUNE && (dcRadar.channels.size + dcRadar.sockets.size > 0);
            if (AUTOTUNE) sendSpacing = atFullStart
                ? maxB / (1.5 * 1024 * 1024) * 1000
                : Math.max(sendSpacing, maxB / (500 * 1024) * 1000);
            let nextSlotAt = performance.now();
            const awaitSendSlot = async () => {
                await dcBackpressure();
                const now = performance.now();
                const wait = nextSlotAt - now;
                nextSlotAt = Math.max(now, nextSlotAt) + sendSpacing;
                if (wait > 0) await sleep(wait);
            };

            const publishOne = async (i, label) => {
                const pay = await buildPayload(i);
                await awaitSendSlot();
                const pubMsg = await publishChunkWithRetry(messageStreamId, chunkPartition(i), pay, 3, chunkIdentity);
                chunkTs[i] = (pubMsg && typeof pubMsg.timestamp === 'number') ? pubMsg.timestamp : Date.now();
                (chunkTsHist[i] = chunkTsHist[i] || []).push(chunkTs[i]);
                return pay.length;
            };

            const republishParallel = async (indices, label) => {
                let next = 0;
                const failed = [];
                const worker = async () => {
                    while (true) {
                        const k = next++;
                        if (k >= indices.length) return;
                        const i = indices[k];
                        try {
                            await publishOne(i, label);
                        } catch (e) {
                            Logger.error(`${label}: publish of chunk ${i} failed: ${e.message}`);
                            failed.push(i);
                        }
                    }
                };
                await Promise.all(Array.from({ length: Math.min(PARALLEL, indices.length) }, worker));
                return failed;
            };

            const publishWorker = async () => {
                while (true) {
                    const i = nextIdx++;
                    while (!compDone && (i + 1) * upc > committedBytes) { compStarvedSinceProbe = true; await waitMoreData(); }
                    if (producerFailed) throw producerFailed;
                    if (compDone && i >= tc) return;
                    let payLen = 0;
                    try {
                        payLen = await publishOne(i, 'publish');
                    } catch (pubErr) {
                        Logger.error(`Publish of chunk ${i} failed (after retries): ${pubErr.message}`);
                        failedChunks.push(i);
                        payLen = upc + oh + sealer.overhead;
                    }
                    noteSegment(i);
                    noteBytes(payLen);
                    doneCount++;
                    etaHist.push({ time: performance.now(), value: doneCount });

                    const tcT = tc == null ? estTc : tc;
                    const pct = Math.round((doneCount / tcT) * 100);
                    const nowStats = performance.now();
                    // ETA from the 10s chunk-rate window (drops on stalls);
                    // instant speed from the 1.5s raw-bytes window.
                    const cps = windowedRate(etaHist, nowStats);
                    upState.stage = 'sending';
                    upState.totalBytes = compSize;
                    upState.instBps = instantRate(speedHist, nowStats);
                    upState.avgBps = totalBytesSent / Math.max(0.001, (nowStats - uploadStart) / 1000);
                    upState.etaSec = (cps && cps > 0) ? (tcT - doneCount) / cps : null;
                    upState.processingPct = tc == null ? compPct : null;
                    emitProgress(pct, doneCount, tcT, upState.instBps);
                }
            };

            // Blind-verify breaker: if verify reads keep SUCCEEDING but not a
            // single published chunk is ever visible, the problem is systemic
            // (e.g. the storage node is not subscribed to the chunk partitions —
            // seen when a stream's partition count grows AFTER the node started
            // storing it). Cutting the send rate then just collapses throughput
            // to the drain floor (~90-120KB/s) without helping anyone: stop
            // judging, keep the wire-level backpressure, announce UNVERIFIED.
            let verifyBlind = false;
            let fullMissProbes = 0;

            // Auto-tune v3 (dynamic oscillator): cut on the FIRST failed probe,
            // drain, recover aggressively — oscillates around the optimum.
            //   search -> +22%/clean probe until the 1st miss (ceiling discovery)
            //   cut    -> ceiling = publish-time rate of the invisible chunk; drain low
            //   drain  -> continued misses deepen x1.5; 1 clean probe -> jump to 85% of ceiling
            //   climb  -> +5%/probe up to ~95% -> hold
            //   hold   -> +3% every 3 clean probes (keeps probing the ceiling)
            // Serial cuts (<75s apart) penalize the ceiling 12% each; 4 in a row
            // restart the search. The ceiling does NOT persist across uploads.
            let probeTimer = null;
            if (AUTOTUNE) {
                let probeBusy = false;
                let releasedFull = !atFullStart;
                const atStartTs = Date.now(), throttlesAtStart = dcRadar.throttleCount;
                let judgeAfterTs = 0;
                let atState = 'search';
                let ceilSpacing = 0;
                let drainMisses = 0;
                let holdProbes = 0;
                let lastCutTs = 0, cutStreak = 0, researchOnDrain = false;
                let lastProbeSentBytes = 0, lastProbeT = 0, lastRealBps = 0;
                const rateHist = [{ t: Date.now(), spacing: sendSpacing }];
                const noteRate = () => rateHist.push({ t: Date.now(), spacing: sendSpacing });
                const spacingAt = (ts) => { let s = rateHist[0].spacing; for (const e of rateHist) { if (e.t <= ts) s = e.spacing; else break; } return s; };
                const rateKBs = () => Math.round(maxB / sendSpacing);
                const enterDrain = (lossSp, why) => {
                    ceilSpacing = lossSp;
                    if (lastRealBps > 100 * 1024) ceilSpacing = Math.max(ceilSpacing, maxB * 1000 / (lastRealBps * 1.05));
                    const nowCut = Date.now();
                    cutStreak = (nowCut - lastCutTs < 75000) ? cutStreak + 1 : 1;
                    lastCutTs = nowCut;
                    if (cutStreak > 1) {
                        ceilSpacing *= Math.pow(1.12, cutStreak - 1);
                        if (cutStreak >= 4) researchOnDrain = true;
                    }
                    atState = 'drain'; drainMisses = 0;
                    dcRadar.throttled = false;
                    judgeAfterTs = Date.now();
                    sendSpacing = Math.min(2000, ceilSpacing * 3);
                    noteRate();
                    Logger.warn(`storage auto-tune: ${why} — CUT to ${rateKBs()}KB/s (draining)`);
                };
                probeTimer = setInterval(async () => {
                    if (probeBusy || (tc != null && doneCount >= tc)) return;
                    probeBusy = true;
                    try {
                        if (!releasedFull && atState === 'search' && Date.now() - atStartTs > 10000) {
                            releasedFull = true;
                            if (dcRadar.throttleCount === throttlesAtStart) {
                                sendSpacing = maxB / (24 * 1024 * 1024) * 1000;
                                noteRate();
                            }
                        }
                        const nowP = performance.now();
                        if (lastProbeT > 0 && nowP > lastProbeT + 1000) lastRealBps = (totalBytesSent - lastProbeSentBytes) / ((nowP - lastProbeT) / 1000);
                        lastProbeT = nowP; lastProbeSentBytes = totalBytesSent;
                        dcRadar.peakQ = 0;

                        const now = Date.now();
                        const cand = [];
                        for (let i = 0; i < chunkTs.length; i++) {
                            if (chunkTs[i] && chunkTs[i] > judgeAfterTs && !stored.has(i)) {
                                const age = now - chunkTs[i];
                                if (age > 12000 && age < 40000) cand.push(i);
                            }
                        }
                        if (verifyBlind) return;
                        if (cand.length < 3) return;
                        const sample = [];
                        const step = Math.max(1, Math.floor(cand.length / 5));
                        for (let k = 0; k < cand.length && sample.length < 5; k += step) sample.push(cand[k]);
                        const probeStats = { winsOk: 0, winsFailed: 0, rows: 0, foreignRows: 0 };
                        const found = await this.readStoredIndices(messageStreamId, windowsForIndices(sample), tsIndexForVerify(), bases, 'auto-tune probe', undefined, probeStats, chunkPublisher, chunkPrivateKey);
                        found.forEach(x => stored.add(x));
                        const missed = sample.filter(i => !found.has(i));
                        if (missed.length > 0) {
                            // A failed READ is not a lost chunk — never judge on it.
                            if (probeStats.winsOk === 0) {
                                Logger.warn('storage auto-tune probe: every verify read failed — skipping judgement');
                                return;
                            }
                            Logger.warn(`storage auto-tune probe: ${missed.length}/${sample.length} invisible ` +
                                `(windows ok ${probeStats.winsOk}, failed ${probeStats.winsFailed}, ` +
                                `rows ${probeStats.rows}, foreign-publisher ${probeStats.foreignRows}, stored so far ${stored.size})`);
                            if (atState !== 'drain') {
                                // Double-read before cutting: a chunk missing on
                                // node A may simply not have replicated yet.
                                await sleep(2500);
                                const found2 = await this.readStoredIndices(messageStreamId, windowsForIndices(missed), tsIndexForVerify(), bases, 'cut confirmation', undefined, null, chunkPublisher, chunkPrivateKey);
                                found2.forEach(x => stored.add(x));
                                const confirmed = missed.filter(i => !found2.has(i));
                                if (confirmed.length === 0) return;
                                if (confirmed.length === sample.length && stored.size === 0) {
                                    fullMissProbes++;
                                    if (fullMissProbes >= 3) {
                                        verifyBlind = true;
                                        Logger.error('Storage verify is BLIND on this stream: reads succeed but no ' +
                                            'published chunk is ever visible. Likely the storage node is not subscribed ' +
                                            'to the chunk partitions (partition count grew after it began storing the ' +
                                            'stream) — check/restart the node. Auto-tune cuts disabled; this upload ' +
                                            'will be announced UNVERIFIED.');
                                        return;
                                    }
                                } else {
                                    fullMissProbes = 0;
                                }
                                const oldestTs = Math.min(...confirmed.map(i => chunkTs[i] || Date.now()));
                                enterDrain(spacingAt(oldestTs), `${confirmed.length}/${sample.length} of the probe invisible at ≥12s (2 reads)`);
                            } else {
                                drainMisses++;
                                if (drainMisses >= 2) {
                                    drainMisses = 0;
                                    judgeAfterTs = Date.now();
                                    sendSpacing = Math.min(2000, sendSpacing * 1.5);
                                    noteRate();
                                    Logger.warn(`storage auto-tune: drain insufficient → deepening to ${rateKBs()}KB/s`);
                                }
                            }
                            return;
                        }
                        if (compStarvedSinceProbe) { compStarvedSinceProbe = false; return; }
                        if (dcRadar.throttled && atState !== 'drain') {
                            dcRadar.throttled = false;
                            if (lastRealBps > 100 * 1024) { sendSpacing = Math.max(sendSpacing, maxB * 1000 / (lastRealBps * 1.05)); noteRate(); }
                            return;
                        }
                        if (lastRealBps > 100 * 1024 && (maxB * 1000 / sendSpacing) > lastRealBps * 1.25) return;
                        if (atState === 'search') {
                            sendSpacing = Math.max(10, sendSpacing * 0.82);
                            noteRate();
                        } else if (atState === 'drain') {
                            if (researchOnDrain) {
                                researchOnDrain = false; cutStreak = 0; lastCutTs = 0;
                                atState = 'search';
                                sendSpacing = Math.min(2000, ceilSpacing * 1.6);
                                noteRate();
                            } else {
                                atState = 'climb';
                                sendSpacing = Math.max(10, ceilSpacing / 0.85);
                                noteRate();
                            }
                        } else if (atState === 'climb') {
                            if (sendSpacing <= ceilSpacing / 0.95) {
                                atState = 'hold'; holdProbes = 0;
                            } else {
                                sendSpacing = Math.max(10, sendSpacing * 0.95);
                                noteRate();
                            }
                        } else {
                            holdProbes++;
                            if (holdProbes === 6) { cutStreak = 0; lastCutTs = 0; }
                            if (holdProbes % 3 === 0) {
                                sendSpacing = Math.max(10, sendSpacing * 0.97);
                                noteRate();
                                if (sendSpacing < ceilSpacing) ceilSpacing = sendSpacing;
                            }
                        }
                    } catch (e) { Logger.warn(`storage auto-tune probe failed: ${e.message}`); }
                    finally { probeBusy = false; }
                }, 4000);
            }

            try {
                await Promise.all(Array.from({ length: Math.min(PARALLEL, estTc) }, publishWorker));
            } finally {
                if (probeTimer) clearInterval(probeTimer);
            }

            if (producerP) await producerP;
            if (producerFailed) throw producerFailed;

            const lastChunkTs = Date.now();

            if (failedChunks.length > 0) {
                Logger.warn(`Retrying ${failedChunks.length} failed chunks`);
                emitPhase('Resending failed chunks…', 'sending');
                failedChunks = await republishParallel(failedChunks, 'retry');
            }

            // ---- VERIFY & REPAIR ----
            let storedCount = null;
            if (doVerify) {
                const missingIdx = () => { const m = []; for (let i = 0; i < tc; i++) if (!stored.has(i)) m.push(i); return m; };
                const updVerifyBar = () => {
                    const pct = tc > 0 ? Math.round(stored.size / tc * 100) : 0;
                    emitProgress(pct, stored.size, tc, null);
                };
                updVerifyBar();

                // Frontier visibility: wait until each partition's NEWEST chunk is
                // readable before judging the rest — reads before that undercount.
                const newestByPart = new Array(STORAGE_FILE.CHUNK_PARTITIONS).fill(0);
                for (let i = 0; i < tc; i++) {
                    const k = i % STORAGE_FILE.CHUNK_PARTITIONS;
                    if (chunkTs[i] && chunkTs[i] > newestByPart[k]) newestByPart[k] = chunkTs[i];
                }
                const frontierBaseFor = (k) => bases.length ? bases[k % bases.length] : null;
                const partFrontierVisible = async (k) => {
                    const base = frontierBaseFor(k);
                    if (!base || !newestByPart[k]) return true;
                    try {
                        if (storageEndpoints.supportsMetaFormat(base) !== false) {
                            const arr = await directFetchRangeMeta(base, messageStreamId, firstChunkPartition + k, newestByPart[k] - 1500, newestByPart[k] + 1500);
                            return arr.some(x => x.timestamp === newestByPart[k]);
                        }
                    } catch (e) {
                        if (/HTTP 400/.test(e.message)) storageEndpoints.setMetaFormatSupport(base, false);
                    }
                    try {
                        let seen = false;
                        await directFetchRange(base, messageStreamId, firstChunkPartition + k, newestByPart[k] - 1500, newestByPart[k] + 1500, () => { seen = true; });
                        return seen;
                    } catch (e) { return true; }
                };
                if (bases.length && tc > 1) {
                    const pendingParts = new Set();
                    for (let k = 0; k < STORAGE_FILE.CHUNK_PARTITIONS; k++) if (newestByPart[k] > 0) pendingParts.add(k);
                    let lastPending = pendingParts.size, frontStall = 0;
                    while (pendingParts.size > 0 && frontStall < 10) {
                        for (const k of [...pendingParts]) {
                            try { if (await partFrontierVisible(k)) pendingParts.delete(k); } catch (e) { /* retry next round */ }
                        }
                        if (pendingParts.size === 0) break;
                        frontStall = pendingParts.size < lastPending ? 0 : frontStall + 1;
                        lastPending = pendingParts.size;
                        emitPhase(`Waiting for storage (${STORAGE_FILE.CHUNK_PARTITIONS - pendingParts.size}/${STORAGE_FILE.CHUNK_PARTITIONS} partitions caught up)…`, 'verifying');
                        await sleep(2000);
                    }
                }

                let missing = missingIdx();
                if (missing.length > 0) {
                    emitPhase('Verifying on storage…', 'verifying');
                    const found = await this.readStoredIndices(
                        messageStreamId,
                        allPartitionWindows(firstChunkTs - 15000, Date.now() + 1000),
                        tsIndexForVerify(), bases, 'full sweep',
                        (foundSoFar) => {
                            foundSoFar.forEach(x => stored.add(x));
                            updVerifyBar();
                            emitPhase(`Verifying: ${stored.size}/${tc} confirmed…`, 'verifying');
                        },
                        null,
                        chunkPublisher,
                        chunkPrivateKey
                    );
                    found.forEach(x => stored.add(x));
                    missing = missingIdx();
                    updVerifyBar();
                }

                // Pre-repair drain: re-read while the cluster catches up; repair
                // only what stalls with the frontier already visible.
                if (doSecondChance && !verifyBlind && missing.length > Math.max(10, tc * 0.05)) {
                    const scStart = performance.now();
                    let zeroProgress = 0;
                    let stalledReal = 0;
                    Logger.warn(`Storage pre-repair drain: ${missing.length}/${tc} missing after the sweep`);
                    while (missing.length > 0 && stalledReal < 2 && zeroProgress < 24 && performance.now() - scStart < 5 * 60000) {
                        await sleep(2500);
                        const before = missing.length;
                        const found2 = await this.readStoredIndices(messageStreamId, windowsForIndices(missing), tsIndexForVerify(), bases, 'drain', undefined, null, chunkPublisher, chunkPrivateKey);
                        found2.forEach(x => stored.add(x));
                        missing = missingIdx();
                        updVerifyBar();
                        if (missing.length < before) { zeroProgress = 0; stalledReal = 0; }
                        else {
                            zeroProgress++;
                            const parts = [...new Set(missing.map(i => i % STORAGE_FILE.CHUNK_PARTITIONS))];
                            let allPassed = true;
                            for (const k of parts) { if (!(await partFrontierVisible(k))) { allPassed = false; break; } }
                            if (allPassed) stalledReal++;
                            else stalledReal = 0;
                        }
                        emitPhase(`Waiting for storage: ${missing.length} unconfirmed…`, 'verifying');
                    }
                }

                let pass = 0, stalledPasses = 0;
                while (missing.length > 0 && !verifyBlind && pass < 8 && stalledPasses < 3) {
                    pass++;
                    const storedBeforePass = stored.size;
                    if (pass > 1) sendSpacing = Math.min(2000, sendSpacing * 1.5);
                    Logger.warn(`Storage repair pass ${pass}: ${missing.length} chunks confirmed missing`);
                    emitPhase(`Repairing (pass ${pass})…`, 'repairing');
                    await republishParallel(missing, `repair pass ${pass}`);

                    let stalled = false;
                    let noProg = 0;
                    let lastRepairReadMs = 0;
                    for (let r = 0; r < 30 && missing.length > 0; r++) {
                        const wait = r === 0 ? 2000 : Math.max(0, 2000 - lastRepairReadMs);
                        if (wait > 0) await sleep(wait);
                        const tRead2 = performance.now();
                        const found = await this.readStoredIndices(messageStreamId, windowsForIndices(missing), tsIndexForVerify(), bases, `post-repair pass ${pass}`, undefined, null, chunkPublisher, chunkPrivateKey);
                        found.forEach(x => stored.add(x));
                        const before = missing.length;
                        missing = missingIdx();
                        updVerifyBar();
                        lastRepairReadMs = performance.now() - tRead2;
                        const progressed = missing.length < before;
                        stalled = !progressed;
                        if (progressed) { noProg = 0; continue; }
                        noProg++;
                        if (noProg >= 6) {
                            Logger.warn(`${noProg} reads with no progress — republishing the ${missing.length} missing chunks again`);
                            break;
                        }
                    }
                    stalledPasses = stored.size > storedBeforePass ? 0 : stalledPasses + 1;
                    if (stalledPasses >= 3 && missing.length > 0) {
                        Logger.warn(`3 consecutive repair passes with no progress — ending verify with ${missing.length} missing`);
                    }
                }
                if (verifyBlind && stored.size === 0) {
                    // Reads work but the node never shows our chunks — the count
                    // would be a lie either way. Announce UNVERIFIED (null).
                    storedCount = null;
                    Logger.error('Storage verify skipped (blind) — announcing UNVERIFIED; fix the storage node and re-upload');
                } else {
                    storedCount = stored.size;
                    Logger.info(`Storage verify & repair: ${storedCount}/${tc} chunks confirmed${storedCount < tc ? ' — INCOMPLETE' : ''}`);
                }
            }

            // ---- ANNOUNCE ----
            emitPhase('Publishing announcement…', 'announce');
            const finalMetadata = {
                ...draftMetadata,
                compressedSize: compSize,
                compression,
                totalChunks: tc,
                chunkDataSize: upc,
                firstChunkTs,
                lastChunkTs,
                storedChunks: storedCount
            };
            const announcement = await identityManager.createSignedStorageFileManifest({
                channelId: messageStreamId,
                metadata: finalMetadata,
                id: messageId
            });

            // Refresh the optimistic bubble in place (same object reference the
            // timeline holds) before the network round-trips.
            Object.assign(localMessage, announcement);
            delete localMessage.pending;
            localMessage.verified = { valid: true, trustLevel: await identityManager.getTrustLevel(announcement.sender) };

            const annTss = [];
            if (isDM && channel?.peerAddress) {
                // Same DM sealing as sendDMMessage / mesh announce: everything on a
                // DM channel travels inside the pair's ECDH envelope.
                const privateKey = authManager.wallet?.privateKey;
                const { verified, pending, ...cleanAnnouncement } = announcement;
                // Sealed sender, same as any other DM message
                const pub = await dmManager.sealAndPublish(
                    messageStreamId, channel.peerAddress, cleanAnnouncement);
                if (pub && typeof pub.timestamp === 'number') annTss.push(pub.timestamp);
                dmManager.rememberFileRows?.(messageId, chunkRows(), chunkPrivateKey);
            } else {
                const pub = await streamrController.publishMessage(messageStreamId, announcement, password);
                if (pub && typeof pub.timestamp === 'number') annTss.push(pub.timestamp);
            }

            // Persist locally where a replay cannot restore it.
            if (channel?.writeOnly) {
                await secureStorage.addSentMessage(messageStreamId, announcement);
            }
            if (isDM) {
                // A DM cannot be replayed from the peer's inbox — persist the
                // manifest (it is small: no piece hashes) so this device keeps
                // rendering the bubble across restarts.
                await secureStorage.addSentMessage(messageStreamId, announcement);
            }

            // Confirm the announce is actually stored (publish() resolving
            // guarantees nothing). Timestamp match works on sealed payloads.
            let annStored = false;
            const annWaits = [1500, 3000, 6000, 10000, 15000, 25000];
            for (let a = 1; a <= annWaits.length && !annStored; a++) {
                emitPhase(`Confirming announcement (${a}/${annWaits.length})…`, 'announce');
                await sleep(annWaits[a - 1]);
                try {
                    annStored = await this.isAnnounceStored(messageStreamId, annTss, bases, isDM ? announceRows() : null);
                } catch (e) { Logger.warn(`announce confirmation error: ${e.message}`); }
                if (!annStored && a === 3) {
                    Logger.warn('Announce still not visible — one-off safety republish');
                    try {
                        let rp;
                        if (isDM && channel?.peerAddress) {
                            // Same sealing as the first publish. This path only
                            // fires on the rare "announce not visible" retry,
                            // which is exactly how it stayed on the v1 scheme
                            // after everything around it had moved.
                            const { verified, pending, ...cleanAnnouncement } = announcement;
                            rp = await dmManager.sealAndPublish(
                                messageStreamId, channel.peerAddress, cleanAnnouncement);
                        } else {
                            rp = await streamrController.publishMessage(messageStreamId, announcement, password);
                        }
                        if (rp && typeof rp.timestamp === 'number') annTss.push(rp.timestamp);
                    } catch (e) { /* next confirmation round retries */ }
                }
            }
            Logger.info(annStored
                ? 'Storage announce confirmed on storage ✓'
                : 'Storage announce NOT confirmed (~60s of reads) — it may surface later');

            const unverified = storedCount === null && verifyBlind;
            const ok = failedChunks.length === 0 && (storedCount === tc || (storedCount === null && !verifyBlind));
            const totalSecs = ((performance.now() - uploadStart) / 1000).toFixed(1);
            emitPhase(unverified
                ? 'Stored — UNVERIFIED (storage node issue)'
                : ok ? `Stored in ${totalSecs}s ✓` : `Stored with gaps (${storedCount}/${tc})`, 'done');
            emitProgress(100, tc, tc, null);
            this.uploads.delete(tid);
            try { this.uploadCompleteCallback?.(tid, localMessage); } catch (e) { /* UI */ }

            return { messageId: announcement.id, metadata: finalMetadata };
        } catch (error) {
            upState.error = error.message;
            this.uploads.delete(tid);
            // Drop the optimistic bubble on failure
            if (channel) {
                const idx = channel.messages.indexOf(localMessage);
                if (idx >= 0) channel.messages.splice(idx, 1);
            }
            try { this.fileErrorCallback?.(tid, error.message); } catch (e) { /* UI */ }
            throw error;
        } finally {
            this.activeTransfers--;
            this.releaseWakeLock();
            if (uploadOpfsName) opfsDelete(uploadOpfsName);
        }
    }

    /** Announce visibility check on P0, matching by publish timestamp. */
    /**
     * The verify by the node's `stored` endpoint: exact per row and signed by
     * the key that wrote the chunks, for a stream the writer may not read (a
     * peer's inbox). Null when no provider offers it, so the caller reads.
     */
    async storedIndices(sid, windows, tsIndex, privateKey, label) {
        let providers;
        try { providers = await storageEndpoints.providersWith(sid, 'stored'); } catch { return null; }
        if (!providers?.length) return null;
        const byPartition = new Map();
        for (const [key, i] of tsIndex) {
            const [p, ts] = key.split(':').map(Number);
            if (!windows.some((w) => w.partition === p && ts >= w.from && ts <= w.to)) continue;
            if (!byPartition.has(p)) byPartition.set(p, []);
            byPartition.get(p).push({ timestamp: ts, sequenceNumber: 0, index: i });
        }
        const signer = keySigner(privateKey);
        const found = new Set();
        for (const [partition, rows] of byPartition) {
            const present = await storedOn(providers, sid, partition, rows.map(({ timestamp, sequenceNumber }) => ({ timestamp, sequenceNumber })), signer);
            if (present === null) {
                Logger.warn(`${label}: stored query unanswered on P${partition} — reading instead`);
                return null;
            }
            for (const r of rows) if (present.has(`${r.timestamp}:${r.sequenceNumber}`)) found.add(r.index);
        }
        return found;
    }

    /** Whether any of the announce rows is on storage, by the `stored` endpoint; null when no provider offers it. */
    async storedRows(streamId, rows) {
        let providers;
        try { providers = await storageEndpoints.providersWith(streamId, 'stored'); } catch { return null; }
        if (!providers?.length) return null;
        for (const r of rows) {
            const present = await storedOn(providers, streamId, r.partition, [{ timestamp: r.timestamp, sequenceNumber: r.sequenceNumber }], keySigner(r.privateKey));
            if (present === null) return null;
            if (present.size > 0) return true;
        }
        return false;
    }

    async isAnnounceStored(messageStreamId, annTss, bases, rows = null) {
        if (!annTss.length) return false;
        if (rows?.length) {
            const present = await this.storedRows(messageStreamId, rows);
            if (present !== null) return present;
        }
        const from = Math.min(...annTss) - 1500;
        const to = Math.max(...annTss) + 1500;
        const P0 = MESSAGE_STREAM.MESSAGES;
        for (const base of (bases.length ? bases : [null])) {
            try {
                if (base && storageEndpoints.supportsMetaFormat(base) !== false) {
                    try {
                        const arr = await directFetchRangeMeta(base, messageStreamId, P0, from, to);
                        if (arr.some(m => annTss.includes(m.timestamp))) return true;
                        continue;
                    } catch (e) {
                        if (/HTTP 400/.test(e.message)) storageEndpoints.setMetaFormatSupport(base, false);
                        else throw e;
                    }
                }
                let seen = false;
                const onMsg = (m) => { if (annTss.includes(m.timestamp)) seen = true; };
                if (base) await directFetchRange(base, messageStreamId, P0, from, to, onMsg);
                else await sdkFetchWindow(messageStreamId, P0, from, to, onMsg);
                if (seen) return true;
            } catch (e) {
                if (base) storageEndpoints.noteFailure(base);
            }
        }
        return false;
    }

    // ================= DOWNLOAD =================

    /**
     * Download a storage-shared file described by a storage_file_announce
     * message. Resumable: staging survives in OPFS + a localStorage record.
     *
     * @param {string} messageStreamId - Channel message stream ID (UI context)
     * @param {Object} announceMsg - The full announce message (metadata + sender)
     * @param {string|null} password - Channel password
     */
    async downloadFile(messageStreamId, announceMsg, password = null) {
        const meta = announceMsg?.metadata;
        if (!meta?.transferId || !meta?.totalChunks) throw new Error('Invalid storage file announce');
        const tid = meta.transferId;

        const existing = this.downloads.get(tid);
        if (existing && existing.status === 'downloading') { Logger.warn('Storage download already in progress:', tid); return; }
        if (this.completedFiles.has(tid)) { Logger.info('Storage file already downloaded:', tid); return; }

        const channel = channelManager.getChannel(messageStreamId);
        const isDM = channel?.type === 'dm';

        // Where the chunks LIVE:
        //  - regular channels: the channel's own message stream.
        //  - DMs: the sender published into the RECEIVER's inbox — my own inbox
        //    message stream, NOT channel.streamId (which points at the peer's).
        const chunkStreamId = isDM
            ? streamrController.getDMInboxId(authManager.getAddress())
            : messageStreamId;

        // DM inbox streams are private at the Streamr layer → direct HTTP would
        // return SDK ciphertext. SDK resend it is (we own the inbox, keys are
        // registered by the DM subsystem).
        const bases = isDM ? [] : await storageEndpoints.rotation(chunkStreamId).catch((e) => {
            Logger.warn('storage endpoint resolution failed — download falls back to SDK resend:', e.message);
            return [];
        });
        if (!isDM) {
            Logger.info(`Storage download endpoints (${bases.length}): ${bases.join(', ') || 'none — SDK resend fallback'}`);
        }

        const sealer = await this.makeSealer(channel, password, {
            encSaltB64: meta.encSalt,
            peerAddress: isDM ? (announceMsg.sender || channel?.peerAddress) : null
        });

        const isMobile = hasDom && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
        const DL_CONC = isMobile ? SM.downloadConcurrencyMobile : SM.downloadConcurrencyDesktop;
        const WRITE_BACKPRESSURE_LIMIT = (isMobile ? SM.writeBackpressureMobileMB : SM.writeBackpressureDesktopMB) * 1024 * 1024;

        const transfer = {
            metadata: meta,
            // For the Active Transfers list to navigate to this transfer's
            // channel (web mesh's equivalent field is transfer.streamId).
            streamId: messageStreamId,
            // The announce's own timestamp — the chunk read windows are
            // computed around it, so resumeDownload() has to hand it back
            // (files without firstChunkTs anchor entirely on this; a
            // Date.now() fallback would put old chunks outside the window).
            announceTs: announceMsg.timestamp || null,
            chunks: new Map(),
            totalChunks: meta.totalChunks,
            status: 'downloading',
            startTime: performance.now(),
            bytesReceived: 0,
            etaHistory: [],
            firstByteTime: null,
            resumedCount: 0,
            // Set by pauseDownload()/resumeDownload() — fetchWindowsParallel()
            // checks this between windows and stops early, without discarding
            // any chunk already staged to disk.
            paused: false
        };
        const shouldStop = () => transfer.paused;
        this.downloads.set(tid, transfer);
        this.activeTransfers++;
        this.acquireWakeLock();

        let staging = null, stagingName = null, stagingError = false;
        let writeChain = Promise.resolve();
        let pendingWriteBytes = 0;
        let upcDl = meta.chunkDataSize || null;
        let lastCheckpoint = 0;
        const isCompressed = meta.compression && meta.compression !== 'none';

        const emitProgress = () => {
            const p = this.getDownloadProgress(tid);
            if (!p) return;
            try { this.fileProgressCallback?.(tid, p.percent, p.received, p.total, p.fileSize, p.bytesPerSec); } catch (e) { /* UI */ }
        };
        let lastEmit = 0;
        const throttledEmit = () => {
            const now = performance.now();
            if (now - lastEmit >= 150) { lastEmit = now; emitProgress(); }
        };

        try {
            const annTs = announceMsg.timestamp || Date.now();
            const margin = Math.max(meta.totalChunks * 600 + 10000, 300000);
            const fromT = meta.firstChunkTs ? meta.firstChunkTs - 30000 : annTs - margin;
            const toT = annTs + 60000;

            if (meta.compressedSize > 0) {
                stagingName = `${OPFS_PREFIX}dl_${tid}.z`;

                const rMeta = getResumeMeta(tid);
                if (rMeta && rMeta.stagingName === stagingName
                    && rMeta.compressedSize === meta.compressedSize
                    && rMeta.totalChunks === meta.totalChunks
                    && Array.isArray(rMeta.indices)) {
                    const existing = (await opfsCreateWorkerWriter(stagingName, meta.compressedSize, true)) || (await opfsOpenExisting(stagingName));
                    if (existing && existing.size === meta.compressedSize) {
                        staging = existing;
                        if (rMeta.upc) upcDl = rMeta.upc;
                        for (const idx of rMeta.indices) transfer.chunks.set(idx, 0);
                        transfer.resumedCount = rMeta.indices.length;
                        Logger.info(`Storage download resume: ${transfer.resumedCount}/${meta.totalChunks} chunks already on disk`);
                    } else {
                        clearResumeMeta(tid);
                        if (existing) { try { await existing.writable.abort(); } catch (e) { /* stale */ } }
                        Logger.warn('Invalid storage resume (staging missing or wrong size) — starting from scratch');
                    }
                }

                if (!staging) {
                    staging = await opfsCreateWorkerWriter(stagingName, meta.compressedSize);
                    if (!staging) staging = await opfsCreate(stagingName, meta.compressedSize);
                    if (!staging) Logger.warn('OPFS unavailable — storage download chunks accumulate in memory');
                }

                if (!staging && meta.compressedSize > 400 * 1024 * 1024) {
                    const why = (hasDom && window.isSecureContext)
                        ? 'OPFS is unavailable in this browser'
                        : 'the page is in an INSECURE context — the browser disables OPFS';
                    throw new Error(`A download this size needs disk staging and ${why}.`);
                }

                if (staging && staging.onError) staging.onError((err) => { stagingError = true; Logger.error(`OPFS write (worker) failed: ${err.message}`); });
            }

            const persistCheckpoint = (snapshot, snapUpc) => {
                saveResumeMeta(tid, { stagingName, upc: snapUpc, indices: snapshot, totalChunks: meta.totalChunks, compressedSize: meta.compressedSize, fileName: meta.fileName, savedAt: Date.now() });
            };
            const scheduleCheckpoint = () => {
                if (!staging) return;
                const snapshot = Array.from(transfer.chunks.keys());
                const snapUpc = upcDl;
                if (staging.flush) {
                    staging.flush().then(() => persistCheckpoint(snapshot, snapUpc))
                        .catch(e => { stagingError = true; Logger.error(`storage checkpoint failed: ${e.message}`); });
                    return;
                }
                writeChain = writeChain.then(async () => {
                    await staging.writable.close();
                    staging.writable = await staging.handle.createWritable({ keepExistingData: true });
                    persistCheckpoint(snapshot, snapUpc);
                }).catch(e => { stagingError = true; Logger.error(`storage checkpoint failed: ${e.message}`); });
            };

            const onChunkMessage = async (msg) => {
                let c = msg.content;
                if (!(c instanceof Uint8Array)) return;

                // Sealed channels: open first (warm-up pings and foreign payloads
                // fail decryption or unpack — both are silently skipped).
                let u = null;
                try {
                    const raw = await sealer.open(c, msg.timestamp);
                    u = unpackChunkPayload(raw);
                } catch (e) {
                    return;
                }
                if (!u || u.meta.transferId !== tid) return;
                if (transfer.chunks.has(u.chunkIndex)) return;
                if (u.chunkIndex >= meta.totalChunks) return;

                const chunkBytes = u.chunkData.length;
                if (staging) {
                    if (upcDl === null && u.chunkIndex < meta.totalChunks - 1) upcDl = chunkBytes;
                    const pos = (u.chunkIndex === meta.totalChunks - 1)
                        ? meta.compressedSize - chunkBytes
                        : u.chunkIndex * upcDl;
                    const idx = u.chunkIndex, data = u.chunkData;
                    pendingWriteBytes += chunkBytes;
                    writeChain = writeChain
                        .then(() => staging.writable.write({ type: 'write', position: pos, data }))
                        .catch(e => { stagingError = true; Logger.error(`OPFS write failed (chunk ${idx}): ${e.message}`); })
                        .then(() => { pendingWriteBytes -= chunkBytes; });
                    transfer.chunks.set(u.chunkIndex, chunkBytes);
                    const nowCp = performance.now();
                    if (nowCp - lastCheckpoint > 5000) {
                        lastCheckpoint = nowCp;
                        scheduleCheckpoint();
                    }
                } else {
                    transfer.chunks.set(u.chunkIndex, u.chunkData);
                }
                transfer.bytesReceived += chunkBytes;
                const nowMs = performance.now();
                if (!transfer.firstByteTime) transfer.firstByteTime = nowMs;
                transfer.etaHistory.push({ time: nowMs, value: transfer.chunks.size, bytes: transfer.bytesReceived });
                throttledEmit();

                if (staging && staging.drainBelow) {
                    if (staging.pending() > WRITE_BACKPRESSURE_LIMIT) return staging.drainBelow(WRITE_BACKPRESSURE_LIMIT / 4);
                } else if (pendingWriteBytes > WRITE_BACKPRESSURE_LIMIT) return writeChain;
            };

            const resumedCount = transfer.resumedCount || 0;
            if (resumedCount >= transfer.totalChunks) {
                // Everything already on disk — straight to assembly.
            } else if (resumedCount > 0 && resumedCount >= transfer.totalChunks * 0.3) {
                const missing0 = [];
                for (let i = 0; i < transfer.totalChunks; i++) if (!transfer.chunks.has(i)) missing0.push(i);
                const windows0 = buildMissingWindows(meta, missing0, fromT, toT);
                await fetchWindowsParallel(chunkStreamId, windows0, onChunkMessage, DL_CONC, bases, shouldStop);
            } else {
                const fullWindows = chunkWindowsFor(meta, fromT, toT);
                await fetchWindowsParallel(chunkStreamId, fullWindows, onChunkMessage, DL_CONC, bases, shouldStop);
            }

            let retryPass = 0;
            while (!transfer.paused && transfer.chunks.size < transfer.totalChunks && retryPass < SM.downloadRetryPasses) {
                retryPass++;
                await sleep(2000 * retryPass);
                if (transfer.paused) break;
                const missingNow = [];
                for (let i = 0; i < transfer.totalChunks; i++) if (!transfer.chunks.has(i)) missingNow.push(i);
                const windows = buildMissingWindows(meta, missingNow, fromT, toT);
                Logger.warn(`Storage download retry ${retryPass}/${SM.downloadRetryPasses}: ${missingNow.length} chunks missing → ${windows.length} window(s)`);
                await fetchWindowsParallel(chunkStreamId, windows, onChunkMessage, DL_CONC, bases, shouldStop);
                const recovered = transfer.chunks.size - (transfer.totalChunks - missingNow.length);
                if (recovered === 0) {
                    Logger.warn(`Storage retry made no progress: the storage does not have the ${missingNow.length} missing chunks — incomplete upload`);
                    break;
                }
            }

            if (transfer.chunks.size === transfer.totalChunks && !stagingError) {
                let blob = null;
                if (staging) {
                    transfer.phase = 'Finishing write to disk…';
                    emitProgress();
                    await writeChain;
                    await staging.writable.close();
                    const stagedFile = await staging.handle.getFile();
                    if (!isCompressed) {
                        blob = new Blob([stagedFile], { type: meta.fileType || 'application/octet-stream' });
                        staging = null;
                        clearResumeMeta(tid);
                        opfsDelete(stagingName);
                    } else {
                        // Streaming decompression staged→OPFS output (never the
                        // whole file in RAM).
                        const outName = stagingName.replace(/\.z$/, '.bin');
                        const out = await opfsCreate(outName);
                        if (!out) throw new Error('OPFS output creation failed');
                        const SLICE = 4 * 1024 * 1024;
                        const ds = new DecompressionStream('deflate');
                        const dw = ds.writable.getWriter();
                        let drainError = null;
                        const drain = (async () => {
                            const reader = ds.readable.getReader();
                            // Batch the inflate output into ~8MB blocks before touching
                            // the writable: DecompressionStream emits 16-64KB at a time,
                            // and one main-thread createWritable() write per emission
                            // costs a browser IPC round-trip apiece — extraction ran
                            // slower than the download. The POC batched per input slice;
                            // this bounds the batch by OUTPUT size instead (predictable
                            // peak RAM even for highly compressible data).
                            const FLUSH_BYTES = 8 * 1024 * 1024;
                            let parts = [], pending = 0;
                            const flush = async () => {
                                if (!parts.length) return;
                                const buf = new Uint8Array(pending);
                                let o = 0;
                                for (const p of parts) { buf.set(p, o); o += p.length; }
                                parts = []; pending = 0;
                                await out.writable.write(buf);
                            };
                            try {
                                for (;;) {
                                    const { done, value } = await reader.read();
                                    if (done) break;
                                    if (value && value.length) {
                                        parts.push(value);
                                        pending += value.length;
                                        if (pending >= FLUSH_BYTES) await flush();
                                    }
                                }
                                await flush();
                            } catch (e) { drainError = e; }
                        })();
                        for (let off = 0; off < stagedFile.size; off += SLICE) {
                            if (drainError) throw drainError;
                            const end = Math.min(off + SLICE, stagedFile.size);
                            const buf = new Uint8Array(await stagedFile.slice(off, end).arrayBuffer());
                            await dw.write(buf);
                            transfer.phase = `Extracting… ${Math.round(end / stagedFile.size * 100)}%`;
                            throttledEmit();
                        }
                        await dw.close();
                        await drain;
                        if (drainError) throw drainError;
                        await out.writable.close();
                        const outFile = await out.handle.getFile();
                        blob = new Blob([outFile], { type: meta.fileType || 'application/octet-stream' });
                        staging = null;
                        opfsDelete(stagingName);
                        clearResumeMeta(tid);
                    }
                } else {
                    const all = [];
                    for (let i = 0; i < transfer.totalChunks; i++) all.push(transfer.chunks.get(i));
                    const tl = all.reduce((s, c) => s + c.length, 0);
                    const cb = new Uint8Array(tl);
                    let o = 0; for (const c of all) { cb.set(c, o); o += c.length; }
                    if (isCompressed) {
                        const ds = new DecompressionStream('deflate');
                        const dw = ds.writable.getWriter();
                        const parts = [];
                        const drain = (async () => {
                            const reader = ds.readable.getReader();
                            for (;;) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                if (value && value.length) parts.push(value);
                            }
                        })();
                        await dw.write(cb);
                        await dw.close();
                        await drain;
                        blob = new Blob(parts, { type: meta.fileType || 'application/octet-stream' });
                    } else {
                        blob = new Blob([cb], { type: meta.fileType || 'application/octet-stream' });
                    }
                }

                transfer.phase = null;
                transfer.status = 'complete';
                const url = URL.createObjectURL(blob);
                this.completedFiles.set(tid, { url, blob, metadata: meta });
                emitProgress();
                try { this.fileCompleteCallback?.(tid, meta, url, blob); } catch (e) { /* UI */ }
                Logger.info(`Storage download complete: ${meta.fileName} (${transfer.totalChunks} chunks)`);
            } else if (transfer.cancelled) {
                // Cancel is "I do not want this": staged bytes, resume record
                // and the transfer entry all go. Ordered before the paused
                // branch — cancel sets the paused brake too to stop the loop.
                if (staging) {
                    try { await staging.writable.abort(); } catch (e) { /* dead */ }
                    staging = null;
                }
                if (stagingName) opfsDelete(stagingName);
                clearResumeMeta(tid);
                this.downloads.delete(tid);
                Logger.info('Storage download cancelled:', tid);
            } else if (transfer.paused && !stagingError) {
                // pauseDownload() stopped the fetch loop early — not an error,
                // so no fileErrorCallback. Same "preserve to disk" write as the
                // incomplete branch below: resumeDownload() picks it back up.
                transfer.status = 'paused';
                if (staging) {
                    try {
                        await writeChain;
                        await staging.writable.close();
                        saveResumeMeta(tid, { stagingName, upc: upcDl, indices: Array.from(transfer.chunks.keys()), totalChunks: meta.totalChunks, compressedSize: meta.compressedSize, fileName: meta.fileName, savedAt: Date.now() });
                        Logger.info(`Storage download paused: ${transfer.chunks.size}/${transfer.totalChunks} chunks preserved on disk`);
                    } catch (e2) { Logger.error(`storage pause commit failed: ${e2.message}`); }
                    staging = null;
                }
                emitProgress();
            } else {
                transfer.status = 'error';
                transfer.error = stagingError
                    ? 'Disk write error during staging'
                    : 'Storage incomplete — some chunks are not on the storage nodes. The sender can repair by re-uploading; Retry later.';
                if (staging) {
                    if (stagingError) {
                        try { await staging.writable.abort(); } catch (e) { /* dead */ }
                        staging = null; opfsDelete(stagingName);
                        clearResumeMeta(tid);
                    } else {
                        // Preserve partial progress on disk — Retry resumes from here.
                        try {
                            await writeChain;
                            await staging.writable.close();
                            saveResumeMeta(tid, { stagingName, upc: upcDl, indices: Array.from(transfer.chunks.keys()), totalChunks: meta.totalChunks, compressedSize: meta.compressedSize, fileName: meta.fileName, savedAt: Date.now() });
                            Logger.warn(`Incomplete storage download: ${transfer.chunks.size}/${transfer.totalChunks} chunks preserved on disk`);
                        } catch (e2) { Logger.error(`storage final commit failed: ${e2.message}`); }
                        staging = null;
                    }
                }
                try { this.fileErrorCallback?.(tid, transfer.error); } catch (e) { /* UI */ }
            }
        } catch (error) {
            Logger.error('storage download err:', error);
            transfer.status = 'error';
            transfer.error = error.message;
            if (staging) {
                try {
                    await writeChain;
                    await staging.writable.close();
                    saveResumeMeta(tid, { stagingName, upc: upcDl, indices: Array.from(transfer.chunks.keys()), totalChunks: meta.totalChunks, compressedSize: meta.compressedSize, fileName: meta.fileName, savedAt: Date.now() });
                } catch (e) { /* nothing to preserve */ }
                staging = null;
            }
            try { this.fileErrorCallback?.(tid, error.message); } catch (e) { /* UI */ }
            throw error;
        } finally {
            this.activeTransfers--;
            this.releaseWakeLock();
        }
    }

    /** Session cleanup (logout / client re-init). Blobs are revoked. */
    clear() {
        for (const { url } of this.completedFiles.values()) {
            try { URL.revokeObjectURL(url); } catch (e) { /* revoked */ }
        }
        this.completedFiles.clear();
        this.downloads.clear();
        this.uploads.clear();
        this.warmedUp.clear();
        this.warmUpPromises.clear();
    }
}

export const storageMediaController = new StorageMediaController();
