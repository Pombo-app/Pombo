/**
 * Channel Modals UI Manager
 * Handles create channel, join channel modal functionality
 */

import { GasEstimator } from './GasEstimator.js';
import { formatRemaining } from './SubscriptionBannerUI.js';
import { authManager } from '../auth.js';
import { streamrController } from '../streamr.js';
import { CONFIG } from '../config.js';
import { snapRetentionDays, retentionLabel } from '../utils/retention.js';

class ChannelModalsUI {
    constructor() {
        this.deps = {};
        this.elements = {};
        this.currentExposure = 'hidden';
        this.currentClassification = 'personal';
        this.currentGateAsset = 'token';
        this.gateTokenPreset = 'pol';
        this.paidTokenPreset = 'usdc';
        this.joinClassification = 'personal';
        this.currentReadOnly = false;
        this.currentStorageProvider = 'streamr';
        this.currentCustomStorageAddress = '';
    }

    /**
     * Set dependencies
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    // Convenience getters
    get channelManager() { return this.deps.channelManager; }
    get modalManager() { return this.deps.modalManager; }
    get notificationUI() { return this.deps.notificationUI; }
    get Logger() { return this.deps.Logger; }

    /**
     * Show notification helper
     */
    showNotification(message, type) {
        this.deps.showNotification?.(message, type);
    }

    /**
     * Set elements reference
     */
    setElements(elements) {
        this.elements = elements;
    }

    /**
     * Show new channel modal
     */
    show() {
        document.body.classList.add('new-channel-open');
        this.deps.modalManager?.show('new-channel-modal');
        if (this.elements.channelNameInput) this.elements.channelNameInput.value = '';
        if (this.elements.channelPasswordInput) {
            this.elements.channelPasswordInput.value = '';
            this.elements.channelPasswordInput.type = 'password';
            this.elements.channelPasswordInput.style.webkitTextSecurity = 'disc';
        }
        if (this.elements.channelPasswordConfirmInput) this.elements.channelPasswordConfirmInput.value = '';
        this.elements.passwordConfirmSection?.classList.add('hidden');
        // Reset password eye icons
        const eyeOpen = document.getElementById('channel-pw-eye-open');
        const eyeOff = document.getElementById('channel-pw-eye-off');
        if (eyeOpen) eyeOpen.classList.remove('hidden');
        if (eyeOff) eyeOff.classList.add('hidden');
        if (this.elements.channelMembersInput) this.elements.channelMembersInput.value = '';
        
        // Reset exposure fields
        if (this.elements.channelDescriptionInput) this.elements.channelDescriptionInput.value = '';
        if (this.elements.channelLanguageInput) this.elements.channelLanguageInput.value = 'en';
        if (this.elements.channelCategoryInput) this.elements.channelCategoryInput.value = 'general';
        
        // Reset to public tab
        this.switchChannelTab('public');
        // Reset to hidden visibility (default)
        this.setVisibility(false);
        // Reset classification to personal (for Closed channels)
        this.switchClassificationTab('personal');
        // Reset gate fields (Gated/Paid tabs)
        for (const id of ['gate-token-input', 'gate-min-balance-input', 'paid-token-input', 'paid-price-input']) {
            const input = document.getElementById(id);
            if (input) input.value = '';
        }
        const paidDuration = document.getElementById('paid-duration-input');
        if (paidDuration) paidDuration.value = '30';
        this.gateTokenPreset = 'pol';
        this.paidTokenPreset = 'usdc';
        this.switchGateAssetTab('token');   // reapplies the gate token preset
        this.switchTokenPresetTab('paid', 'usdc');
        // Reset author visibility to the Sealed default
        const sealedRadio = document.getElementById('gate-wire-identity-sealed');
        if (sealedRadio) sealedRadio.checked = true;
        this._wireAuthorVisibilityCaption();
        this._updateAuthorVisibilityCaption();
        // Reset read-only toggle
        this.setReadOnly(false);
        // Reset storage provider to Streamr (default)
        this.selectStorageProvider('streamr');

        const customAddrInput = document.getElementById('custom-storage-address');
        if (customAddrInput) customAddrInput.value = '';
        this.currentCustomStorageAddress = '';
        this.clearCustomAddressError();

        const storageDaysSlider = document.getElementById('storage-days-input');
        if (storageDaysSlider) {
            storageDaysSlider.value = '180';
            this.updateStorageDaysDisplay(180);
        }
        
        // Fetch and display gas estimates
        this.updateGasEstimates();
    }

    /**
     * Hide new channel modal
     */
    hide() {
        document.body.classList.remove('new-channel-open');
        this.deps.modalManager?.hideNewChannelModal();
    }

    /**
     * Open the confirm-password step: the warning banner and the confirm
     * field. Fires on every focus of the password field, not just the
     * first — an edited password always needs re-confirming, so the confirm
     * field is cleared each time this opens.
     */
    expandPasswordConfirm() {
        const confirmInput = this.elements.channelPasswordConfirmInput;
        if (confirmInput) confirmInput.value = '';
        this.elements.passwordConfirmSection?.classList.remove('hidden');
    }

    /**
     * Collapse the confirm-password step once the two fields match — the
     * password itself stays filled in, only the confirm UI goes away.
     */
    checkPasswordMatch() {
        const password = this.elements.channelPasswordInput?.value || '';
        const confirmInput = this.elements.channelPasswordConfirmInput;
        const confirm = confirmInput?.value || '';
        if (!confirmInput) return;

        if (confirm && password === confirm) {
            confirmInput.classList.remove('border-red-400');
            this.elements.passwordConfirmSection?.classList.add('hidden');
        } else {
            confirmInput.classList.toggle('border-red-400', confirm.length > 0);
        }
    }

