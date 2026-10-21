"""Round 10 R4: ptxas -v resource table of the slice kernel per variant (no GPU time: NVRTC compile only).

    cd gpu && CUDA_CACHE_DISABLE=1 uv run python -m gpu.r10.ptxas  -> ../out/gpu/r10/ptxas.json + ptxas-<variant>.log
(CUDA_CACHE_DISABLE=1: a cached NVRTC/ptxas compile returns no verbose log; ptxas.py also sets it before importing cupy)
Rows: default (production), stack (compact), lean steps 1-4, cap (on default), lean,cap (lean step 4 + cap).
Fields: registers, stack frame (cumulative) bytes, spill store / load bytes of battle3v3_slice, per-function spill totals."""
import os
os.environ.setdefault("CUDA_CACHE_DISABLE", "1")
import json
import re
import sys

from ..study.occ.regs import ptxas_log
from .. import kernel3v3 as K

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "..", "out", "gpu", "r10")


def build(src, maxq=K.MAXQ):
    return "#define REAL float\n#define NO_1V1_KERNEL\n#define MAXQ %d\n#define SLICE\n%s" % (maxq, src)


def entry(log):
    m = re.search(r"Compiling entry function 'battle3v3_slice'.*?Used (\d+) registers.*?(\d+) bytes cumulative stack size", log, re.S)
    seg = log[log.find("Compiling entry function 'battle3v3_slice'"):]
    seg = seg[: seg.find("Compiling entry function", 10)] if seg.find("Compiling entry function", 10) > 0 else seg
    fr = re.search(r"(\d+) bytes stack frame, (\d+) bytes spill stores, (\d+) bytes spill loads", seg)
    allsp = [(int(a), int(b)) for a, b in re.findall(r"\d+ bytes stack frame, (\d+) bytes spill stores, (\d+) bytes spill loads", log)]
    return {"registers": int(m.group(1)) if m else None, "cumulative_stack": int(m.group(2)) if m else None,
            "entry_frame": int(fr.group(1)) if fr else None, "entry_spill_st": int(fr.group(2)) if fr else None,
            "entry_spill_ld": int(fr.group(3)) if fr else None,
            "all_functions_spill_st": sum(a for a, _ in allsp), "all_functions_spill_ld": sum(b for _, b in allsp)}


def variants():
    from ..study.stack import variant as stack
    from ..study.lean import variant as lean
    from ..study.cap import variant as cap
    prod = K.source()
    yield "default", prod
    yield "stack", stack.source()
    for st in lean.STEPS:
        yield f"lean{st}", (lean.source(st), lean.maxq(st))
    yield "cap", cap.edit(prod)
    yield "lean,cap", (cap.edit(lean.source()), lean.maxq())


def main():
    os.makedirs(OUT, exist_ok=True)
    res = {}
    only = os.environ.get("PTXAS_ONLY")
    res = json.load(open(os.path.join(OUT, "ptxas.json"))) if only and os.path.exists(os.path.join(OUT, "ptxas.json")) else {}
    for name, src in variants():
        if only and name not in only.split():
            continue
        src, mq = src if isinstance(src, tuple) else (src, K.MAXQ)
        log = ""
        for _ in range(4):   # NVRTC sometimes returns no verbose log; ptxas_log already retries 6 times, this is the outer retry
            log, _ = ptxas_log(build(src, mq), ["--std=c++14", "--fmad=false"])
            if "Used" in log:
                break
        open(os.path.join(OUT, f"ptxas-{name.replace(',', '+')}.log"), "w").write(log)
        res[name] = {"maxq": mq, **entry(log)}
        print(name, json.dumps(res[name]), flush=True)
    json.dump(res, open(os.path.join(OUT, "ptxas.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
