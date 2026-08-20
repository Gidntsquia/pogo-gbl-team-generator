# pogo-gbl-team-generator

Feed in your Pokemon GO collection (a Poke Genie CSV export, or a simple
generic CSV) and get back a ranked list of the best **Great League
(CP ≤ 1500)** teams of 3 you can build from *your own* Pokemon — ranked by
running real, full **3v3 team battles** against a curated pool of current
Great League meta teams, using [pvpoke](https://pvpoke.com)'s own battle
simulator (vendored and executed headlessly, never reimplemented).

## What it does

1. **Import** your collection CSV into normalized Pokemon (species, IVs,
   shadow/purified/lucky/Best Buddy flags).
2. **Score** every one of your Pokemon 1v1 against a slice of the meta
   (weighted across the 0/1/2-shield scenarios) using pvpoke's real battle
   simulator. This 1v1 score is used only to prune your collection down to
   a manageable candidate pool — it is not the final ranking.
3. **Build candidate teams**: every combination of 3 from your top-scoring
   Pokemon (no duplicate species within a team; a shadow and its base form
   count as the same species).
4. **Battle each candidate team** against a set of curated real Great
   League team presets (pvpoke's own GBL training data) — a full 3v3 team
   battle (shared 2-shield pool, switching, AI leads) across all 9
   lead-matchup pairings, via pvpoke's Training/emulate engine.
5. **Rank** candidate teams by mean win rate across all those battles
   (tiebreak: mean surviving-HP margin), and write a report.

Nothing here reimplements Pokemon GO's damage or battle logic — every
simulated battle runs pvpoke's own vendored engine code.

## Setup

Requires Node ≥ 18.

```bash
npm run setup   # or: bash scripts/setup.sh
```

This clones a pinned, read-only, sparse copy of pvpoke's engine and data
into `vendor/pvpoke` (gitignored — this step is required after every fresh
clone; there are no other npm dependencies to install).

## Usage

```bash
node src/cli.js path/to/your-export.csv
```

Export your collection from **Poke Genie** (Settings → Export → CSV) and
point the CLI at that file. A simple generic CSV also works — see
`fixtures/sample-generic.csv` for the minimal column set
(`name,atk,def,sta,shadow,level,cp`).

This prints a terminal summary of the top recommended teams and writes a
full Markdown report to `out/report.md` (ranked teams, win% vs each meta
team, best lead per team, hardest opposing matchups, and a per-Pokemon 1v1
score appendix).

### Options

```
node src/cli.js <collection.csv> [options]

  --top N          teams to show in the report        (default 5)
  --topK K         candidate pool size (best-scoring)  (default 5)
  --meta M         number of opponent meta teams       (default 5)
  --score-meta S   meta size used for 1v1 pruning       (default 20)
  --difficulty D   AI difficulty 0-3 (3 = strongest)    (default: engine default)
  --exclude a,b    species ids to exclude from teams    (default: none)
  --out PATH       report output path                   (default out/report.md)
  --help           print this help and exit
```

Try it on the bundled fixture:

```bash
node src/cli.js fixtures/sample-pokegenie.csv
```

### Best Buddy (level 51) mons

Poke Genie's CSV export doesn't carry a Best Buddy column, so the importer
can't tell which of your Pokemon are eligible for the extra Best Buddy level
(51, one level above the normal cap of 50) purely from a stock export. If
you want a Best Buddy mon scored and built at its true level-51 potential,
add the column yourself before running the CLI:

- **Poke Genie CSV**: add a `Best Buddy` (or `Buddy`) column and put a
  truthy value (`TRUE`, `Yes`, `Y`, or `1`) in it for each Best Buddy mon,
  blank/`FALSE`/`No` otherwise.
- **Generic CSV**: add a `bestbuddy` column with the same truthy values —
  see `mapGenericRow` in `src/importer/index.js` for the exact header
  aliases recognized (`bestbuddy`, `best buddy`, `buddy`).

The importer recognizes these headers opportunistically in both formats
(see `src/importer/index.js`); a mon without the column just defaults to
`bestBuddy: false`, matching a non-Best-Buddy Pokemon. When set, the engine
levels that mon up to 51 instead of 50 (see `buildPokemon` in
`src/engine/harness.js`), which can raise its best-possible CP-1500 IV
spread's stat product slightly.

### Tuning the search (speed vs. thoroughness)

Total 3v3 battles run = `C(topK, 3) candidate teams × meta teams × 9 lead
pairings`. The defaults (`topK=5`, `meta=5` → 10 candidate teams × 5 meta
teams × 9 = 450 battles) finish in about a minute on a typical machine.
Raising `--topK` grows the candidate pool combinatorially — `--topK 10` is
`C(10,3) = 120` candidate teams — so raise it gradually. `--score-meta`
only affects the cheaper 1v1 pruning pass used to pick which Pokemon are
even eligible for the candidate pool.

## How scoring works

- **1v1 matrix** (`src/scoring`): each of your Pokemon is simulated 1v1
  against a slice of the meta at three shield scenarios (0v0 / 1v1 / 2v2,
  weighted 0.25 / 0.50 / 0.25) using pvpoke's recommended moveset for that
  Pokemon. This produces a per-mon score used purely to prune your
  collection to a candidate pool — it does not decide the final ranking.
- **3v3 team battles** (`src/engine/teamBattle.js`, `src/teams`): the
  actual ranking comes from running pvpoke's own Training/emulate mode —
  full team battles with switching, a shared 2-shield pool, and AI-driven
  decisions — between each candidate team and each meta team, across all 9
  possible lead pairings. Teams are ranked by mean win rate across those
  battles.
- **Fixed-side convention**: every candidate team is always evaluated as
  "team A" against meta teams. pvpoke's emulate engine has a small,
  constant player-1 side edge; keeping candidates on a fixed side makes
  that edge cancel out in the *relative* ranking between candidates, but it
  means the *absolute* win% numbers in the report carry that constant
  offset (they run a little above the "true" 50/50 baseline). Trust the
  ranking; treat the absolute percentages as directional.
- **Meta opponents** come from pvpoke's own curated Great League team
  presets (`vendor/pvpoke/src/data/training/teams/gobattleleague/1500.json`),
  not hand-picked archetypes.

## Tests

```bash
npm test                              # everything
node --test test/<file>.test.js       # one suite
```

`test/e2e.test.js` runs the full pipeline (import → score → build meta
teams → evaluate → report) against the bundled fixture collection with a
small search size, and checks the resulting report file.

## Known limitations / not yet implemented

See `ROADMAP.md` for the full backlog. Notably:
- No *automatic* Best Buddy (level 51) detection — a stock Poke Genie
  export carries no Best Buddy column, so it must be added by hand (see
  "Best Buddy (level 51) mons" above) for those mons to be scored/built at
  level 51.
- Teams are built and scored using each Pokemon's pvpoke-*recommended*
  moveset, not your Pokemon's actual currently-learned moves.
- Meta teams are a fixed curated pool, not weighted by observed usage.
- Only Great League (CP ≤ 1500) is supported end-to-end today.
