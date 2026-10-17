"""Fork "early": standalone replay of one generation's 3 halving steps with the real slice kernel, release driven by LIVE progress.

    cd gpu && bash ../out/gpu/study/gpulock.sh uv run python -m gpu.study.early.bench2 <capture dir> [--gens 1,2] [--reps 2]
        [--gap 0.23] [--poll 0.05] [--frac 0.5] [--modes base,early]

baseline: L1, host gap, L2, host gap, L3 on one stream (what production does today; gap = sleep, default from the baseline
          profiles' host time per step, out/gpu/study/early/baseline.json).
early:    L1 on stream A. Every --poll s the host copies L1's output rows (one contiguous device->host copy on stream C; copies
          do not wait behind a running kernel on this driver, fills do) and marks a battle finished when its end stamp is set.
          From the finished battles only (their results are the captured production rows, identical by construction and
          checked) it runs the certainty test; once the next-round battles owned by certain teams reach --frac of the next
          round, they are launched on stream B. When L1 ends: host gap, the rest of round 2 on stream A. Round 2 -> 3 the same,
          polling both round-2 launches.
Checks: every row (cols 0..19) equals the captured production row; every team used for a release is a true survivor.
Timeline: GPU first start / last end of each launch (one %globaltimer clock for every stream), host time of each launch call.
Writes <capture>/bench2.json.
"""
import json
import os
import sys
import time

import numpy as np

from ... import kernel3v3 as K
from ... import width as WD
from ...profile_kernel import load_dump
from .certainty import Round, load_capture

NS = lambda o, c: (np.asarray(o).astype(np.int64)[:, c] & 0xFFFFFFFF) | ((np.asarray(o).astype(np.int64)[:, c + 1] & 0xFFFFFFFF) << 32)


def launch(static, b, sel, stream):
    if len(sel) == 0:
        return None
    idx, dyn, seeds = (np.ascontiguousarray(x[sel]) for x in b)
    w, _ = WD.pick(static, idx, dyn)
    return K.slice_launch(static, idx, dyn, seeds, width=w, stream=stream)


def collect(h):
    return np.zeros((0, K.B_OUT), np.int32) if h is None else K.slice_collect(h)[0]


def owners_of(nx):
    al = nx["round"]["alive"]
    own = {}
    for row in nx["plan"]:
        for ix in (int(row[2]), int(row[3])):
            if ix >= 0:
                own.setdefault(ix, set()).add(al[int(row[0])])
    return own


class Poller:
    """Finished-battle mask of a round from its live launches (each: handle + index map into the round's batch)."""

    def __init__(self, n, sC):
        self.n, self.sC, self.parts = n, sC, []

    def add(self, h, sel):
        if h is not None:
            self.parts.append((h, sel))

    def done(self):
        m = np.zeros(self.n, bool)
        for h, sel in self.parts:
            host = h["d_out"].get(stream=self.sC)
            self.sC.synchronize()
            m[sel] = NS(host, 22) != 0
        return m


def certain_release(ev, nx, rd, done, own, already):
    """Next-round battle indices (not yet released) owned by a team certain given only `done` battles; plus the certain team ids."""
    rd.end = np.where(done, 0.0, np.inf)
    lo, hi = rd.bounds(0.5)
    c, _ = rd.certain(lo, hi, ev["round"]["keep"])
    al = ev["round"]["alive"]
    cg = {al[i] for i in np.nonzero(c)[0]}
    rel = sorted(ix for ix, o in own.items() if ix not in already and o & cg)
    return np.array(rel, np.int64), cg


def busy(h):
    return h is not None and not h["stream"].done


