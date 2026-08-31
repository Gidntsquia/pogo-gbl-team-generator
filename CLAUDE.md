# pogo-gbl-team-generator — conventions

Node ≥ 18, ESM (`"type": "module"`), plain modern JavaScript, no TypeScript, no build step. 2-space indent, small focused modules, JSDoc on exported functions.

**Fresh clone / start of every scheduled run:** `bash scripts/setup.sh` FIRST — `vendor/pvpoke` is gitignored and absent until it runs.

- Tests: `npm test` (fast tier, ~1s) while working, `npm run test:full` (~13s) before a push. Real battles run in `test/e2e.test.js` and nowhere else. Only node's built-in `node:test` + `node:assert`. Full policy and the rest of the commands under **Tests** below.
- Dependencies: avoid adding npm deps unless clearly necessary; record any addition and why in your report.
- `vendor/pvpoke` is a pinned read-only sparse clone (gitignored). Load/execute its code and data; never edit it, never reimplement its battle math. Need a path not checked out? `git -C vendor/pvpoke sparse-checkout add <path>`.
- Module interfaces are documented in the JSDoc on each exported function, and the GitHub wiki explains how the pieces fit — follow them exactly; if one proves wrong, say so in your report rather than silently changing it.
- Workers: do NOT `git commit` (the orchestrator commits); keep your diff inside the files your task owns.
- Output artifacts (reports, caches) go in `out/` (gitignored).

## Orientation — what this is and where things live

Feed in a Pokemon GO collection CSV, get back the best 3-mon GO Battle League
teams buildable from it, ranked by real 3v3 battles run through pvpoke's
vendored engine. The pipeline (wired end-to-end in `src/cli.js`):

**import CSV → 1v1-score to prune → sample candidate teams → 3v3-battle them
against a meta opponent pool → rank → report (`out/report.md` + `.html`)**

The GitHub wiki documents every feature in depth (flags, sampling weights, the
GA, cost math) — go there for behavior questions; the map below is for finding
code. README.md is only a short landing page. Fetch a wiki page raw with
`curl -s "https://raw.githubusercontent.com/wiki/Gidntsquia/pogo-gbl-team-generator/<Page>.md"`
(pages: Running-the-CLI, How-Scoring-Works, Build-Costs-and-Evolutions,
Evolutionary-Team-Search, Shared-Collections, Development-and-Tests), or clone
`https://github.com/Gidntsquia/pogo-gbl-team-generator.wiki.git`. The video
scanner (screen recording → collection CSV) lives in its own repo:
https://github.com/Gidntsquia/pokemon-go-video-to-csv.

### Entry points

