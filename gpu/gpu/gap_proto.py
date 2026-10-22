"""Round 5 prototype slices: kernel variants (v2 thread-per-battle, warp-per-battle under 5k, work queue) and launch-size scaling,
each >= 3 timed launches (median) on the 5,000 and 36,000 slices from a dumped run. Results must equal v2 row for row.

    uv run python -m gpu.gap_proto --dump ../out/gpu/dump-prof0 --out ../out/gpu/gap/slices.json
"""
import argparse
import json
import os
import statistics

import numpy as np

from . import kernel3v3 as K
from .cuda_guard import require_cuda
from .profile_kernel import load_dump, slice_of, timing

SIZES = (5000, 36000)
SCALE = (2500, 5000, 10000, 15000, 18000, 36000)


def launch(static, sl, proto, reps=3):
    idx, dyn, seeds = sl
    n = len(seeds)
    K.PROTO = proto
    K.run_3v3(static, idx[:64], dyn[:64], seeds[:64], chunk=64)  # compile / warm
    runs = []
    for _ in range(reps):
        out = K.run_3v3(static, idx, dyn, seeds, chunk=n)
        runs.append((timing(out), out))
    runs.sort(key=lambda r: r[0]["span_s"])
    t, out = runs[len(runs) // 2]
    t["span_all_s"] = [r[0]["span_s"] for r in runs]
    return t, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--variants", default="v2,warp,queue")
    ap.add_argument("--reps", type=int, default=3)
    a = ap.parse_args()
    require_cuda()
    static, batches = load_dump(a.dump)
    res = {"variants": [], "scaling": []}
    for size in SIZES:
        sl = slice_of(batches, size)
        base_out = None
        for v in a.variants.split(","):
            t, out = launch(static, sl, "" if v == "v2" else v, a.reps)
            if v == "v2":
                base_out = out
            same = bool((out[:, :20] == base_out[:, :20]).all())
            row = {"size": size, "variant": v, "span_s": t["span_s"], "bps": t["bps"], "tail_share": t["tail_share"], "span_all_s": t["span_all_s"],
                   "same_results": same, "flagged": t["flagged"]}
            res["variants"].append(row)
            print(json.dumps(row), flush=True)
    for size in SCALE:
        t, _ = launch(static, slice_of(batches, size), "", a.reps)
        row = {"size": size, "span_s": t["span_s"], "bps": t["bps"], "tail_share": t["tail_share"], "longest_battle_s": t["battle_max_s"]}
        res["scaling"].append(row)
        print(json.dumps(row), flush=True)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    json.dump(res, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
