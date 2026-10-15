"""Probe: do two launches on two CUDA streams overlap? Prints each launch's first-start / last-end (ms from the earliest start).
    uv run python -m gpu.streams_probe [--dump ../out/gpu/dump-prof0] [--size 5000]"""
import argparse, time
import numpy as np
from . import kernel3v3 as K
from .cuda_guard import require_cuda
from .profile_kernel import load_dump, slice_of
from .sched_bench import v2_segments


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--dump", default="../out/gpu/dump-prof0"); ap.add_argument("--size", type=int, default=5000)
    a = ap.parse_args()
    cp = require_cuda()
    static, batches = load_dump(a.dump)
    idx, dyn, seeds = slice_of(batches, a.size)
    n = len(seeds); h = n // 2
    for proto in ("", "slice"):
        K.PROTO = proto
        for warm in (0, 1):
            t = time.perf_counter()
            hs = [K.launch_async(static, idx[p], dyn[p], seeds[p], stream=cp.cuda.Stream(non_blocking=True), share=2) for p in (slice(0, h), slice(h, n))]
            t_issue = time.perf_counter() - t
            outs = [K.launch_collect(x) for x in hs]
            if not warm:
                continue
            if proto == "":
                sg = [v2_segments(o) for o in outs]
            else:
                sg = [K.slice_collect(x)[1]["segments"] for x in hs]
            t0 = min(s[:, 2].min() for s in sg)
            print(proto or "v2", "issue %.3f s" % t_issue, [("%.0f-%.0f ms" % ((s[:, 2].min() - t0) / 1e6, (s[:, 3].max() - t0) / 1e6)) for s in sg], flush=True)


if __name__ == "__main__":
    main()
