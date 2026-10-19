#!/usr/bin/env node
// Round 10 R7: the round-7 finalist check (gpu/gpu-width.mjs finalists) for the cap fork. Top 12 at the last generation of
// each named 30-gen run, re-battled on the CPU engine against the gen-29 opponent pool of the first (default) run ->
// out/gpu/r10/finalists.json: per run the mean CPU win% of its top 12. Pass: |mean(cap) - mean(default)| <= 1 pt.
//   node gpu/gpu/r10/finalists.mjs <default run dir> <variant run dir> [<run dir> ...]
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

const dirs = process.argv.slice(2);
if (dirs.length < 2) { console.error('usage: finalists.mjs <default dir> <variant dir> ...'); process.exit(2); }
const rd = (p) => JSON.parse(readFileSync(p, 'utf8'));
const genFiles = (d) => (existsSync(d) ? readdirSync(d).filter((f) => /^evolve-gen\d+\.json$/.test(f)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]) : []);
const last = (d) => { const f = genFiles(d).at(-1); return f ? rd(`${d}/${f}`) : null; };

const { buildEvolveSetup } = await import('../../../src/evolve/setup.js');
const { parseEvolveArgs } = await import('../../../src/evolve/cli.js');
const { evaluateTeamsInOrder } = await import('../../../src/evolve/evaluate.js');
const { ownLeadPairing } = await import('../../../src/evolve/fitness.js');
const { createExecutor } = await import('../../../src/engine/parallel.js');
const { rehydrateOpponentPool } = await import('../../../src/meta/opponentPool.js');
process.env.POGO_COMMUNITY_FILE ??= 'data/archive/meta-teams-community-mega-great.json';

const refCk = last(dirs[0]);
if (!refCk) { console.error(`no checkpoint in ${dirs[0]}`); process.exit(1); }
const { csvPath, opts } = parseEvolveArgs(['jaxon-gl-collection.csv', '--config', 'recipes/standard.json', '--cp', '1500', '--cup', 'mega', '--config', 'recipes/recipe-ab-old.json',
  '--seed', 'recipe-ab', '--curated-ratio', '0.66', '--opponent-meta-pool', '400', '--out-dir', 'out/gpu/r10/_setup']);
const setup = await buildEvolveSetup(csvPath, { ...opts, onLog: () => {} });
const opponents = rehydrateOpponentPool(setup.ctx, refCk.opponentPool, setup.curatedPool, () => {});
const sets = {};
for (const d of dirs) {
  const ck = last(d);
  if (!ck) { console.log(`${d}: no checkpoint, skipped`); continue; }
  sets[d] = { gen: ck.generation, top: ck.population.map((p, i) => ({ keys: p, f: ck.fitness[i] })).sort((a, b) => b.f - a.f).slice(0, 12) };
}
const uniq = new Map();
for (const s of Object.values(sets)) for (const t of s.top) uniq.set(t.keys.join('|'), t.keys);
const teams = [...uniq.values()];
console.log(`re-battling ${teams.length} finalists x ${opponents.length} opponents (gen ${refCk.generation} pool of ${dirs[0]}) on the CPU engine`);
const executor = createExecutor({ threads: 8, vendorRoot: setup.ctx.vendorRoot, continueOnError: true, cp: setup.ctx.cp, cup: setup.ctx.cup });
try {
  const t0 = Date.now();
  const run = await evaluateTeamsInOrder(setup.ctx, { teams, matrix: setup.deduped, opponents, pairingsFor: ownLeadPairing, difficulty: setup.difficulty, executor, roleScores: setup.roleScores });
  const win = new Map(teams.map((t, i) => [t.join('|'), run.results[i].rawWinRate]));
  const name = (keys) => keys.map((k) => setup.deduped.builtMons[k]?.speciesId ?? k).join(' / ');
  const out = { built: new Date().toISOString(), engine: 'cpu (pvpoke)', opponents: opponents.length, poolFrom: dirs[0], poolGen: refCk.generation, seconds: (Date.now() - t0) / 1000, sets: {} };
  for (const [d, s] of Object.entries(sets)) {
    const teamsOut = s.top.map((t, i) => ({ rank: i + 1, team: name(t.keys), sig: t.keys.join('|'), fitness: t.f, win: win.get(t.keys.join('|')) }));
    out.sets[d] = { gen: s.gen, meanWinPct: 100 * teamsOut.reduce((a, t) => a + t.win, 0) / teamsOut.length, teams: teamsOut };
  }
  const ref = out.sets[dirs[0]].meanWinPct;
  for (const [d, s] of Object.entries(out.sets)) console.log(`${d}: gen ${s.gen}, top-12 mean CPU win ${s.meanWinPct.toFixed(2)}% (delta ${(s.meanWinPct - ref).toFixed(2)} pt)`);
  writeFileSync('out/gpu/r10/finalists.json', JSON.stringify(out, null, 1));
  console.log(`wrote out/gpu/r10/finalists.json in ${Math.round(out.seconds)} s`);
} finally { await executor.close(); }
process.exit(0);
