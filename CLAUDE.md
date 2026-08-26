# pogo-gbl-team-generator — conventions

Node ≥ 18, ESM (`"type": "module"`), plain modern JavaScript, no TypeScript, no build step. 2-space indent, small focused modules, JSDoc on exported functions.

**Fresh clone / start of every scheduled run:** `bash scripts/setup.sh` FIRST — `vendor/pvpoke` is gitignored and absent until it runs.

- Tests: `npm test` (fast tier) while working, `npm run test:full` before a push. Only node's built-in `node:test` + `node:assert`. Full policy and the rest of the commands under **Tests** below.
- Dependencies: avoid adding npm deps unless clearly necessary; record any addition and why in your report.
- `vendor/pvpoke` is a pinned read-only sparse clone (gitignored). Load/execute its code and data; never edit it, never reimplement its battle math. Need a path not checked out? `git -C vendor/pvpoke sparse-checkout add <path>`.
- Module interfaces are documented in the JSDoc on each exported function, and README.md explains how the pieces fit — follow them exactly; if one proves wrong, say so in your report rather than silently changing it.
- Workers: do NOT `git commit` (the orchestrator commits); keep your diff inside the files your task owns.
- Output artifacts (reports, caches) go in `out/` (gitignored).

## Tests

### What to run, and when

**Run the smallest thing that can fail.**

| what you changed | what to run |
|---|---|
| a doc, comment, or log string | nothing |
| one module | its test: `node --test test/<file>.test.js` |
| a few files inside one area | `npm run test:changed` |
| something several modules import — scoring, engine, a shared fixture | `npm test` (fast tier) |
| `package.json`, `scripts/tests.mjs`, the `vendor/pvpoke` pin, a dependency | `npm run test:full` |
| nothing — you are about to push | `npm run test:full` |

`npm run test:full` costs minutes, tells you nothing the targeted run didn't, and
running it on a loop is how an afternoon disappears.

These override the table:

- **A small change gets a small run.** Running the full suite to check a
  one-line edit isn't caution, it's this section being ignored. If you can name
  the file you changed, you can name the test that covers it.
- **After a failure, re-run that test file, not the suite.** Widen only once
  it's green, and only one row at a time.
- **At most one full-suite run per session**, at the end. Having already run it
  is a reason not to run it again, not a reason to be sure.
- **The push is the gate, not the edit.** The closing `npm run test:full` is
  yours to run and is not optional — foreground, with a
  300000–600000 ms timeout. Nothing else will catch what it catches. That is
  exactly why it belongs once at the end and not after every edit.
- **Don't run tests to prove unrelated code still works.** That is what the
  tier is for.

A `PreToolUse` hook (`.claude/hooks/full-suite-guard.sh`) blocks whole-suite
commands and prints the narrow one to run instead. When you see `BLOCKED:`, run
what it suggests. `TS_FULL=1 npm run test:full` overrides it and exists for the
two cases in the table above — you changed the runner config or a dependency, or
you are about to push — plus the case where the user asked for it directly. It is
not the way past a block you'd rather not think about. The four command strings
live in `.claude/test-commands.sh`, which is where the hook reads them from; edit
that file and this section together or they drift.

If you genuinely can't tell which test covers a change, run `npm run test:changed`
— not the full suite.

The tier is a marker, not a list: a file is slow when its header comment contains `@slow`, and `scripts/tests.mjs` reads that and nothing else. `grep -l @slow test/` answers "what does `npm test` skip?".

`node --test test/<file>.test.js` bypasses `scripts/tests.mjs` entirely, so it
runs an `@slow` file too when you name it. That is deliberate — it is the one
form that never silently skips.

Commands:
- One file: `node --test test/<file>.test.js`
- Changed files only: `npm run test:changed`
- Fast tier (default while developing): `npm test`
- Slow tier alone: `npm run test:slow`
- Full suite (the union — required before a push): `npm run test:full`

### Before adding a test

Runtime is part of the cost of a test. Before adding one, check that it earns its place.

- One test per behavior, not per branch of the same code path. Tests differing only in an input literal should be one parameterized test.
- Don't test framework, standard library, or ORM behavior.
- Don't add characterization tests for code written in the same change.
- Search the suite for existing coverage before adding a test.
- New tests run in under 100ms unless tagged slow or integration. Anything touching network, disk, or a real database gets the tag.
- Fake clock over sleeping. Stub over live service. Fixtures get the widest scope that's still correct.
- Deleting a test that no longer earns its runtime is a normal part of a change — do it, and say so in the summary.
