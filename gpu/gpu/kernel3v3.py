"""Compile and launch the 3v3 battle kernel (one battle per thread)."""
import os
import numpy as np

from .cuda_guard import require_cuda
from .pack import S_N, D_N

_HERE = os.path.join(os.path.dirname(__file__), "kernels")
B_OUT = 24
OUT_FIELDS = ["winner", "remA", "remB", "hp0", "hp1", "hp2", "hp3", "hp4", "hp5", "turns", "flags",
              "innerSims", "draws", "poolMax", "chargedUsed", "hpA", "hpB"]
_cache = {}


def source():
    return "\n".join(open(os.path.join(_HERE, f)).read() for f in ("pvp1v1.cuh", "battle1v1.cuh", "battle3v3.cuh"))


def get_kernel(real="float"):
    cp = require_cuda()
    if real not in _cache:
        src = "#define REAL %s\n#define NO_1V1_KERNEL\n#define MAXQ 768\n%s" % (real, source())
        mod = cp.RawModule(code=src, options=("--std=c++14", "--fmad=false"))
        _cache[real] = mod.get_function("battle3v3_kernel")
    return _cache[real]


def run_3v3(static, idx, dyn, seeds, real="float", block=32, chunk=2048, stack=65536, trace=None):
    """static [nMons,S_N] f64, idx [n,6] i32, dyn [n,6,D_N] f64, seeds [n] u32 -> out [n,B_OUT] i32."""
    cp = require_cuda()
    k = get_kernel(real)
    cp.cuda.runtime.deviceSetLimit(0x00, stack)
    n = idx.shape[0]
    d_st = cp.asarray(static)
    outs = []
    for lo in range(0, n, chunk):
        hi = min(n, lo + chunk)
        d_idx = cp.asarray(np.ascontiguousarray(idx[lo:hi]))
        d_dyn = cp.asarray(np.ascontiguousarray(dyn[lo:hi]))
        d_seed = cp.asarray(np.ascontiguousarray(seeds[lo:hi].astype(np.uint32)))
        d_out = cp.zeros((hi - lo, B_OUT), dtype=cp.int32)
        d_dbg = cp.zeros((6000 * 5,), dtype=cp.int32)
        tt = -1 if trace is None or not (lo <= trace < hi) else trace - lo
        k(((hi - lo + block - 1) // block,), (block,), (d_st, d_idx, d_dyn, d_seed, d_out, np.int32(hi - lo), np.int32(tt), d_dbg))
        cp.cuda.Stream.null.synchronize()
        outs.append(cp.asnumpy(d_out))
        if tt >= 0:
            run_3v3.last_trace = cp.asnumpy(d_dbg).reshape(-1, 5)[: int(outs[-1][tt][17])]
    return np.concatenate(outs)


def load_battles(path, limit=None, tag=None):
    """Returns (idx [n,6], dyn [n,6,D_N], seeds [n], battles list)."""
    import json
    from .pack import pack_dyn
    bs = json.load(open(path))
    if tag:
        bs = [b for b in bs if b["tag"] == tag]
    if limit:
        bs = bs[:limit]
    n = len(bs)
    idx = np.zeros((n, 6), np.int32)
    dyn = np.zeros((n, 6, D_N))
    seeds = np.zeros(n, np.uint32)
    for i, b in enumerate(bs):
        # the engine orders each team lead-first (battleTeams)
        for side, team, lead in ((0, b["teamA"], b["leadA"]), (1, b["teamB"], b["leadB"])):
            order = [lead] + [j for j in range(3) if j != lead]
            for k, j in enumerate(order):
                idx[i, side * 3 + k] = team[j]["mon"]
                dyn[i, side * 3 + k] = pack_dyn(team[j], with_entry=False)
        seeds[i] = b["seed"] & 0xFFFFFFFF
    return idx, dyn, seeds, bs


def run_3v3_streams(static, idx, dyn, seeds, real="float", nstreams=2, chunk=0, block=32, stack=65536):
    """Same result as run_3v3, but the batch is cut into chunks issued round-robin on `nstreams` CUDA streams:
    pinned host staging, async host->device copies, kernel launch and async device->host copy all overlap across streams.
    chunk = battles per launch (0: ceil(n / (nstreams * 4)))."""
    cp = require_cuda()
    import cupyx
    k = get_kernel(real)
    cp.cuda.runtime.deviceSetLimit(0x00, stack)
    n = idx.shape[0]
    chunk = chunk or max(1, -(-n // (nstreams * 4)))
    h_idx = cupyx.empty_pinned(idx.shape, np.int32); h_idx[:] = idx
    h_dyn = cupyx.empty_pinned(dyn.shape, np.float64); h_dyn[:] = dyn
    h_seed = cupyx.empty_pinned((n,), np.uint32); h_seed[:] = seeds
    h_out = cupyx.empty_pinned((n, B_OUT), np.int32)
    d_st = cp.asarray(static)
    streams = [cp.cuda.Stream(non_blocking=True) for _ in range(max(1, nstreams))]
    d_dbg = cp.zeros((6000 * 5,), dtype=cp.int32)
    keep = []
    for ci, lo in enumerate(range(0, n, chunk)):
        hi = min(n, lo + chunk)
        s = streams[ci % len(streams)]
        with s:
            d_idx = cp.empty((hi - lo, 6), cp.int32); d_idx.set(h_idx[lo:hi], stream=s)
            d_dyn = cp.empty((hi - lo, 6, D_N), cp.float64); d_dyn.set(h_dyn[lo:hi], stream=s)
            d_seed = cp.empty((hi - lo,), cp.uint32); d_seed.set(h_seed[lo:hi], stream=s)
            d_out = cp.zeros((hi - lo, B_OUT), dtype=cp.int32)
            k(((hi - lo + block - 1) // block,), (block,), (d_st, d_idx, d_dyn, d_seed, d_out, np.int32(hi - lo), np.int32(-1), d_dbg))
            d_out.get(stream=s, out=h_out[lo:hi])
            keep.append((d_idx, d_dyn, d_seed, d_out))
    for s in streams:
        s.synchronize()
    return np.array(h_out)


def run_3v3_split(static, idx, dyn, seeds, real="float", nstreams=1, max_chunk=0, log=None):
    """Run a batch of any size. If it does not fit in GPU memory (or exceeds max_chunk) it is split in halves
    recursively and the split is logged (log(str), default stderr). Returns (out, number_of_launch_pieces)."""
    cp = require_cuda()
    import sys
    log = log or (lambda m: sys.stderr.write(m + "\n"))
    n = idx.shape[0]
    if max_chunk and n > max_chunk:
        half = n // 2
        log(f"gpu: batch of {n} exceeds the {max_chunk}-battle limit; split into {half} + {n - half}")
        a, pa = run_3v3_split(static, idx[:half], dyn[:half], seeds[:half], real, nstreams, max_chunk, log)
        b, pb = run_3v3_split(static, idx[half:], dyn[half:], seeds[half:], real, nstreams, max_chunk, log)
        return np.concatenate([a, b]), pa + pb
    try:
        out = run_3v3_streams(static, idx, dyn, seeds, real, nstreams) if nstreams > 1 else run_3v3(static, idx, dyn, seeds, real, chunk=max(n, 1))
        return out, 1
    except (cp.cuda.memory.OutOfMemoryError, cp.cuda.runtime.CUDARuntimeError) as e:
        if n < 2:
            raise
        cp.get_default_memory_pool().free_all_blocks()
        half = n // 2
        log(f"gpu: batch of {n} did not fit ({type(e).__name__}: {str(e)[:80]}); split into {half} + {n - half}")
        a, pa = run_3v3_split(static, idx[:half], dyn[:half], seeds[:half], real, nstreams, max_chunk, log)
        b, pb = run_3v3_split(static, idx[half:], dyn[half:], seeds[half:], real, nstreams, max_chunk, log)
        return np.concatenate([a, b]), pa + pb
