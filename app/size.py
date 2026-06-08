##############################
# SIZE — FILE SIZE ANALYSIS  #
##############################

import logging
import time

from flask import Blueprint, jsonify, request
from plexapi.exceptions import Unauthorized

from shared import (
    cache, enrichment, with_plex_retry,
    sort_key_fn, _libraries_from_cache, _libraries_from_plex,
)

SUPPORTED_LIBRARY_TYPES = ('movie', 'show')

size_bp = Blueprint('size', __name__)
api_logger = logging.getLogger('mediadash.size')

# ============================================================
# SIZE SORT KEYS (imported from calculations.py)
# ============================================================

from calculations import SIZE_SORT_KEY


def _annotate_for_size_view(item, rank, library_type):
    """Attach rank/mediaType to a full (non-projected) cached item for the
    merged Sizes view, without stripping any of Search's metadata fields."""
    annotated = dict(item)
    annotated['rank'] = rank
    annotated['mediaType'] = library_type
    return annotated

# ============================================================
# HELPERS
# ============================================================


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


def _library_response(title, library_type):
    if library_type not in SIZE_SORT_KEY:
        return jsonify({'error': f"Library type '{library_type}' is not supported"}), 400

    items, enriched, cache_age, enrichment_running = _get_search_items(title, library_type)

    size_key = SIZE_SORT_KEY[library_type]
    items_sorted = sorted(items, key=lambda x: x.get(size_key, 0) or 0, reverse=True)

    projected = [_annotate_for_size_view(item, i + 1, library_type) for i, item in enumerate(items_sorted)]

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
    # GET LIBRARY TYPE FROM CACHE AND RESPOND WITHOUT TOUCHING PLEX
    search_entry = cache.get(f'search:{title}') or cache.get_stale(f'search:{title}')
    if search_entry:
        return _library_response(title, search_entry.get('type', 'movie'))

    return jsonify({
        'items': [], 'total': 0, 'page': 1, 'perPage': 0, 'totalPages': 1,
        'libraryType': None, 'libraryTitle': title,
        'enriched': False, 'enrichmentRunning': False, 'cacheAge': None,
        'needsSync': True,
    })


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
            projected = [_annotate_for_size_view(item, i + 1, library_type) for i, item in enumerate(items_sorted)]
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
