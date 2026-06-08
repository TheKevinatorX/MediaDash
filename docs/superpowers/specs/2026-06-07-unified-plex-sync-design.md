# Unified Plex Sync — Design Spec

Date: 2026-06-07
Branch: `feature/unified-plex-sync`

## Problem

Today, three pages (Search, Naming, Sizes) each independently fetch-and-cache
their own slice of Plex data:

- **Search/Home** — `search:<library>` cache, built by `fetch_library_items` /
  `_full_fetch_worker` / `_episode_enrichment_worker` in `search.py`. Walks
  movie sections (with stream metadata) or show sections (shows +
  parallel episode metadata).
- **Naming** — `naming:<library>` cache, built entirely separately by
  `_naming_full_fetch_worker` / `_fetch_all_episodes` in `naming.py`. Re-walks
  the *same* sections/episodes from Plex with different extracted fields.
- **Sizes** — has no independent fetch; it derives from `search:` cache via
  projections (`calculations.py`), only kicking off
  `_episode_enrichment_worker` when season/size data is missing.

Net effect: Search and Naming each open their own Plex connections and
re-walk the same libraries, duplicating Plex API load and extraction work.

## Goal

One orchestrated background pass — `plex_sync.py` — that walks each selected
Plex library exactly once and produces all cached data needed by Home,
Search, Naming, and Sizes. `sync_progress.py` continues to be the generic
task-queue/progress engine (no semantic changes needed there); it now tracks
a single global sync task instead of many per-page/per-library tasks.

## Architecture

### `plex_sync.py` (new module)

Single entry point: `run_full_sync()`.

- Connects to Plex once (own `PlexServer` instance, like existing background
  workers do, to avoid contention with the request-thread singleton).
- Iterates selected libraries in this order: movie libraries first (fast,
  feeds Home stats immediately), then show libraries — mirroring today's
  `PRIO_BROWSE_MOVIE` → `PRIO_BROWSE_SHOW` ordering.
- For each library, fetches the raw Plex items **once**:
  - Movies: single `fetchItems` call with `includeElements=Stream`
    (`fetch_movies_with_streams`).
  - Shows: parallel-fetch `section.all()` (shows) + `searchEpisodes()`
    (episodes) + episode metadata (`fetch_episode_metadata`) — same as
    today's `fetch_library_items` show path, run once instead of twice.
- Runs **both** extractor sets over the same in-memory raw items:
  - Search extractor (`EXTRACTORS[type]`, `_merge_episode_meta`) →
    `cache.set('search:<lib>', ...)`
  - Naming extractor (`extract_movie_naming` / `extract_episode_naming`,
    with the existing show-year map) → `cache.set('naming:<lib>', ...)`
- Sizes requires no separate work: it already reads exclusively from
  `search:` cache via `calculations.py` projections, and the unified pass
  always produces fully-enriched season/size data (no more "cold"
  episode-enrichment follow-up).
- Writes each library's cache entries as soon as that library finishes
  (not batched at the end of the whole run), so a partial sync still leaves
  completed libraries fresh and queryable.
- Reports progress via a single task key `sync:full` registered with
  `enrichment`, with rich step text spanning the whole pass, e.g.:
  `"Library 2/5 — Anime (show): episodes 340/1,200"`
  Progress updates include both an overall library counter (`2 of 5`) and
  an item-level counter within the current library.

### Error handling

- Per-item extraction errors are tolerated and logged exactly as today
  (`errors` counters per library) — a single bad item doesn't abort the
  library.
