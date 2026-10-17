#!/usr/bin/env bash
# lockstep fork bench hold (<10 min): run as  bash out/gpu/study/gpulock.sh bash gpu/gpu/study/lockstep/bench2.sh
cd /home/jaxon/files/pogo-gbl-team-generator/gpu
O=../out/gpu/study/lockstep
date '+start %F %T %Z' > $O/bench2.time
timeout 540 uv run python -m gpu.study.lockstep.bench --dump ../out/gpu/study/prof/dump --batches 0,1,3,4 \
  --configs "T=32;T=128;T=32,persist=1;T=128,persist=1;T=32,sync=4" --save $O/bench2.json > $O/bench2.log 2>&1
echo "exit $?" >> $O/bench2.time
date '+end %F %T %Z' >> $O/bench2.time
