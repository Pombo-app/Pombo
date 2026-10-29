/**
 * Notification bell: channel invites + active transfers, in one dropdown.
 *
 * The Android app grew this first (invites used to exist on the web only as
 * transient toasts; unanswered ones were unreachable once the toast died).
 * This is the web side of the same menu: the pending-invite list the
 * notificationManager already keeps, plus every download in flight and every
 * file this device is serving, with basic speed figures and a way to cancel
 * either.
 *
 * Placement is CSS-driven (components.css): on desktop the bell sits beside
 * the account button, top right, with both sections; on the mobile viewport
 * the bell shows invites only and a separate, always-visible transfers button
 * opens the transfers section, with a progress ring and count while
 * downloads run.
 */

import { Logger } from '../logger.js';
import { escapeHtml } from './utils.js';
import { sanitizeText } from './sanitizer.js';

class NotificationBellUI {
    constructor() {
        this.deps = {};
        this.open = false;
        this.refreshTimer = null;
        // 'pending' (default) hides dismissed invites; 'all' appends them,
        // dimmed, with Accept still available (a dismiss can be a mis-tap).
        // Session-scoped on purpose — the dropdown always reopens on Pending.
        this.invitesMode = 'pending';
        // Inactive seeds (stopped, bytes kept) hidden by default; same
        // reopen-on-default rule. The rows come from IndexedDB, so they are
        // fetched async into this cache when toggled on.
        this.showInactive = false;
        this._inactiveSeeds = [];
        // Which sections the open menu shows: 'all' (desktop bell), or one of
        // 'invites' / 'transfers' (the two mobile header buttons).
        this.section = 'all';
        this._indicatorTimer = null;
    }

    _isMobile() {
        return window.innerWidth < 768
            || (window.innerHeight <= 500 && window.matchMedia('(orientation: landscape)').matches);
    }

