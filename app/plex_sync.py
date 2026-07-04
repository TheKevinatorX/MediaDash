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
import json
import os
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from threading import Thread

from plexapi.exceptions import Unauthorized
from plexapi.server import PlexServer

from shared import (
    cache, enrichment, PLEX_URL, PLEX_TOKEN, is_library_selected,
    fetch_movies_with_streams, format_bytes, format_duration_short,
    PRIO_SYNC, CACHE_DIR,
)
from search import (
    EXTRACTORS, fetch_episode_metadata, _merge_episode_meta,
)
from name_analysis import extract_movie_naming, extract_episode_naming

logger = logging.getLogger('mediadash.sync')

#===================
# USER CONFIGURATION
#===================

SYNC_JOURNAL_FILE = os.path.join(CACHE_DIR, 'plex_sync_journal.jsonl')
SYNC_RETRY_BASE_DELAY = 30    # seconds before the first retry after a failed sync
SYNC_RETRY_MAX_BACKOFF = 300  # cap on the retry delay as backoff doubles
SYNC_MAX_ATTEMPTS = 2         # attempts per library before giving up the run

#---------------------------------------------------------------
# DO NOT MODIFY BEYOND THIS LINE UNLESS CHANGING LOGIC
#---------------------------------------------------------------

SYNC_KEY = 'sync:full'
SUPPORTED_LIBRARY_TYPES = ('movie', 'show')
SYNC_TERMINAL_EVENTS = {'sync_completed', 'sync_failed', 'sync_cancelled', 'sync_superseded'}

#=============
# SYNC JOURNAL
#=============


class TerminalSyncError(RuntimeError):
    def __init__(self, message, code='sync_error'):
        super().__init__(message)
        self.user_message = message
        self.code = code


def _append_sync_journal(event):
    event = {
        **event,
        'event_at': datetime.now(timezone.utc).isoformat(),
    }
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(SYNC_JOURNAL_FILE, 'a', encoding='utf-8') as f:
        f.write(json.dumps(event, separators=(',', ':')) + '\n')
        f.flush()
        os.fsync(f.fileno())


