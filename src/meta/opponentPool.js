// JavaScript Document
//
// The OPPONENT-side genetic algorithm (Jaxon 2026-08-26). Sibling of
// src/teams/evolve.js, which evolves the CANDIDATE side; this file evolves
// the pool those candidates are measured against.
//
// WHY THIS EXISTS. scripts/evolve.mjs used to draw a fresh opponent pool
// every generation from src/meta/sampleTeams.js: a curated majority (real
// teams, a fixed pool of ~110) plus a randomly-composed minority. Two things
// went wrong with that.
//   1. The curated pool is finite and unchanging, so over a long run the
//      candidate population converges onto whatever beats those specific ~110
//      teams -- the overfitting this module exists to break.
//   2. The randomly-composed minority was drawn from the full 1,144-species
//      rankings field and was therefore weak, so it applied no selection
//      pressure at all. (That half is fixed in sampleTeams.js's meta-capped
//      pool; this file is the other half of the fix.)
// The opponent pool is now a PERSISTENT POPULATION that culls its weakest
// members, mutates its survivors, and takes in fresh immigrants -- an arms
// race, so "beat the opponent pool" stops meaning "beat one fixed list".
//
// WHAT IS PROTECTED. Curated-origin entries (`origin: 'curated'`) are the
// pool's ground truth: real teams that were actually observed on the ladder
// or published by top players. They are NEVER culled and NEVER modified in
// place, and their headcount is held at `curatedRatio` of the pool every
// generation. They may still MUTATE -- at a much lower rate than everything
// else -- and when they do, the mutant is a NEW entry taking a freed
// evolvable slot (`origin: 'curated-mutant'`) while the curated parent stays
// in the pool untouched. That is what lets curated genes seed the evolving
// half without ever eroding the real-teams anchor.
//
// FITNESS. An opponent's fitness is simply how badly it beat the candidate
// population this generation: `1 - (mean candidate win rate against it)`. It
// costs no extra battles -- scripts/evolve.mjs already fights every candidate
// against every opponent and just has to tally the other side of the ledger.
//
// No battle math here. This module composes and re-composes teams out of
// src/meta/sampleTeams.js's primitives (which themselves only call
// src/scoring/index.js's buildMetaMon) and decides who lives, who mutates,
// and who arrives. Same rule as every other sampler in this repo: sampling
// machinery, not simulation.

import { rngFromSeed, pickWeighted } from '../util/rng.js';
import { buildMetaMon } from '../scoring/index.js';
import { curatedTierWeight } from './teams.js';
import { opponentProfiles, DEFAULT_CORE_RIVALRY, DEFAULT_SIMILAR_RIVALRY, DEFAULT_SIMILAR_FLOOR } from './archetypes.js';
import { createSimilarity } from '../engine/similarity.js';
import { evolveStep } from '../ga/core.js';
import {
  baseIdOf,
  composeSampledOpponent,
  describeSampledTeam,
  loadMovesetPool,
  orderMembersByLead,
} from './sampleTeams.js';

const TEAM_SIZE = 3;
const BACK_SLOTS = [1, 2];

/**
 * Share of the EVOLVABLE (non-curated) portion culled each generation.
 * Deliberately far gentler than the candidate GA's DEFAULT_DEATH_RATE (1/3):
 * the opponent pool is a measuring instrument, not a search. Churning it hard
 * would make a candidate's win rate mean something different every
 * generation, which is exactly the noise scripts/evolve.mjs's
 * last-N-generation averaging is there to damp out.
 */
export const DEFAULT_OPPONENT_DEATH_RATE = 0.15;

/**
 * Mutation odds for an evolvable survivor, scaled by its fitness percentile
 * within the evolvable survivors (same shape as the candidate GA's
 * floor->ceil ramp, so the opponents that are actually beating candidates are
 * the ones that spawn variants). Both numbers are ~4-5x below the candidate
 * GA's 0.05 -> 0.40 -- "a lower rate in general for opponent teams" (Jaxon).
 */
export const DEFAULT_OPPONENT_MUTATION_FLOOR = 0.02;
export const DEFAULT_OPPONENT_MUTATION_CEIL = 0.2;

/**
 * Mutation odds for a CURATED survivor -- a flat, deliberately tiny rate,
 * lower than any evolvable entry's ("and then even lower for curated teams
 * ... since I still want the opponent pool to reflect on-the-ground team
 * realities", Jaxon). Flat rather than percentile-scaled because a curated
 * team is an anchor, not a hill-climber: how well it happened to do against
 * this generation's candidates should not decide whether it throws off a
 * variant. The curated parent itself always survives regardless (see the
 * WHAT IS PROTECTED note above).
 */
