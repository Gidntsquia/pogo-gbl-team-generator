"""Round 8 prof fork: assemble out/gpu/study/prof/metrics.json (coordinator schema + R2 fields) from the saved files.

    python3 -m gpu.study.prof.build OUT_DIR
Every value is read from a file under OUT_DIR; a metric that no file measures gets null values and says why in "method".
"""
import json
import os
import sys

IDS = ("5k", "10k", "36k")
TRIAGE = "https://docs.nvidia.com/nsight-compute/ComputeTriage/index.html"


def load(p):
    return json.load(open(p)) if os.path.exists(p) else None


def main(out):
    lit = json.load(open(os.path.join(out, "..", "lit", "healthy-ranges.json")))
    sm = load(os.path.join(out, "sm-timeline.json")) or {"launches": {}}
    lt = load(os.path.join(out, "lanes-time.json")) or {"launches": {}}
    tl = load(os.path.join(out, "timeline.json")) or {"launches": []}
    sass = load(os.path.join(out, "sass", "sass-counts.json"))
    nvb = load(os.path.join(out, "nvbit", "nvbit-summary.json"))
    lj = {i: load(os.path.join(out, "replay", f"{i}-prod.launch.json")) for i in IDS}

    def hr(key):
        h = lit.get(key)
        return {"lo": h.get("lo"), "hi": h.get("hi"), "source": h.get("url")} if h else None

    def per(get):
        v = []
        for i in IDS:
            try:
                v.append(get(i))
            except (KeyError, TypeError, ZeroDivisionError):
                v.append(None)
        return v

    max_warps = 48
    res_warps_sm = 8  # 255 registers -> 8,192 per warp (256-register allocation unit) -> 8 warps fill the 65,536 registers (sass res-usage)
    M = []

    def add(id_, name, unit, values, healthy, method, what, ours, means, src):
        M.append({"id": id_, "name": name, "name_plain": name, "unit": unit, "values": values,
                  "value_per_launch": dict(zip(IDS, values)), "healthy": healthy, "method": method,
                  "what": what, "what_it_is": what, "ours": ours, "means": means, "means_for_speed": means,
                  "source_file": src})

    theo = 100.0 * res_warps_sm / max_warps
    add("theoretical_occupancy", "theoretical occupancy", "% of 48 warps per SM", [theo] * 3, None,
        "static: register limit from cuobjdump -res-usage of the production cubin (255 registers per thread -> 8 warps of 32 per SM)",
        "the most warps an SM can hold for this kernel, as a share of the hardware maximum (48 on sm_86)",
        f"{theo:.1f}% (8 of 48 warps); registers are the limit", "few warps to switch between when one waits on memory",
        "out/gpu/study/prof/sass/sass-counts.json")
    ach = per(lambda i: 100.0 * sm["launches"][i]["warp_slot_share"] * res_warps_sm / max_warps)
    add("achieved_occupancy", "achieved occupancy", "% of 48 warps per SM", ach, hr("achieved_occupancy_pct"),
        "estimate (no counters): warps with at least one thread running a battle segment, time-averaged over the kernel "
        "span, from the slice kernel's segment records; x theoretical",
        "warps actually resident and running, as a share of the hardware maximum, averaged over the launch",
        " / ".join(f"{i} {v:.1f}%" if v is not None else f"{i} n/a" for i, v in zip(IDS, ach)),
        "far under the 60% healthy floor because only 8 of 48 warp slots exist; the tail lowers it further",
        "out/gpu/study/prof/sm-timeline.json")
    wee = per(lambda i: lt["launches"][i]["hot_loops_active_threads_per_visit"])
    add("warp_exec_efficiency", "warp execution efficiency (active threads per warp step)", "threads of 32", wee,
        hr("warp_execution_efficiency_threads_per_instruction"),
        "estimate (instrumented build, no counters): mean active threads at each visit of the inner 1v1 sim loop and "
        "the lookahead DP loop (popc of __activemask), not per instruction",
        "how many of a warp's 32 threads do useful work each time the warp steps",
        " / ".join(f"{i} {v:.1f}" if v is not None else f"{i} n/a" for i, v in zip(IDS, wee)),
        "each thread runs its own battle (width 1), so threads in one warp are in different branches; the warp runs "
        "each branch in turn", "out/gpu/study/prof/lanes-time.json")
    add("issue_slot_util", "issue-slot utilization", "%", [None] * 3, hr("issue_slot_utilization_pct"),
        "not measured (no counters): ncu fails with ERR_NVGPUCTRPERM (ncu-attempt.log); run ncu-later.sh once counters "
        "are allowed", "share of cycles the warp schedulers issue an instruction", "not measured",
        "would show whether the SMs are starved for ready warps", "out/gpu/study/prof/ncu-attempt.log")
    if nvb:
        lb = per(lambda i: nvb["launches"][i]["local_bytes_est"])
        ls = per(lambda i: 100.0 * nvb["launches"][i]["local_instr_share"])
        meth = "NVBit opcode histogram (dynamic warp-level LDL/STL counts) x access width x active threads: estimate"
        src = "out/gpu/study/prof/nvbit/nvbit-summary.json"
    else:
        lb, ls = [None] * 3, [None] * 3
        meth = ("not measured (no counters; NVBit 1.8.1 loads and instruments kernels on this driver, but the run that covered the slice kernel did not finish before the deadline: nvbit/nvbit-5k.log instrumented only slice_sizes; see jobs4.log). Static only: "
                + (f"{sass['classes']['local_LDL']} LDL + {sass['classes']['local_STL']} STL of "
                   f"{sass['static_instructions']} SASS instructions" if sass else "SASS not available"))
        src = "out/gpu/study/prof/sass/sass-counts.json"
    stat = (f"static: {100 * sass['local_share_of_static_instr']:.1f}% of SASS instructions are LDL/STL; 39,088 B stack "
            "per thread" if sass else "39,088 B stack per thread")
    add("local_mem_bytes", "local (stack) memory traffic", "bytes", lb, hr("local_memory_traffic"), meth,
        "bytes each launch reads and writes in per-thread local memory (the stack: battle state, lookahead pool)", stat,
        "local memory goes through L1/L2 like global memory; heavy traffic means threads wait on memory", src)
    add("local_mem_share", "local memory share of instructions", "% of executed instructions", ls,
        hr("local_memory_traffic"), meth, "LDL+STL as a share of all executed instructions", stat,
        "the larger, the more of the kernel is moving stack data rather than computing", src)
    add("l1_hit", "L1 hit rate", "%", [None] * 3, hr("l1_hit_rate_pct"),
        "not measured (no counters): needs ncu (ERR_NVGPUCTRPERM); ncu-later.sh collects it",
        "share of L1 requests served from L1", "not measured", "local memory traffic misses L1 -> L2 latency",
        "out/gpu/study/prof/ncu-attempt.log")
    add("l2_hit", "L2 hit rate", "%", [None] * 3, hr("l2_hit_rate_pct"),
        "not measured (no counters): needs ncu (ERR_NVGPUCTRPERM); ncu-later.sh collects it",
        "share of L2 requests served from L2", "not measured", "misses go to DRAM", "out/gpu/study/prof/ncu-attempt.log")
    sa = per(lambda i: 100.0 * sm["launches"][i]["sm_active_share_mean"])
    add("sm_active_share", "SM active share (the tail)", "% of kernel span", sa, None,
        "estimate (instrumented build): per SM, time with at least one battle segment running / kernel span, from "
        "segment records + %smid per block; mean over 68 SMs",
        "how much of the launch each SM has work; the rest is the tail where SMs sit idle waiting for the last battles",
        " / ".join(f"{i} {v:.0f}%" if v is not None else f"{i} n/a" for i, v in zip(IDS, sa)),
        "every idle SM-second in the tail is lost throughput", "out/gpu/study/prof/sm-timeline.json")

    tool = "no Nsight: ncu blocked (ERR_NVGPUCTRPERM); segment records + %smid, instrumented probes (POGO_GPU_STUDY=prof), SASS static counts" \
        + (", NVBit opcode histogram" if nvb else "") + (", Nsight Systems CUDA trace for upload/download" if any(
            "Nsight Systems" in r.get("upload_download_method", "") for r in tl["launches"]) else "")
    src = {"5k": "out/gpu/study/prof/dump/batch-0007.bin", "10k": "out/gpu/study/prof/dump/batch-0006.bin",
           "36k": "out/gpu/study/prof/dump/batch-0000.bin+batch-0001.bin+batch-0002.bin (merged)"}
    doc = {"tool": tool,
           "launches": [{"id": i, "n": (lj[i]["reps"][0]["n"] if lj[i] else None), "source": src[i],
                         "merged": i == "36k"} for i in IDS],
           "metrics": M,
           "stalls": [{"reason": "not measured (no counters): stall reasons need ncu WarpStateStats or CUPTI PC sampling; "
                                 "both blocked by ERR_NVGPUCTRPERM", "share": [None] * 3}],
           "timeline": [{k: r[k] for k in ("launch", "host_prep_s", "upload_s", "kernel_s", "download_s", "host_post_s")}
                        for r in tl["launches"] if r["launch"] in IDS],
           "time_split_inside_kernel": {i: lt["launches"][i]["time_split"] for i in IDS if i in lt["launches"]}}
    json.dump(doc, open(os.path.join(out, "metrics.json"), "w"), indent=1)
    for m in M:
        print(m["id"], m["values"])


if __name__ == "__main__":
    main(sys.argv[1])
