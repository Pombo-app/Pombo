/**
 * Modal Manager
 * Handles showing/hiding modals and common modal operations
 * Integrates with browser history for back button support on mobile
 */

class ModalManager {
    constructor() {
        // Pending data storage for modals that need confirmation
        this.pendingData = {};
        this.deps = {};
        
        // Stack of open modals (for history integration)
        this.modalStack = [];
        
        // Callbacks to invoke when a modal is hidden
        this.onHideCallbacks = new Map();
        
        // Modals that should integrate with browser history (back button closes them)
        // These are "navigation" modals that take over the screen, especially on mobile
        this.historyModals = new Set([
            'new-channel-modal',
            'settings-modal',
            'channel-settings-modal',
            'contacts-modal',
            'join-channel-modal',
            'join-closed-channel-modal',
            'invite-users-modal',
            'dm-inbox-setup-modal',
            'new-dm-modal',
            'wallet-modal'
        ]);
        
        // Flag to prevent recursive popstate handling
        this._handlingPopState = false;
        
        // Initialize popstate listener (capture phase to intercept before historyManager)
        this._initHistoryListener();
    }

    /**
     * Initialize browser history listener for back button support
     * Uses capture phase to intercept before other listeners
     * @private
     */
    _initHistoryListener() {
        window.addEventListener('popstate', (event) => {
            // Check if this is a modal state we pushed
            if (event.state && event.state.modal) {
                // This is handled - modal was closed via back button
                // The modal should already be closed by our other handler
                return;
            }
            
            // Check if we have modals open that need to be closed first
            if (this._handlingPopState) return;
            
            const topModal = this.modalStack[this.modalStack.length - 1];
            if (topModal && this.historyModals.has(topModal)) {
                this._handlingPopState = true;
                
                // Close the top modal without touching history (popstate already happened)
                this._hideWithoutHistory(topModal);
                
                // Push the state back to prevent actual navigation
                // This keeps the user on the current view
                window.history.pushState(event.state, '');
                
                this._handlingPopState = false;
                
                // Stop propagation to prevent historyManager from navigating
                event.stopImmediatePropagation();
            }
        }, true); // Use capture phase
    }

    /**
     * Set dependencies
     * @param {Object} deps - { showNotification }
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * Show a modal by ID
     * @param {string} modalId - Modal element ID
     * @param {Object} options - Optional config { focusElement, clearInputs, skipHistory }
     */
    show(modalId, options = {}) {
        const modal = document.getElementById(modalId);
        if (!modal) return;
        
        modal.classList.remove('hidden');
        
        // Clear inputs if specified
        if (options.clearInputs) {
            modal.querySelectorAll('input').forEach(input => {
                if (input.type === 'checkbox') {
                    input.checked = false;
                } else {
                    input.value = '';
                }
            });
        }
        
        // Focus element if specified
        if (options.focusElement) {
            const focusEl = modal.querySelector(options.focusElement);
            focusEl?.focus();
        }
        
        // Add to stack and push history state for supported modals
        if (this.historyModals.has(modalId) && !options.skipHistory) {
            // Only add to stack if not already there
            if (!this.modalStack.includes(modalId)) {
                this.modalStack.push(modalId);
                // Push a history state so back button can close the modal
                window.history.pushState({ modal: modalId }, '');
            }
        }
    }

    /**
     * Register a callback to be invoked when a modal is hidden
     * @param {string} modalId - Modal element ID
     * @param {Function} callback - Callback to invoke on hide
     */
    registerOnHide(modalId, callback) {
        this.onHideCallbacks.set(modalId, callback);
    }

    /**
     * Hide a modal by ID
     * @param {string} modalId - Modal element ID
     * @param {Object} options - Optional config { skipHistory: boolean }
     */
    hide(modalId, options = {}) {
        const modal = document.getElementById(modalId);
        if (!modal) return;
        
        const wasVisible = !modal.classList.contains('hidden');
        modal.classList.add('hidden');
        
        // Invoke onHide callback if registered
        if (wasVisible) {
            this.onHideCallbacks.get(modalId)?.();
        }
        
        // Remove from stack and go back in history if this modal was tracking history
        if (wasVisible && this.historyModals.has(modalId)) {
            const stackIndex = this.modalStack.indexOf(modalId);
            if (stackIndex !== -1) {
                this.modalStack.splice(stackIndex, 1);
                // Go back to remove the history entry we added
                // Skip if: handling popstate, or skipHistory option is set (e.g., switching modals)
                if (!this._handlingPopState && !options.skipHistory) {
                    window.history.back();
                }
            }
        }
    }
    
    /**
     * Hide modal without touching browser history (used during popstate)
     * @param {string} modalId - Modal element ID
     * @private
     */
    _hideWithoutHistory(modalId) {
        const modal = document.getElementById(modalId);
        const wasVisible = modal && !modal.classList.contains('hidden');
        
        if (modal) {
            modal.classList.add('hidden');
        }
        
        // Invoke onHide callback if registered
        if (wasVisible) {
            this.onHideCallbacks.get(modalId)?.();
        }
        
        // Remove from stack
        const stackIndex = this.modalStack.indexOf(modalId);
        if (stackIndex !== -1) {
            this.modalStack.splice(stackIndex, 1);
        }
    }
    
