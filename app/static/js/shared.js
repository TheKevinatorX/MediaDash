// ###################################
// # SHARED JS UTILITIES — ALL PAGES #
// ###################################

//===================
// API & TEXT HELPERS
//===================
// Fetch wrapper: parse JSON, throw on non-2xx
async function api(path, options = {}) {
    const res = await fetch(path, options);
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
            const data = await res.json();
            msg = data.error || data.message || msg;
        } catch (parseErr) {
            console.warn(`API error body parse failed: ${path}`, parseErr?.message || parseErr);
        }
        throw new Error(msg);
    }
    return res.json();
}

// Escape html special characters to prevent XSS
function escapeHTML(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Truncate string to max length with ellipsis
function truncate(str, max = 60) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max - 1) + '\u2026' : str;
}

//====================
// TOAST NOTIFICATIONS
//====================
// Show brief toast notification
function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-visible'));
    setTimeout(() => {
        toast.classList.remove('toast-visible');
        toast.addEventListener('transitionend', () => toast.remove());
    }, duration);
}

//=====================
// APP HEALTH & VERSION
//=====================
// Poll health endpoint and update status pill
function checkHealth() {
    const pill = document.getElementById('plexStatus');
    const dot = document.getElementById('healthDot');
    const label = document.getElementById('healthLabel');
    const badge = document.getElementById('serverBadge');

    fetch('/api/health')
        .then(r => r.json())
        .then(data => {
            const ok = data.status === 'ok';
            if (pill) {
                pill.className = 'plex-status ' + (ok ? 'healthy' : 'unhealthy');
                pill.title = ok
                    ? `Plex connected${data.plex && data.plex.name ? ' — ' + data.plex.name : ''}`
                    : 'Plex disconnected or degraded';
            }
            if (label) label.textContent = ok ? 'Connected' : 'Disconnected';
            if (badge && data.plex && data.plex.name) badge.textContent = data.plex.name;
        })
        .catch((err) => {
            console.warn('Health poll failed: /api/health', err?.message || err);
            if (pill) pill.className = 'plex-status unhealthy';
            if (label) label.textContent = 'Offline';
        });
}

// Load version badge and update indicator from API
function loadVersion() {
    const badge = document.getElementById('appVersion');
    const dot   = document.getElementById('versionDot');
    const pill  = document.getElementById('versionUpdatePill');
    if (!badge) return;

    if (dot) {
        dot.className = 'version-status-dot checking';
        dot.title = 'Checking version...';
    }

    function setVersionBadge(data) {
        const display = data.display || (data.version && data.version !== 'unknown' ? 'v' + data.version : 'unknown');
        badge.textContent = display;
        badge.classList.toggle('dev', !!data.is_dev);
        badge.classList.toggle('release', !data.is_dev);
        badge.classList.remove('has-update');

        const bits = [];
        bits.push(data.is_dev ? 'Local development build' : 'Release build');
        if (data.version && data.version !== display) bits.push('base v' + data.version);
        if (data.image) bits.push(data.image);
        if (data.image_tag) bits.push('tag ' + data.image_tag);
        if (data.commit) bits.push('commit ' + data.commit);
        badge.title = bits.join(' · ');
    }

    fetch('/api/version')
        .then(r => r.json())
        .then(data => {
            setVersionBadge(data);
        })
        .catch((err) => {
            console.warn('Version load failed: /api/version', err?.message || err);
            badge.textContent = 'unknown';
            badge.className = 'app-version';
        });

    fetch('/api/version/check')
        .then(r => r.json())
        .then(data => {
            if (!dot) return;
            const runtime = data.runtime || {};
            if (runtime.display) setVersionBadge(runtime);

            if (data.status === 'current') {
                dot.className = runtime.is_dev ? 'version-status-dot dev' : 'version-status-dot current';
                dot.title = runtime.is_dev
                    ? 'Local development build. Latest release: v' + data.latest
                    : 'Up to date: v' + data.latest;
                if (pill) pill.className = 'version-update-pill';
            } else if (data.status === 'outdated') {
                if (runtime.is_dev) {
                    dot.className = 'version-status-dot dev';
                    dot.title = 'Local development build. Latest release: v' + data.latest;
                    if (pill) {
                        pill.textContent = 'Latest v' + data.latest;
                        pill.title = 'Latest published release from ' + (data.source || 'registry');
                        pill.className = 'version-update-pill visible dev';
                    }
                } else {
                    dot.className = 'version-status-dot outdated';
                    dot.title = 'Update available: v' + data.latest;
                    badge.classList.add('has-update');
                    if (pill) {
                        pill.textContent = 'Update v' + data.latest;
                        pill.title = 'New version available from ' + (data.source || 'registry');
                        pill.className = 'version-update-pill visible';
                    }
                }
            } else {
                dot.className = 'version-status-dot';
                dot.title = data.message || 'Version check unavailable';
                if (pill) pill.className = 'version-update-pill';
            }
        })
        .catch((err) => {
            console.warn('Version check failed: /api/version/check', err?.message || err);
            if (dot) {
                dot.className = 'version-status-dot';
                dot.title = 'Version check unavailable';
            }
            if (pill) pill.className = 'version-update-pill';
        });
}

