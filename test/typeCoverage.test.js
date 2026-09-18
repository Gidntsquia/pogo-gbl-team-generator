import test from 'node:test';
import assert from 'node:assert/strict';

import {
  weaknessSeverity,
  weaknessProfile,
  computeTypePrevalence,
  computeLeadCoverageScores,
  computeSharedWeaknessScore,
  buildTypeCoverageContext,
} from '../src/teams/typeCoverage.js';
import { initEngine, buildPokemon } from '../src/engine/harness.js';
import { buildMetaMon } from '../src/scoring/index.js';

// pvpoke's own typeEffectiveness values carry float noise, so the fixtures
// use the exact numbers a built Pokemon reports rather than clean 1.6/2.56.
const SE = 1.600000023841858;
const DOUBLE_SE = 2.560000076293946;
const RESIST = 0.625;

/** A stand-in for a built pvpoke Pokemon: only `typeEffectiveness` is read. */
function mon(weaknesses, types = ['normal']) {
  const typeEffectiveness = { fire: 1, water: 1, grass: 1, electric: 1, rock: 1, ice: 1, steel: RESIST };
  for (const [type, mult] of Object.entries(weaknesses)) typeEffectiveness[type] = mult;
  return { pokemon: { typeEffectiveness, types } };
}

test('real pvpoke dual types cancel weaknesses and preserve lead ordering', async () => {
  const ctx = await initEngine({ cp: 1500 });
  const build = (speciesId) => ({ pokemon: buildPokemon(ctx, { speciesId, ivs: { atk: 0, def: 15, hp: 15 } }) });
  const swampert = build('swampert');
  assert.deepEqual([...weaknessProfile(swampert.pokemon)], [['grass', 2]]);
  const azumarill = build('azumarill');
  const skarmory = build('skarmory');
  const shared = computeSharedWeaknessScore([swampert, azumarill, skarmory]);
  const rotated = computeSharedWeaknessScore([skarmory, azumarill, swampert]);
  // Swampert's real double grass weakness (azumarill also shares it) and
  // Skarmory's single electric weakness (azumarill also shares it) both cost
  // something -- which type gets flagged depends on the lead's own typing.
  assert.equal(shared.sharedTypes[0].type, 'grass');
  assert.equal(shared.sharedTypes[0].leadSeverity, 2);
  assert.equal(rotated.sharedTypes[0].type, 'electric');
  assert.equal(rotated.sharedTypes[0].leadSeverity, 1);
  assert.ok(shared.score < 1 && rotated.score < 1);
  assert.deepEqual(shared, computeSharedWeaknessScore([swampert, skarmory, azumarill]));
});

test('weaknessSeverity is 1 for a single weakness and 2 for a double weakness', () => {
  assert.equal(weaknessSeverity(SE), 1);
  assert.equal(weaknessSeverity(DOUBLE_SE), 2);
  assert.equal(weaknessSeverity(1), 0);
  assert.equal(weaknessSeverity(RESIST), 0);
  assert.equal(weaknessSeverity(0.390625), 0);
});

test('weaknessProfile lists only weaknesses and rejects missing type data', () => {
  const profile = weaknessProfile(mon({ rock: DOUBLE_SE, electric: SE }).pokemon);
  assert.deepEqual([...profile.entries()].sort(), [['electric', 1], ['rock', 2]]);
  assert.throws(() => weaknessProfile({}), /typeEffectiveness/);
  assert.throws(() => weaknessProfile({ typeEffectiveness: {} }), /typeEffectiveness/);
  for (const multiplier of [NaN, Infinity, -1, undefined]) {
    assert.throws(() => weaknessSeverity(multiplier), /positive finite/);
  }
});

test('a back line sharing none of the lead\'s weaknesses scores a clean 1', () => {
  const team = [mon({ rock: SE }), mon({ water: SE }), mon({ grass: SE })];
  const { score, load, sharedTypes } = computeSharedWeaknessScore(team);
  assert.equal(score, 1);
  assert.equal(load, 0);
  assert.deepEqual(sharedTypes, []);
});

test('a shared weakness is not diluted by an unrelated third Pokemon', () => {
  const lead = mon({ rock: SE });
  const one = computeSharedWeaknessScore([lead, mon({ rock: SE }), mon({ grass: SE })]);
  const both = computeSharedWeaknessScore([lead, mon({ rock: SE }), mon({ rock: SE })]);
  // Normalized against the fixed tuning divisor (3), not this lead's own
  // typing -- an unrelated third Pokemon still contributes nothing either
  // way, and it doesn't matter how many backs share the weakness.
  assert.ok(Math.abs(one.load - 0.625 / 3) < 1e-9);
  assert.equal(one.load, both.load);
  assert.equal(one.score, both.score);
  assert.equal(one.sharedTypes[0].type, 'rock');
  assert.equal(one.sharedTypes[0].leadSeverity, 1);
});

test('a double weakness on the lead costs 1.6x a single weakness', () => {
  const single = computeSharedWeaknessScore([mon({ rock: SE }), mon({ rock: SE }), mon({ grass: SE })]);
  const deepLead = computeSharedWeaknessScore([mon({ rock: DOUBLE_SE }), mon({ rock: SE }), mon({ grass: SE })]);
  assert.ok(deepLead.score < single.score);
  assert.ok(Math.abs(single.load - 0.625 / 3) < 1e-9);
  assert.ok(Math.abs(deepLead.load / single.load - 1.6) < 1e-9);
});

