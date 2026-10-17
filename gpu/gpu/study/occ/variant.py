"""occ study (round 8): more battles resident per SM by cutting registers per thread.

Kernel copies live in gpu/gpu/study/occ/kernels/ (identical to production at copy time); a variant = text edits on those
copies + extra NVRTC options + a block size. Selected with POGO_GPU_STUDY=occ; POGO_GPU_OCC=<name> picks the variant
(default DEFAULT below). The battle math is never changed: only inlining, register limits and launch shape.
"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
KDIR = os.path.join(HERE, "kernels")
PROD_KDIR = os.path.join(os.path.dirname(HERE), "..", "kernels")

# name -> {maxrreg, lb: (threads, minBlocks) for __launch_bounds__ on battle3v3_slice, block, edits: [(regex, repl)], opts, prod_src}
VARIANTS = {
    "prod": {"prod_src": True},
    "copy": {},
}
# cold paths (switch-in / form change / shield decision / mon setup) and the slice entry's inlined helpers (battle init, row
# write, state save/load) become real calls, so their registers are not live in the caller. With --fmad=false every float op is
# rounded on its own, so inlining or not cannot change a result.
COLD = [(r"__device__ void (changeForm|resetMon|resetMoves|loadMon|freshMon)\(", r"__device__ __noinline__ void \1("),
        (r"__device__ bool wouldShield\(", r"__device__ __noinline__ bool wouldShield(")]
ENTRY = [(r"static __device__ __forceinline__ void (battle_init_teams|battle_init|battle_write|save_state|load_state)\(",
          r"static __device__ __noinline__ void \1(")]
VARIANTS["prod64"] = {"prod_src": True, "block": 64}
VARIANTS["ni"] = {"edits": COLD + ENTRY}
for _r in (168, 128, 96, 80, 64, 48):
    _b = 64 if _r > 48 else 128  # 16 blocks per SM at most (sm_86): blocks of 64 threads cap residency at 32 warps
    VARIANTS[f"cap{_r}"] = {"maxrreg": _r, "block": _b}
    VARIANTS[f"ni-cap{_r}"] = {"maxrreg": _r, "block": _b, "edits": COLD + ENTRY}
DEFAULT = "ni"  # set from the bench (see out/gpu/study/occ/summary.md)


def _read(d):
    return "\n".join(open(os.path.join(d, f)).read() for f in ("pvp1v1.cuh", "battle1v1.cuh", "battle3v3.cuh"))


def raw_source(name):
    v = VARIANTS[name]
    src = _read(PROD_KDIR if v.get("prod_src") else KDIR)
    for pat, rep in v.get("edits", ()):
        src2 = re.sub(pat, rep, src)
        if src2 == src:
            raise ValueError(f"occ variant {name}: edit {pat!r} matched nothing")
        src = src2
    if v.get("lb"):
        t, mb = v["lb"]
        src2 = src.replace('extern "C" __global__ void battle3v3_slice(', f'extern "C" __global__ void __launch_bounds__({t}, {mb}) battle3v3_slice(')
        assert src2 != src
        src = src2
    return src


def options(name, maxrreg=None):
    v = VARIANTS[name]
    rr = maxrreg or v.get("maxrreg")
    return ("--std=c++14", "--fmad=false") + tuple(v.get("opts", ())) + ((f"--maxrregcount={rr}",) if rr else ())


def build_source(name, real="float", maxq=2048, defines=(), maxrreg=None):
    """(full NVRTC source, options) exactly as kernel3v3.get_kernel builds them, for variant `name`."""
    extra = "".join("#define %s\n" % d for d in defines)
    src = "#define REAL %s\n#define NO_1V1_KERNEL\n#define MAXQ %d\n%s%s" % (real, maxq, extra, raw_source(name))
    return src, options(name, maxrreg)


CUBIN_DIR = os.path.join(HERE, "..", "..", "..", "..", "out", "gpu", "study", "occ", "cubin")


def src_hash(src, opts):
    import hashlib
    return hashlib.sha256((src + "\0" + " ".join(opts)).encode()).hexdigest()


def cubin_path(vname, src, opts):
    """Bench speed-up: a cubin saved by gpu.study.occ.regs for exactly this source + options (sm_86, any variant name), else None."""
    import glob
    want = src_hash(src, opts)
    for h in sorted(glob.glob(os.path.join(CUBIN_DIR, "*.sha"))):
        if open(h).read().strip() == want:
            return h[:-4] + ".cubin"
    return None


def make_get_kernel(K, vname):
    """A replacement for K.get_kernel compiling variant `vname` (same signature and caching contract)."""
    mods = {}

    def get_kernel(real="float", maxq=None, maxrreg=None, defines=None, name="battle3v3_kernel"):
        cp = K.require_cuda()
        defines = K.DEFAULT_DEFINES if defines is None else defines
        key = (real, maxq or K.MAXQ, maxrreg, tuple(defines))
        if key not in mods:
            src, opts = build_source(vname, real, maxq or K.MAXQ, tuple(defines), maxrreg)
            cub = cubin_path(vname, src, opts)
            mods[key] = None
            if cub:
                try:
                    mods[key] = cp.RawModule(path=cub)
                    mods[key].get_function(name)
                except Exception:  # noqa: BLE001  (an unloadable saved cubin: compile instead)
                    mods[key] = None
            if mods[key] is None:
                mods[key] = cp.RawModule(code=src, options=opts)
        return mods[key].get_function(name)
    return get_kernel


def apply(K, name=None):
    name = name or os.environ.get("POGO_GPU_OCC", DEFAULT)
    if name not in VARIANTS:
        raise ValueError(f"POGO_GPU_OCC: unknown occ variant {name!r} (known: {', '.join(VARIANTS)})")
    K.get_kernel = make_get_kernel(K, name)
    K.BLOCK = VARIANTS[name].get("block", K.BLOCK)
    K.OCC_VARIANT = name
    return K
