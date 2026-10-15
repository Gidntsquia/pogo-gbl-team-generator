"""Kernel-side profile of the 3v3 battle kernel on real evolve launches (dumped with POGO_GPU_DUMP=<dir>).

    uv run python -m gpu.profile_kernel resources                       registers / stack / spills / occupancy per variant
    uv run python -m gpu.profile_kernel launches --dump D [--out F]     every dumped launch replayed: span, tail, longest battle
    uv run python -m gpu.profile_kernel sweep --dump D [--out F]        block-size sweep (32..1024) on the 5,000 and 36,000 slices
    uv run python -m gpu.profile_kernel order --dump D [--out F]        launch time with the slice in dumped / oracle-sorted / predicted order
    uv run python -m gpu.profile_kernel variants --dump D [--out F]     every dumped launch under each kernel variant (pool size, exit on invalid)
    uv run python -m gpu.profile_kernel divergence --dump D [--out F]   each battle alone in its warp (32 identical copies) vs mixed warps
    uv run python -m gpu.profile_kernel slices --dump D [--out F]       v1 vs v2 kernel on the 5,000 / 36,000 slices (per-fix slice saving)
    uv run python -m gpu.profile_kernel flagset --dump D [--out F]      rows the v1 kernel flags in every dumped launch, re-run alone on v2
    uv run python -m gpu.profile_kernel layout --dump D [--out F]       layout prototypes on the slices: one warp per battle (LANES 32),
                                                                       battles sorted by inner sims (oracle), grouped by team

Slices: "5000" = first 5,000 rows of the first dumped launch; "36000" = the first dumped launches concatenated up to
36,000 rows (gen 0 of a 300-team halving run is exactly 36,000 battles). Timing comes from the kernel's per-battle
%globaltimer stamps (out cols 20..23): span = first start .. last end; tail = time after half the battles finished.
"""
import argparse
import glob
import json
import os
import re
import sys
import time

import numpy as np

from .cuda_guard import require_cuda
from .kernel3v3 import run_3v3, get_kernel, stamps, source, MAXQ, BLOCK
from .pack import D_N, pack_static

SM = 68
WARPS_PER_SM = 48


def load_dump(d):
    """-> (static, [(idx, dyn, seeds), ...]) in launch order."""
    static = np.stack([pack_static(m) for m in json.load(open(os.path.join(d, "mons.json")))])
    out = []
    for f in sorted(glob.glob(os.path.join(d, "batch-*.bin"))):
        raw = open(f, "rb").read()
        n = len(raw) // (6 * 4 + 6 * D_N * 8 + 4)
        o1, o2 = n * 24, n * 24 + n * 6 * D_N * 8
        out.append((np.frombuffer(raw, "<i4", n * 6, 0).reshape(n, 6), np.frombuffer(raw, "<f8", n * 6 * D_N, o1).reshape(n, 6, D_N),
                    np.frombuffer(raw, "<u4", n, o2)))
    return static, out


def slice_of(batches, size):
    idx, dyn, seeds, k = [], [], [], 0
    for i, d, s in batches:
        take = min(len(s), size - k)
        idx.append(i[:take]); dyn.append(d[:take]); seeds.append(s[:take]); k += take
        if k >= size:
            break
    return np.concatenate(idx), np.concatenate(dyn), np.concatenate(seeds)


