/**
 * Retry Utility Tests
 * Tests for retry logic with exponential backoff
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeWithRetry, executeWithRetryAndVerify, withCircuitBreaker, resetCircuit, getCircuitState } from '../../src/js/utils/retry.js';

describe('retry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('executeWithRetry', () => {
        it('should return result on first successful attempt', async () => {
            const asyncFn = vi.fn().mockResolvedValue('success');
            
            const result = await executeWithRetry('test', asyncFn, { maxRetries: 3 });
            
            expect(result).toBe('success');
            expect(asyncFn).toHaveBeenCalledTimes(1);
        });

        it('should retry on failure', async () => {
            const asyncFn = vi.fn()
                .mockRejectedValueOnce(new Error('fail 1'))
                .mockResolvedValue('success');
            
            const result = await executeWithRetry('test', asyncFn, { 
                maxRetries: 3, 
                baseDelay: 10 
            });
            
            expect(result).toBe('success');
            expect(asyncFn).toHaveBeenCalledTimes(2);
        });

        it('should throw after all retries exhausted', async () => {
            const error = new Error('persistent failure');
            const asyncFn = vi.fn().mockRejectedValue(error);
            
            await expect(executeWithRetry('test', asyncFn, { 
                maxRetries: 3, 
                baseDelay: 10 
            })).rejects.toThrow('persistent failure');
            
            expect(asyncFn).toHaveBeenCalledTimes(3);
        });

        it('should call onAttempt callback', async () => {
            const asyncFn = vi.fn().mockResolvedValue('ok');
            const onAttempt = vi.fn();
            
            await executeWithRetry('test', asyncFn, { 
                maxRetries: 3,
                onAttempt 
            });
            
            expect(onAttempt).toHaveBeenCalledWith(1, 3);
        });

        it('should call onError callback on failure', async () => {
            const error = new Error('fail');
            const asyncFn = vi.fn()
                .mockRejectedValueOnce(error)
                .mockResolvedValue('ok');
            const onError = vi.fn();
            
            await executeWithRetry('test', asyncFn, { 
                maxRetries: 3, 
                baseDelay: 10,
                onError 
            });
            
            expect(onError).toHaveBeenCalledWith(error, 1);
        });

        it('should respect shouldRetry predicate', async () => {
            const nonRetryableError = new Error('do not retry');
            const asyncFn = vi.fn().mockRejectedValue(nonRetryableError);
            const shouldRetry = vi.fn().mockReturnValue(false);
            
            await expect(executeWithRetry('test', asyncFn, { 
                maxRetries: 5, 
                shouldRetry 
            })).rejects.toThrow('do not retry');
            
            // Should only attempt once since shouldRetry returns false
            expect(asyncFn).toHaveBeenCalledTimes(1);
            expect(shouldRetry).toHaveBeenCalledWith(nonRetryableError);
        });

        it('should use exponential backoff', async () => {
            const asyncFn = vi.fn()
                .mockRejectedValueOnce(new Error('fail 1'))
                .mockRejectedValueOnce(new Error('fail 2'))
                .mockResolvedValue('success');
            
            const start = Date.now();
            
            await executeWithRetry('test', asyncFn, { 
                maxRetries: 3, 
                baseDelay: 50,
                backoffMultiplier: 2
            });
            
            const elapsed = Date.now() - start;
            // First retry: 50 * 2^0 = 50ms, Second retry: 50 * 2^1 = 100ms
            // Total ~150ms minimum
            expect(elapsed).toBeGreaterThanOrEqual(100);
        });
    });

    describe('executeWithRetryAndVerify', () => {
        it('should return result on first successful attempt', async () => {
            const asyncFn = vi.fn().mockResolvedValue('success');
            const checkExistsFn = vi.fn();
            
            const result = await executeWithRetryAndVerify('test', asyncFn, checkExistsFn, { 
                maxRetries: 3 
            });
            
            expect(result).toBe('success');
            expect(asyncFn).toHaveBeenCalledTimes(1);
            expect(checkExistsFn).not.toHaveBeenCalled();
        });

        it('should check if resource exists after error', async () => {
            const asyncFn = vi.fn().mockRejectedValue(new Error('tx error'));
            const checkExistsFn = vi.fn().mockResolvedValue({ id: '123' });
            
            const result = await executeWithRetryAndVerify('test', asyncFn, checkExistsFn, { 
                maxRetries: 3, 
                baseDelay: 10 
            });
            
            expect(result).toEqual({ id: '123' });
            expect(checkExistsFn).toHaveBeenCalled();
        });

        it('should continue retrying if checkExists returns falsy', async () => {
            const asyncFn = vi.fn()
                .mockRejectedValueOnce(new Error('fail'))
                .mockResolvedValue('success');
            const checkExistsFn = vi.fn().mockResolvedValue(null);
            
            const result = await executeWithRetryAndVerify('test', asyncFn, checkExistsFn, { 
                maxRetries: 3, 
                baseDelay: 10 
            });
            
            expect(result).toBe('success');
            expect(asyncFn).toHaveBeenCalledTimes(2);
        });

        it('never sends a write again that landed while its receipt read failed', async () => {
            const asyncFn = vi.fn().mockRejectedValue(new Error('Error while waiting transaction'));
            const checkExistsFn = vi.fn().mockResolvedValue(true);

            const result = await executeWithRetryAndVerify('test', asyncFn, checkExistsFn, {
                maxRetries: 5,
                baseDelay: 10
            });

            expect(result).toBe(true);
            expect(asyncFn).toHaveBeenCalledTimes(1);
        });

        it('checks only after the wait, when a pending write has had time to land', async () => {
            const order = [];
            const asyncFn = vi.fn(async () => { order.push('send'); throw new Error('receipt read failed'); });
            const checkExistsFn = vi.fn(async () => { order.push('check'); return true; });

            await executeWithRetryAndVerify('test', asyncFn, checkExistsFn, { maxRetries: 3, baseDelay: 10 });

            expect(order).toEqual(['send', 'check']);
        });

        it('an unreadable chain sends nothing until the check answers, then sends only if missing', async () => {
            const asyncFn = vi.fn()
                .mockRejectedValueOnce(new Error('receipt read failed'))
                .mockResolvedValue('success');
            const checkExistsFn = vi.fn()
                .mockRejectedValueOnce(new Error('RPC down'))
                .mockRejectedValueOnce(new Error('RPC down'))
                .mockResolvedValue(false);

            const result = await executeWithRetryAndVerify('test', asyncFn, checkExistsFn, {
                maxRetries: 6,
                baseDelay: 10
            });

            expect(result).toBe('success');
            expect(checkExistsFn).toHaveBeenCalledTimes(3);
            expect(asyncFn).toHaveBeenCalledTimes(2);
        });

        it('an unreadable chain to the end sends nothing more and fails with the write error', async () => {
            const asyncFn = vi.fn().mockRejectedValue(new Error('receipt read failed'));
            const checkExistsFn = vi.fn().mockRejectedValue(new Error('RPC down'));

            await expect(executeWithRetryAndVerify('test', asyncFn, checkExistsFn, {
                maxRetries: 4,
                baseDelay: 10
            })).rejects.toThrow('receipt read failed');

            expect(asyncFn).toHaveBeenCalledTimes(1);
            expect(checkExistsFn).toHaveBeenCalledTimes(3);
        });

        it('should throw after all retries if resource never exists', async () => {
            const asyncFn = vi.fn().mockRejectedValue(new Error('persistent error'));
            const checkExistsFn = vi.fn().mockResolvedValue(null);

            await expect(executeWithRetryAndVerify('test', asyncFn, checkExistsFn, {
                maxRetries: 2,
                baseDelay: 10
            })).rejects.toThrow('persistent error');

            expect(asyncFn).toHaveBeenCalledTimes(2);
            expect(checkExistsFn).toHaveBeenCalledTimes(1);
        });

        it('does not retry an error the caller rules out', async () => {
            const asyncFn = vi.fn().mockRejectedValue(new Error('insufficient funds'));
            const checkExistsFn = vi.fn();

            await expect(executeWithRetryAndVerify('test', asyncFn, checkExistsFn, {
                maxRetries: 3,
                baseDelay: 10,
                shouldRetry: () => false
            })).rejects.toThrow('insufficient funds');

            expect(checkExistsFn).not.toHaveBeenCalled();
        });
    });

    describe('withCircuitBreaker', () => {
        const CB_NAME = 'test-circuit';

        beforeEach(() => {
            resetCircuit(CB_NAME);
        });

        it('should execute normally when circuit is closed', async () => {
            const fn = vi.fn().mockResolvedValue('ok');
            const result = await withCircuitBreaker(CB_NAME, fn);
            expect(result).toBe('ok');
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should count failures but stay closed below threshold', async () => {
            const fn = vi.fn().mockRejectedValue(new Error('fail'));
            
            for (let i = 0; i < 2; i++) {
                await expect(withCircuitBreaker(CB_NAME, fn, { threshold: 3 })).rejects.toThrow('fail');
            }
            
            const state = getCircuitState(CB_NAME);
            expect(state.state).toBe('closed');
            expect(state.failures).toBe(2);
        });

        it('should open circuit after threshold failures', async () => {
            const fn = vi.fn().mockRejectedValue(new Error('fail'));
            
            for (let i = 0; i < 3; i++) {
                await expect(withCircuitBreaker(CB_NAME, fn, { threshold: 3 })).rejects.toThrow('fail');
            }
            
            const state = getCircuitState(CB_NAME);
            expect(state.state).toBe('open');
            expect(state.failures).toBe(3);
        });

        it('should skip calls when circuit is open', async () => {
            const fn = vi.fn().mockRejectedValue(new Error('fail'));
            
            // Trip the circuit
            for (let i = 0; i < 3; i++) {
                await expect(withCircuitBreaker(CB_NAME, fn, { threshold: 3, resetTimeoutMs: 60000 })).rejects.toThrow();
            }
            
            fn.mockClear();
            fn.mockResolvedValue('ok');
            
            // Should skip without calling fn
            const result = await withCircuitBreaker(CB_NAME, fn, { threshold: 3, resetTimeoutMs: 60000 });
            expect(result).toBeUndefined();
            expect(fn).not.toHaveBeenCalled();
        });

        it('should transition to half-open after cooldown expires', async () => {
            const fn = vi.fn().mockRejectedValue(new Error('fail'));
            
            // Trip the circuit
            for (let i = 0; i < 3; i++) {
                await expect(withCircuitBreaker(CB_NAME, fn, { threshold: 3, resetTimeoutMs: 50 })).rejects.toThrow();
            }
            
            expect(getCircuitState(CB_NAME).state).toBe('open');
            
            // Wait for cooldown
            await new Promise(r => setTimeout(r, 60));
            
            fn.mockClear();
            fn.mockResolvedValue('recovered');
            
            const result = await withCircuitBreaker(CB_NAME, fn, { threshold: 3, resetTimeoutMs: 50 });
            expect(result).toBe('recovered');
            expect(fn).toHaveBeenCalledTimes(1);
            expect(getCircuitState(CB_NAME).state).toBe('closed');
        });

        it('should re-open circuit on half-open probe failure', async () => {
            const fn = vi.fn().mockRejectedValue(new Error('fail'));
            
            // Trip the circuit
            for (let i = 0; i < 3; i++) {
                await expect(withCircuitBreaker(CB_NAME, fn, { threshold: 3, resetTimeoutMs: 50 })).rejects.toThrow();
            }
            
            // Wait for cooldown
            await new Promise(r => setTimeout(r, 60));
            
            // Probe fails → re-opens
            await expect(withCircuitBreaker(CB_NAME, fn, { threshold: 3, resetTimeoutMs: 50 })).rejects.toThrow();
            expect(getCircuitState(CB_NAME).state).toBe('open');
        });

        it('should reset circuit via resetCircuit()', async () => {
            const fn = vi.fn().mockRejectedValue(new Error('fail'));
            
            // Trip the circuit
            for (let i = 0; i < 3; i++) {
                await expect(withCircuitBreaker(CB_NAME, fn, { threshold: 3 })).rejects.toThrow();
            }
            expect(getCircuitState(CB_NAME).state).toBe('open');
            
            resetCircuit(CB_NAME);
            expect(getCircuitState(CB_NAME)).toBeUndefined();
            
            // Should work again
            fn.mockResolvedValue('fresh');
            const result = await withCircuitBreaker(CB_NAME, fn, { threshold: 3 });
            expect(result).toBe('fresh');
        });

        it('should reset failure count on success', async () => {
            const fn = vi.fn()
                .mockRejectedValueOnce(new Error('fail'))
                .mockRejectedValueOnce(new Error('fail'))
                .mockResolvedValueOnce('ok');
            
            await expect(withCircuitBreaker(CB_NAME, fn, { threshold: 5 })).rejects.toThrow();
            await expect(withCircuitBreaker(CB_NAME, fn, { threshold: 5 })).rejects.toThrow();
            expect(getCircuitState(CB_NAME).failures).toBe(2);
            
            await withCircuitBreaker(CB_NAME, fn, { threshold: 5 });
            expect(getCircuitState(CB_NAME).failures).toBe(0);
            expect(getCircuitState(CB_NAME).state).toBe('closed');
        });
    });
});
