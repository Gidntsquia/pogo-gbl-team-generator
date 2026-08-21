# Orchestrator state — Sim throughput II (Session mode, started 2026-08-21 ~15:35Z)

**Initiative:** Jaxon: "make the GBL team builder faster so that I can run a larger simulation."
Target: tournament-scale runs (10^5–10^6 battles) ≥4x faster on THIS Mac (8 logical cores: 4 perf + 4 eff, node v26.7.0), with determinism upgraded from "serial is the reference mode" to "bit-identical at any thread count." Design: PLAN.md Rev 4. Queue: GOALS.md T19–T22 (session-owned, fenced from routine fires).

## Packet board
| id | status | agent | attempts | note |
|----|--------|-------|----------|------|
| T19 executor rework (persistent pool + per-spec errors) | done (integrated 16:00Z, npm test 186/186) | t19-executor | 1 | baseline this Mac: serial 78.11ms/battle; per-call-boot threading 36.24 best @ t4, degrades @ t7 |
| T20a determinism investigation (read-only) | done (~16:05Z; findings baked into GOALS T20/T20b + PLAN Rev 4 amendment) | t20a-determinism | 1 | mechanism 1 proven+fix validated; mechanism 2 DISCOVERED (TrainingAI.runScenario restore gap) — full bit-identity deferred to T20b |
| T20 land mechanism-1 stamp fix | ready → ROUTINE | ROUTINE | 0 | proven fix + narrow acceptance bar in ticket text |
| T20b mechanism-2 hunt | queued last (after T22, behind T23–T25) | ROUTINE | 0 | wrap-don't-edit vendor boundary stated in ticket |
| T21 tournament/evaluator adopt pool + threaded default | ready (after T20) | ROUTINE | 0 | owns scripts/tournament.mjs, src/teams/index.js, test/tournament.test.js, test/teams.test.js |
| T22 code (bench --threads + docs) | ready (after T21) | ROUTINE | 0 | owns scripts/bench.mjs, test/bench.test.js, README.md, ROADMAP.md |
| T22 measurement (local A/B on this Mac) | ready (after T22 code) | ORCHESTRATOR via Bash | 0 | no agent — run bench + tournament A/B directly, record in PROGRESS.md |
| T23 GA core module (evolve.js) | ready (parallel-safe with T20–T22) | ROUTINE | 0 | pure seeded selection/mutation logic, fake-fitness unit tests |
| T24 evolution driver (evolve.mjs) | ready (after T21+T23) | ROUTINE | 0 | battles via persistent executor; checkpoints; per-gen analytics |
| T25 evolution report + README | ready (after T24) | ROUTINE | 0 | trajectory tables, cores, acceptance run |

## Decisions log
- **Session mode, not Routine** — every acceptance bar is a perf number on Jaxon's Mac; sandbox is ~2.4x slower (T14: 172 vs 73 ms/battle) with few vCPUs, so cloud fires structurally cannot verify this initiative.
- **Paused the hourly cloud routine** (`trig_01JfxVRAW8FQYvnGSpEdkFoG`, was `43 * * * *`, enabled→false 15:35Z) for the duration: queue had zero routine-eligible work, and an idle fire's only ROADMAP pull was the vendor pin bump — which would shift battle results under our perf baselines. **Re-enable at delivery** (or leave off if Jaxon prefers; say so in final report).
- **Success criterion (assumed, not asked):** ≥4x tournament throughput serial→threaded on this Mac, same-seed A/B with identical rankings; post-T20 bar is bit-identical results (winners AND survivorsHp) at any thread count. Rationale: 4P+4E cores realistically give 4–6x; 1M battles ≈ overnight at ~15ms/battle.
- **Knife-edge caveat accepted:** T20 canonicalization may flip a handful of knife-edge battles ONCE relative to today's serial history (0.28% flip rate class, see variance study) — acceptable and documented; the invariant becomes "result is a pure function of (spec, seed)".
- **CLI default stays serial** (default runs are ~27s, not the target); `scripts/tournament.mjs` flips to threaded-by-default post-T20 (it is the big-sim vehicle).
- T19 explicitly does NOT touch scripts/bench.mjs (T22 owns it) to keep packet file ownership disjoint.

- **Jaxon directive (2026-08-21, after /usage showed session 44% / week 56%): no new in-session background subagents — routines instead.** Applied: T19 + T20a workers run to COMPLETION (sunk cost; outputs enable handoff) but nothing new gets dispatched. T20/T21 + T22's code half hand off to the cloud routine once T19 is verified, committed, pushed, GOALS T20's ticket text carries T20a's findings (zero-memory fires can't read this session), and the T19–T22 fence note is rewritten to un-fence T20+. Then re-enable trig_01JfxVRAW8FQYvnGSpEdkFoG. T22's measurement half (perf A/B) is cloud-impossible → orchestrator runs it directly via Bash, no agent. Skill file + project memory updated with the standing rule.

- **Jaxon directive #2 (2026-08-21): "survival of the fittest" evolutionary team search** — designed as PLAN.md Rev 5 + GOALS T23–T25 (routine tickets, per routines-first rule). Design calls made without asking (all tunable flags): fresh opponent draw per generation with elites re-evaluated (no overfitting/stale fitness; `--fixed-opponents` opts out); ~10% immigrants to prevent inbreeding (Jaxon didn't ask for these — documented as GA-standard diversity, can be set to 0); top-50% survive / bottom-50% die / top-quartile mutate; convergence = top-10 set stable 3 gens. Analytics confirmed cheap (pure counting, no battles) → in by default incl. 2-species core tracking. T23 marked parallel-safe; T24 gated on T21 so it's built on the persistent executor from day one.

- **Jaxon GA-selection revision (2026-08-21, mid-turn):** bottom-50% death too harsh → `deathRate` default 0.25; mutation is a seeded RANDOM roll per survivor with probability scaling by fitness percentile (linear 0.05→0.40 default), not a deterministic top-quartile entitlement. PLAN Rev 5 + GOALS T23 updated before anything committed.

- **Adjudication on determinism (16:05Z):** investigation PROVED the known stale-`.index`/`.battle` mechanism and validated a zero-cost stamp fix — but also DISPROVED the Rev 4 bit-identity goal as stated: a second in-battle mechanism flips a reproduced knife-edge battle even with pre-battle state bit-identical. Decision: land the proven fix (T20, narrow provable bar), get reproducibility-at-fixed-(seed,threads) via deterministic partitioning (T21), keep serial as cross-config reference, queue mechanism 2 (T20b) BEHIND the evolution tickets — user value first, ~0.28% rank-preserving residue is acceptable meanwhile. No known-red acceptance tests.

## Watchdog
Armed ~15:40Z until ~16:10Z (sleep 1800, WATCHDOG_TICK).

## Resume (cold read)
If workers dead with no results: reset T19 to ready and hand it to the ROUTINE too (per Jaxon's no-new-subagents directive — T19's correctness is test-verifiable in sandbox; the orchestrator runs its local baseline numbers itself via Bash). T20a findings optional (a T20 fire can re-derive from engine README "Known limitation" + variance-study.mjs). Routine re-enable: RemoteTrigger update trig_01JfxVRAW8FQYvnGSpEdkFoG {"enabled": true} when initiative lands.
