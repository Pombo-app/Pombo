/**
 * ContactsUI
 * Manages the contacts modal, the trusted contacts list, and the
 * Add/Remove Contact confirmation modals.
 *
 * The message right-click context menu lives in MessageContextMenuUI.
 */

import { modalManager } from './ModalManager.js';
import { dropdownManager } from './DropdownManager.js';
import { escapeHtml, escapeAttr, formatAddress } from './utils.js';
import { getAvatarHtml } from './AvatarGenerator.js';
import { sanitizeText } from './sanitizer.js';

class ContactsUI {
    constructor() {
        this.deps = null;
        this.elements = null;
        this.initialized = false;
        this._pendingContactAddress = null;
        this._pendingEditContactAddress = null;
        this._pendingRemoveContactAddress = null;
        this._onRemoveContactCallback = null;
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
    }

    /**
     * Initialize contacts UI elements and listeners
     */
    init() {
        this.elements ??= {};

        // Cache additional elements
        this.elements.contactsModal = document.getElementById('contacts-modal');
        this.elements.contactsList = document.getElementById('contacts-list');
        this.elements.addContactBtn = document.getElementById('add-contact-btn');
        this.elements.addContactAddress = document.getElementById('add-contact-address');
        this.elements.addContactNickname = document.getElementById('add-contact-nickname');
        this.elements.closeContactsBtn = document.getElementById('close-contacts-btn');

        if (this.initialized) {
            return;
        }

        // Contacts modal listeners
        if (this.elements.addContactBtn) {
            this.elements.addContactBtn.addEventListener('click', () => this.handleAddContact());
        }
        if (this.elements.closeContactsBtn) {
            this.elements.closeContactsBtn.addEventListener('click', () => this.hide());
        }

        // Register onHide callback for back button and programmatic hide
        modalManager.registerOnHide('contacts-modal', () => this._cleanupOnHide());
        this.initialized = true;
    }

    /**
     * Ensure DOM elements are available before rendering
     * @returns {boolean}
     */
    ensureElements() {
        if (!this.elements || !this.elements.contactsList || !this.elements.contactsModal) {
            this.init();
        }
        return Boolean(this.elements?.contactsList);
    }

    /**
     * Show contacts modal
     */
    show() {
        if (!this.ensureElements()) {
            return;
        }
        this.renderList();
        // Add contacts-open class for mobile
        if (window.innerWidth < 768) {
            // Add contacts-open class FIRST (before closing settings)
            // so that settings _cleanupOnHide knows we're switching tabs
            document.body.classList.add('contacts-open');
            
            // Close settings modal if open (always use modalManager to keep stack in sync)
            // Use skipHistory to prevent async history.back() from closing contacts modal
            if (modalManager.isVisible('settings-modal')) {
                if (this.deps?.settingsUI?.hide) {
                    this.deps.settingsUI.hide({ skipHistory: true });
                } else {
                    // Fallback: use modalManager to ensure stack stays in sync
                    modalManager.hide('settings-modal', { skipHistory: true });
                    document.body.classList.remove('settings-open');
                }
            }
            // Update pill nav active tab
            document.querySelectorAll('.pill-nav-item[data-pill-tab]').forEach(item => {
                item.classList.toggle('active', item.dataset.pillTab === 'contacts');
            });
        }
        modalManager.show('contacts-modal');
    }

    /**
     * Hide contacts modal
     * @param {Object} options - Optional config { skipHistory: boolean }
     */
    hide(options = {}) {
        modalManager.hide('contacts-modal', options);
    }

