# GPU viability: porting the 3v3 battle to CUDA (rounds 2-9)

The GPU work (rounds 2-9) lives on branch `gpu`; `main` was reset to the commit before it (2b2ca01). Nothing GPU-side is on by default.

## Verdict

**Go for the whole-battle path (b); no-go for the inner-sim batching path (a).** Nothing is wired into the CLI; you decide integration.

| the three numbers | value | measured how |
|---|---|---|
| Slice speedup, GPU + 8 CPU workers overlapped vs CPU only | **×31.7** (333.7 s → 10.5 s for 5,000 battles) | `node gpu/slice-e2e.mjs`, first 5,000 gen-0 battles of `out/evolve-gpu-profile/`, memo on, `out/gpu/slice-5000.json` |
| Projected full run | **≈0.25 h instead of 8 h** (≈0.36 h if the GPU only matches the profile run's warmer 21.5 battles/s CPU rate instead of this slice's cold 15.0) | 8 h × (GA share + (1 − GA share) / 31.7); GA/non-battle share measured at 0.1% (below) |
| Form-changer agreement (float32) | **100.00%** winner agreement on the 435 previously-unsupported 3v3 battles that the kernel finished, win-rate delta +0.00 pp; whole 5,000-battle slice 99.78% (4,989/5,000) | `gpu.verify_3v3`, `slice-e2e.mjs` |

- Form changers (Cramorant, Mimikyu, Morpeko, Aegislash) are ported; the "unsupported" flag no longer exists (0 flagged).
  PASS on both bars, float32: winner agreement ≥ 99% and win rate within ±1 pp.
- **Path (a) fails:** with 16–64 battles in flight and every lookahead sim batched, the effective inner-sim rate is
  2,445–3,129 sims/s against 4,895 for the 8 CPU threads, so S = 0.50–0.64 against the 10.6 needed. Not viable (details below).
- Open items for integration: the 3v3 lookahead pool is now 768 entries (was 320, which flagged 19 of 2,400 battles); the re-run flags 0 of 2,436. Multi-stream overlap does not help (×0.55); results are float32 and not bit-identical (9 survivor-HP / 10 turn-count
  differences in 2,400 compared battles, never a winner).
- Not done: a `--gpu` flag, routing, or a seeded-report diff (see "Not done").

## Why the numbers differ

Every row is the same GPU. They differ in what the timer includes. "vs serial" is pvpoke `battleTeams` on one thread, memo off
(3.30 battles/s). "vs 8 threads" is the 8-worker pool: 21.5 battles/s in the profile run, 14.98 on the 5,000-battle slice (the pool starts cold, memo hit rate 33.8%).

| row | what is timed | battles/s | vs serial 1 thread | vs 8 threads | transfer | packing | CPU fallback | GA time | memo |
|---|---|---|---|---|---|---|---|---|---|
| kernel per battle ×N (1,000 battles) | one launch, host↔device copies | 160 | ×48.6 | ×10.7 (vs 14.98) | yes | no (arrays pre-packed in a file) | no | no | none |
| kernel at 5,000 / 36,000 battles | same, bigger launch | 521 / 947 | ×158 / ×287 | ×35 / ×63 | yes | no | no | no | none |
| sidecar, JSON lines (1,000) | Python process, JSON text both ways | 89 | ×27 | ×5.9 | yes | no | no | no | none |
| sidecar, binary (1,000) | same, packed binary frames | 102 | ×31 | ×6.8 | yes | no | no | no | none |
| inner-sim batched (path a) | CPU battles block on GPU 1v1 batches | 4.7–5.9 | ×1.4–1.8 | ×0.50–0.65 | yes | describe per sim | no | no | local per fiber |
| GPU-only slice (5,000) | node describe + pack + binary batch + kernel | 497 | ×151 | ×33 | yes | yes (0.17 s) | no | no | none |
| overlapped slice (5,000) | GPU 98.5% + CPU workers 1.5% at once, later finisher | 475 | ×144 | **×31.7** | yes | yes | yes (the CPU share) | no | CPU share only |
| projected full run | 8 h × (0.001 + 0.999 / 31.7) | — | — | **≈0.25 h** | yes | yes | yes | 0.1% | CPU share only |

Why the 1,000-battle rows (100–160 b/s) are far below the 5,000-battle slice (≈500 b/s): the kernel's time is set by its slowest
battle in a launch, and a launch of 1,000 battles has a long tail with nothing to hide it. 5,000 battles per launch amortize
it. JSON vs binary: 89 vs 102 b/s on the same 1,000-battle batch (×1.15); once the kernel dominates, transfer format barely matters.
Earlier round numbers (284 b/s kernel, 141 b/s sidecar) were measured on a smaller, less form-heavy set before the form changers
were in the kernel; they are not comparable with this table.

## Why "no CUDA device" and GPU results both exist

Both are true on this machine, and both were observed this session.

- This is a WSL2 box with an RTX 3080 (10 GB, about 4.5 GB in use by other programs). Normal runs of every command in this report
  see the card and produce the GPU numbers above.
- Every `gpu/` entry point first calls `gpu/gpu/cuda_guard.py` (`require_cuda()`). Under `CUDA_VISIBLE_DEVICES=""` it finds no device
  and exits 1 with one line: `gpu: no CUDA device (CUDARuntimeError: cudaErrorNoDevice: no CUDA-capable device is detected)`.
  That is how you check what a machine without a GPU does (a fresh clone on a CI box, say). Observed with it set, all exit 1 with that single line:
  `uv run python -m gpu.bench`, `gpu.verify_1v1`, `gpu.verify_3v3`, `gpu.sidecar`, `gpu.sidecar --binary`, `node gpu/client.mjs`,
  `node gpu/client.mjs --transport json`, `node gpu/slice-e2e.mjs`, `node gpu/scheduler-driver.mjs`.
- The unit test `gpu.test_scheduler` uses a stub for the GPU and needs no device.
- Oversized batches: a batch that exceeds the configured limit or does not fit in GPU memory is split in halves and the split is logged
  (`gpu: batch of 2000 exceeds the 700-battle limit; split into 1000 + 1000`); the split result is identical to the unsplit one.

## Prototype

`gpu/` (Python via `uv`, cupy `RawKernel`, NVRTC; no nvcc needed). Machine: RTX 3080 10 GB, i7-10700KF, 11 GB RAM, WSL2.

| piece | command |
|---|---|
| export pvpoke ground truth (≈15 min, 5.5 GB heap, writes an 800 MB `sims.json`) | `node --max-old-space-size=5500 gpu/export-matchups.mjs --fixtures --rankings 40` |
| 1v1 / 3v3 verification | `uv run python -m gpu.verify_1v1 [--real double]`, `uv run python -m gpu.verify_3v3` (from `gpu/`) |
| benchmark (serial side first) | `node gpu/serial-baseline.mjs --battles 1000 [--memo]`, then `uv run python -m gpu.bench [--skip-1v1]` |
| slice specs | `node gpu/dump-gen0-specs.mjs out/evolve-gpu-profile/evolve-gen0.json jaxon-gl-collection.csv out/gpu/slice-specs.json 5000 --slice` |
| end-to-end slice | `node gpu/slice-e2e.mjs` (needs the GPU; uses all 8 cores for about 6 min) |
| scheduler experiment | `node gpu/scheduler-driver.mjs --battles 256 --fibers 16,32,64`; unit test `uv run python -m unittest gpu.test_scheduler` |
| transports | `node gpu/client.mjs --transport binary\|json` (frame format in `gpu/gpu/wire.py`) |

## Measured: batch size, memory, streams (`out/gpu/bench.json`)

| batch | seconds | battles/s | GPU memory in use (whole card) |
|---|---|---|---|
| 1,000 | 9.7 | 103 | 8,175 MB (+578 MB over idle) |
| 5,000 | 9.6 | 521 | 8,221 MB (+624 MB) |
| 36,000 (one whole generation) | 38.0 | 947 | 8,142 MB (+545 MB) |

