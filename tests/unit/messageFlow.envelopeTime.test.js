/**
 * D-X01(c) regression vector: message order and the pagination anchor follow
 * the signed envelope time, not the publisher-chosen payload timestamp.
 *
 * A message dated far in the past by its author (payload timestamp = 2001) but
 * delivered now (recent envelope) used to drag `channel.oldestTimestamp` down to
 * the fake past. `load-older` then resends `to: {timestamp: 2001}`, which returns
 * nothing before that date, so every genuine message newer than the fake past
 * became unreachable. Ordering and the anchor now read `messageTime` (envelope
 * first), so a past-dated payload lands at its true network position and cannot
 * poison pagination.
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
const { messageTime } = await import('../../src/js/utils/messageTime.js');

const STREAM = '0xowner/chan-1';
const AUTHOR = '0xauthor0000000000000000000000000000000001';

const OLD_ENV = 1_600_000_000_000;   // genuine older message, envelope + payload agree
const NOW_ENV = 1_700_000_000_000;   // attack message delivered now
const PAST_PAYLOAD = 978_307_200_000; // 2001, chosen by the attacking publisher

function msg(id, over) {
  return { type: 'text', id, text: 'hi', sender: AUTHOR, ...over };
}

let flow, channel, manager;

beforeEach(() => {
  channel = { messages: [], oldestTimestamp: null, gate: null };
  manager = {
    channels: new Map([[STREAM, channel]]),
    switchGeneration: 1,
    applyPendingOverrides: vi.fn(),
    notifyHandlers: vi.fn(),
    sortMessagesByTimestamp: (ch) => flow.sortMessagesByTimestamp(ch),
  };
  flow = new MessageFlow(manager);
});

describe('messageTime', () => {
  it('prefers the signed envelope time over the payload', () => {
    expect(messageTime({ _timestamp: NOW_ENV, timestamp: PAST_PAYLOAD })).toBe(NOW_ENV);
  });
  it('falls back to the payload when there is no envelope yet', () => {
    expect(messageTime({ timestamp: PAST_PAYLOAD })).toBe(PAST_PAYLOAD);
  });
  it('is 0 for a missing message or one with no times', () => {
    expect(messageTime(null)).toBe(0);
    expect(messageTime({})).toBe(0);
  });
});

describe('D-X01(c): ordering follows the envelope', () => {
  it('sorts a past-dated payload to its true network position', () => {
    channel.messages = [
      msg('old', { _timestamp: OLD_ENV, timestamp: OLD_ENV }),
      msg('atk', { _timestamp: NOW_ENV, timestamp: PAST_PAYLOAD }),
    ];
    flow.sortMessagesByTimestamp(channel);
    expect(channel.messages.map(m => m.id)).toEqual(['old', 'atk']);
  });
});

describe('D-X01(c): the pagination anchor follows the envelope', () => {
  it('a past-dated payload does not drag oldestTimestamp into the fake past', async () => {
    flow.pendingVerifications = new Map([[STREAM, {
      timer: null,
      messages: [
        { channel, data: msg('old', { _timestamp: OLD_ENV, timestamp: OLD_ENV }) },
        { channel, data: msg('atk', { _timestamp: NOW_ENV, timestamp: PAST_PAYLOAD }) },
      ],
    }]]);

    await flow.flushBatchVerification(STREAM);

    // Anchor is the oldest genuine envelope, never the attacker's 2001 payload.
    expect(channel.oldestTimestamp).toBe(OLD_ENV);
    expect(channel.oldestTimestamp).not.toBe(PAST_PAYLOAD);
  });
});
