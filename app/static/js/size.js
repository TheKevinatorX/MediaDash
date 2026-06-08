// ############################################
// # SIZE PAGE — FILE SIZE ANALYSIS          #
// ############################################

// ============================================================
// SIZE PAGE — FILE SIZE ANALYSIS (IIFE MODULE)
// ============================================================

const SizeDash = (() => {

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
        quickFilters: { criticRating: '', audienceRating: '', year: '', subtitles: '' },
        sortBy: null,
        sortDir: 'desc',
        page: 1,
        perPage: 25,
        totalItems: 0,
        totalPages: 0,
        loading: false,
        expandedRow: null,
        columnFilters: {},
        columnPickerOpen: false,
        enrichmentPolling: null,
        viewMode: 'shows',   // 'shows' | 'seasons'
        enrichmentProgress: null,
        seasonAnalysisPolling: null,
    };

    const dataCache = {};
    let isResizing = false;

    // PENDING FILTER — SET BY navigateWithFilter(), CONSUMED ONCE BY _switchLibrary()
    let _pendingFilter = null;

    // --------------------------------------------------------
    // COLUMN DEFINITIONS
    // --------------------------------------------------------

    function _isMobile() { return window.innerWidth <= 640; }

    const MOVIE_COLS = [
        { key: 'rank',              label: '#',        mobileLabel: '#',     sortable: false },
        { key: 'title',             label: 'Title',    mobileLabel: 'Title', sortable: true  },
        { key: 'fileSizeFormatted', label: 'Size',     mobileLabel: 'Size',  sortable: true,  sortKey: 'fileSize'  },
        { key: 'resolution',        label: 'Res',      mobileLabel: 'Res',   sortable: true  },
        { key: 'videoCodec',        label: 'Codec',    mobileLabel: 'Codec', sortable: true  },
        { key: 'container',         label: 'EXT',      mobileLabel: 'EXT',   sortable: true  },
        { key: 'durationFormatted', label: 'Duration', mobileLabel: 'Dur',   sortable: false },
        { key: 'year',              label: 'Year',     mobileLabel: 'Yr',    sortable: true  },
    ];

    const MOVIE_MOBILE_COLS = [
        { key: 'rank',              label: '#',    sortable: false },
        { key: 'title',             label: 'Title', sortable: true  },
        { key: 'year',              label: 'Year',  sortable: true  },
        { key: 'fileSizeFormatted', label: 'Size',  sortable: true, sortKey: 'fileSize' },
        { key: 'resolution',        label: 'Res',   sortable: true  },
    ];

    const SHOW_COLS = [
        { key: 'rank',                   label: '#',        mobileLabel: '#',     sortable: false },
        { key: 'title',                  label: 'Title',    mobileLabel: 'Title', sortable: true  },
        { key: 'totalSizeFormatted',     label: 'Size',     mobileLabel: 'Size',  sortable: true,  sortKey: 'totalSize' },
        { key: 'dominantResolution',     label: 'Res',      mobileLabel: 'Res',   sortable: true  },
        { key: 'seasons',                label: 'S',        mobileLabel: 'S',     sortable: true  },
        { key: 'episodes',               label: 'E',        mobileLabel: 'E',     sortable: true  },
        { key: 'totalDurationFormatted', label: 'Duration', mobileLabel: 'Dur',   sortable: false },
        { key: 'year',                   label: 'Year',     mobileLabel: 'Yr',    sortable: true  },
        { key: 'showStatus',             label: 'Status',   mobileLabel: 'Stat',  sortable: true  },
    ];

    const SHOW_MOBILE_COLS = [
        { key: 'rank',               label: '#',    sortable: false },
        { key: 'title',              label: 'Title', sortable: true  },
        { key: 'year',               label: 'Year',  sortable: true  },
        { key: 'totalSizeFormatted', label: 'Size',  sortable: true, sortKey: 'totalSize' },
        { key: 'dominantResolution', label: 'Res',   sortable: true  },
    ];

    const SEASON_COLS = [
        { key: 'rank',               label: '#',        mobileLabel: '#',    sortable: false },
        { key: 'showTitle',          label: 'Show',     mobileLabel: 'Show', sortable: true  },
        { key: 'name',               label: 'Season',   mobileLabel: 'Ssn',  sortable: true  },
        { key: 'sizeFormatted',      label: 'Size',     mobileLabel: 'Size', sortable: true,  sortKey: 'size' },
        { key: 'episodeCount',       label: 'Ep',       mobileLabel: 'Ep',   sortable: true  },
        { key: 'dominantResolution', label: 'Res',      mobileLabel: 'Res',  sortable: true  },
        { key: 'durationFormatted',  label: 'Duration', mobileLabel: 'Dur',  sortable: false },
        { key: 'library',            label: 'Library',  mobileLabel: 'Lib',  sortable: true  },
        { key: 'year',               label: 'Year',     mobileLabel: 'Yr',   sortable: true  },
    ];

    const SEASON_MOBILE_COLS = [
        { key: 'rank',               label: '#',   sortable: false },
        { key: 'showTitle',          label: 'Show', sortable: true  },
        { key: 'sizeFormatted',      label: 'Size', sortable: true, sortKey: 'size' },
        { key: 'episodeCount',       label: 'Ep',   sortable: true  },
        { key: 'dominantResolution', label: 'Res',  sortable: true  },
    ];

    // --------------------------------------------------------
    // BLOAT DETECTION
    // --------------------------------------------------------

    const BLOAT_GB = 1024 ** 3;
    const MOVIE_HD_LIMIT_GB = 4;   // flag HD movies over 4 GB
    const MOVIE_4K_LIMIT_GB = 5;   // flag 4K movies over 5 GB
    const SHOW_BLOAT_SIGMA = 1.5;  // std deviations above mean to flag a show/season

    function _is4KRes(res) {
        const v = String(res || '').toLowerCase();
        return v === '4k' || v === '2160';
    }

    function _resLabel(res) {
        const v = String(res || '').toLowerCase();
        if (v === '4k' || v === '2160') return '4K';
        if (v === '1080' || v === '1080p') return '1080p';
        if (v === '720' || v === '720p') return '720p';
        if (v === '480' || v === 'sd') return 'SD';
        return res || '?';
    }

    function _isMovieBloated(item) {
        const bytes = item.fileSize || 0;
        const limitGB = _is4KRes(item.resolution) ? MOVIE_4K_LIMIT_GB : MOVIE_HD_LIMIT_GB;
        return bytes > limitGB * BLOAT_GB;
    }

    function _movieBloatData(item) {
        const bytes = item.fileSize || 0;
        const is4K = _is4KRes(item.resolution);
        const limitGB = is4K ? MOVIE_4K_LIMIT_GB : MOVIE_HD_LIMIT_GB;
        const gb = bytes / BLOAT_GB;
        return {
            type: 'movie',
            gb,
            limitGB,
            res: _resLabel(item.resolution),
            tag: `${gb.toFixed(1)} GB`,
            severity: 'error',
        };
    }

    function _computeShowStats(shows) {
        const groups = {};
        for (const show of shows) {
            if (!show.episodes || show.episodes < 1 || !show.totalSize) continue;
            const res = String(show.dominantResolution || 'unknown').toLowerCase();
            if (!groups[res]) groups[res] = [];
            groups[res].push(show.totalSize / show.episodes);
        }
        const stats = {};
        for (const [res, sizes] of Object.entries(groups)) {
            const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
            const variance = sizes.length > 1
                ? sizes.reduce((a, b) => a + (b - mean) ** 2, 0) / sizes.length
                : 0;
            stats[res] = { mean, std: Math.sqrt(variance), count: sizes.length };
        }
        return stats;
    }

    function _isShowBloated(item, stats) {
        if (!item.episodes || item.episodes < 1 || !item.totalSize) return false;
        const res = String(item.dominantResolution || 'unknown').toLowerCase();
        const s = stats[res];
        if (!s || s.count < 3 || s.std === 0) return false;
        return (item.totalSize / item.episodes) > (s.mean + SHOW_BLOAT_SIGMA * s.std);
    }

    function _showBloatData(item, stats) {
        const res = String(item.dominantResolution || 'unknown').toLowerCase();
        const s = stats[res];
        const sizePerEp = item.totalSize / item.episodes;
        const ratio = sizePerEp / s.mean;
        return {
            type: 'show',
            sizePerEpGB: sizePerEp / BLOAT_GB,
            avgGB: s.mean / BLOAT_GB,
            ratio,
            res: _resLabel(item.dominantResolution),
            tag: `${ratio.toFixed(1)}× avg/ep`,
            severity: ratio >= 2 ? 'error' : 'warning',
        };
    }

    function _computeSeasonStats(seasons) {
        const groups = {};
        for (const s of seasons) {
            if (!s.episodeCount || s.episodeCount < 1 || !s.size) continue;
            const res = String(s.dominantResolution || 'unknown').toLowerCase();
            if (!groups[res]) groups[res] = [];
            groups[res].push(s.size / s.episodeCount);
        }
        const stats = {};
        for (const [res, sizes] of Object.entries(groups)) {
            const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
            const variance = sizes.length > 1
                ? sizes.reduce((a, b) => a + (b - mean) ** 2, 0) / sizes.length
                : 0;
            stats[res] = { mean, std: Math.sqrt(variance), count: sizes.length };
        }
        return stats;
    }

    function _isSeasonBloated(season, stats) {
        if (!season.episodeCount || season.episodeCount < 1 || !season.size) return false;
        const res = String(season.dominantResolution || 'unknown').toLowerCase();
        const s = stats[res];
        if (!s || s.count < 3 || s.std === 0) return false;
        return (season.size / season.episodeCount) > (s.mean + SHOW_BLOAT_SIGMA * s.std);
    }

    function _seasonBloatData(season, stats) {
        const res = String(season.dominantResolution || 'unknown').toLowerCase();
        const s = stats[res];
        const sizePerEp = season.size / season.episodeCount;
        const ratio = sizePerEp / s.mean;
        return {
            type: 'show',
            sizePerEpGB: sizePerEp / BLOAT_GB,
            avgGB: s.mean / BLOAT_GB,
            ratio,
            res: _resLabel(season.dominantResolution),
            tag: `${ratio.toFixed(1)}× avg/ep`,
            severity: ratio >= 2 ? 'error' : 'warning',
        };
    }


    function _renderBloatDetail(item) {
        const b = item._bloat;
        if (!b) return '';
        let html = '<div class="detail-section"><h4>Bloat Analysis</h4><div class="detail-grid">';
        if (b.type === 'movie') {
            html += _detailItem('File Size', `${b.gb.toFixed(2)} GB`);
            html += _detailItem(`Limit (${b.res})`, `${b.limitGB} GB`);
            html += _detailItem('Over Limit', `+${(b.gb - b.limitGB).toFixed(2)} GB`);
        } else {
            html += _detailItem('Size / Episode', `${b.sizePerEpGB.toFixed(2)} GB`);
            html += _detailItem(`Avg (${b.res})`, `${b.avgGB.toFixed(2)} GB/ep`);
            html += _detailItem('Ratio', `${b.ratio.toFixed(2)}× average`);
        }
        html += '</div></div>';
        return html;
    }

    function _buildSeasonItems() {
        const seasons = [];
        for (const [libTitle, cached] of Object.entries(dataCache)) {
            if (cached.type !== 'show') continue;
            for (const show of cached.items) {
                if (!show.seasonSizes || show.seasonSizes.length === 0) continue;
                for (const season of show.seasonSizes) {
                    seasons.push({
                        _isSeason: true,
                        showTitle: show.title,
                        library: libTitle,
                        name: season.name,
                        size: season.size || 0,
                        sizeFormatted: season.sizeFormatted || '-',
                        episodeCount: season.episodeCount || 0,
                        dominantResolution: season.dominantResolution || null,
                        duration: season.duration || 0,
                        durationFormatted: season.durationFormatted || '-',
                        year: show.year || null,
                    });
                }
            }
        }
        return seasons
            .sort((a, b) => b.size - a.size)
            .map((s, i) => ({ ...s, rank: i + 1 }));
    }

    // --------------------------------------------------------
    // INIT
    // --------------------------------------------------------

    async function init() {
        _showLoading(true, 'Connecting to Plex...');

        try {
            const res = await api('/size/libraries');
            state.libraries = res.libraries;

            if (state.libraries.length === 0) {
                _showError('No supported libraries found.');
                return;
            }

            _renderTabs();
            _setupEventListeners();
            await _switchLibrary(state.libraries[0].title, state.libraries[0].type);
            // SILENTLY PRE-WARM ALL SHOW LIBRARIES SO THE SEASONS TAB IS READY
            _prefetchShowLibraries();
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

    const QF_IDS = {
        criticRating: 'qfSizeCriticRating',
        audienceRating: 'qfSizeAudienceRating',
        year: 'qfSizeYear',
        subtitles: 'qfSizeSubtitles',
    };

    function _resetQuickFilters() {
        state.quickFilters = { criticRating: '', audienceRating: '', year: '', subtitles: '' };
        for (const id of Object.values(QF_IDS)) {
            const el = document.getElementById(id);
            if (el) { el.value = ''; el.classList.remove('active-filter'); }
        }
    }

    // APPLY A FILTERSPEC (picklist/text/quick/function) TO STATE + UI — SHARED BY navigateWithFilter + _switchLibrary
    function _applyFilterSpec(filterType, filterKey, filterValue) {
        switch (filterType) {
            case 'picklist':
                state.columnFilters[filterKey] = new Set([filterValue]);
                break;
            case 'text':
            case 'function':
                state.columnFilters[filterKey] = filterValue;
                break;
            case 'quick': {
                state.quickFilters[filterKey] = filterValue;
                const el = document.getElementById(QF_IDS[filterKey]);
                if (el) { el.value = filterValue; el.classList.add('active-filter'); }
                break;
            }
        }
    }

    // --------------------------------------------------------
    // COLUMN-HEADER FILTER DROPDOWNS
    // --------------------------------------------------------

    const FILTER_PLACEHOLDERS = {
        title: 'Search title...', year: '4-digit year...', rating: 'e.g. 7.5',
        resolution: 'e.g. 1080, 4k', fileSizeFormatted: 'e.g. 5.0 GB',
        genres: 'Type a genre...', studio: 'Type a studio...', contentRating: 'e.g. PG-13, R',
        videoCodec: 'e.g. h264, hevc', audioCodec: 'e.g. aac, ac3',
        watchStatus: 'Watched, Unwatched...', showStatus: 'Returning, Airing...',
        seasons: 'Number of seasons...',
        episodes: 'Number of episodes...', totalSizeFormatted: 'e.g. 50.0 GB',
    };

    const PICKLIST_CANDIDATE_KEYS = new Set([
        'resolution', 'dominantResolution', 'watchStatus', 'contentRating',
        'container', 'videoCodec', 'audioCodec', 'showStatus',
    ]);

    function _getPicklistOptions(colKey) {
        const cached = dataCache[state.activeLibrary];
        if (!cached) return null;
        const values = new Set();
        for (const item of cached.items) {
            const v = item[colKey];
            if (v != null && v !== '') values.add(String(v));
        }
        if (values.size < 2 || values.size > 9) return null;
        return [...values].sort();
    }

    function _toggleColumnFilter(btnEl, colKey) {
        document.querySelectorAll('.col-filter-dropdown').forEach(d => d.remove());

        const picklistOptions = PICKLIST_CANDIDATE_KEYS.has(colKey) ? _getPicklistOptions(colKey) : null;

        const dropdown = document.createElement('div');
        dropdown.className = 'col-filter-dropdown';

        const th = btnEl.closest('th');
        const rect = th.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.top = `${rect.bottom + 4}px`;
        dropdown.style.left = `${rect.left}px`;
        dropdown.style.minWidth = `${Math.max(rect.width, 150)}px`;

        if (picklistOptions) {
            const currentSet = (state.columnFilters[colKey] instanceof Set) ? state.columnFilters[colKey] : new Set();
            let optionsHTML = '';
            for (const opt of picklistOptions) {
                const checked = currentSet.has(opt) ? 'checked' : '';
                optionsHTML += `<label class="col-filter-option"><input type="checkbox" value="${escapeHTML(opt)}" ${checked}><span>${escapeHTML(opt)}</span></label>`;
            }
            dropdown.innerHTML = `
                <div class="col-filter-header">
                    <span>Filter</span>
                    <button class="col-filter-clear-btn" title="Clear">&times;</button>
                </div>
                <div class="col-filter-picklist">${optionsHTML}</div>
            `;

            document.body.appendChild(dropdown);

            dropdown.querySelectorAll('.col-filter-option input').forEach(cb => {
                cb.addEventListener('change', () => {
                    const selected = new Set(
                        [...dropdown.querySelectorAll('.col-filter-option input:checked')].map(i => i.value)
                    );
                    if (selected.size > 0) state.columnFilters[colKey] = selected;
                    else delete state.columnFilters[colKey];
                    state.page = 1;
                    state.expandedRow = null;
                    _applyView();
                });
            });
        } else {
            const current = (typeof state.columnFilters[colKey] === 'string') ? state.columnFilters[colKey] : '';
            const placeholder = FILTER_PLACEHOLDERS[colKey] || 'Type to filter...';
            dropdown.innerHTML = `
                <div class="col-filter-header">
                    <span>Filter</span>
                    <button class="col-filter-clear-btn" title="Clear">&times;</button>
                </div>
                <input type="text" class="col-filter-input" placeholder="${escapeHTML(placeholder)}" value="${escapeHTML(current)}" autofocus>
            `;

            document.body.appendChild(dropdown);

            const input = dropdown.querySelector('.col-filter-input');
            setTimeout(() => input.focus(), 0);

            let filterTimeout = null;
            input.addEventListener('input', () => {
                clearTimeout(filterTimeout);
                filterTimeout = setTimeout(() => {
                    const val = input.value.trim();
                    if (val) state.columnFilters[colKey] = val;
                    else delete state.columnFilters[colKey];
                    state.page = 1; state.expandedRow = null;
                    _applyView();
                }, 200);
            });

            input.addEventListener('keydown', e => { if (e.key === 'Escape') dropdown.remove(); });
        }

        dropdown.querySelector('.col-filter-clear-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            delete state.columnFilters[colKey];
            dropdown.remove();
            state.page = 1; state.expandedRow = null;
            _applyView();
        });

        dropdown.addEventListener('click', e => e.stopPropagation());
    }

    function _setupEventListeners() {
        let searchTimeout = null;
        const searchInput = document.getElementById('sizeSearch');
        const searchClear = document.getElementById('sizeSearchClear');

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

        // QUICK FILTER DROPDOWNS
        for (const [key, elId] of Object.entries(QF_IDS)) {
            const el = document.getElementById(elId);
            if (!el) continue;
            el.addEventListener('change', () => {
                state.quickFilters[key] = el.value;
                el.classList.toggle('active-filter', !!el.value);
                state.page = 1;
                state.expandedRow = null;
                _applyView();
            });
        }

        document.getElementById('sizePerPage').addEventListener('change', (e) => {
            state.perPage = parseInt(e.target.value);
            state.page = 1;
            state.expandedRow = null;
            _applyView();
        });

        const sizePickerBtn = document.getElementById('sizeColumnPickerBtn');
        const sizePicker = document.getElementById('sizeColumnPicker');

        sizePickerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.columnPickerOpen = !state.columnPickerOpen;
            sizePicker.style.display = state.columnPickerOpen ? 'flex' : 'none';
            if (state.columnPickerOpen) colMgr.renderColumnPicker();
        });

        document.addEventListener('click', (e) => {
            if (state.columnPickerOpen && !sizePicker.contains(e.target) && e.target !== sizePickerBtn) {
                state.columnPickerOpen = false;
                sizePicker.style.display = 'none';
            }
            if (!e.target.closest('.col-filter-dropdown') && !e.target.closest('.col-filter-btn')) {
                document.querySelectorAll('.col-filter-dropdown').forEach(d => d.remove());
            }
        });

        const bloatToggle = document.getElementById('sizeBloatToggle');
        const bloatBanner = document.getElementById('sizeBloatBanner');
        if (bloatToggle && bloatBanner) {
            bloatToggle.addEventListener('click', () => {
                const isOpen = bloatBanner.classList.toggle('is-open');
                bloatToggle.setAttribute('aria-expanded', String(isOpen));
            });
        }
    }

    // --------------------------------------------------------
    // LIBRARY SWITCHING
    // --------------------------------------------------------

    function _switchToSeasons() {
        _closeMobilePanel();
        _stopEnrichmentPolling();
        _stopSeasonAnalysisPolling();
        _showEnrichmentBanner(false);

        state.viewMode = 'seasons';
        colMgr.loadColumnWidths();
        colMgr.loadVisibleColumns(() => _defaultDesktopCols());
        colMgr.loadMobileColumns();
        colMgr.loadColumnLabels();
        colMgr.loadColumnOrder();
        state.columnPickerOpen = false;
        document.getElementById('sizeColumnPicker').style.display = 'none';
        state.page = 1;
        state.search = '';
        _resetQuickFilters();
        state.sortBy = null;
        state.sortDir = 'desc';
        state.expandedRow = null;

        document.getElementById('sizeSearch').value = '';
        document.getElementById('sizeSearch').placeholder = 'Search show or season\u2026';
        document.getElementById('sizeSearchClear').style.display = 'none';
        _updateTabStyles();

        const showLibs = state.libraries.filter(l => l.type !== 'movie');
        const seasonCount = _buildSeasonItems().length;

        if (seasonCount > 0) {
            // DATA ALREADY AVAILABLE \u2014 SHOW TABLE IMMEDIATELY
            _hideSeasonAnalysis();
            _applyView();
            // KEEP POLLING ONLY IF A SYNC/STARTUP WORKER IS ACTUALLY RUNNING
            if (showLibs.some(l => !dataCache[l.title]?.enriched && dataCache[l.title]?.enrichmentRunning)) {
                _startSeasonAnalysisPolling(showLibs);
            }
        } else if (showLibs.length === 0) {
            _applyView();
        } else {
            // NOTHING CACHED YET \u2014 SHOW ANALYSIS PANEL AND FETCH EVERYTHING
            _loadAllShowLibrariesForSeasons();
        }
    }

    async function _switchLibrary(title, type) {
        _closeMobilePanel();
        _stopEnrichmentPolling();
        _stopSeasonAnalysisPolling();
        _hideSeasonAnalysis();
        _showEnrichmentBanner(false);

        state.viewMode = 'shows';
        state.activeLibrary = title;
        state.activeLibraryType = type;
        state.enrichmentProgress = null;
        colMgr.loadColumnWidths();
        colMgr.loadVisibleColumns(() => _defaultDesktopCols());
        colMgr.loadMobileColumns();
        colMgr.loadColumnLabels();
        colMgr.loadColumnOrder();
        state.columnPickerOpen = false;
        document.getElementById('sizeColumnPicker').style.display = 'none';
        state.page = 1;
        state.search = '';
        state.columnFilters = {};
        _resetQuickFilters();
        state.sortBy = null;
        state.sortDir = 'desc';
        state.expandedRow = null;

        document.getElementById('sizeSearch').value = '';
        document.getElementById('sizeSearch').placeholder = 'Search title, codec, resolution\u2026';
        document.getElementById('sizeSearchClear').style.display = 'none';

        // CONSUME PENDING FILTER (SET BY navigateWithFilter) \u2014 APPLIED AFTER STATE RESET, BEFORE RENDER
        if (_pendingFilter && _pendingFilter.libraryTitle === title) {
            const { filterType, filterKey, filterValue } = _pendingFilter;
            _pendingFilter = null;
            _applyFilterSpec(filterType, filterKey, filterValue);
        }

        _updateTabStyles();

        if (dataCache[title] && dataCache[title].enriched) {
            state.allItems = dataCache[title].items;
            _applyView();
        } else if (dataCache[title]) {
            state.allItems = dataCache[title].items;
            _applyView();
            if (!dataCache[title].enriched && dataCache[title].enrichmentRunning) {
                _startEnrichmentPolling(title);
            }
        } else {
            await _fetchLibrary(title);
            _applyView();
        }
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
        const bar = document.getElementById('sizeTabBar');
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

        // SEASONS VIRTUAL TAB
        const seasonBtn = document.createElement('button');
        seasonBtn.className = 'tab-item tab-seasons';
        seasonBtn.dataset.title = '__seasons__';
        seasonBtn.dataset.type = 'seasons';
        seasonBtn.textContent = 'Seasons';
        seasonBtn.addEventListener('click', () => _switchToSeasons());
        bar.appendChild(seasonBtn);
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
                    delete dataCache[title];
                    if (state.activeLibrary === title) {
                        await _fetchLibrary(title);
                        _applyView();
                    }
                }
            } catch { /* IGNORE TRANSIENT ERRORS — KEEP POLLING */ }
        }, 3000);
    }

    function _updateTabStyles() {
        document.querySelectorAll('#sizeTabBar .tab-item').forEach(tab => {
            if (tab.dataset.title === '__seasons__') {
                tab.classList.toggle('active', state.viewMode === 'seasons');
            } else {
                tab.classList.toggle('active',
                    state.viewMode === 'shows' && tab.dataset.title === state.activeLibrary);
            }
        });
    }

    function _updateSeasonTabCount() {
        const btn = document.querySelector('#sizeTabBar .tab-seasons');
        if (!btn) return;
        const count = _buildSeasonItems().length;
        if (count > 0) {
            btn.innerHTML = `Seasons <span class="tab-count">${count.toLocaleString()}</span>`;
        } else {
            btn.textContent = 'Seasons';
        }
    }

    // --------------------------------------------------------
    // COLUMN PREFERENCES
    // --------------------------------------------------------

    function _getViewKey() {
        if (state.viewMode === 'seasons') return '__seasons__';
        return `${state.activeLibraryType}_${state.activeLibrary}`;
    }

    function _getMasterCols() {
        if (state.viewMode === 'seasons') return SEASON_COLS;
        return state.activeLibraryType === 'movie' ? MOVIE_COLS : SHOW_COLS;
    }

    function _defaultDesktopCols() {
        return _getMasterCols().map(c => c.key);
    }

    function _defaultMobileCols() {
        if (state.viewMode === 'seasons') return SEASON_MOBILE_COLS.map(c => c.key);
        if (state.activeLibraryType === 'movie') return MOVIE_MOBILE_COLS.map(c => c.key);
        return SHOW_MOBILE_COLS.map(c => c.key);
    }

    function _mobileAlwaysOnKey() {
        return state.viewMode === 'seasons' ? 'showTitle' : 'title';
    }

    const SIZE_MOBILE_LABELS = Object.fromEntries(
        [...MOVIE_COLS, ...SHOW_COLS, ...SEASON_COLS]
            .filter(c => c.mobileLabel)
            .map(c => [c.key, c.mobileLabel])
    );

    const colMgr = createColumnManager({
        lsPrefix: 'mediadash_size_',
        viewKeyFn: () => _getViewKey(),
        getMasterCols: () => _getMasterCols(),
        mobileLabels: SIZE_MOBILE_LABELS,
        alwaysOnKeyFn: () => _mobileAlwaysOnKey(),
        defaultMobileKeysFn: () => _defaultMobileCols(),
        pickerEnabled: true,
        pickerElementId: 'sizeColumnPicker',
        onChange: () => _renderTable(),
    });

    // --------------------------------------------------------
    // DATA FETCHING
    // --------------------------------------------------------

    async function _fetchLibrary(title) {
        if (dataCache[title] && dataCache[title].enriched) {
            state.allItems = dataCache[title].items;
            return;
        }

        _showLoading(true, 'Loading...');
        _hideError();
        _hideEmpty();

        try {
            const url = `/size/library/${encodeURIComponent(title)}?all=true`;
            const data = await api(url);
            dataCache[title] = { items: data.items, type: data.libraryType, enriched: data.enriched, enrichmentRunning: data.enrichmentRunning ?? false, cacheAge: data.cacheAge ?? null, needsSync: data.needsSync ?? false };
            _updateSeasonTabCount();
            state.allItems = data.items;
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
                const result = await api(`/size/library/${encodeURIComponent(title)}/enrichment`);

                if (result.status === 'complete') {
                    _stopEnrichmentPolling();
                    state.enrichmentProgress = null;
                    _showEnrichmentBanner(false);

                    if (result.items && result.items.length > 0) {
                        dataCache[title] = {
                            items: result.items,
                            type: dataCache[title]?.type,
                            enriched: true,
                            cacheAge: result.cacheAge ?? dataCache[title]?.cacheAge,
                        };
                        _updateSeasonTabCount();
                        if (state.activeLibrary === title) {
                            state.allItems = result.items;
                            _applyView();
                            showToast('Size data fully loaded', 'info');
                        }
                    }
                } else if (result.status === 'error') {
                    _stopEnrichmentPolling();
                    state.enrichmentProgress = null;
                    _showEnrichmentBanner(false);
                    showToast('Failed to load complete size data', 'error');
                } else if (result.progress && state.activeLibrary === title) {
                    state.enrichmentProgress = result.progress;
                    _showEnrichmentBanner(true, result.progress);
                    _renderPagination();
                }
            } catch (err) {
                console.warn('Size enrichment poll failed:', err);
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
        const banner = document.getElementById('sizeEnrichmentBanner');
        if (!banner) return;

        if (show) {
            const msg = _formatEnrichmentMsg(progress, state.activeLibraryType);
            banner.innerHTML = `<div class="enrichment-spinner"></div><span>${msg}</span>`;
            banner.style.display = 'flex';
        } else {
            banner.style.display = 'none';
        }
    }

    function _formatEnrichmentMsg(progress, libraryType) {
        if (progress) {
            const { current, total, step } = progress;
            if (current > 0 && total > 0) {
                return `${step || 'Syncing\u2026'} ${current.toLocaleString()} / ${total.toLocaleString()} shows`;
            }
            if (total > 0) return step || `Syncing ${total.toLocaleString()} shows\u2026`;
            return step || 'Syncing episode data\u2026';
        }
        return libraryType === 'movie'
            ? 'Loading remaining movies in the background\u2026'
            : 'Loading episode sizes and durations in the background\u2026';
    }

    // --------------------------------------------------------
    // SEASON AUTO-LOAD — PREFETCH, ANALYSIS PANEL, POLLING
    // --------------------------------------------------------

    // SILENTLY FETCH ALL SHOW LIBRARIES AFTER INIT — PRE-WARMS SEASONS TAB AND STARTS ENRICHMENT
    async function _prefetchShowLibraries() {
        const showLibs = state.libraries.filter(l => l.type !== 'movie');
        for (const lib of showLibs) {
            if (dataCache[lib.title]) continue;
            try {
                const data = await api(`/size/library/${encodeURIComponent(lib.title)}?all=true`);
                dataCache[lib.title] = {
                    items: data.items,
                    type: data.libraryType,
                    enriched: data.enriched,
                    cacheAge: data.cacheAge ?? null,
                };
                _updateSeasonTabCount();
            } catch { /* silent — Seasons tab will retry on click */ }
        }
    }

    // SHOW / HIDE THE ANALYSIS PANEL (REPLACES TABLE AREA WHILE LOADING)
    function _showSeasonAnalysis() {
        _hideError(); _hideEmpty(); _hideTable();
        const el = document.getElementById('sizeSeasonAnalysis');
        if (el) el.style.display = 'flex';
    }

    function _hideSeasonAnalysis() {
        const el = document.getElementById('sizeSeasonAnalysis');
        if (el) el.style.display = 'none';
    }

    // BUILD THE PER-LIBRARY PROGRESS ROW HTML
    function _seasonLibRowHTML(title, loaded, enriched, progress) {
        const cls = enriched ? 'sal-done' : loaded ? 'sal-active' : 'sal-waiting';
        const icon = enriched
            ? `<svg class="sal-check-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`
            : `<div class="sal-spinner"></div>`;

        let text, pct;
        if (enriched) {
            text = 'Complete'; pct = 100;
        } else if (progress?.current && progress?.total) {
            text = `${progress.current.toLocaleString()} / ${progress.total.toLocaleString()} shows`;
            pct = Math.round((progress.current / progress.total) * 100);
        } else if (progress?.step) {
            text = progress.step; pct = 5;
        } else if (loaded) {
            text = 'Analyzing episodes…'; pct = 5;
        } else {
            text = 'Waiting…'; pct = 0;
        }

        return `<div class="season-analysis-lib ${cls}" data-lib="${escapeHTML(title)}">
            <div class="sal-icon">${icon}</div>
            <div class="sal-body">
                <div class="sal-name">${escapeHTML(title)}</div>
                <div class="sal-progress-row">
                    <div class="sal-bar-track"><div class="sal-bar-fill" style="width:${pct}%"></div></div>
                    <span class="sal-progress-text">${escapeHTML(text)}</span>
                </div>
            </div>
        </div>`;
    }

    // RENDER ALL LIBRARY ROWS FROM SCRATCH
    function _renderSeasonAnalysisLibs() {
        const showLibs = state.libraries.filter(l => l.type !== 'movie');
        const container = document.getElementById('seasonAnalysisLibs');
        if (!container) return;
        container.innerHTML = showLibs
            .map(l => _seasonLibRowHTML(l.title, !!dataCache[l.title], !!dataCache[l.title]?.enriched, null))
            .join('');
        _updateSeasonAnalysisFooter();
    }

    // UPDATE A SINGLE LIBRARY ROW IN PLACE
    function _updateSeasonAnalysisLib(title, loaded, enriched, progress) {
        const container = document.getElementById('seasonAnalysisLibs');
        if (!container) return;
        const el = Array.from(container.querySelectorAll('.season-analysis-lib'))
            .find(e => e.dataset.lib === title);
        if (!el) return;
        const tmp = document.createElement('div');
        tmp.innerHTML = _seasonLibRowHTML(title, loaded, enriched, progress);
        el.replaceWith(tmp.firstElementChild);
        _updateSeasonAnalysisFooter();
    }

    function _updateSeasonAnalysisFooter() {
        const footer = document.getElementById('seasonAnalysisFooter');
        if (!footer) return;
        const count = _buildSeasonItems().length;
        const showLibs = state.libraries.filter(l => l.type !== 'movie');
        const doneCount = showLibs.filter(l => dataCache[l.title]?.enriched).length;
        footer.textContent = count > 0
            ? `${count.toLocaleString()} seasons found so far…`
            : `${doneCount} of ${showLibs.length} librar${showLibs.length === 1 ? 'y' : 'ies'} analyzed`;
    }

    // ENTRY POINT WHEN SEASONS IS CLICKED WITH NO CACHED SEASON DATA
    async function _loadAllShowLibrariesForSeasons() {
        const showLibs = state.libraries.filter(l => l.type !== 'movie');
        if (!showLibs.length) { _applyView(); return; }

        _showSeasonAnalysis();
        _renderSeasonAnalysisLibs();

        // KICK OFF ANY LIBRARIES THAT HAVEN'T BEEN FETCHED YET (IN PARALLEL)
        const toFetch = showLibs.filter(l => !dataCache[l.title]);
        await Promise.all(toFetch.map(async (lib) => {
            try {
                const data = await api(`/size/library/${encodeURIComponent(lib.title)}?all=true`);
                dataCache[lib.title] = {
                    items: data.items,
                    type: data.libraryType,
                    enriched: data.enriched,
                    enrichmentRunning: data.enrichmentRunning ?? false,
                    cacheAge: data.cacheAge ?? null,
                    needsSync: data.needsSync ?? false,
                };
                _updateSeasonTabCount();
                _updateSeasonAnalysisLib(lib.title, true, data.enriched, null);
            } catch { /* polling will surface any issues */ }
        }));

        // ONLY START POLLER IF A SYNC/STARTUP WORKER IS ACTUALLY RUNNING
        if (showLibs.some(l => !dataCache[l.title]?.enriched && dataCache[l.title]?.enrichmentRunning)) {
            _startSeasonAnalysisPolling(showLibs);
        }
    }

    // POLL ALL SHOW LIBRARIES FOR ENRICHMENT COMPLETION, UPDATING PANEL IN REAL-TIME
    function _startSeasonAnalysisPolling(showLibs) {
        _stopSeasonAnalysisPolling();

        state.seasonAnalysisPolling = setInterval(async () => {
            if (state.viewMode !== 'seasons') {
                _stopSeasonAnalysisPolling();
                return;
            }

            const pending = showLibs.filter(l => !dataCache[l.title]?.enriched);

            for (const lib of pending) {
                try {
                    const result = await api(`/size/library/${encodeURIComponent(lib.title)}/enrichment`);
                    if (result.status === 'complete') {
                        if (result.items?.length > 0) {
                            dataCache[lib.title] = {
                                items: result.items,
                                type: dataCache[lib.title]?.type,
                                enriched: true,
                                cacheAge: result.cacheAge ?? dataCache[lib.title]?.cacheAge,
                            };
                        } else if (dataCache[lib.title]) {
                            dataCache[lib.title].enriched = true;
                        }
                        _updateSeasonTabCount();
                        _updateSeasonAnalysisLib(lib.title, true, true, null);
                    } else {
                        _updateSeasonAnalysisLib(lib.title, !!dataCache[lib.title], false, result.progress ?? null);
                    }
                } catch { /* ignore transient errors */ }
            }

            const analysisEl = document.getElementById('sizeSeasonAnalysis');
            const analysisVisible = analysisEl && analysisEl.style.display !== 'none';
            const seasonCount = _buildSeasonItems().length;

            if (seasonCount > 0 && analysisVisible) {
                // WE HAVE DATA — TRANSITION FROM ANALYSIS PANEL TO THE LIVE TABLE
                _hideSeasonAnalysis();
                _applyView();
            } else if (analysisVisible) {
                _updateSeasonAnalysisFooter();
            } else if (pending.length > 0) {
                // TABLE ALREADY VISIBLE — REFRESH WITH NEWLY ENRICHED DATA
                _applyView();
            }

            // ALL LIBRARIES ENRICHED — CLEAN UP
            if (showLibs.every(l => dataCache[l.title]?.enriched)) {
                _stopSeasonAnalysisPolling();
                if (state.viewMode === 'seasons') {
                    _applyView();
                    showToast('All season data loaded', 'info');
                }
            }
        }, 2500);
    }

    function _stopSeasonAnalysisPolling() {
        if (state.seasonAnalysisPolling) {
            clearInterval(state.seasonAnalysisPolling);
            state.seasonAnalysisPolling = null;
        }
    }

    // --------------------------------------------------------
    // VIEW
    // --------------------------------------------------------

    function _applyView() {
        _showLoading(false);
        _hideError();
        _hideEmpty();
        _hideAllClear();

        if (state.viewMode === 'seasons') {
            const allSeasons = _buildSeasonItems();
            state._totalUnfiltered = allSeasons.length;

            if (allSeasons.length === 0) {
                _hideTable();
                _showEmpty('No show libraries found. Add a TV or Anime library to Plex first.');
                _renderPagination();
                return;
            }

            const seasonStats = _computeSeasonStats(allSeasons);
            let data = allSeasons
                .filter(s => _isSeasonBloated(s, seasonStats))
                .map(s => ({ ...s, _bloat: _seasonBloatData(s, seasonStats) }));
            data = data.map((s, i) => ({ ...s, rank: i + 1 }));

            if (data.length === 0 && !state.search) {
                _hideTable();
                const pending = Object.values(dataCache).some(c => c.type === 'show' && !c.enriched);
                if (pending) {
                    _showLoading(true, 'Calculating season sizes…');
                } else {
                    _showAllClear(`All ${allSeasons.length.toLocaleString()} seasons are within normal size limits.`);
                }
                _renderPagination();
                return;
            }

            if (state.search) {
                const q = state.search.toLowerCase();
                data = data.filter(item =>
                    (item.showTitle && item.showTitle.toLowerCase().includes(q)) ||
                    (item.name && item.name.toLowerCase().includes(q)) ||
                    (item.library && item.library.toLowerCase().includes(q))
                );
            }

            if (state.sortBy) {
                const colDef = SEASON_COLS.find(c => c.key === state.sortBy);
                const sortField = colDef?.sortKey || state.sortBy;
                const reverse = state.sortDir === 'desc';
                data = [...data].sort((a, b) => {
                    let cmp = compareValues(a[sortField], b[sortField]);
                    return reverse ? -cmp : cmp;
                });
            }

            for (let i = 0; i < data.length; i++) {
                data[i] = { ...data[i], rank: i + 1 };
            }

            const total = data.length;
            const totalPages = Math.max(1, Math.ceil(total / state.perPage));
            if (state.page > totalPages) state.page = totalPages;
            const start = (state.page - 1) * state.perPage;

            state.items = data.slice(start, start + state.perPage);
            state.totalItems = total;
            state.totalPages = totalPages;

            if (state.items.length === 0) {
                _hideTable();
                _showEmpty('No results match your search.');
                _renderPagination();
            } else {
                _renderTable();
                _renderPagination();
                _showTable();
            }
            return;
        }

        let data = state.allItems;
        if (!data || data.length === 0) {
            _hideTable();
            if (state.activeLibrary && dataCache[state.activeLibrary] && !dataCache[state.activeLibrary].enriched) {
                _showLoading(true, 'Loading library data…');
            } else {
                _showEmpty('No items loaded.');
            }
            return;
        }

        const totalItems = data.length;
        state._totalUnfiltered = totalItems;

        // BLOAT FILTERING — compute stats from all items, then keep only oversized ones
        if (state.activeLibraryType === 'show') {
            const showStats = _computeShowStats(data);
            data = data
                .filter(item => _isShowBloated(item, showStats))
                .map(item => ({ ...item, _bloat: _showBloatData(item, showStats) }));
        } else {
            data = data
                .filter(item => _isMovieBloated(item))
                .map(item => ({ ...item, _bloat: _movieBloatData(item) }));
        }

        // NOTHING BLOATED
        if (data.length === 0 && !state.search) {
            _hideTable();
            const cached = dataCache[state.activeLibrary];
            const enriched = cached ? cached.enriched : false;
            const typeLabel = state.activeLibraryType === 'movie' ? 'movies' : 'shows';
            if (state.activeLibraryType === 'show' && !enriched) {
                _showLoading(true, 'Calculating episode sizes…');
            } else {
                _showAllClear(`All ${totalItems.toLocaleString()} ${typeLabel} are within normal size limits.`);
            }
            _renderPagination();
            return;
        }

        // SEARCH FILTER
        if (state.search) {
            const q = state.search.toLowerCase();
            data = data.filter(item => item.title && item.title.toLowerCase().includes(q));
        }

        // COLUMN-HEADER FILTERS
        const activeFilters = Object.entries(state.columnFilters).filter(([, v]) => v instanceof Set ? v.size > 0 : !!v);
        if (activeFilters.length > 0) {
            data = data.filter(item => activeFilters.every(([colKey, fv]) => {
                const raw = item[colKey];
                if (raw == null) return false;
                if (typeof fv === 'function') return fv(raw);
                if (fv instanceof Set) {
                    if (Array.isArray(raw)) return raw.some(x => fv.has(String(x)));
                    return fv.has(String(raw));
                }
                const fl = fv.toLowerCase();
                if (Array.isArray(raw)) return raw.some(x => String(x).toLowerCase().includes(fl));
                return String(raw).toLowerCase().includes(fl);
            }));
        }

        // QUICK FILTERS — NUMERIC THRESHOLD AND EXACT MATCH
        const qf = state.quickFilters;
        if (qf.criticRating) {
            const threshold = parseFloat(qf.criticRating);
            data = data.filter(item => item.rating != null && item.rating > threshold);
        }
        if (qf.audienceRating) {
            const threshold = parseFloat(qf.audienceRating);
            data = data.filter(item => item.audienceRating != null && item.audienceRating > threshold);
        }
        if (qf.year) {
            const threshold = parseInt(qf.year, 10);
            data = data.filter(item => item.year != null && item.year > threshold);
        }
        if (qf.subtitles === 'english') {
            data = data.filter(item => item.subtitleLanguages && item.subtitleLanguages.toLowerCase().includes('english'));
        } else if (qf.subtitles === 'none') {
            data = data.filter(item => !item.subtitleLanguages || item.subtitleLanguages === 'None');
        }

        // SORT
        if (state.sortBy && data.length > 0) {
            const cols = state.activeLibraryType === 'movie' ? MOVIE_COLS : SHOW_COLS;
            const colDef = cols.find(c => c.key === state.sortBy);
            const sortField = colDef?.sortKey || state.sortBy;
            const reverse = state.sortDir === 'desc';
            data = [...data].sort((a, b) => {
                let cmp = compareValues(a[sortField], b[sortField]);
                return reverse ? -cmp : cmp;
            });
        }

        // RE-ASSIGN RANK AFTER FILTER/SORT
        for (let i = 0; i < data.length; i++) {
            data[i] = Object.assign({}, data[i], { rank: i + 1 });
        }

        const total = data.length;
        const totalPages = Math.max(1, Math.ceil(total / state.perPage));
        if (state.page > totalPages) state.page = totalPages;
        const start = (state.page - 1) * state.perPage;

        state.items = data.slice(start, start + state.perPage);
        state.totalItems = total;
        state.totalPages = totalPages;

        if (state.items.length === 0) {
            _hideTable();
            if (dataCache[state.activeLibrary]?.needsSync) {
                _showEmpty('No cached data for this library yet — click Sync (top right) to load it from Plex.');
            } else {
                _showEmpty(state.search ? 'No results match your search.' : 'This library is empty.');
            }
            _renderPagination();
        } else {
            _renderTable();
            _renderPagination();
            _showTable();
        }
    }

    // --------------------------------------------------------
    // TABLE RENDERING
    // --------------------------------------------------------

    function _renderTable() {
        const thead = document.getElementById('sizeTableHead');
        const tbody = document.getElementById('sizeTableBody');
        const mobile = _isMobile();
        const cols = mobile
            ? _getMasterCols().filter(c => colMgr.state.mobileColumns.includes(c.key))
            : colMgr.getOrderedVisibleCols();

        // HEADER
        const table = document.getElementById('sizeTable');
        const hasAnyWidth = Object.keys(colMgr.state.columnWidths).length > 0;
        table.classList.toggle('resizable', hasAnyWidth);

        let headerHTML = '<tr><th class="expand-col"></th>';
        for (const col of cols) {
            const isSorted = state.sortBy === col.key;
            const sortClass = isSorted ? `sorted-${state.sortDir}` : '';
            const sortableClass = col.sortable ? 'sortable' : '';
            const _fv = state.columnFilters[col.key];
            const hasFilter = _fv instanceof Set ? _fv.size > 0 : !!_fv;
            const filterActiveClass = hasFilter ? 'active' : '';
            const colLabel = colMgr.getColLabel(col, mobile);
            const widthStyle = colMgr.state.columnWidths[col.key]
                ? `width:${colMgr.state.columnWidths[col.key]}px;`
                : hasAnyWidth ? `min-width:${colLabel.length + 3}ch;` : '';
            const rankClass = col.key === 'rank' ? 'row-num-col' : '';
            headerHTML += `<th class="${sortableClass} ${sortClass} ${rankClass}" data-col="${col.key}" draggable="true" style="${widthStyle}">`;
            headerHTML += '<div class="th-content">';
            if (col.key !== 'rank') headerHTML += `<button class="col-filter-btn ${filterActiveClass}" data-col="${col.key}" title="Filter ${colLabel}">${hasFilter ? '<span class="filter-dot"></span>' : ''}<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.5h13l-5 6v5l-3 2v-7z"/></svg></button>`;
            headerHTML += `<span class="th-label">${escapeHTML(colLabel)}</span>`;
            if (col.sortable) headerHTML += '<span class="sort-indicator"></span>';
            headerHTML += '</div>';
            headerHTML += `<div class="resize-handle" data-col="${col.key}"></div>`;
            headerHTML += '</th>';
        }
        headerHTML += '</tr>';
        thead.innerHTML = headerHTML;

        // ATTACH RESIZE HANDLES BEFORE SORT LISTENERS
        colMgr.initResizeHandles(thead, 'sizeTable', (resizing) => { isResizing = resizing; });
        colMgr.initColumnDrag(thead);

        // SORT CLICK HANDLERS
        thead.querySelectorAll('th.sortable').forEach(th => {
            th.addEventListener('click', (e) => {
                if (isResizing || e.target.closest('.col-filter-btn') || e.target.closest('.resize-handle')) return;
                const col = th.dataset.col;
                if (state.sortBy === col) {
                    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
                    if (state.sortDir === 'asc' && state.sortBy === col) { state.sortBy = null; }
                } else {
                    state.sortBy = col;
                    state.sortDir = 'asc';
                }
                state.page = 1;
                state.expandedRow = null;
                _applyView();
            });
        });

        thead.querySelectorAll('.col-filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                _toggleColumnFilter(btn, btn.dataset.col);
            });
        });

        // BODY
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

            if (isExpanded) {
                bodyHTML += `<tr class="detail-row"><td colspan="${cols.length + 1}">`;
                bodyHTML += _renderDetail(item);
                bodyHTML += '</td></tr>';
            }
        }
        tbody.innerHTML = bodyHTML;

        tbody.querySelectorAll('.data-row').forEach(row => {
            row.addEventListener('click', () => {
                const idx = parseInt(row.dataset.index);
                if (_isMobile()) {
                    _openMobilePanel(state.items[idx]);
                } else {
                    state.expandedRow = state.expandedRow === idx ? null : idx;
                    _renderTable();
                }
            });
        });
    }

    // --------------------------------------------------------

    function _formatCell(key, value, item) {
        if (value === null || value === undefined) return '<span class="text-muted">-</span>';

        switch (key) {
            case 'rank':
                return `<span class="row-num text-muted">${value}</span>`;

            case 'resolution':
            case 'dominantResolution':
                return _renderResolution(value);

            case 'fileSizeFormatted':
                return _renderMovieSize(value, item);

            case 'totalSizeFormatted':
                return _renderShowSize(value, item);

            case 'bitrate':
                return value != null ? escapeHTML(`${value} kbps`) : '<span class="text-muted">-</span>';

            case 'sizeFormatted': {
                const bytes = item.size || 0;
                const GB = 1024 ** 3;
                if (bytes >= 30 * GB) return `<span style="color:var(--error);font-weight:600">${escapeHTML(value)}</span>`;
                if (bytes >= 15 * GB) return `<span style="color:var(--warning);font-weight:600">${escapeHTML(value)}</span>`;
                return escapeHTML(value);
            }
            case 'showStatus':
                if (value === 'Returning') return '<span class="badge badge-warning">Returning</span>';
                if (value === 'Airing')    return '<span class="badge badge-success">Airing</span>';
                if (value === 'Canceled')  return '<span class="badge badge-error">Canceled</span>';
                if (value === 'Finished')  return '<span class="badge badge-info">Finished</span>';
                return '<span class="badge badge-muted">Unknown</span>';

            case 'showTitle':
                return escapeHTML(truncate(String(value), 50));
            case 'name':
                return escapeHTML(String(value));
            case 'library':
                return `<span class="text-muted" style="font-size:0.75rem">${escapeHTML(String(value))}</span>`;

            default:
                return escapeHTML(String(value));
        }
    }

    function _renderResolution(val) {
        if (!val) return '<span class="text-muted">-</span>';
        const v = String(val).toLowerCase();
        let cls = 'res-sd', label = v;
        if (v === '4k' || v === '2160') { cls = 'res-4k'; label = '4K'; }
        else if (v === '1080' || v === '1080p') { cls = 'res-1080'; label = '1080p'; }
        else if (v === '720' || v === '720p') { cls = 'res-720'; label = '720p'; }
        else if (v === '480' || v === 'sd') { label = 'SD'; }
        return `<span class="resolution-badge ${cls}">${label}</span>`;
    }

    function _renderMovieSize(val, item) {
        if (!val) return '<span class="text-muted">-</span>';
        const bytes = item.fileSize || 0;
        const res = String(item.resolution || '').toLowerCase();
        const GB = 1024 ** 3;
        const isError = ((res === '1080' || res === '1080p') && bytes >= 5 * GB) ||
                        ((res === '4k' || res === '2160') && bytes >= 30 * GB);
        const isWarn = (res === '720' || res === '720p') && bytes >= 1.5 * GB;
        if (isError) return `<span style="color:var(--error);font-weight:600">${escapeHTML(val)}</span>`;
        if (isWarn) return `<span style="color:var(--warning);font-weight:600">${escapeHTML(val)}</span>`;
        return escapeHTML(val);
    }

    function _renderShowSize(val, item) {
        if (!val) return '<span class="text-muted">-</span>';
        const bytes = item.totalSize || 0;
        const GB = 1024 ** 3;
        if (bytes >= 100 * GB) return `<span style="color:var(--error);font-weight:600">${escapeHTML(val)}</span>`;
        if (bytes >= 50 * GB) return `<span style="color:var(--warning);font-weight:600">${escapeHTML(val)}</span>`;
        return escapeHTML(val);
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
        if (item._isSeason) return item.showTitle || item.name || 'Season Details';
        return item.title || 'Size Details';
    }

    function _mobilePanelMeta(item) {
        if (item._isSeason) {
            return [
                item.name,
                item.library,
                item.sizeFormatted,
                item.dominantResolution,
            ].filter(v => v != null && v !== '');
        }
        if (item.mediaType === 'movie') {
            return [
                item.year,
                item.fileSizeFormatted,
                item.resolution ? String(item.resolution).toUpperCase() : null,
            ].filter(v => v != null && v !== '');
        }
        return [
            item.year,
            item.totalSizeFormatted,
            item.dominantResolution,
            item.episodes ? `${item.episodes} eps` : null,
        ].filter(v => v != null && v !== '');
    }

    function _buildMobilePanelContent(item) {
        const e = escapeHTML;
        const val = v => (v != null && v !== '') ? e(String(v)) : '<span class="text-muted">—</span>';
        const panelItem = (label, value) =>
            `<div class="mobile-panel-item"><span class="label">${e(label)}</span><span class="value">${val(value)}</span></div>`;
        const section = (title, inner) => `<div class="mobile-panel-section"><div class="mobile-panel-section-title">${e(title)}</div>${inner}</div>`;
        const grid = pairs => `<div class="mobile-panel-grid">${pairs.map(([l, v]) => panelItem(l, v)).join('')}</div>`;

        let html = '';

        if (item._isSeason) {
            const pairs = [
                ['Show',       item.showTitle],
                ['Season',     item.name],
                ['Library',    item.library],
                ['Episodes',   item.episodeCount],
                ['Resolution', item.dominantResolution],
                ['Duration',   item.durationFormatted],
                ['Size',       item.sizeFormatted],
                ['Year',       item.year],
            ].filter(([, v]) => v != null && v !== '');
            if (pairs.length) html += section('Season Details', grid(pairs));
        } else if (item.mediaType === 'movie') {
            const pairs = [
                ['Resolution', item.resolution],
                ['Video Codec', item.videoCodec],
                ['Bitrate', item.bitrate != null ? `${item.bitrate} kbps` : null],
                ['Container', item.container],
                ['File Size', item.fileSizeFormatted],
                ['Duration', item.durationFormatted],
                ['Subtitles', item.subtitleLanguages || null],
                ['Year', item.year],
            ].filter(([, v]) => v != null && v !== '');
            if (pairs.length) html += section('Technical Details', grid(pairs));
        } else {
            const pairs = [
                ['Resolution', item.dominantResolution],
                ['Seasons', item.seasons],
                ['Episodes', item.episodes],
                ['Total Size', item.totalSizeFormatted],
                ['Total Duration', item.totalDurationFormatted],
                ['Year', item.year],
            ].filter(([, v]) => v != null && v !== '');
            if (pairs.length) html += section('Details', grid(pairs));
        }

        html += _renderMobileBloatSection(item);

        if (item.seasonSizes && item.seasonSizes.length > 0) {
            html += _renderSizeBreakdown(item);
        }

        if (item.filePath) {
            html += section('File Path', `<p style="font-family:monospace;font-size:0.72rem;color:var(--text-muted);word-break:break-all;line-height:1.5;">${e(item.filePath)}</p>`);
        }

        return html;
    }

    function _renderMobileBloatSection(item) {
        const b = item._bloat;
        if (!b) return '';
        const e = escapeHTML;
        const panelItem = (label, value) =>
            `<div class="mobile-panel-item"><span class="label">${e(label)}</span><span class="value">${e(value)}</span></div>`;
        let pairs;
        if (b.type === 'movie') {
            pairs = [
                ['File Size', `${b.gb.toFixed(2)} GB`],
                [`Limit (${b.res})`, `${b.limitGB} GB`],
                ['Over Limit', `+${(b.gb - b.limitGB).toFixed(2)} GB`],
            ];
        } else {
            pairs = [
                ['Size / Episode', `${b.sizePerEpGB.toFixed(2)} GB`],
                [`Avg (${b.res})`, `${b.avgGB.toFixed(2)} GB/ep`],
                ['Ratio', `${b.ratio.toFixed(2)}× average`],
            ];
        }
        return `<div class="mobile-panel-section">
            <div class="mobile-panel-section-title">Bloat Analysis</div>
            <div class="mobile-panel-grid">${pairs.map(([l, v]) => panelItem(l, v)).join('')}</div>
        </div>`;
    }

    // --------------------------------------------------------
    // DETAIL ROW
    // --------------------------------------------------------

    function _renderDetail(item) {
        if (item._isSeason) {
            let html = '<div class="detail-content"><div class="detail-section"><h4>Season Details</h4><div class="detail-grid">';
            html += _detailItem('Show', item.showTitle);
            html += _detailItem('Season', item.name);
            html += _detailItem('Library', item.library);
            html += _detailItem('Episodes', item.episodeCount || null);
            html += _detailItem('Resolution', item.dominantResolution);
            html += _detailItem('Duration', item.durationFormatted);
            html += _detailItem('Size', item.sizeFormatted);
            html += _detailItem('Year', item.year);
            html += '</div></div>';
            html += _renderBloatDetail(item);
            html += '</div>';
            return html;
        }

        let html = '<div class="detail-content">';

        if (item.mediaType === 'movie') {
            html += '<div class="detail-section"><h4>Technical Details</h4><div class="detail-grid">';
            html += _detailItem('Resolution', item.resolution);
            html += _detailItem('Video Codec', item.videoCodec);
            html += _detailItem('Bitrate', item.bitrate != null ? `${item.bitrate} kbps` : null);
            html += _detailItem('Container', item.container);
            html += _detailItem('File Size', item.fileSizeFormatted);
            html += _detailItem('Duration', item.durationFormatted);
            html += _detailItem('Subtitles', item.subtitleLanguages || null);
            html += _detailItem('Year', item.year);
            html += '</div></div>';
            html += _renderBloatDetail(item);
            if (item.filePath) {
                html += `<div class="detail-section"><h4>File Path</h4><p class="summary-text" style="font-family:monospace;font-size:0.75rem;word-break:break-all;overflow-wrap:break-word;">${escapeHTML(item.filePath)}</p></div>`;
            }
        } else {
            html += '<div class="detail-section"><h4>Details</h4><div class="detail-grid">';
            html += _detailItem('Resolution', item.dominantResolution);
            html += _detailItem('Seasons', item.seasons);
            html += _detailItem('Episodes', item.episodes);
            html += _detailItem('Total Size', item.totalSizeFormatted);
            html += _detailItem('Total Duration', item.totalDurationFormatted);
            html += _detailItem('Year', item.year);
            html += '</div></div>';
            html += _renderBloatDetail(item);
            if (item.filePath) {
                html += `<div class="detail-section"><h4>File Path</h4><p class="summary-text" style="font-family:monospace;font-size:0.75rem;word-break:break-all;overflow-wrap:break-word;">${escapeHTML(item.filePath)}</p></div>`;
            }
            if (item.seasonSizes && item.seasonSizes.length > 0) {
                html += _renderSizeBreakdown(item);
            }
        }

        html += '</div>';
        return html;
    }

    function _renderSizeBreakdown(item) {
        const seasons = item.seasonSizes;
        const maxSize = Math.max(...seasons.map(s => s.size));

        let html = '<div class="detail-section"><h4>Size Breakdown</h4><div class="size-breakdown">';
        for (const season of seasons) {
            const pct = maxSize > 0 ? (season.size / maxSize) * 100 : 0;
            const sizeGB = season.size / (1024 ** 3);
            const name = season.name.replace(/^Season ([1-9])$/, 'Season 0$1');
            const sizeClass = sizeGB >= 60 ? 'size-lg' : sizeGB >= 20 ? 'size-md' : 'size-sm';
            const info = [season.episodeCount ? `${season.episodeCount} ep` : '', season.durationFormatted || ''].filter(Boolean).join(' \u00B7 ');
            html += `<div class="size-bar-row">
                <span class="size-bar-label">${escapeHTML(name)}${info ? ` <span class="size-bar-info">(${escapeHTML(info)})</span>` : ''}</span>
                <div class="size-bar-track"><div class="size-bar-fill ${sizeClass}" style="width:${pct}%"></div></div>
                <span class="size-bar-value">${escapeHTML(season.sizeFormatted || '-')}</span>
            </div>`;
        }
        const totals = [item.totalSizeFormatted, item.totalDurationFormatted].filter(Boolean);
        html += `<div class="size-bar-total">Total: ${escapeHTML(totals.join(' \u00B7 ') || '-')}</div>`;
        html += '</div></div>';
        return html;
    }

    function _detailItem(label, value) {
        const display = value != null && value !== '' ? escapeHTML(String(value)) : '-';
        return `<div class="detail-item"><span class="label">${escapeHTML(label)}</span><span class="value">${display}</span></div>`;
    }

    // --------------------------------------------------------
    // PAGINATION
    // --------------------------------------------------------

    function _renderPagination() {
        const bar = document.getElementById('sizePaginationBar');
        if (state.totalItems === 0) { bar.style.display = 'none'; return; }

        bar.style.display = 'flex';
        const typeLabel = state.viewMode === 'seasons' ? 'oversized seasons'
            : (state.activeLibraryType === 'movie' ? 'oversized movies' : 'oversized shows');
        const start = (state.page - 1) * state.perPage + 1;
        const end = Math.min(state.page * state.perPage, state.totalItems);
        let isPartial;
        if (state.viewMode === 'seasons') {
            isPartial = Object.values(dataCache).some(c => c.type === 'show' && !c.enriched);
        } else {
            const cached = dataCache[state.activeLibrary];
            isPartial = cached && !cached.enriched;
        }
        let syncInfo = '';
        if (isPartial && state.viewMode !== 'seasons') {
            const p = state.enrichmentProgress;
            if (p && p.current > 0 && p.total > 0) {
                syncInfo = ` \u00b7 <span class="badge badge-info">Syncing: ${p.current.toLocaleString()} / ${p.total.toLocaleString()} shows</span>`;
            } else if (p && p.step) {
                syncInfo = ` \u00b7 <span class="badge badge-info">${escapeHTML(p.step)}</span>`;
            } else if (isPartial) {
                syncInfo = ` \u00b7 <span class="badge badge-info">Loading episode data\u2026</span>`;
            }
        } else if (isPartial) {
            syncInfo = ` \u00b7 <span class="badge badge-info">Loading season data\u2026</span>`;
        }
        const totalUnfiltered = state._totalUnfiltered;
        const ofTotal = totalUnfiltered && totalUnfiltered > state.totalItems
            ? ` of ${totalUnfiltered.toLocaleString()} total` : '';
        const totalDisplay = `${state.totalItems.toLocaleString()}${isPartial ? '+' : ''} ${typeLabel}${ofTotal}${syncInfo}`;

        bar.innerHTML = `
            <div class="pagination-info">${start.toLocaleString()}-${end.toLocaleString()} of ${totalDisplay}</div>
            <div class="pagination-controls">
                <button class="btn btn-sm" id="sizePrevPage" ${state.page <= 1 ? 'disabled' : ''}>\u2190 Previous</button>
                <span class="page-indicator">Page ${state.page} of ${state.totalPages || 1}</span>
                <button class="btn btn-sm" id="sizeNextPage" ${state.page >= state.totalPages ? 'disabled' : ''}>Next \u2192</button>
            </div>
        `;

        document.getElementById('sizePrevPage').addEventListener('click', () => {
            if (state.page > 1) { state.page--; state.expandedRow = null; _applyView(); }
        });
        document.getElementById('sizeNextPage').addEventListener('click', () => {
            if (state.page < state.totalPages) { state.page++; state.expandedRow = null; _applyView(); }
        });
    }

    // --------------------------------------------------------
    // UI STATE HELPERS
    // --------------------------------------------------------

    function _showLoading(show, message) {
        const el = document.getElementById('sizeLoading');
        el.style.display = show ? 'flex' : 'none';
        if (show && message) el.querySelector('.state-text').textContent = message;
        if (show) { _hideTable(); _hideAllClear(); }
    }

    function _showError(message) {
        _hideAllClear();
        document.getElementById('sizeError').style.display = 'flex';
        document.getElementById('sizeErrorMsg').textContent = message;
        _hideTable();
        document.getElementById('sizePaginationBar').style.display = 'none';
    }

    function _hideError() { document.getElementById('sizeError').style.display = 'none'; }

    function _showEmpty(message) {
        document.getElementById('sizeEmpty').style.display = 'flex';
        document.getElementById('sizeEmptyMsg').textContent = message;
    }

    function _hideEmpty() { document.getElementById('sizeEmpty').style.display = 'none'; }

    function _showAllClear(msg) {
        const el = document.getElementById('sizeAllClear');
        if (!el) return;
        document.getElementById('sizeAllClearSub').textContent = msg;
        el.style.display = 'flex';
        document.getElementById('sizePaginationBar').style.display = 'none';
    }

    function _hideAllClear() {
        const el = document.getElementById('sizeAllClear');
        if (el) el.style.display = 'none';
    }

    function _showTable() { document.getElementById('sizeTableWrapper').style.display = 'block'; }
    function _hideTable() { document.getElementById('sizeTableWrapper').style.display = 'none'; }

    // --------------------------------------------------------
    // PUBLIC API
    // --------------------------------------------------------

    function invalidateCache() {
        for (const key of Object.keys(dataCache)) delete dataCache[key];
        _stopEnrichmentPolling();
    }

    async function refreshActive() {
        if (state.activeLibrary && state.viewMode !== 'seasons') {
            delete dataCache[state.activeLibrary];
            await _fetchLibrary(state.activeLibrary);
            _applyView();
        }
    }

    // NAVIGATE TO SIZE PAGE AND PRE-APPLY A FILTER
    // FILTERSPEC: { filterType: 'picklist'|'text'|'quick'|'function', filterKey: string, filterValue: * }
    function navigateWithFilter(libraryTitle, filterSpec) {
        // IF SIZE IS ALREADY SHOWING THE CORRECT LIBRARY, APPLY FILTER IMMEDIATELY
        if (state.activeLibrary === libraryTitle) {
            state.columnFilters = {};
            _resetQuickFilters();
            state.expandedRow = null;
            _applyFilterSpec(filterSpec.filterType, filterSpec.filterKey, filterSpec.filterValue);
            state.page = 1;
            _applyView();
            window.location.hash = '#size';
            return;
        }
        // STORE PENDING FILTER — _switchLibrary WILL CONSUME IT AFTER ITS STATE RESET
        _pendingFilter = { libraryTitle, ...filterSpec };
        // IF SIZE HAS LOADED ITS LIBRARY LIST, SWITCH TO THE TARGET LIBRARY
        const lib = state.libraries.find(l => l.title === libraryTitle);
        if (lib) {
            window.location.hash = '#size';
            _switchLibrary(lib.title, lib.type);
            return;
        }
        // SIZE NOT YET INITIALIZED — NAVIGATE AND LET init() CONSUME THE PENDING FILTER
        window.location.hash = '#size';
    }

    return { init, retry, invalidateCache, refreshActive, navigateWithFilter };
})();
