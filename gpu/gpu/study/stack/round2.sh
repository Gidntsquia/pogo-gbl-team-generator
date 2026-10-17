#!/usr/bin/env bash
# stack fork round 2: each step its own GPU-lock hold (< 10 min) via gpulock.sh. Run detached (setsid), since
# prio.sh pauses waiting flock processes. Step 1 compiles the compact kernel (CuPy caches it on disk for the later steps).
cd /home/jaxon/files/pogo-gbl-team-generator/gpu
O=../out/gpu/study/stack; G=../out/gpu/study/gpulock.sh
t() { TZ=America/New_York date '+%F %T %Z'; }
echo "start $(t)"
bash $G bash -c "echo 'hold1 $(t)'; timeout 540 uv run python -m gpu.study.stack.sizes --variant --out $O/sizes-compact.json > $O/sizes-compact.out 2>&1; echo \"sizes compact \$?\""
grep -q '"B3"' $O/sizes-compact.json 2>/dev/null || { echo "compact did not compile $(t)"; echo "end $(t)"; exit 1; }
echo "verify wait $(t)"
bash $G bash -c "timeout 540 env POGO_GPU_STUDY=stack uv run python -m gpu.verify_3v3 > $O/verify3v3.log 2>&1; echo \"verify \$?\""
echo "bench wait $(t)"
bash $G bash -c "timeout 540 uv run python -m gpu.study.stack.bench --dump ../out/gpu/dump-prof0 --batches 0,1,4 --reps 3 \
  --configs prod,compact,prod+c100,compact+c0 --out $O/bench-r1.json > $O/bench-r1.out 2>&1; echo \"bench \$?\""
echo "end $(t)"
