/**
 * A write whose receipt read failed has usually landed. The retries ask the
 * chain before sending again, so a flaky RPC during channel creation stops
 * paying for the same storage assignment, retention or grant twice.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/js/auth.js', () => ({ authManager: { getSigner: vi.fn() } }));
vi.mock('../../src/js/crypto.js', () => ({ cryptoManager: {} }));

const { streamrController } = await import('../../src/js/streamr.js');

const STREAM = '0xowner/room-1';
const NODE = '0xae340e799e8151f6a4999d245e466197aa217667';
const receiptFailed = () => new Error('Error while waiting transaction for contract call, code=SERVER_ERROR');

/** Runs a write through its retry waits without sleeping. */
async function settled(promise) {
    const outcome = promise.then((value) => ({ value }), (error) => ({ error }));
    await vi.runAllTimersAsync();
    const { value, error } = await outcome;
    if (error) throw error;
    return value;
}

describe('on-chain writes retried against the chain', () => {
    let client;
    let stream;

    afterEach(() => vi.useRealTimers());

    beforeEach(() => {
        vi.useFakeTimers();
        stream = {
            id: STREAM,
            addToStorageNode: vi.fn().mockRejectedValue(receiptFailed()),
            setStorageDayCount: vi.fn().mockResolvedValue(undefined)
        };
        client = {
            getStream: vi.fn().mockResolvedValue(stream),
            isStoredStream: vi.fn().mockResolvedValue(true),
            setPermissions: vi.fn(),
            hasPermission: vi.fn()
        };
        streamrController.client = client;
    });

    it('does not assign the storage node twice when the first assignment landed', async () => {
        const result = await settled(streamrController.enableStorage(STREAM, {}, 4));

        expect(result.success).toBe(true);
        expect(stream.addToStorageNode).toHaveBeenCalledTimes(1);
        expect(client.isStoredStream).toHaveBeenCalledWith(STREAM, NODE);
    });

    it('does not set the retention twice when the first write landed', async () => {
        stream.addToStorageNode.mockResolvedValue(undefined);
        stream.setStorageDayCount.mockRejectedValue(receiptFailed());
        const chainDays = vi.spyOn(streamrController, '_chainStorageDays').mockResolvedValue(30);

        const result = await settled(streamrController.enableStorage(STREAM, { storageDays: 30 }, 4));

        expect(result.retentionApplied).toBe(true);
        expect(stream.setStorageDayCount).toHaveBeenCalledTimes(1);
        chainDays.mockRestore();
    });

    it('does not grant twice when the first grant landed', async () => {
        client.setPermissions.mockRejectedValue(receiptFailed());
        client.hasPermission.mockImplementation(async ({ permission }) => permission === 'subscribe');

        await settled(streamrController.grantPublicReadOnlyPermissions(STREAM, 4));

        expect(client.setPermissions).toHaveBeenCalledTimes(1);
    });

    it('grants again when the chain shows a different set than asked', async () => {
        client.setPermissions.mockRejectedValueOnce(receiptFailed()).mockResolvedValue(undefined);
        // Holds publish too: the grant asked for subscribe only, so it did not land.
        client.hasPermission.mockImplementation(async ({ permission }) =>
            permission === 'subscribe' || permission === 'publish');

        await settled(streamrController.grantPublicReadOnlyPermissions(STREAM, 4));

        expect(client.setPermissions).toHaveBeenCalledTimes(2);
    });

    it('does not grant again while the chain cannot be read', async () => {
        client.setPermissions.mockRejectedValue(receiptFailed());
        client.hasPermission.mockRejectedValue(new Error('RPC down'));

        await expect(settled(streamrController.grantPublicReadOnlyPermissions(STREAM, 3))).rejects.toThrow('SERVER_ERROR');

        expect(client.setPermissions).toHaveBeenCalledTimes(1);
    });

    it('tells a missing stream from an unreadable chain', async () => {
        client.getStream.mockRejectedValueOnce(Object.assign(new Error('Stream not found'), { code: 'STREAM_NOT_FOUND' }));
        await expect(streamrController._streamIfExists(STREAM)).resolves.toBeNull();

        client.getStream.mockRejectedValueOnce(new Error('RPC down'));
        await expect(streamrController._streamIfExists(STREAM)).rejects.toThrow('RPC down');
    });
});
