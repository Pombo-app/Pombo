/**
 * Create/cancel channel and the explore entry point.
 */

import { channelModalsUI } from '../ChannelModalsUI.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachChannelActions(ui) {
    // Create channel
    ui.elements.createChannelBtn.addEventListener('click', () => {
        channelModalsUI.handleCreate();
    });

    // Cancel channel creation
    ui.elements.cancelChannelBtn.addEventListener('click', () => {
        channelModalsUI.hide();
    });

    // Footer cancel button (new design)
    document.getElementById('cancel-channel-btn-footer')?.addEventListener('click', () => {
        channelModalsUI.hide();
    });

    // Explore channels button (sidebar)
    ui.elements.browseChannelsBtn?.addEventListener('click', () => {
        ui.openExploreView();
    });
}
