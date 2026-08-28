// Tests for src/teams/evolve.js -- the GA core module (locked-lead
// representation). Pure generational logic
// over FAKE fitness arrays and a fake scoreCollection matrix (no engine
// boot, no vendor data, no battles) -- verifies: determinism under seed,
// deathRate honored exactly, mutation probability monotone in fitness
// percentile, member-swap mutants differ from their parent in exactly one
// slot and never duplicate a species, lead-rotation mutants swap the lead
// with a back and keep the same species-set, population stays unique
// (LEAD-AWARE identity: same species-set + different lead = different
// individual) + exactly at the target size with the immigrant floor
// respected, and excludeSpecies is honored end to end (initPopulation +
// nextGeneration). The convergence detector is asserted in test/e2e.test.js,
// against a generation history built from real battles.
//
// Also covers scripts/evolve.mjs's `--ban` (format-wide species ban) pure
// helpers -- no dedicated test file exists for that driver script (it has no
// other unit coverage; runEvolution itself is an integration path, not
// exercised here), so its few pure, battle-free helpers land in this file
// alongside the sibling GA module they support. No engine boot, no battles.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  initPopulation,
  nextGeneration,
  DEFAULT_IMMIGRANT_FRACTION,
} from '../src/teams/evolve.js';

import {
  expandBanToCandidateSpeciesIds,
  filterBannedCuratedTeams,
  filterBannedMovesetPool,
  renderEvolveReportHtml,
} from '../scripts/evolve.mjs';

/** A fake mon entry: uniform ratings so computeWeightedScore == score exactly. */
function mon(key, speciesId, score) {
  return {
    key,
    builtMon: { speciesId, name: speciesId },
    ratings: { somemeta: { s00: score, s11: score, s22: score } },
  };
}

/** Build a fake scoreCollection-shaped matrix from a list of mon() entries. */
function fakeMatrix(mons) {
  const ratings = {};
  const builtMons = {};
  for (const m of mons) {
    ratings[m.key] = m.ratings;
    builtMons[m.key] = m.builtMon;
  }
  return { ratings, builtMons };
}

function poolKeys(mons) {
  return mons.map((m) => m.key);
}

/** N distinct-species fake mons, scores spread out so the blend isn't flat. */
function makeMons(n) {
  const mons = [];
  for (let i = 0; i < n; i++) {
    mons.push(mon(`mon${i}`, `species${i}`, 1000 - i * 7));
  }
  return mons;
}

const WIDE_POOL_MONS = makeMons(40); // plenty of room: C(40,3) = 9880 possible teams
const WIDE_MATRIX = fakeMatrix(WIDE_POOL_MONS);
const WIDE_POOL = poolKeys(WIDE_POOL_MONS);

/** Lead-aware identity signature, mirroring src/teams/evolve.js's own. */
function teamSignature(team) {
  return `${team[0]}||${[...team.slice(1)].sort().join('|')}`;
}

function speciesOf(team) {
  return team.map((key) => WIDE_MATRIX.builtMons[key].speciesId);
}

/** A population of `count` unique teams sampled from the wide pool, seeded. */
function samplePopulation(count, seed) {
  return initPopulation({ matrix: WIDE_MATRIX, pool: WIDE_POOL, count, seed });
}

test('initPopulation delegates to sampleCandidateTeams: unique 3-distinct-species teams, deterministic under seed', () => {
  const a = initPopulation({ matrix: WIDE_MATRIX, pool: WIDE_POOL, count: 12, seed: 'gen0' });
  const b = initPopulation({ matrix: WIDE_MATRIX, pool: WIDE_POOL, count: 12, seed: 'gen0' });
  assert.deepEqual(a, b);
  assert.equal(a.length, 12);
  for (const team of a) {
    assert.equal(team.length, 3);
    assert.equal(new Set(speciesOf(team)).size, 3);
  }
});

