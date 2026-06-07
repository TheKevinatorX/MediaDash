########################################
# SHARED UTILITIES AND CONFIGURATION   #
########################################

import glob
import json
import os
import re
import sys
import time
import logging
from datetime import datetime
import queue
from threading import Lock, Thread

import requests.exceptions
from plexapi.server import PlexServer
from plexapi.exceptions import Unauthorized

# ============================================================
# LOGGING SETUP
# ============================================================

# CONFIGURE ROOT LOGGER FROM ENVIRONMENT
def setup_logging():
    log_level = os.environ.get('LOG_LEVEL', 'INFO').upper()
    log_format = '%(asctime)s | %(levelname)-8s | %(name)-20s | %(message)s'
    date_format = '%Y-%m-%d %H:%M:%S'

    logging.basicConfig(
        level=getattr(logging, log_level, logging.INFO),
        format=log_format,
        datefmt=date_format,
        handlers=[logging.StreamHandler(sys.stdout)],
    )

    # SILENCE NOISY THIRD PARTY LOGGERS
    logging.getLogger('urllib3').setLevel(logging.WARNING)
    logging.getLogger('plexapi').setLevel(logging.WARNING)

    return logging.getLogger('mediadash')


logger = setup_logging()

# ============================================================
# CONFIGURATION
# ============================================================

# STRIP TRAILING SLASH FROM URL
PLEX_URL = os.environ.get('PLEX_URL', '').rstrip('/')
PLEX_TOKEN = os.environ.get('PLEX_TOKEN', '')
try:
    CACHE_TTL = int(os.environ.get('CACHE_TTL', '900'))
except (ValueError, TypeError):
    logger.warning(f"Invalid CACHE_TTL value '{os.environ.get('CACHE_TTL')}', falling back to 900")
    CACHE_TTL = 900

EPISODE_FORMAT = os.environ.get('EPISODE_FORMAT', 'NxEE').strip()
if EPISODE_FORMAT not in ('NxEE', 'SxxExx'):
    logger.warning(f"Invalid EPISODE_FORMAT '{EPISODE_FORMAT}', falling back to NxEE")
    EPISODE_FORMAT = 'NxEE'

# SEASON DIR ZERO-PADDING: "Season 01" vs "Season 1"
SEASON_DIR_ZERO_PAD = os.environ.get('SEASON_DIR_ZERO_PAD', '0').strip() == '1'

# YEAR TOLERANCE: how many years off a title year can be and still count as a match (0 or 1)
try:
    YEAR_TOLERANCE = max(0, min(2, int(os.environ.get('YEAR_TOLERANCE', '1'))))
except (ValueError, TypeError):
    YEAR_TOLERANCE = 1

# SPECIAL CHARACTER REPLACEMENT: what illegal chars [:<>"/\\|?*] are replaced with in titles
SPECIAL_CHAR_REPLACEMENT = os.environ.get('SPECIAL_CHAR_REPLACEMENT', ' - ')

SELECTED_LIBRARIES = []

def is_library_selected(title):
    return not SELECTED_LIBRARIES or title in SELECTED_LIBRARIES

# COMMA-SEPARATED SHOW TITLES TO ALWAYS EXCLUDE FROM NAMING RESULTS
_excluded_raw = os.environ.get('EXCLUDED_SHOWS', '')
EXCLUDED_SHOWS = {s.strip().lower() for s in _excluded_raw.split(',') if s.strip()}

TMDB_API_KEY = os.environ.get('TMDB_API_KEY', '')

MOVIE_LABEL = os.environ.get('MOVIE_LABEL', 'Movies').strip() or 'Movies'
SHOW_LABEL  = os.environ.get('SHOW_LABEL',  'Shows').strip()  or 'Shows'

CACHE_DIR = os.environ.get('CACHE_DIR', '/data/cache')
DISK_CACHE_PATH = os.path.join(CACHE_DIR, 'plex_cache.json')
SETTINGS_FILE = os.path.join(CACHE_DIR, 'settings.json')

APP_START_TIME = time.time()


# ============================================================
# USER SETTINGS (overrides env vars, persisted to SETTINGS_FILE)
# ============================================================

