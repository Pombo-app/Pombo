/**
 * Message Renderer
 * Handles rendering of messages, content types, and related UI
 */

import { escapeHtml, escapeAttr, formatAddress, addressToColor, linkify, embedYouTubeLinks } from './utils.js';
import { GroupPosition, shouldShowSenderName } from './MessageGrouper.js';
import { getAvatar, getAvatarHtml } from './AvatarGenerator.js';
import { sanitizeMessageHtml, sanitizeText } from './sanitizer.js';

class MessageRenderer {
    constructor() {
        this.deps = {};
    }

    /**
     * Set dependencies
     * @param {Object} deps - { getCurrentAddress, getMessageReactions, registerMedia, getImage, cacheImage, loadImageFromLedger, getCurrentChannel, getFileUrl, isSeeding, isSaved, isVideoPlayable, getStorageFileUrl, isStorageDownloading, getStorageDownloadProgress, getStorageUploadState, getStorageResumePercent, isStorageSaved }
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * Check if text is emoji-only (no other characters)
     * @param {string} text - Text to check
     * @returns {boolean|string} - false if not emoji-only, 'true' for 1-3 emojis, 'many' for 4+ emojis
     */
    isEmojiOnly(text) {
        if (!text) return false;
        const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
        const stripped = text.replace(/\s/g, '');
        const emojis = stripped.match(emojiRegex);
        if (!emojis || emojis.length === 0) return false;
        
        const withoutEmojis = stripped.replace(emojiRegex, '').replace(/[\uFE0F\u200D]/g, '');
        if (withoutEmojis.length > 0) return false;
        
        return emojis.length <= 3 ? 'true' : 'many';
    }

    /**
     * Wrap emojis in text with span for styling
     * @param {string} html - Escaped HTML text
     * @returns {string} - HTML with emojis wrapped in spans
     */
    wrapInlineEmojis(html) {
        const emojiRegex = /([\p{Emoji_Presentation}\p{Extended_Pictographic}][\uFE0F\u200D]?)/gu;
        // Runs after linkify, so tags are already in the string: wrapping an
        // emoji inside one would put a span in the middle of an attribute.
        return html.replace(/<[^>]*>|[^<]+/g, (chunk) => (
            chunk.startsWith('<')
                ? chunk
                : chunk.replace(emojiRegex, '<span class="inline-emoji">$1</span>')
        ));
    }

    /**
     * Format file size for display
     * @param {number} bytes - File size in bytes
     * @returns {string} - Formatted size string
     */
    formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    /**
     * Render date separator pill
     * @param {Date} date - Date for separator
     * @returns {string} - HTML for date separator
     */
    renderDateSeparator(date) {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        
        let dateText;
        if (date.toDateString() === today.toDateString()) {
            dateText = 'Today';
        } else if (date.toDateString() === yesterday.toDateString()) {
            dateText = 'Yesterday';
        } else {
            const month = date.toLocaleDateString('en-US', { month: 'long' });
            const day = date.getDate();
            const year = date.getFullYear();
            
            if (year === today.getFullYear()) {
                dateText = `${month} ${day}`;
            } else {
                dateText = `${month} ${day}, ${year}`;
            }
        }
        
        return `
            <div class="date-separator">
                <span class="date-pill">${dateText}</span>
            </div>
        `;
    }

    /**
     * Render reactions for a message
     * @param {string} msgId - Message ID
     * @param {boolean} isOwn - Whether message is own
     * @returns {string} - HTML for reactions
     */
    renderReactions(msgId, isOwn) {
        const reactions = this.deps.getMessageReactions?.(msgId);
        if (!reactions || Object.keys(reactions).length === 0) {
            return `<div class="reactions-container" data-reactions-for="${escapeAttr(msgId)}"></div>`;
        }

        const currentAddress = this.deps.getCurrentAddress?.()?.toLowerCase();
        let html = `<div class="reactions-container" data-reactions-for="${escapeAttr(msgId)}">`;
        
        for (const [emoji, users] of Object.entries(reactions)) {
            if (users.length > 0) {
                const userReacted = users.some(u => u.toLowerCase() === currentAddress);
                html += `<span class="reaction-badge ${userReacted ? 'user-reacted' : ''}" data-emoji="${escapeAttr(emoji)}" data-msg-id="${escapeAttr(msgId)}"><span class="reaction-emoji">${escapeHtml(emoji)}</span>${users.length}</span>`;
            }
        }
        
        html += '</div>';
        return html;
    }

    /**
     * Render reply preview for a message
     * @param {Object} replyTo - Reply target info
     * @returns {string} - HTML for reply preview
     */
    renderReplyPreview(replyTo) {
        if (!replyTo) return '';
        
        const displayName = replyTo.senderName || formatAddress(replyTo.sender);
        const truncatedName = displayName.length > 18 ? displayName.substring(0, 18) + '...' : displayName;
        // Defense-in-depth: sanitize network content
        const previewText = replyTo.text 
            ? escapeHtml(sanitizeText(replyTo.text.substring(0, 50))) + (replyTo.text.length > 50 ? '...' : '') 
            : '[Message]';
        
        return `
            <div class="reply-preview" data-reply-to-id="${escapeAttr(replyTo.id)}">
                <span class="reply-preview-name">${escapeHtml(sanitizeText(truncatedName))}</span>
                <span class="reply-preview-text">${previewText}</span>
            </div>
        `;
    }

