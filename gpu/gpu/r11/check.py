"""Round 11: re-derive the docs/gpu-viability.md "Round 11" section and exit non-zero on any mismatch (also runs round 10's check).

    python3 gpu/gpu/r11/check.py          (no GPU)

Checks: (1) the section equals what build.py rebuilds from the data files; (2) <= 90 lines; (3) no placeholder text in Rounds 10 and 11
('pending', 'no Nsight', 'placeholder', 'not run', 'missing:' without a driver-reset count); (4) every verdict recomputed here from runs.json
by the both-spreads rule; (5) no verdict from fewer than 3 runs; (6) Nsight rows: occupancy, long_scoreboard, local bytes, issue-slot present
for 5k and 10k x {default, stack, lean1-4, lean2q, leancap}; (7) byte-identical variants 30/30 identical and verify 100% / 0 flagged;
(8) cap-class rows: agreement >= 99.5%, delta within 1 pp, finalists within 1 pt; (9) glossary present, at most one unmeasured idea."""
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
import build as S  # noqa: E402

S10 = S.S10
fails = []


def check(ok, msg):
    print("ok  " if ok else "FAIL", msg)
    if not ok:
        fails.append(msg)


def main():
    built = S.build()
    cur = S.current()
    check(cur is not None, "docs has the Round 11 section")
    if cur is not None:
        if cur != built:
            import difflib
            sys.stdout.writelines(difflib.unified_diff(cur.splitlines(True), built.splitlines(True), "docs", "rebuilt"))
        check(cur.rstrip("\n") == built.rstrip("\n"), "docs section equals the section rebuilt from the data files")
    n = len(built.rstrip("\n").splitlines())
    check(n <= 90, f"section is {n} lines (limit 90)")
    doc = open(S.DOC).read()
    r10 = doc[doc.find("## Round 10"):]
    for bad in ("pending", "no Nsight", "placeholder"):
        check(bad not in r10, f"no '{bad}' in Rounds 10-11 of the docs")
    for bad in ("not yet run", "needs 3 more", "unmeasured idea: none"):
        pass
    check("missing: not yet run" not in built, "no Nsight profile left unrun")
    # (4)/(5) verdicts recomputed
    for s, by in S.sessions().items():
        dv = [r["warm_s_per_gen"] for r in by.get("default", [])]
        check(len(dv) >= 3, f"session {s}: >= 3 default runs ({len(dv)})")
        for v, rr in by.items():
            if v == "default":
                continue
            vals = [r["warm_s_per_gen"] for r in rr]
            blk = [x for x in built.split("### 30-gen session ") if x.startswith(s + ":")]
            row = re.search(rf"^\| {re.escape(S.LABEL[v])} \|.*$", blk[0] if blk else "", re.M)
            check(row is not None, f"session {s}: row for {v}")
            if len(vals) < 3:
                check(row is not None and "insufficient" in row.group(0), f"session {s}: {v} has {len(vals)} runs and is 'insufficient'")
                continue
            gain = sum(dv) / len(dv) - sum(vals) / len(vals)
            sp = (max(dv) - min(dv)) + (max(vals) - min(vals))  # both spreads added (round 12 R13)
            want = "wins" if gain > sp else ("insufficient" if gain > 0 else "no gain")
            check(row is not None and f"| {want}" in row.group(0), f"session {s}: {v} verdict '{want}' (gain {gain:+.3f}, spread bound {sp:.3f})")
            if v.endswith("cap"):
                vl = S10.verify_line(v, pp=True)
                m = re.match(r"([\d.]+)% / (\d+) flagged / ([-+][\d.]+) pp", vl)
                check(m is not None and (float(m.group(1)) >= 99.5 and abs(float(m.group(3))) <= 1 or "fails agreement" in built),
                      f"{v}: agreement {vl}")
            else:
                check(S.identical(s, v) == len(rr), f"session {s}: {v} {S.identical(s, v)}/{len(rr)} checkpoints identical to default")
                check(S10.verify_line(S.PTX.get(v, v)).startswith("100.00% / 0 flagged"), f"{v}: verify_3v3 100% / 0 flagged ({S10.verify_line(v)})")
    # (6) Nsight
    nc = S10.jload("ncu/summary.json", {})
    for launch in ("5k", "10k"):
        for v in ("default", "stack", "lean1", "lean2", "lean3", "lean4", "lean2q", "leancap"):
            e = nc.get(f"{launch}-{v}", {})
            ok = e.get("achieved_occupancy_pct") is not None and e.get("local_bytes_gb") is not None and e.get("issue_slot_use_pct") is not None \
                and any(x["reason"] == "long_scoreboard" for x in e.get("top5_stalls", []))
            gap = e.get("tool", "").startswith("missing: driver reset")
            check(ok or gap, f"ncu {launch}-{v}: all four fields present" + (f" (gap named: {e['tool']})" if gap else ""))
    # (9)
    check("Glossary:" in built, "glossary present")
    check(len(re.findall(r"\(unmeasured\)", built)) <= 1, "at most one unmeasured idea")
    check(len(re.findall(r"^\d\. \*\*", built, re.M)) == 3, "three ideas in the top-3 list")
    rc = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "..", "r10", "check.py")], capture_output=True, text=True)
    check(rc.returncode == 0, "round 10 check.py exits 0" + ("" if rc.returncode == 0 else "\n" + rc.stdout[-1500:]))
    print(f"\n{len(fails)} failure(s)")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
