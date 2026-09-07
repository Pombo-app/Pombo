/**
 * X-01 regression vector: the one-sided timestamp clamp on message ingest.
 *
 * The payload `timestamp` is what the UI orders, pages, ages and TTL-purges by,
 * and the publisher writes it freely (MessageFlow.sortMessagesByTimestamp reads
 * it). handleTextMessage clamps it BEFORE the message reaches the timeline:
 *   - dated ahead of the wall clock beyond skew  -> dropped
 *   - dated ahead of its own signed envelope      -> dropped
 *   - dated in the PAST                           -> allowed (legitimate republish)
 *
 * The clamp is the first gate that returns, so the discriminator is whether the
 * message ever reaches the batch-verification queue (the next stop for a
 * non-recent message). A dropped message never gets there.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({ Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/js/streamr.js', () => ({ streamrController: {}, STREAM_CONFIG: { MESSAGE_STREAM: { MESSAGES: 0, CONTROL: 1, MODERATION: 2 } } }));
vi.mock('../../src/js/auth.js', () => ({ authManager: { isConnected: () => true, getAddress: () => '0xnotthesender' } }));
vi.mock('../../src/js/identity.js', () => ({ identityManager: { verifyMessage: vi.fn().mockResolvedValue({ valid: true }) } }));
vi.mock('../../src/js/secureStorage.js', () => ({ secureStorage: {} }));
vi.mock('../../src/js/relayManager.js', () => ({ relayManager: {} }));
vi.mock('../../src/js/dm.js', () => ({ dmManager: {} }));
vi.mock('../../src/js/media.js', () => ({ mediaController: { isStoredImageChunkMessage: () => false, isStoredChunkedImageManifest: () => false } }));
vi.mock('../../src/js/adminStatePoller.js', () => ({ adminStatePoller: {} }));

const { MessageFlow } = await import('../../src/js/channels/MessageFlow.js');
const { CONFIG } = await import('../../src/js/config.js');

const STREAM = '0xowner/chan-1';
const SKEW = CONFIG.gate.timestampSkewMs;
const AUTHOR = '0xauthor0000000000000000000000000000000001';

let flow, channel, manager;

function makeMessage(overrides) {
  return { type: 'text', id: 'm-' + Math.random().toString(16).slice(2), text: 'hi', sender: AUTHOR, ...overrides };
}

beforeEach(() => {
  channel = { messages: [], gate: null };
  manager = {
    channels: new Map([[STREAM, channel]]),
    queueMessageForBatchVerification: vi.fn(),
    sortMessagesByTimestamp: vi.fn(),
    applyPendingOverrides: vi.fn(),
    notifyHandlers: vi.fn(),
    handleControlMessage: vi.fn(),
  };
  flow = new MessageFlow(manager);
});

describe('X-01: message timestamp clamp', () => {
  it('drops a message dated far in the future (beyond skew)', async () => {
    await flow.handleTextMessage(STREAM, makeMessage({ timestamp: Date.now() + SKEW + 60_000 }));
    expect(manager.queueMessageForBatchVerification).not.toHaveBeenCalled();
    expect(channel.messages).toHaveLength(0);
  });

  it('drops a message dated ahead of its own signed envelope (beyond skew)', async () => {
    const env = Date.now() - 20 * 60_000;
    await flow.handleTextMessage(STREAM, makeMessage({ _timestamp: env, timestamp: env + SKEW + 60_000 }));
    expect(manager.queueMessageForBatchVerification).not.toHaveBeenCalled();
    expect(channel.messages).toHaveLength(0);
  });

  it('allows a past-dated message (legitimate republish) through the clamp', async () => {
    await flow.handleTextMessage(STREAM, makeMessage({ timestamp: Date.now() - 10 * 60_000 }));
    // Non-recent → routed to batch verification rather than dropped.
    expect(manager.queueMessageForBatchVerification).toHaveBeenCalledTimes(1);
  });

  it('a payload OLDER than its envelope is not clamped', async () => {
    const env = Date.now() - 60_000;
    await flow.handleTextMessage(STREAM, makeMessage({ _timestamp: env, timestamp: env - 10 * 60_000 }));
    expect(manager.queueMessageForBatchVerification).toHaveBeenCalledTimes(1);
  });
});