export const DEFAULT_CURATED_MUTATION_RATE = 0.03;

/** Of the mutations that fire, this share are lead rotations (promote a back to lead) rather than member swaps -- same split and same rationale as src/teams/evolve.js's DEFAULT_LEAD_ROTATION_RATE. */
export const DEFAULT_OPPONENT_LEAD_ROTATION_RATE = 0.3;

/**
 * Of the mutations that fire (after the lead-rotation roll), this share
 * become a SHADOW-FLIP instead of a member-swap -- same mutation type,
 * same all-non-empty-combinations-equally-likely rule, as
 * src/teams/evolve.js's DEFAULT_SHADOW_FLIP_RATE (added here for mutation-
 * vocabulary parity, plans/PLAN.md Item 2: the opponent pool previously had
 * no shadow-flip mutation at all, so a shadow-boosted variant of an
 * opponent could only ever arise from a fresh sampled/immigrant draw, never
 * from mutating an already-successful build the way a candidate can).
 */
export const DEFAULT_OPPONENT_SHADOW_FLIP_RATE = 0.2;

/** Share of the evolvable portion always reserved for fresh immigrants, so the gene pool never closes even if nothing mutates. */
export const DEFAULT_OPPONENT_IMMIGRANT_FRACTION = 0.08;

// Bounded retries when a mutant/immigrant collides with a team already in the
// pool -- same graceful-shortfall pattern as src/teams/sample.js.
const MAX_ATTEMPTS_MULTIPLIER = 20;
const MAX_ATTEMPTS_FLOOR = 50;

/** Origins that are never culled and never modified in place. */
const PROTECTED_ORIGINS = new Set(['curated']);

/**
 * @typedef {object} OpponentEntry
 * @property {string} id - unique within the pool; a curated team's own id, or
 *   `sampled-<lead>-<back>-<back>` for a composed one. Positional, so the same
 *   three species with a different lead is a different entry.
 * @property {string} name
 * @property {import('./teams.js').MetaMon[]} members - exactly 3, `members[0]` is the lead.
 * @property {0} leadIndex - always 0; the lead is rotated into slot 0 at composition time.
 * @property {'curated'|'sampled'|'mutant'|'curated-mutant'|'immigrant'} origin
 * @property {string} label - same string as `origin` (what the report prints).
 * @property {string} [tier] - curated only, from data/meta-teams-community.json.
 * @property {string} [parentId] - mutants only: the entry this was derived from.
 */

/** Is this entry ground truth (never culled, never modified in place)? */
export function isProtectedOpponent(entry) {
  return PROTECTED_ORIGINS.has(entry.origin);
}

/** Normalize a curated MetaTeam into an OpponentEntry. */
function curatedEntry(team) {
  return {
    id: team.id,
    name: team.name,
    members: team.members,
    leadIndex: team.leadIndex ?? 0,
    origin: 'curated',
    label: 'curated',
    tier: team.tier,
    curatedId: team.id,
  };
}

/**
 * How many curated entries a pool of `size` should hold, capped by how many
 * curated teams exist. Kept in one place so the gen-0 draw and every later
 * top-up agree exactly.
 */
export function curatedHeadcount(size, curatedRatio, curatedPoolSize) {
  return Math.min(Math.round(size * curatedRatio), curatedPoolSize, size);
}

/**
 * Build generation 0's opponent pool: a tier-weighted curated draw plus
 * meta-weighted composed teams, every entry lead-ordered and origin-tagged.
 *
 * @param {object} ctx
 * @param {{
 *   size: number, weights: Map<string, number>, curated: import('./teams.js').MetaTeam[],
 *   curatedRatio: number, roleScores?: Map<string, {lead:number}>,
 *   metaPoolSize?: number, movesetPool?: Array<object>, seed?: number|string,
 * }} params
 * @returns {OpponentEntry[]}
 */