def _iter_sync_journal():
    if not os.path.exists(SYNC_JOURNAL_FILE):
        return
    try:
        with open(SYNC_JOURNAL_FILE, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    logger.warning('Ignoring partial/corrupt Plex sync journal line')
    except OSError as e:
        logger.warning(f"Could not read Plex sync journal: {e}")


def _find_resume_sync_run(scope, target_title=None):
    active = {}
    completed = set()
    for event in _iter_sync_journal() or []:
        event_type = event.get('event')
        run_id = event.get('run_id')
        if event_type in ('sync_started', 'sync_resumed') and run_id:
            active[run_id] = event
        elif event_type in SYNC_TERMINAL_EVENTS and run_id:
            completed.add(run_id)
            active.pop(run_id, None)

    for event in reversed(list(active.values())):
        if event.get('run_id') in completed:
            continue
        if event.get('scope') == scope and (event.get('target_title') or None) == (target_title or None):
            return event
    return None


def _incomplete_sync_runs():
    active = {}
    order = []
    for event in _iter_sync_journal() or []:
        event_type = event.get('event')
        run_id = event.get('run_id')
        if not run_id:
            continue
        if event_type in ('sync_started', 'sync_resumed'):
            if run_id not in active:
                order.append(run_id)
            active[run_id] = event
        elif event_type in SYNC_TERMINAL_EVENTS:
            active.pop(run_id, None)
    return [active[run_id] for run_id in order if run_id in active]


def _completed_sync_libraries(run_id):
    completed = set()
    if not run_id:
        return completed
    for event in _iter_sync_journal() or []:
        if event.get('event') == 'library_completed' and event.get('run_id') == run_id:
            title = event.get('title')
            if title:
                completed.add(title)
    return completed


def _library_cache_complete(title):
    return cache.get_stale(f'search:{title}') is not None and cache.get_stale(f'naming:{title}') is not None


def _start_or_resume_sync_run(scope, target_title=None, total_libraries=None):
    resume = _find_resume_sync_run(scope, target_title)
    run_id = (resume or {}).get('run_id') or uuid.uuid4().hex
    event_name = 'sync_resumed' if resume else 'sync_started'
    _append_sync_journal({
        'event': event_name,
        'run_id': run_id,
        'scope': scope,
        'target_title': target_title,
        'started_at': (resume or {}).get('started_at') or datetime.now(timezone.utc).isoformat(),
        'total_libraries': total_libraries,
    })
    return run_id


def _mark_library_completed(run_id, title, library_type, search_count, naming_count):
    _append_sync_journal({
        'event': 'library_completed',
        'run_id': run_id,
        'title': title,
        'library_type': library_type,
        'search_count': search_count,
        'naming_count': naming_count,
        'completed_at': datetime.now(timezone.utc).isoformat(),
    })


def _mark_sync_incomplete(run_id, scope, target_title=None, failed_libraries=None, error=None, total_libraries=None):
    event = {
        'event': 'sync_incomplete',
        'run_id': run_id,
        'scope': scope,
        'target_title': target_title,
        'failed_libraries': failed_libraries or [],
        'total_libraries': total_libraries,
    }
    if error:
        event['error'] = str(error)
    _append_sync_journal(event)


def _mark_sync_failed(run_id, scope, message, target_title=None, code='sync_error', total_libraries=None):
    _append_sync_journal({
        'event': 'sync_failed',
        'run_id': run_id,
        'scope': scope,
        'target_title': target_title,
        'error_code': code,
        'error': message,
        'total_libraries': total_libraries,
    })


def _resume_run_id(scope, target_title=None):
    run = _find_resume_sync_run(scope, target_title)
    return (run or {}).get('run_id') or _start_or_resume_sync_run(scope, target_title=target_title)


def _terminal_progress(progress_key, message, code='sync_error'):
    enrichment.update_progress(
        progress_key,
        0,
        0,
        'Action needed before resync can continue',
        phase='Resync stopped',
        detail=message,
        error=message,
        errorCode=code,
    )


def _retry_delay(attempt):
    return min(SYNC_RETRY_BASE_DELAY * max(1, attempt), SYNC_RETRY_MAX_BACKOFF)


def _transient_failure_message(scope_label, attempts, reason=None):
    message = (
        f"{scope_label} stopped after {attempts} attempts. MediaDash could not finish because Plex or the "
        "network kept failing during the resync. Possible reasons: Plex is restarting, the Plex server is "
        "temporarily unreachable, a library scan is locking metadata, or the connection timed out. "
        "Once Plex/network issues are cleared up, trigger another full resync."
    )
    if reason:
        message = f"{message} Last error: {reason}"
    return message


def _sleep_with_progress(progress_key, attempt, delay, scope_label, error=None):
    started = time.time()
    while True:
        elapsed = int(time.time() - started)
        remaining = max(0, delay - elapsed)
        if remaining <= 0:
            return
        detail = f'Attempt {attempt:,}; retrying in {remaining}s'
        if error:
            detail = f'{detail} after: {error}'
        enrichment.update_progress(
            progress_key,
            0,
            0,
            f'{scope_label} paused — waiting to retry…',
            phase='Plex sync retry',
            detail=detail,
            heartbeat=attempt,
        )
        time.sleep(min(5, remaining))


def _wait_for_show_fetches(futures, title, lib_index, lib_total, progress_key):
    labels = {
        'shows': 'show list',
        'episodes': 'episode list',
        'metadata': 'episode metadata',
    }
    results = {}
    pending = set(futures.keys())
    started = time.time()
    heartbeat = 0

    while pending:
        done, _ = wait(
            [futures[name] for name in pending],
            timeout=2,
            return_when=FIRST_COMPLETED,
        )

        for name, future in list(futures.items()):
            if name in pending and future in done:
                results[name] = future.result()
                pending.remove(name)

        heartbeat += 1
        elapsed = int(time.time() - started)
        completed = [labels[name] for name in labels if name not in pending]
        active = [labels[name] for name in labels if name in pending]

        if active:
            detail_bits = []
            if completed:
                detail_bits.append('Received ' + ', '.join(completed))
            detail_bits.append('Waiting on ' + ', '.join(active))
            detail = ' · '.join(detail_bits)
        else:
            detail = 'Plex data received; preparing local analysis'

        enrichment.update_progress(
            progress_key,
            len(completed),
            len(labels),
            f'Library {lib_index}/{lib_total} — {title} (shows): fetching from Plex…',
            phase='Plex fetch',
            detail=f'{detail} · {elapsed}s elapsed',
            heartbeat=heartbeat,
        )

    return results['shows'], results['episodes'], results['metadata']


def _fetch_movies_with_progress(section, title, lib_index, lib_total, progress_key):
    enrichment.update_progress(
        progress_key, 0, 0,
        f'Library {lib_index}/{lib_total} — {title} (movies): fetching from Plex…',
        phase='Plex fetch',
        detail='Requesting movie list with stream details',
    )
    started = time.time()
    heartbeat = 0
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(fetch_movies_with_streams, section)
        while not future.done():
            heartbeat += 1
            elapsed = int(time.time() - started)
            enrichment.update_progress(
                progress_key, 0, 1,
                f'Library {lib_index}/{lib_total} — {title} (movies): fetching from Plex…',
                phase='Plex fetch',
                detail=f'Waiting on movie list and stream details · {elapsed}s elapsed',
                heartbeat=heartbeat,
            )
            time.sleep(2)
        return future.result()


#=====================
# LIBRARY SYNC WORKERS
#=====================
# Walk one movie library: fetch once, extract for both search and naming


def _sync_movie_library(section, title, lib_index, lib_total, progress_key=SYNC_KEY, run_id=None):
    raw_items = _fetch_movies_with_progress(section, title, lib_index, lib_total, progress_key)
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
                progress_key, i + 1, total,
                f'Library {lib_index}/{lib_total} — {title} (movies): {i + 1:,}/{total:,}'
            )

    cache.set(f'search:{title}', search_items, 'movie')
    cache.set(f'naming:{title}', naming_items, 'movie')
    if run_id:
        _mark_library_completed(run_id, title, 'movie', len(search_items), len(naming_items))
    logger.info(f"Synced movie library '{title}': {len(search_items)} items ({errors} errors)")


