# Merge Search & Sizes Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the standalone "Search" and "Sizes" pages into a single unified page (kept under the "Sizes" identity) that defaults to a "largest files first" ranked view but carries all of Search's filtering/search/metadata capabilities, plus a new on-demand Episodes drill-down.

**Architecture:** Sizes already projects from the exact same `search:{title}` cache that Search reads — there is one source of truth. We collapse the two client-side table renderers into one (built on Sizes' richer view-mode/bloat/quick-refresh foundation, but using Search's fuller item shape so quick filters work), retire the standalone Search nav entry/page/blueprint routes that the merged page no longer needs, and add a new on-demand episode-fetch route + drill-down UI fed from a show/season row.

**Tech Stack:** Flask blueprints (Python), vanilla JS (no bundler, no test framework — this repo has none; verification is manual via the running app per the `verify`/`run` skills), shared `ColumnManager` (`columns.js`), Plex via `plexapi`.

**Note on testing:** This codebase has no automated test suite (confirmed: no `tests/` dir, no pytest config). Each task below ends with a **manual verification** step (start the app, exercise the feature in-browser) instead of an automated test run — follow the project's `run`/`verify` skill patterns for this. Do not introduce a test framework as part of this merge; that would be unrelated scope creep.

---

## File Structure

| File | Change |
|---|---|
| `app/size.py` | Becomes the sole backend for the merged page: stop slimming items via `_project_movie`/`_project_show`; serve full search-shaped items with `rank`/`mediaType`/size-sort added; absorb the columns route; add the new episode-fetch route. |
| `app/search.py` | Shrunk to just the data-extraction helpers (`extract_movie_data`, `extract_show_data`, `fetch_episode_metadata`, `_merge_episode_meta`, `apply_table_operations`, `fetch_library_items`) that `size.py` (and `plex_sync.py`) depend on — `search_bp` and its routes are deleted. Add a new `fetch_episodes_for_season` helper here (sibling to `fetch_episode_metadata`) for on-demand episode rows. |
| `app/calculations.py` | Remove `_project_movie`/`_project_show`/`PROJECTORS` (no longer used — merged page uses full items); keep `build_season_size_list`, resolution helpers, `SIZE_SORT_KEY`. |
| `app/app.py` | Remove `search_bp` import/registration ([app.py:62](../../../app/app.py#L62), [app.py:66](../../../app/app.py#L66)); `_build_summary_from_search_cache` keeps working unchanged (it reads the `search:` cache-key prefix, not the blueprint). |
| `app/templates/index.html` | Delete `#page-search` ([index.html:92-176](../../../app/templates/index.html#L92)) and the `#nav-search` link ([index.html:31](../../../app/templates/index.html#L31)); extend `#page-size` markup with Search's search-box/quick-filter controls and a new episodes drill-down panel. |
| `app/static/js/search.js` | Deleted entirely; its rendering logic (detail rows, quick filters, search box wiring) is folded into `size.js`. |
| `app/static/js/size.js` | Becomes the single page controller: gains Search's search box, quick filters, expandable detail rows, enrichment polling — composed with its existing view-mode switch (Largest/Seasons/**Episodes**), bloat detection, quick refresh, season analysis. |
| `app/static/js/app.js` | Remove the `#nav-search`/`page-search` wiring (whatever registers/initializes `SearchDash`). |

---

## Task 1: Inventory exact call sites before touching anything

**Files:** read-only — `app/app.py`, `app/static/js/app.js`, `app/templates/index.html`

- [ ] **Step 1: Find every reference to the Search page/blueprint/JS module**

Run:
```bash
grep -rn "search_bp\|SearchDash\|page-search\|nav-search\|/search/" app/ --include="*.py" --include="*.js" --include="*.html"
```

Write down every line number returned — these are the exact edit points for Tasks 5–8. Do not skip this; guessing line numbers from memory will cause edits to land in the wrong place after earlier tasks shift line numbers.

- [ ] **Step 2: Find every reference to `_project_movie`/`_project_show`/`PROJECTORS`**

Run:
```bash
grep -rn "_project_movie\|_project_show\|PROJECTORS" app/ --include="*.py"
```

Confirm they're only used in `size.py` and defined in `calculations.py` (per the earlier exploration). If anything else references them, note it — it changes Task 3's scope.

- [ ] **Step 3: Commit nothing — this is a research task.** Just keep the grep output handy for later tasks (paste it into your scratch notes).

---

## Task 2: Add `rank`/`mediaType`/size-sort to full (non-projected) items in `size.py`

**Files:**
- Modify: `app/size.py` (`_library_response`, around [size.py:74-141](../../../app/size.py#L74))
- Modify: `app/calculations.py` (remove `_project_movie`/`_project_show`/`PROJECTORS`, keep `SIZE_SORT_KEY`)

**Why:** Today `_library_response` runs cached items through `_project_movie`/`_project_show`, which strips ratings/genres/watch-status/subtitle-detail fields that Search's quick filters need. The merged page must filter on those fields regardless of whether you're viewing "Largest" or browsing generally — so we stop projecting and instead annotate the full items with the two things Sizes' ranked view needs that Search's items lack: a `rank` (1-based position after sorting by size) and `mediaType` (`'movie'`/`'show'`, used by the shared table renderer to pick columns).

- [ ] **Step 1: Read the current `_library_response` to see exactly what it does with `PROJECTORS`**

```bash
sed -n '74,141p' /home/kevin/Docker/MediaDash/app/size.py
```

- [ ] **Step 2: Replace the projection step with a full-item annotation step**

In `app/size.py`, find the block that calls `PROJECTORS[library_type](item, idx)` (or equivalent) inside `_library_response` and replace the projection with in-place annotation of the full cached item:

```python
def _annotate_for_size_view(item, rank, library_type):
    """Attach rank/mediaType to a full (non-projected) cached item for the
    merged Sizes view, without stripping any of Search's metadata fields."""
    annotated = dict(item)
    annotated['rank'] = rank
    annotated['mediaType'] = library_type
    return annotated
```

Then change the loop that built projected rows from:
```python
projected = [PROJECTORS[library_type](item, idx) for idx, item in enumerate(sorted_items, start=1)]
```
to:
```python
projected = [_annotate_for_size_view(item, idx, library_type) for idx, item in enumerate(sorted_items, start=1)]
```

(Keep the existing `sorted_items = sorted(items, key=SIZE_SORT_KEY, reverse=True)` size-sort — that's the "largest first" default we're keeping. `SIZE_SORT_KEY` stays in `calculations.py`.)

- [ ] **Step 3: Remove the now-unused projection functions from `calculations.py`**

Run:
```bash
grep -n "_project_movie\|_project_show\|PROJECTORS" /home/kevin/Docker/MediaDash/app/calculations.py
```

Delete the `_project_movie`, `_project_show`, and `PROJECTORS` definitions (the whole "PROJECTIONS" section noted in the file's own header comment), and remove their import in `size.py`:

```python
# size.py — change this import line:
from calculations import (
    _project_movie, _project_show, PROJECTORS, SIZE_SORT_KEY,
)
# to:
from calculations import SIZE_SORT_KEY
```

- [ ] **Step 4: Manual verification**

Start the app per the project's `run` skill, open the Sizes page, switch to the Movies and Shows tabs, and confirm:
- Items still render, sorted largest-first, with a visible rank.
- No Python traceback in the container logs (`docker compose logs --tail=100 MediaDash` or equivalent — check `app/app.py` for the actual container/service name first).
- Open the browser devtools Network tab, inspect a `/size/library/<title>` response, and confirm items now include fields like `criticRating`, `genres`, `subtitles` that were previously stripped by the projection (these will be used by quick filters in Task 6).

- [ ] **Step 5: Commit**

```bash
git add app/size.py app/calculations.py
git commit -m "refactor: serve full item shape from size routes instead of projected rows"
```

---

## Task 3: Move Search's data-extraction helpers out from under `search_bp`, delete the blueprint

**Files:**
- Modify: `app/search.py` — remove `search_bp` and its `@search_bp.route(...)` handlers (lines ~413-514 per the earlier exploration); keep everything above that (`extract_movie_data`, `extract_show_data`, `fetch_episode_metadata`, `_merge_episode_meta`, `apply_table_operations`, `_short_duration_display_items`, `fetch_library_items`)
- Modify: `app/app.py` — remove the `search_bp` import and registration

**Why:** `size.py` already imports `_get_search_items`/cache helpers, not `search_bp` routes — the routes (`/search/libraries`, `/search/library/<title>`, `/search/library/<title>/enrichment`, `/search/columns/<library_type>`) become redundant once the merged page is served entirely from `size_bp`. The extraction helpers underneath are still load-bearing (used by `plex_sync.py` during sync — verify this in Step 1) and must stay.

- [ ] **Step 1: Confirm what depends on `search.py`'s helper functions (not the blueprint)**

```bash
grep -rn "from search import\|import search" /home/kevin/Docker/MediaDash/app/ --include="*.py"
```

You should see `plex_sync.py` and/or `app.py` importing specific functions like `extract_movie_data`, `fetch_library_items`, etc. (not `search_bp`, after this task). Note exactly which names are imported elsewhere — those must remain in `search.py`.

- [ ] **Step 2: Delete the blueprint object and its routes from `search.py`**

Open `app/search.py`, locate:
```python
search_bp = Blueprint('search', __name__)
```
and every `@search_bp.route(...)` function below it (per Task 1's grep: `get_libraries`, `get_library`, `get_enrichment_status`, `get_columns` — roughly lines 413-514). Delete the `Blueprint(...)` line and all four route functions. Leave every function above them intact.

- [ ] **Step 3: Remove the registration in `app.py`**

In `app/app.py`, delete:
```python
from search import search_bp  # noqa: E402
```
(around [app.py:62](../../../app/app.py#L62)) and:
```python
app.register_blueprint(search_bp, url_prefix='/search')
```
(around [app.py:66](../../../app/app.py#L66)).

Leave `_build_summary_from_search_cache` and every `cache.entries_by_prefix('search:')` call alone — those read the cache key prefix `search:`, which is unrelated to the Flask blueprint and is populated by sync, not by the routes you just deleted.

- [ ] **Step 4: Search for any remaining references to the deleted routes**

```bash
grep -rn "/search/libraries\|/search/library\|/search/columns" /home/kevin/Docker/MediaDash/app/ --include="*.py" --include="*.js"
```

Anything this returns (besides the JS you'll delete in Task 8) is a dangling dependency — resolve it before moving on (most likely nothing outside `search.js`, which Task 8 removes).

- [ ] **Step 5: Manual verification**

Restart the app, confirm it starts cleanly with no import errors (`docker compose logs --tail=50` or the equivalent for this stack), and confirm `curl -I http://localhost:<port>/search/libraries` now returns 404 (the blueprint is gone).

- [ ] **Step 6: Commit**

```bash
git add app/search.py app/app.py
git commit -m "refactor: remove search_bp routes, keep shared extraction helpers"
```

---

## Task 4: Add the on-demand per-season episode-fetch route

**Files:**
- Modify: `app/search.py` — add `fetch_episodes_for_season` near `fetch_episode_metadata` ([search.py:227](../../../app/search.py#L227))
- Modify: `app/size.py` — add `GET /size/library/<path:title>/episodes` route

**Why:** Per the user's decision, episodes should load on-demand per show/season (not pre-cached during sync) and surface as a drill-down from a show/season row. `fetch_episode_metadata` already shows the exact Plex query pattern (`section.search(libtype='episode')` or equivalent — read it first) but discards individual episode rows after aggregating. We add a sibling function that returns raw per-episode rows for one named season of one named show, fetched live (not cached) — small, scoped Plex calls only when the user actually drills in.

- [ ] **Step 1: Read `fetch_episode_metadata` to copy its Plex-query and field-extraction pattern exactly**

```bash
sed -n '227,330p' /home/kevin/Docker/MediaDash/app/search.py
```

Note: the exact `section.search(...)`/`show.episodes()` call it uses, the field names it pulls off each episode (size, duration, resolution, title, index/episode number), and how it derives `seasonName` from an episode object — your new function must reuse this exact field-extraction shape so episode rows look consistent with the season aggregates already shown.

- [ ] **Step 2: Add `fetch_episodes_for_season` to `search.py`**

Place it directly after `fetch_episode_metadata`. Adapt the field names to whatever Step 1 revealed (the sketch below uses the field names implied by `build_season_size_list`'s consumption of `seasons_meta` — `size`, `duration`, `resolutions`; match `fetch_episode_metadata`'s actual per-episode extraction, don't invent new field names):

```python
# FETCH RAW PER-EPISODE ROWS FOR ONE SEASON OF ONE SHOW, ON DEMAND (NOT CACHED)
# Mirrors fetch_episode_metadata's per-episode extraction shape but returns
# individual rows instead of rolling them up — used by the Episodes drill-down.
def fetch_episodes_for_season(show, season_name):
    rows = []
    for episode in show.episodes():
        if episode.parentTitle != season_name:
            continue
        media = episode.media[0] if episode.media else None
        part = media.parts[0] if media and media.parts else None
        size = part.size if part else 0
        rows.append({
            'title': episode.title,
            'index': episode.index,
            'seasonName': season_name,
            'size': size,
            'sizeFormatted': format_bytes(size),
            'duration': episode.duration or 0,
            'durationFormatted': format_duration_short(episode.duration or 0),
            'resolution': (media.videoResolution if media else None),
            'filePath': part.file if part else None,
            'addedAt': episode.addedAt.isoformat() if episode.addedAt else None,
        })
    rows.sort(key=lambda r: r['index'] or 0)
    return rows
```

If `format_bytes`/`format_duration_short` aren't already imported at the top of `search.py`, add them: `from shared import format_bytes, format_duration_short` (check the existing import block first — `fetch_episode_metadata` likely already uses them, in which case nothing to add).

- [ ] **Step 3: Add the route to `size.py`**

Add near the existing `/library/<path:title>` routes in `app/size.py`:

```python
@size_bp.route('/library/<path:title>/episodes')
def get_episodes(title):
    show_title = request.args.get('show')
    season_name = request.args.get('season')
    if not show_title or not season_name:
        return jsonify({'error': 'show and season query parameters are required'}), 400

    try:
        def _fetch(plex):
            section = plex.library.section(title)
            matches = section.search(title=show_title, libtype='show')
            if not matches:
                return jsonify({'error': f"Show '{show_title}' not found in '{title}'"}), 404
            episodes = fetch_episodes_for_season(matches[0], season_name)
            return jsonify({'show': show_title, 'season': season_name, 'episodes': episodes})

        return with_plex_retry(_fetch)
    except Unauthorized:
        return jsonify({'error': 'Authentication failed. Check your PLEX_TOKEN.'}), 401
    except Exception as e:
        api_logger.error(f"Failed to fetch episodes for '{show_title}' / '{season_name}': {e}")
        return jsonify({'error': f'Failed to fetch episodes: {e}'}), 500
```

Add `fetch_episodes_for_season` to the import from `search` at the top of `size.py` (check whether `size.py` already imports anything from `search` — if not, add `from search import fetch_episodes_for_season`).

- [ ] **Step 4: Manual verification**

With the app running and a real show/season in your library, hit the route directly:
```bash
curl -s "http://localhost:<port>/size/library/<Show%20Library%20Title>/episodes?show=<Show+Title>&season=Season+1" | head -c 2000
```
Confirm you get back a JSON array of episodes with sizes/durations/resolutions that roughly sum to the season's `seasonSizes` aggregate already shown elsewhere (sanity check, not exact — aggregates may use slightly different size sourcing).

- [ ] **Step 5: Commit**

```bash
git add app/search.py app/size.py
git commit -m "feat: add on-demand per-season episode fetch route"
```

---

## Task 5: Extend `#page-size` markup with Search's search box, quick filters, and an episodes drill-down panel

**Files:**
- Modify: `app/templates/index.html` — `#page-size` section ([index.html:322-455](../../../app/templates/index.html#L322))

**Why:** The merged page needs Search's text-search input and quick-filter selects (critic rating, audience rating, year, subtitles) alongside Sizes' existing tab/view-mode/bloat-banner controls — plus a new collapsible panel to host the episode drill-down table.

- [ ] **Step 1: Read both existing markup blocks side by side**

```bash
sed -n '92,176p;322,455p' /home/kevin/Docker/MediaDash/app/templates/index.html
```

- [ ] **Step 2: Copy Search's search-box and quick-filter markup into `#page-size`**

Inside `#page-size`, immediately after the existing tab bar / before the existing per-page select, insert (renaming every `id` with a `size` prefix to avoid collisions with the soon-to-be-deleted `#page-search` ids — though since you'll delete `#page-search` in Task 7, the rename is mainly to match `size.js`'s existing `size`-prefixed id conventions, e.g. `sizeEnrichmentBanner`):

```html
<div class="search-box">
    <input type="text" id="sizeSearch" placeholder="Search title, genre, year..." autocomplete="off">
    <button class="search-clear" id="sizeSearchClear" style="display:none;" title="Clear">&times;</button>
</div>
<select class="per-page-select" id="sizeQfCriticRating" title="Filter by Critic Rating"></select>
<select class="per-page-select" id="sizeQfAudienceRating" title="Filter by Audience Rating"></select>
<select class="per-page-select" id="sizeQfYear" title="Filter by Year"></select>
<select class="per-page-select" id="sizeQfSubtitles" title="Filter by Subtitles"></select>
```

(Match the exact wrapper `<div>`/class structure surrounding the originals in `#page-search` — copy it verbatim with only the `id` renames, so existing CSS rules apply without modification.)

- [ ] **Step 3: Add the episodes drill-down panel**

Add this near the bottom of `#page-size`, alongside the other overlay panels (`sizeBloatContent`, `sizeSeasonAnalysis`):

```html
<div id="sizeEpisodesPanel" class="size-episodes-panel" style="display:none;">
    <div class="size-episodes-header">
        <span id="sizeEpisodesTitle"></span>
        <button class="btn btn-sm" id="sizeEpisodesClose" title="Close">&times;</button>
    </div>
    <div class="size-episodes-loading" id="sizeEpisodesLoading" style="display:none;">Loading episodes…</div>
    <div class="size-episodes-error" id="sizeEpisodesError" style="display:none;"></div>
    <table class="size-episodes-table" id="sizeEpisodesTable" style="display:none;">
        <thead>
            <tr><th>#</th><th>Title</th><th>Size</th><th>Duration</th><th>Resolution</th></tr>
        </thead>
        <tbody id="sizeEpisodesBody"></tbody>
    </table>
</div>
```

- [ ] **Step 4: Manual verification**

Restart the app, open the Sizes page, and confirm via browser devtools (Elements panel) that `#sizeSearch`, `#sizeQfCriticRating`, `#sizeQfAudienceRating`, `#sizeQfYear`, `#sizeQfSubtitles`, and `#sizeEpisodesPanel` all exist in the DOM (they'll be inert/empty until Tasks 6-7 wire them up — that's expected, just confirm no HTML rendering errors and the page still loads).

- [ ] **Step 5: Commit**

```bash
git add app/templates/index.html
git commit -m "feat: add search box, quick filters, and episodes panel markup to Sizes page"
```

---

## Task 6: Fold Search's quick-filter / search-box / detail-row logic into `size.js`

**Files:**
- Modify: `app/static/js/size.js`
- Read for reference: `app/static/js/search.js` (will be deleted in Task 8 — extract logic from it now)

**Why:** This is the core merge: `size.js` gains the ability to text-search and quick-filter on the full item fields (now available per Task 2), and to show expandable detail rows with full metadata (ratings/genres/summary/subtitles), matching what Search offered — composed with the view-mode/bloat/quick-refresh features Sizes already has.

- [ ] **Step 1: Read `search.js`'s quick-filter and search-box wiring**

```bash
grep -n "quickFilter\|searchSearch\|qfCritic\|qfAudience\|qfYear\|qfSubtitles\|_renderDetail\|_renderSizeBreakdown" /home/kevin/Docker/MediaDash/app/static/js/search.js
```

Read each matched function in full (`sed -n '<start>,<end>p' app/static/js/search.js`) — particularly: how `state.quickFilters` is populated/applied, how the search box debounces input and calls the fetch, and how `_renderDetail`/`_renderSizeBreakdown` build the expandable row HTML.

- [ ] **Step 2: Read `size.js`'s current state object and render/fetch functions**

```bash
grep -n "const state\|let state\|_renderTable\|_fetchLibrary\|_buildSeasonItems\|viewMode\|expandedRow" /home/kevin/Docker/MediaDash/app/static/js/size.js
```

Read the matched sections to understand the existing `state` shape, how `_renderTable` dispatches on `viewMode`, and how/whether it already has an `expandedRow` concept (size.js may have a simpler or no detail-row mechanism — confirm before assuming).

- [ ] **Step 3: Extend `size.js`'s `state` object with quick-filter and search fields**

Add to the existing `state` object (matching whatever shape Step 2 revealed — likely an object literal near the top of the IIFE):
```js
search: '',
quickFilters: { criticRating: '', audienceRating: '', year: '', subtitles: '' },
expandedRow: null,
```

- [ ] **Step 4: Port the search-box and quick-filter DOM wiring**

Copy `search.js`'s event listeners for `#searchSearch`/`#searchSearchClear`/`#qfCriticRating`/etc. into `size.js`'s init/bind function, retargeting the selectors to the `size`-prefixed ids added in Task 5 (`#sizeSearch`, `#sizeQfCriticRating`, …). Keep the same debounce timing and the same handler logic (update `state.search`/`state.quickFilters`, reset to page 1, re-fetch or re-filter) — copy the actual function bodies verbatim with only the id-selector strings changed, don't rewrite the logic from scratch.

- [ ] **Step 5: Port quick-filter option population**

`search.js` populates the rating/year/subtitle `<select>` options dynamically from the loaded item set (read its population function, e.g. `_populateQuickFilters` or similar — exact name from Step 1's grep). Copy that function into `size.js`, retargeting it at the `size`-prefixed select ids, and call it at the same point in the render lifecycle that `search.js` does (after items load/change).

- [ ] **Step 6: Port `_renderDetail`/`_renderSizeBreakdown` as the expandable-row renderer**

Copy these functions into `size.js` verbatim (they operate on item data, not on page-specific globals, per the earlier exploration that found `seasonSizes` already embedded in show items — so they should drop in with minimal adaptation). Wire row-click handlers in `size.js`'s table-rendering function to toggle `state.expandedRow` and call this renderer, matching the toggle pattern `search.js` uses.

- [ ] **Step 7: Apply quick filters client-side alongside the existing size-sort**

In `size.js`'s render/filter pipeline, before rendering rows, filter the current item set by `state.search` (substring match across the same fields `apply_table_operations` searches server-side — or, simpler and more consistent: pass `state.search` and `state.quickFilters` through to the `/size/library/<title>` fetch as query params, exactly as `search.js` does for its `/search/library/<title>` calls, and let `size.py`'s existing `apply_table_operations` call handle it server-side). Prefer the server-side route — it's already wired in `_library_response` (confirm by reading it again: does it already accept/forward `search`/quick-filter params? If yes, you only need to send them from the client; if no, add forwarding in `size.py` mirroring how `search.py`'s route did it).

- [ ] **Step 8: Manual verification**

Restart the app, open Sizes, and confirm:
- Typing in the search box filters the visible largest-files list by title/genre/etc.
- Each quick-filter select populates with real values from the loaded library and narrows results when changed.
- Clicking a row expands to show full detail (ratings, genres, summary, season breakdown for shows) — matching what the old Search page showed.
- Switching between Movies/Shows tabs and Largest/Seasons view modes still works, and filters persist sensibly across the switch (or reset — match whatever behavior feels right, but don't leave it silently broken).

- [ ] **Step 9: Commit**

```bash
git add app/static/js/size.js
git commit -m "feat: fold search box, quick filters, and detail rows into Sizes page"
```

---

## Task 7: Add the Episodes view mode and on-demand drill-down

**Files:**
- Modify: `app/static/js/size.js`

**Why:** Per the user's decisions, episodes should be reachable as a drill-down from a show/season row (not a standalone top-level tab), fetched on-demand from the new route added in Task 4.

- [ ] **Step 1: Identify where season rows are rendered (the drill-down entry point)**

```bash
grep -n "_buildSeasonItems\|_switchToSeasons\|seasonName\|_renderSizeBreakdown" /home/kevin/Docker/MediaDash/app/static/js/size.js
```

Read the matched functions — specifically wherever an individual season row or a season entry within an expanded show's detail (`_renderSizeBreakdown`, ported in Task 6) is rendered. That's where you'll add a clickable "View episodes" affordance.

- [ ] **Step 2: Add an episode-fetch helper to `size.js`**

Near the existing `_fetchLibrary`/fetch helpers, add:
```js
async function _fetchEpisodes(libraryTitle, showTitle, seasonName) {
    const url = `/size/library/${encodeURIComponent(libraryTitle)}/episodes`
        + `?show=${encodeURIComponent(showTitle)}&season=${encodeURIComponent(seasonName)}`;
    const res = await fetch(url);
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to load episodes (${res.status})`);
    }
    return res.json();
}
```

- [ ] **Step 3: Wire the panel open/close and render**

Add functions that:
- On click of a season's "View episodes" affordance: show `#sizeEpisodesPanel`, set `#sizeEpisodesTitle` to `"<Show> — <Season>"`, show `#sizeEpisodesLoading`, hide the table/error, call `_fetchEpisodes(...)`, then on success populate `#sizeEpisodesBody` with one `<tr>` per episode (`index`, `title`, `sizeFormatted`, `durationFormatted`, `resolution`), hide the loading indicator and show the table; on failure show `#sizeEpisodesError` with the message.
- On click of `#sizeEpisodesClose`: hide `#sizeEpisodesPanel` and clear its contents.

```js
function _renderEpisodeRows(episodes) {
    const body = document.getElementById('sizeEpisodesBody');
    body.innerHTML = episodes.map(ep => `
        <tr>
            <td>${ep.index ?? ''}</td>
            <td>${_escapeHtml(ep.title)}</td>
            <td>${_escapeHtml(ep.sizeFormatted)}</td>
            <td>${_escapeHtml(ep.durationFormatted)}</td>
            <td>${_escapeHtml(ep.resolution || '—')}</td>
        </tr>
    `).join('');
}
```
(Use whatever HTML-escaping helper `size.js`/`search.js` already has — grep for `_escapeHtml`/`escapeHtml` first; if none exists, check how existing render functions handle user-controlled strings like titles, and match that pattern rather than introducing a new helper.)

- [ ] **Step 4: Add the click handler on season rows**

In the season-row rendering function identified in Step 1, add a button/link per row:
```js
`<button class="btn btn-sm size-view-episodes" data-show="${_escapeHtml(showTitle)}" data-season="${_escapeHtml(season.name)}">Episodes</button>`
```
and a delegated click listener (matching `size.js`'s existing event-delegation pattern — grep for `addEventListener('click'` to find it) that reads `data-show`/`data-season` off the clicked element, plus `state.currentLibraryTitle` (or whatever the existing state field for the active library is called), and invokes the open-panel flow from Step 3.

- [ ] **Step 5: Manual verification**

Restart the app, open Sizes → Shows → Seasons view (or expand a show's detail row to see its seasons), click "Episodes" on a season, and confirm:
- The panel opens with a loading state, then populates with per-episode rows (number, title, size, duration, resolution).
- The displayed episode sizes roughly sum to that season's known total size.
- Clicking close hides the panel and a second open re-fetches cleanly (no stale data from the previous season).
- Triggering it on a season with an unusual name (e.g. "Specials"/"Season 0") doesn't error.

- [ ] **Step 6: Commit**

```bash
git add app/static/js/size.js
git commit -m "feat: add on-demand episode drill-down from season rows"
```

---

## Task 8: Remove the standalone Search page (HTML, JS, nav)

**Files:**
- Modify: `app/templates/index.html` — delete `#page-search` ([index.html:92-176](../../../app/templates/index.html#L92)) and `#nav-search` ([index.html:31](../../../app/templates/index.html#L31))
- Modify: `app/static/js/app.js` — remove `SearchDash` init/registration
- Delete: `app/static/js/search.js`

- [ ] **Step 1: Re-run Task 1's grep to get current line numbers (they may have shifted)**

```bash
grep -n "SearchDash\|page-search\|nav-search" /home/kevin/Docker/MediaDash/app/templates/index.html /home/kevin/Docker/MediaDash/app/static/js/app.js
```

- [ ] **Step 2: Delete the nav link and the page section from `index.html`**

Remove the line:
```html
<a href="#search" class="nav-link" id="nav-search">Search</a>
```
and the entire `<div id="page-search" class="page" ...> ... </div>` block.

- [ ] **Step 3: Remove `SearchDash` wiring from `app.js`**

Open the matched lines in `app.js` — typically a page-route registration like `'#search': SearchDash.init` or a `<script src="search.js">`-equivalent module load plus a call into `SearchDash` on route change. Remove the registration entry and any reference to the `SearchDash` global. Leave the analogous `SizeDash`/equivalent entries untouched.

- [ ] **Step 4: Remove the `<script>` tag loading `search.js` and delete the file**

```bash
grep -n "search.js" /home/kevin/Docker/MediaDash/app/templates/index.html
```
Delete that `<script src=".../search.js">` line, then:
```bash
rm /home/kevin/Docker/MediaDash/app/static/js/search.js
```

- [ ] **Step 5: Full-app grep to catch anything missed**

```bash
grep -rln "SearchDash\|page-search\|nav-search\|search\.js" /home/kevin/Docker/MediaDash/app/
```
This should return nothing. Resolve anything it does return before proceeding.

- [ ] **Step 6: Manual verification**

Restart the app, load the page fresh (hard refresh to bust JS cache), and confirm:
- No "Search" entry in the nav.
- Browser console shows no 404s for `search.js` and no `SearchDash is not defined` errors.
- Navigating directly to `#search` in the URL doesn't crash the app (it should just show nothing / fall through gracefully — check what `app.js`'s router does for unknown routes and confirm it degrades the same way here).
- The merged Sizes page still works end-to-end: tabs, view modes, search box, quick filters, detail rows, bloat banner, quick refresh, episodes drill-down.

- [ ] **Step 7: Commit**

```bash
git add -A app/templates/index.html app/static/js/app.js
git rm app/static/js/search.js
git commit -m "chore: remove standalone Search page now that it's merged into Sizes"
```

---

## Task 9: End-to-end verification and docs

**Files:**
- Read: `app/app.py` (to find the running container/service name for log checks)
- Modify (if relevant per CLAUDE.md doc-update rules): any operator docs that mention the "Search" page as a distinct feature

- [ ] **Step 1: Full manual walkthrough**

With the app running fresh (restart the container), walk through, in order:
1. Load the Sizes page — confirm it defaults to "Largest" sorted desc, with rank numbers.
2. Search for a known title in the search box — confirm results narrow correctly across both Movies and Shows tabs.
3. Apply each quick filter individually (critic rating, audience rating, year, subtitles) and confirm the result set narrows plausibly.
4. Expand a row's detail — confirm full metadata (ratings, genres, summary, subtitle list) renders, matching what the old Search page showed for the same item.
5. Switch to Seasons view — confirm season ranking and bloat indicators still work.
6. Drill into Episodes from a season — confirm the on-demand fetch works, shows correct data, and the panel opens/closes cleanly across multiple seasons in a row.
7. Trigger a per-library quick refresh — confirm it still works post-merge.
8. Check container logs for tracebacks: `docker compose logs --tail=200 <ServiceName>` (use the actual name from `docker compose ps` in the MediaDash stack directory).

- [ ] **Step 2: Update operator docs if the Search page is mentioned as a standalone feature**

```bash
grep -rln "Search page\|#page-search\|search\.js" /media/Documents/Fortress/02\ -\ Areas/Homelab/ 2>/dev/null
```
If anything is found describing Search as a separate page/feature, update it to reflect that search/filter capability now lives inside the Sizes page (per the root `CLAUDE.md` doc-update rule for changes to workflow/features).

- [ ] **Step 3: Final commit (docs only, if Step 2 found anything to change)**

```bash
git add -A
git commit -m "docs: reflect Search/Sizes page merge in operator notes"
```

---

## Self-Review Notes (for the plan author — already applied above)

- **Spec coverage:** default-to-largest ✅ (Task 2 keeps `SIZE_SORT_KEY` desc-sort as default); full search/filter/quick-filter capability ✅ (Task 6); episodes view, on-demand, drill-down from show/season row ✅ (Tasks 4 & 7, matching the user's explicit choices); single unified page ✅ (Task 8 removes the standalone Search page); branch already created (`feature/merge-search-sizes`) — no task needed for that.
- **No automated-test placeholders:** this repo has no test framework: each task ends with concrete manual-verification steps against the running app instead of fabricated `pytest` invocations that would not exist.
- **Type/name consistency check:** `_get_search_items` (size.py) → still reads `search:{title}` cache (untouched); `fetch_episodes_for_season` (search.py, Task 4) → imported and called as `fetch_episodes_for_season` in `size.py`'s new route (same name, no drift); `_annotate_for_size_view` (Task 2) is new and only referenced within `_library_response`; `state.quickFilters`/`state.expandedRow`/`state.search` (Task 6) are the exact field names used by the handlers/render functions added in the same task and referenced again in Task 7 (`state.currentLibraryTitle` flagged as "whatever the existing field is called" — Task 7 Step 4 explicitly tells the implementer to confirm the real name via grep rather than assume, since size.js's existing state shape wasn't fully enumerated during exploration).