def _load_settings_file():
    try:
        if os.path.exists(SETTINGS_FILE):
            with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception:
        pass
    return {}


def save_user_settings(plex_url=None, plex_token=None, episode_format=None,
                       season_dir_zero_pad=None, year_tolerance=None,
                       special_char_replacement=None, selected_libraries=None,
                       excluded_shows=None, tmdb_api_key=None):
    global PLEX_URL, PLEX_TOKEN, EPISODE_FORMAT, SEASON_DIR_ZERO_PAD, YEAR_TOLERANCE, SPECIAL_CHAR_REPLACEMENT, SELECTED_LIBRARIES, EXCLUDED_SHOWS, TMDB_API_KEY
    current = _load_settings_file()
    if plex_url is not None:
        current['plex_url'] = plex_url.rstrip('/')
        PLEX_URL = current['plex_url']
    if plex_token is not None and plex_token:
        current['plex_token'] = plex_token
        PLEX_TOKEN = current['plex_token']
    if episode_format is not None and episode_format in ('NxEE', 'SxxExx'):
        current['episode_format'] = episode_format
        EPISODE_FORMAT = episode_format
    if season_dir_zero_pad is not None:
        current['season_dir_zero_pad'] = bool(season_dir_zero_pad)
        SEASON_DIR_ZERO_PAD = bool(season_dir_zero_pad)
    if year_tolerance is not None:
        current['year_tolerance'] = max(0, min(2, int(year_tolerance)))
        YEAR_TOLERANCE = current['year_tolerance']
    if special_char_replacement is not None:
        current['special_char_replacement'] = str(special_char_replacement)
        SPECIAL_CHAR_REPLACEMENT = current['special_char_replacement']
    if selected_libraries is not None:
        current['selected_libraries'] = [str(t) for t in selected_libraries]
        SELECTED_LIBRARIES = current['selected_libraries']
    if excluded_shows is not None:
        originals = sorted({s.strip() for s in excluded_shows if s.strip()}, key=str.lower)
        current['excluded_shows'] = originals
        EXCLUDED_SHOWS = {s.lower() for s in originals}
    if tmdb_api_key is not None:
        current['tmdb_api_key'] = tmdb_api_key
        TMDB_API_KEY = tmdb_api_key
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(SETTINGS_FILE, 'w', encoding='utf-8') as f:
            json.dump(current, f, indent=2)
        return True
    except Exception as e:
        logger.error(f'Failed to save user settings: {e}')
        return False


def get_user_settings():
    s = _load_settings_file()
    url = s.get('plex_url') or os.environ.get('PLEX_URL', '')
    token = s.get('plex_token') or os.environ.get('PLEX_TOKEN', '')
    hint = (token[:4] + '••••' + token[-2:]) if len(token) > 6 else ('••••' if token else '')
    return {
        'plex_url': url.rstrip('/'),
        'plex_token_hint': hint,
        'source': 'file' if (s.get('plex_url') or s.get('plex_token')) else 'env',
        'episode_format': EPISODE_FORMAT,
        'season_dir_zero_pad': SEASON_DIR_ZERO_PAD,
        'year_tolerance': YEAR_TOLERANCE,
        'special_char_replacement': SPECIAL_CHAR_REPLACEMENT,
        'selected_libraries': SELECTED_LIBRARIES,
        'excluded_shows': s.get('excluded_shows', sorted(EXCLUDED_SHOWS)),
        'tmdb_api_key_hint': (TMDB_API_KEY[:4] + '••••' + TMDB_API_KEY[-2:]) if len(TMDB_API_KEY) > 6 else ('••••' if TMDB_API_KEY else ''),
    }


# APPLY SETTINGS FILE OVERRIDES AT MODULE LOAD TIME
_startup_s = _load_settings_file()
if _startup_s.get('plex_url'):
    PLEX_URL = _startup_s['plex_url'].rstrip('/')
if _startup_s.get('plex_token'):
    PLEX_TOKEN = _startup_s['plex_token']
if _startup_s.get('episode_format') in ('NxEE', 'SxxExx'):
    EPISODE_FORMAT = _startup_s['episode_format']
