"""Round 8 width fork (plans R9): the "same batch, twice" width test on real dumped launches.

  cd gpu && uv run python -m gpu.study.width.calib run --dumps ../out/gpu/study/width/dump-std,... [--per-bucket 10]
  cd gpu && uv run python -m gpu.study.width.calib summarize [--out ../out/gpu/width-calib-<GPU>.json]

run: picks up to --per-bucket launches per size bucket (gpu/gpu/width.py BUCKETS) from the dumps (evenly spaced over each
bucket's launches in dump order) and, for each launch replays that launch's identical battle set
at every width G in WIDTHS twice, in palindrome order (1,2,4,8,16,32,32,16,8,4,2,1: every width has the same mean position, so
slow drift favours none). One GPU-lock hold runs whole launch sets until --hold-budget (9 min) is used. Timed: kernel span (first segment start .. last segment end, the kernel's own clock) and host wall
(launch .. collect). Rows (cols 0..19, everything but the start/end stamps) must be identical across all 12 replays; the raw
row per launch is out/gpu/study/width/raw/<dump>-<batch>.json (an existing file is skipped, so the run resumes).
summarize: per bucket each width's median b/s over the launches (b/s of a launch = battles / mean span of its two replays),
the winner, spread % (best / worst - 1), noise % (median |rep1 - rep2| / mean over every launch and width), the paired
median ratio of each width to G=1 (winner, spread and margin come from these paired ratios), and the pick: the best width
when it beats G=1 by more than PICK_MARGIN on the same launches, else G=1 "width does not matter here".
"""
import argparse
import fcntl
import glob
import signal
import subprocess
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
OUT = os.path.join(REPO, "out", "gpu", "study", "width")
LOCK = os.path.join(REPO, "out", "gpu", "study", "gpu.lock")
WIDTHS = (1, 2, 4, 8, 16, 32)
PICK_MARGIN = 0.03


WANTS = os.path.join(REPO, "out", "gpu", "study", "chain.wants")


def chain_wants():
    """True while the chain waits for the GPU: chain.wants < 60 min old and the chain busy (out/gpu/study/width/chainwants.sh)."""
    if not (os.path.exists(WANTS) and time.time() - os.path.getmtime(WANTS) < 3600):
        return False
    return subprocess.call(["bash", os.path.join(OUT, "chainwants.sh")]) == 0


def wait_chain():
    """Yield to the chain: wait while out/gpu/study/chain.wants exists and is under 60 min old (out/gpu/study/gpulock.sh rule)."""
    while chain_wants():
        time.sleep(5)


class _Timeout(Exception):
    pass


def _alarm(*_):
    raise _Timeout()


def acquire(lk):
    """Take gpu.lock but yield to the chain: block in flock at most 10 s at a time and re-check chain.wants before and after each try."""
    while True:
        wait_chain()
        signal.signal(signal.SIGALRM, _alarm)
        signal.alarm(10)  # block in flock for at most 10 s, then re-check chain.wants
        try:
            fcntl.flock(lk, fcntl.LOCK_EX)
        except _Timeout:
            continue
        finally:
            signal.alarm(0)
        if chain_wants():
            fcntl.flock(lk, fcntl.LOCK_UN)  # the chain asked while we were taking it: give it back
            continue
        return


def log(msg):
    sys.stderr.write(time.strftime("%H:%M:%S ") + msg + "\n")
    sys.stderr.flush()


