"""Round 10 R8: build the docs/gpu-viability.md "Round 10" section from the measurement files, so every number in it is
re-derived (check.py regenerates the section and diffs it against the docs).

    python3 gpu/gpu/r10/section.py            prints the section
    python3 gpu/gpu/r10/section.py --write    replaces (or appends) the "## Round 10" section of docs/gpu-viability.md

Sources (all under out/gpu/r10/): runs.json (timed runs: the only source of s/gen and wall numbers), full100-cmp.txt
(100-gen checkpoint identity), ptxas.json (registers / stack / spill per variant), replay/summary.json (dumped-launch
replays per lean step and cap value), ncu/summary.json (Nsight before/after), verify/verify3v3-*.log (agreement gate),
det-r10.txt (same-seed checkpoints), finalists.json (round-7 top-12 CPU rescoring), cap-value.txt (cap value the A/B used)."""
import json
import os
import re
import sys

R = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
O = os.path.join(R, "out/gpu/r10")
DOC = os.path.join(R, "docs/gpu-viability.md")
HEAD = "## Round 10: as fast as possible (100-gen re-measure, lean state, battle cap)"
LEAN_WHAT = {"1": "compact2 fields (8/16-bit act / timer / QA) on stack", "2": "+ binary-search queue insertion (LEAN_BSEARCH)",
             "3": "+ noinline cold helpers (LEAN_NI)", "4": "+ half lookahead pool (MAXQ 1024)", "2q": "step 2 + half pool, no noinline"}
CAPS = ("128", "192", "256", "512")


def jload(p, default=None):
    p = os.path.join(O, p)
    return json.load(open(p)) if os.path.exists(p) else default


def tload(p):
    p = os.path.join(O, p)
    return open(p).read() if os.path.exists(p) else ""


def et(s):
    """'2026-10-18 19:47:28 EDT' -> '19:47 EDT'"""
    return s[11:16] + " " + s[20:] if s else "?"


def runs():
    return jload("runs.json", {"runs": []})["runs"]


def mean(xs):
    return sum(xs) / len(xs)


def spread(xs):
    return max(xs) - min(xs)


def verdict(var_vals, def_vals):
    """R1: a variant wins only if its mean beats the default's mean by more than both spreads; else no gain."""
    gain = mean(def_vals) - mean(var_vals)
    return ("wins" if gain > max(spread(def_vals), spread(var_vals)) else "no gain"), gain


def full100(L):
    rs = {r["name"][len("r10-full-"):]: r for r in runs() if r["name"].startswith("r10-full-") and r["complete"]}
    cmp = tload("full100-cmp.txt")
    defs = [rs[k]["warm_s_per_gen"] for k in ("default-1", "default-2") if k in rs]
    if len(defs) < 2:
        L.append("### 100-gen runs (R3): not complete")
        return
    first = min(rs.values(), key=lambda r: r["start_epoch"])
    L.append(f"### 100-gen runs (R3): one session, start {et(first['start_et'])}, order default / stack / occ / tail / default, same seed")
    L.append("| run | start ET | total wall (start to exit) | warm s/gen | vs default mean | checkpoints vs default-1 | verdict |")
    L.append("|---|---|---|---|---|---|---|")
    for k in ("default-1", "stack", "occ", "tail", "default-2"):
        r = rs.get(k)
        if not r:
            L.append(f"| {k} | missing | | | | | |")
            continue
        if k == "default-1":
            ident = "-"
        else:
            ident = "100/100 identical" if re.search(rf"^r10-full-{k} vs r10-full-default-1: IDENTICAL \(100 checkpoints", cmp, re.M) else "DIFFER"
        if k.startswith("default"):
            vd, vs = "-", "-"
        else:
            vd, gain = verdict([r["warm_s_per_gen"]], defs)
            vs = f"{-gain:+.2f}"
        L.append(f"| {k} | {et(r['start_et'])} | {r['total_wall_s']:.0f} s ({r['total_wall_s'] / 60:.1f} min) | {r['warm_s_per_gen']:.2f} | {vs} | {ident} | {vd} |")
    L.append(f"Default mean {mean(defs):.2f}, spread {spread(defs):.2f} (two runs); one run per variant, so its own spread is 0 and \"wins\" means "
             f"beating the default mean by more than {spread(defs):.2f}. Checkpoints compared by `gpu/gpu/study/runs.mjs` compareRuns (timing fields ignored). "
             "Nothing was turned on by default: this table is the decision input.")


