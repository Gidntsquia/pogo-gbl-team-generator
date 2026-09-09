// Tests for src/engine/similarity.js -- pvpoke's own Pokemon#calculateSimilarity,
// normalised to 0..1. Needs a real engine context (buildPokemon/generateTraits
// read the vendored gamemaster and rankings), so this runs against initEngine
// like test/engine.test.js.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initEngine, buildPokemon } from '../src/engine/harness.js';
import { createSimilarity, similarityKey } from '../src/engine/similarity.js';

describe('similarity', () => {
  let ctx;
  before(async () => {
    ctx = await initEngine({ cp: 1500 });
  });

  test('same species (and shadow vs base of the same species) scores 1', () => {
    const similarity = createSimilarity();
    const gatr = buildPokemon(ctx, { speciesId: 'feraligatr', ivs: { atk: 15, def: 15, hp: 15 } });
    const gatrAgain = buildPokemon(ctx, { speciesId: 'feraligatr', ivs: { atk: 15, def: 15, hp: 15 } });
    const gatrShadow = buildPokemon(ctx, { speciesId: 'feraligatr_shadow', ivs: { atk: 15, def: 15, hp: 15 } });
    assert.equal(similarity(gatr, gatrAgain), 1);
    assert.equal(similarity(gatr, gatrShadow), 1);
  });

  test('unrelated species (no shared type, move, or trait) scores low', () => {
    const similarity = createSimilarity();
    const gatr = buildPokemon(ctx, { speciesId: 'feraligatr', ivs: { atk: 15, def: 15, hp: 15 } });
    const sab = buildPokemon(ctx, { speciesId: 'sableye', ivs: { atk: 15, def: 15, hp: 15 } });
    assert.ok(similarity(gatr, sab) < 0.5, `expected < 0.5, got ${similarity(gatr, sab)}`);
  });

  test('score is symmetric', () => {
    const similarity = createSimilarity();
    const gatr = buildPokemon(ctx, { speciesId: 'feraligatr', ivs: { atk: 15, def: 15, hp: 15 } });
    const empo = buildPokemon(ctx, { speciesId: 'empoleon', ivs: { atk: 15, def: 15, hp: 15 } });
    assert.equal(similarity(gatr, empo), similarity(empo, gatr));
  });

  test('score stays within [0, 1] and never negative even for the same-species short-circuit', () => {
    const similarity = createSimilarity();
    const gatr = buildPokemon(ctx, { speciesId: 'feraligatr', ivs: { atk: 15, def: 15, hp: 15 } });
    const empo = buildPokemon(ctx, { speciesId: 'empoleon', ivs: { atk: 15, def: 15, hp: 15 } });
    const v = similarity(gatr, empo);
    assert.ok(v >= 0 && v <= 1);
  });

  test('missing calculateSimilarity scores 0 instead of throwing', () => {
    const similarity = createSimilarity();
    const gatr = buildPokemon(ctx, { speciesId: 'feraligatr', ivs: { atk: 15, def: 15, hp: 15 } });
    assert.equal(similarity(gatr, { speciesId: 'fake' }), 0);
    assert.equal(similarity(undefined, gatr), 0);
  });

  test('similarityKey distinguishes species, shadow status, and moveset', () => {
    const gatr = buildPokemon(ctx, { speciesId: 'feraligatr', ivs: { atk: 15, def: 15, hp: 15 } });
    const gatrShadow = buildPokemon(ctx, { speciesId: 'feraligatr_shadow', ivs: { atk: 15, def: 15, hp: 15 } });
    assert.notEqual(similarityKey(gatr), similarityKey(gatrShadow));
  });
});
