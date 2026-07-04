############################################
# NAMING — NAMING CONVENTION ANALYZER      #
############################################

import re
import time
import logging
import unicodedata
from pathlib import PurePosixPath
from flask import Blueprint, jsonify

import shared as _shared

from shared import (
    cache, enrichment, get_plex,
    EXCLUDED_SHOWS,
    libraries_response,
)

SUPPORTED_LIBRARY_TYPES = ('movie', 'show')

naming_bp = Blueprint('naming', __name__)
fetch_logger = logging.getLogger('mediadash.naming')
api_logger = logging.getLogger('mediadash.naming.api')

#======================
# NAME ANALYSIS IMPORTS
#======================
from name_analysis import (
    sanitize_title, format_episode_code,
    build_expected_movie_name, build_expected_movie_dir,
    build_expected_episode_name, build_expected_show_dir, build_expected_season_dir,
    has_episode_code, has_correct_year, has_valid_season_dir, has_correct_episode_code,
    get_ext, _year_from_name, _normalize_for_compare, _episode_structural_prefix,
    extract_movie_naming, extract_episode_naming,
    EPISODE_CODE_RE, YEAR_IN_NAME_RE, SEASON_DIR_RE,
)


#=================
# BLUEPRINT ROUTES
#=================
# List all supported Plex libraries for naming analysis
@naming_bp.route('/libraries')
def get_libraries():
    return libraries_response(SUPPORTED_LIBRARY_TYPES, api_logger,
                              extra={'episodeFormat': _shared.EPISODE_FORMAT})


# Filter out specials (season 0) and excluded shows — applied to any show item list
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


# Fetch naming analysis for a library
@naming_bp.route('/library/<path:title>')
def get_library(title):
    cache_key = f'naming:{title}'
    cached = cache.get(cache_key) or cache.get_stale(cache_key)
    if cached and cached.get('items'):
        return _naming_response(title, cache_key, cached)

    # Cold — learn library type from search cache if available, no PLEX contact
    search_entry = cache.get(f'search:{title}') or cache.get_stale(f'search:{title}')
    lib_type = search_entry.get('type', 'movie') if search_entry else None
    api_logger.info(f"{title}: naming cache cold — run Sync to populate")
    return jsonify({
        'items': [], 'libraryType': lib_type, 'libraryTitle': title,
        'enriched': False, 'enrichmentRunning': False, 'cacheAge': None,
        'needsSync': True,
    })


# Poll for background enrichment status
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


# Debug route — raw vs normalized naming for mismatch diagnosis
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
                except Exception as e:
                    fetch_logger.debug(f"Debug mismatch scan failed for movie in '{title}': {e}")
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
                except Exception as e:
                    fetch_logger.debug(f"Debug mismatch scan failed for episode in '{title}': {e}")
                    continue

        return jsonify({'library': title, 'type': lib_type, 'mismatches': results})

    except Exception as e:
        return jsonify({'error': str(e)}), 500
