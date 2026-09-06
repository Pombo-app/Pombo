/**
 * Explore UI Manager
 * Handles the Explore view (front-page) for browsing public channels
 */

import { GATE_MODE } from '../gate.js';
import { escapeHtml, escapeAttr, wireIdentitySpec, wireIdentityIcon } from './utils.js';
import { sanitizeText } from './sanitizer.js';
import { loadCurationManifest, applyCuration } from '../exploreCuration.js';
import { channelImageManager } from '../channelImageManager.js';
import { channelLatestMessageManager } from '../channelLatestMessageManager.js';
import { deriveAdminId } from '../streamConstants.js';
import { getAvatarHtml } from './AvatarGenerator.js';
import { formatPreviewLine } from './channelPreviewFormatter.js';
import { identityManager } from '../identity.js';
import { openUnjoinedChannel } from '../channelEntry.js';

// Explore card access-info styling: the 3-line pricing stack absolutely
// centered in the card's right half on desktop (anchored to the CARD, not
// the top row, so the vertical centering is true; a hairline divider gives
// it price-column structure; pointer-events pass through to the card tap),
// centered under the content on mobile. Tailwind scans these literals.
const EXPLORE_ACCESS_D_CLS = 'explore-gate-access-d hidden md:flex absolute inset-y-3 left-1/2 right-10 items-center justify-center border-l border-white/[0.06] pointer-events-none';
const EXPLORE_ACCESS_M_CLS = 'explore-gate-access-m md:hidden mt-2 flex justify-center';

/** Travel in one direction before the header answers. Anything less is a
 *  trackpad nudge or the reflow retracting causes, and toggling on those
 *  restarts the transition mid-flight, which is what makes a fast scroll
 *  feel unfinished. */
const EXPLORE_HEADER_INTENT = 24;
/** Keep the header until the list has scrolled past roughly its own height. */
const EXPLORE_HEADER_RETRACT_AFTER = 72;
/** Room that must remain below before retracting is safe — see the comment
 *  in _evaluateExploreHeader. Comfortably over the header's own 64px. */
const EXPLORE_HEADER_BOTTOM_SLACK = 96;

/**
 * Audience icon for the author-visibility mode: WHO can see who wrote each
 * message — group (members only) or globe (everyone; amber, because
 * "publicly attributable forever" is what a buyer must notice). Never an
 * identity glyph: both modes guarantee authorship to participants, what
 * changes is the audience.
 */
function authorVisibilityHtml(wireIdentity) {
    if (!wireIdentity) return '';
    const spec = wireIdentitySpec(wireIdentity);
    const title = `${spec.name} — ${spec.audience}`;
    return `<span class="inline-flex text-white/50" title="${title}">${wireIdentityIcon(wireIdentity)}</span>`;
}

/**
 * The 3-line access stack: VERB / VALUE / QUALIFIER. The verb carries the
 * semantic split — Subscribe (recurring, accent-tinted) vs Hold (mere
 * possession, neutral) — and 'in your wallet' says "you pay nothing". The
 * author-visibility icon rides underneath: the mode is a privacy promise the
 * buyer must see BEFORE entering.
 */
function gateAccessHtml(info) {
    if (!info?.verb) return '';
    const verbColor = info.mode === GATE_MODE.PAID ? 'text-[#F6851B]/70' : 'text-white/40';
    return `
        <div class="flex flex-col items-center leading-tight text-center">
            <span class="text-[10px] uppercase tracking-[0.08em] font-medium ${verbColor}">${escapeHtml(info.verb)}</span>
            <span class="text-[15px] font-semibold text-white/90 mt-0.5">${escapeHtml(info.value)}</span>
            <span class="text-[11px] text-white/40 mt-0.5">${escapeHtml(info.qualifier)}</span>
        </div>`;
}

class ExploreUI {
    constructor() {
        // Filter state
        this.browseTypeFilter = 'public';
        this.browseCategoryFilter = '';
        this.browseLanguageFilterValue = '';
        // Access-type marker (N-D): 'open' | 'gated' | 'paid' ('' = all).
        // Explore OPENS on Open — gate-backed storefronts are a tap away.
        this.browseAccessFilter = 'open';
        // gate → { mode, label } | 'pending' — Explore card access info,
        // resolved once per gate (both reads cache in gateManager)
        this._gateCardInfo = new Map();
        
        // Search starts collapsed to an icon; expands into the input on tap.
        this._searchExpanded = false;

        // Cached channels
        this.cachedPublicChannels = null;
        this._handleCategoryViewportChange = () => {
            this.checkCategoriesOverflow();
        };
        this._handleCategoryRailScroll = () => {
            this._syncCategoryCarouselHints();
        };

        // Explore's header is pinned outside the scroller, so browsing left a
        // bar on screen whose own filters had already scrolled away. It now
        // retracts on the way down and comes back on the way up.
        this._lastExploreScrollTop = 0;
        /** Travel since the reader last changed direction. */
        this._exploreScrollIntent = 0;
        this._exploreScrollFrame = 0;

        // A fast scroll fires far more events than there are frames, and each
        // toggle costs a reflow, so decide once per frame at most.
        this._handleExploreHeaderScroll = () => {
            if (this._exploreScrollFrame) return;
            this._exploreScrollFrame = requestAnimationFrame(() => {
                this._exploreScrollFrame = 0;
                this._evaluateExploreHeader();
            });
        };

        this._evaluateExploreHeader = () => {
            // Shared with the chat view, which scrolls the same element.
            if (!document.body.classList.contains('explore-open')) return;
            const scroller = document.getElementById('messages-area');
            if (!scroller) return;
            const furthest = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
            // Overscroll bounce reports positions outside the range.
            const top = Math.min(Math.max(scroller.scrollTop, 0), furthest);
            const delta = top - this._lastExploreScrollTop;
            this._lastExploreScrollTop = top;
            if (delta === 0) return;

            // Turning around starts the count again, so a flick one way never
            // spends its momentum answering for the other.
            if ((delta > 0) !== (this._exploreScrollIntent > 0)) this._exploreScrollIntent = 0;
            this._exploreScrollIntent += delta;
            if (Math.abs(this._exploreScrollIntent) < EXPLORE_HEADER_INTENT) return;

            const retracted = document.body.classList.contains('explore-header-retracted');
            let next = retracted;
            if (this._exploreScrollIntent > 0) {
                // Retracting hands its height back to the list, which shortens
                // the scrollable range; at the end there is nothing left to
                // take up the slack, so the browser pulls scrollTop back and
                // that arrives as an upward scroll, which restores the header,
                // which lengthens the range again. Leave it alone down there.
                if (furthest - top <= EXPLORE_HEADER_BOTTOM_SLACK) return;
                // Retracting while its own row is still on screen would pull
                // the list up from under a bar the reader can still see.
                next = top > EXPLORE_HEADER_RETRACT_AFTER;
            } else {
                next = false;
            }
            if (next === retracted) return;

            document.body.classList.toggle('explore-header-retracted', next);
            this._exploreScrollIntent = 0;
            // The toggle reflows the list; read the resulting position back so
            // it is not mistaken for the reader moving.
            requestAnimationFrame(() => {
                this._lastExploreScrollTop = scroller.scrollTop;
            });
        };

        this.deps = {};
    }

