// ############################################
// # HEALTH PAGE — FILE HEALTH SCANNER        #
// ############################################

const HealthDash = (() => {
    'use strict';

    //======
    // STATE
    //======
    const state = {
        items: [],
        libraries: [],
        libraryCounts: {},
        activeLibrary: '',
        search: '',
        filter: 'scanned',  // all | scanned | issues | healthy | pending
        sortCol: 'addedAt',
        sortDir: 'desc',
        page: 1,
        perPage: 50,
        totalItems: 0,
        totalPages: 0,
        expandedRow: null,
        quickScannedAt: null,
        fullScannedAt: null,
        retainedResultCount: 0,
        issueLabels: {},
        mediaMissing: false,
        scanning: false,
        activeHealthRun: null,
        interruptedRun: null,
        progressInterval: null,
        refreshingLibrary: null,
        refreshingLabel: '',
        refreshingButton: null,
        hasScanned: false,
        _searchTimer: null,
        _columnViewKey: null,
        _remoteColumnViewKey: null,
    };

    const STALE_DAYS = 7;
    const LS_PREFIX = 'mediadash_health_';

    const HEALTH_COLUMNS = [
        { key: 'rank',            label: '#',        mobileLabel: '#',    sortable: false },
        { key: 'title',           label: 'Title',    mobileLabel: 'Title', sortable: true,  default: true },
        { key: 'library',         label: 'Library',  mobileLabel: 'Lib',   sortable: true,  default: true },
        { key: 'fileSize',        label: 'Size',     mobileLabel: 'Size',  sortable: true,  default: true },
        { key: 'zero_byte',       label: 'Size OK',  mobileLabel: 'Size',  sortable: true,  default: true, title: 'File is not empty or suspiciously small' },
        { key: 'unreadable',      label: 'Readable', mobileLabel: 'Read',  sortable: true,  default: true, title: 'Container can be parsed by ffprobe' },
        { key: 'zero_duration',   label: 'Duration', mobileLabel: 'Dur',   sortable: true,  default: true, title: 'Stream reports a valid non-zero duration' },
        { key: 'no_video_stream', label: 'Video',    mobileLabel: 'Vid',   sortable: true,  default: true, title: 'File contains a video track' },
        { key: 'no_audio_stream', label: 'Audio',    mobileLabel: 'Aud',   sortable: true,  default: true, title: 'File contains an audio track' },
        { key: 'scannedAt',       label: 'Scanned',  mobileLabel: 'Scan',  sortable: true,  default: true },
    ];

    const HEALTH_MOBILE_LABELS = Object.fromEntries(
        HEALTH_COLUMNS
            .filter(c => c.mobileLabel)
            .map(c => [c.key, c.mobileLabel])
    );

    const CHECK_COLUMNS = new Set(['zero_byte', 'unreadable', 'zero_duration', 'no_video_stream', 'no_audio_stream']);

    //=================
    // RENDER UTILITIES
    //=================
    function formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
    }

    function formatRelativeDate(iso) {
        if (!iso) return '';
        try {
            const d = new Date(iso);
            const now = new Date();
            const diff = Math.floor((now - d) / 1000);
            if (diff < 60)   return 'just now';
            if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
            if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
            const days = Math.floor(diff / 86400);
            if (days === 1) return 'yesterday';
            if (days < 30)  return days + ' days ago';
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        } catch (e) {
            return '';
        }
    }

    function isStale(iso) {
        if (!iso) return false;
        try {
            const d = new Date(iso);
            const diff = (new Date() - d) / 86400000;
            return diff > STALE_DAYS;
        } catch (e) {
            return false;
        }
    }

    //==================
    // CHECK CELL RENDER
    //==================
    function renderCheckCell(value) {
        if (value === null || value === undefined) {
            return '<td class="hc-cell hc-cell--pending" title="Not yet scanned">—</td>';
        }
        if (value === true) {
            return '<td class="hc-cell hc-cell--pass" title="Passed"><span class="hc-status-badge">' + statusBadge(true) + '</span></td>';
        }
        return '<td class="hc-cell hc-cell--fail" title="Failed"><span class="hc-status-badge">' + statusBadge(false) + '</span></td>';
    }

    //==================
    // RENDER META PANEL
    //==================
    function renderMetaPanel(data) {
        //Quick SCAN TILE
        const qPrimary = document.getElementById('healthMetaQuickPrimary');
        const qSub     = document.getElementById('healthMetaQuickSub');
        const qBadge   = document.getElementById('healthMetaQuickBadge');
        const coverageExtra = document.getElementById('healthMetaCoverageExtra');

        const retained = data.retained_result_count ?? state.retainedResultCount ?? 0;
        const activeRun = data.active_health_run || null;
        const interruptedRun = data.interrupted_health_run || state.interruptedRun || null;
        const totalUnscanned = data.total_unscanned || 0;
        const unscannedByLib = data.unscanned_by_library || {};
        if (state.quickScannedAt || retained > 0) {
            const total  = data.retained_result_count ?? data.quick_total_scanned;
            const issues = (data.stats || {}).issues || 0;
            if (qPrimary) qPrimary.textContent = (total != null ? total.toLocaleString() : '?') + ' files scanned';
            if (qSub) {
                if (activeRun) {
                    qSub.textContent = 'Scan in progress · completed files appear below';
                } else if (interruptedRun) {
                    const done  = interruptedRun.completed_count;
                    const rTotal = interruptedRun.target_total;
                    const progress = (done != null && rTotal)
                        ? ' at ' + done.toLocaleString() + ' / ' + rTotal.toLocaleString() + ' files'
                        : '';
                    qSub.textContent = 'Scan interrupted' + progress + ' · will resume automatically';
                } else {
                    const scanLabel = state.fullScannedAt ? 'Full baseline ' + formatRelativeDate(state.fullScannedAt) : 'Last scan ' + formatRelativeDate(state.quickScannedAt);
                    qSub.textContent = scanLabel + ' · retained until rescan';
                }
            }
            if (qBadge) {
                if (activeRun) {
                    qBadge.textContent = 'Scanning';
                    qBadge.className   = 'health-meta-badge health-meta-badge--warn';
                } else if (interruptedRun) {
                    qBadge.textContent = 'Paused';
                    qBadge.className   = 'health-meta-badge health-meta-badge--warn';
                } else if (issues > 0) {
                    qBadge.textContent = issues + ' issue' + (issues !== 1 ? 's' : '');
                    qBadge.className   = 'health-meta-badge health-meta-badge--warn';
                } else {
                    qBadge.textContent = 'Clean';
                    qBadge.className   = 'health-meta-badge health-meta-badge--ok';
                }
            }
        } else {
            if (qPrimary) qPrimary.textContent = 'Never run';
            if (qSub)     qSub.textContent     = 'Run Scan New to check unscanned files';
            if (qBadge)  { qBadge.textContent  = ''; qBadge.className = 'health-meta-badge'; }
        }

        if (coverageExtra) {
            if (totalUnscanned > 0) {
                const parts = Object.entries(unscannedByLib)
                    .sort((a, b) => b[1] - a[1])
                    .map(([lib, n]) => n.toLocaleString() + ' ' + lib);
                const breakdown = parts.length ? ' · ' + parts.join(' · ') : '';
                coverageExtra.textContent = totalUnscanned.toLocaleString() + ' not yet scanned' + breakdown;
                coverageExtra.className = 'health-meta-coverage-extra health-meta-coverage-extra--warn';
            } else {
                coverageExtra.textContent = 'All files scanned';
                coverageExtra.className = 'health-meta-coverage-extra health-meta-coverage-extra--ok';
            }
        }

        renderLatestRows('healthMetaLatestRows', data.latest_added, 'addedAt', 'No items found');
        renderLatestRows('healthMetaScannedRows', data.latest_scanned, 'scannedAt', 'No scans yet');
    }

    function renderLatestRows(elementId, payload, dateKey, emptyText) {
        const rowsEl = document.getElementById(elementId);
        const byLib = (payload || {}).by_library || {};
        if (!rowsEl) return;

        const libOrder = ['Movies', 'Shows', 'Animes'];
        const libs = libOrder.filter(l => byLib[l])
            .concat(Object.keys(byLib).filter(l => !libOrder.includes(l)).sort());
        if (libs.length === 0) {
            rowsEl.innerHTML = '<span style="color:var(--text-muted);font-size:0.8rem;">' + escapeHTML(emptyText) + '</span>';
            return;
        }

        rowsEl.innerHTML = libs.map(lib => {
            const it = byLib[lib] || {};
            const name = escapeHTML(it.title || 'Unknown media') + (it.year ? ' <span class="hlr-year">(' + escapeHTML(it.year) + ')</span>' : '');
            const when = formatRelativeDate(it[dateKey]);
            const titleAttr = it.filePath ? ' title="' + escapeHTML(it.filePath) + '"' : '';
            return '<div class="health-latest-row"' + titleAttr + '>' +
                '<span class="hlr-lib">' + escapeHTML(lib) + '</span>' +
                '<span class="hlr-title">' + name + '</span>' +
                '<span class="hlr-when">' + escapeHTML(when) + '</span>' +
                '</div>';
        }).join('');
    }

    //=================
    // RENDER STATS BAR
    //=================
    function renderStatsBar(data) {
        const bar = document.getElementById('healthStatsBar');
        if (!bar) return;
        const stats = data.stats || {};
        const total   = stats.total   || 0;
        const issues  = stats.issues  || 0;
        const healthy = stats.healthy || 0;
        const pending = stats.pending || 0;

        if (!state.hasScanned) {
            bar.style.display = 'none';
            return;
        }

        bar.style.display = '';
        bar.innerHTML = [
            '<span class="health-stats-item">',
            '  <span class="health-stats-dot" style="background:var(--text-muted)"></span>',
            '  <strong>' + total.toLocaleString() + '</strong>&nbsp;total',
            '</span>',
            '<span class="health-stats-item">',
            '  <span class="health-stats-dot health-stats-dot--issue"></span>',
            '  <strong>' + issues.toLocaleString() + '</strong>&nbsp;with issues',
            '</span>',
            '<span class="health-stats-item">',
            '  <span class="health-stats-dot health-stats-dot--ok"></span>',
            '  <strong>' + healthy.toLocaleString() + '</strong>&nbsp;healthy',
            '</span>',
            '<span class="health-stats-item">',
            '  <span class="health-stats-dot health-stats-dot--pending"></span>',
            '  <strong>' + pending.toLocaleString() + '</strong>&nbsp;pending',
            '</span>',
        ].join('');
    }

    //========================
    // RENDER TABS (LIBRARIES)
    //========================
    function tabOrder(title) {
        const t = String(title || '').toLowerCase();
        if (t.includes('movie')) return 0;
        if (t.includes('show')) return 1;
        if (t.includes('anime')) return 2;
        return 3;
    }

    function normalizeLibraries(libraries) {
        return [...new Set(libraries || [])].sort((a, b) => {
            const orderDelta = tabOrder(a) - tabOrder(b);
            return orderDelta || String(a).localeCompare(String(b));
        });
    }

    function renderTabs(libraries) {
        const bar = document.getElementById('healthTabBar');
        if (!bar) return;
        bar.innerHTML = '';

        // "all" tab — no library filter, so freshly scanned results are
        // visible even while a running scan is still deep in one library
        const allBtn = document.createElement('button');
        allBtn.className = 'tab-item' + (state.activeLibrary === '' ? ' active' : '');
        allBtn.dataset.lib = '';
        allBtn.appendChild(document.createTextNode('All'));
        const totalCount = currentMountedFileCount();
        if (totalCount > 0) {
            const countEl = document.createElement('span');
            countEl.className = 'tab-count';
            countEl.textContent = totalCount.toLocaleString();
            allBtn.appendChild(countEl);
        }
        allBtn.addEventListener('click', () => {
            state.activeLibrary = '';
            state.page = 1;
            state.expandedRow = null;
            loadItems();
        });
        bar.appendChild(allBtn);

        libraries.forEach(lib => {
            const btn = document.createElement('button');
            btn.className = 'tab-item' + (state.activeLibrary === lib ? ' active' : '');
            btn.dataset.lib = lib;
            btn.appendChild(document.createTextNode(lib));
            const count = state.libraryCounts[lib];
            if (Number.isFinite(count)) {
                const countEl = document.createElement('span');
                countEl.className = 'tab-count';
                countEl.textContent = count.toLocaleString();
                btn.appendChild(countEl);
            }
            const refreshBtn = document.createElement('button');
            refreshBtn.className = 'tab-refresh-btn';
            refreshBtn.type = 'button';
            refreshBtn.title = `Resync ${libraryScopeLabel(lib)} from Plex and recheck file health`;
            refreshBtn.setAttribute('aria-label', refreshBtn.title);
            refreshBtn.innerHTML = SVG_REFRESH;
            refreshBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                quickRefreshLibrary(lib, refreshBtn);
            });
            btn.appendChild(refreshBtn);
            btn.addEventListener('click', () => {
                state.activeLibrary = btn.dataset.lib;
                state.page = 1;
                state.expandedRow = null;
                loadItems();
            });
            bar.appendChild(btn);
        });
    }

    function libraryScopeLabel(title) {
        const t = String(title || '').toLowerCase();
        if (t.includes('movie')) return 'Movies';
        if (t.includes('anime')) return 'Animes';
        return 'Shows';
    }

    async function quickRefreshLibrary(title, btnEl) {
        if (state.scanning || btnEl.disabled) return;
        const label = libraryScopeLabel(title);
        const count = state.libraryCounts[title];
        const countText = Number.isFinite(count) ? ` about ${count.toLocaleString()} files` : ' every file in that library';
        const confirmed = await showConfirm(
            `Resync and Recheck ${label}?`,
            `This will repull ${label} from Plex and then recheck${countText}. Existing health results stay cached while files are rechecked, but this can still take a while on large libraries.`,
            `Recheck ${label}`
        );
        if (!confirmed) return;

        btnEl.disabled = true;
        btnEl.classList.add('spinning');
        state.refreshingLibrary = title;
        state.refreshingLabel = label;
        state.refreshingButton = btnEl;

        try {
            showToast(`Resyncing ${label} from Plex before health checks…`, 'info');
            const result = await api(`/api/sync/library/${encodeURIComponent(title)}`, { method: 'POST' });
            if (result.status === 'error') throw new Error(result.message || 'Failed to start refresh');
            pollLibraryRefresh(title, result.key || `refresh:${title}`);
        } catch (err) {
            finishLibraryRefresh(false);
            showToast(`${label} health resync failed: ${err.message || err}`, 'error');
            console.error('[HealthDash] quickRefreshLibrary error:', err);
        }
    }

    function pollLibraryRefresh(title, key) {
        const iv = setInterval(async () => {
            try {
                const data = await api('/api/progress');
                const stillRunning = (data.tasks || []).some(t => t.key === key);
                if (stillRunning) return;

                clearInterval(iv);
                const label = libraryScopeLabel(title);
                showToast(`Rechecking ${label} file health…`, 'info');
                const started = startScan('full', title);
                if (!started) finishLibraryRefresh(false);
            } catch (err) {
                clearInterval(iv);
                finishLibraryRefresh(false);
                showToast('Health refresh failed: ' + (err.message || err), 'error');
            }
        }, 3000);
    }

    //=============
    // RENDER TABLE
    //=============
    const colMgr = createColumnManager({
        lsPrefix: LS_PREFIX,
        viewKeyFn: () => state.activeLibrary || 'all',
        getMasterCols: () => HEALTH_COLUMNS,
        mobileLabels: HEALTH_MOBILE_LABELS,
        alwaysOnKeyFn: () => 'title',
        defaultMobileKeysFn: () => state.activeLibrary
            ? ['title', 'fileSize', 'scannedAt']
            : ['title', 'library', 'fileSize', 'scannedAt'],
        pickerEnabled: true,
        pickerElementId: 'healthColumnPicker',
        onChange: () => renderTable(state.items),
    });

    let isResizing = false;

    function defaultDesktopCols() {
        return HEALTH_COLUMNS
            .filter(c => c.key !== 'rank' && c.default)
            .map(c => c.key);
    }

    async function loadColumnPreferences() {
        const viewKey = state.activeLibrary || 'all';
        if (state._columnViewKey !== viewKey) {
            state._columnViewKey = viewKey;
            colMgr.loadVisibleColumns(() => defaultDesktopCols());
            colMgr.loadColumnWidths();
            colMgr.loadMobileColumnWidths();
            colMgr.loadColumnOrder();
            colMgr.loadMobileColumns();
            colMgr.loadColumnLabels();
        }
        if (state._remoteColumnViewKey !== viewKey) {
            await colMgr.loadRemoteState();
            state._remoteColumnViewKey = viewKey;
        }
        if (state.activeLibrary && colMgr.state.mobileColumns.includes('library')) {
            colMgr.state.mobileColumns = colMgr.state.mobileColumns.filter(k => k !== 'library');
            colMgr.saveMobileColumns();
            colMgr.saveRemoteState();
        }
    }

    function activeTableColumns() {
        const mobile = isMobile();
        if (!mobile) return colMgr.getOrderedVisibleCols();
        const rank = HEALTH_COLUMNS.find(c => c.key === 'rank');
        const rest = HEALTH_COLUMNS.filter(c =>
            c.key !== 'rank'
            && (!state.activeLibrary || c.key !== 'library')
            && colMgr.state.mobileColumns.includes(c.key)
        );
        return rank ? [rank, ...rest] : rest;
    }

    function renderTable(items) {
        const tbody = document.getElementById('healthTableBody');
        const thead = document.getElementById('healthTableHead');
        const table = document.getElementById('healthTable');
        if (!tbody || !thead || !table) return;

        const mobile = isMobile();
        const cols = activeTableColumns();

        colMgr.renderTableHeader({
            thead,
            tableElementId: 'healthTable',
            cols,
            mobile,
            sortKey: state.sortCol,
            sortDir: state.sortDir,
            leadingHTML: '<th class="expand-col"></th>',
            onSort: (col) => {
                if (state.sortCol === col) {
                    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    state.sortCol = col;
                    state.sortDir = 'asc';
                }
                state.page = 1;
                state.expandedRow = null;
                loadItems();
            },
            onResizingChange: (resizing) => { isResizing = resizing; },
            isResizingFn: () => isResizing,
        });

        if (!items || items.length === 0) {
            const scope = state.activeLibrary ? 'this library' : 'your libraries';
            const msg = state.filter === 'scanned'
                ? 'No scanned files are available for ' + scope + ' yet.'
                : state.filter === 'issues'
                ? 'No problematic files found for ' + scope + '.'
                : 'No items match the current filter.';
            tbody.innerHTML = '<tr><td colspan="' + Math.max(cols.length + 1, 1) + '" style="text-align:center;color:var(--text-muted);padding:2rem;">' + msg + '</td></tr>';
            return;
        }

        let bodyHTML = '';
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const isExpanded = state.expandedRow === i;
            bodyHTML += `<tr class="data-row ${isExpanded ? 'expanded' : ''}" data-index="${i}">`;
            bodyHTML += `<td class="expand-col"><span class="expand-icon">${isExpanded ? '\u25BC' : '\u25B6'}</span></td>`;
            for (const col of cols) {
                bodyHTML += renderHealthCell(col, item, i);
            }
            bodyHTML += '</tr>';

            if (isExpanded) {
                bodyHTML += `<tr class="detail-row"><td colspan="${cols.length + 1}">`;
                bodyHTML += renderHealthDetail(item);
                bodyHTML += '</td></tr>';
            }
        }
        tbody.innerHTML = bodyHTML;

        tbody.querySelectorAll('.data-row').forEach(row => {
            row.addEventListener('click', () => {
                const idx = parseInt(row.dataset.index, 10);
                if (isMobile()) {
                    openHealthMobilePanel(state.items[idx]);
                } else {
                    state.expandedRow = state.expandedRow === idx ? null : idx;
                    renderTable(state.items);
                }
            });
        });
    }

    function renderHealthCell(col, row, index) {
        if (col.key === 'rank') {
            const n = ((state.page || 1) - 1) * (state.perPage || 50) + index + 1;
            return '<td class="row-num-col" data-col="rank">' + n.toLocaleString() + '</td>';
        }
        if (CHECK_COLUMNS.has(col.key)) {
            return renderCheckCell(row[col.key]);
        }
        return '<td data-col="' + escapeHTML(col.key) + '">' + renderHealthCellValue(col.key, row) + '</td>';
    }

    function renderHealthCellValue(key, row) {
        switch (key) {
            case 'title': {
                const yearPart = row.year ? ' <span style="color:var(--text-muted);font-weight:400;">(' + row.year + ')</span>' : '';
                const titleText = row.displayTitle || row.title || '—';
                if (row.parentTitle) {
                    return '<div>' + escapeHTML(row.parentTitle) + yearPart + '</div>' +
                        '<div style="color:var(--text-muted);font-size:0.78rem;margin-top:3px;word-break:break-word;">' + escapeHTML(row.title || titleText) + '</div>';
                }
                return escapeHTML(titleText) + yearPart;
            }
            case 'library':
                return escapeHTML(row.library || '—');
            case 'fileSize':
                return formatBytes(row.fileSize);
            case 'scannedAt':
                return row.quickScanned
                    ? '<span class="health-scan-depth">Scanned</span>'
                    : '<span class="health-scan-depth health-scan-depth--pending">Pending</span>';
            default:
                return escapeHTML(row[key] ?? '—');
        }
    }

    function detailItem(label, value) {
        const display = value != null && value !== '' ? escapeHTML(String(value)) : '<span class="text-muted">-</span>';
        return `<div class="detail-item"><span class="label">${escapeHTML(label)}</span><span class="value">${display}</span></div>`;
    }

    function healthStatusLabel(row) {
        if (!row.quickScanned) return 'Pending';
        return row.issues && row.issues.length ? 'Issues found' : 'Healthy';
    }

    function renderIssueSummary(row) {
        if (!row.quickScanned) {
            return '<span class="health-scan-depth health-scan-depth--pending">Not yet scanned</span>';
        }
        const issues = row.issues || [];
        if (!issues.length) {
            return '<span class="health-scan-depth">Healthy</span>';
        }
        return issues.map(key => {
            const label = state.issueLabels[key] || key.replace(/_/g, ' ');
            return `<span class="health-issue-badge" title="${escapeHTML(label)}">${escapeHTML(label)}</span>`;
        }).join(' ');
    }

    function checkText(value) {
        if (value === true) return 'Passed';
        if (value === false) return 'Failed';
        return 'Pending';
    }

    function renderHealthDetail(row) {
        let html = '<div class="detail-content">';
        html += '<div class="detail-section"><h4>File Health</h4><div class="detail-grid">';
        html += detailItem('Status', healthStatusLabel(row));
        html += detailItem('Media Type', row.mediaKind === 'episode' ? 'Episode' : 'Movie');
        html += detailItem('Library', row.library);
        html += detailItem('File Size', formatBytes(row.fileSize));
        html += detailItem('Container', row.container || row.extension);
        html += detailItem('Scanned', row.quickScanned ? formatRelativeDate(row.scannedAt) : 'Pending');
        html += detailItem('Added', formatRelativeDate(row.addedAt));
        html += '</div></div>';

        const techPairs = [
            ['Resolution', row.resolution],
            ['Video Codec', row.videoCodec],
            ['Audio Codec', row.audioCodec],
            ['Audio Channels', row.audioChannelsFormatted],
            ['Bitrate', row.bitrateFormatted],
            ['Duration', row.durationFormatted],
            ['Subtitles', row.subtitleLanguages],
        ].filter(([, v]) => v != null && v !== '');
        if (techPairs.length) {
            html += '<div class="detail-section"><h4>Media Metadata</h4><div class="detail-grid">';
            for (const [label, value] of techPairs) html += detailItem(label, value);
            html += '</div></div>';
        }

        html += '<div class="detail-section"><h4>Checks</h4><div class="detail-grid">';
        html += detailItem('Size OK', checkText(row.zero_byte));
        html += detailItem('Readable by ffprobe', checkText(row.unreadable));
        html += detailItem('Duration', checkText(row.zero_duration));
        html += detailItem('Video Track', checkText(row.no_video_stream));
        html += detailItem('Audio Track', checkText(row.no_audio_stream));
        html += '</div></div>';

        html += '<div class="detail-section"><h4>Issue Summary</h4><p class="summary-text">' + renderIssueSummary(row) + '</p></div>';

        if (row.parentTitle) {
            html += '<div class="detail-section"><h4>Episode</h4><div class="detail-grid">';
            html += detailItem('Show', row.parentTitle);
            html += detailItem('Episode File', row.title);
            html += detailItem('Year', row.year);
            html += '</div></div>';
        } else {
            html += '<div class="detail-section"><h4>Movie</h4><div class="detail-grid">';
            html += detailItem('Title', row.title);
            html += detailItem('Year', row.year);
            html += '</div></div>';
        }

        if (row.filePath) {
            html += `<div class="detail-section"><h4>File Path</h4><p class="summary-text full-path">${escapeHTML(row.filePath)}</p></div>`;
            html += '<div class="detail-section"><h4>Filesystem</h4><div class="detail-grid">';
            html += detailItem('Filename', row.fileName);
            html += detailItem('Directory', row.directory);
            html += detailItem('Extension', row.extension);
            html += '</div></div>';
        }

        html += '</div>';
        return html;
    }

    function openHealthMobilePanel(row) {
        const panel = document.getElementById('mobileDetailPanel');
        if (!panel || !row) return;

        if (panel.classList.contains('open')) closeHealthMobilePanel();

        document.getElementById('mobilePanelTitle').textContent = row.parentTitle || row.title || 'File Health';
        const metaParts = [
            row.library,
            row.mediaKind === 'episode' ? 'Episode' : 'Movie',
            formatBytes(row.fileSize),
            healthStatusLabel(row),
        ].filter(Boolean);
        document.getElementById('mobilePanelMeta').innerHTML = metaParts
            .map(p => `<span>${escapeHTML(p)}</span>`)
            .join('<span style="color:var(--border-light)">·</span>');
        document.getElementById('mobilePanelBody').innerHTML = renderHealthMobilePanelContent(row);

        panel.classList.add('open');
        document.body.style.overflow = 'hidden';
        document.getElementById('mobilePanelBackdrop').onclick = closeHealthMobilePanel;
        document.getElementById('mobilePanelClose').onclick = closeHealthMobilePanel;

        // Swipe-to-close: same bottom-sheet feel as Sizes and Naming.
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
                setTimeout(closeHealthMobilePanel, 250);
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

    function closeHealthMobilePanel() {
        const panel = document.getElementById('mobileDetailPanel');
        if (!panel) return;
        if (panel._removeSwipeListeners) {
            panel._removeSwipeListeners();
            panel._removeSwipeListeners = null;
        }
        panel.classList.remove('open');
        document.body.style.overflow = '';
    }

    function renderHealthMobilePanelContent(row) {
        const e = escapeHTML;
        const val = v => (v != null && v !== '') ? e(String(v)) : '<span class="text-muted">-</span>';
        const panelItem = (label, value) =>
            `<div class="mobile-panel-item"><span class="label">${e(label)}</span><span class="value">${val(value)}</span></div>`;
        const section = (title, inner) => `<div class="mobile-panel-section"><div class="mobile-panel-section-title">${e(title)}</div>${inner}</div>`;
        const grid = pairs => `<div class="mobile-panel-grid">${pairs.map(([l, v]) => panelItem(l, v)).join('')}</div>`;

        let html = section('File Health', grid([
            ['Status', healthStatusLabel(row)],
            ['Library', row.library],
            ['Type', row.mediaKind === 'episode' ? 'Episode' : 'Movie'],
            ['Size', formatBytes(row.fileSize)],
            ['Container', row.container || row.extension],
            ['Scanned', row.quickScanned ? formatRelativeDate(row.scannedAt) : 'Pending'],
        ]));

        const metadata = [
            ['Resolution', row.resolution],
            ['Video Codec', row.videoCodec],
            ['Audio Codec', row.audioCodec],
            ['Audio Channels', row.audioChannelsFormatted],
            ['Bitrate', row.bitrateFormatted],
            ['Duration', row.durationFormatted],
            ['Subtitles', row.subtitleLanguages],
        ].filter(([, v]) => v != null && v !== '');
        if (metadata.length) html += section('Media Metadata', grid(metadata));

        html += section('Checks', grid([
            ['Size OK', checkText(row.zero_byte)],
            ['Readable', checkText(row.unreadable)],
            ['Duration', checkText(row.zero_duration)],
            ['Video', checkText(row.no_video_stream)],
            ['Audio', checkText(row.no_audio_stream)],
        ]));

        html += section('Issue Summary', `<p style="margin:0;color:var(--text-secondary);font-size:0.78rem;line-height:1.5;">${renderIssueSummary(row)}</p>`);

        if (row.filePath) {
            html += section('File Path', `<p style="font-family:monospace;font-size:0.72rem;color:var(--text-muted);word-break:break-all;line-height:1.5;">${e(row.filePath)}</p>`);
            html += section('Filesystem', grid([
                ['Filename', row.fileName],
                ['Directory', row.directory],
                ['Extension', row.extension],
            ]));
        }
        return html;
    }

    //==================
    // RENDER PAGINATION
    //==================
    function renderPagination(page, totalPages) {
        const bar = document.getElementById('healthPaginationBar');
        const label = state.filter === 'issues'
            ? 'files with issues'
            : state.filter === 'healthy'
            ? 'healthy files'
            : state.filter === 'pending'
            ? 'pending files'
            : state.filter === 'scanned'
            ? 'scanned files'
            : 'media files';
        const scope = state.activeLibrary ? ` in ${escapeHTML(state.activeLibrary)}` : '';
        renderPaginationBar({
            bar,
            page,
            totalPages,
            totalItems: state.totalItems,
            perPage: state.perPage,
            totalHTML: `${state.totalItems.toLocaleString()} ${label}${scope}`,
            onPage: (p) => {
                state.page = p;
                state.expandedRow = null;
                loadItems();
            },
        });
    }

    //===========
    // RENDER ALL
    //===========
    async function renderAll(data) {
        state.items          = data.items || [];
        state.totalItems     = data.total || 0;
        state.totalPages     = data.total_pages || 1;
        state.page           = data.page || 1;
        if (state.expandedRow != null && state.expandedRow >= state.items.length) {
            state.expandedRow = null;
        }
        state.quickScannedAt = data.quick_scanned_at || null;
        state.fullScannedAt  = data.full_scanned_at || null;
        state.retainedResultCount = data.retained_result_count || 0;
        state.issueLabels    = data.issueLabels || {};
        state.activeHealthRun = data.active_health_run || null;
        state.interruptedRun  = data.interrupted_health_run || null;
        state.hasScanned     = !!state.quickScannedAt || state.retainedResultCount > 0;
        state.mediaMissing   = !!data.media_mounts_missing;
        // scan_running reflects the actual task runner — a stale journal run
        // after a container restart no longer locks the page into "Scanning".
        const scanRunning = !!data.scan_running;
        if (scanRunning) {
            state.scanning = true;
            if (!state.progressInterval) watchProgressHub();
        } else if (!state.progressInterval) {
            state.scanning = false;
        }

        // MEDIA MOUNT WARNING — media volumes not visible inside the container
        const mountEl = document.getElementById('healthMountWarning');
        if (mountEl) mountEl.style.display = state.mediaMissing ? '' : 'none';
        setScanButtonsDisabled(state.scanning);

        if (data.libraries && data.libraries.length) {
            state.libraries = normalizeLibraries(data.libraries);
            state.libraryCounts = data.library_counts || {};
            // '' is the "All" tab and the default landing view — a specific
            // library tab could sit at zero while a scan works elsewhere.
            if (state.activeLibrary && !state.libraries.includes(state.activeLibrary)) {
                state.activeLibrary = '';
            }
            renderTabs(state.libraries);
        }
        await loadColumnPreferences();

        renderMetaPanel(data);
        renderStatsBar(data);

        //Stale Warning
        const staleEl = document.getElementById('healthStaleWarning');
        if (staleEl) {
            if (state.hasScanned && isStale(state.quickScannedAt)) {
                staleEl.style.display = '';
                staleEl.textContent = 'Health scan results are more than ' + STALE_DAYS + ' days old. Use Scan New for unscanned files, or Full Rescan when you intentionally want to recheck everything.';
            } else {
                staleEl.style.display = 'none';
            }
        }

        // SHOW/HIDE no-scan state vs results table
        const noScanEl     = document.getElementById('healthNoScanState');
        const wrapperEl    = document.getElementById('healthTableWrapper');
        const paginationEl = document.getElementById('healthPaginationBar');

        if (!state.hasScanned) {
            // Confirmed no previous results — swap the initial "loading" copy
            // for the real awaiting-scan message.
            const tagEl  = document.getElementById('healthNoScanTag');
            const descEl = document.getElementById('healthNoScanDesc');
            if (tagEl)  tagEl.textContent = 'AWAITING SCAN';
            if (descEl) descEl.innerHTML = 'Your media library hasn\'t been analyzed yet.<br>Run Scan New to build the first protected health cache, or Full Rescan to check every mounted file.';
            if (noScanEl)     noScanEl.style.display     = '';
            if (wrapperEl)    wrapperEl.style.display     = 'none';
            if (paginationEl) paginationEl.style.display  = 'none';
        } else {
            if (noScanEl)  noScanEl.style.display  = 'none';
            if (wrapperEl) wrapperEl.style.display  = '';
            renderTable(state.items);
            renderPagination(state.page, state.totalPages);
        }
    }

    //===========
    // LOAD ITEMS
    //===========
    function loadItems() {
        const params = new URLSearchParams({
            page:     state.page,
            per_page: state.perPage,
            filter:   state.filter,
            sort:     state.sortCol,
            dir:      state.sortDir,
        });
        if (state.search)        params.set('search', state.search);
        if (state.activeLibrary) params.set('library', state.activeLibrary);

        fetch('/filehealth/items?' + params.toString())
            .then(r => r.json())
            .then(data => renderAll(data))
            .catch(err => console.error('[HealthDash] loadItems error:', err));
    }

    //=====
    // SCAN
    //=====
    function startScan(scope, libraryTitle) {
        if (state.scanning) return false;

        const params = new URLSearchParams({ scope });
        if (libraryTitle) params.set('library', libraryTitle);
        const url = '/filehealth/scan?' + params.toString();
        state.scanning = true;
        setScanButtonsDisabled(true);
        if (typeof ProgressHub !== 'undefined') ProgressHub.init();
        showToast(scanStartMessage(scope, libraryTitle), 'info');
        fetch(url, { method: 'POST' })
            .then(r => r.json())
            .then(data => {
                if (data.status === 'no_media') {
                    showToast(data.error || 'No media mounts detected — scanning is unavailable.', 'error');
                    stopPolling(false);
                    loadItems();
                } else if (data.status === 'already_running' || data.status === 'started') {
                    watchProgressHub();
                } else {
                    stopPolling(false);
                }
            })
            .catch(err => {
                console.error('[HealthDash] startScan error:', err);
                stopPolling(false);
            });
        return true;
    }

    function scanStartMessage(scope, libraryTitle) {
        if (libraryTitle) return `Rechecking ${libraryScopeLabel(libraryTitle)} health…`;
        if (scope === 'full') return 'Full health rescan started. Existing results stay cached while files are rechecked.';
        return 'Scanning new and unscanned files. Existing health results stay cached.';
    }

    function watchProgressHub() {
        if (state.progressInterval) clearInterval(state.progressInterval);
        let tick = 0;
        state.progressInterval = setInterval(() => {
            fetch('/api/progress')
                .then(r => r.json())
                .then(data => {
                    const tasks = data.tasks || [];
                    const task = tasks.find(t => t.key && t.key.startsWith('health:'));
                    if (!task) {
                        stopPolling(true);
                        loadItems();
                        return;
                    }
                    // The progress hub shows live per-file progress; the table
                    // only needs a periodic refresh to pull in finished files.
                    tick++;
                    if (tick % 3 === 0) loadItems();
                })
                .catch(() => {
                    stopPolling(false);
                    loadItems();
                });
        }, 2000);
    }

    function stopPolling(success = true) {
        if (state.progressInterval) {
            clearInterval(state.progressInterval);
            state.progressInterval = null;
        }
        state.scanning = false;
        setScanButtonsDisabled(false);
        finishLibraryRefresh(success);
    }

    function finishLibraryRefresh(success) {
        const btn = state.refreshingButton;
        const label = state.refreshingLabel;
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('spinning');
        }
        state.refreshingLibrary = null;
        state.refreshingLabel = '';
        state.refreshingButton = null;
        if (success && label) showToast(`${label} health updated`, 'success');
    }

    function setScanButtonsDisabled(disabled) {
        disabled = disabled || state.mediaMissing;
        ['quickScanBtn', 'fullRescanBtn'].forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = disabled;
        });
        document.querySelectorAll('#healthTabBar .tab-refresh-btn').forEach(btn => {
            if (btn !== state.refreshingButton) btn.disabled = disabled;
        });
        // Cancel is the inverse: only useful while a scan runs or sits paused.
        const cancelBtn = document.getElementById('cancelScanBtn');
        if (cancelBtn) cancelBtn.style.display = (state.scanning || state.interruptedRun) ? '' : 'none';
    }

    async function cancelScan() {
        const confirmed = await showConfirm(
            'Cancel Health Scan?',
            'The scan stops and will no longer auto-resume. Files already checked keep their results, and a future Scan New or Full Rescan picks up from the journal.',
            'Cancel Scan'
        );
        if (!confirmed) return;
        try {
            const result = await api('/filehealth/scan/cancel', { method: 'POST' });
            if (result.status === 'cancelling') {
                showToast('Cancelling scan — finishing the current file…', 'info');
            } else if (result.status === 'cancelled') {
                showToast('Paused scan cancelled — it will not auto-resume.', 'success');
            } else {
                showToast('No scan to cancel.', 'info');
            }
            loadItems();
        } catch (err) {
            showToast('Cancel failed: ' + (err.message || err), 'error');
        }
    }

    //=====
    // INIT
    //=====
    function init() {
        // Scan buttons
        const quickBtn = document.getElementById('quickScanBtn');
        const fullBtn  = document.getElementById('fullRescanBtn');
        if (quickBtn) quickBtn.addEventListener('click', async () => {
            const totalFiles = currentMountedFileCount();
            if (!state.retainedResultCount && totalFiles > 1000) {
                const confirmed = await showConfirm(
                    'Build Health Cache?',
                    `This first scan will check about ${totalFiles.toLocaleString()} mounted files and may take a long time. After it completes, results are retained and future Scan New runs only check missing files.`,
                    'Start Scan New'
                );
                if (!confirmed) return;
            }
            startScan('new');
        });
        if (fullBtn)  fullBtn.addEventListener('click', async () => {
            const totalFiles = currentMountedFileCount();
            const totalText = totalFiles > 0
                ? ` Your current mounted scan set is about ${totalFiles.toLocaleString()} files.`
                : '';
            const confirmed = await showConfirm(
                'Full Health Rescan?',
                'This will recheck every mounted media file. Large libraries can take a long time; about 50,000 files may take around 1h 30m.' + totalText + ' Existing scan results remain cached while the rescan runs.',
                'Start Full Rescan'
            );
            if (confirmed) startScan('full');
        });
        const cancelBtn = document.getElementById('cancelScanBtn');
        if (cancelBtn) cancelBtn.addEventListener('click', cancelScan);

        // Search
        const searchEl = document.getElementById('healthSearch');
        const clearEl  = document.getElementById('healthSearchClear');
        if (searchEl) {
            searchEl.addEventListener('input', () => {
                clearTimeout(state._searchTimer);
                state._searchTimer = setTimeout(() => {
                    state.search = searchEl.value.trim();
                    state.page   = 1;
                    state.expandedRow = null;
                    if (clearEl) clearEl.style.display = state.search ? '' : 'none';
                    loadItems();
                }, 300);
            });
        }
        if (clearEl) {
            clearEl.addEventListener('click', () => {
                if (searchEl) searchEl.value = '';
                state.search = '';
                clearEl.style.display = 'none';
                state.page = 1;
                state.expandedRow = null;
                loadItems();
            });
        }

        const guideToggle = document.getElementById('healthGuideToggle');
        const guideBanner = document.getElementById('healthGuideBanner');
        if (guideToggle && guideBanner) {
            guideToggle.addEventListener('click', () => {
                const isOpen = guideBanner.classList.toggle('is-open');
                guideToggle.setAttribute('aria-expanded', String(isOpen));
            });
        }

        // Filter buttons
        const filtersEl = document.getElementById('healthFilters');
        if (filtersEl) {
            filtersEl.querySelectorAll('.filter-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    filtersEl.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    state.filter = btn.dataset.filter;
                    state.page   = 1;
                    state.expandedRow = null;
                    loadItems();
                });
            });
        }

        const pickerBtn = document.getElementById('healthColumnPickerBtn');
        const picker = document.getElementById('healthColumnPicker');
        if (pickerBtn && picker) {
            pickerBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await loadColumnPreferences();
                colMgr.renderColumnPicker();
                picker.style.display = picker.style.display === 'flex' ? 'none' : 'flex';
            });
            document.addEventListener('click', (e) => {
                if (!picker.contains(e.target) && !pickerBtn.contains(e.target)) {
                    picker.style.display = 'none';
                }
            });
        }

        // Initial load
        loadItems();
    }

    function refreshActive() {
        loadItems();
    }

    function currentMountedFileCount() {
        return Object.values(state.libraryCounts || {}).reduce((sum, n) => (
            sum + (Number.isFinite(n) ? n : 0)
        ), 0);
    }

    return { init, refreshActive };
})();
