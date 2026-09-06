/**
 * UI Utility Functions
 * Common helpers for HTML escaping, formatting, and validation
 */

import { getAddressColor } from './AvatarGenerator.js';

/**
 * Escape HTML to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} - Escaped string
 */
export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    // Ensure str is a string (handles objects, numbers, etc.)
    const s = typeof str === 'string' ? str : String(str);
    return s.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
}

/**
 * Escape string for use in HTML attributes (alias for escapeHtml)
 * @param {string} str - String to escape
 * @returns {string} - Escaped string safe for attributes
 */
export function escapeAttr(str) {
    return escapeHtml(str);
}

/**
 * Format Ethereum address for display
 * @param {string} address - Full address
 * @returns {string} - Formatted address (e.g., "0x1234...abcd")
 */
export function formatAddress(address) {
    if (!address) return 'Unknown';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Stream id with the owner address abbreviated — the path is what identifies
 * a channel, the address only says whose it is.
 * @param {string} streamId
 * @returns {string} - e.g. "0xae34...7667/9862eb7bd898f338-1"
 */
export function formatStreamId(streamId) {
    if (!streamId) return '';
    const slash = streamId.indexOf('/');
    if (slash < 12) return streamId;
    return formatAddress(streamId.slice(0, slash)) + streamId.slice(slash);
}

/**
 * Validate URL for safe use in src/href attributes
 * Prevents javascript: and other dangerous protocols
 * @param {string} url - URL to validate
 * @returns {boolean} - True if URL is safe
 */
export function isValidMediaUrl(url) {
    if (!url || typeof url !== 'string') return false;
    // Allow data URIs (base64 images/video), blob URLs, and http(s)
    if (url.startsWith('data:image/') || url.startsWith('data:video/')) return true;
    if (url.startsWith('blob:')) return true;
    try {
        const parsed = new URL(url);
        return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
        return false;
    }
}

/**
 * Generate a deterministic color from an Ethereum address
 * Uses the same color as the avatar for consistency
 * @param {string} address - Ethereum address (0x...)
 * @returns {string} - Hex color code
 */
export function addressToColor(address) {
    return getAddressColor(address);
}

/**
 * Convert URLs in text to clickable links
 * MUST be called on already HTML-escaped text to prevent XSS
 * @param {string} escapedText - HTML-escaped text
 * @returns {string} - Text with URLs converted to anchor tags
 */
export function linkify(escapedText) {
    if (!escapedText) return '';
    
    // URL regex pattern - matches http, https URLs
    // Works on escaped text where < > are already &lt; &gt;
    const urlPattern = /(https?:\/\/[^\s<>"'`()\[\]{}]+)/gi;
    
    return escapedText.replace(urlPattern, (url) => {
        // Decode HTML entities for the href (browser will encode as needed)
        let decodedUrl = url
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
        
        // Validate URL to prevent javascript: or other dangerous protocols
        try {
            const parsed = new URL(decodedUrl);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                return url; // Return original escaped text, not a link
            }
        } catch {
            return url; // Invalid URL, return as plain text
        }
        
        // Escape for href attribute (quotes and special chars)
        const safeHref = decodedUrl
            .replace(/"/g, '%22')
            .replace(/'/g, '%27')
            .replace(/</g, '%3C')
            .replace(/>/g, '%3E');
        
        // Truncate display text if too long
        const displayUrl = url.length > 50 ? url.substring(0, 47) + '...' : url;
        
        return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" class="text-[#F6851B] hover:underline break-all">${displayUrl}</a>`;
    });
}

/**
 * Convert YouTube links in HTML to embedded players
 * MUST be called on already processed HTML (after linkify)
 * @param {string} html - HTML with links
 * @returns {string} - HTML with YouTube embeds added after links
 */
export function embedYouTubeLinks(html) {
    if (!html) return '';
    
    // Match YouTube URLs in anchor tags - handles both & and &amp; in URLs
    const youtubeUrlPattern = /<a[^>]*href="(https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})[^"]*)"[^>]*>[^<]*<\/a>/gi;
    
    return html.replace(youtubeUrlPattern, (match, fullUrl, videoId) => {
        // Validate videoId format (11 alphanumeric chars, hyphens, underscores)
        if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
            return match;
        }
        
        // Return original link + embed below it
        const embed = `<div class="youtube-embed"><iframe src="https://www.youtube-nocookie.com/embed/${videoId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
        
        return match + embed;
    });
}

/**
 * Author-visibility vocabulary, shared by Explore and Channel Details: WHO
 * can see who wrote each message, group (members only) or globe (everyone).
 * Never an identity glyph: both modes guarantee authorship to participants,
 * what changes is the audience.
 */
export const WIRE_IDENTITY = {
    sealed: {
        name: 'Sealed',
        audience: 'authors readable by members only',
        path: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"/>'
    },
    visible: {
        name: 'Visible',
        audience: 'every message signed by its author',
        path: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m-18.716-2.253A8.959 8.959 0 003 12c0 .778.099 1.533.284 2.253"/>'
    }
};

/** The mode spec, defaulting to Visible for anything unrecognised. */
export function wireIdentitySpec(wireIdentity) {
    return WIRE_IDENTITY[wireIdentity === 'sealed' ? 'sealed' : 'visible'];
}

/** The mode's glyph, sized by the caller. */
export function wireIdentityIcon(wireIdentity, cls = 'w-4 h-4') {
    return `<svg class="${cls}" fill="none" stroke="currentColor" viewBox="0 0 24 24">${wireIdentitySpec(wireIdentity).path}</svg>`;
}