    /**
     * Set dependencies
     * @param {Object} deps - { getPublicChannels, joinPublicChannel(streamId, channelInfo), getNsfwEnabled }
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * Generate the Explore view HTML template
     * @param {boolean} nsfwEnabled - Whether NSFW content is enabled
     * @returns {string} HTML template
     */
    getTemplate(nsfwEnabled = false) {
        const chipClass = 'explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80';
        const orderedCategoryChips = [
            { category: '', label: 'All', active: true },
            { category: 'general', label: 'General' },
            { category: 'news', label: 'News' },
            { category: 'crypto', label: 'Crypto' },
            { category: 'finance', label: 'Finance' },
            { category: 'politics', label: 'Politics' },
            { category: 'science', label: 'Science' },
            { category: 'gaming', label: 'Gaming' },
            { category: 'sports', label: 'Sports' },
            { category: 'health', label: 'Health' },
            { category: 'tech', label: 'Tech & AI' },
            { category: 'entertainment', label: 'Entertainment' },
            { category: 'education', label: 'Education' },
            { category: 'comedy', label: 'Comedy' },
            ...(nsfwEnabled
                ? [
                    { category: 'nsfw', label: 'NSFW' },
                    { category: 'adult', label: 'Adult' }
                ]
                : []),
        ];
        const categoryChips = orderedCategoryChips.map(chip => {
            const classes = chip.active ? 'explore-category-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white text-black' : chipClass;
            return `<button type="button" data-category="${chip.category}" class="${classes}">${chip.label}</button>`;
        }).join('');

        const languageOptions = [
            ['', 'All Languages'], ['en', 'English'], ['pt', 'Português'],
            ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
            ['it', 'Italiano'], ['zh', '中文'], ['ja', '日本語'],
            ['ko', '한국어'], ['ru', 'Русский'], ['ar', 'العربية'],
            ['other', 'Other']
        ];
        const languageMenuItems = languageOptions.map(([value, label]) => `
            <button type="button" data-language="${value}" class="explore-language-option w-full text-left px-3 py-2 rounded-lg text-[13px] text-white/70 hover:bg-white/[0.06] transition">${escapeHtml(label)}</button>
        `).join('');
        const accessMarkersHtml = `
            <div class="flex items-center gap-1 text-sm flex-shrink-0">
                ${['open', 'gated', 'paid'].map((t, i) => `
                    ${i > 0 ? '<span class="text-white/15 px-1">|</span>' : ''}
                    <button type="button" data-access="${t}" class="explore-access-marker px-2 py-1 rounded-md transition text-white/50 hover:text-white/80">
                        ${t[0].toUpperCase() + t.slice(1)}
                    </button>`).join('')}
            </div>`;

        return `
            <div class="explore-view flex flex-col h-full bg-[#0f0f12]">
                <!-- Filters Section -->
                <div class="px-4 pt-3 pb-3 space-y-3">
                    <!-- Access filters left, search + language icons right
                         (2026-08-21 redesign, was bookended). Search
                         collapses to an icon and expands in place — up to
                         the language icon, never pushing the pills down —
                         only when tapped; language drops its "All Languages"
                         text label for an icon-only trigger. -->
                    <div class="flex items-center gap-2">
                        ${accessMarkersHtml}
                        <div class="flex-1 flex items-center justify-end min-w-0">
                            <button type="button" id="explore-search-toggle-btn" aria-label="Search channels" class="flex-shrink-0 w-[38px] h-[38px] flex items-center justify-center bg-white/5 border border-white/10 rounded-xl text-white/50 hover:text-white/80 transition">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/>
                                </svg>
                            </button>
                            <div class="hidden items-center gap-2 bg-white/[0.06] border border-[#F6851B]/40 rounded-xl px-3 h-[38px] w-full" id="explore-search-expanded-row">
                                <svg class="w-4 h-4 text-[#F6851B] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/>
                                </svg>
                                <input
                                    type="search"
                                    id="explore-search-input"
                                    name="pombo_explore_filter"
                                    placeholder="Search"
                                    autocomplete="off"
                                    data-lpignore="true"
                                    data-1p-ignore="true"
                                    data-form-type="other"
                                    class="flex-1 min-w-0 bg-transparent text-white text-sm focus:outline-none placeholder:text-white/30"
                                />
                                <button type="button" id="explore-search-close-btn" aria-label="Close search" class="flex-shrink-0 text-white/40 hover:text-white/70 transition">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M6 6l12 12M18 6L6 18"/></svg>
                                </button>
                            </div>
                        </div>
                        <div class="relative flex-shrink-0">
                            <button type="button" id="explore-language-toggle-btn" aria-label="Language filter" class="w-[38px] h-[38px] flex items-center justify-center bg-white/5 border border-white/10 rounded-xl text-white/50 hover:text-white/80 transition">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <circle cx="12" cy="12" r="9"/>
                                    <path stroke-linecap="round" d="M3 12h18M12 3c2.4 2.4 3.8 5.7 3.8 9s-1.4 6.6-3.8 9c-2.4-2.4-3.8-5.7-3.8-9s1.4-6.6 3.8-9z"/>
                                </svg>
                            </button>
                            <div id="explore-language-dropdown" class="hidden absolute top-full right-0 mt-1.5 w-44 max-h-72 overflow-y-auto bg-[#16161b] border border-white/[0.1] rounded-xl p-1.5 shadow-2xl z-30">
                                ${languageMenuItems}
                            </div>
                        </div>
                    </div>

                    <!-- Category Chips (collapsible) -->
                    <div class="explore-category-controls">
                        <div class="explore-category-rail" data-overflow="false" data-scroll-start="true" data-scroll-end="true">
                            <div id="explore-category-chips" class="explore-category-chips flex gap-1.5 transition-all duration-200" data-expanded="false">
                                ${categoryChips}
                                <button type="button" id="explore-private-chip" class="explore-private-chip px-2.5 py-1 rounded-md text-xs font-medium transition bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80 flex items-center gap-1">
                                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/></svg>
                                    Private
                                </button>
                            </div>
                        </div>
                        <button id="explore-toggle-categories-btn" type="button" aria-controls="explore-category-chips" aria-expanded="false" class="explore-toggle-categories-btn hidden items-center justify-center text-white/40 hover:text-white/60 transition">
                            <svg id="explore-toggle-categories-icon" class="w-4 h-4 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 9l-7 7-7-7"/>
                            </svg>
                        </button>
                    </div>
                </div>

                <!-- Subtle separator -->
                <div class="mx-4 border-t border-white/[0.06]"></div>

                <!-- Channel List -->
                <div id="explore-channels-list" class="flex-1 overflow-y-auto px-4 py-3 space-y-2">
                    <div class="flex flex-col items-center justify-center py-12 text-white/40">
                        <div class="spinner mb-3" style="width: 28px; height: 28px;"></div>
                        <p class="text-sm">Loading channels...</p>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Setup event listeners for the Explore view
     */
    setupListeners() {
        // Search input
        const searchInput = document.getElementById('explore-search-input');
        searchInput?.addEventListener('input', (e) => {
            this.filterChannels(e.target.value);
        });

        // Search collapses to an icon; expands in place — up to the language
        // icon, pills stay put — only on tap (2026-08-21 redesign, was a
        // second row). Autofocuses so typing starts immediately.
        const searchToggleBtn = document.getElementById('explore-search-toggle-btn');
        const expandedRow = document.getElementById('explore-search-expanded-row');
        searchToggleBtn?.addEventListener('click', () => {
            this._searchExpanded = true;
            searchToggleBtn.classList.add('hidden');
            expandedRow?.classList.remove('hidden');
            expandedRow?.classList.add('flex');
            searchInput?.focus();
        });
        document.getElementById('explore-search-close-btn')?.addEventListener('click', () => {
            this._searchExpanded = false;
            if (searchInput) searchInput.value = '';
            expandedRow?.classList.add('hidden');
            expandedRow?.classList.remove('flex');
            searchToggleBtn?.classList.remove('hidden');
            this.filterChannels('');
        });

        // Language: icon-only trigger + a custom dropdown (2026-08-20/21
        // redesign, was a native <select> showing "All Languages" in full).
        const languageDropdown = document.getElementById('explore-language-dropdown');
        document.getElementById('explore-language-toggle-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            languageDropdown?.classList.toggle('hidden');
        });
        document.addEventListener('click', () => languageDropdown?.classList.add('hidden'));
        document.querySelectorAll('.explore-language-option').forEach(opt => {
            opt.addEventListener('click', (e) => {
                e.stopPropagation();
                this.browseLanguageFilterValue = opt.dataset.language;
                this.updateLanguageToggle();
                languageDropdown?.classList.add('hidden');
                this.filterChannels(searchInput?.value || '');
            });
        });
        this.updateLanguageToggle();

        // Private chip. Selecting only — tapping it while active does nothing.
        const privateChip = document.getElementById('explore-private-chip');
        privateChip?.addEventListener('click', () => {
            if (this.browseTypeFilter === 'password') return;
            this.browseTypeFilter = 'password';
            this.browseCategoryFilter = '';
            this.updateCategoryChips();
            // Password view and the access markers are disjoint universes
            this.browseAccessFilter = '';
            this.updateAccessMarkers();
            this.updatePrivateChip();
            this.filterChannels(searchInput?.value || '');
        });

        // Access-type markers (Open / Gated / Paid) — exclusive, and selecting
        // only: tapping the active one does nothing.
        document.querySelectorAll('.explore-access-marker').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this.browseAccessFilter === btn.dataset.access) return;
                this.browseAccessFilter = btn.dataset.access;
                if (this.browseTypeFilter === 'password') {
                    this.browseTypeFilter = 'public';
                    this.updatePrivateChip();
                }
                this.updateAccessMarkers();
                this.filterChannels(searchInput?.value || '');
            });
        });
        this.updateAccessMarkers();   // paint the pre-selected Open
        
        // Category chips
        document.querySelectorAll('.explore-category-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                this.browseCategoryFilter = chip.dataset.category;
                this.updateCategoryChips();
                this.filterChannels(searchInput?.value || '');
            });
        });
        
        // Toggle categories expand/collapse
        document.getElementById('explore-toggle-categories-btn')?.addEventListener('click', () => {
            this.toggleCategoriesExpand();
        });
        document.getElementById('explore-category-chips')?.addEventListener('scroll', this._handleCategoryRailScroll, { passive: true });

        window.removeEventListener('resize', this._handleCategoryViewportChange);
        window.addEventListener('resize', this._handleCategoryViewportChange);

        // Explore re-renders into #messages-area, but the element itself
        // survives, so the listener has to be swapped rather than stacked.
        const scroller = document.getElementById('messages-area');
        if (scroller) {
            scroller.removeEventListener('scroll', this._handleExploreHeaderScroll);
            scroller.addEventListener('scroll', this._handleExploreHeaderScroll, { passive: true });
        }
        this._lastExploreScrollTop = 0;
        this._exploreScrollIntent = 0;
        document.body.classList.remove('explore-header-retracted');
        
        // Check if categories need expand button
        this.checkCategoriesOverflow();
    }

    /** Highlights the language icon + the picked option when a specific language is active. */
    updateLanguageToggle() {
        const btn = document.getElementById('explore-language-toggle-btn');
        const active = !!this.browseLanguageFilterValue;
        btn?.classList.toggle('text-[#F6851B]', active);
        btn?.classList.toggle('border-[#F6851B]/50', active);
        btn?.classList.toggle('text-white/50', !active);
        btn?.classList.toggle('border-white/10', !active);
        document.querySelectorAll('.explore-language-option').forEach(opt => {
            const picked = opt.dataset.language === this.browseLanguageFilterValue;
            opt.classList.toggle('text-white', picked);
            opt.classList.toggle('bg-white/[0.06]', picked);
            opt.classList.toggle('text-white/70', !picked);
        });
    }

    /**
     * Reset filters to default state
     */
    resetFilters() {
        this.browseTypeFilter = 'public';
        this.browseCategoryFilter = '';
        this.browseLanguageFilterValue = '';
        this.browseAccessFilter = 'open';
        this.updateAccessMarkers();
        this.updateLanguageToggle();

        // Sync tab and chip UI to match reset state
        this.updatePrivateChip();
        this.updateCategoryChips();
    }

    /**
     * Load channels from the API
     */
    async loadChannels() {
        const listEl = document.getElementById('explore-channels-list');
        if (!listEl) return;

        // New Explore session: revalidate visible previews once even when
        // a cached entry already exists, but avoid re-fetching again on
        // every filter/search rerender within the same open view.
        this._explorePreviewResolved = new Set();
        this._explorePreviewRefreshStarted = new Set();

        listEl.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-white/40">
                <div class="spinner mb-3" style="width: 28px; height: 28px;"></div>
                <p class="text-sm">Loading channels...</p>
            </div>
        `;

        try {
            if (!this.deps.getPublicChannels) {
                throw new Error('getPublicChannels dependency not set');
            }
            // Fetch channels and curation manifest in parallel; curation failure
            // is non-fatal (helper falls back to an empty manifest).
            const [channels, manifest] = await Promise.all([
                this.deps.getPublicChannels(),
                loadCurationManifest(),
            ]);
            this.cachedPublicChannels = applyCuration(channels, manifest);
            // Resolve gate modes for the WHOLE list up front, not just the
            // rendered subset — Explore opens on Open, so gated cards are
            // filtered out before rendering and the per-render resolution
            // never fires; tapping Paid then filtered against nothing.
            this._resolveGateAccess(this.cachedPublicChannels);
            this.filterChannels('');
        } catch (error) {
            console.error('Failed to load explore channels:', error);
            listEl.innerHTML = `
                <div class="flex flex-col items-center justify-center py-12 text-white/40">
                    <svg class="w-12 h-12 mb-3 text-red-400/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/>
                    </svg>
                    <p class="text-sm">Failed to load channels</p>
                    <p class="text-xs text-white/30 mt-1">${escapeHtml(error.message)}</p>
                </div>
            `;
        }
    }

