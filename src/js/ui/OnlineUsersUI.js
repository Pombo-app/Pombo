/**
 * Online Users UI
 * Manages the online users list and user dropdown menus
 */

import { escapeHtml, escapeAttr, formatAddress } from './utils.js';
import { getAvatarHtml } from './AvatarGenerator.js';
import { sanitizeText } from './sanitizer.js';
import { identityManager } from '../identity.js';

const ENS_BADGE_SVG = `<svg class="inline-block" style="vertical-align: -1px" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" style="stroke:var(--pombo-success)" stroke-width="2" fill="none"/><path d="M7.5 12.5l3 3 6-6.5" style="stroke:var(--pombo-success)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

class OnlineUsersUI {
    constructor() {
        this.deps = {};
        this.ensCache = new Map();
    }

    /**
     * Set dependencies
     * @param {Object} deps - { getCurrentAddress, onUserMenuAction }
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * Update online users display
     * @param {HTMLElement} countEl - Element showing user count
     * @param {HTMLElement} listEl - Element containing user list
     * @param {Array} users - Array of online users
     */
    async updateOnlineUsers(countEl, listEl, users) {
        // Update count
        if (countEl) {
            countEl.textContent = users.length;
        }
        
        // Update list
        if (listEl) {
            if (users.length === 0) {
                listEl.innerHTML = '<div class="text-white/30 text-sm text-center">No one online</div>';
            } else {
                const myAddress = this.deps.getCurrentAddress?.()?.toLowerCase();

                // Resolve ENS for all unique addresses in parallel
                const addresses = users.map(u => u.address || u.id).filter(Boolean);
                const uniqueAddresses = [...new Set(addresses.map(a => a.toLowerCase()))];
                const [ensResults, avatarResults] = await Promise.all([
                    Promise.all(uniqueAddresses.map(addr => identityManager.resolveENS(addr).catch(() => null))),
                    Promise.all(uniqueAddresses.map(addr => identityManager.resolveENSAvatar(addr).catch(() => null)))
                ]);
                const ensMap = new Map();
                const avatarMap = new Map();
                uniqueAddresses.forEach((addr, i) => {
                    if (ensResults[i]) ensMap.set(addr, ensResults[i]);
                    if (avatarResults[i]) avatarMap.set(addr, avatarResults[i]);
                });
                
                listEl.innerHTML = users.map(user => {
                    const address = user.address || user.id;
                    const isMe = address?.toLowerCase() === myAddress;
                    const nickname = user.nickname;
                    const shortAddress = formatAddress(address);
                    const ensName = ensMap.get(address?.toLowerCase());
                    
                    // Display priority: ENS name > nickname > address
                    let displayName;
                    let ensBadge = '';
                    if (ensName) {
                        displayName = escapeHtml(sanitizeText(ensName));
                        ensBadge = `<span title="ENS verified">${ENS_BADGE_SVG}</span>`;
                    } else if (nickname) {
                        displayName = escapeHtml(sanitizeText(nickname));
                    } else {
                        displayName = escapeHtml(shortAddress);
                    }
                    
                    // Subtitle: address if has ENS/nickname, or "(you)" if it's me
                    let subtitle = '';
                    if (ensName || nickname) {
                        subtitle = isMe ? `${escapeHtml(shortAddress)} (you)` : escapeHtml(shortAddress);
                    } else if (isMe) {
                        subtitle = '(you)';
                    }
                    
                    const avatarUrl = avatarMap.get(address?.toLowerCase()) || null;
                    const avatarHtml = getAvatarHtml(address, 32, 0.5, avatarUrl);
                    
                    return `
                        <div class="user-item-wrapper" data-user-address="${escapeAttr(address)}">
                            <div class="user-item cursor-pointer hover:bg-white/[0.06] rounded-lg px-2 py-1.5 -mx-2">
                                <div class="user-avatar-small flex-shrink-0" style="width:32px;height:32px;border-radius:9999px;overflow:hidden;">${avatarHtml}</div>
                                <div class="flex flex-col min-w-0 flex-1">
                                    <span class="text-white/70 truncate text-sm ${isMe ? 'font-semibold' : ''}">${ensBadge} ${displayName}</span>
                                    ${subtitle ? `<span class="text-white/40 text-xs truncate">${subtitle}</span>` : ''}
                                </div>
                                <button class="user-menu-btn ml-auto text-white/30 hover:text-white/60 p-1" title="Options">
                                    <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                                        <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                    `;
                }).join('');
                
                // Attach event listeners for dropdowns
                this.attachUserMenuListeners();
            }
        }
    }
    
    /**
     * Attach event listeners for user dropdown menus
     */
    attachUserMenuListeners() {
        document.querySelectorAll('.user-menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const wrapper = btn.closest('.user-item-wrapper');
                const address = wrapper?.dataset.userAddress;
                const isMe = address?.toLowerCase() === this.deps.getCurrentAddress?.()?.toLowerCase();
                
                // Close any existing dropdown
                this.closeUserDropdown();
                
                // Create dropdown and append to body for proper positioning
                const dropdown = document.createElement('div');
                dropdown.id = 'user-dropdown-menu';
                dropdown.className = 'fixed bg-[#16161b] border border-white/10 rounded-xl shadow-xl py-1 z-[9999] min-w-[160px]';
                
                const safeAddress = escapeAttr(address);
                
                dropdown.innerHTML = `
                    <button class="user-action w-full text-left px-3 py-2 hover:bg-white/[0.08] text-sm text-white/60" data-action="copy-address" data-address="${safeAddress}">
                        📋 Copy Address
                    </button>
                    ${!isMe ? `
                    <button class="user-action w-full text-left px-3 py-2 hover:bg-white/[0.08] text-sm text-white/60" data-action="add-contact" data-address="${safeAddress}">
                        ➕ Add to Contacts
                    </button>
                    <button class="user-action w-full text-left px-3 py-2 hover:bg-white/[0.08] text-sm text-danger" data-action="start-dm" data-address="${safeAddress}">
                        💬 Start DM
                    </button>
                    ` : ''}
                `;
                
                document.body.appendChild(dropdown);
                
                // Position dropdown relative to button
                const btnRect = btn.getBoundingClientRect();
                const dropdownRect = dropdown.getBoundingClientRect();
                
                let left = btnRect.left - dropdownRect.width - 8;
                let top = btnRect.top;
                
                if (left < 8) {
                    left = btnRect.right + 8;
                }
                
                if (top + dropdownRect.height > window.innerHeight - 8) {
                    top = window.innerHeight - dropdownRect.height - 8;
                }
                
                dropdown.style.left = `${left}px`;
                dropdown.style.top = `${top}px`;
                
                // Attach action listeners
                dropdown.querySelectorAll('.user-action').forEach(actionBtn => {
                    actionBtn.addEventListener('click', async (evt) => {
                        evt.stopPropagation();
                        const action = actionBtn.dataset.action;
                        const addr = actionBtn.dataset.address;
                        this.closeUserDropdown();
                        if (this.deps.onUserMenuAction) {
                            await this.deps.onUserMenuAction(action, addr);
                        }
                    });
                });
                
                // Close on outside click
                setTimeout(() => {
                    document.addEventListener('click', this.closeUserDropdown.bind(this), { once: true });
                }, 0);
            });
        });
    }
    
    /**
     * Close user dropdown menu
     */
    closeUserDropdown() {
        const existing = document.getElementById('user-dropdown-menu');
        if (existing) {
            existing.remove();
        }
    }
}

// Export singleton instance
export const onlineUsersUI = new OnlineUsersUI();
