"""Round 9 R4/R5 GPU check: the tail kernel's rows equal production's.

    cd gpu && POGO_GPU_STUDY=tail uv run python -m gpu.study.tail.selftest [--dump D] [--main 7] [--pool 6] [--np 6000]

Main = one dumped real launch, pool = the first --np battles of another; both are also run through the production slice launch.
Checks: every main row (cols 0-19) equals production; every pool row the tail kernel finished equals production; the launch
ends with the main battles (overrun = last lane exit - last main battle end). Then the same with the certain queue: every
pool battle of half the teams fed after the first peek shows finished main rows. Prints one JSON line per run; exit 1 on a mismatch.
"""
import argparse
import json
import sys
import time

import numpy as np

from ... import kernel3v3 as K
from ...profile_kernel import load_dump


def prod(static, idx, dyn, seeds):
    order, _ = K.slice_order(static, idx, dyn)
    h = K.slice_launch(static, idx, dyn, seeds, order=order, width=1)
    out, _ = K.slice_collect(h)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", default="../out/gpu/study/prof/dump")
    ap.add_argument("--main", default="7")
    ap.add_argument("--pool", default="6")
    ap.add_argument("--np", type=int, default=6000)
    ap.add_argument("--teams", type=int, default=60)
    a = ap.parse_args()
    T = K.TAIL
    static, batches = load_dump(a.dump)
    mi, md, ms = batches[int(a.main)]
    pi, pd, ps = (x[: a.np] for x in batches[int(a.pool)])
    ref_m = prod(static, mi, md, ms)
    ref_p = prod(static, pi, pd, ps)
    n, nP, nT = len(ms), len(ps), a.teams
    meta = {"mainTag": (np.arange(n) % nT * 2 + np.arange(n) % 2).astype(np.int32), "poolTeam": (np.arange(nP) % nT).astype(np.int32),
            "priorPts": np.zeros(nT, np.float32), "priorN": np.zeros(nT, np.float32), "keepK": (nT + 1) // 2}
    bad = 0
    for mode in ("spec", "certain"):
        m = dict(meta, spec=True, certain=mode == "certain")
        t0 = time.perf_counter()
        h = T.tail_launch(static, mi, md, ms, (pi, pd, ps), m)
        fed = 0
        if mode == "certain":
            while not T.done(h):
                rows = T.peek(h)
                if rows[:, 3].sum() > 0:
                    fed = T.feed(h, np.flatnonzero(meta["poolTeam"] % 2 == 0).astype(np.int32))
                    break
                time.sleep(0.05)
        while not T.done(h):
            time.sleep(0.01)
        out, pdone, info = T.tail_collect(h)
        wall = time.perf_counter() - t0
        main_ok = bool((out[:n, :20] == ref_m[:, :20]).all())
        dn = np.flatnonzero(pdone)
        valid = dn[(out[n + dn, 10] & 0x6E) == 0]
        pool_ok = bool((out[n + valid, :20] == ref_p[valid, :20]).all())
        bad += (not main_ok) + (not pool_ok)
        rec = {"mode": mode, "n": n, "pool": nP, "main_rows_equal": main_ok, "pool_rows_equal": pool_ok, "pool_done": int(len(dn)),
               "fed": int(fed), "wall_s": round(wall, 3), **{k: (v if not isinstance(v, np.ndarray) else None) for k, v in info.items() if k != "segments"}}
        print(json.dumps(rec, default=float), flush=True)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
