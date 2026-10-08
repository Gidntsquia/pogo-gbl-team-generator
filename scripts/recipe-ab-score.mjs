#!/usr/bin/env node
// Re-battle every completed sim's finalists against the curated opponent file (data/meta-teams-community.json),
// both directions, each finalist at its own lead, unweighted, one pass, one seed (plans/PLAN.md requirement 8).
//   node scripts/recipe-ab-score.mjs [--smoke] [--runs name=dir,name=dir]
// Writes out/recipe-ab[-smoke]/curated100.json (deterministic: no timestamps, so reruns are byte-identical).
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEvolveArgs } from '../src/evolve/cli.js';
import { buildEvolveSetup } from '../src/evolve/setup.js';
import { evaluateTeamsInOrder } from '../src/evolve/evaluate.js';
import { ownLeadPairing } from '../src/evolve/fitness.js';
import { createExecutor } from '../src/engine/parallel.js';
import { simDefs, SEED, COLLECTION } from './recipe-ab-lib.mjs';

const argv = process.argv.slice(2);
const smoke = argv.includes('--smoke');
const runsArg = argv.includes('--runs') ? argv[argv.indexOf('--runs') + 1] : null;
const stateDir = path.join('out', smoke ? 'recipe-ab-smoke' : 'recipe-ab');
mkdirSync(stateDir, { recursive: true });
const runs = runsArg
  ? runsArg.split(',').map((s) => { const [name, dir] = s.split('='); return { name, dir }; })
  : simDefs(smoke).map((d) => ({ name: d.name, dir: path.join('out', `evolve-${d.name}`) }));
const done = runs.filter((r) => existsSync(path.join(r.dir, 'evolve-DONE')) && existsSync(path.join(r.dir, 'evolve-result.json')));
const skipped = runs.filter((r) => !done.includes(r)).map((r) => r.name);

const { csvPath, opts } = parseEvolveArgs([COLLECTION, '--cup', 'mega', '--seed', SEED, '--curated-ratio', '0.66',
  '--opponent-meta-pool', '400', '--out-dir', path.join(stateDir, '_score')]);
const setup = await buildEvolveSetup(csvPath, { ...opts, onLog: () => {} });
const opponents = setup.curatedPool.map((t) => ({ ...t, label: 'curated', leadIndex: t.leadIndex ?? 0 }));
const executor = createExecutor({ threads: smoke ? 4 : 8, vendorRoot: setup.ctx.vendorRoot, continueOnError: true, cp: setup.ctx.cp, cup: setup.ctx.cup });
const out = { opponentSet: 'data/meta-teams-community.json', opponentCount: opponents.length, seed: SEED, skipped, sims: {} };
try {
  for (const r of done) {
    const result = JSON.parse(readFileSync(path.join(r.dir, 'evolve-result.json'), 'utf8'));
    const finalists = result.elites.map((e) => ({ keys: e.members.map((m) => m.key), signature: e.signature }));
    const run = await evaluateTeamsInOrder(setup.ctx, {
      teams: finalists.map((f) => f.keys), matrix: setup.deduped, opponents, pairingsFor: ownLeadPairing,
      difficulty: setup.difficulty, executor, roleScores: setup.roleScores, cache: setup.battleCache,
    });
    out.sims[r.name] = finalists.map((f, i) => ({ signature: f.signature, keys: f.keys, curatedWinRate: run.results[i].rawWinRate }));
    console.log(`[score] ${r.name}: ${finalists.length} finalists vs ${opponents.length} curated; top1 ${(out.sims[r.name][0].curatedWinRate * 100).toFixed(1)}%`);
  }
} finally {
  await executor.close();
}
const file = path.join(stateDir, 'curated100.json');
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`[score] wrote ${file}${skipped.length ? ` (not scored, incomplete: ${skipped.join(', ')})` : ''}`);