    /**
     * Check if any history-tracked modal is currently open
     * @returns {boolean}
     */
    hasOpenHistoryModal() {
        return this.modalStack.length > 0;
    }

    /**
     * Toggle modal visibility
     * @param {string} modalId - Modal element ID
     */
    toggle(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.toggle('hidden');
        }
    }

    /**
     * Check if modal is visible
     * @param {string} modalId - Modal element ID
     * @returns {boolean}
     */
    isVisible(modalId) {
        const modal = document.getElementById(modalId);
        return modal && !modal.classList.contains('hidden');
    }

    /**
     * Set pending data for a modal
     * @param {string} key - Data key
     * @param {*} value - Data value
     */
    setPendingData(key, value) {
        this.pendingData[key] = value;
    }

    /**
     * Get pending data
     * @param {string} key - Data key
     * @returns {*}
     */
    getPendingData(key) {
        return this.pendingData[key];
    }

    /**
     * Clear pending data
     * @param {string} key - Data key (optional, clears all if not provided)
     */
    clearPendingData(key) {
        if (key) {
            delete this.pendingData[key];
        } else {
            this.pendingData = {};
        }
    }

    /**
     * Show join channel modal
     * @param {HTMLElement} modal - Modal element
     * @param {HTMLElement} streamIdInput - Stream ID input
     * @param {HTMLElement} passwordInput - Password input
     * @param {HTMLElement} passwordField - Password field container
     */
    showJoinChannelModal(modal, streamIdInput, passwordInput, passwordField) {
        modal?.classList.remove('hidden');
        if (streamIdInput) streamIdInput.value = '';
        if (passwordInput) {
            passwordInput.value = '';
            passwordInput.type = 'password';
            passwordInput.style.webkitTextSecurity = 'disc';
        }
        passwordField?.classList.add('hidden');
        
        // Reset join password eye icons
        const joinEyeOpen = document.getElementById('join-pw-eye-open');
        const joinEyeOff = document.getElementById('join-pw-eye-off');
        if (joinEyeOpen) joinEyeOpen.classList.remove('hidden');
        if (joinEyeOff) joinEyeOff.classList.add('hidden');

        const checkbox = document.getElementById('join-has-password');
        if (checkbox) checkbox.checked = false;
    }

    /**
     * Show join closed channel modal
     * @param {string} streamId - Pre-filled stream ID
     */
    showJoinClosedChannelModal(streamId = '') {
        const modal = document.getElementById('join-closed-channel-modal');
        const idInput = document.getElementById('join-closed-stream-id-input');
        const nameInput = document.getElementById('join-closed-name-input');
        
        if (idInput) idInput.value = streamId;
        if (nameInput) nameInput.value = '';
        
        modal?.classList.remove('hidden');
    }

    /**
     * Show add contact modal
     * @param {string} address - Contact address
     */
    showAddContactModal(address) {
        const modal = document.getElementById('add-contact-nickname-modal');
        const addressDisplay = document.getElementById('add-contact-modal-address');
        const nicknameInput = document.getElementById('add-contact-modal-nickname');
        
        if (!modal || !addressDisplay || !nicknameInput) return;
        
        this.setPendingData('contactAddress', address);
        addressDisplay.textContent = address;
        nicknameInput.value = '';
        
        modal.classList.remove('hidden');
        nicknameInput.focus();
    }

    /**
     * Hide add contact modal
     */
    hideAddContactModal() {
        this.hide('add-contact-nickname-modal');
        this.clearPendingData('contactAddress');
    }

    /**
     * Show edit contact modal
     * @param {string} address - Contact address
     * @param {string} nickname - Existing nickname
     */
    showEditContactModal(address, nickname = '') {
        const modal = document.getElementById('edit-contact-modal');
        const addressDisplay = document.getElementById('edit-contact-modal-address');
        const nicknameInput = document.getElementById('edit-contact-modal-nickname');

        if (!modal || !addressDisplay || !nicknameInput) return;

        this.setPendingData('editContactAddress', address);
        addressDisplay.textContent = address;
        nicknameInput.value = nickname || '';

        modal.classList.remove('hidden');
        nicknameInput.focus();
        nicknameInput.select();
    }

    /**
     * Hide edit contact modal
     */
    hideEditContactModal() {
        this.hide('edit-contact-modal');
        this.clearPendingData('editContactAddress');
    }

    /**
     * Show remove contact modal
     * @param {string} address - Contact address
     * @param {Function} callback - Callback after removal
     */
    showRemoveContactModal(address, callback = null) {
        const modal = document.getElementById('remove-contact-modal');
        const addressDisplay = document.getElementById('remove-contact-modal-address');
        
        if (!modal || !addressDisplay) return;
        
        this.setPendingData('removeContactAddress', address);
        this.setPendingData('removeContactCallback', callback);
        addressDisplay.textContent = address;
        
        modal.classList.remove('hidden');
    }

    /**
     * Hide remove contact modal
     */
    hideRemoveContactModal() {
        this.hide('remove-contact-modal');
        this.clearPendingData('removeContactAddress');
        this.clearPendingData('removeContactCallback');
    }



    /**
     * Hide new channel modal
     */
    hideNewChannelModal() {
        this.hide('new-channel-modal');
    }

}

// Export singleton instance
export const modalManager = new ModalManager();
