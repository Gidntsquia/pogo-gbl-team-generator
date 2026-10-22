"""Fork "cpushare": warm s/gen of the CPU-share chain runs against the baseline, and what the CPU side did per step.

    python3 gpu/gpu/study/cpushare/share_analysis.py -> out/gpu/study/cpushare/share-analysis.json

Per run: warm s/gen (mean generation wall from the saturation generation on, plans round 8 R8), total wall (log "wall
start/end"), battles/s. Per step with a CPU share: CPU battles, CPU seconds, GPU path seconds, which side finished last
(waitCpu > 0 means the GPU waited for the CPU), and the CPU rate beside the GPU (battles / CPU seconds).
"""
import json
import os
import re
import statistics as st

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
RUNS = ["base-a", "base-b", "cpushare-auto-a", "cpushare-auto-b", "cpushare-0.01-a", "cpushare-0.01-b", "cpushare-share0-a", "cpushare-0.01-c", "cpushare-share0-b", "cpushare-0.003-a", "cpushare-0.003-b"]


def warm(prof):
    rate = {}
    for s in prof["steps"]:
        if not isinstance(s["gen"], int):
            continue
        m, n = rate.get(s["gen"], (0, 0))
        rate[s["gen"]] = (m + s["memoHits"], n + s["memoHits"] + s["n"])
    gens = sorted(rate)
    r = {g: rate[g][0] / max(1, rate[g][1]) for g in gens}
    tail = st.mean(r[g] for g in gens[-5:])
    sat = next(g for g in gens if abs(r[g] - tail) <= 0.02)
    return [g for g in gens if g >= sat], sat


def run_info(name):
    d = os.path.join(REPO, "out", f"evolve-gpu8-{name}")
    p = os.path.join(d, "gpu-profile.json")
    if not os.path.exists(p):
        return None
    prof = json.load(open(p))
    wg, sat = warm(prof)
    gens = {g["gen"]: g for g in prof["generations"]}
    log = open(os.path.join(REPO, "out", f"evolve-gpu8-{name}.log")).read()
    w0, w1 = (float(re.search(rf"wall {k} ([0-9.]+)", log).group(1)) for k in ("start", "end"))
    battles = sum(g["battles"] for g in prof["generations"])
    steps = [s for s in prof["steps"] if s.get("cpuCount")]
    srec = [{"gen": s["gen"], "n": s["n"], "cpu": s["cpuCount"], "cpu_s": s["cpuShareS"], "gpu_path_s": s["gpuPathS"],
             "wait_cpu_s": s["buckets"]["waitCpu"], "cpu_bps": s["cpuCount"] / s["cpuShareS"] if s["cpuShareS"] else None,
             "cpu_last": s["buckets"]["waitCpu"] > 0.01} for s in steps]
    return {"run": name, "saturation_gen": sat, "warm_gens": wg, "warm_s_per_gen": st.mean(gens[g]["wall"] for g in wg),
            "warm_wait_cpu_s_per_gen": st.mean(gens[g]["buckets"]["waitCpu"] for g in wg),
            "warm_gpu_s_per_gen": st.mean(gens[g]["buckets"]["kernel"] + gens[g]["buckets"]["tail"] for g in wg),
            "total_wall_s": w1 - w0, "battles": battles, "bps": battles / (w1 - w0),
            "cpu_steps": len(srec), "cpu_last_steps": sum(x["cpu_last"] for x in srec),
            "cpu_bps_median": st.median([x["cpu_bps"] for x in srec if x["cpu_bps"]]) if srec else None, "steps": srec}


def main():
    res = {r: run_info(r) for r in RUNS}
    res = {k: v for k, v in res.items() if v}
    p = os.path.join(REPO, "out", "gpu", "study", "cpushare", "share-analysis.json")
    json.dump(res, open(p, "w"), indent=1)
    for r, v in res.items():
        print(f"{r}: warm {v['warm_s_per_gen']:.2f} s/gen (gens {v['warm_gens'][0]}-{v['warm_gens'][-1]}), gpu {v['warm_gpu_s_per_gen']:.2f}, "
              f"waitCpu {v['warm_wait_cpu_s_per_gen']:.2f}, total {v['total_wall_s']:.1f} s, {v['bps']:.0f} b/s, "
              f"cpu steps {v['cpu_steps']} (CPU last in {v['cpu_last_steps']}), cpu b/s median {v['cpu_bps_median']}")
    print("wrote", p)


if __name__ == "__main__":
    main()
