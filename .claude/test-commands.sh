# The four test commands, in one place so the guard hook and CLAUDE.md cannot
# drift apart. Sourced by .claude/hooks/full-suite-guard.sh.
#
# FILE_CMD deliberately calls `node --test` rather than scripts/tests.mjs: it
# bypasses the tier filter, so naming an @slow file actually runs it instead of
# handing back a false green.
FILE_CMD="node --test test/<file>.test.js"
CHANGED_CMD="npm run test:changed"
FAST_CMD="npm test"
FULL_CMD="npm run test:full"

# `npm test` already runs the fast tier, so the bare alias is not a full run.
DEFAULT_IS_FAST=1
