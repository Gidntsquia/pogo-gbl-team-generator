"""Bench the lockstep variant against production on dumped launches (kernel-level replay, "bench" numbers).

    cd gpu && uv run python -m gpu.study.lockstep.bench --dump D [--batches 0,1,2] [--configs "T=64,spread=0;T=64,persist=1"] --save J
Production = kernel3v3.run_3v3_slice with its defaults (width picker included); rows compared on cols 0..19.
"""
import argparse
import json
import time

import numpy as np

from ... import kernel3v3 as K
from ...profile_kernel import load_dump
from . import variant as V


def prod(static, idx, dyn, seeds):
    t = time.perf_counter()
    out, info = K.run_3v3_slice(static, idx, dyn, seeds)
    wall = time.perf_counter() - t
    s, e = K.stamps(out)
    return out, {"wall_s": wall, "device_span_s": float((e.max() - s.min()) / 1e9), "width": str(info.get("width")),
                 "requeues": int(info.get("handoffs", 0))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", required=True)
    ap.add_argument("--batches", default="")
    ap.add_argument("--configs", default="T=64", help="';'-separated configs, each k=v,... of T, soa, sync, persist, spread")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--save", required=True)
    a = ap.parse_args()
    static, batches = load_dump(a.dump)
    sel = [int(x) for x in a.batches.split(",")] if a.batches else list(range(len(batches)))
    # warm up both kernels (compile)
    i0, d0, s0 = batches[sel[0]]
    K.run_3v3_slice(static, i0[:256], d0[:256], s0[:256])
    V.run_lockstep(K, static, i0[:256], d0[:256], s0[:256])
    res = []
    for b in sel:
        idx, dyn, seeds = batches[b]
        for rep in range(a.repeat):
            po, pi = prod(static, idx, dyn, seeds)
            row = {"batch": b, "n": int(len(seeds)), "rep": rep, "prod": pi, "lockstep": [],
                   "turns_p50": float(np.median(po[:, 9])), "turns_max": int(po[:, 9].max())}
            for cfg in a.configs.split(";"):
                kv = dict(x.split("=") for x in cfg.split(","))
                T, soa, sync = int(kv.get("T", 64)), int(kv.get("soa", 1)), int(kv.get("sync", 1))
                pers, spr = int(kv.get("persist", 0)), int(kv.get("spread", 0))
                lo, li = V.run_lockstep(K, static, idx, dyn, seeds, T=T, soa=soa, sync=sync, persist=pers, spread=spr)
                same = int((lo[:, :20] == po[:, :20]).all(axis=1).sum())
                act = li.pop("active"); sn = li.pop("slice_ns")
                li["cfg"] = cfg
                li["identical_rows"] = same
                li["ratio_wall_vs_prod"] = li["wall_s"] / pi["wall_s"]
                li["per_relaunch_overhead_ms"] = 1e3 * li["gap_s"] / max(1, li["slices_with_work"] - 1)
                step = max(1, len(act) // 40)
                li["active_sampled"] = [[i, act[i], round(sn[i] / 1e6, 3)] for i in range(0, len(act), step)]
                li["active_first_slices"] = act[:12]
                li["slices_over_half_active"] = int(sum(1 for x in act if x > act[0] / 2))
                row["lockstep"].append(li)
                print(json.dumps({"batch": b, "n": row["n"], "prod_wall": round(pi["wall_s"], 3), "prod_dev": round(pi["device_span_s"], 3),
                                  "cfg": cfg, "wall": round(li["wall_s"], 3), "dev": round(li["device_span_s"], 3), "kern": round(li["kernel_s"], 3),
                                  "slices": li["slices"], "ovh_ms": round(li["per_relaunch_overhead_ms"], 3),
                                  "ratio": round(li["ratio_wall_vs_prod"], 3), "same": same}), flush=True)
            res.append(row)
            json.dump(res, open(a.save, "w"), indent=1)


if __name__ == "__main__":
    main()
