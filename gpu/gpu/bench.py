"""Benchmark the CUDA kernels against pvpoke run serially (numbers from gpu/serial-baseline.mjs).

    uv run python -m gpu.bench [--data ../out/gpu] [--real float] [--sims 10000] [--battles 1000] [--sizes 1000,5000,36000]

1v1: >= 10,000 simulate() scenarios (the exported distinct gen-0 sims, tiled up if there are fewer) timed as one
     kernel call INCLUDING host->device and device->host transfer, and again through the JSON-lines sidecar.
3v3: >= 1,000 real gen-0 battles vs battleTeams run serially in node; the same 1,000-battle batch through the JSON-lines
     and the binary sidecar; whole-generation batch sizes (tiled up from the export) with GPU memory used; single vs
     multi-stream; a forced oversize split. Results also written to <data>/bench.json.
Run `node gpu/serial-baseline.mjs --battles 1000` first for the pvpoke side (writes out/gpu/serial.json).
"""
import argparse
import json
import os
import subprocess
import sys
import time

import numpy as np

from .cuda_guard import require_cuda
from .kernel1v1 import run_1v1, get_kernel as k1
from .kernel3v3 import run_3v3, run_3v3_streams, run_3v3_split, load_battles, get_kernel as k3
from .pack import load_static, load_sims


def best(fn, reps=3):
    ts = []
    for _ in range(reps):
        t = time.perf_counter()
        r = fn()
        ts.append(time.perf_counter() - t)
    return min(ts), r


