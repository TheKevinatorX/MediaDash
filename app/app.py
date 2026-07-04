############################
# FLASK APP AND API ROUTES #
############################

import os
import re
import subprocess
import time
from urllib.parse import urlencode

from flask import Flask, jsonify, render_template, request, redirect, send_from_directory
from flask_compress import Compress

import shared as _shared
from shared import (
    logger,
    cache,
    enrichment,
    get_plex,
    reset_plex,
    validate_environment,
    save_user_settings,
    get_column_setting,
    save_column_setting,
    get_user_settings,
    APP_START_TIME,
    MOVIE_LABEL,
    SHOW_LABEL,
    format_bytes,
    format_duration,
    PRIO_SYNC,
)

#============
# APP FACTORY
#============
# Validate required env vars at startup — exits if missing
validate_environment()

app = Flask(__name__)

# Compress JSON/text responses — shrinks large naming/size payloads for slow mobile links
Compress(app)


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


# Register blueprints after app creation to avoid circular imports
from naming import naming_bp  # noqa: E402
from size import size_bp  # noqa: E402
from health import health_bp  # noqa: E402

app.register_blueprint(naming_bp, url_prefix='/naming')
app.register_blueprint(size_bp, url_prefix='/size')
app.register_blueprint(health_bp, url_prefix='/filehealth')

# Load disk cache only — refreshing from PLEX is user-triggered via sync
from shared import startup_prewarm  # noqa: E402
startup_prewarm(cache, enrichment)

# Pre-walk media mounts in the background so the health page loads instantly,
# and auto-resume any explicitly-started work that was interrupted by a restart/outage.
from health import resume_incomplete_scans, warm_health_caches  # noqa: E402
from plex_sync import resume_incomplete_syncs  # noqa: E402
warm_health_caches()
resume_incomplete_scans()
resume_incomplete_syncs()

#======================
# HOME SUMMARY BUILDERS
#======================
# Check naming cache for health stats — serves stale data when fresh entry is unavailable
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


#===================
# HOME SUMMARY ROUTE
#===================
# Compute library stats from browse cache items — no PLEX call
def _summarize_from_cache(library_title, library_type):
    key = f'search:{library_title}'
    # Get fresh or stale — stale disk-loaded entries past TTL still usable for home summary
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


# Initial totals bucket for home summary routes
def _empty_totals():
    return {
        'movieCount': 0, 'showCount': 0, 'seasonCount': 0, 'episodeCount': 0,
        'totalSize': 0, 'totalSizeFormatted': None,
        'totalMovieDuration': 0, 'totalMovieDurationFormatted': None,
        'totalEpisodeDuration': 0, 'totalEpisodeDurationFormatted': None,
    }


# Accumulate per-library stats into the running totals
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


# Format in-place the size/duration fields of a totals dict
def _finalize_totals(totals):
    totals['totalSizeFormatted'] = format_bytes(totals['totalSize'])
    totals['totalMovieDurationFormatted'] = format_duration(totals['totalMovieDuration'])
    totals['totalEpisodeDurationFormatted'] = format_duration(totals['totalEpisodeDuration'])


# Build summary from all warm browse cache entries plexx offline fallback)
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


@app.route('/api/home/summary')
def home_summary():
    # Return cached summary if fresh
    cached = cache.get('__home_summary__')
    if cached:
        summary = cached['items'][0]
        return jsonify({'summary': summary, 'cached': True})

    # Fast path: build from warm browse cache — no PLEX work during navigation
    search_summary = _build_summary_from_search_cache()
    if search_summary:
        return jsonify({'summary': search_summary, 'cached': False, 'stale': True})

    # Cold path: no browse cache at all — need PLEX to bootstrap
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
            stats = _summarize_from_cache(section.title, lib_type)
            if stats is None:
                lib_entry['loading'] = True
            else:
                lib_entry.update(stats)
                _accumulate_totals(totals, lib_type, stats)
            lib_entry['namingHealth'] = _compute_naming_health(section.title)
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


