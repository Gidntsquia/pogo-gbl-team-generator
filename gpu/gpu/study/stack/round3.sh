#!/usr/bin/env bash
# stack fork round 3 (verify already passed as chain stage 17): sizes of compact / compact2, then the bench, each step
# its own GPU-lock hold (< 10 min) via gpulock.sh. Run detached (setsid): prio.sh pauses waiting flock processes.
cd /home/jaxon/files/pogo-gbl-team-generator/gpu
O=../out/gpu/study/stack; G=../out/gpu/study/gpulock.sh
t() { TZ=America/New_York date '+%F %T %Z'; }
echo "start $(t)"
bash $G bash -c "date '+hold1 %T'; timeout 300 uv run python -m gpu.study.stack.sizes --variant --out $O/sizes-compact.json > $O/sizes-compact.out 2>&1; echo \"sizes compact \$?\"; \
  timeout 280 env POGO_GPU_STACK_SRC=compact2 uv run python -m gpu.study.stack.sizes --variant --out $O/sizes-compact2.json > $O/sizes-compact2.out 2>&1; echo \"sizes compact2 \$?\"; date '+hold1 end %T'"
echo "bench wait $(t)"
bash $G bash -c "date '+hold2 %T'; timeout 570 uv run python -m gpu.study.stack.bench --dump ../out/gpu/dump-prof0 --batches 0,1,4 --reps 3 \
  --configs prod,compact,compact2,compact+c0 --out $O/bench-r1.json > $O/bench-r1.out 2>&1; echo \"bench \$?\"; date '+hold2 end %T'"
echo "end $(t)"
