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
/** Similarity of a shadow to its own non-shadow (same species, the other shadow flag): the top of the scale short of identity. */
export const DEFAULT_SHADOW_SIMILARITY = 0.9;
/** Extra load a better team adds per unit of WHOLE-TEAM similarity (on top of its core load), see coreRivalryFitness. */
export const DEFAULT_TWIN_RIVALRY = 2;

/**
 * @typedef {object} MemberProfile
 * @property {string} baseId - shadow-stripped species id.
 * @property {boolean} [shadow] - whether this build is the shadow form.
 * @property {object} [pokemon] - the member's built pvpoke Pokemon, scored by
 *   the `similarity` callback of coreRivalryFitness; absent = no similarity.
 */

const SHADOW_SUFFIX = '_shadow';

/** Dedupe by baseId (first wins) and sort, so a team's pair math is order-independent. */
function normaliseProfiles(profiles) {
  const byId = new Map();
  for (const p of profiles) if (p.baseId && !byId.has(p.baseId)) byId.set(p.baseId, p);
  return [...byId.keys()].sort().map((id) => byId.get(id));
}

/**
 * Member profiles of one opponent entry (members are built pvpoke Pokemon,
 * see sampleTeams buildMetaMon), in slot order: `[0]` is the lead. Order is
 * what coreRivalryFitness's twin rule reads (`opts.twins`), so keep it.
 */
export function opponentProfiles(opponent) {
  return opponent.members.map((m) => {
    const speciesId = String(m.spec?.speciesId ?? m.speciesId ?? '');
    return {
      baseId: baseIdOf(speciesId),
      shadow: !!m.spec?.shadow || speciesId.endsWith(SHADOW_SUFFIX),
      pokemon: typeof m.calculateSimilarity === 'function' ? m : undefined,
    };
  });
}

/** Member profiles of one candidate team in slot order (`[0]` the lead), read off the built pvpoke instances in `matrix.builtMons`. */
export function candidateProfiles(matrix, team) {
  return team.map((key) => {
    const built = matrix.builtMons[key] ?? {};
    const speciesId = String(built.speciesId ?? '');
    return { baseId: baseIdOf(speciesId), shadow: !!built.spec?.shadow || speciesId.endsWith(SHADOW_SUFFIX), pokemon: built.pokemon };
  });
}

/**
 * Similarity of two members: 1 for the same build (same base species, same
 * shadow flag); `opts.shadowSimilar` (default DEFAULT_SHADOW_SIMILARITY,
 * 0.9) for a species and its own shadow -- the most alike two different
 * builds can be, but not identical, since shadow-ness does change how the
 * mon fights; otherwise pvpoke's own similarity of the two built Pokemon
 * (`opts.similarity`, see src/engine/similarity.js createSimilarity: shared
 * types, moves and traits, normalised to 0..1), floored and rescaled --
 * anything at or below `opts.floor` is 0, and the band above it maps
 * linearly onto (0, `opts.similar`]. So with the defaults a Feraligatr and
 * an Empoleon (pvpoke ~0.55) load about 0.3 on each other, Charizard/
 * Blaziken (~0.62) about 0.4, and Annihilape/Mimikyu (~0.33) nothing. No
 * `similarity` callback, or `similar` 0, means different species never
 * match.
 *
 * @param {MemberProfile} a
 * @param {MemberProfile} b
 * @param {{similar?: number, floor?: number, shadowSimilar?: number, similarity?: (a: object, b: object) => number}} [opts]
 * @returns {number}
 */
export function memberSimilarity(a, b, opts = {}) {
  if (a.baseId === b.baseId) return !!a.shadow === !!b.shadow ? 1 : opts.shadowSimilar ?? DEFAULT_SHADOW_SIMILARITY;
  const similar = opts.similar ?? DEFAULT_SIMILAR_RIVALRY;
  const floor = opts.floor ?? DEFAULT_SIMILAR_FLOOR;
  if (!(similar > 0) || typeof opts.similarity !== 'function' || !a.pokemon || !b.pokemon) return 0;
  const s = opts.similarity(a.pokemon, b.pokemon);
  if (!(s > floor)) return 0;
  return similar * Math.min(1, (s - floor) / (1 - floor));
}