# Walk one show library: fetch shows + episodes + episode-meta once, extract for both
def _sync_show_library(section, title, lib_index, lib_total, progress_key=SYNC_KEY, run_id=None):
    enrichment.update_progress(
        progress_key, 0, 0,
        f'Library {lib_index}/{lib_total} — {title} (shows): fetching from Plex…',
        phase='Plex fetch',
        detail='Starting show list, episode list, and metadata requests',
    )

    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {
            'shows': pool.submit(section.all),
            'episodes': pool.submit(section.searchEpisodes),
            'metadata': pool.submit(fetch_episode_metadata, section),
        }
        shows, episodes, episode_meta = _wait_for_show_fetches(
            futures, title, lib_index, lib_total, progress_key
        )

    show_year_map = {s.ratingKey: s.year for s in shows if s.ratingKey and s.year}

    #Search Side: Extract Shows, THEN Merge Episode Metadata (sizes/seasons/resolutions)
    search_extractor = EXTRACTORS['show']
    search_items = []
    search_errors = 0
    for show in shows:
        try:
            search_items.append(search_extractor(show))
        except Exception as e:
            search_errors += 1
            logger.error(f"Failed to extract search data for '{getattr(show, 'title', '?')}': {e}")

    def _on_merge_progress(current, t):
        enrichment.update_progress(
            progress_key, current, t,
            f'Library {lib_index}/{lib_total} — {title} (shows): computing sizes {current:,}/{t:,}'
        )

    _merge_episode_meta(search_items, episode_meta, progress_fn=_on_merge_progress)

    # Naming side: extract episodes (reuses the same `episodes` list — no re-fetch)
    total_eps = len(episodes)
    naming_items = []
    naming_errors = 0
    for i, ep in enumerate(episodes):
        try:
            naming_items.append(extract_episode_naming(ep, show_year_map))
        except Exception as e:
            naming_errors += 1
            logger.error(f"Failed to extract naming data for episode: {e}")
        if (i + 1) % 100 == 0 or i + 1 == total_eps:
            enrichment.update_progress(
                progress_key, i + 1, total_eps,
                f'Library {lib_index}/{lib_total} — {title} (shows): naming {i + 1:,}/{total_eps:,} episodes'
            )

    cache.set(f'search:{title}', search_items, 'show')
    cache.set(f'naming:{title}', naming_items, 'show')
    if run_id:
        _mark_library_completed(run_id, title, 'show', len(search_items), len(naming_items))
    logger.info(
        f"Synced show library '{title}': {len(search_items)} shows ({search_errors} errors), "
        f"{len(naming_items)} episodes ({naming_errors} errors)"
    )


