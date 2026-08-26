#!/usr/bin/env bash
# PreToolUse(Bash) guard — the enforcement half of this skill's policy.
#
# A CLAUDE.md section asking the agent to run narrow tests is advisory: it
# competes with the model's own prior that running everything is the safe
# move, and it loses often enough that a tiered suite still gets exercised at
# full width after one-line edits. This hook makes the narrow run the only one
# that goes through without a deliberate override.
#
# Install: copied to <repo>/.claude/hooks/full-suite-guard.sh, registered as a
# PreToolUse hook with matcher "Bash" in <repo>/.claude/settings.json, and fed
# the four command strings from <repo>/.claude/test-commands.sh.
#
# Blocks (exit 2, stderr goes back to the agent): a test-runner invocation
# that names no path, no name filter, and no tier or changed-files flag.
# Always allows: anything prefixed TS_FULL=1, anything running measure.sh, and
# collect-only/list invocations, which don't execute tests.
#
# Bias: a false block costs one retry with TS_FULL=1; a false allow costs the
# five minutes this skill exists to save. Matching is anchored at the start of
# a command segment so prose mentioning a runner never trips it.
#
# LOCAL ADDITION (pogo-gbl-team-generator): this repo runs node:test through
# scripts/tests.mjs, which the stock guard does not know. `npm run test:full`
# slips past the generic `npm test` pattern because `test:full` is not the
# bare `test` script, so the union command -- the expensive one -- would go
# through unblocked. The `unionscript` and `nodetest` runners below close that.
set -uo pipefail

input=$(cat 2>/dev/null || true)
[ -n "$input" ] || exit 0

read_json() { printf '%s' "$input" | jq -r ".$1 // empty" 2>/dev/null; }
cmd=$(read_json 'tool_input.command')
[ -n "$cmd" ] || cmd=$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
[ -n "$cmd" ] || exit 0
sid=$(read_json 'session_id'); sid=${sid:-nosession}

FILE_CMD=""; CHANGED_CMD=""; FAST_CMD=""; FULL_CMD=""; DEFAULT_IS_FAST=0
for f in .claude/test-commands.sh "$(dirname "$0")/../test-commands.sh"; do
  # shellcheck disable=SC1090
  [ -f "$f" ] && . "$f" && break
done

has() { printf '%s' "$1" | grep -Eq "$2"; }
state="${TMPDIR:-/tmp}/ts-guard-$sid"

# Explicit override, this skill's own measurement harness, and non-executing
# collect/list passes all go through untouched.
if has "$cmd" '(^|[[:space:]])TS_FULL=1'; then printf 'x' >>"$state" 2>/dev/null; exit 0; fi
has "$cmd" 'measure\.sh' && exit 0
has "$cmd" '(--collect-only|--co[[:space:]]|--dry-run|--listTests|--list([[:space:]]|$)|-list[[:space:]]|--version|--help)' && exit 0

# A path or module argument. `./...` is Go for "everything" and is excluded on
# purpose; a bare `-` prefix means it is a flag, not a path.
PATHLIKE='(^|[[:space:]])[^-[:space:]][^[:space:]]*(\.(py|js|jsx|mjs|cjs|ts|tsx|rb|go|rs|java|kt)|::|/[^[:space:]]*)([[:space:]]|$)'
# Tested against the arguments only: the command word itself is often a path
# (`./gradlew`, `./scripts/test`) and that says nothing about run width.
pathlike() {
  local rest="${1#* }"; [ "$rest" = "$1" ] && rest=""
  has "$rest" "$PATHLIKE" && ! has "$rest" '\./\.\.\.'
}

# `-m ''` / `-m ""` is pytest for "cancel the tier filter" — that is the union
# command, the widest run there is, not a narrow one.
empty_filter() { has "$1" "(^|[[:space:]])-(m|k)[[:space:]]+(''|\"\")([[:space:]]|$)"; }

# Per-runner subset flags. Kept separate because the same letter means
# different things per runner: pytest -p loads a plugin, cargo -p picks a
# package, and treating them alike is how a full run slips past.
narrow() { # $1 = normalized segment, $2 = runner
  local s="$1" re=""
  case "$2" in
    pytest) re='-k|-m|--testmon|--picked|--lf|--last-failed|--ff|--failed-first|--deselect' ;;
    jest|vitest) re='-t|--testNamePattern|--testPathPattern|--testPathPatterns|--findRelatedTests|--onlyChanged|--changed|--changedSince|--selectProjects|--shard|--project|--related' ;;
    go) re='-run|-tags' ;;
    cargo) re='-E|--test|--lib|--bin|--package|-p|--filter-expr|--ignored' ;;
    rspec) re='-e|--example|-t|--tag|--only-failures|--next-failure|-P|--pattern' ;;
    gradle) re='--tests'; has "$s" '(^|[[:space:]]):[^[:space:]]+:' && return 0 ;;
    maven) re='-Dtest' ;;
    npmtest|maketest) re='--' ;;
    # The union command names every tier by definition, so no argument makes
    # it narrow -- refuse before the pathlike fallback sees `scripts/tests.mjs`
    # and mistakes the runner script itself for a test path.
    unionscript) return 1 ;;
    # Bare `node --test` walks the whole test dir; naming a file is the narrow
    # form, and is also the one form that never silently skips an @slow file.
    nodetest) re='--test-name-pattern' ;;
  esac
  empty_filter "$s" && return 1
  [ -n "$re" ] && has "$s" "(^|[[:space:]])($re)([[:space:]]|=|$)" && return 0
  pathlike "$s" && return 0
  return 1
}