export function initOpponentPool(ctx, params) {
  const { size, weights, curated, curatedRatio, roleScores, metaPoolSize, seed } = params;
  const rng = rngFromSeed(seed, 'initOpponentPool');
  const movesetPool = params.movesetPool ?? loadMovesetPool(ctx, { metaPoolSize });

  const curatedCount = curatedHeadcount(size, curatedRatio, curated.length);
  const chosen = pickWeighted(rng, curated, curatedTierWeight, curatedCount).map(curatedEntry);

  const used = new Set(chosen.map((e) => e.id));
  const pool = [...chosen];
  const maxAttempts = (size - chosen.length) * MAX_ATTEMPTS_MULTIPLIER + MAX_ATTEMPTS_FLOOR;
  let attempts = 0;
  while (pool.length < size && attempts < maxAttempts) {
    attempts += 1;
    const team = composeSampledOpponent(ctx, rng, movesetPool, weights, roleScores);
    // Gen-0 identity is the unordered species set, the candidate side's
    // initPopulation rule (src/teams/sample.js dedupes the trio BEFORE a lead
    // is assigned), so neither side starts with two leads of one trio.
    const setKey = team.members.map((m) => m.speciesId).sort().join('|');
    if (used.has(setKey)) continue;
    used.add(setKey);
    pool.push({ ...team, origin: 'sampled', label: 'sampled' });
  }
  return pool;
}

/**
 * Build one member-swap mutant of `parent`: replace a uniform-random slot
 * (the lead slot included -- swapping WHO the lead is, without changing the
 * species, is the separate lead-rotation mutation below) with a fresh
 * meta-pool draw that shares no base species with the two members kept.
 * Returns a new entry or `null` if every bounded attempt collided.
 */
/**
 * Lead-aware identity of an opponent entry: the lead's speciesId, then the two
 * backs sorted -- the same rule as src/teams/evolve.js teamSignature, so both
 * sides agree on when two teams are the same individual.
 */
export function opponentSignature(entry) {
  const ids = entry.members.map((m) => m.speciesId);
  return `${ids[0]}||${ids.slice(1).sort().join('|')}`;
}

function buildMemberSwap(ctx, parent, movesetPool, weights, accept, rng, maxAttempts) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const slot = Math.floor(rng() * TEAM_SIZE) % TEAM_SIZE;
    // Every current member's base species is excluded, the replaced one
    // included -- the candidate side's rule (a swap brings in a DIFFERENT
    // species; changing only shadow state is the shadowFlip mutation's job).
    const excludeBaseIds = new Set(parent.members.map((m) => baseIdOf(m.speciesId)));
    const eligible = movesetPool.filter(
      (e) => !excludeBaseIds.has(baseIdOf(e.speciesId)) && (weights.get(e.speciesId) ?? 0) > 0
    );
    if (eligible.length === 0) return null;
    const [pick] = pickWeighted(rng, eligible, (e) => weights.get(e.speciesId) ?? 0, 1);
    if (!pick) return null;
    let built;
    try {
      built = buildMetaMon(ctx, pick);
    } catch {
      continue; // rare gamemaster edge case -- redraw
    }
    const members = parent.members.slice();
    members[slot] = built;
    const { id, name } = describeSampledTeam(ctx, members);
    if (!accept({ id, members })) continue;
    return { id, name, members, leadIndex: 0, parentId: parent.id, swappedSlot: slot };
  }
  return null;
}

/**
 * Build one lead-rotation mutant of `parent`: promote a random back into slot
 * 0. Same three species, a different designated lead, therefore a different
 * entry. There are only two possible rotations, so this exhausts fast.
 */
function buildLeadRotation(ctx, parent, accept, rng, maxAttempts) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const promoted = BACK_SLOTS[Math.floor(rng() * BACK_SLOTS.length) % BACK_SLOTS.length];
    const members = orderMembersByLead(parent.members, promoted);
    const { id, name } = describeSampledTeam(ctx, members);
    if (!accept({ id, members })) continue;
    return { id, name, members, leadIndex: 0, parentId: parent.id, promotedSlot: promoted };
  }
  return null;
}

/**
 * For every base speciesId the movesetPool holds in BOTH shadow and
 * non-shadow form, the two speciesIds paired -- the opponent-side twin
 * lookup for the shadowFlip mutation, parallel to evolve.js's
 * `buildShadowTwins` (which pairs matrix KEYS; the opponent pool has no
 * matrix, so this pairs speciesIds directly out of the movesetPool that
 * already composes every opponent).
 */
function buildOpponentShadowTwins(movesetPool) {
  const bySpecies = new Map();
  for (const entry of movesetPool) {
    const shadow = entry.speciesId.endsWith('_shadow');
    const base = baseIdOf(entry.speciesId);
    const group = bySpecies.get(base) ?? { shadow: null, plain: null };
    group[shadow ? 'shadow' : 'plain'] ??= entry.speciesId;
    bySpecies.set(base, group);
  }
  const twins = new Map();
  for (const { shadow, plain } of bySpecies.values()) {
    if (shadow && plain) {
      twins.set(shadow, plain);
      twins.set(plain, shadow);
    }
  }
  return twins;
}

