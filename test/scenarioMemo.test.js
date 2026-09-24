// Fast-tier unit test for the scenario memo's form-change rule (src/engine/battle/scenarioMemo.js):
// a sim involving a form-changing Pokemon must run for real every time and never be stored, a plain
// one is stored and replayed. Fake battle and Pokemon objects; real battles are in e2e.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapRunScenario } from '../src/engine/battle/scenarioMemo.js';

const mon = (id, formChange) => ({
  speciesId: id, startFormId: id, activeFormId: id, formChange, stats: { atk: 1, def: 1, hp: 1 }, shadowType: 'normal',
  fastMove: { moveId: 'F' }, chargedMoves: [{ moveId: 'C' }], priority: 0, turnsToKO: -1, baitShields: 1, farmEnergy: false,
  hasActed: false, optimizeMoveTiming: false, chargedMovesOnly: false, startHp: 1, startEnergy: 0, startCooldown: 0,
  startingShields: 1, startStatBuffs: [0, 0], nativeStatBuffs: [0, 0], statBuffs: [0, 0], hp: 1, energy: 0, cooldown: 0,
  shields: 1, damageWindow: 0, faintSource: null, battle: null,
  getBattle() { return this.battle; }, setBattle(b) { this.battle = b; }, changeForm() {},
});

function harness(p0, p1) {
  let realSims = 0;
  class RealBattle {
    getPokemon() { return [p0, p1]; }
    simulate() { realSims += 1; }
    getBattleRatings() { return [500, 0]; }
  }
  let Current = RealBattle;
  const memo = { map: new Map(), hits: 0, misses: 0, max: 100, vmMath: { random: () => 0.5 }, RealBattle, setGlobalBattle: (B) => { Current = B; } };
  const ai = { runScenario() { new Current().simulate(); return 'ok'; } };
  wrapRunScenario(ai, memo);
  return { ai, memo, sims: () => realSims };
}

test('a plain matchup is stored once and replayed', () => {
  const { ai, memo, sims } = harness(mon('a'), mon('b'));
  ai.runScenario('x', mon('a'), mon('b'));
  ai.runScenario('x', mon('a'), mon('b'));
  assert.equal(sims(), 1);
  assert.equal(memo.hits, 1);
});

test('a form-changing Pokemon on either side always simulates for real and is never stored', () => {
  for (const [a, b] of [[mon('mimikyu', {}), mon('b')], [mon('a'), mon('cramorant', {})]]) {
    const { ai, memo, sims } = harness(a, b);
    ai.runScenario('x', a, b);
    ai.runScenario('x', a, b);
    assert.equal(sims(), 2);
    assert.equal(memo.map.size, 0);
    assert.equal(memo.hits + memo.misses, 0);
  }
});
