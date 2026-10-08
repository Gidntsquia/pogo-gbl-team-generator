#!/usr/bin/env bash
# Chain three full evolve sims back to back, then score finalists against the curated 100 and write the report
# (plans/PLAN.md, 2026-10-04). Unattended; detaches itself.
#
#   scripts/recipe-ab-chain.sh [--smoke] [--fg]
#
# Real:  out/chain-recipe-ab.log, out/chain-recipe-ab.pid, out/recipe-ab/, out/recipe-ab.{md,html}
# Smoke: same under recipe-ab-smoke (tiny sizes, 3 generations; sim 1 is killed once to prove the relaunch path,
#        sim 2 is killed once and its relaunches are replaced by a failing stub so it is skipped after 3 failed relaunches).
set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

smoke=0; fg=0
for a in "$@"; do case "$a" in --smoke) smoke=1 ;; --fg) fg=1 ;; *) echo "usage: $0 [--smoke] [--fg]" >&2; exit 2 ;; esac; done
tag=recipe-ab; sflag=""
[ "$smoke" = 1 ] && { tag=recipe-ab-smoke; sflag="--smoke"; }
chainlog="out/chain-$tag.log"
pidfile="out/chain-$tag.pid"
state="out/$tag"

if [ "$fg" = 0 ]; then
  mkdir -p out "$state"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then echo "error: chain already running (pid $(cat "$pidfile"))" >&2; exit 2; fi
  setsid nohup "${BASH_SOURCE[0]}" $sflag --fg >> "$chainlog" 2>&1 < /dev/null &
  echo $! > "$pidfile"
  echo "[chain] launched detached, pid $(cat "$pidfile"), log $chainlog"
  exit 0
fi

mkdir -p out "$state"
log() { echo "[chain] $(date '+%Y-%m-%d %H:%M:%S %Z') $*"; }
now_ms() { echo $(( $(date +%s%N) / 1000000 )); }
MAX_RELAUNCH=3

log "chain start (mode: $tag, pid $$)"
if pgrep -f '^(/[^ ]*/)?node .*scripts/evolve\.mjs' > /dev/null; then log "REFUSING to start: another evolve.mjs process is alive"; exit 1; fi
bash scripts/setup.sh > /dev/null 2>&1 || { log "setup.sh failed"; exit 1; }
log "setup.sh done"

# Pre-launch check of all three sims before any real one starts.
for n in 1 2 3; do
  name="$(node scripts/recipe-ab-lib.mjs name $n $sflag)"
  args="$(node scripts/recipe-ab-lib.mjs args $n $sflag)"
  # shellcheck disable=SC2086
  if ! out="$(scripts/sim.sh --dry-run $args 2>&1)"; then log "pre-launch dry run failed for $name: $out"; exit 1; fi
  cmdline="$(printf '%s\n' "$out" | sed -n 's/^\[sim\] command: *//p')"
  log "recorded command ($name): $cmdline"
  # shellcheck disable=SC2086
  node scripts/recipe-ab-check.mjs "$n" $sflag -- ${cmdline#node scripts/evolve.mjs } || { log "pre-launch check MISMATCH for $name; stopping before any sim starts"; exit 1; }
done 2>&1 | while IFS= read -r l; do case "$l" in "[chain]"*) echo "$l" ;; *) log "$l" ;; esac; done
[ "${PIPESTATUS[0]}" = 0 ] || { log "pre-launch checks failed"; exit 1; }

launch() { # launch <n> <attempt>  -> starts sim detached via sim.sh
  local n="$1" attempt="$2" name args
  name="$(node scripts/recipe-ab-lib.mjs name $n $sflag)"
  if [ "$smoke" = 1 ] && [ "$n" = 2 ] && [ "$attempt" -ge 2 ]; then
    # fault injection: a stub standing in for a sim that keeps dying
    ( sleep 1; exit 1 ) &
    echo $! > "out/evolve-$name.pid"; echo "[stub] simulated failure" > "out/evolve-$name.log"
    return 0
  fi
  # shellcheck disable=SC2086
  scripts/sim.sh $(node scripts/recipe-ab-lib.mjs args $n $sflag) > "$state/sim-$n-launch.txt" 2>&1
}