- Per-library errors (e.g. Plex throws while walking a section) are logged,
  that library's cache is left untouched (stale data persists), and the pass
  continues to the next library. The sync overall still completes/reports
  success; individual library failures surface only in logs (matching
  current behavior — there's no per-library error surfacing in the UI today).
- If the whole pass fails before any library completes (e.g. can't connect
  to Plex at all), the `sync:full` task is marked `error` via the existing
  `BackgroundEnrichment._run` exception handling — no new error-reporting
  mechanism needed.

### `sync_progress.py`

No structural changes — it's already a generic, work-agnostic
priority-queue/progress engine. The only change is a reduction in the
*number* of distinct task keys it ever sees: instead of
`search:<lib>`, `naming:<lib>` (×N libraries) all running independently,
there is exactly one active task, `sync:full`, at a time.

The per-task-type priority constants (`PRIO_BROWSE_MOVIE`, `PRIO_BROWSE_SHOW`,
`PRIO_NAMING`, `PRIO_EPISODE`) are removed from `shared.py`/`sync_progress.py`
and collapsed into a single `PRIO_SYNC` (or simply the engine's default),
since there is only one task type left to prioritize.

## Trigger model

- **Single global trigger only.** `POST /api/sync` starts
  `enrichment.start('sync:full', plex_sync.run_full_sync, priority=PRIO_SYNC, silent=False)`.
  No-ops (logs and returns current status) if `sync:full` is already running.
- **No automatic bootstrap.** Per your direction, pages do **not**
  auto-trigger background fetches on cold cache. A library with no cached
  data simply renders empty with a prompt to run Sync. This removes all the
  scattered `user_sync`/cold-start trigger logic in `search.py`, `naming.py`,
  `size.py`, and `app.py` (`_build_quicksummary_lib_entry`,
  `home_summary`'s cold-path fallbacks, `_ensure_naming_worker`, etc.).
- **Removed routes:** `/api/cache/refresh` (per-library refresh) and
  `/api/warm` (warm-all) are deleted; `/api/sync` replaces both.

## Removed code

Entirely deleted (after the unified pass takes over):

- `search.py`: `_full_fetch_worker`, `_episode_enrichment_worker`,
  progressive/`maxresults` fetch paths in `fetch_library_items`
  (the function itself becomes a pure cache-read — see below)
- `naming.py`: `_naming_full_fetch_worker`, `_fetch_all_episodes`,
  `_fetch_all_movies` (logic moves into `plex_sync.py`)
- `size.py`: `_search_cold_worker`
- `app.py`: `_make_search_worker`/`_search_fetch_worker`/`_warm_search_worker`,
  `_ensure_naming_worker`, `cache_refresh`, `warm_all`, and the cold-path
  Plex-fallback branches in `home_summary`/`home_quicksummary`/
  `_build_quicksummary_lib_entry`
- `shared.py`/`sync_progress.py`: `PRIO_BROWSE_MOVIE`, `PRIO_BROWSE_SHOW`,
  `PRIO_NAMING`, `PRIO_EPISODE` (→ single `PRIO_SYNC`)

`fetch_library_items`/`fetch_library_naming`/`_get_search_items` become thin
cache-read functions: return cached data if present (fresh or stale), else
return empty + `enriched=False` — no Plex contact, no background-worker
spawning. All "needs sync" decisions surface to the user via the UI prompt,
not via implicit background triggers.

## Frontend changes

- **Progress hub** (`/api/progress` consumer): instead of a list of
  per-library/per-type tasks, displays one row for the global sync —
  step text, item-level progress bar, and an overall library counter
  (e.g. "Library 2 of 5").
- **Sync triggers**: the per-library "Sync" actions on Search/Naming/Sizes
  pages are replaced by one global "Sync Now" action (surfaced from Home
  and/or the progress hub). Cold/empty library views show a "no data yet —
  run Sync" prompt instead of silently kicking off background work.

## Testing / Verification

- `docker compose config --quiet` (if compose changes — none expected)
- Manual verification per `verify`/`run` skill: trigger `/api/sync`, confirm
  `/api/progress` reports a single unified task with sensible step text,
  confirm Search/Naming/Sizes/Home all populate correctly from one pass,
  confirm cold-cache pages show the "run Sync" prompt rather than spawning
  background work.
