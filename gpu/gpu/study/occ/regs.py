"""occ study: per-function ptxas resource usage of the slice kernel for a source/option variant (NVRTC, sm_86).

    uv run python -m gpu.study.occ.regs [--variant NAME ...] [--out FILE]

Prints, for each variant, the entry's registers / stack / spills and every device function's line, so we can see which
function sets the kernel's register count (a kernel's count is the max over its whole call tree)."""
import argparse
import json
import re
import os
import subprocess
import sys

from . import variant as V

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "out", "gpu", "study", "occ")
CUOBJDUMP = os.path.join(OUT, "tools-venv", "lib", "python3.12", "site-packages", "nvidia", "cu13", "bin", "cuobjdump")


def res_usage(cubin_path):
    """cuobjdump --dump-resource-usage -> {function: {REG, STACK, LOCAL, ...}} (per function, unlike ptxas -v)."""
    txt = subprocess.run([CUOBJDUMP, "--dump-resource-usage", cubin_path], capture_output=True, text=True).stdout
    funcs, cur = {}, None
    for line in txt.splitlines():
        m = re.search(r"Function ([A-Za-z0-9_]+):", line)
        if m:
            cur = m.group(1)
            continue
        if cur and "REG:" in line:
            funcs[demangle(cur)] = {k: int(v) for k, v in re.findall(r"([A-Z_]+):(\d+)", line)}
    return funcs


def ptxas_log(src, opts, tries=6):
    from cupy_backends.cuda.libs import nvrtc
    opts = list(opts) + ["-arch=sm_86", "--ptxas-options=--verbose"]
    for _ in range(tries):
        p = nvrtc.createProgram(src, "k.cu", [], [])
        try:
            nvrtc.compileProgram(p, opts)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(nvrtc.getProgramLog(p)) from e
        log = nvrtc.getProgramLog(p)
        if "Used" in log:
            return log, nvrtc.getCUBIN(p)
    return "", nvrtc.getCUBIN(p)


def parse(log):
    """-> {function: {registers, stack, frame, spill_st, spill_ld}} ; entry 'battle3v3_slice' included."""
    funcs = {}
    cur = None
    for line in log.splitlines():
        m = re.search(r"(?:Compiling entry function|Function properties for) '?([A-Za-z0-9_]+)'?", line)
        if m:
            cur = m.group(1)
            funcs.setdefault(cur, {})
            continue
        if cur is None:
            continue
        m = re.search(r"(\d+) bytes stack frame, (\d+) bytes spill stores, (\d+) bytes spill loads", line)
        if m:
            funcs[cur].update(frame=int(m.group(1)), spill_st=int(m.group(2)), spill_ld=int(m.group(3)))
        m = re.search(r"Used (\d+) registers", line)
        if m:
            funcs[cur]["registers"] = int(m.group(1))
            m2 = re.search(r"(\d+) bytes cumulative stack size", line)
            if m2:
                funcs[cur]["cum_stack"] = int(m2.group(1))
    return funcs


def demangle(name):
    m = re.match(r"_Z\d*?(\d+)([A-Za-z_][A-Za-z0-9_]*)", name)
    if not m:
        return name
    n = int(m.group(1)) if m.group(1) else 0
    return m.group(2)[:n] if n else name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", action="append")
    ap.add_argument("--out")
    a = ap.parse_args()
    names = a.variant or list(V.VARIANTS)
    res = {}
    for nm in names:
        src, opts = V.build_source(nm, defines=("SLICE",))
        log, cubin = ptxas_log(src, opts)
        os.makedirs(os.path.join(OUT, "cubin"), exist_ok=True)
        cp_ = os.path.join(OUT, "cubin", nm + ".cubin")
        open(cp_, "wb").write(cubin)
        open(os.path.join(OUT, "cubin", nm + ".sha"), "w").write(V.src_hash(src, opts))
        open(os.path.join(OUT, "cubin", nm + ".ptxas.log"), "w").write(log)
        f = parse(log)
        ent = f.get("battle3v3_slice", {})
        fn = {demangle(k): v for k, v in f.items() if not k.startswith("battle3v3_slice") and k != "slice_sizes"}
        # cuobjdump (CUDA 13 wheel) reports "does not contain device code" for NVRTC cubins, and every device function sits in
        # the entry's .text section (one register budget for the whole call tree), so per-function registers are not available;
        # ptxas -v still reports spills per function.
        res[nm] = {"entry": ent, "functions": fn, "opts": list(opts)}
        print(nm, json.dumps(ent), file=sys.stderr)
        print("   spills st/ld per function:", ", ".join(f"{k}={v.get('spill_st', 0)}/{v.get('spill_ld', 0)}" for k, v in fn.items() if v.get("spill_st")), file=sys.stderr, flush=True)
    if a.out:
        json.dump(res, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
