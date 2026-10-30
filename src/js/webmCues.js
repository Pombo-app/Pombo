/**
 * Makes a MediaRecorder WebM seekable. MediaRecorder streams it: the Segment and
 * every Cluster have unknown sizes, Info has no Duration and there are no Cues,
 * so ExoPlayer treats the file as unseekable and a seek restarts it.
 */

const ID = {
    SEGMENT: 0x18538067,
    INFO: 0x1549A966,
    TIMECODE_SCALE: 0x2AD7B1,
    DURATION: 0x4489,
    TRACKS: 0x1654AE6B,
    CLUSTER: 0x1F43B675,
    CLUSTER_TIMECODE: 0xE7,
    CUES: 0x1C53BB6B,
    CUE_POINT: 0xBB,
    CUE_TIME: 0xB3,
    CUE_TRACK_POSITIONS: 0xB7,
    CUE_TRACK: 0xF7,
    CUE_CLUSTER_POSITION: 0xF1,
    TRACK_ENTRY: 0xAE,
    TRACK_NUMBER: 0xD7
};

// Segment children an unknown-size Cluster ends at.
const SEGMENT_LEVEL = new Set([0x114D9B74, ID.INFO, ID.TRACKS, ID.CLUSTER, ID.CUES, 0x1941A469, 0x1043A770, 0x1254C367]);

const CUE_SPACING_MS = 1000;

function readVint(bytes, pos, keepMarker) {
    const first = bytes[pos];
    if (first === undefined || first === 0) throw new Error('bad vint');
    let len = 1;
    while (!(first & (0x80 >> (len - 1)))) len++;
    if (pos + len > bytes.length) throw new Error('truncated vint');
    const mask = (0x80 >> (len - 1)) - 1;
    let value = keepMarker ? first : first & mask;
    let unknown = (first & mask) === mask;
    for (let i = 1; i < len; i++) {
        value = value * 256 + bytes[pos + i];
        if (bytes[pos + i] !== 0xff) unknown = false;
    }
    return { value, len, unknown: !keepMarker && unknown };
}

function readHeader(bytes, pos) {
    const id = readVint(bytes, pos, true);
    const size = readVint(bytes, pos + id.len, false);
    return { id: id.value, start: pos, dataStart: pos + id.len + size.len, size: size.unknown ? null : size.value };
}

function readUint(bytes, start, size) {
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + bytes[start + i];
    return value;
}

function idBytes(id) {
    const out = [];
    for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
    return out;
}

// Fixed 8-byte sizes, so every length is known before any offset is written.
function size8(n) {
    const out = [0x01];
    for (let i = 6; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) % 256);
    return out;
}

function uintBytes(n, width) {
    const out = [];
    for (let i = width - 1; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) % 256);
    return out;
}

function element(id, payload) {
    return [...idBytes(id), ...size8(payload.length), ...payload];
}

function uintElement(id, n, width) {
    return [...idBytes(id), 0x80 | width, ...uintBytes(n, width)];
}

function floatElement(id, value) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, value);
    return [...idBytes(id), 0x88, ...b];
}

function children(bytes, start, end) {
    const out = [];
    let pos = start;
    while (pos < end) {
        const h = readHeader(bytes, pos);
        if (h.size === null) throw new Error('unknown size inside a known element');
        h.end = h.dataStart + h.size;
        if (h.end > end) throw new Error('element overruns its parent');
        out.push(h);
        pos = h.end;
    }
    return out;
}

/**
 * @param {Uint8Array} bytes - a WebM file
 * @param {number} durationMs - the audio's real length
 * @returns {Uint8Array|null} the seekable file, or null to keep the original as it is
 */
export function addWebmCues(bytes, durationMs) {
    if (!(durationMs > 0)) return null;
    try {
        return rewrite(bytes, durationMs);
    } catch {
        return null;
    }
}

