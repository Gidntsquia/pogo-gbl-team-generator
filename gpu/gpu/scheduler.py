"""Inner-sim batching scheduler: many concurrent battles, one GPU batch per decision step.

pvpoke's TrainingAI answers every decision with 1v1 `Battle.simulate()` lookaheads (~505 per 3v3 battle). One call at a
time the GPU is latency-bound (about 1.5k sims/s through a sidecar); the 1v1 kernel does ~700k sims/s on a big batch. This
module is the piece between the two: callers `submit()` sim requests as they make them, and when every concurrent battle is
blocked on its next answer the driver calls `flush()` and all pending sims run as ONE kernel launch.

Interface (all arrays follow gpu/pack.py: D_N doubles per mon, static table from pack_static)

    s = InnerSimScheduler(static, real="float", max_batch=65536, run=run_1v1)
    t = s.submit(idx2, dyn2)      # idx2: int32[2] rows of `static`; dyn2: float64[2, D_N] -> ticket (int)
    s.pending                     # sims waiting
    res = s.flush()               # runs everything pending; dict ticket -> int32[OUT_N] (kernel1v1.OUT_N = 18 columns)
    s.stats()                     # dict: sims requested, distinct sims run, duplicates folded, batches, kernel seconds, mean batch

Identical requests (same mons, same dyn state) inside one flush are folded into one kernel row; every ticket still gets its
result. A flush larger than `max_batch` is cut into several launches (logged in stats["splits"]). `run` is injectable so the
logic is testable without a GPU; the default is gpu.kernel1v1.run_1v1. Nothing here imports src/ or touches node.
"""
import time

import numpy as np

from .pack import D_N


class InnerSimScheduler:
    def __init__(self, static, real="float", max_batch=65536, run=None):
        self.static = static
        self.real = real
        self.max_batch = max_batch
        if run is None:
            from .kernel1v1 import run_1v1 as run
        self._run = run
        self._idx, self._dyn, self._tickets = [], [], []
        self._next = 0
        self._st = dict(requested=0, run=0, folded=0, batches=0, splits=0, kernel_s=0.0)

    @property
    def pending(self):
        return len(self._tickets)

    def submit(self, idx2, dyn2):
        """Queue one 1v1 sim; returns its ticket."""
        self._idx.append(np.asarray(idx2, np.int32).reshape(2))
        self._dyn.append(np.asarray(dyn2, np.float64).reshape(2, D_N))
        t = self._next
        self._next += 1
        self._tickets.append(t)
        self._st["requested"] += 1
        return t

    def flush(self):
        """Run all pending sims as one batch (folding duplicates). Returns {ticket: int32 row}."""
        if not self._tickets:
            return {}
        idx = np.stack(self._idx)
        dyn = np.stack(self._dyn)
        tickets = self._tickets
        self._idx, self._dyn, self._tickets = [], [], []
        # fold identical (mons, state) rows
        keys = np.concatenate([idx.astype(np.float64), dyn.reshape(len(idx), -1)], axis=1)
        _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
        inverse = np.asarray(inverse).reshape(-1)
        u_idx, u_dyn = idx[first], dyn[first]
        out = np.empty((len(first), 0), np.int32)
        pieces = []
        for lo in range(0, len(first), self.max_batch):
            t = time.perf_counter()
            pieces.append(self._run(self.static, u_idx[lo:lo + self.max_batch], u_dyn[lo:lo + self.max_batch], self.real))
            self._st["kernel_s"] += time.perf_counter() - t
        if len(pieces) > 1:
            self._st["splits"] += len(pieces) - 1
        out = np.concatenate(pieces)
        self._st["batches"] += 1
        self._st["run"] += len(first)
        self._st["folded"] += len(tickets) - len(first)
        return {t: out[inverse[i]] for i, t in enumerate(tickets)}

    def stats(self):
        s = dict(self._st)
        s["mean_batch"] = s["run"] / s["batches"] if s["batches"] else 0.0
        return s
