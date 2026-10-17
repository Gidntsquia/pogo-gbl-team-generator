#!/usr/bin/env bash
# stack fork round 1, one GPU-lock hold (<15 min): sizes (production + compact), verify_3v3 on the compact variant, bench.
cd /home/jaxon/files/pogo-gbl-team-generator/gpu
O=../out/gpu/study/stack
echo "start $(date '+%F %T %Z')"
timeout 120 uv run python -m gpu.study.stack.sizes --out $O/sizes-production.json > $O/sizes-production.out 2>&1; echo "sizes prod $?"
timeout 120 uv run python -m gpu.study.stack.sizes --variant --out $O/sizes-compact.json > $O/sizes-compact.out 2>&1; echo "sizes compact $?"
grep -q '"B3"' $O/sizes-compact.json || { echo "compact did not compile"; exit 1; }
timeout 300 env POGO_GPU_STUDY=stack uv run python -m gpu.verify_3v3 > $O/verify3v3.log 2>&1; echo "verify $?"
timeout 420 uv run python -m gpu.study.stack.bench --dump ../out/gpu/dump-prof0 --batches 0,1,4 --reps 3 \
  --configs prod,compact,prod+c100,compact+c0 --out $O/bench-r1.json > $O/bench-r1.out 2>&1; echo "bench $?"
echo "end $(date '+%F %T %Z')"
