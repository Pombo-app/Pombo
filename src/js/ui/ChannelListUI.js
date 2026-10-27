/**
 * ChannelListUI Module
 * Manages channel list rendering, filtering, sorting, and drag-and-drop reordering
 */

import { Logger } from '../logger.js';
import { escapeHtml, escapeAttr } from './utils.js';
import { sanitizeText } from './sanitizer.js';
import { channelImageManager } from '../channelImageManager.js';
import { channelLatestMessageManager } from '../channelLatestMessageManager.js';
import { deriveAdminId } from '../streamConstants.js';
import { getAvatarHtml } from './AvatarGenerator.js';
import { identityManager } from '../identity.js';
import { formatPreviewLine } from './channelPreviewFormatter.js';

class ChannelListUI {
    constructor() {
        this.elements = {};
        this.currentFilter = 'all'; // all | personal | community
        this.clickListenersAttached = false;
        this.dragAndDropBound = false;
        this.draggedItem = null;
        this.draggedStreamId = null;
        
        // Dependencies (injected)
        this.channelManager = null;
        this.secureStorage = null;
        this.onChannelSelect = null;
        this.onFinishPendingCreate = null;
        this.onDiscardPendingCreate = null;

        // Tracks which adminStreamIds / DM peers we have *attempted* to
        // resolve. Any row not in these sets renders a spinner placeholder
        // until its lookup finishes (regardless of whether a result was
        // found). Prevents the avatar/ENS placeholder from flashing in
        // mid-resolution.
        this._resolvedImages = new Set();
        this._resolvedDMPeers = new Set();
        // Tracks streams whose latest-message preview lookup has settled
        // (success or empty). Drives the spinner-vs-blank decision on the
        // second row of each channel item.
        this._resolvedPreviews = new Set();
    }

    /**
     * Set dependencies for the module
     */
    setDependencies({ channelManager, secureStorage, onChannelSelect, onFinishPendingCreate, onDiscardPendingCreate }) {
        this.channelManager = channelManager;
        this.secureStorage = secureStorage;
        this.onChannelSelect = onChannelSelect;
        this.onFinishPendingCreate = onFinishPendingCreate || null;
        this.onDiscardPendingCreate = onDiscardPendingCreate || null;

        // Wire a single global listener for channel-image updates so any
        // visible row gets its avatar refreshed without a full re-render.
        // The manager emits per adminStreamId; we update only matching DOM nodes.
        if (!this._channelImageGlobalUnsub) {
            this._channelImageGlobalUnsub = this._installChannelImageListener();
        }
        // Same idea for the per-channel "latest message" preview line.
        if (!this._channelPreviewGlobalUnsub) {
            this._channelPreviewGlobalUnsub = this._subscribeAllPreviews();
        }
    }

    /** @private */
    _installChannelImageListener() {
        // The manager doesn't currently provide a "wildcard" subscription —
        // wrap setLocal/_emit by patching once: track all subscriptions and
        // re-register lazily as channels appear in the rendered list.
        // Simpler approach: hook into render() — but to also catch async
        // updates, use a lightweight MutationObserver-free approach:
        // poll the manager from within `render()` (cheap; runs on demand),
        // and rely on `renderChannelList()` callbacks already wired in
        // ChannelSettingsUI on upload. For incoming images discovered from
        // `subscribeToChannel` on this client, channels.js calls
        // `channelImageManager.get()` which only emits on hash change; we
        // subscribe per-channel below in `_subscribeAllImages()`.
        return this._subscribeAllImages();
    }

    /** @private — re-subscribe to all known channels' image streams */
    _subscribeAllImages() {
        if (this._imageSubs) {
            for (const u of this._imageSubs.values()) { try { u(); } catch {} }
        }
        this._imageSubs = new Map();
        const subscribe = (adminStreamId, streamId, password) => {
            if (!adminStreamId || this._imageSubs.has(adminStreamId)) return;
            const unsub = channelImageManager.subscribe(adminStreamId, () => {
                this._refreshSingleRow(streamId, adminStreamId);
            });
            this._imageSubs.set(adminStreamId, unsub);
            // Lazy fetch: if we don't yet have a cached image for this
            // channel (e.g. user has it in sidebar but never opened it on
            // this origin / device), trigger a background resend so the
            // sidebar can show the admin-published image without requiring
            // the user to enter the channel first. Mirrors what ExploreUI
            // does for its grid.
            if (channelImageManager.getCached(adminStreamId)) {
                this._resolvedImages.add(adminStreamId);
            } else {
                channelImageManager.get(adminStreamId, { password: password || null })
                    .catch(() => {})
                    .finally(() => {
                        this._resolvedImages.add(adminStreamId);
                        this._refreshSingleRow(streamId, adminStreamId);
                    });
            }
        };
        // Subscribe to current channels and again whenever render() runs
        try {
            const all = this.channelManager?.getAllChannels?.();
            if (Array.isArray(all)) {
                for (const ch of all) {
                    if (ch && ch.type !== 'dm') {
                        subscribe(
                            ch.adminStreamId || deriveAdminId(ch.streamId),
                            ch.streamId,
                            ch.password
                        );
                    }
                }
            }
        } catch {
            // Defensive: tests may inject minimal mocks
        }
        // Return a disposer
        return () => {
            for (const u of this._imageSubs.values()) { try { u(); } catch {} }
            this._imageSubs?.clear();
        };
    }

