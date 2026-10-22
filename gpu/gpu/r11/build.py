"""Round 11: build the docs/gpu-viability.md "Round 11" section from the measurement files (every number is re-derived).

    python3 gpu/gpu/r11/build.py            prints the section
    python3 gpu/gpu/r11/build.py --write    replaces (or appends) the "## Round 11" section of docs/gpu-viability.md

Sources: out/gpu/r10/runs.json (speed; made by gpu/gpu/r10/runs.py), out/gpu/r10/ncu/summary.json (Nsight), out/gpu/r10/ptxas.json,
out/gpu/r10/verify/verify3v3-<variant>.log, out/gpu/r11/det-r11.txt (30-gen checkpoint identity), out/gpu/r11/finalists-s3.json,
out/gpu/r11/top3.json (the judgment text: which variants are the three ideas, the change that makes each default, interactions)."""
import json
import os
import re
import sys

import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("section10", os.path.join(os.path.dirname(__file__), "..", "r10", "section.py"))
S10 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(S10)

R = S10.R
O11 = os.path.join(R, "out/gpu/r11")
DOC = S10.DOC
HEAD = "## Round 11: 30-gen A/Bs of every lean step, Nsight on every variant, kernel iteration, top 3 to implement"
CAPV = "192"
LABEL = {"default": "default", "lean1": "lean 1", "lean2": "lean 2", "lean3": "lean 3", "lean4": "lean 4", "lean2q": "lean 2q",
         "lean5": "lean 5", "lean6": "lean 6", "lean3cap": "lean 3 + cap192", "lean4cap": "lean 4 + cap192", "lean2qcap": "lean 2q + cap192",
         "lean5cap": "lean 5 + cap192", "lean6cap": "lean 6 + cap192"}
PTX = {"lean3cap": "lean3", "lean4cap": "lean4", "lean2qcap": "lean2q", "lean5cap": "lean5", "lean6cap": "lean6"}
ORDER = list(LABEL)


def t11(p):
    p = os.path.join(O11, p)
    return open(p).read() if os.path.exists(p) else ""


def j11(p, default=None):
    p = os.path.join(O11, p)
    return json.load(open(p)) if os.path.exists(p) else default


def sessions():
    rs = [r for r in S10.runs() if r["session"] in ("s2", "s3", "s4") and r["complete"]]  # round 12 sessions (s5, s6, ...) live in gpu/gpu/r12
    out = {}
    for r in rs:
        out.setdefault(r["session"], {}).setdefault(r["variant"], []).append(r)
    return out


def verdict_row(vals, dv):
    """R1/R2: 3+ runs needed; wins = mean better than the default's by more than both spreads added (default's + variant's); a gain > 0 inside the spreads is insufficient."""
    if len(vals) < 3:
        return "insufficient: %d runs, needs %d more" % (len(vals), 3 - len(vals)), None
    gain = S10.mean(dv) - S10.mean(vals)
    if gain > S10.spread(dv) + S10.spread(vals):  # round 12 R13: "both spreads" = the two spreads added (s4 lean 2q: 1.106 < 0.34 + 0.82)
        return "wins", gain
    if gain > 0:
        return "insufficient: %d runs, needs 3 more" % len(vals), gain
    return "no gain", gain


def identical(sess, v):
    t = t11("det-r11.txt")
    n = len(re.findall(rf"^r10-{sess}-{v}-\d vs r10-{sess}-default-\d: IDENTICAL \(30 checkpoints", t, re.M))
    return n


def proof(sess, v, n):
    if v == "default":
        return "-"
    cap = v.endswith("cap")
    vl = S10.verify_line(PTX.get(v, v) if not cap else v, pp=cap)
    if not cap:
        return f"{identical(sess, v)}/{n} runs 30/30 identical; verify {vl}"
    fin = j11("finalists-s3.json")
    fs = "finalists not run"
    if fin:
        sets = fin["sets"]
        ref = next((k for k in sets if "default" in k), None)
        k = next((k for k in sets if f"-{v}-" in k), None)
        if ref and k:
            fs = f"finalists {sets[k]['meanWinPct'] - sets[ref]['meanWinPct']:+.2f} pt"
    return f"verify {vl}; {fs}"


