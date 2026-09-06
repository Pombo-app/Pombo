/**
 * ChannelSettingsUI
 * Manages channel settings modal, members list, permissions, and danger zone
 */

import { Logger } from '../logger.js';
import { modalManager } from './ModalManager.js';
import { escapeHtml, escapeAttr, wireIdentitySpec, wireIdentityIcon, formatAddress, formatStreamId } from './utils.js';
import { sanitizeText } from './sanitizer.js';
import { relayManager } from '../relayManager.js';
import { graphAPI } from '../graph.js';
import { identityManager } from '../identity.js';
import { epochKeyManager } from '../epochKeyManager.js';
import { mediaController } from '../media.js';
import { channelImageManager } from '../channelImageManager.js';
import { deriveAdminId } from '../streamConstants.js';
import { getAvatarHtml } from './AvatarGenerator.js';
import { formatRemaining } from './SubscriptionBannerUI.js';

const CHIP_CLASS = 'inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs '
    + 'text-white/55 bg-white/5 border border-white/[0.08]';
/** Must track the w-[88px] of #channel-image-preview. */
const AVATAR_PX = 88;

class ChannelSettingsUI {
    constructor() {
        this.deps = null;
        this.elements = null;
        this.showDangerTab = false;
        this.showModerationTab = false;
        this.showMembersTab = true; // Only for gated channels
        this._mobileSubPanelOpen = null; // Track which sub-panel is open on mobile
        this._adminHandlerWired = false;
        this._currentModerationStreamId = null;
    }

    /**
     * Set dependencies from UIController
     */
    setDependencies(deps) {
        this.deps = deps;
    }

    /**
     * Set element references
     */
    setElements(elements) {
        this.elements = elements;
        // Initialize channel name edit handlers after elements are set
        this.initChannelNameEdit();
        this._wireHints();
    }

    /**
     * One delegated listener for every ⓘ in the modal: the caption states the
     * effect and the cost, the detail stays a tap away. Touch has no hover,
     * so the toggle carries what the title attribute alone would hide.
     */
    _wireHints() {
        if (this._hintsWired) return;
        this._hintsWired = true;
        document.addEventListener('click', (event) => {
            const trigger = event.target?.closest?.('[data-hint]');
            if (!trigger) return;
            document.getElementById(trigger.dataset.hint)?.classList.toggle('hidden');
        });
    }

    /**
     * Show channel settings modal
     */
    async show() {
        const { channelManager, streamrController, authManager } = this.deps;
        
        // Use getActiveChannel to support both regular and preview mode
        const currentChannel = this.deps.getActiveChannel?.() || channelManager.getCurrentChannel();
        if (!currentChannel) {
            this.deps.showNotification('No channel selected', 'error');
            return;
        }

        // Check if in preview mode
        const isPreviewMode = this.deps.isInPreviewMode?.() || false;

        // Determine effective read-only state from cached publish permission
        // If user cannot publish, treat as read-only regardless of channel.readOnly flag
        const canPublish = currentChannel._publishPermCache?.canPublish;
        const effectiveReadOnly = canPublish === false || currentChannel.readOnly;

        // Update channel info
        this.elements.channelSettingsType.innerHTML = this.deps.getChannelTypeLabel(currentChannel.type, effectiveReadOnly, true);
        this._applyTypeChips();
        this._applyGateAccessLabel(currentChannel);
        this._applyWireIdentityLine(currentChannel);
        this._applyIdentifierRow(currentChannel);

        // Populate channel name (network name, local name, or display fallback)
        const channelName = currentChannel.channelInfo?.name || currentChannel.name || currentChannel.channelInfo?.displayName || '';
        if (this.elements.channelSettingsName) {
            this.elements.channelSettingsName.textContent = channelName;
        }

        // Reset edit state: hide edit container and restore name display
        // (guards against modal being closed mid-edit, which left the name hidden)
        if (this.elements.channelNameEditContainer) {
            this.elements.channelNameEditContainer.classList.add('hidden');
        }
        if (this.elements.channelSettingsName) {
            this.elements.channelSettingsName.classList.remove('hidden');
        }
        if (this.elements.channelSettingsDescriptionInput) {
            this.elements.channelSettingsDescriptionInput.classList.add('hidden');
        }
        this.elements.channelDescriptionDisplay?.classList.remove('hidden');
        if (this.elements.channelEditActions) {
            this.elements.channelEditActions.classList.add('hidden');
        }
        this._editingDescription = false;

        // Determine channel type. Gated channels (N-C) share the whole
        // Closed surface — member list, add/remove, notifications — the
        // difference is only where membership lives (gate contract vs grants).
        const isGated = !!currentChannel.gate?.address;
        
        // In preview mode: no admin permissions
        let canDelete = false;
        let canAddMembers = false;
        
        if (!isPreviewMode) {
            // Use cached DELETE permission if valid for current wallet, else fetch fresh
            const cached = channelManager.getCachedDeletePermission(currentChannel.streamId);
            canDelete = cached.valid 
                ? cached.canDelete 
                : await streamrController.hasDeletePermission(currentChannel.streamId);
            
            Logger.debug('Channel settings:', { 
                canDelete,
                fromCache: cached.valid,
                currentAddress: authManager.getAddress()?.slice(0,10) 
            });
            
            // Check if user can add members (owner OR has GRANT permission)
            canAddMembers = isGated ? await channelManager.canAddMembers(currentChannel.streamId) : false;
        }

        // Edit name permission:
        // - DM channels: any user can rename locally (propagated via sync)
        // - Channels without an on-chain name: any member can rename — the
        //   name is local to the device and propagated via sync. The Graph
        //   check is fail-closed: unreachable = treat as named, no pencil
        //   (a wrong yes would invite a rename that the next metadata
        //   refresh silently reverts).
        // - Visible channels: only the admin (DELETE permission) can rename — on-chain metadata update
        let memberLocalRename = false;
        if (currentChannel.type !== 'dm' && !isPreviewMode && !canDelete && !this._hasPublicMetadata(currentChannel)) {
            try {
                const info = await graphAPI.getChannelInfo(currentChannel.streamId);
                memberLocalRename = !info?.name;
            } catch { /* fail-closed */ }
        }
        const canEditName = (currentChannel.type === 'dm' || canDelete || memberLocalRename) && !isPreviewMode;
        if (this.elements.editChannelNameBtn) {
            this.elements.editChannelNameBtn.classList.toggle('hidden', !canEditName);
        }

        // Show name section if there is a name to display, or if the user can edit it
        if (this.elements.channelNameSection) {
            const showNameSection = channelName.trim() || currentChannel.type === 'dm' || isGated || canEditName;
            this.elements.channelNameSection.classList.toggle('hidden', !showNameSection);
        }

        // Get description from channel (regular or preview mode)
        // If no description, try to fetch from The Graph
        let description = currentChannel.description || currentChannel.channelInfo?.description || '';
        
        if (!description.trim()) {
            try {
                const graphInfo = await graphAPI.getChannelInfo(currentChannel.streamId);
                if (graphInfo?.description) {
                    description = graphInfo.description;
                    // Cache it on the channel object for future use
                    if (currentChannel.channelInfo) {
                        currentChannel.channelInfo.description = description;
                    } else {
                        currentChannel.description = description;
                    }
                }
            } catch (e) {
                Logger.debug('Could not fetch channel info from Graph:', e.message);
            }
        }
        
        // Show/hide description section in Info panel (only if description exists)
        const hasDescription = description.trim().length > 0;
        this.elements.descriptionSection.classList.toggle('hidden', !hasDescription);
        
        // Populate description display
        if (this.elements.channelDescriptionDisplay) {
            this.elements.channelDescriptionDisplay.textContent = description;
        }

        // Show/hide members tab button for gated channels only (and not in preview mode)
        this.showMembersTab = isGated && !isPreviewMode;
        const membersTabBtn = document.querySelector('[data-channel-tab="members"]');
        membersTabBtn?.classList.toggle('hidden', !isGated || isPreviewMode);
        
        // Show/hide notifications tab in preview mode
        const notificationsTabBtn = document.querySelector('[data-channel-tab="notifications"]');
        notificationsTabBtn?.classList.toggle('hidden', isPreviewMode);

        // Populate storage info
        this.populateStorageInfo(currentChannel);

        // Render channel image section (admin upload + preview for everyone).
        // Skipped for DM channels.
        this._renderChannelImageSection(currentChannel, !isPreviewMode);

        // Show/hide members-related elements based on permission to add members
        this.elements.addMemberForm?.classList.toggle('hidden', !canAddMembers);
        // TOKEN/NFT/PAID gates have no owner-minted members — allow() is
        // NONE-only on-chain, so manual add is a guaranteed revert there, and
        // there is no allowlist for the kebab's Remove either.
        this._gateModeIsNone = false;
        if (currentChannel.gate?.address) {
            import('../gate.js').then(async ({ gateManager, GATE_MODE }) => {
                try {
                    const info = await gateManager.getGateInfo(currentChannel.gate.address);
                    this._gateModeIsNone = info.mode === GATE_MODE.NONE;
                    if (info.mode !== GATE_MODE.NONE && canAddMembers) {
                        this.elements.addMemberForm?.classList.add('hidden');
                    }
                } catch { /* unreadable gate — leave visible, the tx error is decoded anyway */ }
            }).catch(() => {});
        }
        this.elements.permissionsSection?.classList.toggle('hidden', !canDelete || !isGated);

        // Clear members list for non-gated channels (prevents stale data)
        if (!isGated && this.elements.membersList) {
            this.elements.membersList.innerHTML = '';
        }

        // Initialize channel settings tabs (clones elements, must be before toggling visibility)
        this.initTabs();
        
        // Re-fetch danger tab elements after cloning (initTabs replaces DOM elements)
        const dangerTabDivider = document.getElementById('danger-tab-divider');
        const dangerTabBtn = document.getElementById('danger-tab-btn');
        
        // Show/hide danger tab for users with DELETE permission only
        this.showDangerTab = canDelete;
        dangerTabDivider?.classList.toggle('hidden', !canDelete);
        dangerTabBtn?.classList.toggle('hidden', !canDelete);

        // Show/hide moderation tab for users with DELETE permission (admin) on non-DM channels
        const moderationTabBtn = document.getElementById('moderation-tab-btn');
        const isDMChannel = currentChannel.type === 'dm';
        this.showModerationTab = canDelete && !isDMChannel && !isPreviewMode;
        moderationTabBtn?.classList.toggle('hidden', !this.showModerationTab);
        if (this.showModerationTab) {
            this._currentModerationStreamId = currentChannel.streamId;
            this.loadBannedMembers(currentChannel);
            this._wireAdminStateHandler();
        } else {
            this._currentModerationStreamId = null;
        }

        // Select appropriate starting tab (desktop) or show unified view (mobile)
        if (this.isMobileView()) {
            this.showMobileUnifiedView(currentChannel, isPreviewMode);
            document.body.classList.add('channel-details-open');
        } else {
            this.selectTab('info');
        }

        // Show modal
        modalManager.show('channel-settings-modal');

        // Initialize channel notifications toggle (only when not in preview mode)
        if (!isPreviewMode) {
            this.initChannelNotificationsToggle(currentChannel.streamId);
            this.initKeyResponderToggle(currentChannel.streamId)
                .catch(() => { /* stays hidden */ });
            this.initRotateEpochSection(currentChannel.streamId);
            this.initRekeyPublishSection(currentChannel.streamId);
            this.initAbsorbModSection(currentChannel.streamId);
            this._applyAdvancedSection();
        }

        // Load members and permissions if gated channel (not in preview mode)
        if (isGated && !isPreviewMode) {
            await this.loadMembers();
            if (canDelete) {
                this.loadPermissions();
            }
        }
    }

    /**
     * Populate storage info panel from Streamr SDK.
     * Single unified list (merges -1 + -3). Admin gets add/remove/edit controls.
     * @param {Object} channel - Channel object
     */
    async populateStorageInfo(channel) {
        const { channelManager } = this.deps;

        const list = this.elements.channelStorageNodesList;
        if (!list) return;

        // Loading state
        list.innerHTML = '<div class="text-sm text-white/40 px-1">Loading…</div>';
        this.elements.channelStorageRetentionReadonly && (this.elements.channelStorageRetentionReadonly.textContent = 'Loading…');
        this.elements.channelStorageNoStorage?.classList.add('hidden');

        // Determine admin status from already-fetched cached perm (set by show()).
        const isPreviewMode = this.deps.isInPreviewMode?.() || false;
        const isDM = channel.type === 'dm';
        const cached = channelManager.getCachedDeletePermission(channel.streamId);
        const canManage = !isPreviewMode && !isDM && cached.valid && cached.canDelete;

        // Toggle admin-only sections
        this.elements.channelStorageAddSection?.classList.toggle('hidden', !canManage);
        this.elements.channelStorageGasWarning?.classList.toggle('hidden', !canManage);
        this.elements.channelStorageRetentionEditor?.classList.toggle('hidden', !canManage);
        this.elements.channelStorageRetentionReadonly?.classList.toggle('hidden', canManage);
        // Reset add form
        this.elements.channelStorageAddForm?.classList.add('hidden');

        try {
            const info = await channelManager.getChannelStorageInfo(channel.streamId);
            this._renderStorageList(channel, info, canManage);
        } catch (err) {
            Logger.error('Failed to fetch storage info:', err);
            list.innerHTML = '<div class="text-sm text-red-400/80 px-1">Failed to load storage info</div>';
            this.elements.channelStorageRetentionReadonly && (this.elements.channelStorageRetentionReadonly.textContent = '-');
        }

        if (canManage) {
            this._wireStorageHandlers(channel);
        }
    }

