#!/usr/bin/env bash
# Round 8 R8: one run of the round-7 halving-3 pop-1x command and seed (out/gpu/width/run20.sh), 10 generations by default.
# usage: run10.sh <name> [ENV=VAL ...]  -> out/evolve-gpu8-<name>/ and out/evolve-gpu8-<name>.log (ends "exit N")
# ENV: any POGO_GPU_* variable (e.g. POGO_GPU_STUDY=cap); GENS=N generations; CPU_SHARE=x passes --gpu-cpu-share x.
set -u
cd /home/jaxon/files/pogo-gbl-team-generator
name=$1; shift
dir=out/evolve-gpu8-prof-dump
export POGO_COMMUNITY_FILE=data/archive/meta-teams-community-mega-great.json
GENS=10; CPU_SHARE=""
for kv in "$@"; do
  case "$kv" in
    GENS=*) GENS=${kv#GENS=} ;;
    CPU_SHARE=*) CPU_SHARE=${kv#CPU_SHARE=} ;;
    POGO_GPU_*=*) export "$kv" ;;
    *) echo "run10: unsupported argument $kv" >&2; exit 2 ;;
  esac
done
extra=()
[ -n "$CPU_SHARE" ] && extra=(--gpu-cpu-share "$CPU_SHARE")
rm -rf "$dir"; mkdir -p "$dir"
echo "env: $* HALVING=3 POP=300 OPP=120 GENS=$GENS (POGO_COMMUNITY_FILE=$POGO_COMMUNITY_FILE)" > "$dir.log"
echo "wall start $(date +%s.%N)" >> "$dir.log"
node scripts/evolve.mjs jaxon-gl-collection.csv --config /home/jaxon/files/pogo-gbl-team-generator/recipes/standard.json --population 300 --opponents-per-gen 120 --generations "$GENS" --cp 1500 --cup mega --seed recipe-ab-old-halving --out-dir "$dir" --threads 8 --mutation-floor-start 0.15 --mutation-ceil-start 0.6 --config recipes/recipe-ab-old.json --seed recipe-ab --curated-ratio 0.66 --opponent-meta-pool 400 --archetype-beta 0.5 --opponent-strength-gamma 1 --similar-rivalry 1 --similar-floor 0.35 --population-final-ratio 0.4 --halving-rounds 3 --gpu "${extra[@]}" --out-dir "$dir" >> "$dir.log" 2>&1
rc=$?
echo "wall end $(date +%s.%N)" >> "$dir.log"
echo "exit $rc" >> "$dir.log"
exit $rc
