##################################
# SEARCH — PLEX LIBRARY FETCHER  #
##################################

import re
import time
import logging
import requests
from concurrent.futures import ThreadPoolExecutor

from flask import Blueprint, jsonify, request
from plexapi.server import PlexServer
from plexapi.exceptions import NotFound, Unauthorized

import shared as _shared
from shared import (
    cache, enrichment, get_plex, with_plex_retry,
    PLEX_URL, PLEX_TOKEN,
    format_bytes, format_duration_short, format_date, format_channels,
    PRIO_BROWSE_MOVIE, PRIO_BROWSE_SHOW, PRIO_EPISODE,
    sort_key_fn, _libraries_from_cache, _libraries_from_plex,
    fetch_movies_with_streams as _fetch_movies_with_streams,
)

search_bp = Blueprint('search', __name__)
fetch_logger = logging.getLogger('mediadash.search')
api_logger = logging.getLogger('mediadash.search.api')

# ============================================================
# CALCULATIONS (imported from calculations.py)
# ============================================================

from calculations import (
    RESOLUTION_LABELS, _compute_dominant_resolution, build_season_size_list,
)

# ============================================================
# DATA EXTRACTION
# ============================================================

# EXTRACT MOVIE METADATA FROM PLEX MOVIE OBJECT
def extract_movie_data(movie):
    # PLEX STORES FIRST MEDIA AND PART AS PRIMARY
    media = movie.media[0] if movie.media else None
    part = media.parts[0] if media and media.parts else None

    # COLLECT SUBTITLE METADATA FROM PART STREAMS (TYPE 3 = SUBTITLE, EMBEDDED OR EXTERNAL)
    subtitles = []
    if part:
        try:
            for stream in getattr(part, 'streams', []):
                if getattr(stream, 'streamType', 0) != 3:
                    continue
                lang = (
                    getattr(stream, 'language', None) or
                    getattr(stream, 'languageTag', None) or
                    getattr(stream, 'languageCode', None) or
                    'Unknown'
                )
                subtitles.append({
                    'language': lang,
                    'codec': getattr(stream, 'codec', ''),
                    'forced': bool(getattr(stream, 'forced', False)),
                    'external': bool(getattr(stream, 'key', None)),
                })
        except Exception as e:
            fetch_logger.warning("Failed to extract subtitles for '%s': %s", movie.title, e)

    file_size = None
    if part:
        file_size = getattr(part, 'size', None)

    return {
        'title': movie.title or 'Unknown',
        'year': movie.year,
        'rating': round(movie.rating, 1) if movie.rating else None,
        'audienceRating': round(movie.audienceRating, 1) if movie.audienceRating else None,
        'duration': movie.duration or 0,
        'durationFormatted': format_duration_short(movie.duration),
        'resolution': getattr(media, 'videoResolution', None) if media else None,
        'addedAt': movie.addedAt.isoformat() if movie.addedAt else None,
        'addedAtFormatted': format_date(movie.addedAt),
        'fileSize': file_size or 0,
        'fileSizeFormatted': format_bytes(file_size),
        'genres': [g.tag for g in movie.genres] if movie.genres else [],
        'studio': movie.studio,
        'contentRating': movie.contentRating,
        'summary': movie.summary or '',
        'videoCodec': getattr(media, 'videoCodec', None) if media else None,
        'audioCodec': getattr(media, 'audioCodec', None) if media else None,
        'bitrate': getattr(media, 'bitrate', None) if media else None,
        'bitrateFormatted': f"{media.bitrate} kbps" if media and getattr(media, 'bitrate', None) else None,
        'container': getattr(media, 'container', None) if media else None,
        'audioChannels': getattr(media, 'audioChannels', None) if media else None,
        'audioChannelsFormatted': format_channels(getattr(media, 'audioChannels', None) if media else None),
        'filePath': getattr(part, 'file', None) if part else None,
        'subtitles': subtitles,
        'subtitleCount': len(subtitles),
        'subtitleLanguages': ', '.join(s['language'] for s in subtitles) if subtitles else 'None',
        'isWatched': bool(movie.viewCount) if movie.viewCount else False,
        'watchStatus': 'Watched' if movie.viewCount else 'Unwatched',
        'playCount': movie.viewCount or 0,
        'lastPlayedAt': movie.lastViewedAt.isoformat() if movie.lastViewedAt else None,
        'lastPlayedAtFormatted': format_date(movie.lastViewedAt),
    }


