"""Fork "cpushare" bench: does taking battles off a GPU launch shorten it, and does it matter WHICH battles?

    cd gpu && flock ../out/gpu/study/gpu.lock uv run python -m gpu.study.cpushare.longest_bench [--batches 0,1,4] [--reps 2]
    -> out/gpu/study/cpushare/longest-bench.json

For each dumped launch of the standard halving-3 command (prof fork's dump, gen 0-2), production slice kernel (width auto):
  full          every battle on the GPU (share 0, today's default)
  even-k        k battles removed at the executor's own CPU slots (isCpuSlot: evenly spread by index, what --gpu-cpu-share does)
  longest-k     the k battles with the longest PREDICTED solo time removed (gpu/gpu/predict.py; what a predictor-routed share does)
  oracle-k      the k battles that took longest in the full launch removed (best case for any routing)
k = 95 (the auto share's count per step, GPU_RATE_MODEL), 32 and 8. Span = first battle start to last battle end (s).
"""
import argparse
import json
import os
import time

import numpy as np

from ... import kernel3v3 as K
from ...predict import predict_s
from ...profile_kernel import load_dump

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))


def span_of(out):
    s, e = K.stamps(out)
    return float((e.max() - s.min()) / 1e9), (e - s) / 1e9


def is_cpu_slot(i, ncpu, n):
    """src/engine/gpuExecutor.js isCpuSlot (exact integer arithmetic)."""
    return ((i + 1) * ncpu) // n > (i * ncpu) // n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", default=os.path.join(REPO, "out", "gpu", "study", "prof", "dump"))
    ap.add_argument("--batches", default="1,4,5")
    ap.add_argument("--ks", default="95,32,8")
    ap.add_argument("--reps", type=int, default=2)
    a = ap.parse_args()
    static, batches = load_dump(a.dump)
    K.run_3v3_slice(static, *[x[:64] for x in batches[1]])  # compile + warm
    res = []
    for bi in [int(x) for x in a.batches.split(",")]:
        idx, dyn, seeds = batches[bi]
        n = idx.shape[0]
        pred = predict_s(static, idx, dyn)
        full = [K.run_3v3_slice(static, idx, dyn, seeds)[0] for _ in range(a.reps)]
        fs = [span_of(o)[0] for o in full]
        dur = span_of(full[0])[1]
        rec = {"batch": bi, "n": n, "full_span_s": fs, "full_max_battle_s": float(dur.max()), "cases": []}
        for k in [int(x) for x in a.ks.split(",")]:
            sets = {
                "even": np.array([i for i in range(n) if is_cpu_slot(i, k, n)]),
                "longest": np.argsort(-pred, kind="stable")[:k],
                "oracle": np.argsort(-dur, kind="stable")[:k],
            }
            for name, rm in sets.items():
                keep = np.setdiff1d(np.arange(n), rm)
                spans = []
                for _ in range(a.reps):
                    out = K.run_3v3_slice(static, idx[keep], dyn[keep], seeds[keep])[0]
                    spans.append(span_of(out)[0])
                    same = bool(np.array_equal(out[:, :20], full[0][keep, :20]))
                rm_dur = dur[rm]
                c = {"k": k, "rule": name, "span_s": spans, "median_span_s": float(np.median(spans)),
                     "gain_s": float(np.median(fs) - np.median(spans)), "rows_equal_full": same,
                     "removed_in_launch_s_sum": float(rm_dur.sum()), "removed_in_launch_s_max": float(rm_dur.max()),
                     "removed_pred_solo_s_sum": float(pred[rm].sum()), "removed_turns_sum": int(full[0][rm, 9].sum()),
                     "removed_innersims_sum": int(full[0][rm, 11].sum()),
                     "overlap_with_oracle": int(len(np.intersect1d(rm, sets["oracle"])))}
                rec["cases"].append(c)
                print(json.dumps({"batch": bi, "n": n, "full": float(np.median(fs)), **{x: c[x] for x in ("k", "rule", "median_span_s", "gain_s", "rows_equal_full", "overlap_with_oracle")}}), flush=True)
        res.append(rec)
    p = os.path.join(REPO, "out", "gpu", "study", "cpushare", "longest-bench.json")
    json.dump({"dump": a.dump, "reps": a.reps, "launches": res, "at": time.strftime("%F %T %Z")}, open(p, "w"), indent=1)
    print("wrote", p)


if __name__ == "__main__":
    main()