    /**
     * Render image message content
     * @param {Object} msg - Message object
     * @returns {string} - HTML for image
     */
    renderImageContent(msg) {
        if (msg?.transport === 'chunked' && msg?.verified?.valid === false) {
            return `<div class="text-red-400 text-sm">Image failed verification</div>`;
        }

        let imageData = this.deps.getImage?.(msg.imageId);
        
        // If not in cache but embedded in message, use that and cache it
        if (!imageData && msg.imageData) {
            imageData = msg.imageData;
            this.deps.cacheImage?.(msg.imageId, imageData);
        }
        
        if (imageData) {
            const mediaId = this.deps.registerMedia?.(imageData, 'image');
            if (!mediaId) {
                return `<div class="text-red-400 text-sm">Invalid image data</div>`;
            }
            
            return `
                <div class="relative inline-block max-w-xs group">
                    <img src="${imageData}" 
                         class="max-w-full max-h-60 rounded-lg cursor-pointer object-contain lightbox-trigger" 
                         data-media-id="${mediaId}"
                         alt="Image"/>
                    <button class="absolute top-1 right-1 bg-black/60 hover:bg-black/80 text-white p-1 rounded transition opacity-0 group-hover:opacity-100 lightbox-trigger"
                            data-media-id="${mediaId}"
                            title="Maximize">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
                        </svg>
                    </button>
                </div>
            `;
        } else {
            // Load image from IndexedDB ledger (async, will replace placeholder when ready)
            this.deps.loadImageFromLedger?.(msg.imageId);
            // Re-fire delivery if the image is already cached — heals
            // placeholders orphaned by re-render races.
            this.deps.recoverImage?.(msg.imageId);
            // Include channel ID in placeholder to verify channel context when image arrives
            const channel = this.deps.getCurrentChannel?.();
            const channelId = channel?.streamId || '';
            return `
                <div data-image-id="${escapeAttr(msg.imageId)}" data-channel-id="${escapeAttr(channelId)}" class="bg-white/[0.05] rounded-xl p-4 max-w-xs">
                    <div class="flex items-center gap-2">
                        <div class="animate-spin w-4 h-4 border-2 border-white/20 border-t-white rounded-full"></div>
                        <span class="text-white/40 text-sm">Loading image...</span>
                    </div>
                </div>
            `;
        }
    }

    /**
     * Format a transfer rate for display.
     * @param {number|null} bytesPerSec
     * @returns {string} Empty when there is nothing measured yet
     */
    formatSpeed(bytesPerSec) {
        if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
        if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
        if (bytesPerSec < 1048576) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
        return `${(bytesPerSec / 1048576).toFixed(2)} MB/s`;
    }

    /**
     * Shared file-card glyphs (mesh + storage): download arrow, upload arrow,
     * floppy (save). One drawing each so the two transports stay visually
     * consistent.
     */
    iconArrowDown(cls) {
        return `<svg class="${cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 4.5v9.75m0 0 3.75-3.75M12 14.25 8.25 10.5M4.5 19.5h15"/></svg>`;
    }

    iconArrowUp(cls) {
        return `<svg class="${cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 19.5V9.75m0 0 3.75 3.75M12 9.75 8.25 13.5M4.5 4.5h15"/></svg>`;
    }

    iconFloppy(cls) {
        return `<svg class="${cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17.25 3H5.25A2.25 2.25 0 0 0 3 5.25v13.5A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V6.75L17.25 3Z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7.5 3v4.5h8.25V3"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7.5 21v-6.75h9V21"/></svg>`;
    }

    iconCheck(cls) {
        return `<svg class="${cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m4.5 12.75 6 6 9-13.5"/></svg>`;
    }

    /**
     * Tiny transport pill ("mesh" / "storage") — the action glyphs are unified
     * now, so this is what tells the two transports apart at a glance.
     */
    transportBadge(label) {
        return `<span class="inline-block text-[9px] uppercase tracking-wider px-1.5 py-px mr-1.5 rounded bg-white/[0.08] text-white/40 align-middle">${label}</span>`;
    }

