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
        if not os.path.isfile(fp):
            continue
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
    Returns (success: bool, streams: list, format_duration: float).
    MKV and many other containers only store duration at the format level,
    not the stream level — so format_duration is required for zero_duration checks.
    Returns (False, [], 0.0) on any failure.
    """
    try:
        result = subprocess.run(
            [
                'ffprobe', '-v', 'error',
                '-print_format', 'json',
                '-show_streams',
                '-show_format',
                path,
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return False, [], 0.0
        data = json.loads(result.stdout)
        fmt_duration = float(data.get('format', {}).get('duration', 0) or 0)
        return True, data.get('streams', []), fmt_duration
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError):
        return False, [], 0.0


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
    ok, streams, format_duration = _ffprobe_file(path)
    if not ok:
        issues.append('unreadable')
        return issues

    # CHECK 3: stream validation
    has_video = False
    has_audio = False
    for s in streams:
        codec_type = s.get('codec_type', '')
        if codec_type == 'video':
            has_video = True
        elif codec_type == 'audio':
            has_audio = True

    if not has_video:
        issues.append('no_video_stream')
    if not has_audio:
        issues.append('no_audio_stream')

    # CHECK 4: zero duration — use format-level duration as the authoritative source.
    # Stream-level duration is absent in many containers (MKV, etc.), so checking
    # only stream duration produces large numbers of false positives.
    if format_duration == 0.0:
        issues.append('zero_duration')

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
# DEEP SCAN
# ============================================================

def _ffmpeg_decode_file(path):
    """
    Run a full ffmpeg decode pass to detect truncation or mid-file corruption.
    Returns (error_count: int). A non-zero count means decode errors were found.
    """
    try:
        result = subprocess.run(
            ['ffmpeg', '-v', 'error', '-i', path, '-f', 'null', '-'],
            capture_output=True,
            text=True,
            timeout=3600,  # 1-hour cap per file
        )
        # ffmpeg writes errors to stderr
        error_lines = [
            line for line in result.stderr.splitlines()
            if line.strip() and not line.startswith('ffmpeg version')
        ]
        return len(error_lines)
    except subprocess.TimeoutExpired:
        health_logger.warning(f"ffmpeg timed out on: {path}")
        return 1
    except FileNotFoundError:
        health_logger.error("ffmpeg not found — deep scan unavailable")
        return 0


def _run_deep_scan():
    """Background worker: run full ffmpeg decode on all cached items and enrich results."""
    targets = _collect_scan_targets()
    total = len(targets)

    existing = _load_health_cache()
    results_by_path = {r['filePath']: r for r in existing.get('results', [])}

    for i, target in enumerate(targets):
        enrichment.update_progress(DEEP_SCAN_KEY, i + 1, total, step=target['title'])
        path = target['filePath']

        if not os.path.exists(path):
            continue

        try:
            error_count = _ffmpeg_decode_file(path)
        except Exception as e:
            health_logger.warning(f"Unexpected error in deep scan for {path}: {e}")
            continue

        if error_count > 0:
            entry = results_by_path.get(path, {
                'filePath': path,
                'title': target['title'],
                'library': target['library'],
                'fileSize': target['fileSize'],
                'issues': [],
                'quickScanned': False,
                'scannedAt': datetime.now(timezone.utc).isoformat(),
            })
            if 'decode_errors' not in entry['issues']:
                entry['issues'].append('decode_errors')
            entry['deepScanned'] = True
            entry['scannedAt'] = datetime.now(timezone.utc).isoformat()
            results_by_path[path] = entry
        else:
            # DEEP SCAN PASSED — REMOVE decode_errors IF PRESENT, KEEP OTHER ISSUES
            entry = results_by_path.get(path)
            if entry:
                entry['issues'] = [iss for iss in entry['issues'] if iss != 'decode_errors']
                entry['deepScanned'] = True
                if not entry['issues']:
                    results_by_path.pop(path)

    cache_data = _load_health_cache()
    cache_data['deep_scanned_at'] = datetime.now(timezone.utc).isoformat()
    cache_data['results'] = list(results_by_path.values())
    _save_health_cache(cache_data)
    health_logger.info(f"Deep scan complete: {len(results_by_path)} issues found across {total} files")


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
