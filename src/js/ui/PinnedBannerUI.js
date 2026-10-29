/**
 * PinnedBannerUI
 *
 * Renders the pinned-message banner shown at the top of the chat area
 * (between the channel header and the messages list).
 *
 * Behaviour:
 *  - Reads `channel.adminState.pins` from the active channel (or preview
 *    channel) and opens on the most recently pinned message.
 *  - Click on the banner → scroll to the shown pin, then show the one before
 *    it (wrapping). A "k/N" counter says which pin is shown.
 *  - Close (×) → hide the banner until a newer pin arrives. Remembered per
 *    account and channel on this device; the "Pinned" channel-menu action
 *    brings it back.
 *  - DOMPurify-safe: text rendered via `textContent` only.
 */

import { previewModeUI } from './PreviewModeUI.js';
import { formatAddress } from './utils.js';
import { identityManager } from '../identity.js';
import { subscriptionBannerUI } from './SubscriptionBannerUI.js';
import { CONFIG } from '../config.js';

class PinnedBannerUI {
    constructor() {
        this.deps = {};
        this.elements = null;
        // streamId → targetId of the newest pin when the banner was closed
        this._hidden = {};
        this._hiddenFor = undefined;
        // streamId → index (newest first) of the pin on show
        this._cursor = new Map();
        // Tracks the pin currently shown so click handlers know what to scroll to
        this._currentPin = null;
        this._currentStreamId = null;
    }

