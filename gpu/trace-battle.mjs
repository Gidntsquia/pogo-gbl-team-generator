// Print pvpoke's emulate-mode move events (turn, actor index, move, defender hp after) for one exported gen-0 battle.
//   node gpu/trace-battle.mjs <battle index into gen0-specs.json battles> [--specs out/gpu/gen0-specs.json]
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { initEngine, buildPokemon } from '../src/engine/harness.js';
import { battleTeams, initTeamBattle } from '../src/engine/teamBattle.js';
import { applyGroupMoveset } from '../src/scoring/index.js';

const args = process.argv.slice(2);
const k = Number(args[0]);
const si = args.indexOf('--specs');
const s = JSON.parse(readFileSync(si >= 0 ? args[si + 1] : 'out/gpu/gen0-specs.json', 'utf8')).battles[k];
const ctx = await initEngine();
initTeamBattle(ctx);
const build = (x) => {
  const p = buildPokemon(ctx, { speciesId: x.speciesId, ivs: x.ivs, shadow: !!x.shadow, bestBuddy: !!x.bestBuddy });
  if (x.fastMove) applyGroupMoveset(p, { fastMove: x.fastMove, chargedMoves: x.chargedMoves });
  return p;
};
const events = [];
const Orig = ctx.Battle;
ctx.Battle = function () {
  const b = new Orig();
  const impl = b.useMove;
  const gta = b.getTurnAction;
  b.getTurnAction = function (poke, opp) {
    const a = gta.apply(this, arguments);
    if (a) events.push([b.getTurns(), poke.index, 100 + ({ fast: 0, charged: 1, switch: 2 }[a.type]), a.value, 'act', 0]);
    return a;
  };
  b.useMove = function (attacker, defender, move) {
    const r = impl.apply(this, arguments);
    const mi = attacker.fastMove === move ? -1 : attacker.chargedMoves.indexOf(move);
    events.push([b.getTurns(), attacker.index, mi, defender.hp, attacker.speciesId, defender.speciesId]);
    return r;
  };
  return b;
};
ctx.Battle.prototype = Orig.prototype;
const r = battleTeams(ctx, { teamA: s.teamA.map(build), teamB: s.teamB.map(build), leadA: s.leadA, leadB: s.leadB, scenarioMemo: false });
console.log(JSON.stringify({ id: s.id, winner: r.winner, survivors: r.survivorsHp, events }));
process.exit(0);