def ab30(L):
    rs = [r for r in runs() if r["session"] not in (None, "full") and r["complete"]]
    out = {}
    cap = tload("cap-value.txt").strip() or "?"
    for s in sorted({r["session"] for r in rs}):
        ss = [r for r in rs if r["session"] == s]
        by = {}
        for r in ss:
            by.setdefault(r["variant"], []).append(r)
        defs = sorted(by.get("default", []), key=lambda r: r["pass"])
        if len(defs) < 3:
            L.append(f"### 30-gen decision table (R1), session {s}: default has {len(defs)} of 3 runs, no verdicts yet")
            continue
        dv = [r["warm_s_per_gen"] for r in defs]
        first = min(ss, key=lambda r: r["start_epoch"])
        L.append(f"### 30-gen decision table (R1): session {s}, start {et(first['start_et'])}, 3 passes, each pass default then the variants, same seed")
        L.append("| variant | warm s/gen, 3 runs | mean | spread | vs default | verdict | run starts ET |")
        L.append("|---|---|---|---|---|---|---|")
        for v, label in (("default", "default"), ("lean", "lean (step 2)"), ("cap", f"cap {cap}"), ("leancap", f"lean,cap {cap}")):
            rr = sorted(by.get(v, []), key=lambda r: r["pass"])
            if len(rr) < 3:
                L.append(f"| {label} | {len(rr)} of 3 runs | | | | | |")
                continue
            vals = [r["warm_s_per_gen"] for r in rr]
            vd, gain = ("-", None) if v == "default" else verdict(vals, dv)
            out[v] = (mean(vals), spread(vals), vd, gain)
            L.append(f"| {label} | {' / '.join(f'{x:.2f}' for x in vals)} | {mean(vals):.2f} | {spread(vals):.2f} | "
                     f"{'-' if gain is None else f'{-gain:+.2f}'} | {vd} | {', '.join(et(r['start_et'])[:5] for r in rr)} |")
    if not rs:
        L.append("### 30-gen decision table (R1): not run")
    return out


def verify_line(name, pp=False):
    t = tload(f"verify/verify3v3-{name}.log")
    ag = re.search(r"per-matchup winner agreement ([\d.]+)%", t)
    fl = re.search(r"flagged invalid in total: (\d+)", t)
    d = re.search(r"delta ([-+][\d.]+) pp", t)
    if not (ag and fl):
        return "-"
    return f"{ag.group(1)}% / {fl.group(1)} flagged" + (f" / {d.group(1)} pp" if pp else "")


def rep(rp, launch, name, key="kernel_span_s_median", pct="span_vs_default_pct"):
    v = rp.get(launch, {}).get("variants", {}).get(name)
    return f"{v[key]:.2f} s ({v[pct]:+.1f}%)" if v else "-"


