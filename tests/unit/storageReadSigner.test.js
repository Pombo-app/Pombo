/**
 * Tests for storageReadSigner.js — the message and headers of a signed
 * storage read, locked against docs/STORAGE-signed-read-vectors.json.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Wallet, verifyMessage } from 'ethers';
import {
    parseStorageDataUrl,
    canonicalQuery,
    buildReadMessage,
    randomNonce,
    signedReadHeaders
} from '../../src/js/storageReadSigner.js';

const VECTORS = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'STORAGE-signed-read-vectors.json'), 'utf8'));
const STREAM = '0xaaaabbbbccccddddeeeeffff0000111122223333/deadbeef01-1';
const enc = encodeURIComponent;

describe('parseStorageDataUrl', () => {
    it('splits a data read URL into base, stream, partition, type and canonical query', () => {
        const parsed = parseStorageDataUrl(`https://1.storage.example/streams/${enc(STREAM)}/data/partitions/2/last?count=50&format=raw`);
        expect(parsed).toEqual({
            base: 'https://1.storage.example',
            streamId: STREAM,
            partition: 2,
            resendType: 'last',
            canonicalQuery: 'count=50&format=raw',
            url: `https://1.storage.example/streams/${enc(STREAM)}/data/partitions/2/last?count=50&format=raw`
        });
    });

    it('keeps a path prefix in the base', () => {
        const parsed = parseStorageDataUrl(`https://host.example/storage/streams/${enc(STREAM)}/data/partitions/0/range?fromTimestamp=1&toTimestamp=2`);
        expect(parsed.base).toBe('https://host.example/storage');
        expect(parsed.resendType).toBe('range');
    });

    it('returns null for anything else', () => {
        expect(parseStorageDataUrl('https://1.storage.example/capabilities')).toBeNull();
        expect(parseStorageDataUrl(`https://1.storage.example/streams/${enc(STREAM)}/data/partitions/0/purge`)).toBeNull();
        expect(parseStorageDataUrl(`https://1.storage.example/streams/${enc(STREAM)}/metadata`)).toBeNull();
        expect(parseStorageDataUrl('https://polygon.drpc.org')).toBeNull();
        expect(parseStorageDataUrl('not a url')).toBeNull();
        expect(parseStorageDataUrl(`https://1.storage.example/streams/%E0%A4%A/data/partitions/0/last`)).toBeNull();
    });
});

describe('canonicalQuery', () => {
    it('sorts by name and decodes values', () => {
        expect(canonicalQuery('format=raw&count=5')).toBe('count=5&format=raw');
        expect(canonicalQuery('msgChainId=Ab3%2Fx%2Bz&format=raw')).toBe('format=raw&msgChainId=Ab3/x+z');
    });

    it('keeps repeated names in received order', () => {
        expect(canonicalQuery('x=b&count=1&x=a')).toBe('count=1&x=b&x=a');
    });

    it('is empty for no parameters', () => {
        expect(canonicalQuery('')).toBe('');
        expect(canonicalQuery(new URLSearchParams())).toBe('');
    });
});

describe('buildReadMessage', () => {
    it('joins the fields one per line in protocol order', () => {
        expect(buildReadMessage({
            streamId: STREAM, partition: 1, issuedAt: 1789000000000, nonce: 'abc',
            resendType: 'from', canonicalQuery: 'format=raw&fromTimestamp=0'
        })).toBe(`pombo-storage-node\nread\n${STREAM}\n1\n1789000000000\nabc\nfrom\nformat=raw&fromTimestamp=0`);
    });
});

describe('randomNonce', () => {
    it('is 32 lowercase hex chars and unique', () => {
        const a = randomNonce();
        const b = randomNonce();
        expect(a).toMatch(/^[0-9a-f]{32}$/);
        expect(a).not.toBe(b);
    });
});

describe('signedReadHeaders', () => {
    const wallet = new Wallet(VECTORS.userPriv);
    const signer = { address: wallet.address, sign: (m) => wallet.signMessage(m) };

    it('produces the four headers, signature recovering the user', async () => {
        const parsed = parseStorageDataUrl(`https://1.storage.example/streams/${enc(STREAM)}/data/partitions/0/last?count=1&format=raw`);
        const headers = await signedReadHeaders(parsed, signer, { issuedAt: 1789000000000, nonce: 'ff'.repeat(16) });
        expect(Object.keys(headers).sort()).toEqual(['x-pombo-issued-at', 'x-pombo-nonce', 'x-pombo-signature', 'x-pombo-user']);
        expect(headers['x-pombo-user']).toBe(wallet.address);
        expect(headers['x-pombo-issued-at']).toBe('1789000000000');
        expect(headers['x-pombo-nonce']).toBe('ff'.repeat(16));
        const message = buildReadMessage({
            streamId: STREAM, partition: 0, issuedAt: 1789000000000, nonce: 'ff'.repeat(16),
            resendType: 'last', canonicalQuery: 'count=1&format=raw'
        });
        expect(verifyMessage(message, headers['x-pombo-signature'])).toBe(wallet.address);
    });

    it('defaults to now and a fresh nonce', async () => {
        const parsed = parseStorageDataUrl(`https://1.storage.example/streams/${enc(STREAM)}/data/partitions/0/last?count=1`);
        const before = Date.now();
        const headers = await signedReadHeaders(parsed, signer);
        expect(Number(headers['x-pombo-issued-at'])).toBeGreaterThanOrEqual(before);
        expect(headers['x-pombo-nonce']).toMatch(/^[0-9a-f]{32}$/);
    });

    it('matches every parity vector', async () => {
        expect(VECTORS.vectors.length).toBeGreaterThan(0);
        for (const v of VECTORS.vectors) {
            const parsed = parseStorageDataUrl(v.url);
            expect(parsed.streamId, v.name).toBe(v.streamId);
            expect(parsed.partition, v.name).toBe(v.partition);
            expect(parsed.resendType, v.name).toBe(v.resendType);
            expect(parsed.canonicalQuery, v.name).toBe(v.canonicalQuery);
            const message = buildReadMessage({
                streamId: parsed.streamId, partition: parsed.partition, issuedAt: v.issuedAt,
                nonce: v.nonce, resendType: parsed.resendType, canonicalQuery: parsed.canonicalQuery
            });
            expect(message, v.name).toBe(v.message);
            const headers = await signedReadHeaders(parsed, signer, { issuedAt: v.issuedAt, nonce: v.nonce });
            expect(headers, v.name).toEqual(v.headers);
        }
    });
});
