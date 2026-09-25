// The sync framing vectors are the shared spec: this suite and
// SyncChunksTest.kt read the same JSON, so a push split on one client
// reassembles on the other.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { splitSyncPayload, reassembleSyncPayloads } from '../../src/js/syncChunks.js';

const vectors = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..',
        'docs', 'SYNC-chunk-vectors.json'), 'utf8'));

describe('sync framing parity vectors', () => {
    for (const v of vectors.split) {
        it(v.what, () => {
            expect(splitSyncPayload(v.payload, 'runA', vectors.limit)).toEqual(v.messages);
        });
    }

    for (const v of vectors.reassemble) {
        it(v.what, () => {
            expect(reassembleSyncPayloads(v.messages)).toEqual(v.payloads);
        });
    }
});
