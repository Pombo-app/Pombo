/**
 * channelPreviewFormatter
 *
 * Pure formatting helpers for the "latest message preview" line shown in
 * the sidebar (ChannelListUI) and Explore (ExploreUI). Renders the entries
 * produced by `channelLatestMessageManager` into safe HTML fragments.
 *
 * Output contract: the strings returned here are already HTML-safe (every
 * variable goes through `escapeHtml` / `sanitizeText`). Callers should
 * inject them with `innerHTML` directly — never wrap them in another
 * escape.
 *
 * Format spec (decided 2026-04-28):
 *   - text          → "{sender}: {text}"          (text via sanitize+escape)
 *   - image         → "{sender}: [image]"         (literal italic tag)
 *   - file_announce→ "{sender}: [video]"
 *   - reaction add  → "{sender}: reacted with {emoji}"
 *   - reaction rem  → dropped at the manager level (never reaches the UI)
 *   - null entry    → "" (caller decides whether to show spinner / blank)
 *
 * Sender resolution (highest priority first):
 *   - Own address                    → "You"
 *   - ENS name (identityManager.ensCache, if resolved)
 *   - `entry.senderName` (user-set display name carried in payload)
 *   - Trusted contact nickname (identityManager.getTrustedContact)
 *   - Short address fallback (`0x12ab...`)
 */

import { escapeHtml } from './utils.js';
import { sanitizeText } from './sanitizer.js';
import { identityManager } from '../identity.js';
import { authManager } from '../auth.js';

function formatPreviewAddress(address) {
    if (!address || typeof address !== 'string') return '';
    return address.length <= 6 ? address : `${address.slice(0, 6)}...`;
}

/**
 * Resolve a display label for the preview sender.
 * Sync — uses identity caches only; never triggers a network lookup.
 * Priority: You → ENS → senderName → trusted-contact-nickname → short addr.
 * @param {string|null} address
 * @param {string|null} [senderName] - user-set display name carried in the
 *                                     message payload.
 * @returns {string} display name (already safe to inject after escape)
 */
export function formatPreviewSender(address, senderName = null) {
    if (!address && !senderName) return '';
    try {
        const me = authManager.getAddress?.();
        if (me && address && address.toLowerCase() === me.toLowerCase()) return 'You';
    } catch {}
    // 1) ENS (verified, on-chain) wins over self-declared / contact labels.
    if (address) {
        try {
            const norm = address.toLowerCase();
            const cached = identityManager.ensCache?.get(norm);
            if (cached && cached.name) return cached.name;
        } catch {}
    }
    // 2) Self-declared sender name from the message payload.
    if (senderName && typeof senderName === 'string' && senderName.trim()) {
        return senderName.trim();
    }
    // 3) Trusted contact nickname → short address fallback.
    if (address) {
        try {
            const contact = identityManager.getTrustedContact?.(address);
            if (contact && typeof contact.nickname === 'string' && contact.nickname.trim()) {
                return contact.nickname.trim();
            }
        } catch {}
        return formatPreviewAddress(address);
    }
    return '';
}

/**
 * Render the preview body (the part after the sender prefix). Returns an
 * HTML fragment safe for direct innerHTML injection.
 * @param {Object|null} entry - canonical preview entry from channelLatestMessageManager
 * @returns {string}
 */
export function formatPreviewBody(entry) {
    if (!entry || typeof entry !== 'object') return '';
    // Lighter accent tag for media / reaction verbs. Inherits color
    // from the surrounding `.channel-preview-line` parent so callers
    // can theme everything in one place.
    const mute = (txt) => `<em class="preview-mute">${escapeHtml(txt)}</em>`;
    switch (entry.type) {
        case 'text': {
            const t = entry.text || '';
            return escapeHtml(sanitizeText(t));
        }
        case 'image':
            return mute('🖼️ Image');
        case 'video_announce':
            return mute('🎬 Video');
        case 'file_announce':
        case 'storage_file_announce': {
            const mime = entry.fileType || '';
            if (mime.startsWith('video/')) return mute('🎬 Video');
            if (mime.startsWith('image/')) return mute('🖼️ Image');
            return mute(`📎 ${sanitizeText(entry.fileName || 'File')}`);
        }
        case 'reaction': {
            // Reaction removals are filtered out upstream
            // (channelLatestMessageManager). Defensive fallthrough only.
            if (entry.action === 'remove') return '';
            const emoji = entry.emoji ? escapeHtml(entry.emoji) : '';
            return `${mute('reacted with')} ${emoji}`.trim();
        }
        default:
            return '';
    }
}

/**
 * Render the full preview line (sender + body) as HTML.
 * Returns "" when no entry is available — callers can fall back to a
 * spinner or blank line based on whether the lookup has already settled.
 * @param {Object|null} entry
 * @param {Object} [opts]
 * @param {boolean} [opts.omitSender=false] - drop the sender prefix
 *        entirely (used for DMs, where the conversation has only two
 *        participants and the prefix is redundant).
 * @returns {string}
 */
export function formatPreviewLine(entry, { omitSender = false } = {}) {
    if (!entry) return '';
    let senderHtml = '';
    if (!omitSender) {
        const senderRaw = formatPreviewSender(entry.sender, entry.senderName);
        // No inline color classes — sender, separator and body all
        // inherit from the `.channel-preview-line` wrapper so addresses,
        // ENS names and nicknames render uniformly.
        senderHtml = senderRaw
            ? `${escapeHtml(senderRaw)}<span class="preview-sep">: </span>`
            : '';
    }
    const body = formatPreviewBody(entry);
    if (!senderHtml && !body) return '';
    return `${senderHtml}${body}`;
}
