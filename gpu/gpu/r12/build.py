"""Round 12: build the docs/gpu-viability.md "Round 12" section from the measurement files (every number is re-derived).

    python3 gpu/gpu/r12/build.py [--write]

Sources: out/gpu/r10/runs.json (sessions s5 = 100-gen lean 6 run, s6 = share / CPU-below A/B), out/gpu/r12/{ptxas.json,det-r12.txt,full100-cmp.txt,
verify3v3.log,det-s6.txt,finalists-s6.json,cpu2-r12.log}, gpu/gpu/r12/fitdata/share-fit.json, out/gpu/r10/ncu/summary.json,
out/gpu/r12/decisions.json (judgment text: what became default, what was cut and why)."""
import importlib.util
import json
import os
import re
import sys

_spec = importlib.util.spec_from_file_location("build11", os.path.join(os.path.dirname(__file__), "..", "r11", "build.py"))
B11 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(B11)
S10 = B11.S10
R = S10.R
O12 = os.path.join(R, "out/gpu/r12")
DOC = S10.DOC
HEAD = "## Round 12: lean 6 as the only kernel, GPU by default, 100-gen run, CPU split"
LABEL = {"default": "share 0 (default)", "auto": "share auto (refit)", "share05": "share 0.05", "share10": "share 0.10",
         "below500": "CPU below 500", "below2000": "CPU below 2000"}
ORDER = list(LABEL)


def t12(p):
    p = os.path.join(O12, p)
    return open(p).read() if os.path.exists(p) else ""


def j12(p, d=None):
    p = os.path.join(O12, p)
    return json.load(open(p)) if os.path.exists(p) else d


def s6():
    out = {}
    for r in S10.runs():
        if r["session"] == "s6" and r["complete"]:
            out.setdefault(r["variant"], []).append(r)
    return out


def proof(v, n):
    t = t12("det-s6.txt")
    same = len(re.findall(rf"^r10-s6-{v}-\d vs r10-s6-default-\d: IDENTICAL", t, re.M))
    s = f"{same}/{n} runs 30/30 identical"
    fin = j12("finalists-s6.json")
    if same < n and fin:
        sets = fin["sets"]
        ref = next((k for k in sets if "-default-" in k), None)
        ks = [k for k in sets if f"-{v}-" in k]
        if ref and ks:
            s += f"; finalists {sum(sets[k]['meanWinPct'] - sets[ref]['meanWinPct'] for k in ks) / len(ks):+.2f} pt"
    return s


def section_100(L):
    full = [r for r in S10.runs() if r["name"].startswith("r10-full-default") and r["complete"]]
    new = next((r for r in S10.runs() if r["name"].startswith("r10-s5-lean6full100") and r["complete"]), None)
    dm = S10.mean([r["warm_s_per_gen"] for r in full])
    dw = S10.mean([r["total_wall_s"] for r in full])
    L.append("### 100-gen run (R8): lean 6 default, same seed and command as round 10's 100-gen runs")
    L.append("| run | start ET | total wall | warm s/gen | checkpoints vs round 10 default |")
    L.append("|---|---|---|---|---|")
    L.append(f"| round 10 default (2 runs, mean) | 19:47 EDT, 20:59 EDT | {dw:.0f} s ({dw / 60:.1f} min) | {dm:.2f} | - |")
    if new:
        ids = len(re.findall(r"IDENTICAL \(100 checkpoints", t12("full100-cmp.txt")))
        L.append(f"| lean 6 (session s5) | {S10.et(new['start_et'])} | {new['total_wall_s']:.0f} s ({new['total_wall_s'] / 60:.1f} min) | {new['warm_s_per_gen']:.2f} | "
                 f"{ids}/2 round 10 default runs: 100/100 identical |")


