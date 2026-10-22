"""Study "split" measurements on dumped launches (run under the GPU lock, from gpu/):

    POGO_GPU_STUDY=split uv run python -m gpu.study.split.measure prof  --dump DIR --batches 0,1,2 --out FILE.json
    POGO_GPU_STUDY=split uv run python -m gpu.study.split.measure bench --dump DIR --batches 0,1,2 --widths auto,4,8 --reps 3 --out FILE.json

prof:  the production picker's width per launch, kernel with SPLIT_PROF counters and without SPLIT (= production code path):
       per battle cycles in the whole battle loop vs inside runScenario's sims, ideal split time at G = 2/4/8 (each call's
       combinations cut in chunks of G, chunk time = its longest sim), calls by number of shield combinations, per decision
       type. Then the same with SPLIT on (actual split time, accepted / rejected guesses, which words differed on a reject).
bench: per launch and width, production kernel vs split kernel on the same battles: span (first start .. last end of the
       launch's battles), rows compared (cols 0..19) to production at the same width and to production at the picker's width.
"""
import argparse
import json
import os
import time

import numpy as np

from ... import kernel3v3 as K
from ... import width as WD
from ...cuda_guard import require_cuda
from ...profile_kernel import load_dump
from . import variant as V

def use(kind):
    """kind: prod | split | prof (SPLIT_PROF only) | profsplit. Rebuilds K.source and clears every compiled-kernel cache."""
    if kind == "prod":
        K.source = _prod_source
    else:
        V.SPLIT = kind in ("split", "profsplit")
        V.PROF = kind in ("prof", "profsplit")
        K.source = V.source
    K._mods.clear(); K._cache.clear(); K._slot.clear(); WD._dev.clear()


def _prod_source():
    d = os.path.join(os.path.dirname(K.__file__), "kernels")
    return "\n".join(open(os.path.join(d, f)).read() for f in ("pvp1v1.cuh", "battle1v1.cuh", "battle3v3.cuh"))


def slice_mod():
    return K._mods[("float", K.MAXQ, None, tuple(K.DEFAULT_DEFINES) + ("SLICE",))]


def run(static, b, width=None, prof=False):
    cp = require_cuda()
    idx, dyn, seeds = b
    n = len(seeds)
    K.get_kernel("float", defines=tuple(K.DEFAULT_DEFINES) + ("SLICE",), name="battle3v3_slice")
    d_prof = d_mism = None
    if prof:
        mod = slice_mod()
        d_prof = cp.zeros((n * 32,), cp.uint64)
        d_mism = cp.zeros((4096,), cp.uint32)
        for name, arr in (("g_prof", d_prof), ("g_mism", d_mism)):
            g = mod.get_global(name)
            cp.ndarray((1,), cp.uint64, g)[...] = arr.data.ptr
    cp.cuda.Stream.null.synchronize()
    t = time.perf_counter()
    out, info = K.slice_collect(K.slice_launch(static, idx, dyn, seeds, width=width))
    wall = time.perf_counter() - t
    sg = info["segments"]
    span = float((sg[:, 3].max() - sg[:, 2].min()) / 1e9)
    r = {"n": n, "width": info["width"], "span_s": span, "wall_s": wall}
    if prof:
        r["prof"] = cp.asnumpy(d_prof).reshape(n, 32).astype(np.int64)
        r["mism"] = cp.asnumpy(d_mism)
    s, e = K.stamps(out)
    r["battle_s"] = (e - s) / 1e9
    return out, r


def prof_summary(P, battle_s):
    tot, sc = P[:, 0].astype(float), P[:, 1].astype(float)
    ideal = P[:, 2:5].astype(float)
    i_long = int(np.argmax(battle_s))
    q90 = battle_s >= np.quantile(battle_s, 0.9)
    def bound(mask):
        t, c = tot[mask].sum(), sc[mask].sum()
        out = {"inner_share": c / t}
        for k, g in enumerate((2, 4, 8)):
            new = t - c + ideal[mask, k].sum()
            out[f"ideal_speedup_G{g}"] = t / new
            out[f"amdahl_G{g}_perfect"] = 1 / ((1 - c / t) + c / t / g)
        return out
    calls = P[:, 9].sum()
    hist = P[:, 11:21].sum(0)
    names = ["evalMatchup", "decideSwitch", "decideShield", "other"]
    dec = {names[k]: {"calls_per_battle": float(P[:, 21 + k].mean()), "sims_per_battle": float(P[:, 25 + k].mean()),
                      "share_of_scenario_cycles": float(P[:, 5 + k].sum() / max(sc.sum(), 1))} for k in range(4)}
    return {"battles": int(len(P)), "all": bound(np.ones(len(P), bool)), "slowest_10pct": bound(q90),
            "longest": {**bound(np.arange(len(P)) == i_long), "innerSims": int(P[i_long, 31]), "calls": int(P[i_long, 9]),
                        "battle_s": float(battle_s[i_long])},
            "scenario_calls_per_battle": float(calls / len(P)), "sims_per_battle": float(P[:, 10].mean()),
            "sims_per_call": float(P[:, 10].sum() / max(calls, 1)),
            "calls_by_combinations": {str(c): int(hist[c]) for c in range(1, 10) if hist[c]},
            "share_of_calls_with_1_combination": float(hist[1] / max(calls, 1)),
            "decisions": dec, "accepted_guesses": int(P[:, 29].sum()), "rejected_chunks": int(P[:, 30].sum())}


