/**
 * The live message pipeline: everything that happens to an envelope between
 * the subscription handing it over and the caller seeing it.
 *
 * Both subscription paths, the one that opens a stored stream with history and
 * the one that adds a partition on demand, ran their own copy of this. They
 * differed only in comments, one variable name and a log string, so the two
 * copies could drift apart silently; a rule fixed in one and forgotten in the
 * other is exactly the kind of bug that outlives a refactor. There is one copy
 * now, and the label says which caller it is serving.
 */

import { Logger } from '../logger.js';
import { cryptoManager } from '../crypto.js';

export class MessagePipeline {
    /**
     * Calls back into `controller` on purpose: while the controller is still
     * the entry point, anything that replaces one of its methods has to keep
     * intercepting the calls this class makes.
     * @param {Object} controller - the streamr controller
     */
    constructor(controller) {
        this.controller = controller;
    }

    /**
     * Build the handler a subscription hands its envelopes to.
     *
     * @param {string} streamId
     * @param {Function} handler - what to call with the finished message
     * @param {string|null} password - for password-encrypted channels
     * @param {string} label - names the caller in the failure log
     * @returns {Function} (content, streamMessage) => Promise<void>
     */
    makeHandler(streamId, handler, password, label) {
        return async (content, streamMessage) => {
            try {
                let data = content;

                // Handle binary content (Uint8Array from MEDIA_DATA partition)
                if (content instanceof Uint8Array) {
                    data = await this.controller._openBinaryMediaPayload(streamId, content, password);
                    if (!data) return;
                    // Extract account and wrap binary with metadata
                    const transportPublisher = streamMessage && (typeof streamMessage.getPublisherId === 'function'
                        ? streamMessage.getPublisherId()
                        : streamMessage.publisherId);
                    const publisherId = await this.controller.resolveAuthor(streamId, streamMessage, transportPublisher, { live: true });
                    if (!publisherId) return;
                    await handler(data, publisherId);
                    return;
                }

                // Decrypt if password provided
                if (password && typeof content === 'string') {
                    data = await cryptoManager.decryptJSON(content, password);
                }

                const envelopeTimestamp = typeof streamMessage?.getTimestamp === 'function'
                    ? streamMessage.getTimestamp() : streamMessage?.timestamp;

                // Epoch envelope (gated): unknown kid → skip, not error (§7.9)
                if (this.controller.isEpochEnvelope(data)) {
                    const opened = await this.controller.openEpochEnvelope(streamId, data, {
                        live: true,
                        timestamp: envelopeTimestamp
                    });
                    if (opened === null) return;
                    data = opened;

                    // Sealed: the seal held an authorship wrapper —
                    // verify it, swap the author in, and cut lapsed members.
                    const gatedChannel = await this.controller._gatedChannelFor(streamId);
                    if (gatedChannel?.wireIdentity === 'sealed') {
                        const authored = await this.controller._openAuthorship(gatedChannel, data, { live: true });
                        if (!authored) return;
                        data = authored.payload;
                        this.controller.attachAccount(data, authored.author);
                        if (envelopeTimestamp) data._timestamp = envelopeTimestamp;
                        await handler(data);
                        return;
                    }
                }

                // Authorship: envelope signer on gated streams, transport
                // publisher otherwise (resolveAuthor; D10c)
                if (streamMessage && typeof data === 'object') {
                    const transportPublisher = typeof streamMessage.getPublisherId === 'function'
                        ? streamMessage.getPublisherId()
                        : streamMessage.publisherId;
                    const publisherId = await this.controller.resolveAuthor(streamId, streamMessage, transportPublisher, { live: true });
                    if (!publisherId) return;
                    this.controller.attachAccount(data, publisherId);
                    // Same `_timestamp` the history paths surface: the signed
                    // envelope time, the anchor the ingest clamp judges the
                    // payload's own timestamp against.
                    if (envelopeTimestamp) data._timestamp = envelopeTimestamp;
                }

                await handler(data);
            } catch (error) {
                Logger.error(`Failed to process ${label}`, error);
            }
        };
    }
}
