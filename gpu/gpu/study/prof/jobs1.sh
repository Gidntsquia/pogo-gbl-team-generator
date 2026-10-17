#!/usr/bin/env bash
# prof fork GPU job 1 (run under the study GPU lock): production replays (timing + segments) and the instrumented builds.
set -u
cd /home/jaxon/files/pogo-gbl-team-generator/gpu
O=../out/gpu/study/prof
D=$O/dump
L=$O/jobs1.log
echo "jobs1 start $(date '+%F %T %Z')" >> $L
for x in "5k 7" "10k 6" "36k 0+1+2" "18k 0"; do set -- $x
  timeout 600 uv run python -m gpu.study.prof.replay launch --dump $D --spec $2 --name $1 --reps 3 --outdir $O/replay >> $L 2>&1
done
echo "prod done $(date '+%F %T %Z')" >> $L
for x in "5k 7" "10k 6" "36k 0+1+2" "18k 0"; do set -- $x
  POGO_GPU_STUDY=prof POGO_GPU_PROF=sm timeout 600 uv run python -m gpu.study.prof.replay launch --dump $D --spec $2 --name $1 --reps 1 --outdir $O/replay >> $L 2>&1
done
echo "sm done $(date '+%F %T %Z')" >> $L
for x in "5k 7" "10k 6" "36k 0+1+2"; do set -- $x
  POGO_GPU_STUDY=prof POGO_GPU_PROF=lanes,time timeout 600 uv run python -m gpu.study.prof.replay launch --dump $D --spec $2 --name $1 --reps 1 --outdir $O/replay >> $L 2>&1
done
echo "jobs1 end $(date '+%F %T %Z')" >> $L
