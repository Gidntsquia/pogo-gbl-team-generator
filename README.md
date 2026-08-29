# PoGo GBL Team Generator 🏆

Finds the best GO Battle League teams you can build from *your own* Pokemon.
It fights real 3v3 battles — switches, shields, AI and all — against the
current meta using [pvpoke](https://pvpoke.com)'s own battle engine, then
hands you a podium:

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/podium-dark.png">
    <img alt="The top three teams from a full run, on a podium" src="docs/podium-light.png">
  </picture>
</p>

That's a real run: 100 generations of evolution over my 107-mon collection,
443,923 battles fought.

## Quickstart 🚀

1. Take a screen recording of yourself swiping through all your Pokemon with
   the "appraise" panel open.
2. Turn the video into a CSV with
   [Pokemon GO Video-to-CSV](https://github.com/Gidntsquia/pokemon-go-video-to-csv)
   (macOS only). A [Poke Genie](https://pokegenie.app) export works too
   (Settings → Export → CSV).
3. Run this (needs Node ≥ 18):

```
git clone https://github.com/Gidntsquia/pogo-gbl-team-generator
cd pogo-gbl-team-generator
npm run setup                        # Downloads pvpoke's engine + data. Required!
node src/cli.js your-collection.csv
```

Your best teams get printed to the terminal, and the full report lands in
`out/report.md` + `out/report.html`. No CSV handy? Try the sample one:

```
node src/cli.js fixtures/sample-pokegenie.csv
```

More toys:

```
node src/cli.js my.csv --cp 2500 --threads 4          # Ultra League, battles on 4 threads
node scripts/evolve.mjs my.csv --deadline-minutes 30  # genetic algorithm team search
node src/cli.js --help                                # everything else
```

## What it can do 💪

- Ranks teams by **real battles**, not stat spreadsheets — every candidate
  team fights full 3v3s against curated ladder teams and meta picks, across
  all 9 lead pairings.
- Evolves teams with a **genetic algorithm** (`scripts/evolve.mjs`) while the
  opponent pool evolves right back, so winners can't overfit one fixed list.
  Killed runs resume from their checkpoints.
- Battles every mon as anything it could still **evolve** into — your level 6
  Phantump gets judged as a Trevenant if that's what it takes.
- Prices out every team: the **Stardust, Candy, and Candy XL** to actually
  build it, including shadow/purified/lucky discounts and evolution items.
- Great League and Ultra League (`--cp 2500`), plus cup bans (`--ban`).
- Same seed = same result, bit for bit, serial or on `--threads N`.
- Watch the whole search unfold in the report's team race — every line is one
  team's win rate per generation, and the colored ones are the final top 10:

<p align="center">
  <img alt="Animated race chart of every team's win rate per generation" src="docs/team-race.gif">
</p>

## Docs 📚

Everything else is in the
[wiki](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki):

- [Running the CLI](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/Running-the-CLI) — every flag, leagues, Best Buddies, current moves, tuning, threads
- [How Scoring Works](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/How-Scoring-Works) — 1v1 pruning, 3v3 ranking, sampling weights, role priors
- [Build Costs and Evolutions](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/Build-Costs-and-Evolutions) — the Stardust/Candy math
- [Evolutionary Team Search](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/Evolutionary-Team-Search) — the genetic algorithm, fitness modes, checkpoints
- [Shared Collections](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/Shared-Collections) — teams two players can both build
- [Development and Tests](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/Development-and-Tests) — test tiers, what to run when
