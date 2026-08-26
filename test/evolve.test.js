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
// respected, the convergence detector fires exactly when specified, and
// excludeSpecies is honored end to end (initPopulation + nextGeneration).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  initPopulation,
  nextGeneration,
  hasConverged,
  DEFAULT_IMMIGRANT_FRACTION,
} from '../src/teams/evolve.js';

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

test('convergence detector fires exactly when the top-N set is stable for `window` generations', () => {
  const P = 10;
  const stablePop = samplePopulation(P, 'converge-stable');
  const stableFitness = stablePop.map((_, i) => i);
  const stableGen = { population: stablePop, fitness: stableFitness };

  const churnPop = samplePopulation(P, 'converge-churn');
  const churnGen = { population: churnPop, fitness: churnPop.map((_, i) => i) };

  // Not enough history yet.
  assert.deepEqual(hasConverged([stableGen, stableGen], { window: 3 }), { converged: false, reason: null });

  // 3 identical generations in a row -> converged.
  const converged = hasConverged([stableGen, stableGen, stableGen], { window: 3, topN: 5 });
  assert.equal(converged.converged, true);
  assert.match(converged.reason, /top-5 composition unchanged for 3 consecutive generations/);

  // A churny generation breaks the streak even if it's the most recent one.
  const broken = hasConverged([stableGen, stableGen, churnGen], { window: 3, topN: 5 });
  assert.equal(broken.converged, false);
  assert.equal(broken.reason, null);

  // Only the most recent `window` generations matter -- an old churn doesn't
  // block convergence once the streak restarts.
  const recovered = hasConverged([churnGen, stableGen, stableGen, stableGen], { window: 3, topN: 5 });
  assert.equal(recovered.converged, true);
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
