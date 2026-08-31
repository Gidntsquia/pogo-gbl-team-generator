#!/usr/bin/env bash
# Launch (or inspect) an evolve.mjs run with the settings real runs use.
#
# Wraps the recipe previously reassembled by hand each session: ensure
# vendor/pvpoke, echo the configuration, launch detached via nohup with the
# out/evolve-<name>{,.log,.pid} convention, and print how to monitor it.
#
# Usage:
#   scripts/sim.sh <collection.csv> [options] [-- extra evolve.mjs flags]
#   scripts/sim.sh status
#
# Options:
#   --name NAME       run name -> out/evolve-NAME/ (default: <csv-stem>-<HHMM>)
#   --ban a,b         species banned format-wide, both sides  (default: none)
#   --generations G   generation cap                          (default 100)
#   --population N    GA population                           (default 300)
#   --hours H         wall-clock budget -> --deadline-minutes (default: none)
#   --threads N       worker threads (default: evolve.mjs's cpus-1)
#   --fg              run in the foreground instead of detaching
#   --dry-run         print the evolve.mjs command and exit
#   --help            this text
#
# Anything after `--` (or any flag not listed above) goes straight to
# evolve.mjs. Defaults follow the established run recipe:
#   --opponents-per-gen 120 --pool 70 --elites 12 --seed <name>
#
# When a run finishes (evolve-DONE marker in its out dir), reports land in
# out/evolve-<name>/my-teams-evolve.{md,html}; render the race chart with
#   node scripts/chart-top-teams.mjs out/evolve-<name>
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

usage() { sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

status() {
  shopt -s nullglob
  local found=0
  for pidfile in out/evolve-*.pid; do
    found=1
    local name log dir pid state gen
    name="$(basename "$pidfile" .pid)"
    log="out/${name}.log"
    dir="out/${name}"
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then state="RUNNING (pid $pid)"
    elif [ -f "$dir/evolve-DONE" ]; then state="DONE"
    else state="STOPPED (no evolve-DONE marker)"; fi
    gen="$(printf '%s\n' "$dir"/evolve-gen*.json | grep -o 'gen[0-9]*' | sed 's/gen//' | sort -n | tail -1 || true)"
    echo "$name: $state${gen:+, checkpoint gen $gen}"
    [ -f "$log" ] && tail -1 "$log" | sed 's/^/  /'
  done
  [ "$found" = 1 ] || echo "no out/evolve-*.pid run markers found"
}

[ "${1:-}" = "status" ] && { status; exit 0; }

csv=""
name=""
ban=""
generations=100
population=300
hours=""
threads=""
fg=0
dryrun=0
passthrough=()
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --name) name="$2"; shift 2 ;;
    --ban) ban="$2"; shift 2 ;;
    --generations) generations="$2"; shift 2 ;;
    --population) population="$2"; shift 2 ;;
    --hours) hours="$2"; shift 2 ;;
    --threads) threads="$2"; shift 2 ;;
    --fg) fg=1; shift ;;
    --dry-run) dryrun=1; shift ;;
    --) shift; passthrough+=("$@"); break ;;
    --*) passthrough+=("$1"); shift ;;
    *)
      if [ -n "$csv" ]; then passthrough+=("$1"); shift; else csv="$1"; shift; fi ;;
  esac
done

if [ -z "$csv" ]; then usage; exit 2; fi
if [ ! -f "$csv" ]; then echo "error: collection not found: $csv" >&2; exit 2; fi

if [ ! -d vendor/pvpoke ]; then
  echo "[sim] vendor/pvpoke missing -- running scripts/setup.sh"
  bash scripts/setup.sh
fi

if [ -z "$name" ]; then
  name="$(basename "$csv" .csv | sed 's/-gl-collection//;s/-collection//')-$(date +%H%M)"
fi
outdir="out/evolve-${name}"
log="out/evolve-${name}.log"
pidfile="out/evolve-${name}.pid"
if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
  echo "error: run '$name' is already in progress (pid $(cat "$pidfile"))" >&2
  exit 2
fi

cmd=(node scripts/evolve.mjs "$csv"
  --population "$population" --opponents-per-gen 120 --generations "$generations"
  --pool 70 --elites 12 --seed "$name" --out-dir "$outdir")
[ -n "$ban" ] && cmd+=(--ban "$ban")
[ -n "$threads" ] && cmd+=(--threads "$threads")
[ -n "$hours" ] && cmd+=(--deadline-minutes "$(awk "BEGIN{printf \"%d\", $hours*60}")")
cmd+=(${passthrough[@]+"${passthrough[@]}"})

echo "[sim] run:         $name"
echo "[sim] collection:  $csv"
echo "[sim] generations: $generations, population: $population"
echo "[sim] banned:      ${ban:-none}"
budget="${hours:+${hours}h}"
echo "[sim] budget:      ${budget:-none}"
echo "[sim] command:     ${cmd[*]}"

[ "$dryrun" = 1 ] && exit 0

if [ "$fg" = 1 ]; then
  "${cmd[@]}"
else
  nohup "${cmd[@]}" > "$log" 2>&1 &
  echo $! > "$pidfile"
  echo "[sim] launched pid $(cat "$pidfile")"
  echo "[sim] monitor:  tail -f $log   (or: scripts/sim.sh status)"
  echo "[sim] finished when $outdir/evolve-DONE exists; reports in $outdir/"
fi