# TMDB STATUS INTEGRATION — MAPS TMDB API STATUS TO DISPLAY LABELS
_TMDB_STATUS_MAP = {
    'returning series': 'Returning',
    'in production':    'Returning',
    'planned':          'Returning',
    'pilot':            'Returning',
    'continuing':       'Airing',
    'ended':            'Finished',
    'canceled':         'Canceled',
    'cancelled':        'Canceled',
}
_tmdb_status_cache = {}          # tmdb_id -> {'status': str, 'ts': float}
_TMDB_STATUS_CACHE_TTL = 86400   # 24 hours — show status rarely changes

def _fetch_show_status(show):
    tmdb_api_key = _shared.TMDB_API_KEY
    if not tmdb_api_key:
        return 'Unknown'
    # PARSE TMDB ID FROM PLEX SHOW GUIDS (EG. "tmdb://12345")
    tmdb_id = None
    for guid in getattr(show, 'guids', []):
        gid = getattr(guid, 'id', '')
        if gid.startswith('tmdb://'):
            tmdb_id = gid[7:]
            break
    if not tmdb_id:
        return 'Unknown'
    # RETURN CACHED STATUS IF STILL FRESH
    now = time.time()
    cached = _tmdb_status_cache.get(tmdb_id)
    if cached and (now - cached['ts']) < _TMDB_STATUS_CACHE_TTL:
        return cached['status']
    # FETCH FROM TMDB API
    try:
        resp = requests.get(
            f'https://api.themoviedb.org/3/tv/{tmdb_id}',
            params={'api_key': tmdb_api_key, 'language': 'en-US'},
            timeout=5,
        )
        if resp.status_code == 200:
            raw = resp.json().get('status', '')
            status = _TMDB_STATUS_MAP.get(raw.strip().lower(), 'Unknown')
        else:
            fetch_logger.debug("TMDB returned %s for tmdb_id=%s", resp.status_code, tmdb_id)
            status = 'Unknown'
    except Exception as exc:
        fetch_logger.debug("TMDB lookup failed for %r: %s", getattr(show, 'title', '?'), exc)
        status = 'Unknown'
    _tmdb_status_cache[tmdb_id] = {'status': status, 'ts': now}
    return status


# EXTRACT SHOW METADATA FROM PLEX SHOW OBJECT
def extract_show_data(show):
    total_episodes = getattr(show, 'leafCount', 0) or 0
    watched_episodes = getattr(show, 'viewedLeafCount', 0) or 0

    # CALCULATE WATCH STATUS FROM EPISODE COUNTS
    if total_episodes > 0 and watched_episodes >= total_episodes:
        watch_status = 'Watched'
    elif watched_episodes > 0:
        watch_status = 'In Progress'
    else:
        watch_status = 'Unwatched'

    progress_pct = round((watched_episodes / total_episodes) * 100, 1) if total_episodes > 0 else 0

    return {
        'title': show.title or 'Unknown',
        'year': show.year,
        'ratingKey': show.ratingKey,
        'rating': round(show.rating, 1) if show.rating else None,
        'audienceRating': round(show.audienceRating, 1) if show.audienceRating else None,
        'duration': getattr(show, 'duration', 0) or 0,
        'durationFormatted': format_duration_short(getattr(show, 'duration', None)),
        'seasons': getattr(show, 'childCount', 0) or 0,
        'episodes': total_episodes,
        'watchedEpisodes': watched_episodes,
        'unwatchedEpisodes': total_episodes - watched_episodes,
        'watchProgress': f'{progress_pct:.0f}%',
        'watchProgressPercent': progress_pct,
        'watchStatus': watch_status,
        'genres': [g.tag for g in show.genres] if show.genres else [],
        'studio': show.studio,
        'contentRating': show.contentRating,
        'summary': show.summary or '',
        'addedAt': show.addedAt.isoformat() if show.addedAt else None,
        'addedAtFormatted': format_date(show.addedAt),
        'lastPlayedAt': show.lastViewedAt.isoformat() if show.lastViewedAt else None,
        'lastPlayedAtFormatted': format_date(show.lastViewedAt),
        'filePath': show.locations[0] if getattr(show, 'locations', None) else None,
        # EPISODE AGGREGATION — FILLED BY BACKGROUND ENRICHMENT
        'totalSize': 0,
        'totalSizeFormatted': None,
        'totalDuration': 0,
        'totalDurationFormatted': None,
        'seasonSizes': [],
        'dominantResolution': None,
        'dominantResolutionRank': -1,
        'showStatus': _fetch_show_status(show),
        'subtitleLanguages': None,
        'subtitleCount': 0,
    }


