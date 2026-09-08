# Simulation Runbook

Operational reference for running this app. Written so an AI assistant can
complete every routine task from this file alone, without reading source.
Run every command from `/home/jaxon/files/pogo-gbl-team-generator` in WSL.

What the app does: take a Pokemon GO collection CSV, find the best 3-mon GO
Battle League teams buildable from it, ranked by real 3v3 battles run through
pvpoke's vendored engine. Two front doors:

| Want | Run | Time |
| --- | --- | --- |
| Quick answer, small sample | `node src/cli.js <csv>` | ~1-3 min |
| Real answer, evolutionary search (the normal case) | `scripts/sim.sh <csv> --name NAME --threads 8 --mutation-floor-start 0.15 --mutation-ceil-start 0.6` | ~8 h |

Everything else in this file supports the second row.

## 1. Preflight (every session, every scheduled run)

```bash
cd /home/jaxon/files/pogo-gbl-team-generator
test "$(git branch --show-current)" = "codex/twilight-trails-preview"
bash scripts/setup.sh          # materializes/repairs vendor/pvpoke (gitignored) at the pin
test "$(git -C vendor/pvpoke rev-parse HEAD)" = "712d3bdbd2061e4c4ab9941c6ab53a58c5cbac92"
```

`setup.sh` is idempotent and fixes an existing checkout to the pin.
`sim.sh` only repairs a *missing* `vendor/pvpoke`; it never re-checks the pin,
so run `setup.sh` yourself first.

Optional sanity check that the preview-season move data is loaded:

```bash
jq -r '.moves[] | select(.moveId=="BODY_SLAM" or .moveId=="BUBBLE_BEAM" or .moveId=="INFESTATION")
  | [.moveId,.power,.energy,.energyGain] | @tsv' vendor/pvpoke/src/data/gamemaster.json
```

Expected: `BODY_SLAM 65 40 0`, `BUBBLE_BEAM 50 50 0`, `INFESTATION 10 0 12`.

Requirements: Node 18+, `jq` for the check above. Machine: 8 cores / 16
threads, 8 GB RAM. Every recent run used `--threads 8`; `--threads 12` measured
fastest in isolation; the raw `cpus-1` count (15) is slower and OOM'd the VM
twice on bare `evolve.mjs` invocations of the new-season, all-generated-
opponents recipe (each worker boots its own pvpoke engine context, so more
threads costs memory as well as CPU). `defaultThreadCount()` in
`src/engine/parallel.js` now caps the automatic default at 8 for this reason,
so an omitted `--threads` is safe -- but keep passing `--threads 8` explicitly
anyway per "Why `--threads 8`" in section 3, since it is also the measured-
fastest count on this machine, not just the safe one.

Memory over a long run: each worker caches every built Pokemon it has seen
(`src/engine/parallelWorker.js`). Before 2026-09-07 that cache was unbounded,
so RSS grew for the whole run (mutation keeps introducing new IVs/movesets)
-- that was the "leak" `scripts/mem-watchdog.sh` was written to contain. It is
now an LRU capped at 5000 entries/side/worker (~120 MB per worker, ~1 GB at
`--threads 8`), which still spans many generations of turnover and keeps every
recurring mon hot. `POGO_GBL_WORKER_CACHE=N` raises or lowers the cap; the
watchdog is still worth running as a backstop.

## 2. Inputs on disk

Collection CSVs live in the repo root, are gitignored, and are personal data.
Never commit, move, or rename them.

| File | Owner | Rows |
| --- | --- | ---: |
| `jaxon-gl-collection.csv` | Jaxon, Great League | ~107 |
| `jaxon-ultra-league.csv` | Jaxon, Ultra League (use `--cp 2500`) | ~15 |
| `jet-gl-collection.csv` | Jet, Great League | ~395 |
| `marisa-gl-collection.csv` | Marisa, Great League | ~429 |
| `shared-gbl-collection.csv` | Jaxon ∩ Jet, built by `build-shared-collection.mjs` | ~66 |

CSV shape (header + one mon per row; Poke Genie exports also work):

```text
name,atk,def,sta,shadow,level,cp
Ninetales,9,15,12,,24,1500
```

