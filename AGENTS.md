# AGENTS.md — pogo-gbl-team-generator

Constitution for any agent working here. `CLAUDE.md` (conventions, test policy; module map in `docs/module-map.md`)
and `RUNBOOK.md` (how to run/resume evolve sims) are authoritative; this file only adds what
they don't say.

- Stack: Node >= 18, ESM, plain JS, no TypeScript, no build step, no new npm deps without a
  stated reason. Tests: `node:test` only.
- No `.env`; there are no secrets. All artifacts and logs live in `out/` (gitignored):
  `out/evolve-<name>/` checkpoints, `out/evolve-<name>.log`, `.pid`.
- Never edit `vendor/pvpoke`; never reimplement its battle math.
- Keep the diff inside the files the task names; commit with `git add <paths>`, never `-A`.
- Never kill, resume, or restart an evolve run unless the task says so.
- Invariant: every pairing is battled from both seats (`mirrorBattleResult`), and both GA sides
  advance through one function, `evolveStep` in `src/ga/core.js`; side-specific behaviour belongs
  in its adapters only. Evolve runs do no 1v1 scoring: both sides sample by pvpoke rank alone
  (1/(rank+20) per species+shadow build; unranked = last place), and under `--meta-mode` (set by
  `scripts/sim.sh --meta`) both draw the whole ranked field. In meta-vs-meta runs the
  candidate-minus-opponent fitness gap stays within 0.02; check with
  `node scripts/symmetry-gap.mjs report --label <label>` or
  `node scripts/fitness-sides.mjs out/evolve-<name>`. Real-collection runs differ between sides
  on purpose; a gap there is not evidence of a bug.
- Run `bash scripts/setup.sh` first on a fresh clone.
- Any change to what a generation's fitness number means must bump `FITNESS_SEMANTICS` in
  `src/evolve/fitness.js` so stale checkpoints refuse to resume instead of mixing scales.
- `--threads N` with N > 0 means N worker threads (`--threads 1` is ONE worker, not serial);
  `--threads 0` is real serial. A serial-vs-threaded determinism check needs both.
- The scenario memo (`src/engine/battle/scenarioMemo.js`) never stores or replays a sim that
  involves a form-changing mon (Mimikyu, Cramorant, Aegislash, Morpeko, ...): replay cannot
  restore the in-sim form rewrite, and results would then depend on worker/battle order. Same
  seed must give identical checkpoints at any `--threads`; check with two runs and diff the
  checkpoints ignoring timing fields.
