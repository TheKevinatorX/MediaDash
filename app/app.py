############################
# FLASK APP AND API ROUTES #
############################

import os
import time

from flask import Flask, jsonify, render_template, request, redirect, send_from_directory

import shared as _shared
from shared import (
    logger,
    cache,
    enrichment,
    get_plex,
    reset_plex,
    validate_environment,
    save_user_settings,
    get_user_settings,
    APP_START_TIME,
    PLEX_URL,
    PLEX_TOKEN,
    MOVIE_LABEL,
    SHOW_LABEL,
    format_bytes,
    format_duration,
    PRIO_BROWSE_MOVIE,
    PRIO_BROWSE_SHOW,
    PRIO_NAMING,
    PRIO_EPISODE,
)

# ============================================================
# APP FACTORY
# ============================================================

# VALIDATE REQUIRED ENV VARS AT STARTUP — EXITS IF MISSING
validate_environment()

app = Flask(__name__)


@app.context_processor
def inject_static_asset_version():
    """Expose file mtimes for cache-busting static assets in templates."""
    def static_asset_version(filename):
        try:
            return int(os.path.getmtime(os.path.join(app.static_folder, filename)))
        except OSError:
            return int(APP_START_TIME)

    return {'static_asset_version': static_asset_version}


@app.route('/favicon.ico')
def favicon():
    """Serve the favicon from the root path for browsers that request it directly."""
    return send_from_directory(
        app.static_folder,
        'favicon.ico',
        mimetype='image/vnd.microsoft.icon',
        max_age=0,
    )


# REGISTER BLUEPRINTS AFTER APP CREATION TO AVOID CIRCULAR IMPORTS
from search import search_bp  # noqa: E402
from naming import naming_bp  # noqa: E402
from size import size_bp  # noqa: E402

app.register_blueprint(search_bp, url_prefix='/search')
app.register_blueprint(naming_bp, url_prefix='/naming')
app.register_blueprint(size_bp, url_prefix='/size')

# LOAD DISK CACHE ONLY — REFRESHING FROM PLEX IS USER-TRIGGERED VIA SYNC
from shared import startup_prewarm  # noqa: E402
startup_prewarm(cache, enrichment)


def _startup_auto_warm():
    """Start background workers for any stale cache entries at container startup.
    Runs in a daemon thread so it doesn't block Flask from serving requests."""
    from threading import Thread

    def _run():
        import time as _t
        _t.sleep(2)  # Brief pause so Flask finishes initializing first

        if not _shared.PLEX_URL or not _shared.PLEX_TOKEN:
            logger.info('Startup auto-warm skipped: Plex not configured')
            return

        now = _t.time()
        started = []

        # BUILD LIBRARY → TYPE MAP FROM BROWSE CACHE (AVOIDS A PLEX API CALL)
        search_entries = cache.entries_by_prefix('search:')
        lib_type_map = {k[len('search:'):]: v.get('type', 'movie') for k, v in search_entries.items()}

        # REFRESH STALE BROWSE CACHES — MOVIES ONLY.
        # Show library caches may contain enriched seasonSizes data; overwriting them with a
        # fresh-but-unenriched fetch would break the Season tab until episode enrichment
        # re-runs. The Size page handles show enrichment on demand via _get_search_items.
        for key, entry in search_entries.items():
            library_title = key[len('search:'):]
            lib_type = entry.get('type', 'movie')
            if lib_type != 'movie':
                continue  # SKIP SHOW LIBRARIES — PRESERVE EXISTING SEASON DATA
            if not _shared.is_library_selected(library_title):
                continue
            age = now - entry.get('ts', 0)
            if age < _shared.CACHE_TTL:
                continue  # still fresh
            if enrichment.is_running(key):
                continue
            enrichment.start(key, _warm_search_worker, (key, library_title, lib_type),
                             priority=PRIO_BROWSE_MOVIE, silent=False)
            started.append(key)

        # REFRESH STALE OR MISSING NAMING CACHES
        for library_title, lib_type in lib_type_map.items():
            if not _shared.is_library_selected(library_title):
                continue
            naming_key = f'naming:{library_title}'
            naming_entry = cache.get_stale(naming_key)
            if naming_entry:
                age = now - naming_entry.get('ts', 0)
                if age < _shared.CACHE_TTL:
                    continue  # still fresh
            if enrichment.is_running(naming_key):
                continue
            from naming import _naming_full_fetch_worker
            enrichment.start(naming_key, _naming_full_fetch_worker,
                             (naming_key, library_title, lib_type, _shared.PLEX_URL, _shared.PLEX_TOKEN),
                             priority=PRIO_NAMING, silent=False)
            started.append(naming_key)

        if started:
            logger.info(f'Startup auto-warm: queued background refresh for {started}')
        else:
            logger.info('Startup auto-warm: all caches fresh, no background refresh needed')

    Thread(target=_run, daemon=True, name='startup-auto-warm').start()


