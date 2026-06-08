// ####################################################
// # NAMING PAGE — PLEX NAMING CONVENTION CHECKER   #
// ####################################################

// ============================================================
// NAMING PAGE — PLEX NAMING CONVENTION CHECKER (IIFE MODULE)
// ============================================================

const NamingDash = (() => {

    // --------------------------------------------------------
    // STATE
    // --------------------------------------------------------

    const state = {
        libraries: [],
        activeLibrary: null,
        activeLibraryType: null,
        allItems: [],
        items: [],
        search: '',
        quickFilters: { year: '' },
        statusFilter: 'issues',
        mismatchSubFilter: null,
        sortBy: null,
        sortDir: 'asc',
        page: 1,
        perPage: 25,
        totalItems: 0,
        totalPages: 0,
        expandedRow: null,
        stats: { total: 0, matches: 0, mismatches: 0, breakdown: {} },
        columnPickerOpen: false,
        enrichmentPolling: null,
        enrichmentProgress: null,
        episodeFormat: null,
    };

    const dataCache = {};
    let isResizing = false;
    const LS_PREFIX = 'mediadash_naming_';
    const SS_CACHE_PREFIX = 'mediadash_naming_cache_';

    // PERSIST AN ENRICHED LIBRARY ENTRY TO sessionStorage SO MOBILE TAB
    // RELOADS (BROWSER MEMORY RECLAIM) DON'T FORCE A FULL RE-FETCH/RE-DOWNLOAD
    function _persistCacheEntry(title, entry) {
        if (!entry || !entry.enriched) return;
        try {
            sessionStorage.setItem(SS_CACHE_PREFIX + title, JSON.stringify(entry));
        } catch { /* QUOTA OR PRIVATE-MODE — JUST SKIP PERSISTENCE */ }
    }

    function _evictCacheEntry(title) {
        delete dataCache[title];
        try { sessionStorage.removeItem(SS_CACHE_PREFIX + title); } catch { /* IGNORE */ }
    }

    // REHYDRATE dataCache FROM sessionStorage ON LOAD (BEFORE ANY NETWORK FETCH)
    function _hydrateCacheFromSession() {
        let key;
        try {
            for (let i = 0; i < sessionStorage.length; i++) {
                key = sessionStorage.key(i);
                if (!key || !key.startsWith(SS_CACHE_PREFIX)) continue;
                const title = key.slice(SS_CACHE_PREFIX.length);
                const entry = JSON.parse(sessionStorage.getItem(key));
                if (entry && entry.enriched) dataCache[title] = entry;
            }
        } catch { /* CORRUPT/UNAVAILABLE STORAGE — IGNORE */ }
    }

    // MAP SUB-FILTER NAME TO ITEM PROPERTY KEY
    const MISMATCH_SUB_FILTER_KEY = {
        file: 'filenameStatus',
        season: 'seasonDirStatus',
        show: 'showDirStatus',
        dir: 'dirStatus',
    };

    // --------------------------------------------------------
    // STATS COMPUTATION
    // --------------------------------------------------------

    function _computeStats(items, libraryType) {
        const total = items.length;
        const matches = items.filter(i => i.overallStatus === 'match').length;
        const mismatches = total - matches;
        const breakdown = { file: items.filter(i => i.filenameStatus === 'mismatch').length };
        if (libraryType === 'show') {
            breakdown.season = items.filter(i => i.seasonDirStatus === 'mismatch').length;
            breakdown.show = items.filter(i => i.showDirStatus === 'mismatch').length;
        } else {
            breakdown.dir = items.filter(i => i.dirStatus === 'mismatch').length;
        }
        return { total, matches, mismatches, breakdown };
    }

    // --------------------------------------------------------
    // INIT
    // --------------------------------------------------------

    async function init() {
        _hydrateCacheFromSession();
        _showLoading(true, 'Connecting to Plex...');

        try {
            const res = await api('/naming/libraries');
            state.libraries = res.libraries;
            state.episodeFormat = res.episodeFormat || 'SxxExx';

            if (state.libraries.length === 0) {
                _showError('No supported libraries found.');
                return;
            }

            _renderTabs();
            _setupEventListeners();
            await _switchLibrary(state.libraries[0].title, state.libraries[0].type);
        } catch (err) {
            _showError(err.message);
        }
    }

    function retry() {
        init();
    }

    // --------------------------------------------------------
    // EVENT LISTENERS
    // --------------------------------------------------------

    function _setupEventListeners() {
        let searchTimeout = null;
        const searchInput = document.getElementById('namingSearch');
        const searchClear = document.getElementById('namingSearchClear');

        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchClear.style.display = searchInput.value ? 'flex' : 'none';
            searchTimeout = setTimeout(() => {
                state.search = searchInput.value.trim();
                state.page = 1;
                state.expandedRow = null;
                _applyView();
            }, 350);
        });

        searchClear.addEventListener('click', () => {
            searchInput.value = '';
            searchClear.style.display = 'none';
            state.search = '';
            state.page = 1;
            state.expandedRow = null;
            _applyView();
        });

        const yearFilter = document.getElementById('qfNamingYear');
        if (yearFilter) {
            yearFilter.addEventListener('change', () => {
                state.quickFilters.year = yearFilter.value;
                yearFilter.classList.toggle('active-filter', !!yearFilter.value);
                state.page = 1;
                state.expandedRow = null;
                _applyView();
            });
        }

        document.getElementById('namingFilterAll').addEventListener('click', () => _setFilter('all'));
        document.getElementById('namingFilterIssues').addEventListener('click', () => _setFilter('issues'));
        document.getElementById('namingFilterOk').addEventListener('click', () => _setFilter('ok'));

        document.getElementById('namingLegendToggle').addEventListener('click', () => {
            const bar = document.getElementById('namingLegendBar');
            const btn = document.getElementById('namingLegendToggle');
            const isOpen = bar.classList.contains('is-open');
            bar.classList.toggle('is-open', !isOpen);
            btn.setAttribute('aria-expanded', String(!isOpen));
        });

        const pickerBtn = document.getElementById('namingColumnPickerBtn');
        const picker = document.getElementById('namingColumnPicker');

        pickerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.columnPickerOpen = !state.columnPickerOpen;
            picker.style.display = state.columnPickerOpen ? 'flex' : 'none';
            if (state.columnPickerOpen) colMgr.renderColumnPicker();
        });

        document.addEventListener('click', (e) => {
            if (state.columnPickerOpen && !picker.contains(e.target) && e.target !== pickerBtn) {
                state.columnPickerOpen = false;
                picker.style.display = 'none';
            }
        });
    }

    function _updateLegend(libraryType) {
        const movieSection = document.getElementById('legendMovies');
        const showSection = document.getElementById('legendShows');
        const epFormat = document.getElementById('legendEpFormat');
        if (movieSection) movieSection.style.display = libraryType === 'movie' ? '' : 'none';
        if (showSection) showSection.style.display = libraryType === 'show' ? '' : 'none';
        if (epFormat && state.episodeFormat) {
            const fmt = state.episodeFormat === 'SxxExx' ? 'S01E01' : '1x01';
            epFormat.textContent = `Show Name (2019) - ${fmt} - Episode Title.mkv`;
        }
    }

    function _setFilter(filter) {
        state.statusFilter = filter;
        state.mismatchSubFilter = null;
        state.page = 1;
        state.expandedRow = null;
        _updateFilterButtons();
        _applyView();
    }

    function _updateFilterButtons() {
        document.getElementById('namingFilterAll').classList.toggle('active', state.statusFilter === 'all');
        document.getElementById('namingFilterIssues').classList.toggle('active', state.statusFilter === 'issues');
        document.getElementById('namingFilterOk').classList.toggle('active', state.statusFilter === 'ok');
    }

    function _setMismatchSubFilter(sub) {
        state.mismatchSubFilter = state.mismatchSubFilter === sub ? null : sub;
        state.page = 1;
        state.expandedRow = null;
        _applyView();
    }

    // --------------------------------------------------------
    // LIBRARY SWITCHING
    // --------------------------------------------------------

    async function _switchLibrary(title, type) {
        _stopEnrichmentPolling();
        _showEnrichmentBanner(false);

        state.activeLibrary = title;
        state.activeLibraryType = type;
        state.enrichmentProgress = null;
        state.page = 1;
        state.search = '';
        state.quickFilters = { year: '' };
        const yearFilterEl = document.getElementById('qfNamingYear');
        if (yearFilterEl) { yearFilterEl.value = ''; yearFilterEl.classList.remove('active-filter'); }
        state.sortBy = null;
        state.sortDir = 'asc';
        state.expandedRow = null;
        state.statusFilter = 'issues';
        state.mismatchSubFilter = null;
        colMgr.loadColumnWidths();

        document.getElementById('namingSearch').value = '';
        document.getElementById('namingSearchClear').style.display = 'none';
        _updateTabStyles();
        _updateFilterButtons();
        _updateLegend(type);
        colMgr.loadVisibleColumns(() => _defaultDesktopCols(state.activeLibraryType));
        colMgr.loadMobileColumns();
        colMgr.loadColumnLabels();
        colMgr.loadColumnOrder();
        state.columnPickerOpen = false;
        document.getElementById('namingColumnPicker').style.display = 'none';

        if (dataCache[title] && dataCache[title].enriched) {
            state.allItems = dataCache[title].items;
            state.stats = dataCache[title].stats;
            _applyView();
        } else if (dataCache[title]) {
            state.allItems = dataCache[title].items;
            state.stats = dataCache[title].stats;
            _applyView();
            if (!dataCache[title].enriched && dataCache[title].enrichmentRunning) _startEnrichmentPolling(title);
        } else {
            await _fetchLibrary(title, type);
            _applyView();
        }
    }

    async function _fetchLibrarySilent(title, type) {
        try {
            const data = await api(`/naming/library/${encodeURIComponent(title)}`);
            dataCache[title] = {
                items: data.items,
                type: data.libraryType,
                stats: _computeStats(data.items, data.libraryType),
                enriched: data.enriched,
                enrichmentRunning: data.enrichmentRunning ?? false,
                cacheAge: data.cacheAge ?? null,
                needsSync: data.needsSync ?? false,
            };
            _persistCacheEntry(title, dataCache[title]);
            if (!data.enriched && data.enrichmentRunning) _silentEnrichmentPoll(title);
        } catch (err) {
            console.warn(`Naming preload failed for '${title}':`, err);
        }
    }

    function _silentEnrichmentPoll(title) {
        const iv = setInterval(async () => {
            try {
                const result = await api(`/naming/library/${encodeURIComponent(title)}/enrichment`);
                if (result.status === 'complete') {
                    clearInterval(iv);
                    const libType = dataCache[title]?.type;
                    dataCache[title] = {
                        items: result.items || [],
                        type: libType,
                        stats: _computeStats(result.items || [], libType),
                        enriched: true,
                        cacheAge: result.cacheAge ?? dataCache[title]?.cacheAge,
                    };
                    _persistCacheEntry(title, dataCache[title]);
                } else if (result.status === 'error') {
                    clearInterval(iv);
                }
            } catch { /* IGNORE TRANSIENT ERRORS */ }
        }, 5000);
    }

    // --------------------------------------------------------
    // TAB RENDERING
    // --------------------------------------------------------

    function _tabOrder(title) {
        const t = title.toLowerCase();
        if (t.includes('movie'))  return 0;
        if (t.includes('show'))   return 1;
        if (t.includes('anime'))  return 2;
        return 3;
    }

    function _renderTabs() {
        const bar = document.getElementById('namingTabBar');
        bar.innerHTML = '';
        for (const lib of [...state.libraries].sort((a, b) => _tabOrder(a.title) - _tabOrder(b.title))) {
            const btn = document.createElement('button');
            btn.className = 'tab-item';
            btn.dataset.title = lib.title;
            btn.dataset.type = lib.type;
            btn.innerHTML = `${escapeHTML(lib.title)} <span class="tab-count">${lib.count.toLocaleString()}</span>`;
            btn.addEventListener('click', () => _switchLibrary(lib.title, lib.type));

            const refreshBtn = document.createElement('button');
            refreshBtn.className = 'tab-refresh-btn';
            refreshBtn.type = 'button';
            refreshBtn.title = `Quick refresh "${lib.title}" from Plex`;
            refreshBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="23 4 23 10 17 10"/>
                <polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>`;
            refreshBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                _quickRefreshLibrary(lib.title, lib.type, refreshBtn);
            });
            btn.appendChild(refreshBtn);
            bar.appendChild(btn);
        }
    }

    // --------------------------------------------------------
    // PER-LIBRARY QUICK REFRESH — RE-WALKS ONE LIBRARY ONLY
    // --------------------------------------------------------

    async function _quickRefreshLibrary(title, type, btnEl) {
        if (btnEl.disabled) return;
        btnEl.disabled = true;
        btnEl.classList.add('spinning');
        try {
            const result = await api(`/api/sync/library/${encodeURIComponent(title)}`, { method: 'POST' });
            if (result.status === 'error') throw new Error(result.message || 'Failed to start refresh');
            _pollQuickRefresh(title, type, btnEl, result.key || `refresh:${title}`);
        } catch (e) {
            btnEl.disabled = false;
            btnEl.classList.remove('spinning');
            console.error('Quick refresh failed:', e);
        }
    }

    function _pollQuickRefresh(title, type, btnEl, key) {
        const iv = setInterval(async () => {
            try {
                const data = await api('/api/progress');
                const stillRunning = (data.tasks || []).some(t => t.key === key);
                if (!stillRunning) {
                    clearInterval(iv);
                    btnEl.disabled = false;
                    btnEl.classList.remove('spinning');
                    _evictCacheEntry(title);
                    if (state.activeLibrary === title) {
                        await _fetchLibrary(title, type);
                        _applyView();
                    }
                }
            } catch { /* IGNORE TRANSIENT ERRORS — KEEP POLLING */ }
        }, 3000);
    }

    function _updateTabStyles() {
        document.querySelectorAll('#namingTabBar .tab-item').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.title === state.activeLibrary);
        });
    }
    // --------------------------------------------------------
    // DATA FETCHING
    // --------------------------------------------------------

    async function _fetchLibrary(title, type) {
        if (dataCache[title] && dataCache[title].enriched) return;

        _showLoading(true, 'Analyzing file names...');
        _hideError();
        _hideEmpty();

        try {
            const url = `/naming/library/${encodeURIComponent(title)}`;
            const data = await api(url);
            const stats = _computeStats(data.items, data.libraryType);
            dataCache[title] = {
                items: data.items,
                type: data.libraryType,
                stats,
                enriched: data.enriched,
                enrichmentRunning: data.enrichmentRunning ?? false,
                cacheAge: data.cacheAge ?? null,
                needsSync: data.needsSync ?? false,
            };
            _persistCacheEntry(title, dataCache[title]);
            state.allItems = data.items;
            state.stats = stats;
            _showLoading(false);

            if (!data.enriched && data.enrichmentRunning && title === state.activeLibrary) {
                _startEnrichmentPolling(title);
            }
        } catch (err) {
            _showLoading(false);
            _showError(err.message);
        }
    }

    // --------------------------------------------------------
    // ENRICHMENT POLLING
    // --------------------------------------------------------

    function _startEnrichmentPolling(title) {
        _stopEnrichmentPolling();
        _showEnrichmentBanner(true);

        state.enrichmentPolling = setInterval(async () => {
            try {
                const result = await api(`/naming/library/${encodeURIComponent(title)}/enrichment`);

                if (result.status === 'complete') {
                    _stopEnrichmentPolling();
                    state.enrichmentProgress = null;
                    _showEnrichmentBanner(false);

                    const libType = dataCache[title]?.type;
                    const stats = _computeStats(result.items || [], libType);
                    dataCache[title] = { items: result.items || [], type: libType, stats, enriched: true, cacheAge: result.cacheAge ?? dataCache[title]?.cacheAge };
                    _persistCacheEntry(title, dataCache[title]);

                    if (state.activeLibrary === title) {
                        state.allItems = result.items || [];
                        state.stats = stats;
                        _applyView();
                        showToast('All files analyzed', 'info');
                    }
                } else if (result.status === 'error') {
                    _stopEnrichmentPolling();
                    state.enrichmentProgress = null;
                    _showEnrichmentBanner(false);
                    showToast('Background analysis failed', 'error');
                } else if (result.progress && state.activeLibrary === title) {
                    state.enrichmentProgress = result.progress;
                    _showEnrichmentBanner(true, result.progress);
                    _renderPagination();
                }
            } catch (err) {
                console.warn('Naming enrichment poll failed:', err);
            }
        }, 3000);
    }

    function _stopEnrichmentPolling() {
        if (state.enrichmentPolling) {
            clearInterval(state.enrichmentPolling);
            state.enrichmentPolling = null;
        }
    }

    function _showEnrichmentBanner(show, progress) {
        let banner = document.getElementById('namingEnrichmentBanner');

        if (show) {
            const msg = _formatEnrichmentMsg(progress, state.activeLibraryType);
            if (!banner) {
                banner = document.createElement('div');
                banner.id = 'namingEnrichmentBanner';
                banner.className = 'enrichment-banner';
                banner.innerHTML = `<div class="enrichment-spinner"></div><span>${msg}</span>`;
                const legendBar = document.getElementById('namingLegendBar');
                legendBar.insertAdjacentElement('afterend', banner);
            } else {
                banner.querySelector('span').textContent = msg;
            }
            banner.style.display = 'flex';
        } else if (banner) {
            banner.style.display = 'none';
        }
    }

    function _formatEnrichmentMsg(progress, libraryType) {
        if (progress) {
            const { current, total, step } = progress;
            if (current > 0 && total > 0) {
                return `Checking naming: ${current.toLocaleString()} / ${total.toLocaleString()} episodes`;
            }
            if (total > 0) return `Checking ${total.toLocaleString()} episodes\u2026`;
            return step || 'Analyzing episodes in the background\u2026';
        }
        return libraryType === 'movie'
            ? 'Loading remaining movies in the background\u2026'
            : 'Analyzing all episodes in the background\u2026';
    }

    // --------------------------------------------------------
    // VIEW
    // --------------------------------------------------------

    function _applyView() {
        _showLoading(false);
        _hideError();
        _hideEmpty();
        _hideAllClear();

        let data = [...state.allItems];

        // APPLY STATUS FILTER
        if (state.statusFilter === 'issues') {
            data = data.filter(i => i.overallStatus === 'mismatch');
        } else if (state.statusFilter === 'ok') {
            data = data.filter(i => i.overallStatus === 'match');
        }

        // SUB-FILTER ONLY ACTIVE WHEN VIEWING ISSUES
        if (state.statusFilter !== 'ok' && state.mismatchSubFilter) {
            const key = MISMATCH_SUB_FILTER_KEY[state.mismatchSubFilter];
            if (key) data = data.filter(i => i[key] === 'mismatch');
        }

        if (state.quickFilters.year) {
            const threshold = parseInt(state.quickFilters.year, 10);
            data = data.filter(item => item.year != null && item.year > threshold);
        }

        if (state.search) {
            const q = state.search.toLowerCase();
            data = data.filter(item => {
                for (const v of Object.values(item)) {
                    if (typeof v === 'string' && v.toLowerCase().includes(q)) return true;
                    if (typeof v === 'number' && String(v).includes(q)) return true;
                }
                return false;
            });
        }

        const total = data.length;

        if (state.sortBy && data.length > 0) {
            const reverse = state.sortDir === 'desc';
            data.sort((a, b) => {
                let cmp = compareValues(a[state.sortBy], b[state.sortBy]);
                return reverse ? -cmp : cmp;
            });
        }

        const totalPages = Math.max(1, Math.ceil(total / state.perPage));
        if (state.page > totalPages) state.page = totalPages;
        const start = (state.page - 1) * state.perPage;

        for (let i = 0; i < data.length; i++) data[i] = { ...data[i], rank: i + 1 };
        state.items = data.slice(start, start + state.perPage);
        state.totalItems = total;
        state.totalPages = totalPages;

        _renderStatsBar();

        if (state.items.length === 0) {
            _hideTable();
            if (dataCache[state.activeLibrary]?.needsSync) {
                _showEmpty('No cached data for this library yet — click Sync (top right) to load it from Plex.');
            } else if (state.statusFilter === 'ok' && !state.search) {
                _showEmpty('All items have naming issues.');
            } else if (state.statusFilter === 'issues' && !state.search && dataCache[state.activeLibrary]?.enriched) {
                _showAllClear();
            } else if (state.search || state.mismatchSubFilter) {
                _showEmpty('No results match your filters.');
            } else if (!dataCache[state.activeLibrary]?.enriched) {
                _showLoading(true, 'Analyzing episodes...');
            } else {
                _showEmpty('This library is empty.');
            }
            _renderPagination();
        } else {
            _renderTable();
            _renderPagination();
            _showTable();
        }
    }

    // --------------------------------------------------------
    // STATS BAR
    // --------------------------------------------------------

    function _renderStatsBar() {
        const bar = document.getElementById('namingStatsBar');
        const s = state.stats;

        if (s.total === 0) { bar.style.display = 'none'; return; }

        const pct = s.total > 0 ? Math.round((s.matches / s.total) * 100) : 0;

        let html = `
            <div class="stat-item"><span>Total:</span><span class="stat-value">${s.total.toLocaleString()}</span></div>
            <div class="stat-divider"></div>
            <div class="stat-item"><span>Correct:</span><span class="stat-value stat-match">${s.matches.toLocaleString()}</span></div>
            <div class="stat-divider"></div>
            <div class="stat-item"><span>Issues:</span><span class="stat-value stat-mismatch">${s.mismatches.toLocaleString()}</span></div>`;

        if (s.mismatches > 0 && s.breakdown) {
            const items = state.activeLibraryType === 'show'
                ? [
                    { key: 'file', label: 'File', count: s.breakdown.file },
                    { key: 'season', label: 'Season', count: s.breakdown.season },
                    { key: 'show', label: 'Show', count: s.breakdown.show },
                  ]
                : [
                    { key: 'file', label: 'File', count: s.breakdown.file },
                    { key: 'dir', label: 'Dir', count: s.breakdown.dir },
                  ];

            const nonZero = items.filter(i => i.count > 0);
            if (nonZero.length > 0) {
                html += '<div class="stat-divider"></div><div class="stat-breakdown">';
                for (const item of nonZero) {
                    const active = state.mismatchSubFilter === item.key ? ' active' : '';
                    html += `<button class="stat-breakdown-item${active}" data-subfilter="${item.key}">`;
                    html += `${item.label} <span class="stat-value stat-mismatch">${item.count.toLocaleString()}</span>`;
                    html += '</button>';
                }
                html += '</div>';
            }
        }

        html += `<div class="stat-divider"></div>
            <div class="stat-item"><span>Score:</span><span class="stat-value ${pct === 100 ? 'stat-match' : pct >= 80 ? '' : 'stat-mismatch'}">${pct}%</span></div>`;

        bar.style.display = 'flex';
        bar.innerHTML = html;

        bar.querySelectorAll('.stat-breakdown-item').forEach(btn => {
            btn.addEventListener('click', () => _setMismatchSubFilter(btn.dataset.subfilter));
        });
    }

    // --------------------------------------------------------
    // TABLE RENDERING
    // --------------------------------------------------------

    const SHOW_COLUMNS = [
        { key: 'rank',            label: '#',                mobileLabel: '#',       sortable: false },
        { key: 'overallStatus',   label: 'Status',           mobileLabel: 'Stat',    sortable: true  },
        { key: 'showTitle',       label: 'Show',             mobileLabel: 'Show',    sortable: true  },
        { key: 'showYear',        label: 'Year',             mobileLabel: 'Yr',      sortable: true  },
        { key: 'actualFilename',  label: 'Current Filename', mobileLabel: 'File',    sortable: true  },
        { key: 'episodeTitle',    label: 'Episode',          mobileLabel: 'Ep',      sortable: true  },
        { key: 'seasonNum',       label: 'S',                mobileLabel: 'S',       sortable: true  },
        { key: 'episodeNum',      label: 'E',                mobileLabel: 'E',       sortable: true  },
        { key: 'filenameStatus',  label: 'File',             mobileLabel: 'File',    sortable: true  },
        { key: 'showDirStatus',   label: 'Show Dir',         mobileLabel: 'SDir',    sortable: true  },
        { key: 'seasonDirStatus', label: 'Season Dir',       mobileLabel: 'SsnDir',  sortable: true  },
    ];

    const MOVIE_COLUMNS = [
        { key: 'rank',           label: '#',                mobileLabel: '#',    sortable: false },
        { key: 'overallStatus',  label: 'Status',           mobileLabel: 'Stat', sortable: true  },
        { key: 'year',           label: 'Year',             mobileLabel: 'Yr',   sortable: true  },
        { key: 'actualFilename', label: 'Current Filename', mobileLabel: 'File', sortable: true  },
        { key: 'filenameStatus', label: 'File',             mobileLabel: 'File', sortable: true  },
        { key: 'dirStatus',      label: 'Dir',              mobileLabel: 'Dir',  sortable: true  },
    ];

    function _isMobile() { return window.innerWidth <= 640; }

    // --------------------------------------------------------
    // COLUMN PREFERENCES
    // --------------------------------------------------------

    function _getActiveMasterCols() {
        return state.activeLibraryType === 'show' ? SHOW_COLUMNS : MOVIE_COLUMNS;
    }

    function _defaultDesktopCols(type) {
        return (type === 'show' ? SHOW_COLUMNS : MOVIE_COLUMNS).map(c => c.key);
    }

    function _defaultMobileCols() {
        return ['actualFilename'];
    }

    const NAMING_MOBILE_LABELS = Object.fromEntries(
        [...MOVIE_COLUMNS, ...SHOW_COLUMNS]
            .filter(c => c.mobileLabel)
            .map(c => [c.key, c.mobileLabel])
    );

    const colMgr = createColumnManager({
        lsPrefix: LS_PREFIX,
        viewKeyFn: () => state.activeLibrary,
        getMasterCols: () => _getActiveMasterCols(),
        mobileLabels: NAMING_MOBILE_LABELS,
        defaultMobileKeysFn: () => _defaultMobileCols(),
        pickerEnabled: true,
        pickerElementId: 'namingColumnPicker',
        onChange: () => _renderTable(),
    });

    function _renderTable() {
        const thead = document.getElementById('namingTableHead');
        const tbody = document.getElementById('namingTableBody');
        const table = document.getElementById('namingTable');

        const mobile = _isMobile();
        const cols = mobile
            ? (() => {
                const master = _getActiveMasterCols();
                const rank = master.find(c => c.key === 'rank');
                const rest = master.filter(c => c.key !== 'rank' && colMgr.state.mobileColumns.includes(c.key));
                return rank ? [rank, ...rest] : rest;
            })()
            : colMgr.getOrderedVisibleCols();
        table.classList.toggle('resizable', Object.keys(colMgr.state.columnWidths).length > 0);

        let headerHTML = '<tr><th class="expand-col"></th>';
        for (const col of cols) {
            const isSorted = state.sortBy === col.key;
            const sortClass = isSorted ? `sorted-${state.sortDir}` : '';
            const widthStyle = colMgr.state.columnWidths[col.key] ? `width:${colMgr.state.columnWidths[col.key]}px;` : '';
            const rankClass = col.key === 'rank' ? 'row-num-col' : '';
            headerHTML += `<th class="${sortClass} ${rankClass}" data-col="${col.key}" draggable="true" style="${widthStyle}">`;
            headerHTML += '<div class="th-content">';
            headerHTML += `<span class="th-label">${escapeHTML(colMgr.getColLabel(col, mobile))}</span>`;
            if (col.sortable) headerHTML += '<span class="sort-indicator"></span>';
            headerHTML += '</div>';
            headerHTML += `<div class="resize-handle" data-col="${col.key}"></div>`;
            headerHTML += '</th>';
        }
        headerHTML += '</tr>';
        thead.innerHTML = headerHTML;

        thead.querySelectorAll('th[data-col]').forEach(th => {
            th.addEventListener('click', (e) => {
                if (isResizing || e.target.closest('.resize-handle')) return;
                const col = th.dataset.col;
                if (state.sortBy === col) {
                    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    state.sortBy = col; state.sortDir = 'asc';
                }
                state.page = 1; state.expandedRow = null;
                _applyView();
            });
        });

        colMgr.initResizeHandles(thead, 'namingTable', (resizing) => { isResizing = resizing; });
        colMgr.initColumnDrag(thead);

        let bodyHTML = '';
        for (let i = 0; i < state.items.length; i++) {
            const item = state.items[i];
            const isExpanded = state.expandedRow === i;
            bodyHTML += `<tr class="data-row ${isExpanded ? 'expanded' : ''}" data-index="${i}">`;
            bodyHTML += `<td class="expand-col"><span class="expand-icon">${isExpanded ? '\u25BC' : '\u25B6'}</span></td>`;
            for (const col of cols) {
                const rankClass = col.key === 'rank' ? ' class="row-num-col"' : '';
                bodyHTML += `<td${rankClass} data-col="${col.key}">${_formatCell(col.key, item[col.key], item)}</td>`;
            }
            bodyHTML += '</tr>';

            if (!mobile && isExpanded) {
                bodyHTML += `<tr class="detail-row"><td colspan="${cols.length + 1}">`;
                bodyHTML += _renderDetail(item, state.activeLibraryType);
                bodyHTML += '</td></tr>';
            }
        }
        tbody.innerHTML = bodyHTML;

        tbody.querySelectorAll('.data-row').forEach(row => {
            row.addEventListener('click', () => {
                const idx = parseInt(row.dataset.index);
                const item = state.items[idx];
                if (mobile) {
                    _openMobilePanel(item);
                    return;
                }
                state.expandedRow = state.expandedRow === idx ? null : idx;
                _renderTable();
            });
        });
    }

    // CELL FORMATTING
    // --------------------------------------------------------

    function _formatCell(key, value, item) {
        if (value === null || value === undefined) return '<span class="text-muted">-</span>';

        switch (key) {
            case 'rank':
                return `<span class="row-num text-muted">${value}</span>`;

            case 'overallStatus':
                if (value === 'match') return '<span class="badge badge-success"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>';
                return '<span class="badge badge-error"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></span>';

            case 'filenameStatus':
            case 'dirStatus':
            case 'seasonDirStatus':
            case 'showDirStatus':
                if (value === 'match') return '<span class="badge badge-success"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>';
                return '<span class="badge badge-error"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></span>';

            case 'showTitle':
                return `<span title="${escapeHTML(String(value))}">${escapeHTML(truncate(String(value), 35))}</span>`;

            case 'actualFilename':
            case 'expectedFilename':
                return `<span title="${escapeHTML(String(value))}">${escapeHTML(String(value))}</span>`;

            default:
                return escapeHTML(String(value));
        }
    }

    // --------------------------------------------------------
    // DETAIL ROW
    // --------------------------------------------------------

    function _renderDetail(item, libraryType) {
        let html = '<div class="detail-content">';
        if (libraryType === 'movie') {
            html += _renderMovieDetail(item);
        } else {
            html += _renderEpisodeDetail(item);
        }
        html += '</div>';
        return html;
    }

    function _renderMovieDetail(item) {
        let html = '<div class="naming-comparison">';

        html += '<div class="detail-section"><h4>Filename</h4>';
        html += '<div class="naming-row"><span class="naming-label">Current</span>';
        html += `<div class="naming-value actual ${item.filenameStatus}">${escapeHTML(item.actualFilename)}</div></div>`;
        html += '<div class="naming-row"><span class="naming-label">Expected</span>';
        html += `<div class="naming-value expected ${item.filenameStatus}">${escapeHTML(item.expectedFilename)}</div></div>`;
        html += '</div>';

        html += '<div class="detail-section"><h4>Directory</h4>';
        html += '<div class="naming-row"><span class="naming-label">Current</span>';
        html += `<div class="naming-value actual ${item.dirStatus}">${escapeHTML(item.actualDir)}</div></div>`;
        html += '<div class="naming-row"><span class="naming-label">Expected</span>';
        html += `<div class="naming-value expected ${item.dirStatus}">${escapeHTML(item.expectedDir)}</div></div>`;
        html += '</div>';

        if (item.filePath) {
            html += `<div class="detail-section"><h4>Full Path</h4><div class="full-path">${escapeHTML(item.filePath)}</div></div>`;
        }

        if (item.subtitleLanguages) {
            html += `<div class="detail-section"><h4>Subtitles</h4><div class="full-path">${escapeHTML(item.subtitleLanguages)}</div></div>`;
        }

        html += '</div>';
        return html;
    }

    function _renderEpisodeDetail(item) {
        let html = '<div class="naming-comparison">';

        html += '<div class="detail-section"><h4>Filename</h4>';
        html += '<div class="naming-row"><span class="naming-label">Current</span>';
        html += `<div class="naming-value actual ${item.filenameStatus}">${escapeHTML(item.actualFilename)}</div></div>`;
        html += '<div class="naming-row"><span class="naming-label">Expected</span>';
        html += `<div class="naming-value expected ${item.filenameStatus}">${escapeHTML(item.expectedFilename)}</div></div>`;
        html += '</div>';

        html += '<div class="detail-section"><h4>Season Directory</h4>';
        html += '<div class="naming-row"><span class="naming-label">Current</span>';
        html += `<div class="naming-value actual ${item.seasonDirStatus}">${escapeHTML(item.actualSeasonDir)}</div></div>`;
        html += '<div class="naming-row"><span class="naming-label">Expected</span>';
        html += `<div class="naming-value expected ${item.seasonDirStatus}">${escapeHTML(item.expectedSeasonDir)}</div></div>`;
        html += '</div>';

        html += '<div class="detail-section"><h4>Show Directory</h4>';
        html += '<div class="naming-row"><span class="naming-label">Current</span>';
        html += `<div class="naming-value actual ${item.showDirStatus}">${escapeHTML(item.actualShowDir)}</div></div>`;
        html += '<div class="naming-row"><span class="naming-label">Expected</span>';
        html += `<div class="naming-value expected ${item.showDirStatus}">${escapeHTML(item.expectedShowDir)}</div></div>`;
        html += '</div>';

        if (item.filePath) {
            html += `<div class="detail-section"><h4>Full Path</h4><div class="full-path">${escapeHTML(item.filePath)}</div></div>`;
        }

        html += '</div>';
        return html;
    }

    // --------------------------------------------------------
    // MOBILE DETAIL PANEL
    // --------------------------------------------------------

    function _openMobilePanel(item) {
        const panel = document.getElementById('mobileDetailPanel');
        if (!panel || !item) return;

        if (panel.classList.contains('open')) _closeMobilePanel();

        document.getElementById('mobilePanelTitle').textContent = _mobilePanelTitle(item);

        const metaParts = _mobilePanelMeta(item);
        document.getElementById('mobilePanelMeta').innerHTML = metaParts
            .map(p => `<span>${escapeHTML(p)}</span>`)
            .join('<span style="color:var(--border-light)">·</span>');

        document.getElementById('mobilePanelBody').innerHTML = _buildMobilePanelContent(item);

        panel.classList.add('open');
        document.body.style.overflow = 'hidden';

        document.getElementById('mobilePanelBackdrop').onclick = _closeMobilePanel;
        document.getElementById('mobilePanelClose').onclick = _closeMobilePanel;

        // SWIPE-TO-CLOSE: SAME BOTTOM-SHEET FEEL AS SEARCH
        const sheet = document.getElementById('mobilePanelSheet');
        const body  = document.getElementById('mobilePanelBody');
        let startY = 0, dragActive = false, isClosing = false;

        function onTouchStart(e) {
            startY     = e.touches[0].clientY;
            dragActive = false;
            isClosing  = false;
        }

        function onTouchMove(e) {
            if (isClosing) return;
            const dy = e.touches[0].clientY - startY;
            if (!dragActive) {
                if (dy <= 0) return;
                if (body && body.scrollTop > 0) return;
                dragActive = true;
                sheet.style.transition = 'none';
            }
            e.preventDefault();
            sheet.style.transform = `translateY(${Math.max(0, dy)}px)`;
        }

        function onTouchEnd(e) {
            if (!dragActive || isClosing) return;
            const dy = e.changedTouches[0].clientY - startY;
            if (dy > 120) {
                isClosing = true;
                sheet.style.transition = 'transform 0.25s cubic-bezier(0.4, 0, 1, 1)';
                sheet.style.transform  = 'translateY(100%)';
                setTimeout(_closeMobilePanel, 250);
            } else {
                sheet.style.transition = 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)';
                sheet.style.transform  = '';
                dragActive = false;
            }
        }

        sheet.addEventListener('touchstart', onTouchStart, { passive: true });
        sheet.addEventListener('touchmove',  onTouchMove,  { passive: false });
        sheet.addEventListener('touchend',   onTouchEnd,   { passive: true });

        panel._removeSwipeListeners = () => {
            sheet.removeEventListener('touchstart', onTouchStart);
            sheet.removeEventListener('touchmove',  onTouchMove);
            sheet.removeEventListener('touchend',   onTouchEnd);
            sheet.style.transform  = '';
            sheet.style.transition = '';
        };
    }

    function _closeMobilePanel() {
        const panel = document.getElementById('mobileDetailPanel');
        if (!panel) return;
        if (panel._removeSwipeListeners) {
            panel._removeSwipeListeners();
            panel._removeSwipeListeners = null;
        }
        panel.classList.remove('open');
        document.body.style.overflow = '';
    }

    function _mobilePanelTitle(item) {
        if (state.activeLibraryType === 'movie') return item.actualFilename || item.expectedFilename || 'Movie Naming';
        return item.showTitle || item.actualFilename || 'Episode Naming';
    }

    function _mobilePanelMeta(item) {
        if (state.activeLibraryType === 'movie') {
            return [
                item.year,
                item.overallStatus === 'match' ? 'OK' : 'Issue',
                item.filenameStatus === 'mismatch' ? 'File mismatch' : null,
                item.dirStatus === 'mismatch' ? 'Dir mismatch' : null,
            ].filter(v => v != null && v !== '');
        }
        return [
            item.showYear,
            item.seasonNum != null ? `S${String(item.seasonNum).padStart(2, '0')}` : null,
            item.episodeNum != null ? `E${String(item.episodeNum).padStart(2, '0')}` : null,
            item.overallStatus === 'match' ? 'OK' : 'Issue',
        ].filter(v => v != null && v !== '');
    }

    function _buildMobilePanelContent(item) {
        const e = escapeHTML;
        const val = v => (v != null && v !== '') ? e(String(v)) : '<span class="text-muted">—</span>';
        const panelItem = (label, value, status = '') =>
            `<div class="mobile-panel-item"><span class="label">${e(label)}</span><span class="value ${e(status)}">${val(value)}</span></div>`;
        const section = (title, inner) => `<div class="mobile-panel-section"><div class="mobile-panel-section-title">${e(title)}</div>${inner}</div>`;
        const grid = pairs => `<div class="mobile-panel-grid">${pairs.map(([l, v, s]) => panelItem(l, v, s)).join('')}</div>`;
        const pathBlock = value => `<p style="font-family:monospace;font-size:0.72rem;color:var(--text-muted);word-break:break-all;line-height:1.5;">${e(value)}</p>`;

        let html = '';

        if (state.activeLibraryType === 'movie') {
            html += section('Filename', grid([
                ['Current',  item.actualFilename, item.filenameStatus],
                ['Expected', item.expectedFilename, item.filenameStatus],
            ]));

            html += section('Directory', grid([
                ['Current',  item.actualDir, item.dirStatus],
                ['Expected', item.expectedDir, item.dirStatus],
            ]));

            const details = [
                ['File Status', item.filenameStatus],
                ['Directory Status', item.dirStatus],
                ['Overall', item.overallStatus],
                ['Subtitles', item.subtitleLanguages],
            ].filter(([, v]) => v != null && v !== '');
            if (details.length) html += section('Details', grid(details));
        } else {
            const episodeDetails = [
                ['Show', item.showTitle],
                ['Episode', item.episodeTitle],
                ['Season', item.seasonNum],
                ['Episode #', item.episodeNum],
                ['Overall', item.overallStatus],
            ].filter(([, v]) => v != null && v !== '');
            if (episodeDetails.length) html += section('Episode Details', grid(episodeDetails));

            html += section('Filename', grid([
                ['Current',  item.actualFilename, item.filenameStatus],
                ['Expected', item.expectedFilename, item.filenameStatus],
            ]));

            html += section('Season Directory', grid([
                ['Current',  item.actualSeasonDir, item.seasonDirStatus],
                ['Expected', item.expectedSeasonDir, item.seasonDirStatus],
            ]));

            html += section('Show Directory', grid([
                ['Current',  item.actualShowDir, item.showDirStatus],
                ['Expected', item.expectedShowDir, item.showDirStatus],
            ]));
        }

        if (item.filePath) {
            html += section('Full Path', pathBlock(item.filePath));
        }

        return html;
    }

    // --------------------------------------------------------
    // PAGINATION
    // --------------------------------------------------------

    function _renderPagination() {
        const bar = document.getElementById('namingPaginationBar');
        if (state.totalItems === 0) { bar.style.display = 'none'; return; }

        bar.style.display = 'flex';
        const typeLabel = state.activeLibraryType === 'movie' ? 'movies' : 'episodes';
        const start = (state.page - 1) * state.perPage + 1;
        const end = Math.min(state.page * state.perPage, state.totalItems);

        const isPartial = dataCache[state.activeLibrary] && !dataCache[state.activeLibrary].enriched;
        let syncInfo = '';
        if (isPartial) {
            const p = state.enrichmentProgress;
            if (p && p.current > 0 && p.total > 0) {
                syncInfo = ` \u00B7 <span class="badge badge-info">Checking: ${p.current.toLocaleString()} / ${p.total.toLocaleString()} episodes</span>`;
            } else if (p && p.step) {
                syncInfo = ` \u00B7 <span class="badge badge-info">${escapeHTML(p.step)}</span>`;
            } else {
                syncInfo = ` \u00B7 <span class="badge badge-info">Analyzing episodes\u2026</span>`;
            }
        }
        bar.innerHTML = `
            <div class="pagination-info">${start.toLocaleString()}-${end.toLocaleString()} of ${state.totalItems.toLocaleString()} ${typeLabel}${syncInfo}</div>
            <div class="pagination-controls">
                <button class="btn btn-sm" id="namingPrevPage" ${state.page <= 1 ? 'disabled' : ''}>\u2190 Previous</button>
                <span class="page-indicator">Page ${state.page} of ${state.totalPages || 1}</span>
                <button class="btn btn-sm" id="namingNextPage" ${state.page >= state.totalPages ? 'disabled' : ''}>Next \u2192</button>
            </div>
        `;

        document.getElementById('namingPrevPage').addEventListener('click', () => {
            if (state.page > 1) { state.page--; state.expandedRow = null; _applyView(); }
        });
        document.getElementById('namingNextPage').addEventListener('click', () => {
            if (state.page < state.totalPages) { state.page++; state.expandedRow = null; _applyView(); }
        });
    }

    // --------------------------------------------------------
    // UI STATE HELPERS
    // --------------------------------------------------------

    function _showLoading(show, message) {
        const el = document.getElementById('namingLoading');
        el.style.display = show ? 'flex' : 'none';
        if (show && message) el.querySelector('.state-text').textContent = message;
        if (show) _hideTable();
    }

    function _showError(message) {
        document.getElementById('namingError').style.display = 'flex';
        document.getElementById('namingErrorMsg').textContent = message;
        _hideTable();
        document.getElementById('namingPaginationBar').style.display = 'none';
    }

    function _hideError() { document.getElementById('namingError').style.display = 'none'; }

    function _showEmpty(message) {
        document.getElementById('namingEmpty').style.display = 'flex';
        document.getElementById('namingEmptyMsg').textContent = message;
    }

    function _hideEmpty() { document.getElementById('namingEmpty').style.display = 'none'; }

    function _showAllClear() {
        const el = document.getElementById('namingAllClear');
        const sub = document.getElementById('namingAllClearSub');
        const total = state.stats.total;
        const typeLabel = state.activeLibraryType === 'movie' ? 'movie' : 'episode';
        const plural = total === 1 ? typeLabel : typeLabel + 's';
        sub.textContent = `Every ${total.toLocaleString()} ${plural} in ${state.activeLibrary} is correctly named`;
        el.style.display = 'flex';
    }

    function _hideAllClear() { document.getElementById('namingAllClear').style.display = 'none'; }

    function _showTable() { document.getElementById('namingTableWrapper').style.display = 'block'; }
    function _hideTable() { document.getElementById('namingTableWrapper').style.display = 'none'; }

    // --------------------------------------------------------
    // PUBLIC API
    // --------------------------------------------------------

    function invalidateCache() {
        for (const key of Object.keys(dataCache)) _evictCacheEntry(key);
        _stopEnrichmentPolling();
    }

    async function refreshActive() {
        if (state.activeLibrary) {
            _evictCacheEntry(state.activeLibrary);
            await _fetchLibrary(state.activeLibrary, state.activeLibraryType);
            _applyView();
        }
    }

    return { init, retry, invalidateCache, refreshActive };
})();
