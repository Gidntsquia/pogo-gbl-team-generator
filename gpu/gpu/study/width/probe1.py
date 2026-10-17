"""Time one dumped launch once per width, printing as it goes (diagnose slow big launches): python -m gpu.study.width.probe1 <dump> <batch> [G,...]"""
import sys
import time

from gpu import kernel3v3 as K
from gpu.study.width.calib import batch_sizes, load_one, static_of, replay

d, k = sys.argv[1], int(sys.argv[2])
ws = [int(x) for x in sys.argv[3].split(",")] if len(sys.argv) > 3 else [1, 2, 4, 8, 16, 32]
f, n = batch_sizes(d)[k]
st, sl = static_of(d), load_one(f, n)
print(f"{f} n={n}", flush=True)
for G in ws:
    t = time.time()
    _, span, wall, _ = replay(K, st, sl, G)
    print(f"G={G} span {span:.1f}s wall {wall:.1f}s b/s {n / span:.0f}", flush=True)