_startup_auto_warm()

# ============================================================
# HOME SUMMARY HELPERS
# ============================================================

# AGGREGATE MOVIE STATS FROM A PLEX MOVIE SECTION
def _summarize_movies(section):
    movies = section.all()
    total_size = 0
    total_duration = 0
    for m in movies:
        try:
            for media in m.media:
                for part in media.parts:
                    total_size += part.size or 0
        except Exception:
            pass
        total_duration += m.duration or 0
    return {
        'count': len(movies),
        'totalSize': total_size,
        'totalSizeFormatted': format_bytes(total_size),
        'totalDuration': total_duration,
        'totalDurationFormatted': format_duration(total_duration),
    }


# AGGREGATE SHOW/SEASON/EPISODE STATS FROM A PLEX SHOW SECTION
def _summarize_shows(section):
    shows = section.all()
    episodes = section.searchEpisodes()

    total_size = 0
    total_duration = 0
    for ep in episodes:
        try:
            for media in ep.media:
                for part in media.parts:
                    total_size += part.size or 0
        except Exception:
            pass
        total_duration += ep.duration or 0

    season_count = 0
    for show in shows:
        try:
            season_count += sum(1 for s in show.seasons() if s.seasonNumber > 0)
        except Exception:
            pass

    return {
        'showCount': len(shows),
        'seasonCount': season_count,
        'episodeCount': len(episodes),
        'totalSize': total_size,
        'totalSizeFormatted': format_bytes(total_size),
        'totalDuration': total_duration,
        'totalDurationFormatted': format_duration(total_duration),
    }


# CHECK NAMING CACHE FOR HEALTH STATS — SERVES STALE DATA WHEN FRESH ENTRY IS UNAVAILABLE
def _compute_naming_health(library_title):
    key = f'naming:{library_title}'
    entry = cache.get_stale(key)  # one atomic read; returns fresh or stale, None only if absent
    if not entry:
        return None
    items = entry.get('items', [])
    if not items:
        return None

    total = len(items)
    issues = sum(
        1 for item in items
        if item.get('overallStatus') == 'mismatch'
    )
    ok = total - issues
    return {
        'total': total,
        'ok': ok,
        'issues': issues,
        'percent': round(ok / total * 100) if total else 100,
    }


# ============================================================
# HOME SUMMARY ROUTE
# ============================================================

# COMPUTE LIBRARY STATS FROM BROWSE CACHE ITEMS — NO PLEX CALL
def _summarize_from_cache(library_title, library_type):
    key = f'search:{library_title}'
    # GET FRESH OR STALE — STALE DISK-LOADED ENTRIES PAST TTL STILL USABLE FOR HOME SUMMARY
    entry = cache.get(key) or cache.get_stale(key)
    if not entry:
        return None
    items = entry.get('items', [])
    if not items:
        return None
    cache_age = round(time.time() - entry['ts'])

    if library_type == 'movie':
        count = len(items)
        total_size = sum(item.get('fileSize') or 0 for item in items)
        total_duration = sum(item.get('duration') or 0 for item in items)
        return {
            'count': count,
            'totalSize': total_size,
            'totalSizeFormatted': format_bytes(total_size),
            'totalDuration': total_duration,
            'totalDurationFormatted': format_duration(total_duration),
            'cacheAge': cache_age,
        }
    else:
        show_count = len(items)
        season_count = sum(item.get('seasons') or 0 for item in items)
        episode_count = sum(item.get('episodes') or 0 for item in items)
        total_size = sum(item.get('totalSize') or 0 for item in items)
        total_duration = sum(item.get('totalDuration') or 0 for item in items)
        return {
            'showCount': show_count,
            'seasonCount': season_count,
            'episodeCount': episode_count,
            'totalSize': total_size,
            'totalSizeFormatted': format_bytes(total_size),
            'totalDuration': total_duration,
            'totalDurationFormatted': format_duration(total_duration),
            'cacheAge': cache_age,
        }


