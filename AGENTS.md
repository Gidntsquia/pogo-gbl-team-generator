# AGENTS.md — pogo-gbl-team-generator

Constitution for any agent working here. `CLAUDE.md` (conventions, module map, test policy)
and `RUNBOOK.md` (how to run/resume evolve sims) are authoritative; this file only adds what
they don't say.

- Stack: Node >= 18, ESM, plain JS, no TypeScript, no build step, no new npm deps without a
  stated reason. Tests: `node:test` only.
- No `.env`; there are no secrets. All artifacts and logs live in `out/` (gitignored):
  `out/evolve-<name>/` checkpoints, `out/evolve-<name>.log`, `.pid`.
- Never edit `vendor/pvpoke`; never reimplement its battle math.
- Never commit as a worker; keep the diff inside the files the task names.
- Never kill, resume, or restart an evolve run unless the task says so.
- Known invariant (fixed 2026-09-18, v13): `evaluateTeamsInOrder` battles every pairing from
  both seats (candidate-as-A, and opponent-as-A mirrored back via `mirrorBattleResult`), in
  every generation and the final elites pass, so pvpoke emulate's residual team-B edge no
  longer accumulates into a population-level side bias. A real population-strength gap between
  the candidate and opponent GAs can still show up in absolute win%/fitness numbers -- that's
  not a harness bug; see RUNBOOK.md's fitness-asymmetry entry and `scripts/side-bias-study.mjs`.
  Relative ranking is still what's trusted.
- Workers must run `bash scripts/setup.sh` first on a fresh clone.
- Plans for the planner/worker/evaluator loop live in `plans/` (gitignored); completed rounds
  are archived under `plans/archive/<date>-<topic>/`.
- Any change to what a generation's fitness number means must bump `FITNESS_SEMANTICS` in
  `scripts/evolve.mjs` so stale checkpoints refuse to resume instead of mixing scales.
