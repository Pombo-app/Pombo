/**
 * A write that changes nothing must not ask the sync for a push, and must not
 * stamp its slice newer: a fresh stamp on an unchanged value beats a real
 * change another device made in the meantime.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { secureStorage } from '../../src/js/secureStorage.js';

const DM = '0xpeer/Pombo-DM-1';

describe('writes that change nothing', () => {
    let saved;

    beforeEach(() => {
        saved = { cache: secureStorage.cache, isUnlocked: secureStorage.isUnlocked, isGuestMode: secureStorage.isGuestMode, address: secureStorage.address, onSentDataChanged: secureStorage.onSentDataChanged };
        secureStorage.initAsGuest('0x1234567890abcdef1234567890abcdef12345678');
        secureStorage.cache.sentMessages = { [DM]: [{ id: 'm1', type: 'text', text: 'hello', timestamp: 100 }] };
        secureStorage.onSentDataChanged = vi.fn();
    });

    afterEach(() => Object.assign(secureStorage, saved));

    it('an edit that sets the same text asks for no push', async () => {
        await secureStorage.updateSentMessage(DM, 'm1', { text: 'hello' });
        expect(secureStorage.onSentDataChanged).not.toHaveBeenCalled();

        await secureStorage.updateSentMessage(DM, 'm1', { text: 'edited' });
        expect(secureStorage.onSentDataChanged).toHaveBeenCalledTimes(1);
    });

    it('a reaction already held, or removed when absent, asks for no push and leaves no empty entry', async () => {
        await secureStorage.addSentReaction(DM, 'm1', '👍', '0xAbc', 'remove');
        expect(secureStorage.cache.sentReactions?.[DM]).toBeUndefined();

        await secureStorage.addSentReaction(DM, 'm1', '👍', '0xAbc', 'add');
        await secureStorage.addSentReaction(DM, 'm1', '👍', '0xabc', 'add');
        expect(secureStorage.onSentDataChanged).toHaveBeenCalledTimes(1);
    });

    it('setting the same username or Graph key does not stamp the slice again', async () => {
        await secureStorage.setUsername('Bob');
        await secureStorage.setGraphApiKey('key');
        await secureStorage.setTrustedContacts({ '0xc1': { nickname: 'Carol' } });
        Object.assign(secureStorage.cache.sliceTs, { username: 1, graphApiKey: 1, trustedContacts: 1 });

        await secureStorage.setUsername('Bob');
        await secureStorage.setGraphApiKey('key');
        await secureStorage.setTrustedContacts({ '0xc1': { nickname: 'Carol' } });

        expect(secureStorage.cache.sliceTs).toMatchObject({ username: 1, graphApiKey: 1, trustedContacts: 1 });
    });
});
