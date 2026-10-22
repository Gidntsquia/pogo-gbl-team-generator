"""Round 8 study variant "pool": a smaller 3v3 lookahead pool, with a full-pool re-run of the rare rows that overflow it.

The production kernel gives every thread a MAXQ=2048-state lookahead pool (pvp1v1.cuh decideAction, 12-byte packed states,
24.6 KB of its ~35 KB stack). This variant compiles the same kernel source with MAXQ = POGO_GPU_POOL_Q (default 512). A battle
whose pool would pass that size sets F_POOL_OVERFLOW and its row is not trusted; slice_collect re-runs exactly those rows with
the production MAXQ (2048) in a second launch on the same stream and writes them over the first rows. A battle that never
reaches the small limit runs identical code (the limit is only read in the `pn >= MAXQ` checks), so every row equals
production bit for bit; a row that still overflows at 2048 stays flagged and goes to the CPU exactly as in production.

Knobs (read here only):
  POGO_GPU_POOL_Q      small pool size (default 512)
  POGO_GPU_POOL_STACK  cudaDeviceSetLimit(stack) for the small-pool launch (default: production 65536). The re-run always
                       uses 65536; changing the limit waits for running kernels, so it is set only around the re-run.
  POGO_GPU_POOL_RW     re-run width (threads per battle; default 32 = one warp per battle, the re-run is a handful of battles)
Every collect adds info["pool"] = {q, rerun, rerun_s, still_flagged} and (POGO_GPU_POOL_LOG=<file>) appends it as a JSON line.
"""
import json
import os
import time

import numpy as np

F_POOL_OVERFLOW = 2
FULL_Q = 2048


def make(K, q=None, stack=None, rw=None):
    """-> (slice_launch, slice_collect) wrappers around K's current ones that run the small pool and re-run overflows."""
    q = int(q or os.environ.get("POGO_GPU_POOL_Q", "512"))
    stack = int(stack or os.environ.get("POGO_GPU_POOL_STACK", "65536"))
    rw = int(rw or os.environ.get("POGO_GPU_POOL_RW", "32"))
    log = os.environ.get("POGO_GPU_POOL_LOG", "")
    base_launch, base_collect = K.slice_launch, K.slice_collect
    full_q = K.MAXQ if K.MAXQ > q else FULL_Q

    def with_q(qq, fn, *a, **kw):
        old = K.MAXQ
        K.MAXQ = qq
        try:
            return fn(*a, **kw)
        finally:
            K.MAXQ = old

    def slice_launch(static, idx, dyn, seeds, real="float", **kw):
        kw2 = dict(kw)
        kw2["stack"] = stack if kw.get("stack", 65536) == 65536 else kw["stack"]
        h = with_q(q, base_launch, static, idx, dyn, seeds, real, **kw2)
        if h.get("n", 0):
            h["pool_args"] = (static, idx, dyn, seeds, real, kw)
        return h

    def slice_collect(h):
        out, info = base_collect(h)
        if not h.get("n"):
            return out, info
        static, idx, dyn, seeds, real, kw = h["pool_args"]
        n = h["n"]
        bad = np.nonzero(out[:n, 10] & F_POOL_OVERFLOW)[0]
        rec = {"n": int(n), "q": q, "rerun": int(len(bad)), "rerun_s": 0.0, "still_flagged": 0}
        if len(bad):
            t0 = time.perf_counter()
            kw2 = {k: v for k, v in kw.items() if k in ("real", "T", "stream")}
            G = rw if len(bad) * rw <= K.slice_grid(real) else 1
            h2 = with_q(full_q, base_launch, static, idx[bad], dyn[bad], seeds[bad], real, width=G, stack=65536, **kw2)
            o2, i2 = base_collect(h2)
            out = out.copy()
            out[bad] = o2
            rec["rerun_s"] = time.perf_counter() - t0
            rec["still_flagged"] = int(np.count_nonzero(o2[:, 10] & F_POOL_OVERFLOW))
            seg = i2.get("segments")
            if seg is not None and len(seg):
                rec["rerun_span_s"] = float(seg[:, 3].max() - seg[:, 2].min()) / 1e9
                info["segments"] = np.concatenate([info["segments"], seg]) if len(info["segments"]) else seg
            if stack != 65536:
                K._set_stack(K.require_cuda(), stack)
        info["pool"] = rec
        if log:
            with open(log, "a") as f:
                f.write(json.dumps(rec) + "\n")
        return out, info

    return slice_launch, slice_collect


def apply(K):
    """Install the small-pool launch/collect on kernel3v3 (POGO_GPU_STUDY=pool)."""
    K.slice_launch, K.slice_collect = make(K)
