"""pool fork: compare two evolve run dirs' checkpoints (evolve-gen*.json) ignoring timing fields and the out dir.
usage: python3 det.py <dirA> <dirB>  -> one line per generation, IDENTICAL or the first differing key path."""
import glob, json, os, sys

DROP = {"timing", "runStartedAt", "outDir", "csvPath", "gpuProfile", "startedAt", "finishedAt", "elapsedMs", "msPerBattle"}


def clean(o):
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items() if k not in DROP}
    if isinstance(o, list):
        return [clean(v) for v in o]
    return o


def diff(a, b, p=""):
    if type(a) != type(b):
        return p or "/"
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                return f"{p}/{k}"
            d = diff(a[k], b[k], f"{p}/{k}")
            if d:
                return d
        return None
    if isinstance(a, list):
        if len(a) != len(b):
            return f"{p} (len)"
        for i, (x, y) in enumerate(zip(a, b)):
            d = diff(x, y, f"{p}[{i}]")
            if d:
                return d
        return None
    return None if a == b else p


A, B = sys.argv[1], sys.argv[2]
for fa in sorted(glob.glob(os.path.join(A, "evolve-gen*.json"))):
    fb = os.path.join(B, os.path.basename(fa))
    if not os.path.exists(fb):
        print(os.path.basename(fa), "MISSING in", B); continue
    d = diff(clean(json.load(open(fa))), clean(json.load(open(fb))))
    print(os.path.basename(fa), "IDENTICAL" if d is None else f"DIFFER at {d}")
