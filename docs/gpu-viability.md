# GPU viability: porting the 3v3 battle to CUDA

## Verdict

**Viable, but the 5× target is only reached conditionally.**

- A CUDA port of the whole 3v3 battle (`Battle.js` + `TrainingAI`) exists in `gpu/` and reproduces pvpoke
  exactly where it is supported: 0 winner / HP / turn mismatches over 1,206 real gen-0 battles and 18 fixtures (double
  build); the float32 build has 0 winner mismatches and 5 HP/turn mismatches in 1,206 battles.
- The kernel runs 284 battles/s against 3.30 battles/s for pvpoke serial (86×; 65× against serial with the scenario memo on).
  Through a JSON-lines sidecar it still does 141 battles/s (43×).
- **(a) Inner sims only on GPU:** 86% of worker time is inner `simulate()` work, so Amdahl caps the run at 7.2×; 5× needs
  an effective inner-sim speedup of ≥10.6× with the latency of per-decision round trips hidden. **Not demonstrated** here; a
  per-sim round trip through the sidecar (1,502 sims/s) is slower than one CPU thread (2,657 sims/s). Verdict: **no for
  a naive offload, ceiling 7.2× on paper.**
- **(b) Whole battle on GPU:** 5.1× when the 19.6% of battles the kernel cannot do (form-changing mons) run on CPU
  concurrently; 3.9× when they run one after the other; about 12× once form changers are ported. Verdict: **borderline
  pass (≈5×) as built, clear pass after porting Cramorant / Mimikyu / Morpeko**.
- Not done: a `--gpu` flag, routing, or seeded-report check (see "Seeded report" below). You decide next.

## Prototype

`gpu/` (Python via `uv`, cupy `RawKernel`, NVRTC; no nvcc needed). Machine: RTX 3080 10 GB, i7-10700KF, WSL2.

| piece | command |
|---|---|
| kernel compiles | `cd gpu && uv run python -c "import cupy; cupy.RawKernel(...)"` |
| export pvpoke ground truth | `node gpu/export-matchups.mjs` (imports only `src/engine/`, `src/scoring/`) |
| 1v1 verification | `uv run python -m gpu.verify_1v1` |
| 3v3 verification | `uv run python -m gpu.verify_3v3` |
| benchmark | `node gpu/serial-baseline.mjs --battles 1000 [--memo]`, then `uv run python -m gpu.bench` |
| sidecar / client | `gpu/sidecar.py`, `node gpu/client.mjs` |

Every entry point exits 1 with one line (`gpu: no CUDA device (...)`) under `CUDA_VISIBLE_DEVICES=""` (observed for
verify_1v1, verify_3v3, bench, sidecar and client).

## Profile of a real generation (R2)

Run `gpu-profile` (8 workers, population as in a normal run; `out/evolve-gpu-profile/profile-summary.json` and
`worker-N.cpuprofile`): gen 0 simulated 36,000 battles in 27 m 53 s (21.5 battles/s); gen 1 simulated 24,452 and served
11,548 from cache in 21 m 07 s.

- Inner sims per battle: 27.77 M memo misses over 60,452 simulated battles = **≈459 real `simulate()` per battle**
  (memo hit rate 31%: 12.58 M hits, 27.77 M misses). With the memo off, the export saw ≈730 per battle (767,463 distinct
  over 1,518 battles).
- ms/battle: 8 threads → 372 ms per worker-battle (23,528 s sampled CPU / 60,452 ≈ 0.39 core-s); serial 1 thread, memo off
  303 ms, memo on 229 ms (`out/gpu-serial*.log`).
- ms per inner sim ≈ 0.73 ms in the run (0.86 × 23,528 s ÷ 27.77 M); isolated serial `simulate()` = 0.38 ms
  (2,657 sims/s).
- GPU-absorbable share: inclusive time under `MemoBattle.b.simulate` = **86.2%** (`node gpu/profile-inclusive.mjs`). Self-time top:
  decideAction 22.5%, damage 18.7%, simulate 9.9%, applyStatBuffs 8.9%, Battle.step 7.4%, useMove 6.2%, resetMoves 3.6%.

