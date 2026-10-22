"""Round 8 prof fork: turn saved replays / run profiles into the R1-R3 JSON files (no GPU needed).

    python3 -m gpu.study.prof.analyze gensplit OUT_DIR RUN_DIR [RUN_DIR ...]   -> OUT_DIR/gen-split.json
    python3 -m gpu.study.prof.analyze sm OUT_DIR NAME [NAME ...]              -> OUT_DIR/sm-timeline.json (needs <name>-sm.npz)
    python3 -m gpu.study.prof.analyze timeline OUT_DIR REPLAY_DIR NSYS_DIR DUMP_RUN -> OUT_DIR/timeline.json
    python3 -m gpu.study.prof.analyze lanes OUT_DIR REPLAY_DIR                -> OUT_DIR/lanes-time.json
"""
import json
import os
import sys

import numpy as np

BLOCK = 32


def gensplit(out, runs):
    doc = {"source": runs, "buckets": {
        "gpu_battles_s": "kernel + tail (sidecar kernel span: first battle start .. last end, all steps of the gen)",
        "host_prep_s": "plan + pack (node: which battles, memo lookup, BATCH3 body)",
        "transport_s": "node <-> sidecar pipe, sidecar upload/download and order/width pick outside the kernel span",
        "host_post_s": "map + accumulate (node: rows -> results -> team scores)",
        "cpu_ga_s": "ga + checkpoint + report (both GAs' generation step, CPU)",
        "other_s": "unattributed + waitCpu + flagged",
        "gpu_idle_s": "wall - gpu_battles_s (the GPU runs no battle)"}, "runs": {}}
    for r in runs:
        d = json.load(open(os.path.join(r, "gpu-profile.json")))
        gens = []
        for g in d["generations"]:
            b = g["buckets"]
            row = {"gen": g["gen"], "wall_s": g["wall"], "battles": g["battles"], "steps": g["steps"],
                   "gpu_battles_s": b["kernel"] + b["tail"], "kernel_body_s": b["kernel"], "kernel_tail_s": b["tail"],
                   "host_prep_s": b["plan"] + b["pack"], "transport_s": b["transport"], "host_post_s": b["map"] + b["accumulate"],
                   "cpu_ga_s": b["ga"] + b["checkpoint"] + b["report"],
                   "other_s": g["unattributed"] + b["waitCpu"] + b["flagged"]}
            row["gpu_idle_s"] = row["wall_s"] - row["gpu_battles_s"]
            row["launches"] = [{"n": l["n"], "span_s": l["spanMs"] / 1e3, "body_s": l["bodyMs"] / 1e3, "tail_s": l["tailMs"] / 1e3,
                                "maxBattle_s": l["maxBattleMs"] / 1e3, "p50Battle_s": l["p50BattleMs"] / 1e3, "longest": l["longest"]}
                               for s in d["steps"] if s["gen"] == g["gen"] for l in s["launches"]]
            gens.append(row)
        warm = [x for x in gens if x["gen"] >= 1]
        keys = ("wall_s", "gpu_battles_s", "kernel_body_s", "kernel_tail_s", "host_prep_s", "transport_s", "host_post_s", "cpu_ga_s",
                "other_s", "gpu_idle_s")
        mean = {k: float(np.mean([x[k] for x in warm])) for k in keys}
        mean["share_gpu_battles"] = mean["gpu_battles_s"] / mean["wall_s"]
        mean["share_tail_of_gpu"] = mean["kernel_tail_s"] / mean["gpu_battles_s"]
        doc["runs"][os.path.basename(r.rstrip("/"))] = {"gens": gens, "warm_mean_gens_1_9": mean}
    allw = [v["warm_mean_gens_1_9"] for v in doc["runs"].values()]
    doc["warm_mean_all_runs"] = {k: float(np.mean([w[k] for w in allw])) for k in allw[0]}
    doc["note"] = "warm = gens 1-9 (gen 0 runs 36,000 battles with no memo hits). Seconds per bucket per gen, from gpu-profile.json."
    json.dump(doc, open(os.path.join(out, "gen-split.json"), "w"), indent=1)
    print(json.dumps(doc["warm_mean_all_runs"], indent=1))


