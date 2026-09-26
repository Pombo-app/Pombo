// The merge vectors are the shared spec: this suite and SyncMergeTest.kt read
// the same JSON, so the two clients cannot resolve a slice to different sides.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mergeState, stampedSliceTs } from '../../src/js/syncMerge.js';
import { syncStateKey } from '../../src/js/syncStateKey.js';

const vectors = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..',
        'docs', 'SYNC-merge-vectors.json'), 'utf8'));

const SLICES = ['blockedPeers', 'dmLeftAt', 'trustedContacts', 'username', 'graphApiKey'];

// The publish cases are patches on a shared base (see the generator).
const at = (root, path) => path.reduce((node, key) => node[key], root);
function applyPatch(state, patch = {}) {
    const out = structuredClone(state);
    for (const [path, value] of patch.set || []) at(out, path.slice(0, -1))[path.at(-1)] = structuredClone(value);
    for (const path of patch.reverse || []) at(out, path).reverse();
    for (const path of patch.reverseKeys || []) {
        const reversed = Object.fromEntries(Object.entries(at(out, path)).reverse());
        if (!path.length) return reversed;
        at(out, path.slice(0, -1))[path.at(-1)] = reversed;
    }
    return out;
}

describe('sync merge parity vectors', () => {
    for (const v of vectors.merge) {
        it(v.what, () => {
            const merged = mergeState(v.base, v.incoming);
            for (const key of SLICES) expect(merged[key]).toEqual(v.expected[key]);
            expect(merged.sliceTs).toEqual(v.expected.sliceTs);
        });
    }

    for (const v of vectors.stamp) {
        it(v.what, () => {
            expect(stampedSliceTs(v.state)).toEqual(v.sliceTs);
        });
    }

    for (const v of vectors.channels) {
        it(v.what, () => {
            const merged = mergeState(v.base, v.incoming);
            expect(merged.channels).toEqual(v.expected.channels);
            expect(merged.channelsLeftAt).toEqual(v.expected.channelsLeftAt);
        });
    }

    for (const v of vectors.publish.cases) {
        it(v.what, () => {
            const from = applyPatch(vectors.publish.base, v.basePatch);
            expect(syncStateKey(from) === syncStateKey(applyPatch(from, v.patch))).toBe(v.same);
        });
    }

    for (const v of vectors.sent) {
        it(v.what, () => {
            const merged = mergeState(v.base, v.incoming);
            expect(merged.sentMessages).toEqual(v.expected.sentMessages);
            expect(merged.sentDeletedAt).toEqual(v.expected.sentDeletedAt);
        });
    }
});
