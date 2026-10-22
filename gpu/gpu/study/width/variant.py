"""Round 8 width fork prototype (POGO_GPU_STUDY=width; plans R9): auto width from a per-GPU calibration file, no probe.

POGO_GPU_WIDTH=auto (the default) picks, per launch, the calibration file's pick for the launch's size bucket
(gpu/gpu/width.py BUCKETS). The file is POGO_GPU_WIDTH_CALIB, else <repo>/out/gpu/width-calib-<GPU name>.json (built by
`python -m gpu.study.width.calib summarize` from the same-batch test). When the file is absent, or has no row for a bucket,
the first launch of that bucket calibrates it: the identical battle set runs once at each width G != 1 before the real launch,
and the real launch itself runs at G=1 and supplies G=1's time (slice_collect), so the cost is 5 extra launches of that size,
once per bucket per GPU. The bucket's row is then written to the file (pick = the best width if it beats G=1 by
> 3%, else G=1) and later launches/runs load it. Logs: `gpu width -- calibrating width for <GPU>… <n> s (bucket ...)` once per
calibrated bucket, `gpu width -- N battles, G=g (calib ...)` per launch. The round-7 probe is not used. Rows are identical at every
width, so the pick only changes speed."""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
WIDTHS = (1, 2, 4, 8, 16, 32)
MARGIN = 0.03


def _log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def calib_path(dev_name):
    p = os.environ.get("POGO_GPU_WIDTH_CALIB")
    if p:
        return p
    safe = "".join(c if c.isalnum() or c in "-_." else "-" for c in dev_name.replace(" ", "-"))
    return os.path.join(REPO, "out", "gpu", f"width-calib-{safe}.json")


def row_from(bps, name, b, n, source):
    """Calibration row for one bucket from {G: b/s} measured on one battle set."""
    best = max(bps, key=lambda g: bps[g])
    worst = min(bps, key=lambda g: bps[g])
    margin = min(bps[best] / bps[g] - 1 for g in bps if g != best)
    gain = bps[best] / bps[1] - 1
    matters = best != 1 and gain > MARGIN
    return {"bucket": b, "name": name, "launches": 1, "sizes": [n, n], "bps_median": {str(g): round(v, 1) for g, v in sorted(bps.items())},
            "winner": best, "worst": worst, "spread_pct": round(100 * (bps[best] / bps[worst] - 1), 2), "winner_margin_pct": round(100 * margin, 2),
            "noise_pct": None, "pick": best if matters else 1, "source": source,
            "gain_over_g1_pct": round(100 * gain, 2),
            "rule": f"G={best} beats G=1 by {100 * gain:.1f}%" if matters else f"width does not matter here (best G={best} is {100 * gain:+.1f}% vs G=1): G=1"}


def apply(K):
    from gpu import width as WD

    st = {"rows": None, "path": None, "pending": {}}

    def load():
        if st["rows"] is None:
            dev = WD.device()["name"]
            st["path"] = calib_path(dev)
            st["rows"] = {}
            st["file"] = {"device": dev, "buckets": []}
            if os.path.exists(st["path"]):
                st["file"] = json.load(open(st["path"]))
                st["rows"] = {int(r["bucket"]): r for r in st["file"]["buckets"]}
                _log(f"gpu width -- calibration loaded: {os.path.relpath(st['path'], REPO)} ({len(st['rows'])} buckets: "
                     + ", ".join(f"{r['name']} G={r['pick']}" for r in st["rows"].values()) + ")")
            else:
                _log(f"gpu width -- no calibration file for {dev} ({os.path.relpath(st['path'], REPO)}): each bucket calibrates on its first launch")
        return st["rows"]

    def save():
        f = st["file"]
        f["buckets"] = [st["rows"][b] for b in sorted(st["rows"])]
        f.setdefault("method", "self: first launch of each bucket replayed once at each width (G=1 = the real launch)")
        f["pick_margin"] = MARGIN
        f["widths"] = list(WIDTHS)
        os.makedirs(os.path.dirname(st["path"]), exist_ok=True)
        tmp = st["path"] + ".tmp"
        json.dump(f, open(tmp, "w"), indent=1)
        os.replace(tmp, st["path"])

    orig_pick = WD.pick

    def pick(static, idx, dyn, real="float", mode=None):
        mode = mode or WD.MODE
        if mode != "auto":
            return orig_pick(static, idx, dyn, real, mode)
        rows = load()
        n = int(idx.shape[0])
        b = WD.bucket_of(n)
        r = rows.get(b)
        if r is not None:
            return int(r["pick"]), f"gpu width -- {n} battles, G={r['pick']} (calib: bucket {WD.BUCKET_NAMES[b]}, {r['rule']})"
        if b in st["pending"]:  # a second launch of the bucket started before the first one was collected
            return 1, f"gpu width -- {n} battles, G=1 (calib: bucket {WD.BUCKET_NAMES[b]} calibrating)"
        # calibrate on this battle set: every width but 1 now (timed, rows discarded); the real launch runs at G=1 and is timed in collect
        t0 = time.perf_counter()
        bps = {}
        seeds = st["seeds"]
        for G in WIDTHS[1:]:
            out, info = K.slice_collect(K.slice_launch(static, idx, dyn, seeds, real, width=G))
            sg = info["segments"]
            bps[G] = n / (float(sg[:, 3].max() - sg[:, 2].min()) / 1e9)
        st["pending"][b] = {"bps": bps, "t0": t0, "n": n}
        return 1, f"gpu width -- {n} battles, G=1 (calib: bucket {WD.BUCKET_NAMES[b]} calibrating, this launch times G=1)"

    orig_launch = K.slice_launch
    orig_collect = K.slice_collect

    def slice_launch(static, idx, dyn, seeds, real="float", **kw):
        st["seeds"] = seeds
        h = orig_launch(static, idx, dyn, seeds, real, **kw)
        if h.get("picked") and h.get("n"):
            b = WD.bucket_of(int(h["n"]))
            p = st["pending"].get(b)
            if p is not None and "h" not in p and p["n"] == h["n"]:
                p["h"] = id(h)
        return h

    def slice_collect(h):
        out, info = orig_collect(h)
        if h.get("n"):
            b = WD.bucket_of(int(h["n"]))
            p = st["pending"].get(b)
            if p is not None and p.get("h") == id(h):
                sg = info["segments"]
                p["bps"][1] = h["n"] / (float(sg[:, 3].max() - sg[:, 2].min()) / 1e9)
                secs = time.perf_counter() - p["t0"]
                row = row_from(p["bps"], WD.BUCKET_NAMES[b], b, int(h["n"]), "self: first launch of the bucket, 1 replay per width")
                row["calib_s"] = round(secs, 1)
                st["rows"][b] = row
                del st["pending"][b]
                save()
                _log(f"gpu width -- calibrating width for {WD.device()['name']}… {secs:.1f} s (bucket {row['name']}, {h['n']} battles: "
                     + ", ".join(f"G={g} {v:.0f}" for g, v in sorted(p["bps"].items())) + f" b/s; pick G={row['pick']}, {row['rule']})")
        return out, info

    WD.pick = pick
    WD.PROBE = False
    WD.probe_report = lambda *a, **k: None
    K.slice_launch = slice_launch
    K.slice_collect = slice_collect