    /** @private — update a single row's avatar slot in place */
    _refreshSingleRow(streamId, adminStreamId) {
        if (!this.elements?.channelList) return;
        const row = this.elements.channelList.querySelector(`.channel-item[data-stream-id="${CSS.escape(streamId)}"]`);
        if (!row) return;
        const slot = row.querySelector('.channel-icon-slot');
        if (!slot) return;
        const dataUrl = this._getCachedImageDataUrl(adminStreamId);
        if (dataUrl) {
            slot.style.width = '44px';
            slot.innerHTML = `<img class="channel-item-image rounded-full object-cover" alt="" src="${escapeAttr(dataUrl)}" draggable="true" style="width:44px;height:44px" />`;
        } else if (this._resolvedImages.has(adminStreamId)) {
            // Resolution finished without a remote image — swap spinner
            // placeholder for the deterministic fallback avatar.
            slot.style.width = '44px';
            slot.innerHTML = `<div class="rounded-full overflow-hidden" style="width:44px;height:44px">${getAvatarHtml(streamId, 44, 0.5, null)}</div>`;
        }
        // Bump signature so next reconcile doesn't replace this row
        const cached = channelImageManager.getCached(adminStreamId);
        const sig = row.dataset.renderSignature;
        if (sig) {
            try {
                const arr = JSON.parse(sig);
                arr[4] = cached?.hash || '';
                row.dataset.renderSignature = JSON.stringify(arr);
            } catch {}
        }
    }

    /**
     * @private — re-subscribe to all known channels' latest-message previews.
     * Triggers a background fetch for streams without a cached entry so the
     * sidebar can render previews for channels the user hasn't opened yet
     * (mirrors `_subscribeAllImages`). DMs are excluded — preview comes
     * exclusively from local `channel.messages` via the channelManager hook.
     */
    _subscribeAllPreviews() {
        if (this._previewSubs) {
            for (const u of this._previewSubs.values()) { try { u(); } catch {} }
        }
        this._previewSubs = new Map();
        const subscribe = (streamId, password) => {
            if (!streamId || this._previewSubs.has(streamId)) return;
            const unsub = channelLatestMessageManager.subscribe(streamId, () => {
                this._refreshSinglePreview(streamId);
            });
            this._previewSubs.set(streamId, unsub);
            if (channelLatestMessageManager.getCached(streamId)) {
                this._resolvedPreviews.add(streamId);
            } else {
                channelLatestMessageManager.get(streamId, { password: password || null })
                    .catch(() => {})
                    .finally(() => {
                        this._resolvedPreviews.add(streamId);
                        this._refreshSinglePreview(streamId);
                    });
            }
        };
        try {
            const all = this.channelManager?.getAllChannels?.();
            if (Array.isArray(all)) {
                for (const ch of all) {
                    if (!ch) continue;
                    if (ch.type === 'dm') {
                        // DMs never hit the resend path — only live messages
                        // populate the preview. Subscribe so the row patches
                        // when a message arrives, but do NOT mark resolved
                        // (would cause a render-signature flip on the next
                        // render). The slot stays as a spinner placeholder
                        // until the first message lands.
                        if (!this._previewSubs.has(ch.streamId)) {
                            const unsub = channelLatestMessageManager.subscribe(ch.streamId, () => {
                                this._refreshSinglePreview(ch.streamId);
                            });
                            this._previewSubs.set(ch.streamId, unsub);
                        }
                        continue;
                    }
                    subscribe(ch.streamId, ch.password);
                }
            }
        } catch {
            // Defensive: tests may inject minimal mocks
        }
        return () => {
            for (const u of this._previewSubs.values()) { try { u(); } catch {} }
            this._previewSubs?.clear();
        };
    }