def batch_sizes(d):
    """[(file, n)] of a dump dir, in launch order (size from the file length; see profile_kernel.load_dump)."""
    from gpu.pack import D_N
    per = 6 * 4 + 6 * D_N * 8 + 4
    return [(f, os.path.getsize(f) // per) for f in sorted(glob.glob(os.path.join(d, "batch-*.bin")))]


def load_one(f, n):
    from gpu.pack import D_N
    raw = open(f, "rb").read()
    o1, o2 = n * 24, n * 24 + n * 6 * D_N * 8
    return (np.frombuffer(raw, "<i4", n * 6, 0).reshape(n, 6).copy(), np.frombuffer(raw, "<f8", n * 6 * D_N, o1).reshape(n, 6, D_N).copy(),
            np.frombuffer(raw, "<u4", n, o2).copy())


_static = {}


def static_of(d):
    if d not in _static:
        from gpu.pack import pack_static
        _static[d] = np.stack([pack_static(m) for m in json.load(open(os.path.join(d, "mons.json")))])
    return _static[d]


def choose(dumps, per_bucket):
    """{bucket: [(dump, file, n)]}: up to per_bucket launches per bucket, evenly spaced over the bucket's launches."""
    from gpu import width as WD
    allb = {}
    for d in dumps:
        for f, n in batch_sizes(d):
            if n > 0:
                allb.setdefault(WD.bucket_of(n), []).append((d, f, n))
    pick = {}
    for b, rows in sorted(allb.items()):
        if len(rows) <= per_bucket:
            pick[b] = rows
        else:
            ix = np.unique(np.round(np.linspace(0, len(rows) - 1, per_bucket)).astype(int))
            pick[b] = [rows[i] for i in ix]
    return pick, {b: len(r) for b, r in allb.items()}


def replay(K, static, sl, G):
    """One launch at width G -> (rows [n,24], kernel span s, host wall s, segments dropped)."""
    idx, dyn, seeds = sl
    t = time.perf_counter()
    out, info = K.slice_collect(K.slice_launch(static, idx, dyn, seeds, width=G))
    wall = time.perf_counter() - t
    sg = info["segments"]
    span = float(sg[:, 3].max() - sg[:, 2].min()) / 1e9 if len(sg) else wall
    return out, span, wall, int(info.get("segments_dropped", 0))


def same_batch(K, static, sl, widths=WIDTHS, reps=2, warm=2000):
    """The paired test on one battle set: palindrome order over widths x reps -> dict with per-run spans and the rows check."""
    # reps=2: palindrome pair per width; reps=1 (capped big launches): each width once, then G=1 again for a noise estimate
    order = list(widths) + list(widths)[::-1] if reps == 2 else list(widths) + [widths[0]] if reps == 1 else [g for _ in range(reps) for g in widths]
    if warm:
        w = min(warm, len(sl[2]))
        K.slice_collect(K.slice_launch(static, sl[0][:w], sl[1][:w], sl[2][:w], width=1))
    ref = None
    runs = []
    same = True
    for k, G in enumerate(order):
        out, span, wall, drop = replay(K, static, sl, G)
        sys.stderr.write(f"   replay {k} G={G} span {span:.1f}s\n")
        sys.stderr.flush()
        rows = out[:, :20]
        if ref is None:
            ref = rows.copy()
        elif not np.array_equal(ref, rows):
            same = False
        runs.append({"pos": k, "G": G, "span_s": round(span, 4), "wall_s": round(wall, 4), "seg_dropped": drop})
    return {"runs": runs, "rows_identical": same, "order": order}


def cmd_run(a):
    from gpu import width as WD
    from gpu import kernel3v3 as K
    dumps = [os.path.abspath(d) for d in a.dumps.split(",")]
    pick, avail = choose(dumps, a.per_bucket)
    raw = a.raw
    os.makedirs(raw, exist_ok=True)
    plan = {WD.BUCKET_NAMES[b]: {"available": avail[b], "chosen": [(os.path.basename(d), os.path.basename(f), n) for d, f, n in r]} for b, r in pick.items()}
    json.dump({"dumps": [os.path.relpath(d, REPO) for d in dumps], "per_bucket": a.per_bucket, "plan": plan}, open(os.path.join(raw, "..", f"plan-{os.path.basename(raw)}.json"), "w"), indent=1)
    for b, r in plan.items():
        log(f"bucket {b}: {len(r['chosen'])} of {r['available']} launches")
    todo = [(b, d, f, n) for b, rows in sorted(pick.items(), key=lambda kv: -kv[0] if a.big_first else kv[0]) for d, f, n in rows]
    todo = [t for t in todo if a.only_bucket is None or str(t[0]) in a.only_bucket.split(",")]
    todo = [t for t in todo if not os.path.exists(os.path.join(raw, f"{os.path.basename(t[1])}-{os.path.basename(t[2])[:-4]}.json"))]
    while todo:
        with open(LOCK, "w") as lk:  # one lock hold runs whole launch sets (all 12 replays of a launch) until the hold budget is used
            t0 = time.time()
            acquire(lk)
            waited = time.time() - t0
            t1 = time.time()
            first = True
            while todo:
                b, d, f, n = todo[0]
                est = (12 if a.reps == 2 else 7) * n / 1500.0 + 5
                if a.stop_at and time.time() + est > a.stop_at:
                    log(f"stop: next launch would end after --stop-at; {len(todo)} launches left undone")
                    return
                if not first and time.time() - t1 + est > a.hold_budget:
                    break
                first = False
                todo.pop(0)
                name = f"{os.path.basename(d)}-{os.path.basename(f)[:-4]}"
                static = static_of(d)
                sl = load_one(f, n)
                t2 = time.time()
                res = same_batch(K, static, sl, reps=a.reps)
                took = time.time() - t2
                rec = {"launch": name, "dump": os.path.relpath(d, REPO), "batch": os.path.basename(f), "n": int(n), "bucket": int(b),
                       "bucket_name": WD.BUCKET_NAMES[b], "device": WD.device()["name"], "lock_wait_s": round(waited, 1),
                       "set_s": round(took, 1), "at": time.strftime("%F %T %Z"), **res}
                json.dump(rec, open(os.path.join(raw, name + ".json"), "w"), indent=1)
                waited = 0.0
                sp = {g: [r["span_s"] for r in res["runs"] if r["G"] == g] for g in WIDTHS}
                log(f"{name} n={n} {WD.BUCKET_NAMES[b]} held {took:.0f}s rows {'same' if res['rows_identical'] else 'DIFFER'}: "
                    + " ".join(f"G={g} {n / np.mean(v):.0f}" for g, v in sp.items()))


# why a bucket has fewer than 10 paired launches (plans R9 asks for >= 10 or the count and the reason)
SHORT = {
    "3.5-7k": "8 paired launches: every 3.5-7k launch in the dumps (standard run 8 of 43; the small and 2x-population runs have none); "
              "an extra dump run did not fit in the GPU time left before the 05:00 ET hand-back",
    "14-26k": "5 paired launches: every 14-26k launch in the dumps (standard run 1, 2x-population run 4); "
              "an extra dump run did not fit in the GPU time left before the 05:00 ET hand-back",
}
REPS_NOTE = {
    ">26k": "only the 2x-population run launches >26k (the standard run peaks at 18000); capped at one replay per width plus a "
            "second G=1 replay (noise is from the G=1 pair) to fit the time left",
}


def summarize(raw_dir, device_name=None, min_launches=1):
    """raw rows -> calibration dict (see module doc)."""
    from gpu import width as WD
    rows = [json.load(open(p)) for p in sorted(glob.glob(os.path.join(raw_dir, "*.json")))]
    buckets = []
    for b, bname in enumerate(WD.BUCKET_NAMES):
        rs = [r for r in rows if r["bucket"] == b]
        if len(rs) < min_launches:
            continue
        per = []  # per launch: {G: b/s}
        noise = []
        for r in rs:
            d = {}
            for g in WIDTHS:
                v = [x["span_s"] for x in r["runs"] if x["G"] == g]
                d[g] = r["n"] / float(np.mean(v))
                if len(v) == 2:
                    noise.append(abs(v[0] - v[1]) / np.mean(v))
            per.append(d)
        med = {g: float(np.median([p[g] for p in per])) for g in WIDTHS}
        ratio = {g: float(np.median([p[g] / p[1] for p in per])) for g in WIDTHS}
        # winner, spread and margin from the paired ratios (each width's b/s over G=1's on the same launch): launches' absolute b/s
        # swing 3x with battle mix, so medians of raw b/s across launches would mix launch difficulty into the width comparison
        best = max(ratio, key=lambda g: ratio[g])
        worst = min(ratio, key=lambda g: ratio[g])
        margin = min(ratio[best] / ratio[g] - 1 for g in WIDTHS if g != best)
        nz = float(np.median(noise)) if noise else None
        gain = ratio[best] - 1  # best width over G=1 on the same launches
        matters = best != 1 and gain > PICK_MARGIN
        buckets.append({
            "bucket": b, "name": bname, "launches": len(rs), "sizes": [min(r["n"] for r in rs), max(r["n"] for r in rs)],
            "bps_median": {str(g): round(v, 1) for g, v in med.items()},
            "ratio_to_g1_median": {str(g): round(v, 4) for g, v in ratio.items()},
            "winner": best, "worst": worst, "spread_pct": round(100 * (ratio[best] / ratio[worst] - 1), 2),
            "winner_margin_pct": round(100 * margin, 2), "noise_pct": round(100 * nz, 2) if nz is not None else None,
            "noise_p90_pct": round(100 * float(np.quantile(noise, 0.9)), 2) if noise else None,
            "rows_identical": all(r["rows_identical"] for r in rs),
            "reps": sorted({len([x for x in r["runs"] if x["G"] == 2]) for r in rs}),  # replays per width G != 1
            **({"note": SHORT[bname]} if bname in SHORT and len(rs) < 10 else {}),
            **({"note_reps": REPS_NOTE[bname]} if bname in REPS_NOTE else {}),
            "pick": best if matters else 1,
            "gain_over_g1_pct": round(100 * gain, 2),
            "rule": f"G={best} beats G=1 by {100 * gain:.1f}% (> {100 * PICK_MARGIN:.0f}%)" if matters
            else f"width does not matter here (best G={best} is {100 * gain:+.1f}% vs G=1, not > {100 * PICK_MARGIN:.0f}%): G=1",
        })
    dev = device_name or (rows[0]["device"] if rows else "unknown")
    return {"device": dev, "built": time.strftime("%F %T %Z"), "method": "same batch, twice: each launch replayed at every width, "
            "2 reps in palindrome order (1 rep where reps says so); b/s = battles / kernel span; winner/spread/margin from the median "
            "per-launch ratio to G=1 (ratio_to_g1_median), bps_median is the plain median b/s per width", "pick_margin": PICK_MARGIN, "widths": list(WIDTHS),
            "source": os.path.relpath(raw_dir, REPO), "buckets": buckets}


def calib_name(dev):
    return "width-calib-" + "".join(c if c.isalnum() or c in "-_." else "-" for c in dev.replace(" ", "-")) + ".json"


def cmd_summarize(a):
    c = summarize(a.raw)
    out = a.out or os.path.join(REPO, "out", "gpu", calib_name(c["device"]))
    json.dump(c, open(out, "w"), indent=1)
    print(f"wrote {out}")
    for r in c["buckets"]:
        print(f"{r['name']:>9} n={r['launches']:2d} winner G={r['winner']:<2d} spread {r['spread_pct']:5.2f}%  margin {r['winner_margin_pct']:5.2f}%  "
              f"noise {r['noise_pct']}%  pick G={r['pick']}  rows {'same' if r['rows_identical'] else 'DIFFER'}  "
              + " ".join(f"G={g} {v:.0f}" for g, v in r["bps_median"].items()))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--dumps", required=True)
    r.add_argument("--per-bucket", type=int, default=10)
    r.add_argument("--big-first", action="store_true")
    r.add_argument("--raw", default=os.path.join(OUT, "raw"))
    r.add_argument("--hold-budget", type=float, default=540.0, help="seconds of launch sets per GPU-lock hold")
    r.add_argument("--only-bucket", default=None, help="comma list of bucket indexes")
    r.add_argument("--reps", type=int, default=2, help="replays per width (2 = palindrome pair)")
    r.add_argument("--stop-at", type=float, default=0, help="epoch seconds: take no launch that would end later")
    s = sub.add_parser("summarize")
    s.add_argument("--raw", default=os.path.join(OUT, "raw"))
    s.add_argument("--out", default=None)
    a = ap.parse_args()
    {"run": cmd_run, "summarize": cmd_summarize}[a.cmd](a)


if __name__ == "__main__":
    main()
