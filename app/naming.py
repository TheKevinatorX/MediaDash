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
# NAMING HELPERS
# ============================================================

# SANITIZE TITLE FOR FILESYSTEM: REMOVE ILLEGAL CHARS
def sanitize_title(title):
    if not title:
        return ''
    repl = _shared.SPECIAL_CHAR_REPLACEMENT
    title = re.sub(r'[:<>"/\\|?*]', repl, title)
    title = re.sub(r'\s+', ' ', title).strip()
    title = re.sub(r'\s*-\s*$', '', title).strip()
    return title


# FORMAT EPISODE CODE BASED ON CONFIGURED FORMAT
def format_episode_code(season_num, episode_num):
    if _shared.EPISODE_FORMAT == 'SxxExx':
        return f'S{season_num:02d}E{episode_num:02d}'
    else:
        return f'{season_num}x{episode_num:02d}'


# BUILD EXPECTED MOVIE FILENAME FROM METADATA
def build_expected_movie_name(title, year, ext):
    clean_title = sanitize_title(title)
    if year and not re.search(r'\(\d{4}\)', clean_title):
        return f'{clean_title} ({year}){ext}'
    return f'{clean_title}{ext}'


# BUILD EXPECTED MOVIE DIRECTORY NAME FROM METADATA
def build_expected_movie_dir(title, year):
    clean_title = sanitize_title(title)
    if year and not re.search(r'\(\d{4}\)', clean_title):
        return f'{clean_title} ({year})'
    return clean_title


# BUILD EXPECTED EPISODE FILENAME FROM METADATA
def build_expected_episode_name(show_title, show_year, season_num, episode_num, episode_title, ext):
    clean_show = sanitize_title(show_title)
    clean_ep = sanitize_title(episode_title)
    code = format_episode_code(season_num, episode_num)

    if show_year and not re.search(r'\(\d{4}\)', clean_show):
        base = f'{clean_show} ({show_year}) - {code}'
    else:
        base = f'{clean_show} - {code}'

    if clean_ep:
        return f'{base} - {clean_ep}{ext}'
    return f'{base}{ext}'


# BUILD EXPECTED SHOW DIRECTORY NAME
def build_expected_show_dir(title, year):
    clean_title = sanitize_title(title)
    if year and not re.search(r'\(\d{4}\)', clean_title):
        return f'{clean_title} ({year})'
    return clean_title


# BUILD EXPECTED SEASON DIRECTORY NAME
def build_expected_season_dir(season_num):
    if _shared.SEASON_DIR_ZERO_PAD:
        return f'Season {season_num:02d}'
    return f'Season {season_num}'


# PATTERN: EPISODE CODE (NxEE or SxxExx, case-insensitive)
# \d{1,2}x\d{2,3} avoids matching video resolutions like 1920x1080 (3-4 digit sides)
EPISODE_CODE_RE = re.compile(r'\b\d{1,2}x\d{2,3}\b|S\d{1,2}E\d{1,2}', re.IGNORECASE)
# PATTERN: YEAR IN PARENTHESES e.g. (2021)
YEAR_IN_NAME_RE = re.compile(r'\((\d{4})\)')
# PATTERN: VALID SEASON DIRECTORY e.g. "Season 1" or "Season 01"
SEASON_DIR_RE = re.compile(r'^Season\s+\d+$', re.IGNORECASE)


def has_episode_code(filename):
    return bool(EPISODE_CODE_RE.search(filename))


def has_correct_year(name, expected_year):
    if not expected_year:
        return True
    m = YEAR_IN_NAME_RE.search(name)
    if not m:
        return False
    return abs(int(m.group(1)) - int(expected_year)) <= _shared.YEAR_TOLERANCE


def has_valid_season_dir(dirname):
    return bool(SEASON_DIR_RE.match(dirname))


def has_correct_episode_code(filename, season_num, episode_num):
    nxee = re.compile(rf'\b{season_num}x{episode_num:02d}\b', re.IGNORECASE)
    sxxexx = re.compile(rf'\bS{season_num:02d}E{episode_num:02d}\b', re.IGNORECASE)
    return bool(nxee.search(filename) or sxxexx.search(filename))


# EXTRACT FILE EXTENSION FROM PATH
def get_ext(file_path):
    if not file_path:
        return ''
    return PurePosixPath(file_path).suffix


# PULL THE 4-DIGIT YEAR OUT OF A NAME LIKE "Title (2021)", OR FALL BACK TO DEFAULT
def _year_from_name(name, default=None):
    m = YEAR_IN_NAME_RE.search(name)
    return int(m.group(1)) if m else default


# NORMALIZE FOR FILENAME COMPARISON: UNICODE FORM + CURLY QUOTES -> STRAIGHT,
# ELLIPSIS -> THREE DOTS, STRIP EXCLAMATION MARKS (metadata often omits/adds them).
def _normalize_for_compare(s):
    if not s:
        return ""
    s = unicodedata.normalize("NFC", s)
    for src, dst in [
        (0x2018, chr(0x27)), (0x2019, chr(0x27)),
        (0x201c, chr(0x22)), (0x201d, chr(0x22)),
        (0x2026, "..."),
    ]:
        s = s.replace(chr(src), dst)
    s = re.sub(r"!+", "", s)
    return s.lower()


