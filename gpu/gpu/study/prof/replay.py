"""Round 8 prof fork: replay dumped real launches through the production slice path and record what the profile needs.

    cd gpu && uv run python -m gpu.study.prof.replay launch --dump D --spec 7 --name 5k --reps 3 --outdir O
    cd gpu && uv run python -m gpu.study.prof.replay solo --dump D --spec 7 --name 5k --top 10 --reps 3 --outdir O

spec = one dumped batch index ("7") or several concatenated ("0+1+2": a merged launch, not a real one).
launch: per rep, host timings (order + width pick, slice_launch call = predict + uploads + enqueue, wait, collect = download
        + segment decode) and the kernel span from the segment records; the last rep's segments, rows and (with
        POGO_GPU_STUDY=prof) the probes are saved to O/<name>[-<tag>].npz, the timings to O/<name>[-<tag>].launch.json.
        tag = POGO_GPU_PROF probes when the prof variant is on, else "prod".
solo:   the --top longest battles of the launch (by their kernel stamps in O/<name>-prod.npz) each replayed ALONE (n=1, one
        thread, width 1) and all together, vs their time inside the full launch -> O/<name>.solo.json.
"""
import argparse
import json
import os
import time

import numpy as np

from ... import kernel3v3 as K
from ...profile_kernel import load_dump


def batch_of(dump, spec):
    static, batches = load_dump(dump)
    parts = [batches[int(x)] for x in spec.split("+")]
    idx = np.concatenate([p[0] for p in parts]); dyn = np.concatenate([p[1] for p in parts]); seeds = np.concatenate([p[2] for p in parts])
    return static, np.ascontiguousarray(idx), np.ascontiguousarray(dyn), np.ascontiguousarray(seeds)


def tag():
    if "prof" in K.STUDY:
        return os.environ.get("POGO_GPU_PROF", "sm").replace(",", "+")
    return "prod"