def sm(out, names, bins=120):
    """Per-SM busy-over-time from the instrumented (sm probe) replays: segment (who, battle, t0, t1) -> thread -> block -> SM."""
    doc = {"note": "per SM: threads running a battle segment, averaged over each time bin; capacity = resident threads per SM. "
                   "busy = at least one thread of the SM runs a battle. From the slice kernel's segment records + %smid per block "
                   "(prof variant, POGO_GPU_PROF=sm).", "launches": {}}
    for name in names:
        z = np.load(name if name.endswith(".npz") else os.path.join(out, f"{name}-sm.npz"))
        segs, smid = z["segments"], z["smid"]
        who = segs[:, 0] & 0xFFFFFF
        blk = who // BLOCK
        s_of = smid[blk].astype(np.int64)
        t0 = segs[:, 2] - segs[:, 2].min()
        t1 = segs[:, 3] - segs[:, 2].min()
        span = float(t1.max())
        nsm = int(smid[smid != 0xFFFFFFFF].max()) + 1
        res_threads = len(smid) * BLOCK // nsm
        edges = np.linspace(0, span, bins + 1)
        busy_thr = np.zeros((nsm, bins))
        # time-weighted thread occupancy per bin: add each segment's overlap with each bin
        for k in range(bins):
            lo, hi = edges[k], edges[k + 1]
            ov = np.clip(np.minimum(t1, hi) - np.maximum(t0, lo), 0, None)
            np.add.at(busy_thr[:, k], s_of, ov / (hi - lo))
        # per SM: union of its segments = time the SM had any battle running; last end = when the SM went idle for good
        sm_busy, sm_last = np.zeros(nsm), np.zeros(nsm)
        for s in range(nsm):
            m = s_of == s
            a, b = np.sort(t0[m]), None
            o = np.argsort(t0[m]); a, b = t0[m][o], t1[m][o]
            tot, cur_s, cur_e = 0.0, None, None
            for x, y in zip(a, b):
                if cur_e is None or x > cur_e:
                    if cur_e is not None:
                        tot += cur_e - cur_s
                    cur_s, cur_e = x, y
                else:
                    cur_e = max(cur_e, y)
            if cur_e is not None:
                tot += cur_e - cur_s
            sm_busy[s], sm_last[s] = tot, b.max() if len(b) else 0
        thr_time = float(((t1 - t0)).sum())
        # warp-level: a warp counts as active while any of its threads runs a segment (achieved occupancy's definition)
        wid = who // 32
        warp_time = 0.0
        for w in np.unique(wid):
            m = wid == w
            o = np.argsort(t0[m]); a, b = t0[m][o], t1[m][o]
            cs, ce = a[0], b[0]
            for x, y in zip(a[1:], b[1:]):
                if x > ce:
                    warp_time += ce - cs; cs, ce = x, y
                else:
                    ce = max(ce, y)
            warp_time += ce - cs
        res_warps = len(smid) * BLOCK // 32
        key = os.path.basename(name).replace("-sm.npz", "")
        doc["launches"][key] = {"source": name,
            "n": int(len(z["start_ns"])), "span_s": span / 1e9, "sms": nsm, "resident_threads_per_sm": res_threads,
            "bin_s": span / bins / 1e9, "threads_running": np.round(busy_thr, 2).tolist(),
            "sm_busy_share": (sm_busy / span).round(4).tolist(), "sm_last_end_s": (sm_last / 1e9).round(4).tolist(),
            "sm_active_share_mean": float((sm_busy / span).mean()),
            "sm_active_share_min": float((sm_busy / span).min()),
            "thread_slot_share": thr_time / (span * nsm * res_threads),
            "warp_slot_share": float(warp_time / (span * res_warps)),
            "resident_warps": int(res_warps),
            "all_threads_running_share_of_time": float((busy_thr.sum(0) >= 0.9 * nsm * res_threads).mean()),
            "time_half_sms_idle_s": float(edges[np.argmax((busy_thr > 0).sum(0) < nsm / 2)] / 1e9) if ((busy_thr > 0).sum(0) < nsm / 2).any() else span / 1e9,
        }
        print(key, {k: v for k, v in doc["launches"][key].items() if not isinstance(v, list)})
    json.dump(doc, open(os.path.join(out, "sm-timeline.json"), "w"))


LAUNCHES = (("5k", "7"), ("10k", "6"), ("36k", "0+1+2"), ("18k", "0"))
SITES = ("outer 3v3 turn step", "inner 1v1 sim turn", "lookahead pool DP iteration", "slice segment start")


