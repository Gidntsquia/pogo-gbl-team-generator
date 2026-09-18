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
- Known invariant (v13, 2026-09-18; measured 2026-09-18, `docs/fitness-symmetry.md`):
  `evaluateTeamsInOrder` battles every pairing from both seats (candidate-as-A, and
  opponent-as-A mirrored back via `mirrorBattleResult`), in every generation and the final
  elites pass, removing the pvpoke-emulate side-bias structurally. For meta-vs-meta runs with
  `--random-opponent-lead`, `docs/fitness-symmetry.md` measured a noise floor
  T = 0.1416 (`scripts/symmetry-study.mjs`, 5-seed gen-0 study): the blend-fitness gap between
  candidate and opponent mean fitness stays under T across an 8-generation run
  (`out/evolve-sym-final`), but the raw win-rate layer alone can exceed T in some generations
  (a real, documented, unfixed asymmetry -- see the residual rows in `docs/fitness-symmetry.md`).
  Relative ranking is still what's trusted; check `docs/fitness-symmetry.md` and
  `scripts/fitness-sides.mjs`/`scripts/side-bias-study.mjs` on your own run before treating an
  absolute win%/fitness gap as evidence of a bug.
- Workers must run `bash scripts/setup.sh` first on a fresh clone.
- Plans for the planner/worker/evaluator loop live in `plans/` (gitignored); completed rounds
  are archived under `plans/archive/<date>-<topic>/`.
- Any change to what a generation's fitness number means must bump `FITNESS_SEMANTICS` in
  `scripts/evolve.mjs` so stale checkpoints refuse to resume instead of mixing scales.
