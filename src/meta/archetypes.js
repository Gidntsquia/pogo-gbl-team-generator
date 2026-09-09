// Pure arithmetic over an already-battled opponent pool -- no battle math, no
// engine calls. Groups opponents into "archetypes" (teams built around the
// same two-species core) so a crowded, mutation-bred core does not get to
// count as N independent teams to beat in fitness math that sums or averages
// over opponents; see docs/plans/2026-09-08-fitness-restructure.md.

import { baseIdOf } from './sampleTeams.js';

export const DEFAULT_ARCHETYPE_BETA = 0.5;

/** Sorted base-species triple (up to 3 distinct base ids, "|"-joined) for one opponent. */
function baseSpeciesKey(opponent) {
  const ids = opponent.members.map((m) => baseIdOf(String(m.spec?.speciesId ?? m.speciesId ?? '')));
  return [...new Set(ids)].sort();
}

/**
 * Groups opponents by their dominant CORE PAIR: every pair of base species an
 * opponent carries is counted across the pool, and each opponent joins the
 * group of its own pair with the highest pool count (ties broken by the
 * sorted "a|b" key, so the result is deterministic and independent of
 * `parentId`/lineage). Two opponents therefore share an archetype only when
 * they share the same two-species core -- there is NO transitive closure.
 * The earlier union-find version ("share >=2 species with anything already
 * in the group") chained A/B/C -> B/C/D -> C/D/E and, on the 2026-09-08 v2
 * meta-vs-meta run, collapsed 167 of 187 opponents into one group so that
 * the ~17 immigrant singletons carried ~60% of every candidate's fitness.
 *
 * An opponent whose best pair count is 1 (no other opponent shares any two
 * of its species) is a singleton group.
 *
 * @param {Array<{members: Array<{speciesId?: string, spec?: {speciesId: string}}>}>} opponents
 * @returns {number[]} groupId per opponent, 0-based, parallel to `opponents`,
 *   ids assigned in order of first appearance.
 */
export function archetypeGroups(opponents) {
  const pairsOf = opponents.map((o) => {
    const ids = baseSpeciesKey(o);
    const pairs = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) pairs.push(`${ids[i]}|${ids[j]}`);
    }
    return pairs;
  });
  const count = new Map();
  for (const pairs of pairsOf) for (const p of pairs) count.set(p, (count.get(p) ?? 0) + 1);

  const idByKey = new Map();
  return pairsOf.map((pairs, i) => {
    let best = null;
    for (const p of pairs) {
      if (best === null || count.get(p) > count.get(best) || (count.get(p) === count.get(best) && p < best)) best = p;
    }
    // A single-species opponent (no pairs) or a pair nobody else carries is
    // its own group; key singletons by index so they never merge.
    const key = best !== null && count.get(best) > 1 ? best : `#${i}`;
    if (!idByKey.has(key)) idByKey.set(key, idByKey.size);
    return idByKey.get(key);
  });
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

export const DEFAULT_CORE_RIVALRY = 0.1;
/** Weight of a maximally similar different-species member, relative to the identical species (1). 0 = exact cores only. */
export const DEFAULT_SIMILAR_RIVALRY = 1;
/** pvpoke similarity (src/engine/similarity.js, 0..1) at or below which two different species count as unrelated. */
export const DEFAULT_SIMILAR_FLOOR = 0.35;

/**
 * @typedef {object} MemberProfile
 * @property {string} baseId - shadow-stripped species id.
 * @property {object} [pokemon] - the member's built pvpoke Pokemon, scored by
 *   the `similarity` callback of coreRivalryFitness; absent = no similarity.
 */

/** Dedupe by baseId (first wins) and sort, so a team's profile list is order-independent. */
function normaliseProfiles(profiles) {
  const byId = new Map();
  for (const p of profiles) if (p.baseId && !byId.has(p.baseId)) byId.set(p.baseId, p);
  return [...byId.keys()].sort().map((id) => byId.get(id));
}

/** Member profiles of one opponent entry (members are built pvpoke Pokemon, see sampleTeams buildMetaMon). */
export function opponentProfiles(opponent) {
  return normaliseProfiles(
    opponent.members.map((m) => ({
      baseId: baseIdOf(String(m.spec?.speciesId ?? m.speciesId ?? '')),
      pokemon: typeof m.calculateSimilarity === 'function' ? m : undefined,
    }))
  );
}

