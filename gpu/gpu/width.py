"""Threads-per-battle picker (plans round 7, R1/R2/R4/R5).

POGO_GPU_WIDTH picks how many lanes of a warp run one battle in the slice kernel (gpu/gpu/kernels/battle3v3.cuh, width sets):
    1,2,4,8,16,32  fixed width G for every launch (1 = the round-6 slice+bin path)
    mix            two widths in one launch: the top POGO_GPU_MIX_Q share of battles by predicted length (default 0.1) run
                   at POGO_GPU_MIX_WIDE lanes (default 8), the rest at POGO_GPU_MIX_NARROW (default 1); warps are split by
                   predicted work (solo-time sum per width, scaled by the width's warps per battle)
    auto           (the --gpu default) per launch: the fill formula below, bounded by the bench table width-table.json
POGO_GPU_PROBE=on (debug, off by default): per launch-size bucket the first launches try the default width and one step
above and below, keep the fastest, and log the convergence.

Fill formula: G_fill = clamp(pow2_floor(resident threads / battles), 1, 32), i.e. the widest power of two at which the
launch's battles still cover every resident lane once. Resident threads = SMs x resident warps per SM x 32 at the slice
kernel's occupancy, queried when the sidecar starts.
Table bound: width-table.json holds, per size bucket measured on this GPU (gpu.width_bench), each width's median b/s. Widths
within TABLE_TOL of the bucket's best are "good"; the pick is G_fill when it is good, else the good width closest to G_fill
(log2 distance, ties to the higher b/s). Every launch logs `gpu width -- N battles, G=<g> (<rule>)` on stderr.
"""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE_PATH = os.environ.get("POGO_GPU_WIDTH_TABLE", os.path.join(HERE, "width-table.json"))
WIDTHS = (1, 2, 4, 8, 16, 32)
TABLE_TOL = 0.02  # 5% let auto sit 6% under the best at 2.5k (G=4 vs G=16, out/gpu/width/recheck.log); 2% keeps it near the top
MODE = os.environ.get("POGO_GPU_WIDTH", "auto")
PROBE = os.environ.get("POGO_GPU_PROBE", "") == "on"
MIX_Q = float(os.environ.get("POGO_GPU_MIX_Q", "0.1"))
MIX_WIDE = int(os.environ.get("POGO_GPU_MIX_WIDE", "8"))
MIX_NARROW = int(os.environ.get("POGO_GPU_MIX_NARROW", "1"))
# launch-size buckets (upper bounds, battles); a launch belongs to the first bucket whose bound is >= its size
BUCKETS = (1500, 3500, 7000, 14000, 26000, 10 ** 9)
BUCKET_NAMES = ("<=1.5k", "1.5-3.5k", "3.5-7k", "7-14k", "14-26k", ">26k")

_dev = {}
_table = [None]


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


def fill_width(n, threads):
    """Widest power of two G (1..32) with n * G <= threads (1 when the launch already covers every lane)."""
    if n <= 0:
        return 32
    g = 2 ** int(math.floor(math.log2(max(1.0, threads / n))))
    return int(min(32, max(1, g)))


def load_table(path=None):
    """width-table.json -> {bucket index: {G: b/s}} (empty when absent)."""
    if path is None and _table[0] is not None:
        return _table[0]
    p = path or TABLE_PATH
    t = {}
    if os.path.exists(p):
        raw = json.load(open(p))
        for row in raw.get("buckets", []):
            t[int(row["bucket"])] = {int(g): float(v) for g, v in row["bps"].items()}
    if path is None:
        _table[0] = t
    return t


def table_pick(g_fill, row, tol=TABLE_TOL):
    """Bound the fill width by one bucket's measured b/s per width -> (G, rule)."""
    if not row:
        return g_fill, "fill"
    best = max(row.values())
    good = [g for g, v in row.items() if v >= best * (1 - tol)]
    if g_fill in good:
        return g_fill, "fill"
    lg = math.log2(g_fill)
    g = min(good, key=lambda w: (abs(math.log2(w) - lg), -row[w]))
    return g, "table"


