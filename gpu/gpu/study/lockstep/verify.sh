#!/usr/bin/env bash
# lockstep fork verify hold: run as  bash out/gpu/study/gpulock.sh bash gpu/gpu/study/lockstep/verify.sh  (variant defaults: T=32, spread auto)
cd /home/jaxon/files/pogo-gbl-team-generator/gpu
(date '+start %F %T %Z'; POGO_GPU_STUDY=lockstep timeout 570 uv run python -m gpu.verify_3v3; echo "exit $?"; date '+end %F %T %Z') > ../out/gpu/study/lockstep/verify3v3.log 2>&1
