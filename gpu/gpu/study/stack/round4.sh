#!/usr/bin/env bash
# stack fork round 4: bench on the round-8 standard-command dump (out/gpu/study/occ/dump, read only), one hold < 10 min.
cd /home/jaxon/files/pogo-gbl-team-generator/gpu
O=../out/gpu/study/stack; G=../out/gpu/study/gpulock.sh
echo "start $(TZ=America/New_York date '+%F %T %Z')"
bash $G bash -c "echo \"hold \$(TZ=America/New_York date +%T)\"; nvidia-smi --query-compute-apps=pid,process_name --format=csv,noheader; \
  timeout 560 uv run python -m gpu.study.stack.bench --dump ../out/gpu/study/occ/dump --batches 0,3,4 --reps 3 \
  --configs prod,compact,compact2,compact+c0 --out $O/bench-r2.json > $O/bench-r2.out 2>&1; echo \"bench \$?\"; echo \"hold end \$(TZ=America/New_York date +%T)\""
echo "end $(TZ=America/New_York date '+%F %T %Z')"