# MAP LIBRARY TYPE TO EXTRACTION FUNCTION
EXTRACTORS = {
    'movie': extract_movie_data,
    'show': extract_show_data,
}


# ============================================================
# COLUMN DEFINITIONS (imported from customizable_columns.py)
# ============================================================

from customizable_columns import COLUMN_DEFINITIONS


# ============================================================
# EPISODE METADATA AGGREGATION
# ============================================================

# FETCH ALL EPISODES IN ONE API CALL AND AGGREGATE BY SHOW AND SEASON
def fetch_episode_metadata(section):
    fetch_logger.info("Fetching all episode metadata...")
    ep_start = time.time()
    meta = {}

    try:
        url = f'/library/sections/{section.key}/all?type=4&includeElements=Stream'
        episodes = section.fetchItems(url)
        for ep in episodes:
            show_key = getattr(ep, 'grandparentRatingKey', None)
            season_title = getattr(ep, 'parentTitle', None) or f"Season {getattr(ep, 'parentIndex', '?')}"

            if not show_key:
                continue

            ep_size = 0
            try:
                if ep.media and ep.media[0].parts:
                    ep_size = getattr(ep.media[0].parts[0], 'size', 0) or 0
            except (IndexError, AttributeError):
                pass

            ep_duration = getattr(ep, 'duration', 0) or 0

            ep_resolution = None
            try:
                if ep.media:
                    ep_resolution = getattr(ep.media[0], 'videoResolution', None)
            except (IndexError, AttributeError):
                pass

            if show_key not in meta:
                meta[show_key] = {'total_size': 0, 'total_duration': 0, 'seasons': {}, 'resolutions': {}, 'subtitle_langs': set()}

            # COLLECT SUBTITLE LANGUAGES FROM EPISODE STREAMS (TYPE 3 = SUBTITLE)
            try:
                if ep.media and ep.media[0].parts:
                    for stream in getattr(ep.media[0].parts[0], 'streams', []):
                        if getattr(stream, 'streamType', 0) == 3:
                            lang = (
                                getattr(stream, 'language', None) or
                                getattr(stream, 'languageTag', None) or
                                getattr(stream, 'languageCode', None) or
                                'Unknown'
                            )
                            meta[show_key]['subtitle_langs'].add(lang)
            except Exception:
                pass

            meta[show_key]['total_size'] += ep_size
            meta[show_key]['total_duration'] += ep_duration

            if ep_resolution:
                res_key = str(ep_resolution).lower()
                meta[show_key]['resolutions'][res_key] = meta[show_key]['resolutions'].get(res_key, 0) + 1

            if season_title not in meta[show_key]['seasons']:
                meta[show_key]['seasons'][season_title] = {'size': 0, 'count': 0, 'duration': 0, 'resolutions': {}}
            meta[show_key]['seasons'][season_title]['size'] += ep_size
            meta[show_key]['seasons'][season_title]['count'] += 1
            meta[show_key]['seasons'][season_title]['duration'] += ep_duration
            if ep_resolution:
                res_key = str(ep_resolution).lower()
                meta[show_key]['seasons'][season_title]['resolutions'][res_key] = \
                    meta[show_key]['seasons'][season_title]['resolutions'].get(res_key, 0) + 1

        # COMPUTE DOMINANT RESOLUTION PER SHOW: PLURALITY, TIE-BREAK BY HIGHER RANK
        for show_data in meta.values():
            label, rank = _compute_dominant_resolution(show_data.get('resolutions', {}))
            show_data['dominant_resolution'] = label
            show_data['dominant_resolution_rank'] = rank

        ep_elapsed = time.time() - ep_start
        fetch_logger.info(f"Fetched episode metadata for {len(meta)} shows in {ep_elapsed:.1f}s")
    except Exception as e:
        fetch_logger.error(f"Failed to fetch episode metadata: {e}")

    return meta