// Start health polling
checkHealth();
setInterval(checkHealth, 30000);
loadVersion();

//===================
// CONFIRMATION MODAL
//===================
// Show confirmation dialog — returns Promise<boolean> (true = confirmed)
function showConfirm(title, body, confirmLabel = 'Sync All') {
    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'confirm-backdrop';
        backdrop.innerHTML = `
            <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
                <div class="confirm-dialog-title" id="confirmTitle">${escapeHTML(title)}</div>
                <div class="confirm-dialog-body">${escapeHTML(body)}</div>
                <div class="confirm-dialog-actions">
                    <button class="btn btn-secondary" id="confirmCancel">Cancel</button>
                    <button class="btn btn-accent" id="confirmOk">${escapeHTML(confirmLabel)}</button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);

        const cleanup = (result) => {
            backdrop.remove();
            resolve(result);
        };

        backdrop.querySelector('#confirmOk').addEventListener('click', () => cleanup(true));
        backdrop.querySelector('#confirmCancel').addEventListener('click', () => cleanup(false));
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(false); });

        const onKey = (e) => {
            if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); cleanup(false); }
        };
        document.addEventListener('keydown', onKey);
        backdrop.querySelector('#confirmCancel').focus();
    });
}

//=========================
// FORMAT & COMPARE HELPERS
//=========================
// Format seconds-ago into human readable relative time string
function relativeTime(ageSeconds) {
    if (ageSeconds == null) return null;
    if (ageSeconds < 60) return 'just now';
    if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
    if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)}h ago`;
    return `${Math.floor(ageSeconds / 86400)}d ago`;
}

// MIXED-TYPE COMPARATOR FOR Array#sort — RETURNS -1/0/1
function compareValues(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : (a ? 1 : -1);
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.join(', ').toLowerCase().localeCompare(b.join(', ').toLowerCase());
    }
    return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
}

// Parse int from url/query param with min/max/default fallback
function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

//=========================
// LOCAL STORAGE & VIEWPORT
//=========================
// localStorage wrappers — silently swallow quota/serialization errors
function lsGetJSON(key, fallback) {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    try {
        const parsed = JSON.parse(raw);
        return parsed == null ? fallback : parsed;
    } catch {
        return fallback;
    }
}

function lsSetJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore quota errors */ }
}

// Mobile breakpoint — single source of truth for the phone-layout cutoff
function isMobile() { return window.innerWidth <= 640; }

//===================
// SVG ICONS & BADGES
//===================
// Inline svg icons — checkmark, x, and refresh arrows
function svgCheck(px, strokeWidth = 3, cls = '') {
    return `<svg${cls ? ` class="${cls}"` : ''} width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
}

function svgX(px, strokeWidth = 3) {
    return `<svg width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
}

// Refresh/resync arrows — sized by CSS, not attributes
const SVG_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';

//Green-check / Red-x Status Badge
function statusBadge(ok, px = 12) {
    return ok
        ? `<span class="badge badge-success">${svgCheck(px)}</span>`
        : `<span class="badge badge-error">${svgX(px)}</span>`;
}

//===============
// PAGINATION BAR
//===============
// Render prev/next pagination bar — shared by naming + size pages
// Computes the "start-end" range, hides the bar when there are no items,
// and wires the Previous/Next buttons. The page supplies the info-line text
// after "of" (item count, label, sync badges) and an onPage callback that
// updates its own state and re-renders.
//
// opts:
//   bar        : pagination bar element
//   page       : current page (1-based)
//   totalPages : total page count
//   totalItems : total item count (bar hides when 0)
//   perPage    : items per page
//   totalHTML  : HTML shown after "start-end of " in the info line
//   onPage     : (newPage) => void
function renderPaginationBar(opts) {
    const { bar, page, totalPages, totalItems, perPage, totalHTML, onPage } = opts;
    if (!bar) return;
    if (totalItems === 0) { bar.style.display = 'none'; return; }

    bar.style.display = 'flex';
    const start = (page - 1) * perPage + 1;
    const end = Math.min(page * perPage, totalItems);
    bar.innerHTML = `
        <div class="pagination-info">${start.toLocaleString()}-${end.toLocaleString()} of ${totalHTML}</div>
        <div class="pagination-controls">
            <button class="btn btn-sm" data-page="prev" ${page <= 1 ? 'disabled' : ''}>← Previous</button>
            <span class="page-indicator">Page ${page} of ${totalPages || 1}</span>
            <button class="btn btn-sm" data-page="next" ${page >= totalPages ? 'disabled' : ''}>Next →</button>
        </div>
    `;

    bar.querySelector('[data-page="prev"]').addEventListener('click', () => {
        if (page > 1) onPage(page - 1);
    });
    bar.querySelector('[data-page="next"]').addEventListener('click', () => {
        if (page < totalPages) onPage(page + 1);
    });
}
