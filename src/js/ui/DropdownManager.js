/**
 * Dropdown Manager
 * Handles channel dropdown menu and positioning logic
 */

import { subscriptionBannerUI } from './SubscriptionBannerUI.js';

class DropdownManager {
    constructor() {
        this.deps = {};
    }

    /**
     * Set dependencies
     * @param {Object} deps - { onChannelMenuAction }
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * Show channel dropdown menu
     * @param {Event} e - Click event
     * @param {HTMLElement} menuBtn - The menu button element
     * @param {Object} channel - Current channel info
     * @param {boolean} isPreviewMode - Whether in preview mode
     */
    showChannelDropdown(e, menuBtn, channel, isPreviewMode = false) {
        if (!channel) return;

        // Build dropdown items - "Leave Channel" only shown when not in preview mode
        const items = [
            {
                action: 'copy-stream-id',
                icon: '<span class="w-4 h-4 flex items-center justify-center font-semibold text-base">#</span>',
                label: 'Copy Channel ID'
            }
        ];

        // "Pinned" only when channel has at least one pinned message
        const accessLost = ['expired', 'unsubscribed', 'banned']
            .includes(subscriptionBannerUI.stateOf(channel?.streamId));
        const hasPins = !accessLost
            && Array.isArray(channel?.adminState?.pins) && channel.adminState.pins.length > 0;
        if (hasPins) {
            items.push({
                action: 'show-pinned',
                icon: '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6l1 1 1-1v-6h5v-2l-2-2z"/></svg>',
                label: 'Pinned'
            });
        }

        items.push({
            action: 'channel-settings',
            icon: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>',
            label: 'Channel Details'
        });

        if (!isPreviewMode) {
            items.push({ separator: true });
            items.push({
                action: 'leave-channel',
                icon: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9"/></svg>',
                label: 'Leave Channel',
                tone: 'danger'
            });
        }

        this._showDropdown({
            menuId: 'channel-dropdown-menu',
            menuBtn,
            items,
            onAction: async (action) => {
                if (this.deps.onChannelMenuAction) {
                    await this.deps.onChannelMenuAction(action);
                }
            }
        });
    }

    /**
     * Show contact dropdown menu
     * @param {Event} e - Click event
     * @param {HTMLElement} menuBtn - The menu button element
     * @param {Object} contact - Current contact info
     * @param {Function} onAction - Action callback
     */
    showContactDropdown(e, menuBtn, contact, onAction) {
        if (!contact) return;

        this._showDropdown({
            menuId: 'contact-dropdown-menu',
            menuBtn,
            items: [
                {
                    action: 'edit-contact',
                    icon: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"/></svg>',
                    label: 'Edit Contact'
                },
                {
                    action: 'send-dm',
                    icon: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"/></svg>',
                    label: 'Send DM'
                },
                {
                    action: 'copy-address',
                    icon: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>',
                    label: 'Copy address'
                },
                { separator: true },
                {
                    action: 'remove-contact',
                    icon: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"/></svg>',
                    label: 'Remove Contact',
                    tone: 'danger'
                }
            ],
            onAction
        });
    }

    /**
     * Render and position a dropdown menu anchored to a button
     * @param {Object} options
     * @private
     */
    _showDropdown({ menuId, menuBtn, items, onAction }) {
        if (!menuBtn || !Array.isArray(items) || items.length === 0) return;

        this.closeAllDropdowns();

        const dropdown = document.createElement('div');
        dropdown.id = menuId;
        dropdown.className = 'fixed bg-surface-raised border border-overlay-10 rounded-xl shadow-xl py-1 z-[9999] min-w-[180px] overflow-hidden';
        dropdown.innerHTML = items.map((item) => this._renderItem(item)).join('');

        document.body.appendChild(dropdown);
        this._positionDropdown(dropdown, menuBtn);

        dropdown.querySelectorAll('.dropdown-action').forEach(actionBtn => {
            actionBtn.addEventListener('click', async (evt) => {
                evt.stopPropagation();
                const action = actionBtn.dataset.action;
                this.closeMenu(menuId);
                await onAction?.(action);
            });
        });

        setTimeout(() => {
            document.addEventListener('click', () => this.closeMenu(menuId), { once: true });
        }, 0);
    }

    /**
     * Render a dropdown item
     * @param {Object} item - Dropdown item
     * @returns {string}
     * @private
     */
    _renderItem(item) {
        if (item.separator) {
            return '<div class="my-1 border-t border-overlay-5"></div>';
        }

        const toneClasses = item.tone === 'danger'
            ? 'hover:bg-red-500/10 text-overlay-50 hover:text-danger'
            : 'hover:bg-overlay-5 text-overlay-70 hover:text-primary';

        return `
            <button class="dropdown-action w-full text-left px-4 py-2 text-sm transition flex items-center gap-2 ${toneClasses}" data-action="${item.action}">
                ${item.icon}
                ${item.label}
            </button>
        `;
    }

    /**
     * Position a dropdown relative to an anchor button
     * @param {HTMLElement} dropdown - Dropdown element
     * @param {HTMLElement} menuBtn - Anchor button
     * @private
     */
    _positionDropdown(dropdown, menuBtn) {
        const btnRect = menuBtn.getBoundingClientRect();
        const dropdownRect = dropdown.getBoundingClientRect();

        let left = btnRect.left;
        let top = btnRect.bottom + 4;

        if (left + dropdownRect.width > window.innerWidth - 8) {
            left = btnRect.right - dropdownRect.width;
        }

        if (top + dropdownRect.height > window.innerHeight - 8) {
            top = btnRect.top - dropdownRect.height - 4;
        }

        dropdown.style.left = `${left}px`;
        dropdown.style.top = `${top}px`;
    }

    /**
     * Close a dropdown by ID
     * @param {string} menuId - Dropdown element ID
     */
    closeMenu(menuId) {
        const existing = document.getElementById(menuId);
        if (existing) {
            existing.remove();
        }
    }
    
    /**
     * Close channel dropdown menu
     */
    closeChannelDropdown() {
        this.closeMenu('channel-dropdown-menu');
    }

    /**
     * Close contact dropdown menu
     */
    closeContactDropdown() {
        this.closeMenu('contact-dropdown-menu');
    }

    /**
     * Close all dropdowns (user and channel)
     */
    closeAllDropdowns() {
        this.closeChannelDropdown();
        this.closeContactDropdown();
        const userDropdown = document.getElementById('user-dropdown-menu');
        if (userDropdown) {
            userDropdown.remove();
        }
    }
}

// Export singleton instance
export const dropdownManager = new DropdownManager();
