"""Round 8 study fork "lockstep" (POGO_GPU_STUDY=lockstep): RL-simulator style scheduling (Isaac Gym / WarpDrive).

Every launch advances each still-running battle by one time slice (up to T battle-loop iterations), saves the state of the
ones not finished to a flat array and appends them to the next launch's active list (device-side compaction); the host
relaunches over that list until it is empty. Same battle code as production (battle_init / battle_steps / battle_write of
gpu/gpu/kernels/battle3v3.cuh, compiled unchanged with lockstep.cuh appended); only the scheduling differs, so rows equal
production's (cols 0..19; 20..23 are timestamps).

Knobs (env): POGO_GPU_LS_T (slice length T, default 256), POGO_GPU_LS_SOA (1 = structure-of-arrays state, default 1),
POGO_GPU_LS_SYNC (read the active count back every N launches, default 1 = exact grids; >1 launches with the last known
count as an upper bound, threads past the device count exit), POGO_GPU_LS_ORDER (bin = longest predicted first, default).
"""
import os
import time

import numpy as np

_HERE = os.path.dirname(__file__)
T_DEFAULT = int(os.environ.get("POGO_GPU_LS_T", "32"))
SOA = int(os.environ.get("POGO_GPU_LS_SOA", "1"))
SYNC = int(os.environ.get("POGO_GPU_LS_SYNC", "1"))
ORDER = os.environ.get("POGO_GPU_LS_ORDER", "bin")
SPREAD = int(os.environ.get("POGO_GPU_LS_SPREAD", "0"))     # lanes per warp taking a battle; 0 = auto (ceil(active / warps)), 32 = packed
PERSIST = int(os.environ.get("POGO_GPU_LS_PERSIST", "0"))   # 1 = one persistent launch, grid barrier between slices
MAX_SLICES = 20000
_mod = {}
last = {}   # info of the last run (bench)


def _kernel(K, real):
    cp = K.require_cuda()
    if real not in _mod:
        src = "#define REAL %s\n#define NO_1V1_KERNEL\n#define MAXQ %d\n%s#define SLICE\n%s\n%s" % (
            real, K.MAXQ, "".join("#define %s\n" % d for d in K.DEFAULT_DEFINES), K.source(),
            open(os.path.join(_HERE, "lockstep.cuh")).read())
        m = cp.RawModule(code=src, options=("--std=c++14", "--fmad=false"))
        _mod[real] = (m, m.get_function("battle3v3_lockstep"), m.get_function("battle3v3_lockstep_persist"))
    return _mod[real][1]


def _grid_res(K, cp, real):
    """Resident threads of the relaunched kernel (blocks per SM x SMs x block)."""
    from cupy_backends.cuda.api import driver
    k = _kernel(K, real)
    nb = driver.occupancyMaxActiveBlocksPerMultiprocessor(k.kernel.ptr, K.BLOCK, 0)
    return nb * cp.cuda.Device().attributes["MultiProcessorCount"] * K.BLOCK


def _persist_kernel(K, real):
    _kernel(K, real)
    return _mod[real][2]


