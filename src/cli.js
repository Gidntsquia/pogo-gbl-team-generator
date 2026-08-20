// JavaScript Document
//
// CLI entry point (GOALS T5). Wires the whole pipeline together:
//
//   collection.csv
//     -> importer      (src/importer)      normalized mons
//     -> scoring       (src/scoring)       1v1 matrix (prunes + per-mon insight)
//     -> meta teams    (src/meta/teams)    curated 3v3 opponents
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
//   --top N          teams to show in the report        (default 5)
//   --topK K         candidate pool size (best-scoring)  (default 5)
//   --meta M         number of opponent meta teams       (default 5)
//   --score-meta S   meta size used for 1v1 pruning       (default 20)
//   --difficulty D   AI difficulty 0-3 (3 = strongest)    (default: engine default)
//   --exclude a,b    species ids to exclude from teams    (default: none)
//   --out PATH       report output path                   (default out/report.md)
//   --help           print this help and exit
//
// Budget note: 3v3 battles run = C(topK,3) candidate teams x M meta teams x 9
// lead pairings. Defaults are sized for a quick interactive run on a personal
// collection; raise --topK / --meta for a more thorough (slower) search.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { importCollection } from './importer/index.js';
import { initEngine } from './engine/harness.js';
import { scoreCollection, computeWeightedScore } from './scoring/index.js';
import { loadMetaTeams } from './meta/teams.js';
import { buildCandidates, evaluateTeams } from './teams/index.js';
import { renderReport, renderSummary } from './report/index.js';

const DEFAULTS = Object.freeze({
  top: 5,
  topK: 5,
  meta: 5,
  scoreMeta: 20,
  out: 'out/report.md',
});

const HELP = `pogo-gbl-team-generator -- rank your Great League teams via real 3v3 battles

Usage:
  node src/cli.js <collection.csv> [options]

Options:
  --top N          teams to show in the report        (default ${DEFAULTS.top})
  --topK K         candidate pool size (best-scoring)  (default ${DEFAULTS.topK})
  --meta M         number of opponent meta teams       (default ${DEFAULTS.meta})
  --score-meta S   meta size used for 1v1 pruning       (default ${DEFAULTS.scoreMeta})
  --difficulty D   AI difficulty 0-3 (3 = strongest)    (default: engine default)
  --exclude a,b    species ids to exclude from teams    (default: none)
  --out PATH       report output path                   (default ${DEFAULTS.out})
  --help           print this help and exit
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

/**
 * Keep only the best-scoring built instance per species, so two copies of the
 * same Pokemon (e.g. two Azumarill with different IVs) don't fill several
 * near-identical "different" candidate teams. Returns a shallow matrix copy
 * with pruned `ratings`/`builtMons`; other fields are shared unchanged.
 */
function dedupeBestPerSpecies(matrix) {
  const bestBySpecies = new Map();
  for (const key of Object.keys(matrix.ratings)) {
    const speciesId = matrix.builtMons[key].speciesId;
    const score = computeWeightedScore(matrix.ratings[key]);
    const cur = bestBySpecies.get(speciesId);
    if (!cur || score > cur.score) bestBySpecies.set(speciesId, { key, score });
  }
  const keep = new Set([...bestBySpecies.values()].map((v) => v.key));
  const ratings = {};
  const builtMons = {};
  for (const key of keep) {
    ratings[key] = matrix.ratings[key];
    builtMons[key] = matrix.builtMons[key];
  }
  return { ...matrix, ratings, builtMons };
}

/**
 * Run the full pipeline and return the pieces the report needs. Exported so
 * test/cli.test.js can drive it with tiny knobs without spawning a subprocess.
 *
 * @param {string} csvPath
 * @param {{ top?:number, topK?:number, meta?:number, scoreMeta?:number,
 *           difficulty?:number, excludeSpecies?:string[],
 *           onProgress?:(p:{completed:number,total:number})=>void }} [opts]
 * @returns {Promise<import('./report/index.js').ReportInput>}
 */
export async function runPipeline(csvPath, opts = {}) {
  const top = opts.top ?? DEFAULTS.top;
  const topK = opts.topK ?? DEFAULTS.topK;
  const metaCount = opts.meta ?? DEFAULTS.meta;
  const scoreMeta = opts.scoreMeta ?? DEFAULTS.scoreMeta;
  const excludeSpecies = opts.excludeSpecies ?? [];

  const { mons, warnings: importWarnings } = importCollection(csvPath);

  const ctx = await initEngine();
  const matrix = scoreCollection(ctx, mons, { metaLimit: scoreMeta });
  const metaTeams = loadMetaTeams(ctx, { limit: metaCount });

  const deduped = dedupeBestPerSpecies(matrix);
  const candidates = buildCandidates(deduped, { topK, excludeSpecies });

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

  return {
    collectionPath: csvPath,
    monCount: matrix.mons.length,
    rankedTeams,
    monScores: matrix.mons,
    metaTeams: metaTeams.map((m) => ({ id: m.id, name: m.name })),
    warnings,
    settings: {
      topK,
      candidateCount: candidates.length,
      scoreMeta,
      difficulty: opts.difficulty,
      excludeSpecies,
    },
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
