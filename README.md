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

  --cp N             CP cap / league: 1500 (Great, default) or 2500 (Ultra)
  --top N            teams to show in the report        (default 5)
  --score-meta S     meta size used for 1v1 pruning      (default 20)
  --difficulty D     AI difficulty 0-3 (3 = strongest)   (default: engine default)
  --exclude a,b      species ids to exclude from teams   (default: none)
  --out PATH         Markdown report output path         (default out/report.md)
  --html PATH        HTML report output path              (default out/report.html)
  --no-html          skip writing the HTML report
  --current-moves    use each mon's own CSV moveset instead of recommended
  --threads N        run battles across N worker threads     (default: serial)
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

### Leagues (`--cp`)

Great League (CP ≤ 1500) is the default. Pass `--cp 2500` for **Ultra
League**:

```bash
node src/cli.js fixtures/sample-pokegenie.csv --cp 2500
```

The cap reaches every layer of the pipeline: your mons are built at the
highest level that stays under it, the 1v1 pruning meta comes from pvpoke's
matching meta group (`groups/great.json` at 1500, `groups/ultra.json` at
2500), usage weights and sampled-opponent movesets come from that cap's
rankings file, curated opponent teams come from pvpoke's GO Battle League
presets for that cap, and the 3v3 battles themselves run at it. The report
is labelled with the league and its Settings line carries `cp=2500`.

Two league-specific notes:

- **Community teams are Great League only.** `data/meta-teams-community.json`
  is a set of teams top players recommended for Great League play, so it is
  left out of the opponent pool at any other cap — an Ultra League run faces
  pvpoke's Ultra presets plus weighted-random Ultra compositions instead.
- **A refreshed usage snapshot is Great League only.**
  `scripts/refresh-usage.mjs` fetches pvpoke's live *Great League* rankings,
  and the snapshot it writes records `cp: 1500`. A `--cp 2500` run ignores
  it (with a one-line note on stderr) and uses the vendored Ultra rankings.

pvpoke also ships data for CP 500 (Little Cup) and 10000 (Master League), so
`--cp 500` and `--cp 10000` run too — they are simply less exercised than the
two above.

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

### Role priors: Lead / Closer / Switch (`src/meta/roles.js`)

The per-mon appendix table also shows **Lead**, **Closer**, and **Switch**
columns — pvpoke's own published role-specific rankings
(`vendor/pvpoke/src/data/rankings/all/{leads,closers,switches}`), each
computed under its own scenario weighting (a lead starts a battle at full
shields/energy; a closer is scored with no shields left to bait or bank; a
switch scenario starts mid-energy, simulating a counter-pick). These are
**species-level priors** under pvpoke's own recommended moveset — context
for reading the appendix, not a replacement for this collection's own
instance-specific 1v1 score or the real 3v3 battle results above it. They
are cp-aware (follow `--cp`, same as everything else) and, like the usage
weights above, prefer a committed freshness snapshot (`data/meta-roles.json`,
same shape convention) over the vendored rankings when one is present and
valid for the league being run — no live-refresh script ships for this yet;
a snapshot would need to be hand-authored or added later.

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

### Performance: parallel battles (`--threads`)

3v3 battles are CPU-bound and independent of each other, so they can run
across multiple OS threads with no change to the battle math itself — every
battle still runs unmodified pvpoke engine code, just on more cores at once.

```bash
node src/cli.js fixtures/sample-pokegenie.csv --threads 4
node scripts/tournament.mjs fixtures/sample-pokegenie.csv --threads 4
```

- `src/cli.js --threads N` runs the whole battle set for a single CLI
  invocation through one worker pool. Omit it for serial (the default).
- `scripts/tournament.mjs --threads N` (for large offline/overnight runs —
  see its own `--help`) defaults to `max(1, cpus - 1)` already; pass
  `--threads 1` to force serial.
- Either way, the *same* `(seed, threads)` reproduces the exact same battle
  results every run — worker assignment is a deterministic function of the
  battle list and thread count, not real-time scheduling.