#=====================================================
# QUICK SUMMARY ROUTE — RETURNS IMMEDIATELY FROM CACHE
#=====================================================
def _build_quicksummary_lib_entry(library_title, lib_type):
    """Build a single library entry for the quicksummary response.

    Returns (lib_entry, stats) where stats is None when the cache miss
    triggered a background fetch (lib_entry['loading'] will be True).
    """
    lib_entry = {'title': library_title, 'type': lib_type}
    stats = _summarize_from_cache(library_title, lib_type)
    if stats is not None:
        lib_entry.update(stats)
        lib_entry['loading'] = False
    else:
        lib_entry['loading'] = True
    lib_entry['namingHealth'] = _compute_naming_health(library_title)
    return (lib_entry, stats)


@app.route('/api/home/quicksummary')
def home_quicksummary():
    libraries = []
    totals = _empty_totals()

    # Fast path: build from search cache — no PLEX API call
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

    # Cold path: search cache empty — need Plex for library list only
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


#=================
# HOME STATS ROUTE
#=================
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

    # Small helper: increment bucket count if value non-empty
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

            # Subtitle Coverage — BOTH Library Types
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
                # Audio channels — movies only
                ch = item.get('audioChannels')
                if ch is not None:
                    ch_label = {2: '2.0', 6: '5.1', 8: '7.1'}.get(int(ch), f'{ch}ch')
                    _bump(audio_channels, ch_label)
            else:
                # Show status / studios / content ratings — shows only
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


#=====================
# SHARED CACHE REFRESH
#=====================
@app.route('/api/progress')
def get_progress():
    tasks = enrichment.get_all_active()
    return jsonify({'tasks': tasks, 'active': len(tasks) > 0})


