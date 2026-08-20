#!/usr/bin/env bash
# Recreates vendor/pvpoke: a pinned, shallow, sparse clone of pvpoke's
# battle engine (src/js) and data (src/data) only -- no PHP backend, no
# images, no full git history. vendor/ is gitignored; this script is the
# only way to (re)materialize it.
#
# Safe to re-run: fixes an existing checkout in place (sparse paths, pinned
# commit) rather than always re-cloning from scratch.
#
# Usage: bash scripts/setup.sh   (or: npm run setup)

set -euo pipefail

REPO_URL="https://github.com/pvpoke/pvpoke.git"
PINNED_COMMIT="ea601f0a61c548f9140e4605b94a31fa97fe6aba"
SPARSE_PATHS=(src/js src/data)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Overridable only for this script's own self-test; the real target is
# always vendor/pvpoke under the repo root.
VENDOR_DIR="${PVPOKE_VENDOR_DIR:-$REPO_ROOT/vendor/pvpoke}"

mkdir -p "$(dirname "$VENDOR_DIR")"

if [ ! -d "$VENDOR_DIR/.git" ]; then
  echo "==> Cloning pvpoke (shallow, sparse, blob:none) into $VENDOR_DIR"
  git clone --depth 1 --filter=blob:none --sparse "$REPO_URL" "$VENDOR_DIR"
fi

echo "==> Setting sparse-checkout paths: ${SPARSE_PATHS[*]}"
git -C "$VENDOR_DIR" sparse-checkout set "${SPARSE_PATHS[@]}"

CURRENT_COMMIT="$(git -C "$VENDOR_DIR" rev-parse HEAD 2>/dev/null || echo "")"

if [ "$CURRENT_COMMIT" != "$PINNED_COMMIT" ]; then
  echo "==> HEAD ($CURRENT_COMMIT) is not the pinned commit ($PINNED_COMMIT); fetching it"
  # GitHub serves arbitrary commit SHAs directly (not just branch tips), so
  # this lands on the pin even if it's since been superseded on master --
  # no need to unshallow / fetch full history to get there.
  git -C "$VENDOR_DIR" fetch --depth 1 origin "$PINNED_COMMIT"
  git -C "$VENDOR_DIR" checkout --detach "$PINNED_COMMIT"
else
  echo "==> Already at pinned commit ($PINNED_COMMIT)"
fi

FINAL_COMMIT="$(git -C "$VENDOR_DIR" rev-parse HEAD)"
if [ "$FINAL_COMMIT" != "$PINNED_COMMIT" ]; then
  echo "==> ERROR: expected HEAD to be $PINNED_COMMIT, got $FINAL_COMMIT" >&2
  exit 1
fi

echo "==> Verifying required engine/data files are present"
REQUIRED_FILES=(
  "src/js/battle/Battle.js"
  "src/js/battle/DamageCalculator.js"
  "src/js/battle/actions/ActionLogic.js"
  "src/js/battle/timeline/TimelineAction.js"
  "src/js/battle/timeline/TimelineEvent.js"
  "src/js/GameMaster.js"
  "src/js/pokemon/Pokemon.js"
  "src/data/gamemaster.json"
  "src/data/rankings/all/overall/rankings-1500.json"
)
missing=0
for f in "${REQUIRED_FILES[@]}"; do
  if [ ! -f "$VENDOR_DIR/$f" ]; then
    echo "    MISSING: $f"
    missing=1
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "==> Some files the engine harness needs are missing from the sparse checkout." >&2
  echo "    Add the missing path with: git -C \"$VENDOR_DIR\" sparse-checkout add <path>" >&2
  exit 1
fi

echo "==> vendor/pvpoke ready at $FINAL_COMMIT"
