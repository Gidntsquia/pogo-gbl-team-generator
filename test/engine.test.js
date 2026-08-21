// JavaScript Document
//
// Verifies src/engine/harness.js against pvpoke's own data:
//   - battle ratings for real Great League matchups are reproduced exactly
//     from vendor/pvpoke/src/data/rankings/all/overall/rankings-1500.json
//   - buildPokemon respects CP <= 1500, custom IVs, bestBuddy, and shadow
//   - simBattle behaves sanely for mirror matches and rejects misuse
//
// Run with: node --test test/engine.test.js

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initEngine, buildPokemon, simBattle } from '../src/engine/harness.js';
import { DEFAULT_VENDOR_ROOT } from '../src/engine/pvpokeLoader.js';

// pvpoke's own shadow Attack/Defense multipliers
// (vendor/pvpoke/src/js/battle/DamageCalculator.js, class DamageMultiplier).
// Repeated here only as an expected value to assert against, not
// recomputed/reimplemented.
const PVPOKE_SHADOW_ATK_MULT = 1.2;
const PVPOKE_SHADOW_DEF_MULT = 0.83333331;

// Well-known Great League matchups, each confirmed bidirectionally
// (rowId's own listed rating vs oppId, and oppId's own listed rating vs
// rowId, summing to ~1000) directly in
// vendor/pvpoke/src/data/rankings/all/overall/rankings-1500.json before
// being chosen here.
const VALIDATION_PAIRS = [
  ['azumarill', 'guzzlord'],
  ['altaria', 'quagsire'],
  ['mimikyu', 'jellicent'], // exercises Mimikyu's Disguise form-change path
  ['lickilicky', 'corsola_galarian'],
];

/** Look up speciesId's own recorded rating against opponentId, pvpoke's "leads" (shields 1/1) scenario. */
function ratingFromRankings(rankings, speciesId, opponentId) {
  const row = rankings.find((r) => r.speciesId === speciesId);
  if (!row) return undefined;
  const hit = [...row.matchups, ...row.counters].find((m) => m.opponent === opponentId);
  return hit?.rating;
}

function movesetFromRankings(rankings, speciesId) {
  return rankings.find((r) => r.speciesId === speciesId)?.moveset;
}

/** pvpoke's own default (max-stat-product) IV spread for CP 1500, read directly from gamemaster data. */
function defaultIVsFor(gm, speciesId) {
  const combo = gm.getPokemonById(speciesId)?.defaultIVs?.cp1500;
  assert.ok(combo, `expected vendor gamemaster data to have defaultIVs.cp1500 for ${speciesId}`);
  const [, atk, def, hp] = combo;
  return { atk, def, hp };
}

let ctx;

before(async () => {
  ctx = await initEngine();
});

describe('initEngine', () => {
  test('loads gamemaster data and Great League rankings directly from vendor/pvpoke', () => {
    assert.ok(Array.isArray(ctx.gm.data.pokemon) && ctx.gm.data.pokemon.length > 1000);
    assert.ok(Array.isArray(ctx.gm.data.moves) && ctx.gm.data.moves.length > 100);
    assert.ok(Array.isArray(ctx.rankings) && ctx.rankings.length > 1000);
    // Populated under the same key Pokemon.js's own selectRecommendedMoveset computes.
    assert.strictEqual(ctx.gm.rankings.alloverall1500, ctx.rankings);
  });

  test('accepts an explicit vendorRoot override', async () => {
    const other = await initEngine({ vendorRoot: DEFAULT_VENDOR_ROOT });
    assert.ok(other.gm.data.pokemon.length > 1000);
  });

  test('battle defaults already match Great League ("all" cup, CP 1500, level cap 50)', () => {
    assert.strictEqual(ctx.battle.getCP(), 1500);
    assert.strictEqual(ctx.battle.getLevelCap(), 50);
    assert.strictEqual(ctx.battle.getCup().name, 'all');
  });
});

