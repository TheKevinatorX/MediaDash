// ################################################
// # PROGRESS HUB — BACKGROUND TASK PANEL       #
// ################################################

// ============================================================
// PROGRESS HUB — GLOBAL BACKGROUND ANALYSIS PANEL
// ============================================================

const ProgressHub = (() => {
    const POLL_INTERVAL        = 3000;  // MS BETWEEN POLLS
    const RATE_HISTORY_MAX     = 10;    // SAMPLES KEPT PER TASK FOR RATE CALCULATION
    const ETA_MIN_SAMPLES      = 3;     // SAMPLES REQUIRED BEFORE SHOWING ETA

    let _pollTimer             = null;
    let _completeTimer         = null;
    let _isVisible             = false;
    let _isComplete            = false;
    let _isCollapsed           = false;
    let _firstPoll             = true;
    let _isInitializing        = false;
    let _initGraceCount        = 0;
    const INIT_GRACE_POLLS     = 3;
    let _rateHistory           = {};           // KEY -> [{TS, CURRENT}, ...]
    let _taskSnapshot          = {};           // KEY -> LAST-KNOWN ACTIVE TASK DATA
    let _completedTasks        = [];           // [{KEY, LIBRARY, TYPE, COMPLETEDAT}, ...]
    let _auxBusy               = {};           // KEY -> LABEL — FRONTEND-DRIVEN LOADING TASKS
    let _taskStartTimes        = {};           // KEY -> TIMESTAMP WHEN TASK FIRST APPEARED
    let _touchStartY           = 0;
    let _expandedCompletedKeys = new Set();

    // DOM HELPER — LAZILY RESOLVED
    const $ = id => document.getElementById(id);

    // --------------------------------------------------------
    // PUBLIC
    // --------------------------------------------------------

    function init() {
        const hub0 = $('progressHub');
        if (!hub0 || hub0.dataset.phubInit) return;
        hub0.dataset.phubInit = '1';

        _isCollapsed = localStorage.getItem('phubCollapsed') === '1';
        if (_isCollapsed) $('progressHub').classList.add('phub--collapsed');

        $('phubHeader').addEventListener('click', _onHeaderClick);

        const closeBtn = $('phubClose');
        if (closeBtn) closeBtn.addEventListener('click', _hide);
        _initSwipe();

        $('phubTitle').textContent      = 'Connecting…';
        $('phubBadge').textContent      = '…';
        $('phubFooterText').textContent = 'Checking Plex status';
        const tasks = $('phubTasks');
        if (tasks) {
            tasks.innerHTML = `
                <div class="phub-init-row">
                    <span class="phub-init-text">Connecting to Plex…</span>
                    <div class="phub-init-bar-track"><div class="phub-init-bar"></div></div>
                </div>`;
        }
        _isInitializing = true;
        _show();
        _schedulePoll();
    }

    // --------------------------------------------------------
    // POLLING
    // --------------------------------------------------------

    function _schedulePoll() {
        // FIRST POLL FIRES QUICKLY; SUBSEQUENT POLLS USE THE FULL INTERVAL
        const delay = _firstPoll ? 600 : POLL_INTERVAL;
        _firstPoll  = false;
        _pollTimer  = setTimeout(_poll, delay);
    }

    async function _poll() {
        try {
            const data = await api('/api/progress');
            _update(data.tasks || []);
        } catch (_) {
            if (_isInitializing) {
                _isInitializing = false;
                _initGraceCount = 0;
                _hide();
            }
        }
        _schedulePoll();
    }

    // --------------------------------------------------------
    // STATE UPDATE
    // --------------------------------------------------------

    function _update(tasks) {
        const active = tasks.filter(t => t.status === 'running' || t.status === 'pending');

        if (_isInitializing) {
            if (active.length === 0) {
                _initGraceCount++;
                if (_initGraceCount < INIT_GRACE_POLLS) return; // keep "Connecting…" visible
                _isInitializing = false;
                _initGraceCount = 0;
                const tasksEl = $('phubTasks');
                if (tasksEl) tasksEl.innerHTML = '';
                _hide();
                return;
            }
            _isInitializing = false;
            _initGraceCount = 0;
            const tasksEl = $('phubTasks');
            if (tasksEl) tasksEl.innerHTML = '';
        }

        const activeKeys = new Set(active.map(t => t.key));
        const now = Date.now();

        // TRACK NEWLY-FINISHED TASKS WHILE OTHERS ARE STILL RUNNING
        if (active.length > 0) {
            for (const [key, snap] of Object.entries(_taskSnapshot)) {
                if (!activeKeys.has(key) && !_completedTasks.find(c => c.key === key)) {
                    const startedAt = _taskStartTimes[key] || now;
                    _completedTasks.push({
                        key,
                        library:     snap.library,
                        type:        snap.type,
                        startedAt,
                        completedAt: now,
                        duration:    now - startedAt,
                        finalCount:  snap.current,
                        finalTotal:  snap.total,
                        finalStep:   snap.step,
                    });
                }
            }
        }

        _taskSnapshot = {};
        for (const t of active) _taskSnapshot[t.key] = t;

        if (active.length === 0) {
            if (Object.keys(_auxBusy).length > 0) {
                // BACKEND IDLE BUT FRONTEND TASKS STILL RUNNING — KEEP HUB OPEN
                const container = $('phubTasks');
                if (container) container.innerHTML = '';
                _renderAuxTasks();
                _updateHeaderForAux();
                if (!_isVisible) _show();
            } else if (_isVisible && !_isComplete) {
                _triggerComplete();
            }
            return;
        }

        _isComplete = false;
        if (_completeTimer) { clearTimeout(_completeTimer); _completeTimer = null; }

        const hub = $('progressHub');
        hub.classList.remove('phub--complete', 'phub--fading');

        // RECORD FIRST-SEEN TIMESTAMP FOR ELAPSED TIME DISPLAY
        active.forEach(t => {
            if (!_taskStartTimes[t.key]) _taskStartTimes[t.key] = Date.now();
        });

        // UPDATE RATE HISTORY FOR ETA COMPUTATION
        active.forEach(t => {
            if (t.total > 0 && t.current > 0) _pushRate(t.key, t.current);
        });

        _renderTasks(active);

        const n    = active.length;
        const auxN = Object.keys(_auxBusy).length;
        const done = _completedTasks.length;
        $('phubBadge').textContent  = n + auxN;
        $('phubTitle').textContent  = n === 1 ? 'Analyzing Library' : 'Analyzing Libraries';
        const footerParts = [`${n} task${n !== 1 ? 's' : ''} running`];
        if (auxN > 0) footerParts.push(`${auxN} loading`);
        if (done > 0) footerParts.push(`${done} completed`);
        $('phubFooterText').textContent = footerParts.join(' · ');

        if (!_isVisible) _show();
    }

    // --------------------------------------------------------
    // TASK RENDERING
    // --------------------------------------------------------

    function _buildActiveTaskHtml(task) {
        const pct = (task.total > 0 && task.current > 0)
            ? Math.min(Math.round((task.current / task.total) * 100), 99)
            : 0;
        const pending = task.status === 'pending' || (pct === 0 && !task.step);
        const eta     = _computeEta(task.key, task.current, task.total);

        // ELAPSED TIME — shown once the task has been running for at least 5s
        const startTs  = _taskStartTimes[task.key] || Date.now();
        const elapsed  = Math.floor((Date.now() - startTs) / 1000);
        const showTime = !pending && elapsed >= 5;

        // ETA: show remaining + elapsed when both are available
        let etaStr;
        if (pending) {
            etaStr = 'starting…';
        } else if (eta !== null) {
            etaStr = showTime ? `${_fmtEta(eta)} · ${_fmtElapsed(elapsed)}` : _fmtEta(eta);
        } else {
            etaStr = showTime ? _fmtElapsed(elapsed) : 'calculating…';
        }

        // ITEM LABEL — episode tasks and naming tasks count episodes
        const itemLabel = task.type === 'naming' ? 'episodes'
            : (task.step && task.step.toLowerCase().includes('show')) ? 'shows'
            : 'items';
        const counts = (task.total > 0 && task.current >= 0)
            ? `${_fmtN(task.current)} / ${_fmtN(task.total)} ${itemLabel}`
            : 'preparing…';

        return `
            <div class="phub-task-top">
                <div class="phub-task-name">
                    <span class="phub-task-library">${_esc(task.library)}</span>
                    <span class="phub-chip ${_chipCls(task.type)}">${_chipLabel(task.type)}</span>
                </div>
                <span class="phub-task-eta">${_esc(etaStr)}</span>
            </div>
            <div class="phub-task-step">${_esc(task.step || (pending ? 'Initializing…' : 'Working…'))}</div>
            <div class="phub-task-bar-row">
                <div class="phub-task-bar-track">
                    <div class="phub-task-bar-fill${pending ? ' phub-task-bar-fill--indeterminate' : ''}"
                         style="${pending ? '' : `width:${pct}%`}"></div>
                </div>
                <span class="phub-task-pct">${pending ? '' : pct + '%'}</span>
            </div>
            <div class="phub-task-counts">${counts}</div>
        `;
    }

    function _renderTasks(tasks) {
        const container = $('phubTasks');
        if (!container) return;

        const activeKeys = new Set(tasks.map(t => t.key));

        // REMOVE ACTIVE ROWS NO LONGER IN THE ACTIVE SET
        container.querySelectorAll('.phub-task').forEach(el => {
            if (!activeKeys.has(el.dataset.key)) el.remove();
        });

        // INSERT/UPDATE ACTIVE TASK ROWS
        tasks.forEach((task, idx) => {
            const existing = container.querySelector(`.phub-task[data-key="${_cssAttr(task.key)}"]`);
            const html = _buildActiveTaskHtml(task);
            if (existing) {
                existing.innerHTML = html;
            } else {
                const row = document.createElement('div');
                row.className = 'phub-task';
                row.dataset.key = task.key;
                row.style.animationDelay = `${idx * 55}ms`;
                row.innerHTML = html;
                container.appendChild(row);
            }
        });

        _renderCompleted();
        _renderAuxTasks();
    }

    // --------------------------------------------------------
    // AUX TASK RENDERING (FRONTEND-DRIVEN LOADING)
    // --------------------------------------------------------

    function _renderAuxTasks() {
        const container = $('phubTasks');
        if (!container) return;

        // REMOVE STALE AUX ROWS
        container.querySelectorAll('.phub-aux-task').forEach(el => {
            if (!_auxBusy[el.dataset.auxKey]) el.remove();
        });

        // ADD NEW AUX ROWS
        Object.entries(_auxBusy).forEach(([key, label]) => {
            if (container.querySelector(`[data-aux-key="${_cssAttr(key)}"]`)) return;
            const row = document.createElement('div');
            row.className = 'phub-task phub-aux-task';
            row.dataset.auxKey = key;
            row.innerHTML = `
                <div class="phub-task-top">
                    <div class="phub-task-name">
                        <span class="phub-task-library">${_esc(label)}</span>
                    </div>
                    <span class="phub-task-eta">in progress…</span>
                </div>
                <div class="phub-task-bar-row">
                    <div class="phub-task-bar-track">
                        <div class="phub-task-bar-fill phub-task-bar-fill--indeterminate"></div>
                    </div>
                    <span class="phub-task-pct"></span>
                </div>
            `;
            container.appendChild(row);
        });
    }

    function _updateHeaderForAux() {
        const n    = Object.keys(_auxBusy).length;
        const done = _completedTasks.length;
        $('phubBadge').textContent = n;
        $('phubTitle').textContent = 'Loading Data';
        const footerParts = [`${n} task${n !== 1 ? 's' : ''} remaining`];
        if (done > 0) footerParts.push(`${done} completed`);
        $('phubFooterText').textContent = footerParts.join(' · ');
    }

    function _renderCompleted() {
        const panel = $('phubCompletedPanel');
        const list  = $('phubCompletedList');
        const count = $('phubCompletedCount');
        if (!panel || !list || !count) return;

        const hub = $('progressHub');

        if (_completedTasks.length === 0) {
            hub.classList.remove('phub--has-completed');
            list.innerHTML = '';
            return;
        }

        hub.classList.add('phub--has-completed');
        count.textContent = _completedTasks.length;

        _completedTasks.forEach(task => {
            // Update expansion class on existing rows without re-creating them
            const existing = list.querySelector(`[data-key="${_cssAttr(task.key)}"]`);
            if (existing) {
                existing.classList.toggle('phub-completed-item--expanded', _expandedCompletedKeys.has(task.key));
                return;
            }

            const durationStr = (task.duration != null)
                ? _fmtElapsed(Math.round(task.duration / 1000))
                : '—';

            const row = document.createElement('div');
            row.className = 'phub-completed-item';
            row.dataset.key = task.key;
            if (_expandedCompletedKeys.has(task.key)) row.classList.add('phub-completed-item--expanded');

            row.innerHTML = `
                <div class="phub-completed-item-header">
                    <div class="phub-completed-item-name">
                        <span class="phub-task-library">${_esc(task.library)}</span>
                        <span class="phub-chip ${_chipCls(task.type)}">${_chipLabel(task.type)}</span>
                    </div>
                    <div class="phub-completed-item-actions">
                        <span class="phub-done-tag">Done ✓</span>
                        <svg class="phub-completed-item-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="6 9 12 15 18 9"/>
                        </svg>
                    </div>
                </div>
                <div class="phub-completed-detail">
                    <div class="phub-completed-stat-row">
                        <span class="phub-completed-stat-label">Duration</span>
                        <span class="phub-completed-stat-value">${_esc(durationStr)}</span>
                    </div>
                </div>
            `;

            row.addEventListener('click', () => {
                if (_expandedCompletedKeys.has(task.key)) {
                    _expandedCompletedKeys.delete(task.key);
                    row.classList.remove('phub-completed-item--expanded');
                } else {
                    _expandedCompletedKeys.add(task.key);
                    row.classList.add('phub-completed-item--expanded');
                }
            });

            list.appendChild(row);
        });
    }

    // --------------------------------------------------------
    // COMPLETE / SHOW / HIDE
    // --------------------------------------------------------

    function _triggerComplete() {
        _isComplete = true;
        _rateHistory = {};

        // Capture any tasks still active at the moment everything finishes
        const now = Date.now();
        for (const [key, snap] of Object.entries(_taskSnapshot)) {
            if (!_completedTasks.find(c => c.key === key)) {
                const startedAt = _taskStartTimes[key] || now;
                _completedTasks.push({
                    key,
                    library:     snap.library,
                    type:        snap.type,
                    startedAt,
                    completedAt: now,
                    duration:    now - startedAt,
                    finalCount:  snap.current,
                    finalTotal:  snap.total,
                    finalStep:   snap.step,
                });
            }
        }

        const hub       = $('progressHub');
        const container = $('phubTasks');

        hub.classList.add('phub--complete', 'phub--dismissible');
        if (container) {
            container.innerHTML = `
                <div class="phub-complete-row">
                    <div class="phub-complete-icon">✓</div>
                    All tasks complete
                </div>`;
        }
        $('phubBadge').textContent      = '✓';
        $('phubTitle').textContent      = 'All Done';
        $('phubFooterText').textContent = 'Libraries up to date';

        _renderCompleted();
    }

    function _show() {
        _isVisible = true;
        const hub = $('progressHub');
        hub.classList.remove('phub--fading');
        void hub.offsetWidth; // FORCE REFLOW SO TRANSITION FIRES
        hub.classList.add('phub--visible');
    }

    function _hide() {
        if (_completeTimer) { clearTimeout(_completeTimer); _completeTimer = null; }
        _isVisible      = false;
        _isComplete     = false;
        _taskSnapshot   = {};
        _completedTasks = [];
        _taskStartTimes = {};
        _expandedCompletedKeys.clear();
        const hub       = $('progressHub');
        hub.classList.remove('phub--has-completed');
        const list = $('phubCompletedList');
        if (list) list.innerHTML = '';
        hub.classList.add('phub--fading');
        hub.addEventListener('transitionend', () => {
            hub.classList.remove('phub--visible', 'phub--fading', 'phub--complete', 'phub--dismissible');
        }, { once: true });
    }

    // --------------------------------------------------------
    // AUX BUSY — FRONTEND TASKS THAT KEEP THE HUB OPEN
    // --------------------------------------------------------

    function setAuxBusy(key, busy, label) {
        const hub = $('progressHub');
        if (!hub) return;

        if (busy) {
            _auxBusy[key] = label || key;
        } else {
            delete _auxBusy[key];
        }

        const anyAux = Object.keys(_auxBusy).length > 0;

        if (anyAux) {
            if (_completeTimer) { clearTimeout(_completeTimer); _completeTimer = null; }
            _isComplete = false;
            hub.classList.remove('phub--complete', 'phub--fading');
            if (!_isVisible) _show();
            _renderAuxTasks();
            if (Object.keys(_taskSnapshot).length === 0) _updateHeaderForAux();
        } else {
            _renderAuxTasks();
            if (_isVisible && !_isComplete && Object.keys(_taskSnapshot).length === 0) {
                _triggerComplete();
            }
        }
    }

    // --------------------------------------------------------
    // COLLAPSE TOGGLE
    // --------------------------------------------------------

    function _onHeaderClick() {
        _isCollapsed = !_isCollapsed;
        $('progressHub').classList.toggle('phub--collapsed', _isCollapsed);
        localStorage.setItem('phubCollapsed', _isCollapsed ? '1' : '0');
    }

    function _initSwipe() {
        const hub = $('progressHub');
        if (!hub) return;
        hub.addEventListener('touchstart', e => {
            _touchStartY = e.touches[0].clientY;
        }, { passive: true });
        hub.addEventListener('touchend', e => {
            if (!_touchStartY || !hub.classList.contains('phub--dismissible')) return;
            const delta = e.changedTouches[0].clientY - _touchStartY;
            if (delta >= 60) _hide();
        }, { passive: true });
    }

    // --------------------------------------------------------
    // ETA CALCULATION
    // --------------------------------------------------------

    function _pushRate(key, current) {
        if (!_rateHistory[key]) _rateHistory[key] = [];
        const h = _rateHistory[key];
        h.push({ ts: Date.now(), current });
        if (h.length > RATE_HISTORY_MAX) h.shift();
    }

    function _computeEta(key, current, total) {
        if (!total || !current) return null;
        const h = _rateHistory[key];
        if (!h || h.length < ETA_MIN_SAMPLES) return null;
        const oldest  = h[0];
        const newest  = h[h.length - 1];
        const elapsed = (newest.ts - oldest.ts) / 1000;
        if (elapsed < 1) return null;
        const rate = (newest.current - oldest.current) / elapsed;
        if (rate <= 0) return null;
        return Math.round((total - current) / rate); // seconds
    }

    // --------------------------------------------------------
    // HELPERS
    // --------------------------------------------------------

    function _fmtEta(secs) {
        if (secs < 10)   return '< 10 sec left';
        if (secs < 60)   return `~${Math.round(secs / 5) * 5} sec left`;
        if (secs < 3600) return `~${Math.ceil(secs / 60)} min left`;
        return `~${Math.round(secs / 3600)} hr left`;
    }

    function _fmtElapsed(secs) {
        if (secs < 60)   return `${secs}s elapsed`;
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        return s > 0 ? `${m}m ${s}s elapsed` : `${m}m elapsed`;
    }

    function _fmtN(n) {
        return (n || 0).toLocaleString();
    }

    function _chipCls(type) {
        return { search: 'phub-chip--search', naming: 'phub-chip--naming', episodes: 'phub-chip--episodes' }[type]
            || 'phub-chip--unknown';
    }

    function _chipLabel(type) {
        return { search: 'Search', naming: 'Naming', episodes: 'Episodes' }[type] || type;
    }

    // ESCAPE STRING FOR USE AS A CSS ATTRIBUTE SELECTOR VALUE (NO QUOTES)
    function _cssAttr(str) {
        return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/]/g, '\\]');
    }

    function _esc(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    return { init, setAuxBusy };
})();