def lanes(out, rdir):
    """Warp execution efficiency estimate from the lanes probe: mean active threads (of 32) per visit of each loop site."""
    doc = {"note": "per site: sum over warps of active threads (popc __activemask) at each visit / visits. A proxy for "
                   "smsp__thread_inst_executed_per_inst_executed.ratio (that counter averages over every instruction; this "
                   "averages over loop visits at 4 sites). Width 1: each thread runs its own battle, so it says how many "
                   "battles of a warp are inside that loop together. Source: <name>-lanes+time.npz (POGO_GPU_STUDY=prof).",
           "sites": SITES, "launches": {}}
    for name, _ in LAUNCHES:
        f = os.path.join(rdir, f"{name}-lanes+time.npz")
        if not os.path.exists(f):
            continue
        z = np.load(f)
        w = z["lanes"].astype(np.float64)  # [warps, site, (sum, visits)]
        tot = w.sum(0)
        per = {SITES[k]: {"active_threads_per_visit": float(tot[k, 0] / tot[k, 1]) if tot[k, 1] else None,
                          "visits": int(tot[k, 1])} for k in range(len(SITES))}
        hot = tot[1:3].sum(0)
        allv = tot[:3].sum(0)
        t = z["ptime"].astype(np.float64)  # [n, 4] cycles: inner sims, DP inside inner sims, outer decide, whole segment
        T = t[:, 3].sum()
        split = {"cycles_total_all_battles": float(T),
                 "inner_1v1_sims_share": float(t[:, 0].sum() / T),
                 "  of which lookahead DP (decideAction in inner sims)": float(t[:, 1].sum() / T),
                 "  of which inner sim turn logic (rest)": float((t[:, 0] - t[:, 1]).sum() / T),
                 "outer_3v3_decideAction_share": float(t[:, 2].sum() / T),
                 "outer_3v3_turn_logic_and_init_share": float((t[:, 3] - t[:, 0] - t[:, 2]).sum() / T),
                 "lookahead_DP_share_total": float((t[:, 1] + t[:, 2]).sum() / T)}
        doc["launches"][name] = {"source": f, "sites": per,
                                 "hot_loops_active_threads_per_visit": float(hot[0] / hot[1]),
                                 "sites_0_2_active_threads_per_visit": float(allv[0] / allv[1]),
                                 "time_split": split,
                                 "time_split_note": "clock64 cycles per battle, summed over battles: elapsed SM cycles while "
                                                    "the battle's thread is inside each region (includes waiting on other "
                                                    "warps / diverged lanes); outer decideAction also counts as DP."}
        print(name, json.dumps({k: v for k, v in doc["launches"][name].items() if k != "sites"}))
    json.dump(doc, open(os.path.join(out, "lanes-time.json"), "w"), indent=1)


def _nsys(ndir, name):
    """Sum memcpy HtoD / DtoH and kernel time per rep from nsys stats cuda_gpu_trace CSV (None if absent)."""
    import csv
    import glob
    fs = glob.glob(os.path.join(ndir, f"{name}_cuda_gpu_trace*.csv"))
    if not fs:
        return None
    rows = list(csv.DictReader(open(fs[0])))
    res = {"file": fs[0], "htod_s": 0.0, "dtoh_s": 0.0, "memset_s": 0.0, "slice_kernels": [], "other_kernel_s": 0.0}
    for r in rows:
        nm = r.get("Name", "")
        d = float(r.get("Duration (ns)", 0) or 0) / 1e9
        if "HtoD" in nm:
            res["htod_s"] += d
        elif "DtoH" in nm:
            res["dtoh_s"] += d
        elif "memset" in nm.lower():
            res["memset_s"] += d
        elif "battle3v3_slice" in nm:
            res["slice_kernels"].append(d)
        else:
            res["other_kernel_s"] += d
    return res


