"""Shared guard: every gpu entry point exits 1 with a one-line reason if CUDA is unusable."""
import sys


def require_cuda():
    """Import cupy and check a device is visible; exit 1 with one line otherwise. Returns the cupy module."""
    try:
        import cupy
    except Exception as e:  # missing wheel, NVRTC/driver load failure
        sys.stderr.write(f"gpu: cupy unavailable ({type(e).__name__}: {str(e).splitlines()[0] if str(e) else ''})\n")
        sys.exit(1)
    try:
        n = cupy.cuda.runtime.getDeviceCount()
    except Exception as e:
        sys.stderr.write(f"gpu: no CUDA device ({type(e).__name__}: {e})\n")
        sys.exit(1)
    if n < 1:
        sys.stderr.write("gpu: no CUDA device visible (CUDA_VISIBLE_DEVICES empty or no driver)\n")
        sys.exit(1)
    return cupy
