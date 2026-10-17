#!/usr/bin/env bash
# prof fork GPU job 4: NVBit opcode histogram of the 64-battle warm-up slice launch (kernel index 1; index 0 is slice_sizes).
set -u
cd /home/jaxon/files/pogo-gbl-team-generator/gpu
O=../out/gpu/study/prof
D=$O/dump
T=/home/jaxon/files/pogo-gbl-team-generator/out/gpu/study/prof/tools/venv/lib/python3.12/site-packages/nvidia/cu13/bin
NV=$O/tools/nvbit/tools/opcode_hist/build/opcode_hist.so
echo "jobs4 start $(date '+%F %T %Z')" >> $O/jobs4.log
( export PATH=$T:$PATH; CUDA_INJECTION64_PATH=$NV LD_PRELOAD=$NV TOOL_VERBOSE=0 COUNT_WARP_LEVEL=1 KERNEL_BEGIN=1 KERNEL_END=2 \
  timeout 480 uv run python -m gpu.study.prof.replay launch --dump $D --spec 7 --name nvbit-5k --reps 1 --outdir $O/nvbit ) > $O/nvbit/nvbit-5k-slice.log 2>&1
echo "nvbit rc=$? $(date '+%F %T %Z')" >> $O/jobs4.log
