// The merge vectors are the shared spec: this suite and SyncMergeTest.kt read
// the same JSON, so the two clients cannot resolve a slice to different sides.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mergeState, stampedSliceTs } from '../../src/js/syncMerge.js';

const vectors = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..',
        'docs', 'SYNC-merge-vectors.json'), 'utf8'));

const SLICES = ['blockedPeers', 'dmLeftAt', 'trustedContacts', 'username', 'graphApiKey'];

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

    for (const v of vectors.sent) {
        it(v.what, () => {
            const merged = mergeState(v.base, v.incoming);
            expect(merged.sentMessages).toEqual(v.expected.sentMessages);
            expect(merged.sentDeletedAt).toEqual(v.expected.sentDeletedAt);
        });
    }
});