    /**
     * @private — patch the second row of a single channel item in place.
     */
    _refreshSinglePreview(streamId) {
        if (!this.elements?.channelList) return;
        const row = this.elements.channelList.querySelector(`.channel-item[data-stream-id="${CSS.escape(streamId)}"]`);
        if (!row) return;
        const slot = row.querySelector('.channel-preview-slot');
        if (!slot) return;
        const entry = channelLatestMessageManager.getCached(streamId);
        const channelType = this.channelManager?.getChannel?.(streamId)?.type || null;
        slot.innerHTML = this._renderPreviewSlotInner(streamId, entry, channelType);
        // Bump signature so reconcile doesn't replace this row
        const sig = row.dataset.renderSignature;
        if (sig) {
            try {
                const arr = JSON.parse(sig);
                arr[8] = this._previewSignature(entry);
                row.dataset.renderSignature = JSON.stringify(arr);
            } catch {}
        }
    }

    /** @private */
    _previewSignature(entry) {
        if (!entry) return '';
        // id+type+ts is enough to detect updates
        return `${entry.type}:${entry.id || ''}:${entry.ts || 0}:${entry.action || ''}:${entry.emoji || ''}`;
    }

    /** @private */
    _renderPreviewSlotInner(streamId, entry, channelType = null) {
        if (entry) {
            // DMs only have two participants \u2014 the sender prefix is
            // redundant and adds visual noise. Drop it for DM rows.
            const omitSender = channelType === 'dm';
            // `.channel-preview-line` controls color / truncation /
            // wrapping uniformly. Sender, separator, address, ENS and
            // nickname all inherit the same muted gray.
            return `<span class="channel-preview-line block">${formatPreviewLine(entry, { omitSender })}</span>`;
        }
        // Unresolved — show a small spinner placeholder for both regular
        // channels (waiting on resend) and DMs (waiting on first live msg).
        if (!this._resolvedPreviews.has(streamId)) {
            return `<span class="inline-flex items-center"><span class="thumb-spinner" style="width:10px;height:10px"></span></span>`;
        }
        return '';
    }

    /**
     * Kick off ENS avatar resolution for any DM rows whose peer avatar is
     * not yet cached. Resolution is deduped & cached by identityManager;
     * once it lands, the next render() picks it up via the signature change.
     * @private
     */
    _resolveDMAvatars(channelViewModels) {
        if (!Array.isArray(channelViewModels)) return;
        for (const vm of channelViewModels) {
            if (vm.type !== 'dm' || !vm.peerAddress) continue;
            const peer = vm.peerAddress;
            if (vm.peerEnsAvatar || this._resolvedDMPeers.has(peer)) continue;
            // Fire-and-forget. Trigger a re-render when it resolves so the
            // newly-cached avatar (or fallback) appears without user
            // interaction. Mark resolved on settle (success or failure)
            // so the spinner placeholder swaps to deterministic avatar.
            try {
                identityManager.resolveENSAvatar?.(peer)
                    ?.then(url => {
                        this._resolvedDMPeers.add(peer);
                        if (url) this.render();
                        else this.render();
                    })
                    ?.catch(() => {
                        this._resolvedDMPeers.add(peer);
                        this.render();
                    });
            } catch {
                this._resolvedDMPeers.add(peer);
            }
        }
    }

    /**
     * Kick off ENS resolution for the senders of all cached preview
     * entries that don't carry a payload `senderName` and haven't been
     * resolved yet. identityManager.resolveENS dedupes inflight + caches
     * 24h, so this is cheap to call on every render. When ENS lands the
     * row's `_refreshSinglePreview` re-renders via the existing
     * subscribe() hook (we manually trigger after the resolve settles).
     * @private
     */
    _resolvePreviewSenders() {
        const seen = new Set();
        // Collect addresses from every cached preview entry.
        try {
            const all = this.channelManager?.getAllChannels?.() || [];
            for (const ch of all) {
                if (!ch?.streamId) continue;
                const entry = channelLatestMessageManager.getCached(ch.streamId);
                if (!entry || !entry.sender) continue;
                if (entry.senderName) continue; // payload already wins
                const addr = entry.sender;
                const normalizedAddr = typeof addr === 'string' ? addr.toLowerCase() : addr;
                if (seen.has(normalizedAddr)) continue;
                seen.add(normalizedAddr);
                // Skip only positive cache hits. Null / startup misses must
                // stay retryable so previews recover once identity init or a
                // provider comes back.
                const cached = normalizedAddr ? identityManager.ensCache?.get(normalizedAddr) : null;
                if (cached && cached.name) continue;
                identityManager.resolveENS?.(addr)
                    ?.then(name => {
                        if (!name) return;
                        // Refresh every row whose sender matches.
                        try {
                            const list = this.channelManager?.getAllChannels?.() || [];
                            for (const c of list) {
                                if (!c?.streamId) continue;
                                const e = channelLatestMessageManager.getCached(c.streamId);
                                const sender = typeof e?.sender === 'string' ? e.sender.toLowerCase() : e?.sender;
                                if (sender === normalizedAddr) {
                                    this._refreshSinglePreview(c.streamId);
                                }
                            }
                        } catch {}
                    })
                    ?.catch(() => {});
            }
        } catch {}
    }

