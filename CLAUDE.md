# pogo-gbl-team-generator — conventions

Node ≥ 18, ESM (`"type": "module"`), plain modern JavaScript, no TypeScript, no build step. 2-space indent, small focused modules, JSDoc on exported functions.

**Fresh clone / start of every scheduled run:** `bash scripts/setup.sh` FIRST — `vendor/pvpoke` is gitignored and absent until it runs.

**Running, watching or resuming an evolve sim: use the `pogo-sim` MCP tools, not Bash.** The server (`mcp/server.mjs`, registered in `.mcp.json` with `alwaysLoad`) is loaded in every session in this folder; launches are detached, so closing the session never kills a sim. Read `RUNBOOK.md` first for recipes and flag conventions; its "MCP servers" section maps each tool to its section.

| need | tool |
|---|---|
| launch | `run_standard` (collection CSV, sim.sh recipe) / `run_meta` (meta-vs-meta); `dry_run` prints the command, `extra` flags go after `--` for you |
| "how's the sim?" | `status_sim` — no name needed, one call. Show the header facts as a line, then candidate teams, candidate mons, opponent teams and opponent mons as four markdown tables with every column it returned; do not drop rows. A DONE run ends with the report path |
| other runs, logs | `list_runs` (names/states only; not needed before `status_sim`), `tail_log` |
| stop | `stop_sim` (`after_generation` soft stop, or `hard` with `confirm`); `cancel_stop` |
| resume | `resume_sim` — rebuilds the flags from the checkpoint `config` + `launch.json` and kills the process if it starts fresh. Pass `threads: 8`: it otherwise reuses the checkpoint's `threadsUsed`, which can have drifted low |
| died? | `check_oom` |

`pogo-sim-extra` (`mcp/server-extra.mjs`: `get_report`, `preflight`, `smoke_test`, `run_raw`, report/analysis and collection-building tools) is off by default via `disabledMcpjsonServers` in `.claude/settings.json`; enable it with `/mcp` only when a task needs it. Fall back to `scripts/sim.sh` / `scripts/evolve.mjs` only when no tool fits; a hand-composed resume must pass the exact original flag set or it silently starts fresh and overwrites the checkpoints (RUNBOOK section 4 checklist).

- Dependencies: avoid adding npm deps unless clearly necessary; record any addition and why in your report.
- `vendor/pvpoke` is a pinned read-only sparse clone (gitignored). Load/execute its code and data; never edit it, never reimplement its battle math. Need a path not checked out? `git -C vendor/pvpoke sparse-checkout add <path>`.
- Module interfaces are documented in the JSDoc on each exported function, and the GitHub wiki explains how the pieces fit — follow them exactly; if one proves wrong, say so in your report rather than silently changing it.
- Keep your diff inside the files your task owns; commit them with `git add <paths>` (never `-A`). There is no orchestrator: nobody else commits or pushes your work.
- Output artifacts (reports, caches) go in `out/` (gitignored).
- Repo root may hold the user's real collection CSVs (`jaxon-gbl-collection.csv`, `jet_GL_collection.csv`, `jaxon-ultra-league.csv`, `shared-gbl-collection.csv`) — gitignored personal data; don't commit or move them.

## Orientation

Feed in a Pokemon GO collection CSV, get back the best 3-mon GO Battle League
teams buildable from it, ranked by real 3v3 battles run through pvpoke's
vendored engine: **import CSV → build mons → sample candidate teams by pvpoke
rank → 3v3-battle them against an evolving opponent pool (both sides run a GA)
→ rank → report** (`my-teams-evolve.md` + `.html` in the run's out dir).

- **Where code lives:** `docs/module-map.md` (every `src/` area, script and data file).
- **How it behaves:** the GitHub wiki. Fetch a page raw with
  `curl -s "https://raw.githubusercontent.com/wiki/Gidntsquia/pogo-gbl-team-generator/<Page>.md"`
  (pages: Running-the-CLI, How-Scoring-Works, Build-Costs-and-Evolutions,
  Evolutionary-Team-Search, Shared-Collections, Development-and-Tests,
  MCP-Server, MCP-Server-Token-Costs).

### Invariants

- Everything is deterministic: same seed ⇒ identical results, serial or
  threaded. All randomness flows through `src/util/rng.js`.
- Only `src/engine/` touches pvpoke; battle math is never reimplemented.
- Candidate teams always battle as "team A" (relative ranking is trusted,
  absolute win% carries a small side offset).
- `members[0]` of any team is its designated lead, everywhere.
- One lineage (a CSV row + its evolutions) contributes at most one candidate
  pool entry (`dedupeByRank`).
- Both GAs share one generation step (`src/ga/core.js`); side-specific rules go
  in an adapter, not there.
- Bad user input throws a `UserError` (`src/util/userError.js`): 1-2 lines, never a stack.

## Tests

Only node's built-in `node:test` + `node:assert`. Tests map ~1:1 to modules
(`test/<area>.test.js`). **Run the smallest thing that can fail.**

| what you changed | what to run |
|---|---|
| a doc, comment, or log string | nothing |
| one module | its test: `node --test test/<file>.test.js` |
| a few files inside one area | `npm run test:changed` |
| something several modules import — scoring, engine, a shared fixture | `npm test` (fast tier, ~1s) |
| `package.json`, `scripts/tests.mjs`, the `vendor/pvpoke` pin, a dependency | `npm run test:full` (~13s) |
| nothing — you are about to push | `npm run test:full` |

- After a failure, re-run that test file, not the suite; widen only once it's green.
- The closing `npm run test:full` before a push is yours to run and is not optional.
- A `PreToolUse` hook blocks whole-suite commands and prints the narrow one;
  when you see `BLOCKED:`, run what it suggests. `TS_FULL=1 npm run test:full`
  overrides it only for the two `test:full` rows above or when the user asks.
  The command strings live in `.claude/test-commands.sh`; edit it and this
  table together.
- `test/e2e.test.js` is the only file that runs real pvpoke battles (the only
  `@slow` file). A test that needs the engine to fight goes there, asserted
  against one of its existing module-scope runs — not a new run or file.
  Tier mechanics: wiki page Development-and-Tests.

Before adding a test: one test per behavior (parameterize input variants);
don't test the framework or stdlib; no characterization tests for code written
in the same change; search for existing coverage first; new tests run under
100ms unless tagged `@slow`. Deleting a test that no longer earns its runtime is
normal — do it and say so.
