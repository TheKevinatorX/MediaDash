######################################################
# SYNC PROGRESS — BACKGROUND TASK QUEUE & TRACKING   #
######################################################
#
# Generic prioritized background-task engine: runs worker functions on a
# pool of daemon threads, tracks their status/progress, and reports active
# tasks for the /api/progress UI. Used for full syncs, episode enrichment,
# naming fetches, etc. — it doesn't know what the work *is*, just runs and
# reports it.

import logging
import queue
from threading import Lock, Thread

# ============================================================
# PRIORITY LEVELS — lower number = processed first
# Mirrors the nav bar order: Home → Search → Naming → Sizes
# ============================================================

PRIO_BROWSE_MOVIE = 0   # movie libraries: fast + feeds Home stats immediately
PRIO_BROWSE_SHOW  = 1   # show libraries: feeds Home stats (submitted in Plex section order)
PRIO_NAMING       = 2   # Naming page data for all libraries
PRIO_EPISODE      = 3   # episode-level size/duration enrichment (Sizes page)


# PRIORITY-QUEUE BACKGROUND TASK RUNNER
# Tasks are dequeued in (priority, submission-order) sequence across NUM_WORKERS threads.
# Workers are daemon threads — they die with the Flask process cleanly.
class BackgroundEnrichment:
    NUM_WORKERS = 2  # enough parallelism without drowning out priority ordering

    def __init__(self):
        self._tasks = {}
        self._generations = {}  # detect stale threads after cache invalidation
        self._lock = Lock()
        self._queue = queue.PriorityQueue()
        self._seq = 0           # monotonic counter: FIFO tiebreaker within same priority
        self._logger = logging.getLogger('mediadash.enrich')
        for i in range(self.NUM_WORKERS):
            Thread(target=self._consumer, daemon=True, name=f'enrich-{i}').start()

    def is_running(self, key):
        with self._lock:
            task = self._tasks.get(key)
            return task is not None and task['status'] in ('pending', 'running')

    def is_complete(self, key):
        with self._lock:
            task = self._tasks.get(key)
            return task is not None and task['status'] == 'complete'

    def get_status(self, key):
        with self._lock:
            return self._tasks.get(key, {}).get('status', 'none')

    def update_progress(self, key, current, total, step=''):
        with self._lock:
            task = self._tasks.get(key)
            if task:
                task['progress'] = {'current': current, 'total': total, 'step': step}

    def get_progress(self, key):
        with self._lock:
            return self._tasks.get(key, {}).get('progress')

    # SILENT TASKS RUN NORMALLY BUT ARE HIDDEN FROM /API/PROGRESS
    def start(self, key, worker_fn, args=(), priority=5, silent=False):
        with self._lock:
            if self._tasks.get(key, {}).get('status') in ('pending', 'running'):
                self._logger.debug(f"Already in progress for '{key}'")
                return
            gen = self._generations.get(key, 0) + 1
            self._generations[key] = gen
            seq = self._seq
            self._seq += 1
            self._tasks[key] = {'status': 'pending', 'priority': priority, 'silent': silent}
        self._queue.put((priority, seq, key, worker_fn, args, gen))

    def _consumer(self):
        while True:
            priority, seq, key, worker_fn, args, gen = self._queue.get()
            try:
                self._run(key, worker_fn, args, gen)
            finally:
                self._queue.task_done()

    def _run(self, key, worker_fn, args, generation):
        with self._lock:
            task = self._tasks.setdefault(key, {})
            task['status'] = 'running'
        try:
            worker_fn(*args)
            with self._lock:
                if self._generations.get(key, 0) == generation:
                    self._tasks[key]['status'] = 'complete'
                else:
                    self._logger.info(f"Stale task for '{key}' (gen={generation}) discarded")
        except Exception as e:
            self._logger.error(f"Background task failed for '{key}': {e}")
            with self._lock:
                self._tasks[key] = {'status': 'error'}

    def get_all_active(self):
        with self._lock:
            result = []
            for key, task in self._tasks.items():
                status = task.get('status', 'none')
                if status not in ('pending', 'running'):
                    continue
                if task.get('silent', False):
                    continue
                progress = task.get('progress') or {}
                parts = key.split(':', 1)
                task_type = parts[0] if len(parts) > 1 else 'unknown'
                library = parts[1] if len(parts) > 1 else key
                result.append({
                    'key': key,
                    'type': task_type,
                    'library': library,
                    'status': status,
                    'current': progress.get('current', 0),
                    'total': progress.get('total', 0),
                    'step': progress.get('step', ''),
                    'priority': task.get('priority', 5),
                })
            result.sort(key=lambda t: t['priority'])
            return result

    def reset(self, key=None):
        with self._lock:
            if key:
                self._tasks.pop(key, None)
                self._generations[key] = self._generations.get(key, 0) + 1
            else:
                self._tasks.clear()
                for k in list(self._generations.keys()):
                    self._generations[k] += 1
