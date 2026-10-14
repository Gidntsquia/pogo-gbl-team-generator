"""Debug aid: first divergence between pvpoke's and the kernel's move-event sequence for one gen-0 battle.

    uv run python -m gpu.trace_cmp <battle index> [--real double]
"""
import json
import subprocess
import sys

from .kernel3v3 import load_battles, run_3v3
from .pack import load_static


def main():
    k = int(sys.argv[1])
    real = sys.argv[sys.argv.index("--real") + 1] if "--real" in sys.argv else "double"
    d = "../out/gpu"
    st = load_static(f"{d}/mons.json")
    idx, dyn, seeds, bs = load_battles(f"{d}/battles.json", tag="gen0")
    js = json.loads(subprocess.run(["node", "gpu/trace-battle.mjs", str(k)], cwd="..", capture_output=True, text=True).stdout.split("\n", 1)[1])
    out = run_3v3(st, idx[k:k + 1], dyn[k:k + 1], seeds[k:k + 1], real, trace=0)
    mons = json.load(open(f"{d}/mons.json"))
    sp = lambda g: mons[idx[k][g]]["species"]
    gp = [((int(t), int(a), int(m), int(h), "act", 0) if int(x) == -1 else (int(t), int(a), int(m), int(h), "proc", 0) if int(x) == -2 else (int(t), int(a) // 3, int(m), int(h), sp(int(x) // 8), sp(int(x) % 8))) for t, a, m, h, x in run_3v3.last_trace]
    jv = [tuple(e) for e in js["events"]]
    print(f"battle {k} {js['id']}: js {len(jv)} events winner {js['winner']} {js['survivors']['aPerMon']} {js['survivors']['bPerMon']}; "
          f"gpu {len(gp)} events winner {out[0][0]} {list(out[0][3:9])} flags {out[0][10]}")
    gpx = [g for g in gp if g[4] != 'proc']
    if '--procs' in sys.argv:
        for g in gp:
            if g[0] in (38, 39): print('   gpu', g)
    gp = gpx
    for i in range(max(len(jv), len(gp))):
        a = jv[i] if i < len(jv) else None
        b = gp[i] if i < len(gp) else None
        if a != b:
            print(f"first divergence at event {i}: js {a} gpu {b}")
            for j in range(max(0, i - 3), min(max(len(jv), len(gp)), i + 3)):
                print("  ", j, jv[j] if j < len(jv) else None, gp[j] if j < len(gp) else None)
            return
    print("sequences identical")


if __name__ == "__main__":
    main()