    /**
     * Render the unified storage nodes list and retention.
     * @private
     */
    _renderStorageList(channel, info, canManage) {
        const list = this.elements.channelStorageNodesList;
        const POMBO_NODE = '0xae340e799e8151f6a4999d245e466197aa217667';
        const { enabled, nodes, storageDays, retention, retentionInSync, hasKeysStream } = info;
        const hasInteractions = info.hasInteractionsStream === true;
        // A lookup that failed says nothing about that stream. Calling a node
        // missing on that basis sends the admin to pay for a repair that may
        // not be needed.
        const allStreamsRead = info.allStreamsRead !== false;

        // Retention: one figure, the message stream's. The warning is a
        // sibling of both retention states, never inside one: the readonly
        // figure is hidden for whoever can manage the channel, and the
        // editor is hidden for everyone else.
        const daysText = (typeof storageDays === 'number') ? `${storageDays} days` : (enabled ? 'Not set' : '-');
        if (this.elements.channelStorageRetentionReadonly) {
            this.elements.channelStorageRetentionReadonly.textContent = daysText;
        }
        const mixed = this.elements.channelStorageRetentionMixed;
        if (mixed) {
            const divergent = retentionInSync === false;
            mixed.classList.toggle('hidden', !divergent);
            if (divergent) {
                const detail = [
                    `messages ${retention?.message ?? 'not set'}`,
                    `admin ${retention?.admin ?? 'not set'}`,
                    ...(hasKeysStream ? [`keys ${retention?.keys ?? 'not set'}`] : []),
                    ...(hasInteractions ? [`reactions ${retention?.interactions ?? 'not set'}`] : [])
                ].join(', ');
                const text = this.elements.channelStorageRetentionMixedText;
                if (text) {
                    text.textContent = canManage
                        ? 'Retention is not the same on all of this channel’s streams. Save it again to apply one value to all of them.'
                        : 'Retention is not the same on all of this channel’s streams.';
                }
                mixed.title = `Retention per stream: ${detail}.`;
            }
        }
        if (this.elements.channelStorageRetentionInput && typeof storageDays === 'number') {
            this.elements.channelStorageRetentionInput.value = String(storageDays);
        }

        // No-storage warning
        this.elements.channelStorageNoStorage?.classList.toggle('hidden', enabled);

        // Nodes
        if (!enabled || nodes.length === 0) {
            list.innerHTML = '<div class="text-sm text-white/40 px-1">No storage provider</div>';
            return;
        }

        list.innerHTML = nodes.map(n => {
            const addr = n.address;
            const isOfficial = addr.toLowerCase() === POMBO_NODE.toLowerCase();
            const label = isOfficial ? 'Pombo' : 'Custom';
            const divergent = allStreamsRead
                && !(n.onMessage && n.onAdmin
                    && (!hasKeysStream || n.onKeys)
                    && (!hasInteractions || n.onInteractions));
            const divergentBadge = divergent
                ? '<span class="text-[10px] text-amber-400/80 ml-1.5" title="This node is missing from some of the channel streams. Adding it again heals it, and only the streams that lack it are charged.">partial</span>'
                : '';
            const removeBtn = canManage
                ? `<button data-storage-remove="${escapeAttr(addr)}" class="storage-remove-btn shrink-0 text-white/40 hover:text-red-400/90 px-2 py-1 rounded transition" title="Remove">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"/></svg>
                   </button>`
                : '';
            return `
                <div class="flex items-center justify-between gap-3 px-3 py-2 bg-white/[0.03] border border-white/5 rounded-xl">
                    <div class="min-w-0 flex-1">
                        <div class="text-xs text-white/50">${escapeHtml(label)}${divergentBadge}</div>
                        <code class="text-xs text-white/70 font-mono truncate block">${escapeHtml(addr)}</code>
                    </div>
                    ${removeBtn}
                </div>
            `;
        }).join('');
    }

    /**
     * Attach event listeners for storage admin controls.
     * Idempotent — uses node cloning to reset listeners on each show().
     * @private
     */
    _wireStorageHandlers(channel) {
        const { channelManager, showNotification } = this.deps;

        // Reset and rebind: nodes list (delegated remove)
        const list = this.elements.channelStorageNodesList;
        if (list) {
            const newList = list.cloneNode(true);
            list.parentNode.replaceChild(newList, list);
            this.elements.channelStorageNodesList = newList;
            newList.addEventListener('click', async (e) => {
                const btn = e.target.closest('.storage-remove-btn');
                if (!btn) return;
                const addr = btn.dataset.storageRemove;
                if (!addr) return;
                if (!confirm(`Remove storage provider ${addr.slice(0, 6)}…${addr.slice(-4)} from this channel?\n\nThis is an on-chain transaction.`)) return;
                btn.disabled = true;
                btn.classList.add('opacity-50');
                showNotification?.('Removing storage provider…', 'info');
                try {
                    const result = await channelManager.removeChannelStorageNode(channel.streamId, addr);
                    this._reportStorageResult(result, 'remove');
                } catch (err) {
                    showNotification?.(`Failed to remove storage provider: ${err.message}`, 'error');
                } finally {
                    await this.populateStorageInfo(channel);
                }
            });
        }

        // Add toggle + form
        const toggle = this.elements.channelStorageAddToggleBtn;
        const form = this.elements.channelStorageAddForm;
        const cancel = this.elements.channelStorageAddCancel;
        const confirmBtn = this.elements.channelStorageAddConfirm;
        const customInput = this.elements.channelStorageCustomAddress;

        const radios = document.getElementsByName('channel-storage-provider-radio');
        const setProvider = () => {
            const val = Array.from(radios).find(r => r.checked)?.value || 'streamr';
            customInput?.classList.toggle('hidden', val !== 'custom');
        };
        radios.forEach(r => {
            const fresh = r.cloneNode(true);
            r.parentNode.replaceChild(fresh, r);
        });
        document.getElementsByName('channel-storage-provider-radio').forEach(r => {
            r.addEventListener('change', setProvider);
        });
        setProvider();

        if (toggle) {
            toggle.onclick = () => {
                form?.classList.toggle('hidden');
            };
        }
        if (cancel) {
            cancel.onclick = () => {
                form?.classList.add('hidden');
                if (customInput) customInput.value = '';
            };
        }
        if (confirmBtn) {
            confirmBtn.onclick = async () => {
                const provider = Array.from(document.getElementsByName('channel-storage-provider-radio'))
                    .find(r => r.checked)?.value || 'streamr';
                const customAddress = customInput?.value.trim() || '';
                if (provider === 'custom' && !/^0x[a-fA-F0-9]{40}$/.test(customAddress)) {
                    showNotification?.('Invalid custom storage provider address', 'error');
                    return;
                }

                // New nodes inherit the channel's retention period (stream-level TTL)
                confirmBtn.disabled = true;
                confirmBtn.textContent = 'Adding…';
                showNotification?.('Adding storage provider…', 'info');
                try {
                    const result = await channelManager.addChannelStorageNode(channel.streamId, {
                        storageProvider: provider,
                        customStorageAddress: customAddress
                    });
                    this._reportStorageResult(result, 'add');
                    form?.classList.add('hidden');
                    if (customInput) customInput.value = '';
                } catch (err) {
                    showNotification?.(`Failed to add storage provider: ${err.message}`, 'error');
                } finally {
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = 'Add';
                    await this.populateStorageInfo(channel);
                }
            };
        }

        // Retention save
        const retSave = this.elements.channelStorageRetentionSave;
        const retInput = this.elements.channelStorageRetentionInput;
        if (retSave && retInput) {
            retSave.onclick = async () => {
                const days = parseInt(retInput.value, 10);
                if (!Number.isFinite(days) || days < 1) {
                    showNotification?.('Retention must be a positive number of days', 'error');
                    return;
                }
                retSave.disabled = true;
                retSave.textContent = 'Saving…';
                showNotification?.('Updating retention…', 'info');
                try {
                    const result = await channelManager.setChannelStorageDays(channel.streamId, days);
                    const failed = Object.values(result.results || {}).filter(v => v === 'failed').length;
                    const ok = failed === 0 && result.verified !== false;
                    showNotification?.(
                        ok
                            ? (result.sent === 0
                                ? `Retention already ${days} days on every stream`
                                : `Retention updated to ${days} days`)
                            : 'Retention updated partially. Try again.',
                        ok ? 'success' : 'error'
                    );
                } catch (err) {
                    showNotification?.(`Failed to update retention: ${err.message}`, 'error');
                } finally {
                    retSave.disabled = false;
                    retSave.textContent = 'Save';
                    await this.populateStorageInfo(channel);
                }
            };
        }
    }

    /**
     * Surface a dual-stream result via toast.
     * @private
     */
    _reportStorageResult(result, op) {
        const { showNotification } = this.deps;
        const verb = op === 'add' ? 'added' : 'removed';
        const states = Object.values(result?.results || {});
        const failed = states.filter(v => v === 'failed').length;

        if (result?.sent === 0) {
            showNotification?.(`Storage provider already ${verb === 'added' ? 'on every stream' : 'off every stream'}`, 'success');
        } else if (failed === 0 && result?.verified !== false) {
            showNotification?.(`Storage provider ${verb}`, 'success');
        } else if (failed === states.length) {
            showNotification?.(`Failed to ${op} storage provider`, 'error');
        } else {
            // Either a write failed or the read-back still disagrees.
            showNotification?.(`Storage provider partially ${verb}. Try again to sync.`, 'error');
        }
    }

