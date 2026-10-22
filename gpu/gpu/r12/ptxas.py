"""Round 12 R2: ptxas -v resource line of the one production kernel (lean 6), and of lean 6 + the cap study. NVRTC compile only.

    cd gpu && CUDA_CACHE_DISABLE=1 uv run python -m gpu.r12.ptxas  -> ../out/gpu/r12/ptxas.json + ptxas-<name>.log
Fields as in round 10's table: registers, cumulative stack bytes, spill store / load bytes of the entry battle3v3_slice
and of all functions."""
import os
os.environ.setdefault("CUDA_CACHE_DISABLE", "1")
import json
import re

from .. import kernel3v3 as K

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "..", "out", "gpu", "r12")


def ptxas_log(src, opts=(), tries=6):
    from cupy_backends.cuda.libs import nvrtc
    opts = list(opts) + ["-arch=sm_86", "--ptxas-options=--verbose"]
    log = ""
    for _ in range(tries):
        p = nvrtc.createProgram(src, "k.cu", [], [])
        nvrtc.compileProgram(p, opts)
        log = nvrtc.getProgramLog(p)
        if "Used" in log:
            break
    return log


def entry(log):
    m = re.search(r"Compiling entry function 'battle3v3_slice'.*?Used (\d+) registers.*?(\d+) bytes cumulative stack size", log, re.S)
    seg = log[log.find("Compiling entry function 'battle3v3_slice'"):]
    cut = seg.find("Compiling entry function", 10)
    seg = seg[:cut] if cut > 0 else seg
    fr = re.search(r"(\d+) bytes stack frame, (\d+) bytes spill stores, (\d+) bytes spill loads", seg)
    allsp = [(int(a), int(b)) for a, b in re.findall(r"\d+ bytes stack frame, (\d+) bytes spill stores, (\d+) bytes spill loads", log)]
    return {"registers": int(m.group(1)) if m else None, "cumulative_stack": int(m.group(2)) if m else None,
            "entry_frame": int(fr.group(1)) if fr else None, "entry_spill_st": int(fr.group(2)) if fr else None,
            "entry_spill_ld": int(fr.group(3)) if fr else None,
            "all_functions_spill_st": sum(a for a, _ in allsp), "all_functions_spill_ld": sum(b for _, b in allsp)}


def build(src, maxq=K.MAXQ):
    return "#define REAL float\n#define NO_1V1_KERNEL\n#define MAXQ %d\n#define SLICE\n%s" % (maxq, src)


def main():
    from ..study.cap import variant as cap
    os.makedirs(OUT, exist_ok=True)
    rows = {}
    for name, src in (("lean6", K.source()), ("lean6+cap192", cap.edit(K.source(), 192))):
        log = ptxas_log(build(src))
        open(os.path.join(OUT, f"ptxas-{name}.log"), "w").write(log)
        rows[name] = {"maxq": K.MAXQ, **entry(log)}
        print(name, json.dumps(rows[name]))
    json.dump(rows, open(os.path.join(OUT, "ptxas.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
