/**
 * Notification UI Manager
 * Handles toast notifications, loading overlays, and loading indicators
 */

import { Logger } from '../logger.js';
import { escapeHtml } from './utils.js';
import { sanitizeText } from './sanitizer.js';

// Toast icon SVGs
const TOAST_ICONS = {
    success: `<svg class="toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`,
    error: `<svg class="toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`,
    info: `<svg class="toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
    warning: `<svg class="toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>`
};

const LOADING_ICONS = {
    chat: `<svg class="toast-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"/>
            </svg>`,
    payment: `<svg class="toast-icon toast-icon-payment" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>`
};

class NotificationUI {
    constructor() {
        this.currentLoadingToast = null;
        this.isMobile = window.innerWidth < 768;
        
        // Update mobile detection on resize
        window.addEventListener('resize', () => {
            this.isMobile = window.innerWidth < 768;
        });
    }

    /**
     * Check if toast type is persistent (cannot be fully dismissed by swipe)
     * @param {HTMLElement} toast - Toast element
     * @returns {boolean}
     */
    _isPersistent(toast) {
        return toast.classList.contains('loading') || 
               toast.classList.contains('error') ||
               toast.classList.contains('invite') ||
               toast.classList.contains('confirm');
    }

    /**
     * Setup swipe handlers for mobile toast dismissal
     * @param {HTMLElement} toast - Toast element to add handlers to
     */
    _setupSwipeHandlers(toast) {
        if (!this.isMobile) return;

        let startX = 0;
        let currentX = 0;
        let isDragging = false;
        const DISMISS_THRESHOLD = 0.5; // 50% of width to dismiss
        const MINIMIZE_THRESHOLD = 0.3; // 30% to minimize persistent

        const handleTouchStart = (e) => {
            // If minimized, tap to restore
            if (toast.classList.contains('toast-minimized')) {
                this.restoreToast(toast);
                e.preventDefault();
                return;
            }
            
            startX = e.touches[0].clientX;
            currentX = startX;
            isDragging = true;
            toast.classList.add('toast-swiping');
        };

        const handleTouchMove = (e) => {
            if (!isDragging) return;
            
            currentX = e.touches[0].clientX;
            const deltaX = currentX - startX;
            
            // Only allow swiping right (positive delta)
            if (deltaX > 0) {
                toast.style.transform = `translateX(${deltaX}px)`;
                // Reduce opacity as user swipes
                const opacity = Math.max(0.3, 1 - (deltaX / toast.offsetWidth) * 0.7);
                toast.style.opacity = opacity;
            }
        };

        const handleTouchEnd = () => {
            if (!isDragging) return;
            isDragging = false;
            toast.classList.remove('toast-swiping');
            
            const deltaX = currentX - startX;
            const swipePercent = deltaX / toast.offsetWidth;
            const isPersistent = this._isPersistent(toast);
            
            if (isPersistent) {
                // Persistent toasts: minimize instead of dismiss
                if (swipePercent > MINIMIZE_THRESHOLD) {
                    toast.classList.add('toast-minimized');
                    toast.style.transform = '';
                    toast.style.opacity = '';
                    // Clear auto-dismiss timeout when minimized
                    if (toast._dismissTimeout) {
                        clearTimeout(toast._dismissTimeout);
                        toast._dismissTimeout = null;
                    }
                    // Pause progress bar
                    const progressBar = toast.querySelector('.toast-progress');
                    if (progressBar) {
                        progressBar.style.animationPlayState = 'paused';
                    }
                } else {
                    // Snap back
                    toast.style.transform = '';
                    toast.style.opacity = '';
                }
            } else {
                // Non-persistent: dismiss if threshold reached
                if (swipePercent > DISMISS_THRESHOLD) {
                    toast.style.transform = 'translateX(100%)';
                    toast.style.opacity = '0';
                    // Clear timeout and remove
                    if (toast._dismissTimeout) {
                        clearTimeout(toast._dismissTimeout);
                        toast._dismissTimeout = null;
                    }
                    setTimeout(() => toast.remove(), 200);
                } else {
                    // Snap back
                    toast.style.transform = '';
                    toast.style.opacity = '';
                }
            }
        };

        toast.addEventListener('touchstart', handleTouchStart, { passive: false });
        toast.addEventListener('touchmove', handleTouchMove, { passive: true });
        toast.addEventListener('touchend', handleTouchEnd);
        toast.addEventListener('touchcancel', handleTouchEnd);
    }

