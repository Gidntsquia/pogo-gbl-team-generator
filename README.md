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

### Building the CSV from a screen recording (`scripts/scan-video.mjs`)

**macOS only.** If you'd rather not keep a Poke Genie export up to date, you
can record your box with your phone and have that video turned into the CSV
above:

```bash
node scripts/scan-video.mjs my-box.mp4 --out out/scanned.csv
node src/cli.js out/scanned.csv
```

**How to record.** Open a Pokemon, tap **Appraise** so the three stat bars
are showing, then swipe through your box resting about a second on each
Pokemon. AirDrop the recording to your Mac. Frames caught mid-swipe are
thrown away on purpose, which is why the pause matters.

Two things the game does make this harder than it sounds, and the scanner
handles both rather than trusting any single frame:

- **The Pokemon is drawn over its own CP.** A wing or a flame crossing the
  digits makes the number read short (`968` comes back as `96`). So CP is
  settled per Pokemon rather than per frame: max HP is printed inside the
  white card where nothing covers it, and species + IVs + HP narrow the CP to
  a short list — usually one. A CP recovered that way is always reported as a
  warning, never written silently.
- **The appraisal bars animate in.** The first frame or two after a swipe
  genuinely shows shorter bars than the real IVs, so the frames of one
  Pokemon vote and the settled reading wins.

**What it reads, and from where:**

| Column | Read from |
| --- | --- |
| `cp` | the large `CP 1498` text above the Pokemon |
| `name` | the caught-location caption — *"This **Trevenant** was caught on…"* |
| `atk` / `def` / `sta` | the three appraisal bars, measured in pixels |
| `level` | not shown on screen — solved for from species + IVs + CP + max HP |
| `shadow` | the sliver of `PURIFY` / `POWER UP` button above the panel, or failing that the purple aura |
| the *form* | not stated anywhere — settled from CP + max HP + IVs, then the type badges |

A Pokemon is identified across frames by species + max HP, so two of the same
species scan as two rows as long as their HP differs.

The species deliberately comes from the caption rather than the name above
the stats, because that name is your own **nickname** — for most PvP players
it's a rank percentage ("Trevena91.1"), not a species.

Because CP, max HP and the three IVs over-determine each other, every row is
checked before it is written: if no level in the game's range produces the
CP *and* the HP that were read, the scan misread something and the row is
flagged as a warning instead of quietly landing in your CSV.

**Forms.** The caption gives the base species and nothing else: a Galarian
Corsola says *"This **Corsola** was caught on…"* just like an ordinary one,
and species the game only has forms of (Oricorio, Lycanroc, Morpeko) used to
be dropped entirely. So the form is *solved for* the same way the level is —
by asking which form has a level that produces the CP and the max HP that
were read. Usually exactly one does: a Corsola with 101 HP and 13/10/15 is
Galarian at level 20, and an ordinary one is nothing at all.

**Shadow.** No text on the appraisal screen says it. The caption gives the
base species with no "Shadow" in front of it, the name above the stats is
your own nickname, and the purple flames are a picture rather than a word.
Pokemon GO writes it down on the detail page *behind* the panel — the
`PURIFY` button and the `SHADOW BONUS` note under the moves — and those
frames have no bars and no caption to read either. The scan picks the marker
off them anyway and ties it back to a Pokemon by the CP and max HP still on
screen, so swiping with the panel shut once per Pokemon still works.

It is no longer necessary, though, because the panel does not quite cover the
page behind it. Two things show above its top edge:

- **The action button.** A shadow Pokemon's page has `PURIFY` above `POWER
  UP`; an ordinary one has only `POWER UP`. Either way the topmost of the two
  lands a few pixels above the panel — pink for `PURIFY`, green for `POWER
  UP`. There is no legible text left at that size, so it is read as colour,
  and always as a *difference* from the bare veil just above it rather than
  as an absolute (the panel's cream wash varies from card to card). This is
  the Pokemon's own page stating the fact, so it is never overruled. It
  answers for roughly two Pokemon in three; on the rest the page happens to
  be scrolled far enough that the buttons sit under the panel.
- **The aura.** For those, the purple smoke around the Pokemon decides.
  None of what makes the aura obvious to a person survives on its own — GO's
  backgrounds cycle through purple, navy and tan, half of them are dark, and
  several are animated — but the aura is *local*: on an ordinary card the
  background beside the Pokemon's feet matches the background under the CP
  text, and the aura darkens it and pushes it blue in only one of those two
  places. Measured against the 257 Pokemon in the test recordings whose
  button *could* be read, and which therefore have an answer that does not
  come from the aura, the rule gets all 26 shadows and none of the 231
  ordinary Pokemon — including a violet Sableye on near-black and a Hisuian
  Braviary lit magenta from behind. Of the 136 it then answered for on its
  own, one had to be corrected by hand, and the rule was tightened until it
  got that one too.

The scan says which of the two answered for how many, and names the ones the
aura called shadow: that half is a strong resemblance rather than a stated
fact, and it is the half worth a second look.

When two forms are stat-for-stat identical the type badges under the HP text
break the tie — that is the only thing separating Oricorio's four dance
forms, which differ solely by type. And when even that cannot (Morpeko's two
forms; a Galarian Stunfisk, whose *"GROUND"* badge Vision reads without the
*"STEEL"* one beside it) the row is written as the form Pokemon GO stores by
default **and says so in a warning**, so those are the rows worth a glance.

```
node scripts/scan-video.mjs <video.mp4> [options]
  --out PATH      CSV output path                 (default out/scanned.csv)
  --interval S    seconds between sampled frames  (default 0.25)
  --no-level      skip level derivation (faster; leaves the level column blank)
  --json PATH     also write the full per-Pokemon detail as JSON
  --quiet         only print the summary line
```

Roughly half the length of the recording: a 28-second clip of 15 Pokemon
scans in about 14 seconds.

No npm dependency, no ffmpeg and no OCR install: frame decoding is
AVFoundation and text recognition is Apple's Vision framework, both macOS
system frameworks, driven by the small `src/videoscan/scan.swift` helper.
That helper needs the Xcode Command Line Tools (`xcode-select --install`);
it is compiled once into `out/.videoscan/` and reused (an unoptimized script
run is ~5x slower, since it measures every pixel of every sampled frame).
Everything it doesn't do — deciding what a frame shows, measuring the bars,
grouping frames into Pokemon — is plain JavaScript in `src/videoscan/` and is
unit-tested against recorded frames in `fixtures/videoscan/`.

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
  --no-evolutions    score mons only in the form you own (never evolve them)
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

### Build cost: what a recommended team costs in Stardust

Every Pokemon is simulated at the **highest level whose CP still fits under
the league cap** (`buildPokemon`, `src/engine/harness.js`) — that's what the
mon *would* be if you built it, not what it is today. A level 6 Stunfisk with
good IVs will happily show up on a winning Ultra League team, and building it
is half a million Stardust.

So every ranked team in the report carries its **build cost**: the Stardust
and Candy needed to bring all three members from the level your CSV states up
to the level the simulator played them at, with a per-member breakdown.

```
- **Build cost:** 829,600 Stardust + 602 Candy + 326 Candy XL

