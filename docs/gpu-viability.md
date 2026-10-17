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
