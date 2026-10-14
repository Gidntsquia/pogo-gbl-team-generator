// Dump real gen-0 battle specs (candidate team vs opponent team) from an evolve
// checkpoint, as plain data the exporter can rebuild with src/engine + src/scoring.
// This helper is the only gpu/ script that touches src/evolve (to resolve the
// checkpoint's "species#id" keys back to concrete specs); export-matchups.mjs does not.
//
//   node gpu/dump-gen0-specs.mjs <evolve-gen0.json> <collection.csv> [out.json] [count] [seed]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildEvolveSetup } from '../src/evolve/setup.js';
import { buildMetaMon } from '../src/scoring/index.js';
import { mulberry32, hashSeed } from '../src/engine/battle/virtualClock.js';

const [cpPath, csv, outArg, countArg, seedArg] = process.argv.slice(2);
if (!cpPath || !csv) {
  console.error('usage: node gpu/dump-gen0-specs.mjs <evolve-gen0.json> <collection.csv> [out.json] [count] [seed]');
  process.exit(1);
}
const out = outArg ?? 'out/gpu/gen0-specs.json';
const count = Number(countArg ?? 600);
const rng = mulberry32(hashSeed(seedArg ?? 'gpu-gen0'));

const cp = JSON.parse(readFileSync(cpPath, 'utf8'));
const setup = await buildEvolveSetup(csv, { cp: cp.config.cp, cup: cp.config.cup });
const { ctx, deduped } = setup;

const candSpec = (key) => {
  const b = deduped.builtMons[key];
  if (!b) throw new Error(`checkpoint key ${key} not in rebuilt collection`);
  return b.spec;
};
const teams = cp.population.map((keys) => keys.map(candSpec));
const opponents = cp.opponentPool.map((o) => ({
  id: o.id,
  leadIndex: o.leadIndex ?? 0,
  team: o.members.map((m) => buildMetaMon(ctx, m).spec),
}));

// Random distinct (team, opponent) pairs, each fought forward AND reversed like evaluate.js does.
const picks = new Set();
const battles = [];
while (picks.size < count) {
  const t = Math.floor(rng() * teams.length);
  const o = Math.floor(rng() * opponents.length);
  const k = `${t}/${o}`;
  if (picks.has(k)) continue;
  picks.add(k);
  const opp = opponents[o];
  battles.push({ id: `${t}v${o}`, teamA: teams[t], teamB: opp.team, leadA: 0, leadB: opp.leadIndex, dir: 'fwd' });
  battles.push({ id: `${o}v${t}`, teamA: opp.team, teamB: teams[t], leadA: opp.leadIndex, leadB: 0, dir: 'rev' });
}
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ source: cpPath, cp: cp.config.cp, cup: cp.config.cup, teams: teams.length, opponents: opponents.length, battles }));
console.log(`wrote ${out}: ${battles.length} battles (${count} pairs x fwd/rev) from ${teams.length} teams x ${opponents.length} opponents`);
process.exit(0);
