// JavaScript Document
//
// Verifies src/teams/index.js -- the 3v3 team evaluator + ranking. The
// combinatorics (buildCandidates: topK, dup-species rule, excludeSpecies) are
// checked purely against a hand-built fake matrix with no engine. The ranking
// itself is checked with tiny pools through the REAL pvpoke 3v3 engine
// (battleTeams): a known-dominant team must rank first, and results must be
// deterministic. No battle math is exercised here directly. Kept small on
// purpose (4 candidates x <=2 meta teams).
//
// Run with: node --test test/teams.test.js

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initEngine } from '../src/engine/harness.js';
import { initTeamBattle } from '../src/engine/teamBattle.js';
import { scoreCollection } from '../src/scoring/index.js';
import { loadMetaTeams } from '../src/meta/teams.js';
import { buildCandidates, evaluateTeams } from '../src/teams/index.js';

const RANK1_IVS = { atk: 0, def: 15, hp: 15 };

// Tiny stable Great League meta subset (real great.json movesets) for scoring.
const TEST_META = [
  { speciesId: 'registeel', fastMove: 'LOCK_ON', chargedMoves: ['FOCUS_BLAST', 'FLASH_CANNON'] },
  { speciesId: 'medicham', fastMove: 'COUNTER', chargedMoves: ['POWER_UP_PUNCH', 'ICE_PUNCH'] },
];

let ctx;

before(async () => {
  ctx = await initEngine();
  initTeamBattle(ctx);
});

// --- Pure combinatorics (no engine) ---------------------------------------
describe('buildCandidates', () => {
  // A fake matrix: ratings drive computeWeightedScore, builtMons carries the
  // species per key. Scores: azumarill#1 > registeel#2 > altaria#3 >
  // azumarill#4 (dup species) > magikarp#5.
  const fakeMatrix = {
    ratings: {
      'azumarill#1': { m: { s00: 900, s11: 900, s22: 900 } },
      'registeel#2': { m: { s00: 800, s11: 800, s22: 800 } },
      'altaria#3': { m: { s00: 700, s11: 700, s22: 700 } },
      'azumarill#4': { m: { s00: 600, s11: 600, s22: 600 } },
      'magikarp#5': { m: { s00: 100, s11: 100, s22: 100 } },
    },
    builtMons: {
      'azumarill#1': { speciesId: 'azumarill', name: 'Azumarill', pokemon: {} },
      'registeel#2': { speciesId: 'registeel', name: 'Registeel', pokemon: {} },
      'altaria#3': { speciesId: 'altaria', name: 'Altaria', pokemon: {} },
      'azumarill#4': { speciesId: 'azumarill', name: 'Azumarill', pokemon: {} },
      'magikarp#5': { speciesId: 'magikarp', name: 'Magikarp', pokemon: {} },
    },
  };

  test('topK caps the mon pool by weighted score', () => {
    const cands = buildCandidates(fakeMatrix, { topK: 3 });
    // Top 3 by score = azumarill#1, registeel#2, altaria#3 -> exactly 1 team.
    assert.equal(cands.length, 1);
    assert.deepEqual(cands[0].sort(), ['altaria#3', 'azumarill#1', 'registeel#2']);
  });

  test('never puts two of the same species on one team', () => {
    // topK 5 includes both azumarill#1 and azumarill#4; no candidate may hold both.
    const cands = buildCandidates(fakeMatrix, { topK: 5 });
    for (const team of cands) {
      const species = team.map((k) => fakeMatrix.builtMons[k].speciesId);
      assert.equal(new Set(species).size, species.length, `dup species in ${team}`);
    }
    // And at least one candidate uses each azumarill instance individually.
    assert.ok(cands.some((t) => t.includes('azumarill#1')));
    assert.ok(cands.some((t) => t.includes('azumarill#4')));
  });

  test('excludeSpecies removes a species from every candidate', () => {
    const cands = buildCandidates(fakeMatrix, { topK: 5, excludeSpecies: ['azumarill'] });
    for (const team of cands) {
      for (const key of team) {
        assert.notEqual(fakeMatrix.builtMons[key].speciesId, 'azumarill');
      }
    }
    // Remaining distinct species: registeel, altaria, magikarp -> exactly 1 team.
    assert.equal(cands.length, 1);
  });

  test('is deterministic across repeated calls', () => {
    assert.deepEqual(buildCandidates(fakeMatrix, { topK: 5 }), buildCandidates(fakeMatrix, { topK: 5 }));
  });
});

