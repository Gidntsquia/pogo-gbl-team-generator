// pvpoke serial baseline for the benchmark: battleTeams over the exported gen-0 battles, one thread,
// timing the whole battle and the time spent inside the inner simulate() calls.
//   node gpu/serial-baseline.mjs [--specs out/gpu/gen0-specs.json] [--battles 1000] [--memo] [--out out/gpu/serial.json]
// Imports only src/engine/ and src/scoring/ (plan R10).
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { initEngine, buildPokemon } from '../src/engine/harness.js';
import { battleTeams, initTeamBattle } from '../src/engine/teamBattle.js';
import { applyGroupMoveset } from '../src/scoring/index.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const specs = JSON.parse(readFileSync(opt('specs', 'out/gpu/gen0-specs.json'), 'utf8')).battles.slice(0, Number(opt('battles', 1000)));
const memo = args.includes('--memo');
const ctx = await initEngine();
initTeamBattle(ctx);
const build = (s) => {
  const p = buildPokemon(ctx, { speciesId: s.speciesId, ivs: s.ivs, shadow: !!s.shadow, bestBuddy: !!s.bestBuddy });
  if (s.fastMove) applyGroupMoveset(p, { fastMove: s.fastMove, chargedMoves: s.chargedMoves });
  return p;
};
let sims = 0, simMs = 0;
ctx.context.__t = { now: () => performance.now(), add(ms) { sims++; simMs += ms; } };
vm.runInContext(`(function () {
  const Orig = Battle;
  Battle = function () {
    const b = new Orig(); const sim = b.simulate;
    b.simulate = function () { const t = __t.now(); const o = sim.apply(b, arguments); __t.add(__t.now() - t); return o; };
    return b;
  };
  Battle.prototype = Orig.prototype;
})()`, ctx.context);
const t0 = performance.now();
for (const s of specs) {
  battleTeams(ctx, { teamA: s.teamA.map(build), teamB: s.teamB.map(build), leadA: s.leadA, leadB: s.leadB, scenarioMemo: memo });
}
const wall = (performance.now() - t0) / 1000;
const r = { battles: specs.length, scenarioMemo: memo, wallS: wall, battlesPerS: specs.length / wall, innerSims: sims, simSeconds: simMs / 1000, simsPerS: sims / (simMs / 1000), msPerBattle: 1000 * wall / specs.length };
writeFileSync(opt('out', `out/gpu/serial${memo ? '-memo' : ''}.json`), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r));
process.exit(0);
