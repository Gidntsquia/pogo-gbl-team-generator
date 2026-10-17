"""Fork "streams": how many seconds per warm generation the host-side buckets take, and how much of them a two-stream
pipeline could hide behind kernel time, from the chain runs' gpu-profile.json.

    python3 gpu/gpu/study/streams/host_buckets.py [run ...]   (default: base-a base-b) -> out/gpu/study/streams/host-buckets.json

Warm generations: from the saturation generation (first gen whose memo hit rate is within 2 pp of the final-5-gen mean, plans
round 8 R8) to the last. Per launch: transport = static + sidecar - span splits into ipc (node<->sidecar pipe and framing =
sidecarMs - kernelUs) and sidecar-host (python-side work inside the sidecar = kernelUs - spanMs) plus staticMs.
"""
import json
import os
import statistics as st
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
HOST = ["plan", "pack", "transport", "map", "accumulate", "ga", "checkpoint", "report"]


def warm_gens(prof):
    """Generation numbers from saturation on (R8 definition) and the per-gen memo hit rates."""
    rate = {}
    for s in prof["steps"]:
        m, n = rate.get(s["gen"], (0, 0))
        rate[s["gen"]] = (m + s["memoHits"], n + s["memoHits"] + s["n"])
    gens = sorted(g for g in rate if isinstance(g, int))
    r = {g: rate[g][0] / max(1, rate[g][1]) for g in gens}
    tail = st.mean(r[g] for g in gens[-5:])
    sat = next(g for g in gens if abs(r[g] - tail) <= 0.02)
    return [g for g in gens if g >= sat], r, sat


def analyze(name):
    d = os.path.join(REPO, "out", f"evolve-gpu8-{name}")
    prof = json.load(open(os.path.join(d, "gpu-profile.json")))
    warm, rate, sat = warm_gens(prof)
    gens = {g["gen"]: g for g in prof["generations"]}
    per = []
    for g in warm:
        G = gens[g]
        b = G["buckets"]
        steps = [s for s in prof["steps"] if s["gen"] == g]
        L = [l for s in steps for l in s["launches"]]
        ipc = sum(l["sidecarMs"] - l["kernelUs"] / 1000 for l in L) / 1000
        side = sum(l["kernelUs"] / 1000 - l["spanMs"] for l in L) / 1000
        static = sum(l["staticMs"] for l in L) / 1000
        host = sum(b.get(k, 0) for k in HOST) + G.get("unattributed", 0)
        gpu = b["kernel"] + b["tail"]
        # what a pipeline could hide, by dependency (see summary.md):
        #  - never: plan (needs the previous round's rows), accumulate of the last rows, ga (needs all 3 rounds), launch latency
        #  - at most: pack + upload of the launch's own later chunks, download + map + accumulate of rows that finished before
        #    the tail ended. Upper bound = pack + transport + map + accumulate (everything except plan, ga, checkpoint, report).
        hide_max = b["pack"] + b["transport"] + b["map"] + b["accumulate"]
        per.append({"gen": g, "wall": G["wall"], "kernel": b["kernel"], "tail": b["tail"], "gpu": gpu, "host": host,
                    **{k: b.get(k, 0) for k in HOST}, "unattributed": G.get("unattributed", 0),
                    "transport_ipc": ipc, "transport_sidecar_host": side, "transport_static": static,
                    "hide_max": hide_max, "launches": len(L), "battles": G["battles"]})
    mean = {k: st.mean(p[k] for p in per) for k in per[0] if k != "gen"}
    return {"run": name, "saturation_gen": sat, "warm_gens": warm, "memo_rate": rate, "per_gen": per, "mean_warm": mean}


def main():
    runs = sys.argv[1:] or ["base-a", "base-b"]
    res = [analyze(r) for r in runs]
    keys = [k for k in res[0]["mean_warm"]]
    both = {k: st.mean(r["mean_warm"][k] for r in res) for k in keys}
    out = {"runs": res, "mean_of_runs": both,
           "note": "seconds per warm generation; hide_max = pack + transport + map + accumulate (upper bound a pipeline could hide)"}
    p = os.path.join(REPO, "out", "gpu", "study", "streams", "host-buckets.json")
    json.dump(out, open(p, "w"), indent=1)
    for r in res:
        m = r["mean_warm"]
        print(f"{r['run']}: sat gen {r['saturation_gen']}, warm gens {r['warm_gens']}, wall {m['wall']:.2f} s/gen, "
              f"gpu {m['gpu']:.2f} (kernel {m['kernel']:.2f} + tail {m['tail']:.2f}), host {m['host']:.2f}")
    print("mean of runs (s per warm gen): " + ", ".join(f"{k} {v:.3f}" for k, v in both.items()))
    print(f"wrote {p}")


if __name__ == "__main__":
    main()
