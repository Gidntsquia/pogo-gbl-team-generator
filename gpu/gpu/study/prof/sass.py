"""Round 8 prof fork: static SASS of the production slice kernel (no counters needed).

    uv run python -m gpu.study.prof.sass OUTDIR TOOLDIR

Compiles the same source / defines / options as kernel3v3.get_kernel(defines=("SLICE",)) with NVRTC to an sm_86 cubin,
disassembles it with cuobjdump -sass, and counts instruction classes of battle3v3_slice (LDL/STL = local (stack) memory,
LDG/STG = global, LDS/STS = shared, BRA/BSSY/BSYNC/WARPSYNC = branch / reconvergence). Writes OUTDIR/slice.cubin,
OUTDIR/slice.sass, OUTDIR/sass-counts.json.
"""
import json
import os
import re
import subprocess
import sys
from collections import Counter



def main():
    if not (len(sys.argv) > 3 and sys.argv[3] == "reuse"):
        global compiler, K
        from cupy.cuda import compiler
        from ... import kernel3v3 as K
    out, tools = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    if len(sys.argv) > 3 and sys.argv[3] == "reuse":  # disassemble the cubin saved by an earlier run (no compile, no GPU)
        arch = "86"
        cub = open(os.path.join(out, "slice.cubin"), "rb").read()
    else:
        src = "#define REAL float\n#define NO_1V1_KERNEL\n#define MAXQ %d\n#define SLICE\n%s" % (K.MAXQ, K.source())
        import cupy as cp
        dev = cp.cuda.Device()
        arch = "%d%d" % dev.compute_capability if isinstance(dev.compute_capability, tuple) else dev.compute_capability
        cub = compiler.compile_using_nvrtc(src, ("--std=c++14", "--fmad=false"), arch=arch)
        cub = cub[0] if isinstance(cub, tuple) else cub
        cub = cub if isinstance(cub, bytes) else bytes(cub)
    # the NVRTC cubin comes back one byte short of its ELF program header table (trailing NUL dropped): pad it
    import struct
    phoff, = struct.unpack_from("<Q", cub, 0x20)
    phentsize, phnum = struct.unpack_from("<HH", cub, 0x36)
    need = phoff + phentsize * phnum
    if len(cub) < need:
        cub = cub + b"\0" * (need - len(cub))
    open(os.path.join(out, "slice.cubin"), "wb").write(cub)
    sass = subprocess.run([os.path.join(tools, "cuobjdump"), "-sass", os.path.join(out, "slice.cubin")],
                          capture_output=True, text=True).stdout
    open(os.path.join(out, "slice.sass"), "w").write(sass)
    res = subprocess.run([os.path.join(tools, "cuobjdump"), "-res-usage", os.path.join(out, "slice.cubin")], capture_output=True, text=True).stdout
    ops = Counter()
    widths = Counter()
    perfun = {}
    fun = None
    for line in sass.splitlines():
        f = re.search(r"Function : (\S+)", line)
        if f:
            fun = f.group(1)
            perfun[fun] = Counter()
            continue
        m = re.match(r"\s*/\*[0-9a-f]{4,}\*/\s+(@!?U?P\w+\s+)?([A-Z][A-Z0-9_.]*)", line)
        if not m:
            continue
        op = m.group(2)
        base = op.split(".")[0]
        ops[base] += 1
        if fun is not None:
            perfun[fun][base] += 1
        if base in ("LDL", "STL"):
            w = re.search(r"\.(8|16|32|64|128|U8|S8|U16|S16)\b", op)
            widths[base + "." + (w.group(1) if w else "32")] += 1
    total = sum(ops.values())
    cls = {"local_LDL": ops["LDL"], "local_STL": ops["STL"], "global_LDG": ops["LDG"], "global_STG": ops["STG"],
           "shared_LDS_STS": ops["LDS"] + ops["STS"], "atomics": ops["ATOM"] + ops["ATOMG"] + ops["RED"],
           "branch_BRA": ops["BRA"], "reconverge_BSSY_BSYNC_WARPSYNC": ops["BSSY"] + ops["BSYNC"] + ops["WARPSYNC"],
           "fp64_DADD_DMUL_DFMA_DSETP": ops["DADD"] + ops["DMUL"] + ops["DFMA"] + ops["DSETP"]}
    doc = {"kernel": "battle3v3_slice module (entry + all __noinline__ device functions)", "arch": "sm_" + str(arch), "static_instructions": total, "classes": cls,
           "local_share_of_static_instr": (ops["LDL"] + ops["STL"]) / max(total, 1), "local_widths": dict(widths),
           "top_ops": ops.most_common(30),
           "per_function": {k: {"instr": sum(v.values()), "LDL": v["LDL"], "STL": v["STL"], "LDG": v["LDG"], "STG": v["STG"]}
                            for k, v in perfun.items()}, "res_usage": res.strip(),
           "note": "static counts (each instruction once, regardless of how often it runs); dynamic counts need NVBit or ncu"}
    json.dump(doc, open(os.path.join(out, "sass-counts.json"), "w"), indent=1)
    print(json.dumps({k: doc[k] for k in ("static_instructions", "classes", "local_share_of_static_instr", "local_widths")}, indent=1))
    print(res)


if __name__ == "__main__":
    main()
