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
    """Frame loop over stdin/stdout (see gpu/wire.py for the layout). Replies: header + int32 rows.
    A reader thread pulls frames off stdin so tagged BATCH3T launches (round 6, R2) stay in flight on their own CUDA streams
    while later requests arrive; finished ones are answered as they complete. Only this loop writes to stdout."""
    import queue
    import threading
    import numpy as np
    from . import wire
    from .pack import D_N, pack_static
    from . import kernel3v3 as K
    fin, fout = sys.stdin.buffer, sys.stdout.buffer
    if K.PROTO == "slice":  # round 7 R4: the width picker's device capacity, logged once at start
        from . import width as WD
        sys.stderr.write(WD.device_line() + f"; POGO_GPU_WIDTH={WD.MODE}" + (", probe on" if WD.PROBE else "") + "\n")
        sys.stderr.flush()
    state = {"static": None, "streams": 1}
    inbox = queue.Queue()

    def reader():
        try:
            while True:
                raw = wire.read_exact(fin, wire.HDR.size)
                if raw is None:
                    inbox.put(None)
                    return
                op, n, arg, a, b = wire.unpack_header(raw)
                size = wire.request_payload_size(op, n, arg) if op not in (wire.QUIT, wire.PING) else 0
                inbox.put((op, n, arg, a, b, wire.read_exact(fin, size) if size else b""))
        except Exception as e:  # noqa: BLE001
            inbox.put(("broken", e))

    def reply(status, n=0, arg=0, a=0, b=0, payload=b""):
        fout.write(wire.pack_header(status, n, arg, a, b) + payload)
        fout.flush()

    def batch3_arrays(n, body):
        o1 = n * 6 * 4
        o2 = o1 + n * 6 * D_N * 8
        idx = np.frombuffer(body, "<i4", n * 6, 0).reshape(n, 6)
        if n and int(idx.max()) >= state["static"].shape[0]:  # a stale table would be read out of bounds by the kernel
            raise RuntimeError(f"mon index {int(idx.max())} >= static table size {state['static'].shape[0]}: send STATIC first")
        return idx, np.frombuffer(body, "<f8", n * 6 * D_N, o1).reshape(n, 6, D_N), np.frombuffer(body, "<u4", n, o2)

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
            idx, dyn, seeds = batch3_arrays(n, body)
            if K.AHEAD and K.PROTO == "slice" and n >= 2:
                out, rec = K.run_3v3_ahead(state["static"], idx, dyn, seeds, real)
                K.write_ahead_log(rec)
                pieces = 2
            else:
                out, pieces = K.run_3v3_split(state["static"], idx, dyn, seeds, real, nstreams=state["streams"])
            cols = K.B_OUT
        elif op == wire.ISLAND:
            from . import island as IS
            job = IS.parse(body)
            if int(job["tIdx"].max(initial=0)) >= state["static"].shape[0]:
                raise RuntimeError("island: mon index beyond the static table: send STATIC first")
            out, status, icut, info = IS.run_island(state["static"], job, real)
            ran = np.nonzero(status == 2)[0]
            head = np.array([info["width"], int(info["span_s"] * 1e6), len(ran), info["tasks"]], np.int32)
            words = np.concatenate([head, status.astype(np.int32), icut.astype(np.int32), out[ran].reshape(-1).astype(np.int32)])
            return words.size, int((time.perf_counter() - t) * 1e6), 1, len(ran), np.ascontiguousarray(words, "<i4").tobytes()
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

    def err_bytes(e):
        return f"{type(e).__name__}: {e}".encode()

    inflight = []  # (tag, handle, t0)

    def poll(block=False):
        for item in list(inflight):
            tag, h, t0 = item
            if block or K.launch_done(h):
                inflight.remove(item)
                try:
                    out = K.launch_collect(h)
                    reply(wire.TAGGED_OK, out.shape[0], int((time.perf_counter() - t0) * 1e6), K.B_OUT, tag, np.ascontiguousarray(out, "<i4").tobytes())
                except Exception as e:  # noqa: BLE001
                    m = err_bytes(e)
                    reply(wire.TAGGED_ERR, len(m), 0, 0, tag, m)

    threading.Thread(target=reader, daemon=True).start()
    reply(0, 0, 0, 0, 0, b"")  # ready
    while True:
        try:
            item = inbox.get(timeout=0.0005) if inflight else inbox.get()
        except queue.Empty:
            item = False
        if item is None:
            poll(block=True)
            return
        if item is False:
            poll()
            continue
        if item[0] == "broken":
            raise item[1]
        op, n, arg, a, b, body = item
        try:
            if op == wire.QUIT:
                poll(block=True)
                reply(0)
                os._exit(0)
            if op == wire.PING:
                reply(0)
            elif op == wire.BATCH3T:
                if state["static"] is None:
                    raise RuntimeError("no static table: send STATIC first")
                import cupy as cp
                idx, dyn, seeds = batch3_arrays(n, body)
                inflight.append((a, K.launch_async(state["static"], idx, dyn, seeds, "double" if arg else "float",
                                                   stream=cp.cuda.Stream(non_blocking=True), share=state["streams"]), time.perf_counter()))
            else:
                rn, us, cols, pieces, out = handle(op, n, arg, body)
                reply(0, rn, us, cols, pieces, out)
        except Exception as e:  # noqa: BLE001
            m = err_bytes(e)
            if op == wire.BATCH3T:
                reply(wire.TAGGED_ERR, len(m), 0, 0, a, m)
            else:
                reply(1, n=len(m), payload=m)
        poll()


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