    /**
     * Filter channels based on current filter state
     * @param {string} query - Search query
     */
    filterChannels(query) {
        if (!this.cachedPublicChannels) return;
        
        let filtered = this.cachedPublicChannels;
        
        // Apply type filter. Two buckets only: password channels live behind
        // the Private chip (their access is a secret shared out-of-band);
        // everything else — public AND gate-backed (gated/paid) — is a
        // storefront and lists in the main view.
        if (this.browseTypeFilter === 'password') {
            filtered = filtered.filter(ch => ch.type === 'password');
        } else {
            filtered = filtered.filter(ch => ch.type !== 'password');
        }

        // Access-type markers (N-D): Open = public; Gated vs Paid split by
        // the on-chain gate MODE — an unresolved gate counts as Gated until
        // its (cached) read lands and re-filters.
        if (this.browseAccessFilter === 'open') {
            filtered = filtered.filter(ch => ch.type === 'public');
        } else if (this.browseAccessFilter === 'gated') {
            filtered = filtered.filter(ch => ch.type === 'gated'
                && this._gateCardInfo.get(ch.gateAddress)?.mode !== GATE_MODE.PAID);
        } else if (this.browseAccessFilter === 'paid') {
            filtered = filtered.filter(ch => ch.type === 'gated'
                && this._gateCardInfo.get(ch.gateAddress)?.mode === GATE_MODE.PAID);
        }
        
        // Apply category filter
        if (this.browseCategoryFilter) {
            filtered = filtered.filter(ch => ch.category === this.browseCategoryFilter);
        }
        
        // Exclude NSFW/Adult channels unless:
        // 1. User explicitly selected NSFW/Adult category
        // 2. User has enabled "Show Sensitive Content" in settings
        const nsfwEnabled = this.deps.getNsfwEnabled ? this.deps.getNsfwEnabled() : false;
        if (this.browseCategoryFilter !== 'nsfw' && this.browseCategoryFilter !== 'adult' && !nsfwEnabled) {
            filtered = filtered.filter(ch => ch.category !== 'nsfw' && ch.category !== 'adult');
        }
        
        // Apply language filter (only when a specific language is selected, not "All")
        if (this.browseLanguageFilterValue) {
            filtered = filtered.filter(ch => ch.language === this.browseLanguageFilterValue);
        }
        
        // Apply search filter
        if (query) {
            const q = query.toLowerCase();
            filtered = filtered.filter(ch => 
                (ch.name || ch.displayName || '').toLowerCase().includes(q) ||
                ch.streamId.toLowerCase().includes(q) ||
                (ch.description && ch.description.toLowerCase().includes(q))
            );
        }
        
        this.renderChannelsList(filtered);
    }

