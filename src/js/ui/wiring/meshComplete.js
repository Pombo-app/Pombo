/**
 * Mesh file completion: inline player, save link and seeding badge.
 */

import { mediaController } from '../../media.js';
import { mediaHandler } from '../MediaHandler.js';
import { messageRenderer } from '../MessageRenderer.js';
import { sanitizeText } from '../sanitizer.js';
import { escapeAttr as _escapeAttr } from '../utils.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachMeshComplete(ui) {
    // File complete - show video player with seeding badge
    mediaController.onFileComplete((fileId, metadata, url, blob) => {
        mediaHandler.autoSaveOnce(fileId, url, metadata.fileName);

        const container = document.querySelector(`[data-file-id="${CSS.escape(fileId)}"]`);
        if (container) {
            const isSeeding = mediaController.isSeeding(fileId);
            
            // Defense-in-depth: sanitize + HTML/attribute-escape network-provided
            // metadata (sanitizeText alone does not neutralize quotes, allowing
            // attribute injection when interpolated into download/type attrs)
            const safeFileName = _escapeAttr(sanitizeText(metadata.fileName));
            const safeFileType = _escapeAttr(sanitizeText(metadata.fileType));
            
            if (metadata.fileType.startsWith('video/')) {
                // Check if video format is playable in browser
                const isPlayable = mediaController.isVideoPlayable(metadata.fileType);
                
                // Register media for safe lightbox handling
                const mediaId = mediaHandler.registerMedia(url, 'video');
                
                if (isPlayable && mediaId) {
                    // Show video player
                    container.outerHTML = `
                        <div data-file-id="${_escapeAttr(fileId)}" class="max-w-xs">
                            <div class="relative rounded-lg overflow-hidden bg-black">
                                <video src="${url}" 
                                       class="max-w-full max-h-60 cursor-pointer video-player-${_escapeAttr(fileId)}" 
                                       controls
                                       preload="metadata"
                                       playsinline>
                                    <source src="${url}" type="${safeFileType}">
                                    Your browser does not support this video format.
                                </video>
                                <button class="absolute top-1 right-1 bg-black/60 hover:bg-black/80 text-primary p-1 rounded transition lightbox-trigger"
                                        data-media-id="${mediaId}"
                                        title="Fullscreen">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
                                    </svg>
                                </button>
                                ${isSeeding ? `
                                <div class="absolute bottom-1 left-1 bg-green-600/90 text-primary text-xs px-2 py-0.5 rounded-full flex items-center gap-1">
                                    <svg class="w-3 h-3 animate-pulse" fill="currentColor" viewBox="0 0 20 20">
                                        <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z"/>
                                    </svg>
                                    <span>Seeding</span>
                                </div>
                                ` : ''}
                            </div>
                            <div class="flex items-center justify-between mt-1 text-xs text-white/40">
                                <span class="truncate flex-1">${safeFileName}</span>
                                <div class="flex items-center gap-2 ml-2">
                                    <span>${messageRenderer.formatFileSize(metadata.fileSize)}</span>
                                    <a href="${url}" download="${safeFileName}" class="text-blue-400 hover:underline">Save</a>
                                </div>
                            </div>
                        </div>
                    `;
                    
                    // Attach lightbox click handlers
                    mediaHandler.attachLightboxListeners();
                    
                    // Add error handler to video element
                    setTimeout(() => {
                        const videoEl = document.querySelector(`.video-player-${CSS.escape(fileId)}`);
                        if (videoEl) {
                            videoEl.addEventListener('error', (e) => {
                                console.error('Video playback error:', e);
                                // Replace with download link on error
                                const parent = videoEl.closest('[data-file-id]');
                                if (parent) {
                                    parent.innerHTML = `
                                        <div class="bg-white/[0.06] rounded-lg p-3">
                                            <div class="flex items-center gap-2 mb-2">
                                                <svg class="w-5 h-5 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                                                </svg>
                                                <span class="text-sm text-white/70">Format not supported</span>
                                            </div>
                                            <a href="${url}" download="${safeFileName}" class="block w-full bg-blue-600 hover:bg-blue-700 text-primary text-center px-3 py-2 rounded-lg text-sm transition">
                                                Download ${safeFileName}
                                            </a>
                                        </div>
                                    `;
                                }
                            });
                            // Force load
                            videoEl.load();
                        }
                    }, 100);
                } else {
                    // Format not playable - show download button
                    container.outerHTML = `
                        <div data-file-id="${_escapeAttr(fileId)}" class="max-w-xs">
                            <div class="bg-white/[0.06] rounded-lg p-3">
                                <div class="flex items-center gap-2 mb-2">
                                    <svg class="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/>
                                    </svg>
                                    <span class="font-medium text-sm truncate text-primary">${safeFileName}</span>
                                </div>
                                <div class="text-xs text-yellow-500 mb-2">
                                    ⚠️ Format not supported in browser (${safeFileType.split('/')[1]?.toUpperCase() || 'video'})
                                </div>
                                <div class="flex items-center justify-between">
                                    <span class="text-xs text-white/30">${messageRenderer.formatFileSize(metadata.fileSize)}</span>
                                    <a href="${url}" download="${safeFileName}" class="bg-blue-600 hover:bg-blue-700 text-primary px-3 py-1.5 rounded-lg text-sm transition">
                                        Download
                                    </a>
                                </div>
                                ${isSeeding ? `
                                <div class="flex items-center gap-2 mt-2">
                                    <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                                    <span class="text-xs text-success">Seeding...</span>
                                </div>
                                ` : ''}
                            </div>
                        </div>
                    `;
                }
            } else {
                // Same bubble the renderer produces, so a finished download looks
                // exactly like a file we are seeding rather than a bare link
                container.outerHTML = messageRenderer.renderFileBubble({ metadata });
            }
        }
    });
}
