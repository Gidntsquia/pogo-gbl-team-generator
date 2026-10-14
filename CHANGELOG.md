# Changelog

All notable changes are listed here, in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

## [1.0.0] - 2026-10-14

First tagged release, summarizing the work since the first commit on 2026-08-20.

### Added

- Importer: Poke Genie and generic CSV import, Best Buddy overrides, and import from a Pokemon GO
  screen recording (shadow detection included).
- Search/GA: evolutionary team search (`scripts/evolve.mjs`) with a co-evolving opponent pool,
  checkpoints and resume, smoothed-fitness convergence, hot-start mutation anneals, core and
  similar-core rivalry, shared-weakness scoring, and a held-out final pass.
- Search/GA: Sequential Halving (on by default, R=3), plus off-by-default Hoeffding races and
  sampled combats (`--sampled-combats`, `--sampled-opponents`).
- Search/GA: a shared battle cache file (`--battle-cache-file`) and a scenario memo for repeated
  sims.
- Scoring: 3v3 team battles through pvpoke's vendored engine, with a modeled 200 ms reaction time
  and throw-and-go, and every pairing battled from both seats.
- Scoring: pvpoke-rank candidate sampling, role priors from pvpoke's lead/closer/switch rankings,
  and the battle-reality fitness blend (snowball, closer, consistency).
- Scoring: evolution-aware builds, with Stardust, Candy and Candy XL costs per team.
- Reports: `my-teams-evolve.md` and `.html` with a podium, a team race chart, core breakers and
  build costs, and `scripts/render-report.mjs` to re-render a finished run.
- MCP: the `pogo-sim` server (launch, status, tail, stop, resume, OOM check) and the optional
  `pogo-sim-extra` server; `status_sim` returns a one-call report for the live run.
- CLI: `scripts/sim.sh` launcher with `--quick`, `--meta`, `--cup`, `--cp`, `--ban`, and
  `recipes/standard.json`; Ultra League and pvpoke cups.
- Docs: README, RUNBOOK, module map and a GitHub wiki, including pages on the MCP server, its token
  costs and the research approaches that were tried.

### Changed

- Search/GA: both GA sides now share one generation step (`src/ga/core.js`), and `--meta-mode`
  gives meta-vs-meta runs a candidate/opponent fitness gap within 0.02.
- Search/GA: the standard recipe is population 300 ramping to 120 with 120 opponents per
  generation and Halving R=3.
- Scoring: candidates are sampled by pvpoke rank alone; 1v1 scoring was dropped.
- Scoring: the scenario memo never replays sims that involve form-changing mons, so serial and
  threaded runs give identical checkpoints.
- Docs: stale history, dated notes and references to retired scripts were removed from CLAUDE.md,
  AGENTS.md, RUNBOOK.md and the module map.

### Removed

- Experiment scripts (sizing sweeps, Hoeffding and sampled-combat A/B drivers, the recipe A/B
  chain, held-out store and report builders), their tests, the old planning docs and
  `recipes/recipe-ab-old.json`. They moved to the gitignored `docs/research/`.

[Unreleased]: https://github.com/Gidntsquia/pogo-gbl-team-generator/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Gidntsquia/pogo-gbl-team-generator/releases/tag/v1.0.0