def run_lockstep(K, static, idx, dyn, seeds, real="float", T=None, soa=None, sync=None, order=None, stack=65536, persist=None, spread=None):
    """-> (out [n,B_OUT] i32, info). info: slices (launches), active [per slice], slice_ns [per slice device span],
    wall_s (host, launch to last row), kernel_s (sum of per-slice device spans)."""
    cp = K.require_cuda()
    T = T or T_DEFAULT
    soa = SOA if soa is None else soa
    sync = max(1, sync or SYNC)
    persist = PERSIST if persist is None else persist
    spread = SPREAD if spread is None else spread
    k = _kernel(K, real)
    K._set_stack(cp, stack)
    n = idx.shape[0]
    if n == 0:
        return np.zeros((0, K.B_OUT), np.int32), {"slices": 0}
    if order is None:
        order = K.slice_order(static, idx, dyn, True)[0] if ORDER == "bin" else np.arange(n, dtype=np.int32)
    words = K._slot_words(real)
    d_st = cp.asarray(static)
    d_idx = cp.asarray(np.ascontiguousarray(idx, dtype=np.int32))
    d_dyn = cp.asarray(np.ascontiguousarray(dyn, dtype=np.float64))
    d_seed = cp.asarray(np.ascontiguousarray(seeds.astype(np.uint32)))
    d_out = K._dz(cp, (n, K.B_OUT), np.int32)
    d_order = cp.asarray(np.ascontiguousarray(order, dtype=np.int32))
    lists = [cp.asarray(np.arange(n, dtype=np.int32)), cp.asarray(np.zeros(n, np.int32))]
    cnt0 = np.zeros(MAX_SLICES + 1, np.uint32)
    cnt0[0] = n
    d_cnt = cp.asarray(cnt0)
    d_started = K._dz(cp, (n,), np.int32)
    d_save = cp.empty((n * words,), cp.uint64)
    st0 = np.zeros(2 * MAX_SLICES, np.uint64)
    st0[0::2] = np.uint64(0xFFFFFFFFFFFFFFFF)
    d_stamps = cp.asarray(st0)
    cp.cuda.Stream.null.synchronize()
    t_start = time.perf_counter()
    bound, s, host_reads = n, 0, 0
    grid_res = _grid_res(K, cp, real)
    if persist:
        from cupy_backends.cuda.api import driver
        kp = _persist_kernel(K, real)
        nb = driver.occupancyMaxActiveBlocksPerMultiprocessor(kp.kernel.ptr, K.BLOCK, 0)
        blocks = nb * cp.cuda.Device().attributes["MultiProcessorCount"]
        d_bar = K._dz(cp, (2,), np.uint32)
        d_res = K._dz(cp, (1,), np.int32)
        kp((blocks,), (K.BLOCK,), (d_st, d_idx, d_dyn, d_seed, d_out, d_order, lists[0], lists[1], d_cnt, np.int32(MAX_SLICES), np.int32(T),
                                   d_save, np.int32(n), np.int32(soa), d_started, d_stamps, d_bar, d_res, np.int32(spread)))
        s = int(d_res.get()[0])
        if s < 0:
            raise RuntimeError(f"lockstep: more than {MAX_SLICES} slices")
        bound = 0
    while bound > 0:
        if s >= MAX_SLICES:
            raise RuntimeError(f"lockstep: more than {MAX_SLICES} slices")
        if spread > 0:
            sp = spread
        else:  # auto: as few battles per warp as the resident grid allows (host-side, from the last known count)
            sp = min(32, max(1, -(-bound // (grid_res // 32))))
        blocks = (-(-bound // sp) * 32 + K.BLOCK - 1) // K.BLOCK
        k((blocks,), (K.BLOCK,), (d_st, d_idx, d_dyn, d_seed, d_out, d_order, lists[s & 1], lists[(s + 1) & 1], d_cnt, np.int32(s),
                                  np.int32(T), d_save, np.int32(n), np.int32(soa), d_started, d_stamps, np.int32(sp)))
        s += 1
        if s % sync == 0:
            bound = int(d_cnt[s].get())   # D2H copy: waits for slice s-1
            host_reads += 1
        # else: keep the last known bound (counts only shrink); threads past cnt[s] exit at once
    cp.cuda.Stream.null.synchronize()
    wall = time.perf_counter() - t_start
    out = cp.asnumpy(d_out)
    cnt = cp.asnumpy(d_cnt)[: s + 1].astype(np.int64)
    if int(cnt[s]) != 0:
        raise RuntimeError(f"lockstep: {int(cnt[s])} battles unfinished after {s} slices")
    stp = cp.asnumpy(d_stamps).reshape(-1, 2)[:s].astype(np.int64)
    ran = cnt[:s] > 0
    span = np.where(ran, stp[:, 1] - stp[:, 0], 0)
    # launches that ran a battle (with sync > 1 a few trailing launches find an empty list)
    nz = np.nonzero(ran)[0]
    dev_span = float((stp[nz, 1].max() - stp[nz, 0].min()) / 1e9) if len(nz) else 0.0
    info = {"n": int(n), "T": int(T), "soa": int(soa), "sync": int(sync), "persist": int(persist), "spread": int(spread), "slices": int(s), "slices_with_work": int(len(nz)),
            "host_reads": host_reads, "active": cnt[:s].tolist(), "slice_ns": span.tolist(), "wall_s": wall,
            "device_span_s": dev_span, "kernel_s": float(span.sum() / 1e9),
            "gap_s": dev_span - float(span.sum() / 1e9)}
    last.clear()
    last.update(info)
    return out, info


LOG = os.environ.get("POGO_GPU_LS_LOG", "")   # JSON line per launch (chain runs): slices, overhead, active battles per slice


def log_launch(info, out, path=None):
    """Append one launch's lockstep record to POGO_GPU_LS_LOG: n, T, slices, wall / device span / summed slice spans,
    per-relaunch gap, active battles and device span (ms) of every slice, plus the rows' battle-duration stamps."""
    import json
    s0 = (out[:, 20].astype(np.int64) & 0xFFFFFFFF) | ((out[:, 21].astype(np.int64) & 0xFFFFFFFF) << 32)
    e0 = (out[:, 22].astype(np.int64) & 0xFFFFFFFF) | ((out[:, 23].astype(np.int64) & 0xFFFFFFFF) << 32)
    dur = (e0 - s0) / 1e9
    r = {k: v for k, v in info.items() if k not in ("active", "slice_ns")}
    r["active"] = info.get("active", [])
    r["slice_ms"] = [round(x / 1e6, 3) for x in info.get("slice_ns", [])]
    r["per_relaunch_gap_ms"] = 1e3 * info.get("gap_s", 0) / max(1, info.get("slices_with_work", 1) - 1)
    r["battle_p50_s"] = float(np.median(dur)) if len(dur) else 0.0
    r["battle_max_s"] = float(dur.max()) if len(dur) else 0.0
    with open(path or LOG, "a") as f:
        f.write(json.dumps(r) + "\n")


def apply(K):
    """Replace the default slice path (run_3v3 -> run_3v3_slice) with the lockstep scheduler."""
    def run_3v3_slice(static, idx, dyn, seeds, real="float", **kw):
        out, info = run_lockstep(K, static, idx, dyn, seeds, real)
        if LOG:
            log_launch(info, out)
        return out, info
    K.run_3v3_slice = run_3v3_slice
    K.lockstep_run = lambda *a, **kw: run_lockstep(K, *a, **kw)
