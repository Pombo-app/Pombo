/**
 * MessageContextMenuUI
 *
 * Owns the right-click context menu for messages (#message-context-menu).
 * Handles visibility logic per-message (own vs other, DM vs channel,
 * admin vs non-admin) and dispatches actions:
 *   - copy-text / copy-address
 *   - send-dm / add-contact / remove-contact / block-user
 *   - edit-message / delete-message            (own messages)
 *   - admin-delete-message / ban-user          (admin-only, non-DM)
 *   - pin-message / unpin-message              (admin-only, non-DM)
 *
 * Add/Remove contact modals are delegated to ContactsUI via deps.
 */

import { confirmDialog } from './ConfirmDialogUI.js';

/** "Erased from storage on k of n providers", with what the others did. */
function purgeOutcomeText(outcome) {
    const n = outcome.providers;
    return `Erased from storage on ${outcome.erasedOn} of ${n} provider${n === 1 ? '' : 's'}`
        + (outcome.forbiddenOn ? ` (${outcome.forbiddenOn} refused)` : '')
        + (outcome.unreachable ? ` (${outcome.unreachable} unreachable)` : '');
}

class MessageContextMenuUI {
    constructor() {
        this.deps = null;
        this.elements = null;
        this.contextMenuTarget = null;
        this._scrollBlocker = null;
    }

    /** Set dependencies from UIController */
    setDependencies(deps) {
        this.deps = deps;
    }

    /**
     * Element references — only `messagesArea` is required; the menu DOM is
     * looked up lazily in `init()` so it works regardless of caller order.
     */
    setElements(elements) {
        this.elements = elements;
    }

    /** Wire up listeners. Idempotent. */
    init() {
        if (!this.elements) this.elements = {};
        this.elements.contextMenu = document.getElementById('message-context-menu');

        if (this.elements.contextMenu && !this._wired) {
            // Hide on outside click
            document.addEventListener('click', () => this.hideContextMenu());
            // Per-item action dispatch
            this.elements.contextMenu.querySelectorAll('.context-menu-item').forEach(item => {
                item.addEventListener('click', (e) => this.handleContextMenuAction(e));
            });
            // Right-click on messages opens the menu (desktop)
            document.addEventListener('contextmenu', (e) => this.handleMessageRightClick(e));
            // Mobile: double-tap on a message opens the menu 
            // Native long-press contextmenu is suppressed below when triggered by touch.
            this._wireTouchHandlers();
            this._wired = true;
        }
    }