    /**
     * Render the bubble for a non-video file.
     *
     * Three states share one shell so the row does not jump around as a transfer
     * moves between them: idle (download button), transferring (bar + statistics),
     * and available (open/save).
     *
     * The single action slot (`.file-card-action`) sits on the AVATAR side —
     * CSS order rules flip it per own/other message and viewport.
     *
     * @param {Object} msg - Message object
     * @param {Object} view - Precomputed view state from renderVideoContent
     * @returns {string} - HTML for the file bubble
     */
    renderFileBubble(msg, { isDownloading, downloadProgress } = {}) {
        const metadata = msg.metadata;
        const fileId = metadata.fileId;
        const safeFileId = escapeAttr(fileId);
        const safeFileName = escapeHtml(sanitizeText(metadata.fileName));
        const attrFileName = escapeAttr(sanitizeText(metadata.fileName));

        const fileUrl = this.deps.getFileUrl?.(fileId);
        const isSeeding = this.deps.isSeeding?.(fileId);
        const canDownload = Array.isArray(metadata.pieceHashes) && metadata.pieceHashes.length > 0;
        const active = isDownloading && downloadProgress;

        const totalSize = this.formatFileSize(metadata.fileSize);
        const percent = active ? downloadProgress.percent : 0;

        // One line of statistics, never two — the bubble is wide enough to hold
        // transferred/total and a rate side by side, and a wrap makes it jitter.
        let detail;
        if (active) {
            const transferred = downloadProgress.total > 0
                ? this.formatFileSize((downloadProgress.received / downloadProgress.total) * downloadProgress.fileSize)
                : '0 B';
            const speed = this.formatSpeed(downloadProgress.bytesPerSec);
            detail = `${transferred} of ${totalSize}${speed ? ` &middot; ${speed}` : ''}`;
        } else if (fileUrl) {
            detail = totalSize;
        } else if (!canDownload) {
            detail = `${totalSize} &middot; not on this device`;
        } else {
            detail = totalSize;
        }

        // Serving stats sit beside the size: an upload glyph with the rate, and a
        // person glyph with however many peers are currently pulling from us.
        const seedingStats = (fileUrl && isSeeding) ? `
            <span class="inline-flex items-center gap-1 ml-1.5" data-upload-stats="${safeFileId}">
                <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 16.5V4m0 0L7.5 8.5M12 4l4.5 4.5M4.5 20h15"/>
                </svg>
                <span data-upload-speed="${safeFileId}"></span>
                <svg class="w-2.5 h-2.5 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6.5 20a5.5 5.5 0 0 1 11 0M12 11.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5M19.5 9.5V4m0 0-2 2m2-2 2 2"/>
                </svg>
                <span data-leecher-count="${safeFileId}">0</span>
            </span>
        ` : '';

        // One action slot on the avatar side: arrow = download, dimmed arrow =
        // transfer running (no spinner — the bar carries the busy state).
        // Saving is automatic once the bytes are here — the floppy only shows
        // as a fallback if that auto-save didn't happen yet; once it has, a
        // plain checkmark confirms it (not a link — nothing left to click).
        let action = '';
        if (fileUrl) {
            action = this.deps.isSaved?.(fileId) ? `
            <div title="Saved" class="file-card-action flex-shrink-0 w-10 h-10 rounded-lg bg-white/[0.06] flex items-center justify-center">
                ${this.iconCheck('w-5 h-5 text-green-400/70')}
            </div>` : `
            <a href="${fileUrl}" download="${attrFileName}" title="Save file"
               class="file-card-action flex-shrink-0 w-10 h-10 rounded-lg bg-white/[0.06] hover:bg-white/[0.14] flex items-center justify-center transition">
                ${this.iconFloppy('w-5 h-5 text-green-400/70')}
            </a>`;
        } else if (active) {
            action = `
            <div class="file-card-action flex-shrink-0 w-10 h-10 rounded-lg bg-white/[0.04] flex items-center justify-center">
                ${this.iconArrowDown('w-5 h-5 text-white/25 animate-pulse')}
            </div>`;
        } else if (canDownload) {
            action = `
            <button class="download-file-btn file-card-action flex-shrink-0 w-10 h-10 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] flex items-center justify-center transition"
                    data-file-id="${safeFileId}" title="Download">
                <span class="download-play-icon">${this.iconArrowDown('w-5 h-5 text-white/60')}</span>
                <div class="download-loading-icon hidden"></div>
            </button>`;
        }

        // The name stays a link once the file is here (the floppy is the obvious
        // target; the title link costs nothing)
        const title = fileUrl
            ? `<a href="${fileUrl}" download="${attrFileName}" class="text-[12px] text-white/80 hover:text-white truncate block" title="${attrFileName}">${safeFileName}</a>`
            : `<div class="text-[12px] text-white/80 truncate" title="${attrFileName}">${safeFileName}</div>`;

        return `
            <div data-file-id="${safeFileId}" class="rounded-xl bg-white/[0.05] overflow-hidden" style="width: 300px; max-width: 100%;">
                <div class="flex items-center gap-2.5 px-3 py-2.5">
                    <div class="min-w-0 flex-1">
                        ${title}
                        <div class="text-[10px] text-white/35 mt-0.5 flex items-center whitespace-nowrap">
                            ${this.transportBadge('mesh')}
                            <span data-progress-text="${safeFileId}">${detail}</span>
                            ${seedingStats}
                        </div>
                        ${(fileUrl && isSeeding) ? `<div class="text-[10px] text-green-400/60 mt-0.5">seeding...</div>` : ''}
                    </div>
                    ${action}
                </div>
                <div class="h-1.5 bg-white/[0.06] ${active ? '' : 'hidden'}" data-progress-overlay="${safeFileId}">
                    <div class="h-full bg-blue-500 rounded-r-full transition-all duration-300"
                         data-progress-fill="${safeFileId}" style="width: ${percent}%"></div>
                </div>
                <span class="hidden" data-progress-percent="${safeFileId}">${percent}%</span>
            </div>
        `;
    }