/**
 * Build one shadow-flip mutant of `parent`: among slots whose species has an
 * opposite-shadow twin in the pool (`shadowTwins`), pick a uniform-random
 * non-empty subset (every combination equally likely, same rule as
 * evolve.js's `buildShadowFlip`) and rebuild each chosen member at its twin
 * speciesId with the SAME moveset (only the shadow state changes). Returns
 * `null` if no member is flippable, a rebuild throws (rare gamemaster edge
 * case), or every attempted combination collides with a used id.
 */
function buildOpponentShadowFlip(ctx, parent, shadowTwins, accept, rng, maxAttempts) {
  const flippable = [];
  parent.members.forEach((m, slot) => {
    if (shadowTwins.has(m.speciesId)) flippable.push(slot);
  });
  if (flippable.length === 0) return null;
  const combos = 2 ** flippable.length - 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const mask = 1 + (Math.floor(rng() * combos) % combos); // 1..combos, never the empty set
    const flippedSlots = flippable.filter((_, bit) => mask & (1 << bit));
    const members = parent.members.slice();
    let ok = true;
    for (const slot of flippedSlots) {
      const twinSpeciesId = shadowTwins.get(parent.members[slot].speciesId);
      try {
        members[slot] = buildMetaMon(ctx, {
          speciesId: twinSpeciesId,
          fastMove: parent.members[slot].fastMove,
          chargedMoves: parent.members[slot].chargedMoves,
        });
      } catch {
        ok = false;
        break; // rare gamemaster edge case -- retry a different combination
      }
    }
    if (!ok) continue;
    const { id, name } = describeSampledTeam(ctx, members);
    if (!accept({ id, members })) continue;
    return { id, name, members, leadIndex: 0, parentId: parent.id, flippedSlots };
  }
  return null;
}

/** A mutant's origin: curated parents produce a distinctly-labeled lineage so the report can tell "a real team, tweaked" from "a composed team, tweaked". */
function mutantOrigin(parent) {
  return parent.origin === 'curated' || parent.origin === 'curated-mutant' ? 'curated-mutant' : 'mutant';
}

/**
 * Advance the opponent pool one generation.
 *
 * Order of operations: (1) curated entries are set aside untouched and topped
 * up to `curatedRatio` of `targetSize`; (2) the evolvable remainder is ranked
 * by fitness and the worst are culled -- both the `deathRate` share and any
 * extra needed to hit `targetSize`; (3) survivors (curated included, as
 * PARENTS only) roll for mutation at their origin's rate; (4) whatever slots
 * are still open take fresh immigrants.
 *
 * @param {object} ctx
 * @param {{
 *   pool: OpponentEntry[],
 *   fitness: number[],            - parallel to `pool`; higher = beat candidates harder.
 *   targetSize: number,
 *   weights: Map<string, number>,
 *   curated: import('./teams.js').MetaTeam[],
 *   curatedRatio: number,
 *   roleScores?: Map<string, {lead:number}>,
 *   metaPoolSize?: number,
 *   movesetPool?: Array<object>,
 *   seed?: number|string,
 *   opts?: {
 *     deathRate?: number, mutationFloor?: number, mutationCeil?: number,
 *     curatedMutationRate?: number, leadRotationRate?: number, shadowFlipRate?: number,
 *     immigrantFraction?: number, coreRivalry?: number, similarRivalry?: number,
 *     similarFloor?: number, similarity?: (a: object, b: object) => number,
 *   },
 * }} params -- `opts.coreRivalry` (default DEFAULT_CORE_RIVALRY, 0 disables)
 *   penalises each evolvable entry per better evolvable entry sharing a
 *   two-species core -- or a similar core by pvpoke's similarity of the
 *   built members (`opts.similarity`, a src/engine/similarity.js
 *   createSimilarity scorer, built on demand when absent; `opts.similarFloor`
 *   / `opts.similarRivalry`, defaults DEFAULT_SIMILAR_FLOOR /
 *   DEFAULT_SIMILAR_RIVALRY), e.g. Tinkaton/Empoleon vs Tinkaton/Feraligatr
 *   -- before the cull ranks it (src/meta/archetypes.js
 *   coreRivalryFitness), so a bred counter core keeps only the variants
 *   that out-fight the rest of the pool on their own merits.
 * @returns {{pool: OpponentEntry[], lineage: {died: number[], coreRivalryDied: number[], originCounts: object}}}
 *   `lineage.died` lists indices into the INPUT `pool`, worst-fitness first
 *   (an exact positional duplicate of a fitter evolvable entry is included
 *   whatever its rank -- coreRivalryFitness's duplicate cull, curated exempt);
 *   `coreRivalryDied` the subset that only died because of the core penalty.
 *   The returned pool is held at `targetSize` unless the meta pool is too
 *   small to supply enough distinct teams, in which case it falls short
 *   gracefully rather than throwing.
 */
