"""Round 8 prof fork: instrumented copy of the slice kernel (POGO_GPU_STUDY=prof). Observation only: the battle code and
its inputs are untouched, so rows are identical to production; only timing changes (instrumentation costs time).

POGO_GPU_PROF=<comma list> picks the probes compiled in (default "sm"):
    sm     each block's SM id (%smid) -> per-SM busy-over-time from the slice kernel's segment records
    lanes  per warp and site: active threads per visit (popc of __activemask) at 4 sites (0 outer turn step, 1 inner 1v1 sim
           turn, 2 lookahead pool DP iteration, 3 slice-loop segment start)
    time   per battle: clock64 cycles in inner 1v1 sims, in decideAction inside inner sims, in decideAction of the outer
           3v3 AI, and in the whole segment (init + battle_steps)
Read the probes with read_probes(K, n_battles, blocks) right after a slice_collect; reset_probes(K) before a launch.
"""
import os

import numpy as np

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kernels")
PROBES = [p for p in os.environ.get("POGO_GPU_PROF", "sm").split(",") if p]
DEFS = tuple("PROF_" + p.upper() for p in PROBES)
NS, MAXW, MAXB = 4, 8192, 65536


def source():
    return "\n".join(open(os.path.join(HERE, f)).read() for f in ("pvp1v1.cuh", "battle1v1.cuh", "battle3v3.cuh"))


def apply(K):
    """Point the kernel module at the instrumented copies and compile the probes in as extra #defines."""
    K.source = source
    K.DEFAULT_DEFINES = tuple(K.DEFAULT_DEFINES) + DEFS
    K.PROF_DEFS = DEFS


def _mod(K, real="float"):
    K.get_kernel(real, defines=tuple(K.DEFAULT_DEFINES) + ("SLICE",), name="battle3v3_slice")
    return K._mods[(real, K.MAXQ, None, tuple(K.DEFAULT_DEFINES) + ("SLICE",))]


def _arr(K, name, n, dtype, real="float"):
    import cupy as cp
    ptr = _mod(K, real).get_global(name)
    return cp.ndarray((n,), dtype, memptr=ptr)


def reset_probes(K, real="float"):
    import cupy as cp
    cp.cuda.Stream.null.synchronize()
    _arr(K, "prof_w", MAXW * NS * 2, np.uint64, real).fill(0)
    _arr(K, "prof_b", MAXB * 4, np.uint64, real).fill(0)
    _arr(K, "prof_cur", MAXW * 32, np.int32, real).fill(-1)
    _arr(K, "prof_smid", 16384, np.uint32, real).fill(0xFFFFFFFF)
    cp.cuda.Stream.null.synchronize()


def read_probes(K, n, blocks, real="float"):
    """-> {'smid': [blocks] u32, 'lanes': [warps, NS, 2] (sum active, visits), 'time': [n, 4] cycles}"""
    w = _arr(K, "prof_w", MAXW * NS * 2, np.uint64, real).get().reshape(MAXW, NS, 2)
    b = _arr(K, "prof_b", MAXB * 4, np.uint64, real).get().reshape(MAXB, 4)
    sm = _arr(K, "prof_smid", 16384, np.uint32, real).get()
    return {"smid": sm[:blocks], "lanes": w, "time": b[:n]}