#========================
# FULL SYNC ORCHESTRATION
#========================
# Top-level orchestrator — runs as a single background task (sync_key)


def run_full_sync():
    start = time.time()
    run_id = _start_or_resume_sync_run('full')
    enrichment.update_progress(SYNC_KEY, 0, 0, 'Connecting to Plex…')
    try:
        plex = PlexServer(PLEX_URL, PLEX_TOKEN, timeout=120)
    except Unauthorized:
        message = 'Plex rejected the saved credentials. Update the Plex token in Settings, then start the resync again.'
        logger.error(f"Full sync stopped — {message}")
        _mark_sync_failed(run_id, 'full', message, code='plex_unauthorized')
        raise TerminalSyncError(message, 'plex_unauthorized')
    except Exception as e:
        logger.error(f"Full sync aborted — could not connect to Plex: {e}")
        _mark_sync_incomplete(run_id, 'full', error=e)
        raise

    sections = [
        s for s in plex.library.sections()
        if s.type in SUPPORTED_LIBRARY_TYPES and is_library_selected(s.title)
    ]
    # Movies first — fast and feeds home stats immediately — then shows
    sections.sort(key=lambda s: 0 if s.type == 'movie' else 1)
    total_libs = len(sections)
    run_id = _start_or_resume_sync_run('full', total_libraries=total_libs)
    completed_libraries = _completed_sync_libraries(run_id)

    enrichment.update_progress(SYNC_KEY, 0, total_libs, 'Connecting to Plex…')

    failed_libraries = []
    for idx, section in enumerate(sections, start=1):
        try:
            if section.title in completed_libraries and _library_cache_complete(section.title):
                enrichment.update_progress(
                    SYNC_KEY, idx, total_libs,
                    f'Library {idx}/{total_libs} — {section.title}: already synced, skipping',
                    phase='Plex sync resume',
                    detail='Restored from sync journal and existing cache',
                )
                continue
            if section.type == 'movie':
                _sync_movie_library(section, section.title, idx, total_libs, run_id=run_id)
            else:
                _sync_show_library(section, section.title, idx, total_libs, run_id=run_id)
        except Unauthorized:
            message = 'Plex rejected the saved credentials. Update the Plex token in Settings, then start the resync again.'
            logger.error(f"Full sync stopped while syncing '{section.title}' — {message}")
            _mark_sync_failed(run_id, 'full', message, code='plex_unauthorized', total_libraries=total_libs)
            raise TerminalSyncError(message, 'plex_unauthorized')
        except Exception as e:
            logger.error(f"Sync failed for library '{section.title}': {e}")
            failed_libraries.append(section.title)
            continue

    elapsed = time.time() - start
    if failed_libraries:
        _mark_sync_incomplete(
            run_id,
            'full',
            failed_libraries=failed_libraries,
            total_libraries=total_libs,
        )
        logger.warning(
            f"Full Plex sync incomplete: {len(failed_libraries)} failed libraries "
            f"in {elapsed:.1f}s; will retry"
        )
        return False
    else:
        _append_sync_journal({
            'event': 'sync_completed',
            'run_id': run_id,
            'scope': 'full',
            'completed_at': datetime.now(timezone.utc).isoformat(),
            'total_libraries': total_libs,
        })
    logger.info(f"Full Plex sync complete: {total_libs} libraries in {elapsed:.1f}s")
    return True