# INITIAL TOTALS BUCKET FOR HOME SUMMARY ROUTES
def _empty_totals():
    return {
        'movieCount': 0, 'showCount': 0, 'seasonCount': 0, 'episodeCount': 0,
        'totalSize': 0, 'totalSizeFormatted': None,
        'totalMovieDuration': 0, 'totalMovieDurationFormatted': None,
        'totalEpisodeDuration': 0, 'totalEpisodeDurationFormatted': None,
    }


# ACCUMULATE PER-LIBRARY STATS INTO THE RUNNING TOTALS
def _accumulate_totals(totals, lib_type, stats):
    if lib_type == 'movie':
        totals['movieCount'] += stats.get('count', 0)
        totals['totalSize'] += stats.get('totalSize', 0)
        totals['totalMovieDuration'] += stats.get('totalDuration', 0)
    else:
        totals['showCount'] += stats.get('showCount', 0)
        totals['seasonCount'] += stats.get('seasonCount', 0)
        totals['episodeCount'] += stats.get('episodeCount', 0)
        totals['totalSize'] += stats.get('totalSize', 0)
        totals['totalEpisodeDuration'] += stats.get('totalDuration', 0)


# FORMAT IN-PLACE THE SIZE/DURATION FIELDS OF A TOTALS DICT
def _finalize_totals(totals):
    totals['totalSizeFormatted'] = format_bytes(totals['totalSize'])
    totals['totalMovieDurationFormatted'] = format_duration(totals['totalMovieDuration'])
    totals['totalEpisodeDurationFormatted'] = format_duration(totals['totalEpisodeDuration'])


# BUILD SUMMARY FROM ALL WARM BROWSE CACHE ENTRIES (PLEX OFFLINE FALLBACK)
def _build_summary_from_search_cache():
    search_entries = cache.entries_by_prefix('search:')
    if not search_entries:
        return None

    totals = _empty_totals()
    libraries = []
    for key, entry in search_entries.items():
        library_title = key[len('search:'):]
        lib_type = entry.get('type', '')
        if not _shared.is_library_selected(library_title):
            continue
        stats = _summarize_from_cache(library_title, lib_type)
        if not stats:
            continue
        lib_entry = {'title': library_title, 'type': lib_type, **stats}
        lib_entry['namingHealth'] = _compute_naming_health(library_title)
        libraries.append(lib_entry)
        _accumulate_totals(totals, lib_type, stats)
    if not libraries:
        return None
    _finalize_totals(totals)
    return {'totals': totals, 'libraries': libraries, 'labels': {'movie': MOVIE_LABEL, 'show': SHOW_LABEL}}


# BACKGROUND WORKER: FETCH BROWSE LIBRARY (PROGRESSIVE OR FULL) — KEEPS HOME COLD-PATH AND /API/WARM IN SYNC
def _make_search_worker(progressive, label):
    def _worker(cache_key, library_title, library_type):
        try:
            from plexapi.server import PlexServer as _PlexServer
            from search import fetch_library_items
            bg_plex = _PlexServer(_shared.PLEX_URL, _shared.PLEX_TOKEN, timeout=120)
            fetch_library_items(bg_plex, library_title, library_type, progressive=progressive)
            logger.info(f"{label} complete for '{library_title}'")
        except Exception as e:
            logger.error(f"{label} failed for '{library_title}': {e}")
    return _worker


_search_fetch_worker = _make_search_worker(progressive=True, label='Background search fetch')
_warm_search_worker = _make_search_worker(progressive=False, label='Warm search')


# START NAMING WORKER IF NOT ALREADY RUNNING — USED BY HOME SUMMARY ROUTES
def _ensure_naming_worker(library_title, library_type):
    naming_key = f'naming:{library_title}'
    if enrichment.is_running(naming_key):
        return
    from naming import _naming_full_fetch_worker
    enrichment.start(
        naming_key,
        _naming_full_fetch_worker,
        (naming_key, library_title, library_type, PLEX_URL, PLEX_TOKEN),
        priority=PRIO_NAMING,
        silent=False,
    )