export function nextOpponentPool(ctx, params) {
  const {
    pool,
    fitness,
    targetSize,
    weights,
    curated,
    curatedRatio,
    roleScores,
    metaPoolSize,
    seed,
    opts = {},
  } = params;
  const deathRate = opts.deathRate ?? DEFAULT_OPPONENT_DEATH_RATE;
  const mutationFloor = opts.mutationFloor ?? DEFAULT_OPPONENT_MUTATION_FLOOR;
  const mutationCeil = opts.mutationCeil ?? DEFAULT_OPPONENT_MUTATION_CEIL;
  const curatedMutationRate = opts.curatedMutationRate ?? DEFAULT_CURATED_MUTATION_RATE;
  const leadRotationRate = opts.leadRotationRate ?? DEFAULT_OPPONENT_LEAD_ROTATION_RATE;
  const shadowFlipRate = opts.shadowFlipRate ?? DEFAULT_OPPONENT_SHADOW_FLIP_RATE;
  const immigrantFraction = opts.immigrantFraction ?? DEFAULT_OPPONENT_IMMIGRANT_FRACTION;
  const coreRivalry = opts.coreRivalry ?? DEFAULT_CORE_RIVALRY;
  const similarRivalry = opts.similarRivalry ?? DEFAULT_SIMILAR_RIVALRY;
  const similarFloor = opts.similarFloor ?? DEFAULT_SIMILAR_FLOOR;

  const rng = rngFromSeed(seed, 'nextOpponentPool');
  const movesetPool = params.movesetPool ?? loadMovesetPool(ctx, { metaPoolSize });
  const shadowTwins = buildOpponentShadowTwins(movesetPool);

  // ---- (1) curated: never culled, topped up to the ratio ------------------
  const curatedKept = pool.filter(isProtectedOpponent);
  const curatedTarget = curatedHeadcount(targetSize, curatedRatio, curated.length);
  const curatedAdded = [];
  if (curatedKept.length < curatedTarget) {
    const heldIds = new Set(curatedKept.map((e) => e.curatedId ?? e.id));
    const available = curated.filter((t) => !heldIds.has(t.id));
    for (const team of pickWeighted(rng, available, curatedTierWeight, curatedTarget - curatedKept.length)) {
      curatedAdded.push(curatedEntry(team));
    }
  }
  // Curated entries are never culled, but they also cannot overflow a pool the
  // caller asked to shrink below the curated headcount (only reachable by
  // reconfiguring a run mid-flight -- scripts/evolve.mjs's schedule only ever
  // grows the opponent pool). Trim from the tail, which is the most recently
  // topped-up (and therefore lowest-priority) end.
  const curatedOut = [...curatedKept, ...curatedAdded].slice(0, Math.max(0, targetSize));

  // ---- (2) evolvable entries: the shared generation step ------------------
  // src/ga/core.js evolveStep does rivalry ranking, cull, mutation roll, seat
  // split, fill and dedupe -- the same function the candidate side calls.
  // This side's adapter: an entry is identified by opponentSignature (lead +
  // sorted backs, the candidate side's teamSignature rule), mutants and
  // immigrants are composed from the meta moveset pool. Curated entries are
  // protected input data: never ranked or culled, they only parent mutants at
  // the flat curatedMutationRate and reserve their identities.
  const evolvableIdx = pool.map((_, i) => i).filter((i) => !isProtectedOpponent(pool[i]));
  const similarity = coreRivalry > 0 && similarRivalry > 0 ? opts.similarity ?? createSimilarity() : null;
  const evolvableTarget = Math.max(0, targetSize - curatedOut.length);
  const adapter = {
    profilesOf: opponentProfiles,
    signatureOf: opponentSignature,
    buildMutant(parent, type, accept, mrng, maxAttempts) {
      const built =
        type === 'leadRotation'
          ? buildLeadRotation(ctx, parent, accept, mrng, maxAttempts)
          : type === 'shadowFlip'
            ? buildOpponentShadowFlip(ctx, parent, shadowTwins, accept, mrng, maxAttempts)
            : buildMemberSwap(ctx, parent, movesetPool, weights, accept, mrng, maxAttempts);
      return built && { entry: built };
    },
    *immigrants(budget, irng) {
      for (let i = 0; i < budget; i++) yield composeSampledOpponent(ctx, irng, movesetPool, weights, roleScores);
    },
  };
  const step = evolveStep({
    entries: evolvableIdx.map((i) => pool[i]),
    fitness: evolvableIdx.map((i) => fitness[i]),
    targetSize: evolvableTarget,
    rng,
    rates: { deathRate, mutationFloor, mutationCeil, leadRotationRate, shadowFlipRate, immigrantFraction },
    rivalry: { coreRivalry, similar: similarRivalry, floor: similarFloor, similarity },
    adapter,
    extraParents: curatedOut,
    extraParentRate: curatedMutationRate,
    reserved: curatedOut.map(opponentSignature),
  });
  const died = step.died.map((k) => evolvableIdx[k]);
  const coreRivalryDied = step.coreRivalryDied.map((k) => evolvableIdx[k]);
  const survivorsOut = step.survivorIdx.map((k) => pool[evolvableIdx[k]]);
  const mutants = step.mutants.map(({ entry, parent }) => {
    const origin = mutantOrigin(parent);
    return { ...entry, origin, label: origin };
  });
  const immigrants = step.immigrants.map((team) => ({ ...team, origin: 'immigrant', label: 'immigrant' }));

  const nextPool = [...curatedOut, ...survivorsOut, ...mutants, ...immigrants];
  const originCounts = {};
  for (const e of nextPool) originCounts[e.origin] = (originCounts[e.origin] ?? 0) + 1;
  return { pool: nextPool, lineage: { died, coreRivalryDied, originCounts } };
}

