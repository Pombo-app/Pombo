import { describe, it, expect, beforeEach } from 'vitest';
import { homeTabOf, filterByHomeTab, loadHomeTab, saveHomeTab, DEFAULT_HOME_TAB } from '../../src/js/ui/homeTabs.js';

describe('homeTabs', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('puts DMs in Direct and every other type in Channels, whatever the classification', () => {
        expect(homeTabOf({ type: 'dm', classification: 'personal' })).toBe('direct');
        for (const type of ['public', 'password', 'gated', undefined]) {
            expect(homeTabOf({ type, classification: 'personal' })).toBe('channels');
            expect(homeTabOf({ type, classification: 'community' })).toBe('channels');
        }
    });

    it('filters a list by tab, keeping the given order', () => {
        const list = [
            { streamId: 'a', type: 'public' },
            { streamId: 'b', type: 'dm' },
            { streamId: 'c', type: 'gated' },
            { streamId: 'd', type: 'dm' }
        ];
        expect(filterByHomeTab(list, 'direct').map(c => c.streamId)).toEqual(['b', 'd']);
        expect(filterByHomeTab(list, 'channels').map(c => c.streamId)).toEqual(['a', 'c']);
    });

    it('starts on Direct and remembers the tab per account', () => {
        expect(loadHomeTab('0xAAA')).toBe(DEFAULT_HOME_TAB);
        expect(DEFAULT_HOME_TAB).toBe('direct');

        saveHomeTab('0xAAA', 'channels');

        expect(loadHomeTab('0xaaa')).toBe('channels');
        expect(loadHomeTab('0xBBB')).toBe('direct');
    });

    it('never saves for a guest and ignores unknown stored values', () => {
        saveHomeTab(null, 'channels');
        expect(localStorage.length).toBe(0);

        localStorage.setItem('pombo_home_tab_0xccc', 'community');
        expect(loadHomeTab('0xCCC')).toBe('direct');
    });
});
