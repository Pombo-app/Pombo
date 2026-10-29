/**
 * Reaction Manager
 * Handles message reactions, emoji picker, and reaction UI
 */

import { Logger } from '../logger.js';
import { sanitizeText } from './sanitizer.js';
import { placeMessageMeta } from './MessageRenderer.js';

// Default emojis for emoji picker
const DEFAULT_EMOJIS = [
    '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇',
    '🙂', '🙃', '😉', '😍', '🥰', '😘', '😋', '😛', '😜', '🤪',
    '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😔', '😢', '😭',
    '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨',
    '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😬', '🙄', '😯',
    '😲', '🥱', '😴', '🤤', '😵', '🤐', '🥴', '🤢', '🤮', '🤧',
    '👍', '👎', '👏', '🙌', '🤝', '🙏', '✌️', '🤞', '🤟', '🤘',
    '👋', '💪', '❤️', '🔥', '⭐', '🎉', '🎊', '💯', '✅', '❌',
    '⚡', '🚀', '💀', '👻', '🤖', '👽', '💩', '🤡'
];

class ReactionManager {
    constructor() {
        this.messageReactions = null;
        this.reactionPickerTimeout = null;
        this.deps = {};
    }

    /**
     * Set dependencies
     * @param {Object} deps - { getCurrentAddress, onSendReaction }
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * Initialize reactions map
     */
    init() {
        if (!this.messageReactions) {
            this.messageReactions = new Map();
        }
    }

    /**
     * Clear all reactions (when switching channels)
     */
    clear() {
        if (this.messageReactions) {
            this.messageReactions.clear();
        }
    }

    /**
     * Load reactions from channel state
     * @param {Object} reactions - Reactions object from channel state
     */
    loadFromChannelState(reactions) {
        this.init();
        this.clear();
        
        for (const [messageId, emojiMap] of Object.entries(reactions)) {
            this.messageReactions.set(messageId, emojiMap);
        }
    }

    /**
     * Get reactions for a message
     * @param {string} msgId - Message ID
     * @returns {Object|undefined} - Reactions map for message
     */
    getReactions(msgId) {
        return this.messageReactions?.get(msgId);
    }

    /**
     * Export all reactions as Object (for transferring to channel state)
     * @returns {Object} - Reactions object { messageId -> { emoji -> [users] } }
     */
    exportAsObject() {
        if (!this.messageReactions) return {};
        
        const result = {};
        for (const [messageId, emojiMap] of this.messageReactions.entries()) {
            result[messageId] = emojiMap;
        }
        return result;
    }

    /**
     * Add or toggle a reaction
     * @param {string} msgId - Message ID
     * @param {string} emoji - Emoji to toggle
     * @returns {{ isRemoving: boolean }} - Whether reaction was removed
     */
    toggleReaction(msgId, emoji) {
        this.init();
        
        const currentAddress = this.deps.getCurrentAddress?.();
        if (!currentAddress) return { isRemoving: false };
        
        if (!this.messageReactions.has(msgId)) {
            this.messageReactions.set(msgId, {});
        }
        
        const reactions = this.messageReactions.get(msgId);
        if (!reactions[emoji]) {
            reactions[emoji] = [];
        }
        
        const userIndex = reactions[emoji].findIndex(u => u.toLowerCase() === currentAddress.toLowerCase());
        const isRemoving = userIndex >= 0;
        
        if (isRemoving) {
            reactions[emoji].splice(userIndex, 1);
            // Clean up empty arrays
            if (reactions[emoji].length === 0) {
                delete reactions[emoji];
            }
        } else {
            reactions[emoji].push(currentAddress);
        }
        
        // Update the UI
        this.updateReactionUI(msgId);
        
        // Send reaction via callback
        if (this.deps.onSendReaction) {
            this.deps.onSendReaction(msgId, emoji, isRemoving);
        }
        
        return { isRemoving };
    }

    /**
     * Handle incoming reaction from other users
     * @param {string} msgId - Message ID
     * @param {string} emoji - Emoji
     * @param {string} sender - Sender address
     * @param {string} action - 'add' or 'remove'
     */
    handleIncomingReaction(msgId, emoji, sender, action = 'add') {
        this.init();
        
        if (!this.messageReactions.has(msgId)) {
            this.messageReactions.set(msgId, {});
        }
        
        const reactions = this.messageReactions.get(msgId);
        if (!reactions[emoji]) {
            reactions[emoji] = [];
        }
        
        const senderLower = sender.toLowerCase();
        const userIndex = reactions[emoji].findIndex(u => u.toLowerCase() === senderLower);
        
        if (action === 'remove') {
            if (userIndex >= 0) {
                reactions[emoji].splice(userIndex, 1);
                if (reactions[emoji].length === 0) {
                    delete reactions[emoji];
                }
                this.updateReactionUI(msgId);
            }
        } else {
            if (userIndex < 0) {
                reactions[emoji].push(sender);
                this.updateReactionUI(msgId);
            }
        }
    }

