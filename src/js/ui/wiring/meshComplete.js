/**
 * Mesh file completion: the finished bubble (video tile or file card).
 */

import { mediaController } from '../../media.js';
import { mediaHandler } from '../MediaHandler.js';
import { messageRenderer } from '../MessageRenderer.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachMeshComplete(ui) {
    mediaController.onFileComplete((fileId, metadata, url) => {
        const isVideo = (metadata.fileType || '').startsWith('video/');
        if (!isVideo) mediaHandler.autoSaveOnce(fileId, url, metadata.fileName);

        const container = document.querySelector(`[data-file-id="${CSS.escape(fileId)}"]`);
        if (!container) return;
        if (isVideo) {
            container.outerHTML = messageRenderer.renderVideoContent({ metadata });
            mediaHandler.attachLightboxListeners();
        } else {
            // Same bubble the renderer produces, so a finished download looks
            // exactly like a file we are seeding rather than a bare link
            container.outerHTML = messageRenderer.renderFileBubble({ metadata });
        }
    });
}