- A threaded run's results are **bit-identical** to a serial run's, not just
  rank-equivalent — several distinct reused-instance state-leak mechanisms
  that used to cause rare cross-run drift (see `src/engine/README.md`'s
  "Resolved: battle order and reused-instance state" section for the full
  history) are all fixed. `--threads` trades nothing for its wall-clock
  speed; it is not an approximation of the serial path.

`scripts/bench.mjs` measures raw battle throughput if you want to compare
serial vs. threaded speed on your own machine before committing to a large
run — see `src/engine/README.md`'s "Parallel battles" section for how to
read its output, including the `--batches` mode that shows the persistent
worker pool's boot-cost amortization across repeated batches (the pattern
`scripts/tournament.mjs` and large multi-call runs actually use).

### Evolutionary team search (`scripts/evolve.mjs`)

Where `src/cli.js` and `scripts/tournament.mjs` sample a fixed set of
candidate teams and battle every one of them the same number of times,
`scripts/evolve.mjs` runs a seeded **genetic algorithm** instead: a
population of candidate teams is repeatedly battled, the worst performers
are culled, some survivors "mutate" (one team member swapped for another),
fresh immigrant teams keep new species entering the pool, and the process
repeats until the best teams converge or a cap is hit. The idea is that
battle budget concentrates on already-good teams instead of being spread
evenly across a static sample.

```bash
node scripts/evolve.mjs fixtures/sample-pokegenie.csv --population 8 --opponents-per-gen 3 --generations 3 --seed my-seed
```

**The selection scheme, in plain words** (see `PLAN.md` Rev 5 for the full
design): every generation, every team in the population is battled against
a fresh sample of opponent teams. The bottom 25% by win rate die. Each
*surviving* team then rolls a chance to mutate — the better a team did
relative to the rest of that generation, the more likely it mutates (from a
5% floor for the weakest survivors up to a 40% ceiling for the top) — and a
successful roll swaps exactly one team member for a different, meta-weighted
pick from your collection. The dead slots are refilled by these mutants plus
a small floor (~10% of the population) of brand-new random "immigrant"
teams, so the population never fully closes off to new ideas. This repeats
either until the top-10 team composition hasn't changed for 3 generations
in a row (convergence), or a generation/time cap is hit — the report says
which one stopped the run.

**Flags** (`node scripts/evolve.mjs --help` for the full list with
defaults): `--population`, `--opponents-per-gen`, and `--generations` size
the search (battles per generation ≈ `population × opponents-per-gen × 3`);
`--seed` controls reproducibility; `--threads` battles through the same
persistent worker-pool executor `--threads` uses elsewhere in this repo
(defaults to `max(1, cpus - 1)`); `--deadline-minutes` stops the run before
starting another generation once past budget; `--fixed-opponents` reuses one
opponent draw for every generation instead of a fresh one each time;
`--elites` controls how many of the final generation's top teams get the
full 9-lead-pairing report treatment (best lead, safe swap); `--cp`,
`--score-meta`, `--pool`, `--curated-ratio`, and `--exclude` mean the same
thing they do elsewhere in this repo.

**Reproducibility:** the same `--seed` (with everything else held equal)
reproduces the *identical* population trajectory, generation by generation —
population sampling, opponent draws, mutation rolls, and immigrant picks are
all derived from that one seed. Change the seed and you get a different
(but still deterministic) trajectory.

**Output:** `out/my-teams-evolve.md` / `out/my-teams-evolve.html` (same
`--out`/`--html`/`--no-html` flags as the other CLIs) report the final
elite teams (win%, best lead, safe swap, hardest opponents), a
generation-by-generation summary, a species-trajectory table (representation
per generation for the top species), and the top elite 2-species "cores".
Per-generation checkpoints (`out/evolve-gen<N>.json`) and a rolling
analytics file (`out/evolve-generations.json`) are also written — a killed
run resumes from its last completed generation automatically. All of the
analytics are **free**: they're computed by counting over data the battles
already produced, with no extra battles run to collect them.

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
- Great League (default) and Ultra League (`--cp 2500`) are both supported
  end-to-end; the community-curated opponent teams and the optional live
  usage snapshot are Great League only (see "Leagues (`--cp`)" above).
