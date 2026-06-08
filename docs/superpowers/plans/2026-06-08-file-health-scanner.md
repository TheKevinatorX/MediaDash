# File Health Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a File Health page that scans Plex media files for corruption, zero-byte files, missing streams, and decode errors — with a fast quick-scan pass and a thorough deep-scan pass, results persisted to cache.

**Architecture:** A new `health.py` Flask Blueprint handles all scanning logic and cache I/O. It slots into the existing `BackgroundEnrichment` task system from `sync_progress.py` for background execution and progress reporting. The frontend is a new SPA page in `index.html` following the same structure as Sizes and Naming.

**Tech Stack:** Python 3, Flask Blueprint, `subprocess` (ffprobe/ffmpeg), `json`, `glob` — no new dependencies.

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `app/health.py` | Blueprint, scanning logic, cache read/write, file discovery |
| Modify | `app/app.py` | Register `health_bp`, add `/api/health/results` and `/api/health/scan` routes |
| Modify | `app/templates/index.html` | Add nav link and `#page-health` SPA page |
| Modify | `app/static/css/style.css` | Health page styles (badge chips, summary bar) |
| Modify | `docker-compose.yml` | Add three read-only media volume mounts |

---

## Task 1: Add media volume mounts to Docker Compose

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add the three read-only bind mounts**

Open `docker-compose.yml`. The current `volumes:` block is:

```yaml
    volumes:
      - ./cache:/data/cache
```

Replace with:

```yaml
    volumes:
      - ./cache:/data/cache
      - /media/Movies:/media/Movies:ro
      - /media/FullSeries:/media/FullSeries:ro
      - /media/NAS:/media/NAS:ro
```

- [ ] **Step 2: Verify the compose file is valid**

```bash
cd /home/kevin/Docker/MediaDash
docker compose config --quiet
```

Expected: no output (silent = valid). Any YAML error will print here.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: mount media paths read-only for file health scanning"
```

---

## Task 2: Create `health.py` — cache I/O and file discovery

**Files:**
- Create: `app/health.py`

This task creates the module skeleton with cache read/write and the file discovery function. Scanning logic comes in Tasks 3 and 4.

- [ ] **Step 1: Create `app/health.py` with the skeleton**

```python
######################################
# HEALTH — FILE HEALTH SCANNER       #
######################################

import glob
import json
import logging
import os
import subprocess
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from shared import CACHE_DIR, enrichment

health_bp = Blueprint('health', __name__)
health_logger = logging.getLogger('mediadash.health')

HEALTH_CACHE_FILE = os.path.join(CACHE_DIR, 'health_cache.json')

QUICK_SCAN_KEY = 'health:quick'
DEEP_SCAN_KEY = 'health:deep'

TINY_FILE_THRESHOLD = 1 * 1024 * 1024  # 1 MB

ISSUE_LABELS = {
    'zero_byte':       'File is empty or suspiciously small',
    'unreadable':      'Container cannot be parsed',
    'no_video_stream': 'No video track found',
    'no_audio_stream': 'No audio track found',
    'zero_duration':   'Stream reports zero duration',
    'decode_errors':   'File failed full playback check — may cut off or stutter',
}


# ============================================================
# CACHE I/O
# ============================================================

def _load_health_cache():
    """Return the current health cache or a blank structure."""
    if os.path.exists(HEALTH_CACHE_FILE):
        try:
            with open(HEALTH_CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            health_logger.warning(f"Could not read health cache: {e}")
    return {'quick_scanned_at': None, 'deep_scanned_at': None, 'results': []}


def _save_health_cache(data):
    """Atomically write health cache to disk."""
    tmp = HEALTH_CACHE_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f)
    os.replace(tmp, HEALTH_CACHE_FILE)


# ============================================================
# FILE DISCOVERY
# ============================================================