    /**
     * Render the list of banned members for the moderation tab.
     * Each row shows the address (and ENS/contact nickname if available) plus an Unban button.
     * @param {Object} channel - Channel object
     */
    async loadBannedMembers(channel) {
        const list = document.getElementById('banned-members-list');
        const counter = document.getElementById('banned-members-count');
        if (!list) return;

        const { channelManager, showNotification } = this.deps;
        const clientBanned = Array.isArray(channel?.adminState?.bannedMembers)
            ? channel.adminState.bannedMembers.map(e => String(e?.address ?? e).toLowerCase())
            : [];
        // The gate's own banned set — a different mechanism from the client
        // ban, so an address can carry either or both.
        const chainBanned = channel?.gate?.address
            ? (await channelManager.getGateBannedMembers(channel.streamId).catch(() => []))
                .map(a => String(a).toLowerCase())
            : [];

        const all = [...new Set([...clientBanned, ...chainBanned])].sort();
        if (counter) counter.textContent = String(all.length);

        if (all.length === 0) {
            list.innerHTML = '<div class="text-center text-white/30 py-6 text-sm">No banned members</div>';
            return;
        }

        list.innerHTML = all.map(lower => {
            // Same identity idiom as the members list: generated avatar unless
            // ENS has a picture, and the best name we have for the address.
            const avatarHtml = getAvatarHtml(
                lower, 32, 0.5, identityManager.getCachedENSAvatar?.(lower) || null);
            const { label, isAddress } = this._memberLabel(lower, channel);
            const onChain = chainBanned.includes(lower);
            const onClient = clientBanned.includes(lower);
            const tags = [
                onChain ? '<span class="text-[10px] bg-red-500/20 text-red-400 px-2 py-0.5 rounded-full">Protocol</span>' : '',
                onClient ? '<span class="text-[10px] bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded-full">Client</span>' : ''
            ].join(' ');
            return `
                <div class="flex items-center justify-between gap-3 px-3 py-2.5 bg-white/[0.03] border border-white/5 rounded-xl">
                    <div class="flex items-center gap-2 min-w-0 flex-1">
                        <div class="flex-shrink-0" style="width:32px;height:32px;border-radius:9999px;overflow:hidden;">
                            ${avatarHtml}
                        </div>
                        <div class="min-w-0">
                            <div class="${isAddress ? 'font-mono text-[13px] text-white/55 break-all' : 'text-sm text-white/80 truncate'}">${escapeHtml(sanitizeText(label))}</div>
                            <div class="flex items-center gap-1 mt-1">${tags}</div>
                        </div>
                    </div>
                    <button data-unban-address="${escapeAttr(lower)}" data-on-chain="${onChain}" class="banned-unban-btn shrink-0 bg-white/10 hover:bg-white/20 text-white/80 border border-white/10 px-3 py-1.5 rounded-lg text-xs transition">
                        Unban
                    </button>
                </div>
            `;
        }).join('');

        this._resolveMemberIdentities(all, () => {
            const current = this.deps.channelManager.channels?.get?.(this._currentModerationStreamId);
            if (current?.streamId === channel.streamId) this.loadBannedMembers(channel);
        });

        list.querySelectorAll('.banned-unban-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const addr = btn.dataset.unbanAddress;
                if (!addr) return;
                const onChain = btn.dataset.onChain === 'true';
                const question = onChain
                    ? 'Lift this ban? Restoring their access on the gate is one transaction.'
                    : 'Lift this ban? No transaction needed.';
                if (!confirm(question)) return;
                btn.disabled = true;
                btn.textContent = '...';
                try {
                    await channelManager.unbanMemberLevels(channel.streamId, addr);
                    showNotification?.('User unbanned', 'success');
                    await this.loadBannedMembers(channel);
                } catch (err) {
                    btn.disabled = false;
                    btn.textContent = 'Unban';
                    showNotification?.(err?.message || 'Failed to unban user', 'error');
                }
            });
        });
    }

    /**
     * Wire one-time listener that refreshes the moderation tab whenever
     * the admin state changes for the currently-shown channel.
     */
    _wireAdminStateHandler() {
        if (this._adminHandlerWired) return;
        const { channelManager } = this.deps;
        if (!channelManager?.onMessage) return;
        // Candidates for the gate read arrive with the -4 history, which the
        // channel open reconciles in the background — after this panel has
        // already rendered. Re-render when the pool grows, debounced so a
        // history burst costs one pass.
        import('../epochKeyManager.js').then(({ epochKeyManager }) => {
            epochKeyManager.onRequestersChanged = (messageStreamId) => {
                if (messageStreamId !== this._currentModerationStreamId) return;
                const modal = document.getElementById('channel-settings-modal');
                if (!modal || modal.classList.contains('hidden')) return;
                clearTimeout(this._requesterRefreshTimer);
                this._requesterRefreshTimer = setTimeout(() => {
                    const channel = channelManager.channels?.get?.(this._currentModerationStreamId);
                    if (channel) this.loadBannedMembers(channel);
                }, 1500);
            };
        }).catch(() => {});
        channelManager.onMessage((event, data) => {
            if (event !== 'admin_state_updated') return;
            if (!this._currentModerationStreamId) return;
            if (data?.streamId !== this._currentModerationStreamId) return;
            const channel = channelManager.channels?.get?.(this._currentModerationStreamId);
            if (!channel) return;
            // Only re-render if the modal is open and on the moderation panel (or mobile)
            const modal = document.getElementById('channel-settings-modal');
            if (!modal || modal.classList.contains('hidden')) return;
            this.loadBannedMembers(channel);
        });
        this._adminHandlerWired = true;
    }

    /**
     * Initialize channel settings tabs navigation
     */
    initTabs() {
        if (this.elements.channelSettingsTabs) {
            this.elements.channelSettingsTabs.forEach(tab => {
                // Remove old listeners by cloning
                const newTab = tab.cloneNode(true);
                tab.parentNode.replaceChild(newTab, tab);
                
                newTab.addEventListener('click', () => {
                    const tabName = newTab.dataset.channelTab;
                    this.selectTab(tabName);
                });
            });
            // Re-cache tabs after cloning
            this.elements.channelSettingsTabs = document.querySelectorAll('.channel-settings-tab');
        }
    }

    /**
     * Select a channel settings tab (desktop only)
     * @param {string} tabName - Tab to select
     */
    selectTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.channel-settings-tab').forEach(tab => {
            const isActive = tab.dataset.channelTab === tabName;
            tab.classList.toggle('bg-white/10', isActive);
            tab.classList.toggle('text-white', isActive);
            tab.classList.toggle('text-white/60', !isActive && tab.dataset.channelTab !== 'danger');
        });

        // Instant switch panels
        document.querySelectorAll('.channel-settings-panel').forEach(panel => {
            const panelName = panel.id.replace('channel-panel-', '');
            panel.classList.toggle('hidden', panelName !== tabName);
        });
    }

    /**
     * Check if we're in mobile view
     */
    isMobileView() {
        return window.innerWidth < 768;
    }



    /**
     * Show mobile unified view — info + storage inline, nav list for Members/Delete
     */
    showMobileUnifiedView(channel, isPreviewMode) {
        const unified = document.getElementById('channel-mobile-unified');
        if (!unified) return;

        // Hide all tab panels
        document.querySelectorAll('.channel-settings-panel').forEach(p => p.classList.add('hidden'));

        // Info stays inline; Storage is a page of its own, like Members and
        // Moderation — it carries its own on-chain actions and reads as a
        // section, not as a tail of the info panel.
        const infoPanel = document.getElementById('channel-panel-info');
        if (infoPanel) infoPanel.classList.remove('hidden');

        // Show unified nav
        unified.classList.remove('hidden');

        // Toggle nav item visibility based on permissions/type
        const membersNav = unified.querySelector('[data-mobile-nav="members"]');
        const dangerNav = unified.querySelector('[data-mobile-nav="danger"]');
        const moderationNav = unified.querySelector('[data-mobile-nav="moderation"]');

        membersNav?.classList.toggle('hidden', !this.showMembersTab);
        dangerNav?.classList.toggle('hidden', !this.showDangerTab);
        moderationNav?.classList.toggle('hidden', !this.showModerationTab);

        // Attach click handlers (clone to remove old listeners)
        unified.querySelectorAll('.channel-mobile-nav-item').forEach(btn => {
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            newBtn.addEventListener('click', () => {
                const panel = newBtn.dataset.mobileNav;
                if (panel) this.openMobileSubPanel(panel);
            });
        });

        // Initialize notification chip for mobile (visible to all users)
        this.initMobileNotifChip(channel.streamId);

        this._mobileSubPanelOpen = null;
    }

    /**
     * Initialize the mobile notification bell chip
     */
    initMobileNotifChip(streamId) {
        const chip = document.getElementById('mobile-notif-chip');
        const chipLabel = document.getElementById('mobile-notif-chip-label');
        if (!chip) return;

        const { channelManager } = this.deps;
        const channel = channelManager.channels.get(streamId);
        const isGated = !!channel?.gate?.address;
        const pushEnabled = relayManager.enabled;

        const isSubscribed = isGated
            ? relayManager.isNativeChannelSubscribed(streamId)
            : relayManager.isChannelSubscribed(streamId);

        // Update chip visual state
        this.updateNotifChipState(chip, chipLabel, isSubscribed, pushEnabled);

        // Show chip on mobile
        chip.classList.remove('hidden');
        chip.classList.add('inline-flex');

        // Attach click handler (clone to remove old)
        const newChip = chip.cloneNode(true);
        chip.parentNode.replaceChild(newChip, chip);
        newChip.addEventListener('click', async () => {
            if (!pushEnabled) {
                this.deps.showNotification('Enable Push Notifications in Settings first', 'warning');
                return;
            }
            const nowSubscribed = isGated
                ? relayManager.isNativeChannelSubscribed(streamId)
                : relayManager.isChannelSubscribed(streamId);
            const enable = !nowSubscribed;
            try {
                if (isGated) {
                    if (enable) await relayManager.subscribeToNativeChannel(streamId);
                    else await relayManager.unsubscribeFromNativeChannel(streamId);
                } else {
                    if (enable) await relayManager.subscribeToChannel(streamId);
                    else await relayManager.unsubscribeFromChannel(streamId);
                }
                const newLabel = document.getElementById('mobile-notif-chip-label');
                this.updateNotifChipState(newChip, newLabel, enable, pushEnabled);
                // Also sync the desktop toggle if it exists
                const desktopToggle = document.getElementById('channel-notifications-enabled');
                if (desktopToggle) desktopToggle.checked = enable;
            } catch (err) {
                this.deps.showNotification('Failed to update notifications', 'error');
            }
        });
    }

    /**
     * Update notification chip visual state
     */
    updateNotifChipState(chip, label, isSubscribed, pushEnabled) {
        if (!chip) return;
        const bell = chip.querySelector('svg');
        if (isSubscribed) {
            chip.className = 'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition border border-[#F6851B]/30 bg-[#F6851B]/10 text-white';
            if (bell) bell.classList.add('text-[#F6851B]');
            if (label) label.textContent = 'Notifications On';
        } else {
            chip.className = 'inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition border border-white/10 bg-white/5 text-white/40';
            if (bell) bell.classList.remove('text-[#F6851B]');
            if (label) label.textContent = 'Notifications Off';
        }
        if (!pushEnabled) {
            chip.classList.add('opacity-50');
        }
    }

    /**
     * Open a sub-panel on mobile with slide-in animation
     */
    openMobileSubPanel(panelName) {
        const panel = document.getElementById(`channel-panel-${panelName}`);
        const unified = document.getElementById('channel-mobile-unified');
        const infoPanel = document.getElementById('channel-panel-info');
        const storagePanel = document.getElementById('channel-panel-storage');
        const header = document.querySelector('#channel-settings-modal .flex.border-b h3');
        if (!panel) return;

        // Store which sub-panel is open
        this._mobileSubPanelOpen = panelName;

        // Update header title
        const titles = {
            'members': 'Members',
            'moderation': 'Moderation',
            'storage': 'Storage',
            'danger': 'Delete Channel'
        };
        if (header) header.textContent = titles[panelName] || 'Channel Details';

        // Hide unified view + info (storage is a sub-panel of its own now)
        if (unified) unified.classList.add('hidden');
        if (infoPanel) infoPanel.classList.add('hidden');
        if (storagePanel && panelName !== 'storage') storagePanel.classList.add('hidden');

        // Show the target panel with slide animation
        panel.classList.remove('hidden');
        panel.style.transform = 'translateX(100%)';
        panel.style.transition = 'transform 0.25s ease';
        // Force reflow
        panel.offsetHeight;
        panel.style.transform = 'translateX(0)';

        setTimeout(() => {
            panel.style.transition = '';
            panel.style.transform = '';
        }, 250);
    }

    /**
     * Close current mobile sub-panel and return to unified view
     */
    closeMobileSubPanel() {
        if (!this._mobileSubPanelOpen) return false;

        const panel = document.getElementById(`channel-panel-${this._mobileSubPanelOpen}`);
        const unified = document.getElementById('channel-mobile-unified');
        const infoPanel = document.getElementById('channel-panel-info');
        const storagePanel = document.getElementById('channel-panel-storage');
        const header = document.querySelector('#channel-settings-modal .flex.border-b h3');

        // Restore header
        if (header) header.textContent = 'Channel Details';

        // Slide out sub-panel
        if (panel) {
            panel.style.transition = 'transform 0.2s ease';
            panel.style.transform = 'translateX(100%)';
            setTimeout(() => {
                panel.classList.add('hidden');
                panel.style.transition = '';
                panel.style.transform = '';
            }, 200);
        }

        // Show unified view + info (storage has its own page now)
        if (unified) unified.classList.remove('hidden');
        if (infoPanel) infoPanel.classList.remove('hidden');
        if (storagePanel) storagePanel.classList.add('hidden');

        this._mobileSubPanelOpen = null;
        return true;
    }

    /**
     * Hide channel settings modal
     */
    hide() {
        this._mobileSubPanelOpen = null;
        document.body.classList.remove('channel-details-open');
        modalManager.hide('channel-settings-modal');
        this.elements.addMemberInput.value = '';
    }

    /**
     * Initialize channel notifications toggle
     */
    initChannelNotificationsToggle(streamId) {
        const toggle = document.getElementById('channel-notifications-enabled');
        const status = document.getElementById('channel-notifications-status');
        const requiresPush = document.getElementById('channel-notifications-requires-push');
        const container = document.getElementById('channel-notifications-container');
        const tooltip = document.getElementById('channel-notifications-tooltip');
        const label = document.getElementById('channel-notifications-label');
        
        if (!toggle) return;
        
        // Get channel type
        const { channelManager } = this.deps;
        const channel = channelManager.channels.get(streamId);
        const isGated = !!channel?.gate?.address;

        // Check if push notifications are enabled globally
        const pushEnabled = relayManager.enabled;

        // Check if this channel has notifications enabled (use appropriate method based on type)
        const isSubscribed = isGated
            ? relayManager.isNativeChannelSubscribed(streamId)
            : relayManager.isChannelSubscribed(streamId);
        
        // Set toggle state
        toggle.checked = isSubscribed;
        toggle.disabled = !pushEnabled;
        
        // Apply visual grey out to container when disabled
        if (container) {
            container.classList.toggle('opacity-50', !pushEnabled);
        }
        
        // Update label cursor
        if (label) {
            label.classList.toggle('cursor-not-allowed', !pushEnabled);
            label.classList.toggle('cursor-pointer', pushEnabled);
        }
        
        // Setup tooltip hover handlers (stored on element to avoid duplicates)
        if (tooltip && label) {
            // Remove old handlers if they exist
            if (label._tooltipEnter) label.removeEventListener('mouseenter', label._tooltipEnter);
            if (label._tooltipLeave) label.removeEventListener('mouseleave', label._tooltipLeave);
            if (label._tooltipClick) label.removeEventListener('click', label._tooltipClick);
            
            if (!pushEnabled) {
                // Store handlers on element for later removal
                label._tooltipEnter = () => tooltip.classList.remove('hidden');
                label._tooltipLeave = () => tooltip.classList.add('hidden');
                label._tooltipClick = (e) => {
                    e.preventDefault();
                    if (requiresPush) {
                        requiresPush.classList.add('animate-pulse');
                        setTimeout(() => requiresPush.classList.remove('animate-pulse'), 1000);
                    }
                };
                label.addEventListener('mouseenter', label._tooltipEnter);
                label.addEventListener('mouseleave', label._tooltipLeave);
                label.addEventListener('click', label._tooltipClick);
            } else {
                tooltip.classList.add('hidden');
            }
        }
        
        // Update status text
        if (status) {
            if (!pushEnabled) {
                status.textContent = '';
            } else if (isSubscribed) {
                status.textContent = 'Push notifications enabled for this channel';
                status.className = 'text-xs text-green-500';
            } else {
                status.textContent = 'Push notifications disabled';
                status.className = 'text-xs text-white/40';
            }
        }
        
        // Show/hide "enable push first" warning
        if (requiresPush) {
            requiresPush.classList.toggle('hidden', pushEnabled);
        }
        
        // Setup toggle change handler (stored on element to avoid duplicates)
        if (toggle._changeHandler) toggle.removeEventListener('change', toggle._changeHandler);
        toggle._changeHandler = async (e) => {
            await this.handleChannelNotificationsToggle(e, streamId);
        };
        toggle.addEventListener('change', toggle._changeHandler);
    }

    /**
     * Owner key-responder toggle (gated channels, owner/moderator only):
     * marks THIS device to keep answering the channel's key requests while a
     * Pombo tab is open. Local to the device — never synced.
     */
    async initKeyResponderToggle(streamId) {
        const container = document.getElementById('channel-key-responder-container');
        const toggle = document.getElementById('channel-key-responder-enabled');
        if (!container || !toggle) return;

        const { channelManager } = this.deps;
        const channel = channelManager.channels.get(streamId);
        const isGated = !!channel?.gate?.address;
        let canServe = false;
        if (isGated) {
            canServe = channelManager.isChannelOwner(streamId);
            if (!canServe) {
                try {
                    canServe = await channelManager.canAddMembers(streamId);
                } catch { /* chain unreachable — owner check already ran */ }
            }
        }
        container.classList.toggle('hidden', !canServe);
        if (!canServe) return;

        const { keyResponder } = await import('../keyResponder.js');
        toggle.checked = keyResponder.isMarked(streamId);
        if (toggle._changeHandler) toggle.removeEventListener('change', toggle._changeHandler);
        toggle._changeHandler = () => keyResponder.setMarked(streamId, toggle.checked);
        toggle.addEventListener('change', toggle._changeHandler);
    }

    /**
     * Gated channels, channel admin only: turn the moderators' pending deltas
     * into the owner's own snapshot. Until this runs their actions hold only
     * while they hold the role.
     */
    initAbsorbModSection(streamId) {
        const section = document.getElementById('absorb-mod-section');
        const button = document.getElementById('absorb-mod-btn');
        const counter = document.getElementById('absorb-mod-count');
        if (!section || !button) return;

        const { channelManager, showNotification } = this.deps;
        const channel = channelManager.channels.get(streamId);
        const deltas = channel ? (channelManager.modDeltas?.pending?.(channel) || []) : [];
        const show = !!channel?.gate?.address
            && channelManager.isChannelOwner(streamId)
            && deltas.length > 0;
        section.classList.toggle('hidden', !show);
        if (!show) return;
        if (counter) counter.textContent = String(deltas.length);

        if (button._clickHandler) button.removeEventListener('click', button._clickHandler);
        button._clickHandler = async () => {
            button.disabled = true;
            try {
                await channelManager.absorbModActions(streamId);
                showNotification?.('Moderator actions confirmed', 'success');
                this.initAbsorbModSection(streamId);
            } catch (error) {
                showNotification?.('Could not confirm: ' + error.message, 'error');
            } finally {
                button.disabled = false;
            }
        };
        button.addEventListener('click', button._clickHandler);
    }

    /**
     * Gated channels, channel admin only: manual epoch rotation. Free,
     * unlike the publish-key re-key below — the UI keeps them apart.
     */
    initRotateEpochSection(streamId) {
        const section = document.getElementById('rotate-epoch-section');
        const button = document.getElementById('rotate-epoch-btn');
        if (!section || !button) return;

        const { channelManager, showNotification } = this.deps;
        const channel = channelManager.channels.get(streamId);
        const show = !!channel?.gate?.address
            && channelManager.isChannelOwner(streamId);
        section.classList.toggle('hidden', !show);
        if (!show) return;
        this._applyNextRotation(streamId);

        if (button._clickHandler) button.removeEventListener('click', button._clickHandler);
        button._clickHandler = async () => {
            const status = document.getElementById('rotate-epoch-status');
            button.disabled = true;
            if (status) {
                status.textContent = 'Rotating…';
                status.classList.remove('hidden');
            }
            try {
                const { epochKeyManager } = await import('../epochKeyManager.js');
                await epochKeyManager.rotateEpoch(channel);
                this._applyNextRotation(streamId);
                if (status) status.textContent = 'New key issued. Members pick it up automatically.';
                showNotification?.('Channel key rotated', 'success');
            } catch (error) {
                if (status) status.textContent = '';
                showNotification?.('Rotation failed: ' + error.message, 'error');
            } finally {
                button.disabled = false;
            }
        };
        button.addEventListener('click', button._clickHandler);
    }

    /**
     * The channel rotates on its own weekly; the button is for not waiting.
     * Saying when the next one falls is what makes that legible — and a due
     * date in the past is the truth, since the timer only runs while the
     * admin's client is open.
     */
    _applyNextRotation(streamId) {
        const line = document.getElementById('rotate-epoch-next');
        if (!line) return;
        const due = epochKeyManager.nextRotationAt(streamId);
        if (!due) {
            line.textContent = '';
            return;
        }
        const msLeft = due - Date.now();
        line.textContent = msLeft > 0
            ? `Next auto-rotate: ${formatRemaining(msLeft)}`
            : 'Next auto-rotate: due';
    }

    /**
     * Advanced holds the surfaces nobody needs on a routine visit. It exists
     * only when something inside it does.
     */
    _applyAdvancedSection() {
        const wrapper = document.getElementById('mod-advanced-section');
        if (!wrapper) return;
        const anyVisible = ['permissions-section', 'rekey-publish-section']
            .map(id => document.getElementById(id))
            .some(el => el && !el.classList.contains('hidden'));
        wrapper.classList.toggle('hidden', !anyVisible);
        if (!anyVisible) wrapper.open = false;
    }

    /**
     * Sealed channels, channel admin only: the escape valve that
     * replaces the shared publish key when ex-key-holders abuse it.
     */
    initRekeyPublishSection(streamId) {
        const section = document.getElementById('rekey-publish-section');
        const button = document.getElementById('rekey-publish-btn');
        if (!section || !button) return;

        const { channelManager, showNotification } = this.deps;
        const channel = channelManager.channels.get(streamId);
        const show = channel?.wireIdentity === 'sealed'
            && channelManager.isChannelOwner(streamId);
        section.classList.toggle('hidden', !show);
        if (!show) return;

        if (button._clickHandler) button.removeEventListener('click', button._clickHandler);
        button._clickHandler = async () => {
            const status = document.getElementById('rekey-publish-status');
            button.disabled = true;
            if (status) {
                status.textContent = 'Re-keying — two on-chain transactions…';
                status.classList.remove('hidden');
            }
            try {
                const { epochKeyManager } = await import('../epochKeyManager.js');
                const rev = await epochKeyManager.rekeyPublishKey(channel);
                if (status) status.textContent = `Publish key reset (rev ${rev}). Members pick it up automatically.`;
                showNotification?.('Publish key reset', 'success');
            } catch (error) {
                if (status) status.textContent = '';
                showNotification?.('Re-key failed: ' + error.message, 'error');
            } finally {
                button.disabled = false;
            }
        };
        button.addEventListener('click', button._clickHandler);
    }

    /**
     * Handle channel notifications toggle change
     */
    async handleChannelNotificationsToggle(e, streamId) {
        const enable = e.target.checked;
        const status = document.getElementById('channel-notifications-status');
        const { showNotification, channelManager } = this.deps;
        
        // Get channel type
        const channel = channelManager.channels.get(streamId);
        const isGated = !!channel?.gate?.address;

        if (enable) {
            try {
                // Use appropriate method based on channel type
                const success = isGated
                    ? await relayManager.subscribeToNativeChannel(streamId)
                    : await relayManager.subscribeToChannel(streamId);
                    
                if (success) {
                    showNotification('Push notifications enabled!', 'success');
                    if (status) {
                        status.textContent = 'Push notifications enabled for this channel';
                        status.className = 'text-xs text-green-500';
                    }
                } else {
                    e.target.checked = false;
                    showNotification('Failed to enable push notifications', 'error');
                }
            } catch (error) {
                e.target.checked = false;
                showNotification('Error: ' + error.message, 'error');
            }
        } else {
            // Use appropriate method based on channel type
            if (isGated) {
                relayManager.unsubscribeFromNativeChannel(streamId);
            } else {
                relayManager.unsubscribeFromChannel(streamId);
            }
            showNotification('Push notifications disabled', 'info');
            if (status) {
                status.textContent = 'Push notifications disabled';
                status.className = 'text-xs text-white/40';
            }
        }
    }

    /**
     * Show delete channel confirmation modal
     */
    showDeleteModal() {
        const currentChannel = this.deps.channelManager.getCurrentChannel();
        if (!currentChannel) return;

        this.elements.deleteChannelName.textContent = currentChannel.name;
        modalManager.show('delete-channel-modal');
    }

    /**
     * Hide delete channel confirmation modal
     */
    hideDeleteModal() {
        modalManager.hide('delete-channel-modal');
    }

    /**
     * Handle delete channel confirmation
     */
    async handleDelete() {
        const { channelManager, subscriptionManager, showNotification, showLoading, hideLoading, renderChannelList, selectChannel, showConnectedNoChannelState } = this.deps;
        
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        const channelName = currentChannel.name;
        const streamId = currentChannel.streamId;

        try {
            showLoading('Deleting channel...');
            this.hideDeleteModal();
            this.hide();

            // Remove from subscription manager tracking first
            await subscriptionManager.removeChannel(streamId);

            const failed = await channelManager.deleteChannel(streamId) || [];
            if (failed.length) {
                // The channel stays in the list precisely so this is
                // retryable, and the retry only pays for what is left.
                showNotification(
                    `${failed.length} stream(s) could not be deleted. `
                    + 'The channel is still here — delete it again to retry.',
                    'error'
                );
                renderChannelList();
                await selectChannel(streamId);
                return;
            }

            showNotification(`Channel "${channelName}" deleted successfully`, 'success');

            // Update UI - select first remaining channel or show empty state
            const channels = channelManager.getAllChannels();
            if (channels.length > 0) {
                renderChannelList();
                await selectChannel(channels[0].streamId);
            } else {
                renderChannelList();
                showConnectedNoChannelState();
            }
        } catch (error) {
            showNotification('Failed to delete channel: ' + error.message, 'error');
        } finally {
            hideLoading();
        }
    }

    /**
     * Show leave channel confirmation modal
     */
    showLeaveModal() {
        const currentChannel = this.deps.channelManager.getCurrentChannel();
        if (!currentChannel) return;
        
        // Close any existing modal
        this.hideLeaveModal();
        
        const isDM = currentChannel.type === 'dm';
        const channelLabel = escapeHtml(currentChannel.name || currentChannel.peerAddress || 'this channel');
        
        const hint = isDM
            ? '<p class="text-xs text-white/30 mt-1">New messages will reopen the conversation.</p>'
            : '<p class="text-xs text-white/30 mt-1">You can rejoin later with the invite link.</p>';
        
        const blockButton = isDM ? `
            <button id="block-leave-btn" class="flex-1 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 text-sm font-medium px-3 py-2.5 rounded-xl transition">
                Block
            </button>
        ` : '';
        
        const modal = document.createElement('div');
        modal.id = 'leave-channel-modal';
        modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[60]';
        modal.innerHTML = `
            <div class="bg-[#111113] rounded-2xl p-5 w-[340px] max-w-full mx-4 border border-white/[0.06]">
                <h3 class="text-base font-medium mb-4 text-white">${isDM ? 'Leave Conversation' : 'Leave Channel'}</h3>
                <div class="space-y-3">
                    <p class="text-sm text-white/50">
                        Are you sure you want to leave <span class="text-white/80 font-medium">"${channelLabel}"</span>?
                    </p>
                    ${hint}
                </div>
                <div class="flex gap-2 mt-5">
                    <button id="cancel-leave-btn" class="flex-1 bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-white/50 text-sm font-medium px-3 py-2.5 rounded-xl transition">
                        Cancel
                    </button>
                    <button id="confirm-leave-btn" class="flex-1 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 text-sm font-medium px-3 py-2.5 rounded-xl transition">
                        Leave
                    </button>
                    ${blockButton}
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Attach listeners
        modal.querySelector('#cancel-leave-btn').addEventListener('click', () => this.hideLeaveModal());
        modal.querySelector('#confirm-leave-btn').addEventListener('click', () => this.confirmLeave(false));
        const blockBtn = modal.querySelector('#block-leave-btn');
        if (blockBtn) {
            blockBtn.addEventListener('click', () => this.confirmLeave(true));
        }
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.hideLeaveModal();
        });
    }
    
    /**
     * Hide leave channel modal
     */
    hideLeaveModal() {
        const modal = document.getElementById('leave-channel-modal');
        if (modal) modal.remove();
    }
    
    /**
     * Confirm and execute leave channel
     */
    async confirmLeave(block = false) {
        const { channelManager, subscriptionManager, showNotification, renderChannelList, selectChannel, showConnectedNoChannelState } = this.deps;
        
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;
        
        const channelName = currentChannel.name;
        const streamId = currentChannel.streamId;
        
        this.hideLeaveModal();
        this.hide();
        
        try {
            // Remove from subscription manager tracking first
            await subscriptionManager.removeChannel(streamId);
            
            await channelManager.leaveChannel(streamId, { block });
            
            if (block) {
                showNotification(`Blocked and left "${channelName}"`, 'info');
            } else {
                showNotification(`Left "${channelName}"`, 'info');
            }
            
            // Update UI - select first remaining channel or show empty state
            const channels = channelManager.getAllChannels();
            if (channels.length > 0) {
                renderChannelList();
                await selectChannel(channels[0].streamId);
            } else {
                renderChannelList();
                showConnectedNoChannelState();
            }
        } catch (error) {
            showNotification('Failed to leave channel: ' + error.message, 'error');
        }
    }

    /**
     * Load channel members
     */
    async loadMembers() {
        const currentChannel = this.deps.channelManager.getCurrentChannel();
        if (!currentChannel?.gate?.address) {
            return;
        }

        this.elements.membersList.innerHTML = '<div class="text-center text-white/30 py-4 text-sm">Loading...</div>';

        try {
            const members = await this.deps.channelManager.getChannelMembers(currentChannel.streamId);
            this.renderMembersList(members, currentChannel);
        } catch (error) {
            this.elements.membersList.innerHTML = `<div class="text-center text-red-400/80 py-4 text-sm">Failed to load: ${escapeHtml(sanitizeText(error.message))}</div>`;
        }
    }

    /**
     * How a person is named in the members and banned lists, in the app's own
     * order: ENS name, then the local contact nickname, then the display name
     * they publish with their messages, then the address in full. The address
     * is not shortened here — in a list of members it is the identity, not a
     * decoration, and a truncated one cannot be checked against anything.
     * @param {string} address
     * @param {Object} channel - Open channel, for names seen on its messages
     */
    _memberLabel(address, channel) {
        const lower = address.toLowerCase();
        const ens = identityManager.getCachedENS?.(lower);
        if (ens) return { label: ens, isAddress: false };
        const nickname = identityManager.getTrustedContact?.(lower)?.nickname;
        if (nickname) return { label: nickname, isAddress: false };
        // Same chain the bubbles use: the roster name and the one declared on
        // a message are the same kind of claim, so the most recent wins. The
        // roster is what names a member who has never posted here.
        const declared = this._declaredNames(channel).get(lower);
        const roster = channel?.gate?.address
            ? epochKeyManager.getRosterName?.(channel.messageStreamId, lower)
            : null;
        if (roster && declared) {
            return {
                label: roster.ts >= declared.ts ? roster.name : declared.name,
                isAddress: false
            };
        }
        if (roster) return { label: roster.name, isAddress: false };
        if (declared) return { label: declared.name, isAddress: false };
        return { label: address, isAddress: true };
    }

    /**
     * Display names seen on this channel's loaded messages, with when they
     * were claimed — the roster name is compared against them by recency.
     * @returns {Map<string, {name: string, ts: number}>}
     */
    _declaredNames(channel) {
        const names = new Map();
        for (const msg of channel?.messages || []) {
            const sender = (msg?.sender || '').toLowerCase();
            const name = (msg?.senderName || '').trim();
            if (!sender || !name) continue;
            const ts = Number(msg?.timestamp) || 0;
            const held = names.get(sender);
            if (!held || ts >= held.ts) names.set(sender, { name, ts });
        }
        return names;
    }

    /**
     * Resolve ENS names and avatars for rows that have neither cached, then
     * re-render once through `onResolved`. Each address is attempted once per
     * panel session so a miss does not re-query on every render.
     */
    _resolveMemberIdentities(addresses, onResolved = null) {
        this._memberIdentityTried ??= new Set();
        const pending = addresses
            .map(a => a.toLowerCase())
            .filter(a => !this._memberIdentityTried.has(a)
                && !identityManager.getCachedENS?.(a)
                && !identityManager.getCachedENSAvatar?.(a));
        if (!pending.length) return;
        pending.forEach(a => this._memberIdentityTried.add(a));

        Promise.all(pending.map(a => Promise.all([
            identityManager.resolveENS?.(a).catch(() => null),
            identityManager.resolveENSAvatar?.(a).catch(() => null)
        ]))).then(results => {
            if (!results.some(([name, avatar]) => name || avatar)) return;
            if (onResolved) return onResolved();
            const channel = this.deps.channelManager.getCurrentChannel();
            // The panel may have moved on to another channel while resolving.
            if (!this._lastMembers || channel?.streamId !== this._lastMembersChannel?.streamId) return;
            this.renderMembersList(this._lastMembers, this._lastMembersChannel);
        }).catch(() => {});
    }

    /**
     * Render members list with permissions
     */
    renderMembersList(members, channel) {
        const { authManager, channelManager, showLoading, hideLoading, showNotification } = this.deps;

        this._lastMembers = members;
        this._lastMembersChannel = channel;

        if (!members || members.length === 0) {
            this.elements.membersList.innerHTML = '<div class="text-center text-white/30 py-4 text-sm">No members found</div>';
            return;
        }

        const currentAddress = authManager.getAddress()?.toLowerCase();
        const creatorAddress = channel.createdBy?.toLowerCase();
        const isOwner = channelManager.isChannelOwner(channel.streamId);
        
        // Find if current user has admin (canGrant) permission
        const currentUserMember = members.find(m => (typeof m === 'string' ? m : m.address)?.toLowerCase() === currentAddress);
        const currentUserCanGrant = typeof currentUserMember === 'object' ? currentUserMember.canGrant : false;

        this.elements.membersList.innerHTML = members.map(member => {
            // Handle both old format (string) and new format (object)
            const address = typeof member === 'string' ? member : member.address;
            const canGrant = typeof member === 'object' ? member.canGrant : false;
            const memberIsOwner = typeof member === 'object' ? member.isOwner : false;
            
            const normalizedAddr = address.toLowerCase();
            const isCreator = normalizedAddr === creatorAddress;
            const isMe = normalizedAddr === currentAddress;

            let badgeHtml = '';
            if (isCreator || memberIsOwner) {
                badgeHtml += '<span class="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded-full">Owner</span>';
            } else if (canGrant) {
                badgeHtml += '<span class="text-xs bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded-full">Moderator</span>';
            }
            // Paid gates: each subscriber's own clock (N-F). Rows here passed
            // the access filter, so the date is normally in the future.
            const paidUntil = typeof member === 'object' ? (member.paidUntil || 0) : 0;
            if (paidUntil > 0 && !memberIsOwner) {
                const expired = paidUntil * 1000 <= Date.now();
                badgeHtml += `<span class="text-xs ${expired ? 'text-red-400/80' : 'text-white/40'}">${expired ? 'expired' : 'until'} ${new Date(paidUntil * 1000).toLocaleDateString()}</span>`;
            }
            if (isMe) {
                badgeHtml += '<span class="text-xs text-white/60 ml-1">(you)</span>';
            }

            // Owner can manage anyone except self
            // Admin (canGrant) can manage regular members only (not owner/creator, not other admins)
            const memberIsAdmin = !memberIsOwner && !isCreator && canGrant;
            const canManage = !isMe && (isOwner || (currentUserCanGrant && !memberIsOwner && !isCreator && !memberIsAdmin));
            const menuBtn = canManage 
                ? `<button class="member-menu-btn text-white/30 hover:text-white/60 p-1.5 rounded-lg hover:bg-white/5 transition" 
                          data-address="${escapeAttr(address)}" data-can-grant="${canGrant}" data-current-is-owner="${isOwner}" title="Manage member">
                    <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z"/>
                    </svg>
                   </button>`
                : '';

            // Same identity idiom as the online-users list: the generated
            // avatar unless ENS has one, and a name in place of the address
            // when there is one to show.
            const avatarHtml = getAvatarHtml(
                address, 32, 0.5, identityManager.getCachedENSAvatar?.(normalizedAddr) || null);
            const { label, isAddress } = this._memberLabel(address, channel);
            const nameHtml = isAddress
                ? `<span class="font-mono text-[13px] text-white/55 break-all">${escapeHtml(label)}</span>`
                : `<span class="text-xs text-white/85 truncate">${escapeHtml(sanitizeText(label))}</span>`;

            return `
                <div class="flex items-center justify-between p-2.5 bg-white/5 rounded-xl border border-white/5 hover:border-white/10 transition group">
                    <div class="flex items-center gap-2 min-w-0 flex-1">
                        <div class="flex-shrink-0" style="width:32px;height:32px;border-radius:9999px;overflow:hidden;">
                            ${avatarHtml}
                        </div>
                        <div class="flex flex-col min-w-0">
                            ${nameHtml}
                            <div class="flex items-center gap-1 mt-0.5">${badgeHtml}</div>
                        </div>
                    </div>
                    ${menuBtn}
                </div>
            `;
        }).join('');

        // Add event listeners for member menu buttons
        this.elements.membersList.querySelectorAll('.member-menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const currentUserIsOwner = btn.dataset.currentIsOwner === 'true';
                this.showMemberDropdown(btn, btn.dataset.address, btn.dataset.canGrant === 'true', currentUserIsOwner);
            });
        });

        this._resolveMemberIdentities(
            members.map(m => (typeof m === 'string' ? m : m.address)).filter(Boolean));
    }

    /**
     * Show member dropdown menu
     */
    showMemberDropdown(targetBtn, address, canGrant, currentUserIsOwner = false) {
        // Close any existing dropdown
        this.closeMemberDropdown();

        const shortAddr = `${address.slice(0, 8)}...${address.slice(-6)}`;
        
        // Only owner can toggle admin permissions
        const toggleGrantBtn = currentUserIsOwner ? `
            <button class="member-action w-full text-left px-4 py-2.5 hover:bg-white/5 text-sm transition flex items-center justify-between gap-3" data-action="toggle-grant">
                <span class="flex items-center gap-2 min-w-0 ${canGrant ? 'text-purple-400' : 'text-white/70'}">
                    <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>
                    <span class="truncate">Moderator</span>
                </span>
                <span class="text-xs flex-shrink-0 ${canGrant ? 'text-purple-400' : 'text-white/30'}">${canGrant ? 'ON' : 'OFF'}</span>
            </button>
            <div class="my-1 border-t border-white/5"></div>
        ` : '';

        // Remove takes them off the allowlist without the ban mark, so adding
        // them back later is a plain allow(). Only Closed gates have one:
        // elsewhere membership is the asset or the subscription, and Ban is
        // the only cut.
        const removeBtn = this._gateModeIsNone ? `
            <button class="member-action w-full text-left px-4 py-2.5 hover:bg-white/5 text-sm text-white/50 transition flex items-center gap-2" data-action="remove">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M22 10.5h-6m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM4 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 0110.374 21c-2.331 0-4.512-.645-6.374-1.766z"/></svg>
                <span>Remove from channel</span>
            </button>
        ` : '';

        const dropdown = document.createElement('div');
        dropdown.id = 'member-dropdown-menu';
        dropdown.className = 'fixed bg-[#111113] border border-white/10 rounded-xl shadow-2xl py-1 z-[9999] min-w-[200px] overflow-hidden';
        dropdown.innerHTML = `
            <div class="px-3 py-2 border-b border-white/5">
                <div class="text-xs text-white/40">Member</div>
                <div class="text-sm text-white/80 font-mono">${escapeHtml(shortAddr)}</div>
            </div>
            ${toggleGrantBtn}
            ${removeBtn}
            <button class="member-action w-full text-left px-4 py-2.5 hover:bg-red-500/10 text-sm text-red-400 transition flex items-center gap-2" data-action="ban">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg>
                <span>Ban</span>
            </button>
        `;

        document.body.appendChild(dropdown);

        // Position dropdown near the button
        const btnRect = targetBtn.getBoundingClientRect();
        let left = btnRect.right - dropdown.offsetWidth;
        let top = btnRect.bottom + 4;

        // Keep within viewport
        if (left < 8) left = 8;
        if (top + dropdown.offsetHeight > window.innerHeight - 8) {
            top = btnRect.top - dropdown.offsetHeight - 4;
        }

        dropdown.style.left = `${left}px`;
        dropdown.style.top = `${top}px`;

        // Attach action listeners
        dropdown.querySelectorAll('.member-action').forEach(actionBtn => {
            actionBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const action = actionBtn.dataset.action;
                this.closeMemberDropdown();
                await this.handleMemberAction(action, address, canGrant);
            });
        });

        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', this.closeMemberDropdown.bind(this), { once: true });
        }, 0);
    }

    /**
     * Close member dropdown
     */
    closeMemberDropdown() {
        const existing = document.getElementById('member-dropdown-menu');
        if (existing) existing.remove();
    }

    /**
     * Handle member action from dropdown
     */
    async handleMemberAction(action, address, currentCanGrant) {
        const { channelManager, showLoading, hideLoading, showNotification } = this.deps;
        
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        switch (action) {
            case 'toggle-grant':
                const newCanGrant = !currentCanGrant;
                try {
                    showLoading(newCanGrant ? 'Appointing moderator...' : 'Dismissing moderator...');
                    await channelManager.updateMemberPermissions(currentChannel.streamId, address, { canGrant: newCanGrant });
                    showNotification(
                        newCanGrant ? 'Member is now a moderator' : 'Moderator dismissed',
                        'success'
                    );
                    // Refresh members list
                    await this.loadMembers();
                } catch (error) {
                    showNotification('Failed to update permission: ' + error.message, 'error');
                } finally {
                    hideLoading();
                }
                break;

            case 'remove':
                this.showRemoveMemberModal(address);
                break;

            case 'ban': {
                const { channelModalsUI } = await import('./ChannelModalsUI.js');
                channelModalsUI.showBanMemberModal(address, currentChannel);
                break;
            }
        }
    }

    /**
     * Handle add member
     */
    async handleAddMember() {
        const { channelManager, showLoading, hideLoading, showNotification } = this.deps;
        
        const address = this.elements.addMemberInput.value.trim();
        if (!address) {
            showNotification('Please enter an address', 'error');
            return;
        }

        if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
            showNotification('Invalid Ethereum address', 'error');
            return;
        }

        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        try {
            showLoading('Adding member (on-chain transaction)...');
            await channelManager.addMember(currentChannel.streamId, address);
            this.elements.addMemberInput.value = '';
            showNotification('Member added successfully!', 'success');
            await this.loadMembers();
        } catch (error) {
            showNotification('Failed to add member: ' + error.message, 'error');
        } finally {
            hideLoading();
        }
    }

    /**
     * Handle batch add members
     */
    async handleBatchAddMembers() {
        const { channelManager, showLoading, hideLoading, showNotification } = this.deps;
        
        const input = this.elements.batchMembersInput?.value || '';
        const lines = input.split('\n').map(l => l.trim()).filter(l => l);
        
        if (lines.length === 0) {
            showNotification('Please enter at least one address', 'error');
            return;
        }

        // Validate all addresses
        const validAddresses = [];
        const invalidAddresses = [];
        
        for (const line of lines) {
            if (line.match(/^0x[a-fA-F0-9]{40}$/)) {
                validAddresses.push(line);
            } else {
                invalidAddresses.push(line);
            }
        }

        if (invalidAddresses.length > 0) {
            showNotification(`${invalidAddresses.length} invalid address(es) found`, 'error');
            return;
        }

        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        try {
            // allowBatch admits the whole list in ONE transaction — the same
            // call channel creation uses for its initial members.
            showLoading(`Adding ${validAddresses.length} members (one transaction)...`);
            await channelManager.addMembers(currentChannel.streamId, validAddresses);

            this.elements.batchMembersInput.value = '';
            showNotification(`${validAddresses.length} members added successfully!`, 'success');
            await this.loadMembers();
        } catch (error) {
            showNotification('Failed to add members: ' + error.message, 'error');
        } finally {
            hideLoading();
        }
    }

    /**
     * Show remove member confirmation modal
     */
    showRemoveMemberModal(address) {
        const shortAddr = `${address.slice(0, 8)}...${address.slice(-6)}`;
        
        // Close any existing modal
        this.hideRemoveMemberModal();
        
        const modal = document.createElement('div');
        modal.id = 'remove-member-modal';
        modal.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[70]';
        modal.innerHTML = `
            <div class="bg-[#111113] rounded-2xl w-[380px] max-w-[95vw] mx-4 shadow-2xl border border-white/[0.06] overflow-hidden">
                <div class="p-6">
                    <div class="flex items-center gap-3 mb-4">
                        <div class="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center text-lg">👤</div>
                        <h3 class="text-lg font-medium text-white/90">Remove Member</h3>
                    </div>
                    <p class="text-sm text-white/50 mb-2">
                        Remove <span class="text-white/80 font-mono">${escapeHtml(shortAddr)}</span> from this channel?
                    </p>
                    <p class="text-xs text-white/30 bg-white/5 rounded-lg px-3 py-2">
                        They come off the allowlist and stop receiving channel keys. No ban mark, so you can add them back later. One transaction.
                    </p>
                </div>
                <div class="flex border-t border-white/5">
                    <button id="cancel-remove-member-btn" class="flex-1 px-4 py-3 text-sm text-white/60 hover:text-white hover:bg-white/5 transition">
                        Cancel
                    </button>
                    <button id="confirm-remove-member-btn" class="flex-1 px-4 py-3 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 border-l border-white/5 transition" data-address="${escapeAttr(address)}">
                        Remove
                    </button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Attach listeners
        modal.querySelector('#cancel-remove-member-btn').addEventListener('click', () => this.hideRemoveMemberModal());
        modal.querySelector('#confirm-remove-member-btn').addEventListener('click', (e) => {
            const addr = e.currentTarget.dataset.address;
            this.hideRemoveMemberModal();
            this.executeRemoveMember(addr);
        });
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.hideRemoveMemberModal();
        });
    }

    /**
     * Hide remove member modal
     */
    hideRemoveMemberModal() {
        const modal = document.getElementById('remove-member-modal');
        if (modal) modal.remove();
    }

    /**
     * Execute remove member
     */
    async executeRemoveMember(address) {
        const { channelManager, showLoading, hideLoading, showNotification } = this.deps;
        
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) return;

        try {
            showLoading('Removing member (on-chain transaction)...');
            await channelManager.removeMember(currentChannel.streamId, address);
            showNotification('Member removed successfully!', 'success');
            await this.loadMembers();
        } catch (error) {
            showNotification('Failed to remove member: ' + error.message, 'error');
        } finally {
            hideLoading();
        }
    }

    /**
     * Load and display stream permissions
     */
    async loadPermissions() {
        const { channelManager } = this.deps;
        
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel?.gate?.address) {
            return;
        }

        if (!this.elements.permissionsList) return;

        // The technical view: who actually holds a grant on the streams. On a
        // gated channel that is the clone and the storage node, never the
        // members — their access is proven per-message against the contract,
        // and the Members panel is where the contract's own roles are shown.
        this.elements.permissionsList.innerHTML = '<div class="text-white/30">Loading...</div>';

        try {
            // Use The Graph API for permissions (same source as members list)
            const { graphAPI } = await import('../graph.js');
            let permissions = [];
            
            try {
                permissions = await graphAPI.getStreamPermissions(currentChannel.streamId);
            } catch (e) {
                Logger.debug('Could not fetch permissions from The Graph:', e.message);
            }
            
            // If no permissions from API, show local members
            if (permissions.length === 0) {
                const localMembers = currentChannel.members || [];
                const owner = currentChannel.createdBy;
                
                let html = '';
                
                // Show owner
                if (owner) {
                    const shortOwner = `${owner.slice(0, 8)}...${owner.slice(-4)}`;
                    html += `<div class="flex justify-between items-center py-1.5 px-2.5 bg-white/5 rounded-lg">
                        <span class="font-mono text-white/60">${escapeHtml(shortOwner)}</span>
                        <span class="text-xs text-yellow-400/80">Owner</span>
                    </div>`;
                }
                
                // Show local members
                for (const member of localMembers) {
                    const shortMember = `${member.slice(0, 8)}...${member.slice(-4)}`;
                    html += `<div class="flex justify-between items-center py-1.5 px-2.5 bg-white/5 rounded-lg">
                        <span class="font-mono text-white/60">${escapeHtml(shortMember)}</span>
                        <span class="text-white/40 flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg></span>
                    </div>`;
                }
                
                if (!html) {
                    html = '<div class="text-white/30">Owner only (private)</div>';
                }
                
                const note = `<div class="text-white/20 mt-2 pt-2 border-t border-white/5 text-[10px] flex items-center gap-1">
                    <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"/></svg>
                    Showing local cache. Check Stream Explorer for on-chain permissions.
                </div>`;
                
                this.elements.permissionsList.innerHTML = html + note;
                return;
            }

            const ownerAddress = currentChannel.createdBy?.toLowerCase();

            // Format permissions for display (The Graph format)
            const now = Math.floor(Date.now() / 1000);
            
            const formatted = permissions
                // The Graph keeps zeroed entries after a revoke (SDK has the
                // same workaround) — an address with no effective permission
                // is an ex-member, not a row.
                .filter(perm => {
                    const stillSubscribes = perm.subscribeExpiration === null || parseInt(perm.subscribeExpiration) > now;
                    const stillPublishes = perm.publishExpiration === null || parseInt(perm.publishExpiration) > now;
                    return stillSubscribes || stillPublishes || perm.canEdit || perm.canDelete || perm.canGrant;
                })
                .map(perm => {
                let who;
                let isOwner = false;
                
                const userAddr = perm.userAddress;
                
                if (!userAddr || userAddr === '0x0000000000000000000000000000000000000000') {
                    who = '<span class="text-yellow-400/80 inline-flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3"/></svg>PUBLIC</span>';
                } else {
                    const short = `${userAddr.slice(0, 8)}...${userAddr.slice(-4)}`;
                    isOwner = ownerAddress && userAddr.toLowerCase() === ownerAddress;
                    // Owner marker: the same crown the Android grantee table
                    // draws. This used to be a phone glyph, which said nothing.
                    const crown = '<span class="text-white/40"><svg class="w-3 h-3 inline" fill="currentColor" viewBox="0 0 24 24"><path d="M3.4 18.7 2.4 8.2l4.8 4.8L12 5.8l4.8 7.2 4.8-4.8-1 10.5z"/></svg></span>';
                    who = `<span class="font-mono text-white/60">${escapeHtml(short)}${isOwner ? ` ${crown}` : ''}</span>`;
                }
                
                // Build permissions array from The Graph fields
                const permList = [];
                
                const canSubscribe = perm.subscribeExpiration === null || parseInt(perm.subscribeExpiration) > now;
                if (canSubscribe) permList.push('<svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>');
                
                const canPublish = perm.publishExpiration === null || parseInt(perm.publishExpiration) > now;
                if (canPublish) permList.push('<svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>');
                
                if (perm.canEdit) permList.push('<svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>');
                if (perm.canDelete) permList.push('<svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>');
                if (perm.canGrant) permList.push('<svg class="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>');
                
                const permsStr = permList.join(' ');
                
                return `<div class="flex justify-between items-center py-1.5 px-2.5 bg-white/5 rounded-lg">
                    <span>${who}</span>
                    <span class="text-white/40">${permsStr}</span>
                </div>`;
            }).join('');
            
            // Add legend
            const legend = `<div class="text-white/20 mt-2 pt-2 border-t border-white/5 text-[10px] flex items-center gap-2 flex-wrap">
                <span class="flex items-center gap-0.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>sub</span>
                <span class="flex items-center gap-0.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>pub</span>
                <span class="flex items-center gap-0.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>edit</span>
                <span class="flex items-center gap-0.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>del</span>
                <span class="flex items-center gap-0.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>grant</span>
            </div>`;
            
            this.elements.permissionsList.innerHTML = formatted + legend;
            
        } catch (error) {
            this.elements.permissionsList.innerHTML = `<div class="text-red-400/80 text-sm">Error: ${escapeHtml(sanitizeText(error.message))}</div>`;
        }
    }

    /**
     * Initialize channel name edit handlers
     * Called after elements are set
     */
    initChannelNameEdit() {
        // Edit button click
        if (this.elements.editChannelNameBtn) {
            this.elements.editChannelNameBtn.addEventListener('click', () => this.startEditingName());
        }
        
        // Save button click
        if (this.elements.saveChannelNameBtn) {
            this.elements.saveChannelNameBtn.addEventListener('click', () => this.saveChannelName());
        }
        
        // Cancel button click
        if (this.elements.cancelChannelNameBtn) {
            this.elements.cancelChannelNameBtn.addEventListener('click', () => this.cancelEditingName());
        }
        
        // Enter key in input
        if (this.elements.channelSettingsNameInput) {
            this.elements.channelSettingsNameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.saveChannelName();
                } else if (e.key === 'Escape') {
                    this.cancelEditingName();
                }
            });
        }

        // Escape key in description textarea cancels edit mode
        if (this.elements.channelSettingsDescriptionInput) {
            this.elements.channelSettingsDescriptionInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    this.cancelEditingName();
                }
            });
        }
    }

    /**
     * Whether this channel's name/description live in PUBLIC on-chain
     * metadata. True for visible channels; a joiner's object may lack the
     * exposure flag, so an on-chain name (channelInfo) also qualifies.
     */
    _hasPublicMetadata(channel) {
        return channel?.exposure === 'visible' || !!channel?.channelInfo?.name;
    }

    /**
     * Access line by gate MODE (N-D): only Closed (NONE) keeps 'Verified
     * Membership' — token/NFT show the condition, paid the price/period.
     * Async on purpose: the sync type label stands until the (cached) chain
     * reads answer, then only the label's text node is swapped.
     *
     * PAID member view adds the subscription clock as a second line ("6h
     * left" / "Subscription expired") — this is the timer's home; the chat
     * header stays clean (N-F).
     */
    async _applyGateAccessLabel(channel) {
        const gate = channel?.gate?.address;
        if (!gate || channel.type !== 'gated') return;
        try {
            const { gateManager, GATE_MODE } = await import('../gate.js');
            const label = await gateManager.gateAccessLabel(gate);
            const current = this.deps.channelManager?.getCurrentChannel?.();
            if (current?.messageStreamId !== channel.messageStreamId) return;
            const span = this.elements.channelSettingsType?.querySelector('span');
            if (span && span.lastChild?.nodeType === Node.TEXT_NODE) {
                span.lastChild.textContent = label;
            }
            await this._applyPaidClock(channel, gate, gateManager, GATE_MODE);
        } catch (e) {
            Logger.debug('Gate access label failed (keeping default):', e?.message);
        }
    }

    /**
     * What the channel is, as chips under its name. The lines come from
     * getChannelTypeLabel so the icons and wording stay shared with the header;
     * only their dress changes here.
     */
    _applyTypeChips() {
        const wrap = this.elements.channelSettingsType?.firstElementChild;
        if (!wrap) return;
        wrap.className = 'flex flex-wrap gap-1.5';
        wrap.querySelectorAll(':scope > span').forEach(s => { s.className = CHIP_CLASS; });
    }

    /**
     * Identity on the wire, as one more chip. Gated only: the mode is the
     * gate's, and it is immutable for its lifetime. The field is reconciled
     * against the contract once per session, so no read here; without it
     * (preview) no chip is added rather than guessing.
     */
    _applyWireIdentityLine(channel) {
        const wrap = this.elements.channelSettingsType?.firstElementChild;
        if (!wrap) return;
        wrap.querySelector('#channel-settings-wire')?.remove();
        const mode = channel?.type === 'gated' ? channel.wireIdentity : null;
        if (!mode) return;
        const chip = document.createElement('span');
        chip.id = 'channel-settings-wire';
        chip.className = CHIP_CLASS;
        chip.innerHTML = wireIdentityIcon(mode, 'w-3 h-3') + wireIdentitySpec(mode).name;
        wrap.appendChild(chip);
    }

    /**
     * The identifier row of the facts card. A DM's stream id is the peer's
     * address with the inbox suffix, so the address is the fact and the id is
     * noise; the click copies whatever is named.
     */
    _applyIdentifierRow(channel) {
        const code = this.elements.channelSettingsId;
        const label = document.getElementById('channel-id-label');
        if (!code) return;
        const peer = channel?.type === 'dm' ? (channel.peerAddress || channel.streamId.split('/')[0]) : null;
        code.textContent = peer ? formatAddress(peer) : formatStreamId(channel.streamId);
        code.dataset.copy = peer || channel.streamId;
        code.dataset.copyLabel = peer ? 'Address' : 'Channel ID';
        if (label) label.textContent = peer ? 'Address' : 'ID';
        document.getElementById('channel-facts')
            ?.querySelector('#channel-settings-paid-left')?.remove();
    }

    async _applyPaidClock(channel, gate, gateManager, GATE_MODE) {
        const container = document.getElementById('channel-facts');
        if (!container) return;
        container.querySelector('#channel-settings-paid-left')?.remove();
        const me = this.deps.authManager?.getAddress?.();
        if (!me) return;
        const info = await gateManager.getGateInfo(gate);
        if (info.mode !== GATE_MODE.PAID || info.owner === me.toLowerCase()) return;
        const until = await gateManager.paidUntilCached(gate, me);
        if (until === null || until === 0) return; // unreadable, or never paid (moderator)
        const current = this.deps.channelManager?.getCurrentChannel?.();
        if (current?.messageStreamId !== channel.messageStreamId) return;
        const { formatRemaining, WARNING_MS } = await import('./SubscriptionBannerUI.js');
        const msLeft = until * 1000 - Date.now();
        const row = document.createElement('div');
        row.id = 'channel-settings-paid-left';
        row.className = 'flex items-center gap-3';
        const tone = msLeft <= 0 ? 'text-red-400/80' : (msLeft < WARNING_MS ? 'text-yellow-400/80' : 'text-white/70');
        row.innerHTML = `<span class="text-xs text-white/35 flex-shrink-0">Subscription</span>`
            + `<span class="flex-1 min-w-0 text-xs text-right ${tone}">`
            + (msLeft > 0 ? `${formatRemaining(msLeft)} left` : 'Expired')
            + `</span><span class="w-3.5 flex-shrink-0"></span>`;
        container.appendChild(row);
    }

    /**
     * Start editing the channel name (and description, when the channel has one).
     * Single global edit mode: unlocks both fields so name + description are
     * saved together in one on-chain transaction.
     */
    startEditingName() {
        const currentName = this.elements.channelSettingsName?.textContent || '';
        
        // Show edit container, hide name display
        if (this.elements.channelNameEditContainer) {
            this.elements.channelNameEditContainer.classList.remove('hidden');
        }
        if (this.elements.channelSettingsName) {
            this.elements.channelSettingsName.classList.add('hidden');
        }
        if (this.elements.editChannelNameBtn) {
            this.elements.editChannelNameBtn.classList.add('hidden');
        }

        // Name and description live in PUBLIC on-chain metadata, so editing
        // them there is only meaningful where that metadata is public: any
        // visible channel (public, password, gated/paid alike). Hidden
        // channels — Closed included — keep name off-chain and have no
        // description; their rename is local, like a DM's.
        const { channelManager } = this.deps;
        const currentChannel = this.deps.getActiveChannel?.() || channelManager.getCurrentChannel();
        const isDM = currentChannel?.type === 'dm';
        const onChainMeta = !isDM && this._hasPublicMetadata(currentChannel);
        this._editingDescription = onChainMeta;

        if (this._editingDescription && this.elements.channelSettingsDescriptionInput) {
            const currentDescription = this.elements.channelDescriptionDisplay?.textContent || '';
            this.elements.channelSettingsDescriptionInput.value = currentDescription;
            // Section may be hidden when the channel has no description yet — unhide while editing
            this.elements.descriptionSection?.classList.remove('hidden');
            this.elements.channelSettingsDescriptionInput.classList.remove('hidden');
            this.elements.channelDescriptionDisplay?.classList.add('hidden');
        }

        // Show save/cancel actions (positioned below the description field)
        if (this.elements.channelEditActions) {
            this.elements.channelEditActions.classList.remove('hidden');
        }

        // Gas warning: only when saving means an on-chain metadata tx
        document.getElementById('channel-edit-gas-warning')?.classList.toggle('hidden', !onChainMeta);
        
        // Set current name in input and focus
        if (this.elements.channelSettingsNameInput) {
            this.elements.channelSettingsNameInput.value = currentName;
            this.elements.channelSettingsNameInput.focus();
            this.elements.channelSettingsNameInput.select();
        }
    }

    /**
     * Cancel editing the channel name/description
     */
    cancelEditingName() {
        // Hide edit container, show name display
        if (this.elements.channelNameEditContainer) {
            this.elements.channelNameEditContainer.classList.add('hidden');
        }
        if (this.elements.channelSettingsName) {
            this.elements.channelSettingsName.classList.remove('hidden');
        }
        if (this.elements.editChannelNameBtn) {
            this.elements.editChannelNameBtn.classList.remove('hidden');
        }
        // Hide description editor, restore display
        if (this.elements.channelSettingsDescriptionInput) {
            this.elements.channelSettingsDescriptionInput.classList.add('hidden');
        }
        this.elements.channelDescriptionDisplay?.classList.remove('hidden');
        // Re-hide the description section if there is still no description
        // (it was unhidden for editing on channels without one)
        if (this._editingDescription && this.elements.descriptionSection) {
            const hasDescription = (this.elements.channelDescriptionDisplay?.textContent || '').trim().length > 0;
            this.elements.descriptionSection.classList.toggle('hidden', !hasDescription);
        }
        // Hide actions
        if (this.elements.channelEditActions) {
            this.elements.channelEditActions.classList.add('hidden');
        }
        // Hide the gas warning that sits above the image in the Info tab
        document.getElementById('channel-edit-gas-warning')?.classList.add('hidden');
        this._editingDescription = false;
    }

    /**
     * Save the edited channel name (and description, if unlocked)
     * - DM and hidden channels: local rename, propagated to other devices via
     *   sync (saveChannels → auto-push) — hidden names never touch the chain
     * - Visible channels: admin-only, updates the stream's on-chain metadata
     *   (name + description written in a SINGLE transaction)
     */
    async saveChannelName() {
        const { channelManager, streamrController, showNotification } = this.deps;
        
        const currentChannel = this.deps.getActiveChannel?.() || channelManager.getCurrentChannel();
        if (!currentChannel) return;

        const newName = this.elements.channelSettingsNameInput?.value?.trim() || '';
        
        if (!newName) {
            showNotification('Name cannot be empty', 'error');
            return;
        }

        const isDM = currentChannel.type === 'dm';
        // On-chain write only where the metadata is public (visible channels);
        // a hidden channel's rename staying local is what keeps its name off
        // the public stream registry.
        const onChainRename = !isDM && this._hasPublicMetadata(currentChannel);
        const editingDescription = onChainRename && this._editingDescription;
        const newDescription = editingDescription
            ? (this.elements.channelSettingsDescriptionInput?.value?.trim() || '')
            : null;

        // Detect changes — skip on-chain tx if nothing changed
        const oldName = currentChannel.channelInfo?.name || currentChannel.name || '';
        const oldDescription = currentChannel.channelInfo?.description ?? currentChannel.description ?? '';
        const nameChanged = newName !== oldName;
        const descriptionChanged = editingDescription && newDescription !== oldDescription;

        if (!nameChanged && !descriptionChanged) {
            this.cancelEditingName();
            return;
        }

        const saveBtn = this.elements.saveChannelNameBtn;
        const cancelBtn = this.elements.cancelChannelNameBtn;

        try {
            if (onChainRename) {
                // Visible channel: admin-only on-chain metadata update (single tx for name + description)
                if (saveBtn) saveBtn.disabled = true;
                if (cancelBtn) cancelBtn.disabled = true;
                showNotification('Updating channel info on-chain...', 'info');

                const updates = {};
                if (nameChanged) updates.name = newName;
                if (descriptionChanged) updates.description = newDescription;
                await streamrController.updateStreamMetadata(currentChannel.streamId, updates);

                // Timestamp of the local admin edit — guards refreshChannelMetadataFromGraph
                // against reverting to stale Graph data (indexing lag)
                currentChannel.metaUpdatedAt = Date.now();

                // Keep cached on-chain info in sync
                if (currentChannel.channelInfo) {
                    if (nameChanged) currentChannel.channelInfo.name = newName;
                    if (descriptionChanged) currentChannel.channelInfo.description = newDescription;
                }
                if (descriptionChanged) {
                    currentChannel.description = newDescription;
                    if (this.elements.channelDescriptionDisplay) {
                        this.elements.channelDescriptionDisplay.textContent = newDescription;
                    }
                }
            }

            // Update local channel name (DM: primary source; non-DM: local cache)
            currentChannel.name = newName;
            
            // Save to localStorage (triggers sync auto-push → name propagates across devices)
            await channelManager.saveChannels();
            
            // Update UI display in modal
            if (this.elements.channelSettingsName) {
                this.elements.channelSettingsName.textContent = newName;
            }
            
            // Update chat header if this is the current channel
            if (this.elements.currentChannelName) {
                const activeChannelId = channelManager.getCurrentChannel()?.messageStreamId || 
                                       channelManager.getCurrentChannel()?.streamId;
                const editedChannelId = currentChannel.messageStreamId || currentChannel.streamId;
                
                if (activeChannelId === editedChannelId) {
                    this.elements.currentChannelName.textContent = newName;
                }
            }
            
            // Exit edit mode
            this.cancelEditingName();
            
            // Sync with Service Worker for push notifications
            relayManager.syncWithServiceWorker();
            
            // Re-render channel list to show new name
            this.deps.renderChannelList?.();
            
            showNotification('Channel info updated!', 'success');
            Logger.debug('Channel info updated:', { newName, newDescription });
            
        } catch (error) {
            showNotification('Failed to save: ' + error.message, 'error');
            Logger.error('Failed to save channel info:', error);
        } finally {
            if (saveBtn) saveBtn.disabled = false;
            if (cancelBtn) cancelBtn.disabled = false;
        }
    }

    // ==================== CHANNEL IMAGE ====================

    /**
     * Render the channel-image section in the Info panel.
     * Visible for all members (preview); upload controls visible only to
     * the channel admin on non-DM channels.
     */
    _renderChannelImageSection(channel, canEdit) {
        const section = document.getElementById('channel-image-section');
        if (!section) return;

        section.classList.remove('hidden');

        const previewEl = document.getElementById('channel-image-preview');
        const controls = document.getElementById('channel-image-controls');
        const fileInput = document.getElementById('channel-image-input');
        const uploadBtn = document.getElementById('channel-image-upload-btn');
        const status = document.getElementById('channel-image-status');

        // A DM has no room identity: the face is the PEER's, ENS picture when
        // they have one, exactly as in the chat header.
        const isDM = channel.type === 'dm';
        if (isDM) {
            controls?.classList.add('hidden');
            status?.classList.add('hidden');
            const peer = channel.peerAddress || channel.streamId.split('/')[0];
            const draw = (url) => {
                if (previewEl) previewEl.innerHTML = getAvatarHtml(peer, AVATAR_PX, 0.5, url);
            };
            draw(identityManager.getCachedENSAvatar?.(peer) || null);
            identityManager.resolveENSAvatar?.(peer)
                .then(url => { if (url) draw(url); })
                .catch(() => {});
            return;
        }

        const adminStreamId = channel.adminStreamId || deriveAdminId(channel.streamId);
        // Same authority source as the moderation menu (pin/hide/ban): the
        // on-chain DELETE permission, RPC-verified and cached at channel
        // open (getCachedDeletePermission). Fallback to isChannelOwner
        // (createdBy OR stream-prefix) only while the cache hasn't been
        // primed yet — the async check races a fast open of this panel.
        const cachedPerm = this.deps?.channelManager?.getCachedDeletePermission?.(channel.streamId);
        const isOwner = cachedPerm
            ? !!cachedPerm.canDelete
            : !!this.deps?.channelManager?.isChannelOwner(channel.streamId);

        // Render preview helper (uses cache; falls back to deterministic avatar)
        const renderPreview = (entry) => {
            if (!previewEl) return;
            if (entry?.dataUrl) {
                previewEl.innerHTML = `<img src="${escapeAttr(entry.dataUrl)}" alt="Channel image" class="w-full h-full object-cover" />`;
            } else {
                // Fallback: deterministic avatar from streamId
                previewEl.innerHTML = getAvatarHtml(channel.streamId, AVATAR_PX, 0.5, null);
            }
        };

        // Initial render from cache (sync) — manager will refresh in background
        renderPreview(channelImageManager.getCached(adminStreamId));

        // Subscribe to updates while modal is open; replace any prior listener
        if (this._channelImageUnsub) {
            try { this._channelImageUnsub(); } catch {}
            this._channelImageUnsub = null;
        }
        if (adminStreamId) {
            this._channelImageUnsub = channelImageManager.subscribe(adminStreamId, renderPreview);
            // Trigger fetch (manager dedups). Don't await; just refresh asynchronously.
            channelImageManager.get(adminStreamId, { password: channel.password || null })
                .then(entry => { if (entry) renderPreview(entry); })
                .catch(() => {});
        }

        // Reset status display when re-rendering
        if (status) {
            status.textContent = '';
            status.classList.add('hidden');
        }

        // Show controls only to admin (and only if not preview mode)
        const showControls = canEdit && isOwner;
        controls?.classList.toggle('hidden', !showControls);
        if (!showControls) return;

        // Wire upload (clone to drop any prior listener)
        if (uploadBtn && fileInput) {
            const newBtn = uploadBtn.cloneNode(true);
            uploadBtn.parentNode.replaceChild(newBtn, uploadBtn);
            const newInput = fileInput.cloneNode(true);
            fileInput.parentNode.replaceChild(newInput, fileInput);

            newBtn.addEventListener('click', () => newInput.click());
            newInput.addEventListener('change', async (ev) => {
                const file = ev.target.files?.[0];
                ev.target.value = '';
                if (!file) return;
                await this._openChannelImageConfirm(channel, file, status, newBtn);
            });
        }
    }

    _paintChannelImageCropCanvas(canvas, image, cropState) {
        if (!canvas || !image || !cropState) return null;

        const viewportSize = canvas.width || 280;
        const frame = mediaController.getSquareCropFrame(
            image.naturalWidth || image.width,
            image.naturalHeight || image.height,
            viewportSize,
            cropState.zoom,
            cropState.centerX,
            cropState.centerY
        );

        cropState.zoom = frame.zoom;
        cropState.centerX = frame.centerX;
        cropState.centerY = frame.centerY;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, viewportSize, viewportSize);
        if (!cropState.preserveAlpha) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, viewportSize, viewportSize);
        }
        ctx.drawImage(image, frame.offsetX, frame.offsetY, frame.drawWidth, frame.drawHeight);
        return frame;
    }

    /**
     * Show the confirmation modal with an interactive square crop preview,
     * encryption option (only for password channels) and Upload/Cancel
     * buttons. On confirm, renders the chosen frame and delegates to
     * _handleChannelImageUpload.
     */
    async _openChannelImageConfirm(channel, file, statusEl, btnEl) {
        const modal = document.getElementById('channel-image-confirm-modal');
        const previewCanvas = document.getElementById('channel-image-confirm-preview');
        const cropStage = document.getElementById('channel-image-crop-stage');
        const zoomInput = document.getElementById('channel-image-zoom');
        const zoomValue = document.getElementById('channel-image-zoom-value');
        const resetBtn = document.getElementById('channel-image-crop-reset-btn');
        const encryptRow = document.getElementById('channel-image-encrypt-row');
        const encryptCb = document.getElementById('channel-image-encrypt');
        const cancelBtn = document.getElementById('cancel-channel-image-btn');
        const confirmBtn = document.getElementById('confirm-channel-image-btn');
        if (!modal || !confirmBtn || !cancelBtn) return;

        let cropImage;
        let preserveAlpha;
        try {
            ({ image: cropImage, preserveAlpha } = await mediaController.loadImageForCrop(file));
        } catch (e) {
            this.deps.showNotification?.('Failed to process image: ' + e.message, 'error');
            return;
        }

        const cropState = {
            zoom: 1,
            centerX: (cropImage.naturalWidth || cropImage.width) / 2,
            centerY: (cropImage.naturalHeight || cropImage.height) / 2,
            preserveAlpha
        };

        const sliderPercentToZoom = (percent) => Math.pow(2, percent / 100);
        const zoomToSliderPercent = (zoom) => Math.round(Math.log2(zoom) * 100);

        const renderCropPreview = () => {
            if (!previewCanvas) return null;
            const frame = this._paintChannelImageCropCanvas(previewCanvas, cropImage, cropState);
            if (zoomInput) {
                const sliderValue = zoomToSliderPercent(cropState.zoom);
                const sliderMin = Number(zoomInput.min || -100);
                const sliderMax = Number(zoomInput.max || 100);
                const thumbPercent = ((sliderValue - sliderMin) / (sliderMax - sliderMin)) * 100;
                zoomInput.value = String(sliderValue);
                zoomInput.style.setProperty('--slider-fill-start', `${Math.min(thumbPercent, 50)}%`);
                zoomInput.style.setProperty('--slider-fill-end', `${Math.max(thumbPercent, 50)}%`);
            }
            if (zoomValue) {
                const sliderValue = zoomToSliderPercent(cropState.zoom);
                zoomValue.textContent = `${sliderValue > 0 ? '+' : ''}${sliderValue}%`;
            }
            return frame;
        };

        if (previewCanvas) {
            previewCanvas.width = 280;
            previewCanvas.height = 280;
            renderCropPreview();
        }

        if (zoomInput) {
            zoomInput.value = '0';
            zoomInput.oninput = () => {
                cropState.zoom = sliderPercentToZoom(Number(zoomInput.value || 0));
                renderCropPreview();
            };
        }

        if (resetBtn) {
            resetBtn.onclick = () => {
                cropState.zoom = 1;
                cropState.centerX = (cropImage.naturalWidth || cropImage.width) / 2;
                cropState.centerY = (cropImage.naturalHeight || cropImage.height) / 2;
                renderCropPreview();
            };
        }

        if (cropStage) {
            let dragState = null;
            const stopDragging = () => {
                dragState = null;
                cropStage.style.cursor = 'grab';
            };

            cropStage.style.cursor = 'grab';
            cropStage.onpointerdown = (ev) => {
                dragState = { pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY };
                cropStage.setPointerCapture?.(ev.pointerId);
                cropStage.style.cursor = 'grabbing';
            };
            cropStage.onpointermove = (ev) => {
                if (!dragState || dragState.pointerId !== ev.pointerId) return;
                const frame = mediaController.getSquareCropFrame(
                    cropImage.naturalWidth || cropImage.width,
                    cropImage.naturalHeight || cropImage.height,
                    previewCanvas?.width || 280,
                    cropState.zoom,
                    cropState.centerX,
                    cropState.centerY
                );
                const deltaX = ev.clientX - dragState.x;
                const deltaY = ev.clientY - dragState.y;
                const displayedWidth = cropStage.getBoundingClientRect().width || (previewCanvas?.width || 280);
                const canvasToScreenRatio = (previewCanvas?.width || 280) / displayedWidth;
                dragState.x = ev.clientX;
                dragState.y = ev.clientY;
                cropState.centerX -= (deltaX * canvasToScreenRatio) / frame.scale;
                cropState.centerY -= (deltaY * canvasToScreenRatio) / frame.scale;
                renderCropPreview();
            };
            cropStage.onpointerup = stopDragging;
            cropStage.onpointercancel = stopDragging;
            cropStage.onlostpointercapture = stopDragging;
        }

        // Encrypt option only for password channels
        const isPassword = channel.type === 'password' && !!channel.password;
        if (encryptRow) {
            encryptRow.classList.toggle('hidden', !isPassword);
            encryptRow.classList.toggle('flex', isPassword);
        }
        if (encryptCb) encryptCb.checked = false;

        modal.classList.remove('hidden');

        // Replace listeners by cloning
        const newCancel = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
        const newConfirm = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);

        const close = () => modal.classList.add('hidden');
        newCancel.addEventListener('click', close);

        // Backdrop click to dismiss
        modal.onclick = (ev) => {
            if (ev.target === modal) close();
        };

        newConfirm.addEventListener('click', async () => {
            const encrypt = !!document.getElementById('channel-image-encrypt')?.checked;
            const dataUrl = mediaController.renderSquareCrop(cropImage, {
                size: 512,
                quality: 0.85,
                zoom: cropState.zoom,
                centerX: cropState.centerX,
                centerY: cropState.centerY,
                preserveAlpha: cropState.preserveAlpha
            });
            close();
            await this._handleChannelImageUpload(channel, dataUrl, encrypt, statusEl, btnEl);
        });
    }

    async _handleChannelImageUpload(channel, dataUrl, encrypt, statusEl, btnEl) {
        const setStatus = (text, kind = 'info') => {
            if (!statusEl) return;
            statusEl.textContent = text;
            statusEl.classList.remove('hidden', 'text-red-400', 'text-green-400', 'text-white/40');
            statusEl.classList.add(
                kind === 'error' ? 'text-red-400'
                    : kind === 'success' ? 'text-green-400'
                        : 'text-white/40'
            );
        };

        const lock = (locked) => {
            if (!btnEl) return;
            btnEl.disabled = locked;
            btnEl.classList.toggle('opacity-50', locked);
            btnEl.classList.toggle('pointer-events-none', locked);
        };

        try {
            lock(true);
            setStatus('Publishing…');

            const base64 = dataUrl.split(',')[1] || dataUrl;
            const sha = await channelImageManager.sha256Hex(base64);

            const { channelManager } = this.deps;
            const adminStreamId = channel.adminStreamId || deriveAdminId(channel.streamId);

            await channelManager.publishChannelImage(channel.streamId, {
                dataUrl,
                hash: sha
            }, { encrypt });

            // Verify by force-fetching the latest from Streamr storage so we
            // confirm the publish actually persisted (and didn't only land
            // in the optimistic local cache).
            setStatus('Verifying…');
            const verified = await channelImageManager
                .get(adminStreamId, {
                    password: encrypt ? channel.password : null,
                    force: true
                })
                .catch(() => null);

            if (verified && verified.hash === sha) {
                setStatus('Image updated', 'success');
            } else {
                setStatus('Published — propagating…', 'success');
            }
            // Refresh sidebar so the new image shows immediately there too.
            this.deps.renderChannelList?.();
        } catch (e) {
            Logger.error('Channel image upload failed:', e);
            setStatus('Failed: ' + (e?.message || 'unknown error'), 'error');
            this.deps.showNotification?.('Failed to upload image: ' + e.message, 'error');
        } finally {
            lock(false);
        }
    }
}

export const channelSettingsUI = new ChannelSettingsUI();
