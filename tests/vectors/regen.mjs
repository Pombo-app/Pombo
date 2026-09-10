/**
 * Regenerates the parity vectors and mirrors them to the Android checkout.
 *
 * The vectors are the contract between the two clients: each generator prints
 * the canonical answer for one mechanism, and both suites assert against it.
 * They used to be produced by hand — redirect stdout somewhere, copy the file
 * around — which is how they ended up living OUTSIDE both repositories, where
 * CI could not see them and the parity tests silently ran on nothing.
 *
 * envelope-vectors.json has no generator: it was produced from a live SDK
 * message and only a comment refers to it.
 *
 * Usage: npm run vectors
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const docs = join(repo, 'docs');

/** A sibling checkout keeps the mirror one command away instead of one habit. */
const ANDROID_CANDIDATES = ['Pombo Android', 'Pombo-Android'];

const GENERATORS = {
    'gen_authorship_vectors.mjs': 'GATED-CHANNELS-authorship-vectors.json',
    'gen_hello_vectors.mjs': 'GATED-CHANNELS-hello-vectors.json',
    'gen_mod_action_vectors.mjs': 'GATED-CHANNELS-mod-action-vectors.json',
    'gen_mod_composition_vectors.mjs': 'GATED-CHANNELS-mod-composition-vectors.json',
    'gen_wrap_v2_vectors.mjs': 'GATED-CHANNELS-wrap-v2-vectors.json',
    'gen_storage_read_vectors.mjs': 'STORAGE-signed-read-vectors.json'
};

const androidDocs = (() => {
    for (const name of ANDROID_CANDIDATES) {
        const candidate = join(repo, '..', name, 'docs');
        if (existsSync(join(repo, '..', name))) return candidate;
    }
    return null;
})();

mkdirSync(docs, { recursive: true });
if (androidDocs) mkdirSync(androidDocs, { recursive: true });

let changed = 0;
for (const [generator, file] of Object.entries(GENERATORS)) {
    const out = execFileSync(process.execPath, [join(here, generator)], { encoding: 'utf8' });
    const target = join(docs, file);
    const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
    writeFileSync(target, out);
    if (before !== out) { changed++; console.log(`changed  ${file}`); }
    if (androidDocs) writeFileSync(join(androidDocs, file), out);
}

console.log(androidDocs
    ? `${Object.keys(GENERATORS).length} vectors written, mirrored to ${androidDocs}`
    : `${Object.keys(GENERATORS).length} vectors written (no Android checkout beside this one)`);
if (changed) console.log(`${changed} changed — commit them in BOTH repositories.`);
