// ########################################
// # SHARED JS UTILITIES — ALL PAGES     #
// ########################################

// ============================================================
// SHARED JS UTILITIES — USED BY ALL PAGES
// ============================================================

// FETCH WRAPPER: PARSE JSON, THROW ON NON-2XX
async function api(path, options = {}) {
    const res = await fetch(path, options);
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch {}
        throw new Error(msg);
    }
    return res.json();
}

// ESCAPE HTML SPECIAL CHARACTERS TO PREVENT XSS
function escapeHTML(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// TRUNCATE STRING TO MAX LENGTH WITH ELLIPSIS
function truncate(str, max = 60) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max - 1) + '\u2026' : str;
}

// SHOW BRIEF TOAST NOTIFICATION
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

// POLL HEALTH ENDPOINT AND UPDATE STATUS PILL
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
        .catch(() => {
            if (pill) pill.className = 'plex-status unhealthy';
            if (label) label.textContent = 'Offline';
        });
}

// LOAD VERSION BADGE AND UPDATE INDICATOR FROM API
function loadVersion() {
    const badge = document.getElementById('appVersion');
    const dot   = document.getElementById('versionDot');
    if (!badge) return;

    fetch('/api/version')
        .then(r => r.json())
        .then(data => {
            if (data.version && data.version !== 'unknown') {
                badge.textContent = 'v' + data.version;
            }
        })
        .catch(() => {});

    if (!dot) return;
    fetch('/api/version/check')
        .then(r => r.json())
        .then(data => {
            if (data.status === 'current') {
                dot.className = 'version-status-dot current';
                dot.title = 'Up to date';
            } else if (data.status === 'outdated') {
                dot.className = 'version-status-dot outdated';
                dot.title = 'Update available: v' + data.latest;
            }
            // unconfigured or error: dot stays hidden
        })
        .catch(() => {});
}

// START HEALTH POLLING
checkHealth();
setInterval(checkHealth, 30000);
loadVersion();

// SHOW CONFIRMATION DIALOG — returns Promise<boolean> (true = confirmed)
function showConfirm(title, body) {
    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'confirm-backdrop';
        backdrop.innerHTML = `
            <div class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
                <div class="confirm-dialog-title" id="confirmTitle">${escapeHTML(title)}</div>
                <div class="confirm-dialog-body">${escapeHTML(body)}</div>
                <div class="confirm-dialog-actions">
                    <button class="btn btn-secondary" id="confirmCancel">Cancel</button>
                    <button class="btn btn-accent" id="confirmOk">Sync All</button>
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

// FORMAT SECONDS-AGO INTO HUMAN READABLE RELATIVE TIME STRING
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

// PARSE INT FROM URL/QUERY PARAM WITH MIN/MAX/DEFAULT FALLBACK
function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

// LOCALSTORAGE WRAPPERS — SILENTLY SWALLOW QUOTA/SERIALIZATION ERRORS
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