def run_full_sync_supervisor():
    last_error = None
    for attempt in range(1, SYNC_MAX_ATTEMPTS + 1):
        try:
            if run_full_sync():
                return
            last_error = 'One or more libraries failed during the Plex sync pass.'
        except TerminalSyncError as e:
            _terminal_progress(SYNC_KEY, e.user_message, e.code)
            raise
        except Exception as e:
            last_error = str(e)

        if attempt < SYNC_MAX_ATTEMPTS:
            delay = _retry_delay(attempt)
            logger.warning(
                f"Full Plex sync failed ({last_error}) — retrying in {delay}s "
                f"(attempt {attempt + 1}/{SYNC_MAX_ATTEMPTS})"
            )
            _sleep_with_progress(SYNC_KEY, attempt + 1, delay, 'Full Plex sync', error=last_error)

    message = _transient_failure_message('Full Plex sync', SYNC_MAX_ATTEMPTS, last_error)
    run_id = _resume_run_id('full')
    _mark_sync_failed(run_id, 'full', message, code='plex_transient_exhausted')
    _terminal_progress(SYNC_KEY, message, 'plex_transient_exhausted')
    raise TerminalSyncError(message, 'plex_transient_exhausted')


#====================
# PUBLIC ENTRY POINTS
#====================

# Start the unified sync if not already running — returns True if newly started
def start_full_sync():
    if enrichment.is_running(SYNC_KEY):
        return False
    _start_or_resume_sync_run('full')
    enrichment.start(SYNC_KEY, run_full_sync_supervisor, priority=PRIO_SYNC, silent=False)
    return True


# Quick refresh for a single library — re-walks only that section, leaves others' cache untouched
def _sync_single_library(title, progress_key):
    start = time.time()
    run_id = _start_or_resume_sync_run('library', target_title=title, total_libraries=1)
    enrichment.update_progress(progress_key, 0, 0, f'Connecting to Plex…')
    try:
        plex = PlexServer(PLEX_URL, PLEX_TOKEN, timeout=120)
    except Unauthorized:
        message = 'Plex rejected the saved credentials. Update the Plex token in Settings, then start the resync again.'
        logger.error(f"Library sync stopped for '{title}' — {message}")
        _mark_sync_failed(run_id, 'library', message, target_title=title, code='plex_unauthorized', total_libraries=1)
        raise TerminalSyncError(message, 'plex_unauthorized')
    except Exception as e:
        logger.error(f"Library sync aborted for '{title}' — could not connect to Plex: {e}")
        _mark_sync_incomplete(run_id, 'library', target_title=title, failed_libraries=[title], error=e, total_libraries=1)
        raise

    section = next(
        (s for s in plex.library.sections()
         if s.title == title and s.type in SUPPORTED_LIBRARY_TYPES and is_library_selected(s.title)),
        None
    )
    if section is None:
        message = (
            f"'{title}' is not available to resync. It may have been renamed, removed from Plex, "
            "or deselected in MediaDash settings."
        )
        logger.error(f"Library sync stopped — {message}")
        _mark_sync_failed(run_id, 'library', message, target_title=title, code='library_unavailable', total_libraries=1)
        raise TerminalSyncError(message, 'library_unavailable')

    completed_libraries = _completed_sync_libraries(run_id)
    if title in completed_libraries and _library_cache_complete(title):
        enrichment.update_progress(
            progress_key, 1, 1,
            f'Library 1/1 — {title}: already synced, skipping',
            phase='Plex sync resume',
            detail='Restored from sync journal and existing cache',
        )
    elif section.type == 'movie':
        _sync_movie_library(section, title, 1, 1, progress_key=progress_key, run_id=run_id)
    else:
        _sync_show_library(section, title, 1, 1, progress_key=progress_key, run_id=run_id)

    _append_sync_journal({
        'event': 'sync_completed',
        'run_id': run_id,
        'scope': 'library',
        'target_title': title,
        'completed_at': datetime.now(timezone.utc).isoformat(),
        'total_libraries': 1,
    })

    elapsed = time.time() - start
    logger.info(f"Quick refresh complete for library '{title}' in {elapsed:.1f}s")
    return True