    /**
     * Update reaction UI for specific message
     * @param {string} msgId - Message ID
     */
    updateReactionUI(msgId) {
        const container = document.querySelector(`[data-reactions-for="${CSS.escape(msgId)}"]`);
        if (!container) return;
        
        const reactions = this.messageReactions?.get(msgId);
        const currentAddress = this.deps.getCurrentAddress?.()?.toLowerCase();
        
        container.innerHTML = '';
        
        if (reactions) {
            for (const [emoji, users] of Object.entries(reactions)) {
                if (users.length > 0) {
                    const userReacted = users.some(u => u.toLowerCase() === currentAddress);
                    const badge = document.createElement('span');
                    badge.className = `reaction-badge ${userReacted ? 'user-reacted' : ''}`;
                    badge.dataset.emoji = emoji;
                    badge.dataset.msgId = msgId;
                    // Defense-in-depth: sanitize emoji from network
                    badge.innerHTML = `<span class="reaction-emoji">${sanitizeText(emoji)}</span>${users.length}`;
                    badge.addEventListener('click', () => this.toggleReaction(msgId, emoji));
                    container.appendChild(badge);
                }
            }
        }
        placeMessageMeta(container.closest('.message-entry'));
    }

    /**
     * Show reaction picker near a button
     * @param {Event} e - Mouse event
     * @param {string} msgId - Message ID
     * @param {HTMLElement} triggerBtn - Button that triggered picker
     */
    showReactionPicker(e, msgId, triggerBtn) {
        const picker = document.getElementById('reaction-picker');
        if (!picker) return;
        
        // Clear any pending hide timeout
        if (this.reactionPickerTimeout) {
            clearTimeout(this.reactionPickerTimeout);
            this.reactionPickerTimeout = null;
        }
        
        // Block scroll on messages area without changing overflow (avoids layout reflow)
        this._blockScroll();
        
        // Position near the button
        const rect = e.target.getBoundingClientRect();
        
        // Temporarily show picker to measure dimensions
        picker.style.visibility = 'hidden';
        picker.style.display = 'flex';
        
        const pickerWidth = picker.offsetWidth;
        const pickerHeight = picker.offsetHeight;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        
        // Calculate initial position
        let left = rect.left;
        let top = rect.bottom + 5;
        
        // Adjust if picker would overflow right edge
        if (left + pickerWidth > viewportWidth - 10) {
            left = viewportWidth - pickerWidth - 10;
        }
        
        // Adjust if picker would overflow bottom edge
        if (top + pickerHeight > viewportHeight - 10) {
            top = rect.top - pickerHeight - 5;
        }
        
        // Ensure minimum left
        left = Math.max(10, left);
        
        picker.style.left = `${left}px`;
        picker.style.top = `${top}px`;
        picker.style.visibility = 'visible';
        
        // Store current message ID
        picker.dataset.currentMsgId = msgId;
        
        // Attach click handlers
        picker.querySelectorAll('span').forEach(span => {
            span.onclick = () => {
                this.toggleReaction(msgId, span.dataset.emoji);
                this.hideReactionPicker();
            };
        });
        
        // Setup mouse leave handlers
        const hidePickerWithDelay = () => {
            this.reactionPickerTimeout = setTimeout(() => {
                this.hideReactionPicker();
            }, 150);
        };
        
        const cancelHide = () => {
            if (this.reactionPickerTimeout) {
                clearTimeout(this.reactionPickerTimeout);
                this.reactionPickerTimeout = null;
            }
        };
        
        picker.onmouseleave = hidePickerWithDelay;
        picker.onmouseenter = cancelHide;
        
        if (triggerBtn) {
            triggerBtn.onmouseleave = hidePickerWithDelay;
        }
    }