The 36,000 batch is the gen-0 export tiled up (about 1,500 distinct battles repeat); cost per battle is unaffected by repetition. One launch
of 36,000 fit without a split. Streams: 1 stream 504 b/s, 2 streams 277 (×0.55), 4 streams 160 (×0.32) on the same
5,000 battles with `chunk = n / streams`. The kernel already fills the GPU and chunking exposes the slowest-battle tail in each chunk, so overlap
only hurts; the `--streams` option stays at 1 in the sidecar.

## Inner-sim batching, path (a) (`gpu/gpu/scheduler.py`, `gpu/scheduler-driver.mjs`)

`InnerSimScheduler` (interface in its docstring, tested in `gpu/gpu/test_scheduler.py`) collects 1v1 requests from many suspended battles,
dedupes identical states, cuts batches at `max_batch`, runs one kernel call and hands results back. The driver runs each CPU battle in a worker
thread that blocks (Atomics.wait) while its lookahead sim is outstanding, and flushes one batch once every running battle is waiting.
Same 256 battles, 8-thread CPU reference: 28.2 s, 118,960 sims → inner-sim capacity 4,895 sims/s (86.2% of time in `simulate`).

| fibers | mean batch | wall | effective sims/s | S vs 10.6 needed | winner agreement with exact CPU | RSS |
|---|---|---|---|---|---|---|
| 16 | 15.3 | 54.8 s | 2,445 | 0.50 | 84.4% | 1.9 GB |
| 32 | 29.7 | 43.2 s | 3,129 | 0.64 | 86.3% | 1.2 GB |
| 64 | 53.3 | 45.0 s | 3,005 | 0.61 | 85.5% | 2.2 GB |

**Path (a) is not viable here.** A batch can never exceed the number of battles in flight (each blocks until its own answer), the batch stays
tiny, every step pays a round trip, and each fiber needs a full engine context (process RSS 1.2–2.2 GB at 16–64 fibers), so memory caps the fibers on 11 GB. Fidelity
is also lower than 100% because the 1v1 kernel does not hand back every field the CPU memo restores (cooldown, damage window, faint source).
Reaching S ≥ 10.6 would need hundreds of battles in flight. Path (b) does not have this problem.

## Profile of a real generation

Run `gpu-profile` (8 workers; `out/evolve-gpu-profile/`): gen 0 simulated 36,000 battles in 27 m 53 s (21.5 battles/s); gen 1 simulated 24,452 and
served 11,548 from cache in 21 m 07 s.

- Whole run 49 m 01 s (2,942 s, from `launch.json` `at` to `evolve-DONE`). The two generations' battle phases sum to 2,939 s (1,672.6 + 1,266.8), so
  GA and all other non-battle work is **≈3 s = 0.1%** of the run. Projections below therefore treat the run as all battles.
- ≈459 real `simulate()` per battle in the run (memo hit rate 31%); inclusive time under `MemoBattle.b.simulate` = **86.2%** of worker time
  (`node gpu/profile-inclusive.mjs`).
- Serial isolated `simulate()` = 0.38 ms (2,657 sims/s).

## Time model

Baseline: ≈8 h at 8 threads ≈ 620k battles at 21.5 battles/s.

**(a) inner sims on GPU:** run time = 0.138 + 0.862 / S. Ceiling 7.2×; 5× needs S ≥ 10.6. Measured S ≤ 0.64 (table above) → no.

**(b) whole battle on GPU, overlapped with the CPU workers (measured):** slice wall 10.52 s vs 333.7 s CPU only. Projected full run
= 8 h × (0.001 + 0.999 × 10.52 / 333.7) = **0.25 h**. With the CPU baseline taken from the profile run (21.5 b/s) and the GPU's 475 b/s
unchanged the ratio is ×22 → 0.36 h. Either way a run is dominated by the fixed costs this model leaves out: GA and report time are 0.1% only
while battles are slow; at 15 minutes of battles they are still seconds. Also not modeled: the 0.8% POOL_OVERFLOW battles that need the CPU
(≈40 per 5,000, a few seconds on 8 workers, hidden by the overlap), and that the GPU path has no scenario memo, which the CPU path uses for 31–34% of sims.

The overlapped result was balanced in two runs: run a (GPU share 97.1%) finished GPU first at 8.3 s with CPU at 15.9 s; run b (98.5%) finished at 10.5 s with
the CPU at 9.2 s. The CPU workers slow down while node packs and feeds the sidecar, so the best split moved from the naive rate-ratio.

## Port map (vendor line ranges)

Ported:

- `Battle.js`: `setNewPokemon` 82-120, `start` 215-274, `step` 278-605, `getTurnAction` 720-788, `queueAction` 793-837,
  `processAction` 842-1012, `useMove` 1016-1650 (damage, buffs, charged-move and fast-move ordering, CMP ties).
- `TrainingAI.js`: `evaluateMatchup` 633-813, `runScenario` 815-957, `chooseOption` 971-990, `processStrategy` 992-1020,
  `decideAction` 1030-1129, `decideSwitch` 1131-1179, `decideShield` 1181-1378.
- Engine wrappers: `aiWrappers.js` throw-and-go (140), shield banking (325), switch cost (415); `clockWrappers.js` (40); `teamBattle.js` 3v3 driver.
- **New in round 2, form changers:** `Pokemon.js` `changeForm` 2471-2590 (move replacement for Morpeko 2505-2511, Aegislash 2513-2520, stat/type
  swaps 2538-2560) and `resetState` 1933-1934; `Battle.js` reset-on-switch 995-997, `activate_charged` trigger 1024-1031, `activate_shield` 1198-1204,
  Mimikyu disguise (`charged_move_damage`) 1273-1290, Aegislash shield-form energy rules 1325/1354/1514, `charged_move` trigger incl.
  Cramorant Gulping/Gorging 1548-1572, Gulp Missile damage and form reset after 1583, Aegislash/Cramorant shield-saving rules 1121-1134;
  `Pokemon.js` Aegislash energy behavior 792-794 and 1569. Static form fields in `pack.py` (S_N 144, rows 130-140) and per-battle form state in dyn rows 15-16.
- 1v1 `simulate()` kernel (separate, simulate-mode ActionLogic).

Not ported (named, not approximated):

- AI difficulty other than the level 3 the evolve search uses; simulate-mode ActionLogic inside the 3v3 path.
- Animations and decision logging (`pushAnimation`, `logDecision`): no effect on results.
- Residual differences (29 of 89,355 form-changer 1v1 scenarios; 3 of 18 form-changer fixture pairings, HP/turn only): not traced to a vendor line.
  Suspects, unconfirmed: the Surf-vs-Dive test at `Battle.js` 1133-1134 and Aegislash move replacement (`Pokemon.js` 2513-2520) persisting across a switch.

Hard parts: RNG draw order (`rng` advances per lookahead sim; `chooseOption`, buff rolls, WAIT_CLOCK, `decideShield` and OVERFARM draws), virtual-timer queue ordering,
branchy bait/throw-and-go/shield logic, and now mid-battle form changes. A divergence in any one of them moves every later random outcome.

## Verification (mismatch counts)

Export: 2,436 battles, 1,202,849 distinct 1v1 inner sims; the previously flagged set is now every scenario or battle containing a form changer
(it is larger than the earlier 294 battles / 54,272 sims because the new export has more gen-0 battles and added form-changer fixtures; the set is
defined by the species, not by the old flag counts).

**1v1** (`gpu.verify_1v1`, gen-0 inner sims 1,193,336; 0 flagged unsupported):

