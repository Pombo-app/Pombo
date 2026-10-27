/**
 * Notification System
 * Handles channel invites and notifications via DM inbox partition 3.
 * Uses the same E2E encryption (ECDH + AES-256-GCM) as DM messages.
 * Requires both sender and recipient to have a DM inbox created.
 */

import { streamrController, STREAM_CONFIG } from './streamr.js';
import { authManager } from './auth.js';
import { Logger } from './logger.js';
import { escapeHtml } from './ui/utils.js';
import { sanitizeText } from './ui/sanitizer.js';
import { CONFIG } from './config.js';
import { dmCrypto } from './dmCrypto.js';
import { secureStorage } from './secureStorage.js';

class NotificationManager {
    /** Newest dismissed records kept for the bell's "All" view — see dismissInvite. */
    static MAX_DISMISSED_INVITES = 50;

    constructor() {
        this.pendingInvites = new Map(); // inviteId -> invite data (dismissed ones stay, flagged)
        this.initialized = false;
        this.muted = false;
    }

    /**
     * Whether invite notifications are muted (silent).
     * Invites are still received and stored, but no toast/sound is shown.
     * @returns {boolean}
     */
    isMuted() {
        return this.muted;
    }

    /**
     * Set muted state and persist to localStorage.
     * @param {boolean} muted
     */
    setMuted(muted) {
        this.muted = !!muted;
        const address = authManager.getAddress()?.toLowerCase();
        if (address) {
            localStorage.setItem(CONFIG.storageKeys.invitesMuted(address), this.muted ? '1' : '0');
        }
    }

    /**
     * Initialize notification system for current user.
     * Loads pending invites from localStorage.
     * Subscription to P3 is managed by DM Manager.
     */
    async init() {
        const address = authManager.getAddress();
        if (!address) {
            Logger.warn('Cannot init notifications: not authenticated');
            return;
        }

        this.loadPendingInvites();

        // Restore muted preference
        const addr = address.toLowerCase();
        this.muted = localStorage.getItem(CONFIG.storageKeys.invitesMuted(addr)) === '1';

        this.initialized = true;
        Logger.info('Notification system initialized');
    }

    /**
     * Send channel invite to a user via their DM inbox partition 3.
     * Requires recipient to have a DM inbox (same check as starting a DM).
     * @param {string} recipientAddress - Recipient's Ethereum address
     * @param {Object} channelInfo - Channel information
     * @returns {Promise<string>} - Invite ID
     */
    async sendChannelInvite(recipientAddress, channelInfo) {
        const senderAddress = authManager.getAddress();
        if (!senderAddress) {
            throw new Error('Not authenticated');
        }

        // 1. Check if recipient has DM inbox
        const peerInboxId = streamrController.getDMInboxId(recipientAddress);
        try {
            await streamrController.client.getStream(peerInboxId);
        } catch {
            throw new Error(
                'This user has not enabled DMs yet. ' +
                'They need to open Pombo and create their inbox first.'
            );
        }

        // 2. Get peer's public key for ECDH encryption
        const peerPubKey = await streamrController.getDMPublicKey(recipientAddress);
        if (!peerPubKey) {
            throw new Error('Cannot send invite: peer public key not available.');
        }

        // 3. Build invite message
        const inviteMessage = {
            type: 'CHANNEL_INVITE',
            inviteId: this.generateInviteId(),
            timestamp: Date.now(),
            from: senderAddress,
            channel: {
                streamId: channelInfo.streamId,
                name: channelInfo.name,
                type: channelInfo.type,
                password: channelInfo.password
            }
        };

        // 4-6. Seal and publish to the recipient's inbox, partition 3.
        //
        // Sealed sender, same as DM messages: the invite goes out under a
        // throwaway publisher, so an observer of the inbox stream cannot tell
        // who invited whom. An invite is a social edge like any other — arguably
        // a stronger one, since it names a channel both parties are in.
        const { dmManager } = await import('./dm.js');
        await dmManager.sealAndPublish(
            peerInboxId,
            recipientAddress,
            inviteMessage,
            STREAM_CONFIG.MESSAGE_STREAM.NOTIFICATIONS
        );

        Logger.info('Channel invite sent to:', recipientAddress);
        return inviteMessage.inviteId;
    }

