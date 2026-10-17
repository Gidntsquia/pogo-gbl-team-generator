"""pool fork: warm s/gen (gens 1..N-1 mean of timing.elapsedMs) per chain run. usage: python3 sgen.py <name>..."""
import glob, json, sys
for n in sys.argv[1:]:
    ms = [json.load(open(f))["timing"]["elapsedMs"] for f in sorted(glob.glob(f"out/evolve-gpu8-{n}/evolve-gen[0-9]*.json"), key=lambda f: int(f.split("gen")[-1][:-5]))]
    print(json.dumps({"run": n, "gens": len(ms), "gen0_s": ms[0] / 1000, "warm_s_per_gen": sum(ms[1:]) / len(ms[1:]) / 1000}))