| set | build | scenarios | rows with a mismatch | notes |
|---|---|---|---|---|
| previously flagged (form changers) | double | 89,355 | 29 (0.03%) | rating 25, hp 18/12, energy 13/15, turnsToKO 8/6, rngDraws 7 (was 226, mostly turnsToKO, before the start-form move fix) |
| previously flagged (form changers) | float32 | 89,355 | 29 (0.03%) | same counts; winner agreement 99.99%, win-rate delta +0.00 pp → PASS |
| rest | double | 1,103,981 | **0** | |
| rest | float32 | 1,103,981 | 195 (0.018%) | rating 182 |

rankings-1500 leads: 398 pairs, 0 rating and 0 any-field mismatches (both builds).

**3v3** (`gpu.verify_3v3`): 36 fixtures plus 2,400 real gen-0 battles (436 with a form changer).

| set (float32) | battles | flagged invalid | winner mismatches | survivorsHp | turn count |
|---|---|---|---|---|---|
| previously flagged (form changers) | 436 | 0 | 0 | 1 | 2 |
| rest | 1,964 | 0 | 0 | 8 | 8 |
| fixtures (incl. 18 form-changer lead pairings) | 36 | 0 | 0 | 3 | 3 |

Double build: previously flagged 0/0/0 winner/HP/turn mismatches (436 compared), rest 0/0/0 (1,964 compared), fixtures 0/3/3; no pass bar applied to double.
Float32 (pool 768, 0 flagged; the double row above is from the earlier pool-320 run): team-A win rate pvpoke 49.94% vs kernel 49.94% (+0.00 pp) → PASS; per-matchup winner agreement 100.00% → PASS; previously-flagged subset alone 436 battles, 100.00%, +0.00 pp.
The fixture mismatches are all HP/turn-only, in form-changer lead pairings (`forms-11`, `forms-21`, `forms-mirror-21`); no winner flips.
The `forms-02` winner flip is fixed: `gpu/describe.mjs` gave the start form's own snapshot the plain move (shield Aegislash `PSYCHO_CUT`, gain 9) instead of
its form move (`AEGISLASH_CHARGE_PSYCHO_CUT`, gain 6). In `forms-11` the GPU skips a shield on Morpeko's charged move at turn 28 that pvpoke uses (shield-decision gap, not yet traced). Flagged invalid
= `POOL_OVERFLOW` (the lookahead pool capacity of the 3v3 kernel), reported in the "flagged invalid" count, distinct from the removed "unsupported" flag.

Earlier-round fix kept for reference: `Battle.js` line 415 `action.priority -= 40` is dead code; the first kernel applied it and gave 96.11% agreement.

## Other evidence

- **Dawn / WebGPU:** `webgpu@0.6.2` (Dawn) runs a compute shader in WSL2 (`result [0,2,4,6]`) but its adapter is llvmpipe (Mesa 26.0.3 software), not the RTX 3080;
  `DAWN_BACKEND=vulkan` gives the same. D3D12 not tried. No Dawn speed numbers.
- **1v1 kernel:** 10,000 sims in 10 ms including transfer ≈ 998k sims/s (pvpoke serial 2,657 sims/s). The 1v1 JSON sidecar figure in `gpu.bench` (130 sims/s) was
  dominated by two 800 MB `sims.json` loads fighting for 11 GB of RAM and is not a transport measurement; the 3v3 rows above are.
- **Invariant:** the port reimplements battle math, which `CLAUDE.md` forbids for `src/`. It is contained in `gpu/` and guarded by exact comparison against pvpoke.

## Not done

- No `--gpu` flag, no routing in `src/`, no seeded-report diff: the production search calls `battleTeams`, and the float32 kernel is not bit-identical
  (see counts), so a seeded report would not be byte-equal. Wiring needed: a batching shim at `src/engine/teamBattle.js` that sends battles to the sidecar in
  ≥5,000-battle launches, a CPU fallback for `POOL_OVERFLOW` battles, and a seeded-report comparison.
- GPU memory: the card is shared with other programs; 36,000-battle launches ran at ≈8.1 GB total in use.

## Round 4: speedup

**Conclusion.** The ×9.8 of the first `--gpu` run (GPU-v1) was mostly the kernel tail: a launch lasts as long as its
slowest battle, and with one thread per battle a mixed warp runs as long as its slowest member, so about half of every
launch is spent with fewer than 50% of battles still running (≈1,650 s of the v1 run's 3,324 s running time). Then came
the many small halving-round launches (≈625 s) and the serial re-run of pool-overflow rows after the GPU (≈549 s). The
evidence page is `out/gpu-profile.html` (`node gpu/gpu-profile.mjs`); the A/B page is `out/recipe-ab-gpu.html`
(`node gpu/gpu-ab.mjs report`). Full GPU-v2 run (`out/evolve-recipe-ab-gpu2-halving`, the recipe-ab CPU
command with `--gpu`, 79 curated): **0h 30m 49s, ×17.6** against the CPU run's 9h 01m 36s (v1: 0h 55m 24s, ×9.8);
top-5 curated-100 quality 56.4% vs 57.6% CPU (−1.2 pts, inside the 3-pt noise); winner agreement 99.95% on a 2,000-battle
sample; a same-seed repro matches gen 0–4; 0 flagged rows. 724 battles/s end to end, short of the 1,500 b/s target: the
kernel is 91% of the run, and about half of each launch is its tail.

**What changed (new defaults).**

- **3v3 lookahead pool 2,048 entries, packed** (`gpu/gpu/kernels/pvp1v1.cuh`, 12-byte entries instead of the 768 wide
  ones; same 36,000 battles per launch on 10 GB, 0 register spills). `POOL_OVERFLOW` goes to 0: the v1 run's 231 flagged
  rows (reconstructed from its dumped batches) and every row of the 5-gen runs, peak pool 1,725. `verify_3v3`: 100%
  winner agreement, 0 flagged on the 2,436-battle set; `verify_1v1` PASS. `POGO_GPU_KERNEL=v1` still builds the old
  pool for comparison.
- **Flagged rows re-run on the CPU workers as each launch returns them, concurrently,** instead of one by one after the
  GPU (with pool 2,048 there are none left to re-run in practice).
- **CPU share `auto` is the default** (`--gpu-cpu-share auto`; a number still sets a fixed share). It is a deterministic
  function of the step's battle count, set from measured rates (`GPU_RATE_MODEL` in `src/engine/gpuExecutor.js`, fitted
  by `node gpu/fit-share.mjs`): a GPU step takes 3.9–11 s whatever its size, so the CPU share is sized to finish inside
  the shortest GPU step at 24.9 battles/s, which gives 95 battles a step. The plan expected a share near 0.06; measured,
  that share (0.05) made 5 generations 84% slower because the CPU workers then set the step time.
- **Every `--gpu` run writes `gpu-profile.json`** in its out dir (`src/evolve/gpuProfile.js`): per step and per
  generation seconds for memo, packing, transport, kernel body and tail, CPU share, flagged re-runs, waiting, GA,
  checkpoint and report, with the unattributed remainder (≤ 0.2% of wall on every 5-gen run).
- **The community file is set with `POGO_COMMUNITY_FILE`** (e.g. `data/archive/meta-teams-community-mega-great.json`
  between seasons, when `data/meta-teams-community.json` is absent) so a GPU run sees the same 79 curated teams as the
  CPU baseline; see RUNBOOK "--gpu".

**Not applied (measured, not worth it).** Bucketing battles by predicted length: even an oracle sort by the true length
gives ×1.04 per launch, and grouping by team gives ×0.75–0.85. Warp-per-battle layout (32 lanes per battle, prototype):
×1.22 at 5,000 battles and ×0.86 at 36,000, below the ×1.5 bar. Merging halving-round batches: each round's pairings
depend on the previous round's results, so there is nothing to merge across rounds. Register cap (128/64): spills
appear, no gain. Block size: 64 threads is best of 32–1024.

