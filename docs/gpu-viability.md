# GPU viability: porting the 3v3 battle to CUDA (rounds 2-4)

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
- Residual differences (226 of 89,355 form-changer 1v1 scenarios, mostly `turnsToKO`; 4 of 18 form-changer fixture pairings): not traced to a vendor line.
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
| previously flagged (form changers) | double | 89,355 | 226 (0.25%) | rating 25, hp 18/12, energy 13/15, turnsToKO 124/87, rngDraws 7 |
| previously flagged (form changers) | float32 | 89,355 | 226 (0.25%) | same counts; winner agreement 99.99%, win-rate delta +0.00 pp → PASS |
| rest | double | 1,103,981 | **0** | |
| rest | float32 | 1,103,981 | 195 (0.018%) | rating 182 |

rankings-1500 leads: 398 pairs, 0 rating and 0 any-field mismatches (both builds).

**3v3** (`gpu.verify_3v3`): 36 fixtures plus 2,400 real gen-0 battles (436 with a form changer).

| set (float32) | battles | flagged invalid | winner mismatches | survivorsHp | turn count |
|---|---|---|---|---|---|
| previously flagged (form changers) | 436 | 0 | 0 | 1 | 2 |
| rest | 1,964 | 0 | 0 | 8 | 8 |
| fixtures (incl. 18 form-changer lead pairings) | 36 | 0 | 1 | 4 | 5 |

Double build: previously flagged 0/0/0 winner/HP/turn mismatches (435 compared), rest 0/0/0 (1,946 compared), fixtures 1/4/5; no pass bar applied to double.
Float32 (pool 768, 0 flagged; the double row above is from the earlier pool-320 run): team-A win rate pvpoke 49.94% vs kernel 49.94% (+0.00 pp) → PASS; per-matchup winner agreement 100.00% → PASS; previously-flagged subset alone 436 battles, 100.00%, +0.00 pp.
The fixture mismatches are all in form-changer lead pairings (`forms-02`, `forms-11`, `forms-21`, `forms-mirror-21`; one winner flips in `forms-02`). Flagged invalid
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
