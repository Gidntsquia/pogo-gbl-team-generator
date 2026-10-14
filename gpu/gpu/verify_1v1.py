"""Verify the CUDA 1v1 kernel against pvpoke's own Battle.simulate() results.

  cd gpu && uv run python -m gpu.verify_1v1 [--data ../out/gpu] [--real float|double|both]

Input is written by `node gpu/export-matchups.mjs --rankings 25` (gen-0 inner sims + rankings-1500 leads).
Prints a per-field mismatch table and the rankings-1500 lead-battle check."""
import argparse
import json
import os
import sys

from .cuda_guard import require_cuda

require_cuda()

import numpy as np  # noqa: E402

from .kernel1v1 import run_1v1  # noqa: E402
from .pack import FIELDS, load_sims, load_static  # noqa: E402


def table(name, out, exp):
    ok = out[:, 16] == 0  # flag 0 = supported and finished cleanly
    n, nsup = len(out), int(ok.sum())
    bad = (out[:, :16] != exp[:, :16]) & ok[:, None]
    rows = bad.any(1)
    print(f"\n[{name}] scenarios={n} supported={nsup} unported(flagged)={n - nsup} rows-with-mismatch={int(rows.sum())}")
    print(f"  {'field':<12}{'mismatches':>11}{'rate':>9}")
    for i, f in enumerate(FIELDS):
        print(f"  {f:<12}{int(bad[:, i].sum()):>11}{bad[:, i].sum() / max(nsup, 1):>9.4%}")
    fl = np.bincount(out[:, 16].astype(int), minlength=32)
    print("  flags:", {int(k): int(v) for k, v in enumerate(fl) if v})
    return int(rows.sum()), n - nsup


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="../out/gpu")
    ap.add_argument("--real", default="both")
    a = ap.parse_args()
    st = load_static(os.path.join(a.data, "mons.json"))
    idx, dyn, exp, sims = load_sims(os.path.join(a.data, "sims.json"))
    gen0 = np.array([not str(s["battle"]).startswith(("rank-", "dominant", "mirror")) for s in sims])
    print(f"data={a.data} distinct sims={len(sims)} gen-0 inner-sim scenarios={int(gen0.sum())}")
    if gen0.sum() < 5000:
        print("WARNING: fewer than 5,000 gen-0 scenarios in the export")
    fails = 0
    for real in (["double", "float"] if a.real == "both" else [a.real]):
        out = run_1v1(st, idx, dyn, real, block=32)
        r, _ = table(f"{real} / gen-0 inner sims", out[gen0], exp[gen0])
        fails += r if real == "double" else 0  # float32 mismatches are reported, not fatal
        rk_path = os.path.join(a.data, "rankings.json")
        if os.path.exists(rk_path):
            rk = json.load(open(rk_path))
            sel = np.array([c["sim"] for c in rk])
            o = out[sel]
            e = np.array([[c["expected"]] for c in rk])
            sup = o[:, 16] == 0
            m1 = (o[:, 0] != e[:, 0]) & sup
            # the recorded rating is rating1 (mon a); mon b's is 1000-ish and checked via the sim row itself
            both = (o[:, :16] != exp[sel][:, :16]) & sup[:, None]
            print(f"[{real}] rankings-1500 leads (shields 1/1): pairs={len(rk)} supported={int(sup.sum())} "
                  f"rating mismatch vs recorded ranking={int(m1.sum())} any-field mismatch vs pvpoke sim={int(both.any(1).sum())}")
            fails += int(m1.sum())
    sys.exit(1 if fails else 0)


main()