Test fixtures for dry runs without personal data: `fixtures/*.csv`.

## 3. Standard evolve run (the normal task)

### The recipe every recent real run used

All runs since 2026-08-29 (`shared-24h-1`, `marisa-8h-1`, `marisa-2-1`) were
launched with the `sim.sh` recipe **plus** two additions the user has said
they like the results of. Treat this as the default unless told otherwise:

```bash
COLLECTION="marisa-gl-collection.csv"
RUN_NAME="marisa-season-note-1"        # unique, shell-safe; doubles as the PRNG seed

bash scripts/setup.sh
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8 \
  --mutation-floor-start 0.15 --mutation-ceil-start 0.6 \
  --dry-run                            # inspect, then rerun without --dry-run
```

| Addition | Why |
| --- | --- |
| `--mutation-floor-start 0.15 --mutation-ceil-start 0.6` | hot-start mutation: 15-60% at generation 0, decreasing linearly to the standard 5-40% at the last generation (`mutationRatesAt` in `scripts/evolve.mjs`, covered by a unit test); user asked for this to widen early diversity |
| `--threads 8` | what every recent run used; ~2 GB RSS on an 8 GB machine with headroom for the user's desktop. Re-measured 2026-09-04: 8 is fastest, 12 and 15 are slower (see "Why `--threads 8`" below) |

The dry run prints collection, seed, out dir, bans, budget, and the full
`evolve.mjs` command. Confirm bans, anneal flags, and threads appear, then
launch. The launcher refuses to start if `out/evolve-RUN_NAME.pid` points at a
live process.

Add `--exclude carbink` only when asked (the user has excluded Carbink from
candidates before because it is too expensive to build; opponents keep it).
Add `--hours H` when the user gives a time budget; the 8 h marisa run used
`--hours 7.75` (465 min) to leave room for the final pass.

### The "as large as possible" 24 h recipe

Used for `shared-24h-1` when the user asked for large populations to reduce
overfitting. Bare `evolve.mjs`, because `sim.sh` fixes opponents/elites:

```bash
nohup node scripts/evolve.mjs "shared-gbl-collection.csv" \
  --population 450 --opponents-per-gen 160 --generations 130 --deadline-minutes 1410 \
  --pool 70 --elites 15 --threads 8 \
  --mutation-floor-start 0.15 --mutation-ceil-start 0.6 \
  --seed shared-24h-1 --out-dir "out/evolve-shared-24h-1" > out/evolve-shared-24h-1.log 2>&1 &
echo $! > out/evolve-shared-24h-1.pid
```

Result: 129 generations in ~23.5 h at 8 threads. (That run also carried
`--ban cramorant,mimikyu`, a cup rule that no longer applies as of 2026-09-04;
do not add it unless the user asks.) Scale rule for a shorter
budget: keep the grid `population × opponents` proportional to the hours
(36k pairings ≈ 8 h at 100 generations, 72k ≈ 24 h at 130).

### All-generated opponents with co-evolution (new-season recipe, 2026-09-04)

When the curated/community teams are from an old season, drop them entirely and
let the opponent side evolve as hard as the candidate side. `--curated-ratio 0`
removes curated teams from every generation AND from the final pass. The
opponent GA normally culls only 15% and mutates at 2-20%; mutants can only fill
seats the cull opens, so raise the cull together with the rates. All four
`--opponent-mutation-*` flags mirror the candidate flags, including the linear
hot-start anneal. Fresh runs only (these flags are part of the checkpoint
fingerprint); bare `evolve.mjs`, because `sim.sh` fixes opponents/elites.

Lessons from the first run of this recipe (`shared-s2-gen-1`, 2026-09-04, see
section 7 and the 2026-09-05 header note in `scripts/evolve.mjs`): a 0.34 cull
turned over a third of the opponent pool every generation, which made a team's
win rate swing 3.9 points generation to generation while real teams were only
2.2 points apart. Selection now ranks on a 5-generation recency-weighted
trailing mean and the final pass is held out (archive, plus a small fresh
stratum only when `--curated-ratio 0`), which absorbs most of that,
but keep the cull at 0.2: the archive already preserves every strong opponent
the run breeds, so churn buys nothing. Size `--generations` to the deadline
(75 for 450 min on this grid); a deadline stop mid-schedule leaves both anneals
and the population ramp unfinished. Send 30 finalists to the pass, not 15: the
pass is now the out-of-sample judge, and with real teams only ~2 points apart
the top 15 of the trailing mean is too tight a cut to trust.

