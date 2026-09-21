#!/usr/bin/env bash
# Launch (or inspect) an evolve.mjs run with the settings real runs use.
#
# Wraps the recipe previously reassembled by hand each session: check
# vendor/pvpoke exists, validate the flags, echo the configuration, launch detached via nohup with the
# out/evolve-<name>{,.log,.pid} convention, and print how to monitor it.
# Memory safety is the box's earlyoom (see RUNBOOK.md section 1): a run that
# outgrows the machine is SIGTERMed, the in-flight generation is lost, and
# checkpoints already on disk survive (writeCheckpoint writes atomically), so
# it resumes from its last completed generation.
#
# Usage:
#   scripts/sim.sh <collection.csv> [options] [-- extra evolve.mjs flags]
#   scripts/sim.sh --meta [options]          meta-vs-meta run (no collection)
#   scripts/sim.sh status
#
# Options:
#   --meta            meta-vs-meta: the collection is every species pvpoke
#                     ranks for the cap (scripts/build-meta-collection.mjs ->
#                     out/evolve-NAME/meta-collection-CP.csv, built once per
#                     run and reused on resume, IVs = pvpoke defaults),
#                     evolutions off (the rankings already list evolved
#                     forms), and BOTH species pools widened to --meta-pool so
#                     each side can field every relevant species
#   --meta-pool N     with --meta: --pool N --opponent-meta-pool N (default 400:
#                     pvpoke overall score >= ~78 at cp 1500; 0 = full field)
#   --cp N            CP cap (default 1500); with --meta also picks the collection
#   --cup NAME        pvpoke cup id (e.g. willpower; default: all/Great League);
#                     with --meta also picks the collection (meta-collection-CUP-CP.csv)
#   --name NAME       run name -> out/evolve-NAME/ (default: <csv-stem>-<HHMM>)
#   --ban a,b         species banned format-wide, both sides  (default: none)
#   --quick           a few-minute trial run: 3 generations, population 24, 12
#                     opponents, foreground (implies --fg; try it on
#                     fixtures/sample-pokegenie.csv)
#   --generations G   generation cap                          (default 100)
#   --population N    GA population                           (default 300)
#   --hours H         wall-clock budget -> --deadline-minutes (default: none)
#   --threads N       worker threads (default: evolve.mjs's cpus-1, capped at 8)
#   --profile         passthrough to evolve.mjs: per-worker CPU profile +
#                     scenario-memo hit/miss stats, flushed to out/evolve-NAME/
#                     on a clean exit (not a recognized flag here -- falls
#                     through to evolve.mjs via the generic passthrough)
#   --halving-rounds R  passthrough (+ --halving-keep F): Sequential Halving, default 3 (~1/2 the
#                     battles); `--halving-rounds 0` = full grid (see RUNBOOK.md)
#   --fg              run in the foreground instead of detaching
#   --dry-run         print the evolve.mjs command and exit
#   --help            this text
#
# Pre-baked start / "resume with different flags": --seed-from PATH is not a
# recognized flag here either -- it falls through to evolve.mjs, which loads
# generation 0's population + opponent pool from that checkpoint (another
# run's evolve-gen<N>.json) instead of sampling fresh. Give the new run its
# own --name (a fresh out dir) so it gets its own checkpoint chain rather than
# colliding with the source run's:
#   scripts/sim.sh --name my-run-v2 --population 400 -- --seed-from \
#     out/evolve-my-run/evolve-gen42.json my-collection.csv
#
# Sequential Halving is ON by default (R=3, ~1/2 the battles); `scripts/sim.sh ... -- --halving-rounds 0` turns it off.
# Part of the config: pass the same value on every resume; runs started before it became the default
# refuse to resume unless given `-- --halving-rounds 0`.
#
# Anything after `--` (or any flag not listed above) goes straight to
# evolve.mjs. Defaults follow the established run recipe, baked into
# recipes/standard.json (--config recipe, see evolve.mjs --help) and passed
# as --config recipes/standard.json --seed <name>:
#   opponents-per-gen 120, elites 15,
#   snowball-weight 0.2, closer-weight 0.1, consistency-weight 0.1, shared-weakness-weight 0.2
#   (--pool is left unset -- evolve.mjs's own default: no cap, whole deduped collection)
# A passthrough --config overrides recipes/standard.json entirely (evolve.mjs
# only accepts one --config), and any individual passthrough flag (e.g.
# --snowball-weight 0) overrides that one key from the recipe file.
# (--meta swaps the pool for --pool N --opponent-meta-pool N --no-evolutions,
#  and sets snowball 0.4 / closer 0.1 / consistency 0.2 / shared-weakness 0.2
#  identically on BOTH sides via the --opponent-*-weight flags)
#
# When a run finishes (evolve-DONE marker in its out dir), reports land in
# out/evolve-<name>/my-teams-evolve.{md,html}; render the race chart with
#   node scripts/chart-top-teams.mjs out/evolve-<name>
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

