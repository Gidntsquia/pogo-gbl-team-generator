# Module map

Where code lives. The GitHub wiki explains behavior; this page is for finding
files. Moved out of `CLAUDE.md` on 2026-10-08 so it isn't loaded into every
agent session.

## `src/`

- `importer/` — CSV → NormalizedMon. `index.js` (Poke Genie + generic row
  mapping), `csv.js` (dep-free parser), `gamemaster.js` (species/form
  resolution against vendored gamemaster), `moves.js` (move-name →
  moveId for `--current-moves`), `util.js` (parsing helpers).
- `engine/` — the only code that touches pvpoke. `pvpokeLoader.js` boots
  vendor sources in a Node `vm`; `harness.js` (`buildPokemon`, 1v1
  `simBattle`); `teamBattle.js` (3v3 `battleTeams`, Training/emulate mode; its determinism/clock/AI-wrapper helpers are in `battle/`);
  `parallel.js`/`parallelWorker.js` (worker-thread executor, `--threads`);
  `similarity.js` (pvpoke's own "Similar Pokemon" score, normalised 0..1, for
  archetypes.js's core-rivalry penalty).
  **Has its own README.md** for engine internals and determinism history.
- `scoring/` — `buildCollection` (mons → battle-ready pvpoke instances, no
  battles; what evolve runs use), `buildMetaMon` (opponent builds), and
  `scoreCollection` (the 1v1 matrix; only `build-shared-collection.mjs` and
  `scripts/*` one-offs still use it -- evolve runs never fight 1v1s).
- `teams/` — the candidate side: `rankedPool.js` (`dedupeByRank` lineage/build
  collapse, `buildRankedPool` species cap, both by pvpoke rank), `sample.js`
  (candidate sampler, weight 1/(rank+20) per species+shadow build, last place
  when unranked), `evolve.js` (GA core), `index.js` (`dedupeBestPerSpecies`).
- `evolve/` — the evolve run, split by stage: `cli.js` parses/validates flags
  and holds `--help`, `run.js` drives generations, `evaluate.js`/`fitness.js`
  score (`fitness.js` holds `FITNESS_SEMANTICS`), `reportMd.js`/`reportHtml.js`/
  `output.js` write results.
- `meta/` — the opponent side: `teams.js` (curated pvpoke presets +
  `data/meta-teams-community.json`, tier weights), `sampleTeams.js` (weighted
  opponent sampler), `usage.js` (per-species usage weights, rank-position
  weighted), `roles.js` (lead/closer/switch priors), `opponentPool.js`
  (opponent-side GA), `archetypes.js` (groups opponents by dominant
  two-species core so a crowded bred core doesn't out-vote a lone one in fitness math,
  plus the core-rivalry penalty both GAs rank with: identical or pvpoke-similar
  cores, per `engine/similarity.js`, compete for seats).
- `ga/` — `core.js`: the one generation step both GAs run (`evolveStep`: rivalry
  ranking, cull, mutation roll, seat split, fill, dedupe) plus shared crowding
  weights and trailing fitness. `teams/evolve.js` and `meta/opponentPool.js` are
  thin callers supplying adapters; side-specific rules go in an adapter, not here.
- `evolution/` — expands a collection so each mon also competes as its
  possible evolutions (default on; `--no-evolutions`).
- `cost/` — `powerup.js` (Stardust/Candy build cost, pure arithmetic) +
  `evolutionCandy.json` (generated).
- `report/` — chart/theme helpers for the evolve report (`raceChart.js`, `podiumTheme.js`).
- `util/` — `leagues.js` (CP cap + cup → format identity), `eligibility.js`
  (candidate-side cup filtering, applied after evolution expansion), `rng.js`
  (seeded PRNG + weighted sampling; the only randomness source in the repo),
  `userError.js` (1-2 line user-facing errors, never a stack).

## Scripts

| script | what it does |
|---|---|
| `scripts/sim.sh` | preferred evolve launcher (recipe, detached runs, `status`); see `RUNBOOK.md` |
| `scripts/evolve.mjs` | thin entry point into `src/evolve/`; `--help` lists every flag, `--check` validates inputs only |
| `mcp/server.mjs` | `pogo-sim` MCP server (`.mcp.json`); tool list in `RUNBOOK.md` |
| `scripts/build-shared-collection.mjs` | intersects two collection CSVs into a shared-pool CSV of mons both players can build (weaker side's best specimen per base species) |
| `scripts/refresh-usage.mjs` | optional: fetch live GL rankings → `data/meta-usage.json` snapshot |
| `scripts/build-evolution-costs.mjs` | regenerates `src/cost/evolutionCandy.json` |
| `scripts/bench.mjs`, `chart-top-teams.mjs`, `fitness-sides.mjs`, `render-report.mjs` | one-off benchmarks/analyses and report re-rendering, not part of the pipeline |
| `scripts/symmetry-gap.mjs` | `run --label L` / `report --label L [--minus B]`: multi-seed candidate-vs-opponent fitness gap for meta-vs-meta runs; `report` exits 0 when within 0.02 (`docs/fitness-symmetry.md`) |

## Data

- `data/meta-teams-community.json` — curated GL teams, `members[0]` = lead;
  absent between seasons (past seasons' pools live in `data/archive/`; the
  loader falls back to vendor presets until repopulated).
- `data/meta-usage.json`/`meta-roles.json` — optional freshness snapshots;
  loaders fall back to vendored rankings when absent.
- `fixtures/` — sample collections for tests.
