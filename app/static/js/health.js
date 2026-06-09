// ############################################
// # HEALTH PAGE — FILE HEALTH SCANNER        #
// ############################################

const HealthDash = (() => {
    'use strict';

    // --------------------------------------------------------
    // STATE
    // --------------------------------------------------------

    const state = {
        results: [],
        issueLabels: {},
        quickScannedAt: null,
        deepScannedAt: null,
        sortCol: 'library',
        sortDir: 'asc',
        scanning: false,
        progressInterval: null,
    };

    const STALE_DAYS = 7;

    // --------------------------------------------------------
    // HELPERS
    // --------------------------------------------------------

    function formatBytes(bytes) {
        if (!bytes) return '—';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        let v = bytes;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return v.toFixed(1) + ' ' + units[i];
    }

    function formatRelativeDate(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        const diffDays = Math.floor((Date.now() - d) / 86400000);
        if (diffDays === 0) return 'today';
        if (diffDays === 1) return 'yesterday';
        return diffDays + ' days ago';
    }

    function staleDays(iso) {
        if (!iso) return null;
        return Math.floor((Date.now() - new Date(iso)) / 86400000);
    }

    // --------------------------------------------------------
    // RENDER HELPERS
    // --------------------------------------------------------

    function renderIssueBadges(issues) {
        return issues.map(k => {
            const label = state.issueLabels[k] || k;
            const short = k.replace(/_/g, ' ');
            return `<span class="health-issue-badge" title="${label}">${short}</span>`;
        }).join('');
    }

    function renderTable() {
        const tbody = document.getElementById('healthTableBody');
        if (!tbody) return;

        const sorted = [...state.results].sort((a, b) => {
            let av = a[state.sortCol] ?? '';
            let bv = b[state.sortCol] ?? '';
            if (typeof av === 'string') av = av.toLowerCase();
            if (typeof bv === 'string') bv = bv.toLowerCase();
            if (av < bv) return state.sortDir === 'asc' ? -1 : 1;
            if (av > bv) return state.sortDir === 'asc' ? 1 : -1;
            return 0;
        });

        tbody.innerHTML = sorted.map(r => `
            <tr>
                <td>${r.title || '—'}</td>
                <td>${r.library || '—'}</td>
                <td>${formatBytes(r.fileSize)}</td>
                <td>${renderIssueBadges(r.issues || [])}</td>
                <td><span class="health-scan-depth">${r.deepScanned ? 'Deep' : 'Quick'}</span></td>
            </tr>
        `).join('');
    }

    function renderPage(data) {
        state.results        = data.results || [];
        state.issueLabels    = data.issueLabels || {};
        state.quickScannedAt = data.quick_scanned_at || null;
        state.deepScannedAt  = data.deep_scanned_at  || null;

        // LAST SCANNED TIMESTAMPS
        const qs = document.getElementById('quickLastScanned');
        const ds = document.getElementById('deepLastScanned');
        if (qs) qs.textContent = state.quickScannedAt ? 'Last: ' + formatRelativeDate(state.quickScannedAt) : '';
        if (ds) ds.textContent = state.deepScannedAt  ? 'Last: ' + formatRelativeDate(state.deepScannedAt)  : '';

        // STALE WARNING — based on whichever scan is most recent
        const latestScan = [state.quickScannedAt, state.deepScannedAt]
            .filter(Boolean).sort().pop() || null;

        const staleEl = document.getElementById('healthStaleWarning');
        if (staleEl) {
            const days = staleDays(latestScan);
            if (days !== null && days >= STALE_DAYS) {
                staleEl.textContent = `Results from ${days} days ago — consider rescanning.`;
                staleEl.style.display = '';
            } else {
                staleEl.style.display = 'none';
            }
        }

        const hasScanned = !!latestScan;
        const noScanEl = document.getElementById('healthNoScanState');
        if (noScanEl) noScanEl.style.display = hasScanned ? 'none' : '';

        const summaryBar = document.getElementById('healthSummaryBar');
        if (summaryBar) summaryBar.style.display = hasScanned ? '' : 'none';

        if (hasScanned) {
            const count = state.results.length;
            const scannedEl = document.getElementById('healthSummaryScanned');
            const issuesEl  = document.getElementById('healthSummaryIssues');
            const cleanEl   = document.getElementById('healthSummaryClean');
            if (scannedEl) scannedEl.textContent = count + ' issue' + (count !== 1 ? 's' : '') + ' found';
            if (issuesEl)  issuesEl.textContent  = count > 0 ? count + ' file' + (count !== 1 ? 's' : '') + ' flagged' : 'no files flagged';
            if (cleanEl)   cleanEl.textContent   = count === 0 ? 'all clean' : '';
        }

        const tableWrap = document.getElementById('healthTableWrap');
        const emptyEl   = document.getElementById('healthEmptyState');

        if (!hasScanned) {
            if (tableWrap) tableWrap.style.display = 'none';
            if (emptyEl)   emptyEl.style.display   = 'none';
        } else if (state.results.length === 0) {
            if (tableWrap) tableWrap.style.display = 'none';
            if (emptyEl)   emptyEl.style.display   = '';
        } else {
            if (emptyEl)   emptyEl.style.display   = 'none';
            if (tableWrap) tableWrap.style.display = '';
            renderTable();
        }
    }

    // --------------------------------------------------------
    // DATA LOADING
    // --------------------------------------------------------

    function loadResults() {
        fetch('/filehealth/results')
            .then(r => r.json())
            .then(data => renderPage(data))
            .catch(err => console.error('[HealthDash] results fetch failed:', err));
    }

    // --------------------------------------------------------
    // SCANNING
    // --------------------------------------------------------

    function startProgressPolling(mode) {
        const wrap  = document.getElementById('healthProgressWrap');
        const label = document.getElementById('healthProgressLabel');
        const fill  = document.getElementById('healthProgressFill');
        if (wrap) wrap.style.display = '';

        const key = 'health:' + mode;
        state.scanning = true;

        clearInterval(state.progressInterval);
        state.progressInterval = setInterval(() => {
            fetch('/api/progress')
                .then(r => r.json())
                .then(d => {
                    const task = (d.tasks || []).find(t => t.key === key);
                    if (!task) {
                        clearInterval(state.progressInterval);
                        state.progressInterval = null;
                        state.scanning = false;
                        if (wrap) wrap.style.display = 'none';
                        if (fill) fill.style.width = '0%';
                        loadResults();
                        return;
                    }
                    const pct = task.total > 0 ? Math.round((task.current / task.total) * 100) : 0;
                    if (fill)  fill.style.width  = pct + '%';
                    if (label) label.textContent = (task.step || 'Scanning…') + ' (' + task.current + '/' + task.total + ')';
                })
                .catch(() => {});
        }, 1000);
    }

    function startScan(mode) {
        if (state.scanning) return;
        state.scanning = true;
        fetch('/filehealth/scan?mode=' + mode, { method: 'POST' })
            .then(r => r.json())
            .then(data => {
                if (data.status === 'already_running') {
                    startProgressPolling(mode);
                    return;
                }
                if (data.status === 'started') {
                    startProgressPolling(mode);
                    return;
                }
                // Unexpected response — reset guard
                state.scanning = false;
            })
            .catch(err => {
                console.error('[HealthDash] scan start failed:', err);
                state.scanning = false;
                const wrap = document.getElementById('healthProgressWrap');
                if (wrap) wrap.style.display = 'none';
            });
    }

    // --------------------------------------------------------
    // INIT
    // --------------------------------------------------------

    function init() {
        // SCAN BUTTONS
        const quickBtn = document.getElementById('quickScanBtn');
        const deepBtn  = document.getElementById('deepScanBtn');
        if (quickBtn) quickBtn.addEventListener('click', () => startScan('quick'));
        if (deepBtn)  deepBtn.addEventListener('click',  () => startScan('deep'));

        // SORTABLE COLUMN HEADERS
        const table = document.getElementById('healthTable');
        if (table) {
            table.querySelectorAll('th.sortable').forEach(th => {
                th.style.cursor = 'pointer';
                th.addEventListener('click', () => {
                    const col = th.dataset.col;
                    if (state.sortCol === col) {
                        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
                    } else {
                        state.sortCol = col;
                        state.sortDir = 'asc';
                    }
                    renderTable();
                });
            });
        }

        // LOAD CACHED RESULTS
        loadResults();
    }

    return { init };
})();
