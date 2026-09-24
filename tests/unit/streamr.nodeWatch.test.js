import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/js/auth.js', () => ({
    authManager: { getSigner: vi.fn() }
}));

import { streamrController } from '../../src/js/streamr.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function clientWithStart(start) {
    return function () {
        this.getAddress = vi.fn().mockResolvedValue('0xme');
        this.getNodeId = vi.fn(start);
    };
}

describe('streamrController node start watch', () => {
    let onDead, onAlive;

    beforeEach(() => {
        onDead = vi.spyOn(streamrController.revival, 'onDead').mockImplementation(() => {});
        onAlive = vi.spyOn(streamrController.revival, 'onAlive').mockImplementation(() => {});
    });

    afterEach(() => {
        streamrController.client = null;
        vi.restoreAllMocks();
    });

    it('hands a client whose node failed to start to the revival', async () => {
        window.StreamrClient = clientWithStart(() => Promise.reject(new Error('Failed to connect to the entrypoints after 7 attempts')));

        await streamrController.init({ privateKey: '0xabc' });
        await flush();

        expect(onDead).toHaveBeenCalledTimes(1);
        expect(onAlive).not.toHaveBeenCalled();
    });

    it('reports a node that came up', async () => {
        window.StreamrClient = clientWithStart(() => Promise.resolve('node-id'));

        await streamrController.init({ privateKey: '0xabc' });
        await flush();

        expect(onAlive).toHaveBeenCalledTimes(1);
        expect(onDead).not.toHaveBeenCalled();
    });

    it('a start that fails while logging out does not wake the revival', async () => {
        let fail;
        window.StreamrClient = clientWithStart(() => new Promise((_, reject) => { fail = reject; }));
        await streamrController.init({ privateKey: '0xabc' });
        let destroyed;
        streamrController.client.destroy = vi.fn(() => new Promise((resolve) => { destroyed = resolve; }));

        const leaving = streamrController.disconnect();
        fail(new Error('Failed to connect to the entrypoints after 7 attempts'));
        await flush();
        destroyed();
        await leaving;

        expect(onDead).not.toHaveBeenCalled();
    });

    it('ignores the start of a client that was already replaced', async () => {
        let fail;
        window.StreamrClient = clientWithStart(() => new Promise((_, reject) => { fail = reject; }));

        await streamrController.init({ privateKey: '0xabc' });
        streamrController.client = { replacement: true };
        fail(new Error('connectionCount>0'));
        await flush();

        expect(onDead).not.toHaveBeenCalled();
    });
});
