#!/usr/bin/env node
// JavaScript Document
//
// Shield-scenario weighting review: the per-mon 1v1 score is
// a weighted mean of three shield scenarios (0.25*s00 + 0.50*s11 + 0.25*s22,
// src/scoring/index.js's SCORE_WEIGHTS) -- a judgment call made before any
// real 3v3 team-battle ground truth existed. Now that it does (src/teams/
// index.js's evaluateTeams), this script empirically checks whether that
// weighting actually picks a BETTER topK candidate-mon pool than plausible
// alternatives, measured by the real 3v3 win rate the resulting candidate
// teams achieve.
//
// Method: score one collection against the real Great League meta ONCE
// (scoreCollection -- same s00/s11/s22 raw ratings every weighting reads),
// then for each weighting scheme: recombine those SAME raw ratings with that
// scheme's weights (no new 1v1 battles), rank mons, take the topK, form every
// no-dup-species 3-mon combination (same rule as src/teams/index.js's
// buildCandidates), and battle those candidate teams against a small fixed
// meta-team sample via the REAL evaluateTeams (3v3, pvpoke's own engine, no
// battle math reimplemented -- this script only decides which candidates to
// feed it and recombines numbers evaluateTeams/scoreCollection already
// produced). Compare each scheme's resulting mean/best candidate win rate.
//
// Usage: node scripts/shield-weight-review.mjs [--csv path] [--top-k 5]
//                                              [--meta-limit 10]
//                                              [--opponents 4] [--json]

import { initEngine } from '../src/engine/harness.js';
import { initTeamBattle } from '../src/engine/teamBattle.js';
import { importCollection } from '../src/importer/index.js';
import { scoreCollection } from '../src/scoring/index.js';
import { loadMetaTeams } from '../src/meta/teams.js';
import { dedupeBestPerSpecies, evaluateTeams } from '../src/teams/index.js';

const FIXTURE_CSV = new URL('../fixtures/sample-pokegenie.csv', import.meta.url).pathname;

// Shield-scenario weightings compared against the production default.
// Each must sum to 1 (asserted in runShieldWeightReview) so a typo can't
// silently skew the comparison.
const WEIGHTING_SCHEMES = [
  { name: 'current (PLAN default)', weights: { s00: 0.25, s11: 0.5, s22: 0.25 } },
  { name: 'pure-1v1', weights: { s00: 0, s11: 1, s22: 0 } },
  { name: 'even', weights: { s00: 1 / 3, s11: 1 / 3, s22: 1 / 3 } },
  { name: 'shield-heavy', weights: { s00: 0.4, s11: 0.2, s22: 0.4 } },
];

function assertWeightsSumToOne(name, weights) {
  const sum = weights.s00 + weights.s11 + weights.s22;
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`shield-weight-review: scheme "${name}" weights must sum to 1, got ${sum}`);
  }
}

/**
 * Same arithmetic as src/scoring/index.js's computeWeightedScore, parameterized
 * by an arbitrary weighting instead of that module's fixed SCORE_WEIGHTS
 * constant -- recombines the SAME raw per-scenario ratings scoreCollection
 * already produced; no new battles, no scoring logic duplicated or changed.
 *
 * @param {Object<string, {s00:number, s11:number, s22:number}>} ratingsBySpecies
 * @param {{s00:number, s11:number, s22:number}} weights
 * @returns {number}
 */
function weightedScore(ratingsBySpecies, weights) {
  const rows = Object.values(ratingsBySpecies);
  if (rows.length === 0) return 0;
  const sum = rows.reduce(
    (acc, r) => acc + weights.s00 * r.s00 + weights.s11 * r.s11 + weights.s22 * r.s22,
    0
  );
  return sum / rows.length;
}

/** All C(items,3) index combinations, in lexicographic order (mirrors src/teams/index.js's combinations3). */
function combinations3(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      for (let k = j + 1; k < items.length; k++) {
        out.push([items[i], items[j], items[k]]);
      }
    }
  }
  return out;
}

/**
 * Rank a (already species-deduped) matrix's mons under one weighting, take
 * the topK, and form every no-dup-species 3-mon combination -- same dup rule
 * src/teams/index.js's buildCandidates uses (shadow/base share a species).
 * Ties broken by key so this is deterministic run to run.
 */
function buildCandidatesForWeighting(matrix, weights, topK) {
  const scored = Object.keys(matrix.ratings)
    .map((key) => ({
      key,
      speciesId: matrix.builtMons[key].speciesId,
      score: weightedScore(matrix.ratings[key], weights),
    }))
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const pool = scored.slice(0, topK);

  return combinations3(pool)
    .filter(([a, b, c]) => a.speciesId !== b.speciesId && a.speciesId !== c.speciesId && b.speciesId !== c.speciesId)
    .map((combo) => combo.map((m) => m.key));
}