    /**
     * Handle incoming notification
     * @param {Object} data - Notification data
     */
    handleNotification(data) {
        Logger.debug('Notification received:', data);

        if (data.type === 'CHANNEL_INVITE') {
            this.handleChannelInvite(data);
        }
    }

    /**
     * Handle channel invite notification
     * @param {Object} invite - Invite data
     */
    async handleChannelInvite(invite, { replay = false } = {}) {
        const existing = this.pendingInvites.get(invite.inviteId);
        // A re-delivered invite the user already dismissed stays dismissed —
        // the record is retained (flagged, not deleted) exactly so it cannot
        // resurface as pending.
        if (existing?.dismissed) return;

        if (replay) {
            // dm.js replayInvites: historical P3 rows, classified silently.
            if (existing) return;
            // Moot invites — the channel is already joined — resurface in no
            // state at all.
            const { channelManager } = await import('./channels.js');
            if (invite.channel?.streamId && channelManager.getChannel(invite.channel.streamId)) return;
            if (this._answeredIds().has(invite.inviteId)) {
                // Answered before the ledger retained full records (or the
                // record was pruned): re-file the replayed content as a
                // dismissed record so the "All" view can offer it.
                invite.dismissed = true;
                invite.dismissedAt = invite.timestamp || Date.now();
                this.pendingInvites.set(invite.inviteId, invite);
                this._pruneDismissed();
            } else {
                // Never answered, and older than any tab that was open to see
                // it live — pending is the honest state, minus the toast.
                this.pendingInvites.set(invite.inviteId, invite);
            }
            this.savePendingInvites();
            this.onChanged?.();
            return;
        }

        // P3 is only subscribed when not muted, so receiving means invites are active
        this.pendingInvites.set(invite.inviteId, invite);
        this.savePendingInvites();
        // The bell badge tracks this list; the toast below is transient.
        this.onChanged?.();
        this.showInviteNotification(invite);
    }

    /**
     * Show invite notification in UI
     * @param {Object} invite - Invite data
     */
    showInviteNotification(invite) {
        // Use toast container
        const container = document.getElementById('toast-container');
        if (!container) {
            Logger.warn('Toast container not found');
            return;
        }

        const duration = CONFIG.notifications.inviteToastDurationMs;
        const toast = document.createElement('div');
        toast.className = 'toast invite';
        toast.dataset.inviteId = invite.inviteId;
        toast.style.setProperty('--toast-duration', `${duration}ms`);
        toast.innerHTML = `
            <svg class="toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
            </svg>
            <div class="toast-content">
                <div class="text-[13px] font-medium text-overlay-90 mb-1">Channel Invite</div>
                <div class="text-[11px] text-overlay-50 mb-0.5">From: ${escapeHtml(this.formatAddress(invite.from))}</div>
                <div class="text-[12px] text-overlay-80 font-medium">${escapeHtml(sanitizeText(invite.channel.name))}</div>
                <div class="mt-2.5 flex gap-2">
                    <button class="accept-btn bg-overlay-90 hover:bg-white text-[#0a0a0a] px-3 py-1 rounded-md text-[11px] font-medium transition">
                        Accept
                    </button>
                    <button class="dismiss-btn bg-overlay-10 hover:bg-overlay-20 text-overlay-70 px-3 py-1 rounded-md text-[11px] font-medium transition">
                        Dismiss
                    </button>
                </div>
            </div>
            <span class="toast-close" title="Dismiss">
                <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </span>
            <div class="toast-progress"></div>
        `;

        // Add event listeners
        toast.querySelector('.accept-btn').addEventListener('click', () => {
            this.acceptInvite(invite.inviteId);
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 250);
        });
        
