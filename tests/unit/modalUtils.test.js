/**
 * Modal Utils Module Tests
 * Tests for template-based modal utilities and password validation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { 
    validatePasswordRules, 
    updatePasswordIndicator, 
    PASSWORD_ICONS,
    bindData,
    $
} from '../../src/js/ui/modalUtils.js';

describe('modalUtils', () => {
    describe('validatePasswordRules', () => {
        it('should fail all rules for empty password', () => {
            const result = validatePasswordRules('');
            expect(result.length).toBe(false);
            expect(result.upper).toBe(false);
            expect(result.lower).toBe(false);
            expect(result.number).toBe(false);
            expect(result.isValid).toBe(false);
        });

        it('should pass length for 12+ characters', () => {
            const result = validatePasswordRules('abcdefghijkl');
            expect(result.length).toBe(true);
        });

        it('should fail length for less than 12 characters', () => {
            const result = validatePasswordRules('abcdefghijk');
            expect(result.length).toBe(false);
        });

        it('should pass upper for uppercase letter', () => {
            const result = validatePasswordRules('A');
            expect(result.upper).toBe(true);
        });

        it('should fail upper for no uppercase', () => {
            const result = validatePasswordRules('abcdefghijkl');
            expect(result.upper).toBe(false);
        });

        it('should pass lower for lowercase letter', () => {
            const result = validatePasswordRules('a');
            expect(result.lower).toBe(true);
        });

        it('should fail lower for no lowercase', () => {
            const result = validatePasswordRules('ABCDEFGHIJKL');
            expect(result.lower).toBe(false);
        });

        it('should pass number for digit', () => {
            const result = validatePasswordRules('1');
            expect(result.number).toBe(true);
        });

        it('should fail number for no digits', () => {
            const result = validatePasswordRules('abcdefghijkl');
            expect(result.number).toBe(false);
        });

        it('should be valid when all rules pass', () => {
            const result = validatePasswordRules('Abcdefghijk1');
            expect(result.isValid).toBe(true);
        });

        it('should be invalid when any rule fails', () => {
            // Missing uppercase
            expect(validatePasswordRules('abcdefghijk1').isValid).toBe(false);
            // Missing lowercase
            expect(validatePasswordRules('ABCDEFGHIJK1').isValid).toBe(false);
            // Missing number
            expect(validatePasswordRules('Abcdefghijkl').isValid).toBe(false);
            // Too short
            expect(validatePasswordRules('Abcdefghij1').isValid).toBe(false);
        });

        it('should accept strong passwords', () => {
            const strongPasswords = [
                'MyPassword123',
                'SecurePass1234',
                'Testing12345A',
                'P@ssword12345!'
            ];
            
            strongPasswords.forEach(password => {
                const result = validatePasswordRules(password);
                expect(result.isValid).toBe(true);
            });
        });
    });

    describe('PASSWORD_ICONS', () => {
        it('should have check icon', () => {
            expect(PASSWORD_ICONS.check).toBeDefined();
            expect(PASSWORD_ICONS.check).toContain('svg');
            expect(PASSWORD_ICONS.check).toContain('M5 13l4 4L19 7');
        });

        it('should have empty icon', () => {
            expect(PASSWORD_ICONS.empty).toBeDefined();
            expect(PASSWORD_ICONS.empty).toContain('svg');
            expect(PASSWORD_ICONS.empty).toContain('circle');
        });
    });

    describe('updatePasswordIndicator', () => {
        let element;

        beforeEach(() => {
            element = document.createElement('div');
        });

        it('should set valid state correctly', () => {
            updatePasswordIndicator(element, true, 'Test requirement');
            
            expect(element.className).toContain('text-emerald-400');
            expect(element.innerHTML).toContain('Test requirement');
            // Check for checkmark path (browser may normalize self-closing tags)
            expect(element.innerHTML).toContain('M5 13l4 4L19 7');
        });

        it('should set invalid state correctly', () => {
            updatePasswordIndicator(element, false, 'Test requirement');
            
            expect(element.className).toContain('text-overlay-30');
            expect(element.innerHTML).toContain('Test requirement');
            // Check for circle element (browser may normalize self-closing tags)
            expect(element.innerHTML).toContain('circle');
        });

        it('should toggle between states', () => {
            updatePasswordIndicator(element, false, 'Toggle test');
            expect(element.className).toContain('text-overlay-30');
            
            updatePasswordIndicator(element, true, 'Toggle test');
            expect(element.className).toContain('text-emerald-400');
        });
    });

    describe('bindData', () => {
        let container;

        beforeEach(() => {
            container = document.createElement('div');
        });

        it('should bind text content to data-bind elements', () => {
            container.innerHTML = '<span data-bind="name"></span>';
            bindData(container, { name: 'John' });
            
            expect(container.querySelector('[data-bind="name"]').textContent).toBe('John');
        });

        it('should bind value to input elements', () => {
            container.innerHTML = '<input data-bind="email" />';
            bindData(container, { email: 'test@example.com' });
            
            expect(container.querySelector('[data-bind="email"]').value).toBe('test@example.com');
        });

        it('should bind value to textarea elements', () => {
            container.innerHTML = '<textarea data-bind="message"></textarea>';
            bindData(container, { message: 'Hello world' });
            
            expect(container.querySelector('[data-bind="message"]').value).toBe('Hello world');
        });

        it('should handle null values', () => {
            container.innerHTML = '<span data-bind="nullValue"></span>';
            bindData(container, { nullValue: null });
            
            expect(container.querySelector('[data-bind="nullValue"]').textContent).toBe('');
        });

        it('should handle multiple bindings', () => {
            container.innerHTML = `
                <span data-bind="first"></span>
                <span data-bind="second"></span>
            `;
            bindData(container, { first: 'A', second: 'B' });
            
            expect(container.querySelector('[data-bind="first"]').textContent).toBe('A');
            expect(container.querySelector('[data-bind="second"]').textContent).toBe('B');
        });

        it('should return container for chaining', () => {
            const result = bindData(container, {});
            expect(result).toBe(container);
        });
    });

    describe('$ query helper', () => {
        let modal;

        beforeEach(() => {
            modal = document.createElement('div');
            modal.innerHTML = `
                <button id="submit">Submit</button>
                <input class="input-field" />
            `;
        });

        it('should query by id', () => {
            const btn = $(modal, '#submit');
            expect(btn).not.toBeNull();
            expect(btn.textContent).toBe('Submit');
        });

        it('should query by class', () => {
            const input = $(modal, '.input-field');
            expect(input).not.toBeNull();
            expect(input.tagName).toBe('INPUT');
        });

        it('should return null for non-existent elements', () => {
            const missing = $(modal, '#nonexistent');
            expect(missing).toBeNull();
        });
    });
});
