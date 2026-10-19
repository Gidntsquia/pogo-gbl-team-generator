"""Compile and launch the 3v3 battle kernel (one battle per thread)."""
import os
import sys
import numpy as np

from .cuda_guard import require_cuda
from .pack import S_N, D_N

_HERE = os.path.join(os.path.dirname(__file__), "kernels")
B_OUT = 24
OUT_FIELDS = ["winner", "remA", "remB", "hp0", "hp1", "hp2", "hp3", "hp4", "hp5", "turns", "flags",
              "innerSims", "draws", "poolMax", "chargedUsed", "hpA", "hpB"]
_cache = {}
_mods = {}


def source():
    return "\n".join(open(os.path.join(_HERE, f)).read() for f in ("pvp1v1.cuh", "battle1v1.cuh", "battle3v3.cuh"))


MAXQ = 2048  # lookahead DP pool per thread (pvp1v1.cuh, packed 12-byte states); a battle that needs more is flagged POOL_OVERFLOW
DEFAULT_DEFINES = ()
if os.environ.get("POGO_GPU_KERNEL") == "v1":  # profiling only: the round-3 kernel (wide 28-byte states, pool 768) for A/B runs
    MAXQ, DEFAULT_DEFINES = 768, ("WIDE_POOL",)
BLOCK = 32  # threads per block for every launch
# EXPERIMENTAL (plans round 5), off by default: POGO_GPU_KERNEL=queue -> work-queue kernel; =warp -> one warp per battle for launches
# up to POGO_GPU_WARP_BELOW battles (default 5000), thread per battle above.
# round 7: the default is the slice scheduler with the width picker (POGO_GPU_WIDTH, default auto; gpu/gpu/width.py).
# POGO_GPU_KERNEL=v2 selects the round-4 thread-per-battle kernel, warp / queue the older prototypes.
PROTO = os.environ.get("POGO_GPU_KERNEL", "") or "slice"
WARP_BELOW = int(os.environ.get("POGO_GPU_WARP_BELOW", "5000"))
QUEUE_GRID_WARPS = 544  # 68 SMs x 8 resident warps at 254 registers (round 4)


def get_kernel(real="float", maxq=None, maxrreg=None, defines=None, name="battle3v3_kernel"):
    """Compiled battle3v3_kernel. maxq / maxrreg (register cap) / defines (extra #define names) are for profiling
    variants; defaults = production. name: another entry of the same module (SLICE: battle3v3_slice, slice_sizes)."""
    cp = require_cuda()
    defines = DEFAULT_DEFINES if defines is None else defines
    key = (real, maxq or MAXQ, maxrreg, tuple(defines))
    if key not in _mods:
        extra = "".join("#define %s\n" % d for d in defines)
        src = "#define REAL %s\n#define NO_1V1_KERNEL\n#define MAXQ %d\n%s%s" % (real, maxq or MAXQ, extra, source())
        opts = ("--std=c++14", "--fmad=false") + ((f"--maxrregcount={maxrreg}",) if maxrreg else ())
        mod = cp.RawModule(code=src, options=opts)
        _mods[key] = mod
        if "SLICE" not in defines:
            _cache[key] = mod.get_function("battle3v3_kernel")
    if name == "battle3v3_kernel":
        return _cache[key]
    return _mods[key].get_function(name)


def stamps(out):
    """Per-battle (start_ns, end_ns) int64 arrays from output cols 20..23 (%globaltimer at thread start / end)."""
    o = np.asarray(out).astype(np.int64) & 0xFFFFFFFF
    return o[:, 20] | (o[:, 21] << 32), o[:, 22] | (o[:, 23] << 32)


