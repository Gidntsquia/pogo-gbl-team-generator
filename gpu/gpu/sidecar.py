"""Sidecar with two transports.

    python -m gpu.sidecar            JSON lines (fallback): one request per stdin line, one response per stdout line
    python -m gpu.sidecar --binary   packed binary frames (gpu/wire.py): whole batches of arrays per message, over
                                     stdin/stdout

JSON-lines protocol:

    {"op":"ping"}
    {"op":"1v1","real":"float","data":"../out/gpu","start":0,"count":10000}   -> {"ok":true,"n":..,"ms":..,"out":[[..18..],..]}
    {"op":"3v3","real":"float","data":"../out/gpu","start":0,"count":1000}   -> {"ok":true,"n":..,"ms":..,"out":[[..],..]}

The sims/battles are read from the export directory (gpu/export-matchups.mjs); the inputs could equally travel inline.
Not imported by src/; gpu/client.mjs is its Node-side caller.
"""
import json
import os
import sys
import time

from .cuda_guard import require_cuda


def serve_binary():
    """Frame loop over stdin/stdout (see gpu/wire.py for the layout). Replies: header + int32 rows."""
    import numpy as np
    from . import wire
    from .pack import D_N, pack_static
    from .kernel1v1 import run_1v1
    from .kernel3v3 import run_3v3, run_3v3_streams, run_3v3_split, B_OUT
    fin, fout = sys.stdin.buffer, sys.stdout.buffer
    state = {"static": None, "streams": 1}

    def reply(f, status, n=0, arg=0, a=0, b=0, payload=b""):
        f.write(wire.pack_header(status, n, arg, a, b) + payload)
        f.flush()

    def handle(op, n, arg, body):
        """-> (n_rows, kernel_us, cols, pieces, int32 bytes)"""
        real = "double" if arg else "float"
        if op == wire.STATIC:
            import json
            state["static"] = np.stack([pack_static(m) for m in json.loads(body.decode())])
            return state["static"].shape[0], 0, 0, 1, b""
        if op == wire.STREAMS:
            state["streams"] = max(1, arg)
            return 0, 0, 0, 1, b""
        if state["static"] is None:
            raise RuntimeError("no static table: send STATIC first")
        t = time.perf_counter()
        if op == wire.BATCH3:
            o1 = n * 6 * 4
            o2 = o1 + n * 6 * D_N * 8
            idx = np.frombuffer(body, "<i4", n * 6, 0).reshape(n, 6)
            dyn = np.frombuffer(body, "<f8", n * 6 * D_N, o1).reshape(n, 6, D_N)
            seeds = np.frombuffer(body, "<u4", n, o2)
            out, pieces = run_3v3_split(state["static"], idx, dyn, seeds, real, nstreams=state["streams"])
            cols = B_OUT
        elif op == wire.BATCH1:
            idx = np.frombuffer(body, "<i4", n * 2, 0).reshape(n, 2)
            dyn = np.frombuffer(body, "<f8", n * 2 * D_N, n * 2 * 4).reshape(n, 2, D_N)
            from .scheduler import InnerSimScheduler  # folds duplicate sims, cuts oversize batches
            sch = InnerSimScheduler(state["static"], real)
            tk = [sch.submit(idx[i], dyn[i]) for i in range(n)]
            res = sch.flush()
            out, pieces = np.stack([res[t] for t in tk]) if n else np.zeros((0, 18), np.int32), 1
            cols = out.shape[1]
        else:
            raise RuntimeError(f"unknown op {op}")
        return n, int((time.perf_counter() - t) * 1e6), cols, pieces, np.ascontiguousarray(out, "<i4").tobytes()

    sys.stdout.write("")  # keep the text layer quiet; the first frame is the ready ping
    reply(fout, 0, 0, 0, 0, 0, b"")
    while True:
        raw = wire.read_exact(fin, wire.HDR.size)
        if raw is None:
            return
        op, n, arg, a, b = wire.unpack_header(raw)
        try:
            if op == wire.QUIT:
                reply(fout, 0)
                os._exit(0)
            if op == wire.PING:
                reply(fout, 0)
                continue
            body = wire.read_exact(fin, wire.request_payload_size(op, n, arg)) if wire.request_payload_size(op, n, arg) else b""
            rn, us, cols, pieces, out = handle(op, n, arg, body)
            reply(fout, 0, rn, us, cols, pieces, out)
        except Exception as e:  # noqa: BLE001
            msg = f"{type(e).__name__}: {e}".encode()
            reply(fout, 1, n=len(msg), payload=msg)


def main():
    require_cuda()
    if "--binary" in sys.argv:
        return serve_binary()
    from .kernel1v1 import run_1v1
    from .kernel3v3 import run_3v3, load_battles
    from .pack import load_static, load_sims
    cache = {}

    def cached(key, fn):
        if key not in cache:
            cache[key] = fn()
        return cache[key]

    print(json.dumps({"ok": True, "ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            op = req.get("op")
            if op == "ping":
                resp = {"ok": True, "pong": True}
            elif op in ("1v1", "3v3"):
                data = req.get("data", "../out/gpu")
                st = cached(("st", data), lambda: load_static(f"{data}/mons.json"))
                lo, cnt = int(req.get("start", 0)), int(req["count"])
                t = time.time()
                if op == "1v1":
                    idx, dyn, _, _ = cached(("sims", data), lambda: load_sims(f"{data}/sims.json"))
                    out = run_1v1(st, idx[lo:lo + cnt], dyn[lo:lo + cnt], req.get("real", "float"))
                else:
                    idx, dyn, seeds, _ = cached(("bat", data), lambda: load_battles(f"{data}/battles.json"))
                    out = run_3v3(st, idx[lo:lo + cnt], dyn[lo:lo + cnt], seeds[lo:lo + cnt], req.get("real", "float"))
                resp = {"ok": True, "n": int(out.shape[0]), "ms": (time.time() - t) * 1000, "out": out.tolist()}
            elif op == "quit":
                sys.stdout.flush()
                os._exit(0)  # skip interpreter teardown of the big cached arrays
            else:
                resp = {"ok": False, "error": f"unknown op {op!r}"}
        except Exception as e:  # noqa: BLE001 - report to the caller, keep serving
            resp = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        print(json.dumps(resp), flush=True)


if __name__ == "__main__":
    main()
