"""Compile and launch the 1v1 simulate kernel (float32 default, double for the logic-exactness build)."""
import os
import numpy as np

from .cuda_guard import require_cuda

_HERE = os.path.join(os.path.dirname(__file__), "kernels")
OUT_N = 18
_cache = {}


def source():
    return "\n".join(open(os.path.join(_HERE, f)).read() for f in ("pvp1v1.cuh", "battle1v1.cuh"))


def get_kernel(real="float"):
    cp = require_cuda()
    if real not in _cache:
        src = "#define REAL %s\n%s" % (real, source())
        # --fmad=false: no fused multiply-add, so the double build matches JS arithmetic bit for bit
        mod = cp.RawModule(code=src, options=("--std=c++14", "--fmad=false"), name_expressions=None)
        _cache[real] = mod.get_function("sim1v1_kernel")
    return _cache[real]


def run_1v1(static, idx, dyn, real="float", block=64):
    """static [nMons,S_N] f64, idx [n,2] i32, dyn [n,2,D_N] f64 -> out [n,18] i32 (numpy)."""
    cp = require_cuda()
    k = get_kernel(real)
    n = idx.shape[0]
    d_st = cp.asarray(static)
    d_idx = cp.asarray(idx)
    d_dyn = cp.asarray(dyn)
    d_out = cp.zeros((n, OUT_N), dtype=cp.int32)
    grid = (n + block - 1) // block
    k((grid,), (block,), (d_st, d_idx, d_dyn, d_out, np.int32(n)))
    cp.cuda.Stream.null.synchronize()
    return cp.asnumpy(d_out)