def tables(L):
    px = S10.jload("ptxas.json", {})
    for s, by in sorted(sessions().items()):
        defs = sorted(by.get("default", []), key=lambda r: r["pass"])
        first = min((r for v in by.values() for r in v), key=lambda r: r["start_epoch"])
        L.append(f"### 30-gen session {s}: start {S10.et(first['start_et'])}, passes interleaved, each pass default then the variants, same seed")
        if len(defs) < 3:
            L.append(f"default has {len(defs)} runs: no verdicts")
            continue
        dv = [r["warm_s_per_gen"] for r in defs]
        L.append("| variant | warm s/gen, runs | mean | spread | vs default | verdict | spill st/ld B | proof | run starts ET |")
        L.append("|---|---|---|---|---|---|---|---|---|")
        for v in [x for x in ORDER if x in by]:
            rr = sorted(by[v], key=lambda r: r["pass"])
            vals = [r["warm_s_per_gen"] for r in rr]
            vd, gain = ("-", None) if v == "default" else verdict_row(vals, dv)
            p = px.get(PTX.get(v, v), {})
            sp = f"{p['entry_spill_st']}/{p['entry_spill_ld']}" if p else "-"
            L.append(f"| {LABEL[v]} | {' / '.join(f'{x:.2f}' for x in vals)} | {S10.mean(vals):.2f} | {S10.spread(vals):.2f} | "
                     f"{'-' if gain is None else f'{-gain:+.2f}'} | {vd} | {sp} | {proof(s, v, len(rr))} | {', '.join(S10.et(r['start_et'])[:5] for r in rr)} |")


def nsight(L):
    nc = S10.jload("ncu/summary.json", {})
    L.append("### Nsight Compute (`out/gpu/r10/ncu/summary.json`; 5k = batch 7, 10k = batch 6; base clocks, kernel replay)")
    L.append("| launch | variant | kernel s | occupancy | long_scoreboard | top stall | local GB | issue-slot use |")
    L.append("|---|---|---|---|---|---|---|---|")
    for launch in ("5k", "10k"):
        for v in [x for x in ORDER if f"{launch}-{x}" in nc or x in ("default", "lean1", "lean2", "lean3", "lean4", "lean2q")] + ["stack", "leancap"]:
            e = nc.get(f"{launch}-{v}")
            if not e:
                continue
            if e["tool"].startswith("missing"):
                L.append(f"| {launch} | {v} | {e['tool']} ({', '.join(e['missing_groups']) or 'all groups'}) | | | | | |")
                continue
            ls = next((x["share_pct"] for x in e["top5_stalls"] if x["reason"] == "long_scoreboard"), None)
            top = e["top5_stalls"][0]
            L.append(f"| {launch} | {v} | {e['kernel_s_at_base_clock']:.2f} | {e['achieved_occupancy_pct']:.1f}% | {'-' if ls is None else f'{ls:.0f}%'} | "
                     f"{top['reason']} {top['share_pct']:.0f}% | {e['local_bytes_gb']:.0f} | {e['issue_slot_use_pct']:.1f}% |")


def ideas():
    """(variant, session, mean, spread, gain, default mean, default spread, minutes saved per 100 gens) for each winning variant with its proof ok."""
    out = []
    for s, by in sessions().items():
        dv = [r["warm_s_per_gen"] for r in by.get("default", [])]
        if len(dv) < 3:
            continue
        for v, rr in by.items():
            if v == "default":
                continue
            vals = [r["warm_s_per_gen"] for r in rr]
            vd, gain = verdict_row(vals, dv)
            if vd != "wins":
                continue
            p = proof(s, v, len(rr))
            if v.endswith("cap"):
                m = re.search(r"verify ([\d.]+)% / (\d+) flagged / ([-+][\d.]+) pp; finalists ([-+][\d.]+) pt", p)
                if not (m and float(m.group(1)) >= 99.5 and abs(float(m.group(3))) <= 1 and abs(float(m.group(4))) <= 1):
                    continue
            elif identical(s, v) < len(rr):
                continue
            out.append((v, s, S10.mean(vals), S10.spread(vals), gain, S10.mean(dv), S10.spread(dv), gain * 100 / 60))
    return sorted(out, key=lambda x: -x[4])


