/**
 * Message composer: send, shortcuts, reply/edit bars and typing.
 */

import { channelManager } from '../../channels.js';
import { chatAreaUI } from '../ChatAreaUI.js';
import { previewModeUI } from '../PreviewModeUI.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachComposer(ui) {
    // Send message
    ui.elements.sendMessageBtn.addEventListener('click', () => {
        ui.handleSendMessage();
    });

    // Ctrl/Cmd+Enter to send (Enter alone inserts a newline). On mobile, use the send button.
    ui.elements.messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            ui.handleSendMessage();
        }
        // Escape to cancel reply or edit
        if (e.key === 'Escape') {
            if (chatAreaUI.getEditingMessage()) {
                chatAreaUI.cancelEdit();
            } else if (ui.replyingTo) {
                chatAreaUI.cancelReply();
                ui.replyingTo = null;
            }
        }
    });
    
    // Reply bar close button
    ui.elements.replyBarClose?.addEventListener('click', () => {
        chatAreaUI.cancelReply();
        ui.replyingTo = null;
    });

    // Edit bar close button
    document.getElementById('edit-bar-close')?.addEventListener('click', () => {
        chatAreaUI.cancelEdit();
    });

    // Infinite-scroll history loading is driven by an IntersectionObserver
    // sentinel installed by ChatAreaUI.renderMessages — no raw 'scroll'
    // listener needed (avoids per-frame layout reads).
    
    // Mobile: tap on message to show reply/react buttons
    ui.elements.messagesArea?.addEventListener('click', (e) => {
        const messageEntry = e.target.closest('.message-entry');
        const isActionButton = e.target.closest('.reply-trigger, .react-trigger, .reaction-badge');
        
        // Don't toggle when clicking action buttons
        if (isActionButton) return;
        
        // Clear any previously active message
        document.querySelectorAll('.message-entry.message-active').forEach(el => {
            if (el !== messageEntry) {
                el.classList.remove('message-active');
            }
        });
        
        // Toggle active state on tapped message
        if (messageEntry) {
            messageEntry.classList.toggle('message-active');
        }
    });

    // (Auto-resize handled by CSS min-h/max-h on the contenteditable input.)

    // Typing indicator - send signal while typing
    let typingTimeout;
    let lastTypingSent = 0;
    ui.elements.messageInput.addEventListener('input', () => {
        const now = Date.now();
        // Send typing signal every 2 seconds while typing
        if (now - lastTypingSent > 2000) {
            const currentChannel = channelManager.getCurrentChannel();
            const preview = currentChannel ? null : previewModeUI.getPreviewChannel();
            const streamId = currentChannel?.streamId ?? preview?.streamId;
            if (streamId) {
                channelManager.sendTypingIndicator(streamId, preview);
            }
            lastTypingSent = now;
        }
        
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            // Stop typing
        }, 3000);
    });
}
