"""Threads-per-battle picker (plans round 7, R1/R2/R4/R5; round 8 R9: per-GPU width calibration).

POGO_GPU_WIDTH picks how many lanes of a warp run one battle in the slice kernel (gpu/gpu/kernels/battle3v3.cuh, width sets):
    1,2,4,8,16,32  fixed width G for every launch (1 = the round-6 slice+bin path)
    mix            two widths in one launch: the top POGO_GPU_MIX_Q share of battles by predicted length (default 0.1) run
                   at POGO_GPU_MIX_WIDE lanes (default 8), the rest at POGO_GPU_MIX_NARROW (default 1); warps are split by
                   predicted work (solo-time sum per width, scaled by the width's warps per battle)
    auto           (the --gpu default) per launch: the calibration file's pick for the launch's size bucket

Calibration file: POGO_GPU_WIDTH_CALIB, else <repo>/out/gpu/width-calib-<GPU name>.json. It holds, per size bucket, each width's
b/s on identical battle sets ("same batch, twice": gpu/gpu/study/width/calib.py replays real launches at every width) and the
pick: the best width only when it beats G=1 by more than PICK_MARGIN on the same battles, else G=1 ("width does not matter here").
When the file is absent or lacks a bucket, the first auto launch of that bucket calibrates it: the identical battle set runs once
at every width G != 1 before the real launch (rows discarded; rows are identical at every width), the real launch runs at G=1
and supplies G=1's time, and the bucket's row is written to the file (logged `gpu width -- calibrating width for <GPU>… <n> s`).
Every launch logs `gpu width -- N battles, G=<g> (<rule>)` on stderr.
"""
import json
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
# round-7 bench table (gpu/gpu/width_table.py, shown by gpu/gpu-width.mjs); auto no longer reads it
TABLE_PATH = os.environ.get("POGO_GPU_WIDTH_TABLE", os.path.join(HERE, "width-table.json"))
TABLE_TOL = 0.02
WIDTHS = (1, 2, 4, 8, 16, 32)
PICK_MARGIN = 0.03  # a width is picked only when it beats G=1 by more than this (plans round 8 R9)
MODE = os.environ.get("POGO_GPU_WIDTH", "auto")
MIX_Q = float(os.environ.get("POGO_GPU_MIX_Q", "0.1"))
MIX_WIDE = int(os.environ.get("POGO_GPU_MIX_WIDE", "8"))
MIX_NARROW = int(os.environ.get("POGO_GPU_MIX_NARROW", "1"))
# launch-size buckets (upper bounds, battles); a launch belongs to the first bucket whose bound is >= its size
BUCKETS = (1500, 3500, 7000, 14000, 26000, 10 ** 9)
BUCKET_NAMES = ("<=1.5k", "1.5-3.5k", "3.5-7k", "7-14k", "14-26k", ">26k")