| 5 generations of the recipe-ab command (same seed) | wall | per-step flagged |
|---|---|---|
| v1 kernel, share 0.004 (before) | 150.5 s | 152 re-runs |
| + packed pool 2,048 (v2 kernel) | 121.6 s | 0 |
| + share auto (v2 defaults) | 121.5 s | 0 |

## Round 5: why v2 gave 724 b/s, not 1,500

Report: `node gpu/gpu-gap.mjs` → `out/gpu-gap.html` (sections: causes, bounds, v1 reconciliation, literature, ideas,
prototype results). Prototype benchmark: `cd gpu && uv run python -m gpu.gap_proto --dump ../out/gpu/dump-prof0`.

- **The gap is the tail.** The v2 5-gen run did 1,338,568 battles in 1,846 s of step wall (725 b/s); 1,500 b/s needed
  892 s, a gap of about 954 s. About 894 s of it is the launch tail: a launch lasts as long as its single longest battle
  (one thread per battle), so small launches leave the GPU mostly idle. Per-launch fixed cost (0.163 s × 301 steps) and
  CPU waiting (40 s) are minor.
- **Ideas, predicted b/s:** fewer/bigger launches 923; warp-per-battle for small launches 799; overlap 741 (pairing
  dependency between halving rounds); work queue 725 (the span already equals the longest battle, so a queue cannot
  shorten it). Top two prototyped.
- **Measured.** Warp kernel on the 5k slice: ×1.28 (below the ×1.3 bar, NO-GO; identical rows to v2; verify_3v3 100%,
  verify_1v1 PASS). Bigger launches (`--halving-rounds 2`): ×1.65 on the 5k step inside a 15k launch (kernel GO); the
  search effect is judged by the 5-gen run in the report. Queue kernel: smoke only, no gain.
- Experimental flags (default off): `POGO_GPU_KERNEL=warp|queue`, `POGO_GPU_WARP_BELOW` (default 5000).
- The verdict against 1,500 b/s stays FAIL until a run meets it.

## Round 6: scheduler (time-sliced queue, load balancing)

Report: `node gpu/gpu-sched.mjs` → `out/gpu-sched.html` (iteration table, per-launch occupancy timelines, predictor,
move-ahead log, determinism). Bench: `gpu/gpu/sched_bench.py`; 5-gen runs `out/gpu/sched/run5.sh`.

- **Conclusion.** Best config `POGO_GPU_KERNEL=slice POGO_GPU_BIN=on` (requeue, T=64, small launches spread over all
  warps, length binning), CPU share 0: 1,315 b/s on the 5-gen run vs 885 for v2 at share 0 (×1.49; medians of 10 runs
  each, 2026-10-16). Clears ×10 over CPU, misses 1,500 b/s on v2's command: FAIL. Same search results as v2
  (checkpoints equal apart from timing, gen 4 and gen 19 of a 20-gen run).
- **Iterations (5-gen b/s, median of 10):** v2 885; slice requeue + spread 1,309; + binning 1,315; spread off 1,282.
  The first runs (2026-10-15 evening: 795 / 971 / 942 / 793) were slower in every GPU step; the repeats agree within a
  few percent. Streams, move-ahead, handoff + spread, and bin + streams + ahead raised idle on both slices and were
  dropped. Stop rule met (two consecutive iterations under +5%).
- **Bigger launches (fewer halving rounds), slice + bin, 5 runs each:** `--halving-rounds 2` 1,535 b/s, full grid
  (`0`) 1,618 (20-gen: 1,517 / 1,658); v2 1,199 / 1,225. Not v2's command: more battles per generation (28.5k / 35.9k
  vs 21.3k), a different search (top 12 at gen 4: 6 / 2 of 12 shared with halving 3), and more GPU seconds per
  generation (18.6 / 22.2 vs 16.2). 20-gen repeats (2 runs each) match their first runs exactly at gen 19.
- **Kernel bench rerun (night, current kernel):** 36k-battle launch, slice 1,973 b/s, slice + bin 1,929 (evening:
  1,810 / 1,737, before the ticket fix that lets idle lanes leave); span ×0.92 / ×0.94 of paired v2.
- **Idle left:** ~92% of threads on a 5k launch (too small to fill the GPU), ~36% on 36k (tail of longest series).
- **Flags (experimental, off by default):** `POGO_GPU_KERNEL=slice`, `POGO_GPU_SLICE_TURNS`, `POGO_GPU_SERIES`,
  `POGO_GPU_SLICE_MODE=handoff|requeue`, `POGO_GPU_SPREAD=off`, `POGO_GPU_BIN=on`, `POGO_GPU_STREAMS=N`,
  `POGO_GPU_AHEAD=on`. `--gpu` runs at CPU share 0 this round; re-add the share once GPU speed stabilises.
- **Next:** choose the search trade-off (halving 3: shortest generation; halving 2: over 1,500 b/s, +2.4 s GPU per
  generation), then re-add the CPU share.

## Round 7: width picker and island halving

Report: `node gpu/gpu-width.mjs` → `out/gpu-width.html` (linked from `gpu-sched.html`), told as seven steps from
the question (1,315 → 1,500 b/s?) to the answer: width, auto picker, island halving, population, full runs, correctness,
answer. Each step has a diagram or chart, at most three findings and a "So →" line into the next; tables sit in
collapsed sections.
Bench: `gpu/gpu/width_bench.py` (writes `gpu/gpu/width-table.json`); runs: `out/gpu/width/chain.sh`.

- **Width bench (threads per battle G = 1..32, slices 1k–36k, median of 5 launches).** No width wins by much: at 5k
  G=1 929 b/s, G=16 924, G=32 915; at 36k G=2 2,045, G=1 1,981, G=32 1,857. Mixed widths in one launch (`mix`, top
  5–20% by predicted length on wide lanes) are slower than G=1 at every size (36k: 1,814–1,931). Every width, mix and
  auto pass verify (same results as the CPU engine).
- **Auto picker.** Fill formula (widest G that still covers every resident lane), bounded by the bench table: a width
  is allowed when it is within 2% of the bucket's best. At 5% auto picked G=4 at 2.5k, which a recheck measured 6%
  under G=16; 2% fixed it. Auto is within 5% of the best fixed width at every size (737 / 587 / 926 / 1,326 / 1,686 /
  2,031 b/s at 1k–36k).
