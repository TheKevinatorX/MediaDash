##################################
# SEARCH — PLEX LIBRARY FETCHER  #
##################################

import re
import time
import logging
import requests

from plexapi.exceptions import Unauthorized

import shared as _shared
from shared import (
    cache, enrichment, with_plex_retry,
    format_bytes, format_duration_short, format_date, format_channels,
    sort_key_fn, _libraries_from_cache, _libraries_from_plex,
)

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


# FETCH RAW PER-EPISODE ROWS FOR ONE SEASON OF ONE SHOW, ON DEMAND (NOT CACHED)
# Mirrors fetch_episode_metadata's per-episode extraction shape but returns
# individual rows instead of rolling them up — used by the Episodes drill-down.
def fetch_episodes_for_season(show, season_name):
    rows = []
    for ep in show.episodes():
        season_title = getattr(ep, 'parentTitle', None) or f"Season {getattr(ep, 'parentIndex', '?')}"
        if season_title != season_name:
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

        rows.append({
            'title': ep.title,
            'index': getattr(ep, 'index', None),
            'seasonName': season_title,
            'size': ep_size,
            'sizeFormatted': format_bytes(ep_size),
            'duration': ep_duration,
            'durationFormatted': format_duration_short(ep_duration),
            'resolution': ep_resolution,
        })

    rows.sort(key=lambda r: r['index'] or 0)
    return rows


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


# RETURN CACHED LIBRARY ITEMS — NO PLEX CONTACT. Sync is the only refresh path.
def fetch_library_items(title, library_type):
    cache_key = f'search:{title}'
    cached = cache.get(cache_key) or cache.get_stale(cache_key)
    if cached is None:
        fetch_logger.info(f"Cold search cache for '{title}' — no sync has run yet")
        return [], library_type, False

    is_stale = cached.get('is_stale', False)
    fetch_logger.info(
        f"Returning {len(cached['items'])} cached search items for '{title}' "
        f"(stale={is_stale}, run Sync to refresh from Plex)"
    )
    return _short_duration_display_items(cached['items']), cached['type'], True

