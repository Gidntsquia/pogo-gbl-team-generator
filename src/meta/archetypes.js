// Pure arithmetic over an already-battled opponent pool -- no battle math, no
// engine calls. Groups opponents into "archetypes" (teams that share at
// least two of their three base species) so a crowded, mutation-bred core
// does not get to count as N independent teams to beat in fitness math that
// sums or averages over opponents; see docs/plans/2026-09-08-fitness-restructure.md.

import { baseIdOf } from './sampleTeams.js';

export const DEFAULT_ARCHETYPE_BETA = 0.5;

/** Sorted base-species triple (up to 3 distinct base ids, "|"-joined) for one opponent. */
function baseSpeciesKey(opponent) {
  const ids = opponent.members.map((m) => baseIdOf(String(m.spec?.speciesId ?? m.speciesId ?? '')));
  return [...new Set(ids)].sort();
}

function sharedCount(a, b) {
  const bSet = new Set(b);
  let n = 0;
  for (const id of a) if (bSet.has(id)) n += 1;
  return n;
}

/**
 * Groups opponents that share at least two of their three base species into
 * the same archetype, via union-find over all pairs. Iteration and group-id
 * assignment both follow input order, so the result is deterministic and
 * does NOT depend on `parentId`/lineage -- an immigrant that happens to be a
 * Stunfisk/Sableye/Tinkaton build groups with an unrelated mutant lineage of
 * the same core.
 *
 * @param {Array<{members: Array<{speciesId?: string, spec?: {speciesId: string}}>}>} opponents
 * @returns {number[]} groupId per opponent, 0-based, parallel to `opponents`.
 */
export function archetypeGroups(opponents) {
  const n = opponents.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const keys = opponents.map(baseSpeciesKey);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sharedCount(keys[i], keys[j]) >= 2) union(i, j);
    }
  }

  // Assign group ids in order of first appearance of each root, so the
  // result is stable across runs regardless of union-find's internal tree
  // shape.
  const idByRoot = new Map();
  const groups = new Array(n);
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!idByRoot.has(root)) idByRoot.set(root, idByRoot.size);
    groups[i] = idByRoot.get(root);
  }
  return groups;
}

/**
 * Per-opponent weight from its archetype group's size: a group of size s
 * contributes a total of `s^(1-beta)` votes, split evenly across its s
 * members (`groupSize^(-beta)` each). beta=0 reproduces a flat/raw mean
 * (every opponent counts once); beta=1 is one-vote-per-archetype
 * (a crowded core counts the same as a lone immigrant of the same archetype).
 *
 * @param {number[]} groups - archetypeGroups(opponents) output.
 * @param {{beta?: number}} [opts]
 * @returns {number[]} weight per opponent, parallel to `groups`.
 */
export function archetypeWeights(groups, opts = {}) {
  const beta = opts.beta ?? DEFAULT_ARCHETYPE_BETA;
  const sizeByGroup = new Map();
  for (const g of groups) sizeByGroup.set(g, (sizeByGroup.get(g) ?? 0) + 1);
  return groups.map((g) => Math.pow(sizeByGroup.get(g), -beta));
}
