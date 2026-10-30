/**
 * Unsent composer state per account and conversation: text, reply and edit.
 * Memory only: drafts of sealed conversations must never reach storage.
 */

const drafts = new Map();

const keyOf = (account, streamId) => `${String(account).toLowerCase()}\n${streamId}`;

export const composerDrafts = {
    /**
     * Keeps a conversation's composer state; an empty one removes it.
     * @param {string} account
     * @param {string} streamId
     * @param {{text?: string, replyTo?: Object|null, editing?: Object|null}} state
     */
    stash(account, streamId, { text = '', replyTo = null, editing = null } = {}) {
        if (!account || !streamId) return;
        const key = keyOf(account, streamId);
        if (!text.trim() && !replyTo && !editing) drafts.delete(key);
        else drafts.set(key, { text, replyTo, editing });
    },

    /**
     * Returns and removes a conversation's draft. A reply or edit whose
     * message has since been deleted is dropped; the text stays.
     * @param {string} account
     * @param {string} streamId
     * @param {Array} [messages] - the conversation's loaded messages
     * @returns {{text: string, replyTo: Object|null, editing: Object|null}|null}
     */
    take(account, streamId, messages = []) {
        if (!account || !streamId) return null;
        const key = keyOf(account, streamId);
        const draft = drafts.get(key);
        if (!draft) return null;
        drafts.delete(key);
        const deleted = (id) => messages.some(m => (m.id || m.timestamp) === id && m._deleted);
        return {
            text: draft.text,
            replyTo: draft.replyTo && !deleted(draft.replyTo.id) ? draft.replyTo : null,
            editing: draft.editing && !deleted(draft.editing.id) ? draft.editing : null
        };
    },

    /**
     * Drops every draft of an account.
     * @param {string} account
     */
    forgetAccount(account) {
        if (!account) return;
        const prefix = `${String(account).toLowerCase()}\n`;
        for (const key of [...drafts.keys()]) {
            if (key.startsWith(prefix)) drafts.delete(key);
        }
    },

    clear() {
        drafts.clear();
    }
};