def _all_cached_items():
    """Yield every item dict from every per-library cache file."""
    for cache_file in glob.glob(os.path.join(CACHE_DIR, '*_cache.json')):
        if os.path.basename(cache_file) == 'health_cache.json':
            continue
        try:
            with open(cache_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        for key, entry in data.items():
            if not key.startswith('search:'):
                continue
            library_title = key.split(':', 1)[1]
            for item in (entry.get('items') or []):
                yield library_title, item


def _collect_scan_targets():
    """
    Return a list of dicts with the fields needed for scanning.
    Skips items with no filePath or whose file does not exist on disk.
    """
    targets = []
    seen = set()
    for library_title, item in _all_cached_items():
        fp = item.get('filePath', '')
        if not fp or fp in seen:
            continue
        seen.add(fp)
        targets.append({
            'filePath': fp,
            'title': item.get('title', ''),
            'library': library_title,
            'fileSize': item.get('fileSize', 0),
        })
    return targets
```

- [ ] **Step 2: Register the blueprint in `app.py`**

Open `app/app.py`. Find the blueprint registration block (around line 65–70):

```python
# REGISTER BLUEPRINTS AFTER APP CREATION TO AVOID CIRCULAR IMPORTS
from naming import naming_bp  # noqa: E402
from size import size_bp  # noqa: E402

app.register_blueprint(naming_bp, url_prefix='/naming')
app.register_blueprint(size_bp, url_prefix='/size')
```

Replace with:

```python
# REGISTER BLUEPRINTS AFTER APP CREATION TO AVOID CIRCULAR IMPORTS
from naming import naming_bp  # noqa: E402
from size import size_bp  # noqa: E402
from health import health_bp  # noqa: E402

app.register_blueprint(naming_bp, url_prefix='/naming')
app.register_blueprint(size_bp, url_prefix='/size')
app.register_blueprint(health_bp, url_prefix='/filehealth')
```

- [ ] **Step 3: Verify the app starts cleanly**

```bash
cd /home/kevin/Docker/MediaDash
docker compose up -d --build
docker compose logs --tail=30 mediadash
```

Expected: no import errors, Flask reports running on port 5010.

- [ ] **Step 4: Commit**

```bash
git add app/health.py app/app.py
git commit -m "feat: scaffold health blueprint with cache I/O and file discovery"
```

---

## Task 3: Quick scan logic

**Files:**
- Modify: `app/health.py`

- [ ] **Step 1: Add ffprobe helper and quick-scan worker to `health.py`**

Add the following after the `_collect_scan_targets` function:

```python
# ============================================================
# QUICK SCAN
# ============================================================

def _ffprobe_file(path):
    """
    Run ffprobe on a single file.
    Returns (success: bool, streams: list) where streams is the parsed JSON
    array from ffprobe, or an empty list on failure.
    """
    try:
        result = subprocess.run(
            [
                'ffprobe', '-v', 'error',
                '-print_format', 'json',
                '-show_streams',
                path,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return False, []
        data = json.loads(result.stdout)
        return True, data.get('streams', [])
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError):
        return False, []


def _quick_scan_file(target):
    """
    Run all quick checks on a single target dict.
    Returns a list of issue keys (empty = clean).
    """
    issues = []
    path = target['filePath']

    # CHECK 1: file exists and is not tiny
    try:
        size_on_disk = os.path.getsize(path)
    except OSError:
        return ['unreadable']

    if size_on_disk < TINY_FILE_THRESHOLD:
        issues.append('zero_byte')
        return issues  # no point probing a near-empty file

    # CHECK 2: ffprobe can parse the container
    ok, streams = _ffprobe_file(path)
    if not ok:
        issues.append('unreadable')
        return issues

    # CHECK 3: stream validation
    has_video = False
    has_audio = False
    for s in streams:
        codec_type = s.get('codec_type', '')
        duration = float(s.get('duration', 0) or 0)
        if codec_type == 'video':
            if duration == 0:
                issues.append('zero_duration')
            else:
                has_video = True
        elif codec_type == 'audio':
            has_audio = True

    if not has_video:
        issues.append('no_video_stream')
    if not has_audio:
        issues.append('no_audio_stream')

    return issues


def _run_quick_scan():
    """Background worker: run quick checks on all cached items and save results."""
    targets = _collect_scan_targets()
    total = len(targets)
    results_by_path = {}

    # SEED WITH EXISTING DEEP-SCAN RESULTS SO THEY ARE NOT LOST
    existing = _load_health_cache()
    for r in existing.get('results', []):
        results_by_path[r['filePath']] = r

    for i, target in enumerate(targets):
        enrichment.update_progress(QUICK_SCAN_KEY, i + 1, total, step=target['title'])
        issues = _quick_scan_file(target)
        if issues:
            entry = results_by_path.get(target['filePath'], {})
            entry.update({
                'filePath': target['filePath'],
                'title': target['title'],
                'library': target['library'],
                'fileSize': target['fileSize'],
                'issues': list(set(entry.get('issues', [])) | set(issues)),
                'quickScanned': True,
                'deepScanned': entry.get('deepScanned', False),
                'scannedAt': datetime.now(timezone.utc).isoformat(),
            })
            results_by_path[target['filePath']] = entry
        else:
            # FILE IS CLEAN — REMOVE FROM RESULTS IF IT WAS PREVIOUSLY FLAGGED
            results_by_path.pop(target['filePath'], None)

    cache_data = _load_health_cache()
    cache_data['quick_scanned_at'] = datetime.now(timezone.utc).isoformat()
    cache_data['results'] = list(results_by_path.values())
    _save_health_cache(cache_data)
    health_logger.info(f"Quick scan complete: {len(results_by_path)} issues found across {total} files")
```

- [ ] **Step 2: Add the API routes to `health.py`**

Add after `_run_quick_scan`:

```python
# ============================================================
# ROUTES
# ============================================================

@health_bp.route('/results')
def get_results():
    data = _load_health_cache()
    data['issueLabels'] = ISSUE_LABELS
    return jsonify(data)


@health_bp.route('/scan', methods=['POST'])
def start_scan():
    mode = request.args.get('mode', 'quick')
    if mode not in ('quick', 'deep'):
        return jsonify({'error': 'mode must be quick or deep'}), 400

    if mode == 'quick':
        key = QUICK_SCAN_KEY
        worker = _run_quick_scan
    else:
        key = DEEP_SCAN_KEY
        worker = _run_deep_scan  # defined in Task 4

    if enrichment.is_running(key):
        return jsonify({'status': 'already_running'})

    enrichment.start(key, worker, priority=3)
    return jsonify({'status': 'started'})
```

- [ ] **Step 3: Verify the quick scan endpoint starts**

Rebuild and curl the scan endpoint:

```bash
docker compose up -d --build
curl -s -X POST "http://localhost:5010/filehealth/scan?mode=quick" | python3 -m json.tool
```

Expected:
```json
{"status": "started"}
```

Then poll progress:

```bash
curl -s http://localhost:5010/api/progress | python3 -m json.tool
```

Expected: a task entry with `"type": "health"` and incrementing `current`/`total`.

After it completes, check results:

```bash
curl -s http://localhost:5010/filehealth/results | python3 -m json.tool | head -40
```

Expected: `quick_scanned_at` is set, `results` contains any flagged files (may be empty if library is healthy).

- [ ] **Step 4: Commit**

```bash
git add app/health.py
git commit -m "feat: add quick scan logic and health API routes"
```

---

## Task 4: Deep scan logic

**Files:**
- Modify: `app/health.py`

- [ ] **Step 1: Add `_run_deep_scan` to `health.py`**

Add after `_run_quick_scan`, before the routes section:

```python
# ============================================================
# DEEP SCAN
# ============================================================

def _ffmpeg_decode_file(path):
    """
    Run a full ffmpeg decode pass to detect truncation or mid-file corruption.
    Returns (error_count: int). A non-zero count means decode errors were found.
    """
    try:
        result = subprocess.run(
            ['ffmpeg', '-v', 'error', '-i', path, '-f', 'null', '-'],
            capture_output=True,
            text=True,
            timeout=3600,  # 1-hour cap per file
        )
        # ffmpeg writes errors to stderr
        error_lines = [
            line for line in result.stderr.splitlines()
            if line.strip() and not line.startswith('ffmpeg version')
        ]
        return len(error_lines)
    except subprocess.TimeoutExpired:
        health_logger.warning(f"ffmpeg timed out on: {path}")
        return 1
    except FileNotFoundError:
        health_logger.error("ffmpeg not found — deep scan unavailable")
        return 0


def _run_deep_scan():
    """Background worker: run full ffmpeg decode on all cached items and enrich results."""
    targets = _collect_scan_targets()
    total = len(targets)

    existing = _load_health_cache()
    results_by_path = {r['filePath']: r for r in existing.get('results', [])}

    for i, target in enumerate(targets):
        enrichment.update_progress(DEEP_SCAN_KEY, i + 1, total, step=target['title'])
        path = target['filePath']

        if not os.path.exists(path):
            continue

        error_count = _ffmpeg_decode_file(path)

        if error_count > 0:
            entry = results_by_path.get(path, {
                'filePath': path,
                'title': target['title'],
                'library': target['library'],
                'fileSize': target['fileSize'],
                'issues': [],
                'quickScanned': False,
                'scannedAt': datetime.now(timezone.utc).isoformat(),
            })
            if 'decode_errors' not in entry['issues']:
                entry['issues'].append('decode_errors')
            entry['deepScanned'] = True
            entry['scannedAt'] = datetime.now(timezone.utc).isoformat()
            results_by_path[path] = entry
        else:
            # DEEP SCAN PASSED — REMOVE decode_errors IF PRESENT, KEEP OTHER ISSUES
            entry = results_by_path.get(path)
            if entry:
                entry['issues'] = [i for i in entry['issues'] if i != 'decode_errors']
                entry['deepScanned'] = True
                if not entry['issues']:
                    results_by_path.pop(path)

    cache_data = _load_health_cache()
    cache_data['deep_scanned_at'] = datetime.now(timezone.utc).isoformat()
    cache_data['results'] = list(results_by_path.values())
    _save_health_cache(cache_data)
    health_logger.info(f"Deep scan complete: {len(results_by_path)} issues found across {total} files")
```

- [ ] **Step 2: Verify ffmpeg is available in the container**

```bash
docker exec MediaDash ffmpeg -version 2>&1 | head -2
docker exec MediaDash ffprobe -version 2>&1 | head -2
```

Expected: version lines for both tools. If either is missing, add it to the Dockerfile:

```dockerfile
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
```

Then rebuild: `docker compose up -d --build`

- [ ] **Step 3: Smoke-test the deep scan endpoint**

Pick one small file to test (use a file path from the quick scan results, or any known media file):

```bash
curl -s -X POST "http://localhost:5010/filehealth/scan?mode=deep" | python3 -m json.tool
```

Expected: `{"status": "started"}`. Poll `/api/progress` to confirm it's running.

- [ ] **Step 4: Commit**

```bash
git add app/health.py
git commit -m "feat: add deep scan (ffmpeg full-decode) logic"
```

---

## Task 5: Health page — HTML structure and nav link

**Files:**
- Modify: `app/templates/index.html`

- [ ] **Step 1: Add the Health nav link**

In `index.html`, find the nav block:

```html
            <nav class="main-nav">
                <a href="#home" class="nav-link" id="nav-home">Home</a>
                <a href="#naming" class="nav-link" id="nav-naming">Naming</a>
                <a href="#size" class="nav-link" id="nav-size">Sizes</a>
            </nav>
```

Replace with:

```html
            <nav class="main-nav">
                <a href="#home" class="nav-link" id="nav-home">Home</a>
                <a href="#naming" class="nav-link" id="nav-naming">Naming</a>
                <a href="#size" class="nav-link" id="nav-size">Sizes</a>
                <a href="#health" class="nav-link" id="nav-health">Health</a>
            </nav>
```

- [ ] **Step 2: Add the Health page `div` to `index.html`**

Find the closing `</div>` of the last existing page (search for `id="page-size"` or `id="page-naming"` — whichever is last). Add the health page block immediately after it, before the `<!-- SETTINGS -->` section or the closing `</div>` of `#app`:

```html
        <!-- HEALTH PAGE -->
        <div id="page-health" class="page" style="display:none;">
            <div class="page-container">
                <div class="page-header">
                    <h2 class="page-title">File Health</h2>
                    <p class="page-subtitle">Scan your media files for corruption, missing streams, and playback issues.</p>
                </div>

                <!-- SCAN CONTROLS -->
                <div class="health-controls">
                    <div class="health-scan-btn-group">
                        <div class="health-scan-action">
                            <button class="btn btn-primary" id="quickScanBtn">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                                Quick Scan
                            </button>
                            <span class="health-last-scanned" id="quickLastScanned"></span>
                        </div>
                        <div class="health-scan-action">
                            <button class="btn btn-ghost" id="deepScanBtn" title="Decodes every file end-to-end. May take 30–60+ minutes on large libraries.">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                                Deep Scan
                            </button>
                            <span class="health-last-scanned" id="deepLastScanned"></span>
                        </div>
                    </div>
                </div>

                <!-- PROGRESS BAR (hidden when idle) -->
                <div class="health-progress-wrap" id="healthProgressWrap" style="display:none;">
                    <div class="health-progress-label" id="healthProgressLabel">Scanning...</div>
                    <div class="health-progress-bar-track">
                        <div class="health-progress-bar-fill" id="healthProgressFill" style="width:0%"></div>
                    </div>
                </div>

                <!-- STALE WARNING -->
                <div class="health-stale-warning" id="healthStaleWarning" style="display:none;"></div>

                <!-- SUMMARY BAR -->
                <div class="health-summary-bar" id="healthSummaryBar" style="display:none;">
                    <span id="healthSummaryScanned"></span>
                    <span class="health-summary-sep">·</span>
                    <span id="healthSummaryIssues"></span>
                    <span class="health-summary-sep">·</span>
                    <span id="healthSummaryClean"></span>
                </div>

                <!-- RESULTS TABLE -->
                <div class="health-table-wrap" id="healthTableWrap" style="display:none;">
                    <table class="data-table" id="healthTable">
                        <thead>
                            <tr>
                                <th class="sortable" data-col="title">Title</th>
                                <th class="sortable" data-col="library">Library</th>
                                <th class="sortable" data-col="fileSize">File Size</th>
                                <th>Issues</th>
                                <th>Scan Depth</th>
                            </tr>
                        </thead>
                        <tbody id="healthTableBody"></tbody>
                    </table>
                </div>

                <!-- EMPTY STATE -->
                <div class="health-empty-state" id="healthEmptyState" style="display:none;">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                    <p>All files healthy — no issues found.</p>
                </div>

                <!-- NO SCAN YET STATE -->
                <div class="health-no-scan-state" id="healthNoScanState">
                    <p>No scan has been run yet. Click <strong>Quick Scan</strong> to start.</p>
                </div>
            </div>
        </div>
```

- [ ] **Step 3: Rebuild and verify the nav link appears**

```bash
docker compose up -d --build
```

Open `http://localhost:5010` in a browser. Confirm the "Health" nav link appears and clicking it shows an empty page without JS errors in the console.

- [ ] **Step 4: Commit**

```bash
git add app/templates/index.html
git commit -m "feat: add health page HTML structure and nav link"
```

---

## Task 6: Health page — CSS styles

**Files:**
- Modify: `app/static/css/style.css`

- [ ] **Step 1: Append health-specific styles to `style.css`**

Add the following at the end of `app/static/css/style.css`:

```css
/* ============================================================
   HEALTH PAGE
   ============================================================ */

.health-controls {
    margin-bottom: 1.5rem;
}

.health-scan-btn-group {
    display: flex;
    gap: 2rem;
    align-items: flex-start;
    flex-wrap: wrap;
}

.health-scan-action {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
}

.health-last-scanned {
    font-size: 0.75rem;
    color: var(--text-muted, #6b7280);
}

.health-progress-wrap {
    margin-bottom: 1.25rem;
}

.health-progress-label {
    font-size: 0.8rem;
    color: var(--text-muted, #6b7280);
    margin-bottom: 0.4rem;
}

.health-progress-bar-track {
    height: 6px;
    background: var(--surface-2, #1e1e2e);
    border-radius: 3px;
    overflow: hidden;
}

.health-progress-bar-fill {
    height: 100%;
    background: #dc2626;
    border-radius: 3px;
    transition: width 0.3s ease;
}

.health-stale-warning {
    background: rgba(234, 179, 8, 0.1);
    border: 1px solid rgba(234, 179, 8, 0.3);
    color: #eab308;
    border-radius: 6px;
    padding: 0.6rem 1rem;
    font-size: 0.85rem;
    margin-bottom: 1rem;
}

.health-summary-bar {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.875rem;
    color: var(--text-secondary, #9ca3af);
    margin-bottom: 1.25rem;
}

.health-summary-sep {
    opacity: 0.4;
}

.health-issue-badge {
    display: inline-block;
    background: rgba(220, 38, 38, 0.15);
    color: #dc2626;
    border: 1px solid rgba(220, 38, 38, 0.3);
    border-radius: 4px;
    padding: 0.15rem 0.5rem;
    font-size: 0.72rem;
    font-weight: 500;
    white-space: nowrap;
    cursor: default;
    margin: 0.1rem;
}

.health-scan-depth {
    font-size: 0.78rem;
    color: var(--text-muted, #6b7280);
    font-style: italic;
}

.health-empty-state,
.health-no-scan-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 3rem 1rem;
    color: var(--text-secondary, #9ca3af);
    text-align: center;
}

.health-empty-state p,
.health-no-scan-state p {
    font-size: 1rem;
    margin: 0;
}

.health-table-wrap {
    overflow-x: auto;
}
```

- [ ] **Step 2: Rebuild and verify styles load**

```bash
docker compose up -d --build
```

Open `http://localhost:5010/#health`. Confirm the page renders without layout breakage. The scan buttons should be visible and styled.

- [ ] **Step 3: Commit**

```bash
git add app/static/css/style.css
git commit -m "feat: add health page CSS styles"
```

---

## Task 7: Health page — JavaScript

**Files:**
- Modify: `app/templates/index.html`

The app uses inline `<script>` blocks in `index.html`. Find the end of the file (near the other page JS blocks) and add the Health page script.

- [ ] **Step 1: Locate where to add the script**

Search `index.html` for the pattern `// SIZE PAGE` or `// NAMING PAGE` to find where existing page JS lives. Add the health block in the same area.

- [ ] **Step 2: Add the Health page JavaScript**

Insert the following script block alongside the other page scripts in `index.html`:

```html
<script>
// ============================================================
// HEALTH PAGE
// ============================================================
(function () {
    'use strict';

    const STALE_DAYS = 7;
    let healthData = null;
    let healthSortCol = 'library';
    let healthSortDir = 'asc';
    let healthProgressInterval = null;
    let issueLabels = {};

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
        const now = new Date();
        const diffDays = Math.floor((now - d) / 86400000);
        if (diffDays === 0) return 'today';
        if (diffDays === 1) return 'yesterday';
        return diffDays + ' days ago';
    }

    function staleDays(iso) {
        if (!iso) return null;
        return Math.floor((new Date() - new Date(iso)) / 86400000);
    }

    function renderIssueBadges(issues) {
        return issues.map(k => {
            const label = issueLabels[k] || k;
            const short = k.replace(/_/g, ' ');
            return `<span class="health-issue-badge" title="${label}">${short}</span>`;
        }).join('');
    }

    function renderTable(results) {
        const tbody = document.getElementById('healthTableBody');
        if (!tbody) return;
        const sorted = [...results].sort((a, b) => {
            let av = a[healthSortCol] ?? '';
            let bv = b[healthSortCol] ?? '';
            if (typeof av === 'string') av = av.toLowerCase();
            if (typeof bv === 'string') bv = bv.toLowerCase();
            if (av < bv) return healthSortDir === 'asc' ? -1 : 1;
            if (av > bv) return healthSortDir === 'asc' ? 1 : -1;
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

    function renderHealthPage(data) {
        if (!data) return;
        issueLabels = data.issueLabels || {};
        const results = data.results || [];

        // LAST SCANNED TIMESTAMPS
        const qs = document.getElementById('quickLastScanned');
        const ds = document.getElementById('deepLastScanned');
        if (qs) qs.textContent = data.quick_scanned_at ? 'Last: ' + formatRelativeDate(data.quick_scanned_at) : '';
        if (ds) ds.textContent = data.deep_scanned_at ? 'Last: ' + formatRelativeDate(data.deep_scanned_at) : '';

        // STALE WARNING — based on most recent scan of either type
        const latestScan = [data.quick_scanned_at, data.deep_scanned_at]
            .filter(Boolean).sort().pop();
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
        document.getElementById('healthNoScanState').style.display = hasScanned ? 'none' : '';

        if (!hasScanned) {
            document.getElementById('healthSummaryBar').style.display = 'none';
            document.getElementById('healthTableWrap').style.display = 'none';
            document.getElementById('healthEmptyState').style.display = 'none';
            return;
        }

        // SUMMARY BAR — total scanned count comes from cache file discovery
        document.getElementById('healthSummaryBar').style.display = '';

        // We don't store total-scanned count, so show issue/clean counts only
        document.getElementById('healthSummaryScanned').textContent =
            results.length + ' issue' + (results.length !== 1 ? 's' : '') + ' found';
        document.getElementById('healthSummaryIssues').textContent =
            results.length > 0
                ? results.length + ' file' + (results.length !== 1 ? 's' : '') + ' flagged'
                : 'no files flagged';
        document.getElementById('healthSummaryClean').textContent =
            results.length === 0 ? 'all clean' : '';

        if (results.length === 0) {
            document.getElementById('healthTableWrap').style.display = 'none';
            document.getElementById('healthEmptyState').style.display = '';
        } else {
            document.getElementById('healthEmptyState').style.display = 'none';
            document.getElementById('healthTableWrap').style.display = '';
            renderTable(results);
        }
    }

    function loadHealthResults() {
        fetch('/filehealth/results')
            .then(r => r.json())
            .then(data => {
                healthData = data;
                renderHealthPage(data);
            })
            .catch(err => console.error('Health results fetch failed:', err));
    }

    function startScan(mode) {
        fetch('/filehealth/scan?mode=' + mode, { method: 'POST' })
            .then(r => r.json())
            .then(data => {
                if (data.status === 'already_running') return;
                startProgressPolling(mode);
            })
            .catch(err => console.error('Scan start failed:', err));
    }

    function startProgressPolling(mode) {
        const wrap = document.getElementById('healthProgressWrap');
        const label = document.getElementById('healthProgressLabel');
        const fill = document.getElementById('healthProgressFill');
        if (wrap) wrap.style.display = '';

        const key = 'health:' + mode;

        clearInterval(healthProgressInterval);
        healthProgressInterval = setInterval(() => {
            fetch('/api/progress')
                .then(r => r.json())
                .then(d => {
                    const task = (d.tasks || []).find(t => t.key === key);
                    if (!task) {
                        clearInterval(healthProgressInterval);
                        if (wrap) wrap.style.display = 'none';
                        loadHealthResults();
                        return;
                    }
                    const pct = task.total > 0
                        ? Math.round((task.current / task.total) * 100)
                        : 0;
                    if (fill) fill.style.width = pct + '%';
                    if (label) label.textContent = (task.step || 'Scanning...') + ' (' + task.current + '/' + task.total + ')';
                })
                .catch(() => {});
        }, 1000);
    }

    function initHealthPage() {
        const quickBtn = document.getElementById('quickScanBtn');
        const deepBtn = document.getElementById('deepScanBtn');
        if (quickBtn) quickBtn.addEventListener('click', () => startScan('quick'));
        if (deepBtn) deepBtn.addEventListener('click', () => startScan('deep'));

        // SORTABLE COLUMN HEADERS
        const table = document.getElementById('healthTable');
        if (table) {
            table.querySelectorAll('th.sortable').forEach(th => {
                th.style.cursor = 'pointer';
                th.addEventListener('click', () => {
                    const col = th.dataset.col;
                    if (healthSortCol === col) {
                        healthSortDir = healthSortDir === 'asc' ? 'desc' : 'asc';
                    } else {
                        healthSortCol = col;
                        healthSortDir = 'asc';
                    }
                    if (healthData) renderTable(healthData.results || []);
                });
            });
        }

        loadHealthResults();
    }

    // HOOK INTO THE APP'S PAGE NAVIGATION — same pattern as other pages
    document.addEventListener('DOMContentLoaded', () => {
        const navLink = document.getElementById('nav-health');
        if (navLink) {
            navLink.addEventListener('click', () => {
                // Let the app's router handle page switching; load data on first visit
                setTimeout(initHealthPage, 50);
            });
        }
    });

    // EXPOSE FOR THE ROUTER IF IT CALLS PAGE INIT FUNCTIONS BY NAME
    window.initHealthPage = initHealthPage;
})();
</script>
```

- [ ] **Step 3: Hook into the existing router**

Open `index.html` and find the SPA router logic — look for where `#home`, `#naming`, `#size` hash changes are handled (likely a `hashchange` or `showPage` function). Add `health` to the same routing logic.

Example — if the router looks like:

```javascript
function showPage(page) {
    ['home', 'naming', 'size', 'settings'].forEach(p => {
        document.getElementById('page-' + p).style.display = p === page ? '' : 'none';
        document.getElementById('nav-' + p)?.classList.toggle('active', p === page);
    });
}
```

Update the array to include `'health'`:

```javascript
function showPage(page) {
    ['home', 'naming', 'size', 'health', 'settings'].forEach(p => {
        document.getElementById('page-' + p).style.display = p === page ? '' : 'none';
        document.getElementById('nav-' + p)?.classList.toggle('active', p === page);
    });
    if (page === 'health') initHealthPage();
}
```

The exact pattern depends on what's in `index.html` — adapt to match whatever routing mechanism is already there.

- [ ] **Step 4: Rebuild and test the full flow**

```bash
docker compose up -d --build
```

1. Open `http://localhost:5010` in a browser
2. Click the **Health** nav link — page should appear with "No scan has been run yet"
3. Click **Quick Scan** — progress bar should appear and increment
4. After completion, summary bar and table (or empty state) should render
5. Check browser console for JS errors — there should be none
6. Click column headers — table should sort

- [ ] **Step 5: Commit**

```bash
git add app/templates/index.html
git commit -m "feat: add health page JavaScript — scan controls, progress, results table"
```

---

## Task 8: Dockerfile — verify ffmpeg is present

**Files:**
- Modify: `Dockerfile` (if ffmpeg is missing)

- [ ] **Step 1: Check if ffmpeg is in the image**

```bash
docker exec MediaDash which ffmpeg
docker exec MediaDash which ffprobe
```

If both return paths (e.g. `/usr/bin/ffmpeg`), skip to Step 4. If either is missing, continue.

- [ ] **Step 2: Read the current Dockerfile**

```bash
cat /home/kevin/Docker/MediaDash/Dockerfile
```

- [ ] **Step 3: Add ffmpeg install**

Find the `RUN apt-get` block (or add one). Insert:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 4: Rebuild and re-verify**

```bash
docker compose up -d --build
docker exec MediaDash ffmpeg -version 2>&1 | head -1
docker exec MediaDash ffprobe -version 2>&1 | head -1
```

Expected: version strings for both.

- [ ] **Step 5: Commit (only if Dockerfile was changed)**

```bash
git add Dockerfile
git commit -m "feat: add ffmpeg to container image for file health scanning"
```

---

## Task 9: End-to-end verification and branch cleanup

- [ ] **Step 1: Full flow test**

1. Open `http://localhost:5010/#health`
2. Run Quick Scan — confirm progress bar, results render correctly, `health_cache.json` exists in `./cache/`
3. Confirm stale warning does not appear (scan just ran)
4. (Optional) Run Deep Scan on a small library — confirm it starts, runs, and enriches results

- [ ] **Step 2: Verify cache file**

```bash
cat /home/kevin/Docker/MediaDash/cache/health_cache.json | python3 -m json.tool | head -30
```

Expected: `quick_scanned_at` is set, `results` is an array.

- [ ] **Step 3: Verify no regressions**

Click through Home, Naming, and Sizes pages — confirm they still load and function normally.

- [ ] **Step 4: Final commit if any cleanup was done**

```bash
git add -p
git commit -m "chore: health scanner cleanup and final verification"
```

- [ ] **Step 5: Push branch**

```bash
git push -u origin feature/file-health-scanner
```