```bash
nohup node scripts/evolve.mjs "shared-gbl-collection.csv" \
  --population 400 --opponents-per-gen 100 --generations 75 --deadline-minutes 450 \
  --pool 70 --elites 30 --threads 8 \
  --curated-ratio 0 \
  --mutation-floor-start 0.15 --mutation-ceil-start 0.6 \
  --opponent-death-rate 0.2 \
  --opponent-mutation-floor 0.05 --opponent-mutation-ceil 0.4 \
  --opponent-mutation-floor-start 0.15 --opponent-mutation-ceil-start 0.6 \
  --seed shared-s2-gen-2 --out-dir "out/evolve-shared-s2-gen-2" > out/evolve-shared-s2-gen-2.log 2>&1 &
echo $! > out/evolve-shared-s2-gen-2.pid
```

Sizing: 400x100 = 40k pairings per generation (the 24 h run was 450x160 over
130 generations). Candidates shrink to 160 and opponents grow to 250 by the
last generation (`--population-final-ratio 0.4`, grid held flat). Gen 0 took
12.6 min on this grid in the s2 run (later ones 5-6 min once the battle cache
warmed); at that pace 75 generations fit the 450 min deadline with the final
pass (30 finalists x ~800 opponents ≈ 24k battles, ~6 min) to spare.
Expected log line:
`generation 0: battling 400 teams against 100 opponents (0 curated, 100 evolved)`.

**Check gen 0 timing before walking away.** The population schedule and both
mutation anneals are indexed to `--generations`, so a deadline stop leaves the
run mid-ramp. If `generation 0: done` reports more than ~13 min, kill the run,
delete the out dir, and relaunch with fewer generations (generations are in the
checkpoint fingerprint, so this must be a fresh start).

```bash
until grep -q "generation 0: done" out/evolve-shared-s2-gen-2.log; do sleep 30; done
grep "generation 0: done" out/evolve-shared-s2-gen-2.log
```

| Flag | Meaning | Default |
| --- | --- | --- |
| `--curated-ratio 0` | no curated/community opponents anywhere, final pass included | 0.66 |
| `--opponent-death-rate R` | evolvable-opponent cull per generation | 0.15 |
| `--opponent-mutation-floor/ceil R` | opponent mutation odds, worst→best survivor | 0.02 / 0.2 |
| `--opponent-mutation-floor-start/ceil-start R` | hot-start values at gen 0, annealed linearly to floor/ceil by the last generation | no anneal |
| `--selection-trailing N` | generations a team's fitness is recency-weighted-averaged over before the cull/mutation ranking and the finalist pick (1 = the pre-2026-09-05 single-draw behaviour); in the fingerprint only when set | 5 |
| `--elites N` | last-generation teams sent to the final pass; NOT in the fingerprint, so a finished run can be re-rendered with more | 15 |
| `--final-archive N` | final pass: strongest evolved opponents from the whole run, minus any fielded in the last `selection-trailing` generations; not in the fingerprint | 400 |
| `--final-fresh N` | final pass: fresh meta-composed opponents never fought during the run -- these are essentially random legal teams, not opponent-GA-selected ones, so kept off by default; not in the fingerprint | 0 (20 at `--curated-ratio 0`) |

### `sim.sh` reference

Options (anything else is passed through to `evolve.mjs`):

| Flag | Meaning | Default |
| --- | --- | --- |
| `--name NAME` | run name → seed + `out/evolve-NAME/` | `<csv-stem>-<HHMM>` (avoid; always name runs) |
| `--ban a,b` | format-wide base-species ban, both sides (cup rules) | none |
| `--generations G` | generation cap | 100 |
| `--population N` | candidate population at gen 0 | 300 |
| `--hours H` | wall-clock budget → `--deadline-minutes` | none |
| `--threads N` | battle worker threads | cpus-1 capped at 8 (use 8 or 12) |
| `--fg` | foreground instead of nohup | detached |
| `--dry-run` | print command, exit | off |