/** A team given as plain species-id strings (tests, callers without built mons; `_shadow` suffix honoured) becomes ordered profiles with no Pokemon. */
function toOrderedProfiles(team) {
  return team.map((m) => (typeof m === 'string' ? { baseId: baseIdOf(m), shadow: m.endsWith(SHADOW_SUFFIX) } : m));
}

/**
 * Exact whole-team identity: the member builds (base id + shadow flag),
 * either lead-aware (lead, then the backs as an unordered set -- a candidate
 * team's back order carries no meaning) or positional (slot for slot -- an
 * OpponentEntry's id is positional and a back's slot can matter to how the
 * engine sequences a switch-in, so two entries the pool treats as distinct
 * must never merge here). Two teams sharing a key are the same team.
 */
function exactKeyOf(profiles, mode) {
  const ids = profiles.map((p) => `${p.baseId}${p.shadow ? SHADOW_SUFFIX : ''}`);
  if (mode === 'positional') return ids.join('|');
  return `${ids[0]}||${ids.slice(1).sort().join('|')}`;
}

/**
 * Duplicate losers: among teams sharing an exact key exactly one -- the
 * fittest, ties to the lower index -- may live. Returns the losers
 * worst-fitness first.
 */
function duplicateLosersOf(teams, fitness, mode) {
  const bestByKey = new Map();
  for (let i = 0; i < teams.length; i++) {
    const key = exactKeyOf(teams[i], mode);
    const cur = bestByKey.get(key);
    if (cur === undefined || fitness[i] > fitness[cur]) bestByKey.set(key, i);
  }
  const winners = new Set(bestByKey.values());
  return teams.map((_, i) => i).filter((i) => !winners.has(i)).sort((a, b) => fitness[a] - fitness[b] || a - b);
}

/**
 * Whole-team similarity of `own` to `rival` under `mode`, as the product of
 * the per-slot member similarities: lead against lead, and the backs
 * matched straight or crossed (whichever is higher) in `'lead'` mode, or
 * strictly slot for slot in `'positional'` mode. 1 only for the identical
 * team; a shadow-flip twin scores DEFAULT_SHADOW_SIMILARITY per flipped
 * member (0.9 for one flip, 0.81 for two); a team differing in one member
 * scores that member's pvpoke similarity to its replacement, so a third
 * member from a different role zeroes it.
 */
function teamSimilarity(own, rival, mode, sim) {
  if (own.length !== rival.length || own.length === 0) return 0;
  if (mode === 'positional' || own.length !== 3) {
    let s = 1;
    for (let k = 0; k < own.length && s > 0; k++) s *= sim(own[k], rival[k]);
    return s;
  }
  const lead = sim(own[0], rival[0]);
  if (lead === 0) return 0;
  const straight = sim(own[1], rival[1]) * sim(own[2], rival[2]);
  const crossed = sim(own[1], rival[2]) * sim(own[2], rival[1]);
  return lead * Math.max(straight, crossed);
}

