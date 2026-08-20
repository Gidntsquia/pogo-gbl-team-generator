# Pokemon GO Great League Team Generator — Plan

## Brief
CLI that reads your Pokemon collection (Poke Genie export CSV or a simple generic CSV), scores every Pokemon for GO Battle League **Great League (CP ≤ 1500)** by battling it against the current Great League meta using **pvpoke's actual battle simulator** (vendored, executed headlessly in Node), then searches teams of 3 for best meta coverage and outputs ranked team recommendations with threat analysis.

## Architecture
- Node ≥ 18, ESM (`"type": "module"`), **no build step**, tests via `node --test`.
- `vendor/pvpoke` — pinned shallow **sparse** clone (only `src/js`, `src/data`), commit `ea601f0a61c548f9140e4605b94a31fa97fe6aba`, **gitignored**, restored by `scripts/setup.sh`. Read-only: we load and execute pvpoke's engine code; we never fork or reimplement its battle math.
- Key vendor paths: engine `src/js/battle/Battle.js`, `src/js/battle/DamageCalculator.js`, `src/js/pokemon/Pokemon.js`, `src/js/GameMaster.js`; data `src/data/gamemaster.json`, meta group `src/data/groups/great.json`, validation ground truth `src/data/rankings/all/overall/rankings-1500.json`.

## Data flow
`collection.csv` → **importer** (normalized mons) → **engine** (level each mon to best CP ≤ 1500 with its actual IVs, pvpoke recommended moveset) → **scoring** (sim matrix vs meta, shields 0v0 / 1v1 / 2v2 weighted 0.25 / 0.50 / 0.25) → **team search** (top K=20 candidates, all C(K,3) combos, coverage metric) → **report** (terminal summary + `out/report.md`).

## Interfaces (contracts between packets — do not drift)
- **NormalizedMon** (importer out): `{ speciesId, name, ivs: {atk, def, hp}, cp?, level?, shadow, purified, lucky, bestBuddy, sourceRow }` — `speciesId` is pvpoke's gamemaster speciesId; no level/CP math in the importer.
- **Engine API** (`src/engine/harness.js`): `await initEngine(opts?)` → `ctx`; `buildPokemon(ctx, { speciesId, ivs, shadow, bestBuddy })` → battle-ready mon at highest level with CP ≤ 1500 (level cap 50, 51 if bestBuddy), pvpoke recommended moveset; `simBattle(ctx, { p1, p2, shields: [s1, s2] })` → `{ rating1, rating2, hp1, hp2, turns }` (ratingX = pvpoke 0–1000 battle rating).
- **Matrix** (scoring out): `{ mons: [{ speciesId, name, score, leadIn }], meta: [speciesId…], ratings: { [userMonKey]: { [metaSpeciesId]: { s00, s11, s22 } } } }` — userMonKey disambiguates duplicates (`speciesId#row`).
- **Teams** (team search out): `[{ members: [3 userMonKeys], score, coveragePct, threats: [uncovered metaSpeciesIds] }]` sorted best-first.

> **Rev 2 (2026-08-20): the project pivoted to 3v3 team battles — see "Rev 2" section at the bottom. The packet table below is historical (P1/P2 landed as described); the live work queue is GOALS.md.**

## Packets
| id | goal | owns (touch nothing else) | deps | verify |
|----|------|--------------------------|------|--------|
| P1 | Headless pvpoke engine harness + validation vs pvpoke's own rankings data | `src/engine/**`, `test/engine.test.js`, `scripts/setup.sh` | — | `node --test test/engine.test.js` |
| P2 | Collection importer (Poke Genie CSV + generic CSV → NormalizedMon[]) | `src/importer/**`, `test/importer.test.js`, `fixtures/**` | — | `node --test test/importer.test.js` |
| P3 | Meta scoring matrix (collection × groups/great.json across shield scenarios) | `src/scoring/**`, `test/scoring.test.js` | P1 | `node --test test/scoring.test.js` |
| P4 | Team-of-3 search + coverage/threat analysis | `src/teams/**`, `test/teams.test.js` | P3 (matrix shape; may build against fixture matrix) | `node --test test/teams.test.js` |
| P5 | CLI + report (`node src/cli.js <collection.csv>` → terminal + out/report.md) | `src/cli.js`, `src/report/**` | P2, P3, P4 | run CLI on fixture collection |
| P6 | End-to-end test on fixture collection + README | `test/e2e.test.js`, `README.md` | all | `npm test` |

Milestone 1 (MVP) = P1–P6. **Stretch:** restrict sims to each mon's current moves; HTML report; `--cp 2500` flag; usage-weighted meta; safe-swap analysis; web UI.

## Scoring & team metric (tunable, documented here)
- Per-mon score = mean over meta of weighted battle rating (0.25·s00 + 0.50·s11 + 0.25·s22). *(Still live — used for candidate pruning and per-mon report insight.)*
- ~~A team covers a meta mon if any member's s11 rating vs it ≥ 500…~~ **Superseded by Rev 2: teams are ranked by simulated 3v3 team-battle results, not 1v1 coverage.**

## Rev 2 — 3v3 team-battle pivot (2026-08-20, user directive)
The user wants candidate teams evaluated in **team battles against meta TEAMS**, not by aggregating 1v1 matchups.

**Primary path — pvpoke's own 3v3 machinery, headless.** pvpoke's Training mode implements full GBL team battles natively: `Battle.js` in *emulate* mode with `src/js/pokemon/Player.js` (team of 3, shared pool of 2 shields per player, switch timer) and `src/js/training/` (TrainingAI: lead/swap/shield decision logic, difficulty levels). Extend the P1 vm-loader to include these modules and expose `battleTeams(ctx, {teamA, teamB, leadA, leadB, difficulty})` → `{winner, survivorsHp, summary}`. Fix the highest AI difficulty; if the AI has stochastic elements, either pin its RNG or aggregate repeated runs — document which. This is not an approximation: it is pvpoke's real team-battle engine.

**Fallback — chained-1v1 battle tree (only if emulate mode proves genuinely infeasible headless, with findings written up first).** Translate 1v1 sims into a 3v3: leads fight (1v1 sim); on a faint, the losing side sends its best remaining counter (chosen from the 1v1 matrix); the survivor carries its remaining HP and energy into the next 1v1 (pvpoke's sim supports custom starting HP/energy); enumerate each player's shared-2-shield allocations across their mons; resolve the outcome tree. Documented plainly as an approximation (no switch-timer dynamics, deterministic switch policy).

**Meta opponents are real teams:** pvpoke ships curated Great League teams in `vendor/pvpoke/src/data/training/` — that's the opponent pool (fallback: compose teams from `groups/great.json` top entries).

**Pipeline (Rev 2):** import collection → 1v1 scoring matrix (pruning + insight + fallback switch policy) → candidate teams = C(topK, 3), no duplicated species (shadow/base count as same species) → every candidate battles every meta team across all 3×3 lead pairings via `battleTeams` → rank by mean win rate (tiebreak: mean surviving-HP margin) → report: per candidate team, win% vs each meta team, best lead, hardest opposing teams.

**Interface (new, for the team evaluator):** `evaluateTeams(ctx, {candidates: [[3 userMonKeys]], metaTeams, matrix, opts})` → `[{members, winRate, bestLead, perMeta: [{metaTeamId, wins, losses, avgHpMargin}], hardestTeams}]` sorted best-first. Work queue and acceptance criteria live in **GOALS.md**.
