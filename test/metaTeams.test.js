// Tests for src/meta/teams.js -- the curated Great League meta team pool.
//
// Verifies: loads the full pvpoke GO Battle League preset set (>=8 teams),
// every member is a battle-ready built pvpoke Pokemon (legal moves, CP<=1500,
// positive HP), ids/names are stable across reloads, `limit` caps the count,
// and a loaded team is actually usable as one side of battleTeams (real 3v3).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initEngine } from '../src/engine/harness.js';
import { battleTeams } from '../src/engine/teamBattle.js';
import { loadMetaTeams } from '../src/meta/teams.js';

const ctx = await initEngine();

test('loads the curated Great League meta teams (>=8, all 3v3)', () => {
  const teams = loadMetaTeams(ctx);
  assert.ok(teams.length >= 8, `expected >=8 meta teams, got ${teams.length}`);
  for (const team of teams) {
    assert.equal(team.members.length, 3, `${team.id} should have 3 members`);
    assert.equal(typeof team.id, 'string');
    assert.ok(team.id.length > 0);
    assert.equal(typeof team.name, 'string');
    assert.ok(team.name.includes('/'), `name should join members: ${team.name}`);
  }
});

test('every member is a battle-ready built pvpoke Pokemon', () => {
  const teams = loadMetaTeams(ctx, { limit: 6 });
  for (const team of teams) {
    for (const m of team.members) {
      const p = m.pokemon;
      // Real pvpoke Pokemon instance with the preset's moveset applied.
      assert.ok(p.fastMove && p.fastMove.moveId, `${m.speciesId} has a fast move`);
      assert.equal(p.fastMove.moveId, m.fastMove);
      assert.ok(p.chargedMoves.length >= 1, `${m.speciesId} has a charged move`);
      const chargedIds = Array.from(p.chargedMoves).map((c) => c.moveId);
      for (const c of m.chargedMoves) assert.ok(chargedIds.includes(c), `${c} applied`);
      // Legal Great League build: CP capped, positive stats/HP.
      assert.ok(p.cp <= 1500 && p.cp > 0, `${m.speciesId} cp ${p.cp} in (0,1500]`);
      assert.ok(p.stats.hp > 0, `${m.speciesId} has positive HP`);
      // Shadow flag round-trips through the "_shadow" suffix.
      assert.equal(p.shadowType === 'shadow', m.shadow);
    }
  }
});

test('ids and names are stable across reloads and match member speciesIds', () => {
  const a = loadMetaTeams(ctx);
  const b = loadMetaTeams(ctx);
  assert.deepEqual(
    a.map((t) => t.id),
    b.map((t) => t.id),
    'team ids are deterministic across loads'
  );
  assert.deepEqual(
    a.map((t) => t.name),
    b.map((t) => t.name),
    'team names are deterministic across loads'
  );
  for (const team of a) {
    assert.equal(team.id, team.members.map((m) => m.speciesId).join('-'));
  }
  // Ids are unique within the pool (no accidental collapse of distinct teams).
  const ids = a.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'meta team ids are unique');
});

test('limit caps how many teams are built', () => {
  const three = loadMetaTeams(ctx, { limit: 3 });
  assert.equal(three.length, 3);
  const full = loadMetaTeams(ctx);
  // limit slices the head, preserving source order.
  assert.deepEqual(three.map((t) => t.id), full.slice(0, 3).map((t) => t.id));
});

test('a loaded meta team is usable as a side of a real 3v3 battle', () => {
  const [teamX, teamY] = loadMetaTeams(ctx, { limit: 2 });
  const result = battleTeams(ctx, {
    teamA: teamX.members.map((m) => m.pokemon),
    teamB: teamY.members.map((m) => m.pokemon),
    leadA: 0,
    leadB: 0,
  });
  assert.ok(['a', 'b', 'tie'].includes(result.winner));
  assert.equal(typeof result.summary.turns, 'number');
  assert.ok(result.summary.turns > 0, 'a real battle ran (>0 turns)');
});
