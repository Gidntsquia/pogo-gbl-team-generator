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
import { loadMetaTeams, loadCommunityTeams, CURATED_TIER_WEIGHTS, curatedTierWeight } from '../src/meta/teams.js';

const ctx = await initEngine();
const COMMUNITY_FILE = 'data/meta-teams-community.json';
const communityRaw = JSON.parse(readFileSync(COMMUNITY_FILE, 'utf8'));

test('loads the curated Great League meta teams (>=8, all 3v3)', () => {
  // Vendor-preset-specific invariants (species-joined id/name format) --
  // scoped to includeCommunity: false since the community teams carry
  // their own human-authored names/ids instead (see the community tests below).
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

// Community-curated opponent teams (data/meta-teams-community.json).

test('community file loads and its teams resolve fully battle-ready (>=84 of 87)', () => {
  // 2026-08-26 (Jaxon): the 12 JP Nature Cup + 3 JP player-party teams and all 3
  // Mimikyu teams were deleted (Mimikyu is banned in Competitor's Cup, the GL
  // format he plays), and 17 teams he fought on ladder that day were added.
  // 58 - 18 + 17 = 57. Later that day 25 more went in: 2 Jaxon ladder teams
  // (jaxon-ladder-13/14), 2 PvPoke top-performer teams (pvpoke-top-*), and 21
  // high-ladder teams (high-ladder-*). 57 + 25 = 82. Later still, 5 more
  // ladder teams (jaxon-ladder-15..19). 82 + 5 = 87.
  assert.equal(communityRaw.teams.length, 87, 'source file has 87 entries under the pinned data (57, plus 7 Jaxon ladder + 2 PvPoke top-performer + 21 high-ladder teams)');

  const teams = loadCommunityTeams(ctx);
  assert.ok(
    teams.length >= 84,
    `expected >=84/87 community teams to resolve (the JP ids that used to fail here, e.g. arctibax, went out with the JP-cup teams), got ${teams.length}`
  );
  for (const team of teams) {
    assert.ok(team.id.startsWith('community:'), `${team.id} should be namespaced`);
    assert.equal(team.members.length, 3);
    assert.ok(Object.keys(CURATED_TIER_WEIGHTS).includes(team.tier), `${team.id} tier ${team.tier}`);
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

test('loadMetaTeams merges vendor presets with community teams, lightest tier ordered last', () => {
  const merged = loadMetaTeams(ctx);
  const vendorOnly = loadMetaTeams(ctx, { includeCommunity: false });
  assert.ok(merged.length > vendorOnly.length, 'merged pool is bigger than vendor-only');

  const community = merged.filter((t) => t.id.startsWith('community:'));
  assert.ok(community.length > 0, 'merged pool includes namespaced community teams');

  // Community teams sort by descending draw weight, so a small `limit` reaches
  // the teams most like real opponents first (see loadMetaTeams' doc comment).
  const weights = community.map(curatedTierWeight);
  assert.deepEqual(
    weights,
    [...weights].sort((a, b) => b - a),
    'community teams are ordered heaviest tier first'
  );
  assert.ok(new Set(weights).size > 1, 'the pinned data actually exercises more than one tier');
});

test('curatedTierWeight grades ladder-observed above recommended above off-meta', () => {
  assert.ok(CURATED_TIER_WEIGHTS.meta > CURATED_TIER_WEIGHTS.recommended);
  assert.ok(CURATED_TIER_WEIGHTS.recommended > CURATED_TIER_WEIGHTS['off-meta']);
  assert.ok(CURATED_TIER_WEIGHTS['off-meta'] > 0, 'a reduced tier still gets drawn sometimes');
  // An untagged team (a caller-supplied fixture, or a vendor preset) is full weight.
  assert.equal(curatedTierWeight({}), CURATED_TIER_WEIGHTS.meta);
  assert.equal(curatedTierWeight({ tier: 'nonsense' }), CURATED_TIER_WEIGHTS.meta);
});

test('a small limit on loadMetaTeams stays within the vendor pool (documented off-meta cap)', () => {
  const small = loadMetaTeams(ctx, { limit: 5 });
  assert.equal(small.length, 5);
  assert.ok(
    small.every((t) => !t.id.startsWith('community:')),
    'a small limit should not reach into the community teams appended after the 25 vendor presets'
  );
});

// Jaxon's 7 real-ladder opponent teams + the file-wide
// "members[0] is the established lead" doctrine.

test('every community team is stamped leadIndex: 0 (declared-lead doctrine)', () => {
  const teams = loadCommunityTeams(ctx);
  assert.ok(teams.length > 0);
  for (const team of teams) {
    assert.equal(team.leadIndex, 0, `${team.id} should carry leadIndex: 0`);
  }
});

// Every id-prefixed batch of Jaxon-supplied opponents is untagged/full-weight
// and must resolve whole -- one parameterized test over the batches, not one
// test each.
const JAXON_BATCHES = [
  ['jaxon-ladder-', 19],
  ['jet-ladder-', 17],
  ['pvpoke-top-', 2],
  ['high-ladder-', 21],
];

test('every Jaxon-supplied batch resolves fully battle-ready at full weight', () => {
  const teams = loadCommunityTeams(ctx);
  for (const [prefix, expected] of JAXON_BATCHES) {
    const batch = teams.filter((t) => t.id.startsWith(`community:${prefix}`));
    assert.equal(batch.length, expected, `expected all ${expected} ${prefix}* teams to resolve, got ${batch.length}`);
    for (const team of batch) {
      assert.equal(team.members.length, 3);
      assert.equal(team.tier, 'meta', `${team.id} should be untagged/full-weight (real ladder opponents)`);
      assert.equal(team.leadIndex, 0);
    }
  }
});

test('a jaxon-ladder team and a legacy community team both battle with members[0] as lead', () => {
  const teams = loadCommunityTeams(ctx);
  const ladderTeam = teams.find((t) => t.id === 'community:jaxon-ladder-1');
  const legacyTeam = teams.find((t) => t.id === 'community:omarchm10');
  assert.ok(ladderTeam, 'jaxon-ladder-1 should resolve');
  assert.ok(legacyTeam, 'the legacy omarchm10 team should still resolve');

  const result = battleTeams(ctx, {
    teamA: ladderTeam.members.map((m) => m.pokemon),
    teamB: legacyTeam.members.map((m) => m.pokemon),
    leadA: ladderTeam.leadIndex,
    leadB: legacyTeam.leadIndex,
  });
  assert.ok(['a', 'b', 'tie'].includes(result.winner));
  assert.equal(typeof result.summary.turns, 'number');
  assert.ok(result.summary.turns > 0, 'a real battle ran (>0 turns) with both teams led by members[0]');
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

// Member-level move overrides (a community member given as an object rather
// than a bare speciesId) -- see CommunityMember in src/meta/teams.js.

const OVERRIDE_CASES = [
  {
    what: 'a fast-move-only override leaves the recommended charged moves alone',
    member: { speciesId: 'empoleon', fastMove: 'WATERFALL' },
    fastMove: 'WATERFALL',
    chargedMoves: ['HYDRO_CANNON', 'DRILL_PECK'],
  },
  {
    what: 'a charged-moves-only override leaves the recommended fast move alone',
    member: { speciesId: 'florges', chargedMoves: ['CHILLING_WATER', 'TRAILBLAZE'] },
    fastMove: 'FAIRY_WIND',
    chargedMoves: ['CHILLING_WATER', 'TRAILBLAZE'],
  },
  {
    what: 'a full override sets both halves, shadow member included',
    member: { speciesId: 'sableye_shadow', fastMove: 'SHADOW_CLAW', chargedMoves: ['POWER_GEM'] },
    fastMove: 'SHADOW_CLAW',
    chargedMoves: ['POWER_GEM'],
  },
];

test('a member object applies its explicit moveset, merging over pvpoke\'s recommendation', () => {
  for (const c of OVERRIDE_CASES) {
    const [team] = loadCommunityTeams(ctx, {
      communityEntries: [{ id: 'ovr', members: [c.member, 'azumarill', 'altaria'] }],
    });
    assert.ok(team, `${c.what}: team should resolve`);
    const [mon] = team.members;

    assert.equal(mon.pokemon.fastMove.moveId, c.fastMove, c.what);
    // Array.from: pvpoke runs in its own realm, so its arrays fail
    // deepStrictEqual's prototype check without being copied out first.
    assert.deepEqual(
      Array.from(mon.pokemon.chargedMoves).map((m) => m.moveId),
      c.chargedMoves,
      c.what
    );
    // The reported moveset must agree with the Pokemon actually built...
    assert.equal(mon.fastMove, c.fastMove);
    assert.deepEqual(mon.chargedMoves, c.chargedMoves);
    // ...and so must `spec`, which is what src/engine/parallelWorker.js rebuilds
    // from: without the moveset here, a threaded run would fight a DIFFERENT
    // opponent (pvpoke's recommended set) than a single-threaded one.
    assert.equal(mon.spec.fastMove, c.fastMove, `${c.what}: spec carries the moveset for the worker rebuild`);
    assert.deepEqual(mon.spec.chargedMoves, c.chargedMoves);
  }
});

test('an override that only restates pvpoke\'s recommendation leaves spec moveset-free', () => {
  // high-ladder-11's Shadow Alolan Sandslash is exactly this case. The built mon
  // is unchanged, so its spec stays free of an explicit moveset and shares a
  // worker build-cache entry with every other recommended build of the species.
  const [team] = loadCommunityTeams(ctx, {
    communityEntries: [
      {
        id: 'restated',
        members: [
          { speciesId: 'sandslash_alolan_shadow', fastMove: 'POWDER_SNOW', chargedMoves: ['ICE_PUNCH', 'DRILL_RUN'] },
          'azumarill',
          'altaria',
        ],
      },
    ],
  });
  const [mon] = team.members;
  assert.equal(mon.fastMove, 'POWDER_SNOW');
  assert.deepEqual(mon.chargedMoves, ['ICE_PUNCH', 'DRILL_RUN']);
  assert.equal(mon.spec.fastMove, undefined, 'no explicit moveset needed in the spec');
  assert.equal(mon.spec.chargedMoves, undefined);
});

test('an unlearnable move in an override warns and falls back, keeping the team', () => {
  // pvpoke's Pokemon#selectMove ADDS an unrecognized move id to the movepool
  // rather than rejecting it, so this fallback is what stops a typo from
  // producing an opponent carrying a move the species cannot learn.
  const [team] = loadCommunityTeams(ctx, {
    communityEntries: [
      {
        id: 'bad-moves',
        members: [{ speciesId: 'azumarill', fastMove: 'BLAST_BURN', chargedMoves: ['NOT_A_MOVE'] }, 'altaria', 'stunfisk'],
      },
    ],
  });
  assert.ok(team, 'a bad MOVE degrades to the recommendation; only a bad speciesId drops the team');
  const [mon] = team.members;
  const recommended = loadCommunityTeams(ctx, {
    communityEntries: [{ id: 'plain', members: ['azumarill', 'altaria', 'stunfisk'] }],
  })[0].members[0];
  assert.equal(mon.fastMove, recommended.fastMove, 'unlearnable fast move falls back to the recommendation');
  assert.deepEqual(mon.chargedMoves, recommended.chargedMoves, 'unlearnable charged move falls back too');
  assert.equal(mon.spec.fastMove, undefined, 'nothing applied, so nothing to reapply worker-side');
});

test('a member object with no speciesId drops its team, like an unknown id', () => {
  const teams = loadCommunityTeams(ctx, {
    communityEntries: [
      { id: 'headless-member', members: [{ fastMove: 'WATERFALL' }, 'azumarill', 'altaria'] },
      { id: 'fine', members: ['azumarill', 'altaria', 'stunfisk'] },
    ],
  });
  assert.deepEqual(teams.map((t) => t.id), ['community:fine']);
});
