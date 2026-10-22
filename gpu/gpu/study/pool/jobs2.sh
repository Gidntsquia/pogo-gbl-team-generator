#!/usr/bin/env bash
# pool fork: one GPU-lock hold for resources, verify_3v3 (variant on) and a second bench. Run under the GPU lock from repo root.
set -u
cd /home/jaxon/files/pogo-gbl-team-generator/gpu
O=../out/gpu/study/pool
uv run python -m gpu.study.pool.res > $O/res.json 2> $O/res.err
env POGO_GPU_STUDY=pool POGO_GPU_POOL_LOG=$PWD/$O/verify-pool.jsonl uv run python -m gpu.verify_3v3 > $O/verify3v3.log 2>&1
for q in ${QS:-768}; do
  timeout 400 uv run python -m gpu.study.pool.bench bench --q $q --repeat 2 --dump $O/dump --out $O/bench-q$q.json 2>&1 | grep -v "^gpu width" > $O/bench-q$q.log
done
