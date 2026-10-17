#!/usr/bin/env bash
# lockstep fork bench hold (<10 min): run as  bash out/gpu/study/gpulock.sh bash gpu/gpu/study/lockstep/bench1.sh
cd /home/jaxon/files/pogo-gbl-team-generator/gpu
O=../out/gpu/study/lockstep
date '+start %F %T %Z' > $O/bench1.time
timeout 540 uv run python -m gpu.study.lockstep.bench --dump ../out/gpu/study/prof/dump --batches 0,1,3,4 \
  --configs "T=16;T=32;T=64;T=128;T=64,spread=32;T=32,persist=1;T=64,persist=1;T=32,sync=4" --save $O/bench1.json > $O/bench1.log 2>&1
echo "exit $?" >> $O/bench1.time
date '+end %F %T %Z' >> $O/bench1.time