def main():
    d = os.path.abspath(sys.argv[1])
    arg = lambda k, dflt: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else dflt
    reps, gap, poll, frac = int(arg("--reps", "2")), float(arg("--gap", "0.23")), float(arg("--poll", "0.05")), float(arg("--frac", "0.5"))
    modes = arg("--modes", "base,early").split(",")
    static, batches = load_dump(os.path.join(d, "dump"))
    evals, cap = load_capture(d)
    gens, cur = [], None
    for ev in evals:
        if ev["round"] is None:
            continue
        if ev["round"]["r"] == 0:
            cur = []
            gens.append(cur)
        cur.append(ev)
    want = [int(x) for x in arg("--gens", ",".join(str(i) for i in range(1, len(gens)))).split(",")]
    import cupy as cp
    sA, sB, sC = (cp.cuda.Stream(non_blocking=True) for _ in range(3))
    import subprocess
    others = subprocess.run(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"], capture_output=True, text=True).stdout.split()
    others = [p for p in others if p.strip() and int(p) != os.getpid()]
    print(f"other GPU processes at start: {others}", flush=True)
    res = {"other_gpu_pids_at_start": others, "capture": d, "gap_s": gap, "poll_s": poll, "frac": frac, "reps": reps, "gens": []}
    for g in want:
        rounds = gens[g]
        R = len(rounds)
        ks = [ev["launch0"] for ev in rounds]
        assert all(ev["launch1"] - ev["launch0"] == 1 for ev in rounds)
        B = [batches[k] for k in ks]
        ref = [cap[k] for k in ks]
        n = [len(b[2]) for b in B]
        own = [owners_of(rounds[r + 1]) for r in range(R - 1)]
        surv = [set(rounds[r + 1]["round"]["alive"]) for r in range(R - 1)]
        gr = {"gen": g, "battles": n, "base": [], "early": []}
        for rep in range(reps):
            if "base" in modes:
                t0 = time.perf_counter()
                outs = []
                for i in range(R):
                    outs.append(collect(launch(static, B[i], np.arange(n[i]), sA)))
                    if i < R - 1:
                        time.sleep(gap)
                wall = time.perf_counter() - t0
                g0 = NS(outs[0], 20).min()
                gr["base"].append({"wall_s": round(wall, 3), "rows_equal": all(np.array_equal(o[:, :20], r[:, :20]) for o, r in zip(outs, ref)),
                                   "launch_gpu_s": [[round(float(NS(o, 20).min() - g0) / 1e9, 3), round(float(NS(o, 22).max() - g0) / 1e9, 3)] for o in outs]})
                print(f"gen {g} rep {rep} base {wall:.3f}s rows {gr['base'][-1]['rows_equal']} gpu {gr['base'][-1]['launch_gpu_s']}", flush=True)
            if "early" not in modes:
                continue
            t0 = time.perf_counter()
            log = []
            # round 0: everything on A
            hA = launch(static, B[0], np.arange(n[0]), sA)
            log.append(("L0", time.perf_counter() - t0, 0, n[0]))
            parts = [[(hA, np.arange(n[0]))]]   # per round: (handle, sel)
            rel_sets, polls, valid, spans = [], [], True, []
            for r in range(R - 1):
                rd = Round(rounds[r], np.zeros(n[r]))
                P = Poller(n[r], sC)
                for h, sel in parts[r]:
                    P.add(h, sel)
                released = np.zeros(0, np.int64)
                hB = None
                while any(busy(h) for h, _ in parts[r]):
                    tp = time.perf_counter()
                    if len(released) == 0:
                        done = P.done()
                        rel, cg = certain_release(rounds[r], rounds[r + 1], rd, done, own[r], set())
                        polls.append((r, round(tp - t0, 3), int(done.sum()), len(cg), len(rel), round(time.perf_counter() - tp, 4)))
                        if not cg <= surv[r]:
                            valid = False
                        if len(rel) >= frac * n[r + 1]:
                            hB = launch(static, B[r + 1], rel, sB)
                            released = rel
                            log.append((f"L{r + 1}early", time.perf_counter() - t0, r + 1, len(rel)))
                    time.sleep(max(0.0, poll - (time.perf_counter() - tp)))
                outs_r = [(collect(h), sel) for h, sel in parts[r]]
                full = np.zeros_like(ref[r])
                for o, sel in outs_r:
                    full[sel] = o
                    spans.append((r, len(sel), int(NS(o, 20).min()), int(NS(o, 22).max())))
                parts[r] = full
                time.sleep(gap)
                rest = np.setdiff1d(np.arange(n[r + 1]), released)
                hR = launch(static, B[r + 1], rest, sA)
                log.append((f"L{r + 1}rest", time.perf_counter() - t0, r + 1, len(rest)))
                parts.append([(h, s) for h, s in ((hB, released), (hR, rest)) if h is not None])
                rel_sets.append(int(len(released)))
            last = parts[R - 1]
            full = np.zeros_like(ref[R - 1])
            for h, sel in last:
                o = collect(h)
                full[sel] = o
                spans.append((R - 1, len(sel), int(NS(o, 20).min()), int(NS(o, 22).max())))
            parts[R - 1] = full
            wall = time.perf_counter() - t0
            same = all(np.array_equal(parts[i][:, :20], ref[i][:, :20]) for i in range(R))
            g0 = NS(parts[0], 20).min()
            gpu = [[round(float(NS(o, 20).min() - g0) / 1e9, 3), round(float(NS(o, 22).max() - g0) / 1e9, 3)] for o in parts]
            gr["early"].append({"wall_s": round(wall, 3), "rows_equal": same, "release_valid": valid, "released": rel_sets,
                                "round_gpu_s": gpu, "launch_log": log, "polls": polls,
                                "launch_gpu_s": [(r_, m_, round((a - g0) / 1e9, 3), round((b_ - g0) / 1e9, 3)) for r_, m_, a, b_ in spans]})
            print(f"gen {g} rep {rep} early {wall:.3f}s rows {same} valid {valid} released {rel_sets}/{n[1:]} gpu {gpu} "
                  f"launches {[(a, round(b, 2), c) for a, b, _, c in log]} launch gpu {gr['early'][-1]['launch_gpu_s']}", flush=True)
        res["gens"].append(gr)
        json.dump(res, open(os.path.join(d, "bench2.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
