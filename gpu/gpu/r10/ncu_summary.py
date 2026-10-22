"""Round 10/11 Nsight summary: out/gpu/r10/ncu/summary.json, the only source of profile numbers.

    python3 gpu/gpu/r10/ncu_summary.py        (no GPU; reads out/gpu/r10/ncu/<launch>-<variant>.g<k>.csv)
Entries "<5k|10k>-<variant>" for variants in VARIANT. Same fields as round 9 (gpu/gpu/study/ncu/ncu_summary.py). A metric group
(g0 stalls, g1 occupancy/issue, g2 local bytes, g3 cache hits, g4 time) with no report is named in "missing_groups"; an entry with
none of them is "missing: driver reset xN" (N = failed tries in its logs), never "no Nsight"."""
import glob
import json
import os
import sys

R = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
sys.path.insert(0, os.path.join(R, "gpu"))
from gpu.study.ncu import ncu_summary as N  # noqa: E402

D = os.path.join(R, "out/gpu/r10/ncu")
LAUNCH = {"5k": "batch 7 (4,788 battles)", "10k": "batch 6 (10,920 battles)"}
VARIANT = {
    "default": "production kernel", "stack": "POGO_GPU_STUDY=stack", "lean1": "POGO_GPU_STUDY=lean POGO_GPU_LEAN=1",
    "lean2": "POGO_GPU_STUDY=lean (step 2, the lean default)", "lean3": "POGO_GPU_STUDY=lean POGO_GPU_LEAN=3",
    "lean4": "POGO_GPU_STUDY=lean POGO_GPU_LEAN=4", "lean2q": "POGO_GPU_STUDY=lean POGO_GPU_LEAN=2q",
    "lean5": "POGO_GPU_STUDY=lean POGO_GPU_LEAN=5 (round 11 candidate: turn-keyed queue)",
    "leancap": "POGO_GPU_STUDY=lean,cap POGO_GPU_CAP=192",
    "lean6": "lean 6 (round 12 standard kernel: step 3 + turn-keyed queue)",
    "lean6cap": "lean 6 + POGO_GPU_STUDY=cap POGO_GPU_CAP=192",
}
VARIANT.update(json.load(open(os.path.join(D, "extra-variants.json"))) if os.path.exists(os.path.join(D, "extra-variants.json")) else {})
GROUPS = {0: "stalls", 1: "occupancy/issue", 2: "local bytes", 3: "cache hits", 4: "kernel time"}


def merged(name):
    out, used, missing = {}, [], []
    for k in GROUPS:
        f = os.path.join(D, f"{name}.g{k}.csv")
        rep = os.path.join(D, f"{name}.g{k}.ncu-rep")
        if not (os.path.exists(f) and os.path.getsize(f) > 0 and os.path.exists(rep) and os.path.getsize(rep) > 0):
            missing.append(f"g{k} ({GROUPS[k]})")
            continue
        m = N.read(f)
        for key in m:
            x = N.num(m, key)
            if x and key not in out:
                out[key] = m[key]
        used.append(os.path.relpath(f, R))
    return out, used, missing


def tries(name):
    n = 0
    for lg in glob.glob(os.path.join(D, f"{name}.g*.log")):
        n += sum(1 for l in open(lg) if "==ERROR==" in l)
        if os.path.getsize(lg) == 0:
            n += 1
    return n


def main():
    out = {}
    for launch in LAUNCH:
        for var in VARIANT:
            name = f"{launch}-{var}"
            m, used, missing = merged(name)
            what = f"{LAUNCH[launch]}, {VARIANT[var]}"
            if m and N.num(m, "gpu__time_duration.sum"):
                N.LAUNCHES[name] = what
                out[name] = N.summarize(name, m, used)
                out[name]["missing_groups"] = missing
            else:
                n = tries(name)
                out[name] = {"launch": what, "tool": f"missing: driver reset x{n}" if n else "missing: not yet run",
                             "missing_groups": missing, "command": f"bash out/gpu/r11/ncu.sh {launch} {var}"}
    json.dump(out, open(os.path.join(D, "summary.json"), "w"), indent=1)
    for k, v in out.items():
        ls = [s["share_pct"] for s in v.get("top5_stalls", []) if s["reason"] == "long_scoreboard"]
        print(f"{k:14s} kernel {v.get('kernel_s_at_base_clock')} occ {v.get('achieved_occupancy_pct')} issue {v.get('issue_slot_use_pct')} "
              f"local GB {v.get('local_bytes_gb')} long_sb {ls} {v['tool'] if 'missing' in v['tool'] else ''} {v['missing_groups'] or ''}")


if __name__ == "__main__":
    main()