/**
 * Core rivalry (added 2026-09-09): teams that look alike compete with each
 * other for their seats, graded by how alike they are. Member similarity
 * (memberSimilarity) is 1 for the same build, `opts.shadowSimilar` (0.9) for
 * a species against its own shadow -- the most similar two different builds
 * can possibly be, so they sit at the very top of the scale without being
 * identical -- and otherwise pvpoke's own similarity of the two builds,
 * floored and scaled by `opts`. A team is charged
 * `rivalry x (max - min fitness of the field) x load` fitness points before
 * the ordinary cull ranks it, where `load` sums two terms over the better,
 * still-living teams (exact duplicates, below, are dead and count for
 * nobody):
 *
 * CORE LOAD -- how crowded its MOST crowded two-species core is:
 *   - a better team carrying the identical core adds 1;
 *   - a better team carrying a similar core adds the product of the member
 *     similarities, so a Tinkaton/Empoleon team adds roughly 0.3 to a
 *     Tinkaton/Feraligatr team with the defaults, Copperajah/Empoleon far
 *     less, and a core with one member shadow-flipped 0.9;
 *   - each better team counts at most once, through whichever of its cores
 *     matches best, and a team's cores are NOT summed: its penalty is the
 *     max over its own cores, so a team that carries two or three strong,
 *     popular cores is not charged two or three times over.
 *
 * TWIN LOAD -- `opts.twinRivalry` (default DEFAULT_TWIN_RIVALRY, 2) times
 *   the WHOLE-TEAM similarity (teamSimilarity: every slot, under
 *   `opts.twins` -- `'lead'`: same lead, backs in either order;
 *   `'positional'`: slot for slot; `false`: off) to each better team. A
 *   shadow-flip twin of a better team therefore carries 1 (core) + 2 x 0.9
 *   (twin) = 2.8 steps against it, compared with the 1 step a mere same-core
 *   variant pays: competition between a team and its shadow variants is
 *   high, but a shadow twin that genuinely fights better than the field's
 *   weaker unrelated teams still survives, and whichever twin fights best
 *   pays nothing. Only whole-team similarity of exactly 1 -- the identical
 *   team drawn twice, only possible on the opponent side -- is fatal: the
 *   fitter copy lives (ties to the lower index), the rest come back as
 *   `twinLosers`, dead regardless of rank and regardless of `rivalry`.
 *
 * The best variant of a core pays nothing, the second pays one step, the
 * fifth four. A second variant that is genuinely strong (a similar-looking
 * team that plays differently) still ranks above the field's weaker
 * unrelated teams and survives; a pile of near-duplicates trailing the best
 * one is pushed to the bottom and culled first. `rivalry` 0 disables the
 * penalty (not the duplicate cull).
 *
 * Deterministic and pure: ties in fitness break on index (lower index is
 * the "better" rival), no randomness.
 *
 * @param {Array<Array<MemberProfile|string>>} profilesByTeam - members per
 *   team in slot order, `[0]` the lead (candidateProfiles /
 *   opponentProfiles), or plain species ids (`_shadow` suffix honoured). A
 *   shadow and its base share a baseId, so a team listing both counts them
 *   as one member for core math.
 * @param {number[]} fitness - parallel to `profilesByTeam`.
 * @param {number} [rivalry] - penalty per unit of load, as a fraction of the field's fitness range.
 * @param {{similar?: number, floor?: number, shadowSimilar?: number, similarity?: (a: object, b: object) => number,
 *   twins?: 'lead'|'positional'|false, twinRivalry?: number}} [opts] -
 *   `similarity`, `floor`, `similar`, `shadowSimilar` go to memberSimilarity:
 *   `similarity` scores two built pvpoke Pokemon (src/engine/similarity.js
 *   createSimilarity; absent = exact cores only), `floor` (default
 *   DEFAULT_SIMILAR_FLOOR) is where a match starts counting, `similar`
 *   (default DEFAULT_SIMILAR_RIVALRY) what a maximal match counts; 0 = exact
 *   cores only. `twins` (default `'lead'`) picks the whole-team identity, or
 *   disables the twin load and the duplicate cull; `twinRivalry` scales the
 *   twin load (0 = core load only).
 * @returns {{shared: number[], rivalsAbove: number[], twinLosers: number[]}}
 *   penalised fitness per team (equal to `fitness` when rivalry is 0 or
 *   nothing overlaps; `-Infinity` for a duplicate loser so any ranking puts
 *   it last), each team's load (core + twin; 0 for a duplicate loser), and
 *   the duplicate losers worst-fitness first.
 */
