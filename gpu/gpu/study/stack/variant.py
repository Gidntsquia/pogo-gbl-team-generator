"""Stack fork (round 8): where the per-battle state lives and how big it is. Selected with POGO_GPU_STUDY=stack.

POGO_GPU_STACK_SRC   compact (default): kernel copies in study/stack/kernels with a compact Move / Mon (8/16-bit fields for
                     table values, flags and small indices; every narrowed load is checked, a value that does not fit flags
                     the row F_BADSTATE so it is re-run on the CPU). compact2: compact + 8/16-bit Act / Timer / QA fields
                     (turn <= 481, slots and flags < 128; values that can be large stay int). prod: the production kernel source.
POGO_GPU_STACK_CARVEOUT  -1 (default: driver choice) or 0..100: preferred shared-memory share of the unified L1/shared
                     memory (0 = largest L1 cache for the local-memory battle state).
Battle code (every step function) is the production code; only struct field types/order and load-time checks differ."""
import os

_HERE = os.path.join(os.path.dirname(__file__), "kernels")
SRC = os.environ.get("POGO_GPU_STACK_SRC", "compact")
CARVEOUT = int(os.environ.get("POGO_GPU_STACK_CARVEOUT", "-1"))


def source():
    pre = "#define STACK_COMPACT2\n" if SRC == "compact2" else ""
    return pre + "\n".join(open(os.path.join(_HERE, f)).read() for f in ("pvp1v1.cuh", "battle1v1.cuh", "battle3v3.cuh"))


def apply(K):
    if SRC not in ("compact", "compact2", "prod"):
        raise ValueError(f"POGO_GPU_STACK_SRC must be compact, compact2 or prod, got {SRC!r}")
    if SRC != "prod":
        K.source = source
    if CARVEOUT >= 0:
        orig = K.get_kernel
        done = set()

        def get_kernel(*a, **kw):
            k = orig(*a, **kw)
            ptr = getattr(k, "kernel", k).ptr
            if ptr not in done:
                from cupy_backends.cuda.api import driver
                driver.funcSetAttribute(ptr, driver.CU_FUNC_ATTRIBUTE_PREFERRED_SHARED_MEMORY_CARVEOUT, CARVEOUT)
                done.add(ptr)
            return k
        K.get_kernel = get_kernel