- **5-gen run (v2's command, auto, 5 runs):** median 1,332 b/s (1,324–1,365) vs round 6's 1,315 (+1.3%).
- **Island halving (`POGO_GPU_ISLAND=on`, experimental, off by default).** Every halving round of a generation step runs
  in one GPU launch: 20 launches in 20 generations, and the host reference recomputes each island cut with 0
  mismatches in all 14 island runs. It is slower than standard halving: halving 3 17.6 vs 12.1 s per warm
  generation, halving 2 15.7 vs 13.4 s (+17.6%). The reason is that one launch uses FIFO tasks with no slicing or
  length order, so each island round waits for its longest battle. Finalists on the gen-19 pool of 300 opponents
  (CPU engine): mean win% of the top 12 is 57.8% (island halving 3) and 57.7% (island halving 2), against 57.3%
  (halving 3), 57.1% (halving 2) and 57.0% (full grid). The search quality is about the same.
- **Population (20 gens, median of runs).** At halving 3, b/s is 1,274 at 1×, 1,505 at 1.5× and 1,521 at 2×; bigger
  launches fill the GPU. Halving 2 runs at 1,535, 1,738 and 1,675 b/s, and full grid at 1,686, 1,653 and 1,644.
- **Best setting (lowest warm wall per generation at pop 1×):** G=16 with halving 3, 11.9 s per warm generation,
  4.3 min total, 1,288 b/s, which is below the 1,500 bar. Auto with halving 3 is 12.1 s (1.6% slower). At pop 1×,
  only halving 2 (1,535) and full grid (1,686) clear 1,500 b/s, and they do it by running more battles per generation.
- **Correctness.** verify_3v3 and verify_1v1 PASS for every width, mix and auto. Every setting's same-seed runs
  write identical checkpoints (18 settings, 20 checkpoints each). A CPU-only 2-gen run with round-7 code is
  identical to round 5's `out/gpu/gap/cpu2b`.
- **Run notes.** Two pop-2× island runs were slowed by other load on the machine: isl-h2-p2-r2 ran at 1,048 b/s (its
  gen 0 took 619 s against 135 s) and isl-h3-p2-r2 at 1,121 b/s. Each setting got a clean third run, so the median
  of 3 outvotes the slowed one, and the page marks runs more than 15% under their median as "slowed". At the user's
  request, isl-h3-p2-r2 was stopped after its gen-13 checkpoint to free memory, then resumed from that checkpoint.
  Its 20 checkpoints are identical to isl-h3-p2's. Its total wall leaves out the 122.3 min pause and the resumed
  process's 2.8 s of setup. The pause starts at the gen-13 checkpoint, so the unfinished gen 14 is also dropped.
- **Next:** re-add the CPU share at the chosen setting. Retire the probe: its picks match the formula in 3 of 6
  buckets, and the widths are now fixed per bucket in `width-table.json`.

## Round 8: profile-first study

Report (since round 9 kept as detail pages): `node gpu/gpu/study/round8-page.mjs` → `out/gpu/study/detail/round8-*.html`: four parts, each closed
by its own "Conclusion of this part" box. A, what to do: a five-point summary, the recommendation box (each line's runs
table sits above its gain), the ranked change list (plain-words meaning, data table, gain beside both run-to-run
spreads, one-line "Do next"). B, where the time goes: steps 1–3 (time split, profile, width). C, what the prototypes
changed: steps 4–6 (chain runs, morning A/B, correctness). D, background: steps 7–8 (literature, forks). Each step has
one picture and a "supports: summary point N / recommendation line N" tag; glossary last. `python3 gpu/gpu/study/check_round8.py` re-derives every number on the page
(`out/gpu/study/detail/check-round8.log`, 0 mismatches); `node gpu/gpu/study/phone.mjs` renders every section at 390 px
(`out/gpu/study/phone/*.png`) and fails on any "…", clipped text, block over 3 lines or horizontal scroll. Research forks live in `gpu/gpu/study/<fork>/`
(`variant.py`, selected by `POGO_GPU_STUDY=<fork>`, off by default) with their data in `out/gpu/study/<fork>/`; the
timed runs ran one at a time in `out/gpu/study/chain.sh` (52 stages, all exit 0, 10-gen standard halving-3 runs).

- **Profile.** Nsight Compute is blocked on this Windows/WSL machine (`ncu` → `ERR_NVGPUCTRPERM`; enabling GPU
  performance counters for all users in the NVIDIA Control Panel needs a Windows admin), so in-kernel clock timers and
  SASS counts stand in. Achieved occupancy 11.4 / 8.6 / 14.4% (5k / 10k / 36k launches) against 16.7% theoretical
  (255 registers per thread, 8 of 48 warps per SM). 2.8 / 4.3 / 9.6 of 32 threads per warp step do useful work. SMs
  have work 73 / 56 / 88% of each launch. Stack is 39,088 B per thread, and 19.7% of the kernel's instructions are
  local-memory loads/stores. Stall reasons, L1/L2 hit rates and issue-slot use need the blocked counters.
- **Time split.** The GPU is busy for 92% of a warm generation, and 43% of it is tail (the GPU waiting on a launch's
  last, longest battles). Host work and the GA are the other 8%.
- **GPU drift.** The same production command ran 13.36 / 13.49 s per warm generation at 21:18 ET and 11.66 / 11.66 at
  04:44 ET (−13%). Each prototype is therefore compared with the two production runs nearest it in the chain; back-to-
  back production runs agree within 0.35 s.
- **Faster, verified (100% winner agreement, 0 flagged, checkpoints identical to production):** cold helpers as real
  function calls (`occ` fork, 11 `__noinline__` edits, −0.6 s/gen: 11.52 vs 12.16 in the same hour) and battle state
  in compact on-chip form (`stack` fork, −0.6 s/gen). Both are study variants; production is unchanged. A run of the
  production path with only a timing log (`streams-time`) also read −0.6 against its neighbours.
- **Morning A/B (`out/gpu/study/ab.sh`, 3 interleaved rounds of defaults / `stack` / `occ`, 08:37–08:57 ET).** Defaults
  11.76 / 11.66 / 11.69 (spread 0.11); compact on-chip state 11.04 / 11.06 / 11.39 (−0.5 s, spread 0.34: beats both
  spreads, not noise); cold helpers as calls 11.38 / 12.19 / 11.32 (−0.1 s, spread 0.88: within noise, needs a longer
  A/B). The recommendation box therefore turns on `stack` only (11.7 → 11.2 s per warm generation).
- **Slower or no gain:** plain work-queue kernel +7.3 s/gen, lockstep one-slice-per-launch +6.2, smaller search pool
  with rare re-run +4.4, two-stream overlap +2.0, register caps for more warps +0.3 (any cap spills ~1 KB per thread),
  splitting one battle's look-ahead over its threads 2.4–4× slower in the bench. A CPU share of 0.003–0.01 gives no
  gain beyond noise and changes the checkpoints (same-share runs match each other).
- **Width calibration.** 68 real launches (10–14 per size bucket) were replayed at G = 1–32 on identical battles (`out/gpu/width-calib-NVIDIA-
  GeForce-RTX-3080.json`). No width beats G=1 by more than 3% in any size bucket, so auto now uses G=1 everywhere
  ("width does not matter here"). `--gpu` loads the file (`gpu width -- calibration loaded: ...`), or builds a bucket's
  row on that bucket's first launch when the file is missing (`gpu width -- calibrating width for NVIDIA GeForce RTX 3080… 68.2 s`,
  `out/gpu/study/width/calib-line.log`). `POGO_GPU_PROBE` and the live prober are removed. This
  supersedes round 7's width question.
- **Correctness.** A CPU-only 2-gen run and a default-GPU 5-gen run with round-8 code write checkpoints identical to
  round 7's (`out/gpu/study/det-r7.txt`).
- **Next:** port the `stack` change into `gpu/gpu/kernels`; re-A/B `occ` over more rounds; build early release of
  sure next-round winners only together with an in-kernel append queue for the tail.

## Round 9: filling the tail

Report: `node gpu/gpu-study.mjs` → `out/gpu-study.html` (Summary, what was built, three facts, what to do, glossary);
round-8 material moved to `out/gpu/study/detail/*.html`. `python3 gpu/gpu/study/check_page.py` recomputes every number
on the page from the raw logs (`out/gpu/study/check.log`); `node gpu/gpu/study/phone.mjs` shoots it and the explainer
at 390 px (`out/gpu/study/phone/`). Plain-words version: `docs/gpu-round9-explained.md`. All timed runs went one at a
time through `out/gpu/study/r9chain.sh` under `flock out/gpu/study/gpu.lock`.