function parseArgs(argv) {
  const opts = { csvPath: FIXTURE_CSV, topK: 5, metaLimit: 10, opponents: 4, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--csv') opts.csvPath = argv[++i];
    else if (a === '--top-k') opts.topK = Number(argv[++i]);
    else if (a === '--meta-limit') opts.metaLimit = Number(argv[++i]);
    else if (a === '--opponents') opts.opponents = Number(argv[++i]);
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

/**
 * @param {object} ctx - from initEngine.
 * @param {{
 *   csvPath?: string, topK?: number, metaLimit?: number, opponents?: number,
 *   schemes?: Array<{name:string, weights:{s00:number,s11:number,s22:number}}>,
 * }} [opts]
 * @returns {Promise<object>} per-weighting-scheme comparison report.
 */
export async function runShieldWeightReview(ctx, opts = {}) {
  const csvPath = opts.csvPath ?? FIXTURE_CSV;
  const topK = opts.topK ?? 5;
  const metaLimit = opts.metaLimit ?? 10;
  const opponentCount = opts.opponents ?? 4;
  const schemes = opts.schemes ?? WEIGHTING_SCHEMES;
  for (const s of schemes) assertWeightsSumToOne(s.name, s.weights);

  initTeamBattle(ctx);

  const { mons, warnings: importWarnings } = importCollection(csvPath);
  const rawMatrix = scoreCollection(ctx, mons, { metaLimit });
  const matrix = dedupeBestPerSpecies(rawMatrix);

  const metaTeams = loadMetaTeams(ctx, { limit: opponentCount });
  if (metaTeams.length < opponentCount) {
    throw new Error(
      `runShieldWeightReview: curated meta pool only has ${metaTeams.length} teams, need ${opponentCount}`
    );
  }

  const schemeReports = [];
  for (const scheme of schemes) {
    const candidates = buildCandidatesForWeighting(matrix, scheme.weights, topK);
    const topKSpecies = [...new Set(candidates.flat().map((key) => matrix.builtMons[key].speciesId))];

    if (candidates.length === 0) {
      schemeReports.push({
        name: scheme.name,
        weights: scheme.weights,
        topKSpecies,
        candidateTeamCount: 0,
        meanWinRate: null,
        bestWinRate: null,
        bestTeam: null,
      });
      continue;
    }

    const results = await evaluateTeams(ctx, { metaTeams, matrix, candidates, opts: {} });
    const winRates = results.map((r) => r.winRate);
    const meanWinRate = winRates.reduce((a, b) => a + b, 0) / winRates.length;
    const bestWinRate = Math.max(...winRates);

    schemeReports.push({
      name: scheme.name,
      weights: scheme.weights,
      topKSpecies,
      candidateTeamCount: candidates.length,
      meanWinRate,
      bestWinRate,
      bestTeam: results[0].members.map((m) => m.speciesId),
    });
  }

  return {
    collectionMonCount: mons.length,
    importWarnings,
    metaLimit,
    topK,
    opponentTeamCount: metaTeams.length,
    schemes: schemeReports,
  };
}

function printReport(report) {
  console.log(
    `shield-weight-review: ${report.collectionMonCount} collection mons, topK=${report.topK}, ` +
      `metaLimit=${report.metaLimit}, ${report.opponentTeamCount} opponent teams`
  );
  if (report.importWarnings.length) {
    console.log(`  import warnings: ${report.importWarnings.join('; ')}`);
  }
  for (const s of report.schemes) {
    const w = s.weights;
    console.log(
      `  ${s.name} [s00=${w.s00.toFixed(2)} s11=${w.s11.toFixed(2)} s22=${w.s22.toFixed(2)}]: ` +
        `topK = [${s.topKSpecies.join(', ')}]`
    );
    if (s.candidateTeamCount === 0) {
      console.log('    no valid (no-dup-species) candidate teams from this topK');
      continue;
    }
    console.log(
      `    ${s.candidateTeamCount} candidate teams -> mean win rate ${s.meanWinRate.toFixed(3)}, ` +
        `best win rate ${s.bestWinRate.toFixed(3)} (best team: ${s.bestTeam.join(', ')})`
    );
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  const ctx = await initEngine();
  const report = await runShieldWeightReview(ctx, opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printReport(report);
  }
}

// Only run when invoked directly (not when imported by tests).
import path from 'node:path';
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`\nError: ${err.message}\n`);
    process.exitCode = 1;
  });
}
