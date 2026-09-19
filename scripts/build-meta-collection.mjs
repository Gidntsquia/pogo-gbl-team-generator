#!/usr/bin/env node
// Builds a synthetic "own every meta-relevant species" collection CSV from
// pvpoke's vendored rankings file for one CP cap -- every speciesId pvpoke
// itself ranks for that cap, with the IV cells left BLANK so the importer
// fills in pvpoke's default spread for the cap (gamemaster `defaultIVs`: best
// stat product at an IV floor of 4; src/importer/index.js, `ivsDefaulted`).
// That is the same build the opponent side gets. Do not write 15/15/15 here:
// the engine levels a mon for the IVs it is given and never optimizes them, so
// a hundo is a ~4-7% worse Great League build than the default spread for any
// species that reaches the cap -- while species that can't
// reach the cap even at hundo (Pachirisu tops out at CP 1372) lose nothing.
// A hundo collection therefore systematically favours low-ceiling species;
// the 2026-09-06 meta-vs-meta-gl2 run put Pachirisu in 3 of its top 6 for
// exactly this reason.
//
// Feeding this into scripts/evolve.mjs as the candidate-side collection
// makes candidate sampling draw from the SAME universe the opponent side
// already draws from (src/meta/usage.js's weights, src/meta/sampleTeams.js),
// instead of whatever species one real player happens to own -- i.e. a true
// meta-vs-meta run, not "the opponent GA learns to counter my collection."
//
// Usage: node scripts/build-meta-collection.mjs [--cp 1500] [--cup all] [--out out/meta-collection-1500.csv]

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFormat, DEFAULT_CUP } from '../src/util/leagues.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_ROOT = path.join(REPO_ROOT, 'vendor', 'pvpoke');

function argVal(args, flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
}

const args = process.argv.slice(2);
const cp = Number(argVal(args, '--cp', '1500'));
const cup = argVal(args, '--cup', DEFAULT_CUP);
const defaultOutName = cup === DEFAULT_CUP ? `meta-collection-${cp}.csv` : `meta-collection-${cup}-${cp}.csv`;
const outPath = path.resolve(argVal(args, '--out', path.join('out', defaultOutName)));

const format = resolveFormat({ cp, cup, vendorRoot: VENDOR_ROOT });
const rankingsFilePath = path.join(VENDOR_ROOT, 'src/data/rankings', format.rankingsDir, 'overall', `rankings-${cp}.json`);

const rankings = JSON.parse(readFileSync(rankingsFilePath, 'utf8'));
if (!Array.isArray(rankings) || rankings.length === 0) {
  throw new Error(`no rankings found at ${rankingsFilePath}`);
}

const rows = rankings
  .filter((r) => typeof r?.speciesId === 'string' && typeof r?.speciesName === 'string')
  .map((r) => ({
    // The base speciesId, not speciesName: pvpoke's rankings mislabel some
    // forms (morpeko_full_belly is named "Morpeko (Hangry)"), and the
    // importer resolves an exact id first (src/importer/gamemaster.js).
    name: r.speciesId.replace(/_shadow$/, ''),
    shadow: r.speciesId.endsWith('_shadow'),
  }));

const lines = ['name,atk,def,sta,shadow'];
for (const row of rows) lines.push(`"${row.name.replace(/"/g, '""')}",,,,${row.shadow}`);

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`wrote ${rows.length} species (cp ${cp}, cup ${cup}) -> ${outPath}`);
