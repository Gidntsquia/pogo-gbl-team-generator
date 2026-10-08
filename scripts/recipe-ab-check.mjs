#!/usr/bin/env node
// Pre-launch check: parse the evolve.mjs command that `sim.sh --dry-run` printed for one sim and confirm the
// effective settings (config-file merge included) match plans/PLAN.md requirements 1-3. Exit 1 on mismatch.
//   node scripts/recipe-ab-check.mjs <1|2|3> [--smoke] -- <evolve.mjs argv...>
import { parseEvolveArgs } from '../src/evolve/cli.js';
import { buildRunConfig } from '../src/evolve/config.js';
import { simDefs, SEED } from './recipe-ab-lib.mjs';

const argv = process.argv.slice(2);
const n = Number(argv[0]);
const smoke = argv.includes('--smoke');
const evolveArgv = argv.slice(argv.indexOf('--') + 1);
const def = simDefs(smoke).find((d) => d.n === n);
const parsed = parseEvolveArgs(evolveArgv);
const c = buildRunConfig(parsed.csvPath, parsed.opts);
const eff = {
  population: c.population, finalRatio: c.populationFinalRatio, opponents: c.opponentsPerGen, k: c.sampledOpponents ?? null,
  halving: c.halvingRounds ?? 0, seed: c.seed,
};
const want = { population: def.population, finalRatio: def.finalRatio, opponents: def.opponents, k: def.k, halving: def.halving, seed: SEED };
const fixed = {
  cup: 'mega', cp: 1500, eliteCount: 15, snowballWeight: 0.4, closerWeight: 0.1, consistencyWeight: 0.2, sharedWeaknessWeight: 0.2,
  coreRivalry: 0.2, mutationFloorStart: 0.15, mutationCeilStart: 0.6, curatedRatio: 0.66, opponentMetaPool: 400,
  archetypeBeta: 0.5, opponentStrengthGamma: 1, similarRivalry: 1, similarFloor: 0.35, evolutions: true, generations: def.generations,
};
const bad = [];
for (const [k, v] of Object.entries(want)) if (eff[k] !== v) bad.push(`${k}: got ${eff[k]}, want ${v}`);
for (const [k, v] of Object.entries(fixed)) if (c[k] !== v) bad.push(`${k}: got ${c[k]}, want ${v}`);
if (c.banSpecies?.length || c.excludeSpecies?.length) bad.push('bans/excludes present');
if (evolveArgv.some((a) => a === '--battle-cache-file' || a === '--seed-from')) bad.push('--battle-cache-file/--seed-from present');
console.log(`[check] sim ${n} ${def.name}: population ${eff.population}, final ratio ${eff.finalRatio}, opponents ${eff.opponents}, K ${eff.k ?? 'off'}, halving rounds ${eff.halving}, seed ${eff.seed}${bad.length ? '  MISMATCH' : '  ok'}`);
if (bad.length) { for (const b of bad) console.error(`[check]   ${b}`); process.exit(1); }
