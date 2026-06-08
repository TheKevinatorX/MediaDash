// ################################################
// # SEARCH PAGE — PLEX LIBRARY BROWSER          #
// ################################################

// ============================================================
// SEARCH PAGE — PLEX LIBRARY BROWSER (IIFE MODULE)
// ============================================================

const SearchDash = (() => {

    // --------------------------------------------------------
    // STATE
    // --------------------------------------------------------

    const state = {
        libraries: [],
        activeLibrary: null,
        activeLibraryType: null,
        columns: [],
        visibleColumns: [],
        mobileColumns: [],
        columnLabels: { desktop: {}, mobile: {} },
        items: [],
        search: '',
        sortBy: null,
        sortDir: 'asc',
        page: 1,
        perPage: 25,
        totalItems: 0,
        totalPages: 0,
        loading: false,
        expandedRow: null,
        columnPickerOpen: false,
        columnFilters: {},
        quickFilters: { criticRating: '', audienceRating: '', year: '', subtitles: '' },
        columnWidths: {},
        columnOrder: [],
        enrichmentPolling: null,
        enrichmentProgress: null,
    };

    // CACHE ALL FETCHED LIBRARY DATA INDEXED BY LIBRARY TITLE
    const dataCache = {};

    // PREVENT SORT CLICKS DURING COLUMN RESIZE
    let isResizing = false;

    // PENDING FILTER — SET BY navigateWithFilter(), CONSUMED ONCE BY _switchLibrary()
    let _pendingFilter = null;

    const LS_PREFIX = 'mediadash_search_';

    const SEARCH_MOBILE_LABELS = {
        title:                    'Title',
        year:                     'Yr',
        rating:                   'Critic',
        audienceRating:           'Aud',
        durationFormatted:        'Dur',
        resolution:               'Res',
        fileSizeFormatted:        'Size',
        genres:                   'Genre',
        studio:                   'Studio',
        contentRating:            'Ctnt',
        addedAtFormatted:         'Added',
        videoCodec:               'VCodec',
        audioCodec:               'ACodec',
        audioChannelsFormatted:   'Audio',
        bitrateFormatted:         'Brate',
        container:                'EXT',
        subtitleLanguages:        'Subs',
        watchStatus:              'Watch',
        playCount:                'Plays',
        lastPlayedAtFormatted:    'Last',
        seasons:                  'S',
        episodes:                 'E',
        totalSizeFormatted:       'Size',
        dominantResolution:       'Res',
        totalDurationFormatted:   'Dur',
        watchedEpisodes:          'Wtchd',
        watchProgress:            'Prog',
        showStatus:               'Stat',
    };

    // QUICK-FILTER MAPPING: state-key -> select element id (matches index.html)
    const QF_IDS = {
        criticRating: 'qfCriticRating',
        audienceRating: 'qfAudienceRating',
        year: 'qfYear',
        subtitles: 'qfSubtitles',
    };
    // FACTORY: FRESH EMPTY QUICK-FILTERS OBJECT
    const _emptyQuickFilters = () => ({ criticRating: '', audienceRating: '', year: '', subtitles: '' });
    // RESET ALL QUICK-FILTER UI ELEMENTS TO EMPTY/INACTIVE
    function _resetQuickFilterUI() {
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
    // INIT
    // --------------------------------------------------------

    async function init() {
        _showLoading(true, 'Connecting to Plex...');

        try {
            const res = await api('/search/libraries');
            state.libraries = res.libraries;

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
        const searchInput = document.getElementById('searchSearch');
        const searchClear = document.getElementById('searchSearchClear');

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

        document.getElementById('searchPerPage').addEventListener('change', (e) => {
            state.perPage = parseInt(e.target.value);
            state.page = 1;
            state.expandedRow = null;
            _applyView();
        });

        const pickerBtn = document.getElementById('searchColumnPickerBtn');
        const picker = document.getElementById('searchColumnPicker');

        pickerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.columnPickerOpen = !state.columnPickerOpen;
            picker.style.display = state.columnPickerOpen ? 'flex' : 'none';
            if (state.columnPickerOpen) _renderColumnPicker();
        });

        document.addEventListener('click', (e) => {
            if (state.columnPickerOpen && !picker.contains(e.target) && e.target !== pickerBtn) {
                state.columnPickerOpen = false;
                picker.style.display = 'none';
            }
            if (!e.target.closest('.col-filter-dropdown') && !e.target.closest('.col-filter-btn')) {
                document.querySelectorAll('.col-filter-dropdown').forEach(d => d.remove());
            }
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
    }

    // --------------------------------------------------------
    // LIBRARY SWITCHING
    // --------------------------------------------------------

    async function _switchLibrary(title, type) {
        _closeMobilePanel();
        _stopEnrichmentPolling();
        _showEnrichmentBanner(false);

        state.activeLibrary = title;
        state.activeLibraryType = type;
        state.enrichmentProgress = null;
        state.page = 1;
        state.search = '';
        state.sortBy = null;
        state.sortDir = 'asc';
        state.expandedRow = null;
        state.columnFilters = {};
        state.quickFilters = _emptyQuickFilters();

        document.getElementById('searchSearch').value = '';
        document.getElementById('searchSearchClear').style.display = 'none';
        _resetQuickFilterUI();

        // CONSUME PENDING FILTER (SET BY navigateWithFilter) — APPLIED AFTER STATE RESET, BEFORE RENDER
        if (_pendingFilter && _pendingFilter.libraryTitle === title) {
            const { filterType, filterKey, filterValue } = _pendingFilter;
            _pendingFilter = null;
            _applyFilterSpec(filterType, filterKey, filterValue);
        }

        _updateTabStyles();

        await _loadColumns(type);
        _loadColumnPreferences(title);
        _loadColumnWidths(title);
        _loadColumnOrder(title);
        _loadMobileColumns(title);
        _loadColumnLabels(title);

        if (dataCache[title] && dataCache[title].enriched) {
            _applyView();
        } else if (dataCache[title]) {
            _applyView();
            if (!dataCache[title].enriched && dataCache[title].enrichmentRunning) {
                _startEnrichmentPolling(title);
            }
        } else {
            await _fetchLibrary(title, type);
            _applyView();
        }
    }

    async function _fetchLibrarySilent(title, type) {
        try {
            const colData = await api(`/search/columns/${type}`);
            const data = await api(`/search/library/${encodeURIComponent(title)}?all=true`);
            dataCache[title] = {
                items: data.items,
                type: data.libraryType,
                columns: colData.columns,
                enriched: data.enriched,
                enrichmentRunning: data.enrichmentRunning ?? false,
                cacheAge: data.cacheAge ?? null,
            };
            if (!data.enriched && data.enrichmentRunning) {
                _silentEnrichmentPoll(title);
            }
        } catch (err) {
            console.warn(`Search preload failed for '${title}':`, err);
        }
    }

    function _silentEnrichmentPoll(title) {
        const iv = setInterval(async () => {
            try {
                const result = await api(`/search/library/${encodeURIComponent(title)}/enrichment`);
                if (result.status === 'complete') {
                    clearInterval(iv);
                    if (result.items && result.items.length > 0) {
                        dataCache[title] = {
                            items: result.items,
                            type: dataCache[title]?.type,
                            columns: dataCache[title]?.columns,
                            enriched: true,
                        };
                    }
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
        const bar = document.getElementById('searchTabBar');
        bar.innerHTML = '';
        for (const lib of [...state.libraries].sort((a, b) => _tabOrder(a.title) - _tabOrder(b.title))) {
            const btn = document.createElement('button');
            btn.className = 'tab-item';
            btn.dataset.title = lib.title;
            btn.dataset.type = lib.type;
            btn.innerHTML = `${escapeHTML(lib.title)} <span class="tab-count">${lib.count.toLocaleString()}</span>`;
            btn.addEventListener('click', () => _switchLibrary(lib.title, lib.type));
            bar.appendChild(btn);
        }
    }

    function _updateTabStyles() {
        document.querySelectorAll('#searchTabBar .tab-item').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.title === state.activeLibrary);
        });
    }

    // --------------------------------------------------------
    // COLUMN MANAGEMENT
    // --------------------------------------------------------

    async function _loadColumns(type) {
        try {
            const data = await api(`/search/columns/${type}`);
            state.columns = data.columns;
        } catch {
            state.columns = [];
        }
    }

    function _loadColumnPreferences(title) {
        const saved = lsGetJSON(`${LS_PREFIX}cols_${title}`, null);
        if (Array.isArray(saved) && saved.length > 0) {
            state.visibleColumns = saved;
        } else {
            state.visibleColumns = state.columns.filter(c => c.default && !c.expandOnly).map(c => c.key);
        }
    }

    function _saveColumnPreferences() {
        lsSetJSON(`${LS_PREFIX}cols_${state.activeLibrary}`, state.visibleColumns);
    }

    function _loadColumnWidths(title) {
        const saved = lsGetJSON(`${LS_PREFIX}widths_${title}`, null);
        state.columnWidths = (saved && typeof saved === 'object' && !Array.isArray(saved)) ? saved : {};
    }

    function _saveColumnWidths() {
        lsSetJSON(`${LS_PREFIX}widths_${state.activeLibrary}`, state.columnWidths);
    }

    function _loadColumnOrder(title) {
        const saved = lsGetJSON(`${LS_PREFIX}order_${title}`, null);
        state.columnOrder = (Array.isArray(saved) && saved.length > 0) ? saved : [];
    }

    function _saveColumnOrder() {
        lsSetJSON(`${LS_PREFIX}order_${state.activeLibrary}`, state.columnOrder);
    }

    function _loadMobileColumns(title) {
        const saved = lsGetJSON(`${LS_PREFIX}mobile_${title}`, null);
        if (Array.isArray(saved) && saved.length > 0) {
            state.mobileColumns = saved;
            return;
        }
        const defaults = state.activeLibraryType === 'movie'
            ? ['title', 'year', 'durationFormatted', 'resolution']
            : ['title', 'year', 'seasons', 'episodes', 'dominantResolution'];
        state.mobileColumns = state.columns.filter(c => defaults.includes(c.key)).map(c => c.key);
    }

    function _saveMobileColumns() {
        lsSetJSON(`${LS_PREFIX}mobile_${state.activeLibrary}`, state.mobileColumns);
    }

    function _loadColumnLabels(title) {
        const saved = lsGetJSON(`${LS_PREFIX}labels_${title}`, null);
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
            if (saved.desktop !== undefined || saved.mobile !== undefined) {
                state.columnLabels = { desktop: saved.desktop || {}, mobile: saved.mobile || {} };
            } else {
                state.columnLabels = { desktop: saved, mobile: {} };
            }
        } else {
            state.columnLabels = { desktop: {}, mobile: {} };
        }
    }

    function _saveColumnLabels() {
        lsSetJSON(`${LS_PREFIX}labels_${state.activeLibrary}`, state.columnLabels);
    }

    function _getColLabel(col, isMobile) {
        if (col.key === 'rank') return '#';
        if (isMobile) return state.columnLabels.mobile[col.key] || SEARCH_MOBILE_LABELS[col.key] || col.label;
        return state.columnLabels.desktop[col.key] || col.label;
    }

    function _syncColumnOrder() {
        if (state.columnOrder.length === 0) return;
        const visibleKeys = state.columns.filter(c => !c.expandOnly && state.visibleColumns.includes(c.key)).map(c => c.key);
        state.columnOrder = state.columnOrder.filter(k => visibleKeys.includes(k));
        for (const k of visibleKeys) {
            if (!state.columnOrder.includes(k)) state.columnOrder.push(k);
        }
    }

    function _getOrderedVisibleCols() {
        const rankCol = { key: 'rank', label: '#', sortable: false };
        const vis = state.columns.filter(c => !c.expandOnly && state.visibleColumns.includes(c.key));
        if (state.columnOrder.length === 0) return [rankCol, ...vis];
        const ordered = [];
        for (const key of state.columnOrder) {
            const col = vis.find(c => c.key === key);
            if (col) ordered.push(col);
        }
        for (const col of vis) {
            if (!ordered.includes(col)) ordered.push(col);
        }
        return [rankCol, ...ordered];
    }

    function _renderColumnPicker() {
        const picker = document.getElementById('searchColumnPicker');
        const tableCols = state.columns.filter(c => !c.expandOnly);
        const hasLabels = Object.keys(state.columnLabels.desktop).length > 0 || Object.keys(state.columnLabels.mobile).length > 0;

        let html = '<div class="picker-col-header"><span>Desktop</span><span>Mobile</span><span title="Desktop">D</span><span title="Mobile">M</span></div>';
        html += '<div class="picker-list">';
        for (const col of tableCols) {
            const dChecked  = state.visibleColumns.includes(col.key) ? 'checked' : '';
            const mChecked  = state.mobileColumns.includes(col.key) ? 'checked' : '';
            const dDisabled = col.key === 'title' ? 'disabled' : '';
            const mDisabled = col.key === 'title' ? 'disabled' : '';
            const dCustom = state.columnLabels.desktop[col.key] || '';
            const mCustom = state.columnLabels.mobile[col.key] || '';
            const mPlaceholder = SEARCH_MOBILE_LABELS[col.key] || col.label;
            html += `<div class="picker-item picker-item--grid">
                <input type="text" class="picker-label-input" data-col="${col.key}" data-labeltype="desktop" value="${escapeHTML(dCustom)}" placeholder="${escapeHTML(col.label)}">
                <input type="text" class="picker-label-input picker-label-input--mobile" data-col="${col.key}" data-labeltype="mobile" value="${escapeHTML(mCustom)}" placeholder="${escapeHTML(mPlaceholder)}">
                <input type="checkbox" data-col="${col.key}" data-section="desktop" ${dChecked} ${dDisabled}>
                <input type="checkbox" data-col="${col.key}" data-section="mobile" ${mChecked} ${mDisabled}>
            </div>`;
        }
        html += '</div>';
        const orderedMobSearch = state.mobileColumns.map(k => tableCols.find(c => c.key === k)).filter(Boolean);
        if (orderedMobSearch.length > 0) {
            html += '<div class="picker-mobile-order"><div class="picker-order-header">Mobile Column Order</div><div class="picker-order-list">';
            orderedMobSearch.forEach(c => {
                const lbl = _getColLabel(c, true);
                html += `<div class="picker-order-item" draggable="true" data-col="${c.key}"><span class="picker-drag-handle">⠿</span><span>${escapeHTML(lbl)}</span></div>`;
            });
            html += '</div></div>';
        }
        html += '<div class="picker-footer">';
        html += '<div class="picker-footer-section"><span class="picker-footer-label">Desktop</span>';
        html += '<button class="btn btn-sm" id="searchDeskAll" title="Select All">All</button>';
        html += '<button class="btn btn-sm" id="searchDeskNone" title="Deselect All">None</button>';
        html += '<button class="btn btn-sm" id="searchDeskDefaults" title="Reset to defaults">↺</button></div>';
        html += '<div class="picker-footer-section"><span class="picker-footer-label">Mobile</span>';
        html += '<button class="btn btn-sm" id="searchMobAll" title="Select All">All</button>';
        html += '<button class="btn btn-sm" id="searchMobNone" title="Deselect All">None</button>';
        html += '<button class="btn btn-sm" id="searchMobDefaults" title="Reset to defaults">↺</button></div>';
        if (hasLabels) {
            html += '<div class="picker-footer-section"><button class="btn btn-sm" id="searchResetLabels" style="flex:1">Reset Label Names</button></div>';
        }
        html += '<div class="picker-footer-section picker-save-section"><button class="btn btn-sm btn-accent" id="searchSaveColumns" style="flex:1">Save</button></div>';
        html += '</div>';
        picker.innerHTML = html;

        // Mobile column order drag-and-drop
        const searchOrderList = picker.querySelector('.picker-order-list');
        if (searchOrderList) {
            let dragSrc = null;
            searchOrderList.querySelectorAll('.picker-order-item').forEach(item => {
                item.addEventListener('dragstart', e => {
                    dragSrc = item;
                    item.classList.add('dragging');
                    e.dataTransfer.effectAllowed = 'move';
                });
                item.addEventListener('dragend', () => {
                    item.classList.remove('dragging');
                    state.mobileColumns = [...searchOrderList.querySelectorAll('.picker-order-item')].map(i => i.dataset.col);
                    _saveColumnPreferences();
                    _renderTable();
                });
                item.addEventListener('dragover', e => {
                    e.preventDefault();
                    if (!dragSrc || item === dragSrc) return;
                    const { top, height } = item.getBoundingClientRect();
                    searchOrderList.insertBefore(dragSrc, e.clientY < top + height / 2 ? item : item.nextSibling);
                });
                item.addEventListener('dragenter', e => e.preventDefault());
            });
        }

        let labelDebounce = null;
        picker.querySelectorAll('.picker-label-input').forEach(input => {
            input.addEventListener('input', () => {
                clearTimeout(labelDebounce);
                labelDebounce = setTimeout(() => {
                    const colKey = input.dataset.col;
                    const labelType = input.dataset.labeltype;
                    const val = input.value.trim();
                    if (val) state.columnLabels[labelType][colKey] = val;
                    else delete state.columnLabels[labelType][colKey];
                    _saveColumnLabels();
                    _renderTable();
                    const footer = picker.querySelector('.picker-footer');
                    const nowHasLabels = Object.keys(state.columnLabels.desktop).length > 0 || Object.keys(state.columnLabels.mobile).length > 0;
                    const existing = document.getElementById('searchResetLabels');
                    if (nowHasLabels && !existing) {
                        const sec = document.createElement('div');
                        sec.className = 'picker-footer-section';
                        sec.innerHTML = '<button class="btn btn-sm" id="searchResetLabels" style="flex:1">Reset Label Names</button>';
                        footer.appendChild(sec);
                        sec.querySelector('button').addEventListener('click', () => {
                            state.columnLabels = { desktop: {}, mobile: {} };
                            _saveColumnLabels();
                            _renderTable();
                            _renderColumnPicker();
                        });
                    } else if (!nowHasLabels && existing) {
                        existing.closest('.picker-footer-section').remove();
                    }
                }, 250);
            });
        });

        picker.querySelectorAll('input[data-section="desktop"]').forEach(cb => {
            cb.addEventListener('change', () => {
                const colKey = cb.dataset.col;
                if (cb.checked) {
                    if (!state.visibleColumns.includes(colKey)) state.visibleColumns.push(colKey);
                } else {
                    state.visibleColumns = state.visibleColumns.filter(k => k !== colKey);
                    state.columnOrder = state.columnOrder.filter(k => k !== colKey);
                }
                _syncColumnOrder();
                _saveColumnPreferences();
                _saveColumnOrder();
                _renderTable();
            });
        });

        picker.querySelectorAll('input[data-section="mobile"]').forEach(cb => {
            cb.addEventListener('change', () => {
                const colKey = cb.dataset.col;
                if (cb.checked) {
                    if (!state.mobileColumns.includes(colKey)) state.mobileColumns.push(colKey);
                } else {
                    state.mobileColumns = state.mobileColumns.filter(k => k !== colKey);
                }
                _saveMobileColumns();
                if (_isMobile()) _renderTable();
            });
        });

        document.getElementById('searchDeskAll').addEventListener('click', () => {
            state.visibleColumns = tableCols.map(c => c.key);
            _syncColumnOrder();
            _saveColumnPreferences();
            _saveColumnOrder();
            _renderColumnPicker();
            _renderTable();
        });

        document.getElementById('searchDeskNone').addEventListener('click', () => {
            state.visibleColumns = ['title'];
            state.columnOrder = state.columnOrder.filter(k => k === 'title');
            _saveColumnPreferences();
            _saveColumnOrder();
            _renderColumnPicker();
            _renderTable();
        });

        document.getElementById('searchDeskDefaults').addEventListener('click', () => {
            state.visibleColumns = state.columns.filter(c => c.default && !c.expandOnly).map(c => c.key);
            state.columnOrder = [];
            _saveColumnPreferences();
            _saveColumnOrder();
            _renderColumnPicker();
            _renderTable();
        });

        const defaultMobileKeys = state.activeLibraryType === 'movie'
            ? ['title', 'year', 'durationFormatted', 'resolution']
            : ['title', 'year', 'seasons', 'episodes', 'dominantResolution'];

        document.getElementById('searchMobAll').addEventListener('click', () => {
            state.mobileColumns = tableCols.map(c => c.key);
            _saveMobileColumns();
            _renderColumnPicker();
            if (_isMobile()) _renderTable();
        });

        document.getElementById('searchMobNone').addEventListener('click', () => {
            state.mobileColumns = ['title'];
            _saveMobileColumns();
            _renderColumnPicker();
            if (_isMobile()) _renderTable();
        });

        document.getElementById('searchMobDefaults').addEventListener('click', () => {
            state.mobileColumns = state.columns.filter(c => defaultMobileKeys.includes(c.key)).map(c => c.key);
            _saveMobileColumns();
            _renderColumnPicker();
            if (_isMobile()) _renderTable();
        });

        const resetLabelsBtn = document.getElementById('searchResetLabels');
        if (resetLabelsBtn) {
            resetLabelsBtn.addEventListener('click', () => {
                state.columnLabels = { desktop: {}, mobile: {} };
                _saveColumnLabels();
                _renderTable();
                _renderColumnPicker();
            });
        }

        document.getElementById('searchSaveColumns').addEventListener('click', () => {
            state.columnPickerOpen = false;
            picker.style.display = 'none';
        });
    }

    // --------------------------------------------------------
    // DATA FETCHING
    // --------------------------------------------------------

    async function _fetchLibrary(title, type) {
        if (dataCache[title] && dataCache[title].enriched) return;

        _showLoading(true, 'Loading...');
        _hideError();
        _hideEmpty();

        try {
            const url = `/search/library/${encodeURIComponent(title)}?all=true`;
            const data = await api(url);
            dataCache[title] = { items: data.items, type: data.libraryType, enriched: data.enriched, enrichmentRunning: data.enrichmentRunning ?? false, cacheAge: data.cacheAge ?? null, needsSync: data.needsSync ?? false };
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
                const result = await api(`/search/library/${encodeURIComponent(title)}/enrichment`);

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
                        if (state.activeLibrary === title) {
                            _applyView();
                            const msg = dataCache[title]?.type === 'movie' ? 'All movies loaded' : 'Episode data loaded';
                            showToast(msg, 'info');
                        }
                    }
                } else if (result.status === 'error') {
                    _stopEnrichmentPolling();
                    state.enrichmentProgress = null;
                    _showEnrichmentBanner(false);
                    showToast('Failed to load episode data', 'error');
                } else if (result.progress && state.activeLibrary === title) {
                    state.enrichmentProgress = result.progress;
                    _showEnrichmentBanner(true, result.progress);
                    _renderPagination();
                }
            } catch (err) {
                console.warn('Search enrichment poll failed:', err);
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
        let banner = document.getElementById('searchEnrichmentBanner');

        if (show) {
            const msg = _formatEnrichmentMsg(progress, state.activeLibraryType);
            if (!banner) {
                banner = document.createElement('div');
                banner.id = 'searchEnrichmentBanner';
                banner.className = 'enrichment-banner';
                banner.innerHTML = `<div class="enrichment-spinner"></div><span>${msg}</span>`;
                const toolbar = document.getElementById('searchToolbar');
                toolbar.insertAdjacentElement('afterend', banner);
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
    // VIEW
    // --------------------------------------------------------

    function _applyView() {
        _hideError();
        _hideEmpty();

        const cached = dataCache[state.activeLibrary];
        if (!cached) { _showError('No data loaded.'); return; }

        let data = cached.items;

        if (state.search) {
            const q = state.search.toLowerCase();
            data = data.filter(item => {
                for (const v of Object.values(item)) {
                    if (typeof v === 'string' && v.toLowerCase().includes(q)) return true;
                    if (Array.isArray(v) && v.some(x => String(x).toLowerCase().includes(q))) return true;
                    if (typeof v === 'number' && String(v).includes(q)) return true;
                }
                return false;
            });
        }

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

        const total = data.length;

        if (state.sortBy && data.length > 0) {
            const colDef = state.columns.find(c => c.key === state.sortBy);
            const sortField = colDef?.sortKey || state.sortBy;
            const reverse = state.sortDir === 'desc';
            data = [...data].sort((a, b) => {
                let cmp = compareValues(a[sortField], b[sortField]);
                return reverse ? -cmp : cmp;
            });
        }

        for (let i = 0; i < data.length; i++) data[i] = { ...data[i], rank: i + 1 };

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
                const hasFilters = state.search || activeFilters.length > 0 || Object.values(state.quickFilters).some(v => !!v);
                _showEmpty(hasFilters ? 'No results match your filters.' : 'This library is empty.');
            }
            _renderPagination();
        } else {
            _renderTable();
            _renderPagination();
            _showTable();
        }
    }

    // --------------------------------------------------------
    // MOBILE HELPERS
    // --------------------------------------------------------

    function _isMobile() {
        return window.innerWidth <= 640;
    }

    function _getMobileColumns() {
        const rankCol = { key: 'rank', label: '#', sortable: false };
        return [rankCol, ...state.mobileColumns.map(k => state.columns.find(c => c.key === k)).filter(Boolean)];
    }

    // --------------------------------------------------------
    // TABLE RENDERING
    // --------------------------------------------------------

    function _renderTable() {
        const thead = document.getElementById('searchTableHead');
        const tbody = document.getElementById('searchTableBody');
        const table = document.getElementById('searchTable');

        const mobile = _isMobile();
        const visibleCols = mobile ? _getMobileColumns() : _getOrderedVisibleCols();
        const hasAnyWidth = Object.keys(state.columnWidths).length > 0;
        table.classList.toggle('resizable', hasAnyWidth);

        let headerHTML = '<tr><th class="expand-col"></th>';
        for (const col of visibleCols) {
            const isSorted = state.sortBy === col.key;
            const sortClass = isSorted ? `sorted-${state.sortDir}` : '';
            const sortableClass = col.sortable ? 'sortable' : '';
            const _fv = state.columnFilters[col.key];
            const hasFilter = _fv instanceof Set ? _fv.size > 0 : !!_fv;
            const filterActiveClass = hasFilter ? 'active' : '';
            const colLabel = _getColLabel(col, mobile);
            const widthStyle = state.columnWidths[col.key]
                ? `width:${state.columnWidths[col.key]}px;`
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

        thead.querySelectorAll('th.sortable').forEach(th => {
            th.addEventListener('click', (e) => {
                if (isResizing || e.target.closest('.col-filter-btn') || e.target.closest('.resize-handle')) return;
                const col = th.dataset.col;
                if (state.sortBy === col) {
                    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
                    if (state.sortDir === 'asc' && state.sortBy === col) { state.sortBy = null; }
                } else {
                    state.sortBy = col; state.sortDir = 'asc';
                }
                state.page = 1; state.expandedRow = null;
                _applyView();
            });
        });

        thead.querySelectorAll('.col-filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                _toggleColumnFilter(btn, btn.dataset.col);
            });
        });

        _initResizeHandles(thead);
        _initColumnDrag(thead);

        let bodyHTML = '';
        for (let i = 0; i < state.items.length; i++) {
            const item = state.items[i];
            const isExpanded = state.expandedRow === i;
            const globalRowNum = (state.page - 1) * state.perPage + i + 1;
            bodyHTML += `<tr class="data-row ${isExpanded ? 'expanded' : ''}" data-index="${i}">`;
            bodyHTML += `<td class="expand-col"><span class="expand-icon">${isExpanded ? '\u25BC' : '\u25B6'}</span></td>`;
            for (const col of visibleCols) {
                const rankClass = col.key === 'rank' ? ' class="row-num-col"' : '';
                bodyHTML += `<td${rankClass} data-col="${col.key}">${_formatCell(col.key, item[col.key], item)}</td>`;
            }
            bodyHTML += '</tr>';

            if (isExpanded) {
                bodyHTML += `<tr class="detail-row"><td colspan="${visibleCols.length + 1}">`;
                bodyHTML += _renderDetail(item, state.activeLibraryType);
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
    // COLUMN FILTER DROPDOWN
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

    // --------------------------------------------------------
    // RESIZE & DRAG
    // --------------------------------------------------------

    function _initResizeHandles(thead) {
        thead.querySelectorAll('.resize-handle').forEach(handle => {
            handle.addEventListener('mousedown', (e) => {
                e.preventDefault(); e.stopPropagation();
                isResizing = true;
                const th = handle.closest('th');
                const colKey = handle.dataset.col;
                const startX = e.pageX;
                const startWidth = th.offsetWidth;
                const table = document.getElementById('searchTable');
                table.classList.add('resizable');
                thead.querySelectorAll('th[data-col]').forEach(t => {
                    if (!t.style.width) t.style.width = t.offsetWidth + 'px';
                });

                function onMove(e) {
                    const minW = colKey === 'rank' ? 16 : 50;
                    const newW = Math.max(minW, startWidth + e.pageX - startX);
                    th.style.width = newW + 'px';
                    state.columnWidths[colKey] = newW;
                }
                function onUp() {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                    _saveColumnWidths();
                    setTimeout(() => { isResizing = false; }, 0);
                }
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        });
    }

    function _initColumnDrag(thead) {
        let dragColKey = null;
        const table = thead.closest('table');

        thead.querySelectorAll('th[data-col]').forEach(th => {
            th.addEventListener('dragstart', (e) => {
                if (e.target.closest('.resize-handle')) { e.preventDefault(); return; }
                dragColKey = th.dataset.col;

                // Styled ghost element for the drag cursor
                const labelText = th.querySelector('.th-label')?.textContent?.trim() || th.dataset.col;
                const ghost = document.createElement('div');
                ghost.className = 'col-drag-ghost';
                ghost.innerHTML = `<span class="col-drag-ghost-icon">⠿</span><span>${labelText}</span>`;
                document.body.appendChild(ghost);
                e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
                requestAnimationFrame(() => ghost.remove());

                th.classList.add('col-drag-source');
                table?.classList.add('col-drag-active');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', dragColKey);
            });

            th.addEventListener('dragend', () => {
                dragColKey = null;
                table?.classList.remove('col-drag-active');
                thead.querySelectorAll('th').forEach(t => t.classList.remove('col-drag-source', 'drop-before', 'drop-after'));
            });

            th.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (!dragColKey || th.dataset.col === dragColKey) return;
                const rect = th.getBoundingClientRect();
                const insertAfter = e.clientX > rect.left + rect.width / 2;
                thead.querySelectorAll('th').forEach(t => t.classList.remove('drop-before', 'drop-after'));
                th.classList.add(insertAfter ? 'drop-after' : 'drop-before');
            });

            th.addEventListener('dragleave', (e) => {
                if (!th.contains(e.relatedTarget)) {
                    th.classList.remove('drop-before', 'drop-after');
                }
            });

            th.addEventListener('drop', (e) => {
                e.preventDefault();
                const insertAfter = th.classList.contains('drop-after');
                table?.classList.remove('col-drag-active');
                thead.querySelectorAll('th').forEach(t => t.classList.remove('col-drag-source', 'drop-before', 'drop-after'));

                const fromKey = e.dataTransfer.getData('text/plain');
                const toKey = th.dataset.col;
                if (!fromKey || fromKey === toKey) return;

                const keys = _getOrderedVisibleCols().map(c => c.key);
                const fi = keys.indexOf(fromKey);
                if (fi === -1) return;
                keys.splice(fi, 1);
                const newTi = keys.indexOf(toKey);
                if (newTi === -1) return;
                keys.splice(insertAfter ? newTi + 1 : newTi, 0, fromKey);

                state.columnOrder = keys;
                _saveColumnOrder();
                _renderTable();

                // Flash the newly placed column after re-render
                setTimeout(() => {
                    const landed = document.querySelector(`th[data-col="${fromKey}"]`);
                    if (landed) {
                        landed.classList.add('drop-flash');
                        landed.addEventListener('animationend', () => landed.classList.remove('drop-flash'), { once: true });
                    }
                }, 16);
            });
        });
    }

    // --------------------------------------------------------
    // CELL FORMATTING
    // --------------------------------------------------------

    function _formatCell(key, value, item) {
        if (value === null || value === undefined) return '<span class="text-muted">-</span>';

        switch (key) {
            case 'rank':
                return `<span class="row-num text-muted">${value}</span>`;

            case 'genres':
                if (Array.isArray(value) && value.length > 0)
                    return value.map(g => `<span class="genre-tag">${escapeHTML(g)}</span>`).join('');
                return '<span class="text-muted">-</span>';

            case 'rating':
            case 'audienceRating':
                return _renderRating(value);

            case 'resolution':
            case 'dominantResolution':
                return _renderResolution(value);

            case 'fileSizeFormatted':
                return _renderFileSize(value, item);

            case 'watchStatus':
                if (value === 'Watched') return '<span class="badge badge-success">Watched</span>';
                if (value === 'In Progress') return '<span class="badge badge-warning">In Progress</span>';
                return '<span class="badge badge-muted">Unwatched</span>';

            case 'showStatus':
                if (value === 'Returning') return '<span class="badge badge-warning">Returning</span>';
                if (value === 'Airing')    return '<span class="badge badge-success">Airing</span>';
                if (value === 'Canceled')  return '<span class="badge badge-error">Canceled</span>';
                if (value === 'Finished')  return '<span class="badge badge-info">Finished</span>';
                return '<span class="badge badge-muted">Unknown</span>';

            case 'watchProgress':
                return _renderProgress(item.watchProgressPercent, value);

            case 'isWatched':
                return value ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-muted">No</span>';

            default:
                return escapeHTML(String(value));
        }
    }

    function _renderRating(val) {
        if (val == null) return '<span class="text-muted">-</span>';
        let cls = val >= 7.5 ? 'rating-high' : val < 5 ? 'rating-low' : 'rating-mid';
        return `<span class="rating-badge ${cls}">${val}</span>`;
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

    function _renderFileSize(val, item) {
        if (!val) return '<span class="text-muted">-</span>';
        const bytes = item.fileSize || 0;
        const res = String(item.resolution || '').toLowerCase();
        const GB = 1024 ** 3;
        const isRed = ((res === '1080' || res === '1080p') && bytes >= 5 * GB) ||
                      ((res === '720'  || res === '720p')  && bytes >= 1.5 * GB);
        return isRed ? `<span style="color:var(--error);font-weight:600">${escapeHTML(val)}</span>` : escapeHTML(val);
    }

    function _renderProgress(percent, text) {
        if (percent == null) return '<span class="text-muted">-</span>';
        return `<div class="progress-bar-container">
            <div class="progress-bar"><div class="progress-bar-fill" style="width:${Math.min(100, percent)}%"></div></div>
            <span class="progress-text">${text}</span>
        </div>`;
    }

    // --------------------------------------------------------
    // DETAIL ROW
    // --------------------------------------------------------

    function _renderDetail(item, libraryType) {
        let html = '<div class="detail-content">';

        if (item.summary) {
            html += `<div class="detail-section"><h4>Summary</h4><p class="summary-text">${escapeHTML(item.summary)}</p></div>`;
        }

        if (libraryType === 'movie') {
            html += '<div class="detail-section"><h4>Technical Details</h4><div class="detail-grid">';
            html += _detailItem('Studio', item.studio);
            html += _detailItem('Video Codec', item.videoCodec);
            html += _detailItem('Audio Codec', item.audioCodec);
            html += _detailItem('Audio Channels', item.audioChannelsFormatted);
            html += _detailItem('Bitrate', item.bitrateFormatted);
            html += _detailItem('Container', item.container);
            html += _detailItem('File Size', item.fileSizeFormatted);
            html += _detailItem('Resolution', item.resolution);
            html += _detailItem('Duration', item.durationFormatted);
            html += _detailItem('Content Rating', item.contentRating);
            html += _detailItem('Play Count', item.playCount);
            html += _detailItem('Last Played', item.lastPlayedAtFormatted);
            html += _detailItem('Added', item.addedAtFormatted);
            html += '</div></div>';

            if (item.filePath) {
                html += `<div class="detail-section"><h4>File Path</h4><p class="summary-text" style="font-family:monospace;font-size:0.75rem;">${escapeHTML(item.filePath)}</p></div>`;
            }

            if (item.subtitles && item.subtitles.length > 0) {
                html += '<div class="detail-section"><h4>Subtitles</h4><div class="subtitle-list">';
                for (const sub of item.subtitles) {
                    let label = escapeHTML(sub.language);
                    if (sub.codec) label += ` (${escapeHTML(sub.codec)})`;
                    if (sub.forced) label += ' [Forced]';
                    if (sub.external) label += ' [EXT]';
                    html += `<span class="subtitle-tag">${label}</span>`;
                }
                html += '</div></div>';
            }
        } else {
            html += '<div class="detail-section"><h4>Details</h4><div class="detail-grid">';
            html += _detailItem('Studio', item.studio);
            html += _detailItem('Content Rating', item.contentRating);
            html += _detailItem('Seasons', item.seasons);
            html += _detailItem('Total Episodes', item.episodes);
            html += _detailItem('Watched Episodes', item.watchedEpisodes);
            html += _detailItem('Unwatched Episodes', item.unwatchedEpisodes);
            html += _detailItem('Total Size', item.totalSizeFormatted);
            html += _detailItem('Total Duration', item.totalDurationFormatted);
            html += _detailItem('Added', item.addedAtFormatted);
            html += _detailItem('Last Played', item.lastPlayedAtFormatted);
            html += '</div></div>';

            if (item.filePath) {
                html += `<div class="detail-section"><h4>File Path</h4><p class="summary-text" style="font-family:monospace;font-size:0.75rem;">${escapeHTML(item.filePath)}</p></div>`;
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
    // MOBILE DETAIL PANEL
    // --------------------------------------------------------

    function _openMobilePanel(item) {
        const panel = document.getElementById('mobileDetailPanel');
        if (!panel) return;

        document.getElementById('mobilePanelTitle').textContent = item.title || '—';

        const metaParts = [];
        if (item.year) metaParts.push(String(item.year));
        if (state.activeLibraryType === 'movie') {
            if (item.durationFormatted) metaParts.push(item.durationFormatted);
            if (item.resolution) metaParts.push(String(item.resolution).toUpperCase());
        } else {
            if (item.episodes) metaParts.push(`${item.episodes} eps`);
            if (item.dominantResolution) metaParts.push(item.dominantResolution);
        }
        const metaEl = document.getElementById('mobilePanelMeta');
        metaEl.innerHTML = metaParts.map(p => `<span>${escapeHTML(p)}</span>`).join('<span style="color:var(--border-light)">·</span>');

        document.getElementById('mobilePanelBody').innerHTML = _buildMobilePanelContent(item);

        panel.classList.add('open');
        document.body.style.overflow = 'hidden';

        document.getElementById('mobilePanelBackdrop').onclick = _closeMobilePanel;
        document.getElementById('mobilePanelClose').onclick = _closeMobilePanel;

        // Swipe-to-close: drag the sheet down to dismiss
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
                if (dy <= 0) return;                        // upward swipe — ignore
                if (body && body.scrollTop > 0) return;    // content not at top — let it scroll
                dragActive = true;
                sheet.style.transition = 'none';
            }
            e.preventDefault(); // block browser pull-to-refresh while dragging sheet
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

    function _buildMobilePanelContent(item) {
        const e = escapeHTML;
        const val = v => (v != null && v !== '') ? e(String(v)) : '<span class="text-muted">—</span>';
        const panelItem = (label, value) =>
            `<div class="mobile-panel-item"><span class="label">${e(label)}</span><span class="value">${val(value)}</span></div>`;

        let html = '';

        if (item.summary) {
            html += `<div class="mobile-panel-section">
                <div class="mobile-panel-section-title">Summary</div>
                <p class="mobile-panel-summary">${e(item.summary)}</p>
            </div>`;
        }

        if (state.activeLibraryType === 'movie') {
            const pairs = [
                ['Duration',      item.durationFormatted],
                ['Resolution',    item.resolution],
                ['File Size',     item.fileSizeFormatted],
                ['Content Rating',item.contentRating],
                ['Studio',        item.studio],
                ['Video Codec',   item.videoCodec],
                ['Audio',         item.audioChannelsFormatted],
                ['Container',     item.container],
                ['Added',         item.addedAtFormatted],
                ['Last Played',   item.lastPlayedAtFormatted],
                ['Play Count',    item.playCount != null ? item.playCount : null],
            ].filter(([, v]) => v != null && v !== '');

            if (pairs.length) {
                html += `<div class="mobile-panel-section">
                    <div class="mobile-panel-section-title">Details</div>
                    <div class="mobile-panel-grid">${pairs.map(([l, v]) => panelItem(l, v)).join('')}</div>
                </div>`;
            }

            if (item.rating != null || item.audienceRating != null) {
                html += `<div class="mobile-panel-section">
                    <div class="mobile-panel-section-title">Ratings</div>
                    <div class="mobile-panel-grid">`;
                if (item.rating != null)         html += `<div class="mobile-panel-item"><span class="label">Critic</span><span class="value">${_renderRating(item.rating)}</span></div>`;
                if (item.audienceRating != null)  html += `<div class="mobile-panel-item"><span class="label">Audience</span><span class="value">${_renderRating(item.audienceRating)}</span></div>`;
                html += `</div></div>`;
            }

            if (item.genres && item.genres.length) {
                html += `<div class="mobile-panel-section">
                    <div class="mobile-panel-section-title">Genres</div>
                    <div class="mobile-panel-badges">${item.genres.map(g => `<span class="genre-tag">${e(g)}</span>`).join('')}</div>
                </div>`;
            }

            if (item.subtitles && item.subtitles.length) {
                html += `<div class="mobile-panel-section">
                    <div class="mobile-panel-section-title">Subtitles</div>
                    <div class="mobile-panel-badges">`;
                for (const sub of item.subtitles) {
                    let lbl = e(sub.language);
                    if (sub.codec) lbl += ` (${e(sub.codec)})`;
                    if (sub.forced) lbl += ' [F]';
                    html += `<span class="subtitle-tag">${lbl}</span>`;
                }
                html += `</div></div>`;
            }

        } else {
            // SHOW
            const pairs = [
                ['Seasons',        item.seasons],
                ['Episodes',       item.episodes],
                ['Watched',        item.watchedEpisodes],
                ['Unwatched',      item.unwatchedEpisodes],
                ['Total Size',     item.totalSizeFormatted],
                ['Total Duration', item.totalDurationFormatted],
                ['Content Rating', item.contentRating],
                ['Studio',         item.studio],
                ['Added',          item.addedAtFormatted],
                ['Last Played',    item.lastPlayedAtFormatted],
            ].filter(([, v]) => v != null && v !== '');

            if (pairs.length) {
                html += `<div class="mobile-panel-section">
                    <div class="mobile-panel-section-title">Details</div>
                    <div class="mobile-panel-grid">${pairs.map(([l, v]) => panelItem(l, v)).join('')}</div>
                </div>`;
            }

            if (item.watchStatus || item.showStatus) {
                html += `<div class="mobile-panel-section">
                    <div class="mobile-panel-section-title">Status</div>
                    <div class="mobile-panel-badges">
                        ${item.watchStatus ? _formatCell('watchStatus', item.watchStatus, item) : ''}
                        ${item.showStatus  ? _formatCell('showStatus',  item.showStatus,  item) : ''}
                    </div>
                </div>`;
            }

            if (item.watchProgressPercent != null) {
                html += `<div class="mobile-panel-section">
                    <div class="mobile-panel-section-title">Watch Progress</div>
                    ${_renderProgress(item.watchProgressPercent, item.watchProgress)}
                </div>`;
            }

            if (item.genres && item.genres.length) {
                html += `<div class="mobile-panel-section">
                    <div class="mobile-panel-section-title">Genres</div>
                    <div class="mobile-panel-badges">${item.genres.map(g => `<span class="genre-tag">${e(g)}</span>`).join('')}</div>
                </div>`;
            }

            if (item.seasonSizes && item.seasonSizes.length) {
                html += _renderSizeBreakdown(item);
            }
        }

        if (item.filePath) {
            html += `<div class="mobile-panel-section">
                <div class="mobile-panel-section-title">File Path</div>
                <p style="font-family:monospace;font-size:0.72rem;color:var(--text-muted);word-break:break-all;line-height:1.5;">${e(item.filePath)}</p>
            </div>`;
        }

        return html;
    }

    // --------------------------------------------------------
    // PAGINATION
    // --------------------------------------------------------

    function _renderPagination() {
        const bar = document.getElementById('searchPaginationBar');
        if (state.totalItems === 0) { bar.style.display = 'none'; return; }

        bar.style.display = 'flex';
        const typeLabel = state.activeLibraryType === 'movie' ? 'movies' : 'shows';
        const start = (state.page - 1) * state.perPage + 1;
        const end = Math.min(state.page * state.perPage, state.totalItems);
        const cached = dataCache[state.activeLibrary];
        const isPartial = cached && !cached.enriched;
        let syncInfo = '';
        if (isPartial) {
            const p = state.enrichmentProgress;
            if (p && p.current > 0 && p.total > 0) {
                syncInfo = ` \u00b7 <span class="badge badge-info">Syncing: ${p.current.toLocaleString()} / ${p.total.toLocaleString()} shows</span>`;
            } else if (p && p.step) {
                syncInfo = ` \u00b7 <span class="badge badge-info">${escapeHTML(p.step)}</span>`;
            } else {
                syncInfo = ` \u00b7 <span class="badge badge-info">Loading episode data\u2026</span>`;
            }
        }
        const totalDisplay = `${state.totalItems.toLocaleString()}${isPartial ? '+' : ''} ${typeLabel}${syncInfo}`;

        bar.innerHTML = `
            <div class="pagination-info">${start.toLocaleString()}-${end.toLocaleString()} of ${totalDisplay}</div>
            <div class="pagination-controls">
                <button class="btn btn-sm" id="searchPrevPage" ${state.page <= 1 ? 'disabled' : ''}>\u2190 Previous</button>
                <span class="page-indicator">Page ${state.page} of ${state.totalPages || 1}</span>
                <button class="btn btn-sm" id="searchNextPage" ${state.page >= state.totalPages ? 'disabled' : ''}>Next \u2192</button>
            </div>
        `;

        document.getElementById('searchPrevPage').addEventListener('click', () => {
            if (state.page > 1) { state.page--; state.expandedRow = null; _applyView(); }
        });
        document.getElementById('searchNextPage').addEventListener('click', () => {
            if (state.page < state.totalPages) { state.page++; state.expandedRow = null; _applyView(); }
        });
    }

    // --------------------------------------------------------
    // UI STATE HELPERS
    // --------------------------------------------------------

    function _showLoading(show, message) {
        const el = document.getElementById('searchLoading');
        el.style.display = show ? 'flex' : 'none';
        if (show && message) el.querySelector('.state-text').textContent = message;
        if (show) _hideTable();
    }

    function _showError(message) {
        document.getElementById('searchError').style.display = 'flex';
        document.getElementById('searchErrorMsg').textContent = message;
        _hideTable();
        document.getElementById('searchPaginationBar').style.display = 'none';
    }

    function _hideError() { document.getElementById('searchError').style.display = 'none'; }

    function _showEmpty(message) {
        document.getElementById('searchEmpty').style.display = 'flex';
        document.getElementById('searchEmptyMsg').textContent = message;
    }

    function _hideEmpty() { document.getElementById('searchEmpty').style.display = 'none'; }
    function _showTable() { document.getElementById('searchTableWrapper').style.display = 'block'; }
    function _hideTable() { document.getElementById('searchTableWrapper').style.display = 'none'; }

    // --------------------------------------------------------
    // PUBLIC API
    // --------------------------------------------------------

    function invalidateCache() {
        for (const key of Object.keys(dataCache)) delete dataCache[key];
        _stopEnrichmentPolling();
    }

    async function refreshActive() {
        if (state.activeLibrary) {
            delete dataCache[state.activeLibrary];
            await _fetchLibrary(state.activeLibrary, state.activeLibraryType);
            _applyView();
        }
    }

    // NAVIGATE TO SEARCH AND PRE-APPLY A FILTER
    // FILTERSPEC: { filterType: 'picklist'|'text'|'quick'|'function', filterKey: string, filterValue: * }
    function navigateWithFilter(libraryTitle, filterSpec) {
        // IF SEARCH IS ALREADY SHOWING THE CORRECT LIBRARY, APPLY FILTER IMMEDIATELY
        if (state.activeLibrary === libraryTitle) {
            state.columnFilters = {};
            state.quickFilters = _emptyQuickFilters();
            _resetQuickFilterUI();
            _applyFilterSpec(filterSpec.filterType, filterSpec.filterKey, filterSpec.filterValue);
            state.page = 1;
            state.expandedRow = null;
            _applyView();
            window.location.hash = '#search';
            return;
        }
        // STORE PENDING FILTER — _switchLibrary WILL CONSUME IT AFTER ITS STATE RESET
        _pendingFilter = { libraryTitle, ...filterSpec };
        // IF SEARCH HAS LOADED ITS LIBRARY LIST, SWITCH TO THE TARGET LIBRARY
        const lib = state.libraries.find(l => l.title === libraryTitle);
        if (lib) {
            window.location.hash = '#search';
            _switchLibrary(lib.title, lib.type);
            return;
        }
        // SEARCH NOT YET INITIALIZED — NAVIGATE AND LET init() CONSUME THE PENDING FILTER
        window.location.hash = '#search';
    }

    return { init, retry, invalidateCache, refreshActive, navigateWithFilter };
})();

