# pogo-gbl-team-generator — conventions

Node ≥ 18, ESM (`"type": "module"`), plain modern JavaScript, no TypeScript, no build step. 2-space indent, small focused modules, JSDoc on exported functions.

**Fresh clone / start of every scheduled run:** `bash scripts/setup.sh` FIRST — `vendor/pvpoke` is gitignored and absent until it runs. Work queue: GOALS.md (rules in its header). Run log: PROGRESS.md (append-only). Why + backlog: ROADMAP.md. Design: PLAN.md (Rev 2 = current).

- Tests: `npm test` (fast tier) while working, `npm run test:full` before a push. Only node's built-in `node:test` + `node:assert`. Full policy and the rest of the commands under **Tests** below.
- Dependencies: avoid adding npm deps unless clearly necessary; record any addition and why in your report.
- `vendor/pvpoke` is a pinned read-only sparse clone (gitignored). Load/execute its code and data; never edit it, never reimplement its battle math. Need a path not checked out? `git -C vendor/pvpoke sparse-checkout add <path>`.
- Interfaces between modules are defined in PLAN.md — follow them exactly; if one proves wrong, say so in your report rather than silently changing it.
- Workers: do NOT `git commit` (the orchestrator commits); keep your diff inside the files your packet owns.
- Output artifacts (reports, caches) go in `out/` (gitignored).

## Tests

**Run the smallest thing that can fail.** After a change, run the tests for
what you changed — `node --test test/<file>.test.js`, or `npm run test:changed`.
Run `npm test` (fast tier) only when the change reaches past its own module.
`npm run test:full` is for immediately before a push, not after every edit:
it costs minutes, it tells you nothing the targeted run didn't, and running it
on a loop is how an afternoon disappears.

Runtime is part of the cost of a test. Before adding one, check that it earns its place.

- One test per behavior, not per branch of the same code path. Tests differing only in an input literal should be one parameterized test.
- Don't test framework, standard library, or ORM behavior.
- Don't add characterization tests for code written in the same change.
- Search the suite for existing coverage before adding a test.
- New tests run in under 100ms unless tagged slow or integration. Anything touching network, disk, or a real database gets the tag.
- Fake clock over sleeping. Stub over live service. Fixtures get the widest scope that's still correct.
- Deleting a test that no longer earns its runtime is a normal part of a change — do it, and say so in the summary.

The tier is a marker, not a list: a file is slow when its header comment contains `@slow`, and `scripts/tests.mjs` reads that and nothing else. `grep -l @slow test/` answers "what does `npm test` skip?".

Commands:
- Full suite (the union — required before a push): `npm run test:full`
- Fast tier (default while developing): `npm test`
- Changed files only: `npm run test:changed`
- Slow tier alone: `npm run test:slow`
- One packet: `node --test test/<file>.test.js`