## Time model

Baseline: ≈8 h at 8 threads = ≈21.5 battles/s ≈ 620k simulated battles.

**(a) Inner sims on GPU, battle logic on CPU.** Run time = 0.138 + 0.862 / S (S = effective inner-sim speedup).
S → ∞ gives 7.2×; 5× needs S ≥ 10.6. The kernel does 711k sims/s (267× one CPU thread) for large batches including transfer
(10,000 sims, 7–14 ms), but the AI's lookahead sims are sequentially dependent inside a battle, so a batch only
forms by running many battles at once. A request per sim through the sidecar costs ~0.67 ms (1,502 sims/s for 10,000 sims
incl. JSON), i.e. no gain. **5×: not met by a straightforward offload; possible only with a batching scheduler
that hides the latency.** Not built.

**(b) Whole battle on GPU.** CPU rate 21.5 battles/s (8 threads). Kernel 284 b/s (sidecar 141 b/s). 19.6% of gen-0
battles contain a form changer and must stay on CPU (Cramorant 244, Mimikyu 40, Morpeko 26 of 282 affected battles).
Per battle: CPU leftover 0.196 × 46.5 ms = 9.1 ms; GPU 0.804 / 284 = 2.8 ms (5.7 ms via sidecar).

| scenario | per-battle time | speedup | 8 h becomes |
|---|---|---|---|
| fallback overlapped with GPU | 9.1 ms | **5.1×** | ≈1.6 h |
| fallback sequential | 11.9 ms | 3.9× | ≈2.1 h |
| sidecar, overlapped | 9.1 ms | 5.1× | ≈1.6 h |
| sidecar, sequential | 14.8 ms | 3.1× | ≈2.6 h |
| form changers ported (GPU only, kernel) | 3.5 ms | ≈13× | ≈0.6 h |
| form changers ported (sidecar) | 7.1 ms | ≈6.6× | ≈1.2 h |

Caveats: GA, caching and CSV/report work outside battles are not modeled (profile says battles dominate); each battle
currently needs a packed input, and the sidecar copies results back as JSON (94 ms per 1,000 battles measured by
`node gpu/client.mjs`, round trip 7.3 s for 1,000). Only gen-0-style battles were benchmarked; GPU memory limits batch size
(local stack 64 KB × threads). **Verdict (b): borderline ≥5× as built, clearly ≥5× after porting the three form changers.**

## Port map (vendor line ranges)

Ported (verified 0 mismatches against pvpoke):

- `Battle.js`: `setNewPokemon` 82-120, `start` 215-274, `step` 278-605, `getTurnAction` 720-788, `queueAction` 793-837,
  `processAction` 842-1012, `useMove` 1016-1650 (damage, buffs, charged-move and fast-move ordering, CMP ties).
- `TrainingAI.js`: `evaluateMatchup` 633-813, `runScenario` 815-957, `chooseOption` 971-990, `processStrategy` 992-1020,
  `decideAction` 1030-1129, `decideSwitch` 1131-1179, `decideShield` 1181-1378.
- Engine wrappers: `aiWrappers.js` throw-and-go (140), shield banking (325), switch cost (415); `clockWrappers.js` (40);
  `teamBattle.js` 3v3 driver.
- 1v1 `simulate()` kernel (separate, with the simulate-mode ActionLogic).

Not yet ported (flagged by the kernel, never approximated; those battles fall back to CPU):

- Form changers: Aegislash, Mimikyu, Cramorant, Morpeko (Full Belly / Hangry).
- AI difficulty other than the level 3 the evolve search uses.
- Simulate-mode ActionLogic inside the 3v3 path (only used by the 1v1 kernel).

