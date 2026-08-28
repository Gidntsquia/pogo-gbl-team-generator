// Tests for scripts/build-shared-collection.mjs.
//
// Two layers, both engine-free (no initEngine/scoreCollection call -- the
// engine boot happens only when the script is run for real, exercised by
// hand against the real collections, not here):
//
//   1. The pure selection logic (bestPerBaseSpecies/selectSharedCollection/
//      sourceRowFromLineageKey) against a tiny hand-built fixture matrix --
//      no importer, no CSV.
//   2. CSV emission + round-trip (toGenericRow/toGenericCsv +
//      importCollection) -- the importer has no engine dependency, so this
//      exercises the exact format the script writes without booting pvpoke.
//
// Run with: node --test test/buildSharedCollection.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  sourceRowFromLineageKey,
  bestPerBaseSpecies,
  selectSharedCollection,
  toGenericRow,
  toGenericCsv,
} from '../scripts/build-shared-collection.mjs';
import { importCollection } from '../src/importer/index.js';

function writeTempCsv(content) {
  const dir = mkdtempSync(path.join(tmpdir(), 'build-shared-collection-test-'));
  const file = path.join(dir, 'out.csv');
  writeFileSync(file, content, 'utf8');
  return file;
}

// -------------------------------------------------- sourceRowFromLineageKey

test('sourceRowFromLineageKey: parses "row<N>", null otherwise', () => {
  assert.equal(sourceRowFromLineageKey('row42'), 42);
  assert.equal(sourceRowFromLineageKey('row1'), 1);
  assert.equal(sourceRowFromLineageKey('species:pikachu'), null);
  assert.equal(sourceRowFromLineageKey(undefined), null);
  assert.equal(sourceRowFromLineageKey(''), null);
});

// -------------------------------------------------------- bestPerBaseSpecies

test('bestPerBaseSpecies: collapses a base/shadow pair to the higher-scoring entry', () => {
  const entries = [
    { key: 'registeel#1', speciesId: 'registeel', score: 700 },
    { key: 'registeel_shadow#2', speciesId: 'registeel_shadow', score: 750 },
    { key: 'medicham#3', speciesId: 'medicham', score: 600 },
  ];
  const best = bestPerBaseSpecies(entries);
  assert.deepEqual([...best.keys()].sort(), ['medicham', 'registeel']);
  assert.equal(best.get('registeel').key, 'registeel_shadow#2');
  assert.equal(best.get('registeel').score, 750);
});

test('bestPerBaseSpecies: ties favor the lexicographically-lower key', () => {
  const entries = [
    { key: 'b#2', speciesId: 'gligar', score: 500 },
    { key: 'a#1', speciesId: 'gligar', score: 500 },
  ];
  const best = bestPerBaseSpecies(entries);
  assert.equal(best.get('gligar').key, 'a#1');
});

// ---------------------------------------------------- selectSharedCollection

test('selectSharedCollection: intersects base species and keeps the weaker of each collection\'s best', () => {
  const entriesA = [
    { key: 'registeel#1', speciesId: 'registeel', score: 700, lineageKey: 'row1' }, // shared, A weaker
    { key: 'medicham#2', speciesId: 'medicham', score: 650, lineageKey: 'row2' }, // shared, B weaker
    { key: 'azumarill#3', speciesId: 'azumarill', score: 720, lineageKey: 'row3' }, // A-only
    { key: 'gligar#4', speciesId: 'gligar', score: 500, lineageKey: 'row4' }, // tie
  ];
  const entriesB = [
    { key: 'registeel#10', speciesId: 'registeel', score: 780, lineageKey: 'row10' },
    { key: 'medicham#11', speciesId: 'medicham', score: 600, lineageKey: 'row11' },
    { key: 'trevenant#12', speciesId: 'trevenant', score: 500, lineageKey: 'row12' }, // B-only
    { key: 'gligar#13', speciesId: 'gligar', score: 500, lineageKey: 'row13' }, // tie
  ];

  const shared = selectSharedCollection(entriesA, entriesB);

  assert.deepEqual(
    shared.map((s) => s.baseSpeciesId),
    ['gligar', 'medicham', 'registeel'] // sorted, azumarill/trevenant excluded
  );

  const registeel = shared.find((s) => s.baseSpeciesId === 'registeel');
  assert.equal(registeel.chosenSide, 'A'); // 700 < 780
  assert.equal(registeel.scoreA, 700);
  assert.equal(registeel.scoreB, 780);
  assert.equal(registeel.chosen.key, 'registeel#1');

  const medicham = shared.find((s) => s.baseSpeciesId === 'medicham');
  assert.equal(medicham.chosenSide, 'B'); // 600 < 650
  assert.equal(medicham.chosen.key, 'medicham#11');

  const gligar = shared.find((s) => s.baseSpeciesId === 'gligar');
  assert.equal(gligar.chosenSide, 'A'); // tie favors A
});

