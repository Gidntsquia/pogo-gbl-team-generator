"""pool fork: writes out/gpu/study/pool/result.json from the saved bench / dist / res / chain files (run from repo root)."""
import json, os
O = "out/gpu/study/pool"
L = lambda f: json.load(open(os.path.join(O, f)))
dist = L("dist.json")["total"]
b = {q: L(f"bench-q{q}.json") for q in (256, 512, 768)}
res = L("res.json")
sg = {r["run"]: r for r in map(json.loads, open(os.path.join(O, "sgen.jsonl")))}
base = (sg["base-a"]["warm_s_per_gen"] + sg["base-b"]["warm_s_per_gen"]) / 2
pool = (sg["pool-a"]["warm_s_per_gen"] + sg["pool-b"]["warm_s_per_gen"]) / 2
main_only = {q: sum(r["var_wall"][-1] - r["pool"]["rerun_s"] for r in b[q]["launches"]) for q in b}
mem = {m["stack_limit"]: round(m["free_mib"]) for m in res["stack_memory"]}
loc = {k["maxq"]: k["local_bytes"] for k in res["kernels"]}
stk = {}
for f in ("bench-q2048-s40960.json", "bench-q768-s24576.json"):
    if os.path.exists(os.path.join(O, f)):
        t = L(f)["total"]; stk[f] = {"ratio_wall": round(t["ratio_wall"], 3), "all_equal": t["all_equal"], "launches": "1,3,4"}
t = {q: b[q]["total"] for q in b}
cards = [{
    "id": "pool-small",
    "name": "Smaller search pool, rare re-run",
    "mechanism": "Each thread's lookahead pool shrinks from 2,048 to 512 states (local memory, the per-thread scratch space in GPU "
                 "memory, 39.1 KB -> 17.6 KB); the 0.3% of battles that need more are re-run with the full pool after the launch.",
    "evidence": (f"Rows identical ({t[512]['rerun_rows']} re-runs, all_equal) but bench wall x{t[512]['ratio_wall']:.2f} "
                 f"({t[512]['var_bps']:.0f} vs {t[512]['prod_bps']:.0f} battles/s; bench-q512.json); main launch alone "
                 f"{main_only[512]:.1f} s vs production {t[512]['prod_wall_s']:.1f} s, so the small pool itself saves nothing, "
                 f"and the re-run adds {t[512]['rerun_s']:.1f} s because overflow battles are the longest ones and run after the "
                 f"rest; chain warm s/gen {pool:.2f} vs baseline {base:.2f} (sgen.jsonl)."),
    "touches": "gpu/gpu/kernel3v3.py slice_launch/slice_collect (MAXQ per launch, overflow re-run)",
    "predicted_s_per_gen": [round(pool - base - 0.3, 1), round(pool - base + 0.3, 1)],
    "risk": "None for results: rows equal production bit for bit (bench all_equal at q 256/512/768, chain checkpoints identical to base-a, det.txt).",
    "tested": True, "runs": ["pool-a", "pool-b"], "verify": f"{O}/verify3v3.log (chain: {O}/verify3v3-pool.log)",
    "verify_agreement": "100.00%, 0 flagged",
    "bench": {"source": f"{O}/bench-q*.json", **{f"q{q}": {"ratio_wall": round(t[q]["ratio_wall"], 3), "rerun_rows": t[q]["rerun_rows"],
              "rerun_s": round(t[q]["rerun_s"], 2), "main_only_s": round(main_only[q], 2), "prod_wall_s": round(t[q]["prod_wall_s"], 2),
              "var_bps": round(t[q]["var_bps"]), "prod_bps": round(t[q]["prod_bps"])} for q in t}},
    "do_next": "Drop: the pool size is not what limits speed (registers are), and re-running the longest battles serially costs more than it saves.",
}, {
    "id": "stack-limit",
    "name": "Lower the stack limit to 40 KB",
    "mechanism": "cudaDeviceSetLimit(stack) = 65,536 B reserves that much per resident thread although the slice kernel needs "
                 "39,104 B; 40,960 B is enough for the 2,048 pool and returns GPU memory, with the same rows.",
    "evidence": (f"Free device memory {mem[65536]} MiB at 65,536 vs {mem[40960]} MiB at 40,960 and {mem[24576]} MiB at 24,576 "
                 f"(res.json; ~816 MiB per 8 KB); kernel local bytes {loc[2048]} at pool 2048 (res.json). Occupancy is 8 warps/SM "
                 f"at every pool size (register-limited), so no speed gain is expected"
                 + (f"; bench {stk}" if stk else "; speed bench on launches 1,3,4 did not get the GPU lock in time") + "."),
    "touches": "gpu/gpu/kernel3v3.py default stack= arguments / _set_stack",
    "predicted_s_per_gen": [-0.1, 0.1],
    "risk": "If a future kernel's frame grows past 40,960 B the launch fails loudly (no silent change); rows unchanged.",
    "tested": bool(stk), "runs": [], "verify": "", "verify_agreement": "", "bench": stk,
    "do_next": "Optional: set stack to 40,960 only if GPU memory becomes a constraint (bigger batches, two sidecars); not a speed change.",
}]
findings = [
    f"poolMax over {dist['n']:,} real battles: median {dist['p50']}, p99 {dist['p99']}, p99.9 {dist['p999']}, max {dist['max']}; "
    f"{dist['over']['512']} ({dist['over_pct']['512']:.2f}%) reach 512, {dist['over']['768']} reach 768 (dist.json).",
    f"Shrinking the pool does not speed the kernel: launches with no re-runs at pool 768 take "
    + ", ".join(f"{min(r['var_wall']):.2f} vs {min(r['prod_wall']):.2f} s" for r in b[768]['launches'] if r['pool']['rerun'] == 0)
    + f"; occupancy stays 8 warps/SM (res.json, bench-q768.json).",
    f"Chain: pool-a/b warm {sg['pool-a']['warm_s_per_gen']:.2f}/{sg['pool-b']['warm_s_per_gen']:.2f} s/gen vs base-a/b "
    f"{sg['base-a']['warm_s_per_gen']:.2f}/{sg['base-b']['warm_s_per_gen']:.2f} (+{100 * (pool / base - 1):.0f}%), checkpoints identical (sgen.jsonl, det.txt).",
]
files = sorted(os.path.join(O, f) for f in os.listdir(O) if f not in ("dump", "dumprun")) + [f"{O}/dump/", f"{O}/dumprun/"] + \
    [f"gpu/gpu/study/pool/{f}" for f in sorted(os.listdir("gpu/gpu/study/pool")) if f.endswith((".py", ".sh"))]
json.dump({"fork": "pool", "cards": cards, "findings": findings, "files": files}, open(os.path.join(O, "result.json"), "w"), indent=1)
print(json.dumps(findings, indent=1))