def run_3v3(static, idx, dyn, seeds, real="float", block=None, chunk=2048, stack=65536, trace=None, maxq=None, maxrreg=None, defines=None, lanes=1):
    """static [nMons,S_N] f64, idx [n,6] i32, dyn [n,6,D_N] f64, seeds [n] u32 -> out [n,B_OUT] i32.
    lanes > 1 (profiling prototype): that many threads run each battle in lockstep, one of them writes the row."""
    if PROTO == "slice" and lanes == 1 and trace is None and maxq is None and maxrreg is None and defines is None:
        return np.concatenate([run_3v3_slice(static, idx[lo:lo + chunk], dyn[lo:lo + chunk], seeds[lo:lo + chunk], real)[0]
                               for lo in range(0, idx.shape[0], chunk)])
    cp = require_cuda()
    block = block or BLOCK
    queue = PROTO == "queue"
    if PROTO == "warp" and lanes == 1 and idx.shape[0] <= WARP_BELOW:
        lanes, block = 32, 64
    if queue:
        defines = tuple(DEFAULT_DEFINES if defines is None else defines) + ("QUEUE",)
    if lanes > 1:
        defines = tuple(DEFAULT_DEFINES if defines is None else defines) + ("LANES %d" % lanes,)
    k = get_kernel(real, maxq, maxrreg, defines)
    _set_stack(cp, stack)
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
        grid = ((hi - lo) * lanes + block - 1) // block
        if queue:
            ptr = _mods[next(kk for kk in _cache if _cache[kk] is k)].get_global("g_queue")
            cp.cuda.runtime.memset(ptr.ptr, 0, 4)
            grid = min(grid, QUEUE_GRID_WARPS * 32 // block)
        k((grid,), (block,), (d_st, d_idx, d_dyn, d_seed, d_out, np.int32(hi - lo), np.int32(tt), d_dbg))
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




def _dz(cp, shape, dtype):
    """Zeroed device array by a host->device copy on the current stream. cp.zeros/cp.full launch a fill kernel, and on this GPU
    driver (WSL2) that kernel waits behind a running slice launch on another stream until it ends, which serialised
    POGO_GPU_STREAMS launches (plans round 6 R2); a copy does not wait."""
    return cp.asarray(np.zeros(shape, dtype))

_stack_now = [None]


def _set_stack(cp, stack):
    """cudaDeviceSetLimit(stack) only when it changes: the call waits for every running kernel, so calling it per launch would
    serialise launches on different streams (POGO_GPU_STREAMS)."""
    if _stack_now[0] != stack:
        cp.cuda.runtime.deviceSetLimit(0x00, stack)
        _stack_now[0] = stack

def run_3v3_streams(static, idx, dyn, seeds, real="float", nstreams=2, chunk=0, block=32, stack=65536):
    """Same result as run_3v3, but the batch is cut into chunks issued round-robin on `nstreams` CUDA streams:
    pinned host staging, async host->device copies, kernel launch and async device->host copy all overlap across streams.
    chunk = battles per launch (0: ceil(n / (nstreams * 4)))."""
    cp = require_cuda()
    import cupyx
    k = get_kernel(real)
    _set_stack(cp, stack)
    n = idx.shape[0]
    chunk = chunk or max(1, -(-n // (nstreams * 4)))
    h_idx = cupyx.empty_pinned(idx.shape, np.int32); h_idx[:] = idx
    h_dyn = cupyx.empty_pinned(dyn.shape, np.float64); h_dyn[:] = dyn
    h_seed = cupyx.empty_pinned((n,), np.uint32); h_seed[:] = seeds
    h_out = cupyx.empty_pinned((n, B_OUT), np.int32)
    d_st = cp.asarray(static)
    streams = [cp.cuda.Stream(non_blocking=True) for _ in range(max(1, nstreams))]
    d_dbg = _dz(cp, (6000 * 5,), np.int32)
    keep = []
    for ci, lo in enumerate(range(0, n, chunk)):
        hi = min(n, lo + chunk)
        s = streams[ci % len(streams)]
        with s:
            d_idx = cp.empty((hi - lo, 6), cp.int32); d_idx.set(h_idx[lo:hi], stream=s)
            d_dyn = cp.empty((hi - lo, 6, D_N), cp.float64); d_dyn.set(h_dyn[lo:hi], stream=s)
            d_seed = cp.empty((hi - lo,), cp.uint32); d_seed.set(h_seed[lo:hi], stream=s)
            d_out = _dz(cp, (hi - lo, B_OUT), np.int32)
            k(((hi - lo + block - 1) // block,), (block,), (d_st, d_idx, d_dyn, d_seed, d_out, np.int32(hi - lo), np.int32(-1), d_dbg))
            d_out.get(stream=s, out=h_out[lo:hi], blocking=False)
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


# ---------------------------------------------------------------------------------------------- time-sliced scheduler (round 6)
# EXPERIMENTAL, off by default (POGO_GPU_KERNEL=slice). Tunables (defaults picked by profiling, see docs/gpu-viability.md round 6):
SLICE_TURNS = int(os.environ.get("POGO_GPU_SLICE_TURNS", "64"))        # T: loop iterations a thread runs before it may yield
SLICE_SERIES = int(os.environ.get("POGO_GPU_SERIES", "1"))             # K: battles per series (queue item)
SLICE_MODE = os.environ.get("POGO_GPU_SLICE_MODE", "requeue")          # requeue | handoff (round-6 profile: requeue)
SLICE_HANDOFF = os.environ.get("POGO_GPU_HANDOFF", "")                 # W: live battles at which thread mode hands off ("" = warps)
SLICE_BIN = os.environ.get("POGO_GPU_BIN", "on") != "off"             # order the queue by predicted length (longest first; round 7: on by default)
SLICE_SPREAD = os.environ.get("POGO_GPU_SPREAD", "on") != "off"        # launches smaller than the grid: fewer battles per warp
THREAD_FACTOR = 5.9  # thread-mode (mixed warp) time / solo time, round-5 divergence profile; refit by sched_bench fit


def slice_grid(real="float", block=None):
    """Resident threads of the slice kernel (persistent grid = blocks per SM x SMs x block)."""
    cp = require_cuda()
    from cupy_backends.cuda.api import driver
    block = block or BLOCK
    k = get_kernel(real, defines=tuple(DEFAULT_DEFINES) + ("SLICE",), name="battle3v3_slice")
    nb = driver.occupancyMaxActiveBlocksPerMultiprocessor(k.kernel.ptr, block, 0)
    sms = cp.cuda.Device().attributes["MultiProcessorCount"]
    return nb * sms * block


def slice_order(static, idx, dyn, bin_=None):
    """Queue order + predicted solo seconds (None without weights). bin_ (default POGO_GPU_BIN): longest predicted first."""
    from .predict import predict_s
    n = idx.shape[0]
    pred = predict_s(static, idx, dyn)
    if (SLICE_BIN if bin_ is None else bin_) and pred is not None:
        return np.argsort(-pred, kind="stable").astype(np.int32), pred
    return np.arange(n, dtype=np.int32), pred


def run_3v3_slice(static, idx, dyn, seeds, real="float", **kw):
    """Time-sliced run of a batch, synchronous: slice_collect(slice_launch(...)). See slice_launch."""
    return slice_collect(slice_launch(static, idx, dyn, seeds, real, **kw))


def slice_launch(static, idx, dyn, seeds, real="float", T=None, K=None, mode=None, W=None, bin_=None, ahead=None, stream=None,
                 order=None, grid=None, seg_cap=None, stack=65536, spread=None, width=None):
    """Time-sliced run of a batch; the rows equal run_3v3's (same battle code, only the scheduling differs).

    ahead = (idx, dyn, seeds) of battles of the NEXT launch whose inputs are already fixed (POGO_GPU_AHEAD): idle lanes take them,
    shortest predicted first, only while now + predicted length is before the slowest started main battle's predicted end.
    Returns (out [n,B_OUT], info) where info has ctl counters, segments [m,4] (who|mode<<30, battle, t0, t1 ns), threads,
    and for ahead: 'ahead_out' rows of the taken ones (index into the ahead batch -> row), 'ahead_log' (start, predicted end,
    actual end, deadline ns) and 'ahead_taken'.

    width (round 7): lanes per battle, an int G in 1,2,4,..,32 (1 = the round-6 path), or a mix plan
    {"split": m, "wide": Gw, "narrow": Gn, "warps_wide": w}: the first m battles of the queue order (longest predicted first under
    bin) run at Gw on warps [0, w), the rest at Gn on the other warps, in the same launch. Rows are identical at every width."""
    cp = require_cuda()
    T = T or SLICE_TURNS
    K = max(1, K or SLICE_SERIES)
    mode = {"requeue": 0, "handoff": 1}[mode or SLICE_MODE] if not isinstance(mode, int) else mode
    defines = tuple(DEFAULT_DEFINES) + ("SLICE",)
    k = get_kernel(real, defines=defines, name="battle3v3_slice")
    _set_stack(cp, stack)
    n = idx.shape[0]
    if n == 0:
        return {"n": 0}
    grid_threads = grid or slice_grid(real)
    if W is None:
        W = int(SLICE_HANDOFF) if SLICE_HANDOFF else grid_threads // 32
    if order is None:
        order, pred = slice_order(static, idx, dyn, bin_)
    else:
        from .predict import predict_s
        pred = predict_s(static, idx, dyn)
    na = 0
    if ahead is not None and len(ahead[2]):
        from .predict import predict_s
        pa = predict_s(static, ahead[0], ahead[1])
        if pa is not None:
            na = len(ahead[2])
            asort = np.argsort(pa, kind="stable")
            idx = np.concatenate([idx, ahead[0]]); dyn = np.concatenate([dyn, ahead[1]]); seeds = np.concatenate([seeds, ahead[2]])
            pred = np.concatenate([pred, pa])
    pred_ns = (np.zeros(n + na) if pred is None else pred * THREAD_FACTOR * 1e9).astype(np.float32)
    ser = np.arange(0, n + K, K, dtype=np.int32)
    ser[-1] = n
    ser = np.unique(np.minimum(ser, n)).astype(np.int32)
    nser = len(ser) - 1
    warps = grid_threads // 32
    wlog = None
    if width is None:  # production: POGO_GPU_WIDTH (auto by default), logged per launch
        if mode != 0 or na or K != 1:
            width, wlog = 1, f"gpu width -- {n} battles, G=1 (fixed: handoff mode, series > 1 or ahead pool)"
        else:
            from . import width as WD
            width, wlog = WD.pick(static, idx, dyn, real, seeds=seeds)
        sys.stderr.write(wlog + "\n")
        sys.stderr.flush()
    if isinstance(width, dict):
        if mode != 0 or na or K != 1:
            raise ValueError("mixed widths need requeue mode, K=1 and no ahead pool")
        m = max(1, min(nser - 1, int(width["split"]))) if nser > 1 else nser
        ww = max(1, min(warps - 1, int(width["warps_wide"])))
        plan = [(0, ww, int(width["wide"]), 0, m), (ww, warps, int(width["narrow"]), m, nser - m)]
    else:
        G = int(width or 1)
        if G not in (1, 2, 4, 8, 16, 32):
            raise ValueError(f"width must be a power of two 1..32, got {G}")
        if G > 1 and (mode != 0 or na):
            raise ValueError("width > 1 needs requeue mode and no ahead pool")
        plan = [(0, warps, G, 0, nser)]
    nsets = len(plan)
    s = stream or cp.cuda.Stream.null
    with s:
        d_st = cp.asarray(static)
        d_idx = cp.asarray(np.ascontiguousarray(idx, dtype=np.int32))
        d_dyn = cp.asarray(np.ascontiguousarray(dyn, dtype=np.float64))
        d_seed = cp.asarray(np.ascontiguousarray(seeds.astype(np.uint32)))
        d_out = _dz(cp, (n + na, B_OUT), np.int32)
        d_order = cp.asarray(np.ascontiguousarray(order, dtype=np.int32))
        d_ser = cp.asarray(ser)
        ctl = np.zeros(16 * nsets, np.uint32)
        sp = SLICE_SPREAD if spread is None else spread
        sets = np.zeros(nsets * 5, np.int32)
        ring_cap = max(nser, 1) if mode == 0 else 1
        ring = np.zeros(ring_cap if mode else max(nser, 1) + nsets, np.uint64)
        roff = 0
        for si, (wlo, whi, G, s0, ns) in enumerate(plan):
            c = ctl[16 * si:16 * si + 16]
            gpw = 32 // G                       # groups (workers) per warp
            nw = whi - wlo
            c[2] = int(ser[s0 + ns] - ser[s0])  # battles of this set
            c[13] = min(gpw, max(1, -(-ns // nw))) if sp else gpw
            if mode == 0:
                c[1] = ns
                c[12] = nw * gpw
                cap = max(ns, 1)
                ring[roff:roff + ns] = ((np.arange(ns, dtype=np.uint64) + 1) << np.uint64(32)) | (np.arange(ns, dtype=np.uint64) + np.uint64(s0))
            else:
                cap = 1
            sets[5 * si:5 * si + 5] = (wlo, whi, G, roff, cap)
            roff += cap
        d_ctl = cp.asarray(ctl)
        d_sets = cp.asarray(sets)
        d_spos = _dz(cp, max(nser, 1), np.int32)
        d_sstate = _dz(cp, max(nser, 1), np.int32)
        words = _slot_words(real)
        d_save = cp.empty((max(nser, 1) * words,), cp.uint64)
        d_ring = cp.asarray(ring)
        d_wq = cp.asarray(np.full((nser + grid_threads // 32 + 1,), -1, np.int32))  # one ticket per push plus one per warp that finds it empty
        seg_cap = seg_cap or int(min(30_000_000, (n + na) * (3 + (0 if mode else 1200 // max(T, 1)))))
        d_segs = cp.empty((seg_cap * 6,), cp.uint32)  # written before read (the host reads the first ctl[C_SEG] records)
        d_pred = cp.asarray(pred_ns)
        d_ahead = cp.asarray(np.arange(n, n + na, dtype=np.int32)[asort] if na else np.zeros(1, np.int32))
        d_adone = _dz(cp, max(na, 1), np.int32)
        d_alog = _dz(cp, (max(na, 1) * 4,), np.uint64)
        blocks = grid_threads // BLOCK
        k((blocks,), (BLOCK,), (d_st, d_idx, d_dyn, d_seed, d_out, d_order, d_ser, np.int32(nser), np.int32(T), np.int32(mode), np.int32(W),
                                d_ctl, d_spos, d_sstate, d_save, d_ring, np.uint32(ring_cap), d_wq, d_segs, np.int32(seg_cap),
                                d_pred, d_ahead, np.int32(na), d_adone, d_alog, d_sets, np.int32(nsets)))
    return {"n": n, "na": na, "stream": s, "d_out": d_out, "d_ctl": d_ctl, "d_segs": d_segs, "seg_cap": seg_cap, "threads": grid_threads,
            "T": T, "K": K, "mode": mode, "W": W, "series": nser, "spread": int(ctl[13]), "d_adone": d_adone, "d_alog": d_alog,
            "asort": asort if na else None, "nsets": nsets, "plan": plan, "width": width, "picked": wlog is not None, "keep": (d_sets, d_st, d_idx, d_dyn, d_seed, d_order, d_ser, d_spos, d_sstate, d_save, d_ring, d_wq, d_pred, d_ahead)}


def slice_collect(h):
    """Wait for a slice_launch and return (out [n,B_OUT], info); see run_3v3_slice."""
    cp = require_cuda()
    if h["n"] == 0:
        return np.zeros((0, B_OUT), np.int32), {"ctl": [0] * 16, "segments": np.zeros((0, 4), np.int64), "threads": 0, "handoffs": 0}
    n, na, seg_cap = h["n"], h["na"], h["seg_cap"]
    h["stream"].synchronize()
    out = cp.asnumpy(h["d_out"])
    ctl_all = cp.asnumpy(h["d_ctl"]).reshape(-1, 16)
    ctl = ctl_all[0].copy()
    ctl[2] = ctl_all[:, 2].sum()
    ctl[8] = ctl_all[:, 8].sum()
    nseg = min(int(ctl[5]), seg_cap)
    sg = cp.asnumpy(h["d_segs"][: nseg * 6]).reshape(-1, 6).astype(np.int64)
    if int(ctl[2]) != 0:
        raise RuntimeError(f"slice kernel ended with {int(ctl[2])} battles unfinished (ctl {ctl_all.tolist()})")
    segs = np.stack([sg[:, 0], sg[:, 1], sg[:, 2] | (sg[:, 3] << 32), sg[:, 4] | (sg[:, 5] << 32)], 1) if nseg else np.zeros((0, 4), np.int64)
    info = {"ctl": ctl.tolist(), "segments": segs, "segments_dropped": max(0, int(ctl[5]) - seg_cap), "threads": h["threads"],
            "T": h["T"], "K": h["K"], "mode": h["mode"], "W": h["W"], "series": h["series"], "handoffs": int(ctl[8]), "spread": h["spread"],
            "plan": h.get("plan"), "width": h.get("width")}
    if h.get("picked") and nseg:
        from . import width as WD
        WD.finish_calibration(n, h["width"], info)
    if na:
        asort = h["asort"]
        done = cp.asnumpy(h["d_adone"])[:na].astype(bool)
        lg = cp.asnumpy(h["d_alog"]).reshape(-1, 4)[:na]
        rows = np.arange(n, n + na)[asort]          # ticket a -> row in the concatenated batch
        taken = np.nonzero(done)[0]
        info["ahead_taken"] = int(len(taken))
        info["ahead_offered"] = na
        info["ahead_rows"] = {int(rows[a] - n): out[rows[a]] for a in taken}
        info["ahead_log"] = [{"battle": int(rows[a] - n), "start": int(lg[a, 0]), "pred_end": int(lg[a, 1]), "end": int(lg[a, 2]),
                              "deadline": int(lg[a, 3])} for a in taken]
    return out[:n], info


_slot = {}


def _slot_words(real="float"):
    if real not in _slot:
        cp = require_cuda()
        k = get_kernel(real, defines=tuple(DEFAULT_DEFINES) + ("SLICE",), name="slice_sizes")
        o = cp.zeros(3, cp.int32)
        k((1,), (1,), (o,))
        _slot[real] = [int(x) for x in o.get()]
    return _slot[real][0]


def slice_sizes(real="float"):
    """(saved words per series, sizeof(B3), sizeof(Run)) of the slice kernel's state save."""
    _slot_words(real)
    return tuple(_slot[real])


def launch_async(static, idx, dyn, seeds, real="float", stream=None, stack=65536, share=1):
    """Start one launch on `stream` without waiting (concurrent launches, POGO_GPU_STREAMS; plans round 6 R2). The v2 kernel, or the
    slice kernel under POGO_GPU_KERNEL=slice. Poll with launch_done(h), finish with launch_collect(h) -> out [n,B_OUT].
    share: launches meant to run side by side. A slice launch's persistent grid fills every resident slot, so a second one could
    not start until the first's threads exit; with share=N each slice launch takes 1/N of the resident grid."""
    cp = require_cuda()
    s = stream or cp.cuda.Stream(non_blocking=True)
    n = idx.shape[0]
    if PROTO == "slice":
        grid = None
        if share > 1:
            grid = max(BLOCK, slice_grid(real) // share // BLOCK * BLOCK)
        h = slice_launch(static, idx, dyn, seeds, real, stream=s, stack=stack, grid=grid)
        h["kind"] = "slice"
    else:
        k = get_kernel(real)
        _set_stack(cp, stack)
        with s:
            d_st = cp.asarray(static)
            d_idx = cp.asarray(np.ascontiguousarray(idx, dtype=np.int32))
            d_dyn = cp.asarray(np.ascontiguousarray(dyn, dtype=np.float64))
            d_seed = cp.asarray(np.ascontiguousarray(seeds.astype(np.uint32)))
            d_out = _dz(cp, (max(n, 1), B_OUT), np.int32)
            d_dbg = _dz(cp, (8,), np.int32)
            if n:
                k(((n + BLOCK - 1) // BLOCK,), (BLOCK,), (d_st, d_idx, d_dyn, d_seed, d_out, np.int32(n), np.int32(-1), d_dbg))
        h = {"kind": "v2", "n": n, "stream": s, "d_out": d_out, "keep": (d_st, d_idx, d_dyn, d_seed, d_dbg)}
    h["event"] = s.record() if h.get("stream") is not None else None
    return h


def launch_done(h):
    """True once the launch's stream has reached its end event (non-blocking)."""
    return h["event"] is None or h["event"].done


def launch_collect(h):
    """Wait for a launch_async launch; -> out rows [n,B_OUT] int32."""
    cp = require_cuda()
    if h["kind"] == "slice":
        return slice_collect(h)[0]
    h["stream"].synchronize()
    return cp.asnumpy(h["d_out"])[: h["n"]]


AHEAD = os.environ.get("POGO_GPU_AHEAD", "") == "on"
AHEAD_LOG = os.environ.get("POGO_GPU_AHEAD_LOG", "")


def run_3v3_ahead(static, idx, dyn, seeds, real="float", **kw):
    """R4 (POGO_GPU_AHEAD=on, slice kernel): the batch runs as two launches in a row; the second half's battles have fixed
    inputs, so lanes of the first launch that find its queue empty take them (shortest predicted first) while they are
    predicted to end before the first launch's slowest started battle. The second launch runs only what was not taken.
    Nothing is speculative or discarded: every taken row is a final result. -> (out [n,B_OUT], record dict for the ahead log)."""
    n = idx.shape[0]
    half = n // 2
    out = np.zeros((n, B_OUT), np.int32)
    o1, i1 = run_3v3_slice(static, idx[:half], dyn[:half], seeds[:half], real, ahead=(idx[half:], dyn[half:], seeds[half:]), **kw)
    out[:half] = o1
    rows = i1.get("ahead_rows", {})
    taken = np.array(sorted(rows), dtype=np.int64)
    for b, row in rows.items():
        out[half + b] = row
    rest = np.setdiff1d(np.arange(n - half), taken)
    o2, i2 = run_3v3_slice(static, idx[half:][rest], dyn[half:][rest], seeds[half:][rest], real, **kw)
    out[half + rest] = o2
    lg = i1.get("ahead_log", [])
    s1, s2 = i1["segments"], i2["segments"]
    rec = {"n": int(n), "first": int(half), "offered": int(n - half), "taken": int(len(taken)), "discarded": 0,
           "second": int(len(rest)), "late": int(sum(1 for x in lg if x["end"] > x["deadline"])),
           "first_span_s": float((s1[:, 3].max() - s1[:, 2].min()) / 1e9) if len(s1) else 0.0,
           "second_span_s": float((s2[:, 3].max() - s2[:, 2].min()) / 1e9) if len(s2) else 0.0,
           "taken_log": lg, "segments": (s1, s2, rest + half)}
    return out, rec


def write_ahead_log(rec, path=None):
    """Append one launch's ahead record (JSON line) to POGO_GPU_AHEAD_LOG: battles taken, each one's predicted vs actual end,
    the deadline it was checked against, and discarded = 0."""
    import json
    path = path or AHEAD_LOG
    if not path:
        return
    r = {k: v for k, v in rec.items() if k != "segments"}
    with open(path, "a") as f:
        f.write(json.dumps(r) + "\n")


# ---------------------------------------------------------------------------------------------- round 8 study variants
# EXPERIMENTAL, off by default (plans round 8 R6/R7; round 9 adds tail, certain; round 10 lean, cap). POGO_GPU_STUDY=<name>[,<name>] selects research prototypes from the
# fixed list below; each lives in this repo at gpu/gpu/study/<name>/variant.py and its apply(module) replaces functions of
# this module (kernel source, launch or scheduler). Names outside STUDY_VARIANTS are rejected. Unset = production path.
STUDY_VARIANTS = ("prof", "width", "stack", "pool", "split", "lockstep", "streams", "cpushare", "queue", "early", "occ", "tail", "certain", "lean", "cap")
STUDY = [f for f in os.environ.get("POGO_GPU_STUDY", "").split(",") if f]


def _apply_study():
    from .study import variants
    for name in STUDY:
        if name not in STUDY_VARIANTS:
            raise ValueError(f"POGO_GPU_STUDY: unknown variant {name!r} (known: {', '.join(STUDY_VARIANTS)})")
        getattr(variants, name)().apply(sys.modules[__name__])
        sys.stderr.write(f"gpu study -- variant {name} applied\n")


if STUDY:
    _apply_study()
