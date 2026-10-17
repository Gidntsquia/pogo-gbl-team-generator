"""Fork "early": fluid replay model of starting next-round battles of sure winners inside the previous round's tail.

    cd gpu && uv run python -m gpu.study.early.model <capture dir> [--gap 0.23] [--poll 0.05] [--lag 0.02]

MODELLED, not measured. Inputs are measured: per-battle start/end stamps of every halving round (capture rows) and the
certainty test of certainty.py evaluated on a fine time grid. Model:
  - round r's GPU capacity C_r = the most battles running at once in its launch; free share f(t) = 1 - running(t)/C_r;
  - a next-round battle j costs d_j / C_{r+1} GPU-seconds (d_j = its end - start in its own captured launch);
  - the host polls finished rows every --poll s and releases the next-round battles of every team certain at that poll,
    --lag s later (launch latency);
  - released work runs at rate f(t) until round r's last battle ends, then at rate 1 during the host gap (--gap: the
    GPU is idle between dependent steps today), then the rest of round r+1 starts;
  - round r+1's new span = max(span - absorbed work, longest unreleased battle, latest (release + own duration) of a
    released battle measured from the rest launch) -- stragglers still take their own measured time.
Saving per boundary = old span - new span (gap hidden counts inside 'absorbed'). Writes <capture>/model.json.
"""
import json
import math
import os
import sys

import numpy as np

from .certainty import Round, load_capture, stamps


def running(start, end, t):
    return int(((start <= t) & (end > t)).sum())


def boundary(ev, nx, L, Lnx, keep, gap, poll, lag, dt=0.005):
    s, e = stamps(L)
    ns_, ne = stamps(Lnx)
    span, nspan = float(e.max()), float(ne.max())
    d = ne - ns_
    grid = np.arange(0, span + dt, dt)
    run = np.array([running(s, e, t) for t in grid])
    C = run.max()
    run_nx = np.array([running(ns_, ne, t) for t in np.arange(0, nspan + dt, dt)])
    Cn = run_nx.max()
    rd = Round(ev, e)
    alive = ev["round"]["alive"]
    nx_alive = nx["round"]["alive"]
    owners = {}
    for row in nx["plan"]:
        tg = nx_alive[int(row[0])]
        for ix in (int(row[2]), int(row[3])):
            if ix >= 0:
                owners.setdefault(ix, set()).add(tg)
    rel_t = np.full(len(d), math.inf)
    polls = np.arange(poll, span + poll, poll)
    first_cert = None
    for t in polls:
        if t < np.quantile(e, 0.4):
            continue  # nothing is certain before ~half the battles are in (measured: 0 certain at p50 in every round)
        lo, hi = rd.bounds(t)
        c, _ = rd.certain(lo, hi, keep)
        if c.any() and first_cert is None:
            first_cert = float(t)
        cg = {alive[i] for i in np.nonzero(c)[0]}
        for ix, own in owners.items():
            if rel_t[ix] == math.inf and own & cg:
                rel_t[ix] = t + lag
    work = d / Cn  # GPU-seconds per next-round battle
    # fluid: process released work FIFO by release time while capacity is free
    order = np.argsort(rel_t, kind="stable")
    free = np.clip(1 - run / C, 0, 1)
    pending = 0.0
    absorbed = 0.0
    k = 0
    for gi, t in enumerate(grid):
        while k < len(order) and rel_t[order[k]] <= t:
            pending += work[order[k]]
            k += 1
        x = min(pending, free[gi] * dt)
        pending -= x
        absorbed += x
    # host gap: GPU idle today; released (not yet absorbed) work runs at full rate
    released_by_end = rel_t <= span
    pending_gap = min(pending, gap)
    absorbed += pending_gap
    unrel_max = float(d[~released_by_end].max()) if (~released_by_end).any() else 0.0
    # a released battle cannot end before its release + its own measured duration (straggler bound)
    rel_fin = float((rel_t[released_by_end] + d[released_by_end]).max() - span - gap) if released_by_end.any() else 0.0
    new_span = max(nspan - absorbed, unrel_max, rel_fin, 0.0)
    return {"span_s": round(span, 3), "next_span_s": round(nspan, 3), "capacity": int(C), "next_capacity": int(Cn),
            "first_certain_s": first_cert, "released": int(released_by_end.sum()), "next_fresh": len(d),
            "released_work_gpu_s": round(float(work[released_by_end].sum()), 3), "next_work_gpu_s": round(float(work.sum()), 3),
            "tail_free_gpu_s": round(float(free.sum() * dt), 3), "absorbed_gpu_s": round(absorbed, 3),
            "longest_unreleased_s": round(unrel_max, 3), "released_finish_bound_s": round(rel_fin, 3), "new_next_span_s": round(new_span, 3), "saved_s": round(nspan - new_span, 3)}


def main():
    d = sys.argv[1]
    arg = lambda k, dflt: float(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else dflt
    gap, poll, lag = arg("--gap", 0.23), arg("--poll", 0.05), arg("--lag", 0.02)
    evals, launches = load_capture(d)
    gens, cur = [], None
    for ev in evals:
        if ev["round"] is None:
            continue
        if ev["round"]["r"] == 0:
            cur = []
            gens.append(cur)
        cur.append(ev)
    out = {"capture": d, "gap_s": gap, "poll_s": poll, "lag_s": lag, "modelled": True, "gens": []}
    for g, rounds in enumerate(gens):
        keep = rounds[0]["round"]["keep"]
        bs = []
        for r in range(len(rounds) - 1):
            ev, nx = rounds[r], rounds[r + 1]
            assert nx["launch1"] - nx["launch0"] == 1 and ev["launch1"] - ev["launch0"] == 1
            b = boundary(ev, nx, launches[ev["launch0"]], launches[nx["launch0"]], keep, gap, poll, lag)
            b["round"] = r
            bs.append(b)
            print(f"gen {g} boundary {r}->{r + 1}: span {b['span_s']}s, first certain {b['first_certain_s']}, released "
                  f"{b['released']}/{b['next_fresh']} ({b['released_work_gpu_s']}/{b['next_work_gpu_s']} GPU-s), tail free "
                  f"{b['tail_free_gpu_s']} GPU-s, absorbed {b['absorbed_gpu_s']}, next span {b['next_span_s']} -> "
                  f"{b['new_next_span_s']} (saved {b['saved_s']}s)", flush=True)
        out["gens"].append({"gen": g, "boundaries": bs, "saved_s": round(sum(b["saved_s"] for b in bs), 3)})
        print(f"gen {g}: saved {out['gens'][-1]['saved_s']}s", flush=True)
    warm = [x["saved_s"] for x in out["gens"][1:]]
    out["warm_saved_s_mean"] = round(float(np.mean(warm)), 3) if warm else None
    print(f"warm gens mean saved {out['warm_saved_s_mean']}s")
    json.dump(out, open(os.path.join(d, "model.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
