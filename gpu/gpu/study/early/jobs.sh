#!/usr/bin/env bash
# Fork "early": run GPU jobs one after another, each its own gpulock hold (< 10 min), detached (setsid) so a SIGSTOP from
# prio.sh on the waiting flock does not end the queue. Usage: setsid nohup bash jobs.sh <job>... (jobs: bench3, cap10, bench10)
R=/home/jaxon/files/pogo-gbl-team-generator; E=$R/out/gpu/study/early; Q=$E/queue.log
hold() {  # hold <name> <cmd...>: wait for the lock (surviving SIGSTOP/SIGCONT), log times
  local name=$1; shift
  bash $R/out/gpu/study/gpulock.sh bash -c "echo \"$name got lock \$(TZ=America/New_York date +%T)\" >> $Q; $*; echo \"$name exit \$? \$(TZ=America/New_York date +%T)\" >> $Q" &
  local p=$!
  while kill -0 $p 2>/dev/null; do wait $p 2>/dev/null; sleep 1; done
}
for j in "$@"; do
  case $j in
    bench3) hold bench3 "cd $R/gpu && timeout 560 uv run python -m gpu.study.early.bench $E/cap-h3 --gens 1,2 --reps 3 > $E/cap-h3/bench.log 2>&1" ;;
    cap10) hold cap10 "cd $R && timeout 580 gpu/gpu/study/early/capture.sh cap-h3g10 3 10" ;;
    b2cap) hold b2cap "cd $R/gpu && timeout 200 uv run python -m gpu.study.early.bench2 $E/cap-h3 --gens 1,2 --reps 2 > $E/cap-h3/bench2.log 2>&1; echo bench2 rc \$? >> $Q; cd $R && timeout 360 gpu/gpu/study/early/capture.sh cap-h3g10 3 10" ;;
    b2g10) hold b2g10 "cd $R/gpu && timeout 560 uv run python -m gpu.study.early.bench2 $E/cap-h3g10 --gens 3,5,7 --reps 2 > $E/cap-h3g10/bench2.log 2>&1" ;;
    bench10) hold bench10 "cd $R/gpu && timeout 560 uv run python -m gpu.study.early.bench $E/cap-h3g10 --gens 3,5,7 --reps 2 > $E/cap-h3g10/bench.log 2>&1" ;;
  esac
done
echo "jobs done $(TZ=America/New_York date +%T)" >> $Q