    /**
     * Set DOM element references
     */
    setElements(elements) {
        this.elements = elements;
    }

    /**
     * Set the current channel filter
     * @param {string} filter - 'all' | 'personal' | 'community'
     */
    setFilter(filter) {
        this.currentFilter = filter;
    }

    /**
     * Get the current channel filter
     * @returns {string}
     */
    getFilter() {
        return this.currentFilter;
    }

    /**
     * Render the channel list with current filter
     */
    render() {
        if (!this.channelManager || !this.elements.channelList) {
            Logger.warn('ChannelListUI: Missing dependencies or elements');
            return;
        }

        let channels = this.channelManager.getAllChannels();
        Logger.debug('ChannelListUI.render - Total channels:', channels.length);

        // Apply channel filter
        channels = this._applyFilter(channels);

        if (channels.length === 0) {
            this._renderEmptyState();
            this._renderInterruptedCreates();
            this._attachClickListeners();
            return;
        }

        // Sort by user-defined order
        const channelOrder = this.secureStorage.getChannelOrder();
        if (channelOrder.length > 0) {
            channels = this._sortByOrder(channels, channelOrder);
        }

        // Get current channel for highlighting
        const currentChannel = this.channelManager.getCurrentChannel();
        const currentStreamId = currentChannel?.streamId;
        const channelViewModels = channels.map(channel =>
            this._buildChannelViewModel(channel, currentStreamId)
        );

        // Reconcile channel items without rebuilding unchanged rows
        this._reconcileChannelItems(channelViewModels);
        this._renderInterruptedCreates();

        // Refresh per-channel image listeners (idempotent for unchanged set)
        this._channelImageGlobalUnsub = this._subscribeAllImages();
        // Same for the latest-message preview line.
        this._channelPreviewGlobalUnsub = this._subscribeAllPreviews();

        // Lazy-resolve ENS avatars for DM peers (off-chain HTTP).
        // resolveENSAvatar dedups in-flight lookups; once resolved it
        // caches in localStorage, so the next render sees it via
        // getCachedENSAvatar and the row signature changes → re-render.
        this._resolveDMAvatars(channelViewModels);

        // Lazy-resolve ENS for the senders of cached preview entries
        // that don't carry a payload `senderName`. Same pattern as
        // `OnlineUsersUI` / `_resolveDMAvatars` — fire-and-forget,
        // dedupe in identityManager, refresh on settle.
        this._resolvePreviewSenders();

        // Attach delegated event listeners once
        this._attachClickListeners();
        this._setupDragAndDrop();

        Logger.debug('ChannelListUI: Render complete');
    }

    /**
     * Apply filter to channels
     * @private
     */
    _applyFilter(channels) {
        switch (this.currentFilter) {
            case 'personal':
                // Personal: any channel with classification 'personal'
                return channels.filter(ch => ch.classification === 'personal');
            case 'community':
                // Communities: channels without classification OR with classification 'community'
                // This includes public/password channels without explicit classification
                return channels.filter(ch => 
                    !ch.classification || ch.classification === 'community'
                );
            default:
                // 'all' - no filtering
                return channels;
        }
    }

    /**
     * Creations a reload interrupted after something of them landed, above
     * the channels: Finish sends what is missing, Discard forgets them.
     * @private
     */
    _renderInterruptedCreates() {
        this.elements.channelList.querySelector('.pending-creates')?.remove();
        const records = this.channelManager.getInterruptedCreates?.() || [];
        if (records.length === 0) return;
        const block = document.createElement('div');
        block.className = 'pending-creates space-y-1.5';
        block.innerHTML = records.map(record => `
            <div class="pending-create mx-2 rounded-xl bg-overlay-2 border border-overlay-4 px-3 py-2.5" data-pending-base="${escapeAttr(record.basePath)}">
                <div class="flex items-center gap-1.5 min-w-0">
                    <h3 class="text-sm font-medium text-overlay-90 truncate">${escapeHtml(sanitizeText(record.name))}</h3>
                    <span class="text-[12px] text-overlay-40 flex-shrink-0">· creation interrupted</span>
                </div>
                <div class="flex items-center gap-2 mt-2">
                    <button type="button" data-pending-action="finish" class="bg-overlay-90 hover:bg-white text-surface-2 px-3 py-1 rounded-md text-[11px] font-medium transition">Finish</button>
                    <button type="button" data-pending-action="discard" class="bg-overlay-10 hover:bg-overlay-20 text-overlay-70 px-3 py-1 rounded-md text-[11px] font-medium transition">Discard</button>
                </div>
            </div>`).join('');
        this.elements.channelList.prepend(block);
    }