The launcher always adds `--opponents-per-gen 120 --pool 70 --elites 12
--seed NAME --out-dir out/evolve-NAME`. A bare `node scripts/evolve.mjs` uses
much smaller defaults (pop 100, 20 opponents, 15 gens) and is not a standard run.

### Common variants

```bash
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8  --hours 7.75         # ~8 h budget incl. final pass
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8  --cp 2500            # Ultra League
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8  --ban a,b            # cup rule, both sides
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8  --exclude carbink    # candidate side only
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8  --no-evolutions      # own forms only
```

- `--ban` drops the species from candidates, from any curated opponent team
  containing it, and from the composed-opponent pool. `_shadow` counts as the
  same base species; regional/battle forms are distinct ids.
- `--exclude` is an exact candidate-side species id. It does not remove the
  shadow form or touch opponents.
- `--hours H` is checked only between generations; the final pass and
  reports still run after the deadline. On resume, elapsed time counts from the
  original start timestamp including downtime, so pass the new *total*.
- Do not pass `--out-dir` through the wrapper; `--name` owns it.
- Full lower-level flag list: `node scripts/evolve.mjs --help`.

### Timing expectations (marisa, 300×120 grid, `--threads 8`)

| Phase | Wall clock |
| --- | ---: |
| Generation 0 (no cache) | ~10.5 min |
| Late generations (~60% cache hits) | ~4 min |
| 100 generations + final pass | ~7.5 h |

Budget a full day slot for a run to be safe. Two concurrent battle runs each
take more than twice as long; run one at a time. The figures above predate the
engine's scenario memo; expect roughly 25-30% less.

### Why `--threads 8` (measured 2026-09-04, do not change without re-measuring)

The limit is the machine, not the executor: 8 independent single-worker
processes each run 2.1x slower than one alone (103 -> 217 ms/battle). 8 threads
gives ~3.8x; 12 and 15 are slower than 8. Profiling and the engine's scenario
memo are documented in `src/engine/README.md`, "The scenario memo".

## 4. Monitor, stop, resume, queue

```bash
scripts/sim.sh status                      # every run: RUNNING/DONE/STOPPED + last checkpoint gen + last log line
tail -f out/evolve-RUN_NAME.log
grep -E '^generation [0-9]+: done' out/evolve-RUN_NAME.log | tail -3
```

After launching, past sessions verified health the same way each time: wait for
`generation 0: battling`, then check the process once a minute for a few
minutes, then wait for `generation 0: done` to get real timing.

```bash
until grep -q "generation 0: battling" out/evolve-RUN_NAME.log; do sleep 10; done
ps -p "$(cat out/evolve-RUN_NAME.pid)" -o pid,etime,rss --no-headers; free -m | sed -n 2p
until grep -q "generation 0: done" out/evolve-RUN_NAME.log || ! kill -0 "$(cat out/evolve-RUN_NAME.pid)" 2>/dev/null; do sleep 30; done
grep "generation 0: done" out/evolve-RUN_NAME.log || { echo "died before gen 0"; tail -5 out/evolve-RUN_NAME.log; }
```

Run long waits as background Bash tasks, not foreground sleeps. If the user
asks "is anything running", answer from `scripts/sim.sh status` or
`pgrep -af evolve.mjs`.

Log lines to recognise:

```text
evolve: starting (collection=..., out-dir=..., report=...)
generation 0: battling 300 teams against 120 opponents (79 curated, 41 evolved)
generation 0: done -- mean fitness 41.4%, 36000 battles simulated + 0 served from cache (0 errors), 10m 32s elapsed
evolve: resuming -- 37 generation(s) already complete (config matches)
Top team: Tinkaton (Lead) / Furret / Carbink -- score 55% (57% elites-pass win rate, 51% over the last 5 generation(s)).
Done marker written to out/evolve-RUN_NAME/evolve-DONE
```

Stop (keeps every completed-generation checkpoint; the in-progress generation is lost):

```bash
kill "$(cat out/evolve-RUN_NAME.pid)"
```