def timeline(out, rdir, ndir, dumprun):
    """R3a per launch: host prep / upload / kernel / download / host post (seconds)."""
    prof = json.load(open(os.path.join(dumprun, "gpu-profile.json")))
    steps = prof["steps"]
    doc = {"note": "host_prep = node plan+pack+static (dump run gpu-profile.json, that launch's step) + sidecar order/width "
                   "pick (replay host_prep_s). upload/download = Nsight Systems CUDA memcpy time per launch when the trace "
                   "exists (nsys/<name>_cuda_gpu_trace.csv), else replay host timings (launch_call_s = predict + uploads + "
                   "enqueue; collect_s = download + decode). kernel = slice kernel span from its segment stamps, median of "
                   "replay reps (prod build). host_post = node map+accumulate of the step. 36k = three gen-0 launches "
                   "merged into one (not a real launch); its node buckets are the sum of steps 0-2.", "launches": []}
    for name, spec in LAUNCHES:
        lf = os.path.join(rdir, f"{name}-prod.launch.json")
        if not os.path.exists(lf):
            continue
        L = json.load(open(lf))
        reps = L["reps"]
        med = lambda k: float(np.median([r[k] for r in reps]))
        idx = [int(x) for x in spec.split("+")]
        node_prep = sum(steps[i]["buckets"]["plan"] + steps[i]["buckets"]["pack"] + steps[i]["launches"][0]["staticMs"] / 1e3 for i in idx)
        node_post = sum(steps[i]["buckets"]["map"] + steps[i]["buckets"]["accumulate"] for i in idx)
        run_span = sum(steps[i]["launches"][0]["spanMs"] / 1e3 for i in idx)
        ns = _nsys(ndir, name)
        row = {"launch": name, "n": reps[0]["n"], "host_prep_s": node_prep + med("host_prep_s")}
        if ns:
            nrep = max(1, len(ns["slice_kernels"]) - 1)  # minus the warm-up launch
            row.update({"upload_s": ns["htod_s"] / (nrep + 1), "download_s": ns["dtoh_s"] / (nrep + 1),
                        "upload_download_method": "Nsight Systems CUDA trace (memcpy durations, per launch incl. warm-up share)",
                        "nsys_slice_kernel_s": ns["slice_kernels"]})
        else:
            row.update({"upload_s": med("launch_call_s"), "download_s": med("collect_s"),
                        "upload_download_method": "host timer (no CUDA trace): upload = slice_launch call, download = slice_collect"})
        row.update({"kernel_s": med("kernel_span_s"), "host_post_s": node_post,
                    "event_launch_to_done_s": med("event_launch_to_done_s"), "kernel_span_in_dump_run_s": run_span,
                    "parts": {"node_plan_pack_static_s": node_prep, "sidecar_order_pick_s": med("host_prep_s"),
                              "slice_launch_call_s": med("launch_call_s"), "wait_s": med("wait_s"), "collect_s": med("collect_s")},
                    "source": [lf, os.path.join(dumprun, "gpu-profile.json")] + ([ns["file"]] if ns else [])})
        doc["launches"].append(row)
        print(json.dumps({k: v for k, v in row.items() if k not in ("parts", "source")}))
    json.dump(doc, open(os.path.join(out, "timeline.json"), "w"), indent=1)



def nvbit(out, log):
    """Parse the NVBit opcode_hist log (warp-level dynamic counts per opcode) -> OUT/nvbit/nvbit-summary.json."""
    import re
    txt = open(log).read()
    blocks = re.split(r"\nkernel (\d+) - ", txt)
    kern = []
    for k in range(1, len(blocks), 2):
        body = blocks[k + 1]
        head = body.splitlines()[0]
        ops = {m.group(1): int(m.group(2)) for m in re.finditer(r"^\s+(\S+) = (\d+)$", body, re.M)}
        kern.append({"kernel": int(blocks[k]), "head": head, "ops": ops})
    sl = [x for x in kern if "battle3v3_slice" in x["head"] and x["ops"]]
    if not sl:
        print("no instrumented slice kernel in", log)
        return
    ops = sl[0]["ops"]
    tot = sum(ops.values())
    def width(op):
        m = re.search(r"\.(64|128|U8|S8|U16|S16)\b", op)
        return {"64": 8, "128": 16, "U8": 1, "S8": 1, "U16": 2, "S16": 2}[m.group(1)] if m else 4
    loc = {o: c for o, c in ops.items() if o.split(".")[0] in ("LDL", "STL")}
    lw = sum(loc.values())
    bytes_thread_max = sum(c * width(o) for o, c in loc.items()) * 32
    doc = {"source": log, "kernel": sl[0]["head"], "battles": 64,
           "note": "NVBit 1.8.1 opcode_hist, COUNT_WARP_LEVEL=1: dynamic warp-level instruction counts of the 64-battle "
                   "warm-up launch (first 64 battles of batch-0007, the 5k launch), not the whole launch. local_bytes_est = "
                   "LDL/STL warp instructions x access width x 32 threads (upper bound: assumes every thread active).",
           "warp_instructions": tot, "local_warp_instructions": lw,
           "launches": {"5k": {"local_instr_share": lw / tot, "local_bytes_est": bytes_thread_max,
                               "local_bytes_est_per_battle": bytes_thread_max / 64}},
           "top_ops": sorted(ops.items(), key=lambda x: -x[1])[:25], "local_ops": loc}
    os.makedirs(os.path.join(out, "nvbit"), exist_ok=True)
    json.dump(doc, open(os.path.join(out, "nvbit", "nvbit-summary.json"), "w"), indent=1)
    print(json.dumps({k: doc[k] for k in ("warp_instructions", "local_warp_instructions", "launches")}))

if __name__ == "__main__":
    cmd, out = sys.argv[1], sys.argv[2]
    if cmd == "gensplit":
        gensplit(out, sys.argv[3:])
    elif cmd == "sm":
        sm(out, sys.argv[3:])
    elif cmd == "nvbit":
        nvbit(out, sys.argv[3])
    elif cmd == "lanes":
        lanes(out, sys.argv[3])
    elif cmd == "timeline":
        timeline(out, sys.argv[3], sys.argv[4], sys.argv[5])