@app.route('/api/home/summary')
def home_summary():
    # RETURN CACHED SUMMARY IF FRESH
    cached = cache.get('__home_summary__')
    if cached:
        summary = cached['items'][0]
        return jsonify({'summary': summary, 'cached': True})

    # FAST PATH: BUILD FROM WARM BROWSE CACHE — NO PLEX WORK DURING NAVIGATION
    search_summary = _build_summary_from_search_cache()
    if search_summary:
        return jsonify({'summary': search_summary, 'cached': False, 'stale': True})

    # COLD PATH: NO BROWSE CACHE AT ALL — NEED PLEX TO BOOTSTRAP
    try:
        plex = get_plex()
        sections = plex.library.sections()
    except Exception as e:
        return jsonify({'error': f'Cannot connect to Plex: {e}'}), 503

    libraries = []
    totals = _empty_totals()

    for section in sections:
        lib_type = section.type
        if lib_type not in ('movie', 'show'):
            continue
        if not _shared.is_library_selected(section.title):
            continue

        lib_entry = {'title': section.title, 'type': lib_type}

        try:
            # FAST PATH: BUILD STATS FROM BROWSE CACHE (NO PLEX API CALL)
            stats = _summarize_from_cache(section.title, lib_type)

            if stats is None:
                # COLD CACHE: FALL BACK TO PLEX API (FIRST-EVER LOAD ONLY)
                logger.info(f"Search cache cold for '{section.title}', falling back to Plex API")
                if lib_type == 'movie':
                    stats = _summarize_movies(section)
                else:
                    stats = _summarize_shows(section)
                # KICK OFF BACKGROUND BROWSE FETCH SO NEXT LOAD IS INSTANT
                search_key = f'search:{section.title}'
                if not enrichment.is_running(search_key):
                    p = PRIO_BROWSE_MOVIE if lib_type == 'movie' else PRIO_BROWSE_SHOW
                    enrichment.start(
                        search_key,
                        _search_fetch_worker,
                        (search_key, section.title, lib_type),
                        priority=p,
                        silent=False,
                    )

            lib_entry.update(stats)
            _accumulate_totals(totals, lib_type, stats)

            if lib_type == 'show':
                # WARM CACHE BUT UNENRICHED — START EPISODE ENRICHMENT SO SIZE/DURATION POPULATE ON NEXT REFRESH
                if stats.get('totalSize', 0) == 0 and stats.get('episodeCount', 0) > 0:
                    search_key = f'search:{section.title}'
                    if not enrichment.is_running(search_key) and not enrichment.is_complete(search_key):
                        logger.info(f"Show cache unenriched for '{section.title}', starting episode enrichment")
                        from search import _episode_enrichment_worker
                        enrichment.start(
                            search_key,
                            _episode_enrichment_worker,
                            (search_key, section.title, PLEX_URL, PLEX_TOKEN),
                            priority=PRIO_EPISODE,
                            silent=True,
                        )

            lib_entry['namingHealth'] = _compute_naming_health(section.title)

            # START NAMING WORKER FOR ABSENT OR STALE NAMING CACHE
            naming_raw = cache.get_stale(f'naming:{section.title}')
            naming_stale = naming_raw and naming_raw.get('is_stale', False)
            if lib_entry['namingHealth'] is None or naming_stale:
                _ensure_naming_worker(section.title, lib_type)

        except Exception as e:
            logger.error(f'Failed to summarize library {section.title!r}: {e}')
            lib_entry['error'] = str(e)

        libraries.append(lib_entry)

    _finalize_totals(totals)

    summary = {'totals': totals, 'libraries': libraries, 'labels': {'movie': MOVIE_LABEL, 'show': SHOW_LABEL}}
    all_naming_warm = all(lib.get('namingHealth') is not None for lib in libraries if not lib.get('error'))
    all_shows_enriched = all(
        lib.get('totalSize', 0) > 0 or lib.get('type') == 'movie'
        for lib in libraries if not lib.get('error')
    )
    if all_naming_warm and all_shows_enriched:
        cache.set('__home_summary__', [summary], 'summary')
    return jsonify({'summary': summary, 'cached': False})


# ============================================================
# QUICK SUMMARY ROUTE — RETURNS IMMEDIATELY FROM CACHE
# ============================================================