    /**
     * Format a remaining-time estimate ("42s", "2m 05s", "1h 12m").
     * @param {number} sec
     * @returns {string} Empty when there is no finite estimate
     */
    formatETA(sec) {
        if (!Number.isFinite(sec) || sec < 0) return '';
        if (sec < 60) return `${Math.ceil(sec)}s`;
        const m = Math.floor(sec / 60), s = Math.round(sec % 60);
        if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
        const h = Math.floor(m / 60);
        return `${h}h ${String(m % 60).padStart(2, '0')}m`;
    }

    /**
     * Compose the sender-bubble stats from a storage upload snapshot, as TWO
     * lines so nothing truncates in a 300px card:
     *   line1: "38% · 42.1 of 113 MB · 1.2 MB/s"
     *   line2: "~1m 10s left · processing 64%"
     * Non-sending stages put the engine's phase label on line1
     * (Verifying: 512/1200 confirmed…). Used for the initial render AND the
     * live DOM updates in ui.js — one source for the format.
     * @param {Object} s - storageMediaController.getUploadState() snapshot
     * @returns {{line1: string, line2: string}}
     */
    formatStorageUploadDetail(s) {
        if (!s) return { line1: '', line2: '' };
        if (s.stage && s.stage !== 'sending') return { line1: s.phase || '', line2: '' };
        // line1 = progress only (always fits at 300px); speed + ETA live on line2
        const parts = [`${s.percent || 0}%`];
        const sent = this.formatFileSize(s.bytesSent || 0);
        parts.push(s.totalBytes ? `${sent} of ${this.formatFileSize(s.totalBytes)}` : sent);
        const sub = [];
        const speed = this.formatSpeed(s.instBps ?? s.avgBps);
        if (speed) sub.push(speed);
        const eta = this.formatETA(s.etaSec);
        if (eta) sub.push(`~${eta} left`);
        if (Number.isFinite(s.processingPct) && s.processingPct < 100) sub.push(`processing ${s.processingPct}%`);
        return { line1: parts.join(' · '), line2: sub.join(' · ') };
    }

    /**
     * Compose the receiver-bubble stats from a storage download snapshot,
     * two-line like the upload variant (ETA on line2). Assembly phases
     * (Finishing write / Extracting) replace line1.
     * @param {Object} p - storageMediaController.getDownloadProgress() snapshot
     * @returns {{line1: string, line2: string}}
     */
    formatStorageDownloadDetail(p) {
        if (!p) return { line1: '', line2: '' };
        if (p.phase) return { line1: p.phase, line2: '' };
        // line1 = progress only (always fits at 300px); speed + ETA live on line2
        const transferred = p.total > 0
            ? this.formatFileSize((p.received / p.total) * p.fileSize)
            : '0 B';
        const parts = [`${p.percent}%`, `${transferred} of ${this.formatFileSize(p.fileSize)}`];
        const sub = [];
        const speed = this.formatSpeed(p.instBps ?? p.bytesPerSec);
        if (speed) sub.push(speed);
        const eta = this.formatETA(p.etaSec);
        if (eta) sub.push(`~${eta} left`);
        return { line1: parts.join(' · '), line2: sub.join(' · ') };
    }

