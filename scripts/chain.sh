#!/usr/bin/env bash
# Chain: meta-vs-meta run -> per-cup curated file -> standard run, detached, resumable.
#   scripts/chain.sh --name N --cup C <csv> [--meta-generations G] [--generations G] [--candidates 50]
#                    [--opponents 50] [--threads N] [--cpu-only] [--dry-run] [-- extra sim.sh flags]
# Details and state file format: scripts/chain.mjs. Log: out/chain-N.log, state: out/chain-N.json.
cd "$(dirname "${BASH_SOURCE[0]}")/.." && exec node scripts/chain.mjs "$@"
