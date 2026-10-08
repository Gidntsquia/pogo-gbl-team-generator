# AGENTS.md — pogo-gbl-team-generator

Constitution for any agent working here. `CLAUDE.md` (conventions, module map, test policy)
and `RUNBOOK.md` (how to run/resume evolve sims) are authoritative; this file only adds what
they don't say.

- Stack: Node >= 18, ESM, plain JS, no TypeScript, no build step, no new npm deps without a
  stated reason. Tests: `node:test` only.
- No `.env`; there are no secrets. All artifacts and logs live in `out/` (gitignored):
  `out/evolve-<name>/` checkpoints, `out/evolve-<name>.log`, `.pid`.
- Never edit `vendor/pvpoke`; never reimplement its battle math.
- Never commit as a worker; keep the diff inside the files the task names. Exception: inside
  the planner/worker/evaluator loop (`plans/PLAN.md`) the worker commits, one commit per item,
  only the files its work touches, with `git add <paths>` -- the evaluator only sees commits.
- Never kill, resume, or restart an evolve run unless the task says so.
- Known invariant (v16, `docs/fitness-symmetry.md`): every pairing is battled from both
  seats (`mirrorBattleResult`), and both GA sides advance through one function,
  `evolveStep` in `src/ga/core.js`; side-specific behaviour belongs in its adapters only.
  Evolve runs do no 1v1 scoring: both sides sample by pvpoke rank alone (1/(rank+20) per
  species+shadow build; unranked = last place), and under `--meta-mode` (set by
  `scripts/sim.sh --meta`) both draw the whole ranked field. The 0.02 gap bound was
  measured on v15 (label `final`, 5 seeds, blend -0.0074 SE 0.0098, raw -0.0130 SE 0.0101);
  v16 has only a short sanity run, not a proof of the bound. Check with
  `node scripts/symmetry-gap.mjs report --label <label>` or
  `node scripts/fitness-sides.mjs out/evolve-<name>`. Real-collection runs differ between
  sides on purpose; a gap there is not evidence of a bug.
- Workers must run `bash scripts/setup.sh` first on a fresh clone.
- Plans for the planner/worker/evaluator loop live in `plans/` (gitignored); completed rounds
  are archived under `plans/archive/<date>-<topic>/`.
- Any change to what a generation's fitness number means must bump `FITNESS_SEMANTICS` in
  `src/evolve/fitness.js` so stale checkpoints refuse to resume instead of mixing scales.
- `--threads N` with N > 0 means N worker threads (`--threads 1` is ONE worker, not serial);
  `--threads 0` is real serial. A serial-vs-threaded determinism check needs both, and a
  1-worker run of a big cell is ~8x the wall time of 8 workers.
- The scenario memo (`src/engine/battle/scenarioMemo.js`) never stores or replays a sim that
  involves a form-changing mon (Mimikyu, Cramorant, Aegislash, Morpeko, ...): replay cannot
  restore the in-sim form rewrite, and results then depended on worker/battle order
  (found 2026-09-24). Same seed must give identical checkpoints at any `--threads`; check with
  two runs and diff the checkpoints ignoring timing fields. `FITNESS_SEMANTICS` was not bumped
  for this, so pre-fix checkpoints still resume.
- Round-3 opponent sweep lives in `out/sampled-k-ab-r3/` (driver `scripts/sampled-k-r3-sweep.mjs`);
  round 2's `out/sampled-k-ab/results.json` is kept as the pre-fix record. The report
  (`compare-search.mjs report --dir out/sampled-k-ab`) merges both.


## Recipe A/B chain (`scripts/recipe-ab-*.mjs|sh`)
`scripts/recipe-ab-chain.sh [--smoke]` runs 3 evolve sims in order (old no-halving, old+halving, new standard), relaunches
killed sims up to 3 times, scores finalists on the curated 100, writes `out/recipe-ab[-smoke].{md,html}`. Old sizes come from
`recipes/recipe-ab-old.json`, passed as a second `--config` after `--` (last value wins). Smoke mode kills sims 1-2 once and fails sim 2 on purpose.
