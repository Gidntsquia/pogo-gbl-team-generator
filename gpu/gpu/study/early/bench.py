"""Fork "early": standalone replay of halving steps with the real slice kernel, baseline vs early start.

    cd gpu && flock ../out/gpu/study/gpu.lock uv run python -m gpu.study.early.bench <capture dir> [--gens 1,2] [--reps 3]

Inputs: a capture (capture.sh: dump/ batches + cap/ rows) and its certainty.json (certainty.py).
For each chosen generation (3 halving rounds = 3 launches k1, k2, k3 in the dump):
  baseline: L1, host gap, L2, host gap, L3 one after another (what production does);
  early:    L1 on stream A; at t_rel (from the captured round-1 certainty curve) the round-2 battles of the teams already
            certain are launched on stream B (a second, concurrent kernel that gets the SMs L1's retiring blocks free);
            when L1 ends: host gap, the rest of round 2 on stream A; then the same for round 3 (release time from the
            round-2 certainty recomputed on THIS run's own stamps of the previous early rep, falling back to "no release").
The host gap (accumulate + plan + pack + transport between dependent launches) is a sleep of --gap seconds (default from
the baseline gpu-profile.json: (plan + pack + transport + accumulate) / steps).
Checks: every row (cols 0..19) equals the captured production row of the same battle; after each early rep the release
is re-checked with that rep's own end stamps (every released battle's owners were certain at the moment of release given
only battles finished by then). Writes <capture>/bench.json.
"""
import json
import math
import os
import sys
import time

import numpy as np

from ... import kernel3v3 as K
from ... import width as WD
from ...profile_kernel import load_dump
from .certainty import Round, load_capture, stamps


def ns(o, c):
    """64-bit %globaltimer stamp from row cols c, c+1 (one clock for every stream)."""
    o = np.asarray(o).astype(np.int64)
    return (o[:, c] & 0xFFFFFFFF) | ((o[:, c + 1] & 0xFFFFFFFF) << 32)


def launch(static, b, sel, stream):
    idx, dyn, seeds = b[0][sel], b[1][sel], b[2][sel]
    if len(sel) == 0:
        return None
    w, _ = WD.pick(static, idx, dyn)
    return K.slice_launch(static, np.ascontiguousarray(idx), np.ascontiguousarray(dyn), np.ascontiguousarray(seeds), width=w, stream=stream)


def collect(h):
    if h is None:
        return np.zeros((0, K.B_OUT), np.int32)
    return K.slice_collect(h)[0]


def released(round_info, t, rd, next_ev, launches_cap, end_override=None):
    """Next-round fresh battle indices owned by at least one team certain at time t (end stamps of this round)."""
    if end_override is not None:
        rd.end = end_override
    lo, hi = rd.bounds(t)
    c, _ = rd.certain(lo, hi, round_info["keep"])
    alive = round_info["alive"]
    cg = {alive[i] for i in np.nonzero(c)[0]}
    nx_alive = next_ev["round"]["alive"]
    rel = set()
    for row in next_ev["plan"]:
        if nx_alive[int(row[0])] in cg:
            for ix in (int(row[2]), int(row[3])):
                if ix >= 0:
                    rel.add(ix)
    return np.array(sorted(rel), dtype=np.int64), int(c.sum())