    /**
     * Update gas cost estimates in the create channel modal
     */
    async updateGasEstimates() {
        const costPublic = document.getElementById('cost-public');
        const costPassword = document.getElementById('cost-password');
        // Every gate-backed tab (Closed/Gated/Paid) deploys the same clone
        // and stream set — they share the gated cost bucket.
        const costGated = ['cost-closed', 'cost-gated', 'cost-paid']
            .map((id) => document.getElementById(id)).filter(Boolean);

        try {
            const estimates = await GasEstimator.estimateCosts();
            const tooltipText = `Gas: ${estimates.formatted.gasPrice}`;

            if (costPublic) {
                costPublic.textContent = estimates.formatted.public;
                costPublic.dataset.tooltip = tooltipText;
            }
            if (costPassword) {
                costPassword.textContent = estimates.formatted.password;
                costPassword.dataset.tooltip = tooltipText;
            }
            for (const el of costGated) {
                el.textContent = estimates.formatted.gated;
                el.dataset.tooltip = tooltipText;
            }
        } catch (error) {
            this.Logger?.warn('Failed to estimate gas costs:', error);
            const fallbackTooltip = 'Gas: ~120 gwei';
            if (costPublic) {
                costPublic.textContent = '~0.23 POL';
                costPublic.dataset.tooltip = fallbackTooltip;
            }
            if (costPassword) {
                costPassword.textContent = '~0.23 POL';
                costPassword.dataset.tooltip = fallbackTooltip;
            }
            for (const el of costGated) {
                el.textContent = '~0.28 POL';
                el.dataset.tooltip = fallbackTooltip;
            }
        }
    }

    /**
     * Switch channel type tab
     */
    switchChannelTab(tabType) {
        document.querySelectorAll('.channel-tab').forEach(tab => {
            const isActive = tab.dataset.tab === tabType;
            tab.classList.toggle('bg-white/10', isActive);
            tab.classList.toggle('text-white', isActive);
            tab.classList.toggle('text-white/60', !isActive);
            tab.classList.toggle('hover:text-white/90', !isActive);
            tab.classList.toggle('hover:bg-white/5', !isActive);
        });
        
        document.querySelectorAll('.channel-tab-content').forEach(content => {
            content.classList.toggle('hidden', content.id !== `tab-${tabType}`);
        });
        
        // Show/hide type-specific fields
        const passwordSection = document.getElementById('password-field-section');
        const closedSection = document.getElementById('closed-fields-section');
        const gatedSection = document.getElementById('gated-fields-section');
        const paidSection = document.getElementById('paid-fields-section');

        if (passwordSection) {
            passwordSection.classList.toggle('hidden', tabType !== 'password');
        }
        if (closedSection) {
            closedSection.classList.toggle('hidden', tabType !== 'closed');
        }
        if (gatedSection) {
            gatedSection.classList.toggle('hidden', tabType !== 'gated');
        }
        if (paidSection) {
            paidSection.classList.toggle('hidden', tabType !== 'paid');
        }
        // Author visibility applies to every gated variant (Closed included)
        const gatedFamily = ['closed', 'gated', 'paid'].includes(tabType);
        document.getElementById('author-visibility-section')
            ?.classList.toggle('hidden', !gatedFamily);
        // Classification is local-only organization: same variants, end of page
        document.getElementById('classification-section')
            ?.classList.toggle('hidden', !gatedFamily);

        // Update cost display in footer
        document.querySelectorAll('.channel-cost-display').forEach(cost => {
            cost.classList.add('hidden');
        });
        const activeCost = document.getElementById(`cost-${tabType}`);
        if (activeCost) activeCost.classList.remove('hidden');

        // Closed channels: hide exposure section entirely
        if (tabType === 'closed') {
            this.setVisibility(false);
            this.elements.exposureSection?.classList.add('hidden');
        } else {
            this.elements.exposureSection?.classList.remove('hidden');
        }
    }

    /**
     * Switch asset type (token/nft) in the Gated tab
     */
    switchGateAssetTab(asset) {
        document.querySelectorAll('.gate-asset-tab').forEach(tab => {
            const isActive = tab.dataset.gateAsset === asset;
            tab.classList.toggle('bg-white/10', isActive);
            tab.classList.toggle('text-white', isActive);
            tab.classList.toggle('border-white/10', isActive);
            tab.classList.toggle('bg-white/5', !isActive);
            tab.classList.toggle('text-white/50', !isActive);
            tab.classList.toggle('border-white/5', !isActive);
            tab.classList.toggle('hover:bg-white/10', !isActive);
            tab.classList.toggle('hover:text-white/70', !isActive);
        });
        // NFT gates require holding at least one — no balance threshold on-chain
        document.getElementById('gate-min-balance-field')?.classList.toggle('hidden', asset === 'nft');
        this.currentGateAsset = asset;

        // Quick-pick tokens are ERC-20 only — an NFT gate is always a custom
        // collection address
        const presetsRow = document.getElementById('gate-token-presets');
        if (asset === 'nft') {
            presetsRow?.classList.add('hidden');
            const input = document.getElementById('gate-token-input');
            if (input) {
                input.classList.remove('hidden');
                input.value = '';
            }
            const hint = document.getElementById('gate-token-hint');
            if (hint) hint.textContent = 'ERC-721 collection on Polygon — holding any token grants access.';
        } else {
            presetsRow?.classList.remove('hidden');
            this.switchTokenPresetTab('gate', this.gateTokenPreset);
        }
    }

    /**
     * Switch the quick-pick token (pol/usdc/data/custom) in the Gated or Paid
     * tab. A preset fills the (hidden) token input; Custom reveals it empty.
     * POL differs by context — see CONFIG.gate.tokenPresets.
     */
    switchTokenPresetTab(context, key) {
        const isGate = context === 'gate';
        const preset = CONFIG.gate.tokenPresets[isGate ? 'gate' : 'pay'][key] || null;
        document.querySelectorAll(isGate ? '.gate-token-preset-tab' : '.paid-token-preset-tab').forEach(tab => {
            const isActive = tab.dataset.tokenPreset === key;
            tab.classList.toggle('bg-white/10', isActive);
            tab.classList.toggle('text-white', isActive);
            tab.classList.toggle('border-white/10', isActive);
            tab.classList.toggle('bg-white/5', !isActive);
            tab.classList.toggle('text-white/50', !isActive);
            tab.classList.toggle('border-white/5', !isActive);
            tab.classList.toggle('hover:bg-white/10', !isActive);
            tab.classList.toggle('hover:text-white/70', !isActive);
        });
        const input = document.getElementById(isGate ? 'gate-token-input' : 'paid-token-input');
        if (input) {
            input.classList.toggle('hidden', !!preset);
            input.value = preset ? preset.address : '';
        }
        const hint = document.getElementById(isGate ? 'gate-token-hint' : 'paid-token-hint');
        if (hint) hint.textContent = this._tokenPresetHint(context, key, preset);
        if (isGate) this.gateTokenPreset = key;
        else this.paidTokenPreset = key;
    }