    /**
     * Render the filtered channels list
     * @param {Array} channels - Array of channel objects
     */
    renderChannelsList(channels) {
        const listEl = document.getElementById('explore-channels-list');
        if (!listEl) return;

        if (channels.length === 0) {
            listEl.innerHTML = `
                <div class="flex flex-col items-center justify-center py-12 text-white/40">
                    <svg class="w-12 h-12 mb-3 text-white/20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/>
                    </svg>
                    <p class="text-sm">No channels found</p>
                    <p class="text-xs text-white/30 mt-1">Try adjusting your filters</p>
                </div>
            `;
            return;
        }
        
        const categoryNames = {
            politics: 'Politics', news: 'News', tech: 'Tech & AI', crypto: 'Crypto',
            finance: 'Finance', science: 'Science', gaming: 'Gaming', entertainment: 'Entertainment',
            sports: 'Sports', health: 'Health', education: 'Education', comedy: 'Comedy', 
            general: 'General', other: 'Other', nsfw: 'NSFW', adult: 'Adult'
        };
        
        const languageNames = { 
            en: 'EN', pt: 'PT', es: 'ES', fr: 'FR', de: 'DE', 
            it: 'IT', zh: '中文', ja: '日本語', ko: '한국어', ru: 'RU', ar: 'العربية', other: 'Other'
        };

        listEl.innerHTML = channels.map(ch => {
            const readOnlyBadge = ch.readOnly 
                ? '<svg class="w-3.5 h-3.5 md:w-5 md:h-5 text-white/60 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"/></svg>' 
                : '';
            const categoryBadge = ch.category && ch.category !== 'general'
                ? `<span class="px-1.5 py-1 bg-white/5 text-white/50 text-[11px] font-medium rounded">${escapeHtml(categoryNames[ch.category] || ch.category)}</span>`
                : '';
            // Access info (N-D): the 3-line stack — right half on desktop,
            // centered under the content on mobile. Rendered inline when the
            // mode is cached, patched async otherwise.
            const gateCached = ch.type === 'gated' && ch.gateAddress
                ? this._gateCardInfo.get(ch.gateAddress) : null;
            const accessHtml = gateCached && gateCached !== 'pending'
                ? gateAccessHtml(gateCached) : '';
            const accessAttr = ch.type === 'gated' && ch.gateAddress
                ? `data-gate-access="${escapeAttr(ch.gateAddress)}"` : '';
            const accessDesktop = accessAttr
                ? `<div ${accessAttr} class="${accessHtml ? EXPLORE_ACCESS_D_CLS : 'explore-gate-access-d hidden'}">${accessHtml}</div>`
                : '';
            const accessMobile = accessAttr
                ? `<div ${accessAttr} class="${accessHtml ? EXPLORE_ACCESS_M_CLS : 'explore-gate-access-m hidden'}">${accessHtml}</div>`
                : '';
            const languageBadge = ch.language
                ? `<span class="px-1.5 py-1 bg-white/5 text-white/50 text-[11px] font-medium rounded">${escapeHtml(languageNames[ch.language] || ch.language.toUpperCase())}</span>`
                : '';
            // Every card caps description/preview at 55% on desktop (two
            // lines max) — uniform layout, and gated cards never run under
            // the absolutely-centered access text
            const halfCap = ' md:max-w-[55%]';
            // Defense-in-depth: sanitize user-provided content before escaping
            const description = ch.description
                ? `<p class="text-base text-white/40 mt-1 line-clamp-2${halfCap}">${escapeHtml(sanitizeText(ch.description))}</p>`
                : '';

            // Latest message preview (sidebar/Explore share the same source).
            // Cached read first; lazy-fetch dispatched after innerHTML below.
            if (!this._explorePreviewResolved) this._explorePreviewResolved = new Set();
            const previewEntry = channelLatestMessageManager.getCached(ch.streamId);
            // `.channel-preview-line.explore-preview-line` controls color
            // (uniform muted gray) and wrapping (clamp 2 lines desktop /
            // 3 lines mobile). Drop the explicit `truncate` class — the
            // CSS rule handles overflow with multi-line clamping.
            let previewLine;
            if (ch.type === 'gated') {
                // Gated: no card previews — members-only content, and the
                // browser-wide preview cache would leak entries a member
                // account decrypted to every other account on this device
                previewLine = '';
            } else if (previewEntry) {
                previewLine = `<p class="channel-preview-line explore-preview-line mt-3 ml-3${halfCap}" data-channel-preview="${escapeAttr(ch.streamId)}">${formatPreviewLine(previewEntry)}</p>`;
            } else if (!this._explorePreviewResolved.has(ch.streamId)) {
                previewLine = `<p class="channel-preview-line explore-preview-line mt-3 ml-3${halfCap}" data-channel-preview="${escapeAttr(ch.streamId)}"><span class="thumb-spinner inline-block align-middle" style="width:10px;height:10px"></span></p>`;
            } else {
                // Resolved without a usable entry → leave the slot empty
                // (avoids a permanent dead spinner on dormant channels).
                previewLine = `<p class="channel-preview-line explore-preview-line mt-3 ml-4${halfCap}" data-channel-preview="${escapeAttr(ch.streamId)}"></p>`;
            }

            // Channel thumbnail: cached if available, else spinner placeholder
            // (or deterministic fallback once lookup has settled).
            // We always pass through the manager so the same fetch is
            // shared with the sidebar and Channel Details panes.
            const adminStreamId = deriveAdminId(ch.streamId);
            const cachedImage = adminStreamId ? channelImageManager.getCached(adminStreamId) : null;
            if (!this._exploreResolvedImages) this._exploreResolvedImages = new Set();
            let thumb;
            if (cachedImage?.dataUrl) {
                thumb = `<img class="rounded-full object-cover flex-shrink-0" alt="" src="${escapeAttr(cachedImage.dataUrl)}" data-channel-thumb="${escapeAttr(adminStreamId)}" style="width:56px;height:56px" />`;
            } else if (adminStreamId && !this._exploreResolvedImages.has(adminStreamId)) {
                thumb = `<div class="rounded-full flex items-center justify-center flex-shrink-0 bg-white/[0.04]" data-channel-thumb="${escapeAttr(adminStreamId)}" style="width:56px;height:56px"><div class="thumb-spinner" style="width:20px;height:20px"></div></div>`;
            } else {
                thumb = `<div class="rounded-full overflow-hidden flex-shrink-0" data-channel-thumb="${escapeAttr(adminStreamId || '')}" style="width:56px;height:56px">${getAvatarHtml(ch.streamId, 56, 0.5, null)}</div>`;
            }

            return `
            <div class="relative p-4 md:w-[70%] md:mx-auto bg-white/[0.03] border border-white/[0.05] rounded-2xl hover:bg-white/[0.06] hover:border-white/[0.1] transition-all duration-200 cursor-pointer explore-channel-item group" data-stream-id="${escapeAttr(ch.streamId)}" data-type="${escapeAttr(ch.type || 'public')}">
                <div class="flex items-start justify-between gap-3">
                    <div class="flex items-start gap-3 flex-1 min-w-0">
                        ${thumb}
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2 flex-wrap">
                                ${readOnlyBadge}
                                <h4 class="text-base font-large text-white/90 truncate">${escapeHtml(sanitizeText(ch.name || ch.displayName || 'Unknown'))}</h4>
                            </div>
                            ${description}
                            ${previewLine}
                        </div>
                    </div>
                    ${accessDesktop}
                    <svg class="w-4 h-4 text-white/15 group-hover:text-white/30 flex-shrink-0 mt-0.5 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                    </svg>
                </div>
                <div class="relative">
                    ${accessMobile}
                    <div class="flex items-end justify-end gap-1.5 mt-3${accessAttr ? ' absolute bottom-0 right-0 md:static' : ''}">
                        ${(() => {
                            // The audience icon centers over the LAST tag
                            // (language when present), not over the group.
                            const icon = ch.type === 'gated'
                                ? authorVisibilityHtml(ch.wireIdentity || 'visible') : '';
                            const badges = [categoryBadge, languageBadge].filter(Boolean);
                            if (!icon) return badges.join('');
                            if (!badges.length) return icon;
                            const last = badges.pop();
                            return `${badges.join('')}<div class="flex flex-col items-center gap-1">${icon}${last}</div>`;
                        })()}
                    </div>
                </div>
            </div>
            `;
        }).join('');

        // Resolve gate modes/labels for cards that missed the cache
        this._resolveGateAccess(channels);

        // Lazy-fetch missing thumbnails (deduped by manager).
        // Public/password channels are publicly readable on -3, so this works
        // even before joining. Hidden channels will simply fall back.
        for (const ch of channels) {
            const adminStreamId = deriveAdminId(ch.streamId);
            if (!adminStreamId) continue;
            if (channelImageManager.getCached(adminStreamId)?.dataUrl) continue;
            if (this._exploreResolvedImages.has(adminStreamId)) continue;
            channelImageManager.get(adminStreamId, { password: null })
                .then(entry => {
                    if (!entry?.dataUrl) return;
                    const slot = listEl.querySelector(`[data-channel-thumb="${CSS.escape(adminStreamId)}"]`);
                    if (slot && !(slot.tagName === 'IMG')) {
                        slot.outerHTML = `<img class="rounded-full object-cover flex-shrink-0" alt="" src="${escapeAttr(entry.dataUrl)}" data-channel-thumb="${escapeAttr(adminStreamId)}" style="width:56px;height:56px" />`;
                    } else if (slot && slot.tagName === 'IMG') {
                        slot.src = entry.dataUrl;
                    }
                })
                .catch(() => {})
                .finally(() => {
                    this._exploreResolvedImages.add(adminStreamId);
                    // If still showing spinner placeholder (no image found),
                    // swap to deterministic fallback avatar.
                    const slot = listEl.querySelector(`[data-channel-thumb="${CSS.escape(adminStreamId)}"]`);
                    if (slot && slot.tagName !== 'IMG' && !channelImageManager.getCached(adminStreamId)?.dataUrl) {
                        slot.outerHTML = `<div class="rounded-full overflow-hidden flex-shrink-0" data-channel-thumb="${escapeAttr(adminStreamId)}" style="width:56px;height:56px">${getAvatarHtml(ch.streamId, 56, 0.5, null)}</div>`;
                    }
                });
        }

        // Lazy-fetch missing latest-message previews (sidebar shares cache).
        // Public/password channels: -1/P0 is publicly readable, so this
        // works even before joining. Encrypted (password) channels return
        // entries we can't decrypt without the password and are silently
        // skipped — the slot will fall back to "empty" once resolved.
        // Also (re-)subscribe so a later re-emit (e.g. when ENS resolves
        // for the sender) patches the slot in place.
        if (this._explorePreviewSubs) {
            for (const u of this._explorePreviewSubs.values()) { try { u(); } catch {} }
        }
        this._explorePreviewSubs = new Map();
        if (!this._explorePreviewRefreshStarted) this._explorePreviewRefreshStarted = new Set();
        for (const ch of channels) {
            if (!ch.streamId) continue;
            // Gated: no card previews (Android parity). The content is for
            // members; and the preview cache is browser-wide, so an entry
            // decrypted by a member ACCOUNT would leak to the other accounts
            // on the same device.
            if (ch.type === 'gated') continue;
            if (!this._explorePreviewSubs.has(ch.streamId)) {
                const unsub = channelLatestMessageManager.subscribe(ch.streamId, (entry) => {
                    const slot = listEl.querySelector(`[data-channel-preview="${CSS.escape(ch.streamId)}"]`);
                    if (!slot) return;
                    slot.innerHTML = entry ? formatPreviewLine(entry) : '';
                    if (entry) this._resolveExplorePreviewSender(listEl, channels, entry);
                });
                this._explorePreviewSubs.set(ch.streamId, unsub);
            }
            if (this._explorePreviewRefreshStarted.has(ch.streamId)) continue;
            this._explorePreviewRefreshStarted.add(ch.streamId);
            channelLatestMessageManager.get(ch.streamId, { password: null })
                .then(entry => {
                    const slot = listEl.querySelector(`[data-channel-preview="${CSS.escape(ch.streamId)}"]`);
                    if (slot) slot.innerHTML = entry ? formatPreviewLine(entry) : '';
                    if (entry) this._resolveExplorePreviewSender(listEl, channels, entry);
                })
                .catch(() => {})
                .finally(() => {
                    this._explorePreviewResolved.add(ch.streamId);
                    // If still showing spinner placeholder (no entry), clear it
                    const slot = listEl.querySelector(`[data-channel-preview="${CSS.escape(ch.streamId)}"]`);
                    if (slot && !channelLatestMessageManager.getCached(ch.streamId)) {
                        slot.innerHTML = '';
                    }
                });
        }

        // Lazy-resolve ENS for the senders of cached/resolved preview
        // entries that don't carry a payload `senderName`. Same pattern
        // as `OnlineUsersUI`: dedupe in identityManager, refresh the
        // matching slots when the lookup settles.
        this._resolveExplorePreviewSenders(listEl, channels);

        // Add click listeners
        listEl.querySelectorAll('.explore-channel-item').forEach(item => {
            item.addEventListener('click', async () => {
                const streamId = item.dataset.streamId;
                const channelType = item.dataset.type;
                
                if (!streamId) return;
                
                // The card's own type stands in when the cache has no entry
                // for this row, so routing never falls back to public.
                const cached = this.cachedPublicChannels?.find(ch => ch.streamId === streamId);
                const channelInfo = cached || (channelType ? { type: channelType } : null);

                await openUnjoinedChannel(streamId, channelInfo, {
                    enterPreviewMode: this.deps.enterPreviewMode,
                    joinPublicChannel: this.deps.joinPublicChannel
                });
            });
        });
    }

