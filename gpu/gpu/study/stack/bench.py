"""Stack fork bench: replay dumped real launches through the production slice kernel and the stack variant(s), alternating
A/B per repeat, in one process. Rows are compared column by column (cols 0..19; 20..23 are timing stamps).

    cd gpu && flock ../out/gpu/study/gpu.lock uv run python -m gpu.study.stack.bench --dump D [--batches 0,3] [--reps 3]
        [--configs prod,compact,compact+c0] [--out F]

A config is <src>[+c<carveout>]: src prod | compact (study/stack/kernels), carveout = preferred shared-memory percent
(0 = largest L1). Time = kernel span from the slice kernel's segment stamps (first start .. last end), and host wall."""
import argparse
import json
import time

import numpy as np

from ...cuda_guard import require_cuda
from ... import kernel3v3 as K
from ...profile_kernel import load_dump
from . import variant as V

PROD_SOURCE = K.source
PROD_GET = K.get_kernel


def _src(s):
    old, V.SRC = V.SRC, s
    try:
        return V.source()
    finally:
        V.SRC = old


_store = {}
_cur = [None]


def use(config):
    """Point K at a config's source / carveout. Each config keeps its own compiled modules (K's caches are swapped, not shared)."""
    if _cur[0] == config:
        return
    if _cur[0] is not None:
        _store[_cur[0]] = (dict(K._mods), dict(K._cache), dict(K._slot), K.get_kernel, K.source)
    src, _, c = config.partition("+c")
    K._mods.clear(); K._cache.clear(); K._slot.clear()
    if config in _store:
        m, ca, sl, gk, so = _store[config]
        K._mods.update(m); K._cache.update(ca); K._slot.update(sl); K.get_kernel, K.source = gk, so
    else:
        V.SRC = src
        K.source = (lambda s=src: _src(s)) if src != "prod" else PROD_SOURCE
        K.get_kernel = PROD_GET
        if c:
            V.CARVEOUT = int(c)
            V.apply(K)  # wraps get_kernel with the carveout
            K.source = (lambda s=src: _src(s)) if src != "prod" else PROD_SOURCE
    _cur[0] = config


def run_one(static, b, width):
    cp = require_cuda()
    idx, dyn, seeds = b
    t0 = time.perf_counter()
    out, info = K.run_3v3_slice(static, idx, dyn, seeds, width=width)
    wall = time.perf_counter() - t0
    sg = info["segments"]
    span = float((sg[:, 3].max() - sg[:, 2].min()) / 1e9) if len(sg) else float("nan")
    return out, span, wall


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", required=True)
    ap.add_argument("--batches", default="")
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--configs", default="prod,compact")
    ap.add_argument("--width", type=int, default=0, help="threads per battle G (0 = the production auto pick per launch)")
    ap.add_argument("--out")
    a = ap.parse_args()
    cp = require_cuda()
    static, batches = load_dump(a.dump)
    sel = [int(x) for x in a.batches.split(",")] if a.batches else list(range(len(batches)))
    configs = a.configs.split(",")
    from ... import width as WD
    rec = {"dump": a.dump, "configs": configs, "reps": a.reps, "launches": []}
    # compile + warm every config once (also gives the reference rows)
    ref = {}
    res = {}
    for c in configs:
        use(c)
        t = time.perf_counter()
        K.slice_grid()
        k = K.get_kernel("float", defines=tuple(K.DEFAULT_DEFINES) + ("SLICE",), name="battle3v3_slice")
        res[c] = {"compile_s": time.perf_counter() - t, "num_regs": k.num_regs, "local_bytes": k.local_size_bytes,
                  "slot_words": K._slot_words(), "grid_threads": K.slice_grid()}
        print(c, res[c], flush=True)
    rec["resources"] = res
    for bi in sel:
        b = batches[bi]
        n = len(b[2])
        use("prod")
        width = a.width or WD.pick(static, b[0], b[1], "float")[0]
        row = {"batch": bi, "n": n, "width": width, "span_s": {c: [] for c in configs}, "wall_s": {c: [] for c in configs},
               "rows_equal": {}, "flagged": {}}
        outs = {}
        for r in range(a.reps):
            for c in (configs if r % 2 == 0 else configs[::-1]):
                use(c)
                out, span, wall = run_one(static, b, width)
                row["span_s"][c].append(span); row["wall_s"][c].append(wall)
                if c not in outs:
                    outs[c] = out
                    row["flagged"][c] = int(((out[:, 10] & 0x6E) != 0).sum())
                print(f"batch {bi} n={n} G={width} rep {r} {c}: span {span:.3f} s wall {wall:.3f} s", flush=True)
        base = outs[configs[0]]
        for c in configs[1:]:
            row["rows_equal"][c] = bool(np.array_equal(base[:, :20], outs[c][:, :20]))
            row.setdefault("rows_diff", {})[c] = int((base[:, :20] != outs[c][:, :20]).any(1).sum())
        row["median_span_s"] = {c: float(np.median(v)) for c, v in row["span_s"].items()}
        row["ratio_vs_" + configs[0]] = {c: row["median_span_s"][configs[0]] / row["median_span_s"][c] for c in configs}
        print(json.dumps({k: row[k] for k in ("batch", "n", "width", "median_span_s", "rows_equal", "flagged")}), flush=True)
        rec["launches"].append(row)
    tot = {c: sum(r["median_span_s"][c] for r in rec["launches"]) for c in configs}
    rec["total_median_span_s"] = tot
    rec["speedup_vs_" + configs[0]] = {c: tot[configs[0]] / tot[c] for c in configs}
    print(json.dumps({"total_median_span_s": tot, "speedup": rec["speedup_vs_" + configs[0]]}))
    if a.out:
        json.dump(rec, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
