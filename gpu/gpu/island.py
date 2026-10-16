"""Island halving launch (plans round 7 R7, POGO_GPU_ISLAND=on): every halving round of a generation step in one kernel launch.

The kernel is battle3v3_island in kernels/battle3v3.cuh (ISLAND build); the host side that builds the job and pools the
results is src/evolve/islandHalving.js. Wire op ISLAND (gpu/wire.py) carries one job.
"""
import sys
import time

import numpy as np

from .cuda_guard import require_cuda
from . import kernel3v3 as K
from .pack import D_N

META_N = 8  # int32 meta words at the start of an ISLAND body: nC, nO, R, nIsl, keep * 1e6, 0, 0, 0


def body_size(nbytes):
    return nbytes


def parse(body):
    """ISLAND body -> dict of arrays (layout in gpu/wire.py)."""
    meta = np.frombuffer(body, "<i4", META_N, 0)
    nC, nO, R, nIsl, keepM = (int(x) for x in meta[:5])
    nT, nB = nC + nO, nC * nO * 2
    off = META_N * 4
    def take(dt, n):
        nonlocal off
        a = np.frombuffer(body, dt, n, off).copy()
        off += a.nbytes
        return a
    tIdx = take("<i4", nT * 3)
    if (nT * 3) % 2:
        off += 4   # pad to 8 bytes before the doubles
    tDyn = take("<f8", nT * 3 * D_N)
    seeds = take("<u4", nB)
    canon = take("<i4", nB)
    known = take("<i4", nB)
    ordr = take("<i4", nO)
    sz = take("<i4", R)
    islStart = take("<i4", nIsl + 1)
    members = take("<i4", nC)
    if off != len(body):
        raise ValueError(f"island body: parsed {off} of {len(body)} bytes")
    return {"nC": nC, "nO": nO, "R": R, "nIsl": nIsl, "keep": keepM / 1e6, "tIdx": tIdx, "tDyn": tDyn, "seeds": seeds,
            "canon": canon, "known": known, "ord": ordr, "sz": sz, "islStart": islStart, "members": members}


def initial_tasks(job):
    """Round-0 tasks of every island in island order: (bid, island) arrays."""
    nO, sz = job["nO"], job["sz"]
    bids, isl = [], []
    for k in range(job["nIsl"]):
        for c in job["members"][job["islStart"][k]:job["islStart"][k + 1]]:
            for oi in range(int(sz[0])):
                for sd in (0, 1):
                    bids.append((int(c) * nO + int(job["ord"][oi])) * 2 + sd)
                    isl.append(k)
    return np.array(bids, np.int32), np.array(isl, np.int32)


def island_grid(k):
    """Resident threads of the island kernel (persistent grid: blocks per SM at its occupancy x SMs x block)."""
    cp = require_cuda()
    from cupy_backends.cuda.api import driver
    nb = driver.occupancyMaxActiveBlocksPerMultiprocessor(k.kernel.ptr, K.BLOCK, 0)
    return nb * cp.cuda.Device().attributes["MultiProcessorCount"] * K.BLOCK


