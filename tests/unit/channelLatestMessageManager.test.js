import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const resendMock = vi.fn();
vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        resendLatestContentMessages: (...args) => resendMock(...args)
    }
}));

import { channelLatestMessageManager } from '../../src/js/channelLatestMessageManager.js';

describe('channelLatestMessageManager', () => {
    const sid = '0xabc/test-1';

    beforeEach(() => {
        // Reset internal state between tests
        channelLatestMessageManager.cache.clear();
        channelLatestMessageManager.inflight.clear();
        channelLatestMessageManager.listeners.clear();
        channelLatestMessageManager.db = null;
        channelLatestMessageManager._initPromise = null;
        resendMock.mockReset();
    });

    it('setFromLocal preserves sender casing for display fallbacks', () => {
        const entry = channelLatestMessageManager.setFromLocal(sid, {
            type: 'text',
            id: 'm1',
            text: 'Hello',
            sender: '0xABCDEF',
            timestamp: 1000
        });
        expect(entry).toMatchObject({ type: 'text', text: 'Hello', sender: '0xABCDEF', id: 'm1' });
        expect(channelLatestMessageManager.getCached(sid)).toEqual(entry);
    });

    it('setFromLocal captures user-set senderName from payload', () => {
        const entry = channelLatestMessageManager.setFromLocal(sid, {
            type: 'text', id: 'm1', text: 'hi', sender: '0xa',
            senderName: '  Alice  ', timestamp: 1
        });
        expect(entry.senderName).toBe('Alice');
    });

    it('setFromLocal leaves senderName null when payload omits or blanks it', () => {
        const e1 = channelLatestMessageManager.setFromLocal(sid, {
            type: 'text', id: 'm1', text: 'hi', sender: '0xa', timestamp: 1
        });
        expect(e1.senderName).toBeNull();
        channelLatestMessageManager.cache.clear();
        const e2 = channelLatestMessageManager.setFromLocal(sid, {
            type: 'text', id: 'm1', text: 'hi', sender: '0xa', senderName: '   ', timestamp: 1
        });
        expect(e2.senderName).toBeNull();
    });

    it('setFromLocal rejects unknown message types', () => {
        const entry = channelLatestMessageManager.setFromLocal(sid, {
            type: 'edit', targetId: 'm1', text: 'x', timestamp: 1
        });
        expect(entry).toBeNull();
        expect(channelLatestMessageManager.getCached(sid)).toBeNull();
    });

    it('setFromLocal does not overwrite a fresher entry with an older one', () => {
        channelLatestMessageManager.setFromLocal(sid, {
            type: 'text', id: 'new', text: 'recent', sender: '0xa', timestamp: 2000
        });
        channelLatestMessageManager.setFromLocal(sid, {
            type: 'text', id: 'old', text: 'old', sender: '0xa', timestamp: 1000
        });
        expect(channelLatestMessageManager.getCached(sid).id).toBe('new');
    });

    it('setFromLocal normalizes reactions and forces action=add', () => {
        const entry = channelLatestMessageManager.setFromLocal(sid, {
            type: 'reaction', emoji: '👍', messageId: 'mX', sender: '0xA', timestamp: 5
        });
        expect(entry).toMatchObject({ type: 'reaction', emoji: '👍', action: 'add', targetId: 'mX', sender: '0xA' });
    });

    it('setFromLocal drops reaction removals (never reach the preview)', () => {
        const entry = channelLatestMessageManager.setFromLocal(sid, {
            type: 'reaction', emoji: '🔥', action: 'remove', messageId: 'mX', sender: '0xA', timestamp: 5
        });
        expect(entry).toBeNull();
        expect(channelLatestMessageManager.getCached(sid)).toBeNull();
    });

    it('emits to subscribers when an entry lands', () => {
        const cb = vi.fn();
        const unsub = channelLatestMessageManager.subscribe(sid, cb);
        channelLatestMessageManager.setFromLocal(sid, {
            type: 'text', id: 'm1', text: 'hi', sender: '0xa', timestamp: 1
        });
        expect(cb).toHaveBeenCalledTimes(1);
        unsub();
        channelLatestMessageManager.setFromLocal(sid, {
            type: 'text', id: 'm2', text: 'bye', sender: '0xa', timestamp: 2
        });
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('get() returns cached entry without re-fetching when entry exists', async () => {
        channelLatestMessageManager.cache.set(sid, {
            id: 'm1', ts: 1, type: 'text', sender: '0xa', text: 'cached'
        });
        const entry = await channelLatestMessageManager.get(sid);
        expect(entry?.text).toBe('cached');
        // Background refresh dispatched but not awaited; resend may have been called once
        expect(resendMock).toHaveBeenCalledTimes(1);
    });

    it('get() awaits resend when nothing is cached and normalizes the result', async () => {
        resendMock.mockResolvedValueOnce([
            {
                type: 'text',
                id: 'm1',
                text: 'hello',
                sender: '0xa',
                _timestamp: 10
            }
        ]);
        const entry = await channelLatestMessageManager.get(sid);
        expect(entry).toMatchObject({ type: 'text', id: 'm1', text: 'hello', sender: '0xa' });
    });

    it('get() prefers a non-reaction entry over a newer reaction in the same window', async () => {
        // Stream order: [reaction(t=20), text(t=10)] (newest-first).
        // Reactions live in the same P0 partition as messages, so a more
        // recent reaction can sit on top of an older content message.
        // The preview should still surface the content message.
        resendMock.mockResolvedValueOnce([
            { type: 'reaction', emoji: '🔥', action: 'add', messageId: 'mX', _publisherId: '0xR', _timestamp: 20 },
            { type: 'text', id: 'm10', text: 'hello', sender: '0xa', _timestamp: 10 }
        ]);
        const entry = await channelLatestMessageManager.get(sid);
        expect(entry).toMatchObject({ type: 'text', id: 'm10', text: 'hello' });
    });

    /**
     * A window with nothing but reactions leaves the preview empty rather
     * than promoting one: an emoji is not what was said here last, and on a
     * channel with a -5 the refresh would never see it again anyway.
     */
    it('get() never promotes a reaction, even when the window holds only that', async () => {
        resendMock.mockResolvedValueOnce([
            { type: 'reaction', emoji: '🔥', action: 'add', messageId: 'mX', _publisherId: '0xR', _timestamp: 20 }
        ]);
        const entry = await channelLatestMessageManager.get(sid);
        expect(entry).toBeNull();
    });

    it('get() dedupes concurrent cold-start fetches', async () => {
        let resolveFn;
        resendMock.mockReturnValueOnce(new Promise(r => { resolveFn = r; }));
        const p1 = channelLatestMessageManager.get(sid);
        const p2 = channelLatestMessageManager.get(sid);
        resolveFn([{ type: 'text', id: 'm1', text: 'x', sender: '0xa', _timestamp: 1 }]);
        const [e1, e2] = await Promise.all([p1, p2]);
        expect(e1).toEqual(e2);
        expect(resendMock).toHaveBeenCalledTimes(1);
    });

    it('clear() removes the cache entry and emits null', () => {
        const cb = vi.fn();
        channelLatestMessageManager.cache.set(sid, { id: 'm1', ts: 1, type: 'text', sender: '0xa', text: 'x' });
        channelLatestMessageManager.subscribe(sid, cb);
        channelLatestMessageManager.clear(sid);
        expect(channelLatestMessageManager.getCached(sid)).toBeNull();
        expect(cb).toHaveBeenCalledWith(null);
    });

    it('hydrate from IDB does not clobber a fresher in-memory entry (reload race)', async () => {
        // Arrange: persist an OLD entry to IDB, then simulate a live
        // message arriving via setFromLocal before init() resolves.
        // After init completes, the fresher in-memory entry must win.
        await channelLatestMessageManager.init();
        const old = { id: 'm-old', ts: 100, type: 'text', sender: '0xa', senderName: null, text: 'old' };
        await channelLatestMessageManager._persistToIDB(sid, old);

        // Reset state so init() will hydrate from IDB on next call.
        channelLatestMessageManager.cache.clear();
        channelLatestMessageManager.db = null;
        channelLatestMessageManager._initPromise = null;

        // Live message lands BEFORE init() — populates cache directly.
        channelLatestMessageManager.setFromLocal(sid, {
            type: 'text', id: 'm-new', text: 'new', sender: '0xa', timestamp: 200
        });
        expect(channelLatestMessageManager.getCached(sid).id).toBe('m-new');

        // Now init() runs (and awaits hydrate). It must NOT overwrite
        // the fresher entry with the stale IDB row.
        await channelLatestMessageManager.init();
        expect(channelLatestMessageManager.getCached(sid).id).toBe('m-new');
        expect(channelLatestMessageManager.getCached(sid).text).toBe('new');
    });

    it('hydrate from IDB merges entries when the cache has none', async () => {
        await channelLatestMessageManager.init();
        const persisted = { id: 'm1', ts: 50, type: 'text', sender: '0xa', senderName: null, text: 'persisted' };
        await channelLatestMessageManager._persistToIDB(sid, persisted);

        channelLatestMessageManager.cache.clear();
        channelLatestMessageManager.db = null;
        channelLatestMessageManager._initPromise = null;

        await channelLatestMessageManager.init();
        expect(channelLatestMessageManager.getCached(sid)).toMatchObject({ id: 'm1', text: 'persisted' });
    });

    /**
     * Rows written while reactions still made a preview line outlive the rule
     * that ended it: a channel with no new message never replaces its row.
     * A DM keeps its own, which is the one surface where the line is right.
     */
    it('hydrate drops a stored reaction preview, except on a DM inbox', async () => {
        const dmId = '0xpeer/Pombo-DM-1';
        await channelLatestMessageManager.init();
        await channelLatestMessageManager._persistToIDB(sid,
            { id: 'r1', ts: 50, type: 'reaction', emoji: '👍', sender: '0xa' });
        await channelLatestMessageManager._persistToIDB(dmId,
            { id: 'r2', ts: 60, type: 'reaction', emoji: '🔥', sender: '0xb' });

        channelLatestMessageManager.cache.clear();
        channelLatestMessageManager.db = null;
        channelLatestMessageManager._initPromise = null;

        await channelLatestMessageManager.init();
        expect(channelLatestMessageManager.getCached(sid)).toBeNull();
        expect(channelLatestMessageManager.getCached(dmId)).toMatchObject({ type: 'reaction', emoji: '🔥' });
    });
});
