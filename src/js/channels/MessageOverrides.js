/**
 * Changes to messages already published: reactions, edits and deletes.
 * Edits and deletes ride the append-only override protocol; reactions are
 * their own message type but share the same shape, an operation naming a
 * message that already exists.
 */

import { Logger } from '../logger.js';
import { streamrController, STREAM_CONFIG } from '../streamr.js';
import { authManager } from '../auth.js';
import { identityManager } from '../identity.js';
import { secureStorage } from '../secureStorage.js';
import { dmManager } from '../dm.js';
import { CONFIG } from '../config.js';
import { hasChannelIdentity, getChannelIdentity } from '../channelIdentity.js';

export class MessageOverrides {
    /**
     * Self-calls go through `manager` on purpose: while the manager is still
     * the entry point, anything that replaces one of its methods has to keep
     * intercepting the calls this class makes.
     * @param {Object} manager - the channel manager
     */
    constructor(manager) {
        this.manager = manager;
        // Deduplication: track reactions currently being sent
        // Prevents duplicate reaction sends on rapid clicks
        this.pendingReactions = new Set(); // streamId:messageId:emoji:action
        this.REACTION_DEBOUNCE_MS = CONFIG.channels.reactionDebounceMs;
        // Deduplication: track edit/delete operations currently being sent
        this.pendingOverrides = new Set(); // streamId:targetId:type
    }

    /**
     * Store a reaction in the channel object
     * @param {Object} channel - Channel object
     * @param {string} messageId - Message ID
     * @param {string} emoji - Emoji
     * @param {string} user - User address
     * @param {string} action - 'add' or 'remove' (default: 'add')
     */
    storeReaction(channel, messageId, emoji, user, action = 'add') {
        if (!channel.reactions) {
            channel.reactions = {};
        }
        if (!channel.reactions[messageId]) {
            channel.reactions[messageId] = {};
        }
        if (!channel.reactions[messageId][emoji]) {
            channel.reactions[messageId][emoji] = [];
        }
        
        const normalizedUser = user.toLowerCase();
        const userIndex = channel.reactions[messageId][emoji].findIndex(u => u.toLowerCase() === normalizedUser);
        
        if (action === 'remove') {
            // Remove user from reaction
            if (userIndex >= 0) {
                channel.reactions[messageId][emoji].splice(userIndex, 1);
                // Clean up empty arrays
                if (channel.reactions[messageId][emoji].length === 0) {
                    delete channel.reactions[messageId][emoji];
                }
                if (Object.keys(channel.reactions[messageId]).length === 0) {
                    delete channel.reactions[messageId];
                }
            }
        } else {
            // Add user if not already in the list
            if (userIndex < 0) {
                channel.reactions[messageId][emoji].push(user);
            }
        }
    }

    /**
     * Get reactions for a channel
     * @param {string} streamId - Stream ID
     * @returns {Object} - Reactions object { messageId -> { emoji -> [users] } }
     */
    getChannelReactions(streamId) {
        const channel = this.manager.channels.get(streamId);
        return channel?.reactions || {};
    }

    // ==================== Message Edit/Delete (Append-Only Overrides) ====================