Hard parts (these decided the port's difficulty):

- **RNG draw order.** `rng` advances by `draws × 0x6d2b79f5` per lookahead sim; `chooseOption` always consumes one draw;
  buff-roll draws in `useMove`; an extra draw on WAIT_CLOCK; the `decideShield` estimatedEnergy draw; the OVERFARM draw. Any
  order change moves every later random outcome. The kernel reproduces pvpoke's sequence exactly; this is where a port
  diverges first if wrong.
- Virtual-timer ordering and queue sort (CMP ties).
- Baiting, throw-and-go and shield decisions (large branchy functions).
- Buff roll sequencing; form changes mid-battle.

## Verification (mismatch counts)

**1v1** (`out/gpu-verify1v1.log`, 758,101 gen-0 inner sims, 703,829 supported, 54,272 flagged as unsupported =
Cramorant):

- double build: 0 mismatching rows on every field.
- float32 build: 40 rows mismatch (0.0057%): rating 37, hp 25, energy 33/28, defBuff 8/23, turns 34, rngDraws 37.
- rankings-1500 leads: 247 pairs, 183 supported, 0 rating and 0 any-field mismatches (both builds).

**3v3** (`out/gpu-verify3v3.log`): 18 fixtures plus 1,500 real gen-0 battles; 294 flagged unsupported (19.6%), 1,206 compared.

| build | winner mismatches | survivorsHp | turn count | team-A win rate | per-matchup agreement |
|---|---|---|---|---|---|
| double | 0 | 0 | 0 | 48.47% vs 48.47% | 100.00% |
| float32 | 0 | 5 | 5 | 48.47% vs 48.47% | 100.00% |

Found and fixed by trace: the first kernel gave 46 winner and 151 HP mismatches (96.11% agreement, failing). Tracing
one battle (`gpu/trace-battle.mjs`, `gpu/gpu/trace_cmp.py`) showed `Battle.js` line 415 does `action.priority -= 40` on a property
the sort never reads, so it is dead code; the port had applied it. Removing it gave 0 mismatches.

The 5 float32 HP/turn differences are rounding in damage; no winner changed.

## Other evidence

- **Dawn / WebGPU:** `webgpu@0.6.2` (Dawn) runs a compute shader in WSL2 (`result [0,2,4,6]`) but its adapter is llvmpipe
  (Mesa 26.0.3 software), not the RTX 3080; `DAWN_BACKEND=vulkan` gives the same. D3D12 not tried. No Dawn speed numbers.
- **Benchmark** (`out/gpu-bench.log`, float32): 1v1: 10,000 sims in 14 ms incl. transfer = 710,858 sims/s (earlier run
  7 ms, 1.47 M/s); via sidecar 6.7 s round trip (26 ms kernel; the rest is JSON and file handling), 1,502 sims/s;
  pvpoke serial 2,657 sims/s. 3v3: 1,000 battles in 3.52 s = 284.4 battles/s (592 inner sims/battle, 168,258 inner sims/s);
  sidecar 7.09 s = 141.0 battles/s; pvpoke `battleTeams` serial 3.30 battles/s (memo off), 4.36 (memo on).
  1v1 sims are tiled to 10,000 from distinct non-flagged sims.
- **Seeded report check (R14):** not observable here: no `--gpu` flag exists, as asked, and the production search
  calls `battleTeams`. Wiring needed: a batching shim at `src/engine/teamBattle.js` that sends supported battles to the sidecar,
  an unsupported-fallback path, and a seeded-report diff run. The float32 kernel reproduces pvpoke's RNG draws in
  all but 5 of 1,206 battles, so exact seeded report equality is not guaranteed.
- **Invariant:** the port reimplements battle math, which `CLAUDE.md` forbids for `src/`. It is contained in `gpu/` and
  guarded by exact comparison against pvpoke on every change.

## Where RNG draw order diverges

Float32 only: rating, energy and rngDraws mismatches in 37 of 703,829 1v1 sims (0.0053%) and 5 of 1,206 3v3 battles come
from rounding changing a branch (a damage value or a threshold) that then shifts later draws. The double build never
diverges. No divergence found in the order itself.

## Next steps (your call)

Port the form changers (largest gain, 5.1× → ≈13×); build the batching scheduler for the sim-level option; then wire a `--gpu`
flag behind the shim above.