def sidecar_roundtrip(data, op, count, real):
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    p = subprocess.Popen([sys.executable, "-m", "gpu.sidecar"], cwd=here, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    p.stdout.readline()
    req = json.dumps({"op": op, "real": real, "data": data, "start": 0, "count": count}) + "\n"
    p.stdin.write(req); p.stdin.flush(); p.stdout.readline()  # warm: loads files, compiles-cache
    t = time.perf_counter()
    p.stdin.write(req); p.stdin.flush()
    resp = json.loads(p.stdout.readline())
    total = time.perf_counter() - t
    p.stdin.write('{"op":"quit"}\n'); p.stdin.flush(); p.stdin.close()
    try:
        p.wait(timeout=30)
    except subprocess.TimeoutExpired:
        p.kill()
    return total, resp["ms"] / 1000


def binary_roundtrip(data, idx, dyn, seeds, real, reps=3, via_file=False):
    """Time BATCH3 through `python -m gpu.sidecar --binary` (raw arrays over stdin/stdout). Returns (best total s, kernel s)."""
    import json as _json
    from . import wire
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    p = subprocess.Popen([sys.executable, "-m", "gpu.sidecar", "--binary"], cwd=here, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    wire.read_exact(p.stdout, wire.HDR.size)
    mons = _json.load(open(f"{data}/mons.json")); j = _json.dumps(mons).encode()
    p.stdin.write(wire.pack_header(wire.STATIC, len(j)) + j); p.stdin.flush()
    wire.read_exact(p.stdout, wire.HDR.size)
    n = len(seeds)
    body = np.ascontiguousarray(idx, "<i4").tobytes() + np.ascontiguousarray(dyn, "<f8").tobytes() + np.ascontiguousarray(seeds, "<u4").tobytes()
    req = wire.pack_header(wire.BATCH3, n, 1 if real == "double" else 0) + body
    best_t, kus = 1e9, 0
    for _ in range(reps + 1):  # first call compiles/warms
        t = time.perf_counter()
        p.stdin.write(req); p.stdin.flush()
        op, rn, arg, cols, pieces = wire.unpack_header(wire.read_exact(p.stdout, wire.HDR.size))
        wire.read_exact(p.stdout, rn * cols * 4)
        dt = time.perf_counter() - t
        if _ > 0 and dt < best_t:
            best_t, kus = dt, arg
    p.stdin.write(wire.pack_header(wire.QUIT)); p.stdin.flush(); p.stdin.close()
    try:
        p.wait(timeout=30)
    except subprocess.TimeoutExpired:
        p.kill()
    return best_t, kus / 1e6


def gpu_mem_mb():
    """Device memory in use by everything on the GPU (nvidia-style free/total from the runtime), MB."""
    import cupy as cp
    free, total = cp.cuda.runtime.memGetInfo()
    return (total - free) / 2**20


def tile(arr, n):
    reps = -(-n // len(arr))
    return np.concatenate([arr] * reps)[:n]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="../out/gpu")
    ap.add_argument("--real", default="float")
    ap.add_argument("--sims", type=int, default=10000)
    ap.add_argument("--battles", type=int, default=1000)
    ap.add_argument("--sizes", default="1000,5000,36000")
    ap.add_argument("--skip-1v1", action="store_true", help="3v3 sections only (the 1v1 sidecar section loads the 800 MB sims.json twice)")
    a = ap.parse_args()
    require_cuda()
    st = load_static(f"{a.data}/mons.json")
    serial = json.load(open(f"{a.data}/serial.json")) if os.path.exists(f"{a.data}/serial.json") else None

    if not a.skip_1v1:
        idx, dyn, _, sims = load_sims(f"{a.data}/sims.json")
        distinct = len(idx)
        reps = -(-a.sims // distinct)
        idx_t, dyn_t = np.tile(idx, (reps, 1)), np.tile(dyn, (reps, 1, 1))
        idx_t, dyn_t = idx_t[:a.sims], dyn_t[:a.sims]
        k1(a.real)
        t1, _ = best(lambda: run_1v1(st, idx_t, dyn_t, a.real, 64))
        print(f"1v1 [{a.real}]: {a.sims} sims ({distinct} distinct, tiled x{reps}) in {t1 * 1000:.0f} ms incl. transfer -> {a.sims / t1:,.0f} sims/s")
        ts, ks = sidecar_roundtrip(a.data, "1v1", a.sims, a.real)
        print(f"1v1 via JSON-lines sidecar: {ts * 1000:.0f} ms round trip ({ks * 1000:.0f} ms kernel+transfer) -> {a.sims / ts:,.0f} sims/s")
        if serial:
            print(f"1v1 pvpoke serial: {serial['simsPerS']:,.0f} sims/s ({serial['innerSims']} sims in {serial['simSeconds']:.1f} s of simulate()) "
                  f"-> kernel x{a.sims / t1 / serial['simsPerS']:.2f}, with sidecar x{a.sims / ts / serial['simsPerS']:.2f}")

    bidx, bdyn, bseeds, bs = load_battles(f"{a.data}/battles.json", tag="gen0")
    n = min(a.battles, len(bs))
    k3(a.real)
    run_3v3(st, bidx[:64], bdyn[:64], bseeds[:64], a.real)  # warm
    t3, out = best(lambda: run_3v3(st, bidx[:n], bdyn[:n], bseeds[:n], a.real), reps=2)
    inner = int(out[:, 11].sum())
    print(f"3v3 [{a.real}]: {n} battles in {t3:.2f} s incl. transfer -> {n / t3:.1f} battles/s ({inner / n:.0f} inner sims/battle, {inner / t3:,.0f} inner sims/s)")
    ts3, ks3 = sidecar_roundtrip(a.data, "3v3", n, a.real)
    print(f"3v3 via JSON-lines sidecar: {ts3:.2f} s round trip ({ks3:.2f} s kernel) -> {n / ts3:.1f} battles/s")
    tb3, kb3 = binary_roundtrip(a.data, bidx[:n], bdyn[:n], bseeds[:n], a.real)
    print(f"3v3 via binary sidecar (same {n}-battle batch): {tb3:.2f} s round trip ({kb3:.2f} s kernel) -> {n / tb3:.1f} battles/s; "
          f"JSON {n / ts3:.1f} b/s vs binary {n / tb3:.1f} b/s (x{ts3 / tb3:.2f})")
    res = {"real": a.real, "kernel3v3_bps": n / t3, "sidecar_json_bps": n / ts3, "sidecar_binary_bps": n / tb3, "batch": n,
           "inner_sims_per_s": inner / t3, "inner_sims_per_battle": inner / n}
    if serial:
        print(f"3v3 pvpoke battleTeams serial (memo {'on' if serial['scenarioMemo'] else 'off'}): {serial['battlesPerS']:.2f} battles/s over {serial['battles']} battles "
              f"-> kernel x{n / t3 / serial['battlesPerS']:.2f}, JSON sidecar x{n / ts3 / serial['battlesPerS']:.2f}, binary sidecar x{n / tb3 / serial['battlesPerS']:.2f}")
        res["serial_bps"] = serial["battlesPerS"]
        memo_path = f"{a.data}/serial-memo.json"
        if os.path.exists(memo_path):
            m = json.load(open(memo_path))
            print(f"3v3 pvpoke serial (memo on): {m['battlesPerS']:.2f} battles/s -> kernel x{n / t3 / m['battlesPerS']:.2f}")
            res["serial_memo_bps"] = m["battlesPerS"]
    else:
        print("no serial.json: run `node gpu/serial-baseline.mjs --battles 1000` for the pvpoke side")

    # whole-generation batch sizes (the export has ~1,500 distinct battles; larger batches repeat them, which costs the same per battle)
    gidx, gdyn, gseeds, _ = load_battles(f"{a.data}/battles.json", tag="gen0")
    res["sizes"] = []
    base_mem = gpu_mem_mb()
    for size in [int(x) for x in a.sizes.split(",")]:
        i3, d3, s3 = tile(gidx, size), tile(gdyn, size), tile(gseeds, size)
        try:
            t = time.perf_counter()
            out, pieces = run_3v3_split(st, i3, d3, s3, a.real)
            dt = time.perf_counter() - t
            mem = gpu_mem_mb()
            print(f"batch {size:>6}: {dt:6.2f} s -> {size / dt:6.1f} battles/s ({pieces} launch piece(s)); GPU memory in use {mem:.0f} MB (+{mem - base_mem:.0f} MB over idle/others)")
            res["sizes"].append({"size": size, "seconds": dt, "bps": size / dt, "pieces": pieces, "gpu_mb": mem, "gpu_mb_delta": mem - base_mem})
        except Exception as e:  # noqa: BLE001
            print(f"batch {size:>6}: FAILED {type(e).__name__}: {str(e)[:120]} (limit: device memory / 64 KB local stack per resident thread)")
            res["sizes"].append({"size": size, "error": f"{type(e).__name__}: {e}"[:200]})
    # CUDA streams: same batch, one stream vs several (pinned staging, async copies, chunked launches)
    sz = 5000
    i3, d3, s3 = tile(gidx, sz), tile(gdyn, sz), tile(gseeds, sz)
    run_3v3_streams(st, i3[:256], d3[:256], s3[:256], a.real, 2, 128)  # warm
    res["streams"] = {}
    for ns in (1, 2, 4):
        best_t = 1e9
        for _ in range(2):
            t = time.perf_counter()
            if ns == 1:
                run_3v3(st, i3, d3, s3, a.real, chunk=sz)
            else:
                run_3v3_streams(st, i3, d3, s3, a.real, ns, sz // ns)
            best_t = min(best_t, time.perf_counter() - t)
        res["streams"][ns] = sz / best_t
        print(f"streams={ns}: {sz} battles in {best_t:.2f} s -> {sz / best_t:.1f} battles/s")
    print(f"multi-stream vs single: x{res['streams'][2] / res['streams'][1]:.2f} (2 streams), x{res['streams'][4] / res['streams'][1]:.2f} (4 streams)")
    # oversize batch split: force a limit and show the logged split
    msgs = []
    out, pieces = run_3v3_split(st, i3[:2000], d3[:2000], s3[:2000], a.real, max_chunk=700, log=lambda m: (msgs.append(m), print(m)))
    ref = run_3v3(st, i3[:2000], d3[:2000], s3[:2000], a.real, chunk=2000)
    print(f"split run: {pieces} pieces, {len(msgs)} split(s) logged, result identical to unsplit: {bool((out == ref).all())}")
    res["split"] = {"pieces": pieces, "identical": bool((out == ref).all())}
    json.dump(res, open(f"{a.data}/bench.json", "w"), indent=1)
    print(f"wrote {a.data}/bench.json")


if __name__ == "__main__":
    main()
