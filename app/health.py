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
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        os.replace(tmp, HEALTH_CACHE_FILE)
    except OSError as e:
        health_logger.error(f"Could not write health cache: {e}")
        raise


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
        except (json.JSONDecodeError, OSError) as e:
            health_logger.warning(f"Skipping unreadable cache file {cache_file}: {e}")
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


# ============================================================
# QUICK SCAN
# ============================================================

def _ffprobe_file(path):
    """
    Run ffprobe on a single file.
    Returns (success: bool, streams: list) where streams is the parsed JSON
    array from ffprobe, or an empty list on failure.
    """
    try:
        result = subprocess.run(
            [
                'ffprobe', '-v', 'error',
                '-print_format', 'json',
                '-show_streams',
                path,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return False, []
        data = json.loads(result.stdout)
        return True, data.get('streams', [])
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError):
        return False, []


def _quick_scan_file(target):
    """
    Run all quick checks on a single target dict.
    Returns a list of issue keys (empty = clean).
    """
    issues = []
    path = target['filePath']

    # CHECK 1: file exists and is not tiny
    try:
        size_on_disk = os.path.getsize(path)
    except OSError:
        return ['unreadable']

    if size_on_disk < TINY_FILE_THRESHOLD:
        issues.append('zero_byte')
        return issues  # no point probing a near-empty file

    # CHECK 2: ffprobe can parse the container
    ok, streams = _ffprobe_file(path)
    if not ok:
        issues.append('unreadable')
        return issues

    # CHECK 3: stream validation
    has_video = False
    has_audio = False
    for s in streams:
        codec_type = s.get('codec_type', '')
        duration = float(s.get('duration', 0) or 0)
        if codec_type == 'video':
            has_video = True
            if duration == 0:
                issues.append('zero_duration')
        elif codec_type == 'audio':
            has_audio = True

    if not has_video:
        issues.append('no_video_stream')
    if not has_audio:
        issues.append('no_audio_stream')

    return issues


def _run_quick_scan():
    """Background worker: run quick checks on all cached items and save results."""
    targets = _collect_scan_targets()
    total = len(targets)
    results_by_path = {}

    # SEED WITH EXISTING DEEP-SCAN RESULTS SO THEY ARE NOT LOST
    existing = _load_health_cache()
    for r in existing.get('results', []):
        results_by_path[r['filePath']] = r

    for i, target in enumerate(targets):
        enrichment.update_progress(QUICK_SCAN_KEY, i + 1, total, step=target['title'])
        try:
            issues = _quick_scan_file(target)
        except Exception as e:
            health_logger.warning(f"Unexpected error scanning {target.get('filePath', '?')}: {e}")
            continue
        if issues:
            entry = results_by_path.get(target['filePath'], {})
            entry.update({
                'filePath': target['filePath'],
                'title': target['title'],
                'library': target['library'],
                'fileSize': target['fileSize'],
                'issues': list(set(entry.get('issues', [])) | set(issues)),
                'quickScanned': True,
                'deepScanned': entry.get('deepScanned', False),
                'scannedAt': datetime.now(timezone.utc).isoformat(),
            })
            results_by_path[target['filePath']] = entry
        else:
            # FILE IS CLEAN — REMOVE FROM RESULTS IF IT WAS PREVIOUSLY FLAGGED
            results_by_path.pop(target['filePath'], None)

    cache_data = _load_health_cache()
    cache_data['quick_scanned_at'] = datetime.now(timezone.utc).isoformat()
    cache_data['results'] = list(results_by_path.values())
    _save_health_cache(cache_data)
    health_logger.info(f"Quick scan complete: {len(results_by_path)} issues found across {total} files")


# ============================================================
# ROUTES
# ============================================================

@health_bp.route('/results')
def get_results():
    data = _load_health_cache()
    data['issueLabels'] = ISSUE_LABELS
    return jsonify(data)


@health_bp.route('/scan', methods=['POST'])
def start_scan():
    mode = request.args.get('mode', 'quick')
    if mode not in ('quick', 'deep'):
        return jsonify({'error': 'mode must be quick or deep'}), 400

    if mode == 'quick':
        key = QUICK_SCAN_KEY
        worker = _run_quick_scan
    else:
        key = DEEP_SCAN_KEY
        worker = _run_deep_scan  # defined in Task 4

    if enrichment.is_running(key):
        return jsonify({'status': 'already_running'}), 409

    enrichment.start(key, worker, priority=3)
    return jsonify({'status': 'started'})
