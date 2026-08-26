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
    if (used.has(team.id)) continue;
    used.add(team.id);
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
function buildMemberSwap(ctx, parent, movesetPool, weights, usedIds, rng, maxAttempts) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const slot = Math.floor(rng() * TEAM_SIZE) % TEAM_SIZE;
    const kept = parent.members.filter((_, i) => i !== slot);
    const excludeBaseIds = new Set(kept.map((m) => baseIdOf(m.speciesId)));
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
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    return { id, name, members, leadIndex: 0, parentId: parent.id, swappedSlot: slot };
  }
  return null;
}

/**
 * Build one lead-rotation mutant of `parent`: promote a random back into slot
 * 0. Same three species, a different designated lead, therefore a different
 * entry. There are only two possible rotations, so this exhausts fast.
 */
function buildLeadRotation(ctx, parent, usedIds, rng, maxAttempts) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const promoted = BACK_SLOTS[Math.floor(rng() * BACK_SLOTS.length) % BACK_SLOTS.length];
    const members = orderMembersByLead(parent.members, promoted);
    const { id, name } = describeSampledTeam(ctx, members);
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    return { id, name, members, leadIndex: 0, parentId: parent.id, promotedSlot: promoted };
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
 *     curatedMutationRate?: number, leadRotationRate?: number,
 *     immigrantFraction?: number,
 *   },
 * }} params
 * @returns {{pool: OpponentEntry[], lineage: {died: number[], originCounts: object}}}
 *   `lineage.died` lists indices into the INPUT `pool`, worst-fitness first.
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
  const immigrantFraction = opts.immigrantFraction ?? DEFAULT_OPPONENT_IMMIGRANT_FRACTION;

  const rng = rngFromSeed(seed, 'nextOpponentPool');
  const movesetPool = params.movesetPool ?? loadMovesetPool(ctx, { metaPoolSize });

  // ---- (1) curated: never culled, topped up to the ratio ------------------
  const curatedKept = pool.filter(isProtectedOpponent);
  const curatedTarget = curatedHeadcount(targetSize, curatedRatio, curated.length);
  const usedIds = new Set(pool.map((e) => e.id));
  const curatedAdded = [];
  if (curatedKept.length < curatedTarget) {
    const heldIds = new Set(curatedKept.map((e) => e.curatedId ?? e.id));
    const available = curated.filter((t) => !heldIds.has(t.id));
    for (const team of pickWeighted(rng, available, curatedTierWeight, curatedTarget - curatedKept.length)) {
      curatedAdded.push(curatedEntry(team));
      usedIds.add(team.id);
    }
  }
  // Curated entries are never culled, but they also cannot overflow a pool the
  // caller asked to shrink below the curated headcount (only reachable by
  // reconfiguring a run mid-flight -- scripts/evolve.mjs's schedule only ever
  // grows the opponent pool). Trim from the tail, which is the most recently
  // topped-up (and therefore lowest-priority) end.
  const curatedOut = [...curatedKept, ...curatedAdded].slice(0, Math.max(0, targetSize));

  // ---- (2) evolvable: rank worst-first, cull -------------------------------
  const evolvableIdx = pool.map((_, i) => i).filter((i) => !isProtectedOpponent(pool[i]));
  const rankedWorstFirst = evolvableIdx.slice().sort((a, b) => fitness[a] - fitness[b] || a - b);
  const evolvableTarget = Math.max(0, targetSize - curatedOut.length);
  // The churn is a share of who is ALIVE NOW, not of the target -- the
  // opponent pool grows over a run (scripts/evolve.mjs trades candidate slots
  // for opponent slots), and taking the share of the target would make
  // `survivorsKept` exceed the live population and clamp the cull to zero in
  // every growing generation, i.e. never. On top of that, a target smaller
  // than the survivors trims the extra: `deathCount` is whichever of the two
  // pressures binds.
  const churn = Math.round(deathRate * rankedWorstFirst.length);
  const survivorsKept = Math.max(0, Math.min(rankedWorstFirst.length - churn, evolvableTarget));
  const deathCount = rankedWorstFirst.length - survivorsKept;
  const died = rankedWorstFirst.slice(0, deathCount);
  const survivorIdxAsc = rankedWorstFirst.slice(deathCount); // worst-to-best among survivors
  const survivorsOut = survivorIdxAsc
    .slice()
    .sort((a, b) => a - b)
    .map((i) => pool[i]);

  const openSlots = Math.max(0, evolvableTarget - survivorsOut.length);
  // `usedIds` deliberately still holds the ids of the teams just culled: a
  // mutant or immigrant must not re-create, this same generation, a team the
  // cull just decided was the pool's weakest. They become drawable again next
  // generation, when `usedIds` is rebuilt from the surviving pool.

  // ---- (3) mutation: evolvable survivors ramp with fitness percentile,
  //          curated parents roll a flat (much lower) rate ------------------
  const rolls = [];
  const n = survivorIdxAsc.length;
  survivorIdxAsc.forEach((idx, rank) => {
    const percentile = n <= 1 ? 1 : rank / (n - 1);
    const chance = mutationFloor + (mutationCeil - mutationFloor) * percentile;
    if (rng() < chance) rolls.push({ parent: pool[idx], percentile, type: rng() < leadRotationRate ? 'leadRotation' : 'memberSwap' });
  });
  for (const parent of curatedOut) {
    if (rng() < curatedMutationRate) {
      rolls.push({ parent, percentile: 0, type: rng() < leadRotationRate ? 'leadRotation' : 'memberSwap' });
    }
  }

  // Immigrants get a reserved share of the open slots so fresh blood keeps
  // arriving whatever else happens; mutants take the rest. `Math.floor`, not
  // `Math.round`, because at this pool's scale rounding the reserve UP is what
  // starves mutation outright: a default run's evolvable half is ~7 entries,
  // the 15% cull opens exactly 1 seat, and a rounded 8% reserve claims it --
  // so no opponent would ever mutate at the shipped settings. And if a roll
  // does fire with no seat left for it, it borrows one from the reserve:
  // immigrants are the fallback filler at step (4) and refill whatever the
  // mutants don't use, so the reserve only ever needs to bind the other way.
  const immigrantFloor = Math.min(openSlots, Math.floor(immigrantFraction * evolvableTarget));
  let mutantSlots = Math.max(0, openSlots - immigrantFloor);
  if (mutantSlots === 0 && openSlots > 0 && rolls.length > 0) mutantSlots = 1;
  const chosenRolls =
    rolls.length > mutantSlots
      ? rolls.slice().sort((a, b) => b.percentile - a.percentile).slice(0, mutantSlots)
      : rolls;

  const maxAttempts = Math.max(chosenRolls.length, 1) * MAX_ATTEMPTS_MULTIPLIER + MAX_ATTEMPTS_FLOOR;
  const mutants = [];
  for (const { parent, type } of chosenRolls) {
    const built =
      type === 'leadRotation'
        ? buildLeadRotation(ctx, parent, usedIds, rng, maxAttempts)
        : buildMemberSwap(ctx, parent, movesetPool, weights, usedIds, rng, maxAttempts);
    if (!built) continue; // bounded retries exhausted -- graceful shortfall
    const origin = mutantOrigin(parent);
    mutants.push({ ...built, origin, label: origin });
  }

  // ---- (4) immigrants fill whatever is left --------------------------------
  const immigrantTarget = Math.max(0, openSlots - mutants.length);
  const immigrants = [];
  const immigrantAttempts = immigrantTarget * MAX_ATTEMPTS_MULTIPLIER + MAX_ATTEMPTS_FLOOR;
  let attempts = 0;
  while (immigrants.length < immigrantTarget && attempts < immigrantAttempts) {
    attempts += 1;
    const team = composeSampledOpponent(ctx, rng, movesetPool, weights, roleScores);
    if (usedIds.has(team.id)) continue;
    usedIds.add(team.id);
    immigrants.push({ ...team, origin: 'immigrant', label: 'immigrant' });
  }

  const nextPool = [...curatedOut, ...survivorsOut, ...mutants, ...immigrants];
  const originCounts = {};
  for (const e of nextPool) originCounts[e.origin] = (originCounts[e.origin] ?? 0) + 1;
  return { pool: nextPool, lineage: { died, originCounts } };
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
