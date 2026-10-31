/**
 * Home list tabs: Direct holds DMs, Channels holds every other channel type.
 * The chosen tab is remembered per account in this browser only.
 */
import { CONFIG } from '../config.js';

export const HOME_TABS = ['direct', 'channels'];
export const DEFAULT_HOME_TAB = 'direct';

/**
 * @param {Object} channel
 * @returns {'direct'|'channels'}
 */
export function homeTabOf(channel) {
    return channel?.type === 'dm' ? 'direct' : 'channels';
}

/**
 * @param {Object[]} channels
 * @param {string} tab
 * @returns {Object[]}
 */
export function filterByHomeTab(channels, tab) {
    return channels.filter(channel => homeTabOf(channel) === tab);
}

/**
 * @param {string|null} address - Account address; none means a guest
 * @returns {'direct'|'channels'}
 */
export function loadHomeTab(address) {
    if (!address) return DEFAULT_HOME_TAB;
    try {
        const stored = localStorage.getItem(CONFIG.storageKeys.homeTab(address));
        return HOME_TABS.includes(stored) ? stored : DEFAULT_HOME_TAB;
    } catch {
        return DEFAULT_HOME_TAB;
    }
}

/**
 * @param {string|null} address - Account address; none means a guest, not saved
 * @param {string} tab
 */
export function saveHomeTab(address, tab) {
    if (!address || !HOME_TABS.includes(tab)) return;
    try {
        localStorage.setItem(CONFIG.storageKeys.homeTab(address), tab);
    } catch {
        // Storage unavailable: the tab just isn't remembered.
    }
}
