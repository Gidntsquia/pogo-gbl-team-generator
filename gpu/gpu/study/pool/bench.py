"""pool fork bench on dumped real launches (POGO_GPU_DUMP). Run from gpu/ under the GPU lock:

    uv run python -m gpu.study.pool.bench dist  --dump D --out F.json        production rows: poolMax distribution per launch
    uv run python -m gpu.study.pool.bench bench --dump D --out F.json --q 512 [--stack S] [--repeat 2]
        each launch alternately on production and on the small pool + re-run; rows (cols 0..19) compared to production,
        wall (launch -> rows on the host, incl. the re-run) and kernel span (first battle start .. last end, from the stamps)
"""
import argparse
import json
import time

import numpy as np

from ... import kernel3v3 as K
from ...profile_kernel import load_dump
from . import variant

QS = (128, 192, 256, 320, 384, 512, 640, 768, 1024, 1536, 2048)


def span_s(out):
    s, e = K.stamps(out)
    return float(e.max() - s.min()) / 1e9


def run(launch, collect, static, b):
    cp = K.require_cuda()
    cp.cuda.Stream.null.synchronize()
    t0 = time.perf_counter()
    out, info = collect(launch(static, *b, "float", width=None))
    return out, info, time.perf_counter() - t0


def dist(static, batches, out_path):
    allpm, rec = [], []
    for k, b in enumerate(batches):
        out, info, wall = run(K.slice_launch, K.slice_collect, static, b)
        pm = out[:, 13]
        allpm.append(pm)
        rec.append({"launch": k, "n": int(len(pm)), "p50": int(np.percentile(pm, 50)), "p90": int(np.percentile(pm, 90)),
                    "p99": int(np.percentile(pm, 99)), "max": int(pm.max()), "flagged": int(np.count_nonzero(out[:, 10] & 0x6E)),
                    "wall_s": wall, "span_s": span_s(out), "over": {q: int(np.count_nonzero(pm >= q)) for q in QS}})
        print(json.dumps(rec[-1]), flush=True)
    pm = np.concatenate(allpm)
    tot = {"n": int(len(pm)), "mean": float(pm.mean()), "p50": int(np.percentile(pm, 50)), "p90": int(np.percentile(pm, 90)),
           "p99": int(np.percentile(pm, 99)), "p999": int(np.percentile(pm, 99.9)), "max": int(pm.max()),
           "over": {q: int(np.count_nonzero(pm >= q)) for q in QS},
           "over_pct": {q: 100.0 * np.count_nonzero(pm >= q) / len(pm) for q in QS},
           "launches_with_over": {q: sum(1 for r in rec if r["over"][q]) for q in QS},
           "hist_edges": [0, 50, 100, 150, 200, 300, 400, 512, 768, 1024, 1536, 2048],
           "hist": np.histogram(pm, [0, 50, 100, 150, 200, 300, 400, 512, 768, 1024, 1536, 2049])[0].tolist()}
    print(json.dumps(tot), flush=True)
    json.dump({"launches": rec, "total": tot}, open(out_path, "w"), indent=1)


def bench(static, batches, out_path, q, stack, repeat):
    vl, vc = variant.make(K, q=q, stack=stack)
    rec = []
    for k, b in enumerate(batches):
        r = {"launch": k, "n": int(len(b[2])), "prod_wall": [], "var_wall": [], "prod_span": [], "var_span": []}
        ref = None
        for _ in range(repeat):
            o1, _, w1 = run(K.slice_launch, K.slice_collect, static, b)
            K._set_stack(K.require_cuda(), 65536)
            o2, i2, w2 = run(vl, vc, static, b)
            K._set_stack(K.require_cuda(), 65536)
            ref = o1 if ref is None else ref
            r["equal"] = r.get("equal", True) and bool(np.array_equal(o1[:, :20], o2[:, :20])) and bool(np.array_equal(ref[:, :20], o1[:, :20]))
            r["prod_wall"].append(w1); r["var_wall"].append(w2); r["prod_span"].append(span_s(o1)); r["var_span"].append(span_s(o2))
            r["pool"] = i2.get("pool")
        r["ratio_wall"] = min(r["var_wall"]) / min(r["prod_wall"])
        rec.append(r)
        print(json.dumps(r), flush=True)
    tw = lambda key: sum(min(r[key]) for r in rec)
    tot = {"q": q, "stack": stack, "repeat": repeat, "launches": len(rec), "battles": sum(r["n"] for r in rec),
           "all_equal": all(r["equal"] for r in rec), "rerun_rows": sum(r["pool"]["rerun"] for r in rec),
           "still_flagged": sum(r["pool"]["still_flagged"] for r in rec), "rerun_s": sum(r["pool"]["rerun_s"] for r in rec),
           "prod_wall_s": tw("prod_wall"), "var_wall_s": tw("var_wall"), "prod_span_s": tw("prod_span"), "var_span_s": tw("var_span")}
    tot["ratio_wall"] = tot["var_wall_s"] / tot["prod_wall_s"]
    tot["ratio_span"] = tot["var_span_s"] / tot["prod_span_s"]
    tot["prod_bps"] = tot["battles"] / tot["prod_wall_s"]
    tot["var_bps"] = tot["battles"] / tot["var_wall_s"]
    print(json.dumps(tot), flush=True)
    json.dump({"launches": rec, "total": tot}, open(out_path, "w"), indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=("dist", "bench"))
    ap.add_argument("--dump", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--q", type=int, default=512)
    ap.add_argument("--stack", type=int, default=65536)
    ap.add_argument("--repeat", type=int, default=2)
    ap.add_argument("--launches", default="", help="comma list of launch indexes (default all)")
    a = ap.parse_args()
    static, batches = load_dump(a.dump)
    if a.launches:
        batches = [batches[int(i)] for i in a.launches.split(",")]
    if a.mode == "dist":
        dist(static, batches, a.out)
    else:
        bench(static, batches, a.out, a.q, a.stack, a.repeat)


if __name__ == "__main__":
    main()
