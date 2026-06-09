######################################
# HEALTH — FILE HEALTH SCANNER       #
######################################

import glob
import json
import logging
import os
import subprocess
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from shared import CACHE_DIR, enrichment

health_bp = Blueprint('health', __name__)
health_logger = logging.getLogger('mediadash.health')

HEALTH_CACHE_FILE = os.path.join(CACHE_DIR, 'health_cache.json')

QUICK_SCAN_KEY = 'health:quick'
DEEP_SCAN_KEY = 'health:deep'

TINY_FILE_THRESHOLD = 1 * 1024 * 1024  # 1 MB

ISSUE_LABELS = {
    'zero_byte':       'File is empty or suspiciously small',
    'unreadable':      'Container cannot be parsed',
    'no_video_stream': 'No video track found',
    'no_audio_stream': 'No audio track found',
    'zero_duration':   'Stream reports zero duration',
    'decode_errors':   'File failed full playback check — may cut off or stutter',
}


# ============================================================
# CACHE I/O
# ============================================================

def _load_health_cache():
    """Return the current health cache or a blank structure."""
    if os.path.exists(HEALTH_CACHE_FILE):
        try:
            with open(HEALTH_CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            health_logger.warning(f"Could not read health cache: {e}")
    return {'quick_scanned_at': None, 'deep_scanned_at': None, 'results': []}


def _save_health_cache(data):
    """Atomically write health cache to disk."""
    tmp = HEALTH_CACHE_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f)
    os.replace(tmp, HEALTH_CACHE_FILE)


# ============================================================
# FILE DISCOVERY
# ============================================================

def _all_cached_items():
    """Yield every item dict from every per-library cache file."""
    for cache_file in glob.glob(os.path.join(CACHE_DIR, '*_cache.json')):
        if os.path.basename(cache_file) == 'health_cache.json':
            continue
        try:
            with open(cache_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        for key, entry in data.items():
            if not key.startswith('search:'):
                continue
            library_title = key.split(':', 1)[1]
            for item in (entry.get('items') or []):
                yield library_title, item


def _collect_scan_targets():
    """
    Return a list of dicts with the fields needed for scanning.
    Skips items with no filePath or whose file does not exist on disk.
    """
    targets = []
    seen = set()
    for library_title, item in _all_cached_items():
        fp = item.get('filePath', '')
        if not fp or fp in seen:
            continue
        seen.add(fp)
        targets.append({
            'filePath': fp,
            'title': item.get('title', ''),
            'library': library_title,
            'fileSize': item.get('fileSize', 0),
        })
    return targets
