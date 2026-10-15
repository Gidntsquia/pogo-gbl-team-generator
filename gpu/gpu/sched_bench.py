"""Round 6 scheduler bench (plans round 6, R1-R4, R8): each kernel/scheduler config on the 5,000 and 36,000 slices of a dumped
run, >= 5 timed launches each. Rows must equal v2's row for row (cols 0..19). Writes one JSON per config to out/gpu/sched/.

    uv run python -m gpu.sched_bench fit   --dump ../out/gpu/dump-prof0 [--out ../out/gpu/sched/predictor.json]
    uv run python -m gpu.sched_bench bench --dump ../out/gpu/dump-prof0 --name NAME --cfg '{"kernel":"slice","T":64,...}' [--reps 5]

Config keys: kernel v2|warp|slice (warp = one warp per battle, lanes 32, any size), T (slice turns), K (battles per series), mode requeue|handoff, W (handoff threshold, live battles),
bin (order by predicted length), streams (concurrent launches, the batch cut in that many parts), ahead (the batch cut in two
launches; the first may take battles of the second -- R4 -- and the second runs what is left).

Idle share of a launch (R8) = 1 - busy / (threads x span): busy = lane-time spent inside a battle (segment stamps; a warp-mode
segment counts all 32 lanes), threads = resident thread slots of the GPU at this kernel's occupancy (17,408 on the RTX 3080 at
8 warps/SM), span = first segment start .. last segment end over all streams of the launch.
"""
import argparse
import json
import os
import statistics
import time

import numpy as np

from . import kernel3v3 as K
from .cuda_guard import require_cuda
from .profile_kernel import load_dump, slice_of
from . import predict

SIZES = (5000, 36000)
BINS = 120
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "..", "out", "gpu", "sched"))


def resident_threads():
    cp = require_cuda()
    from cupy_backends.cuda.api import driver
    k = K.get_kernel("float")
    nb = driver.occupancyMaxActiveBlocksPerMultiprocessor(k.kernel.ptr, K.BLOCK, 0)
    return nb * cp.cuda.Device().attributes["MultiProcessorCount"] * K.BLOCK


def v2_segments(out, stream=0):
    s, e = K.stamps(out)
    return np.stack([np.full(len(s), stream, np.int64), np.arange(len(s)), s, e], 1)


def metrics(segs, streams, threads, n):
    """segs: rows (who|mode<<30, battle, t0, t1); streams: stream id per row. -> dict incl. a busy-lane timeline per stream."""
    who, t0, t1 = segs[:, 0], segs[:, 2].astype(np.int64), segs[:, 3].astype(np.int64)
    mode = (who >> 30) & 3
    lanes = np.where(mode == 1, 32, 1)
    a, z = int(t0.min()), int(t1.max())
    span = (z - a) / 1e9
    dur = (t1 - t0) / 1e9
    busy = float((dur * lanes).sum())
    warp_busy = float((dur * (mode == 1)).sum()) * 32
    edges = np.linspace(a, z, BINS + 1)
    tl = {}
    for st in np.unique(streams):
        m = streams == st
        acc = np.zeros(BINS)
        for k in range(BINS):
            lo, hi = edges[k], edges[k + 1]
            ov = np.clip(np.minimum(t1[m], hi) - np.maximum(t0[m], lo), 0, None)
            acc[k] = float((ov * lanes[m]).sum()) / (hi - lo) / threads
        tl[int(st)] = [round(x, 4) for x in acc]
    return {"span_s": span, "bps": n / span, "idle_share": 1 - busy / (threads * span), "busy_lane_s": busy,
            "warp_mode_share": warp_busy / busy if busy else 0.0, "warp_redundant_share": warp_busy * 31 / 32 / (threads * span),
            "ahead_lane_s": float((dur * (mode == 2)).sum()), "timeline": tl, "segments": int(len(segs))}


