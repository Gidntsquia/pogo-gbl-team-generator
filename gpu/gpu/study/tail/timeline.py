"""Round 9 R3: SM-active over time of the three real launches, tail filler off vs on (clock timers, no Nsight needed).

    cd gpu && POGO_GPU_STUDY=tail uv run python -m gpu.study.tail.timeline [--dump ../out/gpu/study/prof/dump] [--out F]

Launches as in round 8: 5k = dump batch 7, 10k = batch 6, 36k = batches 0+1+2 merged. Each runs through the tail kernel three
ways: off (no pool: the production schedule), tail (pool = the next round's stand-in, below) and certain (same pool, all fed
through the in-kernel queue after the first finished main row). Pool stand-in: the first 6,000 battles of another dumped batch
(5k: batch 6, 10k: batch 7, 36k: batch 3). From the segment records (thread | SM id, mode, battle, t0, t1), up to the last
main battle's end (when the host gets its rows): SM-active share (mean over SMs of the time any battle runs on it), the busy-SM
count per time bin split main / pool, and the tail share (time after half the main battles ended / main span).
-> out/gpu/study/prof/tail-timeline.json
"""
import argparse
import json
import time

import numpy as np

from ... import kernel3v3 as K
from ...profile_kernel import load_dump

LAUNCH = {"5k": ([7], 6), "10k": ([6], 7), "36k": ([0, 1, 2], 3)}
BINS = 120


def union(t0, t1):
    if not len(t0):
        return 0.0
    o = np.argsort(t0)
    a, b = t0[o], t1[o]
    tot, cs, ce = 0.0, a[0], b[0]
    for x, y in zip(a[1:], b[1:]):
        if x > ce:
            tot += ce - cs
            cs, ce = x, y
        else:
            ce = max(ce, y)
    return tot + ce - cs


def run(T, static, main, pool, mode, reps):
    mi, md, ms = main
    n = len(ms)
    nT = 60
    pi, pd, ps = pool if mode != "off" else (x[:0] for x in pool)
    nP = len(ps)
    meta = {"mainTag": (np.arange(n) % nT * 2 + np.arange(n) % 2).astype(np.int32), "poolTeam": (np.arange(nP) % nT).astype(np.int32),
            "priorPts": np.zeros(nT, np.float32), "priorN": np.zeros(nT, np.float32), "keepK": (nT + 1) // 2,
            "spec": mode != "off", "certain": mode == "certain"}
    best = None
    for _ in range(reps):
        t0 = time.perf_counter()
        h = T.tail_launch(static, mi, md, ms, (pi, pd, ps), meta)
        fed = 0
        if mode == "certain":
            while not T.done(h):
                if T.peek(h)[:, 3].sum() > 0:
                    fed = T.feed(h, np.arange(nP, dtype=np.int32))
                    break
                time.sleep(0.02)
        while not T.done(h):
            time.sleep(0.005)
        wall = time.perf_counter() - t0
        out, pdone, info = T.tail_collect(h)
        while T._ZOMBIES:
            time.sleep(0.05)
            T._reap()
        rec = {"wall_s": wall, "info": info, "fed": fed, "pdone": int(pdone.sum()) if nP else 0}
        if best is None or wall < best["wall_s"]:
            best = rec
    return best


def describe(rec, n):
    info = rec["info"]
    sg = info["segments"].astype(np.int64)
    who, mode = sg[:, 0] & 0x3FFFFFFF, sg[:, 0] >> 30
    sm = (who >> 20) & 255
    st0 = sg[:, 2].min()
    t0, t1 = (sg[:, 2] - st0) / 1e9, (sg[:, 3] - st0) / 1e9
    main = mode != 3
    ends = {}
    for b, e in zip(sg[main, 1], t1[main]):
        ends[b] = max(ends.get(b, 0.0), e)
    e = np.sort(np.fromiter(ends.values(), float))
    span = float(e[-1])
    half = float(e[(len(e) - 1) // 2])
    t1c = np.minimum(t1, span)
    keep = t0 < span
    nsm = int(sm.max()) + 1
    edges = np.linspace(0, span, BINS + 1)
    busy = {"main": np.zeros(BINS), "pool": np.zeros(BINS)}
    act = []
    for s in range(nsm):
        m = keep & (sm == s)
        act.append(union(t0[m], t1c[m]) / span)
        for kind, km in (("main", main), ("pool", ~main)):
            mm = m & km
            for k in range(BINS):
                lo, hi = edges[k], edges[k + 1]
                if ((t0[mm] < hi) & (t1c[mm] > lo)).any():
                    busy[kind][k] += 1
    both = np.zeros(BINS)
    for s in range(nsm):
        m = keep & (sm == s)
        for k in range(BINS):
            lo, hi = edges[k], edges[k + 1]
            both[k] += ((t0[m] < hi) & (t1c[m] > lo)).any()
    return {"n": n, "pool": info["pool"], "host_wall_s": round(rec["wall_s"], 3), "main_span_s": round(span, 3),
            "tail_s": round(span - half, 3), "tail_share_pct": round(100 * (span - half) / span, 1),
            "sm_active_share_pct": round(100 * float(np.mean(act)), 1), "sms": nsm, "bin_s": span / BINS,
            "busy_sms": [int(x) for x in both], "busy_sms_main": [int(x) for x in busy["main"]], "busy_sms_pool_only": [int(x) for x in both - busy["main"]],
            "pool_started": info["started"], "pool_kept": info["kept"], "pool_discarded": info["discarded"],
            "fed": rec["fed"], "from_certain": info["from_certain"], "returned_early": info["returned_early"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", default="../out/gpu/study/prof/dump")
    ap.add_argument("--out", default="../out/gpu/study/prof/tail-timeline.json")
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--np", type=int, default=6000)
    a = ap.parse_args()
    T = K.TAIL
    static, batches = load_dump(a.dump)
    doc = {"note": __doc__.split("\n\n", 2)[2].strip(), "reps": a.reps, "launches": {}}
    for name, (mb, pb) in LAUNCH.items():
        main_ = tuple(np.concatenate([batches[i][j] for i in mb]) for j in range(3))
        pool = tuple(x[: a.np] for x in batches[pb])
        doc["launches"][name] = {}
        for mode in ("off", "tail", "certain"):
            r = describe(run(T, static, main_, pool, mode, a.reps), len(main_[2]))
            doc["launches"][name][mode] = r
            print(json.dumps({"launch": name, "mode": mode, **{k: v for k, v in r.items() if not k.startswith("busy")}}), flush=True)
    json.dump(doc, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
