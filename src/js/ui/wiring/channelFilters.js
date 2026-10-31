/**
 * Sidebar channel filter tabs and their mobile swipe gestures.
 */

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachChannelFilters(ui) {
    // Home tabs (sidebar: Direct/Channels)
    document.querySelectorAll('.channel-filter-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            ui.switchChannelFilterTab(tab.dataset.channelFilter);
        });
    });

    // Mobile swipe gestures for channel filter tabs
    ui.initChannelFilterSwipe();
}