- **What was built.** `POGO_GPU_STUDY=tail` (`gpu/gpu/study/tail/variant.py`, kernel `battle3v3_tail`): once half the
  threads of a launch are idle (`POGO_GPU_TAIL_IDLE=0.5`, a design choice, not tuned by measurement), idle threads run the next halving round's likely battles.
  Their results only enter the battle memo, so a checkpoint never changes, and a filler battle never extends the launch
  (it stops within one lookahead step of the main battles' end). `tail,certain` adds the battles of teams already sure
  to pass the cut (a JS port of the certainty check) through an in-kernel queue fed while the launch runs. Both are off
  by default. Each launch logs speculated, kept and discarded counts (`gpu tail -- ...`).
- **Same results.** verify_3v3 through the tail kernel: all agree, 0 flagged, for both flags. 5-gen checkpoints of
  `tail` and `tail,certain` equal the default's; the 100-gen full runs equal the default's too (100 of 100 checkpoints
  each). CPU-only 2-gen and default-GPU 5-gen checkpoints equal round 8's (`out/gpu/study/det-r9.txt`).
- **Speed (reference A/B, started 2026-10-17 18:34 ET, 3 rounds × default/tail/certain, 10 gens, halving 3).** Warm
  s/gen: default 12.23 (spread 0.13), tail 11.83 (0.26), tail,certain 11.59 (0.73). Tail beats both spreads (−0.41 s);
  certain does not (−0.64 s inside its own 0.73 spread). Tail share rises from 42.3% to 55.4%: the filler work
  sits in the tail, and later rounds find battles already done, so the non-tail kernel time falls (about 6.2 → 3.7 s/gen). Per launch with a next-round pool (2 of 3 per generation) the filler ran 3,315 battles; 65% finished in time and 49% were later used.
- **Full runs (100 gens, standard).** Start to process exit: default 17.4 min (19:48–20:05 ET), tail 17.5 min (18:54–19:12 ET),
  tail,certain 17.1 min (19:12–19:29 ET); one run each, so no spread. Warm s/gen 10.08 / 10.26 / 10.05: the 10-gen gain of tail did
  not carry over to 100 gens. One run per variant, so there is no noise measure for the 100-gen differences.
- **SM-active timeline** (replay of dumped launches on the fixed code, 19:44 ET, `out/gpu/study/prof/tail-timeline.json`;
  the next-round pool is a stand-in, up to 6,000 battles of another dumped launch): on the 10k launch SMs are busy 48.1%
  of the launch with the default, 55.4% with tail, 60.2% with tail,certain, but the launch ends 0.54 s later with
  tail. A launch still ends with its longest battle. The Nsight cards on the page do not include this share.
- **Nsight Compute** (counters now allowed; `out/gpu/study/prof/ncu/summary.json`, 5k and 10k launches at base
  clocks): long-scoreboard waits 51.5% of all warp cycles (55.0% of non-issuing cycles), issue-slot use 12.5%, achieved occupancy 15.6%, local memory
  99.87% of L1 bytes (844 GB in a 3.9 s launch), L1 hit 82.9%, L2 hit 86.9%. The 36k launch and the tail kernel have no
  Nsight numbers: replay ends in `LaunchFailed (CUDA error 999)` and resets the Windows display driver, and a launch the
  host feeds while it runs cannot be replayed.
- **Four bugs the long runs found**, all fixed before the reference runs: a state read could run before its upload
  (now waits on the upload); late filler battles ran past the launch end (now stop within one lookahead, and the next
  launch waits for them); a new CUDA stream per launch kept cupy's freed blocks from being reused, so the pool grew
  ~7 MB a launch and late generations slowed (the 100-gen tail run took 134 min, 14:26–16:39 ET; 17.5 min after the fix; one module stream now); an early read of the timing
  buffer saw old bytes from reused memory and overflowed the int32 reply (buffer zeroed per launch, unwritten rows
  dropped).
- **GPU time.** About 7 h of chain stages against the ~3 h budget, because the four bugs forced three chain restarts.
  Cut: ncu on the tail kernel and the 36k launch (driver resets), a second full run per variant.
- **Next:** cut more bytes from each battle's state (round 8's compact state saved 0.5 s/gen); local memory is 99.9% of L1
  traffic, so that targets the long-scoreboard waits. Shared memory is too small to hold it (100 KB per SM vs ~39 KB per battle).
  Keep the tail flags off.

## Round 10: as fast as possible (100-gen re-measure, lean state, battle cap)

Branch `gpu`, 2026-10-18. The user's ask: use what the rounds taught to make `--gpu` runs as fast as possible. Numbers come only from `out/gpu/r10/runs.json` (`python3 gpu/gpu/r10/runs.py`) and the files `python3 gpu/gpu/r10/check.py` re-reads (it rebuilds this section with `gpu/gpu/r10/section.py` and fails on any difference). Warm s/gen = mean wall of generations 2 and later from `gpu-profile.json`; spread = max - min; rule (R1): a variant wins only if its mean beats the default's mean by more than both spreads, else "no gain". Clock times are US Eastern.

### 100-gen runs (R3): one session, start 19:47 EDT, order default / stack / occ / tail / default, same seed
| run | start ET | total wall (start to exit) | warm s/gen | vs default mean | checkpoints vs default-1 | verdict |
|---|---|---|---|---|---|---|
| default-1 | 19:47 EDT | 1101 s (18.4 min) | 10.75 | - | - | - |
| stack | 20:05 EDT | 1056 s (17.6 min) | 10.30 | -0.43 | 100/100 identical | wins |
| occ | 20:23 EDT | 1081 s (18.0 min) | 10.55 | -0.18 | 100/100 identical | wins |
| tail | 20:41 EDT | 1113 s (18.5 min) | 10.84 | +0.11 | 100/100 identical | no gain |
| default-2 | 20:59 EDT | 1100 s (18.3 min) | 10.71 | - | 100/100 identical | - |
Default mean 10.73, spread 0.03 (two runs); one run per variant, so its own spread is 0 and "wins" means beating the default mean by more than 0.03. Checkpoints compared by `gpu/gpu/study/runs.mjs` compareRuns (timing fields ignored). Nothing was turned on by default: this table is the decision input.

### 30-gen decision table (R1): session s1, start 23:13 EDT, 3 passes, each pass default then the variants, same seed
| variant | warm s/gen, 3 runs | mean | spread | vs default | verdict | run starts ET |
|---|---|---|---|---|---|---|
| default | 11.16 / 9.67 / 9.75 | 10.19 | 1.49 | - | - | 23:13, 23:36, 23:54 |
| lean (step 2) | 8.38 / 7.52 / 7.52 | 7.80 | 0.86 | -2.39 | wins | 23:19, 23:41, 00:00 |
| cap 192 | 9.44 / 9.30 / 9.22 | 9.32 | 0.22 | -0.87 | no gain | 23:24, 23:45, 00:04 |
| lean,cap 192 | 7.73 / 7.83 / 7.88 | 7.81 | 0.14 | -2.38 | wins | 23:29, 23:50, 00:09 |