    /** @private */
    async _onPendingAction(action, basePath, row) {
        const handler = action === 'finish' ? this.onFinishPendingCreate : this.onDiscardPendingCreate;
        if (!handler) return;
        row.querySelectorAll('button').forEach(button => { button.disabled = true; });
        try {
            await handler(basePath);
        } finally {
            this.render();
        }
    }

    /**
     * Render empty state message
     * @private
     */
    _renderEmptyState() {
        const filterMsg = this.currentFilter === 'all' 
            ? 'No channels yet' 
            : `No ${this.currentFilter} channels`;

        const emptyState = document.createElement('div');
        emptyState.className = 'p-4 text-center text-overlay-25 text-[13px]';
        emptyState.textContent = filterMsg;
        this.elements.channelList.replaceChildren(emptyState);
        Logger.debug('ChannelListUI: No channels to render');
    }

    /**
     * Build the render view-model for a channel row.
     * @private
     */
    _buildChannelViewModel(channel, currentStreamId) {
        const lastAccess = this.secureStorage.getChannelLastAccess(channel.streamId) || 0;
        const messages = Array.isArray(channel.messages) ? channel.messages : [];
        const unreadCount = messages.reduce((count, message) => {
            const isUnread = message.timestamp > lastAccess
                && !message._deleted
                && !['reaction', 'edit', 'delete'].includes(message.type);
            return isUnread ? count + 1 : count;
        }, 0);
        const hasUnread = unreadCount > 0;

        return {
            streamId: channel.streamId,
            name: channel.name,
            type: channel.type,
            readOnly: !!channel.readOnly,
            unreadCount,
            hasUnread,
            displayCount: hasUnread ? (unreadCount >= 30 ? '+30' : unreadCount) : '',
            isActive: channel.streamId === currentStreamId,
            // Channel image hash (for render signature; null if no image cached)
            imageHash: this._getCachedImageHash(channel.streamId, channel.type),
            adminStreamId: channel.adminStreamId || deriveAdminId(channel.streamId),
            // For DM rows: peer address + cached ENS avatar URL (if any)
            peerAddress: channel.peerAddress || null,
            peerEnsAvatar: channel.peerAddress
                ? (identityManager.getCachedENSAvatar?.(channel.peerAddress) || null)
                : null,
            // Latest-message preview entry (may be null while loading)
            previewEntry: channelLatestMessageManager.getCached(channel.streamId)
        };
    }

    /** @private */
    _getCachedImageHash(streamId, type) {
        if (type === 'dm') return null;
        const adminId = deriveAdminId(streamId);
        if (!adminId) return null;
        return channelImageManager.getCached(adminId)?.hash || null;
    }

    /** @private */
    _getCachedImageDataUrl(adminStreamId) {
        if (!adminStreamId) return null;
        return channelImageManager.getCached(adminStreamId)?.dataUrl || null;
    }

    /**
     * Reconcile channel rows by stream id so unchanged nodes can be reused.
     * @private
     */
    _reconcileChannelItems(channelViewModels) {
        const existingItems = new Map(
            Array.from(this.elements.channelList.querySelectorAll('.channel-item'))
                .map(item => [item.dataset.streamId, item])
        );
        const signatures = channelViewModels.map(viewModel => this._buildRenderSignature(viewModel));
        const currentItems = Array.from(this.elements.channelList.children)
            .filter(element => element.classList?.contains('channel-item'));
        const isUnchanged = currentItems.length === channelViewModels.length
            && currentItems.every((item, index) => (
                item.dataset.streamId === channelViewModels[index].streamId
                && item.dataset.renderSignature === signatures[index]
            ));

        if (isUnchanged) {
            return;
        }

        const fragment = document.createDocumentFragment();

        channelViewModels.forEach((viewModel, index) => {
            const signature = signatures[index];
            let item = existingItems.get(viewModel.streamId);

            if (!item || item.dataset.renderSignature !== signature) {
                item = this._createChannelItemElement(viewModel, signature);
            }

            fragment.appendChild(item);
        });

        this.elements.channelList.replaceChildren(fragment);
    }

