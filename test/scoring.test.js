// JavaScript Document
//
// Verifies src/scoring/index.js -- the 1v1 meta scoring matrix -- against
// pvpoke's own engine (src/engine/harness.js). No battle math is exercised
// here directly; every rating this suite checks comes from harness.simBattle
// (pvpoke's own Battle.simulate()). Kept fast: a tiny hand-picked meta subset
// only. A full 49-entry great.json run is deliberately NOT tested here (it is
// exercised end-to-end in the CLI/e2e path instead).
//
// Run with: node --test test/scoring.test.js

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initEngine, buildPokemon, simBattle } from '../src/engine/harness.js';
import {
  loadMeta,
  scoreCollection,
  computeWeightedScore,
  computeLeadIn,
} from '../src/scoring/index.js';

// A small, stable Great League meta subset (real great.json movesets), enough
// to exercise every code path without the cost of the full group.
const TEST_META = [
  { speciesId: 'registeel', fastMove: 'LOCK_ON', chargedMoves: ['FOCUS_BLAST', 'FLASH_CANNON'] },
  { speciesId: 'medicham', fastMove: 'COUNTER', chargedMoves: ['POWER_UP_PUNCH', 'ICE_PUNCH'] },
  {
    speciesId: 'annihilape_shadow',
    fastMove: 'COUNTER',
    chargedMoves: ['RAGE_FIST', 'ICE_PUNCH'],
    shadowType: 'shadow',
  },
];

const RANK1_IVS = { atk: 0, def: 15, hp: 15 };

let ctx;

before(async () => {
  ctx = await initEngine();
});

describe('loadMeta', () => {
  test('applies each group entry\'s explicit moveset to the built pokemon', () => {
    const meta = loadMeta(ctx, { groupEntries: TEST_META });
    assert.equal(meta.length, TEST_META.length);

    for (let i = 0; i < TEST_META.length; i++) {
      const entry = TEST_META[i];
      const m = meta[i];
      assert.equal(m.speciesId, entry.speciesId);
      assert.equal(
        m.pokemon.fastMove.moveId,
        entry.fastMove,
        `${entry.speciesId}: fast move not applied`
      );
      // Array.from re-homes the pvpoke-vm-realm array into this realm's
      // Array.prototype so deepEqual's reference-equal prototype check passes.
      assert.deepEqual(
        Array.from(m.pokemon.chargedMoves, (c) => c.moveId),
        entry.chargedMoves,
        `${entry.speciesId}: charged moves not applied`
      );
    }
  });

  test('resolves a "_shadow" group id to a shadow pokemon on the base species', () => {
    const meta = loadMeta(ctx, { groupEntries: TEST_META });
    const ape = meta.find((m) => m.speciesId === 'annihilape_shadow');
    assert.ok(ape, 'annihilape_shadow should be in the meta');
    assert.equal(ape.shadow, true);
    assert.equal(ape.baseSpeciesId, 'annihilape');
    assert.equal(ape.pokemon.shadowType, 'shadow');
  });

  test('metaLimit caps how many entries are built', () => {
    const meta = loadMeta(ctx, { groupEntries: TEST_META, metaLimit: 2 });
    assert.equal(meta.length, 2);
    assert.deepEqual(
      meta.map((m) => m.speciesId),
      ['registeel', 'medicham']
    );
  });
});