    /**
     * Show loading indicator with spinner overlay
     * @param {string} message - Loading message
     */
    showLoading(message) {
        const overlay = document.getElementById('loading-overlay');
        const textEl = document.getElementById('loading-text');
        if (overlay && textEl) {
            textEl.textContent = message || 'Loading...';
            overlay.classList.add('active');
        }
    }

    /**
     * Hide loading indicator
     */
    hideLoading() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.classList.remove('active');
        }
    }

    /**
     * Show toast notification
     * @param {string} message - Notification message
     * @param {string} type - Notification type (success, error, info, warning)
     * @param {number} duration - Duration in ms (default 3000)
     */
    showNotification(message, type = 'info', duration = 3000) {
        const container = document.getElementById('toast-container');
        if (!container) {
            Logger.debug(`[${type}] ${message}`);
            return;
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.style.setProperty('--toast-duration', `${duration}ms`);
        // Defense-in-depth: sanitize then escape user content
        toast.innerHTML = `
            ${TOAST_ICONS[type] || TOAST_ICONS.info}
            <div class="toast-content">
                <span class="toast-message">${escapeHtml(sanitizeText(message))}</span>
            </div>
            <span class="toast-close" title="Dismiss">
                <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </span>
            <div class="toast-progress"></div>
        `;
        
        // Close button handler
        const closeBtn = toast.querySelector('.toast-close');
        closeBtn?.addEventListener('click', () => {
            this._dismissToast(toast);
        });
        
        container.appendChild(toast);
        
        // Setup mobile swipe handlers
        this._setupSwipeHandlers(toast);

        // Auto remove after duration - store timeout ID on element
        toast._dismissTimeout = setTimeout(() => {
            if (toast.parentElement) {
                this._dismissToast(toast);
            }
        }, duration);
    }

    /**
     * Dismiss a toast with exit animation
     * @param {HTMLElement} toast - Toast to dismiss
     */
    _dismissToast(toast) {
        if (!toast || !toast.parentElement) return;
        
        // Clear any pending timeout
        if (toast._dismissTimeout) {
            clearTimeout(toast._dismissTimeout);
            toast._dismissTimeout = null;
        }
        
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 250);
    }

    /**
     * Show a persistent confirm toast with Confirm / Cancel actions.
     * Resolves with `true` if the user confirms, `false` otherwise (cancel,
     * close button, or auto-dismiss timeout).
     *
     * Designed to keep the same minimalist look as other toasts — just an
     * icon + title/subtitle + two small action buttons.
     *
     * @param {string} message - Title/headline
     * @param {string} [subtitle] - Optional secondary line
     * @param {Object} [options]
     * @param {string} [options.confirmLabel='Confirm']
     * @param {string} [options.cancelLabel='Cancel']
     * @param {'warning'|'info'|'error'} [options.variant='warning'] - Icon/accent color
     * @param {number} [options.timeoutMs] - Auto-dismiss after N ms (default: no timeout)
     * @returns {Promise<boolean>}
     */
    showConfirmToast(message, subtitle = '', options = {}) {
        const container = document.getElementById('toast-container');
        if (!container) {
            Logger.warn('Toast container not found — falling back to window.confirm');
            return Promise.resolve(window.confirm(`${message}\n\n${subtitle}`));
        }

        const {
            confirmLabel = 'Confirm',
            cancelLabel = 'Cancel',
            variant = 'warning',
            timeoutMs = 0,
        } = options;

        return new Promise((resolve) => {
            const toast = document.createElement('div');
            toast.className = `toast confirm ${variant}`;
            toast.innerHTML = `
                ${TOAST_ICONS[variant] || TOAST_ICONS.warning}
                <div class="toast-content">
                    <div class="text-[13px] font-medium text-white/90">${escapeHtml(message)}</div>
                    ${subtitle ? `<div class="text-[11px] text-white/50 mt-0.5">${escapeHtml(subtitle)}</div>` : ''}
                    <div class="mt-2.5 flex gap-2">
                        <button class="confirm-btn bg-white/90 hover:bg-white text-[#0a0a0a] px-3 py-1 rounded-md text-[11px] font-medium transition">
                            ${escapeHtml(confirmLabel)}
                        </button>
                        <button class="cancel-btn bg-white/10 hover:bg-white/20 text-white/70 px-3 py-1 rounded-md text-[11px] font-medium transition">
                            ${escapeHtml(cancelLabel)}
                        </button>
                    </div>
                </div>
                <span class="toast-close" title="Cancel">
                    <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                </span>
            `;

            let settled = false;
            const settle = (value) => {
                if (settled) return;
                settled = true;
                if (toast._dismissTimeout) {
                    clearTimeout(toast._dismissTimeout);
                    toast._dismissTimeout = null;
                }
                this._dismissToast(toast);
                resolve(value);
            };

            toast.querySelector('.confirm-btn').addEventListener('click', () => settle(true));
            toast.querySelector('.cancel-btn').addEventListener('click', () => settle(false));
            toast.querySelector('.toast-close')?.addEventListener('click', () => settle(false));

            container.appendChild(toast);
            this._setupSwipeHandlers(toast);

            if (timeoutMs > 0) {
                toast._dismissTimeout = setTimeout(() => settle(false), timeoutMs);
            }
        });
    }

    /**
     * Show a persistent loading toast notification (for long operations)
     * @param {string} message - Loading message
     * @param {string} subtitle - Optional subtitle with more info
     * @param {Object} [options]
     * @param {number} [options.steps] - When provided, renders a determinate
     *   progress ring on the right side. Update via {@link setLoadingProgress}.
     * @param {string} [options.initialLabel] - Label shown below the ring
     *   (defaults to the toast message).
     * @param {string} [options.icon] - 'payment' for an on-chain payment;
     *   the chat bubble otherwise.
     * @returns {HTMLElement} - Toast element (call hideLoadingToast to dismiss)
     */
    showLoadingToast(message, subtitle = 'This may take a moment...', options = {}) {
        const container = document.getElementById('toast-container');
        if (!container) {
            Logger.debug(`[loading] ${message}`);
            return null;
        }

        // Remove any existing loading toasts
        container.querySelectorAll('.toast.loading').forEach(t => t.remove());

        const toast = document.createElement('div');
        toast.className = 'toast loading';

        const showRing = Number.isFinite(options.steps) && options.steps > 0;
        const ringHtml = showRing
            ? `
            <div class="toast-progress-ring" aria-hidden="true">
                <svg class="ring-svg" viewBox="0 0 36 36">
                    <circle class="ring-track" cx="18" cy="18" r="15.9155"></circle>
                    <circle class="ring-fill" cx="18" cy="18" r="15.9155"></circle>
                </svg>
                <span class="ring-label">${escapeHtml(options.initialLabel || message)}</span>
            </div>`
            : '';

        toast.innerHTML = `
            ${LOADING_ICONS[options.icon] || LOADING_ICONS.chat}
            <div class="toast-content">
                <span class="toast-message">${escapeHtml(message)}</span>
                ${subtitle ? `<span class="text-[11px] text-white/40 block mt-0.5">${escapeHtml(subtitle)}</span>` : ''}
            </div>
            ${ringHtml}
            <div class="toast-progress"></div>
        `;

        if (showRing) {
            toast.dataset.totalSteps = String(options.steps);
            toast.dataset.currentStep = '0';
        }

        container.appendChild(toast);
        this.currentLoadingToast = toast;

        // Setup mobile swipe handlers
        this._setupSwipeHandlers(toast);

        return toast;
    }

    /**
     * Update the determinate progress ring on the current loading toast.
     * Safe no-op if the toast was created without `options.steps`.
     * @param {number} step - Current step (1-based). Clamped to [0, totalSteps].
     * @param {string} [label] - Optional new status label below the ring.
     */
    setLoadingProgress(step, label = null) {
        const toast = this.currentLoadingToast;
        if (!toast) return;
        const total = parseInt(toast.dataset.totalSteps || '0', 10);
        if (!total) return;

        const clamped = Math.max(0, Math.min(total, step));
        toast.dataset.currentStep = String(clamped);

        const ringFill = toast.querySelector('.ring-fill');
        if (ringFill) {
            const pct = (clamped / total) * 100;
            ringFill.style.strokeDashoffset = String(100 - pct);
        }

        if (label) {
            const labelEl = toast.querySelector('.ring-label');
            if (labelEl && labelEl.textContent !== label) {
                labelEl.textContent = label;
            }
        }
    }

    /**
     * Hide the current loading toast
     * @param {HTMLElement} toast - Optional specific toast to hide
     */
    hideLoadingToast(toast = null) {
        const target = toast || this.currentLoadingToast;
        if (target && target.parentElement) {
            // Restore if minimized before exit animation
            if (target.classList.contains('toast-minimized')) {
                target.classList.remove('toast-minimized');
                target.style.transform = '';
                target.style.opacity = '';
            }
            target.classList.add('toast-exit');
            setTimeout(() => target.remove(), 250);
        }
        this.currentLoadingToast = null;
    }

    /**
     * Restore a minimized toast to full visibility
     * Note: Timer is not restarted - toast stays until manually dismissed
     * @param {HTMLElement} toast - Toast element to restore
     */
    restoreToast(toast) {
        if (toast && toast.classList.contains('toast-minimized')) {
            toast.classList.remove('toast-minimized');
            toast.style.transform = '';
            toast.style.opacity = '';
            // Resume progress bar animation (visual only, timer was cleared)
            const progressBar = toast.querySelector('.toast-progress');
            if (progressBar) {
                progressBar.style.animationPlayState = 'running';
            }
        }
    }

    /**
     * Show loading indicator at top of messages area. Tagged with the caller's
     * load-op token so a stale `hideLoadingMoreIndicator(staleToken)` from a
     * previously-cancelled op cannot remove a fresh op's spinner.
     * @param {HTMLElement} messagesArea - The messages container element
     * @param {string|number|null} token - Owner token (load-op id). When null,
     *   any pre-existing indicator is replaced unconditionally (legacy behaviour).
     */
    showLoadingMoreIndicator(messagesArea, token = null) {
        // Always replace any pre-existing indicator: a fresh `show` always wins.
        const prior = document.getElementById('loading-more-indicator');
        if (prior) prior.remove();

        const indicator = document.createElement('div');
        indicator.id = 'loading-more-indicator';
        if (token != null) indicator.dataset.loadToken = String(token);
        indicator.className = 'flex justify-center py-3';
        indicator.innerHTML = `
            <div class="flex items-center gap-2 text-white/30 text-sm">
                <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>Loading older messages...</span>
            </div>
        `;
        messagesArea?.prepend(indicator);
    }

    /**
     * Hide the loading indicator. When `token` is provided, the indicator is
     * only removed if its `data-load-token` matches — preventing a stale op
     * from clearing the indicator owned by a fresher op.
     * @param {string|number|null} token - Owner token. Pass null to force-clear.
     */
    hideLoadingMoreIndicator(token = null) {
        const indicator = document.getElementById('loading-more-indicator');
        if (!indicator) return;
        if (token != null) {
            const stored = indicator.dataset.loadToken;
            if (stored !== undefined && stored !== String(token)) return;
        }
        indicator.remove();
    }
}

// Export singleton instance
export const notificationUI = new NotificationUI();