def top3(L):
    spec = j11("top3.json", {"ideas": []})
    byv = {i["variant"]: i for i in spec["ideas"] if i.get("variant")}
    L.append("### Top 3 ideas to implement (ranked by s/gen saved; a 100-gen run is the 30-gen mean x 100)")
    ranked = ideas()
    n = 0
    for v, s, m, sp, gain, dm, ds, mins in ranked:
        if v not in byv:
            continue
        i = byv[v]
        n += 1
        L.append(f"{n}. **{LABEL[v]}**: saves {gain:.2f} s/gen (mean {m:.2f}, spread {sp:.2f} vs default {dm:.2f}, spread {ds:.2f}, session {s}) = "
                 f"{mins:.1f} min per 100-gen run. Proof: {proof(s, v, 3)}. Change: {i['change']} Interacts: {i['interacts']}")
        if n == 3:
            break
    for i in spec["ideas"]:
        if i.get("unmeasured") and n < 3:
            n += 1
            L.append(f"{n}. **{i['title']}** (unmeasured): {i['why']} Test that would settle it: {i['test']} Change: {i['change']} Interacts: {i['interacts']}")
    if n == 0:
        L.append("no idea has a verdict yet")


def insufficient(L):
    """Round 12 R13: a candidate is unresolved only if NO session gave it a clear verdict (wins / no gain); sessions that repeated it count."""
    clear, notes = set(), {}
    for s, by in sorted(sessions().items()):
        dv = [r["warm_s_per_gen"] for r in by.get("default", [])]
        for v, rr in by.items():
            if v != "default" and len(dv) >= 3:
                vd, _ = verdict_row([r["warm_s_per_gen"] for r in rr], dv)
                if vd.startswith("insufficient"):
                    notes.setdefault(v, []).append(f"session {s}: {vd}")
                else:
                    clear.add(v)
    out = [f"{LABEL[v]} ({'; '.join(n)})" for v, n in notes.items() if v not in clear]
    L.append("Unresolved at the end of the budget: " + ("; ".join(out) if out else "none; every candidate has a wins or no gain verdict in some session."))


def build():
    L = [HEAD, "",
         "Branch `gpu`, 2026-10-21. Numbers come only from `out/gpu/r10/runs.json` (speed), `out/gpu/r10/ncu/summary.json` (Nsight) and the files "
         "`python3 gpu/gpu/r11/check.py` re-reads; it rebuilds this section and fails on any difference. Yardstick: warm s/gen = mean of generations 2+ over a "
         "30-gen standard run, 3 interleaved runs per variant with a default run in every pass; spread = max - min; \"wins\" = mean beats the session's default "
         "mean by more than both spreads added together; a gain inside the spreads is \"insufficient\". Clock times are US Eastern. Nothing is on by default.", ""]
    tables(L)
    L.append("")
    nsight(L)
    L.append("")
    insufficient(L)
    L.append("")
    top3(L)
    L.append("")
    L.append("Glossary: **stack** = the compact per-battle state (smaller Move / Mon structs) the kernel keeps in local memory; **occ** = occupancy edits "
             "(noinline cold helpers, fewer live registers) to fit more warps per SM; **lean** = stack + 8/16-bit fields + a binary-search lookahead queue, with "
             "steps 1-6 adding noinline, a half pool and a turn-keyed queue; **cap** = give up the lookahead when its pool reaches N entries (changes some winners, "
             "so it must pass the agreement gate); **spill** = values the compiler cannot keep in the 255 registers and parks in slow local memory, so each use costs a load.")
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
        print(f"wrote {len(sec.splitlines())} lines to {os.path.relpath(DOC, R)}")
    else:
        sys.stdout.write(sec)
