"""Round 8 study "split" (POGO_GPU_STUDY=split): the G threads of a battle's group share its runScenario sims instead of all
running the same ones.

Kernel: gpu/gpu/study/split/kernels/ (built from production by make_kernel.py), compiled with #define SPLIT. In runScenario,
a call with C > 1 shield combinations hands combination k0 + l to thread l of the group; each thread checks that the state it
started from equals the true start (the previous combination's end state after the same resets) and the group keeps the
results up to the first mismatch, in combination order, so every row equals production's bit for bit.

Knobs (env):
  POGO_GPU_SPLIT=off        compile without SPLIT (the patched source then runs exactly production's code)
  POGO_GPU_SPLIT_PROF=on    also compile the per-battle counters (g_prof; used by gpu.study.split.measure only)
  POGO_GPU_SPLIT_MINW=G     width floor: a launch whose picked width is below G runs at G (default 1 = the picker's width)
Width otherwise comes from production's picker (POGO_GPU_WIDTH, default auto).
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
KDIR = os.path.join(HERE, "kernels")
SPLIT = os.environ.get("POGO_GPU_SPLIT", "on") != "off"
PROF = os.environ.get("POGO_GPU_SPLIT_PROF", "") == "on"
MINW = int(os.environ.get("POGO_GPU_SPLIT_MINW", "1"))


def source():
    pre = ("#define SPLIT\n" if SPLIT else "") + ("#define SPLIT_PROF\n" if PROF else "")
    return pre + "\n".join(open(os.path.join(KDIR, f)).read() for f in ("pvp1v1.cuh", "battle1v1.cuh", "battle3v3.cuh"))


def apply(K):
    K.source = source
    if MINW > 1:
        from ... import width as WD
        orig = WD.pick

        def pick(static, idx, dyn, real="float", mode=None):
            g, msg = orig(static, idx, dyn, real, mode)
            if isinstance(g, int) and g < MINW:
                return MINW, msg + f" -> G={MINW} (split floor POGO_GPU_SPLIT_MINW)"
            return g, msg
        WD.pick = pick