# MERGE EPISODE METADATA INTO SHOW ITEMS LIST IN-PLACE
def _merge_episode_meta(items, episode_meta, progress_fn=None):
    total = len(items)
    for i, item in enumerate(items):
        show_meta = episode_meta.get(item['ratingKey'])
        if show_meta:
            item['totalSize'] = show_meta['total_size']
            item['totalSizeFormatted'] = format_bytes(show_meta['total_size'])
            item['totalDuration'] = show_meta['total_duration']
            item['totalDurationFormatted'] = format_duration_short(show_meta['total_duration'])
            item['dominantResolution'] = show_meta.get('dominant_resolution')
            item['dominantResolutionRank'] = show_meta.get('dominant_resolution_rank', -1)
            item['seasonSizes'] = build_season_size_list(show_meta['seasons'])
            sub_langs = sorted(show_meta.get('subtitle_langs', set()))
            item['subtitleLanguages'] = ', '.join(sub_langs) if sub_langs else None
            item['subtitleCount'] = len(sub_langs)
        if progress_fn and ((i + 1) % 10 == 0 or i + 1 == total):
            progress_fn(i + 1, total)

# ============================================================
# BACKGROUND WORKERS
# ============================================================

INITIAL_BATCH_SIZE = 100


# BACKGROUND: FETCH EPISODE METADATA AND MERGE INTO CACHED SHOWS
def _episode_enrichment_worker(cache_key, library_title, plex_url, plex_token):
    try:
        bg_plex = PlexServer(plex_url, plex_token, timeout=120)
        section = bg_plex.library.section(library_title)
        enrichment.update_progress(cache_key, 0, 0, 'Fetching episode data from Plex…')
        episode_meta = fetch_episode_metadata(section)
        cached = cache.get(cache_key) or cache.get_stale(cache_key)
        if cached:
            items = list(cached['items'])  # SHALLOW COPY TO AVOID MUTATION DURING ITERATION
            total = len(items)
            enrichment.update_progress(cache_key, 0, total, f'Fetching {total:,} shows from Plex…')

            def _on_progress(current, t):
                enrichment.update_progress(
                    cache_key, current, t,
                    f'Computing sizes & season data… ({current:,}/{t:,} shows)'
                )

            _merge_episode_meta(items, episode_meta, progress_fn=_on_progress)
            cache.set(cache_key, items, cached['type'])
            fetch_logger.info(f"Episode enrichment complete for '{library_title}': merged into {total} shows")
    except Exception as e:
        fetch_logger.error(f"Episode enrichment worker failed for '{library_title}': {e}")


# BACKGROUND: FETCH ALL MOVIES FOR A LIBRARY (PROGRESSIVE MODE COMPLETION)
def _full_fetch_worker(cache_key, library_title, library_type, plex_url, plex_token):
    try:
        bg_plex = PlexServer(plex_url, plex_token, timeout=120)
        section = bg_plex.library.section(library_title)
        extractor = EXTRACTORS.get(library_type)
        if not extractor:
            return
        enrichment.update_progress(cache_key, 0, 0, 'Fetching from Plex…')
        items = []
        errors = 0
        raw_items = _fetch_movies_with_streams(section) if library_type == 'movie' else section.all()
        total = len(raw_items)
        for i, item in enumerate(raw_items):
            try:
                items.append(extractor(item))
            except Exception as e:
                errors += 1
                fetch_logger.error(f"Failed to extract '{getattr(item, 'title', '?')}': {e}")
            if (i + 1) % 100 == 0 or i + 1 == total:
                enrichment.update_progress(cache_key, i + 1, total, f'Processing {total:,} {library_type}s…')
        cache.set(cache_key, items, library_type)
        fetch_logger.info(f"Full fetch complete for '{library_title}': {len(items)} items ({errors} errors)")
    except Exception as e:
        fetch_logger.error(f"Full fetch worker failed for '{library_title}': {e}")