        toast.querySelector('.dismiss-btn').addEventListener('click', () => {
            this.dismissInvite(invite.inviteId);
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 250);
        });
        
        toast.querySelector('.toast-close')?.addEventListener('click', () => {
            this.dismissInvite(invite.inviteId);
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 250);
        });

        container.appendChild(toast);

        // Auto-dismiss after duration
        setTimeout(() => {
            if (toast.parentElement) {
                toast.classList.add('toast-exit');
                setTimeout(() => toast.remove(), 250);
            }
        }, duration);

        // Play notification sound
        this.playNotificationSound();
    }

    /**
     * Accept channel invite
     * @param {string} inviteId - Invite ID
     */
    async acceptInvite(inviteId) {
        const invite = this.pendingInvites.get(inviteId);
        if (!invite) {
            Logger.error('Invite not found:', inviteId);
            return;
        }

        try {
            // Lazy imports to avoid circular dependency (notifications ↔ channels ↔ dm, notifications ↔ ui)
            const { channelManager } = await import('./channels.js');

            // Join the channel
            await channelManager.joinChannel(
                invite.channel.streamId,
                invite.channel.password,
                {
                    name: invite.channel.name,
                    type: invite.channel.type
                }
            );

            // Remove from pending; ledger the id so a P3 replay cannot
            // resurrect it (accepted = answered, same as Android's resolve).
            this.pendingInvites.delete(inviteId);
            this.markAnswered(inviteId);
            this.savePendingInvites();
            this.onChanged?.();

            Logger.info('Invite accepted:', inviteId);
            
            // Show toast
            const { uiController } = await import('./ui.js');
            uiController.showNotification(`Joined channel: ${invite.channel.name}!`, 'success');
        } catch (error) {
            Logger.error('Failed to accept invite:', error);
            try {
                const { uiController } = await import('./ui.js');
                uiController.showNotification('Failed to join channel: ' + error.message, 'error');
            } catch { /* ui not available */ }
        }
    }

    /**
     * Dismiss invite. The record is FLAGGED, not deleted: the bell's "All"
     * view lists dismissed invites so one swiped away by mistake can still be
     * accepted, and the flag doubles as re-delivery suppression (see
     * handleChannelInvite). Bounded — only the newest MAX_DISMISSED_INVITES
     * dismissed records are kept.
     * @param {string} inviteId - Invite ID
     */
    dismissInvite(inviteId) {
        const invite = this.pendingInvites.get(inviteId);
        if (!invite || invite.dismissed) return;
        invite.dismissed = true;
        invite.dismissedAt = Date.now();
        this.markAnswered(inviteId);
        this._pruneDismissed();
        this.savePendingInvites();
        this.onChanged?.();
        Logger.info('Invite dismissed:', inviteId);
    }

    /** Keep only the newest MAX_DISMISSED_INVITES dismissed records. */
    _pruneDismissed() {
        const dismissed = Array.from(this.pendingInvites.values())
            .filter(i => i.dismissed)
            .sort((a, b) => (b.dismissedAt || 0) - (a.dismissedAt || 0));
        for (const stale of dismissed.slice(NotificationManager.MAX_DISMISSED_INVITES)) {
            this.pendingInvites.delete(stale.inviteId);
        }
    }

    // ---- answered-invite ledger ----
    // Ids of accepted/dismissed invites, so a P3 replay (dm.js replayInvites)
    // can classify historical rows instead of resurrecting answered ones as
    // pending — the web-side mirror of Android's InviteStore id ledger, same
    // 200-id bound. Ids carry no secrets, so plain localStorage is fine (and
    // stays writable when secure storage is locked).

    _answeredKey() {
        const address = authManager.getAddress();
        return address ? `pombo_invites_answered_${address.toLowerCase()}` : null;
    }

    _answeredIds() {
        try {
            const key = this._answeredKey();
            return key ? new Set(JSON.parse(localStorage.getItem(key) || '[]')) : new Set();
        } catch {
            return new Set();
        }
    }

    markAnswered(inviteId) {
        try {
            const key = this._answeredKey();
            if (!key) return;
            const ids = Array.from(this._answeredIds()).filter(id => id !== inviteId);
            ids.push(inviteId);
            while (ids.length > 200) ids.shift();
            localStorage.setItem(key, JSON.stringify(ids));
        } catch { /* quota/private mode — ledger is best-effort */ }
    }

    /**
     * Get all pending invites
     * @returns {Array} - Array of pending invites
     */
    getPendingInvites() {
        return Array.from(this.pendingInvites.values()).filter(i => !i.dismissed);
    }

    /**
     * Dismissed-but-retained invites, newest dismissal first (the bell's
     * "All" view).
     * @returns {Array}
     */
    getDismissedInvites() {
        return Array.from(this.pendingInvites.values())
            .filter(i => i.dismissed)
            .sort((a, b) => (b.dismissedAt || 0) - (a.dismissedAt || 0));
    }

    /**
     * Load pending invites from encrypted secure storage.
     * Invites carry channel passwords, so they are stored encrypted at rest.
     * Migrates (and deletes) the legacy plaintext localStorage payload once.
     */
    loadPendingInvites() {
        try {
            const address = authManager.getAddress();
            if (!address) return;

            // Clear any invites left over from a previously connected account
            // (otherwise account A's invites get re-saved under account B's key)
            this.pendingInvites.clear();

            // One-time migration: legacy plaintext localStorage payload
            let migrated = false;
            try {
                const legacyKey = CONFIG.storageKeys.invites(address);
                const legacy = localStorage.getItem(legacyKey);
                if (legacy) {
                    for (const invite of JSON.parse(legacy)) {
                        this.pendingInvites.set(invite.inviteId, invite);
                    }
                    localStorage.removeItem(legacyKey);
                    migrated = true;
                    Logger.info('Migrated legacy plaintext invites to secure storage');
                }
            } catch (e) {
                Logger.warn('Failed to migrate legacy invites:', e.message);
            }

            for (const invite of secureStorage.getPendingInvites()) {
                if (!this.pendingInvites.has(invite.inviteId)) {
                    this.pendingInvites.set(invite.inviteId, invite);
                }
            }

            if (migrated) {
                this.savePendingInvites();
            }

            if (this.pendingInvites.size > 0) {
                Logger.info('Loaded pending invites:', this.pendingInvites.size);
            }
        } catch (error) {
            Logger.error('Failed to load pending invites:', error);
        }
    }

    /**
     * Save pending invites to encrypted secure storage.
     * Never writes plaintext: if storage is locked (e.g. guest without
     * unlock), invites stay in memory only.
     */
    savePendingInvites() {
        try {
            const invites = Array.from(this.pendingInvites.values());
            secureStorage.setPendingInvites(invites).catch((error) => {
                Logger.error('Failed to save pending invites:', error);
            });
        } catch (error) {
            Logger.error('Failed to save pending invites:', error);
        }
    }

    /**
     * Generate unique invite ID
     * @returns {string} - Invite ID
     */
    generateInviteId() {
        return `invite_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Format Ethereum address
     * @param {string} address - Full address
     * @returns {string} - Shortened address
     */
    formatAddress(address) {
        if (!address) return 'Unknown';
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    /**
     * Play notification sound
     */
    playNotificationSound() {
        try {
            // Simple beep using Web Audio API
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            oscillator.frequency.value = 800;
            oscillator.type = 'sine';
            gainNode.gain.value = 0.1;

            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.1);
        } catch (error) {
            Logger.warn('Failed to play notification sound:', error);
        }
    }
}

// Export singleton instance
export const notificationManager = new NotificationManager();
