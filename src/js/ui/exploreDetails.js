/**
 * Channel details sheet opened from an Explore card: everything the
 * directory knows about a channel the viewer has not joined.
 */

import { GATE_MODE } from '../gate.js';
import { escapeHtml, escapeAttr, formatAddress, wireIdentitySpec, wireIdentityIcon } from './utils.js';
import { sanitizeText } from './sanitizer.js';

/** The type a reader recognises: the gate mode decides for gated channels. */
export function channelTypeLabel(ch, gateInfo) {
    if (ch?.type === 'password') return 'Password';
    if (ch?.type !== 'gated') return 'Open';
    if (gateInfo?.mode === GATE_MODE.PAID) return 'Paid';
    if (gateInfo?.mode === GATE_MODE.NONE) return 'Closed';
    return 'Gated';
}

const row = (label, valueHtml) => `
    <div class="flex items-start justify-between gap-4 py-2.5 border-b border-overlay-5 last:border-b-0">
        <span class="text-[13px] text-overlay-40 flex-shrink-0">${label}</span>
        <span class="text-[13px] text-overlay-90 text-right min-w-0">${valueHtml}</span>
    </div>`;

const copyButton = (value, what) => `
    <button type="button" class="explore-details-copy ml-1.5 align-middle text-overlay-40 hover:text-primary transition" data-copy="${escapeAttr(value)}" data-copy-what="${escapeAttr(what)}" title="Copy">
        <svg class="w-3.5 h-3.5 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-9.077a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25"/></svg>
    </button>`;

/**
 * @param {Object} ch - directory entry (streamId, name, description, type, createdAt, gateAddress, wireIdentity)
 * @param {Object} opts
 * @param {string} opts.thumbHtml - the channel image, already sized
 * @param {Object|null} [opts.gateInfo] - cached gate card info ({mode, verb, value, qualifier})
 * @param {string|null} [opts.ownerName] - the owner's ENS name, when known
 * @returns {string}
 */
export function renderExploreDetails(ch, { thumbHtml, gateInfo = null, ownerName = null }) {
    const owner = String(ch.streamId || '').split('/')[0];
    const created = ch.createdAt
        ? new Date(ch.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : null;
    const rows = [row('Type', escapeHtml(channelTypeLabel(ch, gateInfo)))];
    if (ch.type === 'gated' && gateInfo?.verb) {
        rows.push(row('Access', escapeHtml(`${gateInfo.verb} ${gateInfo.value} ${gateInfo.qualifier}`)));
    }
    if (ch.type === 'gated') {
        const spec = wireIdentitySpec(ch.wireIdentity);
        rows.push(row('Identity on the wire', `<span class="inline-flex items-center gap-1.5 justify-end">${wireIdentityIcon(ch.wireIdentity, 'w-4 h-4 text-overlay-50')}${escapeHtml(spec.name)}</span><span class="block text-[11px] text-overlay-40 mt-0.5">${escapeHtml(spec.audience)}</span>`));
    }
    if (owner) {
        const ownerLabel = ownerName
            ? `${escapeHtml(ownerName)} <span class="text-overlay-40">${escapeHtml(formatAddress(owner))}</span>`
            : `<span class="font-mono">${escapeHtml(formatAddress(owner))}</span>`;
        rows.push(row('Owner', `<span data-details-owner>${ownerLabel}</span>${copyButton(owner, 'Address')}`));
    }
    if (created) rows.push(row('Created', escapeHtml(created)));
    rows.push(row('Channel ID', `<span class="font-mono text-[12px] break-all">${escapeHtml(ch.streamId)}</span>${copyButton(ch.streamId, 'Channel ID')}`));

    const description = ch.description
        ? `<p class="text-[14px] text-overlay-60 mt-3 whitespace-pre-line break-words">${escapeHtml(sanitizeText(ch.description))}</p>`
        : '';
    return `
        <div class="flex flex-col items-center text-center">
            ${thumbHtml}
            <h3 class="text-lg font-semibold text-overlay-90 mt-3 break-words">${escapeHtml(sanitizeText(ch.name || ch.displayName || 'Unknown'))}</h3>
            ${description}
        </div>
        <div class="mt-4">${rows.join('')}</div>
        <div class="mt-4 flex justify-center">
            <button type="button" disabled class="inline-flex items-center gap-1.5 text-[12px] text-overlay-30 cursor-not-allowed">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 3v1.5M3 21v-6m0 0l2.77-.693a9 9 0 016.208.682l.108.054a9 9 0 006.086.71l3.114-.732a48.524 48.524 0 01-.005-10.499l-3.11.732a9 9 0 01-6.085-.711l-.108-.054a9 9 0 00-6.208-.682L3 4.5M3 15V4.5"/></svg>
                Report · Soon
            </button>
        </div>`;
}
