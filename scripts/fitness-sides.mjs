#!/usr/bin/env node
/**
 * Read every `evolve-genN.json` checkpoint in a meta-vs-meta run's output
 * directory and print, per generation, the candidate/opponent numbers read
 * from opposite sides of the same battles -- the artifact documented in
 * RUNBOOK.md "Known artifact: candidates read ~5-8pts low on fitness".
 *
 * Usage: node scripts/fitness-sides.mjs out/evolve-<name>
 *
 * Three layers per side (plans/WORKER_NOTES.md Item 1 -- same-kind numbers on
 * both sides so "equal" is checkable):
 *   raw      -- unweighted winPoints/battles off each side's own ledger
 *               (`candidateRawWinRateMean`/`opponentRawWinRateMean`).
 *   weighted -- the win rate that side's own selection/fitness actually used
 *               this generation (`candidateWeightedWinRateMean`/
 *               `opponentWeightedWinRateMean`; candidate's is also the mean of
 *               `winRateBySignature`).
 *   blend    -- the final fitness value (`analytics.meanFitness`/
 *               `analytics.opponentMeanFitness`).
 * `rawPlusOppSum` is `candidateRawWinRateMean + opponentRawWinRateMean`, which
 * should be ~1 since both are the same battles read from opposite sides.
 * Checkpoints written before this session's Item 1 change lack the raw/
 * weighted fields; those columns print `n/a` for them (candRawWinrateMean/
 * rawPlusOppSum still work off `winRateBySignature`, which is older).
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

const fmt = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(4) : "n/a");
const diff = (a, b) => (typeof a === "number" && typeof b === "number" ? a - b : undefined);

const COLUMNS = [
  "gen",
  "candRawWinrateMean",
  "oppRawWinrateMean",
  "rawGap",
  "candWeightedWinrateMean",
  "oppWeightedWinrateMean",
  "weightedGap",
  "candFitMean",
  "oppFitMean",
  "blendGap",
  "rawPlusOppSum",
];
console.log(COLUMNS.join("\t"));

const sums = Object.fromEntries(COLUMNS.filter((c) => c !== "gen").map((c) => [c, { sum: 0, n: 0 }]));
function accumulate(key, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  sums[key].sum += value;
  sums[key].n += 1;
}

for (const { name, gen } of genFiles) {
  const checkpoint = JSON.parse(readFileSync(join(dir, name), "utf8"));
  const a = checkpoint.analytics ?? {};

  // Legacy fallback: `winRateBySignature` mean (candidate's weighted win
  // rate, since its values are `run.results[i].winRate`) plus opponent fit
  // mean, for checkpoints predating candidateRawWinRateMean etc.
  const rawValues = Object.values(checkpoint.winRateBySignature ?? {});
  const legacyCandWeighted = rawValues.length ? rawValues.reduce((s, v) => s + v, 0) / rawValues.length : undefined;

  const candRaw = a.candidateRawWinRateMean;
  const oppRaw = a.opponentRawWinRateMean;
  const candWeighted = a.candidateWeightedWinRateMean ?? legacyCandWeighted;
  const oppWeighted = a.opponentWeightedWinRateMean;
  const candFit = a.meanFitness;
  const oppFit = a.opponentMeanFitness;

  const row = {
    gen,
    candRawWinrateMean: candRaw,
    oppRawWinrateMean: oppRaw,
    rawGap: diff(candRaw, oppRaw),
    candWeightedWinrateMean: candWeighted,
    oppWeightedWinrateMean: oppWeighted,
    weightedGap: diff(candWeighted, oppWeighted),
    candFitMean: candFit,
    oppFitMean: oppFit,
    blendGap: diff(candFit, oppFit),
    rawPlusOppSum:
      typeof candRaw === "number" && typeof oppRaw === "number"
        ? candRaw + oppRaw
        : typeof legacyCandWeighted === "number" && typeof oppFit === "number"
          ? legacyCandWeighted + oppFit
          : undefined,
  };

  for (const key of COLUMNS) {
    if (key === "gen") continue;
    accumulate(key, row[key]);
  }

  console.log(COLUMNS.map((k) => (k === "gen" ? gen : fmt(row[k]))).join("\t"));
}

console.log(
  COLUMNS.map((k) => (k === "gen" ? "mean" : fmt(sums[k].n ? sums[k].sum / sums[k].n : undefined))).join("\t"),
);
