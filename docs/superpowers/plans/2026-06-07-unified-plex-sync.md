# Unified Plex Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three independent per-page Plex fetch pipelines (Search, Naming, Sizes-via-episode-enrichment) with one orchestrated `plex_sync.py` pass that walks each library once and populates all caches, triggered only by a single global "Sync" action.

**Architecture:** New `plex_sync.py` module owns `run_full_sync()`, which fetches each library's raw Plex items once and runs both the search-extractor and naming-extractor over them, writing `search:<lib>` and `naming:<lib>` cache entries. `app.py` exposes `POST /api/sync` as the sole trigger (replacing `/api/cache/refresh` + `/api/warm`). Pages (`search.py`/`naming.py`/`size.py`) become pure cache-readers — no more background-worker spawning on page load or `?sync=1`.

**Tech Stack:** Python 3 / Flask / PlexAPI, vanilla JS frontend. No automated test suite exists in this repo — verification is manual via the `run`/`verify` skills against a live Plex connection.

> Note: there is no `pytest` setup in this project (`find ... -iname "*test*"` returned nothing but build artifacts). Each task therefore ends with a **manual verification** step instead of an automated test run — start the app (`run` skill) and check behavior in the browser / via `curl`, per the existing project convention.

---

### Task 1: Add `PRIO_SYNC` and remove the old per-task-type priorities

**Files:**
- Modify: `app/sync_progress.py:20-23`
- Modify: `app/shared.py:402-405`

- [ ] **Step 1: Replace the priority constants**

In `app/sync_progress.py`, replace lines 20-23:

```python
PRIO_BROWSE_MOVIE = 0   # movie libraries: fast + feeds Home stats immediately
PRIO_BROWSE_SHOW  = 1   # show libraries: feeds Home stats (submitted in Plex section order)
PRIO_NAMING       = 2   # Naming page data for all libraries
PRIO_EPISODE      = 3   # episode-level size/duration enrichment (Sizes page)
```

with:

```python
PRIO_SYNC = 0   # the single unified Plex sync pass
```

- [ ] **Step 2: Update the re-export in `shared.py`**

In `app/shared.py`, replace the import block at lines 402-405:

```python
from sync_progress import (
    BackgroundEnrichment,
    PRIO_BROWSE_MOVIE, PRIO_BROWSE_SHOW, PRIO_NAMING, PRIO_EPISODE,
)
```

with:

```python
from sync_progress import (
    BackgroundEnrichment,
    PRIO_SYNC,
)
```

- [ ] **Step 3: Verify nothing imports the old names yet**