record() { printf '{"sim":"%s","attempt":%s,"start":%s,"end":%s,"exit":%s}\n' "$1" "$2" "$3" "$4" "$5" >> "$state/attempts.jsonl"; }

run_sim() {
  local n="$1" name attempt=0 relaunches=0 pid start
  name="$(node scripts/recipe-ab-lib.mjs name $n $sflag)"
  if [ -f "out/evolve-$name/evolve-DONE" ]; then log "sim $n ($name): already finished (evolve-DONE); not re-running"; return 0; fi
  if [ -n "$(ls "out/evolve-$name" 2>/dev/null)" ]; then
    # partial run from an interrupted chain: resume it with the identical command (takes the relaunch path below)
    log "sim $n ($name): partial out dir found; resuming"
    attempt=1
  fi
  while :; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 1 ]; then
      mv "out/evolve-$name.log" "out/evolve-$name.log.$((attempt - 1))" 2>/dev/null
      log "sim $n ($name): relaunch $relaunches/$MAX_RELAUNCH with the identical command (earlier log kept as evolve-$name.log.$((attempt - 1)))"
    fi
    start=$(now_ms)
    launch "$n" "$attempt" || { log "sim $n ($name): sim.sh failed: $(tail -2 "$state/sim-$n-launch.txt")"; return 1; }
    pid="$(cat "out/evolve-$name.pid")"
    log "sim $n ($name): attempt $attempt started, pid $pid"
    if [ "$attempt" -gt 1 ]; then
      for _ in $(seq 1 120); do
        grep -q 'resuming -- \|starting fresh\|simulated failure' "out/evolve-$name.log" 2>/dev/null && break
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      if grep -q 'starting fresh' "out/evolve-$name.log" 2>/dev/null; then
        log "sim $n ($name): relaunch logged 'starting fresh' -- FAILURE, not retried"
        kill "$pid" 2>/dev/null
        record "$name" "$attempt" "$start" "$(now_ms)" 1
        return 1
      fi
      resume_line="$(grep -m1 'resuming -- ' "out/evolve-$name.log" 2>/dev/null || true)"
      [ -n "$resume_line" ] && log "sim $n ($name): $(printf '%s' "$resume_line" | sed 's/^evolve: //')"
    fi
    if [ "$smoke" = 1 ] && [ "$n" -le 2 ] && [ "$attempt" = 1 ]; then
      ( until [ -f "out/evolve-$name/evolve-gen$((n - 1)).json" ] || ! kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
        kill -9 "$pid" 2>/dev/null && echo "[chain] $(date '+%Y-%m-%d %H:%M:%S %Z') smoke: forced kill of sim $n (pid $pid) after its gen$((n - 1)) checkpoint" ) &
    fi
    while kill -0 "$pid" 2>/dev/null; do sleep 2; done
    if [ -f "out/evolve-$name/evolve-DONE" ]; then
      record "$name" "$attempt" "$start" "$(now_ms)" 0
      log "sim $n ($name): finished (evolve-DONE) after attempt $attempt"; return 0
    fi
    record "$name" "$attempt" "$start" "$(now_ms)" 1
    log "sim $n ($name): process exited WITHOUT evolve-DONE (attempt $attempt)"
    if [ "$relaunches" -ge "$MAX_RELAUNCH" ]; then log "sim $n ($name): $MAX_RELAUNCH relaunches failed; SKIPPING, going on to the next sim"; return 1; fi
    relaunches=$((relaunches + 1))
  done
}

for n in 1 2 3; do
  name="$(node scripts/recipe-ab-lib.mjs name $n $sflag)"
  log "sim $n ($name): starting"
  run_sim "$n" || log "sim $n ($name): INCOMPLETE"
done

log "scoring finalists against the curated 100"
node scripts/recipe-ab-score.mjs $sflag 2>&1 | sed 's/^/[score] /' || log "scoring failed"
node scripts/recipe-ab-report.mjs $sflag 2>&1 | sed 's/^/[report] /'
log "chain finished; report written to out/$tag.md and out/$tag.html"
