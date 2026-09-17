/**
 * Token amounts are money on screen: a wrong decimal place is a wrong claim
 * about what the account holds. The formatter never rounds up, never invents
 * precision it does not have, and says "< 0.0001" rather than "0" for dust.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { formatTokenAmount } = await import('../../src/js/ui/WalletUI.js');

describe('formatTokenAmount', () => {
    it('renders whole units with no fractional noise', () => {
        expect(formatTokenAmount(0n, 18)).toBe('0');
        expect(formatTokenAmount(10n ** 18n, 18)).toBe('1');
        expect(formatTokenAmount(42n * 10n ** 18n, 18)).toBe('42');
    });

    it('reads the token decimals, not a fixed 18', () => {
        // 3.20 USDC, which has 6 decimals. Read as 18 this would be dust.
        expect(formatTokenAmount(3200000n, 6)).toBe('3.2');
        expect(formatTokenAmount(1n, 6)).toBe('< 0.0001');
        // 1 WBTC, 8 decimals.
        expect(formatTokenAmount(100000000n, 8)).toBe('1');
    });

    it('caps at four decimals and drops trailing zeros', () => {
        expect(formatTokenAmount(1697000000000000000n, 18)).toBe('1.697');
        expect(formatTokenAmount(169712345678901234n, 18)).toBe('0.1697');
        expect(formatTokenAmount(100000000000000000n, 18)).toBe('0.1');
    });

    it('never rounds a balance up', () => {
        // 0.99999 rounds DOWN to 0.9999: claiming 1 would claim funds that
        // are not there.
        expect(formatTokenAmount(999990000000000000n, 18)).toBe('0.9999');
    });

    it('says dust is dust instead of zero', () => {
        expect(formatTokenAmount(1n, 18)).toBe('< 0.0001');
        expect(formatTokenAmount(99999999999999n, 18)).toBe('< 0.0001');
    });

    it('refuses anything that is not an integer amount', () => {
        expect(formatTokenAmount(1, 18)).toBeNull();
        expect(formatTokenAmount('1', 18)).toBeNull();
        expect(formatTokenAmount(1n, null)).toBeNull();
        expect(formatTokenAmount(1n, -1)).toBeNull();
    });
});
