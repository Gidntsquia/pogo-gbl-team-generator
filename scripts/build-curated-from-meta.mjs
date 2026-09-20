#!/usr/bin/env node
// Build a curated opponent-team file from a finished meta-vs-meta run.
//
//   node scripts/build-curated-from-meta.mjs out/evolve-<meta-run> --cup retro \
//     [--candidates 50] [--opponents 50] [--gen N] [--out data/meta-teams-community.json]
//
// Reads one generation's checkpoint (default: the latest) and takes the top N
// candidate teams by selectionFitness and the top M opponent teams by
// opponentSelectionFitness. Species only (members[0] = lead, shadow builds as
// `<id>_shadow`); the loader in src/meta/teams.js builds pvpoke's recommended
// moveset for each. The file carries a top-level "cup" so it is used only by
// runs of that cup (readCommunityEntries in src/meta/teams.js).
//
// Refuses to overwrite an existing --out; archive the old file first (see
// RUNBOOK.md, "New meta: curated teams from a meta-vs-meta run").

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseCsv } from '../src/importer/csv.js';

/** Order teams by a fitness array, best first; keep the first of each identical lead+species list. */
function topTeams(teams, fitness, count) {
  const order = teams.map((_, i) => i).sort((a, b) => fitness[b] - fitness[a]);
  const seen = new Set();
  const out = [];
  for (const i of order) {
    const key = teams[i].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(teams[i]);
    if (out.length >= count) break;
  }
  return out;
}

/**
 * @param {string} runDir - out/evolve-<name> of a finished meta-vs-meta run
 * @param {{cup: string, candidates?: number, opponents?: number, gen?: number}} opts
 * @returns {{cup: string, source: string, teams: object[]}}
 */
export function buildCuratedFromMeta(runDir, { cup, candidates = 50, opponents = 50, gen }) {
  const gens = readdirSync(runDir)
    .map((f) => f.match(/^evolve-gen(\d+)\.json$/)?.[1])
    .filter(Boolean)
    .map(Number);
  const genN = gen ?? Math.max(...gens);
  const cp = JSON.parse(readFileSync(path.join(runDir, `evolve-gen${genN}.json`), 'utf8'));
  if (!cp.config.metaMode) throw new Error(`${runDir} is not a --meta-mode run`);

  // Candidate keys are `<speciesId>#<CSV line number>`; the CSV row carries the shadow flag.
  const rows = parseCsv(readFileSync(cp.config.csvPath, 'utf8'));
  const lineOf = (key) => {
    const [species, line] = key.split('#');
    const row = rows[Number(line) - 1]; // rows[0] is the header, so file line N is rows[N-1]
    if (!row || row[0] !== species) throw new Error(`key ${key} does not match CSV line ${line}`);
    return row[4] === 'true' ? `${species}_shadow` : species;
  };
  const candTeams = cp.population.map((t) => t.map(lineOf));
  const oppTeams = cp.opponentPool.map((t) => t.members.map((m) => m.speciesId));

  const run = path.basename(runDir).replace(/^evolve-/, '');
  const tag = `${run}-gen${genN}`;
  const teams = [];
  const add = (kind, list) =>
    list.forEach((members, i) => teams.push({ id: `${tag}-${kind}-${i + 1}`, members }));
  add('candidate', topTeams(candTeams, cp.selectionFitness, candidates));
  add('opponent', topTeams(oppTeams, cp.opponentSelectionFitness, opponents));
  return { cup, source: tag, teams };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i < 0 ? dflt : args[i + 1];
  };
  const runDir = args[0];
  const cup = flag('cup');
  if (!runDir || !cup) {
    console.error('usage: build-curated-from-meta.mjs <run-dir> --cup <cup> [--candidates 50] [--opponents 50] [--gen N] [--out FILE]');
    process.exit(2);
  }
  const out = flag('out', 'data/meta-teams-community.json');
  if (existsSync(out)) {
    console.error(`${out} exists; archive it to data/archive/ first`);
    process.exit(1);
  }
  const gen = flag('gen');
  const result = buildCuratedFromMeta(runDir, {
    cup,
    candidates: Number(flag('candidates', 50)),
    opponents: Number(flag('opponents', 50)),
    gen: gen === undefined ? undefined : Number(gen),
  });
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(`wrote ${result.teams.length} teams (cup=${cup}, source=${result.source}) to ${out}`);
}
