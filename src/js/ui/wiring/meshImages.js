/**
 * Mesh image placeholders: arrival and the give-up/retry state.
 */

import { channelManager } from '../../channels.js';
import { mediaController } from '../../media.js';
import { Logger } from '../../logger.js';
import { mediaHandler } from '../MediaHandler.js';
import { escapeAttr as _escapeAttr } from '../utils.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachMeshImages(ui) {
    // Image received - update image placeholders
    mediaController.onImageReceived((imageId, base64Data) => {
        // Replace ALL placeholders for this imageId — re-shares produce
        // multiple placeholders, and `recoverImage` relies on this fan-out.
        const placeholders = document.querySelectorAll(`[data-image-id="${CSS.escape(imageId)}"]`);
        if (placeholders.length === 0) return;

        const currentChannel = ui.getActiveChannel();
        const mediaId = mediaHandler.registerMedia(base64Data, 'image');
        if (!mediaId) return;

        const replacementHtml = `
            <div class="relative inline-block max-w-xs group">
                <img src="${base64Data}" 
                     class="max-w-full max-h-60 rounded-lg cursor-pointer object-contain lightbox-trigger" 
                     data-media-id="${mediaId}"
                     alt="Image"/>
                <button class="absolute top-1 right-1 bg-black/60 hover:bg-black/80 text-primary p-1 rounded transition opacity-0 group-hover:opacity-100 lightbox-trigger"
                        data-media-id="${mediaId}"
                        title="Maximize">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
                    </svg>
                </button>
            </div>
        `;

        let replacedAny = false;
        for (const placeholder of placeholders) {
            const placeholderChannelId = placeholder.getAttribute('data-channel-id');
            if (placeholderChannelId && currentChannel && placeholderChannelId !== currentChannel.streamId) {
                Logger.debug('Image received for different channel, skipping DOM update:', imageId);
                continue;
            }
            placeholder.outerHTML = replacementHtml;
            replacedAny = true;
        }
        if (replacedAny) {
            mediaHandler.attachLightboxListeners();
        }
    });
    
    // Image recovery gave up — render "Image unavailable" + Retry button
    // for each affected placeholder. Channel manager dispatches this
    // when pagination is exhausted or the recovery loop stagnates;
    // the Retry handler restarts the loop in case the stream has since
    // gained more storage history.
    if (typeof window !== 'undefined' && !ui._imageRecoveryGaveUpBound) {
        ui._imageRecoveryGaveUpBound = true;
        window.addEventListener('pombo:imageRecoveryGaveUp', (ev) => {
            const detail = ev?.detail || {};
            const ids = Array.isArray(detail.imageIds) ? detail.imageIds : [];
            if (ids.length === 0) return;
            for (const imageId of ids) {
                try {
                    const placeholders = document.querySelectorAll(`[data-image-id="${CSS.escape(imageId)}"]`);
                    if (placeholders.length === 0) continue;
                    for (const el of placeholders) {
                        el.innerHTML = `
                            <div class="flex flex-col items-center gap-2 text-white/40 text-sm p-3">
                                <div class="flex items-center gap-2">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                                        <line x1="3" y1="3" x2="21" y2="21"></line>
                                    </svg>
                                    <span>Image unavailable</span>
                                </div>
                                <button type="button" class="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white/80 text-xs" data-retry-image-id="${_escapeAttr(imageId)}">Retry</button>
                            </div>
                        `;
                        const btn = el.querySelector(`[data-retry-image-id="${CSS.escape(imageId)}"]`);
                        if (btn) {
                            btn.addEventListener('click', async (clickEv) => {
                                clickEv.preventDefault();
                                clickEv.stopPropagation();
                                // Reset to spinner state
                                try {
                                    el.innerHTML = `
                                        <div class="flex items-center gap-2 text-white/40 text-sm">
                                            <div class="w-4 h-4 border-2 border-white/30 border-t-white/80 rounded-full animate-spin" aria-hidden="true"></div>
                                            <span>Loading\u2026</span>
                                        </div>
                                    `;
                                } catch (_) { /* ignore DOM reset errors */ }
                                // Re-run recovery for this channel
                                const channelId = el.getAttribute('data-channel-id') || detail.streamId;
                                if (channelId) {
                                    try {
                                        await channelManager.recoverIncompleteImages(channelId);
                                    } catch (err) {
                                        Logger.debug('image retry: recovery failed:', err?.message || err);
                                    }
                                }
                            }, { once: true });
                        }
                    }
                } catch (err) {
                    Logger.debug('image-recovery-gave-up: DOM update failed:', err?.message || err);
                }
            }
        });
    }
}
