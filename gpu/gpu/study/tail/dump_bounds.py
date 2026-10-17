"""Round 9 R5 check, Python side: certainty.py's bounds (vectorized) and certain sets on every halving round of a capture, at
the selftest instants (quantiles 0.5, 0.9, 0.97, 0.995, 1.0 of the launch's end times). check_certainty.mjs compares the JS port.

    uv run python -m gpu.study.tail.dump_bounds <capture dir> <out.json>
"""
import json
import sys

import numpy as np

from gpu.study.early.certainty import Round, load_capture, stamps

QS = [0.5, 0.9, 0.97, 0.995, 1.0]


def main():
    d, outp = sys.argv[1], sys.argv[2]
    evals, launches = load_capture(d)
    rows = []
    for e, ev in enumerate(evals):
        if ev["round"] is None or ev["launch1"] == ev["launch0"]:
            continue
        end = stamps(launches[ev["launch0"]])[1]
        rd = Round(ev, end)
        for q in QS:
            t = float(np.quantile(end, q))
            lo, hi = rd.bounds(t)
            c, _ = rd.certain(lo, hi, ev["round"]["keep"])
            rows.append({"eval": e, "q": q, "t": t, "lo": lo.tolist(), "hi": hi.tolist(), "certain": c.astype(int).tolist()})
    json.dump(rows, open(outp, "w"))
    print(f"{d}: {len(rows)} instants")


if __name__ == "__main__":
    main()