test('selectSharedCollection: no overlap -> empty result', () => {
  const entriesA = [{ key: 'a#1', speciesId: 'azumarill', score: 700, lineageKey: 'row1' }];
  const entriesB = [{ key: 'b#1', speciesId: 'medicham', score: 600, lineageKey: 'row1' }];
  assert.deepEqual(selectSharedCollection(entriesA, entriesB), []);
});

// --------------------------------------------------------- CSV emission --

test('toGenericRow: emits every field the generic importer format supports', () => {
  const row = toGenericRow({
    name: 'Registeel',
    ivs: { atk: 0, def: 15, hp: 14 },
    shadow: false,
    purified: false,
    lucky: true,
    bestBuddy: false,
    level: 20,
    cp: 1428,
  });
  assert.equal(row, 'Registeel,0,15,14,,,1,,20,1428');
});

test('toGenericRow: blank level/cp when absent, all flags on', () => {
  const row = toGenericRow({
    name: 'Umbreon',
    ivs: { atk: 3, def: 15, hp: 15 },
    shadow: true,
    purified: true,
    lucky: true,
    bestBuddy: true,
  });
  assert.equal(row, 'Umbreon,3,15,15,1,1,1,1,,');
});

test('toGenericCsv + importCollection: round-trips speciesId/IVs/level/flags', () => {
  const mons = [
    { name: 'Registeel', ivs: { atk: 0, def: 15, hp: 14 }, shadow: false, purified: false, lucky: true, bestBuddy: false, level: 20, cp: 1428 },
    { name: 'Umbreon', ivs: { atk: 3, def: 15, hp: 15 }, shadow: true, purified: false, lucky: false, bestBuddy: false, level: 24, cp: 1497 },
    { name: 'Stunfisk (Galarian)', ivs: { atk: 1, def: 14, hp: 15 }, shadow: false, purified: true, lucky: false, bestBuddy: false },
  ];

  const csv = toGenericCsv(mons);
  const file = writeTempCsv(csv);
  const { mons: reimported, warnings } = importCollection(file);

  assert.deepEqual(warnings, []);
  assert.equal(reimported.length, mons.length);

  for (let i = 0; i < mons.length; i++) {
    const exp = mons[i];
    const got = reimported[i];
    assert.deepEqual(got.ivs, exp.ivs, `${exp.name}: ivs`);
    assert.equal(got.level ?? null, exp.level ?? null, `${exp.name}: level`);
    assert.equal(!!got.shadow, !!exp.shadow, `${exp.name}: shadow`);
    assert.equal(!!got.purified, !!exp.purified, `${exp.name}: purified`);
    assert.equal(!!got.lucky, !!exp.lucky, `${exp.name}: lucky`);
  }

  // Species actually resolved (not skipped) -- speciesId is stable across a
  // round-trip through the SAME resolver, whatever it is.
  assert.ok(reimported.every((m) => typeof m.speciesId === 'string' && m.speciesId.length > 0));
});
