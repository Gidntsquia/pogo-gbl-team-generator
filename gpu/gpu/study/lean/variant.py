"""lean fork (round 10 R4): less per-battle state and fewer dependent local-memory loads, results byte-identical to the
default path. Selected with POGO_GPU_STUDY=lean; POGO_GPU_LEAN=<step> picks how much of it is on (default DEFAULT_STEP).

Kernel copies in gpu/gpu/study/lean/kernels/ start from the round-8 stack fork (compact Move / Mon) with the round-8 occ
"ni" edits in the files behind LEAN_NI (LEAN_NOINLINE on 31 cold / entry helpers). Steps are cumulative:
  1  compact2: 8/16-bit Act / Timer / QA fields (STACK_COMPACT2) on top of compact Move / Mon
  2  + LEAN_BSEARCH: the lookahead DP finds each queue insertion point by binary search over the turn-sorted queue instead
     of a linear scan of dependent local loads (same index, same order; pvp1v1.cuh qpos_le / qpos_lt)
  3  + LEAN_NI: the occ "ni" noinline edits (round 8: -0.55 s/gen, but ptxas spills 48 B stores / 76 B loads)
  4  + half the lookahead pool: MAXQ 1024 instead of 2048 (K.MAXQ; the pool is 24.6 KB of the 35 KB stack). A battle whose
     pool would pass 1024 is flagged POOL_OVERFLOW and re-run on the CPU exactly as a 2048 overflow is today, so the run's
     results stay identical; the cost is more CPU re-runs (pool study: 0.30% of battles reach 512, far fewer 1024)
  2q = step 2 with the half pool (no noinline): the 0-spill way to the half pool, kept as a measured extra
Battle code is otherwise the production code; nothing here changes a result (checked by verify_3v3 and same-seed checkpoints)."""
import os

_HERE = os.path.join(os.path.dirname(__file__), "kernels")
STEPS = {"1": ("STACK_COMPACT2",), "2": ("STACK_COMPACT2", "LEAN_BSEARCH"), "3": ("STACK_COMPACT2", "LEAN_BSEARCH", "LEAN_NI"),
         "4": ("STACK_COMPACT2", "LEAN_BSEARCH", "LEAN_NI"), "2q": ("STACK_COMPACT2", "LEAN_BSEARCH")}
MAXQ = {"4": 1024, "2q": 1024}   # step -> pool entries per thread when not the production 2048
DEFAULT_STEP = "2"   # the step turned on by plain POGO_GPU_STUDY=lean (set from the round-10 measurements, see docs)
STEP = os.environ.get("POGO_GPU_LEAN", DEFAULT_STEP)


def defines(step=None):
    step = STEP if step is None else step
    if step not in STEPS:
        raise ValueError(f"POGO_GPU_LEAN must be one of {sorted(STEPS)}, got {step}")
    return STEPS[step]


def source(step=None):
    pre = "".join(f"#define {d}\n" for d in defines(step))
    return pre + "\n".join(open(os.path.join(_HERE, f)).read() for f in ("pvp1v1.cuh", "battle1v1.cuh", "battle3v3.cuh"))


def maxq(step=None, default=2048):
    return MAXQ.get(STEP if step is None else step, default)


def apply(K):
    defines()
    K.source = source
    K.MAXQ = maxq(STEP, K.MAXQ)
    K.LEAN_STEP = STEP