describe('buildPokemon', () => {
  test('CP never exceeds 1500, for a capped species and an uncapped one', () => {
    const capped = buildPokemon(ctx, { speciesId: 'azumarill', ivs: { atk: 15, def: 15, hp: 15 } });
    const uncapped = buildPokemon(ctx, { speciesId: 'medicham', ivs: { atk: 0, def: 0, hp: 0 } });
    assert.ok(capped.cp <= 1500, `azumarill 15/15/15 cp=${capped.cp}`);
    assert.ok(uncapped.cp <= 1500, `medicham 0/0/0 cp=${uncapped.cp}`);
    // Sanity: levels are valid half-level increments within the default cap.
    for (const p of [capped, uncapped]) {
      assert.ok(p.level >= 1 && p.level <= 50);
      assert.strictEqual((p.level * 2) % 1, 0, `level ${p.level} should be a half-level increment`);
    }
  });

  test('a 0/15/15 spread yields a different level and stats than 15/15/15 (azumarill caps under CP 1500)', () => {
    const lowAtk = buildPokemon(ctx, { speciesId: 'azumarill', ivs: { atk: 0, def: 15, hp: 15 } });
    const maxIv = buildPokemon(ctx, { speciesId: 'azumarill', ivs: { atk: 15, def: 15, hp: 15 } });

    assert.notStrictEqual(lowAtk.level, maxIv.level);
    assert.notStrictEqual(lowAtk.stats.atk, maxIv.stats.atk);
    assert.notStrictEqual(lowAtk.stats.hp, maxIv.stats.hp);
    assert.ok(lowAtk.cp <= 1500 && maxIv.cp <= 1500);
  });

  test('same 0/15/15-vs-15/15/15 divergence holds for medicham', () => {
    const lowAtk = buildPokemon(ctx, { speciesId: 'medicham', ivs: { atk: 0, def: 15, hp: 15 } });
    const maxIv = buildPokemon(ctx, { speciesId: 'medicham', ivs: { atk: 15, def: 15, hp: 15 } });

    assert.notStrictEqual(lowAtk.level, maxIv.level);
    assert.notStrictEqual(lowAtk.stats.atk, maxIv.stats.atk);
    assert.ok(lowAtk.cp <= 1500 && maxIv.cp <= 1500);
  });

  test('reproduces pvpoke\'s own precomputed default-IV level/CP (defaultIVs.cp1500) for several species', () => {
    // If buildPokemon's level-search loop matches pvpoke's own
    // (Pokemon.generateIVCombinations), feeding it the exact IVs pvpoke
    // precomputed as the max-stat-product CP-1500 combo must land on the
    // exact level pvpoke recorded alongside them.
    for (const speciesId of ['azumarill', 'medicham', 'guzzlord', 'skarmory', 'registeel']) {
      const [expectedLevel, atk, def, hp] = ctx.gm.getPokemonById(speciesId).defaultIVs.cp1500;
      const built = buildPokemon(ctx, { speciesId, ivs: { atk, def, hp } });
      assert.strictEqual(built.level, expectedLevel, `${speciesId} level`);
      assert.ok(built.cp <= 1500, `${speciesId} cp=${built.cp}`);
    }
  });

  test('bestBuddy allows level 51 (and only when the species is not already CP-capped below 50)', () => {
    const normal = buildPokemon(ctx, {
      speciesId: 'azumarill',
      ivs: { atk: 0, def: 0, hp: 0 },
      bestBuddy: false,
    });
    const bestBuddy = buildPokemon(ctx, {
      speciesId: 'azumarill',
      ivs: { atk: 0, def: 0, hp: 0 },
      bestBuddy: true,
    });

    assert.strictEqual(normal.level, 50);
    assert.strictEqual(bestBuddy.level, 51);
    assert.ok(bestBuddy.cp > normal.cp);
    assert.ok(bestBuddy.cp <= 1500);
  });

  test('recommended moveset matches pvpoke\'s own rankings-1500.json moveset entry', () => {
    for (const speciesId of ['azumarill', 'guzzlord', 'mimikyu']) {
      const ivs = defaultIVsFor(ctx.gm, speciesId);
      const built = buildPokemon(ctx, { speciesId, ivs });
      const expectedMoveset = movesetFromRankings(ctx.rankings, speciesId);
      const builtMoveset = [built.fastMove.moveId, ...built.chargedMoves.map((m) => m.moveId)];
      assert.deepStrictEqual(builtMoveset, expectedMoveset);
    }
  });

  test('shadow applies pvpoke\'s shadow atk/def multipliers for a real Shadow-eligible species', () => {
    const normal = buildPokemon(ctx, { speciesId: 'sableye', ivs: { atk: 1, def: 15, hp: 14 } });
    const shadow = buildPokemon(ctx, { speciesId: 'sableye', ivs: { atk: 1, def: 15, hp: 14 }, shadow: true });

    assert.strictEqual(normal.shadowType, 'normal');
    assert.strictEqual(normal.shadowAtkMult, 1);
    assert.strictEqual(normal.shadowDefMult, 1);

    assert.strictEqual(shadow.speciesId, 'sableye_shadow');
    assert.strictEqual(shadow.shadowType, 'shadow');
    assert.strictEqual(shadow.shadowAtkMult, PVPOKE_SHADOW_ATK_MULT);
    assert.strictEqual(shadow.shadowDefMult, PVPOKE_SHADOW_DEF_MULT);
    // The _shadow gamemaster entry carries its own recommended moveset.
    assert.deepStrictEqual(
      [shadow.fastMove.moveId, ...shadow.chargedMoves.map((m) => m.moveId)],
      movesetFromRankings(ctx.rankings, 'sableye_shadow')
    );
  });

  test('shadow still applies the multipliers for a species pvpoke has never modeled as Shadow', () => {
    // Azumarill has never been released as Shadow in-game, so
    // vendor/pvpoke/src/data/gamemaster/pokemon.json has no "azumarill_shadow"
    // entry -- buildPokemon falls back to the base species and applies the
    // multipliers by hand (see harness.js).
    assert.ok(!ctx.gm.pokemonMap.has('azumarill_shadow'), 'fixture assumption: no azumarill_shadow entry');

    const shadow = buildPokemon(ctx, {
      speciesId: 'azumarill',
      ivs: { atk: 4, def: 15, hp: 13 },
      shadow: true,
    });

    assert.strictEqual(shadow.speciesId, 'azumarill');
    assert.strictEqual(shadow.shadowType, 'shadow');
    assert.strictEqual(shadow.shadowAtkMult, PVPOKE_SHADOW_ATK_MULT);
    assert.strictEqual(shadow.shadowDefMult, PVPOKE_SHADOW_DEF_MULT);
  });

  test('rejects an unknown speciesId', () => {
    assert.throws(
      () => buildPokemon(ctx, { speciesId: 'not_a_real_pokemon', ivs: { atk: 1, def: 1, hp: 1 } }),
      /unknown speciesId/
    );
  });

  test('rejects out-of-range or non-integer IVs', () => {
    assert.throws(() => buildPokemon(ctx, { speciesId: 'azumarill', ivs: { atk: 16, def: 0, hp: 0 } }), /ivs\.atk/);
    assert.throws(() => buildPokemon(ctx, { speciesId: 'azumarill', ivs: { atk: -1, def: 0, hp: 0 } }), /ivs\.atk/);
    assert.throws(() => buildPokemon(ctx, { speciesId: 'azumarill', ivs: { atk: 1.5, def: 0, hp: 0 } }), /ivs\.atk/);
  });
});

