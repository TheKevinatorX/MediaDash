######################################################
# CUSTOMIZABLE COLUMNS — TABLE COLUMN DEFINITIONS    #
######################################################
#
# Per-library-type column metadata for toggleable/sortable table views
# (key, display label, default visibility, sortability, expand-only flag).
# Pure data — no Flask, cache, or Plex I/O. Pages reference this so column
# sets can be shared/extended without duplicating definitions.

COLUMN_DEFINITIONS = {
    'movie': [
        {'key': 'title',              'label': 'Title',           'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'year',               'label': 'Year',            'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'rating',             'label': 'Critic Rating',   'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'audienceRating',     'label': 'Rating',          'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'durationFormatted',  'label': 'Time',            'default': True,  'sortable': True,  'expandOnly': False, 'sortKey': 'duration'},
        {'key': 'resolution',         'label': 'Res',             'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'fileSizeFormatted',  'label': 'Size',            'default': False, 'sortable': True,  'expandOnly': False, 'sortKey': 'fileSize'},
        {'key': 'genres',             'label': 'Genre',           'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'studio',             'label': 'Studio',          'default': False, 'sortable': True,  'expandOnly': False},
        {'key': 'contentRating',      'label': 'Content Rating',  'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'addedAtFormatted',   'label': 'Added',           'default': False, 'sortable': True,  'expandOnly': False, 'sortKey': 'addedAt'},
        {'key': 'videoCodec',         'label': 'Video Codec',     'default': False, 'sortable': True,  'expandOnly': False},
        {'key': 'audioCodec',         'label': 'Audio Codec',     'default': False, 'sortable': True,  'expandOnly': False},
        {'key': 'audioChannelsFormatted', 'label': 'Audio Channels', 'default': False, 'sortable': True, 'expandOnly': False, 'sortKey': 'audioChannels'},
        {'key': 'bitrateFormatted',   'label': 'Bitrate',         'default': False, 'sortable': True,  'expandOnly': False, 'sortKey': 'bitrate'},
        {'key': 'container',          'label': 'EXT',             'default': False, 'sortable': True,  'expandOnly': False},
        {'key': 'subtitleLanguages',  'label': 'Subtitles',       'default': False, 'sortable': True,  'expandOnly': False},
        {'key': 'watchStatus',        'label': 'Status',          'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'playCount',          'label': 'Play Count',      'default': False, 'sortable': True,  'expandOnly': False},
        {'key': 'lastPlayedAtFormatted', 'label': 'Last Played',  'default': False, 'sortable': True,  'expandOnly': False, 'sortKey': 'lastPlayedAt'},
        {'key': 'summary',            'label': 'Summary',         'default': False, 'sortable': False, 'expandOnly': True},
        {'key': 'filePath',           'label': 'File Path',       'default': False, 'sortable': False, 'expandOnly': True},
    ],
    'show': [
        {'key': 'title',              'label': 'Title',           'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'year',               'label': 'Year',            'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'rating',             'label': 'Critic Rating',   'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'audienceRating',     'label': 'Rating',          'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'seasons',            'label': 'S',               'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'episodes',           'label': 'E',               'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'totalSizeFormatted', 'label': 'Size',             'default': True,  'sortable': True,  'expandOnly': False, 'sortKey': 'totalSize'},
        {'key': 'dominantResolution', 'label': 'Res',              'default': True,  'sortable': True,  'expandOnly': False, 'sortKey': 'dominantResolutionRank'},
        {'key': 'totalDurationFormatted', 'label': 'Duration',      'default': False, 'sortable': True, 'expandOnly': False, 'sortKey': 'totalDuration'},
        {'key': 'watchedEpisodes',    'label': 'Watched',         'default': False, 'sortable': True,  'expandOnly': False},
        {'key': 'watchProgress',      'label': 'Progress',        'default': True,  'sortable': True,  'expandOnly': False, 'sortKey': 'watchProgressPercent'},
        {'key': 'genres',             'label': 'Genre',           'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'studio',             'label': 'Studio',          'default': False, 'sortable': True,  'expandOnly': False},
        {'key': 'contentRating',      'label': 'Content Rating',  'default': False, 'sortable': True,  'expandOnly': False},
        {'key': 'watchStatus',        'label': 'Watch Status',    'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'showStatus',         'label': 'Show Status',     'default': True,  'sortable': True,  'expandOnly': False},
        {'key': 'subtitleLanguages',  'label': 'Subtitles',       'default': False, 'sortable': True,  'expandOnly': False},
        {'key': 'addedAtFormatted',   'label': 'Added',           'default': False, 'sortable': True,  'expandOnly': False, 'sortKey': 'addedAt'},
        {'key': 'lastPlayedAtFormatted', 'label': 'Last Played',  'default': False, 'sortable': True,  'expandOnly': False, 'sortKey': 'lastPlayedAt'},
        {'key': 'summary',            'label': 'Summary',         'default': False, 'sortable': False, 'expandOnly': True},
        {'key': 'filePath',           'label': 'File Path',       'default': False, 'sortable': False, 'expandOnly': True},
    ],
}