# EXTRACT THE STRUCTURAL PREFIX OF AN EPISODE FILENAME: “Show (Year) - SxxExx”
# Episode titles are excluded from comparison because Plex metadata titles often
# differ from the titles embedded in existing filenames (translated names, alt titles,
# custom labels, etc.). The show identity + episode code is sufficient for correctness.
def _episode_structural_prefix(filename):
    stem = PurePosixPath(filename).stem
    m = EPISODE_CODE_RE.search(stem)
    if not m:
        return _normalize_for_compare(stem)
    return _normalize_for_compare(stem[:m.end()])

# ============================================================
# DATA EXTRACTION
# ============================================================

# EXTRACT MOVIE NAMING DATA FROM PLEX MOVIE OBJECT
def extract_movie_naming(movie):
    media = movie.media[0] if movie.media else None
    part = media.parts[0] if media and media.parts else None
    file_path = getattr(part, 'file', None) if part else None

    actual_filename = PurePosixPath(file_path).name if file_path else ''
    ext = get_ext(file_path)
    expected_filename = build_expected_movie_name(movie.title, movie.year, ext)
    filename_status = 'match' if has_correct_year(actual_filename, _year_from_name(expected_filename, movie.year)) else 'mismatch'

    actual_dir = PurePosixPath(file_path).parent.name if file_path else ''
    expected_dir = build_expected_movie_dir(movie.title, movie.year)
    dir_status = 'match' if has_correct_year(actual_dir, _year_from_name(expected_dir, movie.year)) else 'mismatch'

    overall_status = 'mismatch' if 'mismatch' in (filename_status, dir_status) else 'match'

    # COLLECT SUBTITLE LANGUAGES FROM PART STREAMS (TYPE 3 = SUBTITLE, REQUIRES includeElements=Stream)
    subtitle_langs = []
    if part:
        try:
            for stream in getattr(part, 'streams', []):
                if getattr(stream, 'streamType', 0) == 3:
                    lang = (
                        getattr(stream, 'language', None) or
                        getattr(stream, 'languageTag', None) or
                        getattr(stream, 'languageCode', None) or
                        'Unknown'
                    )
                    if lang not in subtitle_langs:
                        subtitle_langs.append(lang)
        except Exception:
            pass

    return {
        'title': movie.title or 'Unknown',
        'year': movie.year,
        'filePath': file_path or '',
        'actualFilename': actual_filename,
        'expectedFilename': expected_filename,
        'filenameStatus': filename_status,
        'actualDir': actual_dir,
        'expectedDir': expected_dir,
        'dirStatus': dir_status,
        'overallStatus': overall_status,
        'subtitleLanguages': ', '.join(subtitle_langs) if subtitle_langs else None,
    }


# EXTRACT EPISODE NAMING DATA FROM PLEX EPISODE OBJECT
def extract_episode_naming(episode, show_year_map=None):
    media = episode.media[0] if episode.media else None
    part = media.parts[0] if media and media.parts else None
    file_path = getattr(part, 'file', None) if part else None

    show_title = getattr(episode, 'grandparentTitle', None) or 'Unknown'
    show_year = None
    if show_year_map:
        show_key = getattr(episode, 'grandparentRatingKey', None)
        if show_key:
            show_year = show_year_map.get(show_key)
    if not show_year:
        show_year = getattr(episode, 'grandparentYear', None)

    season_num = getattr(episode, 'parentIndex', 0) or 0
    episode_num = getattr(episode, 'index', 0) or 0
    episode_title = getattr(episode, 'title', '') or ''

    actual_filename = PurePosixPath(file_path).name if file_path else ''
    ext = get_ext(file_path)
    expected_filename = build_expected_episode_name(
        show_title, show_year, season_num, episode_num, episode_title, ext
    )
    filename_status = 'match' if (
        has_correct_year(actual_filename, show_year) and
        has_correct_episode_code(actual_filename, season_num, episode_num)
    ) else 'mismatch'

    actual_season_dir = PurePosixPath(file_path).parent.name if file_path else ''
    expected_season_dir = build_expected_season_dir(season_num)
    season_dir_status = 'match' if has_valid_season_dir(actual_season_dir) else 'mismatch'

    actual_show_dir = PurePosixPath(file_path).parent.parent.name if file_path else ''
    expected_show_dir = build_expected_show_dir(show_title, show_year)
    show_dir_status = 'match' if has_correct_year(actual_show_dir, _year_from_name(expected_show_dir, show_year)) else 'mismatch'

    overall_status = 'mismatch' if 'mismatch' in (filename_status, season_dir_status, show_dir_status) else 'match'

    return {
        'showTitle': show_title,
        'showYear': show_year,
        'seasonNum': season_num,
        'episodeNum': episode_num,
        'episodeTitle': episode_title,
        'filePath': file_path or '',
        'actualFilename': actual_filename,
        'expectedFilename': expected_filename,
        'filenameStatus': filename_status,
        'actualSeasonDir': actual_season_dir,
        'expectedSeasonDir': expected_season_dir,
        'seasonDirStatus': season_dir_status,
        'actualShowDir': actual_show_dir,
        'expectedShowDir': expected_show_dir,
        'showDirStatus': show_dir_status,
        'overallStatus': overall_status,
    }

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