    _tokenPresetHint(context, key, preset) {
        const short = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
        if (context === 'gate') {
            if (key === 'pol') return "Gates on the member's native POL balance.";
            if (!preset) return 'ERC-20 contract on Polygon.';
            return `${preset.label} on Polygon · ${short(preset.address)}`;
        }
        if (key === 'pol') return 'Priced in Wrapped POL (WPOL) — subscribers paying with plain POL have it wrapped automatically.';
        if (!preset) return 'ERC-20 token subscribers pay with, on Polygon.';
        return `Subscribers pay in ${preset.label} · ${short(preset.address)}`;
    }

    /**
     * Toggle visibility (hidden/visible)
     */
    toggleVisibility() {
        const toggle = document.getElementById('visibility-toggle');
        if (!toggle) return;
        const isEnabled = toggle.dataset.enabled === 'true';
        this.setVisibility(!isEnabled);
    }

    /**
     * Set visibility state
     */
    setVisibility(visible) {
        const toggle = document.getElementById('visibility-toggle');
        if (!toggle) return;
        
        toggle.dataset.enabled = visible ? 'true' : 'false';
        const knob = toggle.querySelector('span');
        
        if (visible) {
            toggle.classList.remove('bg-white/10');
            toggle.classList.add('bg-[#F6851B]');
            if (knob) {
                knob.classList.remove('left-0.5', 'bg-white/30');
                knob.classList.add('left-4', 'bg-white');
            }
            this.elements.visibleFields?.classList.remove('hidden');
        } else {
            toggle.classList.remove('bg-[#F6851B]');
            toggle.classList.add('bg-white/10');
            if (knob) {
                knob.classList.remove('left-4', 'bg-white');
                knob.classList.add('left-0.5', 'bg-white/30');
            }
            this.elements.visibleFields?.classList.add('hidden');
        }
        
        this.currentExposure = visible ? 'visible' : 'hidden';
    }

    /** The caption states each mode's gain and cost, so it follows the pick. */
    _updateAuthorVisibilityCaption() {
        const caption = document.getElementById('author-visibility-caption');
        if (!caption) return;
        const onTheWire = document.getElementById('gate-wire-identity-visible')?.checked;
        caption.textContent = onTheWire
            ? "Every message exposes its author's account, attributable by anyone, forever. Removed members' messages are rejected by readers, but can still reach storage."
            : 'Full author privacy. Removed members can pollute storage until you reset the key with a paid on-chain action.';
    }

    _wireAuthorVisibilityCaption() {
        if (this._authorCaptionWired) return;
        this._authorCaptionWired = true;
        for (const id of ['gate-wire-identity-sealed', 'gate-wire-identity-visible']) {
            document.getElementById(id)?.addEventListener('change', () =>
                this._updateAuthorVisibilityCaption());
        }
    }

    /**
     * Switch classification tab (personal/community) in Create modal
     */
    switchClassificationTab(classification) {
        document.querySelectorAll('.classification-tab').forEach(tab => {
            const isActive = tab.dataset.classification === classification;
            tab.classList.toggle('bg-white/10', isActive);
            tab.classList.toggle('text-white', isActive);
            tab.classList.toggle('border-white/10', isActive);
            tab.classList.toggle('bg-white/5', !isActive);
            tab.classList.toggle('text-white/50', !isActive);
            tab.classList.toggle('border-white/5', !isActive);
            tab.classList.toggle('hover:bg-white/10', !isActive);
            tab.classList.toggle('hover:text-white/70', !isActive);
        });
        this.currentClassification = classification;
    }

    /**
     * Switch classification tab in Join Closed Channel modal
     */
    switchJoinClassificationTab(classification) {
        document.querySelectorAll('.join-classification-tab').forEach(tab => {
            const isActive = tab.dataset.joinClassification === classification;
            tab.classList.toggle('bg-white/10', isActive);
            tab.classList.toggle('text-white', isActive);
            tab.classList.toggle('border-white/10', isActive);
            tab.classList.toggle('bg-white/5', !isActive);
            tab.classList.toggle('text-white/50', !isActive);
            tab.classList.toggle('border-white/5', !isActive);
            tab.classList.toggle('hover:bg-white/10', !isActive);
            tab.classList.toggle('hover:text-white/70', !isActive);
        });
        this.joinClassification = classification;
    }

    /**
     * Toggle read-only mode
     */
    toggleReadOnly() {
        const toggle = document.getElementById('read-only-toggle');
        if (!toggle) return;
        const isEnabled = toggle.dataset.enabled === 'true';
        this.setReadOnly(!isEnabled);
    }

    /**
     * Set read-only mode state
     */
    setReadOnly(enabled) {
        const toggle = document.getElementById('read-only-toggle');
        if (!toggle) return;
        
        toggle.dataset.enabled = enabled ? 'true' : 'false';
        const knob = toggle.querySelector('span');
        
        if (enabled) {
            toggle.classList.remove('bg-white/10');
            toggle.classList.add('bg-[#F6851B]');
            if (knob) {
                knob.classList.remove('left-0.5', 'bg-white/30');
                knob.classList.add('left-4', 'bg-white');
            }
        } else {
            toggle.classList.remove('bg-[#F6851B]');
            toggle.classList.add('bg-white/10');
            if (knob) {
                knob.classList.remove('left-4', 'bg-white');
                knob.classList.add('left-0.5', 'bg-white/30');
            }
        }
        
        this.currentReadOnly = enabled;
    }

    /**
     * Select storage provider ('streamr' or 'custom')
     */
    selectStorageProvider(provider) {
        this.currentStorageProvider = provider;

        document.querySelectorAll('.storage-provider-tab').forEach(tab => {
            if (tab.dataset.storage === provider) {
                tab.classList.remove('bg-white/5', 'text-white/50', 'border-white/5');
                tab.classList.add('bg-white/10', 'text-white', 'border-white/10');
            } else {
                tab.classList.remove('bg-white/10', 'text-white', 'border-white/10');
                tab.classList.add('bg-white/5', 'text-white/50', 'border-white/5');
            }
        });

        const streamrAddressDisplay = document.getElementById('streamr-address-display');
        const customAddressSection = document.getElementById('custom-address-section');

        if (provider === 'streamr') {
            streamrAddressDisplay?.classList.remove('hidden');
            customAddressSection?.classList.add('hidden');
            this.refreshStreamrAddress();
        } else {
            streamrAddressDisplay?.classList.add('hidden');
            customAddressSection?.classList.remove('hidden');
            this.clearCustomAddressError();
        }
    }

