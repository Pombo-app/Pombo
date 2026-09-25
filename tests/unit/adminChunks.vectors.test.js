// The ADMIN_STATE framing vectors are the shared spec: this suite and
// AdminChunksTest.kt read the same JSON, so a snapshot split by one client's
// owner reassembles on the other client's members.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { splitFramed, joinFramed, ADMIN_FRAME } from '../../src/js/syncChunks.js';

const vectors = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..',
        'docs', 'ADMIN-chunk-vectors.json'), 'utf8'));

describe('ADMIN_STATE framing parity vectors', () => {
    for (const v of vectors.split) {
        it(v.what, () => {
            expect(splitFramed(v.payload, 'runA', ADMIN_FRAME, vectors.limit)).toEqual(v.messages);
        });
    }

    for (const v of vectors.reassemble) {
        it(v.what, () => {
            expect(joinFramed(v.messages, ADMIN_FRAME).map(r => r.payload)).toEqual(v.payloads);
        });
    }

    it('keeps each chunk free of a lone surrogate half', () => {
        const straddling = vectors.split.find(v => v.what.includes('surrogate'));
        for (const m of straddling.messages.filter(r => r.type === 'admin_chunk')) {
            expect(m.data).toBe(m.data.toWellFormed());
        }
    });
});
