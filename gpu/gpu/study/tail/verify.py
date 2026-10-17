"""Round 9 R6a: gpu.verify_3v3 with every battle run through the tail kernel (battle3v3_tail), against pvpoke.

    cd gpu && POGO_GPU_STUDY=tail[,certain] uv run python -m gpu.study.tail.verify [verify_3v3 args]

verify_3v3 checks run_3v3's rows; under the study flags production run_3v3 is unchanged, so this swaps it for a tail launch:
even battles are the main batch, odd battles the pool (the speculative rows a halving round would keep as memo hits); with
"certain" the whole pool is also fed through the in-kernel queue after the first finished main row. Pool battles the launch did
not finish run as main battles of a second tail launch, so every row compared comes from the tail kernel.
"""
import sys
import time

import numpy as np

from ... import kernel3v3 as K
from ... import verify_3v3 as V


def tail_rows(static, idx, dyn, seeds, real="float", certain=False):
    T = K.TAIL
    n_all = idx.shape[0]
    mi, pi = np.arange(0, n_all, 2), np.arange(1, n_all, 2)
    nT = 8
    meta = {"mainTag": (np.arange(len(mi)) % (2 * nT)).astype(np.int32), "poolTeam": (np.arange(len(pi)) % nT).astype(np.int32),
            "priorPts": np.zeros(nT, np.float32), "priorN": np.zeros(nT, np.float32), "keepK": nT // 2, "spec": True, "certain": certain}
    h = T.tail_launch(static, idx[mi], dyn[mi], seeds[mi], (idx[pi], dyn[pi], seeds[pi]), meta, real=real, idle=1.0)
    fed = 0
    if certain:
        while not T.done(h):
            if T.peek(h)[:, 3].sum() > 0:
                fed = T.feed(h, np.arange(len(pi), dtype=np.int32))
                break
            time.sleep(0.02)
    while not T.done(h):
        time.sleep(0.01)
    out, pdone, info = T.tail_collect(h)
    T._reap()
    rows = np.zeros((n_all, out.shape[1]), out.dtype)
    rows[mi] = out[: len(mi)]
    got = np.flatnonzero(pdone)
    rows[pi[got]] = out[len(mi) + got]
    miss = pi[np.flatnonzero(pdone == 0)]
    if len(miss):
        h2 = T.tail_launch(static, idx[miss], dyn[miss], seeds[miss], (idx[:0], dyn[:0], seeds[:0]),
                           dict(meta, mainTag=np.full(len(miss), -1, np.int32), poolTeam=np.zeros(0, np.int32)), real=real)
        while not T.done(h2):
            time.sleep(0.01)
        o2, _, _ = T.tail_collect(h2)
        T._reap()
        rows[miss] = o2[: len(miss)]
    print(f"  tail kernel ({'tail,certain' if certain else 'tail'}): {len(mi)} main rows, {len(got)} of {len(pi)} pool rows from the "
          f"same launch (fed {fed}), {len(miss)} from a second tail launch")
    return rows


def main():
    if not hasattr(K, "TAIL"):
        sys.exit("needs POGO_GPU_STUDY=tail or tail,certain")
    certain = bool(getattr(K, "TAIL_CERTAIN", False))
    V.run_3v3 = lambda st, idx, dyn, seeds, real="float": tail_rows(st, idx, dyn, seeds, real, certain)
    V.main()


if __name__ == "__main__":
    main()
