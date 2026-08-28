#!/usr/bin/env node
// JavaScript Document
//
// Builds a "teams both players could run" collection from two collection
// CSVs: a shared-pool CSV that intersects two players' collections at the
// Great League cap and, for every species BOTH of them can field, keeps
// whichever player's copy is the WEAKER of the two -- so every mon in the
// output is buildable by both players (the stronger player's version, by
// definition, also clears that bar).
//
// Pipeline per collection mirrors src/cli.js's default (sampled) path
// exactly, up through the 1v1 matrix:
//
//   importCollection -> expandEvolutions (evolutions on, the default) ->
//   scoreCollection({metaLimit:20}) -> dedupeBestPerSpecies
//
// dedupeBestPerSpecies already collapses one physical Pokemon (a CSV row +
// its possible evolutions) down to whichever FORM scored best, so each row
// contributes at most one final speciesId per collection. This script then
// groups those by BASE species (src/meta/sampleTeams.js's baseIdOf, so a
// shadow and its non-shadow counterpart count as the same species -- see
// note below on why that grouping is usually a no-op for collection
// species but is applied anyway per spec), intersects the two collections'
// base-species sets, and for each shared base species keeps the entry with
// the LOWER weighted score.
//
// The OUTPUT row for a chosen entry is the SOURCE mon -- the original CSV
// row's owned form, IVs, level, CP, and shadow/purified/lucky flags -- never
// the evolved form scoreCollection may have scored it as (a player owns the
// row they wrote in their CSV, not a hypothetical evolution of it). The
// source row is recovered via lineageKeyFor's "row<N>" convention
// (src/evolution/index.js), which every scored entry carries regardless of
// whether it was expanded.
//
// The selection logic itself (bestPerBaseSpecies / selectSharedCollection)
// is pure -- plain {speciesId, score} arrays in, a decision out -- and is
// unit-tested in test/buildSharedCollection.test.js against a tiny hand-built
// fixture, with no engine boot at all.
//
// Output format: the importer's "generic" CSV
// (name,atk,def,sta,shadow,purified,lucky,bestbuddy,level,cp -- see
// src/importer/index.js's mapGenericRow/detectFormat), which round-trips
// every field this script needs to carry (IVs, level, CP, shadow, purified,
// lucky, Best Buddy). The script re-imports its own output and verifies every
// row resolves to the same speciesId/IVs/level it selected before reporting
// success.
//
// Usage:
//   node scripts/build-shared-collection.mjs [collectionA.csv] [collectionB.csv] [options]
//
// Options:
//   --out PATH   output CSV path              (default repo-root shared-gbl-collection.csv)
//   --cp N       CP cap / league               (default 1500, Great League)
//   --help       print this help and exit
//
// Positional defaults (repo-root, personal/gitignored collections):
//   collectionA.csv = jaxon-gbl-collection.csv
//   collectionB.csv = jet_GL_collection.csv

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { importCollection } from '../src/importer/index.js';
import { initEngine } from '../src/engine/harness.js';
import { scoreCollection, computeWeightedScore } from '../src/scoring/index.js';
import { dedupeBestPerSpecies } from '../src/teams/index.js';
import { expandEvolutions } from '../src/evolution/index.js';
import { baseIdOf } from '../src/meta/sampleTeams.js';
import { leagueForCp, DEFAULT_CP, SUPPORTED_CPS } from '../src/util/leagues.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Fixed to match src/cli.js's default 1v1-pruning meta size exactly (its
// `--score-meta` default) -- not exposed as a flag here, since this script's
// whole job is "score exactly like the main pipeline does by default", not
// to explore pruning depth.
const SCORE_META_LIMIT = 20;

const DEFAULTS = Object.freeze({
  collectionA: path.join(REPO_ROOT, 'jaxon-gbl-collection.csv'),
  collectionB: path.join(REPO_ROOT, 'jet_GL_collection.csv'),
  out: path.join(REPO_ROOT, 'shared-gbl-collection.csv'),
  cp: DEFAULT_CP,
});

const HELP = `build-shared-collection -- teams both players could run (intersect two collections, keep the weaker of each shared species)

Usage:
  node scripts/build-shared-collection.mjs [collectionA.csv] [collectionB.csv] [options]

Positional (defaults are repo-root personal collections, gitignored):
  collectionA.csv   (default ${path.relative(REPO_ROOT, DEFAULTS.collectionA)})
  collectionB.csv   (default ${path.relative(REPO_ROOT, DEFAULTS.collectionB)})

Options:
  --out PATH   output CSV path   (default ${path.relative(REPO_ROOT, DEFAULTS.out)})
  --cp N       CP cap / league, ${SUPPORTED_CPS.join('/')}   (default ${DEFAULTS.cp})
  --help       print this help and exit
`;

/** Write a line to stdout. */
function say(line = '') {
  process.stdout.write(`${line}\n`);
}

/** Parse a positive integer flag; throws a clear error on bad input (mirrors src/cli.js). */
function intFlag(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer, got "${value}"`);
  }
  return n;
}

// ------------------------------------------------------- pure selection --
//
// Everything in this section takes/returns plain data (no engine, no
// matrix/ctx objects) and is exercised directly by
// test/buildSharedCollection.test.js.

const LINEAGE_ROW_RE = /^row(\d+)$/;

/**
 * Recover the CSV sourceRow a scored entry traces back to, from its
 * lineageKey (src/evolution/index.js's lineageKeyFor: `row${sourceRow}` for
 * any mon that came from an actual CSV row -- which is every mon
 * importCollection produces, since it always stamps sourceRow).
 *
 * @param {string} lineageKey
 * @returns {number|null} null if lineageKey isn't in the "row<N>" form.
 */
export function sourceRowFromLineageKey(lineageKey) {
  const m = LINEAGE_ROW_RE.exec(String(lineageKey ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Reduce one collection's deduped per-species scored entries down to the
 * single best-scoring entry per BASE species (src/meta/sampleTeams.js's
 * baseIdOf). dedupeBestPerSpecies itself already groups by exact speciesId,
 * so for today's collection-derived speciesIds (always base -- shadow is a
 * flag, never a "_shadow"-suffixed id, see NormalizedMon's doc comment) this
 * is a 1:1 pass-through; it exists so a future entry that DID carry a
 * "_shadow" suffix would still collapse correctly, matching the spec's
 * "find each collection's best entry for that base species" step.
 *
 * @param {Array<{key:string, speciesId:string, score:number}>} entries
 * @returns {Map<string, {key:string, speciesId:string, baseSpeciesId:string, score:number, lineageKey:string}>}
 */
export function bestPerBaseSpecies(entries) {
  const best = new Map();
  for (const entry of entries) {
    const baseSpeciesId = baseIdOf(entry.speciesId);
    const cur = best.get(baseSpeciesId);
    // Ties favor the lexicographically-lower key, for determinism.
    if (!cur || entry.score > cur.score || (entry.score === cur.score && entry.key < cur.key)) {
      best.set(baseSpeciesId, { ...entry, baseSpeciesId });
    }
  }
  return best;
}

/**
 * The shared-collection selection: for every base species BOTH collections
 * own (as a deduped best entry), pick whichever collection's best entry has
 * the LOWER weighted score -- the weaker of the two collections' strongest,
 * so the output is buildable by both players. Ties favor collection A.
 *
 * Pure and engine-free: entries are plain {key, speciesId, score, lineageKey}
 * records (already computed by scoreCollection/dedupeBestPerSpecies
 * upstream), so this is testable with a hand-built fixture matrix.
 *
 * @param {Array<{key:string, speciesId:string, score:number, lineageKey:string}>} entriesA
 * @param {Array<{key:string, speciesId:string, score:number, lineageKey:string}>} entriesB
 * @returns {Array<{baseSpeciesId:string, scoreA:number, scoreB:number, chosenSide:'A'|'B', chosen:object}>}
 *   sorted by baseSpeciesId, for determinism.
 */
export function selectSharedCollection(entriesA, entriesB) {
  const bestA = bestPerBaseSpecies(entriesA);
  const bestB = bestPerBaseSpecies(entriesB);
  const shared = [];

  for (const [baseSpeciesId, a] of bestA) {
    const b = bestB.get(baseSpeciesId);
    if (!b) continue;
    const chosenSide = b.score < a.score ? 'B' : 'A';
    shared.push({
      baseSpeciesId,
      scoreA: a.score,
      scoreB: b.score,
      chosenSide,
      chosen: chosenSide === 'A' ? a : b,
    });
  }

  shared.sort((x, y) => (x.baseSpeciesId < y.baseSpeciesId ? -1 : x.baseSpeciesId > y.baseSpeciesId ? 1 : 0));
  return shared;
}

// ------------------------------------------------------- CSV emission --

// Column order the importer's generic-format detector/mapper reads by name
// (not position) -- see src/importer/index.js's detectFormat/mapGenericRow.
const GENERIC_HEADER = ['name', 'atk', 'def', 'sta', 'shadow', 'purified', 'lucky', 'bestbuddy', 'level', 'cp'];

/** Quote a CSV field only when it needs it (comma, quote, or newline), doubling embedded quotes -- matches src/importer/csv.js's dialect. */
function csvField(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * One generic-format CSV row for a NormalizedMon (src/importer/index.js),
 * carrying every field that format supports: IVs, shadow/purified/lucky/
 * Best Buddy flags, level, and CP.
 *
 * @param {import('../src/importer/index.js').NormalizedMon} mon
 * @returns {string}
 */
export function toGenericRow(mon) {
  return [
    mon.name,
    mon.ivs.atk,
    mon.ivs.def,
    mon.ivs.hp,
    mon.shadow ? '1' : '',
    mon.purified ? '1' : '',
    mon.lucky ? '1' : '',
    mon.bestBuddy ? '1' : '',
    mon.level ?? '',
    mon.cp ?? '',
  ]
    .map(csvField)
    .join(',');
}

/** @param {import('../src/importer/index.js').NormalizedMon[]} mons */
export function toGenericCsv(mons) {
  return [GENERIC_HEADER.join(','), ...mons.map(toGenericRow)].join('\n') + '\n';
}

// -------------------------------------------------------------- driver --

/**
 * Import + expand + score + dedupe one collection, mirroring
 * src/cli.js's runPipeline default path exactly through dedupeBestPerSpecies.
 *
 * @param {object} ctx - from initEngine.
 * @param {string} csvPath
 * @returns {{
 *   csvPath: string,
 *   sourceByRow: Map<number, object>,
 *   entries: Array<{key:string, speciesId:string, score:number, lineageKey:string}>,
 *   warnings: string[],
 * }}
 */
function loadCollection(ctx, csvPath) {
  const { mons: importedMons, warnings: importWarnings } = importCollection(csvPath);
  // Keyed by sourceRow so a chosen (possibly-evolved) scored entry can be
  // traced back to the exact owned CSV row it came from.
  const sourceByRow = new Map(importedMons.map((m) => [m.sourceRow, m]));

  const expanded = expandEvolutions(ctx, importedMons);
  const matrix = scoreCollection(ctx, expanded.mons, { metaLimit: SCORE_META_LIMIT });
  const deduped = dedupeBestPerSpecies(matrix);

  const entries = Object.keys(deduped.ratings).map((key) => ({
    key,
    speciesId: deduped.builtMons[key].speciesId,
    score: computeWeightedScore(deduped.ratings[key]),
    lineageKey: deduped.builtMons[key].lineageKey,
  }));

  return {
    csvPath,
    sourceByRow,
    entries,
    warnings: [...importWarnings, ...expanded.warnings, ...matrix.warnings],
  };
}

/**
 * Resolve a shared-selection pick back to the SOURCE mon (owned form) it
 * came from, in whichever collection's data won.
 */
function sourceMonFor(pick, collections) {
  const side = pick.chosenSide === 'A' ? collections.A : collections.B;
  const sourceRow = sourceRowFromLineageKey(pick.chosen.lineageKey);
  if (sourceRow === null) {
    throw new Error(
      `build-shared-collection: could not recover a source row for "${pick.baseSpeciesId}" ` +
        `(lineageKey="${pick.chosen.lineageKey}")`
    );
  }
  const mon = side.sourceByRow.get(sourceRow);
  if (!mon) {
    throw new Error(
      `build-shared-collection: no source row ${sourceRow} in ${side.csvPath} for "${pick.baseSpeciesId}"`
    );
  }
  return { side: pick.chosenSide, sourceRow, mon };
}

/**
 * Re-import the just-written CSV and assert every emitted mon resolves to
 * the same speciesId/IVs/level (and shadow/purified/lucky flags) it was
 * selected with. Throws on any mismatch or import warning -- this script's
 * whole point is a file the main pipeline can read back correctly, so a
 * silent round-trip drift here would be a real bug, not a warning.
 *
 * @param {string} outPath
 * @param {import('../src/importer/index.js').NormalizedMon[]} expectedMons - in emission order.
 */
function verifyRoundTrip(outPath, expectedMons) {
  const { mons: reimported, warnings } = importCollection(outPath);
  if (warnings.length) {
    throw new Error(`verify: round-trip import of ${outPath} produced warnings:\n  ${warnings.join('\n  ')}`);
  }
  if (reimported.length !== expectedMons.length) {
    throw new Error(
      `verify: wrote ${expectedMons.length} rows but re-imported ${reimported.length} -- row count mismatch`
    );
  }
  for (let i = 0; i < expectedMons.length; i++) {
    const exp = expectedMons[i];
    const got = reimported[i];
    const mismatches = [];
    if (got.speciesId !== exp.speciesId) mismatches.push(`speciesId "${got.speciesId}" != "${exp.speciesId}"`);
    if (got.ivs.atk !== exp.ivs.atk || got.ivs.def !== exp.ivs.def || got.ivs.hp !== exp.ivs.hp) {
      mismatches.push(`ivs ${JSON.stringify(got.ivs)} != ${JSON.stringify(exp.ivs)}`);
    }
    if ((got.level ?? null) !== (exp.level ?? null)) mismatches.push(`level ${got.level} != ${exp.level}`);
    if (!!got.shadow !== !!exp.shadow) mismatches.push('shadow flag mismatch');
    if (!!got.purified !== !!exp.purified) mismatches.push('purified flag mismatch');
    if (!!got.lucky !== !!exp.lucky) mismatches.push('lucky flag mismatch');
    if (mismatches.length) {
      throw new Error(`verify: row ${i + 1} ("${exp.name}") round-trip mismatch: ${mismatches.join(', ')}`);
    }
  }
  return reimported.length;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: 'string' },
        cp: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    say(HELP);
    return;
  }

  const collectionAPath = positionals[0] ? path.resolve(positionals[0]) : DEFAULTS.collectionA;
  const collectionBPath = positionals[1] ? path.resolve(positionals[1]) : DEFAULTS.collectionB;
  const outPath = values.out ? path.resolve(values.out) : DEFAULTS.out;
  const cp = intFlag(values.cp, 'cp', DEFAULTS.cp);
  const league = leagueForCp(cp); // throws on an unsupported cap before any work happens

  const labels = { A: path.basename(collectionAPath), B: path.basename(collectionBPath) };

  // pvpoke's vendored engine prints a few debug lines during init/scoring
  // (mirrors src/cli.js's console silencing).
  const realLog = console.log;
  console.log = () => undefined;
  console.info = () => undefined;
  console.debug = () => undefined;

  let ctx;
  let A;
  let B;
  try {
    ctx = await initEngine({ cp: league.cp });
    A = loadCollection(ctx, collectionAPath);
    B = loadCollection(ctx, collectionBPath);
  } finally {
    console.log = realLog;
  }

  for (const w of A.warnings) process.stderr.write(`warning [${labels.A}]: ${w}\n`);
  for (const w of B.warnings) process.stderr.write(`warning [${labels.B}]: ${w}\n`);

  const shared = selectSharedCollection(A.entries, B.entries);

  // Deduplicate: the same physical CSV row (one collection, one sourceRow)
  // can end up as the winning pick for more than one base species (e.g. a
  // single owned mon that legitimately scores as the best available answer
  // for two different shared-species slots) -- emit it once, note every
  // species it was picked for.
  const rowsBySourceKey = new Map();
  for (const pick of shared) {
    const { side, sourceRow, mon } = sourceMonFor(pick, { A, B });
    const sourceKey = `${side}:${sourceRow}`;
    if (!rowsBySourceKey.has(sourceKey)) {
      rowsBySourceKey.set(sourceKey, { mon, side, species: [] });
    }
    rowsBySourceKey.get(sourceKey).species.push(pick.baseSpeciesId);
  }
  const outputRows = [...rowsBySourceKey.values()];
  const outputMons = outputRows.map((r) => r.mon);

  writeFileSync(outPath, toGenericCsv(outputMons), 'utf8');
  const reimportedCount = verifyRoundTrip(outPath, outputMons);

  say(`build-shared-collection -- ${league.name} (cp ${league.cp})`);
  say('');
  say(`Collection A: ${labels.A} -- ${A.entries.length} species (deduped, evolutions on)`);
  say(`Collection B: ${labels.B} -- ${B.entries.length} species (deduped, evolutions on)`);
  say(`Shared species (both own a deduped entry): ${shared.length}`);
  say(`Output rows written: ${outputMons.length}${outputMons.length !== shared.length ? ` (deduped from ${shared.length} picks -- some rows cover multiple species)` : ''} -> ${path.relative(REPO_ROOT, outPath)}`);
  say(`Round-trip verify: OK -- ${reimportedCount} mons re-imported, all match speciesId/IVs/level/flags`);
  say('');
  say('Per-species picks (base species: chosen side [collection], scoreA vs scoreB):');
  for (const pick of shared) {
    const chosenLabel = pick.chosenSide === 'A' ? labels.A : labels.B;
    say(`  ${pick.baseSpeciesId}: ${chosenLabel} (A=${labels.A}:${pick.scoreA}, B=${labels.B}:${pick.scoreB})`);
  }
  for (const [sourceKey, row] of rowsBySourceKey) {
    if (row.species.length > 1) {
      say(`  note: ${sourceKey} (${row.mon.name}) is the chosen row for multiple species: ${row.species.join(', ')}`);
    }
  }
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
