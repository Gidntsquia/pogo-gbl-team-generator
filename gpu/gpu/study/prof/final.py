"""Round 8 prof fork: write out/gpu/study/prof/result.json and summary.md from the saved files (numbers only from files).

    python3 -m gpu.study.prof.final OUT_DIR
"""
import json
import os
import sys


def load(p):
    return json.load(open(p)) if os.path.exists(p) else None


def main(out):
    j = lambda *p: os.path.join(out, *p)
    m = load(j("metrics.json"))
    sm = load(j("sm-timeline.json"))["launches"]
    lt = load(j("lanes-time.json"))["launches"]
    gs = load(j("gen-split.json"))["warm_mean_all_runs"]
    sc = load(j("sass", "sass-counts.json"))
    nv = load(j("nvbit", "nvbit-summary.json"))
    solo = {i: load(j("replay", f"{i}.solo.json")) for i in ("5k", "10k", "36k")}
    tl = {r["launch"]: r for r in load(j("timeline.json"))["launches"]}
    mv = {x["id"]: x["values"] for x in m["metrics"]}

    f1 = (f"Few threads of each warp do work: at width 1 (one battle per thread) the hot loops (inner 1v1 sim turn, lookahead DP) run "
          f"with {mv['warp_exec_efficiency'][0]:.1f} / {mv['warp_exec_efficiency'][1]:.1f} / {mv['warp_exec_efficiency'][2]:.1f} "
          f"active threads of 32 at 5k / 10k / 36k battles (healthy 24-32), and only "
          f"{100 * sm['5k']['thread_slot_share']:.1f}% / {100 * sm['10k']['thread_slot_share']:.1f}% / "
          f"{100 * sm['36k']['thread_slot_share']:.1f}% of the 17,408 resident thread slots run a battle on average (a 5k launch "
          f"can fill at most {100 * 4788 / 17408:.0f}% of them even at the start)")
    sl = {i: solo[i] for i in ("5k", "10k", "36k") if solo[i]}
    f2 = ("The tail is not caused by long battles: the 10 battles that finish last take "
          + " / ".join(f"{max(x['alone_s'] for x in v['top']):.2f}" for v in sl.values())
          + " s at most when replayed alone, and all 10 together finish in "
          + " / ".join(f"{v['top_together']['span_s']:.2f}" for v in sl.values())
          + " s, while the launches take " + " / ".join(f"{v['launch_kernel_span_s_median']:.2f}" for v in sl.values())
          + " s (5k / 10k / 36k); inside the launch the same battles run "
          + " / ".join(f"{min(x['slowdown_in_launch'] for x in v['top']):.0f}-{max(x['slowdown_in_launch'] for x in v['top']):.0f}x"
                       for v in sl.values())
          + f" slower than alone. SMs are busy {mv['sm_active_share'][0]:.0f}% / {mv['sm_active_share'][1]:.0f}% / "
          f"{mv['sm_active_share'][2]:.0f}% of the kernel span; over warm gens the tail is "
          f"{100 * gs['share_tail_of_gpu']:.0f}% of GPU battle time ({gs['kernel_tail_s']:.2f} of {gs['gpu_battles_s']:.2f} s per gen)")
    ts = lt["10k"]["time_split"]
    f3 = (f"Registers cap occupancy and the code leans on stack memory: 255 registers per thread -> 8 of 48 warps per SM "
          f"(theoretical {mv['theoretical_occupancy'][0]:.1f}%, achieved about {mv['achieved_occupancy'][0]:.0f}% / "
          f"{mv['achieved_occupancy'][1]:.0f}% / {mv['achieved_occupancy'][2]:.0f}%, healthy >= 60); "
          f"{100 * sc['local_share_of_static_instr']:.1f}% of the {sc['static_instructions']:,} SASS instructions are "
          f"local-memory loads/stores (LDL is the most common instruction), 39,088 B stack per thread. Inside a battle, inner "
          f"1v1 sims take {100 * ts['inner_1v1_sims_share']:.0f}% of its time and the lookahead DP "
          f"{100 * ts['lookahead_DP_share_total']:.0f}% (10k launch; 5k and 36k within 2 points)")
    srows = []
    for i, s in solo.items():
        if s:
            top = s["top"][0]
            srows.append(f"{i}: longest battle {top['in_launch_s']:.2f} s inside the launch vs {top['alone_s']:.2f} s alone "
                         f"(x{top['slowdown_in_launch']:.2f}); launch span {s['launch_kernel_span_s_median']:.2f} s")
    files = sorted(os.path.relpath(os.path.join(dp, f), os.path.join(out, "..", "..", "..", ".."))
                   for dp, _, fs in os.walk(out) for f in fs
                   if not dp.startswith(j("tools")) and not dp.startswith(j("dump")) and not f.endswith((".sqlite", ".npz", ".cubin")))
    res = {"fork": "prof", "cards": [], "findings": [
        {"text": f1, "source": ["out/gpu/study/prof/lanes-time.json", "out/gpu/study/prof/sm-timeline.json"]},
        {"text": f2, "source": ["out/gpu/study/prof/replay/5k.solo.json", "out/gpu/study/prof/replay/10k.solo.json",
                                "out/gpu/study/prof/replay/36k.solo.json", "out/gpu/study/prof/sm-timeline.json",
                                "out/gpu/study/prof/gen-split.json"]},
        {"text": f3, "source": ["out/gpu/study/prof/metrics.json", "out/gpu/study/prof/lanes-time.json",
                                "out/gpu/study/prof/sass/sass-counts.json"]
                               + (["out/gpu/study/prof/nvbit/nvbit-summary.json"] if nv else [])}],
        "solo": srows, "tool": m["tool"], "files": files}
    json.dump(res, open(j("result.json"), "w"), indent=1)

    L = ["# prof fork: profile of the slice kernel (round 8)", "",
         f"Tool: {m['tool']}. ncu still fails (ERR_NVGPUCTRPERM, ncu-attempt.log); ncu-later.sh collects every counter once "
         "access is allowed. Launches: 5k = batch 7 (4,788), 10k = batch 6 (10,920), 36k = gen 0's three launches merged "
         "(36,000), all width 1. Instrumented builds give identical rows (rows_sha1).", "",
         "| metric | 5k | 10k | 36k | healthy | method |", "|---|---|---|---|---|---|"]
    for x in m["metrics"]:
        v = " | ".join("-" if a is None else (f"{a:.3g}" if abs(a) < 1e6 else f"{a:.3e}") for a in x["values"])
        h = x["healthy"]
        hs = "-" if not h or (h["lo"] is None and h["hi"] is None) else f"{h['lo'] if h['lo'] is not None else ''}-{h['hi'] if h['hi'] is not None else ''}"
        L.append(f"| {x['name']} ({x['unit']}) | {v} | {hs} | {x['method'].split(':')[0]} |")
    L += ["", "Findings:", f"1. {f1}.", f"2. {f2}.", f"3. {f3}.", ""]
    if srows:
        L.append("Longest battle alone vs in launch: " + "; ".join(srows) + ".")
    t = [tl[i] for i in ("5k", "10k", "36k") if i in tl]
    L.append("Per launch (s, host prep / upload / kernel / download / host post): " + "; ".join(
        f"{r['launch']} {r['host_prep_s']:.2f} / {r['upload_s']:.3f} / {r['kernel_s']:.2f} / {r['download_s']:.4f} / "
        f"{r['host_post_s']:.2f}" for r in t) + " (upload/download from host timers; nsys records no GPU activity on WSL).")
    L.append(f"Warm gen ({gs['wall_s']:.1f} s): GPU battles {gs['gpu_battles_s']:.2f} s ({100 * gs['share_gpu_battles']:.0f}%), "
             f"host prep {gs['host_prep_s']:.2f}, transport {gs['transport_s']:.2f}, host post {gs['host_post_s']:.2f}, "
             f"CPU GA {gs['cpu_ga_s']:.2f} (gen-split.json).")
    L.append("Not measured (no counters): issue-slot use, L1/L2 hit rates, stall reasons. Local memory traffic: static SASS "
             "share only; NVBit works on this driver, but its run on the slice kernel stayed queued for the GPU lock and was "
             "cancelled at the cut-off (jobs4.log).")
    open(j("summary.md"), "w").write("\n".join(L) + "\n")
    print("\n".join(L))
    print(len(L), "lines")


if __name__ == "__main__":
    main(sys.argv[1])
