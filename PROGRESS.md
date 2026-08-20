# PROGRESS — append-only run log (newest entry LAST; never edit past entries)

## 2026-08-20T17:55Z — orchestrator session (handoff to routine)
Project bootstrapped in an interactive session; switching to the scheduled-routine engine per user directive. State at handoff:
- **Done + committed:** P1 engine harness (`src/engine/` — pvpoke's own sim code vm-loaded headless; 20 tests incl. EXACT reproduction of 4 rankings-1500 matchup ratings; sharp edges documented in src/engine/README.md). P2 importer (`src/importer/` — Poke Genie + generic CSV, species/form resolver; 22 tests; fixtures double as demo collection).
- **WIP, unverified:** `src/scoring/index.js` (326 lines) from a session worker killed mid-task → T1 reviews and finishes it. No other stray files.
- **Pivot:** user wants teams evaluated by **3v3 team battles**, not 1v1 aggregation → PLAN.md Rev 2 (primary: pvpoke Training/emulate mode headless; fallback: chained-1v1 tree; meta opponents from pvpoke's training team presets). Old P4 (1v1-coverage team search) was killed before writing files; its approach is superseded.
- **Environment caveat for the FIRST fire:** `vendor/pvpoke` does not exist in a fresh clone — T0 (setup.sh parity check, with vendor-into-repo fallback) gates everything.
- Verified this session: engine + importer suites green locally (42/42, macOS, Node 26). Unverified: everything in the cloud sandbox — that's T0.
- Next: T0, then T1.
