################################################
# CALCULATIONS — PURE SIZE, DURATION & RESOLUTION MATH #
################################################
#
# Pure aggregation/projection math for the Sizes page: turning raw
# per-episode totals into per-season and per-series size/duration/
# resolution figures, and projecting cached items into display rows.
# No Flask, cache, or Plex I/O here.

import re

from shared import format_bytes, format_duration_short

# ============================================================
# RESOLUTION LABELS
# ============================================================

# MAP PLEX RESOLUTION STRINGS TO DISPLAY LABELS AND SORT WEIGHTS
RESOLUTION_LABELS = {
    'sd':   ('SD',    0),
    '480':  ('480p',  1),
    '720':  ('720p',  2),
    '1080': ('1080p', 3),
    '4k':   ('4K',    4),
}


# COMPUTE THE DOMINANT RESOLUTION FROM A {resolution_key: count} MAP
# Plurality wins; ties broken by higher resolution rank. Returns (label, rank).
def _compute_dominant_resolution(resolution_counts):
    if not resolution_counts:
        return None, -1
    dominant_key = max(
        resolution_counts,
        key=lambda r: (resolution_counts[r], RESOLUTION_LABELS.get(r, (r, -1))[1])
    )
    label, rank = RESOLUTION_LABELS.get(dominant_key, (dominant_key.upper(), -1))
    return label, rank


# BUILD THE SORTED PER-SEASON SIZE PROJECTION FOR A SHOW FROM ACCUMULATED SEASON META
# `seasons_meta` is a {season_name: {'size', 'count', 'duration', 'resolutions'}} map.
def build_season_size_list(seasons_meta):
    season_list = []
    for sname, sdata in seasons_meta.items():
        s_dominant_resolution, _ = _compute_dominant_resolution(sdata.get('resolutions', {}))
        season_list.append({
            'name': sname,
            'size': sdata['size'],
            'sizeFormatted': format_bytes(sdata['size']),
            'episodeCount': sdata['count'],
            'duration': sdata['duration'],
            'durationFormatted': format_duration_short(sdata['duration']),
            'dominantResolution': s_dominant_resolution,
        })
    season_list.sort(key=lambda s: (m := re.search(r'\d+', s['name'])) and int(m.group()) or float('inf'))
    return season_list

# ============================================================
# PROJECTIONS — SHAPE CACHED ITEMS INTO DISPLAY ROWS
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
