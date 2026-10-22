#!/usr/bin/env bash
# Fork "early": one measurement run of the round-8 standard command (out/gpu/study/run10.sh's flags, same seed) with the
# capture hook (hook.mjs) and POGO_GPU_DUMP. usage: capture.sh <name> <halving-rounds> <gens>  -> out/gpu/study/early/<name>/
set -u
cd /home/jaxon/files/pogo-gbl-team-generator
name=$1; H=$2; GENS=$3
d=out/gpu/study/early/$name
rm -rf "$d"; mkdir -p "$d"
export POGO_COMMUNITY_FILE=data/archive/meta-teams-community-mega-great.json
export EARLY_CAP=$PWD/$d/cap POGO_GPU_DUMP=$PWD/$d/dump
export NODE_OPTIONS="--import $PWD/gpu/gpu/study/early/hook.mjs"
node scripts/evolve.mjs jaxon-gl-collection.csv --config /home/jaxon/files/pogo-gbl-team-generator/recipes/standard.json --population 300 --opponents-per-gen 120 --generations "$GENS" --cp 1500 --cup mega --seed recipe-ab-old-halving --out-dir "$d/run" --threads 8 --mutation-floor-start 0.15 --mutation-ceil-start 0.6 --config recipes/recipe-ab-old.json --seed recipe-ab --curated-ratio 0.66 --opponent-meta-pool 400 --archetype-beta 0.5 --opponent-strength-gamma 1 --similar-rivalry 1 --similar-floor 0.35 --population-final-ratio 0.4 --halving-rounds "$H" --gpu --out-dir "$d/run" > "$d/run.log" 2>&1
echo "exit $?" >> "$d/run.log"