# Which runner, if any, a segment executes. Anchored: the runner has to be the
# command being run, not a word appearing somewhere in it.
runner_in() {
  local s="$1"
  case "$s" in
    pytest|pytest\ *) echo pytest; return ;;
    jest|jest\ *) echo jest; return ;;
    vitest|vitest\ *) echo vitest; return ;;
    "go test"|"go test "*) echo go; return ;;
    "cargo test"|"cargo test "*|"cargo nextest run"|"cargo nextest run "*) echo cargo; return ;;
    rspec|rspec\ *) echo rspec; return ;;
    make\ test|make\ test\ *) echo maketest; return ;;
  esac
  # This repo's union command, in both the spellings that reach it. Checked
  # before the generic npm alias below, which only matches the bare `test`.
  has "$s" '^(npm|pnpm|yarn|bun)[[:space:]]+run[[:space:]]+test:full([[:space:]]|$)' && { echo unionscript; return; }
  has "$s" '^node[[:space:]]+scripts/tests\.mjs[[:space:]]+all([[:space:]]|$)' && { echo unionscript; return; }
  has "$s" '^node[[:space:]]+.*--test([[:space:]]|$)' && { echo nodetest; return; }
  has "$s" '^(\./)?gradlew?[[:space:]]+.*(test|check)([[:space:]]|$)' && { echo gradle; return; }
  has "$s" '^mvn[[:space:]]+.*(test|verify)([[:space:]]|$)' && { echo maven; return; }
  # Package-manager script aliases. Only the bare `test` script is the whole
  # suite; `test:fast`, `test:unit` and friends are already the narrow path.
  has "$s" '^(npm|pnpm|yarn|bun)[[:space:]]+(run[[:space:]]+)?test([[:space:]]|$)' && { echo npmtest; return; }
  echo ""
}

# Strip what wraps a command without changing what it runs, so the runner ends
# up at position 0: env assignments, `time`, and the launcher prefixes.
normalize() {
  printf '%s' "$1" \
    | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' \
    | sed -E 's/^(env[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*//' \
    | sed -E 's/^(time|command|nice([[:space:]]+-n[[:space:]]+[0-9]+)?)[[:space:]]+//' \
    | sed -E 's/^(npx|bunx)([[:space:]]+--no-install)?[[:space:]]+//' \
    | sed -E 's/^(yarn|pnpm|bun)([[:space:]]+(exec|dlx))?[[:space:]]+(jest|vitest|rspec)([[:space:]]|$)/\4 /' \
    | sed -E 's/^bundle[[:space:]]+exec[[:space:]]+//' \
    | sed -E 's/^(poetry|pipenv|uv|rye|hatch)[[:space:]]+run[[:space:]]+//' \
    | sed -E 's/^python[0-9.]*[[:space:]]+-m[[:space:]]+//' \
    | sed -E 's/[[:space:]]+$//'
}

blocked=""
while IFS= read -r seg; do
  seg=$(normalize "$seg")
  [ -n "$seg" ] || continue
  r=$(runner_in "$seg")
  [ -n "$r" ] || continue
  # The repo's default script was rewired to the fast tier, so the alias is fine.
  { [ "$r" = npmtest ] || [ "$r" = maketest ]; } && [ "$DEFAULT_IS_FAST" = 1 ] && continue
  narrow "$seg" "$r" && continue
  blocked="$seg"; break
done < <(printf '%s\n' "$cmd" | tr ';|&' '\n')

[ -n "$blocked" ] || exit 0

prior=0; [ -f "$state" ] && prior=$(wc -c 2>/dev/null <"$state" | tr -d ' ')
{
  echo "BLOCKED: that runs the whole test suite."
  echo "  $blocked"
  echo
  echo "Run the narrowest command that covers what you changed:"
  [ -n "$FILE_CMD" ]    && echo "  one file:      $FILE_CMD"
  [ -n "$CHANGED_CMD" ] && echo "  changed files: $CHANGED_CMD"
  [ -n "$FAST_CMD" ]    && echo "  fast tier:     $FAST_CMD"
  echo
  if [ "${prior:-0}" -gt 0 ] 2>/dev/null; then
    echo "The full suite has already run $prior time(s) this session. Having run it"
    echo "is a reason not to run it again, not a reason to be sure."
    echo
  fi
  echo "If you genuinely need the full suite — the user asked for it, you changed the"
  echo "runner config or a dependency, or you are about to push — re-run it as:"
  echo "  TS_FULL=1 ${FULL_CMD:-$blocked}"
  echo "CI and the pre-push hook run everything before anything merges."
} >&2
exit 2