    /**
     * Initialize emoji picker for message input
     * @param {HTMLElement} messageInput - Message input element
     */
    initEmojiPicker(messageInput) {
        const emojiPicker = document.getElementById('emoji-picker');
        const emojiBtn = document.getElementById('emoji-btn');
        
        if (!emojiPicker || !emojiBtn) return;
        
        emojiPicker.innerHTML = DEFAULT_EMOJIS.map(e => `<span>${e}</span>`).join('');
        
        // Add click handlers
        emojiPicker.querySelectorAll('span').forEach(span => {
            span.addEventListener('click', () => {
                if (messageInput) {
                    messageInput.textContent += span.textContent;
                    messageInput.dispatchEvent(new Event('input', { bubbles: true }));
                    messageInput.focus();
                }
            });
        });
        
        // Toggle emoji picker
        emojiBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            emojiPicker.style.display = emojiPicker.style.display === 'flex' ? 'none' : 'flex';
        });
        
        // Close picker when clicking outside
        document.addEventListener('click', (e) => {
            if (!emojiPicker.contains(e.target) && e.target !== emojiBtn) {
                emojiPicker.style.display = 'none';
            }
            
            // Also close reaction picker
            const reactionPicker = document.getElementById('reaction-picker');
            if (reactionPicker && !reactionPicker.contains(e.target)) {
                this.hideReactionPicker();
            }
            
            // Also close attach menu
            const attachMenu = document.getElementById('attach-menu');
            const attachBtn = document.getElementById('attach-btn');
            if (attachMenu && !attachMenu.contains(e.target) && e.target !== attachBtn) {
                attachMenu.classList.add('hidden');
            }
        });
    }

    /**
     * Attach reaction listeners to message buttons
     * @param {Function} onReply - Callback for reply button
     * @param {Function} onFileDownload - Callback for mesh file download
     * @param {Function} onScrollToMessage - Callback to scroll to message
     * @param {Function} onStorageFileDownload - Callback for storage (persistent) file download
     */
    attachReactionListeners(onReply, onFileDownload, onScrollToMessage, onStorageFileDownload) {
        // React buttons
        document.querySelectorAll('.react-btn').forEach(btn => {
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            
            // Desktop: show on hover
            newBtn.addEventListener('mouseenter', (e) => {
                const msgId = newBtn.dataset.msgId;
                this.showReactionPicker(e, msgId, newBtn);
            });
            
            // Mobile: show on tap
            newBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const msgId = newBtn.dataset.msgId;
                this.showReactionPicker(e, msgId, newBtn);
            });
        });
        
        // Reply buttons
        document.querySelectorAll('.reply-btn').forEach(btn => {
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            
            newBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const msgId = newBtn.dataset.msgId;
                if (onReply) onReply(msgId);
            });
        });
        
        // Reply preview click - scroll to original message
        document.querySelectorAll('.reply-preview').forEach(preview => {
            preview.addEventListener('click', () => {
                const replyToId = preview.dataset.replyToId;
                if (replyToId && onScrollToMessage) {
                    onScrollToMessage(replyToId);
                }
            });
        });
        
        // Reaction badges
        document.querySelectorAll('.reaction-badge').forEach(badge => {
            badge.addEventListener('click', () => {
                const msgId = badge.dataset.msgId;
                const emoji = badge.dataset.emoji;
                this.toggleReaction(msgId, emoji);
            });
        });
        
        // Download buttons (mesh swarm)
        document.querySelectorAll('.download-file-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const fileId = btn.dataset.fileId;
                if (onFileDownload) await onFileDownload(fileId);
            });
        });

        // Download buttons (persistent, storage nodes)
        document.querySelectorAll('.storage-download-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (onStorageFileDownload) await onStorageFileDownload(btn.dataset.fileId, btn.dataset.msgId);
            });
        });
    }

    /**
     * Hide the reaction picker
     */
    hideReactionPicker() {
        const reactionPicker = document.getElementById('reaction-picker');
        if (reactionPicker) {
            reactionPicker.style.display = 'none';
        }
        
        // Re-enable scroll on messages area
        this._unblockScroll();
        
        // Also clear any pending hide timeout
        if (this.reactionPickerTimeout) {
            clearTimeout(this.reactionPickerTimeout);
            this.reactionPickerTimeout = null;
        }
    }

    /** Block scroll on messages area without changing overflow (avoids layout reflow) */
    _blockScroll() {
        const messagesArea = document.getElementById('messages-area');
        if (!messagesArea || this._scrollBlocker) return;
        const prevent = (e) => e.preventDefault();
        messagesArea.addEventListener('wheel', prevent, { passive: false });
        messagesArea.addEventListener('touchmove', prevent, { passive: false });
        this._scrollBlocker = { el: messagesArea, handler: prevent };
    }

    /** Restore scroll on messages area */
    _unblockScroll() {
        if (!this._scrollBlocker) return;
        const { el, handler } = this._scrollBlocker;
        el.removeEventListener('wheel', handler);
        el.removeEventListener('touchmove', handler);
        this._scrollBlocker = null;
    }
}

// Export singleton instance
export const reactionManager = new ReactionManager();
