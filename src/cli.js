// JavaScript Document
//
// CLI entry point (GOALS T5, sampling wired in T12). Wires the whole
// pipeline together:
//
//   collection.csv
//     -> importer      (src/importer)      normalized mons
//     -> scoring       (src/scoring)       1v1 matrix (prunes + per-mon insight)
//     -> meta teams    (src/meta/teams,    curated 3v3 opponents (exhaustive)
//                       src/meta/sampleTeams, src/meta/usage)   or a weighted
//                                                                sample (default)
//     -> candidates    (src/teams/index,   C(topK,3) exhaustive combinations
//                       src/teams/sample)  or a weighted sample (default)
//     -> evaluator     (src/teams)         real 3v3 battles, ranked teams
//     -> report        (src/report)        terminal summary + out/report.md
//
// No battle math lives here -- this file only parses args, sequences the
// modules above, dedupes the candidate pool to one instance per species, and
// prints/writes their output.
//
// Usage:
//   node src/cli.js <collection.csv> [options]
//
// Options:
//   --top N            teams to show in the report        (default 5)
//   --score-meta S     meta size used for 1v1 pruning       (default 20)
//   --difficulty D     AI difficulty 0-3 (3 = strongest)    (default: engine default)
//   --exclude a,b      species ids to exclude from teams    (default: none)
//   --out PATH         report output path                   (default out/report.md)
//   --help             print this help and exit
//
// Sampling (default path -- GOALS T9-T12, PLAN.md Rev 3):
//   --candidates N     candidate teams to sample             (default 15)
//   --opponents M      opponent teams to sample               (default 7)
//   --pool P           user-mon pool sampled from (best-scoring, deduped
//                       one-per-species)                       (default 30)
//   --seed S           PRNG seed, any string/number -- same seed + same
//                       inputs always reproduces the same run  (default: a
//                       fixed built-in string, i.e. reproducible out of the
//                       box; pass your own to explore a different sample)
//   --curated-ratio R  fraction of opponents drawn from curated/community
//                       teams vs weighted-random compositions  (default 0.4)
//
// Candidate teams are sampled from the deduped user pool with P(mon) blended
// from the user's own 1v1 matrix score and the species' current-meta usage
// weight (src/meta/usage.js), so both a user's strong performers AND popular
// meta picks land on more candidate teams. Opponent teams mix curated/
// community presets with weighted-random compositions from the wide meta
// pool. Both samplers are pure list generators (src/teams/sample.js,
// src/meta/sampleTeams.js) -- evaluateTeams itself is unchanged either way.
//
// Exhaustive path (old T5 behavior, opt-in via --exhaustive):
//   --exhaustive       use C(topK,3) exhaustive candidates + a fixed curated
//                       opponent list instead of sampling
//   --topK K           candidate pool size (best-scoring)  (default 5, exhaustive only)
//   --meta M           number of opponent meta teams       (default 5, exhaustive only)
//
// Budget math: 3v3 battles run = candidates x opponents x 9 lead pairings
// (sampled) or C(topK,3) x meta x 9 (exhaustive). Measured ~172ms/battle in
// the sandbox (PROGRESS.md 2026-08-20T18:03Z). Sampled defaults (15
// candidates x 7 opponents x 9 = 945 battles) land at roughly 945 x 172ms =~
// 2.7 min, inside the ~3 min sandbox budget with margin; exhaustive defaults
// (C(5,3)=10 candidates x 5 meta x 9 = 450 battles =~ 77s) are unchanged from
// T5/T6. Raising --candidates/--opponents (sampled) or --topK/--meta
// (exhaustive) grows runtime roughly linearly (sampled) or combinatorially
// (--topK, exhaustive) -- raise gradually.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { importCollection } from './importer/index.js';
import { initEngine } from './engine/harness.js';
import { scoreCollection, computeWeightedScore } from './scoring/index.js';
import { loadMetaTeams } from './meta/teams.js';
import { loadUsageWeights } from './meta/usage.js';
import { sampleOpponentTeams } from './meta/sampleTeams.js';
import { sampleCandidateTeams } from './teams/sample.js';
import { buildCandidates, evaluateTeams, dedupeBestPerSpecies } from './teams/index.js';
import { renderReport, renderSummary } from './report/index.js';

const DEFAULTS = Object.freeze({
  top: 5,
  // Exhaustive-path-only knobs (see --exhaustive).
  topK: 5,
  meta: 5,
  // Sampled-path (default) knobs.
  candidates: 15,
  opponents: 7,
  pool: 30,
  seed: 'pogo-gbl-team-generator',
  curatedRatio: 0.4,
  scoreMeta: 20,
  out: 'out/report.md',
});