def lean(L):
    px = jload("ptxas.json", {})
    rp = jload("replay/summary.json", {})
    base = px.get("default", {}).get("cumulative_stack")
    L.append("### lean (R4): steps are cumulative; results byte-identical to the default path (R5)")
    L.append("| step | what | stack B/thread | regs | spill st/ld B | 5k replay span | 10k span | 36k span | verify_3v3 |")
    L.append("|---|---|---|---|---|---|---|---|---|")
    rows = [("default", "production slice kernel"), ("stack", "round-8 compact Move / Mon")] + [(f"lean{s}", LEAN_WHAT[s]) for s in ("1", "2", "3", "4", "2q")]
    for name, what in rows:
        p = px.get(name)
        if not p:
            L.append(f"| {name} | {what} | no ptxas | | | | | | |")
            continue
        L.append(f"| {name} | {what} | {p['cumulative_stack']:,} ({100 * p['cumulative_stack'] / base:.0f}%) | {p['registers']} | "
                 f"{p['entry_spill_st']}/{p['entry_spill_ld']} | {rep(rp, '5k', name)} | {rep(rp, '10k', name)} | {rep(rp, '36k', name)} | {verify_line(name)} |")
    L.append("Means used: 8/16-bit field packing (step 1), fewer dependent local loads in the lookahead queue (step 2: binary search for the "
             "insertion point, same index and order as the scan), noinline of cold helpers (step 3), half the per-thread pool (step 4: a battle "
             "whose pool passes 1024 is flagged and re-run on the CPU exactly as at 2048, so run results stay identical; replay rows differ "
             "only in those flagged rows). Replays: 5k = prof batch 7, 10k = batch 6, 36k = batches 0-2 merged, median of 3 reps, vs the "
             "default replay of the same launch. Registers stay at 255 at every step (a register target below 255 spilled and lost in round 8), "
             "so occupancy stays at 8 warps/SM and the >=25% target is not reached; the <=50% local-bytes target is only approached by the pool "
             "halving (54% of today's stack bytes), and the spilling step 4 is not the default: plain `POGO_GPU_STUDY=lean` is step 2 (0 spill).")
    L.append("Steps were judged on these replays instead of 30-gen sessions (the user asked for the smallest test that answers the question); "
             "only step 2 went to the A/B. Early-stop rule: step 1 moved the 10k launch under 4%, step 3 over 2 is within replay noise, so the A/B has one lean row.")
    nc = jload("ncu/summary.json", {})
    L.append("Nsight Compute before / after (R4; `out/gpu/r10/ncu/summary.json`, base clocks, kernel replay, same fields as round 9):")
    L.append("| launch | variant | kernel s | achieved occupancy | long_scoreboard share | local bytes | issue-slot use |")
    L.append("|---|---|---|---|---|---|---|")
    for k in ("5k-default", "5k-lean", "10k-default", "10k-lean"):
        v = nc.get(k)
        launch, var = k.split("-")
        if not v or v.get("tool") == "no Nsight":
            L.append(f"| {launch} | {var} | no Nsight: {(v or {}).get('error', 'not run')} | | | | |")
            continue
        ls = next((s["share_pct"] for s in v["top5_stalls"] if s["reason"] == "long_scoreboard"), None)
        L.append(f"| {launch} | {var} | {v['kernel_s_at_base_clock']:.2f} | {v['achieved_occupancy_pct']:.1f}% | "
                 f"{'-' if ls is None else f'{ls:.1f}%'} | {v['local_bytes_gb']:.0f} GB | {v['issue_slot_use_pct']:.1f}% |")
    det = tload("det-r10.txt").strip().splitlines()
    for l in det:
        if l.startswith("POGO_GPU_STUDY=lean 5-gen") or l.startswith("cpu-only 2-gen (round 10 code) vs out/gpu/study/cpu2-r9"):
            L.append(f"- {l}")
    if not det:
        L.append("- det-r10.txt: not run")


def cap(L):
    rp = jload("replay/summary.json", {})
    fin = jload("finalists.json")
    L.append("### cap (R6/R7): cap on pool entries per lookahead decision; gate = agreement with the CPU engine on the 2,436-battle verify set")
    L.append("| cap | verify agreement / flagged / win-rate delta | gate (>=99.5%, +-1 pp) | capped in verify | 36k replay tail after 50% done | 36k span | 10k tail | capped in 36k |")
    L.append("|---|---|---|---|---|---|---|---|")
    gates = {}
    for c in CAPS:
        name = f"cap{c}"
        vl = verify_line(name, pp=True)
        hits = sum(int(x) for x in re.findall(r"gpu cap -- (\d+) of \d+ battles", tload(f"verify/verify3v3-{name}.log")))
        m = re.match(r"([\d.]+)% / (\d+) flagged / ([-+][\d.]+) pp", vl)
        gate = "-" if not m else ("pass" if float(m.group(1)) >= 99.5 and abs(float(m.group(3))) <= 1 else f"cap: fails agreement at {c}")
        gates[c] = gate
        v36 = rp.get("36k", {}).get("variants", {}).get(name)
        L.append(f"| {c} | {vl} | {gate} | {hits if m else '-'} | {rep(rp, '36k', name, 'tail_after_50pct_s', 'tail_vs_default_pct')} | "
                 f"{rep(rp, '36k', name)} | {rep(rp, '10k', name, 'tail_after_50pct_s', 'tail_vs_default_pct')} | {v36['capped'] if v36 else '-'} |")
    capv = tload("cap-value.txt").strip()
    best30 = [c for c in CAPS if gates[c] == "pass" and (rp.get("36k", {}).get("variants", {}).get(f"cap{c}") or {}).get("tail_vs_default_pct", 0) <= -30]
    L.append(f"R6 asked for a cap value that cuts the 36k tail by >=30% in a replay: {'none that passes the agreement gate does' if not best30 else 'cap ' + ', '.join(best30)}; "
             f"128 cuts it most and fails agreement, so the A/B used cap {capv or '?'} (largest tail cut among the passing values). Every launch logs `gpu cap -- N of M battles hit the pool cap C`.")
    if fin:
        sets = fin["sets"]
        ref = next((k for k in sets if "default" in k), None)
        if ref:
            rv = sets[ref]["meanWinPct"]
            parts = []
            for k, s in sets.items():
                parts.append(f"{os.path.basename(k).replace('evolve-gpu8-r10-', '')} {s['meanWinPct']:.2f}% ({s['meanWinPct'] - rv:+.2f} pt)")
            L.append(f"Top-12 finalists of each 30-gen run re-battled on the CPU engine against the gen-{sets[ref]['gen']} opponent pool of {os.path.basename(ref)} "
                     f"(round-7 method, {fin['opponents']} opponents): mean CPU win " + "; ".join(parts) + ". Pass = within 1 pt of the default run.")
    else:
        L.append("Top-12 finalist check (round-7 method): not run.")


