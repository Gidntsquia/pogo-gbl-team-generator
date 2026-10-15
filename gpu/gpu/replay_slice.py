"""Replay a dumped slice and save the kernel output (cols 0..19) for A/B kernel comparisons.

    uv run python -m gpu.replay_slice --dump D --size N --save out.npy [--compare ref.npy] [--block B]
"""
import argparse
import json

import numpy as np

from .cuda_guard import require_cuda
from .profile_kernel import load_dump, slice_of, run_t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", required=True)
    ap.add_argument("--size", type=int, default=5000)
    ap.add_argument("--save")
    ap.add_argument("--compare")
    ap.add_argument("--block", type=int)
    a = ap.parse_args()
    require_cuda()
    static, batches = load_dump(a.dump)
    sl = slice_of(batches, a.size)
    r, out = run_t(static, sl, block=a.block)
    res = {k: r[k] for k in ("n", "span_s", "bps", "tail_share", "battle_p50_s", "battle_max_s", "flagged", "pool_overflow")}
    if a.save:
        np.save(a.save, out[:, :20])
    if a.compare:
        ref = np.load(a.compare)
        res["identical_rows"] = int((ref == out[:, :20]).all(axis=1).sum())
        res["identical_valid_rows"] = int(((ref == out[:, :20]).all(axis=1) | ((ref[:, 10] & 0x6E) != 0)).sum())
    print(json.dumps(res))


if __name__ == "__main__":
    main()