test('initPopulation randomizes WHICH of a team\'s 3 species becomes the lead (team[0])', () => {
  // A 3-mon pool has exactly one possible species-set (C(3,3)=1); requesting
  // one team under many different seeds isolates lead assignment -- if it
  // were a no-op (always the same underlying draw-order slot), team[0] would
  // be the same species every time. Real randomization should hit all 3.
  const tinyMons = makeMons(3);
  const tinyMatrix = fakeMatrix(tinyMons);
  const tinyPool = poolKeys(tinyMons);

  const leadsSeen = new Set();
  for (let i = 0; i < 60; i++) {
    const [team] = initPopulation({ matrix: tinyMatrix, pool: tinyPool, count: 1, seed: `lead-assign-${i}` });
    leadsSeen.add(tinyMatrix.builtMons[team[0]].speciesId);
  }
  assert.equal(leadsSeen.size, 3, `expected all 3 species to appear as lead across 60 seeds, got ${[...leadsSeen]}`);
});

test('a same species-set can appear twice in a population with two different leads (lead-aware identity)', () => {
  // Force a lead-rotation mutant of every survivor, then confirm the mutant's
  // species-set collides with its parent's (by design) while the two remain
  // DISTINCT entries in the next population under the lead-aware signature.
  const P = 10;
  const population = samplePopulation(P, 'coexist-pop');
  const fitness = population.map((_, i) => i);
  const { population: next, lineage } = nextGeneration({
    population,
    fitness,
    pool: WIDE_POOL,
    matrix: WIDE_MATRIX,
    seed: 'coexist-gen',
    opts: { deathRate: 0.5, mutationFloor: 1, mutationCeil: 1, leadRotationRate: 1, immigrantFraction: 0 },
  });

  const rotations = lineage.entries
    .map((entry, i) => ({ entry, team: next[i] }))
    .filter(({ entry }) => entry.origin === 'mutant' && entry.mutationType === 'leadRotation');
  assert.ok(rotations.length > 0, 'sanity: leadRotationRate=1 should force lead-rotation mutants');

  for (const { entry, team } of rotations) {
    const parentTeam = population[entry.parentIndex];
    assert.deepEqual(new Set(speciesOf(team)), new Set(speciesOf(parentTeam)), 'same species-set as parent');
    assert.notEqual(team[0], parentTeam[0], 'different lead than parent');
    // Both the parent (if it survived) and the rotated mutant would carry the
    // SAME species-set but different lead-aware signatures -- confirm they
    // are not collapsed into one entry by the population's own uniqueness.
    assert.notEqual(teamSignature(team), teamSignature(parentTeam));
  }
});

test('nextGeneration is deterministic across repeated calls under the same seed', () => {
  const population = samplePopulation(20, 'pop-det');
  const fitness = population.map((_, i) => i / population.length);
  const a = nextGeneration({ population, fitness, pool: WIDE_POOL, matrix: WIDE_MATRIX, seed: 'gen-det' });
  const b = nextGeneration({ population, fitness, pool: WIDE_POOL, matrix: WIDE_MATRIX, seed: 'gen-det' });
  assert.deepEqual(a, b);
});

test('a different seed produces a different next generation', () => {
  const population = samplePopulation(20, 'pop-diff');
  const fitness = population.map((_, i) => i / population.length);
  const a = nextGeneration({ population, fitness, pool: WIDE_POOL, matrix: WIDE_MATRIX, seed: 'seed-a' });
  const b = nextGeneration({ population, fitness, pool: WIDE_POOL, matrix: WIDE_MATRIX, seed: 'seed-b' });
  assert.notDeepEqual(a, b);
});

