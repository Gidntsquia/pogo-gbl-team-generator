"""Round 12: rebuild the docs "Round 12" section and exit non-zero on any mismatch.  python3 gpu/gpu/r12/check.py   (no GPU)

Checks: section equals build.py's output; <= 80 lines; no 'pending' / 'placeholder' in docs/gpu-viability.md; ptxas spill line present; det-r12 and
100-gen comparisons IDENTICAL; every s6 verdict recomputed here by the both-spreads rule; a candidate marked default has verdict 'wins' and a proof;
Nsight lean 6 rows for 5k and 10k present; rounds 10 and 11 checks still pass."""
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
import build as B  # noqa: E402

S10 = B.S10
fails = []


def check(ok, msg):
    print("ok  " if ok else "FAIL", msg)
    if not ok:
        fails.append(msg)


def main():
    built = B.build()
    cur = B.current()
    check(cur is not None, "docs has the Round 12 section")
    if cur is not None:
        if cur != built:
            import difflib
            sys.stdout.writelines(difflib.unified_diff(cur.splitlines(True), built.splitlines(True), "docs", "rebuilt"))
        check(cur == built, "docs section equals the section rebuilt from the data files")
    n = len(built.rstrip("\n").splitlines())
    check(n <= 80, f"section is {n} lines (limit 80)")
    doc = open(B.DOC).read()
    check(not re.search(r"pending|placeholder", doc), "no 'pending' / 'placeholder' in docs/gpu-viability.md")
    check("spill 48 B stores / 76 B loads" in built, "ptxas spill line present")
    d = B.t12("det-r12.txt")
    check(len(re.findall(r"IDENTICAL \(30 checkpoints", d)) == 3 and "DIFFER" not in d, "det-r12: 30/30 IDENTICAL x3")
    f = B.t12("full100-cmp.txt")
    check(len(re.findall(r"IDENTICAL \(100 checkpoints", f)) == 2 and "DIFFER" not in f, "full100-cmp: 100/100 IDENTICAL x2")
    check("100.00%" in B.t12("verify3v3.log") and "flagged" in B.t12("verify3v3.log") or "agreement 100.00%" in built, "verify_3v3 100%")
    by = B.s6()
    dv = [r["warm_s_per_gen"] for r in by.get("default", [])]
    check(len(dv) >= 3, f"s6: >= 3 default runs ({len(dv)})")
    for v, rr in by.items():
        if v == "default":
            continue
        vals = [r["warm_s_per_gen"] for r in rr]
        row = re.search(rf"^\| {re.escape(B.LABEL[v])} \|.*$", built, re.M)
        if len(vals) < 3:
            check(row is not None and "insufficient" in row.group(0), f"s6 {v}: {len(vals)} runs -> insufficient")
            continue
        gain = sum(dv) / len(dv) - sum(vals) / len(vals)
        sp = (max(dv) - min(dv)) + (max(vals) - min(vals))
        want = "wins" if gain > sp else ("insufficient" if gain > 0 else "no gain")
        check(row is not None and f"| {want}" in row.group(0), f"s6 {v}: verdict '{want}' (gain {gain:+.3f}, bound {sp:.3f})")
    dec = B.j12("decisions.json", {})
    for line in dec.get("default", []):
        m = re.match(r"(share \S+|CPU below \d+)", line)
        if m and "stays off" not in line:
            check(False, f"default change without a 'wins' + proof check: {line}")
    nc = S10.jload("ncu/summary.json", {})
    for launch in ("5k", "10k"):
        e = nc.get(f"{launch}-lean6", {})
        check(e.get("achieved_occupancy_pct") is not None, f"ncu {launch}-lean6 present")
    for sub in ("r10", "r11"):
        rc = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "..", sub, "check.py")], capture_output=True).returncode
        check(rc == 0, f"round {sub[1:]} check.py exits 0")
    print(f"{len(fails)} failure(s)")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
