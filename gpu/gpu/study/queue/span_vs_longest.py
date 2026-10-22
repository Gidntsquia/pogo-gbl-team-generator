"""Fork "queue": per launch, kernel span vs the longest battle's in-launch time and the median battle's, from gpu-profile.json.

    python3 gpu/gpu/study/queue/span_vs_longest.py [run ...]  (default base-a base-b) -> out/gpu/study/queue/span-vs-longest.json

span = first battle start to last battle end; maxBattleMs = longest single battle (its start to its end, inside the launch).
span / maxBattle near 1.0 means the launch ends when its longest battle ends: no scheduler can make it shorter without
making that battle itself run faster (one thread group runs one battle; its turns cannot be split across threads).
"""
import json
import os
import statistics as st
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))


def main():
    runs = sys.argv[1:] or ["base-a", "base-b"]
    out = {"runs": {}}
    for r in runs:
        prof = json.load(open(os.path.join(REPO, "out", f"evolve-gpu8-{r}", "gpu-profile.json")))
        rows = []
        for s in prof["steps"]:
            for l in s["launches"]:
                if not l.get("spanMs"):
                    continue
                rows.append({"gen": s["gen"], "n": l["n"], "span_s": l["spanMs"] / 1000, "max_battle_s": l["maxBattleMs"] / 1000,
                             "p50_battle_s": l["p50BattleMs"] / 1000, "tail_s": l["tailMs"] / 1000,
                             "gap_s": (l["spanMs"] - l["maxBattleMs"]) / 1000, "span_over_max": l["spanMs"] / l["maxBattleMs"],
                             "max_over_p50": l["maxBattleMs"] / l["p50BattleMs"], "longest": l.get("longest")})
        tot_span = sum(x["span_s"] for x in rows)
        tot_gap = sum(x["gap_s"] for x in rows)
        out["runs"][r] = {"launches": rows, "n_launches": len(rows), "sum_span_s": tot_span, "sum_gap_s": tot_gap,
                          "gap_share": tot_gap / tot_span, "median_span_over_max": st.median(x["span_over_max"] for x in rows),
                          "max_span_over_max": max(x["span_over_max"] for x in rows),
                          "median_max_over_p50": st.median(x["max_over_p50"] for x in rows)}
        R = out["runs"][r]
        print(f"{r}: {R['n_launches']} launches, span sum {tot_span:.2f} s, span - longest battle sum {tot_gap:.3f} s "
              f"({100 * R['gap_share']:.2f}%), median span/longest {R['median_span_over_max']:.4f} (max {R['max_span_over_max']:.4f}), "
              f"median longest/median battle {R['median_max_over_p50']:.2f}")
    p = os.path.join(REPO, "out", "gpu", "study", "queue", "span-vs-longest.json")
    json.dump(out, open(p, "w"), indent=1)
    print("wrote", p)


if __name__ == "__main__":
    main()
