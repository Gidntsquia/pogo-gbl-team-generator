"""Round 10 R4/R6: compare replayed launches (out/gpu/r10/replay/<launch>-<variant>-prod.npz + .launch.json from
gpu-checks.sh) against the default replay of the same launch -> out/gpu/r10/replay/summary.json.

    python3 gpu/gpu/r10/replay_cmp.py          (no GPU)
Per launch (5k, 10k, 36k) and variant: median kernel span over the reps, tail = span after 50% of the battles have finished
(median end stamp - first start, subtracted from the last end), rows identical to default (all 20 result columns; for cap
variants the flag column is compared with F_CAPPED masked out), winner agreement vs default, capped battles (flag 128)."""
import glob
import json
import os
import re

import numpy as np

R = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
D = os.path.join(R, "out/gpu/r10/replay")
F_CAPPED = 128


def load(launch, var):
    p = os.path.join(D, f"{launch}-{var}-prod.npz")
    if not os.path.exists(p):
        return None
    z = np.load(p)
    j = json.load(open(p[:-4] + ".launch.json"))
    return z, j


def tail(z):
    s, e = z["start_ns"].astype(np.int64), z["end_ns"].astype(np.int64)
    ok = (e > 0) & (s > 0)
    t0, t1 = s[ok].min(), e[ok].max()
    half = np.sort(e[ok])[len(e[ok]) // 2]
    return float((t1 - half) / 1e9), float((t1 - t0) / 1e9)


def main():
    out = {}
    names = sorted({re.match(r"(\w+)-(.+)-prod\.npz$", os.path.basename(p)).groups() for p in glob.glob(os.path.join(D, "*-prod.npz"))})
    for launch in sorted({l for l, _ in names}):
        ref = load(launch, "default")
        if not ref:
            continue
        zr, jr = ref
        tail_r, span_r = tail(zr)
        out[launch] = {"n": int(zr["rows"].shape[0]), "variants": {}}
        for l, var in names:
            if l != launch:
                continue
            z, j = load(launch, var)
            spans = [r["kernel_span_s"] for r in j["reps"]]
            tl, sp = tail(z)
            rows, rr = z["rows"], zr["rows"]
            mask = np.ones(rows.shape[1], bool)
            flags = rows[:, 10]
            cmpr = rows.copy(); cmpr[:, 10] &= ~F_CAPPED
            identical = bool(cmpr.shape == rr.shape and np.array_equal(cmpr, rr))
            agree = float(np.mean(rows[:, 0] == rr[:, 0]) * 100)
            out[launch]["variants"][var] = {
                "reps": len(spans), "kernel_span_s_median": float(np.median(spans)), "kernel_span_s": spans,
                "tail_after_50pct_s": tl, "span_of_stamps_s": sp,
                "tail_vs_default_pct": round(100 * (tl / tail_r - 1), 1) if tail_r else None,
                "span_vs_default_pct": round(100 * (float(np.median(spans)) / float(np.median([r["kernel_span_s"] for r in jr["reps"]])) - 1), 1),
                "rows_identical_to_default": identical, "winner_agreement_pct": agree,
                "capped": int(np.count_nonzero(flags & F_CAPPED)), "rows_sha1": j["rows_sha1"],
            }
    json.dump(out, open(os.path.join(D, "summary.json"), "w"), indent=1)
    for launch, d in out.items():
        for var, v in d["variants"].items():
            print(f"{launch:4s} {var:12s} span {v['kernel_span_s_median']:.2f}s ({v['span_vs_default_pct']:+.1f}%) tail {v['tail_after_50pct_s']:.2f}s ({v['tail_vs_default_pct']:+.1f}%) identical {v['rows_identical_to_default']} agree {v['winner_agreement_pct']:.2f}% capped {v['capped']}")


if __name__ == "__main__":
    main()
