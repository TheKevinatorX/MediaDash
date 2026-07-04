######################################
# HEALTH — FILE HEALTH SCANNER       #
######################################

import glob
import json
import logging
import os
import subprocess
import time
import uuid
from datetime import datetime, timezone
from threading import Event, Lock, Thread

from flask import Blueprint, jsonify, request

from shared import CACHE_DIR, enrichment

health_bp = Blueprint('health', __name__)
health_logger = logging.getLogger('mediadash.health')

#===================
# USER CONFIGURATION
#===================

HEALTH_CACHE_FILE = os.path.join(CACHE_DIR, 'health_cache.json')
HEALTH_JOURNAL_FILE = os.path.join(CACHE_DIR, 'health_scan_journal.jsonl')

TINY_FILE_THRESHOLD = 1 * 1024 * 1024  # 1 MB — files smaller than this are flagged
SCAN_CACHE_CHECKPOINT_EVERY = 100      # files scanned between cache checkpoints
SCAN_RETRY_MAX_BACKOFF = 600           # seconds between retries after repeated failures
VERIFY_MAX_PASSES = 3                  # follow-up passes chasing files that keep failing
MOUNT_WAIT_POLL_SECONDS = 30           # seconds between mount checks while waiting

# Issue labels shown on the health page
ISSUE_LABELS = {
    'zero_byte':       'File is empty or suspiciously small',
    'unreadable':      'Container cannot be parsed',
    'no_video_stream': 'No video track found',
    'no_audio_stream': 'No audio track found',
    'zero_duration':   'Stream reports zero duration',
}

#---------------------------------------------------------------
# DO NOT MODIFY BEYOND THIS LINE UNLESS CHANGING LOGIC
#---------------------------------------------------------------

QUICK_SCAN_KEY = 'health:File Health'

# Journal events that end a run — anything else in the journal means the run
# is unfinished and must be resumed until it completes.
TERMINAL_SCAN_EVENTS = ('scan_completed', 'scan_cancelled', 'scan_superseded')

# Cancellation is the only sanctioned way to stop a scan; everything else
# (crashes, restarts, outages) resumes automatically.
_scan_cancel = Event()


