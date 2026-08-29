# pogo-gbl-team-generator

Feed in your Pokemon GO collection, get back the best GO Battle League teams
you can actually build — ranked by fighting real **3v3 team battles** against
the current meta, using [pvpoke](https://pvpoke.com)'s own battle simulator
(vendored and executed headlessly, never reimplemented).

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/podium-dark.png">
    <img alt="Podium from the HTML report: the top three teams of a 100-generation run over a 107-mon collection, 443,923 battles fought" src="docs/podium-light.png">
  </picture>
</p>

<p align="center"><sub>The HTML report's podium from a real run: 100 generations of evolutionary
search over a 107-mon collection — 443,923 battles fought.</sub></p>

## What it can do

- **Rank teams by real battles, not stat spreadsheets** — every candidate
  team fights full 3v3 battles (switching, shared shield pool, AI decisions,
  all 9 lead pairings) against curated ladder teams plus weighted-random
  compositions from the current meta.
- **Search your whole collection with a genetic algorithm**
  (`scripts/evolve.mjs`) — candidate teams evolve over generations while the
  opponent pool co-evolves against them, so a winner can't overfit one fixed
  list. Checkpoints let a killed run resume where it stopped.
- **Respect what you actually own** — imports a Poke Genie export (or a
  simple generic CSV), scores each specimen's own IVs, and by default also
  battles each mon as every evolution it could still become.
- **Tell you what a team costs to build** — Stardust, Candy, and Candy XL
  from each mon's current level to its optimal league build, with
  shadow/purified/lucky adjustments and evolution items included.
- **Cover Great and Ultra League** end-to-end (`--cp 2500`), with cup rules
  via `--ban` (removes a species from both sides of the format).
- **Stay deterministic** — one seed reproduces an identical run,
  bit-for-bit, serial or across `--threads N` worker threads.
- **Write a real report** — Markdown plus a self-contained HTML page with
  the podium above and an animated generation-by-generation team race:

<p align="center">
  <img alt="Animated race chart: each team's win rate per generation over a 100-generation evolutionary run; the final top 10 are colored, the rest of the field is grey" src="docs/team-race.gif">
</p>

<p align="center"><sub>Every line is one team's win rate against the co-evolving opponent pool;
the colored lines are the run's final top 10.</sub></p>

## Quick start

Requires Node ≥ 18.

**1. Get your collection as a CSV.** Take a screen recording in Pokemon GO of
yourself swiping through all your Pokemon with the **appraisal panel open**,
then run the video through the importer in
[Pokemon GO Video-to-CSV](https://github.com/Gidntsquia/pokemon-go-video-to-csv)
(macOS only) — it produces the collection CSV this app reads. A
[Poke Genie](https://pokegenie.app) export (Settings → Export → CSV) works too.

**2. Run the pipeline on it:**

```bash
npm run setup                        # clones pvpoke's engine + data into vendor/ (required after every fresh clone)
node src/cli.js your-collection.csv  # the CSV from the video importer (or Poke Genie)
```

This prints the top teams to the terminal and writes `out/report.md` plus a
styled, self-contained `out/report.html`. No collection handy? Try the
bundled fixture:

```bash
node src/cli.js fixtures/sample-pokegenie.csv
```

Going further:

```bash
node src/cli.js my.csv --cp 2500 --threads 4          # Ultra League, battles across 4 threads
node scripts/evolve.mjs my.csv --deadline-minutes 30  # genetic-algorithm team search
node src/cli.js --help                                # every flag
```

## Documentation

The full docs live in the
**[project wiki](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki)**:

- [Running the CLI](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/Running-the-CLI)
  — setup, every flag, leagues (`--cp`), Best Buddy mons, current-moves
  mode, tuning the search, parallel battles.
- [How Scoring Works](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/How-Scoring-Works)
  — the 1v1 pruning matrix, the 3v3 ranking, sampling weights, role priors,
  the community team file.
- [Build Costs and Evolutions](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/Build-Costs-and-Evolutions)
  — the Stardust/Candy/XL bill on every ranked team; mons competing as what
  they could become.
- [Evolutionary Team Search](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/Evolutionary-Team-Search)
  — the GA, the co-evolving opponent pool, fitness modes, convergence,
  checkpoints, `--ban`.
- [Shared Collections](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/Shared-Collections)
  — teams two players can both build.
- [Development and Tests](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/Development-and-Tests)
  — the test tiers and what to run when.