def run_cfg(static, sl, cfg):
    """One timed launch (set) of config cfg on slice sl -> (out rows in batch order, segs, stream ids, extra dict)."""
    cp = require_cuda()
    idx, dyn, seeds = sl
    n = len(seeds)
    nstr = int(cfg.get("streams", 1) or 1)
    extra = {}
    if cfg.get("kernel") == "warp":  # round-4/5 warp-per-battle: all 32 lanes of a warp run one battle (lanes=32), any size
        K.PROTO = ""
        t = time.perf_counter()
        out = K.run_3v3(static, idx, dyn, seeds, chunk=n, lanes=32)
        extra["wall_s"] = time.perf_counter() - t
        sg = v2_segments(out)
        sg[:, 0] |= 1 << 30  # warp mode: a battle occupies 32 lanes
        return out, sg, np.zeros(n, np.int64), extra
    if cfg.get("kernel", "v2") == "v2":
        K.PROTO = ""
        t = time.perf_counter()
        if nstr == 1:
            out = K.run_3v3(static, idx, dyn, seeds, chunk=n)
        else:
            out = K.run_3v3_streams(static, idx, dyn, seeds, nstreams=nstr, chunk=-(-n // nstr))
        extra["wall_s"] = time.perf_counter() - t
        part = np.minimum(np.arange(n) // -(-n // nstr), nstr - 1)
        sg = v2_segments(out)
        return out, sg, part, extra
    kw = {k: cfg[k] for k in ("T", "K", "mode", "W", "spread") if k in cfg}
    kw["bin_"] = bool(cfg.get("bin", False))
    if cfg.get("ahead"):
        t = time.perf_counter()
        out, rec = K.run_3v3_ahead(static, idx, dyn, seeds, **kw)
        extra["wall_s"] = time.perf_counter() - t
        s1, s2, rest = rec.pop("segments")
        s2 = s2.copy()
        s2[:, 1] = rest[s2[:, 1]]
        sg = np.concatenate([s1, s2])
        extra.update({"ahead_offered": rec["offered"], "ahead_taken": rec["taken"], "ahead_discarded": 0, "ahead_log": rec["taken_log"],
                      "launch_spans_s": [rec["first_span_s"], rec["second_span_s"]],
                      "gap_s": float((s2[:, 2].min() - s1[:, 3].max()) / 1e9) if len(s2) else 0.0})
        return out, sg, np.concatenate([np.zeros(len(s1), np.int64), np.ones(len(s2), np.int64)]), extra
    parts = np.array_split(np.arange(n), nstr)
    streams = [cp.cuda.Stream(non_blocking=True) for _ in parts] if nstr > 1 else [None]
    t = time.perf_counter()
    hs = [K.slice_launch(static, idx[p], dyn[p], seeds[p], stream=s, **kw) for p, s in zip(parts, streams)]
    res = [K.slice_collect(h) for h in hs]
    extra["wall_s"] = time.perf_counter() - t
    out = np.zeros((n, K.B_OUT), np.int32)
    sgs, sid = [], []
    for j, (p, (o, info)) in enumerate(zip(parts, res)):
        out[p] = o
        sg = info["segments"].copy()
        sg[:, 1] = p[sg[:, 1]]
        sgs.append(sg); sid.append(np.full(len(sg), j, np.int64))
    extra.update({"handoffs": sum(i["handoffs"] for _, i in res), "threads": res[0][1]["threads"],
                  "segments_dropped": sum(i.get("segments_dropped", 0) for _, i in res)})
    return out, np.concatenate(sgs), np.concatenate(sid), extra


def bench(static, batches, cfg, reps, ref_cache):
    threads = resident_threads()
    rows = []
    for size in SIZES:
        sl = slice_of(batches, size)
        if size not in ref_cache:
            K.PROTO = ""
            ref_cache[size] = K.run_3v3(static, *sl, chunk=size)
        ref = ref_cache[size]
        run_cfg(static, tuple(x[:256] for x in sl), cfg)  # compile / warm
        launches = []
        paired = cfg.get("kernel", "v2") != "v2" or int(cfg.get("streams", 1) or 1) > 1
        for r in range(reps):
            pv = None
            if paired:  # a v2 launch right before, so the GPU's other load (desktop, games) hits both alike
                _, psg, psid, _ = run_cfg(static, sl, {"kernel": "v2"})
                pv = metrics(psg, psid, threads, size)
            out, sg, sid, extra = run_cfg(static, sl, cfg)
            m = metrics(sg, sid, threads, size)
            if pv:
                m.update({"v2_span_s": pv["span_s"], "v2_idle_share": pv["idle_share"], "span_ratio": m["span_s"] / pv["span_s"],
                          "idle_delta": m["idle_share"] - pv["idle_share"]})
            m.update({k: v for k, v in extra.items() if k != "ahead_log"})
            if "ahead_log" in extra:
                lg = extra["ahead_log"]
                m["ahead_log"] = lg
                m["ahead_late"] = int(sum(1 for x in lg if x["end"] > x["deadline"]))
            m["same_results"] = bool((out[:, :20] == ref[:, :20]).all())
            m["flagged"] = int(((out[:, 10] & 0x6E) != 0).sum())
            launches.append(m)
            print(json.dumps({"size": size, "rep": r, "span_s": round(m["span_s"], 3), "bps": round(m["bps"], 1),
                              "idle": round(m["idle_share"], 4), "same": m["same_results"], "handoffs": m.get("handoffs"),
                              "ahead": m.get("ahead_taken"), "v2_span": round(m["v2_span_s"], 3) if "v2_span_s" in m else None,
                              "ratio": round(m["span_ratio"], 3) if "span_ratio" in m else None}), flush=True)
        idle = [l["idle_share"] for l in launches]
        span = [l["span_s"] for l in launches]
        rows.append({"size": size, "reps": reps, "threads": threads,
                     "idle_median": statistics.median(idle), "idle_min": min(idle), "idle_max": max(idle),
                     "span_median_s": statistics.median(span), "span_min_s": min(span), "span_max_s": max(span),
                     "bps_median": size / statistics.median(span), "same_results": all(l["same_results"] for l in launches),
                     **({"span_ratio_median": statistics.median(l["span_ratio"] for l in launches),
                         "span_ratio_min": min(l["span_ratio"] for l in launches), "span_ratio_max": max(l["span_ratio"] for l in launches),
                         "idle_delta_median": statistics.median(l["idle_delta"] for l in launches),
                         "v2_span_median_s": statistics.median(l["v2_span_s"] for l in launches),
                         "v2_idle_median": statistics.median(l["v2_idle_share"] for l in launches)} if launches and "span_ratio" in launches[0] else {}),
                     "launches": launches})
    return rows


def fit(static, batches, out_path):
    """Solo times (one warp per battle) on both slices; fit on 5,000, correlation on 36,000 (and on its rows not in the 5,000)."""
    res = {}
    solo = {}
    thread = {}
    for size in SIZES:
        sl = slice_of(batches, size)
        K.PROTO = ""
        o = K.run_3v3(static, *sl, chunk=size, lanes=32, block=64)
        s, e = K.stamps(o)
        solo[size] = (e - s) / 1e9
        o2 = K.run_3v3(static, *sl, chunk=size)
        s2, e2 = K.stamps(o2)
        thread[size] = (e2 - s2) / 1e9
    sl5 = slice_of(batches, 5000)
    X5 = predict.features(static, sl5[0], sl5[1])
    w = fit_w = predict.fit(X5, solo[5000])
    sl36 = slice_of(batches, 36000)
    p36 = predict.predict_s(static, sl36[0], sl36[1], w)
    p5 = predict.predict_s(static, sl5[0], sl5[1], w)
    y36 = solo[36000]
    corr = lambda a, b: float(np.corrcoef(a, b)[0, 1])
    spear = lambda a, b: corr(np.argsort(np.argsort(a)), np.argsort(np.argsort(b)))
    res = {"train": "5000 slice (solo time, LANES 32)", "n_features": len(predict.NAMES),
           "pearson_train_5000": corr(p5, solo[5000]), "pearson_36000": corr(p36, y36), "pearson_log_36000": corr(np.log(p36), np.log(y36)),
           "spearman_36000": spear(p36, y36), "pearson_36000_heldout": corr(p36[5000:], y36[5000:]),
           "spearman_36000_heldout": spear(p36[5000:], y36[5000:]),
           "pearson_thread_time_36000": corr(p36, thread[36000]),
           "thread_over_solo_median": float(np.median(thread[36000] / y36)),
           "solo_p50_s": float(np.median(y36)), "solo_max_s": float(y36.max()), "pred_p50_s": float(np.median(p36))}
    print(json.dumps(res, indent=1))
    json.dump(w, open(os.path.join(HERE, "predict-weights.json"), "w"), indent=1)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    np.save(os.path.join(os.path.dirname(out_path), "solo-36000.npy"), y36)
    json.dump(res, open(out_path, "w"), indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["fit", "bench"])
    ap.add_argument("--dump", default="../out/gpu/dump-prof0")
    ap.add_argument("--name")
    ap.add_argument("--cfg", default="{}")
    ap.add_argument("--reps", type=int, default=5)
    ap.add_argument("--out")
    a = ap.parse_args()
    require_cuda()
    static, batches = load_dump(a.dump)
    if a.cmd == "fit":
        fit(static, batches, a.out or os.path.join(OUT, "predictor.json"))
        return
    cfg = json.loads(a.cfg)
    rows = bench(static, batches, cfg, a.reps, {})
    res = {"name": a.name, "cfg": cfg, "at": time.strftime("%Y-%m-%d %H:%M:%S"), "slices": rows}
    if cfg.get("kernel") == "slice":
        res["state_bytes_per_series"] = K.slice_sizes()[0] * 8
    os.makedirs(OUT, exist_ok=True)
    json.dump(res, open(a.out or os.path.join(OUT, f"{a.name}.json"), "w"), indent=1)
    for r in rows:
        print(f"{a.name} {r['size']}: span median {r['span_median_s']:.2f}s ({r['span_min_s']:.2f}-{r['span_max_s']:.2f}), "
              f"{r['bps_median']:.0f} b/s, idle median {r['idle_median']:.3f} ({r['idle_min']:.3f}-{r['idle_max']:.3f}), same {r['same_results']}"
              + (f"; vs paired v2: span x{r['span_ratio_median']:.3f} ({r['span_ratio_min']:.3f}-{r['span_ratio_max']:.3f}), idle {r['idle_delta_median']:+.3f}" if 'span_ratio_median' in r else ""))


if __name__ == "__main__":
    main()