    /**
     * Wire touch-based handlers for mobile:
     *   - Double-tap on a message bubble opens the context menu.
     *   - Native long-press contextmenu (Android Chrome fires `contextmenu`
     *     after a long touch) is suppressed so only double-tap triggers it.
     * @private
     */
    _wireTouchHandlers() {
        const DOUBLE_TAP_MS = 350;
        const TAP_MOVE_TOLERANCE = 10; // px
        const LONGPRESS_SUPPRESS_MS = 1000;

        let lastTapTime = 0;
        let lastTapTarget = null;
        let touchStartX = 0;
        let touchStartY = 0;
        let touchStartTime = 0;
        let touchMoved = false;

        document.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) {
                touchMoved = true;
                return;
            }
            const messageDiv = e.target.closest?.('.message-entry');
            if (!messageDiv || !this.elements.messagesArea?.contains(messageDiv)) return;
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            touchStartTime = Date.now();
            touchMoved = false;
            this._lastTouchOnMessage = touchStartTime;
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (touchMoved || !e.touches[0]) return;
            const dx = e.touches[0].clientX - touchStartX;
            const dy = e.touches[0].clientY - touchStartY;
            if (Math.hypot(dx, dy) > TAP_MOVE_TOLERANCE) touchMoved = true;
        }, { passive: true });

        document.addEventListener('touchend', (e) => {
            if (touchMoved) return;
            const messageDiv = e.target.closest?.('.message-entry');
            if (!messageDiv || !this.elements.messagesArea?.contains(messageDiv)) return;

            // Ignore taps on inner action controls.
            if (e.target.closest?.('.reply-trigger, .react-trigger, .reaction-badge, a, button, img, video')) {
                return;
            }

            const now = Date.now();
            if (lastTapTarget === messageDiv && (now - lastTapTime) < DOUBLE_TAP_MS) {
                e.preventDefault();
                const t = e.changedTouches?.[0];
                this._openMenuForMessage(messageDiv, t?.clientX ?? 0, t?.clientY ?? 0);
                lastTapTime = 0;
                lastTapTarget = null;
                this._lastTouchOnMessage = now;
            } else {
                lastTapTime = now;
                lastTapTarget = messageDiv;
            }
        });

        // Track the suppression window for native long-press contextmenu.
        this._isWithinTouchWindow = () => {
            return this._lastTouchOnMessage
                && (Date.now() - this._lastTouchOnMessage) < LONGPRESS_SUPPRESS_MS;
        };
    }

    /**
     * Right-click handler — decides which menu items to show for the clicked
     * message and positions the menu.
     */
    handleMessageRightClick(e) {
        const { Logger } = this.deps;

        const messageDiv = e.target.closest('.message-entry');
        if (!messageDiv || !this.elements.messagesArea?.contains(messageDiv)) {
            return;
        }

        e.preventDefault();

        // Suppress mobile long-press: if this `contextmenu` was triggered by a
        // recent touch, do not open the menu — only double-tap should.
        if (this._isWithinTouchWindow?.()) {
            return;
        }

        this._openMenuForMessage(messageDiv, e.clientX, e.clientY);
    }

    /**
     * Open the context menu for `messageDiv` at the given viewport coords.
     * @private
     */
    _openMenuForMessage(messageDiv, clientX, clientY) {
        const { Logger } = this.deps;

        const senderAddress = messageDiv.dataset.sender;
        if (!senderAddress) {
            Logger.warn('No sender address found for message');
            return;
        }

        this.contextMenuTarget = {
            element: messageDiv,
            sender: senderAddress,
            msgId: messageDiv.dataset.msgId,
            msgType: messageDiv.dataset.type
        };

        const isSelf = messageDiv.classList.contains('own-message');
        const { channelManager, identityManager } = this.deps;
        const currentChannel = channelManager?.getCurrentChannel?.();

        // Send DM — hide if self or already in DM with this sender
        const sendDMBtn = document.getElementById('context-menu-send-dm-btn');
        const contactDivider = document.getElementById('context-menu-contact-divider');
        let showSendDM = false;
        if (sendDMBtn) {
            const alreadyInDM = currentChannel?.type === 'dm'
                && currentChannel.peerAddress?.toLowerCase() === senderAddress.toLowerCase();
            showSendDM = !isSelf && !alreadyInDM;
            sendDMBtn.classList.toggle('hidden', !showSendDM);
        }

        // Add/Remove Contact
        const addContactBtn = document.getElementById('context-menu-add-contact-btn');
        const removeContactBtn = document.getElementById('context-menu-remove-contact-btn');
        const isContact = !!identityManager?.getTrustedContact?.(senderAddress);
        const showAddContact = !isSelf && !isContact;
        const showRemoveContact = !isSelf && isContact;
        if (addContactBtn) addContactBtn.classList.toggle('hidden', !showAddContact);
        if (removeContactBtn) removeContactBtn.classList.toggle('hidden', !showRemoveContact);
        if (contactDivider) {
            contactDivider.classList.toggle('hidden', !(showSendDM || showAddContact || showRemoveContact));
        }

        // Block User — only inside a DM channel and not for yourself
        const blockBtn = document.getElementById('context-menu-block-btn');
        const blockDivider = document.getElementById('context-menu-block-divider');
        const showBlock = currentChannel?.type === 'dm' && !isSelf;
        if (blockBtn) blockBtn.classList.toggle('hidden', !showBlock);
        if (blockDivider) blockDivider.classList.toggle('hidden', !showBlock);

        // Determine admin status once — used both for routing the delete
        // action and for the admin moderation block below.
        const { channelManager: cm } = this.deps;
        const isDMChannel = currentChannel?.type === 'dm';
        const isPreview = currentChannel?.isPreview === true;
        let isAdminUser = false;
        if (currentChannel && !isDMChannel && !isPreview && cm?.getCachedDeletePermission) {
            const cached = cm.getCachedDeletePermission(currentChannel.streamId);
            isAdminUser = !!cached?.canDelete;
        }

        // Edit / Delete (own messages). Admins on their OWN messages are
        // routed through the admin stream (`hideMessage`) instead of the
        // owner -1/P1 override path so the moderation surface is the
        // single source of truth: receivers apply via `applyAdminState`
        // which is consolidated, replayed deterministically on join, and
        // propagated via the `admin_invalidate` snapshot signal. The
        // owner -1/P1 path is reserved for non-admin authors.
        const editBtn = document.getElementById('context-menu-edit-btn');
        const deleteBtn = document.getElementById('context-menu-delete-btn');
        const editDivider = document.getElementById('context-menu-edit-divider');
        const showEdit = isSelf && messageDiv.dataset.type === 'text';
        // Hide owner-delete when the user is admin — the admin-delete
        // button (rendered by _toggleAdminItems) handles deletion via
        // the admin stream for both own and others' messages.
        const showDelete = isSelf && !isAdminUser;
        if (editBtn) editBtn.classList.toggle('hidden', !showEdit);
        if (deleteBtn) deleteBtn.classList.toggle('hidden', !showDelete);
        if (editDivider) editDivider.classList.toggle('hidden', !showEdit && !showDelete);

        // A moderator holds no stream permission — their authority is on the
        // gate — so hide/ban are offered to them too and routed as deltas.
        const isModeratorUser = !isDMChannel && !isPreview && currentChannel
            && !!cm?.isCachedModerator?.(currentChannel.streamId);

        // Admin moderation: Pin / Unpin / Admin Delete / Ban
        this._toggleAdminItems(currentChannel, senderAddress, isSelf, isAdminUser, isModeratorUser);

        this.showContextMenu(clientX, clientY);
    }

    /**
     * Compute and apply visibility for the admin moderation buttons.
     * @param {Object} currentChannel
     * @param {string} senderAddress  — message author address
     * @param {boolean} isSelf        — message authored by current user
     * @param {boolean} isAdminUser   — current user is the channel admin
     * @param {boolean} isModeratorUser — current user moderates the gate
     * @private
     */
    _toggleAdminItems(currentChannel, senderAddress, isSelf, isAdminUser, isModeratorUser = false) {
        const adminDivider = document.getElementById('context-menu-admin-divider');
        const pinBtn = document.getElementById('context-menu-pin-btn');
        const unpinBtn = document.getElementById('context-menu-unpin-btn');
        const adminDeleteBtn = document.getElementById('context-menu-admin-delete-btn');
        const unhideBtn = document.getElementById('context-menu-unhide-btn');
        const eraseBtn = document.getElementById('context-menu-erase-btn');
        const banBtn = document.getElementById('context-menu-ban-btn');

        const msgId = this.contextMenuTarget?.msgId;
        const isAlreadyPinned = !!(currentChannel?.adminState?.pins?.some?.(p => p.targetId === msgId));
        const isCreator = currentChannel?.createdBy
            && senderAddress.toLowerCase() === String(currentChannel.createdBy).toLowerCase();
        const moderates = isAdminUser || isModeratorUser;
        const isHidden = !!(msgId && currentChannel?.adminState?.hiddenMessageIds?.includes?.(msgId));
        const message = msgId ? currentChannel?.messages?.find?.(m => m.id === msgId) : null;

        const showPin = isAdminUser && !!msgId && !isAlreadyPinned;
        const showUnpin = isAdminUser && !!msgId && isAlreadyPinned;
        // Hide keeps the bytes and is reversible; it is offered on ANY
        // message, the admin's own included, so moderation stays the single
        // surface for admins. Erase goes further: it removes the bytes from
        // every storage provider that can, and only exists where one can.
        const showHide = moderates && !!msgId && !isHidden;
        const showUnhide = moderates && !!msgId && isHidden && !message?._erased;
        const { dmManager } = this.deps;
        const dmErase = currentChannel?.type === 'dm' && !isSelf && !!msgId
            && (dmManager?.inboxPurgeProviders?.length > 0);
        const showErase = dmErase || (moderates && !!msgId && !message?._erased
            && (currentChannel?.purgeProviders?.length > 0));
        // Cannot ban yourself or the channel admin.
        const showBan = moderates && !isSelf && !isCreator;

        if (pinBtn) pinBtn.classList.toggle('hidden', !showPin);
        if (unpinBtn) unpinBtn.classList.toggle('hidden', !showUnpin);
        if (adminDeleteBtn) adminDeleteBtn.classList.toggle('hidden', !showHide);
        if (unhideBtn) unhideBtn.classList.toggle('hidden', !showUnhide);
        if (eraseBtn) eraseBtn.classList.toggle('hidden', !showErase);
        if (banBtn) banBtn.classList.toggle('hidden', !showBan);
        if (adminDivider) adminDivider.classList.toggle('hidden', !(showPin || showUnpin || showHide || showUnhide || showErase || showBan));
    }

    /** Show the menu at viewport coords, clamped to the visible area. */
    showContextMenu(x, y) {
        if (!this.elements.contextMenu) this.init();
        if (!this.elements.contextMenu) return;

        this._blockScroll();

        // Temporarily show to measure dimensions
        this.elements.contextMenu.style.visibility = 'hidden';
        this.elements.contextMenu.classList.remove('hidden');

        const menuWidth = this.elements.contextMenu.offsetWidth;
        const menuHeight = this.elements.contextMenu.offsetHeight;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        if (x + menuWidth > viewportWidth - 10) x = viewportWidth - menuWidth - 10;
        if (y + menuHeight > viewportHeight - 10) y = viewportHeight - menuHeight - 10;
        x = Math.max(10, x);
        y = Math.max(10, y);

        this.elements.contextMenu.style.left = `${x}px`;
        this.elements.contextMenu.style.top = `${y}px`;
        this.elements.contextMenu.style.visibility = 'visible';
    }

    hideContextMenu() {
        this.elements?.contextMenu?.classList.add('hidden');
        this._unblockScroll();
    }

    /** Block scroll on messages area without changing overflow (avoids reflow). */
    _blockScroll() {
        const messagesArea = document.getElementById('messages-area');
        if (!messagesArea || this._scrollBlocker) return;
        const prevent = (e) => e.preventDefault();
        messagesArea.addEventListener('wheel', prevent, { passive: false });
        messagesArea.addEventListener('touchmove', prevent, { passive: false });
        this._scrollBlocker = { el: messagesArea, handler: prevent };
    }

    _unblockScroll() {
        if (!this._scrollBlocker) return;
        const { el, handler } = this._scrollBlocker;
        el.removeEventListener('wheel', handler);
        el.removeEventListener('touchmove', handler);
        this._scrollBlocker = null;
    }

    /** Dispatch the clicked menu item. */
    async handleContextMenuAction(e) {
        const { showNotification, contactsUI, chatAreaUI, channelManager } = this.deps;

        const action = e.currentTarget.dataset.action;
        const target = this.contextMenuTarget;
        if (!target?.sender) {
            this.hideContextMenu();
            return;
        }

        const address = target.sender;
        this.hideContextMenu();

        switch (action) {
            case 'send-dm':
                this.handleSendDM(address);
                break;

            case 'add-contact':
                contactsUI?.showAddModal(address);
                break;

            case 'copy-text': {
                const msgContent = target.element?.querySelector('.message-content');
                const text = msgContent?.innerText || msgContent?.textContent || '';
                try {
                    await navigator.clipboard.writeText(text);
                    showNotification('Text copied!', 'success');
                } catch {
                    showNotification('Failed to copy', 'error');
                }
                break;
            }

            case 'copy-address':
                try {
                    await navigator.clipboard.writeText(address);
                    showNotification('Address copied!', 'success');
                } catch {
                    showNotification('Failed to copy', 'error');
                }
                break;

            case 'remove-contact':
                contactsUI?.showRemoveModal(address);
                break;

            case 'block-user':
                this.handleBlockUser(address);
                break;

            case 'edit-message':
                if (target.msgId && chatAreaUI) {
                    chatAreaUI.startEdit(target.msgId);
                }
                break;

            case 'delete-message': {
                if (!target.msgId) break;
                const ch = channelManager?.getCurrentChannel?.();
                if (!ch) break;
                const providers = ch.purgeProviders?.length || 0;
                const purges = providers > 0 && channelManager.ownPurgeApplies?.(ch.streamId, target.msgId);
                const note = purges
                    ? ` It is also erased from storage on ${providers} provider${providers === 1 ? '' : 's'}.`
                    : (providers > 0
                        ? (ch.wireIdentity === 'sealed'
                            ? " Its copy on storage stays until the channel's retention ends."
                            : ' Its copy on storage cannot be erased from this session.')
                        : '');
                if (!await confirmDialog({ title: 'Delete message', message: `Removed for everyone.${note}`, confirmLabel: 'Delete' })) break;
                try {
                    const outcome = await channelManager.sendDelete(ch.streamId, target.msgId);
                    if (outcome?.error) showNotification(`Deleted, but not erased from storage: ${outcome.error}`, 'warning');
                    else if (outcome) showNotification(purgeOutcomeText(outcome), outcome.erasedOn === outcome.providers ? 'success' : 'warning');
                } catch (err) {
                    showNotification(err?.message || 'Failed to delete message', 'error');
                }
                break;
            }

            case 'admin-delete-message': {
                if (!target.msgId) break;
                if (!await confirmDialog({ title: 'Hide message', message: 'Hidden for everyone in the channel. You can show it again later.', confirmLabel: 'Hide' })) break;
                const ch = channelManager?.getCurrentChannel?.();
                if (!ch) break;
                try {
                    // The owner publishes their snapshot; a moderator has no
                    // permission on the admin stream and signs a delta instead.
                    if (channelManager.isCachedModerator?.(ch.streamId)
                        && !channelManager.getCachedDeletePermission?.(ch.streamId)?.canDelete) {
                        await channelManager.publishModAction(ch.streamId, 'hide', target.msgId);
                    } else {
                        await channelManager.hideMessage(ch.streamId, target.msgId);
                    }
                    showNotification('Message hidden', 'success');
                } catch (err) {
                    showNotification(err?.message || 'Failed to hide message', 'error');
                }
                break;
            }

            case 'unhide-message': {
                if (!target.msgId) break;
                const ch = channelManager?.getCurrentChannel?.();
                if (!ch) break;
                try {
                    if (channelManager.isCachedModerator?.(ch.streamId)
                        && !channelManager.getCachedDeletePermission?.(ch.streamId)?.canDelete) {
                        await channelManager.publishModAction(ch.streamId, 'unhide', target.msgId);
                    } else {
                        await channelManager.unhideMessage(ch.streamId, target.msgId);
                    }
                    showNotification('Message shown again', 'success');
                } catch (err) {
                    showNotification(err?.message || 'Failed to unhide message', 'error');
                }
                break;
            }

            case 'erase-message': {
                if (!target.msgId) break;
                const ch = channelManager?.getCurrentChannel?.();
                const msg = ch?.messages?.find?.(m => m.id === target.msgId);
                if (!ch || !msg) break;
                if (ch.type === 'dm') {
                    const { dmManager } = this.deps;
                    const n = dmManager?.inboxPurgeProviders?.length || 0;
                    if (!await confirmDialog({
                        title: 'Erase from storage',
                        message: `Remove this message from your inbox on ${n} storage provider${n === 1 ? '' : 's'}. It disappears from this device and cannot be recovered.`,
                        confirmLabel: 'Erase'
                    })) break;
                    try {
                        const outcome = await dmManager.eraseReceived(ch.streamId, target.msgId);
                        showNotification(purgeOutcomeText(outcome), outcome.erasedOn === outcome.providers ? 'success' : 'warning');
                    } catch (err) {
                        showNotification(err?.message || 'Failed to erase message', 'error');
                    }
                    break;
                }
                const providers = ch.purgeProviders?.length || 0;
                if (!await confirmDialog({
                    title: 'Erase from storage',
                    message: `Remove this message from ${providers} storage provider${providers === 1 ? '' : 's'}. It stays hidden for everyone and cannot be recovered.`,
                    confirmLabel: 'Erase'
                })) break;
                try {
                    const { authManager } = await import('../auth.js');
                    const { eraseMessage } = await import('../storagePurge.js');
                    const isModOnly = channelManager.isCachedModerator?.(ch.streamId)
                        && !channelManager.getCachedDeletePermission?.(ch.streamId)?.canDelete;
                    // Hide first: the bytes leaving storage does nothing for a
                    // client that still holds the message.
                    if (!ch.adminState?.hiddenMessageIds?.includes?.(target.msgId)) {
                        if (isModOnly) await channelManager.publishModAction(ch.streamId, 'hide', target.msgId);
                        else await channelManager.hideMessage(ch.streamId, target.msgId);
                    }
                    const signer = { address: authManager.getAddress(), sign: (m) => authManager.signMessage(m) };
                    const outcome = await eraseMessage(ch, msg, signer, channelManager.purgeOptions?.(ch));
                    if (outcome.erasedOn > 0) msg._erased = true;
                    showNotification(purgeOutcomeText(outcome), outcome.erasedOn === outcome.providers ? 'success' : 'warning');
                    chatAreaUI?.renderMessages?.(ch.messages, () => chatAreaUI._attachMessageListeners?.());
                } catch (err) {
                    console.warn('Erase from storage failed:', err?.message || err);
                    showNotification(err?.message || 'Failed to erase message', 'error');
                }
                break;
            }

            case 'ban-user': {
                const ch = channelManager?.getCurrentChannel?.();
                if (!ch) break;
                // A moderator's ban is a delta and has no on-chain half, so
                // the two-level modal (which spends gas) is the owner's.
                if (channelManager.isCachedModerator?.(ch.streamId)
                    && !channelManager.getCachedDeletePermission?.(ch.streamId)?.canDelete) {
                    if (!await confirmDialog({ title: 'Hide their messages', message: `Every message from ${address.slice(0, 10)}… is hidden from now on.`, confirmLabel: 'Hide' })) break;
                    try {
                        const { epochKeyManager } = await import('../epochKeyManager.js');
                        await channelManager.publishModAction(
                            ch.streamId, 'ban', address,
                            epochKeyManager.currentEpoch(ch.streamId));
                        showNotification('Member banned', 'success');
                    } catch (err) {
                        showNotification(err?.message || 'Failed to ban member', 'error');
                    }
                    break;
                }
                const { channelModalsUI } = await import('./ChannelModalsUI.js');
                channelModalsUI.showBanMemberModal(address, ch);
                break;
            }

            case 'pin-message': {
                if (!target.msgId) break;
                const ch = channelManager?.getCurrentChannel?.();
                if (!ch) break;
                try {
                    await channelManager.pinMessage(ch.streamId, target.msgId);
                    showNotification('Message pinned', 'success');
                } catch (err) {
                    showNotification(err?.message || 'Failed to pin message', 'error');
                }
                break;
            }

            case 'unpin-message': {
                if (!target.msgId) break;
                const ch = channelManager?.getCurrentChannel?.();
                if (!ch) break;
                try {
                    await channelManager.unpinMessage(ch.streamId, target.msgId);
                    showNotification('Message unpinned', 'success');
                } catch (err) {
                    showNotification(err?.message || 'Failed to unpin message', 'error');
                }
                break;
            }
        }
    }

    /** Open a DM conversation with the given address. */
    async handleSendDM(address) {
        const { dmManager, showNotification } = this.deps;
        if (!dmManager) {
            showNotification('DM system not available', 'error');
            return;
        }
        try {
            await dmManager.startDM(address);
        } catch (e) {
            showNotification(e.message || 'Failed to start DM', 'error');
        }
    }

    /**
     * Find the DM channel for `address` and leave it with `block: true`,
     * then refresh the channel list and navigate away.
     */
    async handleBlockUser(address) {
        const {
            channelManager, showNotification,
            renderChannelList, selectChannel, showConnectedNoChannelState
        } = this.deps;
        if (!channelManager) return;

        const channels = channelManager.getAllChannels();
        const dmChannel = channels.find(
            ch => ch.type === 'dm' && ch.peerAddress?.toLowerCase() === address.toLowerCase()
        );

        if (!dmChannel) {
            showNotification('Could not find DM conversation', 'error');
            return;
        }

        const short = address.slice(0, 6) + '…' + address.slice(-4);
        if (!await confirmDialog({ title: 'Block user', message: `All messages from ${short} will be permanently ignored.`, confirmLabel: 'Block' })) {
            return;
        }

        try {
            await channelManager.leaveChannel(dmChannel.messageStreamId || dmChannel.streamId, { block: true });
            showNotification('User blocked', 'info');

            const remaining = channelManager.getAllChannels();
            if (remaining.length > 0) {
                renderChannelList?.();
                await selectChannel?.(remaining[0].streamId);
            } else {
                renderChannelList?.();
                showConnectedNoChannelState?.();
            }
        } catch (err) {
            showNotification('Failed to block user: ' + err.message, 'error');
        }
    }
}

export const messageContextMenuUI = new MessageContextMenuUI();
