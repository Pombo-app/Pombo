/**
 * DM Modals UI
 * Handles DM inbox creation button and new-DM modal
 */

import { GasEstimator } from './GasEstimator.js';
import { authManager } from '../auth.js';
import { streamrController } from '../streamr.js';
import { snapRetentionDays, retentionLabel } from '../utils/retention.js';

class DMModalsUI {
    constructor() {
        this.deps = {};
        this.selectedStorageProvider = 'streamr';
        this.selectedStorageDays = 180;
    }

    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    get dmManager() { return this.deps.dmManager; }
    get modalManager() { return this.deps.modalManager; }
    get authManager() { return this.deps.authManager; }
    get notificationUI() { return this.deps.notificationUI; }
    get Logger() { return this.deps.Logger; }

    showNotification(message, type) {
        this.deps.showNotification?.(message, type);
    }

    init() {
        // Inbox setup button
        const openDmBtn = document.getElementById('open-dm-btn');
        if (openDmBtn) {
            openDmBtn.addEventListener('click', () => this.showCreateInboxModal());
        }

        // New DM button
        const newDmBtn = document.getElementById('new-dm-btn');
        if (newDmBtn) {
            newDmBtn.addEventListener('click', () => this.showNewDMModal());
        }

        // Modal buttons
        const cancelDmBtn = document.getElementById('cancel-dm-btn');
        if (cancelDmBtn) {
            cancelDmBtn.addEventListener('click', () => this.hideNewDMModal());
        }

        const startDmBtn = document.getElementById('start-dm-btn');
        if (startDmBtn) {
            startDmBtn.addEventListener('click', () => this.handleStartDM());
        }

        // Enter key in address input
        const addressInput = document.getElementById('dm-address-input');
        if (addressInput) {
            addressInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.handleStartDM();
            });
        }

        // Close modal on backdrop click
        const modal = document.getElementById('new-dm-modal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) this.hideNewDMModal();
            });
        }

        // Initialize DM Inbox Setup Modal
        this.initCreateInboxModal();
    }

    /**
     * Initialize DM Inbox Setup Modal handlers
     */
    initCreateInboxModal() {
        const modal = document.getElementById('dm-inbox-setup-modal');
        if (!modal) return;

        // Close buttons
        const cancelBtn = document.getElementById('cancel-dm-inbox-btn');
        const cancelBtnFooter = document.getElementById('cancel-dm-inbox-btn-footer');
        
        cancelBtn?.addEventListener('click', () => this.hideCreateInboxModal());
        cancelBtnFooter?.addEventListener('click', () => this.hideCreateInboxModal());

        // Backdrop click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.hideCreateInboxModal();
        });

        // Create button
        const createBtn = document.getElementById('create-dm-inbox-btn');
        createBtn?.addEventListener('click', () => this.handleCreateInbox());

        // Storage provider tabs
        const storageTabs = modal.querySelectorAll('.dm-storage-provider-tab');
        storageTabs.forEach(tab => {
            tab.addEventListener('click', () => this.selectStorageProvider(tab.dataset.dmStorage));
        });

        // Storage days slider
        const storageDaysSlider = document.getElementById('dm-storage-days-input');
        if (storageDaysSlider) {
            this.updateSliderProgress(storageDaysSlider);
            storageDaysSlider.addEventListener('input', () => {
                this.selectedStorageDays = this.updateStorageDaysDisplay(storageDaysSlider.value);
                this.updateSliderProgress(storageDaysSlider);
            });
        }

        // Custom storage address input — clear error on edit
        const customStorageAddrInput = document.getElementById('dm-custom-storage-address');
        customStorageAddrInput?.addEventListener('input', () => {
            this.clearCustomAddressError();
        });

        // Learn more buttons - open storage info modal
        const learnMoreBtns = modal.querySelectorAll('.dm-storage-learn-more-btn');
        learnMoreBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                this.modalManager?.show('storage-info-modal');
            });
        });
    }

    /**
     * Select storage provider
     */
    selectStorageProvider(provider) {
        this.selectedStorageProvider = provider;

        const tabs = document.querySelectorAll('.dm-storage-provider-tab');
        tabs.forEach(tab => {
            const isActive = tab.dataset.dmStorage === provider;
            tab.classList.toggle('bg-white/10', isActive);
            tab.classList.toggle('text-white', isActive);
            tab.classList.toggle('border-white/10', isActive);
            tab.classList.toggle('bg-white/5', !isActive);
            tab.classList.toggle('text-white/50', !isActive);
            tab.classList.toggle('border-white/5', !isActive);
        });

        const streamrAddressDisplay = document.getElementById('dm-streamr-address-display');
        const customAddressSection = document.getElementById('dm-custom-address-section');

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

    refreshStreamrAddress() {
        const target = document.getElementById('dm-streamr-address-value');
        if (!target) return;
        target.textContent = '0xae340e799e8151f6a4999d245e466197aa217667';
        target.classList.remove('text-red-400');
        target.classList.add('text-white/50');
    }

    showCustomAddressError(message) {
        const errorEl = document.getElementById('dm-custom-storage-address-error');
        const inputEl = document.getElementById('dm-custom-storage-address');
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.classList.remove('hidden');
        }
        inputEl?.classList.add('border-red-500/50');
    }

    clearCustomAddressError() {
        const errorEl = document.getElementById('dm-custom-storage-address-error');
        const inputEl = document.getElementById('dm-custom-storage-address');
        errorEl?.classList.add('hidden');
        inputEl?.classList.remove('border-red-500/50');
    }

    /**
     * Update storage days display. The slider stays a proportional 1-365 day
     * range; above the 30-day mark the effective value is magnet-snapped to
     * the nearest exact month, and the thumb snaps along with it.
     */
    updateStorageDaysDisplay(rawDays) {
        const days = snapRetentionDays(rawDays);
        const slider = document.getElementById('dm-storage-days-input');
        if (slider && slider.value !== String(days)) slider.value = String(days);

        const display = document.getElementById('dm-storage-days-value');
        if (display) display.textContent = retentionLabel(days);

        return days;
    }

    /**
     * Update slider progress CSS variable so the track color follows the thumb
     */
    updateSliderProgress(slider) {
        const min = parseFloat(slider.min) || 0;
        const max = parseFloat(slider.max) || 100;
        const val = parseFloat(slider.value) || 0;
        const percent = ((val - min) / (max - min)) * 100;
        slider.style.setProperty('--slider-progress', `${percent}%`);
    }

    /**
     * Update gas cost estimate in the modal
     */
    updateGasEstimate() {
        const costEl = document.getElementById('dm-inbox-cost');
        if (!costEl) return;

        // Show loading state
        costEl.textContent = '...';

        GasEstimator.estimateCosts()
            .then(estimates => {
                costEl.textContent = estimates.formatted.dmInbox;
                costEl.dataset.tooltip = `Gas: ${estimates.formatted.gasPrice}`;
            })
            .catch(error => {
                this.Logger?.warn('Failed to estimate DM inbox gas cost:', error);
                costEl.textContent = '~0.15 POL';
                costEl.dataset.tooltip = 'Gas: ~120 gwei';
            });
    }

    /**
     * Show Create Inbox Modal
     */
    showCreateInboxModal() {
        // Reset to defaults
        this.selectedStorageProvider = 'streamr';
        this.selectedStorageDays = 180;
        this.selectedCustomStorageAddress = '';

        // Reset UI
        this.selectStorageProvider('streamr');
        const slider = document.getElementById('dm-storage-days-input');
        if (slider) {
            slider.value = '180';
            this.updateSliderProgress(slider);
        }
        this.updateStorageDaysDisplay(180);
        const customAddrInput = document.getElementById('dm-custom-storage-address');
        if (customAddrInput) customAddrInput.value = '';
        this.clearCustomAddressError();
        
        // Update gas estimate
        this.updateGasEstimate();
        
        this.modalManager?.show('dm-inbox-setup-modal');
        // Hide pill nav on mobile while modal is open
        document.getElementById('mobile-pill-nav')?.classList.add('hidden');
    }

    /**
     * Hide Create Inbox Modal
     */
    hideCreateInboxModal() {
        this.modalManager?.hide('dm-inbox-setup-modal');
        // Restore pill nav on mobile
        document.getElementById('mobile-pill-nav')?.classList.remove('hidden');
    }

    /**
     * Update sidebar DM buttons visibility based on inbox state
     */
    async updateVisibility() {
        const setupWrap = document.getElementById('dm-inbox-setup');
        const newBtnWrap = document.getElementById('dm-new-btn-wrap');

        if (!this.dmManager || !this.authManager) {
            setupWrap?.classList.add('hidden');
            newBtnWrap?.classList.add('hidden');
            return;
        }

        // Only show for non-guest connected users
        if (!this.authManager.isConnected() || this.authManager.isGuestMode?.()) {
            setupWrap?.classList.add('hidden');
            newBtnWrap?.classList.add('hidden');
            return;
        }

        const hasInbox = await this.dmManager.hasInbox();

        if (hasInbox) {
            setupWrap?.classList.add('hidden');
            newBtnWrap?.classList.remove('hidden');
        } else {
            setupWrap?.classList.remove('hidden');
            newBtnWrap?.classList.add('hidden');
        }
    }

    /**
     * Handle "Create DM Inbox" button click — creates inbox streams with selected options
     */
    async handleCreateInbox() {
        const btn = document.getElementById('create-dm-inbox-btn');
        if (!btn) return;

        let customStorageAddress = null;
        if (this.selectedStorageProvider === 'custom') {
            customStorageAddress = (document.getElementById('dm-custom-storage-address')?.value || '').trim();
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

        const options = {
            storageProvider: this.selectedStorageProvider,
            customStorageAddress,
            storageDays: this.selectedStorageDays
        };

        // ─── Pre-flight balance check ──────────────────────────────────────
        // Block on zero/insufficient; warn (with confirmation) when balance is
        // close to the estimated cost. Margin: require 1.5× the estimate.
        const SAFETY_MULTIPLIER = 1.5;
        try {
            const address = authManager.getAddress?.() || this.authManager?.getAddress?.();
            if (address) {
                const [balanceWei, estimates] = await Promise.all([
                    GasEstimator.getBalance(address),
                    GasEstimator.estimateCosts()
                ]);
                const estimateWei = estimates.dmInbox;
                const formattedEstimate = estimates.formatted.dmInbox;
                const formattedBalance = GasEstimator.formatBalancePOL(balanceWei);

                if (balanceWei === null) {
                    this.Logger?.warn('Could not fetch balance for DM inbox pre-flight check; proceeding anyway');
                } else if (balanceWei === 0) {
                    this.showNotification(
                        `No POL in wallet — DM inbox creation costs about ${formattedEstimate}. Top up and try again.`,
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
                        this.Logger?.debug('DM inbox creation cancelled by user (low balance)');
                        return;
                    }
                }
            }
        } catch (preflightError) {
            this.Logger?.warn('Balance pre-flight check failed (continuing):', preflightError);
        }

        // Close modal immediately and show loading toast with progress ring
        this.hideCreateInboxModal();

        // Total on-chain steps:
        //   2× createStream + 2× setPermissions + addToStorageNode (= 5)
        //   + setStorageDayCount when provider supports TTL (Streamr) -> 6 total
        const totalSteps = options.storageProvider === 'streamr' ? 6 : 5;
        this.notificationUI?.showLoadingToast(
            'Creating DM inbox...',
            'This may take a minute',
            { steps: totalSteps, initialLabel: 'Creating Inbox...' }
        );

        // [1; 2] Creating Inbox · [3; 4] Setting Permissions · [5; total] Setting Storage
        const labelForStep = (s) => {
            if (s <= 2) return 'Creating Inbox...';
            if (s <= 4) return 'Setting Permissions...';
            return 'Setting Storage...';
        };

        let currentStep = 0;
        const onProgress = () => {
            currentStep += 1;
            this.notificationUI?.setLoadingProgress(currentStep, labelForStep(currentStep));
        };

        try {
            await this.dmManager.createInbox({ ...options, onProgress });
            this.showNotification('DM inbox created!', 'success');
            await this.updateVisibility();
            document.dispatchEvent(new CustomEvent('pombo:dm-inbox-ready'));
        } catch (err) {
            this.Logger?.error('DMModalsUI: Failed to create inbox', err);
            this.showNotification('Failed to create DM inbox', 'error');
        } finally {
            this.notificationUI?.hideLoadingToast();
        }
    }

    /**
     * Show the "New DM" modal
     */
    showNewDMModal() {
        this.modalManager?.show('new-dm-modal', {
            clearInputs: true,
            focusElement: '#dm-address-input'
        });
    }

    /**
     * Show the "New DM" modal pre-filled with an address
     */
    showNewDMModalWithAddress(address) {
        this.showNewDMModal();
        const input = document.getElementById('dm-address-input');
        if (input) input.value = address;
    }

    /**
     * Hide the "New DM" modal
     */
    hideNewDMModal() {
        this.modalManager?.hide('new-dm-modal');
    }

    /**
     * Handle "Start DM" button in the modal
     */
    async handleStartDM() {
        const addressInput = document.getElementById('dm-address-input');
        const nameInput = document.getElementById('dm-localname-input');
        const btn = document.getElementById('start-dm-btn');

        const address = addressInput?.value.trim();
        const localName = nameInput?.value.trim() || undefined;

        if (!address) {
            this.showNotification('Enter an address or ENS name', 'error');
            return;
        }

        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Starting...';
        }

        try {
            await this.dmManager.startDM(address, localName);
            this.hideNewDMModal();
            this.deps.renderChannelList?.();
        } catch (err) {
            this.Logger?.error('DMModalsUI: startDM failed', err);
            this.showNotification(err.message || 'Failed to start DM', 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Start DM';
            }
        }
    }

    /**
     * Hide all DM sidebar elements (disconnect cleanup)
     */
    hideAll() {
        document.getElementById('dm-inbox-setup')?.classList.add('hidden');
        document.getElementById('dm-new-btn-wrap')?.classList.add('hidden');
    }
}

export const dmModalsUI = new DMModalsUI();