if 'season_dir_zero_pad' in _startup_s:
    SEASON_DIR_ZERO_PAD = bool(_startup_s['season_dir_zero_pad'])
if 'year_tolerance' in _startup_s:
    YEAR_TOLERANCE = max(0, min(2, int(_startup_s['year_tolerance'])))
if 'special_char_replacement' in _startup_s:
    SPECIAL_CHAR_REPLACEMENT = str(_startup_s['special_char_replacement'])
if isinstance(_startup_s.get('selected_libraries'), list):
    SELECTED_LIBRARIES = [str(t) for t in _startup_s['selected_libraries']]
if isinstance(_startup_s.get('excluded_shows'), list):
    EXCLUDED_SHOWS = {s.strip().lower() for s in _startup_s['excluded_shows'] if s.strip()}
if _startup_s.get('tmdb_api_key') is not None:
    TMDB_API_KEY = str(_startup_s['tmdb_api_key'])
del _startup_s

# ============================================================
# STARTUP VALIDATION
# ============================================================

# VERIFY REQUIRED ENVIRONMENT VARIABLES OR EXIT
def validate_environment():
    ok = True
    if not PLEX_URL:
        logger.warning('PLEX_URL not configured — open /setup in your browser to connect your Plex server')
        ok = False
    elif not PLEX_URL.startswith(('http://', 'https://')):
        logger.warning(f'PLEX_URL must start with http:// or https:// (got: {PLEX_URL}) — visit /setup to correct it')
        ok = False

    if not PLEX_TOKEN:
        logger.warning('PLEX_TOKEN not configured — open /setup in your browser to connect your Plex server')
        ok = False

    if not ok:
        logger.info('No Plex credentials found — serving setup wizard at /setup')
        return

    masked_token = PLEX_TOKEN[:4] + '****' if len(PLEX_TOKEN) > 4 else '****'
    logger.info(f'Configuration: PLEX_URL={PLEX_URL}, PLEX_TOKEN={masked_token}, CACHE_TTL={CACHE_TTL}s, EPISODE_FORMAT={EPISODE_FORMAT}')

# ============================================================
# CACHE
# ============================================================