def cmd_prof(a):
    static, batches = load_dump(a.dump)
    res = {"dump": a.dump, "launches": []}
    for bi in [int(x) for x in a.batches.split(",")]:
        b = batches[bi]
        rec = {"batch": bi}
        use("prof")
        out0, r0 = run(static, b, prof=True)
        rec["width"] = r0["width"]
        rec["nosplit"] = prof_summary(r0["prof"], r0["battle_s"])
        rec["nosplit"]["span_s"] = r0["span_s"]
        use("profsplit")
        rec["split_width"] = r0["width"] if a.widths == "auto" else int(a.widths)
        out1, r1 = run(static, b, width=rec["split_width"], prof=True)
        rec["split"] = prof_summary(r1["prof"], r1["battle_s"])
        rec["split"]["span_s"] = r1["span_s"]
        rec["split"]["scenario_cycles_vs_nosplit"] = float(r1["prof"][:, 1].sum() / r0["prof"][:, 1].sum())
        rec["split"]["battle_cycles_vs_nosplit"] = float(r1["prof"][:, 0].sum() / r0["prof"][:, 0].sum())
        rec["rows_equal"] = bool((out0[:, :20] == out1[:, :20]).all())
        rec["rows_differ"] = int((out0[:, :20] != out1[:, :20]).any(1).sum())
        m = r1["mism"]
        nz = np.nonzero(m)[0]
        rec["reject_words"] = {int(i): int(m[i]) for i in nz[np.argsort(-m[nz])][:20]}
        res["launches"].append(rec)
        print(json.dumps({k: v for k, v in rec.items()}, default=float)[:3000], flush=True)
    json.dump(res, open(a.out, "w"), indent=1, default=float)


def cmd_bench(a):
    static, batches = load_dump(a.dump)
    res = {"dump": a.dump, "reps": a.reps, "rows": []}
    for bi in [int(x) for x in a.batches.split(",")]:
        b = batches[bi]
        use("prod")
        ref, r = run(static, b)
        auto_w = r["width"]
        for w in a.widths.split(","):
            width = auto_w if w == "auto" else int(w)
            row = {"batch": bi, "n": len(b[2]), "width": width, "auto_width": auto_w}
            for kind in ("prod", "split"):
                use(kind)
                run(static, b, width=width)  # compile + warm
                spans, outs = [], None
                for _ in range(a.reps):
                    o, rr = run(static, b, width=width)
                    spans.append(rr["span_s"])
                    outs = o
                row[kind] = {"span_s": spans, "median_s": float(np.median(spans)), "max_battle_s": float(rr["battle_s"].max()),
                             "p50_battle_s": float(np.median(rr["battle_s"]))}
                row[kind]["rows_equal_auto_prod"] = bool((outs[:, :20] == ref[:, :20]).all())
            row["split_over_prod"] = row["split"]["median_s"] / row["prod"]["median_s"]
            res["rows"].append(row)
            print(json.dumps(row), flush=True)
    # split at each width vs production at the picker's width
    for bi in {r["batch"] for r in res["rows"]}:
        rows = [r for r in res["rows"] if r["batch"] == bi]
        base = next((r["prod"]["median_s"] for r in rows if r["width"] == r["auto_width"]), None)
        for r in rows:
            r["split_over_prod_auto"] = r["split"]["median_s"] / base if base else None
    json.dump(res, open(a.out, "w"), indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("prof", "bench"))
    ap.add_argument("--dump", required=True)
    ap.add_argument("--batches", default="0,1,2")
    ap.add_argument("--widths", default="auto")
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    {"prof": cmd_prof, "bench": cmd_bench}[a.cmd](a)


if __name__ == "__main__":
    main()