describe('simBattle', () => {
  test('a mirror match returns ratings ~500/500', () => {
    const a = buildPokemon(ctx, { speciesId: 'azumarill', ivs: { atk: 4, def: 15, hp: 13 } });
    const b = buildPokemon(ctx, { speciesId: 'azumarill', ivs: { atk: 4, def: 15, hp: 13 } });

    const result = simBattle(ctx, { p1: a, p2: b, shields: [1, 1] });

    // Observed exact 500/500 for an identical-object mirror (pvpoke's
    // simulation is fully deterministic in "default" decision mode -- no
    // shield/buff RNG is exercised). A small tolerance is kept here rather
    // than asserting exact equality so this test isn't brittle to that
    // implementation detail if pvpoke's tie-breaking ever changes.
    assert.ok(Math.abs(result.rating1 - 500) <= 25, `rating1=${result.rating1}`);
    assert.ok(Math.abs(result.rating2 - 500) <= 25, `rating2=${result.rating2}`);
    assert.strictEqual(result.rating1 + result.rating2, 1000);
  });

  test('rejects reusing the same Pokemon instance for both sides', () => {
    const a = buildPokemon(ctx, { speciesId: 'azumarill', ivs: { atk: 4, def: 15, hp: 13 } });
    assert.throws(() => simBattle(ctx, { p1: a, p2: a, shields: [1, 1] }), /distinct Pokemon instances/);
  });

  test('shape of the result matches the documented contract', () => {
    const a = buildPokemon(ctx, { speciesId: 'azumarill', ivs: { atk: 4, def: 15, hp: 13 } });
    const b = buildPokemon(ctx, { speciesId: 'guzzlord', ivs: { atk: 4, def: 13, hp: 10 } });
    const result = simBattle(ctx, { p1: a, p2: b, shields: [1, 1] });

    assert.deepStrictEqual(Object.keys(result).sort(), ['hp1', 'hp2', 'rating1', 'rating2', 'turns'].sort());
    for (const key of ['rating1', 'rating2', 'hp1', 'hp2', 'turns']) {
      assert.strictEqual(typeof result[key], 'number');
    }
    assert.ok(result.rating1 >= 0 && result.rating1 <= 1000);
    assert.ok(result.rating2 >= 0 && result.rating2 <= 1000);
    assert.ok(result.turns > 0);
  });

  describe('reproduces pvpoke\'s own rankings-1500.json battle ratings exactly', () => {
    for (const [rowId, oppId] of VALIDATION_PAIRS) {
      test(`${rowId} vs ${oppId} (shields 1/1, pvpoke's "leads" scenario)`, () => {
        const expectedRating1 = ratingFromRankings(ctx.rankings, rowId, oppId);
        const expectedRating2 = ratingFromRankings(ctx.rankings, oppId, rowId);
        assert.ok(
          expectedRating1 !== undefined && expectedRating2 !== undefined,
          `fixture assumption: ${rowId} <-> ${oppId} should be a listed matchup/counter both directions`
        );

        const p1 = buildPokemon(ctx, { speciesId: rowId, ivs: defaultIVsFor(ctx.gm, rowId) });
        const p2 = buildPokemon(ctx, { speciesId: oppId, ivs: defaultIVsFor(ctx.gm, oppId) });

        // rankings-1500.json's per-matchup ratings come from pvpoke's
        // "leads" ranking scenario: shields [1, 1], no energy advantage
        // (vendor/pvpoke/src/data/gamemaster.json -> rankingScenarios).
        const result = simBattle(ctx, { p1, p2, shields: [1, 1] });

        // Exact match: same IVs (pvpoke's own default/max-stat-product
        // spread), same moveset (pvpoke's own recommended-moveset logic),
        // same shield scenario, same simulator code -> identical result.
        assert.strictEqual(result.rating1, expectedRating1);
        assert.strictEqual(result.rating2, expectedRating2);
      });
    }
  });
});

