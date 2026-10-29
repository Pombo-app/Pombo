/**
 * modalUtils.js Extended Tests
 * Covers: loadTemplate, createModalFromTemplate, closeModal, setupModalCloseHandlers,
 * setupPasswordToggle, getPasswordStrengthHtml, setupPasswordStrengthValidation,
 * bindData data-bind-attr branches
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    bindData,
    createModalFromTemplate,
    closeModal,
    setupModalCloseHandlers,
    setupPasswordToggle,
    $,
    validatePasswordRules,
    PASSWORD_ICONS,
    updatePasswordIndicator,
    getPasswordStrengthHtml,
    setupPasswordStrengthValidation
} from '../../src/js/ui/modalUtils.js';

describe('modalUtils.js extended', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    // ==================== loadTemplate / createModalFromTemplate ====================
    describe('createModalFromTemplate()', () => {
        it('should throw if template not found', () => {
            expect(() => createModalFromTemplate('nonexistent')).toThrow('Template not found: nonexistent');
        });

        it('should create modal from template and append to body', () => {
            const tpl = document.createElement('template');
            tpl.id = 'test-modal';
            tpl.innerHTML = '<div class="modal"><span data-bind="title"></span></div>';
            document.body.appendChild(tpl);

            const modal = createModalFromTemplate('test-modal', { title: 'Hello' });

            expect(modal).toBeTruthy();
            expect(modal.classList.contains('modal')).toBe(true);
            expect(modal.querySelector('[data-bind="title"]').textContent).toBe('Hello');
            expect(document.body.contains(modal)).toBe(true);
        });

        it('should work with empty data', () => {
            const tpl = document.createElement('template');
            tpl.id = 'empty-modal';
            tpl.innerHTML = '<div class="modal">static content</div>';
            document.body.appendChild(tpl);

            const modal = createModalFromTemplate('empty-modal');
            expect(modal.textContent).toBe('static content');
        });
    });

    // ==================== closeModal() ====================
    describe('closeModal()', () => {
        it('should return immediately if modal is null', () => {
            closeModal(null);
            // No error
        });

        it('should add opacity-0 class and transition style', () => {
            const modal = document.createElement('div');
            document.body.appendChild(modal);

            closeModal(modal);

            expect(modal.classList.contains('opacity-0')).toBe(true);
            expect(modal.style.transition).toBe('opacity 150ms ease-out');
        });

        it('should remove modal from DOM after 150ms', () => {
            const modal = document.createElement('div');
            document.body.appendChild(modal);

            closeModal(modal);
            expect(document.body.contains(modal)).toBe(true);

            vi.advanceTimersByTime(150);
            expect(document.body.contains(modal)).toBe(false);
        });

        it('should call callback after removal', () => {
            const modal = document.createElement('div');
            document.body.appendChild(modal);
            const callback = vi.fn();

            closeModal(modal, callback);
            expect(callback).not.toHaveBeenCalled();

            vi.advanceTimersByTime(150);
            expect(callback).toHaveBeenCalledOnce();
        });

        it('should handle modal already removed from DOM', () => {
            const modal = document.createElement('div');
            // NOT appended to body

            closeModal(modal);
            vi.advanceTimersByTime(150);
            // No error
        });

        it('should not call callback if none provided', () => {
            const modal = document.createElement('div');
            document.body.appendChild(modal);

            closeModal(modal);
            vi.advanceTimersByTime(150);
            // No error
        });
    });

    // ==================== setupModalCloseHandlers() ====================
    describe('setupModalCloseHandlers()', () => {
        let modal;

        beforeEach(() => {
            modal = document.createElement('div');
            modal.innerHTML = '<div class="content"><button data-close-modal>X</button></div>';
            document.body.appendChild(modal);
        });

        it('should close on close button click', () => {
            const onClose = vi.fn();
            setupModalCloseHandlers(modal, onClose);

            const closeBtn = modal.querySelector('[data-close-modal]');
            closeBtn.click();

            expect(modal.classList.contains('opacity-0')).toBe(true);
            vi.advanceTimersByTime(150);
            expect(onClose).toHaveBeenCalledOnce();
        });

        it('should close on backdrop click (click on modal itself)', () => {
            const onClose = vi.fn();
            setupModalCloseHandlers(modal, onClose);

            // Click on the modal itself (backdrop)
            modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));

            expect(modal.classList.contains('opacity-0')).toBe(true);
            vi.advanceTimersByTime(150);
            expect(onClose).toHaveBeenCalledOnce();
        });

        it('should NOT close on content click (not backdrop)', () => {
            const onClose = vi.fn();
            setupModalCloseHandlers(modal, onClose);

            // Click on inner content - e.target !== modal
            const content = modal.querySelector('.content');
            content.dispatchEvent(new MouseEvent('click', { bubbles: true }));

            // Should not have triggered close (e.target !== modal)
            expect(onClose).not.toHaveBeenCalled();
        });

        it('should close on Escape key', () => {
            const onClose = vi.fn();
            setupModalCloseHandlers(modal, onClose);

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

            expect(modal.classList.contains('opacity-0')).toBe(true);
            vi.advanceTimersByTime(150);
            expect(onClose).toHaveBeenCalledOnce();
        });

        it('should NOT close on non-Escape key', () => {
            const onClose = vi.fn();
            setupModalCloseHandlers(modal, onClose);

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

            expect(modal.classList.contains('opacity-0')).toBe(false);
            expect(onClose).not.toHaveBeenCalled();
        });

        it('should disable backdrop close when closeOnBackdrop=false', () => {
            const onClose = vi.fn();
            setupModalCloseHandlers(modal, onClose, { closeOnBackdrop: false });

            modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));

            expect(modal.classList.contains('opacity-0')).toBe(false);
        });

        it('should disable escape close when closeOnEscape=false', () => {
            const onClose = vi.fn();
            setupModalCloseHandlers(modal, onClose, { closeOnEscape: false });

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

            expect(modal.classList.contains('opacity-0')).toBe(false);
        });

        it('should remove escape listener after first use', () => {
            const onClose = vi.fn();
            setupModalCloseHandlers(modal, onClose);

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            vi.advanceTimersByTime(150);

            expect(onClose).toHaveBeenCalledOnce();

            // Second escape should not trigger again
            onClose.mockClear();

            // Re-add modal for second test
            const modal2 = document.createElement('div');
            document.body.appendChild(modal2);

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            vi.advanceTimersByTime(150);

            // onClose from original handler should NOT fire again
            expect(onClose).not.toHaveBeenCalled();
        });

        it('should handle modal without close button', () => {
            const modalNoBtn = document.createElement('div');
            modalNoBtn.innerHTML = '<div class="content">No close btn</div>';
            document.body.appendChild(modalNoBtn);

            const onClose = vi.fn();
            setupModalCloseHandlers(modalNoBtn, onClose);

            // Should still work for escape/backdrop
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            vi.advanceTimersByTime(150);
            expect(onClose).toHaveBeenCalledOnce();
        });
    });

    // ==================== setupPasswordToggle() ====================
    describe('setupPasswordToggle()', () => {
        it('should toggle password to text', () => {
            const button = document.createElement('button');
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            button.appendChild(svg);
            const input = document.createElement('input');
            input.type = 'password';

            setupPasswordToggle(button, input);
            button.click();

            expect(input.type).toBe('text');
        });

        it('should toggle text back to password', () => {
            const button = document.createElement('button');
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            button.appendChild(svg);
            const input = document.createElement('input');
            input.type = 'password';

            setupPasswordToggle(button, input);

            // First click: password → text
            button.click();
            expect(input.type).toBe('text');

            // Second click: text → password
            button.click();
            expect(input.type).toBe('password');
        });

        it('should switch SVG icon on toggle', () => {
            const button = document.createElement('button');
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.innerHTML = 'initial';
            button.appendChild(svg);
            const input = document.createElement('input');
            input.type = 'password';

            setupPasswordToggle(button, input);

            button.click();
            expect(svg.innerHTML).toContain('3.98'); // EYE_CLOSED path

            button.click();
            expect(svg.innerHTML).toContain('2.036'); // EYE_OPEN path
        });

        it('should work without SVG icon', () => {
            const button = document.createElement('button');
            const input = document.createElement('input');
            input.type = 'password';

            setupPasswordToggle(button, input);
            button.click();

            expect(input.type).toBe('text');
            // No error from missing SVG
        });
    });

    // ==================== getPasswordStrengthHtml() ====================
    describe('getPasswordStrengthHtml()', () => {
        it('should return HTML string with all 4 indicators', () => {
            const html = getPasswordStrengthHtml();

            expect(html).toContain('id="password-strength"');
            expect(html).toContain('id="check-length"');
            expect(html).toContain('id="check-upper"');
            expect(html).toContain('id="check-lower"');
            expect(html).toContain('id="check-number"');
            expect(html).toContain('At least 12 characters');
            expect(html).toContain('Uppercase letter');
            expect(html).toContain('Lowercase letter');
            expect(html).toContain('Number');
        });

        it('should contain PASSWORD_ICONS.empty for initial state', () => {
            const html = getPasswordStrengthHtml();
            // Should contain the circle SVG (empty icon)
            expect(html).toContain('circle');
        });
    });

    // ==================== setupPasswordStrengthValidation() ====================
    describe('setupPasswordStrengthValidation()', () => {
        let input, container;

        beforeEach(() => {
            input = document.createElement('input');
            input.type = 'password';

            container = document.createElement('div');
            container.innerHTML = getPasswordStrengthHtml();
            document.body.appendChild(container);
        });

        it('should return a validate function', () => {
            const validate = setupPasswordStrengthValidation(input, container, vi.fn());
            expect(typeof validate).toBe('function');
        });

        it('should respond to input events', () => {
            const onChange = vi.fn();
            setupPasswordStrengthValidation(input, container, onChange);

            input.value = 'weak';
            input.dispatchEvent(new Event('input'));

            expect(onChange).toHaveBeenCalledWith(false);
        });

        it('should report valid for strong password', () => {
            const onChange = vi.fn();
            setupPasswordStrengthValidation(input, container, onChange);

            input.value = 'StrongPass123!';
            input.dispatchEvent(new Event('input'));

            expect(onChange).toHaveBeenCalledWith(true);
        });

        it('should update indicator elements', () => {
            setupPasswordStrengthValidation(input, container, vi.fn());

            input.value = 'aB1XXXXXXXXXX';
            input.dispatchEvent(new Event('input'));

            const checkLength = container.querySelector('#check-length');
            const checkUpper = container.querySelector('#check-upper');
            const checkLower = container.querySelector('#check-lower');
            const checkNumber = container.querySelector('#check-number');

            expect(checkLength.className).toContain('text-emerald-400');
            expect(checkUpper.className).toContain('text-emerald-400');
            expect(checkLower.className).toContain('text-emerald-400');
            expect(checkNumber.className).toContain('text-emerald-400');
        });

        it('should show invalid indicators for weak password', () => {
            setupPasswordStrengthValidation(input, container, vi.fn());

            input.value = 'short';
            input.dispatchEvent(new Event('input'));

            const checkLength = container.querySelector('#check-length');
            expect(checkLength.className).toContain('text-overlay-30');
        });

        it('should work without onValidChange callback', () => {
            const validate = setupPasswordStrengthValidation(input, container, null);
            input.value = 'Test1234567890';
            input.dispatchEvent(new Event('input'));
            // No error
        });

        it('manual validate should return isValid boolean', () => {
            const validate = setupPasswordStrengthValidation(input, container, vi.fn());

            input.value = 'short';
            expect(validate()).toBe(false);

            input.value = 'ValidPass123!!';
            expect(validate()).toBe(true);
        });
    });

    // ==================== bindData extended: data-bind-attr ====================
    describe('bindData() data-bind-attr', () => {
        it('should bind attributes via data-bind-attr', () => {
            const div = document.createElement('div');
            div.innerHTML = '<a data-bind-attr="href:link">click</a>';

            bindData(div, { link: 'https://example.com' });

            const a = div.querySelector('a');
            expect(a.getAttribute('href')).toBe('https://example.com');
        });

        it('should handle multiple attr bindings', () => {
            const div = document.createElement('div');
            div.innerHTML = '<img data-bind-attr="src:imageUrl,alt:imageAlt">';

            bindData(div, { imageUrl: 'test.png', imageAlt: 'Test Image' });

            const img = div.querySelector('img');
            expect(img.getAttribute('src')).toBe('test.png');
            expect(img.getAttribute('alt')).toBe('Test Image');
        });

        it('should handle null/undefined values in attr binding', () => {
            const div = document.createElement('div');
            div.innerHTML = '<a data-bind-attr="href:link">click</a>';

            bindData(div, { link: null });

            const a = div.querySelector('a');
            expect(a.getAttribute('href')).toBe('');
        });

        it('should not match wrong data-bind-attr key', () => {
            const div = document.createElement('div');
            div.innerHTML = '<a data-bind-attr="href:otherKey">click</a>';

            bindData(div, { link: 'https://example.com' });

            const a = div.querySelector('a');
            expect(a.getAttribute('href')).toBeNull();
        });

        it('should bind INPUT via value', () => {
            const div = document.createElement('div');
            div.innerHTML = '<input data-bind="name">';

            bindData(div, { name: 'John' });

            expect(div.querySelector('input').value).toBe('John');
        });

        it('should bind TEXTAREA via value', () => {
            const div = document.createElement('div');
            div.innerHTML = '<textarea data-bind="bio"></textarea>';

            bindData(div, { bio: 'Hello world' });

            expect(div.querySelector('textarea').value).toBe('Hello world');
        });
    });
});
