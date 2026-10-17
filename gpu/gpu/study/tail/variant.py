"""Round 9 study variant "tail" (POGO_GPU_STUDY=tail, and tail,certain): fill the launch tail with the next halving round's battles.

A halving round's launch ends with a long tail: most workers have no battle left while the last long ones run. The next round's
battles are fully specified before this round ends (every current team x the next slice's new opponents x both seats); only
WHICH teams survive the cut is unknown. This variant appends that pool to the launch (kernel battle3v3_tail, tail.cuh):

  spec tier (tail):       once main battles not finished <= TAIL_IDLE x workers, the kernel ranks teams by partial win rate
                          and runs the pool battles of the top keep share in idle lanes whose warp holds no main battle.
  certain tier (certain): the host reads finished rows during the launch (peek), runs the exact certainty test in Node
                          (certainty.mjs) and appends the battles of teams certain to survive to an in-kernel queue (feed).

Every lane leaves when the last main battle ends; pool battles still running are discarded. Finished pool rows are only
served, by the executor, as results of the next round's identical battles, so every result equals the default path's.

Knobs (read here only):
  POGO_GPU_TAIL_IDLE   share of workers idle before the spec tier starts (default 0.5)
  POGO_GPU_TAIL_TS     pool battle steps between checks of "main battles left" and "main battle in this warp" (default 8)
  POGO_GPU_TAIL_ORDER  pool order inside the chosen teams: long (longest predicted first, default) | short | host
"""
import os
import sys
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TAIL_IDLE = float(os.environ.get("POGO_GPU_TAIL_IDLE", "0.5"))
TAIL_TS = int(os.environ.get("POGO_GPU_TAIL_TS", "8"))
TAIL_ORDER = os.environ.get("POGO_GPU_TAIL_ORDER", "long")
NT = 16  # tctl words
_mods = {}
_K = None


def _kernel(real="float"):
    K = _K
    cp = K.require_cuda()
    if real not in _mods:
        src = "#define REAL %s\n#define NO_1V1_KERNEL\n#define MAXQ %d\n#define SLICE\n#define TAIL\n%s\n%s" % (
            real, K.MAXQ, K.source(), open(os.path.join(HERE, "tail.cuh")).read())
        _mods[real] = cp.RawModule(code=src, options=("--std=c++14", "--fmad=false"))
    return _mods[real].get_function("battle3v3_tail")


def grid(real="float"):
    """Resident threads of battle3v3_tail."""
    K = _K
    cp = K.require_cuda()
    from cupy_backends.cuda.api import driver
    k = _kernel(real)
    nb = driver.occupancyMaxActiveBlocksPerMultiprocessor(k.kernel.ptr, K.BLOCK, 0)
    return nb * cp.cuda.Device().attributes["MultiProcessorCount"] * K.BLOCK