    /** @param {Object} deps - { channelManager, chatAreaUI, getActiveChannel, getAccount, Logger } */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * @param {Object} elements - { banner, name, text, count, closeBtn }
     */
    init(elements) {
        this.elements = elements;
        if (!elements?.banner) return;

        elements.banner.addEventListener('click', (e) => {
            if (e.target.closest('#pinned-banner-close')) return;
            this.jumpAndAdvance();
        });
        elements.banner.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.jumpAndAdvance();
            }
        });
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(() => this._reserveSpace()).observe(elements.banner);
        }

        if (elements.closeBtn) {
            elements.closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.dismissCurrent();
            });
        }

        this._wireAdminUpdates();
    }

    /** Subscribe to admin_state_updated so the banner refreshes live. */
    _wireAdminUpdates() {
        const { channelManager } = this.deps;
        if (!channelManager?.onMessage) return;
        channelManager.onMessage((event, data) => {
            if (event !== 'admin_state_updated') return;
            const ch = this._resolveChannel();
            if (!ch || ch.streamId !== data?.streamId) return;
            this._cursor.delete(ch.streamId);
            this._reconcileDismissals(ch);
            this.update();
        });
    }

    /** A closed banner reopens once the pin it was closed on is unpinned. */
    _reconcileDismissals(channel) {
        if (!channel) return;
        const hidden = this._hiddenMap();
        const id = hidden[channel.streamId];
        if (!id) return;
        if (!(channel.adminState?.pins || []).some(p => p.targetId === id)) {
            delete hidden[channel.streamId];
            this._saveHidden();
        }
    }

    _hiddenMap() {
        const account = this.deps.getAccount?.()?.toLowerCase() || null;
        if (account !== this._hiddenFor) {
            this._hiddenFor = account;
            this._hidden = {};
            if (account) {
                try {
                    this._hidden = JSON.parse(localStorage.getItem(CONFIG.storageKeys.pinsHidden(account))) || {};
                } catch { /* unreadable → nothing hidden */ }
            }
        }
        return this._hidden;
    }

    _saveHidden() {
        if (!this._hiddenFor) return;
        try {
            localStorage.setItem(CONFIG.storageKeys.pinsHidden(this._hiddenFor), JSON.stringify(this._hidden));
        } catch { /* best effort */ }
    }

    /** Messages start below the floating banner, whatever its height. */
    _reserveSpace() {
        const banner = this.elements?.banner;
        const area = document.getElementById('messages-area');
        if (!banner || !area) return;
        if (banner.classList.contains('hidden')) {
            area.style.removeProperty('--pinned-banner-space');
        } else {
            const below = banner.getBoundingClientRect().bottom - area.getBoundingClientRect().top;
            area.style.setProperty('--pinned-banner-space', `${Math.max(0, Math.ceil(below))}px`);
        }
    }

    /** Resolve the channel currently being viewed (regular or preview). */
    _resolveChannel() {
        const { getActiveChannel, channelManager } = this.deps;
        return (
            (getActiveChannel && getActiveChannel()) ||
            channelManager?.getCurrentChannel?.() ||
            previewModeUI.getPreviewChannel?.() ||
            null
        );
    }

    _accessLost(streamId) {
        return ['expired', 'unsubscribed', 'banned']
            .includes(subscriptionBannerUI.stateOf(streamId));
    }

    /** Re-render banner from current channel state. Safe to call repeatedly. */
    update() {
        if (!this.elements?.banner) return;
        const channel = this._resolveChannel();
        const banner = this.elements.banner;

        if (!channel) {
            banner.classList.add('hidden');
            this._currentPin = null;
            this._currentStreamId = null;
            return;
        }

        // Pins ride the open admin stream: they resolve long before the
        // messages they float over, and after the gate has stopped granting
        // access. Neither is a moment to draw them in.
        const settled = !channel.initialLoadInProgress && !this._accessLost(channel.streamId);
        const pins = settled && Array.isArray(channel.adminState?.pins)
            ? channel.adminState.pins : [];
        // Ordered by array position, not pinnedAt: Android restamps every pin
        // on each ADMIN_STATE republish. Both clients append new pins last.
        const newestFirst = [...pins].reverse();
        this._currentStreamId = channel.streamId;
        if (pins.length === 0 || this._hiddenMap()[channel.streamId] === newestFirst[0].targetId) {
            banner.classList.add('hidden');
            this._renderCount(0, 0);
            this._currentPin = null;
            this._reserveSpace();
            return;
        }

        const index = (this._cursor.get(channel.streamId) || 0) % newestFirst.length;
        const visible = newestFirst[index];
        this._currentPin = visible;

        // Resolve sender label + body separately (sender goes on its own line)
        const { senderLabel, body } = this._buildPreviewParts(visible, channel);
        if (this.elements.name) this.elements.name.textContent = senderLabel || '';
        if (this.elements.text) this.elements.text.textContent = body;
        this._renderCount(index + 1, newestFirst.length);

        banner.classList.remove('hidden');
        this._reserveSpace();
    }

    /**
     * @param {number} position - 1-based, newest first
     * @param {number} total
     */
    _renderCount(position, total) {
        const el = this.elements?.count;
        if (!el) return;
        if (total > 1) {
            el.textContent = `${position}/${total}`;
            el.title = `Pinned message ${position} of ${total}`;
            el.classList.remove('hidden');
        } else {
            el.textContent = '';
            el.removeAttribute('title');
            el.classList.add('hidden');
        }
    }

    /**
     * Build the sender label + message body for a pin.
     * Display name resolution mirrors the message renderer:
     *   ENS name → local senderName → truncated address.
     */
    _buildPreviewParts(pin, channel) {
        const snap = pin.snapshot || {};
        let sender = snap.sender;
        let text = snap.text;
        let ensName = snap.ensName;
        let senderName = snap.senderName;

        if (!text || !sender || (!ensName && !senderName)) {
            const msg = channel.messages?.find?.(m => m.id === pin.targetId);
            if (msg) {
                sender = sender || msg.sender;
                text = text || msg.text;
                ensName = ensName || msg.verified?.ensName;
                senderName = senderName || msg.senderName;
            }
        }

        // Cache-first, same as the message renderer. Both the pin snapshot and
        // msg.verified.ensName are frozen at capture/verification time, so if
        // the cache was cold then they stay empty forever. Reading the live
        // cache lets the label fill in once ENS resolves.
        const senderLabel =
            (sender ? identityManager.getCachedENS?.(sender) : null) ||
            ensName ||
            senderName ||
            (sender ? (formatAddress?.(sender) || String(sender).slice(0, 10)) : '');
        const body = (text || '[message]').replace(/\s+/g, ' ').trim();
        return { senderLabel, body };
    }

    /** Scroll to the currently displayed pinned message. */
    scrollToCurrent() {
        if (!this._currentPin) return;
        const { chatAreaUI } = this.deps;
        chatAreaUI?.scrollToMessage?.(this._currentPin.targetId);
    }

    /** Banner tap: go to the shown pin, then show the one before it. */
    jumpAndAdvance() {
        if (!this._currentPin || !this._currentStreamId) return;
        this.scrollToCurrent();
        const streamId = this._currentStreamId;
        this._cursor.set(streamId, (this._cursor.get(streamId) || 0) + 1);
        this.update();
    }

    /**
     * Re-show the banner on the newest pin and scroll to it. Invoked from the
     * channel-menu "Pinned" action.
     */
    showAndScroll() {
        const channel = this._resolveChannel();
        if (!channel) return;
        const hidden = this._hiddenMap();
        if (channel.streamId in hidden) {
            delete hidden[channel.streamId];
            this._saveHidden();
        }
        this._cursor.delete(channel.streamId);
        this.update();
        this.scrollToCurrent();
    }

    /** Close the banner until a newer pin arrives (banner-only — does not unpin). */
    dismissCurrent() {
        const channel = this._resolveChannel();
        const pins = channel?.adminState?.pins;
        if (!this._currentPin || !pins?.length) return;
        this._hiddenMap()[channel.streamId] = pins[pins.length - 1].targetId;
        this._saveHidden();
        this._cursor.delete(channel.streamId);
        this.update();
    }

    /** Returns true if the active channel has at least one pin. */
    hasPins() {
        const channel = this._resolveChannel();
        return !!(channel?.adminState?.pins?.length);
    }
}

export const pinnedBannerUI = new PinnedBannerUI();