/** Member profiles of one candidate team, read off the built pvpoke instances in `matrix.builtMons`. */
export function candidateProfiles(matrix, team) {
  return normaliseProfiles(
    team.map((key) => {
      const built = matrix.builtMons[key] ?? {};
      return { baseId: baseIdOf(String(built.speciesId ?? '')), pokemon: built.pokemon };
    })
  );
}

/**
 * Similarity of two members: 1 for the same base species (a shadow and its
 * base are the same species here); otherwise pvpoke's own similarity of
 * the two built Pokemon (`opts.similarity`, see src/engine/similarity.js
 * createSimilarity: shared types, moves and traits, normalised to 0..1),
 * floored and rescaled -- anything at or below `opts.floor` is 0, and the
 * band above it maps linearly onto (0, `opts.similar`]. So with the
 * defaults a Feraligatr and an Empoleon (pvpoke ~0.55) load about 0.3 on
 * each other, Charizard/Blaziken (~0.62) about 0.4, and Annihilape/Mimikyu
 * (~0.33) nothing. No `similarity` callback, or `similar` 0, means
 * different species never match.
 *
 * @param {MemberProfile} a
 * @param {MemberProfile} b
 * @param {{similar?: number, floor?: number, similarity?: (a: object, b: object) => number}} [opts]
 * @returns {number}
 */
export function memberSimilarity(a, b, opts = {}) {
  if (a.baseId === b.baseId) return 1;
  const similar = opts.similar ?? DEFAULT_SIMILAR_RIVALRY;
  const floor = opts.floor ?? DEFAULT_SIMILAR_FLOOR;
  if (!(similar > 0) || typeof opts.similarity !== 'function' || !a.pokemon || !b.pokemon) return 0;
  const s = opts.similarity(a.pokemon, b.pokemon);
  if (!(s > floor)) return 0;
  return similar * Math.min(1, (s - floor) / (1 - floor));
}

/** A team given as plain base-id strings (tests, callers without built mons) becomes a profile with no Pokemon. */
function toProfiles(team) {
  return normaliseProfiles(team.map((m) => (typeof m === 'string' ? { baseId: baseIdOf(m) } : m)));
}

/**
 * Core rivalry (added 2026-09-09): teams built around the same two-species
 * core compete with each other for their seats, the way shadow/non-shadow
 * twins do in src/teams/evolve.js's shadowRivalryLosers -- but softer. A
 * shadow rivalry kills the weaker twin outright; here a team is charged
 * `rivalry x (max - min fitness of the field) x load` fitness points before
 * the ordinary cull ranks it, where `load` is how crowded its MOST crowded
 * core is with better teams:
 *
 *   - a better team carrying the identical core adds 1;
 *   - a better team carrying a similar core adds the product of the member
 *     similarities (memberSimilarity: same species 1, otherwise pvpoke's
 *     similarity of the two builds, floored and scaled by `opts`), so a
 *     Tinkaton/Empoleon team adds roughly 0.3 to a Tinkaton/Feraligatr
 *     team with the defaults, and Copperajah/Empoleon far less;
 *   - each better team counts at most once, through whichever of its cores
 *     matches best, and a team's cores are NOT summed: its penalty is the
 *     max over its own cores, so a team that carries two or three strong,
 *     popular cores is not charged two or three times over.
 *
 * The best variant of a core pays nothing, the second pays one step, the
 * fifth four. A second variant that is genuinely strong (a similar-looking
 * team that plays differently) still ranks above the field's weaker
 * unrelated teams and survives; a pile of near-duplicates trailing the best
 * one is pushed to the bottom and culled first. `rivalry` 0 disables.
 *
 * Deterministic and pure: ties in fitness break on index (lower index is
 * the "better" rival), no randomness.
 *
 * @param {Array<Array<MemberProfile|string>>} profilesByTeam - members per
 *   team (candidateProfiles / opponentProfiles), or plain base ids.
 * @param {number[]} fitness - parallel to `profilesByTeam`.
 * @param {number} [rivalry] - penalty per unit of load, as a fraction of the field's fitness range.
 * @param {{similar?: number, floor?: number, similarity?: (a: object, b: object) => number}} [opts] -
 *   passed to memberSimilarity: `similarity` scores two built pvpoke Pokemon
 *   (src/engine/similarity.js createSimilarity; absent = exact cores only),
 *   `floor` (default DEFAULT_SIMILAR_FLOOR) is where a match starts counting,
 *   `similar` (default DEFAULT_SIMILAR_RIVALRY) what a maximal match counts; 0 = exact cores only.
 * @returns {{shared: number[], rivalsAbove: number[]}} penalised fitness per
 *   team (equal to `fitness` when rivalry is 0 or nothing overlaps) and each
 *   team's load (better identical-core rivals count 1, similar ones less).
 */