Resume: rerun the *identical* launch command (same csv, name, bans, cp,
population, generations, and any GA flags). Threads, `--hours`, and
`--no-battle-cache` may change freely. Anything else mismatching the stored
config makes the driver reject the checkpoints. A detached restart overwrites
the old `.log`, so copy it first if it matters.

```bash
cp out/evolve-RUN_NAME.log out/evolve-RUN_NAME.log.1
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8 --mutation-floor-start 0.15 --mutation-ceil-start 0.6
```

Never reuse a run name for a different collection or configuration.

Queue a run to start when another finishes (pattern from `out/queue-marisa-8h.sh`):

```bash
cat > out/queue-NEXT.sh <<'EOF'
#!/bin/bash
cd /home/jaxon/files/pogo-gbl-team-generator || exit 1
prev=$(cat out/evolve-PREV.pid)
while kill -0 "$prev" 2>/dev/null; do sleep 60; done
sleep 15
scripts/sim.sh "COLLECTION.csv" --name NEXT --threads 8 --mutation-floor-start 0.15 --mutation-ceil-start 0.6 >> out/evolve-queue.log 2>&1
EOF
nohup bash out/queue-NEXT.sh >/dev/null 2>&1 &
```


## 5. Read the results

Inside `out/evolve-RUN_NAME/`:

| File | Contents |
| --- | --- |
| `evolve-DONE` | present ⇒ final pass + reports finished without an uncaught error (stop reason may be convergence, cap, or deadline) |
| `my-teams-evolve.md` | final report; top 12 teams, weighted final-pass win%, score, build costs |
| `my-teams-evolve.html` | same, with the animated generation race chart embedded |
| `evolve-ranking.json` | machine-readable final ranking (array, rank 1 first) |
| `evolve-generations.json` | compact per-generation analytics |
| `evolve-genN.json` | full checkpoint per generation (config, populations, fitness, lineage, timing) |

Quick answers:

```bash
grep -m1 '^Top team' out/evolve-RUN_NAME.log
node -e 'for (const t of JSON.parse(require("fs").readFileSync("out/evolve-RUN_NAME/evolve-ranking.json")).slice(0,5))
  console.log(t.rank, t.name, (t.combinedScore*100).toFixed(1)+"%")'
```

`evolve-ranking.json` entries: `{rank, name, signature, combinedScore, winRate,
recentWinRate, selectionFitness, winRateByStratum: {curated|archive|fresh: {winRate, battles}}}`.
`combinedScore = 0.7 × winRate (weighted final pass) + 0.3 × recentWinRate`;
`selectionFitness` is the trailing-mean fitness that made the team a finalist,
`winRateByStratum` the unweighted pass result per opponent stratum (runs
re-rendered before 2026-09-05 lack both).
Team names read `Lead (Lead) / back1 / back2`; `members[0]` is the lead everywhere.

Standalone chart file, if the HTML report is not enough:

```bash
node scripts/chart-top-teams.mjs out/evolve-RUN_NAME [--top N] [--out PATH]
```

Reports flag members marked **not buildable** when evolving keeps a level that
lands over the CP cap (e.g. a L24 Mareep becomes a CP 1743 Ampharos). Runs
from `marisa-2-1` onward filter these during the run; older reports may still
contain them. The user has asked before to keep only fully buildable teams.

Rankings are relative. Absolute win% carries a small fixed-side offset because
candidates always fight as team A; compare teams to each other, not to 50%.

### Re-render reports without re-simulating

Rerunning the exact original command on a finished run resumes past the last
checkpoint, redoes only the deterministic final pass, and rewrites the reports.
Use this after changing report code in `scripts/evolve.mjs`. Since 2026-09-05
the final pass battles held-out opponents (archive + fresh) that the
generations never fought, so a re-render costs real battles (30 finalists x
~800 opponents ≈ 24k, ~6 min at 8 threads) and rankings only come out identical
when the final-pass code and `--elites/--final-archive/--final-fresh` are
unchanged. Those three flags are outside the checkpoint fingerprint, so a
finished run CAN be re-rendered with `--elites 30`; `--selection-trailing` is
inside it (only when set), so never add it on a re-render. For a bare
`evolve.mjs` run, repeat its original command with `--fg`-style foreground
redirection instead of `sim.sh`.

