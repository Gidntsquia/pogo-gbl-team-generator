// JavaScript Document
//
// src/evolution/index.js -- expanding a collection with the forms each mon
// could evolve into, and the lineage bookkeeping that keeps a team from
// fielding two forms of the same physical Pokemon.
//
// Evolution ids come from vendor/pvpoke's own gamemaster, so these tests boot
// a real engine context; the candy figures come from src/cost/evolutionCandy.json.

import test from 'node:test';
import assert from 'node:assert/strict';

import { initEngine } from '../src/engine/harness.js';
import { evolutionTargets, expandEvolutions, lineageKeyFor } from '../src/evolution/index.js';
import { dedupeBestPerSpecies } from '../src/teams/index.js';

const ctx = await initEngine();

function mon(overrides) {
  return {
    speciesId: 'phantump',
    name: 'Phantump',
    ivs: { atk: 15, def: 13, hp: 15 },
    cp: 636,
    level: 20,
    shadow: false,
    purified: false,
    lucky: false,
    bestBuddy: false,
    sourceRow: 9,
    ...overrides,
  };
}

test('evolutionTargets prices a one-step evolution from pvpoke family data', () => {
  const targets = evolutionTargets(ctx, 'phantump');
  assert.equal(targets.length, 1);
  assert.deepEqual(
    { id: targets[0].speciesId, steps: targets[0].steps, candy: targets[0].candy },
    { id: 'trevenant', steps: 1, candy: 200 }
  );
});

test('evolutionTargets walks a family transitively and accumulates candy', () => {
  const targets = evolutionTargets(ctx, 'timburr');
  const byId = new Map(targets.map((t) => [t.speciesId, t]));
  assert.deepEqual([...byId.keys()].sort(), ['conkeldurr', 'gurdurr']);
  assert.equal(byId.get('gurdurr').candy, 50);
  assert.equal(byId.get('conkeldurr').steps, 2);
  assert.equal(byId.get('conkeldurr').candy, 250, '50 to Gurdurr + 200 to Conkeldurr');
});

test('evolutionTargets reports the item an evolution needs', () => {
  const scizor = evolutionTargets(ctx, 'scyther').find((t) => t.speciesId === 'scizor');
  assert.deepEqual(scizor.items, ['Metal Coat']);
});

test('evolutionTargets covers every branch of a branching family', () => {
  const ids = evolutionTargets(ctx, 'eevee').map((t) => t.speciesId).sort();
  assert.deepEqual(ids, [
    'espeon', 'flareon', 'glaceon', 'jolteon', 'leafeon', 'sylveon', 'umbreon', 'vaporeon',
  ]);
});

test('a fully-evolved Pokemon has nowhere to go', () => {
  assert.deepEqual(evolutionTargets(ctx, 'conkeldurr'), []);
  assert.deepEqual(evolutionTargets(ctx, 'stunfisk'), []);
});

test('shadow costs 20% more candy to evolve; purified uses the published figure', () => {
  const plain = evolutionTargets(ctx, 'phantump')[0].candy;
  const shadow = evolutionTargets(ctx, 'phantump', { shadow: true })[0].candy;
  const purified = evolutionTargets(ctx, 'phantump', { purified: true })[0].candy;
  assert.equal(plain, 200);
  assert.equal(shadow, Math.ceil(200 * 1.2));
  assert.equal(purified, 180);
});

test('expandEvolutions carries IVs, level and flags onto the evolved form', () => {
  const { mons } = expandEvolutions(ctx, [mon({ shadow: true, lucky: true, bestBuddy: true })]);
  assert.equal(mons.length, 2);
  const [original, evolved] = mons;
  assert.equal(original.speciesId, 'phantump');
  assert.equal(evolved.speciesId, 'trevenant');
  assert.equal(evolved.name, 'Trevenant');
  assert.deepEqual(evolved.ivs, original.ivs, 'evolving preserves IVs');
  assert.equal(evolved.level, 20);
  assert.equal(evolved.shadow, true);
  assert.equal(evolved.lucky, true);
  assert.equal(evolved.bestBuddy, true);
  assert.equal(evolved.sourceRow, 9);
});

test('expandEvolutions drops the CP and moveset the evolved form invalidates', () => {
  const { mons, warnings } = expandEvolutions(ctx, [
    mon({ moves: { fastMove: 'SHADOW_CLAW', chargedMoves: ['SEED_BOMB'] } }),
  ]);
  const evolved = mons[1];
  assert.equal(evolved.cp, undefined, 'the CSV CP belongs to the unevolved form');
  assert.equal(evolved.moves, undefined, 'the evolved form has a different movepool');
  assert.ok(
    warnings.some((w) => /different movepool/.test(w)),
    'says so rather than silently dropping the moveset'
  );
});

test('every form of one physical Pokemon shares a lineage key', () => {
  const { mons } = expandEvolutions(ctx, [mon()]);
  assert.equal(mons[0].lineageKey, mons[1].lineageKey);
  assert.equal(mons[0].lineageKey, lineageKeyFor(mon()));
});

test('two copies of the same species are different lineages', () => {
  const { mons } = expandEvolutions(ctx, [
    mon({ sourceRow: 1 }),
    mon({ sourceRow: 2 }),
  ]);
  const lineages = new Set(mons.map((m) => m.lineageKey));
  assert.equal(lineages.size, 2);
  assert.equal(mons.length, 4);
});

test('the evolved variant records what it costs to get there', () => {
  const { mons } = expandEvolutions(ctx, [mon()]);
  assert.deepEqual(mons[1].evolution, {
    fromSpeciesId: 'phantump',
    fromName: 'Phantump',
    steps: 1,
    candy: 200,
    items: [],
    buddyKm: null,
  });
});

test('dedupeBestPerSpecies keeps only the best-scoring form of one Pokemon', () => {
  // Hand-built matrix: one physical mon, scored as both of its forms. No
  // engine involved -- dedupe only reads ratings + builtMons.
  const rating = (s11) => ({ metaA: { s00: s11, s11, s22: s11 } });
  const matrix = {
    ratings: {
      'phantump#9': rating(300),
      'trevenant#9': rating(800),
      'stunfisk#12': rating(700),
    },
    builtMons: {
      'phantump#9': { speciesId: 'phantump', name: 'Phantump', lineageKey: 'row9' },
      'trevenant#9': { speciesId: 'trevenant', name: 'Trevenant', lineageKey: 'row9' },
      'stunfisk#12': { speciesId: 'stunfisk', name: 'Stunfisk', lineageKey: 'row12' },
    },
  };
  const kept = Object.keys(dedupeBestPerSpecies(matrix).ratings).sort();
  assert.deepEqual(kept, ['stunfisk#12', 'trevenant#9'], 'the Phantump form loses to its own evolution');
});

test('dedupeBestPerSpecies still collapses two different mons of one species', () => {
  const rating = (s11) => ({ metaA: { s00: s11, s11, s22: s11 } });
  const matrix = {
    ratings: { 'trevenant#1': rating(600), 'trevenant#2': rating(900) },
    builtMons: {
      'trevenant#1': { speciesId: 'trevenant', name: 'Trevenant', lineageKey: 'row1' },
      'trevenant#2': { speciesId: 'trevenant', name: 'Trevenant', lineageKey: 'row2' },
    },
  };
  assert.deepEqual(Object.keys(dedupeBestPerSpecies(matrix).ratings), ['trevenant#2']);
});
