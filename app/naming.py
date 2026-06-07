############################################
# NAMING — NAMING CONVENTION ANALYZER      #
############################################

import re
import time
import logging
import unicodedata
from pathlib import PurePosixPath
from concurrent.futures import ThreadPoolExecutor

from flask import Blueprint, jsonify, request
from plexapi.server import PlexServer
from plexapi.exceptions import NotFound, Unauthorized

import shared as _shared

from shared import (
    cache, enrichment, get_plex, with_plex_retry,
    PLEX_URL, PLEX_TOKEN, EXCLUDED_SHOWS,
    PRIO_NAMING,
    _libraries_from_cache, _libraries_from_plex,
    fetch_movies_with_streams,
)

SUPPORTED_LIBRARY_TYPES = ('movie', 'show')

naming_bp = Blueprint('naming', __name__)
fetch_logger = logging.getLogger('mediadash.naming')
api_logger = logging.getLogger('mediadash.naming.api')

# ============================================================
# NAME ANALYSIS (imported from name_analysis.py)
# ============================================================

from name_analysis import (
    sanitize_title, format_episode_code,
    build_expected_movie_name, build_expected_movie_dir,
    build_expected_episode_name, build_expected_show_dir, build_expected_season_dir,
    has_episode_code, has_correct_year, has_valid_season_dir, has_correct_episode_code,
    get_ext, _year_from_name, _normalize_for_compare, _episode_structural_prefix,
    extract_movie_naming, extract_episode_naming,
    EPISODE_CODE_RE, YEAR_IN_NAME_RE, SEASON_DIR_RE,
)


# ============================================================
# FETCH HELPERS
# ============================================================

INITIAL_BATCH_SIZE = 100


# FETCH AND ANALYZE ALL MOVIES IN A SECTION
def _fetch_all_movies(section, max_results=None):
    movies = fetch_movies_with_streams(section, maxresults=max_results)
    items = []
    errors = 0
    for movie in movies:
        try:
            items.append(extract_movie_naming(movie))
        except Exception as e:
            errors += 1
            fetch_logger.error(f"Failed to extract naming for '{getattr(movie, 'title', '?')}': {e}")
    fetch_logger.info(f"Analyzed {len(movies)} movies ({errors} errors)")
    return items


# FETCH AND ANALYZE ALL EPISODES IN A SECTION (PARALLELIZED)
def _fetch_all_episodes(section, cache_key=None):
    with ThreadPoolExecutor(max_workers=2) as executor:
        shows_future = executor.submit(section.all)
        episodes_future = executor.submit(section.searchEpisodes)
        shows = shows_future.result()
        episodes = episodes_future.result()

    show_year_map = {s.ratingKey: s.year for s in shows if s.ratingKey and s.year}
    fetch_logger.info(f"Built show year map for {len(show_year_map)} shows")

    total = len(episodes)
    if cache_key:
        enrichment.update_progress(cache_key, 0, total, f'Reviewing {total:,} episode names…')

    items = []
    errors = 0
    for i, ep in enumerate(episodes):
        try:
            items.append(extract_episode_naming(ep, show_year_map))
        except Exception as e:
            errors += 1
            fetch_logger.error(f"Failed to extract naming for episode: {e}")
        if cache_key and ((i + 1) % 100 == 0 or i + 1 == total):
            enrichment.update_progress(cache_key, i + 1, total, f'Reviewing {total:,} episode names…')

    fetch_logger.info(f"Analyzed {len(items)} episodes ({errors} errors)")
    return items


# BACKGROUND: FULL NAMING ANALYSIS AFTER PROGRESSIVE INITIAL BATCH
def _naming_full_fetch_worker(cache_key, library_title, library_type, plex_url, plex_token):
    try:
        bg_plex = PlexServer(plex_url, plex_token, timeout=120)
        section = bg_plex.library.section(library_title)
        enrichment.update_progress(cache_key, 0, 0, 'Fetching from Plex…')
        if library_type == 'movie':
            items = _fetch_all_movies(section)
        elif library_type == 'show':
            items = _fetch_all_episodes(section, cache_key=cache_key)
        else:
            items = []
        cache.set(cache_key, items, library_type)
        fetch_logger.info(f"Naming full fetch complete for '{library_title}': {len(items)} items")
    except Exception as e:
        fetch_logger.error(f"Naming full fetch failed for '{library_title}': {e}")


