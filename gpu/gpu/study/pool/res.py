"""pool fork: slice-kernel resources per pool size (registers, local bytes per thread, occupancy) and the device memory the
stack limit reserves. Run from gpu/ under the GPU lock: uv run python -m gpu.study.pool.res > out/gpu/study/pool/res.json"""
import json

import numpy as np

from ... import kernel3v3 as K


def main():
    cp = K.require_cuda()
    from cupy_backends.cuda.api import driver
    rows = []
    for q in (256, 512, 768, 1024, 2048):
        k = K.get_kernel("float", maxq=q, defines=("SLICE",), name="battle3v3_slice")
        nb = driver.occupancyMaxActiveBlocksPerMultiprocessor(k.kernel.ptr, K.BLOCK, 0)
        rows.append({"maxq": q, "num_regs": k.num_regs, "local_bytes": k.local_size_bytes, "blocks_per_sm": nb,
                     "warps_per_sm": nb * K.BLOCK // 32})
    mem = []
    k = K.get_kernel("float", maxq=512, defines=("SLICE",), name="battle3v3_slice")
    for stack in (65536, 40960, 32768, 24576, 16384):
        cp.cuda.runtime.deviceSetLimit(0x00, stack)
        free, total = cp.cuda.runtime.memGetInfo()
        mem.append({"stack_limit": stack, "got": int(cp.cuda.runtime.deviceGetLimit(0x00)), "free_mib": free / 2**20, "total_mib": total / 2**20})
    cp.cuda.runtime.deviceSetLimit(0x00, 65536)
    print(json.dumps({"kernels": rows, "stack_memory": mem}, indent=1))


if __name__ == "__main__":
    main()
