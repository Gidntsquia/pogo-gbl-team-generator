"""Fork "queue" bench: how close is a launch to its longest battle, and what does the plain queue kernel do on the same launch?

    cd gpu && flock ../out/gpu/study/gpu.lock uv run python -m gpu.study.queue.solo_bench [--dump DIR] [--batches 0,1,4] [--reps 2]
    -> out/gpu/study/queue/solo-bench.json

For each dumped launch (the standard halving-3 command, gen 0-2, dumped by the prof fork):
  slice   production slice kernel (ring requeue, longest predicted first, width auto): span, longest battle's in-launch time
  queue   round-5 work-queue kernel (POGO_GPU_KERNEL=queue: one thread per battle, FIFO atomic counter): span
  solo    the launch's longest battle (by its in-launch time under slice) run alone, and the 32 longest run alone together
Rows of slice and queue are compared (they must be identical: same battle code). Bench numbers, not chain s/gen.
"""
import argparse
import json
import os
import time

import numpy as np

from ... import kernel3v3 as K
from ...profile_kernel import load_dump

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
ROW = 20  # out cols compared: everything before the timer stamps (cols 20..23)


def times(out):
    """(span s, per-battle duration s) from the %globaltimer stamps."""
    s, e = K.stamps(out)
    return float((e.max() - s.min()) / 1e9), (e - s) / 1e9


def starts(out):
    """Start offsets (s after the first start): the last-ending battle's, how many start > 0.1 s late, and the max."""
    s, e = K.stamps(out)
    off = (s - s.min()) / 1e9
    return {"last_end_start_s": float(off[int(np.argmax(e))]), "late_starts_0.1s": int((off > 0.1).sum()), "max_start_s": float(off.max())}


def run(proto, static, idx, dyn, seeds):
    K.PROTO = proto
    t = time.perf_counter()
    if proto == "slice":
        out, _ = K.run_3v3_slice(static, idx, dyn, seeds)
    else:
        out = K.run_3v3(static, idx, dyn, seeds, chunk=max(1, idx.shape[0]))
    wall = time.perf_counter() - t
    span, dur = times(out)
    return out, span, dur, wall


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", default=os.path.join(REPO, "out", "gpu", "study", "prof", "dump"))
    ap.add_argument("--batches", default="0,1,2,3,4,5")
    ap.add_argument("--reps", type=int, default=2)
    a = ap.parse_args()
    static, batches = load_dump(a.dump)
    res = []
    run("slice", static, *[x[:64] for x in batches[1]])  # compile + warm both kernels
    run("queue", static, *[x[:64] for x in batches[1]])
    for bi in [int(x) for x in a.batches.split(",")]:
        idx, dyn, seeds = batches[bi]
        n = idx.shape[0]
        rec = {"batch": bi, "n": n, "slice": [], "queue": []}
        ref = None
        for _ in range(a.reps):
            for proto in ("slice", "queue"):
                out, span, dur, wall = run(proto, static, idx, dyn, seeds)
                if ref is None:
                    ref = out
                same = bool(np.array_equal(out[:, :ROW], ref[:, :ROW]))
                rec[proto].append({"span_s": span, "wall_s": wall, "max_battle_s": float(dur.max()), "p50_battle_s": float(np.median(dur)),
                                   "rows_equal_slice": same, **starts(out)})
                if proto == "slice":
                    rec.setdefault("_dur", dur)
        dur = rec.pop("_dur")
        order = np.argsort(-dur, kind="stable")
        top1, top32 = order[:1], order[:32]
        solo1 = [run("slice", static, idx[top1], dyn[top1], seeds[top1])[1] for _ in range(3)]
        solo32 = [run("slice", static, idx[top32], dyn[top32], seeds[top32])[1] for _ in range(2)]
        rec["longest"] = {"index": int(top1[0]), "in_launch_s": float(dur[top1[0]]), "turns": int(ref[top1[0], 9]), "innerSims": int(ref[top1[0], 11]),
                          "solo_s": float(np.median(solo1)), "solo_runs_s": solo1, "top32_alone_span_s": float(np.median(solo32))}
        med = lambda p, k: float(np.median([r[k] for r in rec[p]]))
        rec["summary"] = {"slice_span_s": med("slice", "span_s"), "queue_span_s": med("queue", "span_s"),
                          "slice_max_battle_s": med("slice", "max_battle_s"), "slice_p50_battle_s": med("slice", "p50_battle_s"),
                          "span_over_longest_in_launch": med("slice", "span_s") / med("slice", "max_battle_s"),
                          "span_over_longest_solo": med("slice", "span_s") / rec["longest"]["solo_s"],
                          "queue_over_slice": med("queue", "span_s") / med("slice", "span_s"),
                          "rows_equal": all(r["rows_equal_slice"] for p in ("slice", "queue") for r in rec[p])}
        print(json.dumps({"batch": bi, "n": n, **rec["summary"], "longest_solo_s": rec["longest"]["solo_s"]}), flush=True)
        res.append(rec)
    K.PROTO = "slice"
    p = os.path.join(REPO, "out", "gpu", "study", "queue", "solo-bench.json")
    json.dump({"dump": a.dump, "reps": a.reps, "launches": res, "at": time.strftime("%F %T %Z")}, open(p, "w"), indent=1)
    print("wrote", p)


if __name__ == "__main__":
    main()