export function coreRivalryFitness(profilesByTeam, fitness, rivalry = DEFAULT_CORE_RIVALRY, opts = {}) {
  const n = profilesByTeam.length;
  const rivalsAbove = new Array(n).fill(0);
  if (!(rivalry > 0) || n === 0) return { shared: fitness.slice(), rivalsAbove };
  const teams = profilesByTeam.map(toProfiles);

  // Pairs are identified by their sorted baseId key, so the many mutants and
  // immigrants that share an identical two-species core collapse onto the
  // same pair id -- pairSim then computes that core's similarity to another
  // core ONCE for the whole population instead of once per team pair that
  // happens to carry it (a crowded core is exactly the case this fitness
  // term exists for, so this is the common case, not an edge case).
  const pairIdOf = new Map();
  const pairMembers = [];
  const idOfPair = (p) => {
    const key = p[0].baseId < p[1].baseId ? `${p[0].baseId}|${p[1].baseId}` : `${p[1].baseId}|${p[0].baseId}`;
    let id = pairIdOf.get(key);
    if (id === undefined) {
      id = pairMembers.length;
      pairMembers.push(p);
      pairIdOf.set(key, id);
    }
    return id;
  };
  const pairsOf = teams.map((members) => {
    const pairs = [];
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) pairs.push(idOfPair([members[i], members[j]]));
    return pairs;
  });

  const simCache = new Map();
  const sim = (a, b) => {
    const key = a.baseId < b.baseId ? `${a.baseId}|${b.baseId}` : `${b.baseId}|${a.baseId}`;
    let v = simCache.get(key);
    if (v === undefined) {
      v = memberSimilarity(a, b, opts);
      simCache.set(key, v);
    }
    return v;
  };
  const pairSimCache = new Map();
  const pairSim = (idX, idY) => {
    const key = idX <= idY ? `${idX}|${idY}` : `${idY}|${idX}`;
    let v = pairSimCache.get(key);
    if (v === undefined) {
      const p = pairMembers[idX];
      const q = pairMembers[idY];
      const straight = sim(p[0], q[0]) * sim(p[1], q[1]);
      const crossed = sim(p[0], q[1]) * sim(p[1], q[0]);
      v = Math.max(straight, crossed);
      pairSimCache.set(key, v);
    }
    return v;
  };

  // Iterate strictly-better rivals via one fitness-descending order instead
  // of an n-way `better()` scan per team.
  const order = fitness.map((_, i) => i).sort((a, b) => fitness[b] - fitness[a] || a - b);
  const rankOf = new Array(n);
  order.forEach((i, rank) => (rankOf[i] = rank));

  for (let i = 0; i < n; i++) {
    const own = pairsOf[i];
    if (own.length === 0) continue;
    const load = new Array(own.length).fill(0);
    for (let rank = 0; rank < rankOf[i]; rank++) {
      const j = order[rank];
      for (let p = 0; p < own.length; p++) {
        let best = 0;
        for (const q of pairsOf[j]) {
          const s = pairSim(own[p], q);
          if (s > best) best = s;
          if (best === 1) break;
        }
        load[p] += best;
      }
    }
    rivalsAbove[i] = Math.max(...load);
  }
  let min = Infinity;
  let max = -Infinity;
  for (const f of fitness) {
    if (f < min) min = f;
    if (f > max) max = f;
  }
  const step = rivalry * (max - min);
  const shared = fitness.map((f, i) => f - step * rivalsAbove[i]);
  return { shared, rivalsAbove };
}
