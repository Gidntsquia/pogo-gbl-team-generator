# PROGRESS — append-only run log (newest entry LAST; never edit past entries)

## 2026-08-20T17:55Z — orchestrator session (handoff to routine)
Project bootstrapped in an interactive session; switching to the scheduled-routine engine per user directive. State at handoff:
- **Done + committed:** P1 engine harness (`src/engine/` — pvpoke's own sim code vm-loaded headless; 20 tests incl. EXACT reproduction of 4 rankings-1500 matchup ratings; sharp edges documented in src/engine/README.md). P2 importer (`src/importer/` — Poke Genie + generic CSV, species/form resolver; 22 tests; fixtures double as demo collection).
- **WIP, unverified:** `src/scoring/index.js` (326 lines) from a session worker killed mid-task → T1 reviews and finishes it. No other stray files.
- **Pivot:** user wants teams evaluated by **3v3 team battles**, not 1v1 aggregation → PLAN.md Rev 2 (primary: pvpoke Training/emulate mode headless; fallback: chained-1v1 tree; meta opponents from pvpoke's training team presets). Old P4 (1v1-coverage team search) was killed before writing files; its approach is superseded.
- **Environment caveat for the FIRST fire:** `vendor/pvpoke` does not exist in a fresh clone — T0 (setup.sh parity check, with vendor-into-repo fallback) gates everything.
- Verified this session: engine + importer suites green locally (42/42, macOS, Node 26). Unverified: everything in the cloud sandbox — that's T0.
- Next: T0, then T1.

## 2026-08-20T17:03Z — routine fire (T1: scoring matrix finished + verified)
- **T0 verified:** `bash scripts/setup.sh` cloned vendor/pvpoke at pinned ea601f0; `node --test test/engine.test.js test/importer.test.js` → 42/42 green in this sandbox. No fallback needed. (T0 box left unchecked — it's a per-fire parity gate, not one-time work.)
- **T1 done + verified:** Reviewed the 326-line WIP `src/scoring/index.js` from the killed worker — it is sound and faithful (loadMeta/scoreCollection/computeWeightedScore/computeLeadIn all match PLAN's Matrix interface; meta movesets applied via pvpoke's own selectMove/resetMoves; shadow `_shadow` suffix handling mirrors harness.buildPokemon; no battle math reimplemented). Kept it as-is — no code changes needed. Wrote `test/scoring.test.js` (11 tests): meta movesets actually applied to built instances; `_shadow` id resolution; metaLimit cap; full Matrix shape per PLAN; **s11 cell equals a direct simBattle** on the same instances; strong-pick (azumarill) outscores weak-pick (magikarp); unknown-species skip-with-warning; onProgress cadence; weighted-score arithmetic; leadIn win/loss labeling. Full-meta run deliberately kept OUT of tests (tiny hand-picked meta subset only).
- **Gotcha recorded:** pvpoke Pokemon objects live in a vm realm, so `array.map(...)` yields a foreign-realm Array that `assert.deepEqual` rejects on the prototype reference-equality check. Normalized with `Array.from(...)` in the test. Anything comparing pvpoke-vm collections in future tests must do the same.
- **Verify command run clean THIS fire:** `node --test test/scoring.test.js` → 11/11; `npm test` → 53/53 green.
- **Next:** T2 — 3v3 engine via pvpoke Training/emulate mode headless (`src/engine/teamBattle.js` + loader additions, Player.js + src/js/training/). Seq-gated; T1 now unblocks it.

## 2026-08-20T17:10Z — orchestrator (queue hygiene)
- Converted T0 from a queue checkbox into standing-rule gate G0: the first fire correctly treated it as a per-fire gate and left it unchecked, but rule 7 ("take the first unchecked ticket") would point every future zero-memory fire at a permanently-unchecked T0 — ambiguity removed. Fallback instructions preserved verbatim in G0. Queue head is now T2.
- Orchestrator re-verified the first fire locally: 491eade pulled, `npm test` 53/53 green on macOS/Node 26. Routine is confirmed live end-to-end (clone → setup.sh → tests → commit → push).
