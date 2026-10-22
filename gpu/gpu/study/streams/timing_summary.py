"""Fork "streams": sum the per-launch Python-side timings written by the streams variant (timing-<run>.jsonl).

    python3 gpu/gpu/study/streams/timing_summary.py [run ...]  (default streams-time-a streams-time-b)
    -> out/gpu/study/streams/timing-summary.json

Per launch (seconds, wall clock in the sidecar): predict = length prediction for the order; launch = upload + kernel
start (minus predict); kernel = wait for the GPU to finish; collect = download of results; split = the whole call.
other = split - (predict + launch + kernel + collect): Python work around it. Host-side part that a second stream could
in principle overlap with the kernel = predict + launch + collect + other.
"""
import json
import os
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
D = os.path.join(REPO, "out", "gpu", "study", "streams")


def main():
    runs = sys.argv[1:] or ["streams-time-a", "streams-time-b"]
    res = {}
    for r in runs:
        rows = [json.loads(l) for l in open(os.path.join(D, f"timing-{r}.jsonl")) if l.strip()]
        tot = {k: sum(x[k] for x in rows) for k in ("predict", "launch", "kernel", "collect", "split")}
        tot["other"] = tot["split"] - tot["predict"] - tot["launch"] - tot["kernel"] - tot["collect"]
        tot["host_in_sidecar"] = tot["split"] - tot["kernel"]
        res[r] = {"launches": len(rows), "battles": sum(x["n"] for x in rows), "sum_s": tot,
                  "host_share_of_split": tot["host_in_sidecar"] / tot["split"]}
        print(r, len(rows), "launches;", ", ".join(f"{k} {v:.3f}" for k, v in tot.items()),
              f"; sidecar host share {100 * res[r]['host_share_of_split']:.2f}%")
    p = os.path.join(D, "timing-summary.json")
    json.dump(res, open(p, "w"), indent=1)
    print("wrote", p)


if __name__ == "__main__":
    main()
