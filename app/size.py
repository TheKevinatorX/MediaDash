##############################
# SIZE — FILE SIZE ANALYSIS  #
##############################

import logging
import time

from flask import Blueprint, jsonify, request
from plexapi.exceptions import NotFound, Unauthorized

from shared import (
    cache, enrichment, get_plex, with_plex_retry,
    format_bytes, format_duration_short, PLEX_URL, PLEX_TOKEN,
    sort_key_fn, _libraries_from_cache, _libraries_from_plex,
    PRIO_EPISODE,
)

SUPPORTED_LIBRARY_TYPES = ('movie', 'show')

size_bp = Blueprint('size', __name__)
api_logger = logging.getLogger('mediadash.size')


def _search_cold_worker(cache_key, library_title, library_type):
    try:
        from plexapi.server import PlexServer as _PlexServer
        from search import fetch_library_items
        bg_plex = _PlexServer(PLEX_URL, PLEX_TOKEN, timeout=120)
        fetch_library_items(bg_plex, library_title, library_type, progressive=False)
        api_logger.info(f"Browse cold worker complete for '{library_title}'")
    except Exception as e:
        api_logger.error(f"Browse cold worker failed for '{library_title}': {e}")

# ============================================================
# PROJECTIONS
# ============================================================

def _project_movie(item, rank):
    return {
        'rank': rank,
        'title': item['title'],
        'year': item.get('year'),
        'fileSize': item.get('fileSize', 0),
        'fileSizeFormatted': item.get('fileSizeFormatted'),
        'resolution': item.get('resolution'),
        'videoCodec': item.get('videoCodec'),
        'bitrate': item.get('bitrate'),
        'container': item.get('container'),
        'durationFormatted': format_duration_short(item.get('duration')),
        'filePath': item.get('filePath'),
        'subtitleLanguages': item.get('subtitleLanguages'),
        'mediaType': 'movie',
    }


def _project_show(item, rank):
    season_sizes = [
        {
            **season,
            'durationFormatted': format_duration_short(season.get('duration')),
        }
        for season in item.get('seasonSizes', [])
    ]

    return {
        'rank': rank,
        'title': item['title'],
        'year': item.get('year'),
        'totalSize': item.get('totalSize', 0),
        'totalSizeFormatted': item.get('totalSizeFormatted'),
        'dominantResolution': item.get('dominantResolution'),
        'seasons': item.get('seasons', 0),
        'episodes': item.get('episodes', 0),
        'totalDurationFormatted': format_duration_short(item.get('totalDuration')),
        'seasonSizes': season_sizes,
        'filePath': item.get('filePath'),
        'showStatus': item.get('showStatus', 'Unknown'),
        'mediaType': 'show',
    }


PROJECTORS = {
    'movie': _project_movie,
    'show': _project_show,
}

SIZE_SORT_KEY = {
    'movie': 'fileSize',
    'show': 'totalSize',
}

# ============================================================
# HELPERS
# ============================================================


def _get_search_items(title, library_type, user_sync=False):
    cache_key = f'search:{title}'
    cached = cache.get(cache_key) or cache.get_stale(cache_key)
    if cached and cached.get('items'):
        items = cached['items']
        cache_age = round(time.time() - cached['ts'])

        # FOR SHOW LIBRARIES: ONLY MARK ENRICHED WHEN EPISODE/SEASON DATA IS PRESENT.
        # Only start enrichment on explicit user sync — never on page navigation.
        if library_type == 'show':
            has_season_data = any(item.get('seasonSizes') for item in items)
            if has_season_data:
                enriched = True
            else:
                enriched = False
                if user_sync and not enrichment.is_running(cache_key):
                    from search import _episode_enrichment_worker
                    enrichment.start(
                        cache_key, _episode_enrichment_worker,
                        (cache_key, title, PLEX_URL, PLEX_TOKEN),
                        priority=PRIO_EPISODE, silent=False,
                    )
                    api_logger.info(f"Show cache lacks season data for '{title}', episode enrichment started")
        else:
            enriched = True

        return items, enriched, cache_age, enrichment.is_running(cache_key)

    # CACHE MISS — ONLY START WORKER ON EXPLICIT SYNC, NEVER ON PAGE NAVIGATION
    if user_sync and not enrichment.is_running(cache_key):
        enrichment.start(cache_key, _search_cold_worker, (cache_key, title, library_type), silent=False)
        api_logger.info(f"Cold search cache for '{title}', sync-triggered worker started — returning empty")
    else:
        api_logger.info(f"Cold search cache for '{title}', no sync requested — returning empty")
    return [], False, 0, enrichment.is_running(cache_key)


# ============================================================
# ROUTES
# ============================================================