#==========
# CACHE I/O
#==========
def _load_health_cache():
    """Return the current health cache or a blank structure."""
    data = None
    if os.path.exists(HEALTH_CACHE_FILE):
        try:
            with open(HEALTH_CACHE_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            # MIGRATION: convert old 'results' list to 'file_results' dict
            if 'results' in data and 'file_results' not in data:
                file_results = {}
                for r in data['results']:
                    fp = r.get('filePath')
                    if fp:
                        r.setdefault('quickScanned', True)
                        r.setdefault('deepScanned', False)
                        file_results[fp] = r
                data['file_results'] = file_results
                # Keep 'results' key absent going forward — save migrated cache
                data.pop('results', None)
                _save_health_cache(data)
            data.setdefault('cache_version', 2)
            data.setdefault('quick_scanned_at', None)
            data.setdefault('full_scanned_at', None)
            data.setdefault('quick_total_scanned', 0)
            data.setdefault('file_results', {})
            data.setdefault('library_scanned_at', {})
            data.setdefault('last_scan_scope', None)
        except (json.JSONDecodeError, OSError) as e:
            health_logger.warning(f"Could not read health cache: {e}")
            data = None

    if data is None:
        data = {
            'cache_version': 2,
            'quick_scanned_at': None,
            'full_scanned_at': None,
            'quick_total_scanned': 0,
            'file_results': {},
            'library_scanned_at': {},
            'last_scan_scope': None,
            'active_health_run': None,
        }

    data.setdefault('cache_version', 2)
    data.setdefault('quick_scanned_at', None)
    data.setdefault('full_scanned_at', None)
    data.setdefault('quick_total_scanned', 0)
    data.setdefault('file_results', {})
    data.setdefault('library_scanned_at', {})
    data.setdefault('last_scan_scope', None)
    data.setdefault('active_health_run', None)
    return _replay_health_journal(data)


def _save_health_cache(data):
    """Atomically write health cache to disk."""
    tmp = HEALTH_CACHE_FILE + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        os.replace(tmp, HEALTH_CACHE_FILE)
    except OSError as e:
        health_logger.error(f"Could not write health cache: {e}")
        raise


def _append_health_journal(event):
    """Append one durable journal event. Malformed partial tail lines are ignored on replay."""
    event = {
        **event,
        'event_at': datetime.now(timezone.utc).isoformat(),
    }
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(HEALTH_JOURNAL_FILE, 'a', encoding='utf-8') as f:
        f.write(json.dumps(event, separators=(',', ':')) + '\n')
        f.flush()
        os.fsync(f.fileno())


def _iter_health_journal():
    if not os.path.exists(HEALTH_JOURNAL_FILE):
        return
    try:
        with open(HEALTH_JOURNAL_FILE, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    health_logger.warning('Ignoring partial/corrupt health journal line')
    except OSError as e:
        health_logger.warning(f"Could not read health journal: {e}")


def _replay_health_journal(data):
    """Merge completed per-file journal entries into the cache snapshot."""
    if not os.path.exists(HEALTH_JOURNAL_FILE):
        return data
    if os.path.exists(HEALTH_CACHE_FILE):
        try:
            if os.path.getmtime(HEALTH_CACHE_FILE) >= os.path.getmtime(HEALTH_JOURNAL_FILE):
                return data
        except OSError:
            pass

    file_results = data.setdefault('file_results', {})
    active_runs = {}
    completed_runs = set()
    run_counts = {}
    for event in _iter_health_journal() or []:
        event_type = event.get('event')
        run_id = event.get('run_id')
        if event_type in ('scan_started', 'scan_resumed') and run_id:
            active_runs[run_id] = {
                'run_id': run_id,
                'scope': event.get('scope'),
                'library_title': event.get('library_title'),
                'started_at': event.get('started_at') or event.get('event_at'),
                'target_total': event.get('target_total'),
            }
        elif event_type == 'file_scanned':
            entry = event.get('entry') or {}
            fp = entry.get('filePath')
            if fp:
                file_results[fp] = entry
            if run_id:
                run_counts[run_id] = run_counts.get(run_id, 0) + 1
        elif event_type == 'files_pruned':
            for fp in event.get('file_paths') or []:
                if fp:
                    file_results.pop(fp, None)
        elif event_type in TERMINAL_SCAN_EVENTS and run_id:
            completed_runs.add(run_id)
            active_runs.pop(run_id, None)
            if event_type == 'scan_completed':
                data['quick_scanned_at'] = event.get('completed_at') or event.get('event_at')
                data['last_scan_scope'] = event.get('scope')
                if event.get('scope') == 'full' and not event.get('library_title'):
                    data['full_scanned_at'] = event.get('completed_at') or event.get('event_at')
                if event.get('library_title'):
                    scanned_at = data.get('library_scanned_at') or {}
                    scanned_at[event['library_title']] = event.get('completed_at') or event.get('event_at')
                    data['library_scanned_at'] = scanned_at

    active_run = next(
        (run for run_id, run in reversed(list(active_runs.items())) if run_id not in completed_runs),
        None,
    )
    if active_run:
        active_run = {**active_run, 'completed_count': run_counts.get(active_run['run_id'], 0)}
    data['active_health_run'] = active_run
    data['quick_total_scanned'] = len([r for r in file_results.values() if r.get('quickScanned')])
    return data


def _incomplete_runs():
    """Return unfinished journal runs in start order (oldest first)."""
    active = {}
    for event in _iter_health_journal() or []:
        event_type = event.get('event')
        run_id = event.get('run_id')
        if event_type in ('scan_started', 'scan_resumed') and run_id:
            active[run_id] = event
        elif event_type in TERMINAL_SCAN_EVENTS and run_id:
            active.pop(run_id, None)
    return list(active.values())


def _find_resume_run(scope, library_title):
    for event in reversed(_incomplete_runs()):
        if event.get('scope') == scope and (event.get('library_title') or None) == (library_title or None):
            return event
    return None


def _find_latest_incomplete_run():
    runs = _incomplete_runs()
    return runs[-1] if runs else None


def _journal_completed_paths(run_id):
    paths = set()
    if not run_id:
        return paths
    for event in _iter_health_journal() or []:
        if event.get('event') != 'file_scanned' or event.get('run_id') != run_id:
            continue
        entry = event.get('entry') or {}
        fp = entry.get('filePath')
        if fp:
            paths.add(fp)
    return paths


def _append_pruned_files(file_paths, scope='new', library_title=None, reason='missing_from_scan_targets'):
    if not file_paths:
        return
    _append_health_journal({
        'event': 'files_pruned',
        'scope': scope,
        'library_title': library_title,
        'reason': reason,
        'file_paths': sorted(file_paths),
        'removed_count': len(file_paths),
    })


#===============
# FILE DISCOVERY
#===============
def _all_cached_items():
    """Yield every item dict from every per-library cache file."""
    for cache_file in glob.glob(os.path.join(CACHE_DIR, '*_cache.json')):
        if os.path.basename(cache_file) == 'health_cache.json':
            continue
        try:
            with open(cache_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            health_logger.warning(f"Skipping unreadable cache file {cache_file}: {e}")
            continue
        for key, entry in data.items():
            if not key.startswith('search:'):
                continue
            library_title = key.split(':', 1)[1]
            for item in (entry.get('items') or []):
                yield library_title, item


VIDEO_EXTENSIONS = {'.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv', '.ts', '.m2ts', '.mpg', '.mpeg'}


def _collect_scan_targets():
    """
    Return a list of dicts with the fields needed for scanning.
    - Movie items: filePath is a file — added directly.
    - Show/anime items: filePath is a show folder — walked for episode files.
    Skips items with no filePath or no resolvable file(s) on disk.
    """
    targets = []
    seen = set()
    for library_title, item in _all_cached_items():
        fp = item.get('filePath', '')
        if not fp:
            continue

        if os.path.isfile(fp):
            # Movie-style: direct file path
            if fp in seen:
                continue
            seen.add(fp)
            movie_title = item.get('title', '')
            targets.append({
                'filePath': fp,
                'title': movie_title,
                'parentTitle': None,
                'displayTitle': movie_title,
                'mediaKind': 'movie',
                'year': item.get('year'),
                'library': library_title,
                'fileSize': item.get('fileSize', 0),
                'addedAt': item.get('addedAt', ''),
                'durationFormatted': item.get('durationFormatted'),
                'resolution': item.get('resolution'),
                'videoCodec': item.get('videoCodec'),
                'audioCodec': item.get('audioCodec'),
                'container': item.get('container'),
                'bitrateFormatted': item.get('bitrateFormatted'),
                'audioChannelsFormatted': item.get('audioChannelsFormatted'),
                'subtitleLanguages': item.get('subtitleLanguages'),
            })
        elif os.path.isdir(fp):
            # Show-style: walk the show folder to find episode files
            show_title = item.get('title', '')
            show_year = item.get('year')
            show_added = item.get('addedAt', '')
            for root, _dirs, files in os.walk(fp):
                for fname in files:
                    ext = os.path.splitext(fname)[1].lower()
                    if ext not in VIDEO_EXTENSIONS:
                        continue
                    episode_fp = os.path.join(root, fname)
                    if episode_fp in seen:
                        continue
                    seen.add(episode_fp)
                    try:
                        file_size = os.path.getsize(episode_fp)
                    except OSError:
                        file_size = 0
                    episode_title = os.path.splitext(fname)[0]
                    rel_path = os.path.relpath(episode_fp, fp)
                    targets.append({
                        'filePath': episode_fp,
                        'title': episode_title,
                        'parentTitle': show_title,
                        'displayTitle': f'{show_title} — {rel_path}',
                        'mediaKind': 'episode',
                        'year': show_year,
                        'library': library_title,
                        'fileSize': file_size,
                        'addedAt': show_added,
                    })
    return targets


#=============
# TARGET CACHE
#=============
# Walking every show folder on the media mounts takes ~10s on large
# libraries, so requests are served from an in-memory copy. A background
# thread re-walks when the library caches change or the TTL lapses.

TARGETS_TTL_SECONDS = 600
TARGETS_SNAPSHOT_FILE = os.path.join(CACHE_DIR, 'health_targets_snapshot.json')
TARGETS_SNAPSHOT_VERSION = 4

_targets_lock = Lock()
_targets_build_lock = Lock()  # serializes the expensive walk itself
_targets_state = {'targets': None, 'sig': None, 'built_at': 0.0, 'refreshing': False}
_latest_added_state = {'value': None, 'sig': None}


def _library_cache_signature():
    """Cheap fingerprint of the per-library cache files (path, mtime, size)."""
    sig = []
    for cache_file in sorted(glob.glob(os.path.join(CACHE_DIR, '*_cache.json'))):
        if os.path.basename(cache_file) == 'health_cache.json':
            continue
        try:
            st = os.stat(cache_file)
        except OSError:
            continue
        sig.append((cache_file, st.st_mtime_ns, st.st_size))
    return tuple(sig)


def _store_targets(targets, sig):
    with _targets_lock:
        _targets_state.update(targets=targets, sig=sig, built_at=time.time(), refreshing=False)
    # Persist so a restarted container can serve instantly and re-walk lazily.
    tmp = TARGETS_SNAPSHOT_FILE + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({
                'version': TARGETS_SNAPSHOT_VERSION,
                'sig': [list(s) for s in sig],
                'built_at': time.time(),
                'targets': targets,
            }, f)
        os.replace(tmp, TARGETS_SNAPSHOT_FILE)
    except OSError as e:
        health_logger.warning(f"Could not write health targets snapshot: {e}")


def _load_targets_snapshot():
    """Seed the in-memory target cache from the on-disk snapshot, if present."""
    try:
        with open(TARGETS_SNAPSHOT_FILE, 'r', encoding='utf-8') as f:
            snap = json.load(f)
    except (OSError, json.JSONDecodeError):
        return
    if snap.get('version') != TARGETS_SNAPSHOT_VERSION:
        return
    targets = snap.get('targets')
    if not isinstance(targets, list) or not targets:
        return
    sig = tuple(tuple(s) for s in (snap.get('sig') or []))
    with _targets_lock:
        if _targets_state['targets'] is None:
            _targets_state.update(targets=targets, sig=sig, built_at=snap.get('built_at') or 0.0)


def _refresh_targets_background(sig):
    try:
        with _targets_build_lock:
            _store_targets(_collect_scan_targets(), sig)
    except Exception as e:
        health_logger.warning(f"Background scan-target refresh failed: {e}")
        with _targets_lock:
            _targets_state['refreshing'] = False


def get_scan_targets_cached():
    """
    Return scan targets from memory when available. A stale copy is served
    immediately while a background thread rebuilds. After a restart the
    on-disk snapshot is used so no request has to wait for the mount walk;
    only a truly cold start (no snapshot yet) pays for it inline.
    """
    with _targets_lock:
        seeded = _targets_state['targets'] is not None
    if not seeded:
        _load_targets_snapshot()

    sig = _library_cache_signature()
    with _targets_lock:
        cached = _targets_state['targets']
        fresh = (
            cached is not None
            and _targets_state['sig'] == sig
            and time.time() - _targets_state['built_at'] < TARGETS_TTL_SECONDS
        )
        if cached is not None and not fresh and not _targets_state['refreshing']:
            _targets_state['refreshing'] = True
            Thread(target=_refresh_targets_background, args=(sig,), daemon=True, name='health-targets').start()
    if cached is not None:
        return cached

    # Cold start with no snapshot — serialize the walk so concurrent requests
    # and the startup warm-up don't all hit the mounts at once.
    with _targets_build_lock:
        with _targets_lock:
            cached = _targets_state['targets']
        if cached is not None:
            return cached
        targets = _collect_scan_targets()
        _store_targets(targets, sig)
        return targets


def warm_health_caches():
    """Build the target cache in the background at startup so the first
    Health page load after a container restart does not pay for the walk."""
    def _warm():
        try:
            get_scan_targets_cached()
        except Exception as e:
            health_logger.warning(f"Health cache warm-up failed: {e}")
    Thread(target=_warm, daemon=True, name='health-warm').start()


def _build_fresh_targets():
    """Fresh mount walk for scans/verification — serialized with the other
    builders so concurrent walks never hit the mounts at once. The result
    also refreshes the request-serving cache and snapshot."""
    with _targets_build_lock:
        sig = _library_cache_signature()
        targets = _collect_scan_targets()
        _store_targets(targets, sig)
        return targets


def _media_mounts_missing():
    """
    True when library caches reference file paths but none of them are
    visible on disk — i.e. the media volumes are not mounted in the container.
    Short-circuits on the first path that resolves, so the healthy case is cheap.
    """
    found_any_path = False
    for _library_title, item in _all_cached_items():
        fp = item.get('filePath', '')
        if not fp:
            continue
        found_any_path = True
        if os.path.exists(fp):
            return False
    return found_any_path


def _get_latest_added():
    """Signature-cached wrapper — recomputed only when a library cache changes."""
    sig = _library_cache_signature()
    with _targets_lock:
        if _latest_added_state['sig'] == sig and _latest_added_state['value'] is not None:
            return _latest_added_state['value']
    value = _compute_latest_added()
    with _targets_lock:
        _latest_added_state.update(value=value, sig=sig)
    return value


def _compute_latest_added():
    """
    Return the most recently added item per library, plus a global latest.
    Reflects current library state without requiring a scan to have been run.
    Returns: { 'global': {...}, 'by_library': { 'Movies': {...}, 'Shows': {...}, ... } }
    """
    latest_global = None
    latest_global_dt = None
    by_library = {}       # library_title -> best item dict
    by_library_dt = {}    # library_title -> best dt

    for library_title, item in _all_cached_items():
        added_at = item.get('addedAt')
        if not added_at:
            continue
        try:
            dt = datetime.fromisoformat(added_at)
        except (ValueError, TypeError):
            continue

        entry = {
            'title': item.get('title', ''),
            'year': item.get('year'),
            'library': library_title,
            'addedAt': added_at,
        }

        # Per-library latest
        if library_title not in by_library_dt or dt > by_library_dt[library_title]:
            by_library_dt[library_title] = dt
            by_library[library_title] = entry

        # Global latest
        if latest_global_dt is None or dt > latest_global_dt:
            latest_global_dt = dt
            latest_global = entry

    return {
        'global': latest_global,
        'by_library': by_library,
    }


def _get_latest_added_legacy():
    """Legacy single-item version kept for backwards compat."""
    latest = None
    latest_dt = None
    for library_title, item in _all_cached_items():
        added_at = item.get('addedAt')
        if not added_at:
            continue
        try:
            dt = datetime.fromisoformat(added_at)
        except (ValueError, TypeError):
            continue
        if latest_dt is None or dt > latest_dt:
            latest_dt = dt
            latest = {
                'title': item.get('title', ''),
                'year': item.get('year'),
                'library': library_title,
                'addedAt': added_at,
            }
    return latest


def _get_latest_scanned(file_results):
    """
    Return the most recently scanned retained health result per library.
    Uses scannedAt from completed per-file entries, so in-flight files do not appear.
    """
    latest_global = None
    latest_global_dt = None
    by_library = {}
    by_library_dt = {}

    for entry in (file_results or {}).values():
        scanned_at = entry.get('scannedAt')
        library = entry.get('library') or 'Library'
        if not scanned_at:
            continue
        try:
            dt = datetime.fromisoformat(scanned_at)
        except (ValueError, TypeError):
            continue

        title = entry.get('parentTitle') or entry.get('displayTitle') or entry.get('title') or os.path.basename(entry.get('filePath', ''))
        item = {
            'title': title,
            'library': library,
            'scannedAt': scanned_at,
            'filePath': entry.get('filePath', ''),
            'mediaKind': entry.get('mediaKind'),
        }

        if library not in by_library_dt or dt > by_library_dt[library]:
            by_library_dt[library] = dt
            by_library[library] = item

        if latest_global_dt is None or dt > latest_global_dt:
            latest_global_dt = dt
            latest_global = item

    return {
        'global': latest_global,
        'by_library': by_library,
    }


#================
# SCAN DURABILITY
#================
# A triggered scan must reach verified completion no matter what:
# worker crashes retry, missing mounts are waited out, and container
# restarts auto-resume from the journal. Cancelling is the only way out.

def _mount_root_missing(path):
    """True when the mount root of a media path (e.g. /media/NAS) is gone —
    the signature of a network outage rather than a single bad file."""
    parts = path.strip('/').split('/')
    if len(parts) < 2:
        return False
    return not os.path.exists('/' + '/'.join(parts[:2]))


def _wait_for_media(step_text):
    """Block until media mounts are visible again.
    Returns False if the scan was cancelled while waiting."""
    while _media_mounts_missing():
        if _scan_cancel.is_set():
            return False
        enrichment.update_progress(
            QUICK_SCAN_KEY, 0, 0,
            step=step_text,
            phase='Health scan',
            detail='Media mounts are not visible — the scan will resume automatically when they return',
        )
        health_logger.warning('Media mounts not visible — health scan waiting for them to return')
        time.sleep(MOUNT_WAIT_POLL_SECONDS)
    return True


def _sleep_cancellable(seconds):
    """Sleep in 1s slices. Returns True if cancelled during the wait."""
    for _ in range(int(seconds)):
        if _scan_cancel.is_set():
            return True
        time.sleep(1)
    return _scan_cancel.is_set()


def _cancel_all_incomplete(reason=''):
    """Journal a terminal cancel for EVERY unfinished run and clear the
    active-run marker. Cancel means nothing resumes afterwards — leaving an
    older interrupted run alive would resurrect it on the next restart."""
    for run in _incomplete_runs():
        _append_health_journal({
            'event': 'scan_cancelled',
            'run_id': run.get('run_id'),
            'scope': run.get('scope'),
            'library_title': run.get('library_title'),
            'reason': reason,
        })
        health_logger.info(f"Health scan run {run.get('run_id', '')[:8]} cancelled: {reason}")
    data = _load_health_cache()
    data['active_health_run'] = None
    _save_health_cache(data)


def _supersede_stale_runs(library_title=None):
    """After a verified-complete scan, mark other unfinished runs terminal —
    full coverage means they have nothing left to contribute. Library-scoped
    scans only supersede runs for the same library."""
    for run in _incomplete_runs():
        if library_title and (run.get('library_title') or None) != library_title:
            continue
        _append_health_journal({
            'event': 'scan_superseded',
            'run_id': run.get('run_id'),
            'scope': run.get('scope'),
            'library_title': run.get('library_title'),
        })


def _count_unscanned(library_title=None):
    """Verification: fresh walk, count files without retained results."""
    targets = _build_fresh_targets()
    if library_title:
        targets = [t for t in targets if t.get('library') == library_title]
    cache_data = _load_health_cache()
    pruned = _prune_missing_file_results(cache_data, targets, scope='new', library_title=library_title)
    if pruned:
        _save_health_cache(cache_data)
    if not targets and _media_mounts_missing():
        raise RuntimeError('media mounts not visible during verification')
    file_results = cache_data.get('file_results', {})
    return sum(
        1 for t in targets
        if not (file_results.get(t['filePath']) or {}).get('quickScanned')
    )


def _prune_missing_file_results(cache_data, current_targets, scope='new', library_title=None):
    """
    Remove retained Health results for files that are no longer discoverable.
    This lets Scan New reconcile deletions/renames without forcing a full
    rescan. Results under a missing mount root are kept so outages do not
    masquerade as mass deletes.
    """
    file_results = cache_data.setdefault('file_results', {})
    current_paths = {t.get('filePath') for t in current_targets if t.get('filePath')}
    removed = []
    for fp, entry in list(file_results.items()):
        if library_title and (entry.get('library') or None) != library_title:
            continue
        if fp in current_paths:
            continue
        if _mount_root_missing(fp):
            continue
        removed.append(fp)
        file_results.pop(fp, None)

    if not removed:
        return 0

    cache_data['quick_total_scanned'] = len(
        [r for r in file_results.values() if r.get('quickScanned')]
    )
    _append_pruned_files(removed, scope=scope, library_title=library_title)
    library_msg = f" for '{library_title}'" if library_title else ''
    health_logger.info(
        f"Pruned {len(removed)} stale health result(s){library_msg}; files are no longer discoverable"
    )
    return len(removed)


def _run_scan_supervisor(scope='new', library_title=None):
    """
    Drive a scan to verified completion. Unexpected failures retry with
    backoff, missing mounts are waited out, and after each completed pass a
    fresh walk verifies nothing is left unscanned (new files that appeared
    mid-scan get follow-up passes). Only cancellation exits early.
    """
    attempt = 0
    verify_pass = 0
    current_scope = scope
    while True:
        if _scan_cancel.is_set():
            _cancel_all_incomplete('cancelled before scan pass started')
            return
        if _media_mounts_missing():
            if not _wait_for_media('Waiting for media mounts before scanning…'):
                _cancel_all_incomplete('cancelled while waiting for media mounts')
                return
        try:
            result = _run_quick_scan(scope=current_scope, library_title=library_title)
            if result == 'cancelled':
                return
            attempt = 0

            remaining = _count_unscanned(library_title)
            if remaining == 0:
                _append_health_journal({
                    'event': 'scan_verified',
                    'scope': scope,
                    'library_title': library_title,
                    'unscanned_remaining': 0,
                })
                _supersede_stale_runs(library_title)
                health_logger.info('Health scan verified complete — every discovered file has a result')
                return

            verify_pass += 1
            if verify_pass > VERIFY_MAX_PASSES:
                _append_health_journal({
                    'event': 'scan_verified',
                    'scope': scope,
                    'library_title': library_title,
                    'unscanned_remaining': remaining,
                })
                _supersede_stale_runs(library_title)
                health_logger.warning(
                    f'Health scan verification stopped after {VERIFY_MAX_PASSES} follow-up passes: '
                    f'{remaining} files still have no result (they may be persistently unreadable)'
                )
                return

            health_logger.info(
                f'Health scan verification found {remaining} unscanned files — follow-up pass {verify_pass}'
            )
            current_scope = 'new'  # follow-up passes only need the missing files
        except Exception as e:
            attempt += 1
            delay = min(60 * attempt, SCAN_RETRY_MAX_BACKOFF)
            health_logger.warning(f'Health scan pass failed ({e}) — retrying in {delay}s (attempt {attempt})')
            if _sleep_cancellable(delay):
                _cancel_all_incomplete('cancelled during retry backoff')
                return


def resume_incomplete_scans():
    """Called at startup: if the journal holds an unfinished run (container
    restart, host reboot, crash), restart it so triggered scans always reach
    verified completion."""
    def _resume():
        try:
            run = _find_latest_incomplete_run()
            if not run or enrichment.is_running(QUICK_SCAN_KEY):
                return
            scope = run.get('scope') or 'new'
            library_title = run.get('library_title') or None
            health_logger.info(
                f"Auto-resuming interrupted health scan (scope={scope}, "
                f"library={library_title or 'all'}, run={run.get('run_id', '')[:8]})"
            )
            _scan_cancel.clear()
            enrichment.start(
                QUICK_SCAN_KEY,
                lambda: _run_scan_supervisor(scope=scope, library_title=library_title),
                priority=3,
            )
        except Exception as e:
            health_logger.warning(f"Health scan auto-resume failed: {e}")
    Thread(target=_resume, daemon=True, name='health-autoresume').start()


#===========
# QUICK SCAN
#===========
def _ffprobe_file(path):
    """
    Run ffprobe on a single file.
    Returns (success: bool, streams: list, format_duration: float).
    MKV and many other containers only store duration at the format level,
    not the stream level — so format_duration is required for zero_duration checks.
    Returns (False, [], 0.0) on any failure.
    """
    try:
        result = subprocess.run(
            [
                'ffprobe', '-v', 'error',
                '-print_format', 'json',
                '-show_streams',
                '-show_format',
                path,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return False, [], 0.0
        data = json.loads(result.stdout)
        fmt_duration = float(data.get('format', {}).get('duration', 0) or 0)
        return True, data.get('streams', []), fmt_duration
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError):
        return False, [], 0.0


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
    ok, streams, format_duration = _ffprobe_file(path)
    if not ok:
        issues.append('unreadable')
        return issues

    # CHECK 3: stream validation
    has_video = False
    has_audio = False
    for s in streams:
        codec_type = s.get('codec_type', '')
        if codec_type == 'video':
            has_video = True
        elif codec_type == 'audio':
            has_audio = True

    if not has_video:
        issues.append('no_video_stream')
    if not has_audio:
        issues.append('no_audio_stream')

    # CHECK 4: zero duration — use format-level duration as the authoritative source.
    # Stream-level duration is absent in many containers (MKV, etc.), so checking
    # only stream duration produces large numbers of false positives.
    if format_duration == 0.0:
        issues.append('zero_duration')

    return issues


def _run_quick_scan(scope='new', library_title=None):
    """Background worker: run quick checks on scan targets and save results."""
    enrichment.update_progress(
        QUICK_SCAN_KEY, 0, 0,
        step='Discovering media files…',
        phase='Health scan',
        detail='Walking mounted media folders to build the scan list',
    )
    cache_data = _load_health_cache()
    file_results = cache_data.get('file_results', {})
    resume_run = _find_resume_run(scope, library_title)
    run_id = (resume_run or {}).get('run_id') or uuid.uuid4().hex
    started_at = (resume_run or {}).get('started_at') or datetime.now(timezone.utc).isoformat()
    completed_paths = _journal_completed_paths(run_id)

    # Scans always do a fresh walk so brand-new files are picked up;
    # the result also refreshes the request-serving target cache.
    all_targets = _build_fresh_targets()
    _prune_missing_file_results(cache_data, all_targets, scope=scope, library_title=library_title)
    if scope == 'new':
        # Only targets without preserved results — the expensive full scan is
        # a one-time baseline; Scan New fills in missing files afterwards.
        targets = [
            t for t in all_targets
            if not (file_results.get(t['filePath']) or {}).get('quickScanned')
        ]
    else:
        targets = all_targets
    if library_title:
        targets = [t for t in targets if t.get('library') == library_title]
    original_total = len(targets)
    if completed_paths:
        targets = [t for t in targets if t.get('filePath') not in completed_paths]
    remaining_total = len(targets)

    scan_event = 'scan_resumed' if resume_run else 'scan_started'
    _append_health_journal({
        'event': scan_event,
        'run_id': run_id,
        'scope': scope,
        'library_title': library_title,
        'started_at': started_at,
        'target_total': original_total,
        'already_completed': len(completed_paths),
        'remaining_total': remaining_total,
    })
    cache_data['active_health_run'] = {
        'run_id': run_id,
        'scope': scope,
        'library_title': library_title,
        'started_at': started_at,
        'target_total': original_total,
        'already_completed': len(completed_paths),
        'remaining_total': remaining_total,
    }
    _save_health_cache(cache_data)

    total = remaining_total
    totals_by_library = {}
    current_by_library = {}
    for target in targets:
        lib = target.get('library') or 'Library'
        totals_by_library[lib] = totals_by_library.get(lib, 0) + 1

    for i, target in enumerate(targets):
        if _scan_cancel.is_set():
            _cancel_all_incomplete('cancelled by user')
            return 'cancelled'
        lib = target.get('library') or 'Library'
        current_by_library[lib] = current_by_library.get(lib, 0) + 1
        lib_current = current_by_library[lib]
        lib_total = totals_by_library.get(lib, total)
        step_title = target.get('displayTitle') or target.get('title') or os.path.basename(target['filePath'])
        absolute_current = len(completed_paths) + i + 1
        absolute_total = len(completed_paths) + total
        enrichment.update_progress(
            QUICK_SCAN_KEY,
            absolute_current,
            absolute_total,
            step=f"{lib}: {lib_current:,}/{lib_total:,} — {step_title}",
            phase='Health scan',
            detail='Completed files are written to the health journal immediately',
        )
        fp = target['filePath']
        try:
            quick_issues = _quick_scan_file(target)
            # A failing check can mean the media mount itself vanished
            # (network outage) — pause and recheck instead of recording
            # bogus results for this and every remaining file.
            while quick_issues and _mount_root_missing(fp):
                if not _wait_for_media('Paused — waiting for media mounts to return…'):
                    _cancel_all_incomplete('cancelled while waiting for media mounts')
                    return 'cancelled'
                quick_issues = _quick_scan_file(target)
        except Exception as e:
            health_logger.warning(f"Unexpected error scanning {fp}: {e}")
            continue

        existing_entry = file_results.get(fp, {})
        combined_issues = list(set(quick_issues))

        file_results[fp] = {
            'filePath': fp,
            'title': target['title'],
            'parentTitle': target.get('parentTitle'),
            'displayTitle': target.get('displayTitle') or target['title'],
            'mediaKind': target.get('mediaKind'),
            'year': target.get('year'),
            'library': target['library'],
            'fileSize': target['fileSize'],
            'addedAt': target.get('addedAt', ''),
            'quickScanned': True,
            'deepScanned': existing_entry.get('deepScanned', False),
            'issues': combined_issues,
            'scannedAt': datetime.now(timezone.utc).isoformat(),
        }
        _append_health_journal({
            'event': 'file_scanned',
            'run_id': run_id,
            'scope': scope,
            'library_title': library_title,
            'index': absolute_current,
            'target_total': absolute_total,
            'filePath': fp,
            'entry': file_results[fp],
        })

        if (i + 1) % SCAN_CACHE_CHECKPOINT_EVERY == 0:
            checkpoint_data = _load_health_cache()
            checkpoint_data['file_results'] = file_results
            checkpoint_data['cache_version'] = 2
            checkpoint_data['quick_total_scanned'] = len(
                [r for r in file_results.values() if r.get('quickScanned')]
            )
            checkpoint_data['active_health_run'] = cache_data.get('active_health_run')
            _save_health_cache(checkpoint_data)

    completed_at = datetime.now(timezone.utc).isoformat()
    cache_data = _load_health_cache()
    cache_data['file_results'] = file_results
    cache_data['cache_version'] = 2
    cache_data['quick_scanned_at'] = completed_at
    cache_data['last_scan_scope'] = scope
    if scope == 'full' and not library_title:
        cache_data['full_scanned_at'] = completed_at
    if library_title:
        scanned_at = cache_data.get('library_scanned_at') or {}
        scanned_at[library_title] = completed_at
        cache_data['library_scanned_at'] = scanned_at
    cache_data['active_health_run'] = None
    cache_data['quick_total_scanned'] = len(
        [r for r in file_results.values() if r.get('quickScanned')]
    )
    _save_health_cache(cache_data)
    _append_health_journal({
        'event': 'scan_completed',
        'run_id': run_id,
        'scope': scope,
        'library_title': library_title,
        'started_at': started_at,
        'completed_at': completed_at,
        'target_total': len(completed_paths) + total,
        'completed_count': len(completed_paths) + total,
    })
    library_msg = f" for '{library_title}'" if library_title else ''
    health_logger.info(
        f"Quick scan ({scope}){library_msg} complete: {total} files scanned, "
        f"{len([r for r in file_results.values() if r.get('issues')])} with issues"
    )
    return 'completed'


#=======
# ROUTES
#=======
@health_bp.route('/results')
def get_results():
    """Legacy endpoint — returns a flat list of flagged items for backwards compat."""
    data = _load_health_cache()
    file_results = data.get('file_results', {})
    flagged = [r for r in file_results.values() if r.get('issues')]
    return jsonify({
        'quick_scanned_at': data.get('quick_scanned_at'),
        'quick_total_scanned': data.get('quick_total_scanned', 0),
        'full_scanned_at': data.get('full_scanned_at'),
        'last_scan_scope': data.get('last_scan_scope'),
        'retained_result_count': len(file_results),
        'results': flagged,
        'issueLabels': ISSUE_LABELS,
        'latest_added': _get_latest_added(),
        'latest_scanned': _get_latest_scanned(file_results),
    })


@health_bp.route('/items')
def get_items():
    """
    Returns all library items merged with health data, paginated.
    Query params: page, per_page, filter (all|scanned|issues|healthy|pending),
                  search, library, sort, dir
    """
    page = max(1, int(request.args.get('page', 1)))
    per_page = min(200, max(10, int(request.args.get('per_page', 50))))
    filter_mode = request.args.get('filter', 'scanned')
    search = request.args.get('search', '').strip().lower()
    library_filter = request.args.get('library', '').strip()
    sort_col = request.args.get('sort', 'addedAt')
    sort_dir = request.args.get('dir', 'desc')

    cache_data = _load_health_cache()
    file_results = cache_data.get('file_results', {})

    # BUILD FULL ITEM LIST from scan targets — handles both movie files and
    # show/anime directories (walks folders to find individual episode files).
    all_items_raw = []
    libraries_set = set()
    library_counts = {}

    for target in get_scan_targets_cached():
        fp = target['filePath']
        lib = target['library']
        libraries_set.add(lib)
        library_counts[lib] = library_counts.get(lib, 0) + 1

        health_entry = file_results.get(fp)
        quick_scanned = bool(health_entry and health_entry.get('quickScanned'))
        issues = list(health_entry.get('issues', [])) if health_entry else []
        scanned_at = health_entry.get('scannedAt') if health_entry else None

        # Build per-check pass/fail (True=pass, False=fail, None=not checked)
        def _chk(key, _qs=quick_scanned, _iss=issues):
            if not _qs:
                return None
            return key not in _iss

        all_items_raw.append({
            'filePath': fp,
            'fileName': os.path.basename(fp),
            'directory': os.path.dirname(fp),
            'extension': os.path.splitext(fp)[1].lower().lstrip('.'),
            'title': target['title'],
            'parentTitle': target.get('parentTitle') or (health_entry or {}).get('parentTitle'),
            'displayTitle': target.get('displayTitle') or (health_entry or {}).get('displayTitle') or target['title'],
            'mediaKind': target.get('mediaKind') or (health_entry or {}).get('mediaKind'),
            'year': target.get('year'),
            'library': lib,
            'fileSize': target['fileSize'],
            'addedAt': target.get('addedAt', ''),
            'durationFormatted': target.get('durationFormatted'),
            'resolution': target.get('resolution'),
            'videoCodec': target.get('videoCodec'),
            'audioCodec': target.get('audioCodec'),
            'container': target.get('container') or os.path.splitext(fp)[1].lower().lstrip('.'),
            'bitrateFormatted': target.get('bitrateFormatted'),
            'audioChannelsFormatted': target.get('audioChannelsFormatted'),
            'subtitleLanguages': target.get('subtitleLanguages'),
            'quickScanned': quick_scanned,
            'issues': issues,
            'scannedAt': scanned_at,
            'zero_byte':       _chk('zero_byte'),
            'unreadable':      _chk('unreadable'),
            'no_video_stream': _chk('no_video_stream'),
            'no_audio_stream': _chk('no_audio_stream'),
            'zero_duration':   _chk('zero_duration'),
        })

    # UNSCANNED BREAKDOWN — computed before any filtering for the meta panel
    unscanned_by_library = {}
    for it in all_items_raw:
        if not it['quickScanned']:
            lib = it['library']
            unscanned_by_library[lib] = unscanned_by_library.get(lib, 0) + 1
    total_unscanned = sum(unscanned_by_library.values())

    # MOUNT CHECK — only worth probing when no scan targets resolved at all
    media_mounts_missing = not libraries_set and _media_mounts_missing()

    all_items = all_items_raw

    # SCOPE FILTERS — library and search narrow the working set first so the
    # stats below describe the whole scope, not just the active filter tab
    if library_filter:
        all_items = [it for it in all_items if it['library'] == library_filter]

    if search:
        all_items = [
            it for it in all_items
            if search in (it.get('title') or '').lower()
            or search in (it.get('parentTitle') or '').lower()
            or search in (it.get('filePath') or '').lower()
        ]

    # STATS — computed before the status filter so switching between
    # All/Scanned/Issues/Healthy/Pending never zeroes the counts
    stats_total   = len(all_items)
    total_issues  = sum(1 for it in all_items if it['issues'])
    total_healthy = sum(1 for it in all_items if it['quickScanned'] and not it['issues'])
    total_pending = sum(1 for it in all_items if not it['quickScanned'])

    # Status Filter
    if filter_mode == 'scanned':
        all_items = [it for it in all_items if it['quickScanned']]
    elif filter_mode == 'issues':
        all_items = [it for it in all_items if it['issues']]
    elif filter_mode == 'healthy':
        all_items = [it for it in all_items if it['quickScanned'] and not it['issues']]
    elif filter_mode == 'pending':
        all_items = [it for it in all_items if not it['quickScanned']]

    # Sort
    VALID_COLS = {
        'title', 'library', 'fileSize', 'addedAt', 'scannedAt',
        'zero_byte', 'unreadable', 'no_video_stream', 'no_audio_stream',
        'zero_duration',
    }
    if sort_col not in VALID_COLS:
        sort_col = 'addedAt'

    def sort_key(it):
        v = it.get(sort_col)
        if sort_col == 'addedAt':
            # Sort by ISO date string; missing/empty sorts last
            return (0 if v else 1, v or '')
        if v is None:
            primary = 1 if sort_col not in ('title', 'library', 'fileSize', 'addedAt', 'scannedAt') else ''
        elif isinstance(v, bool):
            primary = 0 if not v else 2  # fail first, pass last
        elif isinstance(v, str):
            primary = v.lower()
        else:
            primary = v
        return (primary, it.get('title', '').lower())

    reverse = sort_dir == 'desc'
    all_items.sort(key=sort_key, reverse=reverse)

    # Paginate
    total = len(all_items)
    total_pages = max(1, (total + per_page - 1) // per_page)
    page = min(page, total_pages)
    start = (page - 1) * per_page
    page_items = all_items[start:start + per_page]

    # RUN STATE RECONCILIATION — the cache/journal can claim an active run
    # after a container restart killed the scan thread. Only report a run as
    # active when the task runner is actually executing it; otherwise expose
    # it as interrupted so the UI can say it will resume instead of "Scanning".
    scan_running = enrichment.is_running(QUICK_SCAN_KEY)
    active_run = cache_data.get('active_health_run')
    interrupted_run = None
    if active_run and not scan_running:
        interrupted_run = active_run
        active_run = None

    return jsonify({
        'items': page_items,
        'total': total,
        'page': page,
        'per_page': per_page,
        'total_pages': total_pages,
        'libraries': sorted(libraries_set),
        'library_counts': library_counts,
        'issueLabels': ISSUE_LABELS,
        'quick_scanned_at': cache_data.get('quick_scanned_at'),
        'full_scanned_at': cache_data.get('full_scanned_at'),
        'last_scan_scope': cache_data.get('last_scan_scope'),
        'active_health_run': active_run,
        'scan_running': scan_running,
        'interrupted_health_run': interrupted_run,
        'quick_total_scanned': cache_data.get('quick_total_scanned', 0),
        'retained_result_count': len(file_results),
        'cache_policy': 'Health results are retained until a file is explicitly rescanned.',
        'stats': {
            'total': stats_total,
            'issues': total_issues,
            'healthy': total_healthy,
            'pending': total_pending,
        },
        'unscanned_by_library': unscanned_by_library,
        'total_unscanned': total_unscanned,
        'media_mounts_missing': media_mounts_missing,
        'latest_added': _get_latest_added(),
        'latest_scanned': _get_latest_scanned(file_results),
    })


@health_bp.route('/scan', methods=['POST'])
def start_scan():
    scope = request.args.get('scope', 'new')
    library_title = request.args.get('library', '').strip() or None

    if scope not in ('new', 'full'):
        return jsonify({'error': 'scope must be new or full'}), 400

    if _media_mounts_missing():
        return jsonify({
            'status': 'no_media',
            'error': 'No media files are visible inside the container, so there is nothing to scan. '
                     'Check that your media folders are mounted as volumes in docker-compose.yml, '
                     'then recreate the container.',
        }), 503

    if enrichment.is_running(QUICK_SCAN_KEY):
        return jsonify({'status': 'already_running'}), 409

    _scan_cancel.clear()
    enrichment.start(QUICK_SCAN_KEY, lambda: _run_scan_supervisor(scope=scope, library_title=library_title), priority=3)
    return jsonify({'status': 'started'})


@health_bp.route('/scan/cancel', methods=['POST'])
def cancel_scan():
    """Stop the running scan (or clear a paused one) so it will not resume."""
    if enrichment.is_running(QUICK_SCAN_KEY):
        _scan_cancel.set()
        return jsonify({'status': 'cancelling'})
    if _find_latest_incomplete_run():
        _cancel_all_incomplete('cancelled from UI while paused')
        return jsonify({'status': 'cancelled'})
    return jsonify({'status': 'idle'})