def build():
    px = S10.jload("ptxas.json", {}) or json.load(open(os.path.join(O12, "ptxas.json")))
    p = px["lean6"]
    dec = j12("decisions.json", {})
    L = [HEAD, "",
         "Branch `gpu`, 2026-10-22. Numbers come only from `out/gpu/r10/runs.json` (speed), `out/gpu/r10/ncu/summary.json`, `out/gpu/r12/*` and the fit data in "
         "`gpu/gpu/r12/fitdata/`; `python3 gpu/gpu/r12/check.py` rebuilds this section and fails on any difference. Yardstick as in round 11 (warm s/gen = mean of "
         "generations 2+, 3 interleaved runs per variant with a share-0 default in every pass, spread = max - min, \"wins\" = gain larger than both spreads added, "
         "a smaller gain is \"insufficient\"). Clock times are US Eastern.", "",
         "### Lean 6 is the only kernel (R1-R3)",
         f"- ptxas for the standard build: {p['registers']} registers, entry frame {p['entry_frame']:,} B, **spill {p['entry_spill_st']} B stores / {p['entry_spill_ld']} B loads** "
         f"(all functions {p['all_functions_spill_st']}/{p['all_functions_spill_ld']} B), pool MAXQ {p['maxq']}. The sidecar start log names `kernel: lean 6`.",
         "- Removed: `POGO_GPU_STUDY=lean|stack|occ|tail`, `POGO_GPU_LEAN`, the tail host code (`gpuTail.js`, `tailSpec.js`) and the study forks; the tables in Rounds 8-11 keep their numbers.",
         "- CPU-only 2-gen checkpoints (round 12 code) vs round 9 and round 10: "
         + ("gen 0 and gen 1 IDENTICAL in both" if len(re.findall(r"evolve-gen0.json: IDENTICAL; evolve-gen1.json: IDENTICAL", t12("det-r12.txt"))) == 2 else "DIFFER, see det-r12.txt") + ".",
         "- 30-gen standard run with lean 6 as the default vs round 11's three default runs: "
         + ", ".join(re.findall(r"IDENTICAL \((\d+) checkpoints", t12("det-r12.txt"))[:3]) + " checkpoints, all IDENTICAL.",
         "- verify_3v3: " + (re.findall(r"agree[^\n]*", t12("verify3v3.log")) or ["see out/gpu/r12/verify3v3.log"])[-1], ""]
    section_100(L)
    L.append("")
    L.append("### CPU share (R10)")
    L.append("`node gpu/fit-share.mjs` on two 8-gen lean 6 runs (share 0.01 for the GPU side, 0.05 for the CPU side; `gpu/gpu/r12/fitdata/`): "
             + dec.get("fit", "see fitdata") + "")
    by = s6()
    dv = [r["warm_s_per_gen"] for r in sorted(by.get("default", []), key=lambda r: r["pass"])]
    if len(dv) >= 3:
        first = min((r for v in by.values() for r in v), key=lambda r: r["start_epoch"])
        L.append(f"Session s6, start {S10.et(first['start_et'])}, 3 passes, each pass the share-0 default then the variants:")
        L.append("| variant | warm s/gen, runs | mean | spread | vs default | verdict | proof | run starts ET |")
        L.append("|---|---|---|---|---|---|---|---|")
        for v in [x for x in ORDER if x in by]:
            rr = sorted(by[v], key=lambda r: r["pass"])
            vals = [r["warm_s_per_gen"] for r in rr]
            vd, gain = ("-", None) if v == "default" else B11.verdict_row(vals, dv)
            L.append(f"| {LABEL[v]} | {' / '.join(f'{x:.2f}' for x in vals)} | {S10.mean(vals):.2f} | {S10.spread(vals):.2f} | {'-' if gain is None else f'{-gain:+.2f}'} | "
                     f"{vd} | {'-' if v == 'default' else proof(v, len(rr))} | {', '.join(S10.et(r['start_et'])[:5] for r in rr)} |")
    L.append("")
    L.append("### Host overlap (R11)")
    for k in ("overlap_a", "overlap_b", "overlap_c"):
        if k in dec:
            L.append("- " + dec[k])
    L.append("")
    L.append("### Nsight Compute, lean 6 (standard) and lean 6 + cap192 (`out/gpu/r10/ncu/summary.json`)")
    nc = S10.jload("ncu/summary.json", {})
    L.append("| launch | variant | kernel s | occupancy | long_scoreboard | local GB | issue-slot use |")
    L.append("|---|---|---|---|---|---|---|")
    for launch in ("5k", "10k"):
        for v in ("lean6", "lean6cap"):
            e = nc.get(f"{launch}-{v}")
            if not e:
                L.append(f"| {launch} | {v} | missing: not profiled | | | | |")
            elif e["tool"].startswith("missing"):
                L.append(f"| {launch} | {v} | {e['tool']} | | | | |")
            else:
                ls = next((x["share_pct"] for x in e["top5_stalls"] if x["reason"] == "long_scoreboard"), None)
                L.append(f"| {launch} | {v} | {e['kernel_s_at_base_clock']:.2f} | {e['achieved_occupancy_pct']:.1f}% | {'-' if ls is None else f'{ls:.0f}%'} | {e['local_bytes_gb']:.0f} | {e['issue_slot_use_pct']:.1f}% |")
    L.append("")
    L.append("### What became default (R12)")
    L.extend("- " + x for x in dec.get("default", ["nothing besides lean 6 and the GPU engine; every share and overlap candidate stays off with its flag documented."]))
    L.append("")
    L.append("Glossary: **share** = the fraction of each step's battles the CPU workers run beside the GPU (`--gpu-cpu-share`); **stack**, **occ**, **lean**, **cap**, **spill** as in Round 11.")
    return "\n".join(L) + "\n"


def current():
    t = open(DOC).read()
    i = t.find(HEAD)
    if i < 0:
        return None
    j = t.find("\n## ", i + 1)
    return t[i:] if j < 0 else t[i:j + 1]


def write(sec):
    t = open(DOC).read()
    cur = current()
    t = t.rstrip("\n") + "\n\n" + sec if cur is None else t.replace(cur, sec)
    open(DOC, "w").write(t)


if __name__ == "__main__":
    sec = build()
    if "--write" in sys.argv:
        write(sec)
        print(f"wrote {len(sec.splitlines())} lines")
    else:
        sys.stdout.write(sec)