| Member | Level | Stardust | Candy | Candy XL |
| --- | --- | ---: | ---: | ---: |
| Stunfisk | 6 → 50 | 516,400 | 294 | 296 |
| Conkeldurr | 26 → 28 | 17,000 | 16 | 0 |
| Greninja | 7 → 41.5 | 296,200 | 292 | 30 |
| **Total** | | **829,600** | **602** | **326** |
```

Details, all in `src/cost/powerup.js` (pure arithmetic, no engine):

- Levels 40 and up spend **Candy XL**, reported separately because it can't
  be bought — often the real blocker rather than the Stardust.
- **Shadow** costs 20% more Stardust and Candy per power-up, **purified** 10%
  less, **lucky** half the Stardust. The `shadow`/`purified`/`lucky` columns
  drive this; absent columns mean "no".
- Level 50 → 51 is the free Best Buddy boost and is never billed.
- A mon already at or past its simulated level costs nothing.
- A mon whose CSV row states **no level** contributes nothing and the team's
  cost is explicitly flagged as excluding it — a partial bill is never shown
  as a full one.
- The cost table is transcribed from the published per-half-level costs
  (neither this repo nor `vendor/pvpoke` ships one). It's pinned by four
  published totals asserted in `test/cost.test.js`: level 1 → 40 is 270,000
  Stardust + 304 Candy, level 40 → 50 is 250,000 Stardust + 296 Candy XL,
  and the same 40 → 50 run costs 360 Candy XL shadow / 272 purified.

Evolution Candy is included when the team wants a form you don't own yet —
see the next section.

### Evolutions: mons compete as what they could become

The engine levels a Pokemon up to the CP cap but never evolves it, so a
Phantump used to be simulated *as a Phantump* — losing every matchup for a
reason that has nothing to do with whether it's worth building.

By default every mon now also competes as each species it can still evolve
into, transitively (a Timburr yields both Gurdurr and Conkeldurr), carrying
the same IVs, level and shadow/purified/lucky/Best Buddy flags, because
evolving in Pokemon GO changes none of those. Pass `--no-evolutions` to score
only the forms you actually own.

There is no hand-tuned "is it viable?" rule. Every form is scored normally and
the existing ranking decides: `dedupeBestPerSpecies` (`src/teams/index.js`)
collapses each **lineage** — every form derived from one CSV row — down to
whichever form actually scored best. So a Phantump that can hold its own stays
a Phantump, and one that can't gets replaced by its Trevenant. Because a
lineage only ever contributes one entry to the candidate pool, no team can
field both forms of the same physical Pokemon.

Two fields deliberately do not carry over to an evolved variant:

- **CP** — the CSV's value belongs to the unevolved form; the engine
  recomputes it from the evolved base stats.
- **Current moves** — the evolved form has a different movepool, so under
  `--current-moves` the variant falls back to pvpoke's recommended moveset,
  with a warning saying so.

Evolution data comes from vendor/pvpoke's own `family.evolutions`. The candy
costs don't: pvpoke parses the official GAME_MASTER and drops them
(`src/data/parseEvolution.php`), so they're baked into
`src/cost/evolutionCandy.json` by `scripts/build-evolution-costs.mjs` — 501
priced pairs, with 12 left unpriced (listed in the file's own `_unpriced`
field: pvpoke names a handful of evolutions the official file doesn't branch
to, e.g. `stantler > wyrdeer`). Those are scored normally but reported as an
unknown evolution cost rather than a guessed one. Shadow evolutions cost 20% more candy, rounded up; purified uses
the official file's own published figure. Any item an evolution needs
("Metal Coat", "Sinnoh Stone") is carried through to the report, since candy
totals don't express that blocker.

Expansion applies to `src/cli.js`, `scripts/evolve.mjs` and
`scripts/tournament.mjs` (all take `--no-evolutions`; it's part of the GA's
and tournament's checkpoint config, so flipping it starts a fresh run rather
than resuming an incompatible one). `scripts/shield-weight-review.mjs` is left
alone on purpose — it compares shield weightings on a fixed mon set, where
extra forms would only add noise.

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
`src/meta/sampleTeams.js`):

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
  fraction) plus weighted-random 3-mon compositions. The composed half draws
  from a **meta-capped** species pool: the top N species by pvpoke's own
  overall ranking score (default 100, `--opponent-meta-pool` in
  `scripts/evolve.mjs`), *then* weighted by usage within that pool. The cap
  decides "does anyone play this"; the weights decide "how often, among
  those". Weighting alone was not enough — at the usage exponent of 2.5 the
  top 50 species hold only ~7% of the total weight across pvpoke's
  1,144-species field, so an uncapped draw produced three fringe picks per
  team and applied no real pressure. Every opponent team, curated or
  composed, carries a **designated lead** in `members[0]`: curated teams
  declare it in the data file, composed ones get the member with the highest
  `lead` role prior (see "Role priors" below).
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
  results every run — and so does a *different* thread count, and so does
  serial. What a result depends on is its own spec and seed, nothing else.
  (Which worker runs which battle is not fixed: workers take a contiguous
  chunk each and then steal from whoever is furthest behind, so nobody sits
  idle waiting on a straggler. Nothing observable depends on the assignment —
  see `src/engine/parallel.js`'s "Tail work-stealing".)
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

**The selection scheme, in plain words** ("locked leads" and
battle-reality fitness are both described below): every generation, every team
in the population is battled against every team in the opponent pool (which is
a population of its own — see "Both sides evolve" below). The bottom third by
win rate die. Each
*surviving* team then rolls a chance to mutate — the better a team did
relative to the rest of that generation, the more likely it mutates (from a
5% floor for the weakest survivors up to a 40% ceiling for the top) — and a
successful roll either swaps one team member for a different, meta-weighted
pick from your collection, or (about 30% of successful rolls) promotes a
bench member to lead instead. The dead slots are refilled by these mutants
plus a small floor (~10% of the population) of brand-new random "immigrant"
teams, so the population never fully closes off to new ideas. This repeats
either until the top-10 team composition hasn't changed for 3 generations
in a row (convergence), or a generation/time cap is hit — the report says
which one stopped the run.

**Locked leads:** a team isn't just 3 species — it's a
*(lead, back, back)*, and which mon leads is part of what makes two teams
different individuals in the population (evolution can promote a back to
lead via the lead-rotation mutation above, same spirit as a member swap).
Every generation's fitness battle battles a team ONLY at its own declared
lead, against each opponent's own declared lead — one battle per opponent
instead of the pre-Rev-6 scheme's three, freeing up ~3x the battle budget to
spend on `--opponents-per-gen`/`--generations` instead. Opponents declare a
lead the same way candidates do: curated teams from the data file, composed
ones from pvpoke's `leads` role prior at composition time. The final elites
pass uses the same one-pairing rule (it used to spread each elite over all 3
of the opponent's possible leads) — now that every opponent has a real lead,
averaging over two leads nobody plays only adds noise.

**Fitness: `--fitness classic|battle-reality`:** by
default (`battle-reality`) a team's fitness blends its plain
locked-lead win rate with two more signals, both computed for free from the
same battles (no extra simulation): a **snowball score** (this team's own
fraction of decided lead exchanges it won this generation — how often its
lead outlasts the opponent's, independent of whether the game is ultimately
won) and a **closer score** (the mean of its two back-line members' `closer`
role prior from pvpoke's own rankings — see "Role priors" below). Real-battle
measurement found winning the lead exchange is roughly a 2.3–2.7x multiplier
on win probability, so the default blend weights it meaningfully
(`winRate=0.6, snowball=0.3, closer=0.1`, documented in
`scripts/evolve.mjs`). `--fitness classic` restores the plain win-rate
metric (today's original behavior, still fully supported) — both scores are
always computed and shown in the report regardless of mode, so you can see
how a team is winning, not just whether it is.

`battle-reality` became the default on the strength of a real A/B (same
seed/collection/opponents, `--fitness classic` vs
`--fitness battle-reality`): battle-reality's
top-10 showed the exact shift the battle-reality work was built to
produce — Stunfisk (Galarian)/Azumarill's share of the top 10 teams fell
(5→2 and 7→5 team-appearances respectively) while Skarmory, absent from
classic's top 10 entirely, entered twice as a back-line closer pick, and
Medicham rose 2→5. The #1 team is the same three species in both runs, led
by a different member (Medicham under classic, Sableye under battle-reality).

**Two report metrics distinct from the fitness-blend components above** —
per elite team: a
**snowball index**, P(win the game | won the lead exchange), and a
**comeback index**, P(win the game | lost the lead exchange) — both `n/a`
when a team had zero decided exchanges of that kind to measure from (not
0%, which would imply a measured failure); and a **designated closer**, the
higher-`closer`-prior of the team's two back members specifically (not the
mean the closer score above uses). Teams are named `Lead / Back / Back` in
every report table and heading. `out/evolve-generations.json` also carries
each generation's top-10-by-fitness teams (`topTeams`) with these same
fields, so they're trackable across generations, not just in the final
elites pass.

**Both sides evolve** (`src/meta/opponentPool.js`): the opponent pool is not
re-drawn from scratch each generation — it is a *persistent population* that
culls, mutates and takes immigrants just like the candidate side, so "beat the
opponent pool" cannot collapse into "beat one fixed list of ~110 curated
teams". That collapse is exactly the overfitting this design exists to break.
The two sides run at deliberately different temperatures:

| | candidate pool (`src/teams/evolve.js`) | opponent pool (`src/meta/opponentPool.js`) |
| --- | ---: | ---: |
| culled per generation | 1/3 | 15% of the evolvable half |
| mutation rate | 5% → 40% (fitness-ramped) | 2% → 20% (fitness-ramped) |
| curated-entry mutation | — | 3% flat |
| immigrants | ~10% | ~8% of the evolvable half |

The opponent pool is a *measuring instrument*, not a search: churning it hard
would make a candidate's win rate mean something different every generation.
**Curated entries are protected** — never culled, never modified in place, and
topped back up to `--curated-ratio` of the pool every generation. They can
still throw off a mutant (at that 3% flat rate), but the mutant is a *new*
entry with `origin: 'curated-mutant'` taking a freed evolvable slot while the
real team stays in the pool untouched. That is what keeps the pool anchored to
teams actually observed on the ladder. An opponent's fitness is free: it is
`1 - (mean candidate win rate against it)`, the other side of the ledger the
generation's battles already produced.

**The schedule** (`--population-final-ratio`): the candidate population
*shrinks* over the run (to 40% of `--population` by the last generation, floor
12) while the opponent count *grows* to match, holding `population ×
opponents` — the per-generation battle grid — roughly flat. Late generations
therefore measure fewer, better teams against a much wider field, instead of
spending the same budget re-confirming that the weak teams are weak.

**The ranking number:** the report sorts on a **Score** that blends the elites
pass with recent history — `0.7 × elites-pass win% + 0.3 × mean win% over the
last 5 generations` (the last *quarter* of the run when fewer than 20
generations ran). The elites pass is the only apples-to-apples measurement, so
it carries the majority; the trailing average spans several independent
opponent pools, which is what filters out a team that merely drew a friendly
final generation. A team younger than the window ranks on the elites pass
alone. Both components are printed next to the Score in every report table.

**Battle memo cache:** identical pairings are memoized within a run, keyed on
the two teams' resolved specs and leads. pvpoke battles are deterministic, so
a cache hit returns the numbers a re-simulation would have produced — this is
a speed knob, not an accuracy trade. Hit rate is reported in the run summary.
`--no-battle-cache` re-simulates everything (an escape hatch for A/B checking
the cache itself, not a correctness setting).

**Flags** (`node scripts/evolve.mjs --help` for the full list with
defaults): `--population`, `--opponents-per-gen`, and `--generations` size
the search (battles per generation ≈ `population × opponents-per-gen`, one
battle per pairing under the locked-lead scheme above); `--seed` controls
reproducibility; `--threads` battles through the same persistent worker-pool
executor `--threads` uses elsewhere in this repo (defaults to
`max(1, cpus - 1)`); `--deadline-minutes` stops the run before starting
another generation once past budget; `--fixed-opponents` freezes the opponent
pool at its generation-0 draw (no evolution, no resizing) — the pre-arms-race
behavior, kept for A/B comparisons; `--elites` controls how many of the final
generation's top teams get the final evaluation pass (the ranking win%, safe
swap, hardest opponents);
`--population-final-ratio` sets how far the candidate population shrinks by the
last generation; `--opponent-meta-pool` caps the composed opponents' species
pool; `--no-battle-cache` disables pairing memoization; `--fitness` selects the
fitness metric (above); `--cp`, `--score-meta`, `--pool`, `--curated-ratio`
(default 0.66), and `--exclude` mean the same thing they do elsewhere in this
repo.

**Checkpoint format:** each `out/evolve-gen<N>.json` is tagged with a
`formatVersion`. A checkpoint written under an incompatible population/
battle scheme (e.g. from before the locked-lead change above) is refused
with a clear error on resume rather than silently misread — delete the
`out/evolve-gen*.json`/`out/evolve-DONE` files under your `--out-dir`, or
pass a fresh `--out-dir`, to start over.

**Reproducibility:** the same `--seed` (with everything else held equal)
reproduces the *identical* population trajectory, generation by generation —
population sampling, opponent draws, mutation rolls, and immigrant picks are
all derived from that one seed. Change the seed and you get a different
(but still deterministic) trajectory.

**The final elites pass** fights each of the top `--elites` teams against
*every* curated team, untouched and at its declared lead, plus the strongest
teams the opponent pool evolved over the run — in practice all of them, since
the live pool holds far fewer evolvable entries than the ~110 curated teams.
Both sides lead with their designated lead, one battle per pairing, so the
headline win% is a team's record against the real field.

**Output:** `out/my-teams-evolve.md` / `out/my-teams-evolve.html` (same
`--out`/`--html`/`--no-html` flags as the other CLIs) report the final
elite teams (Score, elites-pass win%, trailing win%, safe swap, hardest
opponents), a generation-by-generation summary, a species-trajectory table
(representation per generation for the top species), the final opponent pool's
composition and toughest members, and the top elite 2-species "cores".
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

### The community team file

`data/meta-teams-community.json` is our own data (not vendor), read by
`src/meta/teams.js`. Each entry names a 3-mon team; members are pvpoke
speciesIds, with a `_shadow` suffix for shadow forms, and `members[0]` is
always that team's lead.

**Tiers set how often a team is drawn** from the curated pool. The gradient is
"how much does drawing this team tell me about what I will actually face":

| `tier` | weight | what it is |
|---|---|---|
| absent (meta) | 1 | a team fought on the GBL ladder, or one from PvPoke's own top-performer listings |
| `recommended` | 0.5 | a top player's *recommended* team, transcribed from an infographic or stream screenshot — second-hand and dated |
| `off-meta` | 0.25 | carried for surface diversity, not because it is likely |

`loadMetaTeams` orders the merged pool by descending weight, so a small
`--meta` limit reaches the teams most like real opponents first. The numbers
live in one place, `CURATED_TIER_WEIGHTS` in `src/meta/teams.js`.

**Members normally build with pvpoke's recommended moveset.** When a real
opponent was seen carrying something else, write that member as an object
instead of a bare string:

```jsonc
"members": [
  { "speciesId": "empoleon", "fastMove": "WATERFALL" },       // charged moves stay recommended
  { "speciesId": "florges", "chargedMoves": ["CHILLING_WATER", "TRAILBLAZE"] },
  "azumarill"                                                  // fully recommended
]
```

Both move fields are optional and merge independently over the recommendation,
so an entry states only the half it observed. A move the species cannot learn
warns on stderr and that slot falls back to the recommendation — the team still
loads. (Only an unresolvable *speciesId* drops a team, and it drops the whole
team: two mons isn't a team.)

## Tests

```bash
npm test                              # fast tier (~1s) -- what to run while working
npm run test:changed                  # only what the working tree touches
npm run test:full                     # the union, incl. real battles -- before a push
node --test test/<file>.test.js       # one suite (never skips, even a slow one)
```

The tier is a marker, not a list: a file is slow when its header comment
contains `@slow`, and `scripts/tests.mjs` reads that and nothing else.
`test/e2e.test.js` is the only file that runs real pvpoke battles and the only
`@slow` one; everything else works on hand-built fixtures or pure functions.

`test/videoscan.test.js` covers the video importer against real frames
recorded off a phone — `fixtures/videoscan/appraisal-frames.jsonl` (a
downscaled clip) and `ultra-frames.jsonl` (full resolution, including a
maxed stat drawn in red, a CP behind the Pokemon's animation, and a frame
caught while the bars were still filling) — so it needs no video and no
macOS frameworks to run.

`test/e2e.test.js` runs the full pipeline (import → score → build meta
teams → evaluate → report) against the bundled fixture collection with a
small search size, and checks the resulting report file. It is the one place
real battles run: every other suite asserts against the shared runs already at
its module scope, or against hand-built fixtures.

## Known limitations / not yet implemented

- No *automatic* Best Buddy (level 51) detection — a stock Poke Genie
  export carries no Best Buddy column, so it must be added by hand (see
  "Best Buddy (level 51) mons" above) for those mons to be scored/built at
  level 51.
- Teams are built and scored using each Pokemon's pvpoke-*recommended*
  moveset by default — pass `--current-moves` to use each mon's actual
  currently-learned moves instead (see "Current-moves mode" above); moves
  that don't resolve fall back to recommended with a warning.
- The video importer (`scripts/scan-video.mjs`) is macOS-only, needs the
  appraisal panel visible in the recording, and cannot see a Pokemon's
  moves, Lucky or Best Buddy status. Shadow it does read, from the sliver of
  page above the panel (see "Shadow" above).
- Great League (default) and Ultra League (`--cp 2500`) are both supported
  end-to-end; the community-curated opponent teams and the optional live
  usage snapshot are Great League only (see "Leagues (`--cp`)" above).
