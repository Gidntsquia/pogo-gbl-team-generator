"""Verify the CUDA 3v3 battle kernel against pvpoke's own battleTeams results (made by gpu/export-matchups.mjs).

    uv run python -m gpu.verify_3v3 [--data ../out/gpu] [--real both|double|float] [--limit N]

Compares winner and per-mon survivor HP for the fixture battles (test/e2e.test.js: STRONG/WEAK dominant and mirror,
all 9 lead pairings each) and every real gen-0 candidate-vs-opponent battle, then the team-A win rate and the
per-matchup winner agreement (pass/fail thresholds from the plan: |delta| <= 1 pp, agreement >= 99%).
"""
import argparse
import sys
import time

import numpy as np

from .cuda_guard import require_cuda
from .kernel3v3 import load_battles, run_3v3, OUT_FIELDS
from .pack import load_static

WIN = {"a": 0, "b": 1, "tie": 2}
INVALID = 0x6F  # F_UNSUPPORTED|POOL_OVERFLOW|STACK_OVERFLOW|MOVES_OVERFLOW|GUARD|BADSTATE (TIMEOUT=16 is a real outcome)


def compare(bs, out):
    rows = []
    for b, o in zip(bs, out):
        r = b["result"]
        sv = r["survivorsHp"]
        exp_hp = list(sv["aPerMon"]) + list(sv["bPerMon"])
        got_hp = [int(x) for x in o[3:9]]
        rows.append({
            "id": b["id"], "tag": b["tag"], "flags": int(o[10]),
            "winner_ok": int(o[0]) == WIN[r["winner"]],
            "hp_ok": got_hp == exp_hp,
            "turns_ok": int(o[9]) == r["summary"]["turns"],
            "js": WIN[r["winner"]], "gpu": int(o[0]),
        })
    return rows


def report(label, rows):
    sup = [r for r in rows if not (r["flags"] & INVALID)]
    uns = len(rows) - len(sup)
    wm = sum(not r["winner_ok"] for r in sup)
    hm = sum(not r["hp_ok"] for r in sup)
    tm = sum(not r["turns_ok"] for r in sup)
    print(f"  {label}: {len(rows)} battles, {uns} unsupported (flagged), {len(sup)} compared | "
          f"winner mismatches {wm}, survivorsHp mismatches {hm}, turn-count mismatches {tm}")
    return sup


def team_a_rate(winners):
    w = np.asarray(winners)
    return 100.0 * ((w == 0).sum() + 0.5 * (w == 2).sum()) / max(len(w), 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="../out/gpu")
    ap.add_argument("--real", default="both")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    require_cuda()
    st = load_static(f"{a.data}/mons.json")
    idx, dyn, seeds, bs = load_battles(f"{a.data}/battles.json", limit=a.limit or None)
    fx = [i for i, b in enumerate(bs) if b["tag"] != "gen0"]
    real_idx = [i for i, b in enumerate(bs) if b["tag"] == "gen0"]
    print(f"{len(fx)} fixture battles, {len(real_idx)} real gen-0 battles")
    ok = True
    for real in (["double", "float"] if a.real == "both" else [a.real]):
        t = time.time()
        out = run_3v3(st, idx, dyn, seeds, real)
        print(f"[{real}] kernel time {time.time() - t:.1f}s")
        rows = compare(bs, out)
        report("fixtures", [rows[i] for i in fx])
        sup = report("real gen-0", [rows[i] for i in real_idx])
        sel = [i for i in real_idx if not (rows[i]["flags"] & INVALID)]
        jsw = [rows[i]["js"] for i in sel]
        gw = [rows[i]["gpu"] for i in sel]
        d = team_a_rate(gw) - team_a_rate(jsw)
        agree = 100.0 * np.mean([x == y for x, y in zip(jsw, gw)]) if sel else 0.0
        print(f"  team-A win rate: pvpoke {team_a_rate(jsw):.2f}% kernel {team_a_rate(gw):.2f}% delta {d:+.2f} pp -> "
              f"{'PASS' if abs(d) <= 1 else 'FAIL'} (|delta| <= 1 pp)")
        print(f"  per-matchup winner agreement {agree:.2f}% -> {'PASS' if agree >= 99 else 'FAIL'} (>= 99%)")
        bad = [r for r in rows if not (r["flags"] & INVALID) and not (r["winner_ok"] and r["hp_ok"])]
        for r in bad[:8]:
            print(f"    mismatch {r['id']}: winner js={r['js']} gpu={r['gpu']} hp_ok={r['hp_ok']}")
        ok = ok and abs(d) <= 1 and agree >= 99
    sys.exit(0 if ok else 2)


if __name__ == "__main__":
    main()