test('deathRate is honored exactly: round(deathRate * P) worst-fitness teams die', () => {
  const P = 20;
  const population = samplePopulation(P, 'death-check');
  const fitness = population.map((_, i) => i); // strictly increasing, no ties
  const { lineage } = nextGeneration({
    population,
    fitness,
    pool: WIDE_POOL,
    matrix: WIDE_MATRIX,
    seed: 'death-check-gen',
    opts: { deathRate: 0.25 },
  });
  assert.equal(lineage.died.length, 5, 'round(0.25 * 20) = 5');
  // The 5 lowest-fitness indices (0..4) must be exactly the ones that died.
  assert.deepEqual([...lineage.died].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
});

test('mutation probability is monotone in fitness percentile among survivors', () => {
  const P = 16;
  const population = samplePopulation(P, 'mono-pop');
  const fitness = population.map((_, i) => i); // fixed ranking every trial below

  // deathRate 0.5 + immigrantFraction 0 keeps mutantSlotsAvailable (8) well
  // above the expected number of successful rolls at these odds (floor 0.05,
  // ceil 0.4), so oversubscription capping never distorts the raw roll rate
  // -- every successful roll becomes a 'mutant' lineage entry.
  const opts = { deathRate: 0.5, immigrantFraction: 0 };

  const trials = 250;
  const mutantCountByIndex = new Map();
  for (let t = 0; t < trials; t++) {
    const { lineage } = nextGeneration({
      population,
      fitness,
      pool: WIDE_POOL,
      matrix: WIDE_MATRIX,
      seed: `mono-trial-${t}`,
      opts,
    });
    for (const entry of lineage.entries) {
      if (entry.origin !== 'mutant') continue;
      mutantCountByIndex.set(entry.parentIndex, (mutantCountByIndex.get(entry.parentIndex) ?? 0) + 1);
    }
  }

  // Survivors are indices 8..15 (fitness 8..15, worst-to-best among them).
  // Index 8 = lowest surviving percentile (floor chance); index 15 = highest
  // (ceil chance) -- expect meaningfully more mutation rolls at the top.
  const lowestSurvivorMutations = mutantCountByIndex.get(8) ?? 0;
  const highestSurvivorMutations = mutantCountByIndex.get(15) ?? 0;
  assert.ok(
    highestSurvivorMutations > lowestSurvivorMutations * 2,
    `expected the highest-percentile survivor to mutate meaningfully more often ` +
      `(lowest=${lowestSurvivorMutations}, highest=${highestSurvivorMutations})`
  );

  // Coarser, noise-robust monotonicity check: the theoretical per-index
  // chance is 0.05 + 0.35*percentile, so summing across the bottom half of
  // survivors (indices 8-11, percentiles 0/7..3/7) vs the top half (12-15,
  // percentiles 4/7..1) gives a wide expected gap (theoretical sums 0.5P vs
  // 1.3P) that easily survives sampling noise at this trial count, unlike a
  // tighter per-index or adjacent-band comparison.
  const bottomHalf = [8, 9, 10, 11].reduce((sum, idx) => sum + (mutantCountByIndex.get(idx) ?? 0), 0);
  const topHalf = [12, 13, 14, 15].reduce((sum, idx) => sum + (mutantCountByIndex.get(idx) ?? 0), 0);
  assert.ok(topHalf > bottomHalf, `expected the top-percentile half (${topHalf}) to mutate more than the bottom half (${bottomHalf})`);
});

test('every member-swap mutant differs from its parent in exactly one slot and has 3 distinct species', () => {
  const P = 24;
  const population = samplePopulation(P, 'mutant-shape-pop');
  const fitness = population.map((_, i) => i);
  const { population: next, lineage } = nextGeneration({
    population,
    fitness,
    pool: WIDE_POOL,
    matrix: WIDE_MATRIX,
    seed: 'mutant-shape-gen',
    opts: { deathRate: 0.4, mutationCeil: 0.9, mutationFloor: 0.5 }, // force plenty of mutants
  });

  let memberSwapCount = 0;
  let leadRotationCount = 0;
  lineage.entries.forEach((entry, i) => {
    if (entry.origin !== 'mutant') return;
    const parentTeam = population[entry.parentIndex];
    const mutantTeam = next[i];
    const diffSlots = [0, 1, 2].filter((slot) => parentTeam[slot] !== mutantTeam[slot]);
    assert.equal(new Set(speciesOf(mutantTeam)).size, 3, 'mutant must have 3 distinct species');

    if (entry.mutationType === 'memberSwap') {
      memberSwapCount++;
      assert.equal(diffSlots.length, 1, `member-swap mutant should differ from parent in exactly one slot, got ${diffSlots.length}`);
      assert.equal(entry.swappedSlot, diffSlots[0]);
    } else if (entry.mutationType === 'leadRotation') {
      leadRotationCount++;
      // A rotation swaps the lead (slot 0) with one back slot -- exactly 2
      // slots differ (the two that traded places) -- and the SPECIES SET is
      // unchanged (same 3 species, just a different one designated lead).
      assert.equal(diffSlots.length, 2, `lead-rotation mutant should differ from parent in exactly 2 slots, got ${diffSlots.length}`);
      assert.ok(diffSlots.includes(0), 'lead-rotation must change the lead slot');
      assert.equal(entry.promotedSlot, diffSlots.find((slot) => slot !== 0));
      assert.deepEqual(new Set(speciesOf(mutantTeam)), new Set(speciesOf(parentTeam)), 'lead-rotation must keep the same species set');
      assert.equal(mutantTeam[0], parentTeam[entry.promotedSlot], 'the promoted back should now be the lead');
      assert.equal(mutantTeam[entry.promotedSlot], parentTeam[0], 'the old lead should now sit in the promoted slot');
    } else {
      assert.fail(`unexpected mutationType: ${entry.mutationType}`);
    }
  });
  assert.ok(memberSwapCount > 0, 'sanity: this config should actually produce member-swap mutants');
  assert.ok(leadRotationCount > 0, 'sanity: this config should actually produce lead-rotation mutants');
});

test('lead-rotation rate controls the mix of mutation types (statistical check over many seeded generations)', () => {
  const P = 20;
  const population = samplePopulation(P, 'rotation-rate-pop');
  const fitness = population.map((_, i) => i);
  const opts = { deathRate: 0.5, immigrantFraction: 0, mutationFloor: 0.9, mutationCeil: 0.9 }; // force ~every survivor to mutate

  function countTypesOverTrials(leadRotationRate, trials) {
    let memberSwap = 0;
    let leadRotation = 0;
    for (let t = 0; t < trials; t++) {
      const { lineage } = nextGeneration({
        population,
        fitness,
        pool: WIDE_POOL,
        matrix: WIDE_MATRIX,
        seed: `rotation-rate-${leadRotationRate}-${t}`,
        opts: { ...opts, leadRotationRate },
      });
      for (const entry of lineage.entries) {
        if (entry.origin !== 'mutant') continue;
        if (entry.mutationType === 'leadRotation') leadRotation++;
        else memberSwap++;
      }
    }
    return { memberSwap, leadRotation };
  }

  const low = countTypesOverTrials(0.1, 30);
  const high = countTypesOverTrials(0.8, 30);
  assert.ok(low.leadRotation + low.memberSwap > 0 && high.leadRotation + high.memberSwap > 0, 'sanity: both trials produced mutants');
  const lowRatio = low.leadRotation / (low.leadRotation + low.memberSwap);
  const highRatio = high.leadRotation / (high.leadRotation + high.memberSwap);
  assert.ok(highRatio > lowRatio, `expected a higher leadRotationRate to produce more lead-rotation mutants (low=${lowRatio}, high=${highRatio})`);
});

test('population stays unique and exactly at target size, with the immigrant floor respected', () => {
  const P = 30;
  const population = samplePopulation(P, 'size-pop');
  const fitness = population.map((_, i) => i);
  const { population: next, lineage } = nextGeneration({
    population,
    fitness,
    pool: WIDE_POOL,
    matrix: WIDE_MATRIX,
    seed: 'size-gen',
    opts: { deathRate: 0.25 }, // default immigrantFraction (0.1)
  });

  assert.equal(next.length, P, 'the wide pool should always be able to fill back up to P');
  const signatures = new Set(next.map(teamSignature));
  assert.equal(signatures.size, P, 'no two teams in the next population share a species-set');

  const immigrantCount = lineage.entries.filter((e) => e.origin === 'immigrant').length;
  const expectedFloor = Math.round(DEFAULT_IMMIGRANT_FRACTION * P);
  assert.ok(
    immigrantCount >= expectedFloor,
    `expected at least the ${expectedFloor}-team immigrant floor, got ${immigrantCount}`
  );
});

test('excludeSpecies is honored end to end: initPopulation and nextGeneration (mutants + immigrants)', () => {
  const excludeSpecies = WIDE_POOL_MONS.slice(0, 5).map((m) => m.builtMon.speciesId);

  const gen0 = initPopulation({ matrix: WIDE_MATRIX, pool: WIDE_POOL, count: 20, seed: 'exclude-gen0', excludeSpecies });
  for (const team of gen0) {
    for (const species of excludeSpecies) assert.ok(!speciesOf(team).includes(species));
  }

  const fitness = gen0.map((_, i) => i);
  const { population: next } = nextGeneration({
    population: gen0,
    fitness,
    pool: WIDE_POOL,
    matrix: WIDE_MATRIX,
    seed: 'exclude-gen1',
    opts: { deathRate: 0.4, mutationCeil: 0.9, mutationFloor: 0.5, excludeSpecies },
  });
  for (const team of next) {
    for (const species of excludeSpecies) assert.ok(!speciesOf(team).includes(species));
  }
});

test('a too-small population still returns a coherent (possibly short) result rather than throwing', () => {
  const tinyMons = makeMons(4); // C(4,3) = 4 possible teams total
  const tinyMatrix = fakeMatrix(tinyMons);
  const tinyPool = poolKeys(tinyMons);
  const population = initPopulation({ matrix: tinyMatrix, pool: tinyPool, count: 4, seed: 'tiny' });
  assert.equal(population.length, 4);

  const fitness = population.map((_, i) => i);
  const { population: next, lineage } = nextGeneration({
    population,
    fitness,
    pool: tinyPool,
    matrix: tinyMatrix,
    seed: 'tiny-gen',
    opts: { deathRate: 0.25 },
  });
  assert.ok(next.length <= 4, 'never exceeds the requested population size');
  const signatures = new Set(next.map(teamSignature));
  assert.equal(signatures.size, next.length, 'no duplicate team compositions even under pool exhaustion');
  assert.ok(Array.isArray(lineage.died));
});

// ---------------------------------------------------------------------------
// scripts/evolve.mjs's `--ban` helpers -- format-wide species bans ("no
// Mimikyu, no Cramorant") matched by BASE species id, unlike --exclude's
// exact-match-only candidate exclusion. No engine boot, no battles.
// ---------------------------------------------------------------------------

test('filterBannedCuratedTeams drops a WHOLE curated team containing a banned base species (shadow variant included)', () => {
  const teams = [
    { id: 'a', name: 'Altaria team', members: [{ speciesId: 'altaria' }, { speciesId: 'skarmory' }, { speciesId: 'clodsire' }] },
    { id: 'b', name: 'Mimikyu team', members: [{ speciesId: 'medicham' }, { speciesId: 'mimikyu' }, { speciesId: 'swampert' }] },
    { id: 'c', name: 'Shadow Mimikyu team', members: [{ speciesId: 'mimikyu_shadow' }, { speciesId: 'azumarill' }, { speciesId: 'registeel' }] },
  ];

  const filtered = filterBannedCuratedTeams(teams, ['mimikyu']);
  assert.deepEqual(filtered.map((t) => t.id), ['a'], 'both the exact-match and shadow-form Mimikyu teams are dropped entirely, base-species-only team survives');

  assert.deepEqual(filterBannedCuratedTeams(teams, []), teams, 'an empty ban list is a no-op');
  assert.deepEqual(filterBannedCuratedTeams(teams, ['cramorant']), teams, 'a ban that matches nothing changes nothing');
});

test('filterBannedMovesetPool removes banned species by BASE id (baseIdOf: exact id or its shadow variant)', () => {
  const pool = [
    { speciesId: 'mimikyu', fastMove: 'shadow_claw', chargedMoves: ['play_rough'] },
    { speciesId: 'mimikyu_shadow', fastMove: 'shadow_claw', chargedMoves: ['play_rough'] },
    { speciesId: 'cramorant', fastMove: 'water_gun', chargedMoves: ['surf'] },
    { speciesId: 'altaria', fastMove: 'dragon_breath', chargedMoves: ['sky_attack'] },
  ];

  const filtered = filterBannedMovesetPool(pool, ['mimikyu', 'cramorant']);
  assert.deepEqual(filtered.map((e) => e.speciesId), ['altaria'], 'exact match (cramorant) and both the base and shadow Mimikyu entries are removed');

  assert.deepEqual(filterBannedMovesetPool(pool, []), pool, 'an empty ban list is a no-op');
});

test('expandBanToCandidateSpeciesIds expands base-id bans to every concrete speciesId present (baseIdOf: exact id or its shadow variant)', () => {
  const builtMons = {
    key1: { speciesId: 'mimikyu' },
    key2: { speciesId: 'mimikyu_shadow' },
    key3: { speciesId: 'cramorant' },
    key4: { speciesId: 'altaria' },
  };

  const expanded = expandBanToCandidateSpeciesIds(builtMons, ['mimikyu']);
  assert.deepEqual(new Set(expanded), new Set(['mimikyu', 'mimikyu_shadow']));

  assert.deepEqual(expandBanToCandidateSpeciesIds(builtMons, []), [], 'an empty ban list expands to nothing');
  assert.deepEqual(expandBanToCandidateSpeciesIds(builtMons, ['registeel']), [], 'a ban matching no owned species expands to nothing');
});

// ---------------------------------------------------------------------------
// renderEvolveReportHtml -- the podium-style HTML report. A synthetic
// `result` (no engine, no battles, no real GA run) exercises the podium,
// per-elite detail cards, the embedded race chart (fed straight from
// generationRecords, exactly as a real run would), the full-standings table
// and the data-driven run notes, checking every section renders and that
// nothing reads as "undefined"/"NaN" -- the failure mode a missing/renamed
// field on a real run would produce, which wouldn't surface until the very
// end of an hours-long run otherwise.
// ---------------------------------------------------------------------------

/** Same lead-aware identity src/teams/evolve.js / src/report/raceChart.js use. */
function sig(keys) {
  return `${keys[0]}||${[...keys.slice(1)].sort().join('|')}`;
}

/** One synthetic elite-team member with every field renderEvolveReportHtml's detail card reads. */
function fakeMember(overrides) {
  return {
    key: overrides.key,
    speciesId: overrides.key,
    name: overrides.name,
    ivs: { atk: 1, def: 14, hp: 15 },
    shadow: false,
    purified: false,
    currentLevel: 20,
    currentCp: 900,
    targetLevel: 30,
    targetCp: 1490,
    fastMove: 'Counter',
    chargedMoves: ['Power-Up Punch', 'Ice Punch'],
    evolveFrom: null,
    evolveItems: [],
    ...overrides,
  };
}

function fakeResult() {
  const teamA = [fakeMember({ key: 'a1', name: 'Alpha' }), fakeMember({ key: 'a2', name: 'Bravo' }), fakeMember({ key: 'a3', name: 'Charlie' })];
  const teamB = [fakeMember({ key: 'b1', name: 'Delta' }), fakeMember({ key: 'b2', name: 'Echo' }), fakeMember({ key: 'b3', name: 'Foxtrot' })];
  const teamC = [
    // Exercises the three buildLineHtml branches: unknown current level,
    // already-built (current >= target), and an evolution.
    fakeMember({ key: 'c1', name: 'Golf', currentLevel: null, currentCp: null }),
    fakeMember({ key: 'c2', name: 'Hotel', currentLevel: 35, currentCp: 1500, targetLevel: 30, targetCp: 1490 }),
    fakeMember({ key: 'c3', name: 'India', evolveFrom: 'Indigo', evolveItems: ['Sinnoh Stone'] }),
  ];

  const eliteEntry = (members, signature, score) => ({
    members,
    signature,
    combinedScore: score,
    winRate: score + 0.03,
    recentWinRate: score - 0.02,
    recentGenerations: 2,
    battles: 150,
    errors: 0,
    bestLead: { name: members[0].name },
    safeSwap: { name: members[1].name, avgHpPct: 0.42 },
    coreBreakExposure: [{ name: 'Nemesis' }],
    hardestOpponents: [
      { name: 'Toughy', label: 'curated', winRate: 0.3, wins: 3, losses: 7, ties: 0, avgHpMargin: -12.5 },
    ],
  });

  const elites = [
    eliteEntry(teamA, sig(['a1', 'a2', 'a3']), 0.7),
    eliteEntry(teamB, sig(['b1', 'b2', 'b3']), 0.65),
    // Team C has no safeSwap/coreBreakExposure/hardestOpponents -- the
    // "not tracked" branches (guarded with `?.`/`if`) must not crash or
    // print "undefined".
    { ...eliteEntry(teamC, sig(['c1', 'c2', 'c3']), 0.6), safeSwap: null, coreBreakExposure: [], hardestOpponents: [] },
  ];

  const generationRecords = [
    {
      timing: { battleCount: 100, cachedCount: 20, errorCount: 0 },
      threadsUsed: 4,
      winRateBySignature: { [sig(['a1', 'a2', 'a3'])]: 0.6, [sig(['b1', 'b2', 'b3'])]: 0.5 },
      analytics: {
        topTeams: [
          { members: [{ key: 'a1', name: 'Alpha' }, { key: 'a2', name: 'Bravo' }, { key: 'a3', name: 'Charlie' }] },
          { members: [{ key: 'b1', name: 'Delta' }, { key: 'b2', name: 'Echo' }, { key: 'b3', name: 'Foxtrot' }] },
        ],
      },
    },
    {
      timing: { battleCount: 90, cachedCount: 30, errorCount: 1 },
      threadsUsed: 4,
      // Team B died before this generation (no entry); team C is alive here
      // but never cracked a per-gen top-N, so it only shows up via the final
      // ranking (buildTopTeamSeries's "ranking-only team" path).
      winRateBySignature: { [sig(['a1', 'a2', 'a3'])]: 0.68, [sig(['c1', 'c2', 'c3'])]: 0.6 },
      analytics: {
        topTeams: [{ members: [{ key: 'a1', name: 'Alpha' }, { key: 'a2', name: 'Bravo' }, { key: 'a3', name: 'Charlie' }] }],
      },
    },
  ];

  return {
    collectionPath: 'fixtures/my-collection.csv',
    collectionMonCount: 42,
    scoredMonCount: 55,
    outDir: 'out/test-run',
    reportPath: 'out/test-run/my-teams-evolve.md',
    league: { name: 'Great League' },
    config: {
      generations: 5,
      cp: 1500,
      seed: 'test-seed',
      population: 40,
      populationFinalRatio: 0.4,
      opponentsPerGen: 10,
      pool: 20,
      curatedRatio: 0.66,
      fitness: 'battle-reality',
      evolutions: true,
      fixedOpponents: false,
      banSpecies: ['mimikyu'],
      excludeSpecies: ['smeargle'],
    },
    stopReason: 'generation cap reached',
    importWarnings: ['skipped weird-row: unrecognized species'],
    generationRecords,
    elites,
    eliteTiming: { battleCount: 200, cachedCount: 10, errorCount: 0 },
    eliteOpponents: { total: 30, curated: 20, evolved: 10 },
    ranking: { weights: { elitePass: 0.7, recent: 0.3 }, recentWindow: 2 },
    totalElapsedMs: 3_723_000,
  };
}

test('renderEvolveReportHtml: podium, detail cards, embedded race, standings and notes render with no undefined/NaN', () => {
  const html = renderEvolveReportHtml(fakeResult());

  assert.match(html, /<h1>The Podium<\/h1>/);
  assert.match(html, /Great League/);
  assert.match(html, /Alpha/);
  assert.match(html, /Delta/);
  assert.match(html, /Golf/);
  // Podium medals for the top 3.
  assert.match(html, /Gold — Alpha \/ Bravo \/ Charlie/);
  assert.match(html, /Silver — Delta \/ Echo \/ Foxtrot/);
  assert.match(html, /Bronze — Golf \/ Hotel \/ India/);
  // Per-member moveset/build lines (movesetLine/buildLineHtml).
  assert.match(html, /Counter/);
  assert.match(html, /Power-Up Punch \/ Ice Punch/);
  assert.match(html, /no level on file/); // Golf, currentLevel: null
  assert.match(html, /already at or above the level simulated/); // Hotel
  assert.match(html, /evolve from Indigo/); // India
  // The race section: embedded chart, not just a link out.
  assert.match(html, /<h2>The race<span class="rule"><\/span><\/h2>/);
  assert.match(html, /id="chart"/);
  assert.match(html, /"generations":2/, 'chart data carries one entry per generationRecords entry');
  // Full standings: one row per elite.
  assert.match(html, /Full standings/);
  const standingsRows = html.match(/<span class="medal-dot"/g) ?? [];
  assert.equal(standingsRows.length, 3, 'one medal dot per top-3 standings row');
  // Run notes: data-driven facts, not fabricated prose.
  assert.match(html, /Run notes/);
  assert.match(html, /generation cap reached/);
  assert.match(html, /ban=|Banned species/i);
  assert.match(html, /skipped weird-row: unrecognized species/);

  assert.doesNotMatch(html, /undefined/, 'no field read off a missing key leaked through as the literal string');
  assert.doesNotMatch(html, /NaN/, 'no arithmetic on a missing/wrong-shaped field leaked through as NaN');
});

test('renderEvolveReportHtml: zero elites renders gracefully (no podium/cards, race + standings + notes still present)', () => {
  const result = { ...fakeResult(), elites: [] };
  const html = renderEvolveReportHtml(result);

  assert.match(html, /No elite teams were produced/);
  assert.match(html, /<h2>The race<span class="rule"><\/span><\/h2>/);
  assert.match(html, /Full standings/);
  assert.match(html, /Run notes/);
  assert.doesNotMatch(html, /undefined/);
  assert.doesNotMatch(html, /NaN/);
});