    /**
     * Lazy-resolve ENS for the senders of every preview entry rendered
     * in the Explore list. Mirrors the pattern used by OnlineUsersUI /
     * ChannelListUI: identityManager dedupes inflight lookups + caches
     * 24h, so calling this on every render is cheap. When ENS lands we
     * patch only the slots whose sender matches.
     * @private
     */
    _resolveExplorePreviewSenders(listEl, channels) {
        const runPass = () => {
            for (const ch of channels) {
                if (!ch?.streamId) continue;
                const entry = channelLatestMessageManager.getCached(ch.streamId);
                this._resolveExplorePreviewSender(listEl, channels, entry);
            }
        };
        runPass();
        // Retry once shortly after render so startup races between
        // preview hydration and identityManager.init() still settle
        // without requiring the user to navigate into the channel.
        setTimeout(runPass, 1500);
    }

    /** @private */
    _resolveExplorePreviewSender(listEl, channels, entry) {
        if (!entry?.sender || entry.senderName) return;
        const addr = entry.sender;
        const normalizedAddr = typeof addr === 'string' ? addr.toLowerCase() : addr;
        const cached = normalizedAddr ? identityManager.ensCache?.get(normalizedAddr) : null;
        if (cached && cached.name) return;
        identityManager.resolveENS?.(addr)
            ?.then(name => {
                if (!name) return;
                for (const ch of channels) {
                    if (!ch?.streamId) continue;
                    const e = channelLatestMessageManager.getCached(ch.streamId);
                    if (!e?.sender) continue;
                    const sender = typeof e.sender === 'string' ? e.sender.toLowerCase() : e.sender;
                    if (sender !== normalizedAddr) continue;
                    const slot = listEl.querySelector(`[data-channel-preview="${CSS.escape(ch.streamId)}"]`);
                    if (slot) slot.innerHTML = formatPreviewLine(e);
                }
            })
            ?.catch(() => {});
    }

