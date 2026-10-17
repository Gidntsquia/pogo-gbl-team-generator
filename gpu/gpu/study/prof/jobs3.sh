#!/usr/bin/env bash
# prof fork GPU job 3 (under the study GPU lock, after jobs1): the 10 longest battles of each launch replayed alone.
set -u
cd /home/jaxon/files/pogo-gbl-team-generator/gpu
O=../out/gpu/study/prof
D=$O/dump
L=$O/jobs3.log
echo "jobs3 start $(date '+%F %T %Z')" >> $L
for x in "5k 7" "10k 6" "36k 0+1+2"; do set -- $x
  timeout 600 uv run python -m gpu.study.prof.replay solo --dump $D --spec $2 --name $1 --top 10 --reps 2 --outdir $O/replay >> $L 2>&1
done
echo "jobs3 end $(date '+%F %T %Z')" >> $L