def _build_quicksummary_lib_entry(library_title, lib_type):
    """Build a single library entry for the quicksummary response.

    Returns (lib_entry, stats) where stats is None when the cache miss
    triggered a background fetch (lib_entry['loading'] will be True).
    """
    search_key = f'search:{library_title}'
    lib_entry = {'title': library_title, 'type': lib_type}
    stats = _summarize_from_cache(library_title, lib_type)
    if stats is not None:
        lib_entry.update(stats)
        lib_entry['loading'] = False
    else:
        lib_entry['loading'] = True
        if not enrichment.is_running(search_key):
            p = PRIO_BROWSE_MOVIE if lib_type == 'movie' else PRIO_BROWSE_SHOW
            enrichment.start(search_key, _search_fetch_worker,
                             (search_key, library_title, lib_type),
                             priority=p, silent=False)
    lib_entry['namingHealth'] = _compute_naming_health(library_title)
    return (lib_entry, stats)


@app.route('/api/home/quicksummary')
def home_quicksummary():
    libraries = []
    totals = _empty_totals()

    # FAST PATH: BUILD FROM SEARCH CACHE — NO PLEX API CALL
    search_entries = cache.entries_by_prefix('search:')
    if search_entries:
        for key, entry in search_entries.items():
            library_title = key[len('search:'):]
            lib_type = entry.get('type', 'movie')
            if not _shared.is_library_selected(library_title):
                continue
            lib_entry, stats = _build_quicksummary_lib_entry(library_title, lib_type)
            if stats is not None:
                _accumulate_totals(totals, lib_type, stats)
            libraries.append(lib_entry)
        _finalize_totals(totals)
        summary = {'totals': totals, 'libraries': libraries,
                   'labels': {'movie': MOVIE_LABEL, 'show': SHOW_LABEL}}
        return jsonify({'summary': summary, 'cached': False})

    # COLD PATH: SEARCH CACHE EMPTY — NEED PLEX FOR LIBRARY LIST ONLY
    try:
        plex = get_plex()
        sections = [s for s in plex.library.sections() if s.type in ('movie', 'show')]
    except Exception as e:
        return jsonify({'error': f'Cannot connect to Plex: {e}'}), 503

    for section in sections:
        lib_type = section.type
        library_title = section.title
        if not _shared.is_library_selected(library_title):
            continue
        lib_entry, stats = _build_quicksummary_lib_entry(library_title, lib_type)
        if stats is not None:
            _accumulate_totals(totals, lib_type, stats)
        libraries.append(lib_entry)

    _finalize_totals(totals)
    summary = {'totals': totals, 'libraries': libraries,
               'labels': {'movie': MOVIE_LABEL, 'show': SHOW_LABEL}}
    return jsonify({'summary': summary, 'cached': False})


# ============================================================
# HOME STATS ROUTE
# ============================================================

