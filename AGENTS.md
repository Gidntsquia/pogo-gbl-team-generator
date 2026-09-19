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
  `scripts/evolve.mjs` so stale checkpoints refuse to resume instead of mixing scales.
