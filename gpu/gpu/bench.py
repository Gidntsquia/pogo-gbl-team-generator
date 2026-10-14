"""Benchmark the CUDA kernels against pvpoke run serially (numbers from gpu/serial-baseline.mjs).

    uv run python -m gpu.bench [--data ../out/gpu] [--real float] [--sims 10000] [--battles 1000]

1v1: >= 10,000 simulate() scenarios (the exported distinct gen-0 sims, tiled up if there are fewer) timed as one
     kernel call INCLUDING host->device and device->host transfer, and again through the JSON-lines sidecar.
3v3: >= 1,000 real gen-0 battles vs battleTeams run serially in node.
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
from .kernel3v3 import run_3v3, load_battles, get_kernel as k3
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="../out/gpu")
    ap.add_argument("--real", default="float")
    ap.add_argument("--sims", type=int, default=10000)
    ap.add_argument("--battles", type=int, default=1000)
    a = ap.parse_args()
    require_cuda()
    st = load_static(f"{a.data}/mons.json")
    serial = json.load(open(f"{a.data}/serial.json")) if os.path.exists(f"{a.data}/serial.json") else None

    idx, dyn, _, sims = load_sims(f"{a.data}/sims.json")
    sup = np.array([(st[i][29] == 0 and st[i][26] != 3) for i in range(len(st))])
    keep = sup[idx[:, 0]] & sup[idx[:, 1]]
    idx, dyn = idx[keep], dyn[keep]
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
    if serial:
        print(f"3v3 pvpoke battleTeams serial (memo {'on' if serial['scenarioMemo'] else 'off'}): {serial['battlesPerS']:.2f} battles/s over {serial['battles']} battles "
              f"-> kernel x{n / t3 / serial['battlesPerS']:.2f}, with sidecar x{n / ts3 / serial['battlesPerS']:.2f}")
        memo_path = f"{a.data}/serial-memo.json"
        if os.path.exists(memo_path):
            m = json.load(open(memo_path))
            print(f"3v3 pvpoke serial (memo on): {m['battlesPerS']:.2f} battles/s -> kernel x{n / t3 / m['battlesPerS']:.2f}")
    else:
        print("no serial.json: run `node gpu/serial-baseline.mjs --battles 1000` for the pvpoke side")


if __name__ == "__main__":
    main()