@app.route('/api/home/stats')
def home_stats():
    search_entries = cache.entries_by_prefix('search:')
    if not search_entries:
        return jsonify({'stats': None, 'cached': False})

    containers = {}
    codecs = {}
    resolutions = {}
    decades = {}
    genres = {}
    subtitles_with = 0
    subtitles_without = 0
    subtitle_langs = {}
    audio_channels = {}
    show_statuses = {}
    show_studios = {}
    show_content_ratings = {}
    any_found = False

    LABEL_TO_KEY = {'4K': '4k', '1080p': '1080', '720p': '720', '480p': '480', 'SD': 'sd'}

    # SMALL HELPER: INCREMENT BUCKET COUNT IF VALUE NON-EMPTY
    def _bump(d, key):
        if key:
            d[key] = d.get(key, 0) + 1

    for key, entry in search_entries.items():
        library_title = key[len('search:'):]
        if not _shared.is_library_selected(library_title):
            continue
        items = entry.get('items', [])
        lib_type = entry.get('type', '')
        any_found = True

        for item in items:
            if lib_type == 'movie':
                _bump(containers, item.get('container'))
                _bump(codecs, item.get('videoCodec'))
                res = item.get('resolution')
                res_key = str(res).lower() if res else None
            else:
                dom = item.get('dominantResolution')
                res_key = LABEL_TO_KEY.get(dom, dom.lower() if dom else None)
            _bump(resolutions, res_key)

            year = item.get('year')
            if year:
                try:
                    _bump(decades, f"{(int(year) // 10) * 10}s")
                except (ValueError, TypeError):
                    pass

            for g in item.get('genres', []) or []:
                _bump(genres, g)

            # SUBTITLE COVERAGE — BOTH LIBRARY TYPES
            if (item.get('subtitleCount') or 0) > 0:
                subtitles_with += 1
                if lib_type == 'movie':
                    for s in item.get('subtitles', []) or []:
                        if isinstance(s, dict):
                            _bump(subtitle_langs, s.get('language'))
                else:
                    raw_langs = item.get('subtitleLanguages') or ''
                    for lang in (l.strip() for l in raw_langs.split(',') if l.strip()):
                        _bump(subtitle_langs, lang)
            else:
                subtitles_without += 1

            if lib_type == 'movie':
                # AUDIO CHANNELS — MOVIES ONLY
                ch = item.get('audioChannels')
                if ch is not None:
                    ch_label = {2: '2.0', 6: '5.1', 8: '7.1'}.get(int(ch), f'{ch}ch')
                    _bump(audio_channels, ch_label)
            else:
                # SHOW STATUS / STUDIOS / CONTENT RATINGS — SHOWS ONLY
                _bump(show_statuses, item.get('showStatus'))
                _bump(show_studios, item.get('studio'))
                _bump(show_content_ratings, item.get('contentRating'))

    if not any_found:
        return jsonify({'stats': None, 'cached': False})

    top_genres = dict(sorted(genres.items(), key=lambda x: x[1], reverse=True)[:10])
    stats = {
        'containers': containers,
        'codecs': codecs,
        'resolutions': resolutions,
        'decades': decades,
        'genres': top_genres,
        'subtitles': {
            'with': subtitles_with,
            'without': subtitles_without,
            'total': subtitles_with + subtitles_without,
            'langs': dict(sorted(subtitle_langs.items(), key=lambda x: x[1], reverse=True)[:8]),
        },
        'audioChannels': audio_channels,
        'showStatuses': dict(sorted(show_statuses.items(), key=lambda x: x[1], reverse=True)),
        'showStudios': dict(sorted(show_studios.items(), key=lambda x: x[1], reverse=True)[:4]),
        'showContentRatings': dict(sorted(show_content_ratings.items(), key=lambda x: x[1], reverse=True)),
    }
    return jsonify({'stats': stats, 'cached': True})


# ============================================================
# SHARED CACHE REFRESH
# ============================================================

@app.route('/api/progress')
def get_progress():
    tasks = enrichment.get_all_active()
    return jsonify({'tasks': tasks, 'active': len(tasks) > 0})


@app.route('/api/cache/refresh', methods=['POST'])
def cache_refresh():
    data = request.get_json(silent=True) or {}
    library = data.get('library')

    if library:
        search_key = f'search:{library}'
        naming_key = f'naming:{library}'

        # CAPTURE LIB_TYPE BEFORE INVALIDATING SO BG TASKS CAN START IMMEDIATELY
        search_entry = cache.get(search_key) or cache.get_stale(search_key)
        lib_type = search_entry.get('type') if search_entry else None

        cache.invalidate(search_key)
        cache.invalidate(naming_key)
        enrichment.reset(search_key)
        enrichment.reset(naming_key)

        # PRE-START NON-SILENT BG TASKS SO PROGRESS HUB AND MOVIE BROWSE APPEAR IMMEDIATELY
        if lib_type == 'movie':
            from search import _full_fetch_worker
            enrichment.start(search_key, _full_fetch_worker,
                (search_key, library, lib_type, PLEX_URL, PLEX_TOKEN),
                priority=PRIO_BROWSE_MOVIE, silent=False)
        if lib_type:
            from naming import _naming_full_fetch_worker
            enrichment.start(naming_key, _naming_full_fetch_worker,
                (naming_key, library, lib_type, PLEX_URL, PLEX_TOKEN),
                priority=PRIO_NAMING, silent=False)

        logger.info(f'Cache refreshed for library: {library!r}')
        return jsonify({'status': 'ok', 'invalidated': [search_key, naming_key]})
    else:
        cache.invalidate()
        cache.invalidate('__home_summary__')
        enrichment.reset()
        logger.info('All caches invalidated')
        return jsonify({'status': 'ok', 'invalidated': 'all'})


