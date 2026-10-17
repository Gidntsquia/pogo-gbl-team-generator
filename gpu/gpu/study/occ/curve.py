"""occ study: merge bench-*.json into the occupancy-vs-speed curve (each bench's ratio is against prod in the same run).

    python3 -m gpu.study.occ.curve OUTDIR   -> OUTDIR/curve.json, OUTDIR/curve.txt
"""
import glob
import json
import os
import sys

regs = {}
for f in glob.glob(os.path.join(sys.argv[1], "regs-*.json")):
    for n, r in json.load(open(f)).items():
        if r["entry"].get("registers"):
            regs[n] = r["entry"]
rows = []
for f in sorted(glob.glob(os.path.join(sys.argv[1], "bench-*.json"))):
    b = json.load(open(f))
    for n, r in b["variants"].items():
        if n == "prod" and f[-6:] != "a.json":
            continue
        e = regs.get(n, regs.get("prod") if n in ("prod", "prod64") else {})
        rows.append({"variant": n, "bench": os.path.basename(f), "registers": r["num_regs"], "warps_per_sm": r["warps_per_sm"],
                     "local_bytes": r["local_bytes"], "spill_store_B": e.get("spill_st"), "spill_load_B": e.get("spill_ld"),
                     "sum_median_span_s": round(r["sum_median_span"], 3), "speed_vs_prod": round(r["ratio_vs_prod"], 3),
                     "rows_identical": r["all_identical"]})
json.dump(rows, open(os.path.join(sys.argv[1], "curve.json"), "w"), indent=1)
with open(os.path.join(sys.argv[1], "curve.txt"), "w") as fh:
    fh.write("speed vs prod = prod's summed median kernel span / variant's, same bench run (>1 faster); launches 3,4,5 of dump/\n")
    fh.write(f"{'variant':12} {'bench':13} {'regs':>4} {'warps/SM':>8} {'spill st/ld B':>14} {'span s':>7} {'speed':>6} identical\n")
    for r in sorted(rows, key=lambda r: (r["warps_per_sm"], r["variant"])):
        fh.write(f"{r['variant']:12} {r['bench']:13} {r['registers']:>4} {r['warps_per_sm']:>8} {str(r['spill_store_B'])+'/'+str(r['spill_load_B']):>14} "
                 f"{r['sum_median_span_s']:>7} {r['speed_vs_prod']:>6} {r['rows_identical']}\n")
print(open(os.path.join(sys.argv[1], "curve.txt")).read())
