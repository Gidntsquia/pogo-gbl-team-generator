#!/usr/bin/env bash
# Round 9 R2/R3: Nsight Compute on one replayed launch, the metrics the study page uses, collected as small groups (one ncu run
# each, a few passes, up to NCU_TRIES tries) and merged by ncu_summary.py.
#
# Why groups: on this WSL2 box a long launch under ncu dies at a random pass with CUDA error 999 / LaunchFailed (2026-10-17:
# round 8's one-shot script died at pass 22 of the 10k launch, and later at passes 1-2; out/gpu/study/prof/ncu-r9*.log). A
# failed group is retried on its own instead of losing every pass. The SourceCounters section (SASS patching) is not asked for:
# nothing on the page reads it.
#
#   bash gpu/gpu/study/tail/ncu.sh <name> <python -m module and args...>
#   e.g. bash gpu/gpu/study/tail/ncu.sh 10k gpu.study.prof.replay launch --dump D --spec 6 --name ncu-10k --reps 1 --outdir O
# Writes out/gpu/study/prof/ncu/<name>.g<k>.{ncu-rep,csv} and <name>.stalls.csv. Env: NCU_ENV="VAR=val ..." for the replay,
# NCU_KERNEL (default battle3v3_slice), NCU_CLOCK (base), NCU_TRIES (4).
set -u
R=/home/jaxon/files/pogo-gbl-team-generator
NCU=/home/jaxon/.local/nsight/root/opt/nvidia/nsight-compute/2025.4.1/ncu
O=${NCU_OUT:-$R/out/gpu/study/prof/ncu}
mkdir -p "$O"
name=$1; shift
KERNEL=${NCU_KERNEL:-battle3v3_slice}
GROUPS_=(
  "--section WarpStateStats"
  "--metrics sm__warps_active.avg.pct_of_peak_sustained_active,sm__maximum_warps_per_active_cycle_pct,smsp__issue_active.avg.pct_of_peak_sustained_active,smsp__warps_eligible.avg.per_cycle_active,smsp__thread_inst_executed_per_inst_executed.ratio"
  "--metrics l1tex__t_bytes_pipe_lsu_mem_local_op_ld.sum,l1tex__t_bytes_pipe_lsu_mem_local_op_st.sum,l1tex__t_bytes_pipe_lsu_mem_global_op_ld.sum,l1tex__t_bytes_pipe_lsu_mem_global_op_st.sum"
  "--metrics l1tex__t_sector_hit_rate.pct,lts__t_sector_hit_rate.pct,l1tex__t_sector_pipe_lsu_mem_local_op_ld_hit_rate.pct,lts__t_bytes.sum,dram__bytes.sum"
  "--metrics sm__cycles_active.avg,sm__cycles_active.min,sm__cycles_active.max,sm__cycles_elapsed.avg,gpu__time_duration.sum"
)
cd "$R/gpu"
fail=0
for k in "${!GROUPS_[@]}"; do
  ok=0
  for try in $(seq 1 "${NCU_TRIES:-4}"); do
    # shellcheck disable=SC2086
    flock "$R/out/gpu/study/gpu.lock" env ${NCU_ENV:-} "$NCU" --target-processes all -k "$KERNEL" --launch-skip 1 --launch-count 1 \
      --replay-mode kernel --cache-control all --clock-control "${NCU_CLOCK:-base}" ${GROUPS_[$k]} \
      -f -o "$O/$name.g$k" uv run python -m "$@" > "$O/$name.g$k.log" 2>&1
    if ! grep -q "==ERROR==" "$O/$name.g$k.log" && [ -s "$O/$name.g$k.ncu-rep" ]; then ok=1; break; fi
    echo "ncu $name group $k try $try: $(grep -m1 -A0 'LaunchFailed\|ERR_\|==ERROR==' "$O/$name.g$k.log" || echo 'no report written (driver reset)')"
    sleep 5
  done
  if [ $ok = 1 ]; then
    "$NCU" --import "$O/$name.g$k.ncu-rep" --csv --page raw > "$O/$name.g$k.csv"
    [ "$k" = 0 ] && "$NCU" --import "$O/$name.g$k.ncu-rep" --csv --page details --section WarpStateStats > "$O/$name.stalls.csv"
    echo "ncu $name group $k ok (try $try)"
  else
    fail=1; echo "ncu $name group $k FAILED after ${NCU_TRIES:-4} tries"
  fi
done
exit $fail
