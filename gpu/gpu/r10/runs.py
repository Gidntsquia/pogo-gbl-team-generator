"""Round 10 R2: out/gpu/r10/runs.json, the only source of the numbers in docs/gpu-viability.md "Round 10".

    python3 gpu/gpu/r10/runs.py            (no GPU; reads out/evolve-gpu8-r10-*.log and gpu-profile.json)

One entry per run: name, variant (fork), env, seed, start (ET), gens, warm s/gen = mean of gpu-profile.json
generations[].wall for generations 2 and later (plan R1), total wall = "wall end" - "wall start" in the log (process start
to exit), exit code, session (r10-<session>-...), pass. Runs with exit != 0 or fewer generations than asked are kept with
"complete": false and never used in a mean."""
import glob
import json
import os
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

R = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
OUT = os.path.join(R, "out")
ET = ZoneInfo("America/New_York")
SEED = "recipe-ab"   # run10.sh: the last --seed on the command line wins


def one(log_path):
    name = os.path.basename(log_path)[len("evolve-gpu8-"):-4]
    log = open(log_path).read()
    d = log_path[:-4]
    env = (re.search(r"^env: (.*?) HALVING=", log, re.M) or [None, ""])[1].strip()
    gens_asked = int(re.search(r"GENS=(\d+)", log).group(1))
    start = float(re.search(r"wall start ([\d.]+)", log).group(1))
    end = re.search(r"wall end ([\d.]+)", log)
    exit_ = re.findall(r"^exit (\d+)", log, re.M)
    done = len(re.findall(r"^generation \d+: done --", log, re.M))
    prof = os.path.join(d, "gpu-profile.json")
    walls = []
    if os.path.exists(prof):
        walls = [g["wall"] for g in json.load(open(prof)).get("generations", [])]
    warm = [w for g, w in enumerate(walls) if g >= 2]
    m = re.match(r"r10-([^-]+)-(.+?)-(\d+)$", name) or re.match(r"r10-(full)-(.+?)(?:-(\d+))?$", name)
    session, variant_name, pass_ = (m.group(1), m.group(2), m.group(3)) if m else (None, name, None)
    fork = {"default": "default"}.get(variant_name, variant_name)
    for k in ("stack", "occ", "tail", "lean", "cap"):
        if variant_name.startswith(k):
            fork = variant_name
    study = re.search(r"POGO_GPU_STUDY=(\S+)", env)
    capped = [int(x) for x in re.findall(r"gpu cap -- (\d+) of \d+ battles hit", log)]
    return {
        "name": name, "session": session, "pass": int(pass_) if pass_ else None, "variant": fork,
        "study": study.group(1) if study else "", "env": env, "seed": SEED,
        "start_et": datetime.fromtimestamp(start, timezone.utc).astimezone(ET).strftime("%Y-%m-%d %H:%M:%S %Z"),
        "start_epoch": start, "gens_asked": gens_asked, "gens_done": done, "exit": int(exit_[-1]) if exit_ else None,
        "complete": bool(end) and exit_ and int(exit_[-1]) == 0 and done == gens_asked and len(walls) >= gens_asked,
        "warm_s_per_gen": sum(warm) / len(warm) if warm else None, "warm_gens": len(warm),
        "total_wall_s": float(end.group(1)) - start if end else None,
        "cap_hits": sum(capped) if capped else None, "cap_launches": len(capped) or None,
    }


def main():
    runs = [one(p) for p in sorted(glob.glob(os.path.join(OUT, "evolve-gpu8-r10-*.log")))]
    runs.sort(key=lambda r: r["start_epoch"])
    out = os.path.join(OUT, "gpu", "r10", "runs.json")
    json.dump({"note": __doc__.strip().splitlines()[0], "runs": runs}, open(out, "w"), indent=1)
    for r in runs:
        print(f"{r['name']:40s} {r['start_et']}  gens {r['gens_done']}/{r['gens_asked']}  warm {r['warm_s_per_gen'] and round(r['warm_s_per_gen'], 2)}  wall {r['total_wall_s'] and round(r['total_wall_s'])}  exit {r['exit']}")


if __name__ == "__main__":
    main()