    /**
     * Populate the Pombo storage node address (hardcoded).
     */
    refreshStreamrAddress() {
        const target = document.getElementById('streamr-address-value');
        if (!target) return;
        const addr = '0xae340e799e8151f6a4999d245e466197aa217667';
        target.textContent = addr;
        target.classList.remove('text-red-400');
        target.classList.add('text-white/50');
    }

    /**
     * Show inline error for the custom storage address input.
     */
    showCustomAddressError(message) {
        const errorEl = document.getElementById('custom-storage-address-error');
        const inputEl = document.getElementById('custom-storage-address');
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.classList.remove('hidden');
        }
        inputEl?.classList.add('border-red-500/50');
    }

    clearCustomAddressError() {
        const errorEl = document.getElementById('custom-storage-address-error');
        const inputEl = document.getElementById('custom-storage-address');
        errorEl?.classList.add('hidden');
        inputEl?.classList.remove('border-red-500/50');
    }

    /**
     * Update storage days slider display and progress. The slider itself
     * stays a proportional 1-365 day range; above the 30-day mark the
     * effective value is magnet-snapped to the nearest exact month so the
     * label never shows an ambiguous in-between day count, and the thumb
     * snaps along with it.
     */
    updateStorageDaysDisplay(rawDays) {
        const days = snapRetentionDays(rawDays);
        const label = document.getElementById('storage-days-value');
        const slider = document.getElementById('storage-days-input');

        if (label) label.textContent = retentionLabel(days);

        if (slider) {
            if (slider.value !== String(days)) slider.value = String(days);
            const progress = ((days - 1) / (365 - 1)) * 100;
            slider.style.setProperty('--slider-progress', `${progress}%`);
        }

        return days;
    }

    /**
     * Show join channel modal for channels requiring local name
     * Used for: native channels, hidden channels, unknown channels
     * @param {string} streamId - Channel stream ID
     * @param {Object} channelInfo - Channel info from Graph (optional)
     */
    showJoinClosedModal(streamId = '', channelInfo = null) {
        // Store channelInfo for use when joining
        this._pendingJoinChannelInfo = channelInfo;
        this._localIdentityTarget = null;

        this.deps.modalManager?.showJoinClosedChannelModal(streamId);
        document.getElementById('join-closed-stream-id-input')?.parentElement?.classList.remove('hidden');
        const joinBtn = document.getElementById('join-closed-btn');
        if (joinBtn) joinBtn.textContent = 'Join';
        this.switchJoinClassificationTab('personal');
        
        // Always show classification section - helps organize any channel locally
        const classificationSection = document.getElementById('join-classification-section');
        classificationSection?.classList.remove('hidden');
        
        // Update modal title based on channel type
        const modalTitle = document.querySelector('#join-closed-channel-modal h3');
        if (modalTitle) {
            if (channelInfo?.type === 'gated') {
                modalTitle.textContent = 'Join Closed Channel';
            } else if (channelInfo) {
                modalTitle.textContent = 'Name This Channel';
            } else {
                modalTitle.textContent = 'Join Channel';
            }
        }
    }
    
    /**
     * Show join hidden channel modal (alias for consistency)
     * @param {string} streamId - Channel stream ID
     * @param {Object} channelInfo - Channel info from Graph (optional)
     */
    showJoinHiddenModal(streamId = '', channelInfo = null) {
        // Use the same modal - classification is useful for all hidden channels
        this.showJoinClosedModal(streamId, channelInfo);
    }

    /**
     * Hide join closed channel modal
     */
    hideJoinClosedModal() {
        this._localIdentityTarget = null;
        this.deps.modalManager?.hide('join-closed-channel-modal');
    }

    /**
     * Post-join local identity panel for channels without an on-chain name:
     * reuses the join-closed modal (stream ID hidden, name prefilled) to let
     * the member set the local name + classification. Closing skips — the
     * ID-derived name stays and can be edited later in Channel Details.
     * @param {Object} channel - The just-joined channel record
     */
    showLocalIdentityModal(channel) {
        if (!channel) return;
        this._pendingJoinChannelInfo = null;

        this.deps.modalManager?.showJoinClosedChannelModal(channel.messageStreamId);
        this._localIdentityTarget = channel;
        document.getElementById('join-closed-stream-id-input')?.parentElement?.classList.add('hidden');
        document.getElementById('join-classification-section')?.classList.remove('hidden');
        this.switchJoinClassificationTab(channel.classification || 'personal');

        const nameInput = document.getElementById('join-closed-name-input');
        if (nameInput) {
            nameInput.value = channel.name || '';
            nameInput.focus();
            nameInput.select();
        }

        const modalTitle = document.querySelector('#join-closed-channel-modal h3');
        if (modalTitle) modalTitle.textContent = 'Name This Channel';
        const joinBtn = document.getElementById('join-closed-btn');
        if (joinBtn) joinBtn.textContent = 'Save';
    }

    /**
     * Save the local identity panel: local rename + classification only,
     * never a join (the channel is already in the list).
     */
    async _handleSaveLocalIdentity(channel) {
        const localName = document.getElementById('join-closed-name-input')?.value.trim();
        const classification = this.joinClassification || 'personal';
        this.hideJoinClosedModal();

        if (localName) channel.name = localName;
        channel.classification = classification;
        await this.channelManager.saveChannels();
        this.deps.renderChannelList?.();

        const current = this.channelManager.getCurrentChannel?.();
        if (current?.messageStreamId === channel.messageStreamId) {
            const headerName = document.getElementById('current-channel-name');
            if (headerName) headerName.textContent = channel.name;
        }
    }

    /**
     * Handle joining a channel (with local name + classification)
     */
    async handleJoinClosedChannel() {
        if (this._localIdentityTarget) {
            await this._handleSaveLocalIdentity(this._localIdentityTarget);
            return;
        }

        const streamId = document.getElementById('join-closed-stream-id-input')?.value.trim();
        const localName = document.getElementById('join-closed-name-input')?.value.trim();
        const classification = this.joinClassification || 'personal';
        
        // Get stored channel info from when modal was opened
        const channelInfo = this._pendingJoinChannelInfo;
        
        if (!streamId) {
            this.showNotification('Please enter a Stream ID', 'error');
            return;
        }
        
        if (!localName) {
            this.showNotification('Please enter a name for this channel', 'error');
            return;
        }
        
        this.hideJoinClosedModal();
        
        // Clear pending state
        this._pendingJoinChannelInfo = null;
        
        // Use actual channel type from Graph, or 'gated' if unknown
        const channelType = channelInfo?.type || 'gated';

        const attempt = async () => {
            try {
                this.notificationUI?.showLoadingToast('Joining channel...', 'This may take a moment');
                await this.channelManager.joinChannel(streamId, null, {
                    name: localName,
                    named: true,
                    type: channelType,
                    classification: classification,  // Always save classification for local organization
                    readOnly: channelInfo?.readOnly || false,
                    createdBy: channelInfo?.createdBy
                });
                this.deps.renderChannelList?.();
                this.showNotification('Joined channel successfully!', 'success');
            } finally {
                this.notificationUI?.hideLoadingToast();
            }
        };

        try {
            await attempt();
        } catch (error) {
            if (error.code === 'GATE_ACCESS_DENIED') {
                this.showGateEntryModal({
                    streamId,
                    gateAddress: error.gateAddress,
                    name: localName,
                    retry: attempt
                });
            } else {
                this.showNotification('Failed to join: ' + error.message, 'error');
            }
        }
    }

    /**
     * Ban with its two enforcement levels, either or both.
     *
     * CLIENT is the ADMIN_STATE ban: every client hides the author's messages,
     * free, reversible, and publishable only by the channel creator, since
     * receivers reject an ADMIN_STATE from anyone else. PROTOCOL bans on the
     * gate: no responder hands them keys again and the rotation that follows
     * cuts their reads. That one costs gas, and only gated channels have it.
     *
     * @param {string} address - Who to ban
     * @param {Object} channel - The open channel
     */
    showBanMemberModal(address, channel) {
        const gated = !!channel?.gate?.address;
        const me = authManager.getAddress()?.toLowerCase();
        const canClientBan = !!me && me === channel?.createdBy?.toLowerCase();

        const label = document.getElementById('ban-member-label');
        if (label) label.textContent = `${address.slice(0, 6)}…${address.slice(-4)}`;

        const client = document.getElementById('ban-level-client');
        const protocol = document.getElementById('ban-level-protocol');
        const clientDetail = document.getElementById('ban-level-client-detail');
        const protocolDetail = document.getElementById('ban-level-protocol-detail');

        if (client) {
            client.checked = canClientBan;
            client.disabled = !canClientBan;
        }
        if (protocol) {
            protocol.checked = gated;
            protocol.disabled = !gated;
        }
        if (clientDetail && !canClientBan) {
            clientDetail.textContent = 'Only the channel creator can publish this.';
        } else if (clientDetail) {
            clientDetail.textContent = 'Hides their messages for everyone. Free and reversible.';
        }
        if (protocolDetail && !gated) {
            protocolDetail.textContent = 'Only gated channels have a gate to ban on.';
        } else if (protocolDetail) {
            protocolDetail.textContent = 'Cuts their access on the gate and rotates the channel key. One transaction.';
        }
        document.getElementById('ban-level-client-row')?.classList.toggle('opacity-40', !canClientBan);
        document.getElementById('ban-level-protocol-row')?.classList.toggle('opacity-40', !gated);

        const confirmBtn = document.getElementById('confirm-ban-member-btn');
        if (confirmBtn) {
            confirmBtn.onclick = async () => {
                const levels = {
                    client: !!client?.checked && canClientBan,
                    protocol: !!protocol?.checked && gated
                };
                if (!levels.client && !levels.protocol) return;
                this.deps.modalManager?.hide('ban-member-modal');
                try {
                    this.notificationUI?.showLoadingToast('Banning…', 'This may take a moment');
                    await this.channelManager.banMemberLevels(channel.streamId, address, levels);
                    this.showNotification('Member banned', 'success');
                } catch (error) {
                    this.showNotification('Failed to ban: ' + error.message, 'error');
                } finally {
                    this.notificationUI?.hideLoadingToast();
                }
            };
        }
        const cancelBtn = document.getElementById('cancel-ban-member-btn');
        if (cancelBtn) cancelBtn.onclick = () => this.deps.modalManager?.hide('ban-member-modal');

        this.deps.modalManager?.show('ban-member-modal');
    }

    /**
     * Entry screen for a gated channel the user cannot enter yet:
     * reads the gate mode on-chain and shows the requirement, the user's
     * standing, and the pay() action. `retry` re-runs the entry that
     * was denied with GATE_ACCESS_DENIED.
     *
     * `renewal: true` reuses the screen for a member renewing from inside a
     * paid channel: the pay action is always offered (renewing early extends
     * from the current end), there is no "Enter Channel", and `retry` runs
     * after payment instead of re-joining.
     */
    async showGateEntryModal({ streamId, gateAddress, name = null, retry = null, renewal = false }) {
        this._gateEntry = { streamId, gateAddress, name, retry, renewal };
        this.deps.modalManager?.show('gate-entry-modal');

        const titleEl = document.getElementById('gate-entry-title');
        if (titleEl) {
            titleEl.textContent = renewal
                ? (name ? `Renew ${name}` : 'Renew Subscription')
                : (name ? `Join ${name}` : 'Join Gated Channel');
        }

        const cancelBtn = document.getElementById('gate-entry-cancel-btn');
        if (cancelBtn) cancelBtn.onclick = () => this.hideGateEntryModal();

        await this._renderGateEntry();
    }

    hideGateEntryModal() {
        this._gateEntry = null;
        this.deps.modalManager?.hide('gate-entry-modal');
    }

    async _renderGateEntry() {
        const entry = this._gateEntry;
        if (!entry) return;
        const conditionEl = document.getElementById('gate-entry-condition');
        const stackEl = document.getElementById('gate-entry-stack');
        const verbEl = document.getElementById('gate-entry-verb');
        const valueEl = document.getElementById('gate-entry-value');
        const qualifierEl = document.getElementById('gate-entry-qualifier');
        const statusEl = document.getElementById('gate-entry-status');
        const noteEl = document.getElementById('gate-entry-note');
        const actionBtn = document.getElementById('gate-entry-action-btn');
        const recheckBtn = document.getElementById('gate-entry-recheck-btn');

        // Access stack (Explore card anatomy) for real gates; the prose line
        // stays for NONE mode and while loading.
        const showStack = (verb, value, qualifier, paid) => {
            if (verbEl) {
                verbEl.textContent = verb;
                verbEl.className = paid
                    ? 'text-[10px] uppercase tracking-[0.2em] text-[#F6851B]/70'
                    : 'text-[10px] uppercase tracking-[0.2em] text-white/40';
            }
            if (valueEl) valueEl.textContent = value;
            if (qualifierEl) qualifierEl.textContent = qualifier;
            stackEl?.classList.remove('hidden');
            conditionEl?.classList.add('hidden');
        };
        // One line, state-colored: green = access granted, red = blocked,
        // dim = neutral.
        const showStatus = (text, tone) => {
            if (!statusEl) return;
            statusEl.textContent = text;
            statusEl.className = 'mt-4 text-sm text-center ' + (
                tone === 'ok' ? 'text-emerald-400/90'
                    : tone === 'bad' ? 'text-red-400/80'
                        : 'text-white/50');
        };

        if (conditionEl) {
            conditionEl.textContent = 'Loading…';
            conditionEl.classList.remove('hidden');
        }
        stackEl?.classList.add('hidden');
        statusEl?.classList.add('hidden');
        noteEl?.classList.add('hidden');
        actionBtn?.classList.add('hidden');
        recheckBtn?.classList.add('hidden');

        const fmt = (value, decimals) => {
            const s = ethers.formatUnits(value, decimals ?? 0);
            return s.endsWith('.0') ? s.slice(0, -2) : s;
        };
        const finishJoin = async (gateManager) => {
            // The denial that opened this modal is still cached fail-closed
            gateManager.invalidateAccess(entry.gateAddress, authManager.getAddress());
            this.hideGateEntryModal();
            try {
                await entry.retry?.();
            } catch (error) {
                this.showNotification('Failed to join: ' + error.message, 'error');
            }
        };

        // Author visibility — a privacy promise the user must see BEFORE
        // paying or entering. Fire-and-forget: the metadata read is cached.
        const authorsEl = document.getElementById('gate-entry-authors');
        authorsEl?.classList.add('hidden');
        if (entry.streamId && authorsEl) {
            import('../channels.js')
                .then(({ channelManager }) =>
                    channelManager.readGateFromMetadata(entry.streamId, { withMode: true }))
                .then((flags) => {
                    if (!flags) return;
                    const members = flags.wireIdentity === 'sealed';
                    authorsEl.textContent = members
                        ? 'Sealed identity — authors readable by members only'
                        : 'Every message is signed by its author on the wire';
                    authorsEl.className = 'mt-2 text-xs text-center '
                        + (members ? 'text-white/40' : 'text-amber-400/70');
                })
                .catch(() => { /* stays hidden */ });
        }

        try {
            const { gateManager, GATE_MODE } = await import('../gate.js');
            const me = authManager.getAddress();
            const info = await gateManager.getGateInfo(entry.gateAddress);

            if (recheckBtn) {
                recheckBtn.classList.remove('hidden');
                recheckBtn.onclick = () => {
                    gateManager.invalidateAccess(entry.gateAddress, me);
                    this._renderGateEntry();
                };
            }

            if (info.mode === GATE_MODE.NONE) {
                if (conditionEl) conditionEl.textContent =
                    'This is a closed channel — members are added by the owner. Ask the owner to add your address, then check again.';
                return;
            }

            const meta = await gateManager.getTokenMeta(info.token);

            if (info.mode === GATE_MODE.PAID) {
                const days = Number(info.duration) / 86400;
                const daysLabel = Number.isInteger(days) ? days : days.toFixed(1);
                // WPOL-priced gates read POL everywhere the user sees a cost —
                // pay() auto-wraps, plain POL is literally what they spend
                const paySymbol = meta.symbol === 'WPOL' ? 'POL' : meta.symbol;
                showStack('Subscribe', `${fmt(info.price, meta.decimals)} ${paySymbol}`,
                    `per ${daysLabel} ${days === 1 ? 'day' : 'days'}`, true);
                const until = me ? await gateManager.paidUntil(entry.gateAddress, me) : 0n;
                const msLeft = Number(until) * 1000 - Date.now();
                const active = msLeft > 0;
                if (active) {
                    const when = new Date(Number(until) * 1000)
                        .toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
                    showStatus(`Active until ${when} · ${formatRemaining(msLeft)} left`, 'ok');
                } else if (until > 0n) {
                    showStatus('Subscription expired', 'bad');
                } else {
                    showStatus('No active subscription', 'dim');
                }
                if (noteEl && entry.renewal) {
                    noteEl.classList.remove('hidden');
                    noteEl.textContent = 'Renewing extends from the current end.';
                }
                const startPay = async () => {
                    actionBtn.disabled = true;
                    // Renewal: the modal's job ends at the click — the toast
                    // narrates the payment from here. (First-time pay keeps
                    // the modal up: on failure it is the retry context.)
                    if (entry.renewal) this.hideGateEntryModal();
                    try {
                        this.notificationUI?.showLoadingToast('Paying subscription...', 'Confirm may take a moment');
                        await gateManager.pay(entry.gateAddress, (step) => {
                            this.notificationUI?.showLoadingToast(
                                step === 'wrap' ? 'Wrapping POL...'
                                    : step === 'approve' ? 'Approving token...'
                                        : 'Paying subscription...',
                                'Waiting for the transaction'
                            );
                        });
                        this.notificationUI?.hideLoadingToast();
                        await finishJoin(gateManager);
                    } catch (error) {
                        this.notificationUI?.hideLoadingToast();
                        this.showNotification('Payment failed: ' + error.message, 'error');
                        actionBtn.disabled = false;
                    }
                };
                if (actionBtn) {
                    actionBtn.classList.remove('hidden');
                    if (entry.renewal) {
                        actionBtn.textContent = active
                            ? `Renew — ${fmt(info.price, meta.decimals)} ${paySymbol}`
                            : `Pay ${fmt(info.price, meta.decimals)} ${paySymbol}`;
                        actionBtn.onclick = startPay;
                    } else if (active) {
                        actionBtn.textContent = 'Enter Channel';
                        actionBtn.onclick = () => finishJoin(gateManager);
                    } else {
                        actionBtn.textContent = `Pay ${fmt(info.price, meta.decimals)} ${paySymbol}`;
                        actionBtn.onclick = startPay;
                    }
                }
                return;
            }

            // TOKEN_BALANCE / NFT_OWNERSHIP
            const isNft = info.mode === GATE_MODE.NFT_OWNERSHIP;
            showStack('Hold',
                isNft ? `${meta.symbol} NFT` : `${fmt(info.minBalance, meta.decimals)} ${meta.symbol}`,
                'in your wallet', false);
            const balance = me ? await gateManager.getTokenBalance(info.token, me) : 0n;
            const holds = isNft ? balance > 0n : balance >= info.minBalance;
            if (isNft) {
                if (holds) showStatus(`You hold ${balance} · access granted`, 'ok');
                else showStatus('You hold none', 'bad');
            } else {
                const bal = `Balance: ${fmt(balance, meta.decimals)} ${meta.symbol}`;
                showStatus(holds ? `${bal} · access granted` : bal, holds ? 'ok' : 'bad');
            }
            if (holds && actionBtn) {
                actionBtn.classList.remove('hidden');
                actionBtn.textContent = 'Enter Channel';
                actionBtn.onclick = () => finishJoin(gateManager);
            }
        } catch (error) {
            if (conditionEl) conditionEl.textContent = 'Could not read the gate contract: ' + error.message;
        }
    }

    /**
     * Handle create channel
     */
    async handleCreate() {
        const name = this.elements.channelNameInput?.value.trim();
        const activeTab = document.querySelector('.channel-tab-content:not(.hidden)');
        let type = activeTab?.querySelector('.channel-type-input')?.value || 'public';
        const password = this.elements.channelPasswordInput?.value;
        const membersText = this.elements.channelMembersInput?.value;

        // Every non-public tab is gate-backed (N-C, Q7): membership lives in a
        // per-channel PomboGate clone and the tab only picks the mode — Closed
        // is NONE (owner allowlist), Gated is TOKEN/NFT holding, Paid is a
        // subscription (N-D).
        const { gateManager, GATE_MODE } = await import('../gate.js');
        let gateMode = null;
        if (type === 'closed') {
            type = 'gated';
            gateMode = GATE_MODE.NONE;
        } else if (type === 'gated') {
            gateMode = this.currentGateAsset === 'nft'
                ? GATE_MODE.NFT_OWNERSHIP : GATE_MODE.TOKEN_BALANCE;
        } else if (type === 'paid') {
            type = 'gated';
            gateMode = GATE_MODE.PAID;
        }
        const isGated = gateMode !== null;
        const isClosed = gateMode === GATE_MODE.NONE;

        // Exposure and metadata (for visible channels)
        const exposure = isClosed ? 'hidden' : (this.currentExposure || 'hidden');
        const description = exposure === 'visible' ? (this.elements.channelDescriptionInput?.value?.trim() || '') : '';
        const language = exposure === 'visible' ? (this.elements.channelLanguageInput?.value || 'en') : '';
        const category = exposure === 'visible' ? (this.elements.channelCategoryInput?.value || 'general') : '';

        // Classification for Closed channels (stored locally only)
        const classification = isClosed ? (this.currentClassification || 'personal') : null;

        // Storage provider selection
        const storageProvider = this.currentStorageProvider || 'streamr';
        const storageDays = snapRetentionDays(document.getElementById('storage-days-input')?.value || '180');
        let customStorageAddress = null;

        if (storageProvider === 'custom') {
            customStorageAddress = (document.getElementById('custom-storage-address')?.value || '').trim();
            if (!/^0x[a-fA-F0-9]{40}$/.test(customStorageAddress)) {
                this.showCustomAddressError('Enter a valid EVM address (0x followed by 40 hex characters).');
                return;
            }

            try {
                await streamrController.validateCustomStorageNodeAddress(customStorageAddress);
            } catch (error) {
                this.showCustomAddressError(error.message || 'Custom storage provider is not compatible with Pombo web.');
                return;
            }

            this.clearCustomAddressError();
        }
        // Pombo node is always available — no additional check needed

        if (!name) {
            this.showNotification('Please enter a channel name', 'warning');
            return;
        }

        if (type === 'password' && !password) {
            this.showNotification('Please enter a password', 'warning');
            return;
        }

        if (type === 'password' && !this.elements.passwordConfirmSection?.classList.contains('hidden')) {
            this.showNotification('Please confirm the password — retype it to make sure it matches', 'warning');
            this.elements.channelPasswordConfirmInput?.focus();
            return;
        }

        // Gate parameters — validated up front against PomboGate.initialize's
        // per-mode rules: a bad combination would only revert (InvalidParams)
        // after the wallet already paid for the gate deploy attempt.
        const gateOptions = isGated ? { gateMode } : {};
        if (isGated) {
            // Identity on the wire (IMMUTABLE post-creation): Sealed unless
            // the creator opted into Visible.
            gateOptions.wireIdentity =
                document.getElementById('gate-wire-identity-visible')?.checked
                    ? 'visible' : 'sealed';
        }
        if (isGated && !isClosed) {
            const tokenInputId = gateMode === GATE_MODE.PAID ? 'paid-token-input' : 'gate-token-input';
            const token = (document.getElementById(tokenInputId)?.value || '').trim();
            if (!/^0x[a-fA-F0-9]{40}$/.test(token)) {
                this.showNotification('Enter a valid token contract address (0x…)', 'warning');
                return;
            }
            let meta;
            try {
                [meta] = await Promise.all([
                    gateManager.getTokenMeta(token),
                    // An address without a working balanceOf would create a
                    // gate that fails checkAccess for everyone, forever.
                    gateManager.getTokenBalance(token, authManager.getAddress())
                ]);
            } catch (error) {
                this.showNotification('That address does not look like a token contract on Polygon', 'warning');
                this.Logger?.warn('Gate token validation failed:', error);
                return;
            }
            gateOptions.gateToken = token;

            if (gateMode === GATE_MODE.TOKEN_BALANCE) {
                const raw = (document.getElementById('gate-min-balance-input')?.value || '').trim();
                let minBalance = 0n;
                try {
                    minBalance = ethers.parseUnits(raw, meta.decimals ?? 0);
                } catch { /* leave 0n — rejected below */ }
                if (minBalance <= 0n) {
                    this.showNotification('Enter a minimum balance greater than zero', 'warning');
                    return;
                }
                gateOptions.gateMinBalance = minBalance;
            } else if (gateMode === GATE_MODE.PAID) {
                if (meta.decimals === null) {
                    this.showNotification('The payment token must be an ERC-20 contract', 'warning');
                    return;
                }
                const rawPrice = (document.getElementById('paid-price-input')?.value || '').trim();
                let price = 0n;
                try {
                    price = ethers.parseUnits(rawPrice, meta.decimals);
                } catch { /* leave 0n — rejected below */ }
                if (price <= 0n) {
                    this.showNotification('Enter a price greater than zero', 'warning');
                    return;
                }
                const days = parseInt(document.getElementById('paid-duration-input')?.value || '0', 10);
                if (!Number.isFinite(days) || days < 1) {
                    this.showNotification('Enter a subscription period of at least 1 day', 'warning');
                    return;
                }
                gateOptions.gatePrice = price;
                gateOptions.gateDuration = BigInt(days) * 86400n;
            }
        }

        const members = isClosed
            ? (membersText || '').split('\n').map(m => m.trim()).filter(m => m)
            : [];
        
        const options = {
            exposure,
            description,
            language,
            category,
            classification,
            readOnly: this.currentReadOnly || false,
            storageProvider,
            customStorageAddress,
            storageDays,
            ...gateOptions
        };

        this.Logger?.debug('Creating channel:', { name, type, password: password ? '***' : null, members, options });

        // ─── Pre-flight balance check ──────────────────────────────────────
        // Block on zero balance; warn (with confirmation) when balance is
        // close to the estimated cost. Margin: require 1.5× the estimate as
        // "safe"; below that we ask the user to confirm.
        const SAFETY_MULTIPLIER = 1.5;
        try {
            const address = authManager.getAddress();
            if (address) {
                const [balanceWei, estimates] = await Promise.all([
                    GasEstimator.getBalance(address),
                    GasEstimator.estimateCosts()
                ]);
                const estimateWei = isGated ? estimates.native : estimates.public;
                const formattedEstimate = isGated ? estimates.formatted.gated : estimates.formatted.public;
                const formattedBalance = GasEstimator.formatBalancePOL(balanceWei);

                if (balanceWei === null) {
                    // RPC failed — don't block, just log. The user can still try.
                    this.Logger?.warn('Could not fetch balance for pre-flight check; proceeding anyway');
                } else if (balanceWei === 0) {
                    this.showNotification(
                        `No POL in wallet — channel creation costs about ${formattedEstimate}. Top up and try again.`,
                        'error',
                        6000
                    );
                    return;
                } else if (balanceWei < estimateWei) {
                    this.showNotification(
                        `Insufficient POL: balance ${formattedBalance} is below the estimated cost (${formattedEstimate}).`,
                        'error',
                        6000
                    );
                    return;
                } else if (balanceWei < estimateWei * SAFETY_MULTIPLIER) {
                    const confirmed = await this.notificationUI?.showConfirmToast?.(
                        'Low POL balance',
                        `Your balance (${formattedBalance}) is close to the estimated cost (${formattedEstimate}). If gas spikes, the transaction may fail. Continue anyway?`,
                        { confirmLabel: 'Create anyway', cancelLabel: 'Cancel', variant: 'warning' }
                    );
                    if (!confirmed) {
                        this.Logger?.debug('Channel creation cancelled by user (low balance)');
                        return;
                    }
                }
            }
        } catch (preflightError) {
            // Never block creation on pre-flight errors — user already filled the form
            this.Logger?.warn('Balance pre-flight check failed (continuing):', preflightError);
        }

        try {
            // Total on-chain steps. Every type has the -5, and the -2 is the
            // only stream with no storage:
            //   public/password: 4× createStream + 4× setPermissions
            //        + 3× addToStorageNode + 3× setStorageDayCount = 14
            //   gated: gate deploy + 5× createStream + 5× setPermissions
            //        + 4× addToStorageNode + 4× setStorageDayCount = 19
            const streamCount = isGated ? 5 : 4;
            // A closed channel created with an initial member list allows them
            // in one extra transaction (gate allowBatch).
            const totalSteps = isGated ? (members.length ? 20 : 19) : 14;
            this.notificationUI?.showLoadingToast(
                'Creating channel...',
                'This may take a minute',
                { steps: totalSteps, initialLabel: 'Creating Channel...' }
            );

            // Map step index -> phase label.
            // [1; N] Creating Channel · [N+1; 2N] Setting Permissions · [2N+1; total] Setting Storage
            const labelForStep = (s) => {
                if (s <= streamCount) return 'Creating Channel...';
                if (s <= streamCount * 2) return 'Setting Permissions...';
                return 'Setting Storage...';
            };

            let currentStep = 0;
            const onProgress = () => {
                currentStep += 1;
                this.notificationUI?.setLoadingProgress(currentStep, labelForStep(currentStep));
            };

            this.hide();
            
            const channel = await this.channelManager.createChannel(name, type, password, members, {
                ...options,
                onProgress
            });
            this.Logger?.debug('Channel created in UI:', channel);

            this.deps.renderChannelList?.();

            // Auto-select the new channel
            if (channel) {
                setTimeout(() => {
                    this.deps.selectChannel?.(channel.streamId);
                }, 100);
            }

            this.showNotification('Channel created successfully!', 'success');
        } catch (error) {
            this.showNotification('Failed to create channel: ' + error.message, 'error');
        } finally {
            this.notificationUI?.hideLoadingToast();
        }
    }
}

// Create singleton instance
const channelModalsUI = new ChannelModalsUI();

export { channelModalsUI, ChannelModalsUI };
