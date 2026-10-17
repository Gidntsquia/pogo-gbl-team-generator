#!/usr/bin/env bash
# prof fork GPU job 2 (under the study GPU lock): Nsight Systems CUDA trace of the production replays, then solo replays.
set -u
cd /home/jaxon/files/pogo-gbl-team-generator/gpu
O=../out/gpu/study/prof
D=$O/dump
L=$O/jobs2.log
N=/home/jaxon/.local/nsight/nsysroot/opt/nvidia/nsight-systems/2025.5.2/target-linux-x64/nsys
mkdir -p $O/nsys
echo "jobs2 start $(date '+%F %T %Z')" >> $L
for x in "5k 7" "10k 6" "36k 0+1+2"; do set -- $x
  timeout 600 $N profile -t cuda,osrt -s none --cpuctxsw=none -f true -o $O/nsys/$1 \
    uv run python -m gpu.study.prof.replay launch --dump $D --spec $2 --name nsys-$1 --reps 2 --outdir $O/nsys >> $L 2>&1
  $N stats --report cuda_gpu_trace,cuda_api_sum --format csv -o $O/nsys/$1 --force-export=true $O/nsys/$1.nsys-rep >> $L 2>&1
done
echo "nsys done $(date '+%F %T %Z')" >> $L
# SASS static counts (rerun: the earlier try timed out waiting on the lock)
T=/home/jaxon/files/pogo-gbl-team-generator/out/gpu/study/prof/tools/venv/lib/python3.12/site-packages/nvidia/cu13/bin
timeout 300 uv run python -m gpu.study.prof.sass $O/sass "$T" >> $L 2>&1
echo "sass rc=$? $(date '+%F %T %Z')" >> $L
# NVBit try (route b): opcode histogram of the 64-battle warm-up launch only (KERNEL_END=1; the 5k launch after it runs uninstrumented); driver 610.47 is newer than NVBit 1.8.1 supports
NV=$O/tools/nvbit/tools/opcode_hist/build/opcode_hist.so
mkdir -p $O/nvbit
( export PATH=$T:$PATH; CUDA_INJECTION64_PATH=$NV LD_PRELOAD=$NV TOOL_VERBOSE=0 COUNT_WARP_LEVEL=1 KERNEL_BEGIN=0 KERNEL_END=1 \
  timeout 300 uv run python -m gpu.study.prof.replay launch --dump $D --spec 7 --name nvbit-5k --reps 1 --outdir $O/nvbit ) > $O/nvbit/nvbit-5k.log 2>&1
echo "nvbit rc=$? $(date '+%F %T %Z')" >> $L
echo "jobs2 all end $(date '+%F %T %Z')" >> $L
