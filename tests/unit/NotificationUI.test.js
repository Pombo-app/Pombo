/**
 * Tests for NotificationUI.js - Toast notifications and loading indicators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notificationUI } from '../../src/js/ui/NotificationUI.js';

describe('NotificationUI', () => {
    beforeEach(() => {
        // Reset state
        notificationUI.currentLoadingToast = null;
        
        // Clear DOM
        document.body.innerHTML = '';
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    describe('showLoading()', () => {
        it('should show loading overlay with message', () => {
            const overlay = document.createElement('div');
            overlay.id = 'loading-overlay';
            const textEl = document.createElement('span');
            textEl.id = 'loading-text';
            document.body.appendChild(overlay);
            document.body.appendChild(textEl);
            
            notificationUI.showLoading('Loading data...');
            
            expect(overlay.classList.contains('active')).toBe(true);
            expect(textEl.textContent).toBe('Loading data...');
        });
        
        it('should use default message when not provided', () => {
            const overlay = document.createElement('div');
            overlay.id = 'loading-overlay';
            const textEl = document.createElement('span');
            textEl.id = 'loading-text';
            document.body.appendChild(overlay);
            document.body.appendChild(textEl);
            
            notificationUI.showLoading();
            
            expect(textEl.textContent).toBe('Loading...');
        });
        
        it('should handle missing elements gracefully', () => {
            // Should not throw
            notificationUI.showLoading('Test');
        });
    });

    describe('hideLoading()', () => {
        it('should hide loading overlay', () => {
            const overlay = document.createElement('div');
            overlay.id = 'loading-overlay';
            overlay.classList.add('active');
            document.body.appendChild(overlay);
            
            notificationUI.hideLoading();
            
            expect(overlay.classList.contains('active')).toBe(false);
        });
        
        it('should handle missing overlay gracefully', () => {
            // Should not throw
            notificationUI.hideLoading();
        });
    });

    describe('showNotification()', () => {
        let container;
        
        beforeEach(() => {
            container = document.createElement('div');
            container.id = 'toast-container';
            document.body.appendChild(container);
            vi.useFakeTimers();
        });
        
        it('should create toast element', () => {
            notificationUI.showNotification('Test message', 'success');
            
            const toast = container.querySelector('.toast');
            expect(toast).not.toBeNull();
            expect(toast.classList.contains('success')).toBe(true);
        });
        
        it('should show message in toast', () => {
            notificationUI.showNotification('Hello World', 'info');
            
            const message = container.querySelector('.toast-message');
            expect(message.textContent).toBe('Hello World');
        });
        
        it('should use info as default type', () => {
            notificationUI.showNotification('Default type');
            
            const toast = container.querySelector('.toast');
            expect(toast.classList.contains('info')).toBe(true);
        });
        
        it('should set custom duration', () => {
            notificationUI.showNotification('Custom duration', 'warning', 5000);
            
            const toast = container.querySelector('.toast');
            expect(toast.style.getPropertyValue('--toast-duration')).toBe('5000ms');
        });
        
        it('should auto-remove after duration', () => {
            notificationUI.showNotification('Auto remove', 'error', 3000);
            
            expect(container.querySelectorAll('.toast').length).toBe(1);
            
            vi.advanceTimersByTime(3000);
            expect(container.querySelector('.toast').classList.contains('toast-exit')).toBe(true);
            
            vi.advanceTimersByTime(250);
            expect(container.querySelectorAll('.toast').length).toBe(0);
        });
        
        it('should allow manual dismiss via close button', () => {
            notificationUI.showNotification('Dismissable', 'info');
            
            const closeBtn = container.querySelector('.toast-close');
            closeBtn.click();
            
            expect(container.querySelector('.toast').classList.contains('toast-exit')).toBe(true);
            
            vi.advanceTimersByTime(250);
            expect(container.querySelectorAll('.toast').length).toBe(0);
        });
        
        it('should sanitize message content (XSS prevention)', () => {
            notificationUI.showNotification('<script>alert(1)</script>', 'error');
            
            const message = container.querySelector('.toast-message');
            expect(message.textContent).not.toContain('<script>');
            expect(message.innerHTML).not.toContain('<script>');
        });
        
        it('should include appropriate icon for each type', () => {
            notificationUI.showNotification('Success', 'success');
            const successToast = container.querySelector('.toast.success');
            expect(successToast.querySelector('.toast-icon')).not.toBeNull();
            
            container.innerHTML = '';
            notificationUI.showNotification('Error', 'error');
            const errorToast = container.querySelector('.toast.error');
            expect(errorToast.querySelector('.toast-icon')).not.toBeNull();
            
            container.innerHTML = '';
            notificationUI.showNotification('Warning', 'warning');
            const warningToast = container.querySelector('.toast.warning');
            expect(warningToast.querySelector('.toast-icon')).not.toBeNull();
        });
        
        it('should handle missing container gracefully', () => {
            document.body.innerHTML = '';
            // Should not throw
            notificationUI.showNotification('No container');
        });
        
        it('should include progress bar', () => {
            notificationUI.showNotification('With progress', 'info');
            
            const progress = container.querySelector('.toast-progress');
            expect(progress).not.toBeNull();
        });
    });

    describe('showLoadingToast()', () => {
        let container;
        
        beforeEach(() => {
            container = document.createElement('div');
            container.id = 'toast-container';
            document.body.appendChild(container);
        });
        
        it('should create loading toast', () => {
            const toast = notificationUI.showLoadingToast('Processing...');
            
            expect(toast).not.toBeNull();
            expect(toast.classList.contains('toast')).toBe(true);
            expect(toast.classList.contains('loading')).toBe(true);
        });
        
        it('should show message and subtitle', () => {
            notificationUI.showLoadingToast('Please wait', 'Uploading files...');
            
            const toast = container.querySelector('.toast.loading');
            expect(toast.textContent).toContain('Please wait');
            expect(toast.textContent).toContain('Uploading files...');
        });
        
        it('should use default subtitle when not provided', () => {
            notificationUI.showLoadingToast('Loading');
            
            const toast = container.querySelector('.toast.loading');
            expect(toast.textContent).toContain('This may take a moment');
        });
        
        it('should store reference to current loading toast', () => {
            const toast = notificationUI.showLoadingToast('Loading...');
            expect(notificationUI.currentLoadingToast).toBe(toast);
        });
        
        it('should remove existing loading toasts', () => {
            notificationUI.showLoadingToast('First');
            notificationUI.showLoadingToast('Second');
            
            const loadingToasts = container.querySelectorAll('.toast.loading');
            expect(loadingToasts.length).toBe(1);
            expect(loadingToasts[0].textContent).toContain('Second');
        });
        
        it('should return null when container is missing', () => {
            document.body.innerHTML = '';
            const result = notificationUI.showLoadingToast('Test');
            expect(result).toBeNull();
        });
        
        it('should escape HTML in message', () => {
            notificationUI.showLoadingToast('<b>Bold</b>');
            
            const toast = container.querySelector('.toast.loading');
            expect(toast.innerHTML).not.toContain('<b>');
        });

        it('draws the payment icon for a payment and the chat bubble otherwise', () => {
            const dollar = 'M12 8c-1.657';
            const bubble = 'M8.625 12a.375';

            notificationUI.showLoadingToast('Paying subscription...', 'Confirm may take a moment', { icon: 'payment' });
            let icon = container.querySelector('.toast.loading .toast-icon path').getAttribute('d');
            expect(icon.startsWith(dollar)).toBe(true);

            notificationUI.showLoadingToast('Joining channel...');
            icon = container.querySelector('.toast.loading .toast-icon path').getAttribute('d');
            expect(icon.startsWith(bubble)).toBe(true);
        });
    });

    describe('hideLoadingToast()', () => {
        let container;
        
        beforeEach(() => {
            container = document.createElement('div');
            container.id = 'toast-container';
            document.body.appendChild(container);
            vi.useFakeTimers();
        });
        
        it('should hide current loading toast', () => {
            notificationUI.showLoadingToast('Loading...');
            
            notificationUI.hideLoadingToast();
            
            const toast = container.querySelector('.toast.loading');
            expect(toast.classList.contains('toast-exit')).toBe(true);
            
            vi.advanceTimersByTime(250);
            expect(container.querySelectorAll('.toast.loading').length).toBe(0);
        });
        
        it('should clear currentLoadingToast reference', () => {
            notificationUI.showLoadingToast('Loading...');
            expect(notificationUI.currentLoadingToast).not.toBeNull();
            
            notificationUI.hideLoadingToast();
            expect(notificationUI.currentLoadingToast).toBeNull();
        });
        
        it('should accept specific toast to hide', () => {
            const toast1 = notificationUI.showLoadingToast('First');
            const toast2 = document.createElement('div');
            toast2.className = 'toast other';
            container.appendChild(toast2);
            
            notificationUI.hideLoadingToast(toast2);
            
            expect(toast2.classList.contains('toast-exit')).toBe(true);
            expect(toast1.classList.contains('toast-exit')).toBe(false);
        });
        
        it('should handle null gracefully', () => {
            notificationUI.currentLoadingToast = null;
            // Should not throw
            notificationUI.hideLoadingToast();
        });
        
        it('should handle already removed toast', () => {
            const toast = notificationUI.showLoadingToast('Test');
            toast.remove();
            
            // Should not throw
            notificationUI.hideLoadingToast();
        });
    });

    describe('showLoadingMoreIndicator()', () => {
        it('should add loading indicator to messages area', () => {
            const messagesArea = document.createElement('div');
            document.body.appendChild(messagesArea);
            
            notificationUI.showLoadingMoreIndicator(messagesArea);
            
            const indicator = document.getElementById('loading-more-indicator');
            expect(indicator).not.toBeNull();
            expect(indicator.textContent).toContain('Loading older messages');
        });
        
        it('should prepend indicator (not append)', () => {
            const messagesArea = document.createElement('div');
            const existingChild = document.createElement('div');
            existingChild.textContent = 'Existing';
            messagesArea.appendChild(existingChild);
            document.body.appendChild(messagesArea);
            
            notificationUI.showLoadingMoreIndicator(messagesArea);
            
            expect(messagesArea.firstChild.id).toBe('loading-more-indicator');
        });
        
        it('should remove existing indicator before adding new one', () => {
            const messagesArea = document.createElement('div');
            document.body.appendChild(messagesArea);
            
            notificationUI.showLoadingMoreIndicator(messagesArea);
            notificationUI.showLoadingMoreIndicator(messagesArea);
            
            const indicators = messagesArea.querySelectorAll('#loading-more-indicator');
            expect(indicators.length).toBe(1);
        });
        
        it('should handle null messagesArea gracefully', () => {
            // Should not throw
            notificationUI.showLoadingMoreIndicator(null);
        });
        
        it('should include spinner animation', () => {
            const messagesArea = document.createElement('div');
            document.body.appendChild(messagesArea);
            
            notificationUI.showLoadingMoreIndicator(messagesArea);
            
            const indicator = document.getElementById('loading-more-indicator');
            const spinner = indicator.querySelector('.animate-spin');
            expect(spinner).not.toBeNull();
        });
    });

    describe('hideLoadingMoreIndicator()', () => {
        it('should remove loading indicator', () => {
            const indicator = document.createElement('div');
            indicator.id = 'loading-more-indicator';
            document.body.appendChild(indicator);
            
            notificationUI.hideLoadingMoreIndicator();
            
            expect(document.getElementById('loading-more-indicator')).toBeNull();
        });
        
        it('should handle missing indicator gracefully', () => {
            // Should not throw
            notificationUI.hideLoadingMoreIndicator();
        });

        it('tags the indicator with the owner load token', () => {
            const messagesArea = document.createElement('div');
            document.body.appendChild(messagesArea);

            notificationUI.showLoadingMoreIndicator(messagesArea, 42);
            const el = document.getElementById('loading-more-indicator');
            expect(el?.dataset.loadToken).toBe('42');
        });

        it('hide with mismatched token leaves indicator in place', () => {
            const messagesArea = document.createElement('div');
            document.body.appendChild(messagesArea);

            notificationUI.showLoadingMoreIndicator(messagesArea, 7);
            // Stale op tries to hide a fresh op's indicator
            notificationUI.hideLoadingMoreIndicator(3);

            expect(document.getElementById('loading-more-indicator')).not.toBeNull();

            notificationUI.hideLoadingMoreIndicator(7);
            expect(document.getElementById('loading-more-indicator')).toBeNull();
        });

        it('hide with null token force-clears regardless of stored token', () => {
            const messagesArea = document.createElement('div');
            document.body.appendChild(messagesArea);

            notificationUI.showLoadingMoreIndicator(messagesArea, 99);
            notificationUI.hideLoadingMoreIndicator(null);

            expect(document.getElementById('loading-more-indicator')).toBeNull();
        });
    });

    describe('integration scenarios', () => {
        beforeEach(() => {
            vi.useFakeTimers();
            
            // Setup full DOM
            const overlay = document.createElement('div');
            overlay.id = 'loading-overlay';
            const textEl = document.createElement('span');
            textEl.id = 'loading-text';
            const container = document.createElement('div');
            container.id = 'toast-container';
            
            document.body.appendChild(overlay);
            document.body.appendChild(textEl);
            document.body.appendChild(container);
        });
        
        it('should handle multiple notifications at once', () => {
            notificationUI.showNotification('First', 'success');
            notificationUI.showNotification('Second', 'error');
            notificationUI.showNotification('Third', 'warning');
            
            const container = document.getElementById('toast-container');
            expect(container.querySelectorAll('.toast').length).toBe(3);
        });
        
        it('should allow loading overlay and toast simultaneously', () => {
            notificationUI.showLoading('Processing...');
            notificationUI.showNotification('Background task completed', 'success');
            
            const overlay = document.getElementById('loading-overlay');
            const container = document.getElementById('toast-container');
            
            expect(overlay.classList.contains('active')).toBe(true);
            expect(container.querySelectorAll('.toast').length).toBe(1);
        });
        
        it('should handle rapid show/hide cycles', () => {
            for (let i = 0; i < 10; i++) {
                notificationUI.showLoading(`Loading ${i}`);
                notificationUI.hideLoading();
            }
            
            const overlay = document.getElementById('loading-overlay');
            expect(overlay.classList.contains('active')).toBe(false);
        });
    });

    describe('_isPersistent()', () => {
        it('should return true for loading type', () => {
            const toast = document.createElement('div');
            toast.className = 'toast loading';
            
            expect(notificationUI._isPersistent(toast)).toBe(true);
        });
        
        it('should return true for error type', () => {
            const toast = document.createElement('div');
            toast.className = 'toast error';
            
            expect(notificationUI._isPersistent(toast)).toBe(true);
        });
        
        it('should return true for invite type', () => {
            const toast = document.createElement('div');
            toast.className = 'toast invite';
            
            expect(notificationUI._isPersistent(toast)).toBe(true);
        });
        
        it('should return false for success type', () => {
            const toast = document.createElement('div');
            toast.className = 'toast success';
            
            expect(notificationUI._isPersistent(toast)).toBe(false);
        });
        
        it('should return false for info type', () => {
            const toast = document.createElement('div');
            toast.className = 'toast info';
            
            expect(notificationUI._isPersistent(toast)).toBe(false);
        });
        
        it('should return false for warning type', () => {
            const toast = document.createElement('div');
            toast.className = 'toast warning';
            
            expect(notificationUI._isPersistent(toast)).toBe(false);
        });
    });

    describe('_dismissToast()', () => {
        let container;
        
        beforeEach(() => {
            container = document.createElement('div');
            container.id = 'toast-container';
            document.body.appendChild(container);
            vi.useFakeTimers();
        });
        
        it('should add toast-exit class', () => {
            const toast = document.createElement('div');
            toast.className = 'toast info';
            container.appendChild(toast);
            
            notificationUI._dismissToast(toast);
            
            expect(toast.classList.contains('toast-exit')).toBe(true);
        });
        
        it('should clear pending timeout', () => {
            const toast = document.createElement('div');
            toast.className = 'toast info';
            container.appendChild(toast);
            
            const timeoutId = setTimeout(() => {}, 5000);
            toast._dismissTimeout = timeoutId;
            
            notificationUI._dismissToast(toast);
            
            expect(toast._dismissTimeout).toBeNull();
        });
        
        it('should remove toast after animation delay', () => {
            const toast = document.createElement('div');
            toast.className = 'toast info';
            container.appendChild(toast);
            
            notificationUI._dismissToast(toast);
            
            expect(container.contains(toast)).toBe(true);
            
            vi.advanceTimersByTime(250);
            
            expect(container.contains(toast)).toBe(false);
        });
        
        it('should handle null toast gracefully', () => {
            // Should not throw
            notificationUI._dismissToast(null);
        });
        
        it('should handle orphaned toast (no parent) gracefully', () => {
            const toast = document.createElement('div');
            toast.className = 'toast info';
            // Not appended to any container
            
            // Should not throw
            notificationUI._dismissToast(toast);
        });
    });

    describe('restoreToast()', () => {
        it('should remove toast-minimized class', () => {
            const toast = document.createElement('div');
            toast.className = 'toast info toast-minimized';
            
            notificationUI.restoreToast(toast);
            
            expect(toast.classList.contains('toast-minimized')).toBe(false);
        });
        
        it('should clear inline transform style', () => {
            const toast = document.createElement('div');
            toast.className = 'toast info toast-minimized';
            toast.style.transform = 'translateX(calc(100% - 12px))';
            
            notificationUI.restoreToast(toast);
            
            expect(toast.style.transform).toBe('');
        });
        
        it('should clear inline opacity style', () => {
            const toast = document.createElement('div');
            toast.className = 'toast info toast-minimized';
            toast.style.opacity = '0.7';
            
            notificationUI.restoreToast(toast);
            
            expect(toast.style.opacity).toBe('');
        });
        
        it('should resume progress bar animation', () => {
            const toast = document.createElement('div');
            toast.className = 'toast info toast-minimized';
            const progressBar = document.createElement('div');
            progressBar.className = 'toast-progress';
            progressBar.style.animationPlayState = 'paused';
            toast.appendChild(progressBar);
            
            notificationUI.restoreToast(toast);
            
            expect(progressBar.style.animationPlayState).toBe('running');
        });
        
        it('should handle toast without progress bar', () => {
            const toast = document.createElement('div');
            toast.className = 'toast info toast-minimized';
            
            // Should not throw
            notificationUI.restoreToast(toast);
        });
        
        it('should not modify non-minimized toast', () => {
            const toast = document.createElement('div');
            toast.className = 'toast info';
            toast.style.transform = 'translateX(50px)';
            
            notificationUI.restoreToast(toast);
            
            // Should remain unchanged
            expect(toast.style.transform).toBe('translateX(50px)');
        });
        
        it('should handle null gracefully', () => {
            // Should not throw
            notificationUI.restoreToast(null);
        });
    });
});
