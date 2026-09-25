/**
 * Deleting a sent DM has to reach the account's other devices: the local
 * copy goes, and the deletion is recorded in the state the sync carries, so
 * a device still holding the message drops it at the next merge.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { secureStorage } from '../../src/js/secureStorage.js';

const DM = '0xpeer/Pombo-DM-1';
const text = (id) => ({ id, type: 'text', text: `text of ${id}`, timestamp: 100 });

describe('sent DM deletions', () => {
    let saved;

    beforeEach(() => {
        saved = { cache: secureStorage.cache, isUnlocked: secureStorage.isUnlocked, isGuestMode: secureStorage.isGuestMode, address: secureStorage.address };
        secureStorage.initAsGuest('0x1234567890abcdef1234567890abcdef12345678');
        secureStorage.cache.sentMessages = { [DM]: [text('m1'), text('m2')] };
    });

    afterEach(() => Object.assign(secureStorage, saved));

    it('drops the local copy and records the deletion', async () => {
        await secureStorage.removeSentMessage(DM, 'm2');

        expect(secureStorage.cache.sentMessages[DM].map(m => m.id)).toEqual(['m1']);
        expect(typeof secureStorage.cache.sentDeletedAt[DM].m2).toBe('number');
    });

    it('records the deletion of a message this device never held', async () => {
        await secureStorage.removeSentMessage(DM, 'elsewhere');

        expect(secureStorage.cache.sentMessages[DM]).toHaveLength(2);
        expect(secureStorage.cache.sentDeletedAt[DM]).toHaveProperty('elsewhere');
    });

    it('carries the deletions in the sync and backup exports', async () => {
        await secureStorage.removeSentMessage(DM, 'm2');

        expect(secureStorage.exportForSync().sentDeletedAt[DM]).toHaveProperty('m2');
        expect(secureStorage.exportForBackup().sentDeletedAt[DM]).toHaveProperty('m2');
    });

    it('takes the merged deletions from a pull', async () => {
        const changes = await secureStorage.importFromSync({ sentDeletedAt: { [DM]: { m9: 900 } } });

        expect(changes.hasChanges).toBe(true);
        expect(secureStorage.cache.sentDeletedAt).toEqual({ [DM]: { m9: 900 } });
    });
});
