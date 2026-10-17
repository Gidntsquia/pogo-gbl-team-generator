"""Fork "cpushare": GPU path time on the steps whose battles are the same with and without a CPU share.

    python3 gpu/gpu/study/cpushare/same_steps.py -> out/gpu/study/cpushare/same-steps.json

Gens 0 and 1 run the same battles in every run (same seed; a CPU share first changes scores in gen 0, so the GA
diverges from gen 2 on). For each such step: n, battles sent to the CPU, step wall (kernel + tail + waitCpu) per run.
"""
import json
import os
import statistics as st

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
GROUPS = {"share0": ["cpushare-share0-a", "cpushare-share0-b"], "0.01": ["cpushare-0.01-a", "cpushare-0.01-c"],
          "0.003": ["cpushare-0.003-a", "cpushare-0.003-b"], "auto": ["cpushare-auto-a", "cpushare-auto-b"]}


def steps(run):
    p = json.load(open(os.path.join(REPO, "out", f"evolve-gpu8-{run}", "gpu-profile.json")))
    return [(s["n"], s.get("cpuCount", 0), s["buckets"]["kernel"] + s["buckets"]["tail"] + s["buckets"]["waitCpu"])
            for s in p["steps"] if s["gen"] in (0, 1)]


def main():
    res = {}
    for g, runs in GROUPS.items():
        per = [steps(r) for r in runs]
        res[g] = {"runs": runs, "n": [x[0] for x in per[0]], "cpu": [x[1] for x in per[0]],
                  "step_s_mean": [st.mean(p[i][2] for p in per) for i in range(len(per[0]))]}
        res[g]["sum_s"] = sum(res[g]["step_s_mean"])
    base = res["share0"]["sum_s"]
    for g, v in res.items():
        v["vs_share0_s"] = v["sum_s"] - base
        print(f"{g}: gens 0-1 GPU path {v['sum_s']:.2f} s ({v['vs_share0_s']:+.2f} vs share0), steps "
              + ", ".join(f"{n}/{c}:{t:.2f}" for n, c, t in zip(v["n"], v["cpu"], v["step_s_mean"])))
    p = os.path.join(REPO, "out", "gpu", "study", "cpushare", "same-steps.json")
    json.dump(res, open(p, "w"), indent=1)
    print("wrote", p)


if __name__ == "__main__":
    main()
