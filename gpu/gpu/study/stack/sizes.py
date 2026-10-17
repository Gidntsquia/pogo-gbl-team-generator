"""Stack fork: where the per-thread local memory (stack) of the slice kernel goes.

    cd gpu && flock ../out/gpu/study/gpu.lock uv run python -m gpu.study.stack.sizes [--variant] [--out F]

sizeof of every battle struct (tiny kernel), ptxas per-function stack frames and the slice kernel's registers / local bytes /
resident warps. --variant measures the stack fork's kernel source instead of production."""
import argparse
import json
import re
import sys

import numpy as np

from ...cuda_guard import require_cuda
from ... import kernel3v3 as K

STRUCTS = ["Move", "Mon", "Sim", "QA", "Act", "Timer", "Ply", "B3", "Run", "BState"]
SIZES_SRC = 'extern "C" __global__ void stack_sizes(int* o) {\n%s\n}\n' % "\n".join(
    f"  o[{i}] = (int)sizeof({s});" for i, s in enumerate(STRUCTS))


def full_source(src, defines=("SLICE",)):
    return "#define REAL float\n#define NO_1V1_KERNEL\n#define MAXQ %d\n%s%s\n%s" % (
        K.MAXQ, "".join("#define %s\n" % d for d in defines), src, SIZES_SRC)


def struct_sizes(src):
    cp = require_cuda()
    mod = cp.RawModule(code=full_source(src), options=("--std=c++14", "--fmad=false"))
    o = cp.zeros(len(STRUCTS), cp.int32)
    mod.get_function("stack_sizes")((1,), (1,), (o,))
    sl = mod.get_function("battle3v3_slice")
    from cupy_backends.cuda.api import driver
    nb = driver.occupancyMaxActiveBlocksPerMultiprocessor(sl.kernel.ptr, K.BLOCK, 0)
    return dict(zip(STRUCTS, [int(x) for x in o.get()])), {
        "num_regs": sl.num_regs, "local_bytes": sl.local_size_bytes, "shared_bytes": sl.shared_size_bytes,
        "blocks_per_sm": nb, "warps_per_sm": nb * K.BLOCK // 32}


def frames(src, tries=6):
    """ptxas --verbose: per function 'N bytes stack frame' (entry: cumulative stack)."""
    from cupy_backends.cuda.libs import nvrtc
    opts = ["--std=c++14", "--fmad=false", "-arch=sm_86", "--ptxas-options=--verbose"]
    for _ in range(tries):
        p = nvrtc.createProgram(full_source(src), "k.cu", [], [])
        nvrtc.compileProgram(p, opts)
        log = nvrtc.getProgramLog(p)
        if "stack frame" in log:
            break
    out = {}
    for m in re.finditer(r"Function properties for (\S+)\s*\n\s*(\d+) bytes stack frame, (\d+) bytes spill stores, (\d+) bytes spill loads", log):
        out[m.group(1)] = {"frame": int(m.group(2)), "spill_st": int(m.group(3)), "spill_ld": int(m.group(4))}
    ent = re.search(r"Compiling entry function 'battle3v3_slice'.*?Used (\d+) registers.*?(\d+) bytes cumulative stack size", log, re.S)
    return out, ({"registers": int(ent.group(1)), "cumulative_stack": int(ent.group(2))} if ent else None), log


def demangle_short(name):
    m = re.match(r"_Z\d+(\D\w*?)(P|R|i|v|S)", name)
    if not name.startswith("_Z"):
        return name
    m = re.match(r"_Z(?:L)?(\d+)", name)
    if m:
        n = int(m.group(1)); s = name[len(m.group(0)):]
        return s[:n]
    return name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", action="store_true")
    ap.add_argument("--out")
    a = ap.parse_args()
    if a.variant:
        from . import variant
        variant.apply(K)
    src = K.source()
    sizes, res = struct_sizes(src)
    fr, ent, log = frames(src)
    named = {demangle_short(k): v for k, v in fr.items()}
    rec = {"variant": ("stack-" + __import__("os").environ.get("POGO_GPU_STACK_SRC", "compact")) if a.variant else "production", "sizeof": sizes, "slice_kernel": res, "ptxas_entry": ent,
           "frames": dict(sorted(named.items(), key=lambda kv: -kv[1]["frame"]))}
    print(json.dumps(rec, indent=1))
    if a.out:
        open(a.out.replace(".json", ".ptxas.log"), "w").write(log)
        json.dump(rec, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