export function coreRivalryFitness(profilesByTeam, fitness, rivalry = DEFAULT_CORE_RIVALRY, opts = {}) {
  const n = profilesByTeam.length;
  const rivalsAbove = new Array(n).fill(0);
  const ordered = profilesByTeam.map(toOrderedProfiles);
  const twinMode = opts.twins ?? 'lead';
  const twinRivalry = twinMode ? opts.twinRivalry ?? DEFAULT_TWIN_RIVALRY : 0;
  const twinLosers = twinMode && n > 0 ? duplicateLosersOf(ordered, fitness, twinMode) : [];
  const dead = new Set(twinLosers);
  const shared = fitness.map((f, i) => (dead.has(i) ? -Infinity : f));
  if (!(rivalry > 0) || n === 0) return { shared, rivalsAbove, twinLosers };
  const teams = ordered.map(normaliseProfiles);

  // Pairs are identified by their sorted build-id key (base id + shadow
  // flag), so the many mutants and immigrants that share an identical
  // two-species core collapse onto the same pair id -- pairSim then computes
  // that core's similarity to another core ONCE for the whole population
  // instead of once per team pair that happens to carry it (a crowded core
  // is exactly the case this fitness term exists for, so this is the common
  // case, not an edge case).
  const buildId = (p) => `${p.baseId}${p.shadow ? SHADOW_SUFFIX : ''}`;
  const pairIdOf = new Map();
  const pairMembers = [];
  const idOfPair = (p) => {
    const a = buildId(p[0]);
    const b = buildId(p[1]);
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
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
    const ia = buildId(a);
    const ib = buildId(b);
    const key = ia < ib ? `${ia}|${ib}` : `${ib}|${ia}`;
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

  // Iterate strictly-better LIVING rivals via one fitness-descending order
  // instead of an n-way `better()` scan per team. Twin losers are out of the
  // field entirely: they neither pay nor count.
  const order = fitness.map((_, i) => i).filter((i) => !dead.has(i)).sort((a, b) => fitness[b] - fitness[a] || a - b);
  const rankOf = new Array(n).fill(0);
  order.forEach((i, rank) => (rankOf[i] = rank));

  // Two teams that carry the exact same set of pair ids (near-duplicate
  // mutants/elites, or teams that happen to collapse onto the same cores)
  // always produce the same per-p `best` array against a given rival, so
  // cache it by (own's pair ids, rival's sorted pair ids) instead of
  // recomputing the O(own*rival) inner scan for every (i, j) that shares
  // either side's signature -- a crowded core, the exact case this fitness
  // term targets, is also the case with the most duplicate signatures.
  const bestArrayCache = new Map();
  const jSigCache = new Array(n);
  const jSigOf = (j) => (jSigCache[j] ??= pairsOf[j].slice().sort((a, b) => a - b).join(','));

  for (let i = 0; i < n; i++) {
    const own = pairsOf[i];
    if (own.length === 0 || dead.has(i)) continue;
    const ownKey = own.join(',');
    const load = new Array(own.length).fill(0);
    for (let rank = 0; rank < rankOf[i]; rank++) {
      const j = order[rank];
      const cacheKey = `${ownKey}||${jSigOf(j)}`;
      let bestArr = bestArrayCache.get(cacheKey);
      if (!bestArr) {
        bestArr = new Array(own.length);
        for (let p = 0; p < own.length; p++) {
          let best = 0;
          for (const q of pairsOf[j]) {
            const s = pairSim(own[p], q);
            if (s > best) best = s;
            if (best === 1) break;
          }
          bestArr[p] = best;
        }
        bestArrayCache.set(cacheKey, bestArr);
      }
      for (let p = 0; p < own.length; p++) load[p] += bestArr[p];
    }
    let twinLoad = 0;
    if (twinRivalry > 0) {
      for (let rank = 0; rank < rankOf[i]; rank++) twinLoad += teamSimilarity(ordered[i], ordered[order[rank]], twinMode, sim);
    }
    rivalsAbove[i] = Math.max(...load) + twinRivalry * twinLoad;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const i of order) {
    if (fitness[i] < min) min = fitness[i];
    if (fitness[i] > max) max = fitness[i];
  }
  const step = rivalry * (max - min);
  for (const i of order) shared[i] = fitness[i] - step * rivalsAbove[i];
  return { shared, rivalsAbove, twinLosers };
}
