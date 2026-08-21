// Tests for src/meta/teams.js -- the curated Great League meta team pool.
//
// Verifies: loads the full pvpoke GO Battle League preset set (>=8 teams),
// every member is a battle-ready built pvpoke Pokemon (legal moves, CP<=1500,
// positive HP), ids/names are stable across reloads, `limit` caps the count,
// and a loaded team is actually usable as one side of battleTeams (real 3v3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { initEngine } from '../src/engine/harness.js';
import { battleTeams } from '../src/engine/teamBattle.js';
import { loadMetaTeams, loadCommunityTeams } from '../src/meta/teams.js';

const ctx = await initEngine();
const COMMUNITY_FILE = 'data/meta-teams-community.json';
const communityRaw = JSON.parse(readFileSync(COMMUNITY_FILE, 'utf8'));

test('loads the curated Great League meta teams (>=8, all 3v3)', () => {
  // Vendor-preset-specific invariants (species-joined id/name format) --
  // scoped to includeCommunity: false since T10b's community teams carry
  // their own human-authored names/ids instead (see the T10b tests below).
  const teams = loadMetaTeams(ctx, { includeCommunity: false });
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
  // Ids are unique within the pool (no accidental collapse of distinct teams).
  const ids = a.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'meta team ids are unique');
});

test('vendor preset ids match their members\' speciesIds (species-joined format)', () => {
  const teams = loadMetaTeams(ctx, { includeCommunity: false });
  for (const team of teams) {
    assert.equal(team.id, team.members.map((m) => m.speciesId).join('-'));
  }
});

test('limit caps how many teams are built', () => {
  const three = loadMetaTeams(ctx, { limit: 3 });
  assert.equal(three.length, 3);
  const full = loadMetaTeams(ctx);
  // limit slices the head, preserving source order.
  assert.deepEqual(three.map((t) => t.id), full.slice(0, 3).map((t) => t.id));
});

// GOALS T10b: community-curated opponent teams (data/meta-teams-community.json).

test('community file loads and its teams resolve fully battle-ready (>=26 of 33)', () => {
  assert.equal(communityRaw.teams.length, 33, 'source file has 33 entries under the pinned data');

  const teams = loadCommunityTeams(ctx);
  assert.ok(
    teams.length >= 26,
    `expected >=26/33 community teams to resolve (a few JP ids like arctibax may legitimately be absent from the pinned gamemaster), got ${teams.length}`
  );
  for (const team of teams) {
    assert.ok(team.id.startsWith('community:'), `${team.id} should be namespaced`);
    assert.equal(team.members.length, 3);
    assert.ok(['meta', 'off-meta'].includes(team.tier));
    for (const m of team.members) {
      const p = m.pokemon;
      assert.ok(p.fastMove && p.fastMove.moveId, `${m.speciesId} has a fast move`);
      assert.ok(p.chargedMoves.length >= 1, `${m.speciesId} has a charged move`);
      assert.ok(p.cp <= 1500 && p.cp > 0, `${m.speciesId} cp ${p.cp} in (0,1500]`);
      assert.ok(p.stats.hp > 0, `${m.speciesId} has positive HP`);
    }
  }
});

test('off-meta tier is carried through from the source file', () => {
  const teams = loadCommunityTeams(ctx);
  const offMeta = teams.filter((t) => t.tier === 'off-meta');
  const meta = teams.filter((t) => t.tier === 'meta');
  assert.ok(offMeta.length > 0, 'at least one off-meta community team should resolve');
  assert.ok(meta.length > 0, 'at least one untagged (meta) community team should resolve');
});

test('community team ids are stable across reloads', () => {
  const a = loadCommunityTeams(ctx);
  const b = loadCommunityTeams(ctx);
  assert.deepEqual(
    a.map((t) => t.id),
    b.map((t) => t.id)
  );
  assert.equal(new Set(a.map((t) => t.id)).size, a.length, 'community team ids are unique');
});

test('a bogus speciesId in a temp-file copy drops that team with a warning, not a throw', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'community-teams-'));
  try {
    const badFile = path.join(dir, 'meta-teams-community.json');
    const tampered = {
      ...communityRaw,
      teams: [
        communityRaw.teams[0],
        { id: 'bogus-team', name: 'Bogus', members: ['azumarill', 'not_a_real_species_xyz', 'registeel'] },
      ],
    };
    writeFileSync(badFile, JSON.stringify(tampered));

    const realWrite = process.stderr.write;
    const warnings = [];
    process.stderr.write = (chunk) => {
      warnings.push(String(chunk));
      return true;
    };
    let teams;
    try {
      teams = loadCommunityTeams(ctx, { communityFile: badFile });
    } finally {
      process.stderr.write = realWrite;
    }

    assert.equal(teams.length, 1, 'the bogus team is dropped whole, the good one survives');
    assert.equal(teams[0].id, `community:${communityRaw.teams[0].id}`);
    assert.ok(
      warnings.some((w) => w.includes('bogus-team') && w.includes('not_a_real_species_xyz')),
      `expected a stderr warning naming the dropped team/species, got: ${warnings.join('')}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadMetaTeams merges vendor presets with community teams, off-meta ordered last', () => {
  const merged = loadMetaTeams(ctx);
  const vendorOnly = loadMetaTeams(ctx, { includeCommunity: false });
  assert.ok(merged.length > vendorOnly.length, 'merged pool is bigger than vendor-only');

  const communityIds = merged.filter((t) => t.id.startsWith('community:'));
  assert.ok(communityIds.length > 0, 'merged pool includes namespaced community teams');

  // off-meta community teams sort after every vendor + community-meta team.
  const firstOffMetaIdx = merged.findIndex((t) => t.tier === 'off-meta');
  const lastNonOffMetaIdx = merged.reduce(
    (max, t, i) => (t.tier !== 'off-meta' ? i : max),
    -1
  );
  assert.ok(firstOffMetaIdx > lastNonOffMetaIdx, 'off-meta teams are ordered after every other team');
});

test('a small limit on loadMetaTeams stays within the vendor pool (documented off-meta cap)', () => {
  const small = loadMetaTeams(ctx, { limit: 5 });
  assert.equal(small.length, 5);
  assert.ok(
    small.every((t) => !t.id.startsWith('community:')),
    'a small limit should not reach into the community teams appended after the 25 vendor presets'
  );
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