def main():
    d = os.path.abspath(sys.argv[1])
    arg = lambda k, dflt: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else dflt
    reps = int(arg("--reps", "3"))
    gap = float(arg("--gap", "0.23"))  # baseline gen-3 profile: (plan 0.21 + pack 0.10 + transport 0.23 + accumulate 0.15) / 3 steps
    frac = float(arg("--release-at", "0.5"))  # release when this fraction of the certain set reachable at span is known
    static, batches = load_dump(os.path.join(d, "dump"))
    evals, cap = load_capture(d)
    gens, cur = [], None
    for ev in evals:
        if ev["round"] is None:
            continue
        if ev["round"]["r"] == 0:
            cur = []; gens.append(cur)
        cur.append(ev)
    want = [int(x) for x in arg("--gens", ",".join(str(i) for i in range(1, len(gens)))).split(",")]
    res = {"capture": d, "gap_s": gap, "reps": reps, "gens": []}
    import cupy as cp
    sA, sB = cp.cuda.Stream(non_blocking=True), cp.cuda.Stream(non_blocking=True)
    for g in want:
        rounds = gens[g]
        ks = [ev["launch0"] for ev in rounds]
        assert all(rounds[i]["launch1"] - rounds[i]["launch0"] == 1 for i in range(3)), "one launch per round expected"
        B = [batches[k] for k in ks]
        ref = [cap[k] for k in ks]
        n = [len(b[2]) for b in B]
        # captured-run release plan for round 1 -> 2
        rd1 = Round(rounds[0], stamps(ref[0])[1])
        span1 = float(stamps(ref[0])[1].max())
        cands = []
        for t in np.linspace(0, span1, 41):
            rel, nc = released(rounds[0]["round"], t, rd1, rounds[1], cap)
            cands.append((float(t), len(rel), nc))
        full = cands[-1][1]
        t_rel1 = next(t for t, m, _ in cands if m >= frac * full) if full else span1
        rel1, nc1 = released(rounds[0]["round"], t_rel1, rd1, rounds[1], cap)
        gr = {"gen": g, "battles": n, "t_rel1_planned": t_rel1, "released1": len(rel1), "certain1": nc1, "curve1": cands,
              "baseline": [], "early": []}
        rest_of = lambda m, rel: np.setdiff1d(np.arange(m), rel)
        rel2 = np.zeros(0, np.int64); t_rel2 = None
        for rep in range(reps):
            # ---- baseline
            t0 = time.perf_counter()
            outs = []
            for i in range(3):
                h = launch(static, B[i], np.arange(n[i]), sA)
                outs.append(collect(h))
                if i < 2:
                    time.sleep(gap)
            wall = time.perf_counter() - t0
            same = all(np.array_equal(outs[i][:, :20], ref[i][:, :20]) for i in range(3))
            gr["baseline"].append({"wall_s": wall, "spans": [float(stamps(o)[1].max() - 0) for o in outs], "rows_equal": same})
            # ---- early
            t0 = time.perf_counter()
            hA = launch(static, B[0], np.arange(n[0]), sA)
            tl = time.perf_counter()
            while time.perf_counter() - tl < t_rel1:
                time.sleep(0.002)
            hB = launch(static, B[1], rel1, sB)
            o1 = collect(hA)
            time.sleep(gap)
            rest1 = rest_of(n[1], rel1)
            hA2 = launch(static, B[1], rest1, sA)
            # round 3 release (planned from the previous rep's stamps): wait until t_rel2 after L2rest launch
            hB2 = None
            if t_rel2 is not None and len(rel2):
                tl2 = time.perf_counter()
                while time.perf_counter() - tl2 < t_rel2:
                    time.sleep(0.002)
                hB2 = launch(static, B[2], rel2, sB)
            o2b = collect(hB); o2a = collect(hA2)
            time.sleep(gap)
            rest2 = rest_of(n[2], rel2)
            hA3 = launch(static, B[2], rest2, sA)
            o3b = collect(hB2); o3a = collect(hA3)
            wall_e = time.perf_counter() - t0
            o2 = np.zeros_like(ref[1]); o2[rel1] = o2b; o2[rest1] = o2a
            o3 = np.zeros_like(ref[2]); o3[rel2] = o3b; o3[rest2] = o3a
            same_e = all(np.array_equal(o[:, :20], r[:, :20]) for o, r in ((o1, ref[0]), (o2, ref[1]), (o3, ref[2])))
            # re-check release 1 with this rep's own stamps (globaltimer is one clock for both streams)
            st1, e1ns = ns(o1, 20), ns(o1, 22)
            sB_ns = ns(o2b, 20).min() if len(o2b) else None
            ok1 = True
            if sB_ns is not None:
                rdc = Round(rounds[0], (e1ns - st1.min()) / 1e9)
                chk, _ = released(rounds[0]["round"], (sB_ns - st1.min()) / 1e9, rdc, rounds[1], cap)
                ok1 = set(rel1.tolist()) <= set(chk.tolist())
            # plan round-3 release for the next rep from this rep's round-2 stamps
            e2 = ns(o2, 22); s2a0 = ns(o2a, 20).min() if len(o2a) else ns(o2, 20).min()
            rd2 = Round(rounds[1], (e2 - s2a0) / 1e9)  # times relative to the start of the rest-of-round-2 launch
            span2 = float(((e2 - s2a0) / 1e9).max())
            c2 = []
            for t in np.linspace(0, span2, 41):
                r2, nc = released(rounds[1]["round"], t, rd2, rounds[2], cap)
                c2.append((float(t), len(r2), nc))
            ok2 = True
            if hB2 is not None and len(o3b):
                sB2 = ns(o3b, 20).min()
                chk2, _ = released(rounds[1]["round"], (sB2 - s2a0) / 1e9, rd2, rounds[2], cap)
                ok2 = set(rel2.tolist()) <= set(chk2.tolist())
            gr["early"].append({"wall_s": wall_e, "rows_equal": same_e, "release1_valid": bool(ok1), "release2_valid": bool(ok2),
                                "released2": int(len(rel2)), "t_rel2": t_rel2, "curve2": c2})
            full2 = c2[-1][1]
            # next rep's round-3 release: same rule, with a 0.1 s safety margin on this rep's own timing
            t2 = next((t for t, m, _ in c2 if m >= frac * full2), None) if full2 else None
            if t2 is not None:
                t_rel2 = t2 + 0.1
                rel2, _ = released(rounds[1]["round"], t2, rd2, rounds[2], cap)
            print(f"gen {g} rep {rep}: baseline {wall:.3f}s rows {same}; early {wall_e:.3f}s rows {same_e} "
                  f"(rel1 {len(rel1)}/{n[1]} at {t_rel1:.2f}s valid {ok1}; rel2 {gr['early'][-1]['released2']}/{n[2]} valid {ok2})", flush=True)
        res["gens"].append(gr)
    json.dump(res, open(os.path.join(d, "bench.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
