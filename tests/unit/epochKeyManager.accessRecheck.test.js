/**
 * An epoch rotates because someone lost access. A responder that cached a
 * grant for them before the rotation must ask the chain again before it wraps
 * the new key.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { gateManager } = await import('../../src/js/gate.js');

const ADMIN = '0x' + 'aa'.repeat(20);
const GATE = '0x' + 'ab'.repeat(20);
const STREAM = `${ADMIN}/recheck-1`;
const channel = { messageStreamId: STREAM, keysStreamId: `${ADMIN}/recheck-4`, gate: { address: GATE } };

const announce = (epoch) => ({ t: 'key_announce', epoch, keyId: `${epoch}.k`, keyHash: `0xh${epoch}`, validFrom: epoch * 100 });

describe('grants are forgotten when the epoch moves forward', () => {
    let s;

    beforeEach(() => {
        epochKeyManager.state.clear();
        vi.spyOn(gateManager, 'invalidateGrants').mockImplementation(() => {});
        s = epochKeyManager._getState(STREAM);
        epochKeyManager._applyAnnounce(channel, s, announce(3), ADMIN, 300);
        gateManager.invalidateGrants.mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        epochKeyManager.state.clear();
    });

    it('on the announce of a later epoch', () => {
        epochKeyManager._applyAnnounce(channel, s, announce(4), ADMIN, 400);

        expect(gateManager.invalidateGrants).toHaveBeenCalledWith(GATE);
    });

    it('not on an earlier epoch, nor on another copy of the current one', () => {
        epochKeyManager._applyAnnounce(channel, s, announce(2), ADMIN, 200);
        epochKeyManager._applyAnnounce(channel, s, announce(3), ADMIN, 250);

        expect(gateManager.invalidateGrants).not.toHaveBeenCalled();
    });

    it('when this device adopts a later epoch', async () => {
        vi.spyOn(epochKeyManager, '_persist').mockResolvedValue(undefined);
        vi.spyOn(epochKeyManager, '_maybePublishHello').mockResolvedValue(undefined);

        await epochKeyManager._adopt(channel, s, { keyId: '5.k', keyHex: '55'.repeat(32), keyHash: '0xh5', epoch: 5 });

        expect(gateManager.invalidateGrants).toHaveBeenCalledWith(GATE);
    });
});