def timing(out):
    """Launch timing summary from the stamps."""
    s, e = stamps(out)
    t0 = s.min()
    s, e = (s - t0) / 1e9, (e - t0) / 1e9
    dur = e - s
    span = e.max()
    half = np.sort(e)[(len(e) - 1) // 2]
    n = len(e)
    # achieved occupancy: warp-resident time (first start .. last end of its 32 lanes) over SM-warp capacity x span
    nw = (n + 31) // 32
    ws = np.array([s[w * 32:(w + 1) * 32].min() for w in range(nw)])
    we = np.array([e[w * 32:(w + 1) * 32].max() for w in range(nw)])
    lane_busy = dur.sum() / ((we - ws).sum() * 32)  # share of resident lane-time doing a battle (divergence inside warps)
    i = int(np.argmax(dur))
    return {
        "n": n, "span_s": float(span), "bps": n / float(span), "tail_s": float(span - half), "tail_share": float((span - half) / span),
        "battle_p50_s": float(np.median(dur)), "battle_p90_s": float(np.quantile(dur, 0.9)), "battle_max_s": float(dur.max()),
        "battle_mean_s": float(dur.mean()),
        "longest": {"turns": int(out[i, 9]), "innerSims": int(out[i, 11]), "poolMax": int(out[i, 13]), "s": float(dur[i])},
        "inner_sims_p50": float(np.median(out[:, 11])), "inner_sims_max": int(out[:, 11].max()),
        "turns_p50": float(np.median(out[:, 9])), "turns_max": int(out[:, 9].max()),
        "corr_dur_innersims": float(np.corrcoef(dur, out[:, 11])[0, 1]), "corr_dur_turns": float(np.corrcoef(dur, out[:, 9])[0, 1]),
        "achieved_occupancy": float((we - ws).sum() / (SM * WARPS_PER_SM * span)),
        "warp_lane_efficiency": float(lane_busy),
        "flagged": int(((out[:, 10] & 0x6E) != 0).sum()), "pool_overflow": int(((out[:, 10] & 2) != 0).sum()),
    }


def ptxas(maxq=MAXQ, maxrreg=None, tries=6, defines=()):
    """ptxas verbose line for the kernel entry (the NVRTC log comes back empty on some calls; retried)."""
    from cupy_backends.cuda.libs import nvrtc
    src = "#define REAL float\n#define NO_1V1_KERNEL\n#define MAXQ %d\n%s%s" % (maxq, "".join("#define %s\n" % d for d in defines), source())
    opts = ["--std=c++14", "--fmad=false", "-arch=sm_86", "--ptxas-options=--verbose"] + ([f"--maxrregcount={maxrreg}"] if maxrreg else [])
    for _ in range(tries):
        p = nvrtc.createProgram(src, "k.cu", [], [])
        nvrtc.compileProgram(p, opts)
        log = nvrtc.getProgramLog(p)
        m = re.search(r"Compiling entry function 'battle3v3_kernel'.*?(?=Compiling entry|\Z)", log, re.S)
        if m:
            used = re.search(r"Used (\d+) registers.*?(\d+) bytes cumulative stack size", m.group(0), re.S)
            spill = re.search(r"(\d+) bytes stack frame, (\d+) bytes spill stores, (\d+) bytes spill loads", m.group(0))
            return {"registers": int(used.group(1)), "stack_bytes": int(used.group(2)),
                    "frame_bytes": int(spill.group(1)) if spill else None,
                    "spill_store_bytes": int(spill.group(2)) if spill else None, "spill_load_bytes": int(spill.group(3)) if spill else None}
    return None


def resources():
    cp = require_cuda()
    from cupy_backends.cuda.api import driver
    rows = []
    W = ("WIDE_POOL",)
    for maxq, rr, d in ((768, None, W), (768, 128, W), (768, 64, W), (1536, None, W), (2048, None, W), (3072, None, W),
                        (MAXQ, None, ()), (MAXQ, 128, ()), (MAXQ, 64, ())):
        k = get_kernel("float", maxq, rr, d)
        r = {"maxq": maxq, "pool": "wide 28 B (v1)" if d else "packed 12 B (v2)", "maxrregcount": rr, "num_regs": k.num_regs,
             "local_bytes": k.local_size_bytes, "max_block": k.max_threads_per_block}
        r.update(ptxas(maxq, rr, defines=d) or {})
        occ = {}
        for blk in (32, 64, 128, 256, 512, 1024):
            if blk <= k.max_threads_per_block:
                nb = driver.occupancyMaxActiveBlocksPerMultiprocessor(k.kernel.ptr, blk, 0)
                occ[blk] = {"blocks_per_sm": nb, "warps_per_sm": nb * blk // 32, "theoretical": nb * blk / 32 / WARPS_PER_SM, "resident_battles": nb * blk * SM}
        r["occupancy"] = occ
        rows.append(r)
        print(json.dumps(r))
    return rows


VARIANTS = {  # name -> run_3v3 kwargs
    "v1 (pool 768)": {"maxq": 768, "defines": ("WIDE_POOL",)},
    "pool 768 + exit on invalid": {"maxq": 768, "defines": ("WIDE_POOL", "EXIT_ON_INVALID")},
    "pool 2048": {"maxq": 2048, "stack": 131072, "defines": ("WIDE_POOL",)},
    "pool 2048 + exit on invalid": {"maxq": 2048, "stack": 131072, "defines": ("WIDE_POOL", "EXIT_ON_INVALID")},
    "packed pool 2048 (v2)": {},
}


def run_variants(static, batches, names):
    """Each dumped launch replayed under each variant: span, flagged, and how many valid rows differ from v1."""
    rows = []
    for k, b in enumerate(batches):
        ref = None
        for name in names:
            r, out = run_t(static, b, **VARIANTS[name])
            ok = (out[:, 10] & 0x6E) == 0
            if ref is None:
                ref = out
            both = ok & ((ref[:, 10] & 0x6E) == 0)
            rows.append({"launch": k, "variant": name, "n": r["n"], "span_s": r["span_s"], "flagged": int((~ok).sum()),
                         "pool_overflow": r["pool_overflow"], "valid_rows_differing_from_v1": int((out[both, :20 - 2] != ref[both, :18]).any(axis=1).sum()),
                         "tail_share": r["tail_share"], "battle_max_s": r["battle_max_s"], "battle_p50_s": r["battle_p50_s"]})
            print(json.dumps(rows[-1]), flush=True)
    tot = {}
    for r in rows:
        t = tot.setdefault(r["variant"], {"span_s": 0, "flagged": 0, "pool_overflow": 0, "differing": 0})
        t["span_s"] += r["span_s"]; t["flagged"] += r["flagged"]; t["pool_overflow"] += r["pool_overflow"]; t["differing"] += r["valid_rows_differing_from_v1"]
    print(json.dumps(tot))
    return {"rows": rows, "totals": tot}


def divergence(static, batches, n=1024):
    """Warp divergence: the first n battles of the 5,000 slice in their dumped (mixed) warps, then each battle
    replicated 32x so its warp runs it alone (no divergence; same instruction stream in all lanes). Compares each
    mixed warp's duration with the solo durations of its 32 battles, and the launch spans."""
    idx, dyn, seeds = slice_of(batches, n)
    rm, om = run_t(static, (idx, dyn, seeds))
    sm, em = stamps(om)
    mixed = (em - sm) / 1e9
    rep = np.repeat(np.arange(n), 32)
    rs, os_ = run_t(static, (idx[rep], dyn[rep], seeds[rep]))
    ss, es = stamps(os_)
    solo = ((es - ss) / 1e9).reshape(n, 32).max(axis=1)
    same = bool((os_[::32, :20] == om[:, :20]).all())
    nw = n // 32
    wm = mixed.reshape(nw, 32).max(axis=1)
    smax = solo.reshape(nw, 32).max(axis=1)
    smean = solo.reshape(nw, 32).mean(axis=1)
    res = {
        "n": n, "same_results": same, "mixed_span_s": rm["span_s"], "solo_launch_span_s": rs["span_s"], "solo_launch_battles": n * 32,
        "solo_battle_p50_s": float(np.median(solo)), "solo_battle_max_s": float(solo.max()), "solo_battle_mean_s": float(solo.mean()),
        "mixed_warp_mean_s": float(wm.mean()), "mixed_warp_max_s": float(wm.max()),
        "warp_over_slowest_member": float((wm / smax).mean()), "warp_over_mean_member": float((wm / smean).mean()),
        "sum_solo_over_warp": float((solo.reshape(nw, 32).sum(axis=1) / wm).mean()),
        "corr_solo_innersims": float(np.corrcoef(solo, om[:, 11])[0, 1]),
    }
    print(json.dumps(res), flush=True)
    return res


def slices(static, batches, sizes, names, repeat=2):
    """Each variant on each slice, `repeat` launches (median span). Row results of v2 vs v1 compared on rows valid in both."""
    rows = []
    for size in sizes:
        sl = slice_of(batches, size)
        ref = None
        for name in names:
            runs = [run_t(static, sl, **VARIANTS[name]) for _ in range(repeat)]
            spans = sorted(r["span_s"] for r, _ in runs)
            r, out = runs[0]
            ok = (out[:, 10] & 0x6E) == 0
            if ref is None:
                ref = out
            both = ok & ((ref[:, 10] & 0x6E) == 0)
            row = {"size": size, "variant": name, "span_s": spans[len(spans) // 2], "spans_s": spans, "bps": size / spans[len(spans) // 2],
                   "tail_share": r["tail_share"], "flagged": r["flagged"], "pool_overflow": r["pool_overflow"],
                   "battle_max_s": r["battle_max_s"], "longest": r["longest"],
                   "valid_rows_differing_from_v1": int((out[both, :18] != ref[both, :18]).any(axis=1).sum())}
            rows.append(row)
            print(json.dumps({k: row[k] for k in ("size", "variant", "span_s", "spans_s", "flagged", "valid_rows_differing_from_v1")}), flush=True)
    return rows


def flagset(static, batches):
    """R10 check: every row the v1 kernel (wide pool 768) flags invalid, collected over all dumped launches, then
    re-run alone (one launch) on the production kernel. Also reports the v2 kernel's flags over the whole dump."""
    pick, v2_flags, v2_overflow, n = [], 0, 0, 0
    for i, d, sd in batches:
        _, o1 = run_t(static, (i, d, sd), **VARIANTS["v1 (pool 768)"])
        bad = np.nonzero(o1[:, 10] & 0x6E)[0]
        pick.append((i[bad], d[bad], sd[bad], o1[bad, 10]))
        r2, _ = run_t(static, (i, d, sd))
        v2_flags += r2["flagged"]; v2_overflow += r2["pool_overflow"]; n += len(sd)
    idx = np.concatenate([p[0] for p in pick]); dyn = np.concatenate([p[1] for p in pick]); seeds = np.concatenate([p[2] for p in pick])
    f1 = np.concatenate([p[3] for p in pick])
    r, out = run_t(static, (idx, dyn, seeds))
    res = {"dump_rows": n, "v1_flagged": int(len(seeds)), "v1_pool_overflow": int(((f1 & 2) != 0).sum()),
           "v2_flagged_on_v1_set": r["flagged"], "v2_pool_overflow_on_v1_set": r["pool_overflow"],
           "v2_pool_max_on_v1_set": int(out[:, 13].max()) if len(out) else 0, "v2_span_v1_set_alone_s": r["span_s"],
           "v2_flagged_whole_dump": v2_flags, "v2_pool_overflow_whole_dump": v2_overflow}
    print(json.dumps(res), flush=True)
    return res


def layout(static, batches, sizes):
    """Prototype estimates for a layout change, measured on the slices. Each variant's results must equal the
    one-thread-per-battle run row for row (cols 0..19)."""
    rows = []
    for size in sizes:
        idx, dyn, seeds = slice_of(batches, size)
        base, out = run_t(static, (idx, dyn, seeds))
        ins = out[:, 11].astype(np.int64)
        team = np.lexsort(idx[:, ::-1].T)  # identical 6-mon rows (same teams, different seeds/opponents) side by side
        perms = {"thread per battle (v1)": None, "sorted by inner sims, desc (oracle)": np.argsort(-ins, kind="stable"),
                 "grouped by teams": team}
        for name, perm in perms.items():
            if perm is None:
                r = dict(base); same = True
            else:
                r, o2 = run_t(static, (idx[perm], dyn[perm], seeds[perm]))
                same = bool((o2[:, :20] == out[perm][:, :20]).all())
            r.update(size=size, variant=name, same_results=same, speedup=base["span_s"] / r["span_s"])
            rows.append(r)
            print(json.dumps({x: r.get(x) for x in ("size", "variant", "span_s", "bps", "tail_share", "speedup", "same_results")}), flush=True)
        r, o2 = run_t(static, (idx, dyn, seeds), lanes=32, block=64)
        r.update(size=size, variant="warp per battle (LANES 32)", same_results=bool((o2[:, :20] == out[:, :20]).all()), speedup=base["span_s"] / r["span_s"])
        rows.append(r)
        print(json.dumps({x: r.get(x) for x in ("size", "variant", "span_s", "bps", "tail_share", "speedup", "same_results")}), flush=True)
    return rows


def run_t(static, sl, **kw):
    idx, dyn, seeds = sl
    n = len(seeds)
    d = tuple(kw.get("defines", ())) + (("LANES %d" % kw["lanes"],) if kw.get("lanes", 1) > 1 else ())
    get_kernel("float", kw.get("maxq"), kw.get("maxrreg"), d)  # compile outside the timed launch
    t = time.perf_counter()
    out = run_3v3(static, idx, dyn, seeds, chunk=max(n, 1), **kw)
    wall = time.perf_counter() - t
    r = timing(out)
    r["wall_s"] = wall
    return r, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["resources", "launches", "sweep", "order", "variants", "divergence", "layout", "flagset", "slices"])
    ap.add_argument("--variants", default=",".join(VARIANTS))
    ap.add_argument("--dump")
    ap.add_argument("--out")
    ap.add_argument("--sizes", default="5000,36000")
    ap.add_argument("--max-launches", type=int, default=0)
    a = ap.parse_args()
    require_cuda()
    res = {}
    if a.cmd == "resources":
        res = {"variants": resources()}
    else:
        static, batches = load_dump(a.dump)
        if a.cmd == "launches":
            rows = []
            for k, b in enumerate(batches[: a.max_launches or None]):
                r, _ = run_t(static, b)
                r["launch"] = k
                rows.append(r)
                print(json.dumps({x: r[x] for x in ("launch", "n", "span_s", "bps", "tail_share", "battle_p50_s", "battle_max_s", "flagged")}), flush=True)
            res = {"launches": rows}
        elif a.cmd == "slices":
            res = {"slices": slices(static, batches, list(map(int, a.sizes.split(","))), a.variants.split(","))}
        elif a.cmd == "flagset":
            res = {"flagset": flagset(static, batches)}
        elif a.cmd == "layout":
            res = {"layout": layout(static, batches, list(map(int, a.sizes.split(","))))}
        elif a.cmd == "divergence":
            res = {"divergence": divergence(static, batches)}
        elif a.cmd == "variants":
            res = {"variants": run_variants(static, batches, a.variants.split(","))}
        elif a.cmd == "sweep":
            res = {"sweep": []}
            for size in map(int, a.sizes.split(",")):
                sl = slice_of(batches, size)
                for blk, rr in ((32, None), (64, None), (128, None), (256, None), (512, 128), (1024, 64)):
                    r, _ = run_t(static, sl, block=blk, maxrreg=rr)
                    r.update(size=size, block=blk, maxrregcount=rr)
                    res["sweep"].append(r)
                    print(json.dumps({x: r[x] for x in ("size", "block", "maxrregcount", "span_s", "bps", "achieved_occupancy", "tail_share")}), flush=True)
        elif a.cmd == "order":
            res = {"order": []}
            for size in map(int, a.sizes.split(",")):
                idx, dyn, seeds = slice_of(batches, size)
                base, out = run_t(static, (idx, dyn, seeds))
                s, e = stamps(out)
                dur = (e - s).astype(np.float64)
                variants = {"dumped": None, "oracle_desc": np.argsort(-dur, kind="stable"), "oracle_asc": np.argsort(dur, kind="stable")}
                for name, perm in variants.items():
                    r = base if perm is None else run_t(static, (idx[perm], dyn[perm], seeds[perm]))[0]
                    if perm is not None:
                        _, o2 = run_t(static, (idx[perm], dyn[perm], seeds[perm]))
                        r["same_results"] = bool((o2[:, :20] == out[perm][:, :20]).all())
                    r.update(size=size, order=name)
                    res["order"].append(r)
                    print(json.dumps({x: r.get(x) for x in ("size", "order", "span_s", "bps", "tail_share", "warp_lane_efficiency", "same_results")}), flush=True)
    if a.out:
        json.dump(res, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    sys.exit(main())
