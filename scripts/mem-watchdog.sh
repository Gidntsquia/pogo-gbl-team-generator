#!/usr/bin/env bash
# Safety net for evolve.mjs runs on memory-constrained WSL boxes.
#
# evolve.mjs has no memory ceiling of its own -- a run that outgrows the
# machine just keeps allocating until the OS (or the WSL VM) falls over.
# That happened twice on this machine (2026-09-05, jaxon-s2-gen-1 attempts):
# `--threads 8` alone was not enough, because the growth came from the run's
# own working set outpacing this box's actual headroom (VSCode/extension
# hosts already claim ~2.8 GB before any run starts), not just from worker
# thread count.
#
# This script watches system available memory (not just the target
# process's RSS, since swap/cache pressure hits everything on the box) and
# sends SIGTERM to the run once it drops below --floor-mb for
# --consecutive checks in a row. evolve.mjs has no SIGTERM handler of its
# own, so this just kills the process (default signal disposition) --
# whatever generation was in flight is lost, but checkpoints already
# durably on disk survive (writeCheckpoint writes to a temp file and
# renames it into place, so a kill mid-write can never leave a truncated,
# silently-discarded checkpoint). The run can be resumed later at a
# smaller grid or lower thread count, restarting from its last completed
# generation, instead of taking the whole VM down.
#
# Usage:
#   scripts/mem-watchdog.sh <pid> <label> [--floor-mb N] [--interval S] [--consecutive N]
#
# Defaults: --floor-mb 600, --interval 15, --consecutive 3 (i.e. ~45s of
# sustained low memory before acting -- long enough to ride out a normal
# generation-boundary GC pause, short enough to act well before swap thrash
# becomes a crash).
#
# Logs to out/evolve-<label>.watchdog.log. Exits on its own once the target
# pid is no longer running (whether it finished, was killed by this script,
# or stopped for any other reason) -- nothing to clean up by hand.
set -euo pipefail

pid="${1:?usage: mem-watchdog.sh <pid> <label> [--floor-mb N] [--interval S] [--consecutive N]}"
label="${2:?usage: mem-watchdog.sh <pid> <label> [--floor-mb N] [--interval S] [--consecutive N]}"
shift 2

floor_mb=600
interval=15
consecutive=3
while [ $# -gt 0 ]; do
  case "$1" in
    --floor-mb) floor_mb="$2"; shift 2 ;;
    --interval) interval="$2"; shift 2 ;;
    --consecutive) consecutive="$2"; shift 2 ;;
    *) echo "mem-watchdog: unknown arg $1" >&2; exit 2 ;;
  esac
done

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log="$repo/out/evolve-${label}.watchdog.log"
mkdir -p "$repo/out"

echo "$(date -Iseconds) watchdog: watching pid $pid, floor ${floor_mb}MB available, ${consecutive}x${interval}s" >> "$log"

low_streak=0
while kill -0 "$pid" 2>/dev/null; do
  sleep "$interval"
  kill -0 "$pid" 2>/dev/null || break
  available="$(awk '/^Mem:/{print $7}' <(free -m))"
  if [ -z "$available" ]; then continue; fi
  if [ "$available" -lt "$floor_mb" ]; then
    low_streak=$((low_streak + 1))
    echo "$(date -Iseconds) watchdog: available ${available}MB < floor ${floor_mb}MB (streak $low_streak/$consecutive)" >> "$log"
  else
    low_streak=0
  fi
  if [ "$low_streak" -ge "$consecutive" ]; then
    echo "$(date -Iseconds) watchdog: sending SIGTERM to $pid (sustained low memory)" >> "$log"
    kill "$pid" 2>/dev/null || true
    echo "$(date -Iseconds) watchdog: stopped run '$label' -- resume from its last checkpoint after reducing population/opponents-per-gen or --threads" >> "$log"
    exit 0
  fi
done

echo "$(date -Iseconds) watchdog: pid $pid no longer running, exiting" >> "$log"
