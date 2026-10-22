"""Round 9 R2/R3: merge Nsight Compute CSVs into out/gpu/study/prof/ncu/summary.json (the numbers the study page reads).

    python3 gpu/gpu/study/ncu/ncu_summary.py            (no GPU; reads only CSV files)

Per launch it takes, metric by metric, the first non-zero value from: <name>.csv (one full ncu run), <name>.g<k>.csv (ncu.sh
groups), r8-sourcecounters/<name>.csv (a run that died part way: ncu keeps the passes before the failure, and a metric from a
pass that never ran reads 0). A launch with no counters gets "no Nsight", the commands tried and their error, and the
clock-timer SM-active share from round 8's segment records (out/gpu/study/prof/sm-timeline.json).
Stall share = that reason's warp cycles per issued instruction / the sum over every reason.
"""
import csv
import glob
import json
import os
import sys

R = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
D = os.path.join(R, "out/gpu/study/prof/ncu")
STALL = "smsp__average_warps_issue_stalled_"
TB = {"byte": 1, "Kbyte": 1e3, "Mbyte": 1e6, "Gbyte": 1e9, "Tbyte": 1e12}
LAUNCHES = {"5k": "batch 7 (4,788 battles)", "10k": "batch 6 (10,920 battles)", "36k": "gen 0's three launches merged (36,000 battles)"}
# R3 (out/gpu/study/prof/ncu-tail.sh): the 5k launch through the round-9 tail kernel, filler off and on (pool = batch 6[:6000])
VARIANTS = {"5k-tailoff": "batch 7 through the tail kernel, filler off", "5k-tailon": "batch 7 + pool of 6,000 (batch 6) through the tail kernel, POGO_GPU_STUDY=tail"}
VARIANT_BLOCKED = {
    "tail,certain": "not profiled: its host feeds the in-kernel queue while the kernel runs, and kernel replay reruns the "
                    "kernel with no host on the other side; SM-active for it comes from the clock-timer timeline (tail-timeline.json)",
    "10k, 36k": "not profiled with the tail kernel: the baseline ncu runs of these launches reset the display driver (BLOCKED above)",
}
# launches tried here; key = launch, value = (files, note); 36k: every try died at pass 1 (see BLOCKED)
BLOCKED = {
    "36k": {
        "command": "ncu --target-processes all -k battle3v3_slice --launch-skip 1 --launch-count 1 --replay-mode kernel "
                   "--cache-control all --clock-control base --section ... uv run python -m gpu.study.prof.replay launch "
                   "--dump out/gpu/study/prof/dump --spec 0+1+2 --name ncu-36k --reps 1",
        "error": "==ERROR== LaunchFailed (CUDA error 999) at pass 1 on both tries (the round-8 one-shot run, whose report is r8-sourcecounters/36k.csv, and out/gpu/study/prof/ncu-r9.log, 2026-10-17 before 10:51 ET); "
                 "Windows logged 'Display driver nvlddmkm stopped responding and has successfully recovered' (event 4101) "
                 "31 times 10:33-10:57 ET, so profiling was stopped to keep the desktop usable",
    }
}


def read(path):
    rows = list(csv.reader(open(path)))
    if len(rows) < 3:
        return {}
    return {k: (u, v) for k, u, v in zip(rows[0], rows[1], rows[2])}


def num(m, k):
    if k not in m:
        return None
    u, v = m[k]
    try:
        x = float(v.replace(",", ""))
    except ValueError:
        return None
    if x != x:
        return None
    return x * TB.get(u, 1) if u in TB else x


def merged(name):
    files = [f for f in [os.path.join(D, f"{name}.csv"), *sorted(glob.glob(os.path.join(D, f"{name}.g*.csv"))),
                         os.path.join(D, "r8-sourcecounters", f"{name}.csv")] if os.path.exists(f)]
    out, used = {}, []
    for f in files:
        m = read(f)
        took = 0
        for k in m:
            x = num(m, k)
            if x and k not in out:
                out[k] = (m[k][0], m[k][1])
                took += 1
        if took:
            used.append(os.path.relpath(f, R))
    return out, used