usage() { sed -n '2,47p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

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
meta=0
metapool=400
cp=1500
cup=all
generations=100
population=300
hours=""
threads=""
fg=0
quick=0
dryrun=0
passthrough=()
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --meta) meta=1; shift ;;
    --meta-pool) metapool="$2"; shift 2 ;;
    --cp) cp="$2"; shift 2 ;;
    --cup) cup="$2"; shift 2 ;;
    --name) name="$2"; shift 2 ;;
    --ban) ban="$2"; shift 2 ;;
    --generations) generations="$2"; shift 2 ;;
    --population) population="$2"; shift 2 ;;
    --hours) hours="$2"; shift 2 ;;
    --threads) threads="$2"; shift 2 ;;
    --quick) quick=1; shift ;;
    --fg) fg=1; shift ;;
    --dry-run) dryrun=1; shift ;;
    --) shift; passthrough+=("$@"); break ;;
    --*) passthrough+=("$1"); shift ;;
    *)
      if [ -n "$csv" ]; then passthrough+=("$1"); shift; else csv="$1"; shift; fi ;;
  esac
done

if [ "$meta" = 1 ]; then
  if [ -n "$csv" ]; then echo "error: --meta takes no collection (it builds its own)" >&2; exit 2; fi
  if [ -z "$name" ]; then
    if [ "$cup" = all ]; then name="meta-vs-meta-${cp}-$(date +%H%M)"
    else name="meta-vs-meta-${cup}-${cp}-$(date +%H%M)"
    fi
  fi
  # The collection is per run, never shared: candidate keys are speciesId#row,
  # so a run can only resume against the byte-identical CSV it started from,
  # and the rankings order (hence the rows) moves with every vendor pin bump.
  # Resuming (checkpoints already in the out dir) reuses the CSV the run
  # recorded instead of rebuilding -- the 2026-09-09 newseason-v3 resume
  # crashed because a rebuild after a pin bump re-numbered every row.
  if [ -f "out/evolve-${name}/evolve-gen0.json" ]; then
    csv="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).config.csvPath)' "out/evolve-${name}/evolve-gen0.json")"
    echo "[sim] resuming '$name': reusing its collection ($csv) instead of rebuilding"
  else
    if [ "$cup" = all ]; then csv="out/evolve-${name}/meta-collection-${cp}.csv"
    else csv="out/evolve-${name}/meta-collection-${cup}-${cp}.csv"
    fi
  fi
fi
if [ -z "$csv" ]; then
  echo "error: no collection CSV given" >&2
  echo "fix:   scripts/sim.sh <collection.csv> [options]   (try fixtures/sample-pokegenie.csv --quick; all options: --help)" >&2
  exit 2
fi

if [ ! -d vendor/pvpoke ]; then
  echo "error: vendor/pvpoke is missing (pvpoke's battle engine and data)" >&2
  echo "fix:   npm run setup   (or: bash scripts/setup.sh)" >&2
  exit 1
fi
if [ "$quick" = 1 ]; then
  generations=3
  population=24
  fg=1
  passthrough=(--opponents-per-gen 12 --elites 5 ${passthrough[@]+"${passthrough[@]}"})
fi
if [ "$meta" = 1 ] && [ ! -f "$csv" ]; then
  mkdir -p "$(dirname "$csv")"
  node scripts/build-meta-collection.mjs --cp "$cp" --cup "$cup" --out "$csv"
fi
if [ ! -f "$csv" ]; then
  echo "error: collection file not found: $csv" >&2
  echo "fix:   check the path; a sample collection is at fixtures/sample-pokegenie.csv" >&2
  exit 1
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
  --config "$repo/recipes/standard.json"
  --population "$population" --generations "$generations"
  --cp "$cp" --cup "$cup" --seed "$name" --out-dir "$outdir")
if [ "$meta" = 1 ]; then
  # --meta widens BOTH species pools to metapool; --pool is otherwise left
  # unset so evolve.mjs's own default (no cap, whole deduped collection) applies.
  # Both sides sample the same ranked field by pvpoke rank alone (1/(rank+20));
  # there is no 1v1 scoring in evolve runs. Real-collection runs (no --meta)
  # pool the player's mons and weight each by its own build's pvpoke rank.
  cmd+=(--pool "$metapool" --opponent-meta-pool "$metapool" --no-evolutions --meta-mode)
  # Both sides play the same game, so both get the same fitness weights.
  # Candidate-only bonus terms inflated candidate fitness ~5.5 pts over the
  # opponents' plain win rate in meta-vs-meta-retro-2 (2026-09-19).
  cmd+=(--snowball-weight 0.4 --closer-weight 0.1 --consistency-weight 0.2 --shared-weakness-weight 0.2
        --opponent-snowball-weight 0.4 --opponent-closer-weight 0.1 --opponent-consistency-weight 0.2 --opponent-shared-weakness-weight 0.2)
fi
[ -n "$ban" ] && cmd+=(--ban "$ban")
[ -n "$threads" ] && cmd+=(--threads "$threads")
[ -n "$hours" ] && cmd+=(--deadline-minutes "$(awk "BEGIN{printf \"%d\", $hours*60}")")
cmd+=(${passthrough[@]+"${passthrough[@]}"})

# Validate flags and inputs now, so a typo fails here instead of in a detached log.
"${cmd[@]}" --check > /dev/null

echo "[sim] run:         $name"
echo "[sim] collection:  $csv"
echo "[sim] cup:         $cup"
echo "[sim] generations: $generations, population: $population"
echo "[sim] banned:      ${ban:-none}"
[ "$meta" = 1 ] && echo "[sim] meta-vs-meta: cp $cp, both species pools = ${metapool} (0 = full field)"
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
