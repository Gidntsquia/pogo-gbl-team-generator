"""Round 10 R4: out/gpu/r10/ncu/summary.json, default vs lean on the 5k and 10k launches (same fields as round 9's
out/gpu/study/prof/ncu/summary.json, made by the same reader: gpu/gpu/study/tail/ncu_summary.py).

    python3 gpu/gpu/r10/ncu_summary.py        (no GPU; reads out/gpu/r10/ncu/<launch>-<variant>.g<k>.csv from ncu.sh)
Entries: "5k-default", "5k-lean", "10k-default", "10k-lean"; a launch/variant pair with no finished pass gets "no Nsight"
with the error line from its ncu.sh logs."""
import glob
import json
import os
import re
import sys

R = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
sys.path.insert(0, os.path.join(R, "gpu"))
from gpu.study.tail import ncu_summary as N  # noqa: E402

D = os.path.join(R, "out/gpu/r10/ncu")
LAUNCH = {"5k": "batch 7 (4,788 battles)", "10k": "batch 6 (10,920 battles)"}
VARIANT = {"default": "production kernel", "lean": "POGO_GPU_STUDY=lean (all steps)"}


def merged(name):
    files = sorted(glob.glob(os.path.join(D, f"{name}.g*.csv")))
    out, used = {}, []
    for f in files:
        m = N.read(f)
        took = 0
        for k in m:
            x = N.num(m, k)
            if x and k not in out:
                out[k] = m[k]
                took += 1
        if took:
            used.append(os.path.relpath(f, R))
    return out, used


def main():
    out = {}
    for launch in LAUNCH:
        for var in VARIANT:
            name = f"{launch}-{var}"
            m, used = merged(name)
            if m and N.num(m, "gpu__time_duration.sum"):
                N.LAUNCHES[name] = f"{LAUNCH[launch]}, {VARIANT[var]}"
                out[name] = N.summarize(name, m, used)
            else:
                errs = []
                for lg in sorted(glob.glob(os.path.join(D, f"{name}.g*.log"))):
                    errs += [l.strip() for l in open(lg) if "==ERROR==" in l][:1]
                out[name] = {"launch": f"{LAUNCH[launch]}, {VARIANT[var]}", "tool": "no Nsight",
                             "command": f"bash out/gpu/r10/ncu.sh {launch} {var}", "error": " | ".join(errs) or "no report written"}
    json.dump(out, open(os.path.join(D, "summary.json"), "w"), indent=1)
    for k, v in out.items():
        print(k, {x: v.get(x) for x in ("kernel_s_at_base_clock", "achieved_occupancy_pct", "local_bytes_gb", "tool")},
              [s for s in v.get("top5_stalls", []) if s["reason"] == "long_scoreboard"])


if __name__ == "__main__":
    main()