    /**
     * Build a stable signature for a rendered channel row.
     * @private
     */
    _buildRenderSignature(channelViewModel) {
        const isResolved = channelViewModel.type === 'dm'
            ? (!!channelViewModel.peerEnsAvatar || (channelViewModel.peerAddress ? this._resolvedDMPeers.has(channelViewModel.peerAddress) : true))
            : (!!channelViewModel.imageHash || (channelViewModel.adminStreamId ? this._resolvedImages.has(channelViewModel.adminStreamId) : true));
        // Preview-resolved is uniform across channel types: the slot
        // shows a spinner until either the resend (regular channels) or
        // the first live message (DMs) settles the entry.
        const previewResolved = !!channelViewModel.previewEntry
            || this._resolvedPreviews.has(channelViewModel.streamId);
        return JSON.stringify([
            channelViewModel.name,
            channelViewModel.type,
            channelViewModel.unreadCount,
            channelViewModel.isActive,
            channelViewModel.imageHash || '',
            channelViewModel.peerEnsAvatar || '',
            channelViewModel.readOnly ? 1 : 0,
            isResolved ? 1 : 0,
            // Index 8: preview signature (kept in sync by `_refreshSinglePreview`)
            this._previewSignature(channelViewModel.previewEntry),
            // Index 9: preview-resolved flag — drives spinner placeholder.
            previewResolved ? 1 : 0
        ]);
    }

    /**
     * Create a channel row element.
     * @private
     */
    _createChannelItemElement(channelViewModel, signature) {
        const template = document.createElement('template');
        template.innerHTML = this._renderChannelItem(channelViewModel).trim();
        const element = template.content.firstElementChild;
        element.dataset.renderSignature = signature;
        return element;
    }

    /**
     * Render the only permission indicator still shown in the sidebar:
     * the read-only megaphone. All other type/permission icons were
     * removed because the ChatHeader already exposes that metadata.
     * @private
     */
    _renderReadOnlyIcon(readOnly = false) {
        if (!readOnly) return '';
        const cls = 'w-3.5 h-3.5 text-overlay-40 flex-shrink-0';
        return `<svg class="${cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"/></svg>`;
    }

