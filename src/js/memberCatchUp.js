/**
 * Member catch-up on a gated channel: a periodic RAW resend of the keys
 * stream and of the message stream while the channel is open.
 *
 * It exists because a member's delivery has two soft spots the owner does
 * not have. Their KEY_REQUEST is dropped by the responders' live
 * subscription — the SDK validates on the subscribing edge and a read-only
 * channel's contract refuses a member's signature — so keys arrive only when
 * a responder sweeps; and a live message subscription on a thin mesh can
 * silently deliver less than the stream holds, which is the same reason
 * every resend in the app is raw.
 *
 * Both halves are pure catch-up: they replay through the ordinary ingest,
 * which dedupes by message id, so a tick that finds nothing new costs one
 * HTTP resend and changes nothing.
 */

import { Logger } from './logger.js';
import { CONFIG } from './config.js';
import { ResendPoller } from './adminStatePoller.js';
import { streamrController, STREAM_CONFIG } from './streamr.js';
import { epochKeyManager, usesEpochKeys } from './epochKeyManager.js';
import { authManager } from './auth.js';

const poller = new ResendPoller(
    'MemberCatchUp', () => CONFIG?.subscriptions?.memberCatchUpIntervalMs);

/** The owner needs none of this: they publish, and they answer their own keys. */
function isOwner(channel) {
    const me = (authManager.getAddress() || '').toLowerCase();
    if (!me) return false;
    const owner = (channel.createdBy || channel.messageStreamId.split('/')[0] || '').toLowerCase();
    return !!owner && owner === me;
}

async function tick(channel, onMessage) {
    await epochKeyManager.ensureChannelKeys(channel).catch(e =>
        Logger.debug('Member catch-up: key sweep failed:', e.message));
    await new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        try {
            streamrController.fetchHistoryAsync(
                channel.messageStreamId,
                STREAM_CONFIG.MESSAGE_STREAM.MESSAGES,
                CONFIG.subscriptions.memberCatchUpCount,
                onMessage,
                channel.password || null,
                done);
        } catch (e) {
            Logger.debug('Member catch-up: message sweep failed:', e.message);
            done();
        }
    });
}

export const memberCatchUp = {
    /** Start catching up for this channel, if this account is a member of it. */
    start(channel, onMessage) {
        if (!channel || !usesEpochKeys(channel) || channel.preview) return;
        if (isOwner(channel)) return;
        poller.start(channel.messageStreamId, () => tick(channel, onMessage));
    },

    stop(messageStreamId = null) {
        if (messageStreamId && poller.getStreamId() !== messageStreamId) return;
        poller.stop();
    },

    getStreamId() { return poller.getStreamId(); }
};