_dev = {}
_calib = {"rows": None, "file": None, "path": None, "pending": {}}


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def device(real="float"):
    """{name, sms, warps_per_sm, warps, threads} of the slice kernel on this GPU (cached)."""
    if real not in _dev:
        from .cuda_guard import require_cuda
        from . import kernel3v3 as K
        cp = require_cuda()
        threads = K.slice_grid(real)
        d = cp.cuda.Device()
        sms = d.attributes["MultiProcessorCount"]
        name = cp.cuda.runtime.getDeviceProperties(d.id)["name"]
        name = name.decode() if isinstance(name, bytes) else str(name)
        _dev[real] = {"name": name, "sms": sms, "warps_per_sm": threads // 32 // sms, "warps": threads // 32, "threads": threads}
    return _dev[real]


def device_line(real="float"):
    d = device(real)
    return (f"gpu device -- {d['name']}, {d['sms']} SMs x {d['warps_per_sm']} resident warps "
            f"({d['warps']} warps, {d['threads']} threads) at the slice kernel's occupancy")


def bucket_of(n):
    for k, hi in enumerate(BUCKETS):
        if n <= hi:
            return k
    return len(BUCKETS) - 1


def calib_path(dev_name):
    """Calibration file for a GPU name: POGO_GPU_WIDTH_CALIB, else out/gpu/width-calib-<name, spaces as dashes>.json."""
    p = os.environ.get("POGO_GPU_WIDTH_CALIB")
    if p:
        return p
    safe = "".join(c if c.isalnum() or c in "-_." else "-" for c in dev_name.replace(" ", "-"))
    return os.path.join(REPO, "out", "gpu", f"width-calib-{safe}.json")


def calib_row(bps, b, n, source):
    """One bucket's calibration row from {G: b/s} on identical battle sets -> dict with winner, spread %, pick and rule."""
    best = max(bps, key=lambda g: bps[g])
    worst = min(bps, key=lambda g: bps[g])
    margin = min(bps[best] / bps[g] - 1 for g in bps if g != best)
    gain = bps[best] / bps[1] - 1  # best width over G=1 on the same battles
    matters = best != 1 and gain > PICK_MARGIN
    return {"bucket": b, "name": BUCKET_NAMES[b], "launches": 1, "sizes": [n, n],
            "bps_median": {str(g): round(v, 1) for g, v in sorted(bps.items())}, "winner": best, "worst": worst,
            "spread_pct": round(100 * (bps[best] / bps[worst] - 1), 2), "winner_margin_pct": round(100 * margin, 2), "noise_pct": None,
            "pick": best if matters else 1, "source": source,
            "gain_over_g1_pct": round(100 * gain, 2),
            "rule": f"G={best} beats G=1 by {100 * gain:.1f}%" if matters else f"width does not matter here (best G={best} is {100 * gain:+.1f}% vs G=1): G=1"}


def load_calib(real="float"):
    """{bucket index: calibration row} from this GPU's calibration file (empty when absent; read once, logged once)."""
    if _calib["rows"] is None:
        dev = device(real)["name"]
        p = calib_path(dev)
        _calib.update(path=p, rows={}, file={"device": dev, "buckets": []})
        if os.path.exists(p):
            _calib["file"] = json.load(open(p))
            _calib["rows"] = {int(r["bucket"]): r for r in _calib["file"].get("buckets", [])}
            log(f"gpu width -- calibration loaded: {p} (" + ", ".join(f"{r['name']} G={r['pick']}" for r in _calib["rows"].values()) + ")")
        else:
            log(f"gpu width -- no calibration file for {dev} ({p}): each size bucket calibrates on its first launch")
    return _calib["rows"]


def _save_calib():
    f = _calib["file"]
    f["buckets"] = [_calib["rows"][b] for b in sorted(_calib["rows"])]
    f.setdefault("method", "self: first launch of each bucket replayed once at each width (G=1 = the real launch)")
    f["pick_margin"] = PICK_MARGIN
    f["widths"] = list(WIDTHS)
    os.makedirs(os.path.dirname(os.path.abspath(_calib["path"])), exist_ok=True)
    tmp = _calib["path"] + ".tmp"
    json.dump(f, open(tmp, "w"), indent=1)
    os.replace(tmp, _calib["path"])


def default_width(n, threads=None, rows=None):
    """auto's pick for an n-battle launch from the calibration file -> (G, rule string); G=1 for an uncalibrated bucket."""
    rows = load_calib() if rows is None else rows
    b = bucket_of(n)
    r = rows.get(b)
    if r is None:
        return 1, f"calib: bucket {BUCKET_NAMES[b]} not calibrated"
    return int(r["pick"]), f"calib: bucket {BUCKET_NAMES[b]}, {r['rule']}"


def mix_plan(static, idx, dyn, n, warps, q=None, wide=None, narrow=None):
    """Mixed-width plan for slice_launch (queue order is longest predicted first, so the first m battles are the long ones)."""
    from .predict import predict_s
    q = MIX_Q if q is None else q
    wide = MIX_WIDE if wide is None else wide
    narrow = MIX_NARROW if narrow is None else narrow
    m = max(1, min(n - 1, int(round(n * q)))) if n > 1 else n
    pred = predict_s(static, idx, dyn)
    if pred is None:
        share = q
    else:
        ps = np.sort(pred)[::-1]
        long_w, short_w = float(ps[:m].sum()), float(ps[m:].sum())
        # warps needed = predicted solo work / per-warp rate; a warp of k = 32/G different battles runs them at about k^0.51 x their
        # solo time (divergence; 32 battles -> 5.9x, the round-5 profile), so its rate is k / k^0.51 = k^0.49 solo-seconds per second
        rate = lambda g: (32 / g) ** 0.49
        need_l, need_s = long_w / rate(wide), short_w / rate(narrow)
        share = need_l / (need_l + need_s) if need_l + need_s > 0 else q
    ww = int(max(1, min(warps - 1, round(warps * share))))
    return {"split": m, "wide": wide, "narrow": narrow, "warps_wide": ww, "q": q}


def resolve(mode, static, idx, dyn, cfg=None, real="float"):
    """Width for one launch under mode ('auto' | 'mix' | int) -> int or mix plan dict (no logging, no calibration)."""
    n = int(idx.shape[0])
    d = device(real)
    if mode == "mix":
        c = cfg or {}
        return mix_plan(static, idx, dyn, n, d["warps"], c.get("q"), c.get("wide"), c.get("narrow"))
    if mode == "auto":
        return default_width(n, d["threads"])[0]
    return int(mode)


def _span_bps(n, info):
    sg = info["segments"]
    return n / (float(sg[:, 3].max() - sg[:, 2].min()) / 1e9) if len(sg) else 0.0


def pick(static, idx, dyn, real="float", mode=None, seeds=None):
    """Production per-launch pick under POGO_GPU_WIDTH -> (width int or mix plan, log line). auto with an uncalibrated bucket and
    seeds given: replays this battle set at every width but 1 now (the calibration), returns G=1 for the real launch, and
    finish_calibration() completes the bucket when that launch is collected."""
    mode = mode or MODE
    n = int(idx.shape[0])
    d = device(real)
    if mode == "mix":
        p = mix_plan(static, idx, dyn, n, d["warps"])
        return p, (f"gpu width -- {n} battles, G=mix {p['wide']}/{p['narrow']} (top {p['q']:.2f} by predicted length = {p['split']} "
                   f"battles on {p['warps_wide']} of {d['warps']} warps)")
    if mode == "auto":
        rows = load_calib(real)
        b = bucket_of(n)
        if b not in rows and seeds is not None and b not in _calib["pending"] and n > 0:
            from . import kernel3v3 as K
            t0 = time.perf_counter()
            bps = {}
            for G in WIDTHS[1:]:
                bps[G] = _span_bps(n, K.slice_collect(K.slice_launch(static, idx, dyn, seeds, real, width=G))[1])
            _calib["pending"][b] = {"bps": bps, "t0": t0, "n": n}
            return 1, f"gpu width -- {n} battles, G=1 (calib: bucket {BUCKET_NAMES[b]} calibrating; this launch times G=1)"
        g, rule = default_width(n, d["threads"], rows)
        return g, f"gpu width -- {n} battles, G={g} ({rule})"
    g = int(mode)
    return g, f"gpu width -- {n} battles, G={g} (fixed POGO_GPU_WIDTH={g})"


def finish_calibration(n, g, info):
    """Called by slice_collect for a picked launch: if it is the G=1 launch of a calibrating bucket, write that bucket's row."""
    b = bucket_of(n)
    p = _calib["pending"].get(b)
    if p is None or p["n"] != n or g != 1:
        return
    p["bps"][1] = _span_bps(n, info)
    secs = time.perf_counter() - p["t0"]
    row = calib_row(p["bps"], b, n, "self: first launch of the bucket, one replay per width")
    row["calib_s"] = round(secs, 1)
    _calib["rows"][b] = row
    del _calib["pending"][b]
    _save_calib()
    log(f"gpu width -- calibrating width for {device()['name']}… {secs:.1f} s (bucket {row['name']}, {n} battles: "
        + ", ".join(f"G={w} {v:.0f}" for w, v in sorted(p["bps"].items())) + f" b/s; pick G={row['pick']}, {row['rule']})")
