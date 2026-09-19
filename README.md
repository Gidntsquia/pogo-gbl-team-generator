# Pokémon Go GBL Team Generator 🏆

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/podium-top3-dark.png">
    <img alt="The top three teams from a run, on a podium" src="docs/podium-top3-light.png">
  </picture>
</p>

Node.js tool that finds the strongest GO Battle League teams buildable from
your own Pokemon collection, by simulating full 3v3 battles against the
current meta with [pvpoke](https://pvpoke.com)'s battle engine.

<p align="center">
  <img alt="Animated race chart of every team's win rate per generation" src="docs/team-race.gif">
</p>

The run above — which produced the podium at the top — covers 100 generations
of evolutionary search over my 107-mon collection, 443,923 battles simulated.
Each line is one team's win rate per generation; the colored lines are the
final top 10.

## Quickstart 🚀

1. Take a screen recording of yourself swiping through all your Pokemon with
   the "appraise" panel open.
2. Convert the video into a CSV with
   [Pokemon GO Video-to-CSV](https://github.com/Gidntsquia/pokemon-go-video-to-csv)
   (macOS only). A [Poke Genie](https://pokegenie.app) export also works
   (Settings → Export → CSV).
3. Run this (requires Node ≥ 18):

```
git clone https://github.com/Gidntsquia/pogo-gbl-team-generator
cd pogo-gbl-team-generator
npm run setup                        # Downloads pvpoke's engine + data (required after every fresh clone)
scripts/sim.sh your-collection.csv --name mine --threads 4 --hours 1
```

The search runs in the background; its report is written to
`out/evolve-mine/my-teams-evolve.md` (+ `.html`). A sample collection is included for
trying it out:

```
node scripts/evolve.mjs fixtures/sample-pokegenie.csv --generations 2 --population 12 --opponents-per-gen 8 --threads 2
```

Other common invocations:

```
node scripts/evolve.mjs my.csv --cp 2500 --threads 4  # Ultra League, battles on 4 threads
node scripts/evolve.mjs my.csv --deadline-minutes 30  # time-boxed search
node scripts/evolve.mjs --help                        # full flag list
```

## Features 🔬

- Rankings come from simulated 3v3 battles (switching, shields, AI), run
  across all 9 lead matchups.
- Genetic-algorithm search (`scripts/evolve.mjs`): candidate teams and the
  opponent pool evolve against each other; interrupted runs resume from
  checkpoints.
- Mons are also evaluated as each evolution they can still become.
- Build costs are reported per team: Stardust, Candy, and Candy XL, with
  shadow/purified/lucky modifiers and evolution items.
- A meta-vs-meta mode (`scripts/sim.sh --meta`) runs the search with no
  collection, and its results can seed the curated opponent teams for a new
  cup or season.
- Great League and Ultra League (`--cp 2500`), pvpoke cups (`--cup willpower`), and species bans via `--ban`.
- Deterministic: the same seed gives identical results, serial or with
  `--threads N`.

## Documentation 📚

For running evolutionary simulations, including the complete standard recipe
and genetic settings, see the local [Runbook](RUNBOOK.md).

Detailed documentation is in the
[wiki](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki):

- [Running the CLI](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/Running-the-CLI) — `sim.sh`, common flags, leagues, cups, Best Buddies, threads
- [How Scoring Works](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/How-Scoring-Works) — 3v3 battles, sampling weights, role priors, curated opponent file
- [Build Costs and Evolutions](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/Build-Costs-and-Evolutions) — the Stardust/Candy math
- [Evolutionary Team Search](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/Evolutionary-Team-Search) — the genetic algorithm, fitness, checkpoints
- [Shared Collections](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/Shared-Collections) — teams two players can both build
- [Development and Tests](https://github.com/Gidntsquia/pogo-gbl-team-generator/wiki/Development-and-Tests) — test tiers, what to run when

## License 📄

[MIT](LICENSE). The vendored battle engine ([pvpoke](https://github.com/pvpoke/pvpoke))
is also MIT-licensed and is downloaded at setup rather than distributed here.