def one(static, idx, dyn, seeds, width=None, probes=False):
    import cupy as cp
    from ... import width as WD
    V = None
    if probes:
        from . import variant as V
        V.reset_probes(K)
    cp.cuda.Stream.null.synchronize()
    t0 = time.perf_counter()
    order, pred = K.slice_order(static, idx, dyn)
    if width is None:
        width, wlog = WD.pick(static, idx, dyn)
    else:
        wlog = f"forced G={width}"
    t1 = time.perf_counter()
    ev0 = cp.cuda.Event(); ev1 = cp.cuda.Event()
    ev0.record()
    h = K.slice_launch(static, idx, dyn, seeds, order=order, width=width)
    t2 = time.perf_counter()
    ev1.record()
    ev1.synchronize()
    t3 = time.perf_counter()
    out, info = K.slice_collect(h)
    t4 = time.perf_counter()
    segs = info["segments"]
    span = float(segs[:, 3].max() - segs[:, 2].min()) / 1e9 if len(segs) else 0.0
    rec = {"n": int(idx.shape[0]), "width": width if isinstance(width, int) else str(width), "width_log": wlog,
           "host_prep_s": t1 - t0, "launch_call_s": t2 - t1, "wait_s": t3 - t2, "collect_s": t4 - t3, "total_s": t4 - t0,
           "event_launch_to_done_s": cp.cuda.get_elapsed_time(ev0, ev1) / 1e3, "kernel_span_s": span,
           "threads": info["threads"], "requeues": info["handoffs"], "segments": int(len(segs)),
           "segments_dropped": info["segments_dropped"]}
    pr = V.read_probes(K, idx.shape[0], info["threads"] // K.BLOCK) if V else None
    return out, info, rec, pr


def cmd_launch(a):
    static, idx, dyn, seeds = batch_of(a.dump, a.spec)
    probes = "prof" in K.STUDY
    one(static, idx[:64], dyn[:64], seeds[:64], width=1, probes=probes)  # warm-up: compile, allocator, predictor weights
    recs = []
    for r in range(a.reps):
        out, info, rec, pr = one(static, idx, dyn, seeds, width=a.width, probes=probes)
        recs.append(rec)
        print(json.dumps(rec), flush=True)
    t = tag()
    base = os.path.join(a.outdir, f"{a.name}-{t}")
    s, e = K.stamps(out)
    save = {"segments": info["segments"], "rows": out[:, :20], "start_ns": s, "end_ns": e}
    if pr is not None:
        save.update({"smid": pr["smid"], "lanes": pr["lanes"], "ptime": pr["time"]})
    np.savez_compressed(base + ".npz", **save)
    json.dump({"dump": a.dump, "spec": a.spec, "name": a.name, "variant": t, "reps": recs,
               "merged": "+" in a.spec, "rows_sha1": __import__("hashlib").sha1(np.ascontiguousarray(out[:, :20]).tobytes()).hexdigest()},
              open(base + ".launch.json", "w"), indent=1)


def cmd_solo(a):
    static, idx, dyn, seeds = batch_of(a.dump, a.spec)
    ref = np.load(os.path.join(a.outdir, f"{a.name}-prod.npz"))
    dur = (ref["end_ns"] - ref["start_ns"]) / 1e9   # first start .. end, inside the full launch (includes requeue waits)
    segs = ref["segments"]
    run = np.zeros(len(dur))                          # time actually running (sum of its segments)
    np.add.at(run, segs[:, 1], (segs[:, 3] - segs[:, 2]) / 1e9)
    top = np.argsort(-dur)[: a.top]
    one(static, idx[:1], dyn[:1], seeds[:1], width=1)  # warm-up
    rows = []
    for b in top:
        sl = slice(int(b), int(b) + 1)
        ts = []
        for _ in range(a.reps):
            out, info, rec, _ = one(static, idx[sl], dyn[sl], seeds[sl], width=1)
            ts.append(rec["kernel_span_s"])
            assert (out[0, :20] == ref["rows"][b]).all(), "solo row differs from the launch row"
        rows.append({"battle": int(b), "in_launch_s": float(dur[b]), "in_launch_running_s": float(run[b]),
                     "alone_s": float(np.median(ts)), "alone_reps_s": ts, "slowdown_in_launch": float(dur[b] / np.median(ts)),
                     "turns": int(ref["rows"][b, 9]), "innerSims": int(ref["rows"][b, 11]), "poolMax": int(ref["rows"][b, 13])})
        print(json.dumps(rows[-1]), flush=True)
    # all top battles together in one launch (one thread each, spread one per warp by the slice kernel)
    sel = np.sort(top)
    out, info, rec, _ = one(static, idx[sel], dyn[sel], seeds[sel], width=1)
    s, e = K.stamps(out)
    together = {"n": int(len(sel)), "span_s": rec["kernel_span_s"], "per_battle_s": ((e - s) / 1e9).tolist()}
    launch = json.load(open(os.path.join(a.outdir, f"{a.name}-prod.launch.json")))
    spans = [r["kernel_span_s"] for r in launch["reps"]]
    doc = {"launch": a.name, "spec": a.spec, "n": int(len(dur)), "launch_kernel_span_s_median": float(np.median(spans)),
           "battle_p50_in_launch_s": float(np.median(dur)), "top": rows, "top_together": together,
           "note": "alone = the battle as a 1-battle launch (one thread, width 1), median of reps; in_launch = first start .. end "
                   "inside the full launch (prod build, last rep), in_launch_running = sum of its slice segments"}
    json.dump(doc, open(os.path.join(a.outdir, f"{a.name}.solo.json"), "w"), indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("launch", "solo"))
    ap.add_argument("--dump", required=True)
    ap.add_argument("--spec", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--width", type=int)
    ap.add_argument("--outdir", required=True)
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)
    {"launch": cmd_launch, "solo": cmd_solo}[a.cmd](a)


if __name__ == "__main__":
    main()