    /**
     * Render the bubble for a storage-shared file (storage_file_announce).
     *
     * Persistent transport: the file lives on the channel's storage nodes, so
     * the bubble has no seeder/swarm state. Five states share one shell:
     * uploading (own, pending), idle (download button), downloading (bar +
     * stats), complete (name is the save link; inline player for playable
     * video), and a warning badge when the sender's verify ended incomplete.
     *
     * DOM contract matches the mesh bubble (data-file-id + data-progress-*),
     * so the shared progress handlers in ui.js drive both transports.
     *
     * @param {Object} msg - storage_file_announce message
     * @returns {string}
     */
    renderStorageFileBubble(msg) {
        const metadata = msg.metadata;
        if (!metadata?.transferId) return escapeHtml(msg.text || '');
        const tid = metadata.transferId;
        const safeTid = escapeAttr(tid);
        const safeFileName = escapeHtml(sanitizeText(metadata.fileName));
        const attrFileName = escapeAttr(sanitizeText(metadata.fileName));

        const uploadState = msg.pending ? this.deps.getStorageUploadState?.(tid) : null;
        const fileUrl = this.deps.getStorageFileUrl?.(tid);
        const isDownloading = this.deps.isStorageDownloading?.(tid);
        const downloadProgress = isDownloading ? this.deps.getStorageDownloadProgress?.(tid) : null;
        const resumePct = (!fileUrl && !isDownloading && !msg.pending) ? this.deps.getStorageResumePercent?.(tid) : null;

        const totalSize = this.formatFileSize(metadata.fileSize ?? metadata.originalSize ?? 0);
        const active = !!(isDownloading && downloadProgress) || !!uploadState;
        const percent = uploadState ? (uploadState.percent || 0) : (downloadProgress ? downloadProgress.percent : 0);

        let detail = { line1: totalSize, line2: '' };
        if (uploadState) {
            const d = this.formatStorageUploadDetail(uploadState);
            detail = { line1: escapeHtml(d.line1 || 'Uploading…'), line2: escapeHtml(d.line2) };
        } else if (downloadProgress) {
            const d = this.formatStorageDownloadDetail(downloadProgress);
            detail = { line1: escapeHtml(d.line1), line2: escapeHtml(d.line2) };
        } else if (resumePct) {
            detail = { line1: totalSize, line2: `resumable ${resumePct}%` };
        }

        const incomplete = Number.isFinite(metadata.storedChunks) && Number.isFinite(metadata.totalChunks)
            && metadata.storedChunks !== null && metadata.storedChunks < metadata.totalChunks;
        const incompleteBadge = incomplete
            ? `<div class="text-[10px] text-amber-400/70 mt-0.5">&#9888; incomplete on storage (${metadata.storedChunks}/${metadata.totalChunks})</div>`
            : '';

        // One action slot on the avatar side, unified with the mesh card:
        // arrow = download, up-arrow dimmed = own upload running, arrow dimmed
        // = download running. Saving is automatic once the bytes are here —
        // the floppy is only a fallback for the rare case that didn't happen;
        // once it has, a plain checkmark confirms it.
        const canDownload = !fileUrl && !active && !msg.pending && Number.isFinite(metadata.totalChunks);
        let action = '';
        if (fileUrl) {
            action = this.deps.isStorageSaved?.(tid) ? `
            <div title="Saved" class="file-card-action flex-shrink-0 w-10 h-10 rounded-lg bg-white/[0.06] flex items-center justify-center">
                ${this.iconCheck('w-5 h-5 text-green-400/70')}
            </div>` : `
            <a href="${fileUrl}" download="${attrFileName}" title="Save file"
               class="file-card-action flex-shrink-0 w-10 h-10 rounded-lg bg-white/[0.06] hover:bg-white/[0.14] flex items-center justify-center transition">
                ${this.iconFloppy('w-5 h-5 text-green-400/70')}
            </a>`;
        } else if (uploadState) {
            action = `
            <div class="file-card-action flex-shrink-0 w-10 h-10 rounded-lg bg-white/[0.04] flex items-center justify-center">
                ${this.iconArrowUp('w-5 h-5 text-white/25 animate-pulse')}
            </div>`;
        } else if (active) {
            action = `
            <div class="file-card-action flex-shrink-0 w-10 h-10 rounded-lg bg-white/[0.04] flex items-center justify-center">
                ${this.iconArrowDown('w-5 h-5 text-white/25 animate-pulse')}
            </div>`;
        } else if (canDownload) {
            action = `
            <button class="storage-download-btn file-card-action flex-shrink-0 w-10 h-10 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] flex items-center justify-center transition"
                    data-file-id="${safeTid}" data-msg-id="${escapeAttr(msg.id || '')}" title="Download from storage">
                <span class="download-play-icon">${this.iconArrowDown('w-5 h-5 text-white/60')}</span>
                <div class="download-loading-icon hidden"></div>
            </button>`;
        }

        // Completed playable video → inline player above the file row
        let playerHtml = '';
        if (fileUrl && (metadata.fileType || '').startsWith('video/') && this.deps.isVideoPlayable?.(metadata.fileType)) {
            playerHtml = `
                <div class="relative rounded-t-xl overflow-hidden bg-black">
                    <video src="${fileUrl}" class="max-w-full max-h-60" controls preload="metadata" playsinline></video>
                </div>
            `;
        }

        const title = fileUrl
            ? `<a href="${fileUrl}" download="${attrFileName}" class="text-[12px] text-white/80 hover:text-white truncate block" title="${attrFileName}">${safeFileName}</a>`
            : `<div class="text-[12px] text-white/80 truncate" title="${attrFileName}">${safeFileName}</div>`;

        return `
            <div data-file-id="${safeTid}" class="rounded-xl bg-white/[0.05] overflow-hidden" style="width: 300px; max-width: 100%;">
                ${playerHtml}
                <div class="flex items-center gap-2.5 px-3 py-2.5">
                    <div class="min-w-0 flex-1">
                        ${title}
                        <div class="mt-0.5 flex items-start whitespace-nowrap">
                            ${this.transportBadge('storage')}
                            <div class="min-w-0 flex-1">
                                <div class="text-[10px] ${active ? 'text-white/55' : 'text-white/35'} overflow-hidden text-ellipsis">
                                    <span data-progress-text="${safeTid}">${detail.line1}</span>
                                </div>
                                <div class="text-[10px] ${active ? 'text-white/45' : 'text-white/30'} overflow-hidden text-ellipsis">
                                    <span data-progress-eta="${safeTid}">${detail.line2}</span>
                                </div>
                            </div>
                        </div>
                        ${incompleteBadge}
                    </div>
                    ${action}
                </div>
                <div class="h-1.5 bg-white/[0.06] ${active ? '' : 'hidden'}" data-progress-overlay="${safeTid}">
                    <div class="h-full rounded-r-full transition-all duration-300"
                         style="width: ${percent}%; background: linear-gradient(90deg, #6366f1, #8b5cf6);"
                         data-progress-fill="${safeTid}"></div>
                </div>
                <span class="hidden" data-progress-percent="${safeTid}">${percent}%</span>
            </div>
        `;
    }