def summarize(name, m, used):
    g = lambda k: num(m, k)
    stalls = {k[len(STALL):-len("_per_issue_active.ratio")]: g(k) for k in m if k.startswith(STALL) and k.endswith("_per_issue_active.ratio")}
    stalls = {k: v for k, v in stalls.items() if v is not None}
    tot = sum(stalls.values())
    top = sorted(stalls.items(), key=lambda kv: -kv[1])[:5]
    loc = (g("l1tex__t_bytes_pipe_lsu_mem_local_op_ld.sum") or 0) + (g("l1tex__t_bytes_pipe_lsu_mem_local_op_st.sum") or 0)
    glb = (g("l1tex__t_bytes_pipe_lsu_mem_global_op_ld.sum") or 0) + (g("l1tex__t_bytes_pipe_lsu_mem_global_op_st.sum") or 0)
    act, ela = g("sm__cycles_active.avg"), g("gpc__cycles_elapsed.avg") or g("sm__cycles_elapsed.avg")
    r = lambda x, d=1: None if x is None else round(x, d)
    return {
        "launch": {**LAUNCHES, **VARIANTS}[name], "tool": "Nsight Compute 2025.4.1, kernel replay, base clocks", "files": used,
        "kernel_s_at_base_clock": r(g("gpu__time_duration.sum"), 3),
        "warp_cycles_per_issued_instruction": r(tot, 2),
        "top5_stalls": [{"reason": k, "cycles_per_issued_instruction": r(v, 2), "share_pct": r(100 * v / tot)} for k, v in top],
        "issue_slot_use_pct": r(g("smsp__issue_active.avg.pct_of_peak_sustained_active")),
        "achieved_occupancy_pct": r(g("sm__warps_active.avg.pct_of_peak_sustained_active")),
        "active_threads_per_warp": r(g("smsp__thread_inst_executed_per_inst_executed.ratio"), 2),
        "l1_hit_pct": r(g("l1tex__t_sector_hit_rate.pct")),
        "l1_local_load_hit_pct": r(g("l1tex__t_sector_pipe_lsu_mem_local_op_ld_hit_rate.pct")),
        "l2_hit_pct": r(g("lts__t_sector_hit_rate.pct")),
        "local_bytes_gb": r(loc / 1e9), "global_bytes_gb": r(glb / 1e9, 2),
        "local_share_of_l1_bytes_pct": r(100 * loc / (loc + glb), 2) if loc + glb else None,
        "sm_active_share_pct": r(100 * act / ela) if act and ela else None,
    }


def main():
    out = {}
    tl = json.load(open(os.path.join(R, "out/gpu/study/prof/sm-timeline.json")))["launches"]
    for name in LAUNCHES:
        m, used = merged(name)
        if m and num(m, "gpu__time_duration.sum"):  # a run with no finished pass leaves stray non-zero fields only
            out[name] = summarize(name, m, used)
            if name == "10k":
                out[name]["note"] = ("the run died at pass 25 of 42 (ncu-r9.log): every metric listed here comes from passes 1-24; "
                                     "sm elapsed cycles were in a later pass, so SM-active uses gpc__cycles_elapsed (same clock)")
        else:
            out[name] = {"launch": LAUNCHES[name], "tool": "no Nsight", **BLOCKED.get(name, {}),
                         "fallback": "clock timer (%globaltimer segment records, round 8 prof variant)",
                         "sm_active_share_pct": round(100 * tl[name]["sm_active_share_mean"], 1)}
        if name in tl:
            out[name]["sm_active_share_clock_timer_pct"] = round(100 * tl[name]["sm_active_share_mean"], 1)
    var = {}
    for name in VARIANTS:
        m, used = merged(name)
        if m and num(m, "gpu__time_duration.sum"):
            var[name] = summarize(name, m, used)
        else:
            log = os.path.join(R, "out/gpu/study/prof/ncu-tail.log")
            lines = [l.strip() for l in open(log)] if os.path.exists(log) else []
            blk, on = [], False  # this variant's block of the log: "== <name> start" .. "== <name> exit"
            for l in lines:
                if l.startswith(f"== {name} start"):
                    on = True
                if on:
                    blk.append(l)
                if l.startswith(f"== {name} exit"):
                    on = False
            err = [l for l in blk if l.startswith("==ERROR==") or l.startswith(f"== {name} exit")]
            var[name] = {"launch": VARIANTS[name], "tool": "no Nsight", "command": "bash out/gpu/study/prof/ncu-tail.sh",
                         "error": " | ".join(err) if err else "no report written (see ncu-tail.log)"}
            if err:
                var[name]["error"] += ("; Windows logged 'Display driver nvlddmkm stopped responding and has successfully recovered' "
                                       "(event 4101) at 13:35:53, 13:36:07 and 13:36:16 ET on 2026-10-17, during these two runs, "
                                       "so they were not retried")
    out["variants"] = var
    out["variants_not_profiled"] = VARIANT_BLOCKED
    json.dump(out, open(os.path.join(D, "summary.json"), "w"), indent=1)
    json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main()
