"""Build gpu/gpu/width-table.json (the round-7 bench table, plans round 7 R4; since round 8 auto reads the width calibration file instead) from the fixed-width benches.

  cd gpu && uv run python -m gpu.width_table [--bench-dir ../out/gpu/width]

Reads bench-w<G>.json (gpu.sched_bench bench --sizes ..., one per width G) and writes, per launch-size bucket of gpu/gpu/width.py,
each width's median b/s at the bench size inside that bucket."""
import argparse
import json
import os
import time

from . import width as WD

WIDTHS = WD.WIDTHS


def build(bench_dir):
    per = {}  # size -> {G: bps}
    for g in WIDTHS:
        p = os.path.join(bench_dir, f"bench-w{g}.json")
        if not os.path.exists(p):
            continue
        for row in json.load(open(p))["slices"]:
            per.setdefault(int(row["size"]), {})[g] = float(row["bps_median"])
    buckets = []
    for size in sorted(per):
        b = WD.bucket_of(size)
        if any(r["bucket"] == b for r in buckets):
            continue
        bps = per[size]
        best = max(bps, key=lambda g: bps[g])
        buckets.append({"bucket": b, "name": WD.BUCKET_NAMES[b], "bench_size": size, "bps": {str(g): round(v, 1) for g, v in sorted(bps.items())},
                        "best": best})
    return {"built": time.strftime("%Y-%m-%d %H:%M:%S"), "source": os.path.relpath(bench_dir, WD.HERE),
            "device": WD.device_line(), "tolerance": WD.TABLE_TOL, "buckets": buckets}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bench-dir", default=os.path.normpath(os.path.join(WD.HERE, "..", "..", "out", "gpu", "width")))
    ap.add_argument("--out", default=WD.TABLE_PATH)
    a = ap.parse_args()
    t = build(a.bench_dir)
    json.dump(t, open(a.out, "w"), indent=1)
    for r in t["buckets"]:
        print(f"{r['name']:>9} ({r['bench_size']}): best G={r['best']}  " + "  ".join(f"G={g} {v:.0f}" for g, v in r["bps"].items()))


if __name__ == "__main__":
    main()
