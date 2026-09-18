#!/usr/bin/env node
/**
 * Read every `evolve-genN.json` checkpoint in a meta-vs-meta run's output
 * directory and print, per generation, the candidate/opponent fitness means
 * read from opposite sides of the same battles -- the artifact documented in
 * RUNBOOK.md "Known artifact: candidates read ~5-8pts low on fitness".
 *
 * Usage: node scripts/fitness-sides.mjs out/evolve-<name>
 *
 * Columns: gen, cand fit mean (analytics.meanFitness), cand raw winrate mean
 * (mean of winRateBySignature values -- the unweighted team-A win rate),
 * opp fit mean (analytics.opponentMeanFitness), raw+opp sum (should be ~1,
 * since both are the same battles read from opposite sides).
 *
 * Reads one checkpoint file at a time (they run 5-10 MB each); never loads
 * evolve-generations.json or all per-gen files together.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/fitness-sides.mjs out/evolve-<name>");
  process.exit(1);
}

const genFiles = readdirSync(dir)
  .map((name) => {
    const match = name.match(/^evolve-gen(\d+)\.json$/);
    return match ? { name, gen: Number(match[1]) } : null;
  })
  .filter(Boolean)
  .sort((a, b) => a.gen - b.gen);

if (genFiles.length === 0) {
  console.error(`no evolve-genN.json files found in ${dir}`);
  process.exit(1);
}

console.log("gen\tcandFitMean\tcandRawWinrateMean\toppFitMean\trawPlusOppSum");

let candFitSum = 0;
let candRawSum = 0;
let oppFitSum = 0;
let sumSum = 0;

for (const { name, gen } of genFiles) {
  const checkpoint = JSON.parse(readFileSync(join(dir, name), "utf8"));
  const candFitMean = checkpoint.analytics.meanFitness;
  const rawValues = Object.values(checkpoint.winRateBySignature);
  const candRawWinrateMean =
    rawValues.reduce((a, b) => a + b, 0) / rawValues.length;
  const oppFitMean = checkpoint.analytics.opponentMeanFitness;
  const sum = candRawWinrateMean + oppFitMean;

  candFitSum += candFitMean;
  candRawSum += candRawWinrateMean;
  oppFitSum += oppFitMean;
  sumSum += sum;

  console.log(
    `${gen}\t${candFitMean.toFixed(4)}\t${candRawWinrateMean.toFixed(4)}\t${oppFitMean.toFixed(4)}\t${sum.toFixed(4)}`,
  );
}

const n = genFiles.length;
console.log(
  `mean\t${(candFitSum / n).toFixed(4)}\t${(candRawSum / n).toFixed(4)}\t${(oppFitSum / n).toFixed(4)}\t${(sumSum / n).toFixed(4)}`,
);