/**
 * Plain-JSON form of an opponent pool, for a scripts/evolve.mjs checkpoint.
 * Built pvpoke Pokemon instances cannot be serialized, so each member is
 * reduced to the (speciesId, resolved moveset) triple `buildMetaMon` needs to
 * rebuild it byte-identically.
 *
 * @param {OpponentEntry[]} pool
 * @returns {Array<object>}
 */
export function serializeOpponentPool(pool) {
  return pool.map((e) => ({
    id: e.id,
    name: e.name,
    origin: e.origin,
    label: e.label,
    leadIndex: e.leadIndex ?? 0,
    tier: e.tier ?? null,
    curatedId: e.curatedId ?? null,
    parentId: e.parentId ?? null,
    members: e.members.map((m) => ({
      speciesId: m.speciesId,
      fastMove: m.fastMove,
      chargedMoves: m.chargedMoves,
    })),
  }));
}

/**
 * Inverse of {@link serializeOpponentPool}. A curated entry is re-resolved
 * from the live curated pool by id so it keeps that pool's exact build
 * (movesets, tier, lead) rather than a round-tripped copy; if the id is gone
 * (someone edited data/meta-teams-community.json between runs) it is rebuilt
 * from the stored movesets and a warning is written, rather than dropping the
 * team and silently shrinking the pool.
 *
 * @param {object} ctx
 * @param {Array<object>} serialized
 * @param {import('./teams.js').MetaTeam[]} curated
 * @param {(msg:string)=>void} [onLog]
 * @returns {OpponentEntry[]}
 */
export function rehydrateOpponentPool(ctx, serialized, curated, onLog) {
  const byId = new Map(curated.map((t) => [t.id, t]));
  return serialized.map((e) => {
    if (e.origin === 'curated' && e.curatedId && byId.has(e.curatedId)) {
      return curatedEntry(byId.get(e.curatedId));
    }
    if (e.origin === 'curated') {
      onLog?.(`opponent pool: curated team "${e.curatedId ?? e.id}" is no longer in the curated pool -- rebuilding it from the checkpoint's stored movesets`);
    }
    const members = e.members.map((m) => buildMetaMon(ctx, m));
    return {
      id: e.id,
      name: e.name,
      members,
      leadIndex: e.leadIndex ?? 0,
      origin: e.origin,
      label: e.label ?? e.origin,
      ...(e.tier ? { tier: e.tier } : {}),
      ...(e.curatedId ? { curatedId: e.curatedId } : {}),
      ...(e.parentId ? { parentId: e.parentId } : {}),
    };
  });
}
