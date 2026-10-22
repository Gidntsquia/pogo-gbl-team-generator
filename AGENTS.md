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
- `--gpu` timing: a GPU step's time is set by its slowest battles, not its battle count (3.9–11 s for
  3,000–18,000 battles on the RTX 3080), so moving battles to the CPU never shortens it. Keep the CPU
  share small (`auto`, ~95 a step); share 0.05 made 5 generations 84% slower. Every `--gpu` run writes
  `<out-dir>/gpu-profile.json`; `node gpu/gpu-profile.mjs` renders it. GPU kernel changes are checked
  with `cd gpu && uv run python -m gpu.verify_3v3` (100% winner, 0 flagged) and `gpu.verify_1v1`.
- `--gpu` launch span equals the longest single battle (one thread per battle), so a work queue cannot shorten a launch;
  only fewer/bigger launches or more parallelism per battle can (`out/gpu-gap.html`, `docs/gpu-viability.md` round 5).
- cupy keeps freed device blocks per stream: a sidecar path that makes a new `cp.cuda.Stream` per launch and allocates
  under it never reuses them, the pool grows every launch, and on this WSL box late generations then run up to 150x
  slower (round 9 tail variant, fixed by one long-lived stream; `POGO_GPU_TAIL_MEMLOG=1` shows the pool per launch).
- Once a pool reuses blocks, a `cp.empty` buffer holds old bytes: anything the host reads while a kernel may still be
  writing it (early reads of a running grid) must be zeroed at allocation (`K._dz`) and its unwritten rows filtered.