@app.route('/api/sync', methods=['POST'])
def trigger_sync():
    from plex_sync import start_full_sync, SYNC_KEY

    try:
        started = start_full_sync()
    except Exception as e:
        logger.error(f"Failed to trigger full sync: {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 503

    if started:
        logger.info('Full Plex sync triggered via /api/sync')
        return jsonify({'status': 'started'})
    status = enrichment.get_status(SYNC_KEY)
    return jsonify({'status': 'already_running' if status in ('pending', 'running') else 'started'})


@app.route('/api/sync/library/<path:title>', methods=['POST'])
def trigger_library_sync(title):
    from plex_sync import start_library_sync, library_sync_key, SYNC_KEY

    if enrichment.is_running(SYNC_KEY):
        return jsonify({'status': 'already_running', 'message': 'Full sync is in progress — try again once it finishes.'}), 409

    try:
        started = start_library_sync(title)
    except Exception as e:
        logger.error(f"Failed to trigger library sync for '{title}': {e}")
        return jsonify({'status': 'error', 'message': str(e)}), 503

    key = library_sync_key(title)
    if started:
        logger.info(f"Quick refresh triggered for library '{title}' via /api/sync/library")
        return jsonify({'status': 'started', 'key': key})
    status = enrichment.get_status(key)
    return jsonify({'status': 'already_running' if status in ('pending', 'running') else 'started', 'key': key})


#=============
# HEALTH CHECK
#=============
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


#========
# VERSION
#========
DEFAULT_GHCR_IMAGE = 'ghcr.io/thekevinatorx/mediadash'


def _read_version_file():
    try:
        version_file = os.path.join(app.root_path, 'VERSION')
        with open(version_file, 'r', encoding='utf-8') as f:
            return f.read().strip() or 'unknown'
    except Exception as e:
        logger.warning(f"Could not read VERSION file: {e}")
        return 'unknown'


def _git_short_sha():
    env_sha = (
        os.environ.get('MEDIADASH_GIT_SHA')
        or os.environ.get('GIT_SHA')
        or os.environ.get('SOURCE_COMMIT')
    )
    if env_sha:
        return env_sha[:12]

    try:
        repo_root = os.path.abspath(os.path.join(app.root_path, '..'))
        out = subprocess.check_output(
            ['git', '-C', repo_root, 'rev-parse', '--short=12', 'HEAD'],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=1,
        ).strip()
        return out or None
    except Exception as e:
        logger.debug(f"Git short SHA lookup failed: {e}")
        return None


def _runtime_version_info():
    base_version = (
        os.environ.get('MEDIADASH_VERSION')
        or os.environ.get('APP_VERSION')
        or _read_version_file()
    ).strip()
    if re.match(r'^v\d+\.\d+\.\d+', base_version):
        base_version = base_version[1:]

    image = (
        os.environ.get('MEDIADASH_IMAGE')
        or os.environ.get('IMAGE_NAME')
        or ''
    ).strip()
    image_tag = (
        os.environ.get('MEDIADASH_IMAGE_TAG')
        or os.environ.get('IMAGE_TAG')
        or ''
    ).strip()
    channel = (
        os.environ.get('MEDIADASH_CHANNEL')
        or os.environ.get('APP_CHANNEL')
        or ''
    ).strip().lower()

    if not image_tag and ':' in image and not image.endswith(':'):
        image_tag = image.rsplit(':', 1)[-1]

    dev_markers = {'dev', 'local', 'development', 'snapshot', 'edge'}
    is_dev = (
        channel in dev_markers
        or image_tag in dev_markers
        or base_version in dev_markers
        or base_version.endswith('-dev')
        or base_version.endswith('-local')
    )

    commit = _git_short_sha()
    display = f'v{base_version}' if base_version and base_version != 'unknown' else 'unknown'
    if is_dev:
        display = 'dev'
        if commit:
            display = f'dev-{commit[:7]}'

    return {
        'version': base_version,
        'display': display,
        'channel': channel or ('dev' if is_dev else 'release'),
        'is_dev': is_dev,
        'image': image or None,
        'image_tag': image_tag or None,
        'commit': commit,
    }


@app.route('/api/version')
def version():
    return jsonify(_runtime_version_info())


_version_check_cache = {'result': None, 'ts': 0}
_VERSION_CHECK_TTL = 3600  # 1 hour


def _parse_semver(v):
    """Return (major, minor, patch) tuple from a version string, ignoring leading 'v'."""
    v = str(v or '').lstrip('v').split('-')[0]
    parts = v.split('.')
    try:
        parsed = tuple(int(x) for x in parts[:3])
        return parsed + (0,) * (3 - len(parsed))
    except ValueError:
        return (0, 0, 0)


def _is_release_tag(tag):
    return bool(re.match(r'^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$', str(tag or '')))


def _latest_semver_tag(tags):
    release_tags = [str(t).lstrip('v') for t in tags if _is_release_tag(t)]
    if not release_tags:
        return None
    return sorted(release_tags, key=_parse_semver)[-1]


def _parse_www_authenticate(header):
    # Bearer realm="...",service="...",scope="..."
    if not header or ' ' not in header:
        return None, {}
    scheme, rest = header.split(' ', 1)
    parts = {}
    for match in re.finditer(r'(\w+)="([^"]*)"', rest):
        parts[match.group(1)] = match.group(2)
    return scheme.lower(), parts


def _fetch_ghcr_latest_tag(image):
    image = (image or DEFAULT_GHCR_IMAGE).strip()
    if image.startswith('ghcr.io/'):
        image = image[len('ghcr.io/'):]
    image = image.strip('/')
    if '/' not in image:
        raise ValueError('GHCR image must include owner and package')

    import requests as _req

    url = f'https://ghcr.io/v2/{image}/tags/list'
    resp = _req.get(url, timeout=6)
    if resp.status_code == 401:
        scheme, params = _parse_www_authenticate(resp.headers.get('WWW-Authenticate', ''))
        if scheme != 'bearer' or not params.get('realm'):
            resp.raise_for_status()
        query = {
            'service': params.get('service') or 'ghcr.io',
            'scope': params.get('scope') or f'repository:{image}:pull',
        }
        realm = params['realm']
        token_resp = _req.get(realm + '?' + urlencode(query), timeout=6)
        token_resp.raise_for_status()
        token = token_resp.json().get('token')
        resp = _req.get(url, headers={'Authorization': f'Bearer {token}'}, timeout=6)

    resp.raise_for_status()
    latest = _latest_semver_tag(resp.json().get('tags') or [])
    if not latest:
        raise ValueError('No semver GHCR tags found')
    return latest


def _fetch_github_latest_release(repo):
    import requests as _req
    resp = _req.get(
        f'https://api.github.com/repos/{repo}/releases/latest',
        headers={'Accept': 'application/vnd.github+json'},
        timeout=6,
    )
    resp.raise_for_status()
    latest_tag = resp.json().get('tag_name', '').lstrip('v')
    if not latest_tag:
        raise ValueError('No release tag found')
    return latest_tag


@app.route('/api/version/check')
def version_check():
    now = time.time()
    if _version_check_cache['result'] and now - _version_check_cache['ts'] < _VERSION_CHECK_TTL:
        return jsonify(_version_check_cache['result'])

    local = _runtime_version_info()
    local_ver = local.get('version') or 'unknown'
    ghcr_image = os.environ.get('GHCR_IMAGE', DEFAULT_GHCR_IMAGE).strip()
    github_repo = os.environ.get('GITHUB_REPO', '').strip()

    latest_tag = None
    source = None
    try:
        latest_tag = _fetch_ghcr_latest_tag(ghcr_image)
        source = 'ghcr'
    except Exception as ghcr_err:
        logger.warning(f"GHCR version check failed for {ghcr_image}: {ghcr_err}")
        if github_repo:
            try:
                latest_tag = _fetch_github_latest_release(github_repo)
                source = 'github'
            except Exception as github_err:
                logger.warning(f"GitHub release check failed for {github_repo}: {github_err}")
                latest_tag = None

    if not latest_tag:
        return jsonify({
            'status': 'error',
            'local': local_ver,
            'runtime': local,
            'message': 'Unable to check GHCR or GitHub releases',
        })

    is_current = _parse_semver(local_ver) >= _parse_semver(latest_tag)
    result = {
        'status': 'current' if is_current else 'outdated',
        'local': local_ver,
        'latest': latest_tag,
        'runtime': local,
        'source': source,
        'is_dev': local.get('is_dev', False),
    }
    _version_check_cache['result'] = result
    _version_check_cache['ts'] = now
    return jsonify(result)


#=========
# SETTINGS
#=========
@app.route('/api/settings', methods=['GET'])
def get_settings():
    return jsonify(get_user_settings())


def _valid_column_setting_key(key):
    return (
        isinstance(key, str)
        and 1 <= len(key) <= 256
        and key.startswith('mediadash_')
        and re.fullmatch(r'[A-Za-z0-9_.:%()\-]+', key) is not None
    )


@app.route('/api/column-settings', methods=['GET'])
def get_column_settings():
    key = request.args.get('key', '')
    if not _valid_column_setting_key(key):
        return jsonify({'error': 'Invalid column setting key'}), 400
    return jsonify({'key': key, 'value': get_column_setting(key)})


@app.route('/api/column-settings', methods=['POST'])
def update_column_settings():
    data = request.get_json(silent=True) or {}
    key = data.get('key')
    value = data.get('value')
    if not _valid_column_setting_key(key):
        return jsonify({'error': 'Invalid column setting key'}), 400
    if not isinstance(value, dict):
        return jsonify({'error': 'value must be an object'}), 400
    if not save_column_setting(key, value):
        return jsonify({'error': 'Failed to save column setting'}), 500
    return jsonify({'status': 'ok'})


@app.route('/api/settings', methods=['POST'])
def update_settings():
    data = request.get_json(silent=True) or {}
    plex_url = (data.get('plex_url') or '').strip()
    plex_token = (data.get('plex_token') or '').strip()
    test_only = bool(data.get('test_only', False))

    # Naming rule fields (optional — only validated/saved when present)
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
    except Exception as e:
        logger.warning(f"Plex connection test failed for {plex_url}: {e}")
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


#=====================
# FRONTEND ENTRY POINT
#=====================
@app.route('/setup')
def setup():
    return render_template('setup.html')


@app.route('/')
def index():
    if not _shared.PLEX_URL or not _shared.PLEX_TOKEN:
        return redirect('/setup')
    return render_template('index.html')


#======================
# ENTRYPOINT (DEV ONLY)
#======================
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5010, debug=True)
