/**
 * checkAccessQuorum: the responder's gate decision cross-checks the enabled RPCs
 * before an epoch key is wrapped, so a single lying RPC cannot make it hand a key
 * to a non-member — while staying non-limiting (a lone or custom RPC is accepted,
 * and no endpoint the user did not enable is ever contacted).
 *
 * The RPC layer is stubbed at `_readAccessAt` (per-URL answers) and the enabled
 * URL list is injected via a mocked `getRpcEndpoints`, so no real chain is hit.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

let ENABLED = [];
vi.mock('../../src/js/logger.js', () => ({ Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/js/config.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, getRpcEndpoints: () => ENABLED.map(url => ({ url })) };
});

const { gateManager } = await import('../../src/js/gate.js');

const GATE = '0x' + '11'.repeat(20);
let answers;           // url -> boolean | null
let readSpy;
let userSeq = 0;
let USER;

beforeEach(() => {
    gateManager._accessCache.clear();
    gateManager._warnedGates.clear();
    answers = {};
    USER = '0x' + String(++userSeq).padStart(40, '0'); // fresh user → no cache carryover
    readSpy = vi.spyOn(gateManager, '_readAccessAt')
        .mockImplementation(async (url) => (url in answers ? answers[url] : null));
});

describe('checkAccessQuorum over enabled RPCs', () => {
    it('two enabled, both true → access', async () => {
        ENABLED = ['a', 'b']; answers = { a: true, b: true };
        expect(await gateManager.checkAccessQuorum(GATE, USER)).toEqual({ access: true });
    });

    it('two enabled, both false → no access', async () => {
        ENABLED = ['a', 'b']; answers = { a: false, b: false };
        expect(await gateManager.checkAccessQuorum(GATE, USER)).toEqual({ access: false });
    });

    it('two enabled, only one responds → accept that answer (non-limiting)', async () => {
        ENABLED = ['a', 'b']; answers = { a: true, b: null };
        expect((await gateManager.checkAccessQuorum(GATE, USER)).access).toBe(true);
    });

    it('two enabled, none respond → fail-closed, not cached', async () => {
        ENABLED = ['a', 'b']; answers = { a: null, b: null };
        expect((await gateManager.checkAccessQuorum(GATE, USER)).access).toBe(false);
        expect(gateManager._accessCache.has(`${GATE.toLowerCase()}|${USER.toLowerCase()}`)).toBe(false);
    });

    it('single enabled RPC responding → accept (non-limiting)', async () => {
        ENABLED = ['solo']; answers = { solo: true };
        expect((await gateManager.checkAccessQuorum(GATE, USER)).access).toBe(true);
    });

    it('single enabled RPC that errors → fail-closed', async () => {
        ENABLED = ['solo']; answers = { solo: null };
        expect((await gateManager.checkAccessQuorum(GATE, USER)).access).toBe(false);
    });

    it('disagreement resolved by a third enabled RPC (majority true)', async () => {
        ENABLED = ['a', 'b', 'c', 'd']; answers = { a: true, b: false, c: true, d: false };
        const res = await gateManager.checkAccessQuorum(GATE, USER);
        expect(res.access).toBe(true);
        expect(res.warn).toBeUndefined();
    });

    it('disagreement resolved to false by majority', async () => {
        ENABLED = ['a', 'b', 'c', 'd']; answers = { a: true, b: false, c: false, d: null };
        expect((await gateManager.checkAccessQuorum(GATE, USER)).access).toBe(false);
    });

    it('unresolvable disagreement (no tie-breaker) → fail-closed + warns', async () => {
        ENABLED = ['a', 'b']; answers = { a: true, b: false };
        const res = await gateManager.checkAccessQuorum(GATE, USER);
        expect(res.access).toBe(false);
        expect(res.warn).toBeTruthy();
        // not cached — a healthy RPC next round should decide
        expect(gateManager._accessCache.has(`${GATE.toLowerCase()}|${USER.toLowerCase()}`)).toBe(false);
    });

    it('never queries beyond the enabled set on a clean agreement', async () => {
        ENABLED = ['a', 'b']; answers = { a: true, b: true };
        await gateManager.checkAccessQuorum(GATE, USER);
        const urlsQueried = readSpy.mock.calls.map(c => c[0]);
        expect(new Set(urlsQueried)).toEqual(new Set(['a', 'b']));
    });

    it('warn is rate-limited per gate (second unresolved call is silent)', async () => {
        ENABLED = ['a', 'b']; answers = { a: true, b: false };
        const first = await gateManager.checkAccessQuorum(GATE, USER);
        const second = await gateManager.checkAccessQuorum(GATE, '0x' + '9'.repeat(40));
        expect(first.warn).toBeTruthy();
        expect(second.warn).toBeUndefined();
    });
});
