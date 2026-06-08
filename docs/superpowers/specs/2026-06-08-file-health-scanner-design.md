# File Health Scanner — Design Spec
**Date:** 2026-06-08
**Branch:** feature/file-health-scanner
**Status:** Approved

---

## Overview

A new File Health page that scans Plex media files for corruption, truncation, and structural problems that would prevent playback. Two scan modes: a fast pass (seconds per file) and a thorough decode pass (minutes for large libraries). Results persist to cache between sessions.

---

## Goals

- Surface files that are zero-byte, unreadable, structurally invalid, or partially downloaded
- Give the user a fast answer (quick scan) and a thorough answer (deep scan) as separate actions
- Results persist so a long deep scan doesn't need to be repeated on every visit
- Scope is limited to files already tracked in the Plex cache — no blind filesystem walks

---

## Architecture

### New files

| File | Purpose |
|---|---|
| `app/health.py` | All scanning logic: file discovery, quick pass, deep pass, cache read/write |
| `app/templates/health.html` | Health page template |

### Modified files

| File | Change |
|---|---|
| `app/app.py` | Three new routes (see Routes section) |
| `docker-compose.yml` | Three new read-only volume mounts for media paths |

### No changes to
- `shared.py` — scan logic does not belong in the shared state layer
- Existing cache files — health results go to their own `health_cache.json`

---

## Media Path Discovery

Media root paths are derived dynamically from `filePath` values in the existing per-library cache files (`movies_cache.json`, `shows_cache.json`, `animes_cache.json`). The scanner extracts the first two path components (e.g. `/media/Movies`) from each cached item and builds the union of unique roots.

This means new Plex libraries pointing to new paths are picked up automatically without config changes.

**Current roots (as of spec date):**
- `/media/Movies`
- `/media/FullSeries`
- `/media/NAS`

### Docker Compose mounts

All three paths added as read-only bind mounts:

```yaml
volumes:
  - /media/Movies:/media/Movies:ro
  - /media/FullSeries:/media/FullSeries:ro
  - /media/NAS:/media/NAS:ro
```

---

## Scanning Logic

### Quick Scan

Iterates all cached items and checks each `filePath`. Per-file checks (in order):

1. **Zero/tiny file** — flag if file size on disk is under 1 MB
2. **ffprobe container check** — run `ffprobe -v error -print_format json -show_streams <path>`; flag if ffprobe exits non-zero or returns no output (unreadable/malformed container)
3. **Stream validation** — parse ffprobe JSON; flag if no video stream present, no audio stream present, or any stream reports zero duration

Quick scan runs via background thread. Progress is reported through the existing `/api/progress` endpoint.

### Deep Scan

Runs after (or independently of) quick scan. Per-file:

1. Run `ffmpeg -v error -i <path> -f null - 2>&1`
2. Count lines containing error/warning indicators in stderr output
3. Flag file if any decode errors are detected (zero-tolerance — threshold can be relaxed later)

Deep scan also runs as a background thread using the same progress pattern. It enriches existing quick scan results rather than replacing them — a file that failed quick scan retains those issues alongside any decode errors found.

### Issue Types

| Key | Plain-English Label | Detected By |
|---|---|---|
| `zero_byte` | File is empty or suspiciously small | Quick |
| `unreadable` | Container cannot be parsed | Quick |
| `no_video_stream` | No video track found | Quick |
| `no_audio_stream` | No audio track found | Quick |
| `zero_duration` | Stream reports zero duration | Quick |
| `decode_errors` | File failed full playback check | Deep |

---

## Data Model

### Per-file result record

```json
{
  "filePath": "/media/Movies/Example (2001)/Example (2001).mkv",
  "title": "Example",
  "library": "Movies",
  "fileSize": 4831838208,
  "issues": ["no_audio_stream"],
  "quickScanned": true,
  "deepScanned": false,
  "scannedAt": "2026-06-08T14:32:00"
}
```

Only files with at least one issue are written to the results list. Clean files are not stored.

### `cache/health_cache.json`

```json
{
  "quick_scanned_at": "2026-06-08T14:32:00",
  "deep_scanned_at": null,
  "results": [ ]
}
```

`deep_scanned_at` is null until a deep scan has completed. Running a new scan of either type overwrites the corresponding timestamp and merges results.

---

## API Routes

### `GET /api/health/results`
Returns the current contents of `health_cache.json`. Returns `{"results": [], "quick_scanned_at": null, "deep_scanned_at": null}` if no cache exists yet.

### `POST /api/health/scan?mode=quick`
### `POST /api/health/scan?mode=deep`
Starts the appropriate scan as a background thread. Returns `{"status": "started"}` immediately. Progress tracked via existing `/api/progress` endpoint. Returns `{"status": "already_running"}` if a scan is already in progress.

---

## UI

### Navigation
New "Health" entry in the nav bar, consistent with existing entries.

### Page structure (top to bottom)

1. **Scan controls** — "Quick Scan" button and "Deep Scan" button side by side. Each shows last scanned timestamp beneath it. Deep Scan button includes a tooltip/note that it may take a long time.
2. **Progress bar** — visible while a scan is running, hidden otherwise (reuses existing progress component pattern)
3. **Summary bar** — after any scan: `X files scanned · Y issues found · Z clean`
4. **Stale warning** — if most recent scan timestamp is older than 7 days, show a subtle banner: "Results from X days ago — consider rescanning."
5. **Results table** — only files with issues. Columns: Title, Library, File Size, Issues (colored badge chips per issue), Scan Depth (Quick / Deep)
6. **Empty state** — if scan has run and zero issues found, show "All files healthy" message

### Issue badges
Red accent chips matching the existing theme. Hover tooltip on each badge shows the plain-English description from the issue type table above.

### Sortable columns
Title, Library, File Size. Default sort: Library then File Size descending.

---

## Out of Scope

- Scanning files not tracked in the Plex cache
- Auto-scheduling scans (can be added later via the existing cron/scheduled task infrastructure)
- Deleting or quarantining flagged files from within the UI
- Codec/container suitability checks (separate feature)
- Subtitle or audio language checks (separate feature)