### lean (R4): steps are cumulative; results byte-identical to the default path (R5)
| step | what | stack B/thread | regs | spill st/ld B | 5k replay span | 10k span | 36k span | verify_3v3 |
|---|---|---|---|---|---|---|---|---|
| default | production slice kernel | 39,088 (100%) | 255 | 28/36 | 3.17 s (+0.0%) | 9.84 s (+0.0%) | 20.59 s (+0.0%) | 100.00% / 0 flagged |
| stack | round-8 compact Move / Mon | 36,128 (92%) | 255 | 0/0 | - | - | - | - |
| lean1 | compact2 fields (8/16-bit act / timer / QA) on stack | 35,440 (91%) | 255 | 0/0 | 3.05 s (-3.9%) | 9.50 s (-3.4%) | 18.99 s (-7.8%) | 100.00% / 0 flagged |
| lean2 | + binary-search queue insertion (LEAN_BSEARCH) | 35,440 (91%) | 255 | 0/0 | 2.34 s (-26.3%) | 5.29 s (-46.3%) | 16.11 s (-21.8%) | 100.00% / 0 flagged |
| lean3 | + noinline cold helpers (LEAN_NI) | 35,472 (91%) | 255 | 48/76 | 2.08 s (-34.4%) | 4.48 s (-54.4%) | 13.50 s (-34.4%) | 100.00% / 0 flagged |
| lean4 | + half lookahead pool (MAXQ 1024) | 21,136 (54%) | 255 | 48/76 | 2.09 s (-33.9%) | 4.91 s (-50.1%) | 14.13 s (-31.4%) | 100.00% / 0 flagged |
| lean2q | step 2 + half pool, no noinline | 21,104 (54%) | 255 | 0/0 | 2.38 s (-24.8%) | 5.18 s (-47.4%) | 16.47 s (-20.0%) | 100.00% / 0 flagged |
Means used: 8/16-bit field packing (step 1), fewer dependent local loads in the lookahead queue (step 2: binary search for the insertion point, same index and order as the scan), noinline of cold helpers (step 3), half the per-thread pool (step 4: a battle whose pool passes 1024 is flagged and re-run on the CPU exactly as at 2048, so run results stay identical; replay rows differ only in those flagged rows). Replays: 5k = prof batch 7, 10k = batch 6, 36k = batches 0-2 merged, median of 3 reps, vs the default replay of the same launch. Registers stay at 255 at every step (a register target below 255 spilled and lost in round 8), so occupancy stays at 8 warps/SM and the >=25% target is not reached; the <=50% local-bytes target is only approached by the pool halving (54% of today's stack bytes), and the spilling step 4 is not the default: plain `POGO_GPU_STUDY=lean` is step 2 (0 spill).
Steps were judged on these replays instead of 30-gen sessions (the user asked for the smallest test that answers the question); only step 2 went to the A/B. Early-stop rule: step 1 moved the 10k launch under 4%, step 3 over 2 is within replay noise, so the A/B has one lean row.
Nsight Compute before / after (R4; `out/gpu/r10/ncu/summary.json`, base clocks, kernel replay, same fields as round 9):
| launch | variant | kernel s | achieved occupancy | long_scoreboard share | local bytes | issue-slot use |
|---|---|---|---|---|---|---|
| 5k | default | 3.88 | 15.6% | 51.5% | 842 GB | 12.5% |
| 5k | lean2 | 2.73 | 16.0% | 31.1% | 760 GB | 13.3% |
| 10k | default | 11.85 | 15.3% | 54.6% | 1955 GB | 12.3% |
| 10k | lean2 | 6.14 | 15.9% | 32.0% | 1749 GB | 13.6% |
- cpu-only 2-gen (round 10 code) vs out/gpu/study/cpu2-r9 (round 9): evolve-gen0.json: IDENTICAL; evolve-gen1.json: IDENTICAL
- POGO_GPU_STUDY=lean 5-gen vs default 5-gen: IDENTICAL (5 checkpoints, timing fields ignored)

### cap (R6/R7): cap on pool entries per lookahead decision; gate = agreement with the CPU engine on the 2,436-battle verify set
| cap | verify agreement / flagged / win-rate delta | gate (>=99.5%, +-1 pp) | capped in verify | 36k replay tail after 50% done | 36k span | 10k tail | capped in 36k |
|---|---|---|---|---|---|---|---|
| 128 | 99.33% / 0 flagged / +0.00 pp | cap: fails agreement at 128 | 141 | 1.23 s (-53.8%) | 16.87 s (-18.1%) | 1.27 s (-73.5%) | 2170 |
| 192 | 99.58% / 0 flagged / +0.10 pp | pass | 47 | 1.92 s (-28.1%) | 19.35 s (-6.0%) | 1.47 s (-69.3%) | 1076 |
| 256 | 99.79% / 0 flagged / +0.12 pp | pass | 25 | 2.57 s (-3.9%) | 19.22 s (-6.7%) | 2.08 s (-56.7%) | 846 |
| 512 | 100.00% / 0 flagged / +0.00 pp | pass | 0 | 2.13 s (-20.3%) | 18.40 s (-10.6%) | 3.88 s (-19.0%) | 148 |
R6 asked for a cap value that cuts the 36k tail by >=30% in a replay: none that passes the agreement gate does; 128 cuts it most and fails agreement, so the A/B used cap 192 (largest tail cut among the passing values). Every launch logs `gpu cap -- N of M battles hit the pool cap C`.
Top-12 finalists of each 30-gen run re-battled on the CPU engine against the gen-29 opponent pool of evolve-gpu8-r10-s1-default-1 (round-7 method, 300 opponents): mean CPU win s1-default-1 57.60% (+0.00 pt); s1-default-2 57.60% (+0.00 pt); s1-default-3 57.60% (+0.00 pt); s1-cap-1 57.49% (-0.11 pt); s1-cap-2 57.49% (-0.11 pt); s1-cap-3 57.49% (-0.11 pt); s1-leancap-1 57.49% (-0.11 pt); s1-leancap-2 57.49% (-0.11 pt); s1-leancap-3 57.49% (-0.11 pt). Pass = within 1 pt of the default run.

### What to turn on (three lines, numbers from `runs.json`)
1. `POGO_GPU_STUDY=stack`-class state packing is real: at 100 gens stack wins (-0.43 s/gen vs the default mean 10.73, default spread 0.03); occ and tail: see the 100-gen table.
2. `POGO_GPU_STUDY=lean` (step 2, byte-identical): wins at 30 gens (-2.39 s/gen, mean 7.80, spread 0.86 vs default 10.19, spread 1.49).
3. `POGO_GPU_STUDY=lean,cap`: wins at 30 gens (-2.38 s/gen, mean 7.81, spread 0.14 vs default 10.19, spread 1.49); cap changes winners, so it is a trade the user decides on with the agreement numbers above.
## Round 11: 30-gen A/Bs of every lean step, Nsight on every variant, kernel iteration, top 3 to implement

Branch `gpu`, 2026-10-21. Numbers come only from `out/gpu/r10/runs.json` (speed), `out/gpu/r10/ncu/summary.json` (Nsight) and the files `python3 gpu/gpu/r11/check.py` re-reads; it rebuilds this section and fails on any difference. Yardstick: warm s/gen = mean of generations 2+ over a 30-gen standard run, 3 interleaved runs per variant with a default run in every pass; spread = max - min; "wins" = mean beats the session's default mean by more than both spreads; a gain inside the spreads is "insufficient". Clock times are US Eastern. Nothing is on by default.

### 30-gen session s2: start 11:11 EDT, passes interleaved, each pass default then the variants, same seed
| variant | warm s/gen, runs | mean | spread | vs default | verdict | spill st/ld B | proof | run starts ET |
|---|---|---|---|---|---|---|---|---|
| default | 9.01 / 9.59 / 9.88 | 9.50 | 0.87 | - | - | 28/36 | - | 11:11, 11:44, 12:11 |
| lean 1 | 8.66 / 8.99 / 9.59 | 9.08 | 0.93 | -0.42 | insufficient: 3 runs, needs 3 more | 0/0 | 3/3 runs 30/30 identical; verify 100.00% / 0 flagged | 11:16, 11:49, 12:16 |
| lean 2 | 6.98 / 7.37 / 7.90 | 7.42 | 0.92 | -2.08 | wins | 0/0 | 3/3 runs 30/30 identical; verify 100.00% / 0 flagged | 11:23, 11:54, 12:21 |
| lean 3 | 6.47 / 6.90 / 7.20 | 6.86 | 0.73 | -2.64 | wins | 48/76 | 3/3 runs 30/30 identical; verify 100.00% / 0 flagged | 11:29, 11:58, 12:25 |
| lean 4 | 7.23 / 7.57 / 8.08 | 7.63 | 0.85 | -1.87 | wins | 48/76 | 3/3 runs 30/30 identical; verify 100.00% / 0 flagged | 11:33, 12:02, 12:29 |
| lean 2q | 7.47 / 8.63 / 8.75 | 8.28 | 1.28 | -1.21 | insufficient: 3 runs, needs 3 more | 0/0 | 3/3 runs 30/30 identical; verify 100.00% / 0 flagged | 11:37, 12:06, 12:34 |
### 30-gen session s3: start 13:31 EDT, passes interleaved, each pass default then the variants, same seed
| variant | warm s/gen, runs | mean | spread | vs default | verdict | spill st/ld B | proof | run starts ET |
|---|---|---|---|---|---|---|---|---|
| default | 9.48 / 9.67 / 9.68 | 9.61 | 0.20 | - | - | 28/36 | - | 13:31, 13:55, 14:20 |
| lean 5 | 7.20 / 7.25 / 7.28 | 7.24 | 0.08 | -2.37 | wins | 0/0 | 3/3 runs 30/30 identical; verify 100.00% / 0 flagged | 13:36, 14:01, 14:25 |
| lean 6 | 6.42 / 6.56 / 6.52 | 6.50 | 0.14 | -3.11 | wins | 48/76 | 3/3 runs 30/30 identical; verify 100.00% / 0 flagged | 13:40, 14:04, 14:29 |
| lean 3 + cap192 | 6.85 / 6.93 / 7.29 | 7.02 | 0.44 | -2.59 | wins | 48/76 | verify 99.58% / 0 flagged / +0.10 pp; finalists -0.11 pt | 13:44, 14:08, 14:32 |
| lean 4 + cap192 | 6.90 / 6.93 / 8.22 | 7.35 | 1.32 | -2.26 | wins | 48/76 | verify 99.58% / 0 flagged / +0.10 pp; finalists -0.11 pt | 13:47, 14:12, 14:36 |
| lean 2q + cap192 | 7.71 / 7.68 / 7.52 | 7.64 | 0.19 | -1.98 | wins | 0/0 | verify 99.58% / 0 flagged / +0.10 pp; finalists -0.11 pt | 13:51, 14:16, 14:41 |
### 30-gen session s4: start 16:00 EDT, passes interleaved, each pass default then the variants, same seed
| variant | warm s/gen, runs | mean | spread | vs default | verdict | spill st/ld B | proof | run starts ET |
|---|---|---|---|---|---|---|---|---|
| default | 9.24 / 9.54 / 9.58 | 9.46 | 0.34 | - | - | 28/36 | - | 16:00, 16:15, 16:29 |
| lean 1 | 8.89 / 9.07 / 9.31 | 9.09 | 0.43 | -0.37 | insufficient: 3 runs, needs 3 more | 0/0 | 3/3 runs 30/30 identical; verify 100.00% / 0 flagged | 16:05, 16:20, 16:34 |
| lean 2q | 7.99 / 8.26 / 8.81 | 8.35 | 0.82 | -1.11 | wins | 0/0 | 3/3 runs 30/30 identical; verify 100.00% / 0 flagged | 16:10, 16:25, 16:39 |

### Nsight Compute (`out/gpu/r10/ncu/summary.json`; 5k = batch 7, 10k = batch 6; base clocks, kernel replay)
| launch | variant | kernel s | occupancy | long_scoreboard | top stall | local GB | issue-slot use |
|---|---|---|---|---|---|---|---|
| 5k | default | 3.88 | 15.6% | 52% | long_scoreboard 52% | 842 | 12.5% |
| 5k | lean1 | 3.63 | 15.7% | 36% | long_scoreboard 36% | 803 | 13.4% |
| 5k | lean2 | 2.73 | 16.0% | 31% | no_instruction 34% | 760 | 13.3% |
| 5k | lean3 | 2.54 | 14.8% | 38% | long_scoreboard 38% | 756 | 16.1% |
| 5k | lean4 | 2.52 | 14.8% | 38% | long_scoreboard 38% | 756 | 16.2% |
| 5k | lean2q | 2.90 | 16.0% | 31% | no_instruction 34% | 760 | 13.4% |
| 5k | lean5 | 2.65 | 16.0% | 29% | no_instruction 36% | 741 | 13.5% |
| 5k | stack | 3.64 | 15.6% | 38% | long_scoreboard 38% | 822 | 13.4% |
| 5k | leancap | 2.77 | 15.9% | 31% | no_instruction 34% | 761 | 13.4% |
| 10k | default | 11.85 | 15.3% | 55% | long_scoreboard 55% | 1955 | 12.3% |
| 10k | lean1 | 11.24 | 15.4% | 40% | long_scoreboard 40% | 1862 | 13.4% |
| 10k | lean2 | 6.14 | 15.9% | 32% | no_instruction 32% | 1749 | 13.6% |
| 10k | lean3 | 5.22 | 15.8% | 40% | long_scoreboard 40% | 1735 | 16.3% |
| 10k | lean4 | 5.35 | 15.8% | 40% | long_scoreboard 40% | 1741 | 16.3% |
| 10k | lean2q | 6.20 | 15.8% | 32% | long_scoreboard 32% | 1755 | 13.7% |
| 10k | lean5 | 6.19 | 15.9% | 30% | no_instruction 34% | 1707 | 13.7% |
| 10k | stack | 10.92 | 15.4% | 42% | long_scoreboard 42% | 1906 | 13.3% |
| 10k | leancap | 6.65 | 15.8% | 32% | no_instruction 32% | 1747 | 13.7% |

Unresolved at the end of the budget: lean 1 (session s2: insufficient: 3 runs, needs 3 more); lean 2q (session s2: insufficient: 3 runs, needs 3 more); lean 1 (session s4: insufficient: 3 runs, needs 3 more)

### Top 3 ideas to implement (ranked by s/gen saved; a 100-gen run is the 30-gen mean x 100)
1. **lean 6**: saves 3.11 s/gen (mean 6.50, spread 0.14 vs default 9.61, spread 0.20, session s3) = 5.2 min per 100-gen run. Proof: 3/3 runs 30/30 identical; verify 100.00% / 0 flagged. Change: make LEAN_STEPS "6" (compact2 fields, binary-search queue, turn-keyed int queue, noinline cold helpers) the kernel the standard run builds, via POGO_GPU_STUDY=lean POGO_GPU_LEAN=6 becoming the default in gpu/gpu/study/lean/variant.py and the run wrapper. Targets long_scoreboard: the turn is read from the key, so no dependent pool load per queue slot. Interacts: Supersedes lean 3 and lean 5; spills 48/76 B like lean 3. Cap can sit on top (untested with step 6).
2. **lean 3 + cap192**: saves 2.59 s/gen (mean 7.02, spread 0.44 vs default 9.61, spread 0.20, session s3) = 4.3 min per 100-gen run. Proof: verify 99.58% / 0 flagged / +0.10 pp; finalists -0.11 pt. Change: turn on POGO_GPU_CAP=192 with lean 3 (or lean 6). It changes winners slightly, so it needs its own opt-in flag even after the gate passes. Interacts: Gain measured against the default, not on top of lean 6; the two attack the same long lookahead cost, so expect less than the sum.
3. **lean 5**: saves 2.37 s/gen (mean 7.24, spread 0.08 vs default 9.61, spread 0.20, session s3) = 3.9 min per 100-gen run. Proof: 3/3 runs 30/30 identical; verify 100.00% / 0 flagged. Change: make LEAN_STEPS "5" the default: step 2 plus the turn-keyed queue, 0 spill, 255 registers. The zero-spill choice if lean 6's spills are unwanted. Interacts: Lean 6 is lean 5 plus noinline helpers, so take one of the two.

Glossary: **stack** = the compact per-battle state (smaller Move / Mon structs) the kernel keeps in local memory; **occ** = occupancy edits (noinline cold helpers, fewer live registers) to fit more warps per SM; **lean** = stack + 8/16-bit fields + a binary-search lookahead queue, with steps 1-6 adding noinline, a half pool and a turn-keyed queue; **cap** = give up the lookahead when its pool reaches N entries (changes some winners, so it must pass the agreement gate); **spill** = values the compiler cannot keep in the 255 registers and parks in slow local memory, so each use costs a load.