    /**
     * Cleanup when contacts modal is hidden (called by modalManager callback)
     * @private
     */
    _cleanupOnHide() {
        // Remove contacts-open class for mobile
        document.body.classList.remove('contacts-open');
        // Only reset pill nav to chats if still on contacts tab
        // If pill was already switched (e.g. to explore), don't override
        const activeTab = document.querySelector('.pill-nav-item[data-pill-tab].active');
        if (!activeTab || activeTab.dataset.pillTab === 'contacts') {
            if (!document.body.classList.contains('settings-open')) {
                document.querySelectorAll('.pill-nav-item[data-pill-tab]').forEach(item => {
                    item.classList.toggle('active', item.dataset.pillTab === 'chats');
                });
            }
        }
        // Clear inputs
        if (this.elements.addContactAddress) this.elements.addContactAddress.value = '';
        if (this.elements.addContactNickname) this.elements.addContactNickname.value = '';
    }

    /**
     * Render contacts list
     */
    renderList() {
        if (!this.ensureElements()) {
            return;
        }

        const { identityManager } = this.deps;
        if (!identityManager || !this.elements.contactsList) {
            return;
        }

        const contacts = identityManager.getAllTrustedContacts();
        
        if (contacts.length === 0) {
            this.elements.contactsList.innerHTML = `
                <div class="text-center text-white/25 py-8 text-[13px]">No contacts yet</div>
            `;
            return;
        }

        this.elements.contactsList.innerHTML = contacts.map(contact => {
            const avatarUrl = identityManager.getCachedENSAvatar(contact.address);
            const avatarHtml = getAvatarHtml(contact.address, 36, 0.5, avatarUrl);
            const displayName = sanitizeText(contact.nickname) || formatAddress(contact.address);

            return `
                <div class="flex items-center justify-between p-3 bg-white/[0.05] border border-white/[0.08] rounded-xl">
                    <div class="flex items-center gap-3 flex-1 min-w-0">
                        <div class="flex-shrink-0" style="width:36px;height:36px;border-radius:9999px;overflow:hidden;">${avatarHtml}</div>
                        <div class="flex-1 min-w-0">
                            <span class="text-[13px] font-medium text-white truncate block">${escapeHtml(displayName)}</span>
                            <div class="text-[10px] text-white/30 font-mono truncate mt-0.5">${escapeHtml(contact.address)}</div>
                        </div>
                    </div>
                    <button 
                        class="contact-menu-btn ml-2 text-white/25 hover:text-white/70 hover:bg-white/5 p-1.5 rounded-lg transition"
                        data-address="${escapeAttr(contact.address)}"
                        title="Contact options"
                    >
                        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z"/>
                        </svg>
                    </button>
                </div>
            `;
        }).join('');

        this.elements.contactsList.querySelectorAll('.contact-menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const address = e.currentTarget.dataset.address;
                const contact = identityManager.getTrustedContact(address);
                if (!contact) return;

                dropdownManager.showContactDropdown(e, e.currentTarget, contact, async (action) => {
                    if (action === 'edit-contact') {
                        this.showEditModal(contact.address);
                        return;
                    }

                    if (action === 'send-dm') {
                        const { dmModalsUI } = await import('./DMModalsUI.js');
                        dmModalsUI.showNewDMModalWithAddress(contact.address);
                        return;
                    }

                    if (action === 'copy-address') {
                        try {
                            await navigator.clipboard.writeText(contact.address);
                            this.deps.showNotification?.('Address copied', 'success');
                        } catch {
                            this.deps.showNotification?.('Failed to copy', 'error');
                        }
                        return;
                    }

                    if (action === 'remove-contact') {
                        this.showRemoveModal(contact.address);
                    }
                });
            });
        });
    }

    /**
     * Handle add contact
     */
    async handleAddContact() {
        const { identityManager, showNotification, showLoading, hideLoading } = this.deps;
        
        const addressOrEns = this.elements.addContactAddress?.value.trim();
        const nickname = this.elements.addContactNickname?.value.trim();

        if (!addressOrEns) {
            showNotification('Please enter an address or ENS name', 'error');
            return;
        }

        let isLoading = false;
        try {
            let address = addressOrEns;
            
            // Resolve ENS if needed
            if (addressOrEns.endsWith('.eth')) {
                showLoading('Resolving ENS...');
                isLoading = true;
                address = await identityManager.resolveAddress(addressOrEns);
                
                if (!address) {
                    showNotification('Could not resolve ENS name', 'error');
                    return;
                }
            }

            // Validate address format
            if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
                showNotification('Invalid Ethereum address', 'error');
                return;
            }

            await identityManager.addTrustedContact(address, nickname || null);
            this.renderList();
            this.deps.renderChannelList?.();
            showNotification('Contact added!', 'success');

            // Clear inputs
            this.elements.addContactAddress.value = '';
            this.elements.addContactNickname.value = '';
        } catch (error) {
            showNotification('Failed to add contact: ' + error.message, 'error');
        } finally {
            if (isLoading) hideLoading();
        }
    }

    // ========================================
    // Add/Remove Contact Modal Methods
    // ========================================

    /**
     * Show add contact modal
     * @param {string} address - Contact address to add
     */
    showAddModal(address) {
        modalManager.showAddContactModal(address);
        this._pendingContactAddress = address;
    }

    /**
     * Hide add contact modal
     */
    hideAddModal() {
        modalManager.hideAddContactModal();
        this._pendingContactAddress = null;
    }

    /**
     * Confirm adding contact from modal
     */
    async confirmAdd() {
        const { identityManager, showNotification } = this.deps;
        const nicknameInput = document.getElementById('add-contact-modal-nickname');
        const nickname = nicknameInput?.value?.trim() || null;
        const address = this._pendingContactAddress || modalManager.getPendingData('contactAddress');
        
        if (!address) return;
        
        await identityManager.addTrustedContact(address, nickname);
        this.renderList();
        this.deps.renderChannelList?.();
        showNotification('Contact added!', 'success');
        this.hideAddModal();
    }

    /**
     * Show edit contact modal
     * @param {string} address - Contact address to edit
     */
    showEditModal(address) {
        const contact = this.deps?.identityManager?.getTrustedContact(address);
        if (!contact) return;

        dropdownManager.closeContactDropdown();
        modalManager.showEditContactModal(contact.address, contact.nickname || '');
        this._pendingEditContactAddress = contact.address;
    }

    /**
     * Hide edit contact modal
     */
    hideEditModal() {
        modalManager.hideEditContactModal();
        this._pendingEditContactAddress = null;
    }

    /**
     * Confirm editing contact from modal
     */
    async confirmEdit() {
        const { identityManager, showNotification } = this.deps;
        const nicknameInput = document.getElementById('edit-contact-modal-nickname');
        const address = this._pendingEditContactAddress || modalManager.getPendingData('editContactAddress');

        if (!address) return;

        await identityManager.updateTrustedContact(address, nicknameInput?.value ?? '');
        this.renderList();
        this.deps.renderChannelList?.();
        showNotification('Contact updated', 'success');
        this.hideEditModal();
    }

    /**
     * Show remove contact confirmation modal
     * @param {string} address - Contact address to remove
     * @param {Function} onRemoveCallback - Optional callback after removal
     */
    showRemoveModal(address, onRemoveCallback = null) {
        dropdownManager.closeContactDropdown();
        modalManager.showRemoveContactModal(address, onRemoveCallback);
        this._pendingRemoveContactAddress = address;
        this._onRemoveContactCallback = onRemoveCallback;
    }

    /**
     * Hide remove contact modal
     */
    hideRemoveModal() {
        modalManager.hideRemoveContactModal();
        this._pendingRemoveContactAddress = null;
        this._onRemoveContactCallback = null;
    }

    /**
     * Confirm removing contact from modal
     */
    async confirmRemove() {
        const { identityManager, showNotification } = this.deps;
        const address = this._pendingRemoveContactAddress || modalManager.getPendingData('removeContactAddress');
        const callback = this._onRemoveContactCallback;
        
        if (!address) return;
        
        await identityManager.removeTrustedContact(address);
        this.renderList();
        this.deps.renderChannelList?.();
        showNotification('Contact removed', 'info');
        this.hideRemoveModal();
        
        if (callback) {
            callback();
        }
    }
}

export const contactsUI = new ContactsUI();
