# Module map

Where code lives. The GitHub wiki explains behavior; this page is for finding
files.

## `src/`

- `importer/` — CSV → NormalizedMon. `index.js` (Poke Genie + generic row
  mapping), `csv.js` (dep-free parser), `gamemaster.js` (species/form
  resolution against vendored gamemaster), `moves.js` (move-name →
  moveId for current-moves mode, `--meta-mode`), `util.js` (parsing helpers).
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
  `output.js` write results; `gpuProfile.js` records the `--gpu` time buckets
  (`gpu-profile.json`).
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
| `mcp/server.mjs`, `mcp/server-extra.mjs` | `pogo-sim` (always loaded) and `pogo-sim-extra` (off by default) MCP servers (`.mcp.json`); tool tables in `RUNBOOK.md`, soft stop in `mcp/soft-stop.mjs` |
| `scripts/build-shared-collection.mjs` | intersects two collection CSVs into a shared-pool CSV of mons both players can build (weaker side's best specimen per base species) |
| `scripts/refresh-usage.mjs` | optional: fetch live GL rankings → `meta-usage.json` snapshot in `data/` |
| `scripts/build-evolution-costs.mjs` | regenerates `src/cost/evolutionCandy.json` |
| `scripts/bench.mjs`, `chart-top-teams.mjs`, `fitness-sides.mjs`, `render-report.mjs` | benchmarks, analyses and report re-rendering, not part of the pipeline |
| `scripts/symmetry-gap.mjs` | `run --label L` / `report --label L [--minus B]`: multi-seed candidate-vs-opponent fitness gap for meta-vs-meta runs; `report` exits 0 when within 0.02 |
| `gpu/` | GPU viability prototype (Python/uv, cupy CUDA kernels for 1v1 and 3v3 battles incl. form changers, verifiers, benchmark, binary + JSON sidecar, inner-sim scheduler and driver, 5,000-battle slice timing; `describe.mjs` shared mon descriptors); wired into `evolve.mjs --gpu` via `src/engine/gpuExecutor.js` (GPU+CPU battle executor); `gpu-ab.mjs` builds the CPU-vs-GPU A/B report (GPU-v1 and v2 columns); `gpu-profile.mjs` builds the `--gpu` speed profile page `out/gpu-profile.html`; `gpu-gap.mjs` builds `out/gpu-gap.html` (why v2 missed 1,500 b/s, prototypes) from `gpu/gap_proto.py` output and the kernel flags `POGO_GPU_KERNEL=warp|queue`; round 6: `POGO_GPU_KERNEL=slice` time-sliced series queue in `gpu/gpu/kernels/battle3v3.cuh` (`#ifdef SLICE`) driven by `gpu/gpu/kernel3v3.py` (`run_3v3_slice`, `run_3v3_ahead`), `gpu/gpu/predict.py` battle-length predictor (weights `predict-weights.json`), `gpu/gpu/sched_bench.py` (paired slice bench → `out/gpu/sched/*.json`), sidecar `BATCH3T` tagged launches for `POGO_GPU_STREAMS` (`gpu/client.mjs` `batch3Async`), `gpu-sched.mjs` builds `out/gpu-sched.html`; `gpu/profile_kernel.py` (kernel resources, launch tail, block sweep, divergence, layout/order prototypes, flagged-set and per-fix slice timing) and `gpu/replay_slice.py` (replay dumped batches) are the kernel-side measurements; `src/evolve/gpuProfile.js` records `gpu-profile.json` time buckets under `--gpu`; round 7: width sets (G lanes per battle) in the slice kernel, `gpu/gpu/width.py` width picker (`POGO_GPU_WIDTH=auto|G|mix`; round 8: auto reads the per-GPU calibration file `out/gpu/width-calib-<GPU>.json`, builds a bucket's row on its first launch when absent, G=1 unless a width wins by >3%; the round-7 bench table `gpu/gpu/width-table.json` from `gpu/gpu/width_table.py` is kept as a record for `gpu-width.mjs`, auto no longer reads it; the `POGO_GPU_PROBE` prober is gone), island halving kernel `battle3v3_island` (`#ifdef ISLAND`) driven by `gpu/gpu/island.py` (wire op ISLAND, `gpu/client.mjs` `island()`, `src/engine/gpuExecutor.js` `runIsland`) with the host side in `src/evolve/islandHalving.js` (halving.js `prepass` hook); `gpu-width.mjs` builds `out/gpu-width.html` (and `cmp`, `finalists` subcommands); round 8 (profile-first study): `gpu/gpu/study/<fork>/` research forks (`prof` profiling and SASS counts, `stack`, `pool`, `occ`, `split`, `lockstep`, `streams`, `cpushare`, `queue`, `early`, `lit`, `width` calibration `calib.py`), each `variant.py` selected by `POGO_GPU_STUDY=<fork>` (fixed list `kernel3v3.STUDY_VARIANTS`, off by default); `gpu/gpu/study/round8-page.mjs` writes the round-8 report as detail pages `out/gpu/study/detail/round8-*.html`, re-derived by `gpu/gpu/study/check_round8.py`; round 9 (branch `gpu`, tail speculation, off by default): `POGO_GPU_STUDY=tail[,certain]` runs the kernel `battle3v3_tail` (`gpu/gpu/study/tail/tail.cuh`, host `variant.py`, sidecar ops TAIL/PEEK/FEED) with the executor side in `src/engine/gpuTail.js` (pool store, certain-tier poller) and the next-round pool in `src/evolve/tailSpec.js` (halving.js/evaluate.js hooks); `gpu/gpu/study/tail/certainty.mjs` is the JS port of round 8's `certainty.py`; `tail/verify.py` (verify_3v3 through the tail kernel), `tail/timeline.py` (busy-SM timeline of dumped launches → `out/gpu/study/prof/tail-timeline.json`), `tail/ncu_summary.py` (Nsight Compute summary → `out/gpu/study/prof/ncu/summary.json`); `gpu/gpu/study/runs.mjs` reads a run's warm s/gen, tail share and tail-log totals; `gpu/gpu-study.mjs` builds the round-9 page `out/gpu-study.html` (+ `out/gpu/study/runs.json`, `page-numbers.json`, `detail/round9-runs.html`) and `gpu/gpu/study/check_page.py` re-derives every number and verdict word on it (`out/gpu/study/check.log`); `gpu/gpu/study/phone.mjs` cuts the page and `docs/gpu-round9-explained.md` into 390 px screenful PNGs (`out/gpu/study/phone/`) and fails on cut-off text, over-tall shots and paragraphs over 3 lines; `gpu/gpu/study/explained.mjs` draws the explainer's pictures `docs/gpu-r9-*.png`; timed runs: `out/gpu/study/run10.sh`, `r9chain.sh` (round 9), `chain.sh`, `ab.sh` (round 8); see `docs/gpu-viability.md` |

## Data

- `data/meta-teams-community.json` — curated GL teams, `members[0]` = lead;
  absent between seasons (past seasons' pools live in `data/archive/`; the
  loader falls back to vendor presets until repopulated).
- the optional `meta-usage.json` / `meta-roles.json` files (in `data/`) — optional freshness snapshots;
  loaders fall back to vendored rankings when absent.
- `fixtures/` — sample collections for tests.
