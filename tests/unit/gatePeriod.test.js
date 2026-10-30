import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { formatGatePeriod } = await import('../../src/js/gate.js');

describe('formatGatePeriod', () => {
    it('names the period in the largest unit it reaches', () => {
        expect(formatGatePeriod(86400)).toBe('day');
        expect(formatGatePeriod(30 * 86400)).toBe('30 days');
        expect(formatGatePeriod(3600)).toBe('hour');
        expect(formatGatePeriod(6 * 3600)).toBe('6 hours');
        expect(formatGatePeriod(600)).toBe('10 minutes');
        expect(formatGatePeriod(45)).toBe('45 seconds');
        expect(formatGatePeriod(10n * 60n)).toBe('10 minutes');
    });

    it('keeps one decimal when the period does not fall on a whole unit', () => {
        expect(formatGatePeriod(1.5 * 86400)).toMatch(/^1[.,]5 days$/);
        expect(formatGatePeriod(90 * 60)).toMatch(/^1[.,]5 hours$/);
    });
});