// --- Ranking through the real 3v3 engine ----------------------------------
describe('evaluateTeams', () => {
  const collection = [
    { speciesId: 'azumarill', name: 'Azumarill', ivs: RANK1_IVS, shadow: false, sourceRow: 1 },
    { speciesId: 'registeel', name: 'Registeel', ivs: RANK1_IVS, shadow: false, sourceRow: 2 },
    { speciesId: 'altaria', name: 'Altaria', ivs: RANK1_IVS, shadow: false, sourceRow: 3 },
    { speciesId: 'magikarp', name: 'Magikarp', ivs: { atk: 15, def: 15, hp: 15 }, shadow: false, sourceRow: 4 },
  ];

  test('a team of strong staples ranks above every team carrying a joke mon', () => {
    const matrix = scoreCollection(ctx, collection, { groupEntries: TEST_META });
    const metaTeams = loadMetaTeams(ctx, { limit: 2 });
    assert.equal(metaTeams.length, 2);

    // C(4,3) = exactly 4 candidates, all distinct species.
    const ranked = evaluateTeams(ctx, { matrix, metaTeams, opts: { topK: 4 } });
    assert.equal(ranked.length, 4);

    const top = ranked[0];
    assert.deepEqual(
      top.members.map((m) => m.speciesId).sort(),
      ['altaria', 'azumarill', 'registeel'],
      'the all-staples team should rank first'
    );
    // The magikarp teams should all sit below it.
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(
        ranked[i].members.some((m) => m.speciesId === 'magikarp'),
        'every lower-ranked team carries the joke mon'
      );
      assert.ok(top.winRate >= ranked[i].winRate, 'top team win rate is highest');
    }
  });

  test('result objects are well-formed', () => {
    const matrix = scoreCollection(ctx, collection, { groupEntries: TEST_META });
    const metaTeams = loadMetaTeams(ctx, { limit: 2 });
    const ranked = evaluateTeams(ctx, { matrix, metaTeams, opts: { topK: 4 } });

    for (const t of ranked) {
      assert.equal(t.members.length, 3);
      assert.ok(t.winRate >= 0 && t.winRate <= 1, 'winRate in 0..1');
      assert.equal(typeof t.avgHpMargin, 'number');
      assert.equal(t.perMeta.length, metaTeams.length);
      for (const pm of t.perMeta) {
        assert.equal(pm.wins + pm.losses + pm.ties, 9, 'all 9 lead pairings accounted for');
        assert.ok(pm.winRate >= 0 && pm.winRate <= 1);
      }
      assert.ok([0, 1, 2].includes(t.bestLead.index));
      assert.equal(t.bestLead.key, t.members[t.bestLead.index].key);
      assert.ok(t.hardestTeams.length >= 1 && t.hardestTeams.length <= 3);
    }
    // Sorted best-first.
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(ranked[i - 1].winRate >= ranked[i].winRate);
    }
  });

  test('excludeSpecies keeps a species out of every candidate', () => {
    const matrix = scoreCollection(ctx, collection, { groupEntries: TEST_META });
    const metaTeams = loadMetaTeams(ctx, { limit: 1 });
    const ranked = evaluateTeams(ctx, {
      matrix,
      metaTeams,
      opts: { topK: 4, excludeSpecies: ['magikarp'] },
    });
    // Without magikarp only one distinct-species trio remains.
    assert.equal(ranked.length, 1);
    for (const m of ranked[0].members) assert.notEqual(m.speciesId, 'magikarp');
  });

  test('is deterministic (same ranking + win rates on a repeat run)', () => {
    const matrix = scoreCollection(ctx, collection, { groupEntries: TEST_META });
    const metaTeams = loadMetaTeams(ctx, { limit: 1 });
    const a = evaluateTeams(ctx, { matrix, metaTeams, opts: { topK: 4 } });
    const b = evaluateTeams(ctx, { matrix, metaTeams, opts: { topK: 4 } });
    assert.deepEqual(
      a.map((t) => [t.members.map((m) => m.key).join('+'), t.winRate, t.avgHpMargin]),
      b.map((t) => [t.members.map((m) => m.key).join('+'), t.winRate, t.avgHpMargin])
    );
  });

  test('teamCount caps how many ranked teams are returned', () => {
    const matrix = scoreCollection(ctx, collection, { groupEntries: TEST_META });
    const metaTeams = loadMetaTeams(ctx, { limit: 1 });
    const ranked = evaluateTeams(ctx, { matrix, metaTeams, opts: { topK: 4, teamCount: 2 } });
    assert.equal(ranked.length, 2);
  });
});
