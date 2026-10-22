"""Same-seed checkpoint comparison (round-7 rule of gpu/gpu-width.mjs compareRuns: timing fields stripped).

    python3 gpu/gpu/study/cpushare/det.py <out.txt> <base run> <run> [<run> ...]
Compares out/evolve-gpu8-<run>/evolve-gen[0-9]*.json against the base run's and appends one line per run to <out.txt>.
"""
import glob
import json
import os
import re
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
DROP = re.compile(r"ms$|elapsed|^timing$|runStartedAt|^threadsUsed$|^resumed$|startedAt|finishedAt|csvPath|outDir|^analytics$", re.I)


def strip(o):
    if isinstance(o, list):
        return [strip(v) for v in o]
    if isinstance(o, dict):
        return {k: strip(v) for k, v in o.items() if not DROP.search(k)}
    return o


def compare(a, b):
    da, db = (os.path.join(REPO, "out", f"evolve-gpu8-{x}") for x in (a, b))
    fa = sorted(os.path.basename(f) for f in glob.glob(os.path.join(da, "evolve-gen[0-9]*.json")))
    fb = sorted(os.path.basename(f) for f in glob.glob(os.path.join(db, "evolve-gen[0-9]*.json")))
    if fa != fb:
        return f"{b} vs {a}: DIFFERENT file sets ({len(fb)} vs {len(fa)} checkpoints)"
    differ = [f for f in fa if strip(json.load(open(os.path.join(da, f)))) != strip(json.load(open(os.path.join(db, f))))]
    return f"{b} vs {a}: " + ("IDENTICAL" if not differ else f"DIFFER in {', '.join(differ)}") + f" ({len(fa)} checkpoints)"


def main():
    out, base, runs = sys.argv[1], sys.argv[2], sys.argv[3:]
    lines = [compare(base, r) for r in runs]
    with open(out, "a") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