    /**
     * Resolve mode + access label for every gated card missing from the
     * cache, patch the card slots when each read lands, and re-apply an
     * active Gated/Paid marker (the split depends on the resolved mode).
     */
    _resolveGateAccess(channels) {
        const pending = channels.filter(ch => ch.type === 'gated' && ch.gateAddress
            && !this._gateCardInfo.has(ch.gateAddress));
        for (const ch of pending) {
            this._gateCardInfo.set(ch.gateAddress, 'pending');
            import('../gate.js')
                .then(({ gateManager }) => gateManager.gateCardInfo(ch.gateAddress))
                .then((info) => {
                    // The card's author-visibility icon rides on the cached
                    // info so the async patch renders it too
                    info.wireIdentity = ch.wireIdentity || 'visible';
                    this._gateCardInfo.set(ch.gateAddress, info);
                    this._patchGateAccess(ch.gateAddress, info);
                    if (this.browseAccessFilter === 'gated' || this.browseAccessFilter === 'paid') {
                        const searchInput = document.getElementById('explore-search-input');
                        this.filterChannels(searchInput?.value || '');
                    }
                })
                .catch(() => this._gateCardInfo.delete(ch.gateAddress));  // retried next render
        }
    }

    _patchGateAccess(gateAddress, info) {
        const html = gateAccessHtml(info);
        if (!html) return;
        const selector = `[data-gate-access="${CSS.escape(gateAddress)}"]`;
        document.querySelectorAll(`.explore-gate-access-d${selector}`).forEach(el => {
            el.innerHTML = html;
            el.className = EXPLORE_ACCESS_D_CLS;
        });
        document.querySelectorAll(`.explore-gate-access-m${selector}`).forEach(el => {
            el.innerHTML = html;
            el.className = EXPLORE_ACCESS_M_CLS;
        });
    }

