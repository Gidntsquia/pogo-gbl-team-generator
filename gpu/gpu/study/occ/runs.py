"""occ study: warm s/gen of chain runs and checkpoint equality against base-a (timing fields ignored).

    python3 -m gpu.study.occ.runs base-a base-b occ-a occ-b ... [--out FILE]
"""
import argparse
import json
import os
import statistics

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..")
SKIP = {"timing", "runStartedAt", "threadsUsed", "resumed", "analytics", "elapsedMs", "msPerBattle"}


def run_stats(name):
    d = os.path.join(ROOT, "out", f"evolve-gpu8-{name}")
    p = json.load(open(os.path.join(d, "gpu-profile.json")))
    gens = p["generations"]
    warm = [g["wall"] for g in gens[1:]]
    kern = [g["buckets"]["kernel"] + g["buckets"]["tail"] for g in gens[1:]]
    log = open(os.path.join(ROOT, "out", f"evolve-gpu8-{name}.log")).read().splitlines()
    dev = next((l for l in log if l.startswith("gpu device")), "")
    w0 = float(next(l.split()[-1] for l in log if l.startswith("wall start")))
    w1 = float(next(l.split()[-1] for l in log if l.startswith("wall end")))
    return {"gens": len(gens), "warm_s_per_gen_mean": statistics.mean(warm), "warm_s_per_gen_median": statistics.median(warm),
            "warm_gpu_s_per_gen_mean": statistics.mean(kern), "total_wall_s": w1 - w0, "device": dev, "exit": log[-1]}


def strip(x):
    if isinstance(x, dict):
        return {k: strip(v) for k, v in x.items() if k not in SKIP}
    if isinstance(x, list):
        return [strip(v) for v in x]
    return x


def same_as(name, ref="base-a"):
    a = os.path.join(ROOT, "out", f"evolve-gpu8-{ref}")
    b = os.path.join(ROOT, "out", f"evolve-gpu8-{name}")
    res = {}
    for f in sorted(os.listdir(a)):
        if f.startswith("evolve-gen") and f.endswith(".json"):
            pb = os.path.join(b, f)
            res[f] = os.path.exists(pb) and strip(json.load(open(os.path.join(a, f)))) == strip(json.load(open(pb)))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="+")
    ap.add_argument("--out")
    a = ap.parse_args()
    res = {}
    for n in a.names:
        r = run_stats(n)
        eq = same_as(n)
        r["checkpoints_equal_base_a"] = f"{sum(eq.values())}/{len(eq)}"
        res[n] = r
        print(n, json.dumps(r))
    if a.out:
        json.dump(res, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
