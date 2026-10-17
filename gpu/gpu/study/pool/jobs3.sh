#!/usr/bin/env bash
# pool fork: stack-limit benches on launches with no re-runs (1,3,4). Run under the GPU lock.
set -u
cd /home/jaxon/files/pogo-gbl-team-generator/gpu
O=../out/gpu/study/pool
echo "jobs3 start $(date)"
timeout 300 uv run python -m gpu.study.pool.bench bench --q 2048 --stack 40960 --launches 1,3,4 --dump $O/dump --out $O/bench-q2048-s40960.json > $O/bench-q2048-s40960.log 2>&1
timeout 300 uv run python -m gpu.study.pool.bench bench --q 768 --stack 24576 --launches 1,3,4 --dump $O/dump --out $O/bench-q768-s24576.json > $O/bench-q768-s24576.log 2>&1
echo "jobs3 end $(date)"