# FETCH LIBRARY NAMING DATA WITH PROGRESSIVE LOADING SUPPORT
# CACHE KEYS ARE PREFIXED WITH "naming:" TO AVOID COLLISION WITH BROWSE DATA
def fetch_library_naming(plex, title, library_type, progressive=False, silent=True):
    cache_key = f'naming:{title}'
    # TRY FRESH CACHE FIRST, THEN FALL BACK TO STALE LOCAL DATA.
    # Navigation must not contact Plex; Sync is the explicit refresh path.
    cached = cache.get(cache_key) or cache.get_stale(cache_key)
    if cached is not None:
        is_stale = cached.get('is_stale', False)
        enriched = True
        fetch_logger.info(
            f"Returning {len(cached['items'])} cached naming items for '{title}' "
            f"(stale={is_stale}, user-sync required for Plex refresh)"
        )
        return cached['items'], cached['type'], enriched

    # CACHE MISS — START BACKGROUND WORKER IMMEDIATELY AND RETURN EMPTY FOR FAST RESPONSE
    if not enrichment.is_running(cache_key):
        enrichment.start(cache_key, _naming_full_fetch_worker,
            (cache_key, title, library_type, PLEX_URL, PLEX_TOKEN), priority=PRIO_NAMING, silent=silent)
    fetch_logger.info(f"Cold naming cache for '{title}', background worker started — returning empty")
    return [], library_type, False

# ============================================================
# BLUEPRINT ROUTES
# ============================================================

# LIST ALL SUPPORTED PLEX LIBRARIES FOR NAMING ANALYSIS
@naming_bp.route('/libraries')
def get_libraries():
    libs = _libraries_from_cache(SUPPORTED_LIBRARY_TYPES)
    if libs:
        return jsonify({'libraries': libs, 'episodeFormat': _shared.EPISODE_FORMAT})

    # COLD PATH: NO CACHE YET — CONNECT TO PLEX
    try:
        def _fetch(plex):
            libraries = _libraries_from_plex(plex, SUPPORTED_LIBRARY_TYPES, logger=api_logger)
            api_logger.info(f'Found {len(libraries)} supported libraries')
            return jsonify({'libraries': libraries, 'episodeFormat': _shared.EPISODE_FORMAT})

        return with_plex_retry(_fetch)

    except Unauthorized:
        return jsonify({'error': 'Authentication failed. Check your PLEX_TOKEN.'}), 401
    except Exception as e:
        api_logger.error(f'Failed to fetch libraries: {e}')
        return jsonify({'error': f'Failed to connect to Plex: {e}'}), 500


# FILTER OUT SPECIALS (SEASON 0) AND EXCLUDED SHOWS — APPLIED TO ANY SHOW ITEM LIST
def _filter_show_items(items):
    items = [i for i in items if i.get('seasonNum', 0) != 0]
    if EXCLUDED_SHOWS:
        items = [i for i in items if i.get('showTitle', '').lower() not in EXCLUDED_SHOWS]
    return items


def _naming_response(title, cache_key, cached):
    lib_type = cached.get('type', 'movie')
    items = cached['items']
    enriched = True

    if lib_type == 'show':
        items = _filter_show_items(items)

    cache_age = round(time.time() - cached['ts'])
    api_logger.info(f"{title}: {len(items)} naming items from cache (user-sync required for Plex refresh)")
    return jsonify({
        'items': items,
        'libraryType': lib_type,
        'libraryTitle': title,
        'enriched': enriched,
        'enrichmentRunning': enrichment.is_running(cache_key),
        'cacheAge': cache_age,
    })


# FETCH NAMING ANALYSIS FOR A LIBRARY
@naming_bp.route('/library/<path:title>')
def get_library(title):
    try:
        cache_key = f'naming:{title}'
        user_sync = request.args.get('sync') == '1'

        # FAST PATH: NAMING CACHE WARM — RESPOND WITHOUT ANY PLEX CONNECTION
        cached = cache.get(cache_key) or cache.get_stale(cache_key)
        if cached and cached.get('items'):
            return _naming_response(title, cache_key, cached)

        # NAMING COLD — TRY BROWSE CACHE TO LEARN LIBRARY TYPE WITHOUT TOUCHING PLEX
        search_entry = cache.get(f'search:{title}') or cache.get_stale(f'search:{title}')
        if search_entry:
            lib_type = search_entry.get('type', 'movie')
            # Only start worker on explicit user sync — never on page navigation
            if user_sync and not enrichment.is_running(cache_key):
                enrichment.start(cache_key, _naming_full_fetch_worker,
                    (cache_key, title, lib_type, PLEX_URL, PLEX_TOKEN), priority=PRIO_NAMING, silent=False)
            api_logger.info(f"{title}: cold naming, type from search cache — returning empty")
            return jsonify({
                'items': [], 'libraryType': lib_type, 'libraryTitle': title,
                'enriched': False, 'enrichmentRunning': enrichment.is_running(cache_key), 'cacheAge': None,
            })

        # BOTH CACHES COLD — NEED ONE PLEX CALL TO DISCOVER LIBRARY TYPE
        def _fetch(plex):
            try:
                section = plex.library.section(title)
            except NotFound:
                return jsonify({'error': f"Library '{title}' not found"}), 404
            lib_type = section.type
            if lib_type not in ('movie', 'show'):
                return jsonify({'error': f"Library type '{lib_type}' is not supported"}), 400
            # Only start worker on explicit user sync — never on page navigation
            if user_sync and not enrichment.is_running(cache_key):
                enrichment.start(cache_key, _naming_full_fetch_worker,
                    (cache_key, title, lib_type, PLEX_URL, PLEX_TOKEN), priority=PRIO_NAMING, silent=False)
            api_logger.info(f"{title}: fully cold naming, type from Plex — returning empty")
            return jsonify({
                'items': [], 'libraryType': lib_type, 'libraryTitle': title,
                'enriched': False, 'enrichmentRunning': enrichment.is_running(cache_key), 'cacheAge': None,
            })

        return with_plex_retry(_fetch)

    except Unauthorized:
        return jsonify({'error': 'Authentication failed'}), 401
    except Exception as e:
        api_logger.error(f"Error fetching naming library '{title}': {e}")
        return jsonify({'error': str(e)}), 500


