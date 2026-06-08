######################################################
# PLEX SYNC — UNIFIED BACKGROUND DATA PIPELINE       #
######################################################
#
# Single orchestrated pass that walks every selected Plex library ONCE and
# produces all cached data needed by Home, Search, Naming, and Sizes:
#   - search:<library>  (browse/episode-meta data — also feeds Sizes via projections)
#   - naming:<library>  (naming-analysis data)
#
# Replaces the three independent per-page fetch pipelines that used to each
# open their own Plex connection and re-walk the same libraries.

import logging
import time
from concurrent.futures import ThreadPoolExecutor

from plexapi.server import PlexServer

from shared import (
    cache, enrichment, PLEX_URL, PLEX_TOKEN, is_library_selected,
    fetch_movies_with_streams, format_bytes, format_duration_short,
    PRIO_SYNC,
)
from search import (
    EXTRACTORS, fetch_episode_metadata, _merge_episode_meta,
)
from name_analysis import extract_movie_naming, extract_episode_naming

logger = logging.getLogger('mediadash.sync')

SYNC_KEY = 'sync:full'
SUPPORTED_LIBRARY_TYPES = ('movie', 'show')


# WALK ONE MOVIE LIBRARY: FETCH ONCE, EXTRACT FOR BOTH SEARCH AND NAMING
def _sync_movie_library(section, title, lib_index, lib_total):
    raw_items = fetch_movies_with_streams(section)
    total = len(raw_items)

    search_extractor = EXTRACTORS['movie']
    search_items = []
    naming_items = []
    errors = 0

    for i, movie in enumerate(raw_items):
        try:
            search_items.append(search_extractor(movie))
        except Exception as e:
            errors += 1
            logger.error(f"Failed to extract search data for '{getattr(movie, 'title', '?')}': {e}")
        try:
            naming_items.append(extract_movie_naming(movie))
        except Exception as e:
            errors += 1
            logger.error(f"Failed to extract naming data for '{getattr(movie, 'title', '?')}': {e}")

        if (i + 1) % 100 == 0 or i + 1 == total:
            enrichment.update_progress(
                SYNC_KEY, i + 1, total,
                f'Library {lib_index}/{lib_total} — {title} (movies): {i + 1:,}/{total:,}'
            )

    cache.set(f'search:{title}', search_items, 'movie')
    cache.set(f'naming:{title}', naming_items, 'movie')
    logger.info(f"Synced movie library '{title}': {len(search_items)} items ({errors} errors)")


# WALK ONE SHOW LIBRARY: FETCH SHOWS + EPISODES + EPISODE-META ONCE, EXTRACT FOR BOTH
def _sync_show_library(section, title, lib_index, lib_total):
    enrichment.update_progress(
        SYNC_KEY, 0, 0,
        f'Library {lib_index}/{lib_total} — {title} (shows): fetching from Plex…'
    )

    with ThreadPoolExecutor(max_workers=3) as pool:
        future_shows = pool.submit(section.all)
        future_episodes = pool.submit(section.searchEpisodes)
        future_meta = pool.submit(fetch_episode_metadata, section)
        shows = future_shows.result()
        episodes = future_episodes.result()
        episode_meta = future_meta.result()

    show_year_map = {s.ratingKey: s.year for s in shows if s.ratingKey and s.year}

    # SEARCH SIDE: EXTRACT SHOWS, THEN MERGE EPISODE METADATA (SIZES/SEASONS/RESOLUTIONS)
    search_extractor = EXTRACTORS['show']
    search_items = []
    search_errors = 0
    for show in shows:
        try:
            search_items.append(search_extractor(show))
        except Exception as e:
            search_errors += 1
            logger.error(f"Failed to extract search data for '{getattr(show, 'title', '?')}': {e}")

    def _on_merge_progress(current, t):
        enrichment.update_progress(
            SYNC_KEY, current, t,
            f'Library {lib_index}/{lib_total} — {title} (shows): computing sizes {current:,}/{t:,}'
        )

    _merge_episode_meta(search_items, episode_meta, progress_fn=_on_merge_progress)

    # NAMING SIDE: EXTRACT EPISODES (REUSES THE SAME `episodes` LIST — NO RE-FETCH)
    total_eps = len(episodes)
    naming_items = []
    naming_errors = 0
    for i, ep in enumerate(episodes):
        try:
            naming_items.append(extract_episode_naming(ep, show_year_map))
        except Exception as e:
            naming_errors += 1
            logger.error(f"Failed to extract naming data for episode: {e}")
        if (i + 1) % 100 == 0 or i + 1 == total_eps:
            enrichment.update_progress(
                SYNC_KEY, i + 1, total_eps,
                f'Library {lib_index}/{lib_total} — {title} (shows): naming {i + 1:,}/{total_eps:,} episodes'
            )

    cache.set(f'search:{title}', search_items, 'show')
    cache.set(f'naming:{title}', naming_items, 'show')
    logger.info(
        f"Synced show library '{title}': {len(search_items)} shows ({search_errors} errors), "
        f"{len(naming_items)} episodes ({naming_errors} errors)"
    )


# TOP-LEVEL ORCHESTRATOR — RUNS AS A SINGLE BACKGROUND TASK (SYNC_KEY)
def run_full_sync():
    start = time.time()
    enrichment.update_progress(SYNC_KEY, 0, 0, 'Connecting to Plex…')
    try:
        plex = PlexServer(PLEX_URL, PLEX_TOKEN, timeout=120)
    except Exception as e:
        logger.error(f"Full sync aborted — could not connect to Plex: {e}")
        raise

    sections = [
        s for s in plex.library.sections()
        if s.type in SUPPORTED_LIBRARY_TYPES and is_library_selected(s.title)
    ]
    # MOVIES FIRST — FAST AND FEEDS HOME STATS IMMEDIATELY — THEN SHOWS
    sections.sort(key=lambda s: 0 if s.type == 'movie' else 1)
    total_libs = len(sections)

    enrichment.update_progress(SYNC_KEY, 0, total_libs, 'Connecting to Plex…')

    for idx, section in enumerate(sections, start=1):
        try:
            if section.type == 'movie':
                _sync_movie_library(section, section.title, idx, total_libs)
            else:
                _sync_show_library(section, section.title, idx, total_libs)
        except Exception as e:
            logger.error(f"Sync failed for library '{section.title}': {e}")
            continue

    elapsed = time.time() - start
    logger.info(f"Full Plex sync complete: {total_libs} libraries in {elapsed:.1f}s")


# START THE UNIFIED SYNC IF NOT ALREADY RUNNING — RETURNS True IF (NEWLY) STARTED
def start_full_sync():
    if enrichment.is_running(SYNC_KEY):
        return False
    enrichment.start(SYNC_KEY, run_full_sync, priority=PRIO_SYNC, silent=False)
    return True