# TTL-BASED IN-MEMORY CACHE WITH THREAD-SAFE LOCKING AND DISK PERSISTENCE
class PlexCache:
    def __init__(self, ttl_seconds=900):
        self.ttl = ttl_seconds
        self._data = {}
        self._lock = Lock()
        self._logger = logging.getLogger('mediadash.cache')

    # RETURN CACHED ENTRY IF FRESH OR NONE IF EXPIRED
    def get(self, key):
        with self._lock:
            entry = self._data.get(key)
            if entry and (time.time() - entry['ts']) < self.ttl:
                self._logger.debug(f"Cache hit for '{key}' (age: {time.time() - entry['ts']:.0f}s)")
                return entry
            if entry:
                self._logger.info(f"Cache expired for '{key}'")
            return None

    # STORE ITEMS WITH CURRENT TIMESTAMP AND PERSIST TO DISK
    def set(self, key, items, library_type):
        with self._lock:
            self._data[key] = {
                'items': items,
                'type': library_type,
                'ts': time.time(),
            }
            self._logger.info(f"Cached {len(items)} items for '{key}'")
        self._save_to_disk()

    # REMOVE ONE CACHE ENTRY OR FLUSH ALL, THEN PERSIST
    def invalidate(self, key=None):
        with self._lock:
            if key:
                self._data.pop(key, None)
                self._logger.info(f"Invalidated cache for '{key}'")
            else:
                self._data.clear()
                self._logger.info('All caches invalidated')
        self._save_to_disk()

    # RETURN CACHED ENTRY EVEN IF EXPIRED — SERVE STALE DATA WHILE BACKGROUND REFRESH RUNS
    # Returns None only when no entry exists at all (true first-run / post-invalidate).
    def get_stale(self, key):
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            age = time.time() - entry['ts']
            return {**entry, 'is_stale': age >= self.ttl, 'age_seconds': round(age)}

    # BUILD CACHE STATS FOR HEALTH ENDPOINT
    def stats(self):
        with self._lock:
            now = time.time()
            return {
                k: {
                    'count': len(v['items']),
                    'age_seconds': round(now - v['ts']),
                    'expires_in': max(0, round(self.ttl - (now - v['ts']))),
                    'library_type': v['type'],
                }
                for k, v in self._data.items()
            }

    # RETURN ALL ENTRIES (FRESH OR STALE) WHOSE KEY STARTS WITH PREFIX — AVOIDS REACHING INTO ._lock/._data
    def entries_by_prefix(self, prefix):
        with self._lock:
            return {k: dict(v) for k, v in self._data.items() if k.startswith(prefix)}

    # MAP A CACHE KEY TO ITS LIBRARY NAME FOR FILE GROUPING
    # 'search:TV Shows' → 'TV Shows', '__home_summary__' → '__home_summary__'
    def _library_name_from_key(self, key):
        if ':' in key:
            return key.split(':', 1)[1]
        return key

    # CONVERT A LIBRARY NAME TO A SAFE CACHE FILENAME
    # 'TV Shows' → '<cache_dir>/tv_shows_cache.json'
    def _cache_file_for_library(self, library_name):
        safe = re.sub(r'[^\w]', '_', library_name.lower()).strip('_')
        safe = re.sub(r'_+', '_', safe)
        return os.path.join(CACHE_DIR, f'{safe}_cache.json')

    # WRITE ONE JSON FILE PER LIBRARY — REMOVES STALE FILES AUTOMATICALLY
    def _save_to_disk(self):
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
            with self._lock:
                data_copy = {
                    k: {'items': v['items'], 'type': v['type'], 'ts': v['ts']}
                    for k, v in self._data.items()
                }

            # GROUP ENTRIES BY LIBRARY NAME
            groups = {}
            for key, entry in data_copy.items():
                lib_name = self._library_name_from_key(key)
                groups.setdefault(lib_name, {})[key] = entry

            # WRITE ONE FILE PER GROUP ATOMICALLY
            written_files = set()
            for lib_name, entries in groups.items():
                path = self._cache_file_for_library(lib_name)
                tmp_path = path + '.tmp'
                with open(tmp_path, 'w', encoding='utf-8') as f:
                    json.dump(entries, f, default=str)
                os.replace(tmp_path, path)
                written_files.add(path)

            # REMOVE ANY CACHE FILES NO LONGER REPRESENTED IN MEMORY
            for path in glob.glob(os.path.join(CACHE_DIR, '*_cache.json')):
                if path not in written_files:
                    try:
                        os.remove(path)
                    except OSError:
                        pass

            self._logger.debug(f"Cache persisted to disk ({len(data_copy)} keys across {len(groups)} files)")
        except Exception as e:
            self._logger.warning(f"Failed to save cache to disk: {e}")

    # LOAD CACHE FROM DISK ON STARTUP — STALE ENTRIES KEPT FOR IMMEDIATE SERVING
    # Reads all *_cache.json files; auto-migrates from legacy plex_cache.json.
    def load_from_disk(self):
        os.makedirs(CACHE_DIR, exist_ok=True)
        cache_files = glob.glob(os.path.join(CACHE_DIR, '*_cache.json'))

        # MIGRATE FROM LEGACY SINGLE-FILE FORMAT IF NO PER-LIBRARY FILES EXIST
        is_migration = False
        if not cache_files and os.path.exists(DISK_CACHE_PATH):
            cache_files = [DISK_CACHE_PATH]
            is_migration = True
            self._logger.info("Migrating legacy plex_cache.json to per-library cache files")

        if not cache_files:
            self._logger.info("No disk cache found, starting fresh")
            return 0

        loaded = 0
        now = time.time()
        with self._lock:
            for path in cache_files:
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    for key, entry in data.items():
                        if not isinstance(entry, dict):
                            continue
                        if 'items' not in entry or 'type' not in entry or 'ts' not in entry:
                            continue
                        self._data[key] = {
                            'items': entry['items'],
                            'type': entry['type'],
                            'ts': float(entry['ts']),
                        }
                        loaded += 1
                except Exception as e:
                    self._logger.warning(f"Failed to load cache file {path}: {e}")

        age_info = {k: round(now - self._data[k]['ts']) for k in self._data}
        self._logger.info(f"Loaded {loaded} cache entries from disk: {age_info}")

        if is_migration and loaded > 0:
            self._save_to_disk()
            try:
                os.remove(DISK_CACHE_PATH)
                self._logger.info("Removed legacy plex_cache.json after migration")
            except OSError:
                pass

        return loaded

