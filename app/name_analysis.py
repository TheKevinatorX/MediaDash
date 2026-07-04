############################################
# NAME ANALYSIS — NAMING CONVENTION RULES  #
############################################

#
# Pure naming-convention logic: building expected filenames/dirnames from
# Plex metadata, checking actual names against those expectations, and
# extracting per-item naming-status data. No Flask, cache, or Plex I/O here.

import logging
import re
import unicodedata
from pathlib import PurePosixPath

import shared as _shared

logger = logging.getLogger('mediadash.name_analysis')

#======================
# TITLE / NAME BUILDERS
#======================
# Sanitize title for filesystem: remove illegal chars
def sanitize_title(title):
    if not title:
        return ''
    repl = _shared.SPECIAL_CHAR_REPLACEMENT
    title = re.sub(r'[:<>"/\\|?*]', repl, title)
    title = re.sub(r'\s+', ' ', title).strip()
    title = re.sub(r'\s*-\s*$', '', title).strip()
    return title


# Format episode code based on configured format
def format_episode_code(season_num, episode_num):
    if _shared.EPISODE_FORMAT == 'SxxExx':
        return f'S{season_num:02d}E{episode_num:02d}'
    else:
        return f'{season_num}x{episode_num:02d}'


# Build expected movie filename from metadata
def build_expected_movie_name(title, year, ext):
    clean_title = sanitize_title(title)
    if year and not re.search(r'\(\d{4}\)', clean_title):
        return f'{clean_title} ({year}){ext}'
    return f'{clean_title}{ext}'


# Build expected movie directory name from metadata
def build_expected_movie_dir(title, year):
    clean_title = sanitize_title(title)
    if year and not re.search(r'\(\d{4}\)', clean_title):
        return f'{clean_title} ({year})'
    return clean_title


# Build expected episode filename from metadata
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


# Build Expected SHOW Directory NAME
def build_expected_show_dir(title, year):
    clean_title = sanitize_title(title)
    if year and not re.search(r'\(\d{4}\)', clean_title):
        return f'{clean_title} ({year})'
    return clean_title


# Build expected season directory name
def build_expected_season_dir(season_num):
    if _shared.SEASON_DIR_ZERO_PAD:
        return f'Season {season_num:02d}'
    return f'Season {season_num}'


#============
# NAME CHECKS
#============
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


# Extract file extension from path
def get_ext(file_path):
    if not file_path:
        return ''
    return PurePosixPath(file_path).suffix


# Pull the 4-digit year out of a name like "title (2021)", or fall back to default
def _year_from_name(name, default=None):
    m = YEAR_IN_NAME_RE.search(name)
    return int(m.group(1)) if m else default


# Normalize for filename comparison: unicode form + curly quotes -> straight,
# ellipsis -> three dots, strip exclamation marks (metadata often omits/adds them).
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


# Extract the structural prefix of an episode filename: “Show (Year) - SxxExx”
# Episode titles are excluded from comparison because Plex metadata titles often
# differ from the titles embedded in existing filenames (translated names, alt titles,
# custom labels, etc.). The show identity + episode code is sufficient for correctness.
def _episode_structural_prefix(filename):
    stem = PurePosixPath(filename).stem
    m = EPISODE_CODE_RE.search(stem)
    if not m:
        return _normalize_for_compare(stem)
    return _normalize_for_compare(stem[:m.end()])

#================
# DATA EXTRACTION
#================
# Extract movie naming data from PLEX movie object
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

    # Collect subtitle languages from part streams (type 3 = subtitle, requires includeelements=stream)
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
        except Exception as e:
            logger.debug(f"Subtitle stream read failed for '{movie.title}': {e}")

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


# Extract episode naming data from PLEX episode object
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