# POLL FOR BACKGROUND ENRICHMENT STATUS
@naming_bp.route('/library/<path:title>/enrichment')
def get_enrichment_status(title):
    cache_key = f'naming:{title}'
    status = enrichment.get_status(cache_key)
    progress = enrichment.get_progress(cache_key)

    if status == 'complete':
        cached = cache.get(cache_key)
        if cached:
            items = cached['items']
            lib_type = cached.get('type', '')
            if lib_type == 'show':
                items = _filter_show_items(items)
            cache_age = round(time.time() - cached['ts'])
            return jsonify({'status': 'complete', 'items': items, 'cacheAge': cache_age})
        return jsonify({'status': 'complete', 'items': []})

    resp = {'status': status}
    if progress:
        resp['progress'] = progress
    return jsonify(resp)


# DEBUG ROUTE — RAW VS NORMALIZED NAMING FOR MISMATCH DIAGNOSIS
@naming_bp.route('/debug/library/<path:title>')
def debug_library_naming(title):
    try:
        plex = get_plex()
        section = next((s for s in plex.library.sections() if s.title == title), None)
        if not section:
            return jsonify({'error': f'Library "{title}" not found'}), 404

        lib_type = section.type
        results = []

        if lib_type == 'movie':
            for movie in section.all(maxresults=500):
                try:
                    item = extract_movie_naming(movie)
                    if item['overallStatus'] == 'mismatch':
                        results.append({
                            'title': item['title'],
                            'year': item['year'],
                            'filename': {
                                'actual': item['actualFilename'],
                                'expected': item['expectedFilename'],
                                'yearFound': YEAR_IN_NAME_RE.search(item['actualFilename']) and YEAR_IN_NAME_RE.search(item['actualFilename']).group(1),
                                'expectedYear': str(item['year']) if item['year'] else None,
                                'status': item['filenameStatus'],
                            },
                            'dir': {
                                'actual': item['actualDir'],
                                'expected': item['expectedDir'],
                                'yearFound': YEAR_IN_NAME_RE.search(item['actualDir']) and YEAR_IN_NAME_RE.search(item['actualDir']).group(1),
                                'expectedYear': str(item['year']) if item['year'] else None,
                                'status': item['dirStatus'],
                            },
                        })
                        if len(results) >= 20:
                            break
                except Exception:
                    continue

        elif lib_type == 'show':
            shows = section.all()
            show_year_map = {s.ratingKey: s.year for s in shows}
            for ep in section.searchEpisodes(maxresults=200):
                try:
                    item = extract_episode_naming(ep, show_year_map)
                    if item['overallStatus'] == 'mismatch':
                        results.append({
                            'show': item['showTitle'],
                            'year': item['showYear'],
                            's': item['seasonNum'],
                            'e': item['episodeNum'],
                            'filename': {
                                'actual': item['actualFilename'],
                                'expected': item['expectedFilename'],
                                'episodeCodeFound': bool(EPISODE_CODE_RE.search(item['actualFilename'])),
                                'status': item['filenameStatus'],
                            },
                            'seasonDir': {
                                'actual': item['actualSeasonDir'],
                                'expected': item['expectedSeasonDir'],
                                'validSeasonDir': bool(SEASON_DIR_RE.match(item['actualSeasonDir'])),
                                'status': item['seasonDirStatus'],
                            },
                            'showDir': {
                                'actual': item['actualShowDir'],
                                'expected': item['expectedShowDir'],
                                'yearFound': YEAR_IN_NAME_RE.search(item['actualShowDir']) and YEAR_IN_NAME_RE.search(item['actualShowDir']).group(1),
                                'expectedYear': str(item['showYear']) if item.get('showYear') else None,
                                'status': item['showDirStatus'],
                            },
                        })
                        if len(results) >= 20:
                            break
                except Exception:
                    continue

        return jsonify({'library': title, 'type': lib_type, 'mismatches': results})

    except Exception as e:
        return jsonify({'error': str(e)}), 500