Run: `grep -rn "PRIO_BROWSE\|PRIO_NAMING\|PRIO_EPISODE" app/`
Expected: matches only in `app/app.py`, `app/search.py`, `app/naming.py`, `app/size.py` (these get fixed in Task 4 — for now this command just confirms scope; don't worry that it still finds hits).

- [ ] **Step 4: Commit**

```bash
git add app/sync_progress.py app/shared.py
git commit -m "refactor: collapse per-task-type sync priorities into PRIO_SYNC"
```

---

### Task 2: Create `plex_sync.py` with the unified fetch pipeline

**Files:**
- Create: `app/plex_sync.py`

This module contains the entire orchestrated pass. It imports the existing extractors rather than redefining them — `extract_movie_data`/`extract_show_data`/`EXTRACTORS`/`fetch_episode_metadata`/`_merge_episode_meta`/`fetch_movies_with_streams` from `search.py`/`shared.py`, and `extract_movie_naming`/`extract_episode_naming` from `name_analysis.py`.

- [ ] **Step 1: Write `app/plex_sync.py`**

```python
######################################################
# PLEX SYNC — UNIFIED BACKGROUND DATA PIPELINE       #
######################################################
#
# Single orchestrated pass that walks every selected Plex library ONCE and
# produces all cached data needed by Home, Search, Naming, and Sizes:
#   - search:<library>  (browse/episode-meta data — also feeds Sizes via projections)
#   - naming:<library>  (naming-analysis data)
#
# Replaces the three independent per-page fetch pipelines that used to each
# open their own Plex connection and re-walk the same libraries.

import logging
import time
from concurrent.futures import ThreadPoolExecutor

from plexapi.server import PlexServer

from shared import (
    cache, enrichment, PLEX_URL, PLEX_TOKEN, is_library_selected,
    fetch_movies_with_streams, format_bytes, format_duration_short,
    PRIO_SYNC,
)
from search import (
    EXTRACTORS, fetch_episode_metadata, _merge_episode_meta,
)
from name_analysis import extract_movie_naming, extract_episode_naming

logger = logging.getLogger('mediadash.sync')

SYNC_KEY = 'sync:full'
SUPPORTED_LIBRARY_TYPES = ('movie', 'show')


# WALK ONE MOVIE LIBRARY: FETCH ONCE, EXTRACT FOR BOTH SEARCH AND NAMING
def _sync_movie_library(section, title, lib_index, lib_total):
    raw_items = fetch_movies_with_streams(section)
    total = len(raw_items)

    search_extractor = EXTRACTORS['movie']
    search_items = []
    naming_items = []
    errors = 0

    for i, movie in enumerate(raw_items):
        try:
            search_items.append(search_extractor(movie))
        except Exception as e:
            errors += 1
            logger.error(f"Failed to extract search data for '{getattr(movie, 'title', '?')}': {e}")
        try:
            naming_items.append(extract_movie_naming(movie))
        except Exception as e:
            errors += 1
            logger.error(f"Failed to extract naming data for '{getattr(movie, 'title', '?')}': {e}")

        if (i + 1) % 100 == 0 or i + 1 == total:
            enrichment.update_progress(
                SYNC_KEY, i + 1, total,
                f'Library {lib_index}/{lib_total} — {title} (movies): {i + 1:,}/{total:,}'
            )

    cache.set(f'search:{title}', search_items, 'movie')
    cache.set(f'naming:{title}', naming_items, 'movie')
    logger.info(f"Synced movie library '{title}': {len(search_items)} items ({errors} errors)")


# WALK ONE SHOW LIBRARY: FETCH SHOWS + EPISODES + EPISODE-META ONCE, EXTRACT FOR BOTH
def _sync_show_library(section, title, lib_index, lib_total):
    enrichment.update_progress(
        SYNC_KEY, 0, 0,
        f'Library {lib_index}/{lib_total} — {title} (shows): fetching from Plex…'
    )

    with ThreadPoolExecutor(max_workers=3) as pool:
        future_shows = pool.submit(section.all)
        future_episodes = pool.submit(section.searchEpisodes)
        future_meta = pool.submit(fetch_episode_metadata, section)
        shows = future_shows.result()
        episodes = future_episodes.result()
        episode_meta = future_meta.result()

    show_year_map = {s.ratingKey: s.year for s in shows if s.ratingKey and s.year}

    # SEARCH SIDE: EXTRACT SHOWS, THEN MERGE EPISODE METADATA (SIZES/SEASONS/RESOLUTIONS)
    search_extractor = EXTRACTORS['show']
    search_items = []
    errors = 0
    for show in shows:
        try:
            search_items.append(search_extractor(show))
        except Exception as e:
            errors += 1
            logger.error(f"Failed to extract search data for '{getattr(show, 'title', '?')}': {e}")

    def _on_merge_progress(current, t):
        enrichment.update_progress(
            SYNC_KEY, current, t,
            f'Library {lib_index}/{lib_total} — {title} (shows): computing sizes {current:,}/{t:,}'
        )

    _merge_episode_meta(search_items, episode_meta, progress_fn=_on_merge_progress)

    # NAMING SIDE: EXTRACT EPISODES (REUSES THE SAME `episodes` LIST — NO RE-FETCH)
    total_eps = len(episodes)
    naming_items = []
    for i, ep in enumerate(episodes):
        try:
            naming_items.append(extract_episode_naming(ep, show_year_map))
        except Exception as e:
            errors += 1
            logger.error(f"Failed to extract naming data for episode: {e}")
        if (i + 1) % 100 == 0 or i + 1 == total_eps:
            enrichment.update_progress(
                SYNC_KEY, i + 1, total_eps,
                f'Library {lib_index}/{lib_total} — {title} (shows): naming {i + 1:,}/{total_eps:,} episodes'
            )

    cache.set(f'search:{title}', search_items, 'show')
    cache.set(f'naming:{title}', naming_items, 'show')
    logger.info(
        f"Synced show library '{title}': {len(search_items)} shows, "
        f"{len(naming_items)} episodes ({errors} errors)"
    )


# TOP-LEVEL ORCHESTRATOR — RUNS AS A SINGLE BACKGROUND TASK (SYNC_KEY)
def run_full_sync():
    start = time.time()
    plex = PlexServer(PLEX_URL, PLEX_TOKEN, timeout=120)

    sections = [
        s for s in plex.library.sections()
        if s.type in SUPPORTED_LIBRARY_TYPES and is_library_selected(s.title)
    ]
    # MOVIES FIRST — FAST AND FEEDS HOME STATS IMMEDIATELY — THEN SHOWS
    sections.sort(key=lambda s: 0 if s.type == 'movie' else 1)
    total_libs = len(sections)

    enrichment.update_progress(SYNC_KEY, 0, total_libs, 'Connecting to Plex…')

    for idx, section in enumerate(sections, start=1):
        try:
            if section.type == 'movie':
                _sync_movie_library(section, section.title, idx, total_libs)
            else:
                _sync_show_library(section, section.title, idx, total_libs)
        except Exception as e:
            logger.error(f"Sync failed for library '{section.title}': {e}")
            continue

    elapsed = time.time() - start
    logger.info(f"Full Plex sync complete: {total_libs} libraries in {elapsed:.1f}s")


# START THE UNIFIED SYNC IF NOT ALREADY RUNNING — RETURNS True IF (NEWLY) STARTED
def start_full_sync():
    if enrichment.is_running(SYNC_KEY):
        return False
    enrichment.start(SYNC_KEY, run_full_sync, priority=PRIO_SYNC, silent=False)
    return True
```

- [ ] **Step 2: Manual verification — module imports cleanly**

Run: `cd app && python3 -c "import plex_sync; print(plex_sync.SYNC_KEY)"`
Expected: prints `sync:full` with no import errors. (This only checks imports resolve — `app.py` registration and a live Plex connection are verified in later tasks.)

- [ ] **Step 3: Commit**

```bash
git add app/plex_sync.py
git commit -m "feat: add unified plex_sync module with single-pass full sync"
```

---

### Task 3: Wire `/api/sync` and remove `/api/cache/refresh` + `/api/warm`

**Files:**
- Modify: `app/app.py:27-30` (import block), `app/app.py:80-145` (`_startup_auto_warm`), `app/app.py:660-732` (`get_progress`/`cache_refresh`/`warm_all`)

- [ ] **Step 1: Update the `shared` import block**

In `app/app.py`, replace lines 27-30:

```python
    PRIO_BROWSE_MOVIE,
    PRIO_BROWSE_SHOW,
    PRIO_NAMING,
    PRIO_EPISODE,
)
```

with:

```python
    PRIO_SYNC,
)
```

- [ ] **Step 2: Replace `_startup_auto_warm` with a unified-sync version**

Replace the entire `_startup_auto_warm` function (`app/app.py:80-145`, ending just before the section that calls it) with:

```python
def _startup_auto_sync():
    """If the on-disk cache is empty or fully stale, kick off a full Plex sync
    at container startup so the dashboard has data without requiring a manual
    click. Runs in a daemon thread so it doesn't block Flask from serving."""
    from threading import Thread

    def _run():
        import time as _t
        _t.sleep(2)  # Brief pause so Flask finishes initializing first

        if not _shared.PLEX_URL or not _shared.PLEX_TOKEN:
            logger.info('Startup auto-sync skipped: Plex not configured')
            return

        search_entries = cache.entries_by_prefix('search:')
        now = _t.time()
        all_stale = not search_entries or all(
            (now - entry.get('ts', 0)) >= _shared.CACHE_TTL
            for entry in search_entries.values()
        )
        if not all_stale:
            logger.info('Startup auto-sync skipped: cache is warm')
            return

        from plex_sync import start_full_sync
        if start_full_sync():
            logger.info('Startup auto-sync: cache cold/stale, full sync started')

    Thread(target=_run, daemon=True, name='startup-auto-sync').start()
```

(Find the call site that previously invoked `_startup_auto_warm()` — likely right after its definition or near app startup — and rename it to `_startup_auto_sync()`.)

Run: `grep -n "_startup_auto_warm" app/app.py`
Expected: two matches (the `def` you just replaced and one call site). Update the call site to `_startup_auto_sync()`.

- [ ] **Step 3: Replace `cache_refresh`/`warm_all` with `/api/sync`**

Replace the entire `cache_refresh` and `warm_all` route functions (`app/app.py:660-732`, i.e. everything from `@app.route('/api/cache/refresh', ...)` through the end of `warm_all`) with:

```python
@app.route('/api/sync', methods=['POST'])
def trigger_sync():
    from plex_sync import start_full_sync, SYNC_KEY

    started = start_full_sync()
    status = enrichment.get_status(SYNC_KEY)
    if started:
        logger.info('Full Plex sync triggered via /api/sync')
        return jsonify({'status': 'started'})
    return jsonify({'status': 'already_running' if status in ('pending', 'running') else 'started'})
```

Keep `get_progress` (`@app.route('/api/progress')`) exactly as-is — it's generic and needs no changes.

- [ ] **Step 4: Manual verification — routes register and respond**

Start the app via the `run` skill (or `cd app && python3 app.py` if that's the project's dev entrypoint), then:

Run: `curl -s -X POST http://localhost:5010/api/sync | head -c 200`
Expected: `{"status":"started"}` (or `"already_running"` if startup auto-sync grabbed it first) — and `curl -s http://localhost:5010/api/progress` shows a `sync:full` task with `type: "sync"`.

Run: `curl -s -X POST http://localhost:5010/api/cache/refresh -o /dev/null -w '%{http_code}\n'`
Expected: `404` (route no longer exists)

- [ ] **Step 5: Commit**

```bash
git add app/app.py
git commit -m "feat: replace /api/cache/refresh and /api/warm with unified /api/sync"
```

---

### Task 4: Strip per-page background-worker triggers down to pure cache reads

**Files:**
- Modify: `app/search.py:458-525` (`fetch_library_items`), `:556-682` (`get_library`/cold-path)
- Modify: `app/naming.py:100-246` (remove fetch workers, simplify `get_library`)
- Modify: `app/size.py:24-32, 47-81` (`_search_cold_worker`, `_get_search_items`)
- Modify: `app/app.py:335-465` (`_make_search_worker`/`_ensure_naming_worker`/`home_summary` cold paths)

This task removes every code path that spawns a background fetch worker outside of `plex_sync.run_full_sync`. After this task, all three pages purely read from cache (fresh or stale) and return empty + a "needs sync" signal on a cold cache.

- [ ] **Step 1: Simplify `search.py`'s `fetch_library_items` to a pure cache read**

Replace the whole function body (`app/search.py:458-525`) with:

```python
# RETURN CACHED LIBRARY ITEMS — NO PLEX CONTACT. Sync is the only refresh path.
def fetch_library_items(title, library_type):
    cache_key = f'search:{title}'
    cached = cache.get(cache_key) or cache.get_stale(cache_key)
    if cached is None:
        fetch_logger.info(f"Cold search cache for '{title}' — no sync has run yet")
        return [], library_type, False

    is_stale = cached.get('is_stale', False)
    fetch_logger.info(
        f"Returning {len(cached['items'])} cached search items for '{title}' "
        f"(stale={is_stale}, run Sync to refresh from Plex)"
    )
    return _short_duration_display_items(cached['items']), cached['type'], True
```

Remove the now-unused imports this function relied on (`PlexServer`, `PRIO_BROWSE_MOVIE`, `PRIO_EPISODE`, `with_plex_retry` if unused elsewhere, `INITIAL_BATCH_SIZE`, `_fetch_movies_with_streams` if unused elsewhere — check with grep before removing each).

Run: `grep -n "PlexServer\|PRIO_BROWSE\|PRIO_EPISODE\|INITIAL_BATCH_SIZE\|_fetch_movies_with_streams\|with_plex_retry" app/search.py`
Remove any import lines whose names no longer appear elsewhere in the file's body.

- [ ] **Step 2: Simplify `search.py`'s `get_library` route to a pure cache read**

Replace the entire `get_library` function (`app/search.py:556-682`, i.e. from `def get_library(title):` through the line before `# CHECK BACKGROUND ENRICHMENT STATUS`) with:

```python
@search_bp.route('/library/<path:title>')
def get_library(title):
    cache_key = f'search:{title}'
    fetch_all = request.args.get('all', '').lower() == 'true'

    cached = cache.get_stale(cache_key)
    if cached is None or cached.get('type') not in EXTRACTORS:
        return jsonify({
            'items': [], 'total': 0, 'page': 1, 'perPage': 0, 'totalPages': 1,
            'libraryType': None, 'libraryTitle': title,
            'enriched': False, 'enrichmentRunning': False, 'cacheAge': None,
            'needsSync': True,
        })

    lib_type = cached['type']
    items = _short_duration_display_items(cached['items'])
    cache_age = round(time.time() - cached['ts'])

    if fetch_all:
        return jsonify({
            'items': items, 'total': len(items), 'page': 1,
            'perPage': len(items), 'totalPages': 1,
            'libraryType': lib_type, 'libraryTitle': title,
            'enriched': True, 'enrichmentRunning': False, 'cacheAge': cache_age,
        })

    search = request.args.get('search', '').strip()
    sort_by = request.args.get('sort', None)
    sort_dir = request.args.get('dir', 'asc')
    try:
        page = max(1, int(request.args.get('page', 1)))
    except (ValueError, TypeError):
        page = 1
    try:
        per_page = min(100, max(10, int(request.args.get('per_page', 25))))
    except (ValueError, TypeError):
        per_page = 25

    result = apply_table_operations(items, search, sort_by, sort_dir, page, per_page)
    result['libraryType'] = lib_type
    result['libraryTitle'] = title
    result['enriched'] = True
    result['enrichmentRunning'] = False
    result['cacheAge'] = cache_age
    return jsonify(result)
```

Note this drops the `Unauthorized`/`NotFound`/`with_plex_retry` exception handling since the route no longer contacts Plex — check with `grep -n "Unauthorized\|NotFound\|with_plex_retry" app/search.py` whether those imports are still used elsewhere in the file (the `/libraries` route still uses them) before touching imports.

Also update every call site of `fetch_library_items` to match its new two-argument signature:

Run: `grep -n "fetch_library_items(" app/*.py`
Expected matches only inside `search.py` itself (the old callers in `app.py`/`size.py` are removed in later steps of this task) — update any remaining call from `fetch_library_items(plex, title, section.type, progressive=..., silent=...)` to `fetch_library_items(title, section.type)`.

- [ ] **Step 3: Simplify `naming.py` — remove fetch workers, simplify `get_library`**

Delete these functions entirely from `app/naming.py`: `_fetch_all_movies` (lines 55-66), `_fetch_all_episodes` (lines 70-96), `_naming_full_fetch_worker` (lines 100-114).

Replace `fetch_library_naming` (`app/naming.py:119-137` roughly — the function starting `def fetch_library_naming(plex, title, library_type, progressive=False, silent=True):`) with a pure cache-read version, OR remove it entirely if nothing calls it (check first):

Run: `grep -n "fetch_library_naming(" app/*.py`

If it has callers, replace its body with a cache-only read mirroring the new `fetch_library_items`; if it has none (the route below uses `cache.get`/`cache.get_stale` directly), delete the function.

Then replace the `get_library` route (`app/naming.py:196-246`) with:

```python
@naming_bp.route('/library/<path:title>')
def get_library(title):
    cache_key = f'naming:{title}'
    cached = cache.get(cache_key) or cache.get_stale(cache_key)
    if cached and cached.get('items'):
        return _naming_response(title, cache_key, cached)

    # COLD — LEARN LIBRARY TYPE FROM SEARCH CACHE IF AVAILABLE, NO PLEX CONTACT
    search_entry = cache.get(f'search:{title}') or cache.get_stale(f'search:{title}')
    lib_type = search_entry.get('type', 'movie') if search_entry else None
    api_logger.info(f"{title}: naming cache cold — run Sync to populate")
    return jsonify({
        'items': [], 'libraryType': lib_type, 'libraryTitle': title,
        'enriched': False, 'enrichmentRunning': False, 'cacheAge': None,
        'needsSync': True,
    })
```

Remove now-unused imports (`PlexServer`, `with_plex_retry`, `Unauthorized`, `NotFound`, `PRIO_NAMING`, `fetch_movies_with_streams`, `INITIAL_BATCH_SIZE`, `ThreadPoolExecutor`) — check each with grep first since `/libraries` route may still use `with_plex_retry`/`Unauthorized`/`NotFound`.

- [ ] **Step 4: Simplify `size.py`**

Delete `_search_cold_worker` (`app/size.py:24-32`) entirely.

Replace `_get_search_items` (`app/size.py:47-81`) with a pure cache-read version that drops the `user_sync` parameter and all enrichment-starting:

```python
def _get_search_items(title, library_type):
    cache_key = f'search:{title}'
    cached = cache.get(cache_key) or cache.get_stale(cache_key)
    if cached and cached.get('items'):
        items = cached['items']
        cache_age = round(time.time() - cached['ts'])
        if library_type == 'show':
            enriched = any(item.get('seasonSizes') for item in items)
        else:
            enriched = True
        return items, enriched, cache_age, False

    api_logger.info(f"Cold search cache for '{title}' — run Sync to populate")
    return [], False, 0, False
```

Update every call site of `_get_search_items`/`_library_response` that passed `user_sync=...` to drop that argument (`grep -n "user_sync" app/size.py` to find them all — including the route handler that reads `request.args.get('sync')`).

Remove now-unused imports (`enrichment` if no longer referenced, `PRIO_EPISODE`) — check with `grep -n "enrichment\.\|PRIO_EPISODE" app/size.py`.

- [ ] **Step 5: Simplify `app.py` — remove worker-spawning helpers and cold-path fallbacks**

Delete `_make_search_worker`/`_search_fetch_worker`/`_warm_search_worker` (`app/app.py:336-350`) and `_ensure_naming_worker` (`app/app.py:354-365`) entirely.

In `home_summary` (`app/app.py:368-465`), remove the cold-path Plex-fallback block — the `if stats is None:` branch that calls `_summarize_movies`/`_summarize_shows` and starts `_search_fetch_worker`, and the "WARM CACHE BUT UNENRICHED" block that starts `_episode_enrichment_worker`, and the `_ensure_naming_worker` call. The loop body for each section becomes:

```python
    for section in sections:
        lib_type = section.type
        if lib_type not in ('movie', 'show'):
            continue
        if not _shared.is_library_selected(section.title):
            continue

        lib_entry = {'title': section.title, 'type': lib_type}

        try:
            stats = _summarize_from_cache(section.title, lib_type)
            if stats is None:
                lib_entry['loading'] = True
            else:
                lib_entry.update(stats)
                _accumulate_totals(totals, lib_type, stats)
            lib_entry['namingHealth'] = _compute_naming_health(section.title)
        except Exception as e:
            logger.error(f'Failed to summarize library {section.title!r}: {e}')
            lib_entry['error'] = str(e)

        libraries.append(lib_entry)
```

Similarly in `_build_quicksummary_lib_entry` (`app/app.py:472-492`), remove the `enrichment.start(...)` call in the `else` branch — it should just set `lib_entry['loading'] = True` without spawning a worker:

```python
def _build_quicksummary_lib_entry(library_title, lib_type):
    lib_entry = {'title': library_title, 'type': lib_type}
    stats = _summarize_from_cache(library_title, lib_type)
    if stats is not None:
        lib_entry.update(stats)
        lib_entry['loading'] = False
    else:
        lib_entry['loading'] = True
    lib_entry['namingHealth'] = _compute_naming_health(library_title)
    return (lib_entry, stats)
```

Remove now-unused imports/constants from `app.py` — check with:
Run: `grep -n "_summarize_movies\|_summarize_shows\|PRIO_BROWSE\|PRIO_NAMING\|PRIO_EPISODE\|enrichment\.start" app/app.py`
Delete any import lines or now-dead helper functions (e.g. `_summarize_movies`/`_summarize_shows`) that are no longer referenced anywhere.

- [ ] **Step 6: Manual verification — pages load from cache without spawning workers**

With the app running and a warm cache (run `/api/sync` once first if cache is empty):

Run: `curl -s http://localhost:5010/search/library/<a-real-library-title> | head -c 300`
Expected: JSON with `items`, `enriched: true`, `enrichmentRunning: false` — served instantly from cache.

Then clear the cache (`rm -f /data/cache/*.json` or via the app's cache dir) and restart, and check a library BEFORE running sync:

Run: `curl -s http://localhost:5010/search/library/<title> | head -c 200`
Expected: `{"items":[],...,"needsSync":true}` — and `curl -s http://localhost:5010/api/progress` shows **no** task was spawned by this request (only `sync:full` if a startup auto-sync kicked in).

- [ ] **Step 7: Commit**

```bash
git add app/search.py app/naming.py app/size.py app/app.py
git commit -m "refactor: pages read purely from cache; remove per-page background fetch triggers"
```

---

### Task 5: Frontend — point Sync at `/api/sync`, drop per-page sync params, label the unified task

**Files:**
- Modify: `app/static/js/home.js:668-715` (`_setupRefreshAll`)
- Modify: `app/static/js/search.js:658-666, 1697-1700`
- Modify: `app/static/js/naming.js:363-371, 1477-1480`
- Modify: `app/static/js/size.js:844-855, 2008-2011`
- Modify: `app/static/js/progress.js:560-567` (`_chipCls`/`_chipLabel`)

- [ ] **Step 1: Point the global Sync button at `/api/sync`**

In `app/static/js/home.js`, inside `_setupRefreshAll` (around line 684-695), replace:

```javascript
            try {
                await api('/api/cache/refresh', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                });
                // RESTART ALL BACKGROUND WORKERS (NON-SILENT SO PROGRESS HUB SHOWS ACTIVITY)
                await fetch('/api/warm', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ silent: false }),
                }).catch(() => {});
```

with:

```javascript
            try {
                await api('/api/sync', { method: 'POST' });
```

- [ ] **Step 2: Drop the `sync`/`?sync=1` plumbing from each page's `_fetchLibrary`**

In `app/static/js/search.js`, change line 658-666 from:

```javascript
    async function _fetchLibrary(title, type, sync = false) {
        if (dataCache[title] && dataCache[title].enriched && !sync) return;
```
…
```javascript
            const url = `/search/library/${encodeURIComponent(title)}?all=true${sync ? '&sync=1' : ''}`;
```

to:

```javascript
    async function _fetchLibrary(title, type) {
        if (dataCache[title] && dataCache[title].enriched) return;
```
…
```javascript
            const url = `/search/library/${encodeURIComponent(title)}?all=true`;
```

Then update the `refreshActive` call at line ~1699 from `await _fetchLibrary(state.activeLibrary, state.activeLibraryType, true);` to `await _fetchLibrary(state.activeLibrary, state.activeLibraryType);` — but first force a re-fetch by clearing the relevant `dataCache` entry, since `_fetchLibrary` now early-returns when cache is warm:

```javascript
    async function refreshActive() {
        if (!state.activeLibrary) return;
        delete dataCache[state.activeLibrary];
        await _fetchLibrary(state.activeLibrary, state.activeLibraryType);
    }
```

(Read the existing `refreshActive` body first — `app/static/js/search.js:1697-1700` — and apply the equivalent change preserving any other lines it contains.)

Apply the identical pattern (drop the `sync` parameter, drop `?sync=1`/`&sync=1` from the URL, clear the cache entry in `refreshActive` before re-fetching) to:
- `app/static/js/naming.js` (`_fetchLibrary` at line 363-371, `refreshActive` at line 1477-1480)
- `app/static/js/size.js` (`_fetchLibrary` at line 844-855, `refreshActive` at line 2008-2011 — note its signature is `_fetchLibrary(title, sync = false)`, so drop just the `sync` param, not a `type` param)

- [ ] **Step 3: Add a "sync" chip to the progress hub**

In `app/static/js/progress.js`, update `_chipCls` (line 560-563) and `_chipLabel` (line 565-567):

```javascript
    function _chipCls(type) {
        return { search: 'phub-chip--search', naming: 'phub-chip--naming', episodes: 'phub-chip--episodes', sync: 'phub-chip--sync' }[type]
            || 'phub-chip--unknown';
    }

    function _chipLabel(type) {
        return { search: 'Search', naming: 'Naming', episodes: 'Episodes', sync: 'Full Sync' }[type] || type;
    }
```

Add the corresponding `.phub-chip--sync` style next to `.phub-chip--search` etc. in the CSS file that defines them:

Run: `grep -rln "phub-chip--search" app/static/css/`

Open that file and add a rule mirroring `.phub-chip--search`'s declaration but with a distinct accent (copy the existing rule's structure, change only the color values to a new distinguishable accent already used elsewhere in the theme — check `grep -n "accent\|--color-" app/static/css/*.css | head -20` for the palette and pick one not already used by the other chips).

- [ ] **Step 4: Manual verification — end-to-end UI check**

Start the app (`run` skill), open it in a browser:
1. Click the global "Sync" button → confirm the progress hub appears showing a single task chip labeled "Full Sync" with step text like "Library 1/5 — Movies (movies): 100/1,200".
2. Wait for completion → confirm Search, Naming, and Sizes pages all show populated, enriched data without any additional spinner/fetch round-trips.
3. Reload the page while sync is mid-run → confirm the active library's view still renders cached data (or the cold-cache prompt) without erroring.

- [ ] **Step 5: Commit**

```bash
git add app/static/js/home.js app/static/js/search.js app/static/js/naming.js app/static/js/size.js app/static/js/progress.js app/static/css/
git commit -m "feat(ui): trigger unified sync from global Sync button, label it in progress hub"
```

---

### Task 6: Add a "needs sync" prompt for cold libraries in the UI

**Files:**
- Modify: `app/static/js/search.js`, `app/static/js/naming.js`, `app/static/js/size.js` (wherever each renders an empty-state for a library)

The backend now returns `needsSync: true` on a cold cache (Task 4, Steps 2-4). Each page should show a clear "No data yet — click Sync to load this library from Plex" message instead of a blank table when it sees `needsSync: true` in the response.

- [ ] **Step 1: Find each page's empty-state rendering**

Run: `grep -n "needsSync\|enrichmentRunning\|No.*data\|empty-state\|emptyState" app/static/js/search.js app/static/js/naming.js app/static/js/size.js`

For each page, locate where it currently checks `enriched`/`items.length === 0` to render an empty table state.

- [ ] **Step 2: Render a "needs sync" message when `needsSync` is true**

In each page's render path for the empty/cold case, branch on `data.needsSync`:

```javascript
if (data.needsSync) {
    // render: "No cached data for this library yet — click Sync (top right) to load it from Plex."
} else {
    // existing empty-state rendering
}
```

Match the existing empty-state markup/classes in each file (read the surrounding code you found in Step 1 and reuse its container/structure — don't invent new CSS classes; reuse what each page already has for "no results" messaging).

- [ ] **Step 3: Manual verification**

With an empty cache (clear `/data/cache/*.json` and restart without triggering sync), open Search, Naming, and Sizes pages:
Expected: each shows a clear "no data — run Sync" message rather than a blank/empty table.

Then click Sync, wait for completion, reload each page:
Expected: the message is replaced by populated data.

- [ ] **Step 4: Commit**

```bash
git add app/static/js/search.js app/static/js/naming.js app/static/js/size.js
git commit -m "feat(ui): show a 'run Sync to load data' prompt for cold libraries"
```

---

### Task 7: Final cleanup pass — confirm no dead references remain

**Files:** all of `app/*.py`, `app/static/js/*.js`

- [ ] **Step 1: Search for stale references to removed names**

Run:
```bash
grep -rn "PRIO_BROWSE\|PRIO_NAMING\|PRIO_EPISODE\|_full_fetch_worker\|_episode_enrichment_worker\|_naming_full_fetch_worker\|_search_cold_worker\|_warm_search_worker\|_search_fetch_worker\|_make_search_worker\|_ensure_naming_worker\|cache_refresh\|/api/cache/refresh\|/api/warm\|warm_all\|_startup_auto_warm" app/*.py app/static/js/*.js
```
Expected: no matches. Fix any stragglers found.

- [ ] **Step 2: Confirm the app boots cleanly**

Run: `cd app && python3 -c "import app"`
Expected: no `ImportError`/`NameError` — confirms all the import-block edits across Tasks 1-5 are consistent.

- [ ] **Step 3: Full manual smoke test**

Using the `run`/`verify` skill: start the app fresh, run a full Sync from empty cache, and confirm Home/Search/Naming/Sizes all populate correctly and the progress hub reports one coherent task through to completion.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: final cleanup pass for unified plex sync migration"
```