describe('initEngine({ cp }) -- Ultra League (CP 2500) parameterization', () => {
  // Sibling of the CP-1500 "reproduces pvpoke's own rankings...json battle
  // ratings exactly" block above, run against rankings-2500.json instead, to
  // confirm the engine layer is genuinely CP-cap-generic (ROADMAP's
  // "--cp 2500 / Ultra League flag" gap, engine-layer slice) rather than
  // just accepting the option and silently still simulating Great League.
  const UL_VALIDATION_PAIRS = [
    ['lickilicky', 'corviknight'],
    ['tinkaton', 'corviknight'],
  ];

  let ulCtx;

  before(async () => {
    ulCtx = await initEngine({ cp: 2500 });
  });

  test('battle is configured for CP 2500, "all" cup, level cap 50 -- and CP-1500 ctx is unaffected', () => {
    assert.strictEqual(ulCtx.battle.getCP(), 2500);
    assert.strictEqual(ulCtx.battle.getLevelCap(), 50);
    assert.strictEqual(ulCtx.battle.getCup().name, 'all');
    assert.strictEqual(ulCtx.cp, 2500);
    assert.strictEqual(ulCtx.gm.rankings.alloverall2500, ulCtx.rankings);

    // The default (no opts.cp) ctx built in the top-level before() hook must
    // stay exactly Great League -- two initEngine() calls must not share or
    // clobber each other's Battle/rankings state.
    assert.strictEqual(ctx.battle.getCP(), 1500);
    assert.strictEqual(ctx.cp, 1500);
  });

  test('rejects an unsupported CP cap with a clear error', async () => {
    await assert.rejects(() => initEngine({ cp: 999 }), /no vendored rankings for cp=999/);
  });

  test('buildPokemon respects the CP-2500 cap, not 1500', () => {
    const built = buildPokemon(ulCtx, { speciesId: 'lickilicky', ivs: { atk: 4, def: 13, hp: 13 } });
    assert.ok(built.cp <= 2500, `lickilicky cp=${built.cp}`);
    assert.ok(built.cp > 1500, `expected a CP-2500-built lickilicky to exceed 1500, got ${built.cp}`);
  });

  test('reproduces pvpoke\'s own precomputed default-IV level/CP (defaultIVs.cp2500) for several species', () => {
    for (const speciesId of ['lickilicky', 'corviknight', 'tinkaton']) {
      const [expectedLevel, atk, def, hp] = ulCtx.gm.getPokemonById(speciesId).defaultIVs.cp2500;
      const built = buildPokemon(ulCtx, { speciesId, ivs: { atk, def, hp } });
      assert.strictEqual(built.level, expectedLevel, `${speciesId} level`);
      assert.ok(built.cp <= 2500, `${speciesId} cp=${built.cp}`);
    }
  });

  describe('reproduces pvpoke\'s own rankings-2500.json battle ratings exactly', () => {
    for (const [rowId, oppId] of UL_VALIDATION_PAIRS) {
      test(`${rowId} vs ${oppId} (shields 1/1, pvpoke's "leads" scenario)`, () => {
        const expectedRating1 = ratingFromRankings(ulCtx.rankings, rowId, oppId);
        const expectedRating2 = ratingFromRankings(ulCtx.rankings, oppId, rowId);
        assert.ok(
          expectedRating1 !== undefined && expectedRating2 !== undefined,
          `fixture assumption: ${rowId} <-> ${oppId} should be a listed matchup/counter both directions`
        );

        const cp2500IvsFor = (speciesId) => {
          const [, atk, def, hp] = ulCtx.gm.getPokemonById(speciesId).defaultIVs.cp2500;
          return { atk, def, hp };
        };
        const p1 = buildPokemon(ulCtx, { speciesId: rowId, ivs: cp2500IvsFor(rowId) });
        const p2 = buildPokemon(ulCtx, { speciesId: oppId, ivs: cp2500IvsFor(oppId) });

        const result = simBattle(ulCtx, { p1, p2, shields: [1, 1] });

        assert.strictEqual(result.rating1, expectedRating1);
        assert.strictEqual(result.rating2, expectedRating2);
      });
    }
  });
});