test('a resisting third Pokemon partially offsets one shared weakness without erasing it', () => {
  const lead = mon({ rock: SE });
  const neutral = computeSharedWeaknessScore([lead, mon({ rock: SE }), mon({})]);
  const resisted = computeSharedWeaknessScore([lead, mon({ rock: SE }), mon({ rock: RESIST })]);
  assert.ok(resisted.load > 0);
  assert.ok(resisted.load < neutral.load);
  // resistanceOffset (0.375) is dampened by RESISTANCE_RELIEF (0.7) before
  // it discounts the contribution: factor = 1 - 0.7*0.375 = 0.7375.
  assert.ok(Math.abs(resisted.load / neutral.load - 0.7375) < 1e-9);
  assert.ok(Math.abs(resisted.sharedTypes[0].resistanceOffset - 0.375) < 1e-9);
});

test('rank-weighted type prevalence splits weight across typings and scales to the dominant type', () => {
  const ranked = [
    { speciesId: 'a', pokemon: { types: ['water', 'ground'] } },
    { speciesId: 'b', pokemon: { types: ['rock', 'none'] } },
  ];
  const prevalence = computeTypePrevalence(ranked, new Map([['a', 3], ['b', 1]]));
  assert.equal(prevalence.get('water'), 1);
  assert.equal(prevalence.get('ground'), 1);
  assert.ok(Math.abs(prevalence.get('rock') - 2 / 3) < 1e-9);
});

test('selected move coverage is rank-weighted and respects dual-type effectiveness', () => {
  const lead = { fastMove: { type: 'fire' }, chargedMoves: [{ type: 'grass' }] };
  const ranked = [
    { speciesId: 'covered', pokemon: { types: ['water'], typeEffectiveness: { fire: RESIST, grass: SE } } },
    { speciesId: 'cancelled', pokemon: { types: ['water', 'flying'], typeEffectiveness: { fire: RESIST, grass: 1 } } },
  ];
  const coverage = computeLeadCoverageScores(lead, ranked, new Map([['covered', 3], ['cancelled', 1]]));
  assert.equal(coverage.get('water'), 0.75);
  assert.equal(coverage.get('flying'), 0);
});

test('common threat types cost more and moveset coverage greatly reduces but does not erase the cost', () => {
  const team = [mon({ water: SE, rock: SE }), mon({ water: SE, rock: SE }), mon({})];
  const typeWeights = new Map([['water', 0.8], ['rock', 0.2]]);
  const noCoverage = computeSharedWeaknessScore(team, { typeWeights });
  const coverage = computeSharedWeaknessScore(team, {
    typeWeights,
    leadCoverage: new Map([['water', 1], ['rock', 0]]),
  });
  const water = noCoverage.sharedTypes.find((x) => x.type === 'water');
  const rock = noCoverage.sharedTypes.find((x) => x.type === 'rock');
  assert.ok(water.contribution > rock.contribution);
  assert.ok(coverage.load > 0);
  assert.ok(coverage.load < noCoverage.load);
  const coveredWater = coverage.sharedTypes.find((x) => x.type === 'water');
  assert.ok(Math.abs(coveredWater.contribution / water.contribution - 0.2) < 1e-9);
});

test('weaknesses shared between the two BACK members only are not penalised', () => {
  const { score } = computeSharedWeaknessScore([mon({ grass: SE }), mon({ rock: SE }), mon({ rock: SE })]);
  assert.equal(score, 1);
});

test('a team with no back line, or a weakness-free lead, scores 1', () => {
  assert.equal(computeSharedWeaknessScore([mon({ rock: SE })]).score, 1);
  assert.equal(computeSharedWeaknessScore([]).score, 1);
  assert.equal(computeSharedWeaknessScore([mon({}), mon({ rock: SE })]).score, 1);
});

// plans/PLAN.md Item 2's coverage-bug test: an opponent lead's build coverage
// lookup used matrix.builtMons' per-collection-row key (`members[0].key`),
// which opponent members never have -- so an opponent lead ALWAYS got an
// empty coverage map (no relief) while a candidate lead with the identical
// build got its real move-coverage relief. The fix keys the lookup by the
// lead's exact build (species + moveset) instead, which both a candidate
// matrix entry and an opponent's buildMetaMon() entry carry.
test('an opponent lead and a candidate lead with the same build get the same shared-weakness score', async () => {
  const ctx = await initEngine({ cp: 1500 });
  const leadEntry = { speciesId: 'swampert', fastMove: 'MUD_SHOT', chargedMoves: ['HYDRO_CANNON', 'EARTHQUAKE'] };
  const candidateLead = buildMetaMon(ctx, leadEntry); // e.g. matrix.builtMons[someKey]
  const opponentLead = buildMetaMon(ctx, leadEntry); // opponent pool entry's members[0], no .key
  const backs = [
    buildMetaMon(ctx, { speciesId: 'azumarill', fastMove: 'BUBBLE', chargedMoves: ['ICE_BEAM', 'HYDRO_PUMP'] }),
    buildMetaMon(ctx, { speciesId: 'skarmory', fastMove: 'AIR_SLASH', chargedMoves: ['SKY_ATTACK', 'FLASH_CANNON'] }),
  ];

  const rankedEntries = [
    { speciesId: 'venusaur', fastMove: 'VINE_WHIP', chargedMoves: ['FRENZY_PLANT'] },
  ];
  const speciesWeights = new Map([['venusaur', 1]]);
  const context = buildTypeCoverageContext(ctx, { candidateKey: candidateLead }, rankedEntries, speciesWeights);

  const candidateScore = computeSharedWeaknessScore([candidateLead, ...backs], context);
  const opponentScore = computeSharedWeaknessScore([opponentLead, ...backs], context);
  assert.deepEqual(opponentScore, candidateScore);
  // Confirm the lookup actually found the build (real coverage present, not
  // both sides sharing the empty-map fallback for different reasons).
  const key = [...context.leadCoverageByKey.keys()][0];
  assert.ok(context.leadCoverageByKey.get(key).size > 0);
});
