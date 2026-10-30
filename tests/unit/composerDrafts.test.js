/**
 * Composer drafts: per account and conversation, memory only.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { composerDrafts } from '../../src/js/composerDrafts.js';

const ALICE = '0xAA';
const BOB = '0xbb';

describe('composerDrafts', () => {
    beforeEach(() => composerDrafts.clear());

    it('gives a conversation back its own draft and leaves the others empty', () => {
        composerDrafts.stash(ALICE, 'chan-1', { text: 'half a thought' });
        expect(composerDrafts.take(ALICE, 'chan-2')).toBeNull();
        expect(composerDrafts.take(ALICE, 'chan-1')).toEqual({ text: 'half a thought', replyTo: null, editing: null });
    });

    it('hands a draft out once: after take the conversation is empty', () => {
        composerDrafts.stash(ALICE, 'chan-1', { text: 'once' });
        composerDrafts.take(ALICE, 'chan-1');
        expect(composerDrafts.take(ALICE, 'chan-1')).toBeNull();
    });

    it('keeps the reply and the edit with the text', () => {
        const replyTo = { id: 'm1', text: 'hi', sender: '0x1', senderName: 'Bob' };
        composerDrafts.stash(ALICE, 'chan-1', { text: 'answer', replyTo });
        const editing = { id: 'm2', originalText: 'old', streamId: 'chan-2' };
        composerDrafts.stash(ALICE, 'chan-2', { text: 'new', editing });
        expect(composerDrafts.take(ALICE, 'chan-1').replyTo).toEqual(replyTo);
        expect(composerDrafts.take(ALICE, 'chan-2').editing).toEqual(editing);
    });

    it('keeps a reply with no text yet', () => {
        composerDrafts.stash(ALICE, 'chan-1', { text: '', replyTo: { id: 'm1' } });
        expect(composerDrafts.take(ALICE, 'chan-1').replyTo).toEqual({ id: 'm1' });
    });

    it('stores nothing for an empty composer and an empty stash removes an old draft', () => {
        composerDrafts.stash(ALICE, 'chan-1', { text: '   ' });
        expect(composerDrafts.take(ALICE, 'chan-1')).toBeNull();
        composerDrafts.stash(ALICE, 'chan-1', { text: 'x' });
        composerDrafts.stash(ALICE, 'chan-1', {});
        expect(composerDrafts.take(ALICE, 'chan-1')).toBeNull();
    });

    it('drops a reply or edit whose message was deleted, keeping the text', () => {
        composerDrafts.stash(ALICE, 'chan-1', { text: 'still mine', replyTo: { id: 'gone' } });
        const draft = composerDrafts.take(ALICE, 'chan-1', [{ id: 'gone', _deleted: true }]);
        expect(draft).toEqual({ text: 'still mine', replyTo: null, editing: null });
        composerDrafts.stash(ALICE, 'chan-1', { text: 'edit', editing: { id: 'gone' } });
        expect(composerDrafts.take(ALICE, 'chan-1', [{ id: 'gone', _deleted: true }]).editing).toBeNull();
    });

    it('keeps a reply whose message is simply not loaded', () => {
        composerDrafts.stash(ALICE, 'chan-1', { text: 't', replyTo: { id: 'older' } });
        expect(composerDrafts.take(ALICE, 'chan-1', [{ id: 'other' }]).replyTo).toEqual({ id: 'older' });
    });

    it('keeps accounts apart, case-insensitively', () => {
        composerDrafts.stash(ALICE, 'chan-1', { text: 'alice' });
        expect(composerDrafts.take(BOB, 'chan-1')).toBeNull();
        expect(composerDrafts.take('0xaa', 'chan-1').text).toBe('alice');
    });

    it('forgets one account without touching the others', () => {
        composerDrafts.stash(ALICE, 'chan-1', { text: 'a' });
        composerDrafts.stash(ALICE, 'chan-2', { text: 'b' });
        composerDrafts.stash(BOB, 'chan-1', { text: 'c' });
        composerDrafts.forgetAccount('0xaa');
        expect(composerDrafts.take(ALICE, 'chan-1')).toBeNull();
        expect(composerDrafts.take(ALICE, 'chan-2')).toBeNull();
        expect(composerDrafts.take(BOB, 'chan-1').text).toBe('c');
    });

    it('ignores calls without an account or a conversation', () => {
        composerDrafts.stash(null, 'chan-1', { text: 'x' });
        composerDrafts.stash(ALICE, null, { text: 'x' });
        expect(composerDrafts.take(null, 'chan-1')).toBeNull();
        expect(composerDrafts.take(ALICE, null)).toBeNull();
    });
});