    /**
     * Render video announcement content
     * @param {Object} msg - Message object
     * @returns {string} - HTML for video
     */
    renderVideoContent(msg) {
        const metadata = msg.metadata;
        if (!metadata) return escapeHtml(msg.text || '');
        
        const currentAddress = this.deps.getCurrentAddress?.();
        const isOwn = msg.sender?.toLowerCase() === currentAddress?.toLowerCase();
        
        const videoUrl = this.deps.getFileUrl?.(metadata.fileId);
        const isSeeding = this.deps.isSeeding?.(metadata.fileId);
        const isDownloading = this.deps.isDownloading?.(metadata.fileId);
        const downloadProgress = isDownloading ? this.deps.getDownloadProgress?.(metadata.fileId) : null;
        
        const safeFileId = escapeAttr(metadata.fileId);
        // Defense-in-depth: sanitize network-provided metadata
        const safeFileName = escapeHtml(sanitizeText(metadata.fileName));
        const safeFileType = escapeHtml(sanitizeText(metadata.fileType));
        
        // Non-video files get their own bubble in every state: the player shell and the
        // 16:9 download panel below are both meaningless for a PDF or an archive, and a
        // file row has space for the transfer statistics a video thumbnail does not.
        if (!(metadata.fileType || '').startsWith('video/')) {
            return this.renderFileBubble(msg, { isDownloading, downloadProgress });
        }

        if (videoUrl) {
            const isPlayable = this.deps.isVideoPlayable?.(metadata.fileType);
            const videoMediaId = this.deps.registerMedia?.(videoUrl, 'video');
            
            if (isPlayable && videoMediaId) {
                return `
                    <div data-file-id="${safeFileId}" class="video-container">
                        <div class="relative rounded-lg overflow-hidden bg-black">
                            <video src="${videoUrl}" 
                                   class="w-full max-h-56 cursor-pointer video-player-${safeFileId}" 
                                   controls
                                   preload="metadata"
                                   playsinline>
                                <source src="${videoUrl}" type="${safeFileType}">
                            </video>
                            <button class="absolute top-1 right-1 bg-black/60 hover:bg-black/80 text-white p-1 rounded transition lightbox-trigger"
                                    data-media-id="${videoMediaId}"
                                    title="Fullscreen">
                                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/>
                                </svg>
                            </button>
                            ${isSeeding ? `
                            <div class="absolute bottom-1 left-1 bg-green-600/80 text-white text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-1">
                                <svg class="w-2.5 h-2.5 animate-pulse" fill="currentColor" viewBox="0 0 20 20">
                                    <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z"/>
                                </svg>
                                Seeding
                            </div>
                            ` : ''}
                        </div>
                        <div class="flex items-center gap-2 mt-1 px-0.5 text-[11px] text-white/40">
                            <span class="truncate flex-1">${safeFileName}</span>
                            <span class="text-white/25">${this.formatFileSize(metadata.fileSize)}</span>
                            <a href="${videoUrl}" download="${safeFileName}" class="text-blue-400 hover:text-blue-300">Save</a>
                        </div>
                    </div>
                `;
            } else {
                return `
                    <div data-file-id="${safeFileId}" class="video-container">
                        <div class="flex items-center gap-2 bg-white/[0.05] rounded-xl p-2">
                            <svg class="w-8 h-8 text-purple-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/>
                            </svg>
                            <div class="flex-1 min-w-0">
                                <div class="text-sm text-white truncate">${safeFileName}</div>
                                <div class="text-[10px] text-yellow-500/80">Format not playable · ${this.formatFileSize(metadata.fileSize)}</div>
                            </div>
                            <a href="${videoUrl}" download="${safeFileName}" class="bg-blue-600 hover:bg-blue-500 text-white px-2.5 py-1 rounded text-xs flex-shrink-0 transition">
                                Save
                            </a>
                        </div>
                        ${isSeeding ? `
                        <div class="flex items-center gap-1 mt-1 px-0.5">
                            <div class="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
                            <span class="text-[10px] text-green-400">Seeding</span>
                        </div>
                        ` : ''}
                    </div>
                `;
            }
        }
        
        // No local copy, and no piece hashes to fetch one. This is a lean record
        // restored from our own sync: it carries naming only, deliberately, so the
        // manifest's hashes never ride the sync payload. Nothing here is actionable,
        // so it gets its own muted treatment rather than a download panel whose
        // button could only ever fail.
        const canDownload = Array.isArray(metadata.pieceHashes) && metadata.pieceHashes.length > 0;
        if (!canDownload) {
            return `
                <div data-file-id="${safeFileId}" class="flex items-center gap-2.5 rounded-xl border border-dashed border-white/10 bg-white/[0.03] px-3 py-2.5" style="max-width: 220px;">
                    <div class="flex-shrink-0 w-8 h-8 rounded-lg bg-white/[0.04] flex items-center justify-center">
                        <svg class="w-4 h-4 text-white/25" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/>
                        </svg>
                    </div>
                    <div class="min-w-0 flex-1">
                        <div class="text-[12px] text-white/50 truncate" title="${escapeAttr(sanitizeText(metadata.fileName))}">${safeFileName}</div>
                        <div class="text-[10px] text-white/25 mt-0.5">
                            Video &middot; ${this.formatFileSize(metadata.fileSize)} &middot; not on this device
                        </div>
                    </div>
                </div>
            `;
        }

        // Video not available yet - show preview panel (with downloading state if active)
        const dlActive = isDownloading && downloadProgress;
        const dlPercent = dlActive ? downloadProgress.percent : 0;
        const dlReceivedMB = dlActive && downloadProgress.total > 0 ? ((downloadProgress.received / downloadProgress.total) * downloadProgress.fileSize / (1024 * 1024)).toFixed(1) : '0.0';
        const dlTotalMB = dlActive ? (downloadProgress.fileSize / (1024 * 1024)).toFixed(1) : '0.0';
        const overlayClass = dlActive ? '' : 'hidden';
        const playIconClass = dlActive ? 'hidden' : '';
        const loadingIconClass = dlActive ? '' : 'hidden';
        const btnDisabled = dlActive ? 'disabled' : '';
        const btnCursorClass = dlActive ? 'cursor-not-allowed' : '';

        return `
            <div data-file-id="${safeFileId}" class="video-container">
                <div class="relative rounded-xl overflow-hidden bg-white/[0.05] cursor-pointer group"
                     style="aspect-ratio: 16/9; width: 220px;">
                    <div class="absolute inset-0 flex items-center justify-center">
                        <svg class="w-10 h-10 text-purple-500/20" fill="currentColor" viewBox="0 0 24 24">
                            <path d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/>
                        </svg>
                    </div>
                    <button class="download-file-btn absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/40 transition-all ${btnCursorClass}" 
                            data-file-id="${safeFileId}" ${btnDisabled}>
                        <div class="play-btn-container transform group-hover:scale-105 transition-transform">
                            <div class="w-12 h-12 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center border border-white/30">
                                <svg class="w-5 h-5 text-white ml-0.5 download-play-icon ${playIconClass}" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M8 5v14l11-7z"/>
                                </svg>
                                <div class="download-loading-icon ${loadingIconClass}">
                                    <div class="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                                </div>
                            </div>
                        </div>
                    </button>
                    <div data-progress-overlay="${safeFileId}" class="${overlayClass} absolute inset-0 bg-black/70 flex flex-col items-center justify-center">
                        <div class="text-white text-sm font-medium" data-progress-percent="${safeFileId}">${dlPercent}%</div>
                        <div class="w-2/3 bg-white/10 rounded-full h-1.5 mt-1.5">
                            <div data-progress-fill="${safeFileId}" class="bg-blue-500 h-1.5 rounded-full transition-all duration-300" style="width: ${dlPercent}%"></div>
                        </div>
                        <div class="text-[10px] text-white/30 mt-1" data-progress-text="${safeFileId}">${dlActive ? `${dlReceivedMB} / ${dlTotalMB} MB` : 'Starting...'}</div>
                    </div>
                    <div class="absolute top-1.5 left-1.5 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1">
                        <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20">
                            <path d="M2 6a2 2 0 012-2h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6zm12.553 1.106A1 1 0 0014 8v4a1 1 0 00.553.894l2 1A1 1 0 0018 13V7a1 1 0 00-1.447-.894l-2 1z"/>
                        </svg>
                        ${this.formatFileSize(metadata.fileSize)}
                    </div>
                    <div class="absolute top-1.5 right-1.5 bg-black/60 text-white/30 text-[10px] px-1.5 py-0.5 rounded" data-seeder-count="${safeFileId}"></div>
                </div>
                <div class="mt-1 px-0.5 text-[11px] text-white/40 truncate" title="${escapeHtml(sanitizeText(metadata.fileName))}">
                    ${escapeHtml(sanitizeText(metadata.fileName))}
                </div>
            </div>
        `;
    }