def run_library_sync_supervisor(title, progress_key):
    last_error = None
    for attempt in range(1, SYNC_MAX_ATTEMPTS + 1):
        try:
            if _sync_single_library(title, progress_key):
                return
            last_error = f"Library '{title}' could not finish syncing."
        except TerminalSyncError as e:
            _terminal_progress(progress_key, e.user_message, e.code)
            raise
        except Unauthorized:
            message = 'Plex rejected the saved credentials. Update the Plex token in Settings, then start the resync again.'
            run_id = _start_or_resume_sync_run('library', target_title=title, total_libraries=1)
            _mark_sync_failed(run_id, 'library', message, target_title=title, code='plex_unauthorized', total_libraries=1)
            _terminal_progress(progress_key, message, 'plex_unauthorized')
            raise TerminalSyncError(message, 'plex_unauthorized')
        except Exception as e:
            last_error = str(e)

        if attempt < SYNC_MAX_ATTEMPTS:
            delay = _retry_delay(attempt)
            logger.warning(
                f"Library sync failed for '{title}' ({last_error}) — retrying in {delay}s "
                f"(attempt {attempt + 1}/{SYNC_MAX_ATTEMPTS})"
            )
            _sleep_with_progress(progress_key, attempt + 1, delay, f"Library sync for '{title}'", error=last_error)

    message = _transient_failure_message(f"Library sync for '{title}'", SYNC_MAX_ATTEMPTS, last_error)
    run_id = _resume_run_id('library', title)
    _mark_sync_failed(
        run_id,
        'library',
        message,
        target_title=title,
        code='plex_transient_exhausted',
        total_libraries=1,
    )
    _terminal_progress(progress_key, message, 'plex_transient_exhausted')
    raise TerminalSyncError(message, 'plex_transient_exhausted')


def library_sync_key(title):
    return f'refresh:{title}'


# Start a quick refresh for one library — returns True if newly started
def start_library_sync(title):
    key = library_sync_key(title)
    if enrichment.is_running(key) or enrichment.is_running(SYNC_KEY):
        return False
    _start_or_resume_sync_run('library', target_title=title, total_libraries=1)
    enrichment.start(key, run_library_sync_supervisor, args=(title, key), priority=PRIO_SYNC, silent=False)
    return True


#===============
# STARTUP RESUME
#===============


def resume_incomplete_syncs():
    """Called at startup so explicit Plex resyncs survive app/container restarts."""
    def _resume():
        try:
            time.sleep(1)
            runs = _incomplete_sync_runs()
            if not runs:
                return

            full_runs = [run for run in runs if run.get('scope') == 'full']
            if full_runs:
                run = full_runs[-1]
                if not enrichment.is_running(SYNC_KEY):
                    logger.info(
                        f"Auto-resuming interrupted full Plex sync "
                        f"(run={run.get('run_id', '')[:8]})"
                    )
                    start_full_sync()
                return

            started = set()
            for run in runs:
                if run.get('scope') != 'library':
                    continue
                title = run.get('target_title')
                if not title or title in started:
                    continue
                key = library_sync_key(title)
                if enrichment.is_running(key) or enrichment.is_running(SYNC_KEY):
                    continue
                logger.info(
                    f"Auto-resuming interrupted Plex sync for '{title}' "
                    f"(run={run.get('run_id', '')[:8]})"
                )
                start_library_sync(title)
                started.add(title)
        except Exception as e:
            logger.warning(f"Plex sync auto-resume failed: {e}")

    Thread(target=_resume, daemon=True, name='plex-sync-autoresume').start()