    /**
     * Handle an edit or delete override message (real-time or from history)
     * Validates account matches original message sender, then applies the override.
     * @param {string} streamId - Stream ID
     * @param {Object} data - Override message { type: 'edit'|'delete', targetId, text?, account, timestamp }
     * @param {boolean} [fromHistory=false] - Whether this is from history replay (skip notification)
     */
    handleOverrideMessage(streamId, data, fromHistory = false) {
        const channel = this.manager.channels.get(streamId);
        if (!channel) return;

        const account = data.account;
        if (!account || !data.targetId) return;

        // Find the original message
        const original = channel.messages.find(m => m.id === data.targetId);

        if (!original) {
            // Message not loaded yet — store as pending override to apply later
            if (!(channel._pendingOverrides instanceof Map)) channel._pendingOverrides = new Map();
            const existing = channel._pendingOverrides.get(data.targetId);
            // Keep only the latest override per targetId
            if (!existing || data.timestamp > existing.timestamp) {
                channel._pendingOverrides.set(data.targetId, data);
            }
            return;
        }

        // SECURITY: Only the original sender can edit/delete their message
        if (original.sender?.toLowerCase() !== account.toLowerCase()) {
            Logger.warn('Override rejected: sender mismatch', {
                originalSender: original.sender, overrideSender: account
            });
            return;
        }

        // Apply the override
        if (data.type === 'edit') {
            if (!data.text) return;
            original.text = data.text;
            original._edited = true;
            original._editedAt = data.timestamp;
        } else if (data.type === 'delete') {
            // Remove from messages array
            const idx = channel.messages.indexOf(original);
            if (idx >= 0) channel.messages.splice(idx, 1);
            this.rememberDeleted(channel, data.targetId);
        }

        if (!fromHistory) {
            this.manager.notifyHandlers(data.type === 'edit' ? 'message_edited' : 'message_deleted', {
                streamId,
                targetId: data.targetId
            });
        }
    }

    /**
     * Storage keeps a deleted message's row, and the catch-up and refresh
     * reads bring rows back without their overrides: the id is remembered
     * for the session so no read reinstates it.
     * @param {Object} channel - Channel object
     * @param {string} targetId - The deleted message
     */
    rememberDeleted(channel, targetId) {
        if (!(channel._deletedIds instanceof Set)) channel._deletedIds = new Set();
        channel._deletedIds.add(targetId);
    }

    /**
     * Apply any pending overrides to messages that just arrived (e.g. from history)
     * Called after messages are added to channel.messages
     * @param {Object} channel - Channel object
     */
    applyPendingOverrides(channel) {
        if (!(channel._pendingOverrides instanceof Map) || channel._pendingOverrides.size === 0) return;
        
        const applied = [];
        for (const [targetId, override] of channel._pendingOverrides) {
            const msg = channel.messages.find(m => m.id === targetId);
            if (!msg) continue;
            
            // Verify sender match
            if (msg.sender?.toLowerCase() !== override.account?.toLowerCase()) continue;
            
            if (override.type === 'edit' && override.text) {
                msg.text = override.text;
                msg._edited = true;
                msg._editedAt = override.timestamp;
            } else if (override.type === 'delete') {
                msg._deleted = true;
                msg._deletedAt = override.timestamp;
                this.rememberDeleted(channel, targetId);
            }
            applied.push(targetId);
        }
        
        for (const id of applied) {
            channel._pendingOverrides.delete(id);
        }

        // Prune deleted messages in place (preserving array identity) so the
        // final state matches handleOverrideMessage's splice path. Callers no
        // longer need to remember a `filter(m => !m._deleted)` afterwards —
        // forgetting it used to leave deleted messages visible.
        for (let i = channel.messages.length - 1; i >= 0; i--) {
            if (channel.messages[i]._deleted) channel.messages.splice(i, 1);
        }
    }