def tail_launch(static, idx, dyn, seeds, pool, meta, real="float", stream=None, T=None, ts=None, idle=None, order=None):
    """Start one main launch with its pool on `stream` (no wait).

    pool = (idx, dyn, seeds) of the next round's battles; meta = {mainTag i32[n] (team * 2 + seat, -1 = none), poolTeam i32[nP],
    priorPts f32[nT], priorN f32[nT], keepK, spec (bool), certain (bool)}. Returns a handle for tail_collect / peek / feed."""
    K = _K
    cp = K.require_cuda()
    T = T or K.SLICE_TURNS
    ts = ts or TAIL_TS
    idle = TAIL_IDLE if idle is None else idle
    order_mode = order or TAIL_ORDER
    k = _kernel(real)
    _drain()
    K._set_stack(cp, 65536)
    n = idx.shape[0]
    pidx, pdyn, pseeds = pool
    nP = pidx.shape[0]
    nT = len(meta["priorPts"])
    from gpu.predict import predict_s
    main_order, pred = K.slice_order(static, idx, dyn)
    pp = predict_s(static, pidx, pdyn) if nP else np.zeros(0)
    if pred is None:
        pred = np.zeros(n)
    if nP and pp is None:
        pp = np.zeros(nP)
    if order_mode == "long" and nP:
        porder = np.argsort(-pp, kind="stable").astype(np.int32)
    elif order_mode == "short" and nP:
        porder = np.argsort(pp, kind="stable").astype(np.int32)
    else:
        porder = np.arange(nP, dtype=np.int32)
    all_idx = np.concatenate([idx, pidx]) if nP else idx
    all_dyn = np.concatenate([dyn, pdyn]) if nP else dyn
    all_seed = np.concatenate([seeds, pseeds]) if nP else seeds
    pred_ns = (np.concatenate([pred, pp]) * K.THREAD_FACTOR * 1e9).astype(np.float32)
    grid_threads = grid(real)
    warps = grid_threads // 32
    nser = n
    spread = min(32, max(1, -(-nser // warps))) if K.SLICE_SPREAD else 32
    workers = warps * spread
    thr = int(idle * workers)
    ctl = np.zeros(16, np.uint32)
    ctl[1] = nser                       # C_TAIL
    ctl[2] = n                          # C_LIVE
    ctl[12] = warps * 32                # C_ALIVE: every lane; spare lanes subtract themselves on entry (as production)
    ctl[13] = spread
    ring = ((np.arange(nser, dtype=np.uint64) + 1) << np.uint64(32)) | np.arange(nser, dtype=np.uint64)
    seg_cap = int(min(30_000_000, (n + nP) * 6 + 1024))
    s = stream or cp.cuda.Stream(non_blocking=True)
    words = K._slot_words(real)
    D = lambda a, dt: cp.asarray(np.ascontiguousarray(a, dtype=dt))
    with s:
        d = {
            "st": cp.asarray(static), "idx": D(all_idx, np.int32), "dyn": D(all_dyn, np.float64), "seed": D(all_seed, np.uint32),
            "out": K._dz(cp, (n + nP, K.B_OUT), np.int32), "order": D(main_order, np.int32), "ser": D(np.arange(n + 1), np.int32),
            "ctl": D(ctl, np.uint32), "spos": K._dz(cp, max(n, 1), np.int32), "sstate": K._dz(cp, max(n, 1), np.int32),
            "save": cp.empty((max(n, 1) * words,), cp.uint64), "ring": D(ring if n else np.zeros(1, np.uint64), np.uint64),
            "segs": cp.empty((seg_cap * 6,), cp.uint32), "pred": D(pred_ns, np.float32),
            "mainTag": D(meta["mainTag"] if n else np.zeros(1), np.int32), "poolTeam": D(meta["poolTeam"] if nP else np.zeros(1), np.int32),
            "porder": D(porder if nP else np.zeros(1), np.int32),
            "tPts": K._dz(cp, max(nT, 1), np.float32), "tN": K._dz(cp, max(nT, 1), np.float32),
            "priorPts": D(meta["priorPts"] if nT else np.zeros(1), np.float32), "priorN": D(meta["priorN"] if nT else np.zeros(1), np.float32),
            "chosen": K._dz(cp, max(nT, 1), np.int32), "spec": K._dz(cp, max(nP, 1), np.int32), "pclaim": K._dz(cp, max(nP, 1), np.int32),
            "pdone": K._dz(cp, max(nP, 1), np.int32), "cq": K._dz(cp, max(nP, 1), np.int32), "tctl": K._dz(cp, NT, np.uint32),
            "wmain": K._dz(cp, max(warps, 256), np.int32), "mdone": K._dz(cp, max(n, 1), np.int32),
            "plane": K._dz(cp, grid_threads, np.int32),
        }
        spec_on = ((1 if meta.get("spec", True) else 0) | (2 if meta.get("certain") else 0)) if nP else 0
        # side-stream reads (done/peek/tail_collect) and writes (feed) wait for these uploads: without it a snapshot could read
        # ctl before its upload (live 0 -> "done" before any battle ran) and feed's tail word could be zeroed by tctl's fill
        up = s.record()
        if n:
            k((grid_threads // K.BLOCK,), (K.BLOCK,), (
                d["st"], d["idx"], d["dyn"], d["seed"], d["out"], d["order"], d["ser"], np.int32(nser), np.int32(T),
                d["ctl"], d["spos"], d["sstate"], d["save"], d["ring"], np.uint32(max(nser, 1)), d["segs"], np.int32(seg_cap), d["pred"],
                np.int32(n), np.int32(nP), d["mainTag"], d["poolTeam"], d["porder"], np.int32(nT), np.int32(meta["keepK"]), np.uint32(thr),
                d["tPts"], d["tN"], d["priorPts"], d["priorN"], d["chosen"], d["spec"], d["pclaim"], d["pdone"],
                d["cq"], d["tctl"], d["wmain"], np.int32(ts), np.int32(spec_on), d["mdone"], d["plane"]))
    ev = s.record()
    return {"n": n, "nP": nP, "nT": nT, "stream": s, "event": ev, "d": d, "seg_cap": seg_cap, "threads": grid_threads,
            "workers": workers, "thr": thr, "spread": spread, "cq_n": 0, "spec_on": spec_on, "ts": ts, "idle": idle,
            "order": order_mode, "side": None, "up": up}


def _side(h):
    cp = _K.require_cuda()
    if h["side"] is None:
        h["side"] = cp.cuda.Stream(non_blocking=True)
        h["side"].wait_event(h["up"])
    return h["side"]


def peek(h):
    """Main rows finished so far, read while the launch runs: mdone first, then the rows, by device->host copies on a side stream
    (no kernel: a kernel would wait behind the persistent grid). A row flagged in the first copy was complete before it (tail.cuh
    fences before the flag). -> int32 [n, 4]: winner, leadFaintA, leadFaintB, done."""
    n = h["n"]
    if not n:
        return np.zeros((0, 4), np.int32)
    cp = _K.require_cuda()
    import cupyx
    s = _side(h)
    if h.get("peek_buf") is None:
        h["peek_buf"] = cupyx.empty_pinned((n, _K.B_OUT), np.int32)
        h["peek_done"] = cupyx.empty_pinned((n,), np.int32)
    buf, dn = h["peek_buf"], h["peek_done"]
    cp.cuda.runtime.memcpyAsync(dn.ctypes.data, h["d"]["mdone"].data.ptr, n * 4, 2, s.ptr)
    cp.cuda.runtime.memcpyAsync(buf.ctypes.data, h["d"]["out"].data.ptr, n * _K.B_OUT * 4, 2, s.ptr)
    s.synchronize()
    o = np.empty((n, 4), np.int32)
    o[:, 0] = buf[:, 0]; o[:, 1] = buf[:, 18]; o[:, 2] = buf[:, 19]; o[:, 3] = dn
    return o


def feed(h, pool_idx):
    """Append pool indices to the in-kernel certain queue while the launch runs: entries first, then the tail word, on one side
    stream (copies run in order), so the kernel never sees a tail past entries that are not written."""
    cp = _K.require_cuda()
    import cupyx
    ix = np.asarray(pool_idx, np.int32)
    if not len(ix) or not h["nP"]:
        return 0
    ix = ix[(ix >= 0) & (ix < h["nP"])]
    room = h["nP"] - h["cq_n"]
    ix = ix[:room]
    if not len(ix):
        return 0
    s = _side(h)
    hb = cupyx.empty_pinned((len(ix),), np.int32); hb[:] = ix
    d_cq = h["d"]["cq"]
    cp.cuda.runtime.memcpyAsync(d_cq.data.ptr + h["cq_n"] * 4, hb.ctypes.data, len(ix) * 4, 1, s.ptr)
    h["cq_n"] += len(ix)
    tb = cupyx.empty_pinned((1,), np.uint32); tb[0] = h["cq_n"]
    cp.cuda.runtime.memcpyAsync(h["d"]["tctl"].data.ptr + 4 * 4, tb.ctypes.data, 4, 1, s.ptr)
    s.synchronize()
    return int(len(ix))


_ZOMBIES = []  # (handle, t_main_end) of launches returned at main end whose late lanes still run
LATE = []      # late-lane times of finished zombies, us after the last main battle (diagnostic, tail.cuh header)
LIVE_POLL_S = 0.002


def _reap():
    for z in list(_ZOMBIES):
        h = z["h"]
        if h["event"].done:
            _ZOMBIES.remove(z)
            tc = _K.require_cuda().asnumpy(h["d"]["tctl"]).astype(np.int64)
            t_exit, t_main = int(tc[8] | (tc[9] << 32)), int(tc[10] | (tc[11] << 32))
            LATE.append(round(max(0, t_exit - t_main) / 1e3, 1) if t_main else 0.0)
            h["d"] = None


def _drain():
    """Wait for the late lanes of earlier launches before a new one starts. Late lanes that ran on beside the next launch slowed
    its battles, which kept the late lanes alive longer still (full 100-gen runs grew to 2 min/gen by gen 79). The wait is the
    real cost of the late lanes, so it is logged ("gpu tail late -- waited"), and counted in WAITED_US."""
    global WAITED_US
    _reap()
    if not _ZOMBIES:
        return
    t = time.perf_counter()
    for z in list(_ZOMBIES):
        z["h"]["event"].synchronize()
    _reap()
    us = (time.perf_counter() - t) * 1e6
    WAITED_US += us
    print(f"gpu tail late -- waited {us / 1e3:.1f}ms for late lanes of the previous launch (total {WAITED_US / 1e6:.2f}s)", file=sys.stderr, flush=True)


WAITED_US = 0.0


def _snap(h, name, nbytes, ptr_off=0):
    """Device -> pinned host copy of h["d"][name] on the side stream (runs while the grid still runs)."""
    import cupyx
    cp = _K.require_cuda()
    a = h["d"][name]
    buf = cupyx.empty_pinned((nbytes // a.itemsize,), a.dtype)
    cp.cuda.runtime.memcpyAsync(buf.ctypes.data, a.data.ptr + ptr_off, nbytes, 2, _side(h).ptr)
    return buf


def done(h):
    """True once the launch's main battles are all finished (C_LIVE == 0, polled every 2 ms), not when the grid exits: lanes
    that were inside a pool battle step then may run on for up to one step (tail.cuh header)."""
    _reap()
    if h["event"].done:
        return True
    if not h["n"]:
        return False
    t = time.perf_counter()
    if t - h.get("live_t", 0.0) < LIVE_POLL_S:
        return False
    h["live_t"] = t
    live = _snap(h, "ctl", 4, 8)
    _side(h).synchronize()
    if int(live[0]) == 0:
        h["early"] = True
        return True
    return False


def tail_collect(h):
    """Rows of a tail_launch once its main battles are finished -> (out [n + nP, B_OUT] int32, pdone [nP] bool, info dict).
    If the grid still runs (late lanes in a pool step), pdone and the rows are copied in that order on the side stream (tail.cuh
    fences each row before its flag), the pool battles not flagged then count as discarded, and the buffers are kept until the
    grid exits."""
    K = _K
    cp = K.require_cuda()
    n, nP = h["n"], h["nP"]
    d = h["d"]
    returned_early = False
    if h.get("early") and not h["event"].done:
        pd = _snap(h, "pdone", max(nP, 1) * 4)
        ob = _snap(h, "out", (n + nP) * K.B_OUT * 4)
        cb = _snap(h, "ctl", 16 * 4)
        tb = _snap(h, "tctl", NT * 4)
        sb = _snap(h, "segs", h["seg_cap"] * 6 * 4)
        _side(h).synchronize()
        out = np.array(ob).reshape(n + nP, K.B_OUT)
        ctl, tc = np.array(cb), np.array(tb).astype(np.int64)
        pdone_raw = np.array(pd)
        segs_raw = np.array(sb)
        returned_early = True
        if n and int(ctl[2]) != 0:  # should not happen since the side stream waits for the uploads; wait for the grid instead
            print(f"gpu tail -- early read saw {int(ctl[2])} main battles live; waited for the grid", file=sys.stderr, flush=True)
            returned_early = False
        else:
            _ZOMBIES.append({"h": h})
    if not returned_early:
        h["stream"].synchronize()
        if h["side"] is not None:
            h["side"].synchronize()
        out = cp.asnumpy(d["out"])
        ctl = cp.asnumpy(d["ctl"])
        tc = cp.asnumpy(d["tctl"]).astype(np.int64)
        pdone_raw = cp.asnumpy(d["pdone"])
        segs_raw = None
        returned_early = False
    if n and int(ctl[2]) != 0:
        raise RuntimeError(f"tail kernel ended with {int(ctl[2])} main battles unfinished (ctl {ctl.tolist()})")
    pdone = pdone_raw[:nP].astype(bool)
    nseg = min(int(ctl[5]), h["seg_cap"])
    sg = (segs_raw[: nseg * 6] if segs_raw is not None else cp.asnumpy(d["segs"][: nseg * 6])).reshape(-1, 6).astype(np.int64)
    segs = np.stack([sg[:, 0], sg[:, 1], sg[:, 2] | (sg[:, 3] << 32), sg[:, 4] | (sg[:, 5] << 32)], 1) if nseg else np.zeros((0, 4), np.int64)
    u64 = lambda i: int(tc[i] | (tc[i + 1] << 32))
    t_exit, t_main, t_spec = u64(8), u64(10), u64(12)
    st0 = int(segs[:, 2].min()) if len(segs) else 0
    info = {"n": int(n), "pool": int(nP), "started": int(tc[5]), "kept": int(pdone.sum()), "discarded": int(tc[5] - pdone.sum()),
            "from_certain": int(tc[7]), "kept_certain": int(tc[14]), "fed": int(h["cq_n"]), "spec_listed": int(tc[1]),
            "spec_ranked": bool(tc[0] == 2), "returned_early": returned_early,
            # host-visible extension: 0 when the rows were read at main end (late lanes run on; LATE gets their time when done)
            "overrun_us": 0.0 if returned_early else (round(max(0, t_exit - t_main) / 1e3, 1) if t_main else 0.0),
            "spec_at_s": round((t_spec - st0) / 1e9, 4) if t_spec and st0 else None,
            "main_end_s": round((t_main - st0) / 1e9, 4) if t_main and st0 else None,
            "workers": h["workers"], "thr": h["thr"], "spread": h["spread"], "ts": h["ts"], "idle": h["idle"], "order": h["order"],
            "segments": segs, "segments_dropped": max(0, int(ctl[5]) - h["seg_cap"])}
    if not returned_early:
        h["d"] = None
    return out, pdone, info


def parse(body):
    """TAIL request body (gpu/client.mjs packTail): meta i32[8] = (n, nPool, nT, keepK, flags: 1 spec | 2 certain, 0, 0, 0) |
    idx i32[n*6] | pool idx i32[nP*6] | mainTag i32[n] | poolTeam i32[nP] | seeds u32[n] | pool seeds u32[nP] | priorPts f32[nT] |
    priorN f32[nT] | pad to 8 | dyn f64[n*6*D_N] | pool dyn f64[nP*6*D_N]."""
    from gpu.pack import D_N
    meta = np.frombuffer(body, "<i4", 8, 0)
    n, nP, nT, keepK, flags = (int(x) for x in meta[:5])
    off = 32
    def take(dt, cnt):
        nonlocal off
        a = np.frombuffer(body, dt, cnt, off).copy()
        off += cnt * np.dtype(dt).itemsize
        return a
    idx = take("<i4", n * 6).reshape(n, 6); pidx = take("<i4", nP * 6).reshape(nP, 6)
    tag = take("<i4", n); pteam = take("<i4", nP)
    seeds = take("<u4", n); pseeds = take("<u4", nP)
    ppts = take("<f4", nT); pn = take("<f4", nT)
    off += (-off) % 8
    dyn = take("<f8", n * 6 * D_N).reshape(n, 6, D_N); pdyn = take("<f8", nP * 6 * D_N).reshape(nP, 6, D_N)
    if off != len(body):
        raise ValueError(f"tail body: parsed {off} of {len(body)} bytes")
    return {"idx": idx, "dyn": dyn, "seeds": seeds, "pool": (pidx, pdyn, pseeds),
            "meta": {"mainTag": tag, "poolTeam": pteam, "priorPts": ppts, "priorN": pn, "keepK": keepK,
                     "spec": bool(flags & 1), "certain": bool(flags & 2)}}


INFO = ("n", "pool", "started", "kept", "discarded", "from_certain", "kept_certain", "fed", "spec_listed", "spec_ranked",
        "overrun_us", "spec_at_us", "main_end_us", "workers", "thr", "segments_dropped")


def reply_words(res):
    """tail_collect result -> int32 reply words: info[16] (INFO order; times in us, -1 = none) | pdone[nP] | rows (n+nP) x B_OUT."""
    out, pdone, info = res
    us = lambda v: -1 if v is None else int(round(v * 1e6))
    vals = dict(info, spec_ranked=int(info["spec_ranked"]), overrun_us=int(round(info["overrun_us"])),
                spec_at_us=us(info["spec_at_s"]), main_end_us=us(info["main_end_s"]))
    head = np.array([int(vals[k]) for k in INFO], np.int32)
    _write_log(info)
    return np.ascontiguousarray(np.concatenate([head, pdone.astype(np.int32), out.reshape(-1).astype(np.int32)]), "<i4")


def _write_log(info):
    """POGO_GPU_TAIL_SEGS=<dir>: each launch's segment records (who|mode, battle, t0, t1; mode 3 = pool) as tail-<k>.npy."""
    d = os.environ.get("POGO_GPU_TAIL_SEGS")
    if not d:
        return
    os.makedirs(d, exist_ok=True)
    k = len([f for f in os.listdir(d) if f.startswith("tail-")])
    np.save(os.path.join(d, f"tail-{k:04d}.npy"), info["segments"])


def apply(K):
    """Register the tail launcher on the kernel module (K.TAIL); the default launch path is unchanged."""
    global _K
    _K = K
    K.TAIL = sys.modules[__name__]