@app.route('/api/warm', methods=['POST'])
def warm_all():
    data = request.get_json(silent=True) or {}
    silent = data.get('silent', True)

    started = []
    try:
        plex = get_plex()
        sections = [s for s in plex.library.sections() if s.type in ('movie', 'show')]
    except Exception as e:
        return jsonify({'error': f'Cannot connect to Plex: {e}'}), 503

    for section in sections:
        lib_type = section.type
        title = section.title
        if not _shared.is_library_selected(title):
            continue

        search_key = f'search:{title}'
        if not cache.get(search_key) and not enrichment.is_running(search_key):
            p = PRIO_BROWSE_MOVIE if lib_type == 'movie' else PRIO_BROWSE_SHOW
            enrichment.start(search_key, _warm_search_worker, (search_key, title, lib_type), priority=p, silent=silent)
            started.append(f'search:{title}')

        naming_key = f'naming:{title}'
        if not cache.get(naming_key) and not enrichment.is_running(naming_key):
            from naming import _naming_full_fetch_worker
            enrichment.start(naming_key, _naming_full_fetch_worker,
                (naming_key, title, lib_type, PLEX_URL, PLEX_TOKEN), priority=PRIO_NAMING, silent=silent)
            started.append(f'naming:{title}')

    logger.info(f'Warm-all started: {started}')
    return jsonify({'status': 'ok', 'started': started})


# ============================================================
# HEALTH CHECK
# ============================================================

@app.route('/api/health')
def health():
    uptime = round(time.time() - APP_START_TIME)
    try:
        plex = get_plex()
        plex_ok = True
        plex_name = plex.friendlyName
        plex_version = plex.version
    except Exception as e:
        plex_ok = False
        plex_name = None
        plex_version = None

    return jsonify({
        'status': 'ok' if plex_ok else 'degraded',
        'uptime_seconds': uptime,
        'episode_format': _shared.EPISODE_FORMAT,
        'plex': {
            'connected': plex_ok,
            'name': plex_name,
            'version': plex_version,
        },
        'cache': cache.stats(),
    })


# ============================================================
# VERSION
# ============================================================

@app.route('/api/version')
def version():
    try:
        version_file = os.path.join(app.root_path, 'VERSION')
        with open(version_file, 'r', encoding='utf-8') as f:
            ver = f.read().strip()
    except Exception:
        ver = 'unknown'
    return jsonify({'version': ver})


_version_check_cache = {'result': None, 'ts': 0}
_VERSION_CHECK_TTL = 3600  # 1 hour


def _parse_semver(v):
    """Return (major, minor, patch) tuple from a version string, ignoring leading 'v'."""
    v = v.lstrip('v').split('-')[0]
    parts = v.split('.')
    try:
        return tuple(int(x) for x in parts[:3])
    except ValueError:
        return (0, 0, 0)


@app.route('/api/version/check')
def version_check():
    github_repo = os.environ.get('GITHUB_REPO', '').strip()
    if not github_repo:
        return jsonify({'status': 'unconfigured'})

    now = time.time()
    if _version_check_cache['result'] and now - _version_check_cache['ts'] < _VERSION_CHECK_TTL:
        return jsonify(_version_check_cache['result'])

    try:
        version_file = os.path.join(app.root_path, 'VERSION')
        with open(version_file, 'r', encoding='utf-8') as f:
            local_ver = f.read().strip()
    except Exception:
        return jsonify({'status': 'error'})

    try:
        import requests as _req
        resp = _req.get(
            f'https://api.github.com/repos/{github_repo}/releases/latest',
            headers={'Accept': 'application/vnd.github+json'},
            timeout=5,
        )
        resp.raise_for_status()
        latest_tag = resp.json().get('tag_name', '').lstrip('v')
        if not latest_tag:
            return jsonify({'status': 'error'})
    except Exception:
        return jsonify({'status': 'error'})

    is_current = _parse_semver(local_ver) >= _parse_semver(latest_tag)
    result = {
        'status': 'current' if is_current else 'outdated',
        'local': local_ver,
        'latest': latest_tag,
    }
    _version_check_cache['result'] = result
    _version_check_cache['ts'] = now
    return jsonify(result)


# ============================================================
# SETTINGS
# ============================================================

@app.route('/api/settings', methods=['GET'])
def get_settings():
    return jsonify(get_user_settings())