describe('scoreCollection', () => {
  const collection = [
    { speciesId: 'azumarill', name: 'Azumarill', ivs: RANK1_IVS, shadow: false, sourceRow: 1 },
    { speciesId: 'magikarp', name: 'Magikarp', ivs: { atk: 15, def: 15, hp: 15 }, shadow: false, sourceRow: 2 },
  ];

  test('produces the Matrix shape from PLAN.md', () => {
    const m = scoreCollection(ctx, collection, { groupEntries: TEST_META });

    // mons: [{ speciesId, name, score, leadIn }]
    assert.equal(m.mons.length, 2);
    for (const mon of m.mons) {
      assert.equal(typeof mon.speciesId, 'string');
      assert.equal(typeof mon.name, 'string');
      assert.equal(typeof mon.score, 'number');
      assert.equal(typeof mon.leadIn, 'string');
    }

    // meta: [speciesId...]
    assert.deepEqual(m.meta, ['registeel', 'medicham', 'annihilape_shadow']);

    // ratings: { [userMonKey]: { [metaSpeciesId]: { s00, s11, s22 } } }
    assert.deepEqual(Object.keys(m.ratings).sort(), ['azumarill#1', 'magikarp#2']);
    for (const key of Object.keys(m.ratings)) {
      assert.deepEqual(Object.keys(m.ratings[key]).sort(), [
        'annihilape_shadow',
        'medicham',
        'registeel',
      ]);
      for (const metaId of m.meta) {
        const cell = m.ratings[key][metaId];
        assert.deepEqual(Object.keys(cell).sort(), ['s00', 's11', 's22']);
        for (const k of ['s00', 's11', 's22']) {
          assert.ok(cell[k] >= 0 && cell[k] <= 1000, `${key} vs ${metaId} ${k} in 0..1000`);
        }
      }
    }

    assert.deepEqual(m.warnings, []);
  });

  test('a matrix cell (s11) equals a direct simBattle with the same instances', () => {
    // Reproduce exactly what scoreCollection does for azumarill vs registeel
    // at shields 1/1, independently, and assert the numbers agree.
    const meta = loadMeta(ctx, { groupEntries: TEST_META });
    const registeel = meta.find((m) => m.speciesId === 'registeel').pokemon;
    const azu = buildPokemon(ctx, { speciesId: 'azumarill', ivs: RANK1_IVS, shadow: false });

    const { rating1 } = simBattle(ctx, { p1: azu, p2: registeel, shields: [1, 1] });

    const m = scoreCollection(ctx, [collection[0]], { meta });
    assert.equal(m.ratings['azumarill#1'].registeel.s11, rating1);
  });

  test('a strong meta pick outscores a deliberately weak one', () => {
    const m = scoreCollection(ctx, collection, { groupEntries: TEST_META });
    const azu = m.mons.find((x) => x.speciesId === 'azumarill');
    const karp = m.mons.find((x) => x.speciesId === 'magikarp');
    assert.ok(
      azu.score > karp.score,
      `azumarill (${azu.score}) should outscore magikarp (${karp.score})`
    );
  });

  test('skips an unknown speciesId with a warning rather than throwing', () => {
    const withBad = [
      collection[0],
      { speciesId: 'notarealmon', name: 'Bogus', ivs: RANK1_IVS, shadow: false, sourceRow: 9 },
    ];
    const m = scoreCollection(ctx, withBad, { groupEntries: TEST_META });
    assert.equal(m.mons.length, 1);
    assert.equal(m.mons[0].speciesId, 'azumarill');
    assert.equal(m.warnings.length, 1);
    assert.match(m.warnings[0], /notarealmon#9/);
  });

  test('onProgress fires once per scored mon', () => {
    const calls = [];
    scoreCollection(ctx, collection, {
      groupEntries: TEST_META,
      onProgress: (p) => calls.push(p),
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[calls.length - 1].completed, 2);
    assert.equal(calls[calls.length - 1].total, 2);
  });

  // ----------------------------------------- GOALS T17: current-moves mode --

  test('currentMoves: applies a user mon\'s own resolved moveset instead of recommended', () => {
    // Azumarill's pvpoke-recommended Great League moveset is Bubble + Ice
    // Beam/Play Rough; pick a deliberately different (but legal) moveset so
    // the assertion can't pass by coincidence.
    const withMoves = [
      {
        ...collection[0],
        moves: { fastMove: 'ROCK_SMASH', chargedMoves: ['HYDRO_PUMP'] },
      },
    ];
    const m = scoreCollection(ctx, withMoves, { groupEntries: TEST_META, currentMoves: true });
    assert.equal(m.warnings.length, 0);

    const built = m.builtMons['azumarill#1'];
    assert.equal(built.pokemon.fastMove.moveId, 'ROCK_SMASH');
    assert.deepEqual(Array.from(built.pokemon.chargedMoves, (c) => c.moveId), ['HYDRO_PUMP']);
    // Spec-carrying (T15b plumbing) must record the applied moveset too, so
    // --threads rebuilds match the serial build.
    assert.equal(built.spec.fastMove, 'ROCK_SMASH');
    assert.deepEqual(built.spec.chargedMoves, ['HYDRO_PUMP']);
  });

  test('currentMoves: a mon with no resolved moves falls back to recommended, with a warning', () => {
    const m = scoreCollection(ctx, collection, { groupEntries: TEST_META, currentMoves: true });
    assert.equal(m.warnings.length, 2, 'both fixture mons carry no `moves` field');
    assert.match(m.warnings[0], /azumarill#1.*current-moves mode/);
    // Falls back to buildPokemon's own recommended moveset -- still a valid,
    // battle-ready mon, not skipped.
    assert.equal(m.mons.length, 2);
    assert.equal(m.builtMons['azumarill#1'].spec.fastMove, undefined);
  });

  test('currentMoves defaults to false: a resolved `moves` field is ignored unless opted in', () => {
    const withMoves = [
      { ...collection[0], moves: { fastMove: 'ROCK_SMASH', chargedMoves: ['HYDRO_PUMP'] } },
    ];
    const m = scoreCollection(ctx, withMoves, { groupEntries: TEST_META });
    assert.equal(m.warnings.length, 0);
    // Recommended moveset (Bubble), not the supplied ROCK_SMASH.
    assert.equal(m.builtMons['azumarill#1'].pokemon.fastMove.moveId, 'BUBBLE');
  });
});

describe('computeWeightedScore', () => {
  test('is the 0.25/0.50/0.25 weighted mean over the meta, rounded to 1 dp', () => {
    const ratings = {
      a: { s00: 400, s11: 500, s22: 600 }, // weighted = 100 + 250 + 150 = 500
      b: { s00: 0, s11: 200, s22: 400 }, //   weighted = 0 + 100 + 100 = 200
    };
    // mean of 500 and 200 = 350
    assert.equal(computeWeightedScore(ratings), 350);
  });

  test('returns 0 for an empty ratings set', () => {
    assert.equal(computeWeightedScore({}), 0);
  });
});

describe('computeLeadIn', () => {
  test('names beaten and lost-to opponents by s11 (win = >500, loss = <500)', () => {
    const ratings = {
      alpha: { s00: 0, s11: 700, s22: 0 },
      beta: { s00: 0, s11: 300, s22: 0 },
    };
    const s = computeLeadIn(ratings);
    assert.match(s, /beats alpha/);
    assert.match(s, /loses to beta/);
  });
});