def default_width(n, threads, table=None):
    """auto's pick for an n-battle launch -> (G, rule string)."""
    g_fill = fill_width(n, threads)
    table = load_table() if table is None else table
    b = bucket_of(n)
    g, rule = table_pick(g_fill, table.get(b))
    return g, f"{rule}: fill G={g_fill}, bucket {BUCKET_NAMES[b]}"


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


class Prober:
    """POGO_GPU_PROBE: per size bucket, try the default width, then one step below and above (more steps while the edge wins),
    keep the fastest by b/s. Converged buckets use their pick; every decision is logged."""

    def __init__(self):
        self.state = {}  # bucket -> {"default": g, "tried": {g: bps}, "queue": [g...], "pick": g | None}

    def choose(self, n, g_default):
        b = bucket_of(n)
        st = self.state.setdefault(b, {"default": g_default, "tried": {}, "queue": [g_default], "pick": None})
        if st["pick"] is not None:
            return st["pick"], f"probe: converged G={st['pick']}, bucket {BUCKET_NAMES[b]}"
        g = st["queue"][0]
        return g, f"probe: trying G={g} (default G={st['default']}), bucket {BUCKET_NAMES[b]}"

    def report(self, n, g, bps):
        b = bucket_of(n)
        st = self.state.get(b)
        if st is None or st["pick"] is not None or not st["queue"] or st["queue"][0] != g:
            return
        st["queue"].pop(0)
        st["tried"][g] = bps
        d = st["default"]
        if not st["queue"]:
            tried = st["tried"]
            best = max(tried, key=lambda w: tried[w])
            nxt = None
            lo, hi = min(tried), max(tried)
            if len(tried) == 1:
                cands = [w for w in (d // 2, d * 2) if w in WIDTHS]
                st["queue"] = cands
                if cands:
                    return
            elif best == lo and lo // 2 in WIDTHS and lo // 2 not in tried:
                nxt = lo // 2
            elif best == hi and hi * 2 in WIDTHS and hi * 2 not in tried:
                nxt = hi * 2
            if nxt:
                st["queue"] = [nxt]
                return
            st["pick"] = best
            log(f"gpu probe -- bucket {BUCKET_NAMES[b]}: tried " + ", ".join(f"G={w} {tried[w]:.0f} b/s" for w in sorted(tried))
                + f" in {len(tried)} launches; pick G={best} (default G={d})")

    def summary(self):
        return {BUCKET_NAMES[b]: {"default": s["default"], "tried": s["tried"], "pick": s["pick"]} for b, s in sorted(self.state.items())}


_prober = Prober()


def resolve(mode, static, idx, dyn, cfg=None, real="float"):
    """Width for one launch under mode ('auto' | 'mix' | int) -> int or mix plan dict (no logging)."""
    n = int(idx.shape[0])
    d = device(real)
    if mode == "mix":
        c = cfg or {}
        return mix_plan(static, idx, dyn, n, d["warps"], c.get("q"), c.get("wide"), c.get("narrow"))
    if mode == "auto":
        return default_width(n, d["threads"])[0]
    return int(mode)


def pick(static, idx, dyn, real="float", mode=None):
    """Production per-launch pick under POGO_GPU_WIDTH / POGO_GPU_PROBE -> (width int or mix plan, log line)."""
    mode = mode or MODE
    n = int(idx.shape[0])
    d = device(real)
    if mode == "mix":
        p = mix_plan(static, idx, dyn, n, d["warps"])
        return p, (f"gpu width -- {n} battles, G=mix {p['wide']}/{p['narrow']} (top {p['q']:.2f} by predicted length = {p['split']} "
                   f"battles on {p['warps_wide']} of {d['warps']} warps)")
    if mode == "auto":
        g, rule = default_width(n, d["threads"])
        if PROBE:
            g, rule = _prober.choose(n, g)
        return g, f"gpu width -- {n} battles, G={g} ({rule})"
    g = int(mode)
    return g, f"gpu width -- {n} battles, G={g} (fixed POGO_GPU_WIDTH={g})"


def probe_report(n, g, span_s):
    if PROBE and MODE == "auto" and isinstance(g, int) and span_s > 0:
        _prober.report(n, g, n / span_s)