# ============================================================
# SYNC PROGRESS (imported from sync_progress.py)
# ============================================================

from sync_progress import (
    BackgroundEnrichment,
    PRIO_BROWSE_MOVIE, PRIO_BROWSE_SHOW, PRIO_NAMING, PRIO_EPISODE,
)

# ============================================================
# SHARED SINGLETONS
# ============================================================

cache = PlexCache(ttl_seconds=CACHE_TTL)
enrichment = BackgroundEnrichment()


# ============================================================
# STARTUP PRE-WARM
# ============================================================

# LOAD DISK CACHE ONLY — PLEX REFRESH IS USER-TRIGGERED VIA SYNC
def startup_prewarm(cache_obj, enrichment_obj):
    _logger = logging.getLogger('mediadash.startup')
    loaded = cache_obj.load_from_disk()
    _logger.info(f"Startup: loaded {loaded} cache entries from disk; automatic Plex prewarm disabled")

# ============================================================
# PLEX CONNECTION
# ============================================================

# SINGLETON PLEX CLIENT WITH LAZY INITIALIZATION
_plex = None
_plex_lock = Lock()


def get_plex():
    global _plex
    with _plex_lock:
        if _plex is None:
            logger.info(f'Connecting to Plex server at {PLEX_URL}...')
            try:
                _plex = PlexServer(PLEX_URL, PLEX_TOKEN, timeout=30)
                logger.info(f'Connected to Plex: {_plex.friendlyName} (v{_plex.version})')
            except Unauthorized:
                logger.error('Authentication failed - check your PLEX_TOKEN')
                raise
            except Exception as e:
                logger.error(f'Failed to connect to Plex at {PLEX_URL}: {e}')
                raise
        return _plex


# FORCE RECONNECT ON NEXT REQUEST
def reset_plex():
    global _plex
    with _plex_lock:
        _plex = None


# RETRY WRAPPER WITH AUTOMATIC RECONNECTION ON TRANSIENT NETWORK ERRORS
def with_plex_retry(fn):
    try:
        return fn(get_plex())
    except (ConnectionError, requests.exceptions.ConnectionError, requests.exceptions.Timeout, OSError):
        logger.warning("Plex connection failed, resetting and retrying...")
        reset_plex()
        return fn(get_plex())

# ============================================================
# FORMATTER HELPERS
# ============================================================

# CONVERT MILLISECONDS TO HUMAN READABLE DURATION
# Used by the Summary page. Keep this long-form output stable.
def format_duration(ms):
    if not ms:
        return None
    total_min = ms // 60000
    if total_min == 0:
        return '0m'
    total_hours = total_min // 60
    remaining_min = total_min % 60
    total_days = total_hours // 24
    remaining_hours = total_hours % 24

    if total_days >= 365:
        years = total_days // 365
        remaining_days = total_days % 365
        months = remaining_days // 30
        days = remaining_days % 30
        parts = [f'{years} {"year" if years == 1 else "years"}']
        if months:
            parts.append(f'{months} {"month" if months == 1 else "months"}')
        if days:
            parts.append(f'{days} {"day" if days == 1 else "days"}')
        return ', '.join(parts)
    elif total_days >= 30:
        months = total_days // 30
        days = total_days % 30
        parts = [f'{months} {"month" if months == 1 else "months"}']
        if days:
            parts.append(f'{days} {"day" if days == 1 else "days"}')
        return ', '.join(parts)
    elif total_days >= 1:
        parts = [f'{total_days} {"day" if total_days == 1 else "days"}', f'{remaining_hours} {"hour" if remaining_hours == 1 else "hours"}']
        if remaining_min:
            parts.append(f'{remaining_min} {"minute" if remaining_min == 1 else "minutes"}')
        return ', '.join(parts)
    else:
        return f'{total_hours} {"hour" if total_hours == 1 else "hours"}, {remaining_min} {"minute" if remaining_min == 1 else "minutes"}' if total_hours else f'{remaining_min} {"minute" if remaining_min == 1 else "minutes"}'