def run_island(static, job, real="float", width=None, log=None):
    """One island launch -> (out [nB, B_OUT] i32, status [nB] i32, icut [nC] i32, info dict)."""
    cp = require_cuda()
    from . import width as WD
    log = log or (lambda m: (sys.stderr.write(m + "\n"), sys.stderr.flush()))
    nC, nO, R, nIsl = job["nC"], job["nO"], job["R"], job["nIsl"]
    nB = nC * nO * 2
    b0, i0 = initial_tasks(job)
    # members sorted by candidate index inside each island (the kernel keeps alive lists sorted)
    members = job["members"].copy()
    for k in range(nIsl):
        lo, hi = job["islStart"][k], job["islStart"][k + 1]
        members[lo:hi] = np.sort(members[lo:hi])
    n_alive = np.diff(job["islStart"]).astype(np.int32)
    pend = np.zeros(nIsl * 2, np.int32)
    for k in range(nIsl):
        pend[2 * k] = 0
        pend[2 * k + 1] = int(n_alive[k]) * int(job["sz"][0]) * 2
    cap = nB + 16
    tasks = np.zeros(cap, np.int32)
    tasks[:len(b0)] = b0 + 1
    task_isl = np.zeros(cap, np.int32)
    task_isl[:len(i0)] = i0
    ctl = np.zeros(8, np.uint32)
    ctl[1] = len(b0)
    ctl[2] = nIsl
    d = WD.device(real)
    if width is None:
        g, rule = WD.default_width(len(b0), d["threads"])
        log(f"gpu width -- {len(b0)} battles, G={g} ({rule}; island round 1 of {R})")
    else:
        g = int(width)
    seg_cap = nB
    k = K.get_kernel(real, defines=tuple(K.DEFAULT_DEFINES) + ("ISLAND",), name="battle3v3_island")
    K._set_stack(cp, 65536)
    t = time.perf_counter()
    dz = lambda shape, dt: K._dz(cp, shape, dt)
    d_out = dz((nB, K.B_OUT), np.int32)
    d_status = dz(nB, np.int32)
    d_icut = cp.asarray(np.full(nC, -1, np.int32))
    d_pts = dz(nC, np.int32)
    d_alive = cp.asarray(members)
    d_nalive = cp.asarray(n_alive)
    d_pend = cp.asarray(pend)
    d_ctl = cp.asarray(ctl)
    d_tasks = cp.asarray(tasks)
    d_tisl = cp.asarray(task_isl)
    d_segs = dz(seg_cap * 3, np.uint64)
    args = [cp.asarray(static), cp.asarray(job["tIdx"]), cp.asarray(job["tDyn"]), cp.asarray(job["seeds"]), cp.asarray(job["canon"]),
            cp.asarray(job["known"]), d_out, d_status, np.int32(nC), np.int32(nO), np.int32(R), np.float64(job["keep"]),
            cp.asarray(job["ord"]), cp.asarray(job["sz"]), cp.asarray(job["islStart"]), np.int32(nIsl), d_alive, d_nalive, d_pts,
            d_icut, d_pend, d_ctl, d_tasks, d_tisl, np.int32(cap), np.int32(g), d_segs, np.int32(seg_cap)]
    grid = island_grid(k)
    k((grid // K.BLOCK,), (K.BLOCK,), tuple(args))
    cp.cuda.Stream.null.synchronize()
    wall = time.perf_counter() - t
    ctl = cp.asnumpy(d_ctl)
    if int(ctl[2]) != 0:
        raise RuntimeError(f"island kernel ended with {int(ctl[2])} islands unfinished (ctl {ctl.tolist()})")
    out = cp.asnumpy(d_out)
    status = cp.asnumpy(d_status)
    icut = cp.asnumpy(d_icut)
    nseg = min(int(ctl[3]), seg_cap)
    sg = cp.asnumpy(d_segs[: nseg * 3]).reshape(-1, 3).astype(np.int64)
    ran = int((status == 2).sum())
    span = float((sg[:, 2].max() - sg[:, 1].min()) / 1e9) if nseg else 0.0
    info = {"width": g, "ran": ran, "memo": int((status == 3).sum()), "dups": int((status == 4).sum()), "tasks": int(ctl[1]),
            "wall_s": wall, "span_s": span, "islands": nIsl, "rounds": R, "grid": grid}
    log(f"gpu island -- 1 launch: {nIsl} islands, {R} rounds, {info['tasks']} tasks, {ran} battles run, {info['memo']} memo, "
        f"{info['dups']} duplicate keys, G={g}, span {span:.2f}s, wall {wall:.2f}s ({ran / span if span else 0:.0f} b/s)")
    return out, status, icut, info
