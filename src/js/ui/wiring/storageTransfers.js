/**
 * Storage-node transfers: progress, upload stats and completion.
 */

import { storageMediaController } from '../../storageMedia.js';
import { mediaHandler } from '../MediaHandler.js';
import { messageRenderer } from '../MessageRenderer.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachStorageTransfers(ui) {
    document.addEventListener('click', (e) => {
        const btn = e.target.closest?.('.storage-retry-btn');
        if (!btn || btn.disabled) return;
        e.preventDefault();
        e.stopPropagation();
        btn.disabled = true;
        storageMediaController.retryUpload(btn.dataset.fileId)
            .then((result) => {
                const m = result?.metadata;
                const gaps = m && Number.isFinite(m.storedChunks) && m.storedChunks < m.totalChunks;
                ui.showNotification(gaps ? `Sent again, still with gaps (${m.storedChunks}/${m.totalChunks})` : 'Sent again ✓', gaps ? 'warning' : 'success');
            })
            .catch((err) => {
                btn.disabled = false;
                ui.showNotification('Retry failed: ' + err.message, 'error');
            });
    });

    // ===== Persistent (storage-node) transfers =====
    // Storage bubbles share the mesh data-* DOM contract, so the progress
    // plumbing mirrors the handlers above, keyed by transferId.
    storageMediaController.onFileProgress((tid, percent) => {
        if (messageRenderer.videoAutoplay.has(tid)) {
            const url = storageMediaController.streamUrl(tid);
            const play = url && document.querySelector(`.video-tile-play[data-file-id="${CSS.escape(tid)}"]`);
            if (play) {
                messageRenderer.videoAutoplay.delete(tid);
                const video = document.createElement('video');
                video.className = 'video-tile-media';
                video.src = url;
                video.controls = true;
                video.autoplay = true;
                video.playsInline = true;
                video.dataset.stream = '';
                play.replaceWith(video);
                video.insertAdjacentHTML('afterend', messageRenderer.videoFullscreenButton(mediaHandler.registerMedia(url, 'video')));
                mediaHandler.attachLightboxListeners();
            }
        }

        const progressOverlay = document.querySelector(`[data-progress-overlay="${CSS.escape(tid)}"]`);
        if (progressOverlay) progressOverlay.classList.remove('hidden');

        const progressPercent = document.querySelector(`[data-progress-percent="${CSS.escape(tid)}"]`);
        if (progressPercent) progressPercent.textContent = `${percent}%`;

        const progressFill = document.querySelector(`[data-progress-fill="${CSS.escape(tid)}"]`);
        if (progressFill) progressFill.style.width = `${percent}%`;

        // Downloads: full POC-parity stats (%, transferred/total, speed on
        // line 1; ETA on line 2) composed by the shared renderer formatter.
        if (storageMediaController.isDownloading(tid)) {
            const p = storageMediaController.getDownloadProgress(tid);
            const d = messageRenderer.formatStorageDownloadDetail(p);
            const progressText = document.querySelector(`[data-progress-text="${CSS.escape(tid)}"]`);
            if (progressText && d.line1) progressText.textContent = d.line1;
            const progressEta = document.querySelector(`[data-progress-eta="${CSS.escape(tid)}"]`);
            if (progressEta) progressEta.textContent = d.line2;
        }
    });

    // Sender bubble: stats snapshot per tick (sending gets %, bytes, speed,
    // ETA; other stages show the engine's phase label — verify/repair/announce)
    storageMediaController.onUploadStats((tid, stats) => {
        const d = messageRenderer.formatStorageUploadDetail(stats);
        const progressText = document.querySelector(`[data-progress-text="${CSS.escape(tid)}"]`);
        if (progressText && d.line1) {
            progressText.textContent = d.line1;
            progressText.classList.remove('hidden');
        }
        const progressEta = document.querySelector(`[data-progress-eta="${CSS.escape(tid)}"]`);
        if (progressEta) progressEta.textContent = d.line2;
        const progressOverlay = document.querySelector(`[data-progress-overlay="${CSS.escape(tid)}"]`);
        if (progressOverlay) {
            progressOverlay.classList.remove('hidden');
            progressOverlay.classList.toggle('is-working', messageRenderer.isUploadWorking(stats));
        }
        const progressFill = document.querySelector(`[data-progress-fill="${CSS.escape(tid)}"]`);
        if (progressFill) progressFill.style.width = `${stats.percent || 0}%`;
    });

    // Upload finished (announce published) — swap the optimistic bubble for
    // the final one
    storageMediaController.onUploadComplete((tid, message) => {
        const container = document.querySelector(`[data-file-id="${CSS.escape(tid)}"]`);
        if (container) {
            container.outerHTML = messageRenderer.renderStorageFileBubble(message);
            ui.attachReactionListeners();
        }
    });

    // Download finished — re-render as the completed card (save link /
    // inline player); the controller's deps now report the blob URL
    storageMediaController.onFileComplete((tid, metadata) => {
        const url = storageMediaController.getFileUrl(tid);
        if (!(metadata.fileType || '').startsWith('video/')) {
            mediaHandler.autoSaveStorageOnce(tid, url, metadata.fileName);
        }

        const container = document.querySelector(`[data-file-id="${CSS.escape(tid)}"]`);
        const live = container?.querySelector('video[data-stream]');
        if (live) {
            // The playing element moves into the finished tile within this
            // task, so it never leaves the document long enough to pause. The
            // holder must belong to this document (not a <template>): adopting
            // a media element into another document restarts its load.
            const holder = document.createElement('div');
            holder.innerHTML = messageRenderer.renderStorageFileBubble({ metadata }).trim();
            const fresh = holder.firstElementChild;
            fresh.querySelector('video')?.replaceWith(live);
            container.replaceWith(fresh);
            ui.attachReactionListeners();
        } else if (container) {
            container.outerHTML = messageRenderer.renderStorageFileBubble({ metadata });
            ui.attachReactionListeners();
        }
    });

    storageMediaController.onFileError((tid, message) => {
        const streaming = document.querySelector(`[data-file-id="${CSS.escape(tid)}"] video[data-stream]`);
        const failedMeta = storageMediaController.downloads.get(tid)?.metadata;
        if (streaming && failedMeta) streaming.closest('[data-file-id]').outerHTML = messageRenderer.renderStorageFileBubble({ metadata: failedMeta });
        const progressOverlay = document.querySelector(`[data-progress-overlay="${CSS.escape(tid)}"]`);
        if (progressOverlay) progressOverlay.classList.add('hidden');
        const btn = document.querySelector(`.storage-download-btn[data-file-id="${CSS.escape(tid)}"]`);
        if (btn) {
            btn.querySelector('.download-play-icon')?.classList.remove('hidden');
            btn.querySelector('.download-loading-icon')?.classList.add('hidden');
            btn.disabled = false;
        }
        ui.showNotification('Storage transfer failed: ' + message, 'error');
    });
}