    /**
     * Render message content based on type
     * @param {Object} msg - Message object
     * @returns {string} - HTML for message content
     */
    renderMessageContent(msg) {
        const type = msg.type || 'text';
        
        switch (type) {
            case 'image':
                return this.renderImageContent(msg);
                
            case 'file_announce':
                return this.renderVideoContent(msg);

            case 'storage_file_announce':
                return this.renderStorageFileBubble(msg);

            default:
                const escapedText = escapeHtml(msg.text || '');
                const withLinks = linkify(escapedText);
                // Only embed YouTube if setting is enabled
                const youtubeEnabled = this.deps.getYouTubeEmbedsEnabled?.() !== false;
                const withYouTube = youtubeEnabled ? embedYouTubeLinks(withLinks) : withLinks;
                const withLineBreaks = withYouTube.replace(/\n/g, '<br>');
                // Defense-in-depth: sanitize final HTML before rendering
                return sanitizeMessageHtml(this.wrapInlineEmojis(withLineBreaks));
        }
    }

    /**
     * Build HTML for the opening of a message group wrapper.
     * The group contains a single sticky avatar rail + a stack of message entries.
     * Pair with buildMessageGroupCloseHTML().
     * @param {Object} group - { sender, isOwn, ensAvatarUrl, displayName }
     * @returns {string} - HTML for group open
     */
    buildMessageGroupOpenHTML({ sender, isOwn, ensAvatarUrl, spacingClass = '' }) {
        const avatarContent = getAvatarHtml(sender, 46, 0.5, ensAvatarUrl);
        const senderAttr = escapeAttr(sender || '');
        const sideClass = isOwn ? 'own-message-group' : 'other-message-group';
        return `
            <div class="message-group ${sideClass} ${spacingClass}" data-group-sender="${senderAttr}">
                <div class="message-group-avatar-rail">
                    <div class="message-avatar">${avatarContent}</div>
                </div>
                <div class="message-group-stack">
        `;
    }

