"""JSON-lines sidecar: one request per stdin line, one response per stdout line.

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


def main():
    require_cuda()
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