    /**
     * Render a single channel item
     * @private
     */
    _renderChannelItem(channelViewModel) {
        const countClass = channelViewModel.hasUnread 
            ? 'text-primary bg-[#F6851B]/20 font-medium' 
            : 'text-overlay-30 bg-overlay-4';

        const activeClass = channelViewModel.isActive 
            ? 'border-l-2 border-l-[#F6851B] bg-overlay-6' 
            : 'border-l-2 border-l-transparent';

        // Icon / avatar slot:
        //   - DM channels: peer ENS avatar (if cached) or deterministic
        //     avatar from peer address. Falls back to streamId so DMs
        //     without a known peerAddress still render something.
        //   - Other channels: render channel image if cached, else fallback avatar.
        // Render image / avatar / spinner. We show a spinner whenever the
        // remote lookup is still pending so the deterministic fallback
        // doesn't flash before the real image / ENS avatar arrives.
        const spinnerSlot = `<div class="rounded-full flex items-center justify-center bg-overlay-4" style="width:44px;height:44px"><div class="thumb-spinner" style="width:16px;height:16px"></div></div>`;
        let iconSlot = '';
        if (channelViewModel.type === 'dm') {
            const seed = channelViewModel.peerAddress || channelViewModel.streamId;
            if (channelViewModel.peerEnsAvatar) {
                iconSlot = `<div class="rounded-full overflow-hidden" style="width:44px;height:44px">${getAvatarHtml(seed, 44, 0.5, channelViewModel.peerEnsAvatar)}</div>`;
            } else if (channelViewModel.peerAddress && !this._resolvedDMPeers.has(channelViewModel.peerAddress)) {
                iconSlot = spinnerSlot;
            } else {
                iconSlot = `<div class="rounded-full overflow-hidden" style="width:44px;height:44px">${getAvatarHtml(seed, 44, 0.5, null)}</div>`;
            }
        } else {
            const dataUrl = this._getCachedImageDataUrl(channelViewModel.adminStreamId);
            if (dataUrl) {
                iconSlot = `<img class="channel-item-image rounded-full object-cover" alt="" src="${escapeAttr(dataUrl)}" draggable="true" style="width:44px;height:44px" />`;
            } else if (channelViewModel.adminStreamId && !this._resolvedImages.has(channelViewModel.adminStreamId)) {
                iconSlot = spinnerSlot;
            } else {
                iconSlot = `<div class="rounded-full overflow-hidden" style="width:44px;height:44px">${getAvatarHtml(channelViewModel.streamId, 44, 0.5, null)}</div>`;
            }
        }
        const readOnlyIcon = this._renderReadOnlyIcon(channelViewModel.readOnly);

        return `
            <div
                class="channel-item mx-2 rounded-xl cursor-pointer bg-overlay-2 border border-overlay-4 hover:bg-overlay-6 hover:border-overlay-8 transition-all duration-200 group ${activeClass}"
                data-stream-id="${escapeAttr(channelViewModel.streamId)}"
                data-admin-stream-id="${escapeAttr(channelViewModel.adminStreamId || '')}"
                draggable="true"
            >
                <div class="channel-item-body flex items-center">
                    <!-- Icon / avatar slot -->
                    <div class="channel-icon-slot flex-shrink-0 flex items-center justify-center" style="width:44px">
                        ${iconSlot}
                    </div>
                    <!-- Two stacked rows: name + read-only icon | preview line -->
                    <div class="channel-item-main flex-1 min-w-0">
                        <div class="flex items-center min-w-0">
                            <h3 class="text-sm font-medium text-overlay-90 truncate">${escapeHtml(sanitizeText(channelViewModel.name))}</h3>
                            ${readOnlyIcon ? `<div class="channel-item-readonly-icon flex items-center flex-shrink-0">${readOnlyIcon}</div>` : ''}
                        </div>
                        <div class="channel-preview-slot">
                            ${this._renderPreviewSlotInner(channelViewModel.streamId, channelViewModel.previewEntry, channelViewModel.type)}
                        </div>
                    </div>
                    <!-- Right side: drag handle + counter (vertically centered between the 2 rows by the body's items-center) -->
                    <div class="channel-item-actions flex items-center flex-shrink-0">
                        <!-- Drag handle (6 dots) - visible on hover -->
                        <div class="drag-handle cursor-grab opacity-0 group-hover:opacity-100 transition-opacity text-overlay-20 hover:text-overlay-40" title="Drag to reorder">
                            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                <circle cx="8" cy="6" r="1.5"/>
                                <circle cx="16" cy="6" r="1.5"/>
                                <circle cx="8" cy="12" r="1.5"/>
                                <circle cx="16" cy="12" r="1.5"/>
                                <circle cx="8" cy="18" r="1.5"/>
                                <circle cx="16" cy="18" r="1.5"/>
                            </svg>
                        </div>
                        ${channelViewModel.hasUnread 
                            ? `<span class="channel-msg-count text-[10px] ${countClass} rounded-md" data-channel-count="${escapeAttr(channelViewModel.streamId)}">${channelViewModel.displayCount}</span>` 
                            : `<span class="channel-msg-count text-[10px] text-overlay-30 bg-overlay-4 rounded-md hidden" data-channel-count="${escapeAttr(channelViewModel.streamId)}">0</span>`
                        }
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Sort channels by user-defined order
     * @private
     */
    _sortByOrder(channels, order) {
        const orderMap = new Map(order.map((id, index) => [id, index]));
        return [...channels].sort((a, b) => {
            const indexA = orderMap.has(a.streamId) ? orderMap.get(a.streamId) : Infinity;
            const indexB = orderMap.has(b.streamId) ? orderMap.get(b.streamId) : Infinity;
            return indexA - indexB;
        });
    }

    /**
     * Attach click listeners to channel items
     * @private
     */
    _attachClickListeners() {
        if (this.clickListenersAttached || !this.elements.channelList) {
            return;
        }

        this.elements.channelList.addEventListener('click', (event) => {
            const clickTarget = event.target instanceof Element ? event.target : null;
            const pendingAction = clickTarget?.closest('[data-pending-action]');
            const pendingRow = pendingAction?.closest('.pending-create');
            if (pendingRow) {
                this._onPendingAction(pendingAction.dataset.pendingAction, pendingRow.dataset.pendingBase, pendingRow);
                return;
            }
            const item = this._getChannelItemFromEventTarget(event.target);
            if (!item || clickTarget?.closest('.drag-handle')) {
                return;
            }

            const streamId = item.dataset.streamId;
            Logger.debug('ChannelListUI: Channel clicked:', streamId);

            if (this.onChannelSelect) {
                this.onChannelSelect(streamId);
            }
        });

        this.elements.channelList.addEventListener('contextmenu', (event) => {
            if (this._getChannelItemFromEventTarget(event.target)) {
                event.preventDefault();
            }
        });

        this.clickListenersAttached = true;
    }

    /**
     * Setup drag and drop for channel reordering
     * @private
     */
    _setupDragAndDrop() {
        if (this.dragAndDropBound || !this.elements.channelList) {
            return;
        }

        this.elements.channelList.addEventListener('dragstart', (event) => {
            const item = this._getChannelItemFromEventTarget(event.target);
            if (!item) {
                return;
            }

            this.draggedItem = item;
            this.draggedStreamId = item.dataset.streamId;
            item.classList.add('dragging');

            // Required for Firefox
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', this.draggedStreamId);

            setTimeout(() => {
                item.style.opacity = '0.5';
            }, 0);
        });

        this.elements.channelList.addEventListener('dragend', (event) => {
            const item = this._getChannelItemFromEventTarget(event.target);
            if (!item) {
                return;
            }

            item.classList.remove('dragging');
            item.style.opacity = '';
            this.draggedItem = null;
            this.draggedStreamId = null;

            this.elements.channelList.querySelectorAll('.channel-item').forEach(element => {
                element.classList.remove('drag-over');
            });
        });

        this.elements.channelList.addEventListener('dragover', (event) => {
            const item = this._getChannelItemFromEventTarget(event.target);
            if (!item) {
                return;
            }

            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';

            if (item !== this.draggedItem) {
                item.classList.add('drag-over');
            }
        });

        this.elements.channelList.addEventListener('dragleave', (event) => {
            const item = this._getChannelItemFromEventTarget(event.target);
            if (!item || (event.relatedTarget instanceof Element && item.contains(event.relatedTarget))) {
                return;
            }

            item.classList.remove('drag-over');
        });

        this.elements.channelList.addEventListener('drop', async (event) => {
            const item = this._getChannelItemFromEventTarget(event.target);
            if (!item) {
                return;
            }

            event.preventDefault();
            item.classList.remove('drag-over');

            if (!this.draggedItem || item === this.draggedItem) {
                return;
            }

            const targetStreamId = item.dataset.streamId;
            await this._handleDrop(this.draggedStreamId, targetStreamId);
        });

        this.dragAndDropBound = true;
    }

    /**
     * Resolve a channel row from an event target.
     * @private
     */
    _getChannelItemFromEventTarget(target) {
        if (!(target instanceof Element) || !this.elements.channelList) {
            return null;
        }

        const item = target.closest('.channel-item');
        return item && this.elements.channelList.contains(item) ? item : null;
    }

    /**
     * Handle drop event - reorder channels
     * @private
     */
    async _handleDrop(draggedStreamId, targetStreamId) {
        // Get current order or create from current channel list
        let currentOrder = this.secureStorage.getChannelOrder();
        const channels = this.channelManager.getAllChannels();
        
        // If no saved order, create from current channels
        if (currentOrder.length === 0) {
            currentOrder = channels.map(ch => ch.streamId);
        }
        
        // Ensure all current channels are in the order
        channels.forEach(ch => {
            if (!currentOrder.includes(ch.streamId)) {
                currentOrder.push(ch.streamId);
            }
        });
        
        // Find positions
        const draggedIndex = currentOrder.indexOf(draggedStreamId);
        const targetIndex = currentOrder.indexOf(targetStreamId);
        
        if (draggedIndex === -1 || targetIndex === -1) return;
        
        // Remove dragged item and insert at new position
        currentOrder.splice(draggedIndex, 1);
        currentOrder.splice(targetIndex, 0, draggedStreamId);
        
        // Save the new order
        await this.secureStorage.setChannelOrder(currentOrder);

        if (this.draggedItem) {
            this.draggedItem.classList.remove('dragging');
            this.draggedItem.style.opacity = '';
        }
        this.draggedItem = null;
        this.draggedStreamId = null;
        
        // Re-render the list
        this.render();
        
        Logger.debug('ChannelListUI: Channel order updated');
    }

    /**
     * Update unread badge for a specific channel
     * @param {string} streamId - Channel stream ID
     * @param {number} count - New unread count
     */
    updateUnreadBadge(streamId, count) {
        const badge = this.elements.channelList?.querySelector(`[data-channel-count="${CSS.escape(streamId)}"]`);
        if (!badge) return;

        if (count > 0) {
            badge.textContent = count >= 30 ? '+30' : count;
            badge.classList.remove('hidden', 'text-overlay-30', 'bg-overlay-4');
            badge.classList.add('text-primary', 'bg-[#F6851B]/20', 'font-medium');
        } else {
            badge.textContent = '0';
            badge.classList.add('hidden');
            badge.classList.remove('text-primary', 'bg-[#F6851B]/20', 'font-medium');
            badge.classList.add('text-overlay-30', 'bg-overlay-4');
        }
    }

    /**
     * Highlight the active channel in the list
     * @param {string} streamId - Channel stream ID to highlight
     */
    setActiveChannel(streamId) {
        this.elements.channelList?.querySelectorAll('.channel-item').forEach(item => {
            const isActive = item.dataset.streamId === streamId;
            item.classList.toggle('border-l-[#F6851B]', isActive);
            item.classList.toggle('bg-overlay-6', isActive);
            item.classList.toggle('border-l-transparent', !isActive);
        });
    }
}

// Export singleton instance
export const channelListUI = new ChannelListUI();