    /**
     * Build HTML for closing a message group wrapper.
     * @returns {string}
     */
    buildMessageGroupCloseHTML() {
        return `
                </div>
            </div>
        `;
    }

    /**
     * Build HTML for a single message
     * @param {Object} msg - Message object
     * @param {boolean} isOwn - Whether message is own
     * @param {string} time - Formatted time string
     * @param {Object} badge - Verification badge info
     * @param {string} displayName - Display name
     * @param {string} groupClass - CSS class for group position (optional)
     * @param {string} groupPosition - Group position enum value (optional)
     * @param {string} spacingClass - CSS class for spacing (optional)
     * @param {string|null} ensAvatarUrl - ENS avatar URL (kept for signature compatibility, unused since avatar is at group level)
     * @returns {string} - HTML for message
     */
    buildMessageHTML(msg, isOwn, time, badge, displayName, groupClass = 'msg-group-single', groupPosition = GroupPosition.SINGLE, spacingClass = '', ensAvatarUrl = null) {
        const msgId = msg.id || msg.timestamp;
        const reactionsHtml = this.renderReactions(msgId, isOwn);
        const contentHtml = this.renderMessageContent(msg);
        const replyPreviewHtml = this.renderReplyPreview(msg.replyTo);
        
        const msgType = msg.type || 'text';
        const emojiOnly = msgType === 'text' ? this.isEmojiOnly(msg.text) : false;
        const emojiAttr = emojiOnly ? ` data-emoji-only="${emojiOnly}"` : '';
        
        // Sender-row is always emitted; CSS hides it for msg-group-middle/msg-group-last.
        // This lets removeMessage flip group classes without rebuilding HTML.
        const senderColor = addressToColor(msg.sender);
        const truncatedName = displayName.length > 18 ? displayName.substring(0, 18) + '...' : displayName;
        const senderRowHtml = `
                    <div class="message-sender-row flex items-center gap-1 mb-0">
                        ${badge.html}
                        <span class="message-sender-name text-[13px] font-medium" style="color: ${senderColor}">${escapeHtml(sanitizeText(truncatedName))}</span>
                    </div>`;

        // A moderator's view of a hidden message: dimmed, labelled, still
        // reachable by the context menu for Unhide and Erase.
        const moderationHtml = msg._hidden
            ? `<div class="message-moderation text-[11px] text-amber-400/80 mb-1">${msg._erased ? 'Hidden · erased from storage' : 'Hidden by moderation'}</div>`
            : '';
        const bubbleStyle = msg._hidden ? ' style="opacity:0.45"' : '';

        return `
            <div class="message-entry ${isOwn ? 'own-message' : 'other-message'} ${groupClass} ${spacingClass}${msg._hidden ? ' message-hidden' : ''}" data-msg-id="${escapeAttr(msgId)}" data-sender="${escapeAttr(msg.sender || '')}" data-type="${escapeAttr(msgType)}"${emojiAttr}>
                <div class="message-bubble"${bubbleStyle}>
                    ${moderationHtml}
                    ${senderRowHtml}
                    ${replyPreviewHtml}
                    <div class="message-content">${contentHtml}</div>
                    <div class="message-footer">
                        ${reactionsHtml}
                        ${msg._edited ? '<span class="message-edited text-xs text-white/25">(edited)</span>' : ''}
                        <span class="message-time text-xs text-white/40">${time}</span>
                    </div>
                    ${msg.verified && !msg.verified.valid && msg.signature ? '<div class="text-xs text-red-400 mt-1">⚠️ Invalid signature</div>' : ''}
                    <span class="reply-trigger reply-btn" data-msg-id="${escapeAttr(msgId)}" title="Reply"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17l-5-5 5-5"/><path d="M4 12h11a4 4 0 0 1 4 4v4"/></svg></span>
                    <span class="react-trigger react-btn" data-msg-id="${escapeAttr(msgId)}" title="React"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg></span>
                </div>
            </div>
        `;
    }
}

// Export singleton instance
export const messageRenderer = new MessageRenderer();