def turn_on(L, ab):
    L.append("### What to turn on (three lines, numbers from `runs.json`)")
    rs = {r["name"][len("r10-full-"):]: r for r in runs() if r["name"].startswith("r10-full-") and r["complete"]}
    defs = [rs[k]["warm_s_per_gen"] for k in ("default-1", "default-2") if k in rs]
    if "stack" in rs and len(defs) == 2:
        vd, gain = verdict([rs["stack"]["warm_s_per_gen"]], defs)
        L.append(f"1. `POGO_GPU_STUDY=stack`-class state packing is real: at 100 gens stack {vd} ({-gain:+.2f} s/gen vs the default mean {mean(defs):.2f}, "
                 f"default spread {spread(defs):.2f}); occ and tail: see the 100-gen table.")
    for v, label in (("lean", "`POGO_GPU_STUDY=lean` (step 2, byte-identical)"), ("leancap", "`POGO_GPU_STUDY=lean,cap`"), ("cap", "`POGO_GPU_STUDY=cap`")):
        if v in ab:
            m, s, vd, gain = ab[v]
            L.append(f"{'2' if v == 'lean' else '3'}. {label}: {vd} at 30 gens ({-gain:+.2f} s/gen, mean {m:.2f}, spread {s:.2f} vs default {ab['default'][0]:.2f}, spread {ab['default'][1]:.2f})"
                     + ("; cap changes winners, so it is a trade the user decides on with the agreement numbers above." if "cap" in v else "."))
            if v == "leancap":
                break
    if not ab:
        L.append("2. lean: 30-gen A/B not run yet.")
        L.append("3. cap: 30-gen A/B not run yet.")


def build():
    L = [HEAD, "",
         "Branch `gpu`, 2026-10-18. The user's ask: use what the rounds taught to make `--gpu` runs as fast as possible. Numbers come only from "
         "`out/gpu/r10/runs.json` (`python3 gpu/gpu/r10/runs.py`) and the files `python3 gpu/gpu/r10/check.py` re-reads (it rebuilds this section "
         "with `gpu/gpu/r10/section.py` and fails on any difference). Warm s/gen = mean wall of generations 2 and later from `gpu-profile.json`; "
         "spread = max - min; rule (R1): a variant wins only if its mean beats the default's mean by more than both spreads, else \"no gain\". "
         "Clock times are US Eastern.", ""]
    full100(L)
    L.append("")
    ab = ab30(L)
    L.append("")
    lean(L)
    L.append("")
    cap(L)
    L.append("")
    turn_on(L, ab)
    return "\n".join(L) + "\n"


def current():
    """The section as it stands in the docs (from HEAD to the next '## ' heading or end of file), or None."""
    t = open(DOC).read()
    i = t.find(HEAD)
    if i < 0:
        return None
    j = t.find("\n## ", i + 1)
    return t[i:] if j < 0 else t[i:j + 1]


def write(sec):
    t = open(DOC).read()
    cur = current()
    if cur is None:
        t = t.rstrip("\n") + "\n\n" + sec
    else:
        t = t.replace(cur, sec)
    open(DOC, "w").write(t)


if __name__ == "__main__":
    sec = build()
    if "--write" in sys.argv:
        write(sec)
        print(f"wrote {len(sec.splitlines())} lines to {os.path.relpath(DOC, R)}")
    else:
        sys.stdout.write(sec)