```bash
cp out/evolve-RUN_NAME/evolve-ranking.json out/evolve-RUN_NAME/evolve-ranking.json.bak
scripts/sim.sh "$COLLECTION" --name "$RUN_NAME" --threads 8 <same flags> --fg > out/evolve-RUN_NAME-rerender.log 2>&1
diff <(jq . out/evolve-RUN_NAME/evolve-ranking.json) <(jq . out/evolve-RUN_NAME/evolve-ranking.json.bak) && echo identical
grep "final pass --" out/evolve-RUN_NAME-rerender.log   # shows the curated/archive/fresh split it fought
```

### Excluding a species after a run finished

Changing `--exclude`/`--ban` invalidates checkpoints, so that is a fresh run
(a 40-gen `--exclude carbink` rerun was started and abandoned for this reason).
The cheap route, done for `marisa-8h-1`: the final pass already scored all 12
finalists, so drop finalists containing the species from the copied report
(`my-teams-evolve-nocarbink.{md,html}`), promote the rest, and add a note naming
the removed winner and why. That is a report edit, not a simulation; say so in
the report.

### Sharing a report as an artifact

The user shares results as Claude artifacts. The HTML report is self-contained;
extract the body between `<body>` and `</body>` plus the `<style>` block, add a
`<title>`, and publish. Past titles: "Great League Podium", "Marisa's Great
League Podium". Republish to the same artifact URL when updating.

## 6. Other tasks

### Quick sampled run (no GA)

```bash
node src/cli.js "$COLLECTION" --threads 12 [--cp 2500] [--top 10] [--exclude a,b] [--current-moves] [--no-evolutions]
# → out/report.md, out/report.html   (change with --out / --html)
```

Defaults: 15 candidate teams × 7 opponents, pool 30, seed
`pogo-gbl-team-generator`. `--exhaustive --topK K --meta M` swaps in all C(K,3)
candidates against a fixed curated list. Good for smoke tests and Ultra League
collections too small for a GA.

### Shared collection for two players

```bash
node scripts/build-shared-collection.mjs jaxon-gl-collection.csv jet-gl-collection.csv \
  --out shared-gbl-collection.csv [--cp 1500]
```

Keeps, per base species both can field, the weaker player's copy, so every
output mon is buildable by both. Then run `sim.sh` on the output. Note the
script's positional defaults reference old filenames; always pass both paths.

### Multi-stage offline tournament (alternative to the GA, rarely used)

```bash
node scripts/tournament.mjs "$COLLECTION" --threads 12 --deadline-minutes 450 --out-dir out/tournament-NAME
```

Three-stage funnel (500×50×3, 100×200×3, 10×500×9 battles at defaults);
stages 2-3 self-tune to the deadline. Report: `<out-dir>/my-teams-tournament.md`.

### Refresh usage weights (deliberate, human-triggered only)

```bash
node scripts/refresh-usage.mjs        # writes data/meta-usage.json from live pvpoke GL rankings
```

Currently no `data/meta-usage.json` or `data/meta-roles.json` exists, so usage
and role priors come from the pinned pvpoke rankings. Community-curated teams in
`data/meta-teams-community.json` are a separate local source; changing the pin
does not update them.

### Tests (only when code changed)

```bash
node --test test/<file>.test.js   # one module
npm run test:changed              # a few files in one area
npm test                          # fast tier, ~1 s
TS_FULL=1 npm run test:full       # ~13 s; required before a push
```

A hook blocks whole-suite runs and prints the narrower command; follow it.

## 7. What the standard recipe actually does

Resolved settings for `scripts/sim.sh <csv> --name NAME --threads 12`:

| Setting | Value |
| --- | --- |
| League | Great League, CP 1500 |
| Generations | 100 (0-99), or earlier on convergence/deadline |
| Candidate population | 300 at gen 0, shrinking linearly to 120 at gen 99 |
| Opponents per generation | 120 at gen 0, growing to 300 at gen 99 (`round(36000 / population)`) |
| Battles per generation | ≈36,000 (one per candidate/opponent pair, both at designated leads) |
| Candidate species pool | top 70 of the collection by 1v1 score (meta size 20) |
| Candidate draw weight | 50% normalized 1v1 score + 50% normalized pvpoke usage, usage = `(score/100)^2.5` |
| Curated opponent target | 66% of the pool, capped by the curated teams available; curated teams are never culled or mutated |
| Composed opponents | built from pvpoke's overall top 100 species |
| Fitness | `battle-reality` = 0.60 win rate + 0.30 decided lead-exchange win rate + 0.10 mean closer prior of the back line |
| Selection statistic | each team's recency-weighted mean fitness over its last 5 generations (`--selection-trailing`, its own window separate from convergence's); the cull, the mutation ranking and the finalist pick all use it, never a single generation's draw (since 2026-09-05; the s2 run showed one draw moves 3.9 points while real teams sit 2.2 apart) |
| Candidate cull | `round(1/3 × next size)` replaced per generation, plus shrink |
| Mutation chance | 5% (worst survivor) to 40% (best), linear by fitness percentile; 30% lead rotation / 70% one-member swap |
| Immigrants | `round(10% × next size)` fresh teams |
| Opponent-side GA | cull 15% of non-curated, mutation 2-20%, immigrants ≤8%, curated parents mutate at a flat 3% into new teams; opponent fitness = 1 − candidate win points, no extra battles |
| Convergence | smoothed (10-gen) top-10 unchanged for 6 straight transitions and elite lift improving ≤0.005 vs the prior 10-gen baseline; cannot fire before gen 16. Tunable only via `--conv-window`, `--conv-top-n` |
| Final pass | top 12 last-generation candidates by the selection statistic vs every curated team + a held-out archive (the 400 strongest evolved opponents of the whole run, excluding any fielded in the last 10 generations) + 400 fresh meta-composed teams never fought during the run. Curated weights meta/untagged 1, recommended 0.5, off-meta 0.25; archive+fresh together carry the run's `(1-curated-ratio)/curated-ratio` share of the curated weight (with `--curated-ratio 0`, every opponent weighs 1). Out-of-sample by construction: before 2026-09-05 the pass re-fought the last generation's own pool, which with `--curated-ratio 0` meant 0 new battles and a winner's-curse ranking |
| Final rank | `0.70 × weighted final-pass win% + 0.30 × mean raw win% over the last 5 generations` (`ceil(gens/4)` if fewer than 20 ran); the report also shows each finalist's unweighted win% per stratum |
| Evolutions of owned mons | on |
| AI difficulty | 3 (engine default) |
| Battle cache | on, in memory, ≤2,000,000 entries; does not survive restart |
| Determinism | same seed ⇒ identical results, serial or threaded |

`--fixed-opponents` freezes the opponent pool (no culling, mutation,
immigration, or growth). Opponent-side rates have no CLI flags.

## 8. Source of truth

Consult only when this file disagrees with observed behaviour, then fix this file.

| Concern | Source |
| --- | --- |
| Launcher recipe, pid/log conventions, `status` | `scripts/sim.sh` |
| Driver defaults, schedule, fitness, checkpoints, final ranking, CLI | `scripts/evolve.mjs` |
| Candidate GA constants and convergence | `src/teams/evolve.js` |
| Candidate draw blend | `src/teams/sample.js` |
| Opponent GA constants | `src/meta/opponentPool.js` |
| Composed-opponent top-100 | `src/meta/sampleTeams.js` |
| Usage exponent and snapshot fallback | `src/meta/usage.js` |
| Role priors | `src/meta/roles.js` |
| Curated teams and tier weights | `src/meta/teams.js`, `data/meta-teams-community.json` |
| pvpoke pin and sparse paths | `scripts/setup.sh` |
| Thread default | `src/engine/parallel.js` |
| Feature docs (flags, cost math, GA) | GitHub wiki: `curl -s "https://raw.githubusercontent.com/wiki/Gidntsquia/pogo-gbl-team-generator/<Page>.md"` — pages Running-the-CLI, How-Scoring-Works, Build-Costs-and-Evolutions, Evolutionary-Team-Search, Shared-Collections, Development-and-Tests |
