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
3. **Build candidate teams.** By default these are *sampled*: 3-mon
   combinations drawn from a wide pool of your Pokemon, weighted so a mon
   that scores well in your own 1v1 matrix *and/or* is a current
   Great-League staple lands on more candidate teams (no duplicate species
   within a team; a shadow and its base form count as the same species).
   `--exhaustive` switches to the older behavior: every combination of 3
   from your top-`topK`-scoring Pokemon.
4. **Battle each candidate team** against a pool of opponent teams — by
   default a mix of curated/community Great League presets plus
   weighted-random compositions from the current meta; `--exhaustive` uses
   only the fixed curated list. Each matchup is a full 3v3 team battle
   (shared 2-shield pool, switching, AI leads) across all 9 lead-matchup
   pairings, via pvpoke's Training/emulate engine.
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
score appendix), plus a self-contained `out/report.html` with the same
content styled for reading in a browser (no build step, no external CSS/JS —
just open the file).

### Options

```
node src/cli.js <collection.csv> [options]

  --top N            teams to show in the report        (default 5)
  --score-meta S     meta size used for 1v1 pruning      (default 20)
  --difficulty D     AI difficulty 0-3 (3 = strongest)   (default: engine default)
  --exclude a,b      species ids to exclude from teams   (default: none)
  --out PATH         Markdown report output path         (default out/report.md)
  --html PATH        HTML report output path              (default out/report.html)
  --no-html          skip writing the HTML report
  --current-moves    use each mon's own CSV moveset instead of recommended
  --help             print this help and exit

Sampling (default path):
  --candidates N     candidate teams to sample             (default 15)
  --opponents M      opponent teams to sample               (default 7)
  --pool P           user-mon pool sampled from             (default 30)
  --seed S           PRNG seed (reproducible)                (default a fixed built-in string)
  --curated-ratio R  fraction of opponents from curated pool (default 0.4)

Exhaustive path (opt-in):
  --exhaustive       use C(topK,3) candidates + a fixed curated opponent list
  --topK K           candidate pool size (best-scoring)  (default 5, exhaustive only)
  --meta M           number of opponent meta teams       (default 5, exhaustive only)
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

### Current-moves mode (`--current-moves`)

By default every Pokemon is scored and battled with pvpoke's own
*recommended* Great League moveset for that species — not necessarily the
moveset it actually has TM'd in-game. Pass `--current-moves` to use each
mon's real moveset instead, read straight from your collection CSV:

- **Poke Genie CSV**: already carries `Quick Move`, `Charge Move`, and
  `Charge Move 2` columns in a stock export — nothing to add.
- **Generic CSV**: add `fast move`, `charged move 1`, and (optionally)
  `charged move 2` columns with the move's display name (e.g. `Ice Beam`).

Move names are matched against that *specific* Pokemon's own legal move
pool in the vendored gamemaster (not a global name lookup — a couple of
move names collide across species with a different underlying move, e.g.
Aegislash's signature Charged "Air Slash" isn't the same move as the common
Fast "Air Slash"), so a typo'd or illegal move name simply fails to match
rather than silently picking the wrong move.

Reliability note: if a mon's move names don't resolve (missing columns,
a typo, a move that species can't actually learn), it is **never dropped**
— it falls back to pvpoke's recommended moveset for that mon, and a note is
added to the report's collection warnings so you can see which mons fell
back. `--current-moves` only changes *which* moveset is used; nothing else
about scoring or battling changes.

### Sampling: how the weighting works

By default, both sides of every matchup are *sampled* rather than
exhaustively enumerated (see `src/meta/usage.js`, `src/teams/sample.js`,
`src/meta/sampleTeams.js`; design writeup in `PLAN.md`'s Rev 3 section):

- **Per-species usage weight** (`src/meta/usage.js`): every species gets a
  weight derived from pvpoke's own Great League ranking score (higher score
  → higher weight, tunable via a documented exponent), so current meta
  staples are more likely to be picked without the fringe being zeroed out.
  A committed snapshot (`data/meta-usage.json`) can override the vendored
  scores with a freshness refresh — see below.
- **Candidate teams** (`--candidates`, `--pool`): sampled from your
  `--pool` best-scoring Pokemon (deduped to one per species), with
  `P(mon)` blended from your own 1v1 matrix score and that species' usage
  weight — so a mon that's *both* strong in your hands *and* a meta staple
  shows up on more candidate teams.
- **Opponent teams** (`--opponents`, `--curated-ratio`): a mixture of
  curated/community Great League team presets (a `--curated-ratio`
  fraction, default 0.4) plus weighted-random 3-mon compositions from the
  wide usage-weighted pool.
- **Reproducibility** (`--seed`): everything is driven by a seeded PRNG
  (`src/util/rng.js`, no npm dependency) — the same collection + the same
  `--seed` always produces the same candidate/opponent teams. The seed used
  is printed in the report's Settings line.

Refresh the live usage snapshot (optional; never required, never run
automatically):

```bash
node scripts/refresh-usage.mjs
```

This fetches pvpoke's live Great League rankings JSON and writes
`data/meta-usage.json`. Network failure here never breaks anything — the
loader falls back to the vendored rankings file whenever the snapshot is
missing, unparseable, or malformed.

### Tuning the search (speed vs. thoroughness)

**Sampled (default) path:** total 3v3 battles run = `--candidates ×
--opponents × 9 lead pairings`. The defaults (`candidates=15`,
`opponents=7` → 15 × 7 × 9 = 945 battles) finish in about 2 minutes on a
typical machine. Runtime grows roughly linearly with `--candidates` /
`--opponents`, so both can be raised more freely than `--topK` below.
`--pool` only controls how wide a Pokemon pool candidates are sampled
from — raising it doesn't change the battle count.

**Exhaustive (`--exhaustive`) path:** total 3v3 battles run = `C(topK, 3)
candidate teams × meta teams × 9 lead pairings`. The defaults (`topK=5`,
`meta=5` → 10 candidate teams × 5 meta teams × 9 = 450 battles) finish in
about a minute. Raising `--topK` grows the candidate pool
*combinatorially* — `--topK 10` is `C(10,3) = 120` candidate teams — so
raise it gradually.

`--score-meta` (both paths) only affects the cheaper 1v1 pruning pass used
to pick which Pokemon are even eligible for the candidate pool.

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
  presets (`vendor/pvpoke/src/data/training/teams/gobattleleague/1500.json`)
  plus community-submitted teams (`data/meta-teams-community.json`), not
  hand-picked archetypes. By default (sampled path) most opponents are
  weighted-random compositions from the current meta rather than only this
  fixed list — see "Sampling: how the weighting works" above.

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
  moveset by default — pass `--current-moves` to use each mon's actual
  currently-learned moves instead (see "Current-moves mode" above); moves
  that don't resolve fall back to recommended with a warning.
- Only Great League (CP ≤ 1500) is supported end-to-end today.
