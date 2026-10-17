"""occ study bench: replay dumped real launches through the production slice path with each occ variant's kernel, interleaved.

    uv run python -m gpu.study.occ.bench --dump DIR --variants prod,cap128,... [--repeats 3] [--launches 0,1,2] [--width auto]
        [--out FILE]

Per variant: registers, local bytes, spills (ptxas), resident warps per SM, and per launch the kernel span (first segment
start .. last segment end, %globaltimer) for every repeat. Rows (cols 0..19) are compared with the 'prod' variant's."""
import argparse
import json
import statistics
import sys
import time

import numpy as np

from ... import kernel3v3 as K
from ... import width as WD
from ...cuda_guard import require_cuda
from ...profile_kernel import load_dump
from . import variant as V


def use(name, kernels):
    """Point kernel3v3 at variant `name` (compiled kernel cache shared per name)."""
    K.get_kernel = kernels[name]
    K.BLOCK = V.VARIANTS[name].get("block", 32)
    K._slot.clear()
    WD._dev.clear()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", required=True)
    ap.add_argument("--variants", default="prod")
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--launches", default="")
    ap.add_argument("--width", default="auto")
    ap.add_argument("--out")
    a = ap.parse_args()
    cp = require_cuda()
    from cupy_backends.cuda.api import driver
    static, batches = load_dump(a.dump)
    sel = [int(x) for x in a.launches.split(",")] if a.launches else list(range(len(batches)))
    names = a.variants.split(",")
    if "prod" not in names:
        names = ["prod"] + names
    orig = K.get_kernel
    kernels = {n: V.make_get_kernel(K, n) for n in names}
    sms = cp.cuda.Device().attributes["MultiProcessorCount"]
    res = {"dump": a.dump, "launches": sel, "sizes": [int(len(batches[i][2])) for i in sel], "width": a.width, "variants": {}}
    for n in names:
        use(n, kernels)
        t = time.perf_counter()
        k = K.get_kernel("float", defines=tuple(K.DEFAULT_DEFINES) + ("SLICE",), name="battle3v3_slice")
        nb = driver.occupancyMaxActiveBlocksPerMultiprocessor(k.kernel.ptr, K.BLOCK, 0)
        res["variants"][n] = {"num_regs": k.num_regs, "local_bytes": k.local_size_bytes, "block": K.BLOCK, "blocks_per_sm": nb,
                              "warps_per_sm": nb * K.BLOCK // 32, "threads": nb * K.BLOCK * sms, "compile_s": time.perf_counter() - t,
                              "spans": {str(i): [] for i in sel}, "walls": {str(i): [] for i in sel}, "widths": {}, "identical": {}}
        print(n, json.dumps({x: res["variants"][n][x] for x in ("num_regs", "local_bytes", "warps_per_sm", "threads")}), file=sys.stderr, flush=True)
    ref = {}
    width = None if a.width == "auto" else int(a.width)
    for rep in range(a.repeats):
        order = names[rep % len(names):] + names[:rep % len(names)]  # rotate so no variant always runs first
        for n in order:
            use(n, kernels)
            r = res["variants"][n]
            for i in sel:
                idx, dyn, seeds = batches[i]
                if width is None:
                    g, _ = WD.pick(static, idx, dyn, "float")
                else:
                    g = width
                t = time.perf_counter()
                out, info = K.run_3v3_slice(static, idx, dyn, seeds, "float", width=g)
                wall = time.perf_counter() - t
                sg = info["segments"]
                span = float(sg[:, 3].max() - sg[:, 2].min()) / 1e9
                r["spans"][str(i)].append(span)
                r["walls"][str(i)].append(wall)
                r["widths"][str(i)] = g if isinstance(g, int) else str(g)
                rows = out[:, :20]
                if n == "prod" and i not in ref:
                    ref[i] = rows.copy()
                if i in ref:
                    same = int((ref[i] == rows).all(axis=1).sum())
                    r["identical"].setdefault(str(i), []).append([same, int(len(rows))])
                print(f"rep {rep} {n} launch {i} n={len(seeds)} G={g} span {span:.3f}s", file=sys.stderr, flush=True)
    K.get_kernel = orig
    base = res["variants"]["prod"]
    for n, r in res["variants"].items():
        med = {i: statistics.median(v) for i, v in r["spans"].items()}
        r["median_span"] = med
        r["sum_median_span"] = sum(med.values())
        r["ratio_vs_prod"] = sum(statistics.median(base["spans"][i]) for i in med) / r["sum_median_span"]  # >1 = faster
        r["all_identical"] = all(s == t for v in r["identical"].values() for s, t in v) and len(r["identical"]) == len(sel)
        print(f"{n}: regs {r['num_regs']} warps/SM {r['warps_per_sm']} sum span {r['sum_median_span']:.3f}s x{r['ratio_vs_prod']:.3f} "
              f"identical {r['all_identical']}", file=sys.stderr)
    if a.out:
        json.dump(res, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