    /**
     * Send an edit for a previously sent message
     * @param {string} streamId - Message Stream ID (channel key)
     * @param {string} targetId - ID of the message to edit
     * @param {string} newText - New text content
     */
    async sendEdit(streamId, targetId, newText) {
        if (!newText?.trim()) throw new Error('Edit text cannot be empty');
        
        const channel = this.manager.channels.get(streamId);
        if (!channel) throw new Error('Channel not found');

        // DM channels: route through DMManager
        if (channel.type === 'dm') {
            return await dmManager.sendEdit(streamId, targetId, newText);
        }

        const overrideKey = `${streamId}:${targetId}:edit`;
        if (this.pendingOverrides.has(overrideKey)) return;
        this.pendingOverrides.add(overrideKey);

        try {
            const original = channel.messages.find(m => m.id === targetId);
            if (!original) throw new Error('Message not found');
            
            const myAddress = authManager.getAddress();
            if (original.sender?.toLowerCase() !== myAddress?.toLowerCase()) {
                throw new Error('Can only edit your own messages');
            }

            const override = {
                type: 'edit',
                targetId,
                text: newText.trim(),
                timestamp: Date.now()
            };

            // Apply locally first (optimistic)
            original.text = override.text;
            original._edited = true;
            original._editedAt = override.timestamp;

            this.manager.notifyHandlers('message_edited', { streamId, targetId });

            // Publish to control partition when available, else fallback to content partition
            const overridePartition = channel?._controlPartitionSupported === false
                ? STREAM_CONFIG.MESSAGE_STREAM.MESSAGES
                : STREAM_CONFIG.MESSAGE_STREAM.CONTROL;
            // publishAsChannel, not publish: edits/deletes must ride the SAME
            // identity as the message they override — the channel's ephemeral
            // key with the proof (public/password), or the account (gated/
            // read-only). Going through the raw account path put the wallet
            // on the wire beside ephemeral messages.
            await streamrController.publishAsChannel(
                streamId,
                overridePartition,
                override,
                channel.password
            );
            Logger.debug('Edit published for message:', targetId);
        } finally {
            setTimeout(() => this.pendingOverrides.delete(overrideKey), 2000);
        }
    }

    /**
     * Send a delete for a previously sent message
     * @param {string} streamId - Message Stream ID (channel key)
     * @param {string} targetId - ID of the message to delete
     */
    async sendDelete(streamId, targetId) {
        const channel = this.manager.channels.get(streamId);
        if (!channel) throw new Error('Channel not found');

        // DM channels: route through DMManager
        if (channel.type === 'dm') {
            return await dmManager.sendDelete(streamId, targetId);
        }

        const overrideKey = `${streamId}:${targetId}:delete`;
        if (this.pendingOverrides.has(overrideKey)) return;
        this.pendingOverrides.add(overrideKey);

        try {
            const original = channel.messages.find(m => m.id === targetId);
            if (!original) throw new Error('Message not found');
            
            const myAddress = authManager.getAddress();
            if (original.sender?.toLowerCase() !== myAddress?.toLowerCase()) {
                throw new Error('Can only delete your own messages');
            }

            const override = {
                type: 'delete',
                targetId,
                timestamp: Date.now()
            };

            // Apply locally first (optimistic) — remove from messages array
            const idx = channel.messages.indexOf(original);
            if (idx >= 0) channel.messages.splice(idx, 1);
            this.rememberDeleted(channel, targetId);

            this.manager.notifyHandlers('message_deleted', { streamId, targetId });

            // Publish to control partition when available, else fallback to content partition
            const overridePartition = channel?._controlPartitionSupported === false
                ? STREAM_CONFIG.MESSAGE_STREAM.MESSAGES
                : STREAM_CONFIG.MESSAGE_STREAM.CONTROL;
            // Same identity as the message it deletes — see sendEdit.
            await streamrController.publishAsChannel(
                streamId,
                overridePartition,
                override,
                channel.password
            );
            Logger.debug('Delete published for message:', targetId);
            return await this.purgeOwnMessage(channel, original);
        } finally {
            setTimeout(() => this.pendingOverrides.delete(overrideKey), 2000);
        }
    }

    /**
     * The signer an own delete can erase the message from storage with, or
     * null when the purge does not apply. The node honours whoever signed the
     * message: the account on a Visible gated (or read-only) channel, the
     * session pseudonym on public/password, where an older message is out of
     * its author's reach. Sealed channels sign with the shared key, so nobody
     * can claim authorship there.
     * @param {Object} channel - Channel record
     * @param {Object} msg - The message being deleted
     * @returns {{address: string, sign: (message: string) => Promise<string>}|null}
     */
    ownPurgeSigner(channel, msg) {
        if (!channel || channel.type === 'dm' || !(channel.purgeProviders?.length > 0)) return null;
        if (channel.wireIdentity === 'sealed') return null;
        if (this.manager.usesAccountPublish(channel.streamId)) {
            return { address: authManager.getAddress(), sign: (m) => authManager.signMessage(m) };
        }
        if (!hasChannelIdentity(channel.streamId)) return null;
        const { publisherId, wallet } = getChannelIdentity(channel.streamId);
        if (msg?._publisherId && String(msg._publisherId).toLowerCase() !== publisherId.toLowerCase()) return null;
        return { address: wallet.address, sign: (m) => wallet.signMessage(m) };
    }

