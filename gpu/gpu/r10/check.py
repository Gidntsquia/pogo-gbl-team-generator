"""Round 10 R8: re-derive the docs/gpu-viability.md "Round 10" section and exit non-zero on any mismatch.

    python3 gpu/gpu/r10/check.py          (no GPU)

Checks: (1) the section in the docs is exactly what section.py rebuilds from out/gpu/r10/ (runs.json and the logs), so every
number is recomputed; (2) it is under 80 lines; (3) no placeholder is left ("not run", "no Nsight", "missing", "?");
(4) every verdict word in the two decision tables follows R1's both-spreads rule, recomputed here straight from runs.json;
(5) the 100-gen table has the five runs with 100 of 100 checkpoints identical."""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
import section as S  # noqa: E402

fails = []


def check(ok, msg):
    (print("ok  " if ok else "FAIL"), print(msg))
    if not ok:
        fails.append(msg)


def main():
    built = S.build()
    cur = S.current()
    check(cur is not None, f"docs section '{S.HEAD}' present")
    if cur is not None:
        if cur != built:
            import difflib
            sys.stdout.writelines(difflib.unified_diff(cur.splitlines(True), built.splitlines(True), "docs", "rebuilt"))
        check(cur == built, "docs section equals the section rebuilt from out/gpu/r10/ (runs.json + logs)")
    n = len(built.rstrip("\n").splitlines())
    check(n <= 80, f"section is {n} lines (limit 80)")
    for bad in ("not run", "no Nsight", "missing", "| ? ", "cap ?", "no ptxas", "of 3 runs |"):
        check(bad not in built, f"no placeholder '{bad}' in the section")
    runs = {r["name"]: r for r in S.runs() if r["complete"]}
    # (4) verdicts straight from runs.json
    defs = [runs[f"r10-full-default-{i}"]["warm_s_per_gen"] for i in (1, 2) if f"r10-full-default-{i}" in runs]
    check(len(defs) == 2, "two complete 100-gen default runs")
    for v in ("stack", "occ", "tail"):
        r = runs.get(f"r10-full-{v}")
        check(r is not None and r["gens_done"] == 100, f"100-gen {v} run complete")
        if r and len(defs) == 2:
            gain = sum(defs) / 2 - r["warm_s_per_gen"]
            want = "wins" if gain > (max(defs) - min(defs)) else "no gain"
            m = re.search(rf"^\| {v} \|.*\| (wins|no gain) \|$", built, re.M)
            check(m is not None and m.group(1) == want, f"100-gen verdict for {v} is '{want}' (gain {gain:+.3f}, default spread {max(defs) - min(defs):.3f})")
    sess = sorted({r["session"] for r in runs.values() if r["session"] not in (None, "full", "s2", "s3", "s4")})
    check(bool(sess), "a 30-gen A/B session exists")
    for s in sess:
        by = {}
        for r in runs.values():
            if r["session"] == s:
                by.setdefault(r["variant"], []).append(r["warm_s_per_gen"])
        check(len(by.get("default", [])) == 3, f"session {s}: 3 default runs")
        for v, label in (("lean", "lean (step 2)"), ("cap", "cap "), ("leancap", "lean,cap ")):
            vals = by.get(v, [])
            check(len(vals) == 3, f"session {s}: 3 {v} runs")
            if len(vals) == 3 and len(by.get("default", [])) == 3:
                d = by["default"]
                gain = sum(d) / 3 - sum(vals) / 3
                want = "wins" if gain > max(max(d) - min(d), max(vals) - min(vals)) else "no gain"
                m = re.search(rf"^\| {re.escape(label)}[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\| (wins|no gain) \|", built, re.M)
                check(m is not None and m.group(1) == want, f"session {s}: 30-gen verdict for {v} is '{want}' (gain {gain:+.3f})")
    # (5) checkpoints
    cmp = S.tload("full100-cmp.txt")
    for v in ("stack", "occ", "tail", "default-2"):
        check(bool(re.search(rf"^r10-full-{v} vs r10-full-default-1: IDENTICAL \(100 checkpoints", cmp, re.M)), f"full100: {v} 100/100 checkpoints identical")
    # lean gates (R5) and cap gate (R7) as the section states them
    check("| lean2 |" in built and re.search(r"^\| lean2 \|.*\| 100\.00% / 0 flagged \|$", built, re.M) is not None, "lean step 2 verify_3v3 100% / 0 flagged")
    det = S.tload("det-r10.txt")
    check(re.search(r"^POGO_GPU_STUDY=lean 5-gen vs default 5-gen: IDENTICAL", det, re.M) is not None, "det-r10.txt: lean 5-gen IDENTICAL to default")
    capv = S.tload("cap-value.txt").strip()
    check(capv.isdigit(), f"cap-value.txt names the A/B cap value ({capv!r})")
    if capv.isdigit():
        check(re.search(rf"^\| {capv} \|.*\| pass \|", built, re.M) is not None, f"cap {capv} passes the agreement gate in the table")
    fin = S.jload("finalists.json")
    check(fin is not None, "finalists.json present")
    if fin:
        sets = fin["sets"]
        ref = next((sets[k]["meanWinPct"] for k in sets if "default" in k), None)
        for k, v in sets.items():
            check(ref is not None and abs(v["meanWinPct"] - ref) <= 1, f"finalists: {os.path.basename(k)} within 1 pt of the default ({v['meanWinPct'] - ref:+.2f})")
    nc = S.jload("ncu/summary.json", {})
    for k in ("5k-default", "5k-lean2", "10k-default", "10k-lean2"):
        v = nc.get(k, {})
        check(v.get("achieved_occupancy_pct") is not None and v.get("local_bytes_gb") is not None and any(s["reason"] == "long_scoreboard" for s in v.get("top5_stalls", [])),
              f"ncu/summary.json {k}: occupancy, long_scoreboard share and local bytes present")
    px = S.jload("ptxas.json", {})
    check(px.get("lean2", {}).get("entry_spill_st") == 0 and px.get("lean2", {}).get("entry_spill_ld") == 0, "ptxas: lean step 2 has 0 spill bytes")
    print(f"\n{len(fails)} failure(s)")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
