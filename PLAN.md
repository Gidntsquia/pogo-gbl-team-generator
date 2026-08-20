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
- Per-mon score = mean over meta of weighted battle rating (0.25·s00 + 0.50·s11 + 0.25·s22).
- A team **covers** a meta mon if any member's s11 rating vs it ≥ 500. Team score = coveragePct (primary) + mean weighted rating (tiebreak). Report each team's uncovered threats.
