"""cap fork (round 10 R6/R7): a bound on what the slowest battles cost. Selected with POGO_GPU_STUDY=cap (composes with the kernel; one
study flag); POGO_GPU_CAP=<entries> (default CAP) caps the lookahead DP pool per decision.

The longest battles are the ones whose charged-move lookahead (pvpoke ActionLogic DynamicProgramming, pvp1v1.cuh
decideCharged) grows a big state pool: in the 10k launch replay a battle with poolMax 1,420 ran 4.9 s alone against
0.1-0.2 s for the median battle (out/gpu/study/prof/replay/10k.solo.json). The DP already gives up after 500 popped states
(returns -1: the mon falls back to its plain charged-move choice); this fork adds the same give-up when the pool reaches
CAP entries, instead of growing to MAXQ (2,048) or overflowing to the CPU. A decision that hit the cap sets F_CAPPED (128,
outside the host's invalid mask, so the row is kept) and the host logs per launch "gpu cap -- N of M battles hit the pool
cap C". This CAN change winners: its gate is agreement with the CPU engine (verify_3v3), not identity.

The edits are text substitutions on whatever kernel source is current."""
import os
import re
import sys

import numpy as np

CAP = int(os.environ.get("POGO_GPU_CAP", "256"))
F_CAPPED = 128
EDITS = [
    (r"if \(pn >= MAXQ\) \{ \*flags \|= F_POOL_OVERFLOW; return -1; \}",
     r"if (pn >= CAP_POOL) { *flags |= F_CAPPED; return -1; } if (pn >= MAXQ) { *flags |= F_POOL_OVERFLOW; return -1; }"),
    (r"b->flags \|= \(s->flags & F_INVALID_MASK\);", r"b->flags |= (s->flags & (F_INVALID_MASK | F_CAPPED));"),
]


def edit(src, cap=None):
    cap = CAP if cap is None else cap
    for pat, rep in EDITS:
        src2, n = re.subn(pat, rep, src)
        if n == 0:
            raise ValueError(f"cap fork: edit {pat!r} matched nothing")
        src = src2
    return f"#define CAP_POOL {cap}\n#define F_CAPPED {F_CAPPED}   // cap fork: a lookahead pool hit POGO_GPU_CAP (result kept)\n" + src


def apply(K):
    if CAP < 8 or CAP > K.MAXQ:
        raise ValueError(f"POGO_GPU_CAP must be 8..{K.MAXQ}, got {CAP}")
    inner = K.source

    def source(*a, **kw):
        return edit(inner(*a, **kw))
    K.source = source
    collect0 = K.slice_collect

    def slice_collect(h):
        out, info = collect0(h)
        n = int(out.shape[0]) if hasattr(out, "shape") else 0
        hit = int(np.count_nonzero(np.asarray(out)[:, 10] & F_CAPPED)) if n else 0
        info["capped"] = hit
        print(f"gpu cap -- {hit} of {n} battles hit the pool cap {CAP}", file=sys.stderr, flush=True)
        return out, info
    K.slice_collect = slice_collect
    K.CAP = CAP
