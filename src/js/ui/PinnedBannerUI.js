/**
 * PinnedBannerUI
 *
 * Renders the pinned-message banner shown at the top of the chat area
 * (between the channel header and the messages list).
 *
 * Behaviour:
 *  - Reads `channel.adminState.pins` from the active channel (or preview
 *    channel) and shows the most recently pinned message.
 *  - Click on the banner → scroll to the pinned message in the timeline.
 *  - A "+N" counter shows how many older pins a dismissal would reveal.
 *  - Close (×) button → dismiss locally for the current session, revealing
 *    the pin before it, or hiding the banner once they run out. Tracked
 *    per-channel; resets when a new pin arrives or the user reopens the
 *    channel via the "Pinned" channel-menu action.
 *  - DOMPurify-safe: text rendered via `textContent` only.
 */

import { previewModeUI } from './PreviewModeUI.js';
import { formatAddress } from './utils.js';
import { identityManager } from '../identity.js';
import { subscriptionBannerUI } from './SubscriptionBannerUI.js';

class PinnedBannerUI {
    constructor() {
        this.deps = {};
        this.elements = null;
        // Map<streamId, Set<targetId>> of pins dismissed by the user this session
        this._dismissed = new Map();
        // Tracks the pin currently shown so click handlers know what to scroll to
        this._currentPin = null;
        this._currentStreamId = null;
    }

    /** @param {Object} deps - { channelManager, chatAreaUI, getActiveChannel, Logger } */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * @param {Object} elements - { banner, name, text, count, closeBtn }
     */
    init(elements) {
        this.elements = elements;
        if (!elements?.banner) return;

        // Click anywhere on banner (except close button) → scroll to pinned msg
        elements.banner.addEventListener('click', (e) => {
            if (e.target.closest('#pinned-banner-close')) return;
            this.scrollToCurrent();
        });
        elements.banner.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.scrollToCurrent();
            }
        });

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
            // A new pin invalidates any previous dismissal for that target
            this._reconcileDismissals(ch);
            this.update();
        });
    }

    /** If a pin was unpinned and re-pinned, clear its dismissal so it shows again. */
    _reconcileDismissals(channel) {
        if (!channel) return;
        const set = this._dismissed.get(channel.streamId);
        if (!set || set.size === 0) return;
        const liveIds = new Set((channel.adminState?.pins || []).map(p => p.targetId));
        // Drop dismissals for pins that no longer exist (so re-pin shows again)
        for (const id of Array.from(set)) {
            if (!liveIds.has(id)) set.delete(id);
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
        if (pins.length === 0) {
            banner.classList.add('hidden');
            this._renderCount(0);
            this._currentPin = null;
            this._currentStreamId = channel.streamId;
            return;
        }

        // Ordered by array position, not pinnedAt: Android restamps every pin
        // on each ADMIN_STATE republish. Both clients append new pins last.
        const newestFirst = [...pins].reverse();
        const dismissed = this._dismissed.get(channel.streamId) || new Set();
        const undismissed = newestFirst.filter(p => !dismissed.has(p.targetId));
        const visible = undismissed[0];

        if (!visible) {
            banner.classList.add('hidden');
            this._renderCount(0);
            this._currentPin = null;
            this._currentStreamId = channel.streamId;
            return;
        }

        this._currentPin = visible;
        this._currentStreamId = channel.streamId;

        // Resolve sender label + body separately (sender goes on its own line)
        const { senderLabel, body } = this._buildPreviewParts(visible, channel);
        if (this.elements.name) this.elements.name.textContent = senderLabel || '';
        if (this.elements.text) this.elements.text.textContent = body;
        this._renderCount(undismissed.length - 1);

        banner.classList.remove('hidden');
    }

    /**
     * @param {number} remaining - Pins a dismissal would still reveal
     */
    _renderCount(remaining) {
        const el = this.elements?.count;
        if (!el) return;
        if (remaining > 0) {
            el.textContent = `+${remaining}`;
            el.title = `${remaining} more pinned message${remaining === 1 ? '' : 's'}`;
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

    /**
     * Re-show banner (clearing any local dismissal) for the current channel and
     * scroll to the most recent pin. Invoked from the channel-menu "Pinned"
     * action.
     */
    showAndScroll() {
        const channel = this._resolveChannel();
        if (!channel) return;
        // Clear dismissals so the latest pin is visible
        this._dismissed.delete(channel.streamId);
        this.update();
        this.scrollToCurrent();
    }

    /** Dismiss the currently shown pin (banner-only — does not unpin). */
    dismissCurrent() {
        if (!this._currentPin || !this._currentStreamId) return;
        let set = this._dismissed.get(this._currentStreamId);
        if (!set) {
            set = new Set();
            this._dismissed.set(this._currentStreamId, set);
        }
        set.add(this._currentPin.targetId);
        this.update();
    }

    /** Returns true if the active channel has at least one pin. */
    hasPins() {
        const channel = this._resolveChannel();
        return !!(channel?.adminState?.pins?.length);
    }
}

export const pinnedBannerUI = new PinnedBannerUI();