const HELP = `pogo-gbl-team-generator -- rank your Great League teams via real 3v3 battles

Usage:
  node src/cli.js <collection.csv> [options]

Options:
  --top N            teams to show in the report        (default ${DEFAULTS.top})
  --score-meta S     meta size used for 1v1 pruning      (default ${DEFAULTS.scoreMeta})
  --difficulty D     AI difficulty 0-3 (3 = strongest)   (default: engine default)
  --exclude a,b      species ids to exclude from teams   (default: none)
  --out PATH         report output path                  (default ${DEFAULTS.out})
  --help             print this help and exit

Sampling (default path):
  --candidates N     candidate teams to sample             (default ${DEFAULTS.candidates})
  --opponents M      opponent teams to sample               (default ${DEFAULTS.opponents})
  --pool P           user-mon pool sampled from             (default ${DEFAULTS.pool})
  --seed S           PRNG seed (reproducible)                (default "${DEFAULTS.seed}")
  --curated-ratio R  fraction of opponents from curated pool (default ${DEFAULTS.curatedRatio})

Exhaustive path (opt-in):
  --exhaustive       use C(topK,3) candidates + a fixed curated opponent list
  --topK K           candidate pool size (best-scoring)  (default ${DEFAULTS.topK}, exhaustive only)
  --meta M           number of opponent meta teams       (default ${DEFAULTS.meta}, exhaustive only)
`;

/** Write a line to stdout without going through console.log (which is silenced). */
function say(line = '') {
  process.stdout.write(`${line}\n`);
}