# CONVERT MILLISECONDS TO SHORT DISPLAY DURATION
# Used by table-heavy pages where narrower columns matter.
def format_duration_short(ms):
    if not ms:
        return None

    total_seconds = int(ms // 1000)
    if total_seconds <= 0:
        return '0sec'

    units = (
        ('y', 'yrs', 365 * 24 * 60 * 60),
        ('mo', 'mos', 30 * 24 * 60 * 60),
        ('wk', 'wks', 7 * 24 * 60 * 60),
        ('d', 'd', 24 * 60 * 60),
        ('hr', 'hrs', 60 * 60),
        ('min', 'mins', 60),
        ('sec', 'secs', 1),
    )

    parts = []
    remaining = total_seconds
    for singular, plural, seconds_per_unit in units:
        value = remaining // seconds_per_unit
        if not value:
            continue
        remaining %= seconds_per_unit
        suffix = singular if value == 1 else plural
        parts.append(f'{value}{suffix}')

    return ', '.join(parts) if parts else '0sec'


# CONVERT BYTES TO HUMAN READABLE SIZE
def format_bytes(size):
    if not size:
        return None
    for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
        if abs(size) < 1024:
            return f'{size:.1f} {unit}'
        size /= 1024
    return f'{size:.1f} PB'


# FORMAT DATETIME TO YYYY-MM-DD HH:MM
def format_date(dt):
    if not dt:
        return None
    if isinstance(dt, datetime):
        return dt.strftime('%Y-%m-%d %H:%M')
    return str(dt)


# MAP CHANNEL COUNT TO DISPLAY STRING
def format_channels(ch):
    if not ch:
        return None
    mapping = {2: '2.0 Stereo', 6: '5.1', 8: '7.1'}
    return mapping.get(ch, f'{ch}ch')


# ============================================================
# SHARED LIBRARY LISTING HELPERS
# ============================================================

# BUILD LIBRARY LIST FROM CACHED SEARCH ENTRIES — NO PLEX CALL
# `allowed_types` MAY BE A DICT (e.g. EXTRACTORS) OR A SET/LIST OF TYPE NAMES
def _libraries_from_cache(allowed_types):
    libraries = []
    for key, entry in sorted(cache.entries_by_prefix('search:').items()):
        title = key[len('search:'):]
        lib_type = entry.get('type', '')
        if lib_type in allowed_types and is_library_selected(title):
            libraries.append({
                'key': title,
                'title': title,
                'type': lib_type,
                'count': len(entry.get('items', [])),
            })
    return libraries


# BUILD LIBRARY LIST FROM A LIVE PLEX CONNECTION
def _libraries_from_plex(plex, allowed_types, logger=None):
    libraries = []
    found_any = False
    for section in plex.library.sections():
        if section.type in allowed_types:
            found_any = True
            if is_library_selected(section.title):
                libraries.append({
                    'key': section.key,
                    'title': section.title,
                    'type': section.type,
                    'count': section.totalSize,
                })
                if logger:
                    logger.info(f"Library: {section.title} ({section.type}) - {section.totalSize} items")
    if not found_any and logger:
        logger.warning('No supported libraries found on the Plex server')
    return libraries


# FETCH MOVIE SECTION ITEMS WITH SUBTITLE/AUDIO/VIDEO STREAM METADATA INCLUDED
# (Required for movie subtitle and stream details — Plex omits Stream elements by default.)
def fetch_movies_with_streams(section, maxresults=None):
    url = f'/library/sections/{section.key}/all?includeElements=Stream'
    if maxresults:
        url += f'&X-Plex-Container-Size={maxresults}&X-Plex-Container-Start=0'
    return section.fetchItems(url)


# NORMALIZE VALUES FOR STABLE MIXED-TYPE SORTING
def sort_key_fn(value):
    if value is None:
        return (0, '')
    if isinstance(value, bool):
        return (1, int(value))
    if isinstance(value, (int, float)):
        return (1, value)
    if isinstance(value, list):
        return (1, ', '.join(str(v) for v in value).lower())
    return (1, str(value).lower())