function rewrite(bytes, durationMs) {
    const ebml = readHeader(bytes, 0);
    if (ebml.id !== 0x1A45DFA3 || ebml.size === null) return null;
    const headerEnd = ebml.dataStart + ebml.size;
    const segment = readHeader(bytes, headerEnd);
    if (segment.id !== ID.SEGMENT) return null;
    const segmentEnd = segment.size === null ? bytes.length : segment.dataStart + segment.size;
    if (segmentEnd > bytes.length) return null;

    const before = [];
    const clusters = [];
    let info = null;
    let trackNumber = 1;
    let pos = segment.dataStart;
    while (pos < segmentEnd) {
        const h = readHeader(bytes, pos);
        if (h.id === ID.CUES) return null;
        if (h.id === ID.CLUSTER) {
            let end;
            if (h.size === null) {
                end = h.dataStart;
                while (end < segmentEnd) {
                    const child = readHeader(bytes, end);
                    if (SEGMENT_LEVEL.has(child.id)) break;
                    if (child.size === null) return null;
                    end = child.dataStart + child.size;
                }
                if (end > segmentEnd) return null;
            } else {
                end = h.dataStart + h.size;
            }
            const timecode = children(bytes, h.dataStart, end).find(c => c.id === ID.CLUSTER_TIMECODE);
            if (!timecode) return null;
            clusters.push({ dataStart: h.dataStart, end, timecode: readUint(bytes, timecode.dataStart, timecode.size) });
            pos = end;
            continue;
        }
        if (h.size === null) return null;
        h.end = h.dataStart + h.size;
        if (h.end > segmentEnd) return null;
        if (clusters.length) return null;
        if (h.id === ID.INFO) {
            info = h;
        } else if (h.id === ID.TRACKS) {
            const entry = children(bytes, h.dataStart, h.end).find(c => c.id === ID.TRACK_ENTRY);
            const number = entry && children(bytes, entry.dataStart, entry.end).find(c => c.id === ID.TRACK_NUMBER);
            if (number) trackNumber = readUint(bytes, number.dataStart, number.size);
        }
        before.push(h);
        pos = h.end;
    }
    if (!info || !clusters.length) return null;

    const infoChildren = children(bytes, info.dataStart, info.end);
    if (infoChildren.some(c => c.id === ID.DURATION)) return null;
    const scaleEl = infoChildren.find(c => c.id === ID.TIMECODE_SCALE);
    const timecodeScale = scaleEl ? readUint(bytes, scaleEl.dataStart, scaleEl.size) : 1000000;
    const infoPayload = [...bytes.subarray(info.dataStart, info.end), ...floatElement(ID.DURATION, durationMs * 1e6 / timecodeScale)];

    const head = [];
    for (const h of before) {
        if (h === info) head.push(...element(ID.INFO, infoPayload));
        else head.push(...bytes.subarray(h.start, h.end));
    }

    const cued = [];
    let lastCueMs = -Infinity;
    for (const c of clusters) {
        const ms = c.timecode * timecodeScale / 1e6;
        if (ms - lastCueMs >= CUE_SPACING_MS) {
            cued.push(c);
            lastCueMs = ms;
        }
    }
    const cuePoint = (c, position) => element(ID.CUE_POINT, [
        ...uintElement(ID.CUE_TIME, c.timecode, 8),
        ...element(ID.CUE_TRACK_POSITIONS, [
            ...uintElement(ID.CUE_TRACK, trackNumber, 1),
            ...uintElement(ID.CUE_CLUSTER_POSITION, position, 8)
        ])
    ]);
    const cuesLength = idBytes(ID.CUES).length + 8 + cued.length * cuePoint({ timecode: 0 }, 0).length;

    let offset = head.length + cuesLength;
    const clusterHeader = idBytes(ID.CLUSTER).length + 8;
    for (const c of clusters) {
        c.position = offset;
        offset += clusterHeader + (c.end - c.dataStart);
    }
    const cues = element(ID.CUES, cued.flatMap(c => cuePoint(c, c.position)));
    if (cues.length !== cuesLength) return null;

    const segmentPayloadLength = offset;
    const out = new Uint8Array(headerEnd + idBytes(ID.SEGMENT).length + 8 + segmentPayloadLength);
    let w = 0;
    const put = (arr) => { out.set(arr, w); w += arr.length; };
    put(bytes.subarray(0, headerEnd));
    put([...idBytes(ID.SEGMENT), ...size8(segmentPayloadLength)]);
    put(head);
    put(cues);
    for (const c of clusters) {
        put([...idBytes(ID.CLUSTER), ...size8(c.end - c.dataStart)]);
        put(bytes.subarray(c.dataStart, c.end));
    }
    return w === out.length ? out : null;
}
