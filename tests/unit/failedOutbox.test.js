/**
 * A text whose send failed is kept per conversation, so after a restart the
 * bubble comes back "Not sent" and its Retry republishes the same message.
 * The restart is real: the encrypted cache is written, dropped and read back.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// channels.js first: it builds a MessageFlow at load, and the import cycle
// leaves the class undefined if MessageFlow.js is evaluated before it.
await import('../../src/js/channels.js');
const { MessageFlow } = await import('../../src/js/channels/MessageFlow.js');
const { DeliveryConfirm } = await import('../../src/js/channels/DeliveryConfirm.js');
const { secureStorage } = await import('../../src/js/secureStorage.js');
const { identityManager } = await import('../../src/js/identity.js');
const { authManager } = await import('../../src/js/auth.js');

const ME = '0x' + 'aa'.repeat(20);
const ROOM = `${ME}/room-1`;
const REPLY = { id: 'parent-1', sender: '0x' + 'bb'.repeat(20), senderName: 'Peer', text: 'the question' };

const signed = (id) => ({
    id, type: 'text', text: 'hello', sender: ME, senderName: 'me', timestamp: 1_000_000,
    channelId: ROOM, replyTo: REPLY, signature: '0xsig'
});

async function unlockRealStorage() {
    secureStorage.isGuestMode = false;
    secureStorage.stateDB = null;
    secureStorage.address = ME;
    secureStorage.storageKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    secureStorage.cache = secureStorage.createEmptyCache();
    secureStorage.isUnlocked = true;
}

/** Drop the decrypted cache and read it back from the encrypted copy. */
async function restart() {
    secureStorage.cache = null;
    await secureStorage.loadFromStorage();
}

function launch() {
    const channel = { messageStreamId: ROOM, type: 'public', messages: [] };
    const manager = {
        channels: new Map([[ROOM, channel]]),
        notifyHandlers: vi.fn(),
        sortMessagesByTimestamp: (ch) => ch.messages.sort((a, b) => a.timestamp - b.timestamp),
        publishWithRetry: vi.fn().mockRejectedValue(new Error('No network')),
        deliveryConfirm: { track: vi.fn() },
        rotationRetry: { settle: vi.fn() },
        sendWakeSignals: vi.fn().mockResolvedValue(undefined)
    };
    const flow = new MessageFlow(manager);
    manager.messageFlow = flow;
    vi.spyOn(flow, '_assertMayPublish').mockResolvedValue(undefined);
    return { channel, manager, flow };
}

const entries = () => secureStorage.getFailedOutbox(ROOM);

describe('the failed-send outbox', () => {
    let saved;

    beforeEach(async () => {
        saved = {
            cache: secureStorage.cache, isUnlocked: secureStorage.isUnlocked, isGuestMode: secureStorage.isGuestMode,
            address: secureStorage.address, stateDB: secureStorage.stateDB, storageKey: secureStorage.storageKey
        };
        localStorage.clear();
        await unlockRealStorage();
        vi.spyOn(authManager, 'getAddress').mockReturnValue(ME);
        vi.spyOn(authManager, 'isConnected').mockReturnValue(true);
        vi.spyOn(identityManager, 'createSignedMessage').mockImplementation(async () => signed('m1'));
        vi.spyOn(identityManager, 'getTrustLevel').mockResolvedValue(0);
        vi.spyOn(identityManager, 'resolveENS').mockResolvedValue(null);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        Object.assign(secureStorage, saved);
        localStorage.clear();
    });

    async function failSend() {
        const { flow } = launch();
        await expect(flow.sendMessage(ROOM, 'hello', REPLY)).rejects.toThrow('No network');
    }

    it('keeps a failed send with everything its retry republishes, and no local state', async () => {
        await failSend();

        const [entry] = entries();
        expect(entry).toMatchObject({ id: 'm1', text: 'hello', sender: ME, timestamp: 1_000_000, signature: '0xsig', failError: 'No network' });
        expect(entry.replyTo).toEqual(REPLY);
        for (const local of ['pending', 'failed', 'verified', 'delivered']) expect(entry).not.toHaveProperty(local);
    });

    it('brings the bubble back after a restart, and its retry republishes the same message', async () => {
        await failSend();
        await restart();

        const { channel, manager, flow } = launch();
        await flow.restoreFailedOutbox(channel);
        const [bubble] = channel.messages;
        expect(bubble).toMatchObject({ id: 'm1', failed: true, pending: false, failError: 'No network', replyTo: REPLY });

        manager.publishWithRetry.mockResolvedValue({ timestamp: 1 });
        await flow.resendMessage(ROOM, 'm1');

        const published = manager.publishWithRetry.mock.calls[0][1];
        expect(published).toMatchObject({ id: 'm1', timestamp: 1_000_000, replyTo: REPLY, signature: '0xsig' });
        expect(channel.messages[0].failed).toBe(false);
        await restart();
        expect(entries()).toEqual([]);
    });

    it('keeps the entry, with the new reason, when the retry fails again', async () => {
        await failSend();
        await restart();
        const { channel, manager, flow } = launch();
        await flow.restoreFailedOutbox(channel);

        manager.publishWithRetry.mockRejectedValue(new Error('Still offline'));
        await expect(flow.resendMessage(ROOM, 'm1')).rejects.toThrow('Still offline');

        await restart();
        expect(entries()).toMatchObject([{ id: 'm1', failError: 'Still offline' }]);
    });

    it('clears the bubble and the entry when our own copy arrives', async () => {
        await failSend();
        const { channel, flow } = launch();
        await flow.restoreFailedOutbox(channel);

        await flow.handleTextMessage(ROOM, { ...signed('m1'), replyTo: null });

        expect(channel.messages).toHaveLength(1);
        expect(channel.messages[0].failed).toBe(false);
        expect(entries()).toEqual([]);
    });

    it('does not put back what the timeline already holds', async () => {
        await failSend();
        const { channel, flow } = launch();
        channel.messages.push({ ...signed('m1'), failed: true });

        await flow.restoreFailedOutbox(channel);

        expect(channel.messages).toHaveLength(1);
    });

    it('keeps a sent text that storage never recorded as undelivered', async () => {
        const { manager } = launch();
        const message = { ...signed('m2'), pending: false };
        const confirm = new DeliveryConfirm(manager);

        confirm._settle(ROOM, message, 'undelivered');
        await vi.waitFor(() => expect(entries()).toHaveLength(1));

        expect(entries()[0]).toMatchObject({ id: 'm2', undelivered: true });
    });

    it('never leaves the device: neither the sync nor the backup carries it', async () => {
        await failSend();

        expect(JSON.stringify(secureStorage.exportForSync())).not.toContain('failedOutbox');
        expect(JSON.stringify(secureStorage.exportForBackup())).not.toContain('failedOutbox');
    });

    it('keeps the newest twenty per conversation', async () => {
        for (let i = 1; i <= 21; i++) {
            await secureStorage.putFailedOutbox(ROOM, { id: `m${i}`, timestamp: i });
        }

        expect(entries()).toHaveLength(20);
        expect(entries()[0].id).toBe('m2');
    });
});