    /**
     * Update access markers UI state
     */
    updateAccessMarkers() {
        document.querySelectorAll('.explore-access-marker').forEach(btn => {
            const active = btn.dataset.access === this.browseAccessFilter;
            btn.classList.toggle('bg-white', active);
            btn.classList.toggle('text-black', active);
            btn.classList.toggle('font-medium', active);
            btn.classList.toggle('text-white/50', !active);
            btn.classList.toggle('hover:text-white/80', !active);
        });
    }

    /**
     * Update Private chip UI state
     */
    updatePrivateChip() {
        const chip = document.getElementById('explore-private-chip');
        if (!chip) return;
        const isActive = this.browseTypeFilter === 'password';
        if (isActive) {
            chip.classList.add('bg-white', 'text-black');
            chip.classList.remove('bg-white/5', 'text-white/60', 'hover:bg-white/10', 'hover:text-white/80');
        } else {
            chip.classList.remove('bg-white', 'text-black');
            chip.classList.add('bg-white/5', 'text-white/60', 'hover:bg-white/10', 'hover:text-white/80');
        }
    }

    /**
     * Update category chips UI state
     */
    updateCategoryChips() {
        document.querySelectorAll('.explore-category-chip').forEach(chip => {
            const isActive = chip.dataset.category === this.browseCategoryFilter;
            if (isActive) {
                chip.classList.add('bg-white', 'text-black');
                chip.classList.remove('bg-white/5', 'text-white/60', 'hover:bg-white/10', 'hover:text-white/80');
            } else {
                chip.classList.remove('bg-white', 'text-black');
                chip.classList.add('bg-white/5', 'text-white/60', 'hover:bg-white/10', 'hover:text-white/80');
            }
        });
    }