@size_bp.route('/libraries')
def get_libraries():
    libs = _libraries_from_cache(SUPPORTED_LIBRARY_TYPES)
    if libs:
        return jsonify({'libraries': libs})

    # COLD PATH: NO CACHE YET — CONNECT TO PLEX
    try:
        def _fetch(plex):
            return jsonify({'libraries': _libraries_from_plex(plex, SUPPORTED_LIBRARY_TYPES)})

        return with_plex_retry(_fetch)

    except Unauthorized:
        return jsonify({'error': 'Authentication failed. Check your PLEX_TOKEN.'}), 401
    except Exception as e:
        api_logger.error(f'Failed to fetch libraries: {e}')
        return jsonify({'error': f'Failed to connect to Plex: {e}'}), 500


def _library_response(title, library_type, user_sync=False):
    if library_type not in PROJECTORS:
        return jsonify({'error': f"Library type '{library_type}' is not supported"}), 400

    items, enriched, cache_age, enrichment_running = _get_search_items(title, library_type, user_sync=user_sync)

    size_key = SIZE_SORT_KEY[library_type]
    items_sorted = sorted(items, key=lambda x: x.get(size_key, 0) or 0, reverse=True)

    projector = PROJECTORS[library_type]
    projected = [projector(item, i + 1) for i, item in enumerate(items_sorted)]

    search = request.args.get('search', '').strip()
    if search:
        search_lower = search.lower()
        projected = [p for p in projected if search_lower in p.get('title', '').lower()]

    sort_by = request.args.get('sort', None)
    sort_dir = request.args.get('dir', 'desc')
    if sort_by:
        reverse = sort_dir.lower() == 'desc'
        projected = sorted(projected, key=lambda x: sort_key_fn(x.get(sort_by)), reverse=reverse)

    total = len(projected)
    for i, item in enumerate(projected):
        item['rank'] = i + 1

    fetch_all = request.args.get('all', '').lower() == 'true'
    if fetch_all:
        return jsonify({
            'items': projected,
            'total': total,
            'page': 1,
            'perPage': total,
            'totalPages': 1,
            'libraryType': library_type,
            'libraryTitle': title,
            'enriched': enriched,
            'enrichmentRunning': enrichment_running,
            'cacheAge': cache_age,
        })

    try:
        page = max(1, int(request.args.get('page', 1)))
    except (ValueError, TypeError):
        page = 1
    try:
        per_page = min(100, max(10, int(request.args.get('per_page', 25))))
    except (ValueError, TypeError):
        per_page = 25

    total_pages = max(1, (total + per_page - 1) // per_page)
    start = (page - 1) * per_page
    end = start + per_page

    return jsonify({
        'items': projected[start:end],
        'total': total,
        'page': page,
        'perPage': per_page,
        'totalPages': total_pages,
        'libraryType': library_type,
        'libraryTitle': title,
        'enriched': enriched,
        'enrichmentRunning': enrichment_running,
        'cacheAge': cache_age,
    })


@size_bp.route('/library/<path:title>')
def get_library(title):
    try:
        user_sync = request.args.get('sync') == '1'

        # FAST PATH: GET LIBRARY TYPE FROM CACHE AND RESPOND WITHOUT TOUCHING PLEX
        search_entry = cache.get(f'search:{title}') or cache.get_stale(f'search:{title}')
        if search_entry:
            return _library_response(title, search_entry.get('type', 'movie'), user_sync=user_sync)

        # COLD CACHE — NEED PLEX ONLY TO DISCOVER THE LIBRARY TYPE
        def _fetch(plex):
            try:
                section = plex.library.section(title)
            except NotFound:
                return jsonify({'error': f"Library '{title}' not found"}), 404
            if section.type not in PROJECTORS:
                return jsonify({'error': f"Library type '{section.type}' is not supported"}), 400
            return _library_response(title, section.type, user_sync=user_sync)

        return with_plex_retry(_fetch)

    except Unauthorized:
        return jsonify({'error': 'Authentication failed'}), 401
    except Exception as e:
        api_logger.error(f"Error fetching size library '{title}': {e}")
        return jsonify({'error': str(e)}), 500


@size_bp.route('/library/<path:title>/enrichment')
def get_enrichment_status(title):
    cache_key = f'search:{title}'
    status = enrichment.get_status(cache_key)
    progress = enrichment.get_progress(cache_key)

    if status == 'complete':
        cached = cache.get(cache_key)
        if cached and cached.get('items'):
            items = cached['items']
            library_type = cached.get('type', 'movie')
            size_key = SIZE_SORT_KEY.get(library_type, 'fileSize')
            items_sorted = sorted(items, key=lambda x: x.get(size_key, 0) or 0, reverse=True)
            projector = PROJECTORS.get(library_type, _project_movie)
            projected = [projector(item, i + 1) for i, item in enumerate(items_sorted)]
            cache_age = round(time.time() - cached['ts'])
            return jsonify({
                'status': 'complete',
                'items': projected,
                'total': len(projected),
                'cacheAge': cache_age,
            })
        return jsonify({'status': 'complete', 'items': [], 'total': 0})

    resp = {'status': status}
    if progress:
        resp['progress'] = progress
    return jsonify(resp)