# ============================================================
# FETCH WITH CACHE
# ============================================================

# APPLY SEARCH SORT AND PAGINATION SERVER-SIDE
def apply_table_operations(data, search=None, sort_by=None, sort_dir='asc', page=1, per_page=25):
    if search:
        search_lower = search.lower()
        filtered = []
        for item in data:
            for value in item.values():
                if isinstance(value, str) and search_lower in value.lower():
                    filtered.append(item)
                    break
                elif isinstance(value, list) and any(search_lower in str(v).lower() for v in value):
                    filtered.append(item)
                    break
                elif isinstance(value, (int, float)) and search_lower in str(value):
                    filtered.append(item)
                    break
        data = filtered

    total = len(data)

    if sort_by and data:
        reverse = sort_dir.lower() == 'desc'
        try:
            data = sorted(data, key=lambda x: sort_key_fn(x.get(sort_by)), reverse=reverse)
        except Exception as e:
            api_logger.warning(f"Sort failed on '{sort_by}': {e}")

    start = (page - 1) * per_page
    end = start + per_page
    total_pages = max(1, (total + per_page - 1) // per_page)

    return {
        'items': data[start:end],
        'total': total,
        'page': page,
        'perPage': per_page,
        'totalPages': total_pages,
    }


# APPLY SHORT DURATION STRINGS TO DISPLAY ITEMS WITHOUT MUTATING CACHE
# Cache may contain older long-form duration strings; non-Summary pages should stay compact.
def _short_duration_display_items(items):
    display_items = []
    for item in items:
        display_item = dict(item)
        if 'duration' in display_item:
            display_item['durationFormatted'] = format_duration_short(display_item.get('duration'))
        if 'totalDuration' in display_item:
            display_item['totalDurationFormatted'] = format_duration_short(display_item.get('totalDuration'))
        if display_item.get('seasonSizes'):
            display_item['seasonSizes'] = [
                {
                    **season,
                    'durationFormatted': format_duration_short(season.get('duration')),
                }
                for season in display_item.get('seasonSizes', [])
            ]
        display_items.append(display_item)
    return display_items


# FETCH LIBRARY ITEMS FROM PLEX OR RETURN CACHED COPY
# CACHE KEYS ARE PREFIXED WITH "search:" TO AVOID COLLISION WITH NAMING DATA
def fetch_library_items(plex, title, library_type, progressive=False, silent=True):
    cache_key = f'search:{title}'
    # TRY FRESH CACHE FIRST, THEN FALL BACK TO STALE DATA WITH BACKGROUND REFRESH
    cached = cache.get(cache_key) or cache.get_stale(cache_key)
    if cached is not None:
        # Cached data is display-ready local data. Do not contact Plex or start
        # background enrichment during navigation; Sync is the explicit refresh path.
        enriched = True
        is_stale = cached.get('is_stale', False)
        fetch_logger.info(
            f"Returning {len(cached['items'])} cached search items for '{title}' "
            f"(stale={is_stale}, user-sync required for Plex refresh)"
        )
        return _short_duration_display_items(cached['items']), cached['type'], enriched

    fetch_logger.info(f"Fetching search library '{title}' (type={library_type}, progressive={progressive})")
    start = time.time()

    section = plex.library.section(title)
    extractor = EXTRACTORS.get(library_type)
    if not extractor:
        return [], library_type, True

    episode_meta = None
    enriched = True

    if library_type == 'movie' and progressive:
        raw_items = _fetch_movies_with_streams(section, maxresults=INITIAL_BATCH_SIZE)
        enriched = False
    elif library_type == 'show' and progressive:
        raw_items = section.all()
        enriched = False  # EPISODE METADATA FETCHED IN BACKGROUND
    elif library_type == 'show':
        # PARALLEL FETCH: SHOW LIST + EPISODE METADATA
        with ThreadPoolExecutor(max_workers=2) as pool:
            future_items = pool.submit(section.all)
            future_meta = pool.submit(fetch_episode_metadata, section)
            raw_items = future_items.result()
            episode_meta = future_meta.result()
    else:
        raw_items = _fetch_movies_with_streams(section)

    items = []
    errors = 0
    for item in raw_items:
        try:
            items.append(extractor(item))
        except Exception as e:
            errors += 1
            fetch_logger.error(f"Failed to extract '{getattr(item, 'title', '?')}': {e}")

    if library_type == 'show' and episode_meta:
        _merge_episode_meta(items, episode_meta)

    elapsed = time.time() - start
    fetch_logger.info(f"Fetched {len(items)} search items for '{title}' in {elapsed:.1f}s ({errors} errors)")

    cache.set(cache_key, items, library_type)

    if not enriched:
        if library_type == 'movie':
            enrichment.start(cache_key, _full_fetch_worker,
                (cache_key, title, library_type, PLEX_URL, PLEX_TOKEN), priority=PRIO_BROWSE_MOVIE, silent=silent)
        else:
            enrichment.start(cache_key, _episode_enrichment_worker,
                (cache_key, title, PLEX_URL, PLEX_TOKEN), priority=PRIO_EPISODE, silent=silent)

    return items, library_type, enriched

# ============================================================
# BLUEPRINT ROUTES
# ============================================================

# LIST ALL SUPPORTED PLEX LIBRARIES
@search_bp.route('/libraries')
def get_libraries():
    libs = _libraries_from_cache(EXTRACTORS)
    if libs:
        return jsonify({'libraries': libs})

    # COLD PATH: NO CACHE YET — CONNECT TO PLEX
    try:
        def _fetch(plex):
            libraries = _libraries_from_plex(plex, EXTRACTORS, logger=api_logger)
            api_logger.info(f'Found {len(libraries)} supported libraries')
            return jsonify({'libraries': libraries})

        return with_plex_retry(_fetch)

    except Unauthorized:
        return jsonify({'error': 'Authentication failed. Check your PLEX_TOKEN.'}), 401
    except Exception as e:
        api_logger.error(f'Failed to fetch libraries: {e}')
        return jsonify({'error': f'Failed to connect to Plex: {e}'}), 500


# FETCH LIBRARY ITEMS WITH OPTIONAL SERVER-SIDE OPERATIONS
@search_bp.route('/library/<path:title>')
def get_library(title):
    cache_key = f'search:{title}'
    fetch_all = request.args.get('all', '').lower() == 'true'
    user_sync = request.args.get('sync') == '1'

    # FAST PATH: SERVE DIRECTLY FROM CACHE — NO PLEX CONNECTION REQUIRED
    if not user_sync:
        cached = cache.get_stale(cache_key)
        if cached is not None and cached.get('type') in EXTRACTORS:
            lib_type = cached['type']
            items = _short_duration_display_items(cached['items'])

            # Cached data is display-ready. Never start background enrichment during
            # navigation; Sync is the explicit refresh path.
            enriched = True
            cache_age = round(time.time() - cached['ts'])

            if fetch_all:
                return jsonify({
                    'items': items, 'total': len(items), 'page': 1,
                    'perPage': len(items), 'totalPages': 1,
                    'libraryType': lib_type, 'libraryTitle': title,
                    'enriched': enriched, 'enrichmentRunning': False, 'cacheAge': cache_age,
                })

            search = request.args.get('search', '').strip()
            sort_by = request.args.get('sort', None)
            sort_dir = request.args.get('dir', 'asc')
            try:
                page = max(1, int(request.args.get('page', 1)))
            except (ValueError, TypeError):
                page = 1
            try:
                per_page = min(100, max(10, int(request.args.get('per_page', 25))))
            except (ValueError, TypeError):
                per_page = 25

            result = apply_table_operations(items, search, sort_by, sort_dir, page, per_page)
            result['libraryType'] = lib_type
            result['libraryTitle'] = title
            result['enriched'] = enriched
            result['enrichmentRunning'] = False
            result['cacheAge'] = cache_age
            return jsonify(result)

        # TRULY COLD — NO DATA AND NO SYNC REQUESTED. Tell the client whether a
        # startup/sync worker is already running so it knows whether to poll.
        return jsonify({
            'items': [], 'total': 0, 'page': 1, 'perPage': 0, 'totalPages': 1,
            'libraryType': None, 'libraryTitle': title,
            'enriched': False, 'enrichmentRunning': enrichment.is_running(cache_key), 'cacheAge': None,
        })

    # COLD/SYNC PATH: connect to Plex (cache empty or user-triggered resync)
    try:
        def _fetch(plex):
            try:
                section = plex.library.section(title)
            except NotFound:
                return jsonify({'error': f"Library '{title}' not found"}), 404

            if section.type not in EXTRACTORS:
                return jsonify({'error': f"Library type '{section.type}' is not supported"}), 400

            fetch_all = request.args.get('all', '').lower() == 'true'
            user_sync = request.args.get('sync') == '1'

            # CACHE_REFRESH PRE-STARTS A BG TASK FOR RESYNCS — RETURN EMPTY SO ENRICHMENT POLLING DELIVERS DATA
            cache_key = f'search:{title}'
            if user_sync and enrichment.is_running(cache_key) and not (cache.get(cache_key) or cache.get_stale(cache_key)):
                lib_type = section.type
                return jsonify({
                    'items': [], 'total': 0, 'page': 1, 'perPage': 0, 'totalPages': 1,
                    'libraryType': lib_type, 'libraryTitle': title,
                    'enriched': False, 'enrichmentRunning': True, 'cacheAge': None,
                })

            items, lib_type, enriched = fetch_library_items(plex, title, section.type, progressive=fetch_all, silent=not user_sync)

            # GET CACHE AGE FOR THIS LIBRARY
            _search_entry = cache.get(f'search:{title}') or cache.get_stale(f'search:{title}')
            cache_age = round(time.time() - _search_entry['ts']) if _search_entry else None
            enrichment_running = enrichment.is_running(cache_key)

            if fetch_all:
                return jsonify({
                    'items': items,
                    'total': len(items),
                    'page': 1,
                    'perPage': len(items),
                    'totalPages': 1,
                    'libraryType': lib_type,
                    'libraryTitle': title,
                    'enriched': enriched,
                    'enrichmentRunning': enrichment_running,
                    'cacheAge': cache_age,
                })

            search = request.args.get('search', '').strip()
            sort_by = request.args.get('sort', None)
            sort_dir = request.args.get('dir', 'asc')

            try:
                page = max(1, int(request.args.get('page', 1)))
            except (ValueError, TypeError):
                page = 1
            try:
                per_page = min(100, max(10, int(request.args.get('per_page', 25))))
            except (ValueError, TypeError):
                per_page = 25

            result = apply_table_operations(items, search, sort_by, sort_dir, page, per_page)
            result['libraryType'] = lib_type
            result['libraryTitle'] = title
            result['enriched'] = enriched
            result['enrichmentRunning'] = enrichment_running
            result['cacheAge'] = cache_age
            return jsonify(result)

        return with_plex_retry(_fetch)

    except Unauthorized:
        return jsonify({'error': 'Authentication failed'}), 401
    except Exception as e:
        api_logger.error(f"Error fetching search library '{title}': {e}")
        return jsonify({'error': str(e)}), 500


# CHECK BACKGROUND ENRICHMENT STATUS AND RETURN ENRICHED DATA WHEN COMPLETE
@search_bp.route('/library/<path:title>/enrichment')
def get_enrichment_status(title):
    cache_key = f'search:{title}'
    status = enrichment.get_status(cache_key)
    progress = enrichment.get_progress(cache_key)

    if status == 'complete':
        cached = cache.get(cache_key)
        if cached:
            cache_age = round(time.time() - cached['ts'])
            return jsonify({
                'status': 'complete',
                'items': _short_duration_display_items(cached['items']),
                'total': len(cached['items']),
                'cacheAge': cache_age,
            })
        return jsonify({'status': 'complete', 'items': [], 'total': 0})

    resp = {'status': status}
    if progress:
        resp['progress'] = progress
    return jsonify(resp)


# RETURN COLUMN DEFINITIONS FOR A LIBRARY TYPE
@search_bp.route('/columns/<library_type>')
def get_columns(library_type):
    columns = COLUMN_DEFINITIONS.get(library_type)
    if not columns:
        return jsonify({'error': f"Unknown library type '{library_type}'"}), 404
    return jsonify({'columns': columns, 'libraryType': library_type})
