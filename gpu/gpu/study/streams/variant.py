"""Round 8 study fork "streams" (POGO_GPU_STUDY=streams): a timing-only wrapper of the slice launch path.

It changes no scheduling and no battle: every wrapped function calls the production one with the same arguments, so rows are
identical by construction. It records, per launch, where the sidecar's own time goes between "frame received" and "rows ready":
  predict   slice_order (the length predictor + sort, host CPU)
  launch    the rest of slice_launch: width pick, device buffers, host->device copies, kernel enqueue (host CPU + copies)
  kernel    waiting for the launch's stream (GPU time not already overlapped with the host work above)
  collect   device->host copies of rows / control / segments and their unpacking (after the GPU is done)
  split     run_3v3_split total (what the sidecar reports to node as kernelUs)
One JSON line per launch goes to POGO_GPU_STREAMS_LOG (default out/gpu/study/streams/timing-<pid>.jsonl).
These are the host-side pieces a two-stream pipeline would try to hide behind kernel time.
"""
import json
import os
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.abspath(os.path.join(_HERE, "..", "..", "..", ".."))


def _log_path():
    p = os.environ.get("POGO_GPU_STREAMS_LOG", "")
    if not p:
        p = os.path.join(_REPO, "out", "gpu", "study", "streams", f"timing-{os.getpid()}.jsonl")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


def apply(K):
    """Wrap K.slice_order, K.slice_launch, K.slice_collect and K.run_3v3_split with perf_counter timers (no behaviour change)."""
    path = _log_path()
    cur = {}
    o_order, o_launch, o_collect, o_split = K.slice_order, K.slice_launch, K.slice_collect, K.run_3v3_split

    def slice_order(*a, **kw):
        t = time.perf_counter()
        r = o_order(*a, **kw)
        cur["predict"] = cur.get("predict", 0.0) + time.perf_counter() - t
        return r

    def slice_launch(*a, **kw):
        t = time.perf_counter()
        h = o_launch(*a, **kw)
        cur["launch_total"] = cur.get("launch_total", 0.0) + time.perf_counter() - t
        cur["n"] = cur.get("n", 0) + int(h.get("n", 0))
        cur["width"] = h.get("width") if isinstance(h.get("width"), int) else str(h.get("width"))
        return h

    def slice_collect(h):
        t = time.perf_counter()
        if h.get("n"):
            h["stream"].synchronize()
        t1 = time.perf_counter()
        r = o_collect(h)
        t2 = time.perf_counter()
        cur["kernel"] = cur.get("kernel", 0.0) + t1 - t
        cur["collect"] = cur.get("collect", 0.0) + t2 - t1
        return r

    def run_3v3_split(*a, **kw):
        cur.clear()
        t = time.perf_counter()
        r = o_split(*a, **kw)
        rec = dict(cur)
        rec["split"] = time.perf_counter() - t
        rec["launch"] = rec.pop("launch_total", 0.0) - rec.get("predict", 0.0)
        rec["at"] = time.time()
        with open(path, "a") as f:
            f.write(json.dumps(rec) + "\n")
        return r

    K.slice_order, K.slice_launch, K.slice_collect, K.run_3v3_split = slice_order, slice_launch, slice_collect, run_3v3_split