    /**
     * The storage side of an own delete. A failure comes back on the outcome
     * rather than failing a delete that already went out.
     * @param {Object} channel - Channel record
     * @param {Object} msg - The deleted message
     * @returns {Promise<Object|null>} storagePurge outcome, null when the purge does not apply
     */
    async purgeOwnMessage(channel, msg) {
        const signer = this.ownPurgeSigner(channel, msg);
        if (!signer) return null;
        try {
            const { eraseMessage } = await import('../storagePurge.js');
            return await eraseMessage(channel, msg, signer, this.manager.purgeOptions?.(channel));
        } catch (err) {
            Logger.warn('Storage purge of own message failed:', err?.message || err);
            return { providers: channel.purgeProviders.length, erasedOn: 0, forbiddenOn: 0, unreachable: 0, error: err?.message || String(err) };
        }
    }

    /**
     * Send reaction to a message
     * @param {string} streamId - Stream ID
     * @param {string} messageId - Message ID to react to
     * @param {string} emoji - Emoji reaction
     * @param {boolean} isRemoving - True if removing reaction
     */
    async sendReaction(streamId, messageId, emoji, isRemoving = false) {
        const action = isRemoving ? 'remove' : 'add';
        
        // DEDUPLICATION: Create unique key for this reaction operation
        // Prevents duplicate sends on rapid clicks
        const reactionKey = `${streamId}:${messageId}:${emoji}:${action}`;
        
        if (this.pendingReactions.has(reactionKey)) {
            Logger.debug('Reaction already pending, skipping duplicate:', reactionKey);
            return; // Silently skip duplicate
        }
        
        this.pendingReactions.add(reactionKey);
        
        try {
            const channel = this.manager.channels.get(streamId);
            if (!channel) return;

            const reaction = {
                type: 'reaction',
                action: action,
                messageId: messageId,
                emoji: emoji,
                senderName: identityManager.getUsername?.() || null,
                timestamp: Date.now()
            };

            // DM channels: sealed sender before publishing to peer's inbox
            if (channel.type === 'dm' && channel.peerAddress) {
                const myAddress = authManager.getAddress();
                await dmManager.sealAndPublish(
                    streamId, channel.peerAddress, reaction,
                    STREAM_CONFIG.MESSAGE_STREAM.MESSAGES);

                // Persist locally — we won't receive our own reaction back from peer's inbox
                await secureStorage.addSentReaction(streamId, messageId, emoji, myAddress, action);
            } else {
                // Regular channels: send to MESSAGE stream (stored) via publishReaction
                await streamrController.publishReaction(
                    streamId,
                    reaction,
                    channel.password
                );
            }
            
            // Persist locally for write-only channels
            if (channel.writeOnly) {
                // Use own address — the reaction object has no `user` field
                // (the old `reaction.user` was always undefined, breaking
                // reaction rendering after reload on write-only channels)
                await secureStorage.addSentReaction(streamId, messageId, emoji, authManager.getAddress(), action);
            }
            
            Logger.debug('Reaction', action, ':', emoji, 'to message:', messageId);
        } catch (error) {
            Logger.error('Failed to send reaction:', error);
        } finally {
            // Remove from pending after debounce period to prevent rapid re-sends
            setTimeout(() => {
                this.pendingReactions.delete(reactionKey);
            }, this.REACTION_DEBOUNCE_MS);
        }
    }
}