    /**
     * @param {Object} deps
     * @param {Object} deps.notificationManager
     * @param {Object} deps.mediaController
     */
    init(deps) {
        this.deps = deps;
        const wrapper = document.getElementById('notif-bell-wrapper');
        const btn = document.getElementById('notif-bell-btn');
        const dropdown = document.getElementById('notif-bell-dropdown');
        if (!wrapper || !btn || !dropdown) {
            Logger.warn('Notification bell markup missing');
            return;
        }

        wrapper.classList.remove('hidden');

        // A reconnect or wallet switch runs the connect flow again; wiring the
        // listeners twice would double-fire every click.
        if (this._wired) {
            this.updateBadge();
            return;
        }
        this._wired = true;

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle(undefined, this._isMobile() ? 'invites' : 'all');
        });
        document.getElementById('transfers-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle(undefined, 'transfers');
        });
        this._indicatorTimer = setInterval(() => this.updateTransfersIndicator(), 1000);
        dropdown.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', () => { if (this.open) this.toggle(false); });

        document.getElementById('notif-invites-mode-pending')?.addEventListener('click', () => this.setInvitesMode('pending'));
        document.getElementById('notif-invites-mode-all')?.addEventListener('click', () => this.setInvitesMode('all'));
        document.getElementById('notif-transfers-inactive')?.addEventListener('click', () => {
            this.setShowInactive(!this.showInactive);
        });

        // The manager pings on every invite arrival/accept/dismiss, so the
        // badge stays honest without the bell polling for it.
        deps.notificationManager.onChanged = () => {
            this.updateBadge();
            if (this.open) this.render();
        };
        this.updateBadge();
    }

    setInvitesMode(mode) {
        this.invitesMode = mode;
        const pendingBtn = document.getElementById('notif-invites-mode-pending');
        const allBtn = document.getElementById('notif-invites-mode-all');
        const active = 'text-overlay-70 transition';
        const idle = 'text-overlay-30 hover:text-overlay-50 transition';
        if (pendingBtn) pendingBtn.className = mode === 'pending' ? active : idle;
        if (allBtn) allBtn.className = mode === 'all' ? active : idle;
        // Historical invites live on the storage node, not in memory — the
        // replay backfills them (once per session) the moment the view can
        // show them; rows land via onChanged re-renders as they arrive.
        if (mode === 'all') this.deps.fetchAllInvites?.();
        this.renderInvites();
    }

    async setShowInactive(show) {
        this.showInactive = show;
        const btn = document.getElementById('notif-transfers-inactive');
        if (btn) {
            btn.textContent = show ? 'Hide inactive' : 'Show inactive';
            btn.className = show
                ? 'text-[10px] font-medium text-overlay-70 transition'
                : 'text-[10px] font-medium text-overlay-30 hover:text-overlay-50 transition';
        }
        await this._refreshInactive();
        this.renderTransfers();
    }

    /** Re-reads the inactive seed records (IndexedDB) into the render cache. */
    async _refreshInactive() {
        this._inactiveSeeds = this.showInactive
            ? await this.deps.mediaController?.getInactiveSeedFiles?.().catch(() => []) || []
            : [];
    }

    /**
     * @param {boolean} [force] - open (true) / close (false); toggles when omitted
     * @param {'all'|'invites'|'transfers'} [section] - sections to show; a tap on
     *   the other mobile button while open switches instead of closing
     */
    toggle(force, section = this.section) {
        const dropdown = document.getElementById('notif-bell-dropdown');
        if (!dropdown) return;
        const switching = this.open && force === undefined && section !== this.section;
        this.section = section;
        this.open = switching || (force !== undefined ? force : !this.open);
        this._applySection();
        dropdown.classList.toggle('hidden', !this.open);
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
        if (this.open) {
            // Always reopen on the default views.
            if (this.invitesMode !== 'pending') this.setInvitesMode('pending');
            if (this.showInactive) this.setShowInactive(false);
            this.render();
            // Speeds move while the menu is open; once a second is enough for
            // a rate readout and cheap enough to not matter.
            this.refreshTimer = setInterval(() => this.render(), 1000);
        }
    }

    _applySection() {
        const s = this.section;
        document.getElementById('notif-invites-section')?.classList.toggle('hidden', s === 'transfers');
        document.getElementById('notif-transfers-section')?.classList.toggle('hidden', s === 'invites');
        document.getElementById('notif-sections-divider')?.classList.toggle('hidden', s !== 'all');

        // The menu lives in the bell's wrapper; opened from the transfers
        // button it hangs under that button instead.
        const dropdown = document.getElementById('notif-bell-dropdown');
        const wrapper = document.getElementById('notif-bell-wrapper');
        const transfersBtn = document.getElementById('transfers-btn');
        if (!dropdown) return;
        if (s === 'transfers' && wrapper && transfersBtn?.offsetParent) {
            const offset = wrapper.getBoundingClientRect().right - transfersBtn.getBoundingClientRect().right;
            const width = dropdown.offsetWidth || 320;
            const maxOffset = wrapper.getBoundingClientRect().right - width - 8;
            dropdown.style.right = `${Math.max(0, Math.min(offset, maxOffset))}px`;
        } else {
            dropdown.style.right = '';
        }
    }

    /**
     * Downloads in flight (mesh + storage node) and their combined progress,
     * plus the files this device serves. The count covers both; the ring
     * only the downloads.
     */
    _transfersActivity() {
        let count = 0;
        let received = 0;
        let size = 0;
        const add = (p) => {
            count++;
            size += p.fileSize || 0;
            received += p.total > 0 ? (p.received / p.total) * (p.fileSize || 0) : 0;
        };
        const media = this.deps.mediaController;
        for (const [fileId, transfer] of media?.incomingFiles || []) {
            const p = media.getDownloadProgress(fileId);
            if (p && transfer.metadata) add(p);
        }
        const storage = this.deps.storageMediaController;
        for (const [tid, transfer] of storage?.downloads || []) {
            if (transfer.status !== 'downloading' && transfer.status !== 'paused') continue;
            const p = storage.getDownloadProgress(tid);
            if (p && transfer.metadata) add(p);
        }
        const downloads = count;
        // Same rule as the seed rows: a real seed's key matches its fileId.
        let seeds = 0;
        for (const [fileId, info] of media?.localFiles || []) {
            if (info?.metadata?.fileId === fileId) seeds++;
        }
        return {
            count: downloads + seeds,
            downloads,
            fraction: size > 0 ? Math.min(1, received / size) : 0
        };
    }

    updateTransfersIndicator() {
        const badge = document.getElementById('transfers-badge');
        const ring = document.getElementById('transfers-ring');
        const progress = document.getElementById('transfers-ring-progress');
        if (!badge || !ring || !progress) return;
        const { count, downloads, fraction } = this._transfersActivity();
        badge.classList.toggle('hidden', count === 0);
        badge.textContent = count > 9 ? '9+' : String(count);
        ring.classList.toggle('hidden', downloads === 0);
        // r = 16 → circumference 2πr ≈ 100.5
        progress.style.strokeDashoffset = String(100.5 * (1 - fraction));
    }

    updateBadge() {
        const badge = document.getElementById('notif-bell-badge');
        if (!badge) return;
        const count = this.deps.notificationManager?.getPendingInvites?.().length || 0;
        badge.classList.toggle('hidden', count === 0);
        badge.textContent = count > 9 ? '9+' : String(count);
    }

    formatBytes(bytes) {
        if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
        if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
        return bytes + ' B';
    }

    formatSpeed(bytesPerSec) {
        if (!bytesPerSec || bytesPerSec <= 0) return '';
        return this.formatBytes(bytesPerSec) + '/s';
    }

    /** Play (resume) or pause glyph, shared by mesh and storage download rows. */
    pauseIconSvg(paused) {
        return paused
            ? `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z"/></svg>`
            : `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.75 5.25v13.5m-7.5-13.5v13.5"/></svg>`;
    }

    render() {
        this.renderInvites();
        this.renderTransfers();
        this.updateBadge();
    }

    renderInvites() {
        const list = document.getElementById('notif-invites-list');
        if (!list) return;
        const pending = this.deps.notificationManager?.getPendingInvites?.() || [];
        const dismissed = this.invitesMode === 'all'
            ? (this.deps.notificationManager?.getDismissedInvites?.() || [])
            : [];
        if (pending.length === 0 && dismissed.length === 0) {
            list.innerHTML = `<div class="px-3.5 pb-2 text-[13px] text-overlay-40">${this.invitesMode === 'all' ? 'No invites' : 'No pending invites'}</div>`;
            return;
        }
        // Dismissed rows: dimmed, Accept only — the whole point of the "All"
        // view is recovering a dismiss that was a mis-tap.
        const inviteRow = (invite, isDismissed) => `
            <div class="px-3.5 py-1.5${isDismissed ? ' opacity-50' : ''}" data-invite-id="${escapeHtml(invite.inviteId)}">
                <div class="text-[13px] font-medium text-overlay-90">${escapeHtml(sanitizeText(invite.channel?.name || 'Channel'))}</div>
                <div class="text-[11px] text-overlay-40">From: ${escapeHtml((invite.from || '').slice(0, 6))}…${escapeHtml((invite.from || '').slice(-4))}</div>
                <div class="mt-1.5 mb-1 flex gap-2">
                    <button class="notif-invite-accept bg-overlay-90 hover:bg-white text-surface-2 px-3 py-1 rounded-md text-[11px] font-medium transition">Accept</button>
                    ${isDismissed ? '' : '<button class="notif-invite-dismiss bg-overlay-10 hover:bg-overlay-20 text-overlay-70 px-3 py-1 rounded-md text-[11px] font-medium transition">Dismiss</button>'}
                </div>
            </div>
        `;
        list.innerHTML = pending.map(i => inviteRow(i, false)).join('')
            + dismissed.map(i => inviteRow(i, true)).join('');
        list.querySelectorAll('[data-invite-id]').forEach(row => {
            const id = row.dataset.inviteId;
            row.querySelector('.notif-invite-accept')?.addEventListener('click', () => {
                this.toggle(false);
                this.deps.notificationManager.acceptInvite(id);
            });
            row.querySelector('.notif-invite-dismiss')?.addEventListener('click', () => {
                this.deps.notificationManager.dismissInvite(id);
                this.render();
            });
        });
    }

    renderTransfers() {
        const list = document.getElementById('notif-transfers-list');
        const media = this.deps.mediaController;
        if (!list || !media) return;

        const rows = [];

        // Downloads in flight
        for (const [fileId, transfer] of media.incomingFiles) {
            const p = media.getDownloadProgress(fileId);
            if (!p || !transfer.metadata) continue;
            const transferred = p.total > 0 ? (p.received / p.total) * p.fileSize : 0;
            const speed = this.formatSpeed(p.bytesPerSec);
            const stats = p.paused
                ? `Paused · ${this.formatBytes(transferred)} of ${this.formatBytes(p.fileSize)}`
                : `${this.formatBytes(transferred)} of ${this.formatBytes(p.fileSize)}${speed ? ` · ${speed}` : ''}`;
            const pauseIcon = p.paused
                ? `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z"/></svg>`
                : `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.75 5.25v13.5m-7.5-13.5v13.5"/></svg>`;
            rows.push(`
                <div class="px-3.5 py-1.5 flex items-center gap-2 hover:bg-overlay-4 cursor-pointer transition" data-transfer-dl="${escapeHtml(fileId)}" data-transfer-paused="${p.paused ? '1' : '0'}" data-stream-id="${escapeHtml(transfer.streamId || '')}" title="Open channel">
                    <svg class="w-3.5 h-3.5 flex-shrink-0 text-[#F6851B]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.5v15m0 0 6-6m-6 6-6-6"/>
                    </svg>
                    <div class="min-w-0 flex-1">
                        <div class="text-[12px] text-overlay-90 truncate">${escapeHtml(sanitizeText(transfer.metadata.fileName || fileId))}</div>
                        <div class="text-[10px] text-overlay-40 truncate">${stats}</div>
                    </div>
                    <button class="notif-pause-dl flex-shrink-0 text-overlay-45 hover:text-primary transition" title="${p.paused ? 'Resume download' : 'Pause download'}">
                        ${pauseIcon}
                    </button>
                    <button class="notif-cancel-dl flex-shrink-0 text-overlay-45 hover:text-primary transition" title="Cancel download">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12"/></svg>
                    </button>
                </div>
            `);
        }

        // Storage-node downloads in flight — same shape as the mesh rows
        // above, no cancel yet (only pause/resume; see resumeStorageDownload).
        const storage = this.deps.storageMediaController;
        if (storage) {
            for (const [tid, transfer] of storage.downloads) {
                if (transfer.status !== 'downloading' && transfer.status !== 'paused') continue;
                const p = storage.getDownloadProgress(tid);
                if (!p || !transfer.metadata) continue;
                const transferred = p.total > 0 ? (p.received / p.total) * p.fileSize : 0;
                const speed = this.formatSpeed(p.bytesPerSec);
                // The tap-to-confirmation gap: "Pausing…" while the fetch loop
                // unwinds, "Resuming…" while the new run spins up (endpoint
                // rotation can take seconds). The icon tracks the request, the
                // text names the gap — replacing the speed, which is stale in
                // both states anyway.
                const pausing = transfer.status === 'downloading' && transfer.paused;
                const resuming = transfer.status === 'paused' && storage.isResuming?.(tid);
                const showPaused = (pausing || transfer.status === 'paused') && !resuming;
                const base = `${this.formatBytes(transferred)} of ${this.formatBytes(p.fileSize)}`;
                let stats;
                if (pausing) stats = `${base} · Pausing…`;
                else if (resuming) stats = `${base} · Resuming…`;
                else if (transfer.status === 'paused') stats = `Paused · ${base}`;
                else stats = `${base}${speed ? ` · ${speed}` : ''}`;
                rows.push(`
                    <div class="px-3.5 py-1.5 flex items-center gap-2 hover:bg-overlay-4 cursor-pointer transition" data-storage-dl="${escapeHtml(tid)}" data-transfer-paused="${showPaused ? '1' : '0'}" data-stream-id="${escapeHtml(transfer.streamId || '')}" title="Open channel">
                        <svg class="w-3.5 h-3.5 flex-shrink-0 text-[#8B5CF6]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.5v15m0 0 6-6m-6 6-6-6"/>
                        </svg>
                        <div class="min-w-0 flex-1">
                            <div class="text-[12px] text-overlay-90 truncate">${escapeHtml(sanitizeText(transfer.metadata.fileName || tid))}</div>
                            <div class="text-[10px] text-overlay-40 truncate">${stats}</div>
                        </div>
                        <button class="notif-pause-storage-dl flex-shrink-0 text-overlay-45 hover:text-primary transition" title="${showPaused ? 'Resume download' : 'Pause download'}">
                            ${this.pauseIconSvg(showPaused)}
                        </button>
                        <button class="notif-cancel-storage-dl flex-shrink-0 text-overlay-45 hover:text-primary transition" title="Cancel download">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12"/></svg>
                        </button>
                    </div>
                `);
            }
        }

        // Files this device serves. localFiles also holds transient hashing
        // entries under a temp key — a real seed's key matches its fileId.
        for (const [fileId, info] of media.localFiles) {
            if (!info?.metadata || info.metadata.fileId !== fileId) continue;
            const { bytesPerSec, leechers } = media.getUploadStats(fileId);
            const rate = this.formatSpeed(bytesPerSec);
            const peers = leechers > 0 ? `${leechers} peer${leechers === 1 ? '' : 's'}` : '';
            const stats = [this.formatBytes(info.metadata.fileSize), rate && `↑ ${rate}`, peers]
                .filter(Boolean).join(' · ');
            rows.push(`
                <div class="px-3.5 py-1.5 flex items-center gap-2 hover:bg-overlay-4 cursor-pointer transition" data-transfer-seed="${escapeHtml(fileId)}" data-stream-id="${escapeHtml(info.streamId || '')}" title="Open channel">
                    <svg class="w-3.5 h-3.5 flex-shrink-0 text-success/70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19.5v-15m0 0-6 6m6-6 6 6"/>
                    </svg>
                    <div class="min-w-0 flex-1">
                        <div class="text-[12px] text-overlay-90 truncate">${escapeHtml(sanitizeText(info.metadata.fileName || fileId))}</div>
                        <div class="text-[10px] text-overlay-40 truncate">${stats}</div>
                    </div>
                    <button class="notif-stop-seed flex-shrink-0 text-overlay-45 hover:text-primary transition" title="Stop seeding">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12"/></svg>
                    </button>
                </div>
            `);
        }

        // Inactive seeds: stopped (bytes kept) or otherwise held-but-unserved.
        // Play = reseed — needs the channel for the announce, so it is only
        // offered while still a member; X = delete for good.
        for (const record of this._inactiveSeeds) {
            const channel = this.deps.getChannel?.(record.streamId);
            rows.push(`
                <div class="px-3.5 py-1.5 flex items-center gap-2 opacity-50 hover:bg-overlay-4 transition${channel ? ' cursor-pointer' : ''}" data-inactive-seed="${escapeHtml(record.fileId)}" data-stream-id="${escapeHtml(channel ? record.streamId : '')}" ${channel ? 'title="Open channel"' : ''}>
                    <svg class="w-3.5 h-3.5 flex-shrink-0 text-overlay-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19.5v-15m0 0-6 6m6-6 6 6"/>
                    </svg>
                    <div class="min-w-0 flex-1">
                        <div class="text-[12px] text-overlay-90 truncate">${escapeHtml(sanitizeText(record.metadata?.fileName || record.fileId))}</div>
                        <div class="text-[10px] text-overlay-40 truncate">${this.formatBytes(record.metadata?.fileSize || 0)} · Inactive</div>
                    </div>
                    ${channel ? `
                    <button class="notif-reseed flex-shrink-0 text-overlay-45 hover:text-primary transition" title="Reseed">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z"/></svg>
                    </button>` : ''}
                    <button class="notif-delete-seed flex-shrink-0 text-overlay-45 hover:text-danger/90 transition" title="Delete file">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18 18 6M6 6l12 12"/></svg>
                    </button>
                </div>
            `);
        }

        list.innerHTML = rows.length
            ? rows.join('')
            : `<div class="px-3.5 pb-2 text-[13px] text-overlay-40">${this.showInactive ? 'No transfers' : 'No active transfers'}</div>`;

        list.querySelectorAll('[data-transfer-dl]').forEach(row => {
            row.querySelector('.notif-cancel-dl')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deps.mediaController.cancelDownload(row.dataset.transferDl);
                this.render();
            });
            row.querySelector('.notif-pause-dl')?.addEventListener('click', (e) => {
                e.stopPropagation();
                const fileId = row.dataset.transferDl;
                if (row.dataset.transferPaused === '1') {
                    this.deps.mediaController.resumeDownload(fileId);
                } else {
                    this.deps.mediaController.pauseDownload(fileId);
                }
                this.render();
            });
            this._wireRowNavigation(row);
        });
        list.querySelectorAll('[data-storage-dl]').forEach(row => {
            row.querySelector('.notif-cancel-storage-dl')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deps.storageMediaController?.cancelDownload(row.dataset.storageDl);
                this.render();
            });
            row.querySelector('.notif-pause-storage-dl')?.addEventListener('click', (e) => {
                e.stopPropagation();
                const tid = row.dataset.storageDl;
                if (row.dataset.transferPaused === '1') {
                    this.deps.resumeStorageDownload?.(tid);
                } else {
                    this.deps.storageMediaController?.pauseDownload(tid);
                }
                this.render();
            });
            this._wireRowNavigation(row);
        });
        list.querySelectorAll('[data-transfer-seed]').forEach(row => {
            row.querySelector('.notif-stop-seed')?.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    // Non-destructive: the bytes and record stay, flagged
                    // inactive — the row moves to the "Show inactive" view.
                    await this.deps.mediaController.stopSeeding(row.dataset.transferSeed);
                } catch (e2) {
                    Logger.warn('Stop seeding failed:', e2.message);
                }
                await this._refreshInactive();
                this.render();
            });
            this._wireRowNavigation(row);
        });
        list.querySelectorAll('[data-inactive-seed]').forEach(row => {
            const fileId = row.dataset.inactiveSeed;
            row.querySelector('.notif-reseed')?.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    await this.deps.mediaController.reseedFile(fileId);
                } catch (e2) {
                    Logger.warn('Reseed failed:', e2.message);
                }
                await this._refreshInactive();
                this.render();
            });
            row.querySelector('.notif-delete-seed')?.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    await this.deps.mediaController.removeSeedFile(fileId);
                } catch (e2) {
                    Logger.warn('Delete seed failed:', e2.message);
                }
                await this._refreshInactive();
                this.render();
            });
            this._wireRowNavigation(row);
        });
    }

    /**
     * Tapping a transfer row (outside its action buttons, which stop
     * propagation) opens the channel it belongs to and closes the dropdown.
     * @private
     */
    _wireRowNavigation(row) {
        const streamId = row.dataset.streamId;
        if (!streamId) return;
        row.addEventListener('click', () => {
            this.toggle(false);
            this.deps.openChannel?.(streamId);
        });
    }
}

export const notificationBellUI = new NotificationBellUI();