    /** @private */
    _measureCollapsedCategoriesOverflow(container) {
        if (!container) return false;
        const wasExpanded = container.dataset.expanded === 'true';
        if (wasExpanded) container.dataset.expanded = 'false';
        const hasOverflow = container.scrollWidth > (container.clientWidth + 1);
        if (wasExpanded) container.dataset.expanded = 'true';
        return hasOverflow;
    }

    /** @private */
    _syncCategoryCarouselHints() {
        const rail = document.querySelector('.explore-category-rail');
        const container = document.getElementById('explore-category-chips');

        if (!rail || !container) return;

        const isExpanded = container.dataset.expanded === 'true';
        const hasOverflow = isExpanded
            ? this._measureCollapsedCategoriesOverflow(container)
            : container.scrollWidth > (container.clientWidth + 1);

        if (isExpanded || !hasOverflow) {
            rail.dataset.overflow = 'false';
            rail.dataset.scrollStart = 'true';
            rail.dataset.scrollEnd = 'true';
            return;
        }

        const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
        const currentScrollLeft = Math.max(0, container.scrollLeft || 0);
        const threshold = 2;

        rail.dataset.overflow = 'true';
        rail.dataset.scrollStart = currentScrollLeft <= threshold ? 'true' : 'false';
        rail.dataset.scrollEnd = currentScrollLeft >= (maxScrollLeft - threshold) ? 'true' : 'false';
    }

    /** @private */
    _setCategoriesExpanded(expanded) {
        const container = document.getElementById('explore-category-chips');
        const icon = document.getElementById('explore-toggle-categories-icon');
        const btn = document.getElementById('explore-toggle-categories-btn');

        if (!container) return;

        container.dataset.expanded = expanded ? 'true' : 'false';
        if (!expanded) {
            container.scrollLeft = 0;
        }
        icon?.classList.toggle('rotate-180', !!expanded);
        btn?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        this._syncCategoryCarouselHints();
    }

    /**
     * Toggle categories expand/collapse
     */
    toggleCategoriesExpand() {
        const container = document.getElementById('explore-category-chips');
        
        if (!container) return;
        
        const isExpanded = container.dataset.expanded === 'true';

        this._setCategoriesExpanded(!isExpanded);
    }

    /**
     * Check if category chips overflow and show/hide expand button
     */
    checkCategoriesOverflow() {
        const container = document.getElementById('explore-category-chips');
        const btn = document.getElementById('explore-toggle-categories-btn');
        
        if (!container || !btn) return;

        const hasOverflow = this._measureCollapsedCategoriesOverflow(container);
        if (hasOverflow) {
            btn.classList.remove('hidden');
            btn.classList.add('flex');
            this._syncCategoryCarouselHints();
        } else {
            this._setCategoriesExpanded(false);
            btn.classList.add('hidden');
            btn.classList.remove('flex');
        }
    }
}

// Export singleton instance
export const exploreUI = new ExploreUI();