/** Parse a positive integer flag; throws a clear error on bad input. */
function intFlag(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer, got "${value}"`);
  }
  return n;
}

/** Parse a fraction flag (e.g. --curated-ratio); throws a clear error on bad input. */
function fractionFlag(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`--${name} must be a number in [0,1], got "${value}"`);
  }
  return n;
}

/**
 * Best-scoring `poolSize` userMonKeys, deduped to one per species and with
 * `excludeSpecies` already removed -- the wide pool sampleCandidateTeams
 * draws from. Mirrors buildCandidates' own score-desc/key-tiebreak sort
 * (src/teams/index.js) so both paths rank identically; this just slices to a
 * (typically larger) pool instead of enumerating combinations.
 *
 * @param {object} deduped - dedupeBestPerSpecies(matrix) result.
 * @param {number} poolSize
 * @param {string[]} excludeSpecies
 * @returns {string[]} userMonKeys.
 */
function buildSamplingPool(deduped, poolSize, excludeSpecies) {
  const exclude = new Set(excludeSpecies);
  return Object.keys(deduped.ratings)
    .filter((key) => !exclude.has(deduped.builtMons[key].speciesId))
    .map((key) => ({ key, score: computeWeightedScore(deduped.ratings[key]) }))
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, poolSize)
    .map((m) => m.key);
}

/**
 * Run the full pipeline and return the pieces the report needs. Exported so
 * test/cli.test.js can drive it with tiny knobs without spawning a subprocess.
 *
 * Sampling (GOALS T12, default) vs exhaustive (`opts.exhaustive: true`) only
 * changes how `candidates`/`metaTeams` are produced; evaluateTeams itself
 * (src/teams/index.js) is identical either way -- see PLAN.md Rev 3.
 *
 * @param {string} csvPath
 * @param {{ top?:number, scoreMeta?:number, difficulty?:number,
 *           excludeSpecies?:string[], exhaustive?:boolean,
 *           topK?:number, meta?:number,
 *           candidates?:number, opponents?:number, pool?:number,
 *           seed?:number|string, curatedRatio?:number,
 *           onProgress?:(p:{completed:number,total:number})=>void }} [opts]
 * @returns {Promise<import('./report/index.js').ReportInput>}
 */
export async function runPipeline(csvPath, opts = {}) {
  const top = opts.top ?? DEFAULTS.top;
  const scoreMeta = opts.scoreMeta ?? DEFAULTS.scoreMeta;
  const excludeSpecies = opts.excludeSpecies ?? [];
  const exhaustive = opts.exhaustive ?? false;

  const { mons, warnings: importWarnings } = importCollection(csvPath);

  const ctx = await initEngine();
  const matrix = scoreCollection(ctx, mons, { metaLimit: scoreMeta });
  const deduped = dedupeBestPerSpecies(matrix);

  let candidates;
  let metaTeams;
  let settings;

  if (exhaustive) {
    const topK = opts.topK ?? DEFAULTS.topK;
    const metaCount = opts.meta ?? DEFAULTS.meta;
    metaTeams = loadMetaTeams(ctx, { limit: metaCount });
    candidates = buildCandidates(deduped, { topK, excludeSpecies });
    settings = { mode: 'exhaustive', topK, scoreMeta, difficulty: opts.difficulty, excludeSpecies };
  } else {
    const candidateTarget = opts.candidates ?? DEFAULTS.candidates;
    const opponentCount = opts.opponents ?? DEFAULTS.opponents;
    const poolSize = opts.pool ?? DEFAULTS.pool;
    const seed = opts.seed ?? DEFAULTS.seed;
    const curatedRatio = opts.curatedRatio ?? DEFAULTS.curatedRatio;

    const weights = loadUsageWeights(ctx);
    const pool = buildSamplingPool(deduped, poolSize, excludeSpecies);

    candidates = sampleCandidateTeams({
      matrix: deduped,
      pool,
      weights,
      count: candidateTarget,
      seed,
      excludeSpecies,
    });
    metaTeams = sampleOpponentTeams(ctx, { count: opponentCount, weights, seed, curatedRatio });

    settings = {
      mode: 'sampled',
      candidateTarget,
      poolSize,
      seed,
      curatedRatio,
      scoreMeta,
      difficulty: opts.difficulty,
      excludeSpecies,
    };
  }

  const rankedTeams = evaluateTeams(ctx, {
    metaTeams,
    matrix,
    candidates,
    opts: {
      teamCount: top,
      difficulty: opts.difficulty,
      onProgress: opts.onProgress,
    },
  });

  const warnings = [...importWarnings, ...matrix.warnings];
  settings.candidateCount = candidates.length;

  return {
    collectionPath: csvPath,
    monCount: matrix.mons.length,
    rankedTeams,
    monScores: matrix.mons,
    metaTeams: metaTeams.map((m) => ({ id: m.id, name: m.name, label: m.label ?? null })),
    warnings,
    settings,
  };
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        top: { type: 'string' },
        topK: { type: 'string' },
        meta: { type: 'string' },
        'score-meta': { type: 'string' },
        difficulty: { type: 'string' },
        exclude: { type: 'string' },
        out: { type: 'string' },
        exhaustive: { type: 'boolean' },
        candidates: { type: 'string' },
        opponents: { type: 'string' },
        pool: { type: 'string' },
        seed: { type: 'string' },
        'curated-ratio': { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    say(HELP);
    if (positionals.length === 0 && !values.help) process.exitCode = 2;
    return;
  }

  const csvPath = positionals[0];
  const opts = {
    top: intFlag(values.top, 'top', DEFAULTS.top),
    topK: intFlag(values.topK, 'topK', DEFAULTS.topK),
    meta: intFlag(values.meta, 'meta', DEFAULTS.meta),
    scoreMeta: intFlag(values['score-meta'], 'score-meta', DEFAULTS.scoreMeta),
    difficulty: values.difficulty !== undefined ? intFlag(values.difficulty, 'difficulty', undefined) : undefined,
    excludeSpecies: values.exclude ? values.exclude.split(',').map((s) => s.trim()).filter(Boolean) : [],
    exhaustive: values.exhaustive ?? false,
    candidates: intFlag(values.candidates, 'candidates', DEFAULTS.candidates),
    opponents: intFlag(values.opponents, 'opponents', DEFAULTS.opponents),
    pool: intFlag(values.pool, 'pool', DEFAULTS.pool),
    seed: values.seed ?? DEFAULTS.seed,
    curatedRatio: fractionFlag(values['curated-ratio'], 'curated-ratio', DEFAULTS.curatedRatio),
  };
  const outPath = values.out ?? DEFAULTS.out;

  // pvpoke's vendored engine prints a few debug lines (e.g. "loading
  // gamemaster") via the host console during init/scoring; silence log/info/
  // debug so CLI stdout stays clean (this file uses process.stdout.write via
  // say()). warn/error still surface. teamBattle silences its own vm console
  // during battles.
  const realLog = console.log;
  console.log = () => undefined;
  console.info = () => undefined;
  console.debug = () => undefined;

  let report;
  try {
    let lastPct = -1;
    report = await runPipeline(csvPath, {
      ...opts,
      onProgress: ({ completed, total }) => {
        const p = Math.floor((completed / total) * 100);
        if (p !== lastPct && p % 10 === 0) {
          lastPct = p;
          process.stderr.write(`\rEvaluating teams... ${p}% (${completed}/${total})   `);
        }
      },
    });
    process.stderr.write('\n');
  } finally {
    console.log = realLog;
  }

  const markdown = renderReport(report);
  mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  writeFileSync(outPath, markdown, 'utf8');

  say(renderSummary(report));
  say('');
  say(`Full report written to ${outPath}`);
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`\nError: ${err.message}\n`);
    process.exitCode = 1;
  });
}
