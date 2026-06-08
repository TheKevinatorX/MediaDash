// ############################################
// # HOME PAGE — MEDIA SUMMARY DASHBOARD     #
// ############################################

// ============================================================
// HOME PAGE — MEDIA SUMMARY DASHBOARD
// ============================================================

const HomeDash = (() => {
    // --------------------------------------------------------
    // STATE
    // --------------------------------------------------------

    let _summary = null;
    let _stats = null;
    let _statsLoading = false;
    let _labels = { movie: 'Movies', show: 'Shows' };
    let _namingPollTimer  = null;
    let _statsPollTimer   = null;
    let _libraryPollTimer = null;
    let _libraryPollCount = 0;
    let _pullTimestampMs  = null;

    // --------------------------------------------------------
    // INIT
    // --------------------------------------------------------

    function init() {
        load();
        _setupRefreshAll();
    }

    function reload() {
        _summary = null;
        _stats = null;
        _statsLoading = false;
        _stopNamingPoll();
        _stopStatsPoll();
        _stopLibraryPoll(false);
        load();
    }

    // --------------------------------------------------------
    // LOAD SUMMARY FROM API
    // --------------------------------------------------------

    // STORE SUMMARY + LABELS, RETURN WHETHER ANY LIBRARY IS STILL WAITING ON NAMING DATA
    function _applySummary(summary) {
        _summary = summary;
        if (summary.labels) _labels = summary.labels;
        return (summary.libraries || []).some(lib => lib.namingHealth === null);
    }

    async function load() {
        _showLoading();
        try {
            const data = await api('/api/home/quicksummary');
            _applySummary(data.summary);
            _render();
            const anyLoading = (data.summary.libraries || []).some(lib => lib.loading);
            if (anyLoading) {
                _startLibraryPoll();
            } else {
                const anyNullNaming = (data.summary.libraries || []).some(lib => lib.namingHealth === null);
                if (anyNullNaming) _startNamingPoll();
                else _stopNamingPoll();
            }
        } catch (err) {
            _showError(err.message);
        }
    }

    // POLL QUICKSUMMARY EVERY 3s — PATCHES EACH CARD IN-PLACE AS ITS WORKER COMPLETES
    const LIBRARY_POLL_MAX = 200; // 10 minutes at 3s intervals

    function _startLibraryPoll() {
        if (_libraryPollTimer) return;
        _libraryPollCount = 0;
        _libraryPollTimer = setInterval(async () => {
            _libraryPollCount++;
            if (_libraryPollCount > LIBRARY_POLL_MAX) {
                _stopLibraryPoll(true);
                return;
            }
            try {
                const data = await api('/api/home/quicksummary');
                if (!data.summary) return;
                if (data.summary.labels) _labels = data.summary.labels;
                const libraries = data.summary.libraries || [];
                let anyLoading = false;
                for (const lib of libraries) {
                    if (lib.loading) {
                        anyLoading = true;
                    } else {
                        _patchLibraryCard(lib);
                    }
                }
                if (!anyLoading) {
                    _stopLibraryPoll(false);
                    _summary = data.summary;
                    _render();
                    if (libraries.some(l => l.namingHealth === null)) _startNamingPoll();
                }
            } catch (_) {}
        }, 3000);
    }

    function _stopLibraryPoll(timedOut) {
        if (_libraryPollTimer) { clearInterval(_libraryPollTimer); _libraryPollTimer = null; }
        if (!timedOut) return;
        const grid = document.getElementById('libraryGrid');
        if (!grid) return;
        for (const card of grid.querySelectorAll('.library-card[data-library-title]')) {
            if (!card.querySelector('.library-card-fetching-label') &&
                !card.querySelector('.library-card-refreshing-overlay')) continue;
            const titleEl = card.querySelector('.library-card-title');
            const title = card.dataset.libraryTitle || (titleEl ? titleEl.textContent : 'Library');
            card.innerHTML = `
                <div class="library-card-header">
                    <span class="library-card-title">${escapeHTML(title)}</span>
                </div>
                <div class="library-card-body">
                    <div style="font-size:0.82rem;color:var(--text-muted);padding:8px 0;">
                        Could not load — try Sync
                    </div>
                </div>
            `;
            card.classList.remove('library-card--refreshing');
        }
    }

    // PATCH ONE CARD IN-PLACE — FADES OUT REFRESHING OVERLAY BEFORE SWAPPING HTML
    function _patchLibraryCard(lib) {
        const grid = document.getElementById('libraryGrid');
        if (!grid) return;
        for (const card of grid.querySelectorAll('.library-card[data-library-title]')) {
            if (card.dataset.libraryTitle !== lib.title) continue;
            const isLoading    = !!card.querySelector('.library-card-fetching-label');
            const isRefreshing = !!card.querySelector('.library-card-refreshing-overlay');
            if (!isLoading && !isRefreshing) return;
            const newHTML = _libraryCardHTML(lib);
            if (isRefreshing) {
                if (card.dataset.patching) return; // fade already in progress
                card.dataset.patching = '1';
                const overlay = card.querySelector('.library-card-refreshing-overlay');
                overlay.classList.add('is-fading');
                setTimeout(() => { if (card.parentNode) card.outerHTML = newHTML; }, 300);
            } else {
                card.outerHTML = newHTML;
            }
            return;
        }
    }

    // PERSISTENT POLL: KEEPS RE-FETCHING STATS EVERY 3s UNTIL BROWSE CACHE IS WARM
    function _startStatsPoll() {
        if (_statsPollTimer) return;
        _statsPollTimer = setInterval(async () => {
            try {
                const data = await api('/api/home/stats');
                if (data.stats) {
                    _stats = data.stats;
                    _renderMoreStats(_stats);
                    _stopStatsPoll();
                }
            } catch (_) {}
        }, 3000);
    }

    function _stopStatsPoll() {
        if (_statsPollTimer) { clearInterval(_statsPollTimer); _statsPollTimer = null; }
        if (typeof ProgressHub !== 'undefined') ProgressHub.setAuxBusy('stats', false);
        _updateLoadingPill();
    }

    // PERSISTENT POLL: KEEPS RE-FETCHING SUMMARY EVERY 3s UNTIL NAMING IS WARM
    function _startNamingPoll() {
        if (_namingPollTimer) return;
        if (typeof ProgressHub !== 'undefined') ProgressHub.setAuxBusy('naming', true, 'Naming Analysis');
        _namingPollTimer = setInterval(async () => {
            try {
                const data = await api('/api/home/summary');
                const anyNull = _applySummary(data.summary);
                _render();
                if (!anyNull) _stopNamingPoll();
            } catch (_) {
                // SILENT FAIL — KEEP POLLING
            }
        }, 3000);
    }

    function _stopNamingPoll() {
        if (_namingPollTimer) { clearInterval(_namingPollTimer); _namingPollTimer = null; }
        if (typeof ProgressHub !== 'undefined') ProgressHub.setAuxBusy('naming', false);
        _updateLoadingPill();
    }

    // --------------------------------------------------------
    // RENDER
    // --------------------------------------------------------

    function _render() {
        _renderTotals(_summary.totals);
        _renderLibraryCards(_summary.libraries);
        document.getElementById('homeLoading').style.display = 'none';
        document.getElementById('homeError').style.display = 'none';
        document.getElementById('homeContent').style.display = '';
        updateSyncAge();

        if (_stats === null) {
            const existingSection = document.getElementById('moreStatsSection');
            const alreadyShimmer = existingSection?.classList.contains('more-stats-placeholder');
            if (!alreadyShimmer) {
                const existingToggle = document.getElementById('moreStatsToggle');
                if (existingToggle) existingToggle.remove();
                if (existingSection) existingSection.remove();
                const grid = document.getElementById('libraryGrid');
                if (grid) {
                    const placeholder = document.createElement('div');
                    placeholder.id = 'moreStatsSection';
                    placeholder.className = 'more-stats-placeholder';
                    placeholder.innerHTML = `
                        <div class="shimmer-line shimmer-line--wide"></div>
                        <div class="shimmer-line shimmer-line--med"></div>
                        <div class="shimmer-line shimmer-line--wide"></div>
                    `;
                    grid.after(placeholder);
                }
            }
        }

        _updateLoadingPill();
        _loadStats();
    }

    // FETCH SUMMARY (OR USE CACHED), STORE PULL TIMESTAMP, UPDATE DISPLAY
    async function updateSyncAge() {
        const el = document.getElementById('syncLastPulled');
        if (!el) return;
        try {
            const src = _summary || (await api('/api/home/summary')).summary;
            const ages = (src.libraries || []).map(l => l.cacheAge).filter(a => a != null);
            if (ages.length === 0) { el.textContent = ''; return; }
            const minAge = Math.min(...ages);
            _pullTimestampMs = Date.now() - minAge * 1000;
            el.textContent = 'Last pulled: ' + relativeTime(minAge);
        } catch { el.textContent = ''; }
    }

    // RECOMPUTE DISPLAY FROM STORED TIMESTAMP — NO NETWORK CALL (USE ON PAGE NAVIGATION)
    function refreshSyncDisplay() {
        const el = document.getElementById('syncLastPulled');
        if (!el || _pullTimestampMs == null) return;
        const ageSeconds = (Date.now() - _pullTimestampMs) / 1000;
        el.textContent = 'Last pulled: ' + relativeTime(ageSeconds);
    }

    // RENDER TOP-LEVEL AGGREGATE STAT CARDS
    function _renderTotals(t) {
        const el = document.getElementById('summaryTotals');
        const cards = [
            { label: _labels.movie, value: _fmt(t.movieCount), sub: t.totalMovieDurationFormatted || '' },
            { label: _labels.show, value: _fmt(t.showCount), sub: '' },
            { label: 'Seasons', value: _fmt(t.seasonCount), sub: '' },
            { label: 'Episodes', value: _fmt(t.episodeCount), sub: t.totalEpisodeDurationFormatted || '' },
            { label: 'Total Size', value: t.totalSizeFormatted || '—', sub: '' },
        ];
        el.innerHTML = cards.map(c => `
            <div class="stat-card">
                <div class="stat-card-label">${escapeHTML(c.label)}</div>
                <div class="stat-card-value">${escapeHTML(String(c.value))}</div>
                ${c.sub ? `<div class="stat-card-sub">${escapeHTML(c.sub)}</div>` : ''}
            </div>
        `).join('');
    }

    // RENDER ONE CARD PER PLEX LIBRARY
    function _renderLibraryCards(libraries) {
        const el = document.getElementById('libraryGrid');
        el.innerHTML = libraries.map(lib =>
            lib.loading ? _libraryCardSkeletonHTML(lib) : _libraryCardHTML(lib)
        ).join('');
    }

    function _libraryCardHTML(lib) {
        const typeClass = lib.type === 'movie' ? 'library-type-movie' : 'library-type-show';
        const typeLabel = lib.type === 'movie' ? _labels.movie : _labels.show;

        // BUILD STATS ROWS BASED ON LIBRARY TYPE
        let rows = '';
        if (lib.type === 'movie') {
            rows = [
                [_labels.movie, _fmt(lib.count)],
                ['Total Size', lib.totalSizeFormatted || '—'],
                ['Total Duration', lib.totalDurationFormatted || '—'],
            ].map(_statRowHTML).join('');
        } else {
            rows = [
                [_labels.show, _fmt(lib.showCount)],
                ['Seasons', _fmt(lib.seasonCount)],
                ['Episodes', _fmt(lib.episodeCount)],
                ['Total Size', lib.totalSizeFormatted || '—'],
                ['Total Duration', lib.totalDurationFormatted || '—'],
            ].map(_statRowHTML).join('');
        }

        // NAMING HEALTH SECTION (ONLY IF NAMING CACHE IS WARM)
        const healthHTML = _namingHealthHTML(lib.namingHealth);

        return `
            <div class="library-card" data-library-title="${escapeHTML(lib.title)}">
                <div class="library-card-header">
                    <span class="library-card-title">${escapeHTML(lib.title)}</span>
                    <span class="library-type-badge ${typeClass}">${typeLabel}</span>
                </div>
                <div class="library-card-body">
                    ${rows}
                    ${healthHTML}
                </div>
            </div>
        `;
    }

    function _libraryCardSkeletonHTML(lib) {
        const typeClass = lib.type === 'movie' ? 'library-type-movie' : 'library-type-show';
        const typeLabel = lib.type === 'movie' ? _labels.movie : _labels.show;
        const rowCount  = lib.type === 'movie' ? 3 : 5;
        const shimmerRows = Array.from({ length: rowCount }, (_, i) =>
            `<div class="shimmer-line ${i % 2 === 0 ? 'shimmer-line--wide' : 'shimmer-line--med'}"></div>`
        ).join('');
        return `
            <div class="library-card" data-library-title="${escapeHTML(lib.title)}">
                <div class="library-card-header">
                    <span class="library-card-title">${escapeHTML(lib.title)}</span>
                    <span class="library-type-badge ${typeClass}">${typeLabel}</span>
                </div>
                <div class="library-card-body">
                    ${shimmerRows}
                    <div class="library-card-fetching-label">
                        <span class="library-card-fetching-dot"></span>Fetching data…
                    </div>
                </div>
            </div>
        `;
    }

    function _statRowHTML([label, value]) {
        return `
            <div class="library-stat-row">
                <span class="library-stat-label">${escapeHTML(label)}</span>
                <span class="library-stat-value">${escapeHTML(String(value))}</span>
            </div>
        `;
    }

    // MAP A 0-100 PERCENT TO THE NAMING-HEALTH COLOR CLASS
    function _healthClass(pct) {
        if (pct >= 95) return 'pct-good';
        if (pct >= 80) return 'pct-warn';
        return 'pct-bad';
    }

    // NAMING HEALTH BAR — ONLY SHOWN WHEN NAMING CACHE IS POPULATED
    function _namingHealthHTML(health) {
        if (!health) {
            return `<div class="naming-health naming-health--loading"><div class="naming-health-spinner"></div><span class="naming-health-loading-label">Loading naming data…</span></div>`;
        }
        const pct = health.percent;
        const cls = _healthClass(pct);
        return `
            <div class="naming-health">
                <div class="naming-health-header">
                    <span class="naming-health-label">Naming Health</span>
                    <span class="naming-health-pct ${cls}">${pct}%</span>
                </div>
                <div class="naming-health-bar">
                    <div class="naming-health-fill ${cls}" style="width:${pct}%"></div>
                </div>
                <div class="library-stat-row" style="margin-top:6px;">
                    <span class="library-stat-label">Correct / Incorrect</span>
                    <span class="library-stat-value">${_fmt(health.ok)} / ${_fmt(health.issues)}</span>
                </div>
            </div>
        `;
    }

    // --------------------------------------------------------
    // UI STATE HELPERS
    // --------------------------------------------------------

    function _showLoading() {
        document.getElementById('homeLoading').style.display = '';
        document.getElementById('homeContent').style.display = 'none';
        document.getElementById('homeError').style.display = 'none';
    }

    function _showError(msg) {
        document.getElementById('homeLoading').style.display = 'none';
        document.getElementById('homeContent').style.display = 'none';
        document.getElementById('homeError').style.display = '';
        document.getElementById('homeErrorMsg').textContent = msg || 'Failed to load summary.';
    }

    function _updateLoadingPill() {
        const homeContent = document.getElementById('homeContent');
        if (!homeContent) return;
        const hasNullNaming = _summary && (_summary.libraries || []).some(lib => lib.namingHealth === null);
        const shouldShow = hasNullNaming || _stats === null;
        let pill = document.getElementById('homeLoadingPill');
        if (shouldShow && !pill) {
            pill = document.createElement('div');
            pill.id = 'homeLoadingPill';
            pill.className = 'home-loading-pill';
            pill.innerHTML = '<span class="home-loading-pill-dot"></span> Fetching remaining data…';
            homeContent.appendChild(pill);
        }
        if (pill) pill.style.display = shouldShow ? '' : 'none';
    }

    // FORMAT NUMBER WITH LOCALE THOUSANDS SEPARATOR
    function _fmt(n) {
        if (n == null) return '—';
        return Number(n).toLocaleString();
    }

    // --------------------------------------------------------
    // PUBLIC API
    // --------------------------------------------------------

    async function _loadStats() {
        if (_stats !== null || _statsPollTimer || _statsLoading) return;
        _statsLoading = true;
        if (typeof ProgressHub !== 'undefined') ProgressHub.setAuxBusy('stats', true, 'Library Statistics');
        try {
            const data = await api('/api/home/stats');
            if (!data.stats) {
                _startStatsPoll(); // KEEPS AUX BUSY OPEN — CLEARED BY _stopStatsPoll
                return;
            }
            _stats = data.stats;
            _renderMoreStats(_stats);
            _stopStatsPoll();
        } catch (_) {
            _stats = false;
            if (typeof ProgressHub !== 'undefined') ProgressHub.setAuxBusy('stats', false);
            _updateLoadingPill();
        } finally {
            _statsLoading = false;
        }
    }

    function _renderMoreStats(stats) {
        const existing = document.getElementById('moreStatsToggle');
        if (existing) existing.remove();
        const existingSection = document.getElementById('moreStatsSection');
        if (existingSection) existingSection.remove();

        const grid = document.getElementById('libraryGrid');
        if (!grid) return;
        const open = localStorage.getItem('moreStatsOpen') !== 'false';

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'moreStatsToggle';
        toggleBtn.className = 'more-stats-toggle';
        toggleBtn.innerHTML = `<span id="moreStatsArrow">${open ? '&#9650;' : '&#9660;'}</span>&nbsp;${open ? 'Hide Stats' : 'More Stats'}`;
        grid.after(toggleBtn);

        const section = document.createElement('div');
        section.id = 'moreStatsSection';
        section.className = 'more-stats-section' + (open ? '' : ' hidden');

        // _buildStatsHTML RETURNS { html, clickHandlers }
        const { html, clickHandlers } = _buildStatsHTML(stats);
        section.innerHTML = html;
        toggleBtn.after(section);

        // DELEGATED CLICK LISTENER FOR CLICKABLE STAT BARS AND CHIPS
        if (clickHandlers.size > 0) {
            section.addEventListener('click', (ev) => {
                const el = ev.target.closest('.stat-bar-row--clickable, .stat-chip--clickable, .subtitle-legend-without--link');
                if (!el) return;
                const group = el.closest('[data-group]');
                if (!group) return;
                const handler = clickHandlers.get(group.dataset.group);
                if (!handler) return;
                handler(el.dataset.value);
            });
            section.addEventListener('keydown', (ev) => {
                if (ev.key !== 'Enter' && ev.key !== ' ') return;
                const el = ev.target.closest('.stat-bar-row--clickable, .stat-chip--clickable, .subtitle-legend-without--link');
                if (!el) return;
                ev.preventDefault();
                el.click();
            });
        }

        toggleBtn.addEventListener('click', () => {
            const isOpen = !section.classList.contains('hidden');
            section.classList.toggle('hidden', isOpen);
            const newOpen = !isOpen;
            toggleBtn.innerHTML = `<span id="moreStatsArrow">${newOpen ? '&#9650;' : '&#9660;'}</span>&nbsp;${newOpen ? 'Hide Stats' : 'More Stats'}`;
            localStorage.setItem('moreStatsOpen', String(newOpen));
        });
    }

    // FIND FIRST LIBRARY TITLE OF A GIVEN TYPE FROM THE HOME SUMMARY
    function _findLibraryTitle(type) {
        if (!_summary || !_summary.libraries) return null;
        const lib = _summary.libraries.find(l => l.type === type);
        return lib ? lib.title : null;
    }

    function _buildStatsHTML(stats) {
        const e = s => escapeHTML(String(s));
        const fmt = n => Number(n).toLocaleString();
        const parts = [];
        const clickHandlers = new Map(); // groupKey -> handler(rawName)

        const movieLib = _findLibraryTitle('movie');
        const showLib  = _findLibraryTitle('show');

        // HELPER: WRAP A stats-group WITH data-group ATTRIBUTE FOR CLICK DELEGATION
        function _withGroup(html, groupKey) {
            return html.replace('<div class="stats-group"', `<div class="stats-group" data-group="${groupKey}"`);
        }

        if (stats.containers && Object.keys(stats.containers).length > 0) {
            const sorted = Object.entries(stats.containers).sort((a, b) => b[1] - a[1]).slice(0, 4);
            const cb = movieLib ? (name) => SizeDash.navigateWithFilter(movieLib, { filterType: 'picklist', filterKey: 'container', filterValue: name.toLowerCase() }) : null;
            parts.push(_withGroup(_barGroupHTML(sorted, 'Containers \u2014 Movies', e, fmt, cb), 'containers'));
            if (cb) clickHandlers.set('containers', cb);
        }
        if (stats.codecs && Object.keys(stats.codecs).length > 0) {
            const sorted = Object.entries(stats.codecs).sort((a, b) => b[1] - a[1]).slice(0, 4);
            const cb = movieLib ? (name) => SizeDash.navigateWithFilter(movieLib, { filterType: 'picklist', filterKey: 'videoCodec', filterValue: name.toLowerCase() }) : null;
            parts.push(_withGroup(_barGroupHTML(sorted, 'Video Codecs \u2014 Movies', e, fmt, cb), 'codecs'));
            if (cb) clickHandlers.set('codecs', cb);
        }
        if (stats.resolutions && Object.keys(stats.resolutions).length > 0) {
            const ORDER = ['4k', '1080', '720', '480', 'sd'];
            const sorted = Object.entries(stats.resolutions).sort((a, b) => {
                const ai = ORDER.indexOf(a[0]), bi = ORDER.indexOf(b[0]);
                return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
            });
            const cb = movieLib ? (name) => SizeDash.navigateWithFilter(movieLib, { filterType: 'picklist', filterKey: 'resolution', filterValue: name }) : null;
            parts.push(_withGroup(_barGroupHTML(sorted, 'Resolutions — Movies', e, fmt, cb), 'resolutions'));
            if (cb) clickHandlers.set('resolutions', cb);
        }
        if (stats.decades && Object.keys(stats.decades).length > 0) {
            const sorted = Object.entries(stats.decades).sort((a, b) => b[1] - a[1]);
            const [topDecade, topCount] = sorted[0];
            const cb = movieLib ? (name) => {
                const start = parseInt(name);
                SizeDash.navigateWithFilter(movieLib, { filterType: 'function', filterKey: 'year', filterValue: y => y >= start && y < start + 10 });
            } : null;
            const chips = sorted.slice(0, 6).map(([d, c]) =>
                cb
                    ? `<span class="stat-chip stat-chip--clickable" data-value="${e(d)}" tabindex="0" role="button" title="Browse ${e(d)}">${e(d)} <span class="stat-chip-count">${fmt(c)}</span></span>`
                    : `<span class="stat-chip">${e(d)} <span class="stat-chip-count">${fmt(c)}</span></span>`
            ).join('');
            parts.push(`<div class="stats-group" ${cb ? 'data-group="decades"' : ''}><div class="stats-group-label">Decades — Movies</div><div class="stats-highlight">${e(topDecade)}</div><div class="stats-highlight-sub">${fmt(topCount)} titles</div><div style="margin-top:10px;">${chips}</div></div>`);
            if (cb) clickHandlers.set('decades', cb);
        }
        if (stats.genres && Object.keys(stats.genres).length > 0) {
            const sorted = Object.entries(stats.genres).sort((a, b) => b[1] - a[1]).slice(0, 6);
            const cb = movieLib ? (name) => SizeDash.navigateWithFilter(movieLib, { filterType: 'text', filterKey: 'genres', filterValue: name }) : null;
            const chips = sorted.map(([g, c]) =>
                cb
                    ? `<span class="stat-chip stat-chip--clickable" data-value="${e(g)}" tabindex="0" role="button" title="Browse ${e(g)}">${e(g)} <span class="stat-chip-count">${fmt(c)}</span></span>`
                    : `<span class="stat-chip">${e(g)} <span class="stat-chip-count">${fmt(c)}</span></span>`
            ).join('');
            parts.push(`<div class="stats-group" ${cb ? 'data-group="genres"' : ''}><div class="stats-group-label">Top Genres — Movies</div><div style="margin-top:4px;">${chips}</div></div>`);
            if (cb) clickHandlers.set('genres', cb);
        }
        if (stats.subtitles && stats.subtitles.total > 0) {
            const { with: withSubs, without: withoutSubs, total, langs } = stats.subtitles;
            const withPct = Math.round((withSubs / total) * 100);
            const withoutPct = 100 - withPct;
            const langCb = movieLib ? (name) => SizeDash.navigateWithFilter(movieLib, { filterType: 'text', filterKey: 'subtitleLanguages', filterValue: name }) : null;
            const withoutCb = movieLib ? () => SizeDash.navigateWithFilter(movieLib, { filterType: 'quick', filterKey: 'subtitles', filterValue: 'none' }) : null;
            const langChips = Object.entries(langs || {})
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([lang, cnt]) =>
                    langCb
                        ? `<span class="stat-chip stat-chip--clickable" data-value="${e(lang)}" tabindex="0" role="button" title="Browse ${e(lang)} subtitles">${e(lang)} <span class="stat-chip-count">${fmt(cnt)}</span></span>`
                        : `<span class="stat-chip">${e(lang)} <span class="stat-chip-count">${fmt(cnt)}</span></span>`
                ).join('');
            const withoutSpan = withoutCb
                ? `<span class="subtitle-legend-without subtitle-legend-without--link" data-group="subtitleWithout" tabindex="0" role="button" title="Browse movies without subtitles">&#9646; ${fmt(withoutSubs)} without</span>`
                : `<span class="subtitle-legend-without">&#9646; ${fmt(withoutSubs)} without</span>`;
            parts.push(`
                <div class="stats-group" ${langCb ? 'data-group="subtitleLangs"' : ''}>
                    <div class="stats-group-label">Subtitles — Movies</div>
                    <div class="subtitle-split-bar">
                        <div class="subtitle-split-with" style="width:${withPct}%" title="${fmt(withSubs)} with subtitles"></div>
                        <div class="subtitle-split-without" style="width:${withoutPct}%" title="${fmt(withoutSubs)} without subtitles"></div>
                    </div>
                    <div class="subtitle-split-legend">
                        <span class="subtitle-legend-with">&#9646; ${fmt(withSubs)} with subs</span>
                        <span class="subtitle-legend-pct">${withPct}%</span>
                        ${withoutSpan}
                    </div>
                    ${langChips ? `<div class="stats-group-label" style="margin-top:14px;margin-bottom:8px;">Top Languages</div><div>${langChips}</div>` : ''}
                </div>
            `);
            if (langCb) clickHandlers.set('subtitleLangs', langCb);
            if (withoutCb) clickHandlers.set('subtitleWithout', withoutCb);
        }
        if (stats.audioChannels && Object.keys(stats.audioChannels).length > 0) {
            const CHANNEL_ORDER = ['7.1', '5.1', '2.0'];
            const sorted = Object.entries(stats.audioChannels).sort((a, b) => {
                const ai = CHANNEL_ORDER.indexOf(a[0]);
                const bi = CHANNEL_ORDER.indexOf(b[0]);
                if (ai !== -1 && bi !== -1) return ai - bi;
                if (ai !== -1) return -1;
                if (bi !== -1) return 1;
                return b[1] - a[1];
            });
            const cb = movieLib ? (name) => SizeDash.navigateWithFilter(movieLib, { filterType: 'text', filterKey: 'audioChannelsFormatted', filterValue: name }) : null;
            parts.push(_withGroup(_barGroupHTML(sorted, 'Audio Channels \u2014 Movies', e, fmt, cb), 'audioChannels'));
            if (cb) clickHandlers.set('audioChannels', cb);
        }
        if (stats.showStatuses && Object.keys(stats.showStatuses).length > 0) {
            const STATUS_ORDER = ['Returning', 'Airing', 'Ended', 'Finished', 'Canceled'];
            const sorted = Object.entries(stats.showStatuses).sort((a, b) => {
                const ai = STATUS_ORDER.indexOf(a[0]);
                const bi = STATUS_ORDER.indexOf(b[0]);
                if (ai !== -1 && bi !== -1) return ai - bi;
                if (ai !== -1) return -1;
                if (bi !== -1) return 1;
                return b[1] - a[1];
            });
            const cb = showLib ? (name) => SizeDash.navigateWithFilter(showLib, { filterType: 'picklist', filterKey: 'showStatus', filterValue: name }) : null;
            parts.push(_withGroup(_barGroupHTML(sorted, 'Show Status — Shows', e, fmt, cb), 'showStatuses'));
            if (cb) clickHandlers.set('showStatuses', cb);
        }
        if (stats.showContentRatings && Object.keys(stats.showContentRatings).length > 0) {
            const CR_ORDER = ['TV-MA', 'TV-14', 'TV-PG', 'TV-G', 'TV-Y7', 'TV-Y'];
            const sorted = Object.entries(stats.showContentRatings).filter(([, c]) => c >= 10).sort((a, b) => {
                const ai = CR_ORDER.indexOf(a[0]);
                const bi = CR_ORDER.indexOf(b[0]);
                if (ai !== -1 && bi !== -1) return ai - bi;
                if (ai !== -1) return -1;
                if (bi !== -1) return 1;
                return b[1] - a[1];
            });
            const cb = showLib ? (name) => SizeDash.navigateWithFilter(showLib, { filterType: 'picklist', filterKey: 'contentRating', filterValue: name }) : null;
            parts.push(_withGroup(_barGroupHTML(sorted, 'Content Ratings \u2014 Shows', e, fmt, cb), 'showContentRatings'));
            if (cb) clickHandlers.set('showContentRatings', cb);
        }
        return { html: parts.join(''), clickHandlers };
    }

    // ONCCLICKROW: IF PROVIDED, ROWS RENDER AS CLICKABLE WITH DATA-VALUE ATTRIBUTE
    function _barGroupHTML(entries, label, e, fmt, onClickRow) {
        const max = entries.length > 0 ? entries[0][1] : 1;
        const rows = entries.map(([name, count]) => {
            const pct = max > 0 ? Math.round((count / max) * 100) : 0;
            if (onClickRow) {
                return `<div class="stat-bar-row stat-bar-row--clickable" data-value="${e(String(name))}" tabindex="0" role="button" title="Search for ${e(String(name))}"><span class="stat-bar-name">${e(String(name).toUpperCase())}</span><div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%"></div></div><span class="stat-bar-count">${fmt(count)}</span></div>`;
            }
            return `<div class="stat-bar-row"><span class="stat-bar-name">${e(String(name).toUpperCase())}</span><div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%"></div></div><span class="stat-bar-count">${fmt(count)}</span></div>`;
        }).join('');
        return `<div class="stats-group" ${onClickRow ? 'data-clickable="1"' : ''}><div class="stats-group-label">${e(label)}</div>${rows}</div>`;
    }

    // WIRE THE GLOBAL REFRESH ALL BUTTON TO INVALIDATE ALL CACHES
    function _setupRefreshAll() {
        const btn = document.getElementById('refreshAllBtn');
        if (!btn) return;
        btn.addEventListener('click', async () => {
            const confirmed = await showConfirm(
                'Sync All Libraries?',
                'This will clear all cached data and reload every library from Plex. Use this if data looks wrong across multiple libraries.'
            );
            if (!confirmed) return;

            const originalHTML = btn.innerHTML;
            const overlay = document.getElementById('syncOverlay');
            btn.disabled = true;
            btn.title = 'Refreshing\u2026';
            if (overlay) overlay.classList.add('sync-overlay--visible');
            try {
                await api('/api/sync', { method: 'POST' });
                // INVALIDATE JS-SIDE CACHES IN ALL PAGE MODULES
                for (const m of [
                    typeof SizeDash !== 'undefined' ? SizeDash : null,
                    typeof NamingDash !== 'undefined' ? NamingDash : null,
                ]) {
                    if (m && m.invalidateCache) m.invalidateCache();
                }
                // RE-FETCH THE ACTIVE PAGE'S LIBRARY IF USER IS ON A NON-HOME PAGE
                const currentPage = getHashPage();
                const refreshMap = {
                    naming: typeof NamingDash !== 'undefined' ? NamingDash : null,
                    size:   typeof SizeDash   !== 'undefined' ? SizeDash   : null,
                };
                if (refreshMap[currentPage]?.refreshActive) await refreshMap[currentPage].refreshActive();
                showToast('All caches cleared. Refreshing libraries…', 'info');
                // OLD DATA STAYS VISIBLE — OVERLAY EACH CARD WHILE ITS WORKER RUNS
                const grid = document.getElementById('libraryGrid');
                if (grid) {
                    for (const card of grid.querySelectorAll('.library-card[data-library-title]')) {
                        card.classList.add('library-card--refreshing');
                        delete card.dataset.patching;
                        const overlay = document.createElement('div');
                        overlay.className = 'library-card-refreshing-overlay';
                        overlay.innerHTML = '<span class="library-card-refreshing-dot"></span>Refreshing…';
                        card.appendChild(overlay);
                    }
                }
                _stopLibraryPoll(false);
                _startLibraryPoll();
                updateSyncAge();
            } catch (err) {
                showToast('Refresh failed: ' + (err.message || err), 'error');
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalHTML;
                btn.title = 'Sync all libraries from Plex — clears every cache and re-fetches everything.';
                if (overlay) overlay.classList.remove('sync-overlay--visible');
            }
        });
    }

    return { init, reload, updateSyncAge, refreshSyncDisplay };
})();
