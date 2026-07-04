########################################################
# CALCULATIONS — PURE SIZE, DURATION & RESOLUTION MATH #
########################################################

#
# Pure aggregation/projection math for the Sizes page: turning raw
# per-episode totals into per-season and per-series size/duration/
# resolution figures, and projecting cached items into display rows.
# No Flask, cache, or Plex I/O here.

import re

from shared import format_bytes, format_duration_short

#==================
# RESOLUTION LABELS
#==================
# Map PLEX resolution strings to display labels and sort weights
RESOLUTION_LABELS = {
    'sd':   ('SD',    0),
    '480':  ('480p',  1),
    '720':  ('720p',  2),
    '1080': ('1080p', 3),
    '4k':   ('4K',    4),
}


# Compute the dominant resolution from a {resolution_key: count} map
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


# Build the sorted per-season size projection for a show from accumulated season meta
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

SIZE_SORT_KEY = {
    'movie': 'fileSize',
    'show': 'totalSize',
}