@app.route('/api/settings', methods=['POST'])
def update_settings():
    data = request.get_json(silent=True) or {}
    plex_url = (data.get('plex_url') or '').strip()
    plex_token = (data.get('plex_token') or '').strip()
    test_only = bool(data.get('test_only', False))

    # NAMING RULE FIELDS (OPTIONAL — ONLY VALIDATED/SAVED WHEN PRESENT)
    episode_format = data.get('episode_format')
    season_dir_zero_pad = data.get('season_dir_zero_pad')
    year_tolerance = data.get('year_tolerance')
    special_char_replacement = data.get('special_char_replacement')
    selected_libraries = data.get('selected_libraries')
    excluded_shows = data.get('excluded_shows')
    tmdb_api_key = data.get('tmdb_api_key')

    if selected_libraries is not None and not isinstance(selected_libraries, list):
        return jsonify({'error': 'selected_libraries must be a list'}), 400
    if isinstance(selected_libraries, list) and len(selected_libraries) == 0:
        return jsonify({'error': 'selected_libraries must contain at least one library'}), 400
    if excluded_shows is not None and not isinstance(excluded_shows, list):
        return jsonify({'error': 'excluded_shows must be a list'}), 400

    if not plex_url:
        return jsonify({'error': 'Plex URL is required'}), 400
    if not plex_url.startswith(('http://', 'https://')):
        return jsonify({'error': 'Plex URL must start with http:// or https://'}), 400
    if episode_format is not None and episode_format not in ('NxEE', 'SxxExx'):
        return jsonify({'error': 'episode_format must be NxEE or SxxExx'}), 400
    if year_tolerance is not None:
        try:
            year_tolerance = max(0, min(2, int(year_tolerance)))
        except (ValueError, TypeError):
            return jsonify({'error': 'year_tolerance must be 0, 1, or 2'}), 400

    effective_token = plex_token if plex_token else _shared.PLEX_TOKEN

    if not effective_token:
        return jsonify({'error': 'Plex token is required'}), 400

    try:
        from plexapi.server import PlexServer as _PlexServer
        from plexapi.exceptions import Unauthorized as _Unauthorized
        import requests as _requests
        test_plex = _PlexServer(plex_url.rstrip('/'), effective_token, timeout=15)
        plex_name = test_plex.friendlyName
        plex_version = test_plex.version
    except _Unauthorized:
        return jsonify({'error': 'Your Plex token was not accepted. Double-check that you copied it correctly and try again.'}), 400
    except (_requests.exceptions.ConnectionError, OSError):
        return jsonify({'error': f'Could not reach a Plex server at that address. Make sure the URL is correct and your Plex server is running.'}), 400
    except (_requests.exceptions.Timeout, TimeoutError):
        return jsonify({'error': f'The Plex server took too long to respond. Check that it is running and reachable, then try again.'}), 400
    except Exception:
        return jsonify({'error': 'Could not connect to Plex. Check your server URL and token, then try again.'}), 400

    if test_only:
        libs = [
            {'title': s.title, 'type': s.type}
            for s in test_plex.library.sections()
            if s.type in ('movie', 'show')
        ]
        return jsonify({'status': 'ok', 'plex_name': plex_name, 'plex_version': plex_version, 'libraries': libs})

    save_user_settings(
        plex_url=plex_url.rstrip('/'),
        plex_token=plex_token if plex_token else None,
        episode_format=episode_format,
        season_dir_zero_pad=season_dir_zero_pad,
        year_tolerance=year_tolerance,
        special_char_replacement=special_char_replacement,
        selected_libraries=selected_libraries,
        excluded_shows=excluded_shows,
        tmdb_api_key=tmdb_api_key if tmdb_api_key is not None else None,
    )
    reset_plex()
    return jsonify({'status': 'ok', 'plex_name': plex_name, 'plex_version': plex_version})


# ============================================================
# FRONTEND ENTRY POINT
# ============================================================

@app.route('/setup')
def setup():
    return render_template('setup.html')


@app.route('/')
def index():
    if not _shared.PLEX_URL or not _shared.PLEX_TOKEN:
        return redirect('/setup')
    return render_template('index.html')


# ============================================================
# ENTRYPOINT (DEV ONLY)
# ============================================================

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5010, debug=True)