| command | what it runs |
|---|---|
| `node src/cli.js <collection.csv>` | the main pipeline above (`--cp 2500` for Ultra League; `--help` for all flags) |
| `scripts/sim.sh <collection.csv>` | **preferred way to launch an evolve run** — wraps evolve.mjs with the established recipe (pop 300, 100 gens, opponents 120, pool 70, elites 12), `--ban a,b`, `--hours H` budget, detached nohup with `out/evolve-<name>{,.log,.pid}` naming; `scripts/sim.sh status` lists runs, live pids, and checkpoint progress. Compose raw evolve.mjs commands only when the recipe genuinely doesn't fit |
| `scripts/evolve.mjs` | genetic-algorithm team search; both sides evolve (`src/teams/evolve.js` + `src/meta/opponentPool.js`), checkpoints/resumes in `out/`; `--ban a,b` removes species format-wide, both sides (cup rules) |
| `scripts/build-shared-collection.mjs` | intersects two collection CSVs into a shared-pool CSV of mons both players can build (weaker side's best specimen per base species) |
| `scripts/tournament.mjs` | large offline sampled runs |
| `scripts/refresh-usage.mjs` | optional: fetch live GL rankings → `data/meta-usage.json` snapshot |
| `scripts/build-evolution-costs.mjs` | regenerates `src/cost/evolutionCandy.json` |
| `scripts/bench.mjs`, `alignment-study.mjs`, `variance-study.mjs`, `shield-weight-review.mjs`, `chart-top-teams.mjs` | one-off benchmarks/analyses, not part of the pipeline |

### Module map (`src/`)

- `importer/` — CSV → NormalizedMon. `index.js` (Poke Genie + generic row
  mapping), `csv.js` (dep-free parser), `gamemaster.js` (species/form
  resolution against vendored gamemaster), `moves.js` (move-name →
  moveId for `--current-moves`), `util.js` (parsing helpers).
- `engine/` — the only code that touches pvpoke. `pvpokeLoader.js` boots
  vendor sources in a Node `vm`; `harness.js` (`buildPokemon`, 1v1
  `simBattle`); `teamBattle.js` (3v3 `battleTeams`, Training/emulate mode);
  `parallel.js`/`parallelWorker.js` (worker-thread executor, `--threads`).
  **Has its own README.md** for engine internals and determinism history.
- `scoring/` — the 1v1 pruning matrix (`scoreCollection`), shield-scenario
  weighted. Prunes candidates only; never the final ranking.
- `teams/` — the candidate side: `index.js` (3v3 evaluation + ranking,
  `dedupeBestPerSpecies` lineage collapse), `sample.js` (weighted candidate
  sampler), `evolve.js` (GA core).
- `meta/` — the opponent side: `teams.js` (curated pvpoke presets +
  `data/meta-teams-community.json`, tier weights), `sampleTeams.js` (weighted
  opponent sampler), `usage.js` (per-species usage weights), `roles.js`
  (lead/closer/switch priors), `opponentPool.js` (opponent-side GA).
- `evolution/` — expands a collection so each mon also competes as its
  possible evolutions (default on; `--no-evolutions`).
- `cost/` — `powerup.js` (Stardust/Candy build cost, pure arithmetic) +
  `evolutionCandy.json` (generated).
- `report/` — Markdown + HTML report rendering, pure (no engine).
- `util/` — `leagues.js` (CP cap → league identity), `rng.js` (seeded PRNG +
  weighted sampling; the only randomness source in the repo).

### Data & artifacts

- `vendor/pvpoke` — pinned sparse clone, absent until `scripts/setup.sh`;
  read-only (see rules above).
- `data/` — our own data: `meta-teams-community.json` (curated GL teams,
  `members[0]` = lead), optional `meta-usage.json`/`meta-roles.json`
  freshness snapshots (loaders fall back to vendored rankings when absent).
- `fixtures/` — sample collections for tests.
- Repo root may hold the user's real collection CSVs (`jaxon-gbl-collection.csv`,
  `jet_GL_collection.csv`, `jaxon-ultra-league.csv`, `shared-gbl-collection.csv`) — gitignored, personal
  data; don't commit or move them.

### Invariants an agent should know before editing

- Everything is deterministic: same seed ⇒ identical results, serial or
  threaded. All randomness flows through `src/util/rng.js`.
- Candidate teams always battle as "team A" (fixed-side convention — relative
  ranking is what's trusted, absolute win% carries a small side offset).
- `members[0]` of any team is its designated lead, everywhere.
- One lineage (a CSV row + its evolutions) contributes at most one candidate
  pool entry (`dedupeBestPerSpecies`).
- Battle math is never reimplemented — only pvpoke's vendored code fights.
- Tests map ~1:1 to modules (`test/<area>.test.js`); `test/e2e.test.js` is
  the only file running real battles (see Tests below).

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

The union runs in about 13 seconds and the fast tier in about 1. Neither is
something to ration — the table is about picking the run that answers your
question, not about avoiding cost.

These override the table:

- **A small change gets a small run.** Not because the suite is expensive, but
  because a green run over code you didn't touch tells you nothing. If you can
  name the file you changed, you can name the test that covers it.
- **After a failure, re-run that test file, not the suite.** The failure is
  right there; widen only once it's green.
- **The push is the gate, not the edit.** The closing `npm run test:full` is
  yours to run and is not optional. Nothing else will catch what it catches.
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

**Where the line sits:** `test/e2e.test.js` is the only file in the suite that
runs real pvpoke battles, and it is the only `@slow` file. Everything else works
on hand-built fixtures, fake matrices, or pure functions.

**Adding a test that needs the engine to actually fight?** It goes in
`test/e2e.test.js`, asserted against one of the shared runs already at module
scope there — not a fresh run of its own, and not a new file. The expensive work
happens once and the tests read its results. That rule is the whole reason the
union is 13 seconds instead of the 158 it used to be: the suite was re-simulating
from eleven files to check plumbing a single run already proved.

A handful of fast-tier files (`engine`, `scoring`, `evolve`, `metaTeams`,
`sampleTeams`, `sampleCandidates`) still call `simBattle`/`scoreCollection`/
`battleTeams` against tiny hand-built inputs. They cost ~0s together and are
unit tests of those call sites, not simulation runs.

Tiering costs no coverage on the narrow path: `test:changed` maps changed modules
to test files without consulting the marker, so editing `src/engine/teamBattle.js`
still pulls in `e2e.test.js`. The tier only decides what the *unfiltered* run skips.

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
