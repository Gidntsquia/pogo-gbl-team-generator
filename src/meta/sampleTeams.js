// JavaScript Document
//
// Weighted opponent-team sampler. Builds the
// opponent side of the sampling initiative: a mixture of pvpoke's own curated
// teams for the run's CP cap (src/meta/teams.js) plus randomly-composed 3-mon teams
// drawn from a META-CAPPED species pool, weighted toward the current meta via
// src/meta/usage.js's per-species weights.
//
// No battle math here -- movesets are read verbatim from pvpoke's own
// vendored rankings file (the same "recommended moveset" pvpoke's own UI
// shows) and applied via src/scoring/index.js's buildMetaMon, which itself
// only calls pvpoke's own Pokemon#selectMove/#resetMoves. The only new logic
// in this file is which species get chosen and in what order -- pure
// sampling machinery (src/util/rng.js), not simulation.
//
// META-CAPPED POOL (Jaxon 2026-08-26): the sampled half used to draw from the
// FULL rankings field (1,144 species at cp 1500). Weighting alone does not
// make that field "meta": at src/meta/usage.js's gamma of 2.5 the top 50
// species hold only ~7.3% of the total sampling weight, so the long tail
// collectively dominates every draw and a typical sampled opponent was three
// fringe picks around rank ~450 (score ~77). Candidate teams then overfit to
// the curated half, because the curated half was the only part of the
// opponent pool that was actually strong. The pool is now capped to the top
// `metaPoolSize` species by pvpoke's own overall ranking score (default 100,
// which is a score floor of ~87 at cp 1500) BEFORE the usage weights are
// applied -- the cap decides "is this a mon anyone plays", the weights still
// decide "how often, among those". Pass `metaPoolSize: 0` for the old
// full-field behavior.
//
// DESIGNATED LEADS: every returned team -- curated and sampled alike -- now
// carries `members[0] === the lead` and an explicit `leadIndex: 0`. Curated
// teams already worked that way (src/meta/teams.js's file-wide
// member-index-0-is-lead doctrine). A sampled team's lead used to be picked
// by whichever driver consumed it (scripts/evolve.mjs seeded a random one off
// the team id); it is now chosen HERE, at composition time, from pvpoke's own
// published `leads` role rankings when the caller supplies `roleScores` (the
// member with the highest lead prior is rotated into slot 0), and by a seeded
// random draw otherwise. That makes the lead part of the team's identity --
// which is what lets src/meta/opponentPool.js evolve it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildMetaMon } from '../scoring/index.js';
import { loadMetaTeams, curatedTierWeight } from './teams.js';
import { pickWeighted, rngFromSeed } from '../util/rng.js';

const DEFAULT_CURATED_RATIO = 0.4;
const TEAM_SIZE = 3;
const SHADOW_SUFFIX = '_shadow';

/**
 * How many species the sampled half may draw from, taken off the top of
 * pvpoke's own overall ranking for the run's CP cap. See the META-CAPPED POOL
 * note above for why a cap (rather than a sharper weight exponent) is the
 * right knob. 0 (or a negative value) disables the cap entirely.
 */
export const DEFAULT_META_POOL_SIZE = 100;

/** Strip the "_shadow" suffix pvpoke uses to key shadow variants, so base/shadow forms of the same species count as one species for dedup purposes (matches the team evaluator's rule). */
export function baseIdOf(speciesId) {
  return speciesId.endsWith(SHADOW_SUFFIX) ? speciesId.slice(0, -SHADOW_SUFFIX.length) : speciesId;
}

function titleCase(part) {
  return part
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Prefer pvpoke's own gamemaster display name, falling back to a title-cased speciesId. */
export function displayName(ctx, metaMon) {
  const data = ctx.gm.getPokemonById(metaMon.pokemon.speciesId);
  return data?.speciesName ?? titleCase(metaMon.speciesId);
}

/**
 * The moveset-having species pool a sampled opponent team is composed from:
 * entries in pvpoke's own vendored rankings file for ctx.cp, mapped to a
 * buildMetaMon-ready `{speciesId, fastMove, chargedMoves, score}` using that
 * entry's own `moveset` field (pvpoke's own top recommended moveset -- the
 * same field pvpoke's rankings UI shows, not a heuristic reimplemented here),
 * capped to the top `metaPoolSize` by pvpoke's own `score`.
 *
 * The vendored file is already sorted by score descending, but this sorts
 * defensively anyway so the cap means the same thing regardless of the
 * on-disk order of a caller-supplied `rankingsEntries`.
 *
 * @param {object} ctx - from initEngine (src/engine/harness.js)
 * @param {{ rankingsFile?: string, rankingsEntries?: Array<object>, metaPoolSize?: number }} [opts]
 * @returns {Array<{speciesId: string, fastMove: string, chargedMoves: string[], score: number}>}
 */
export function loadMovesetPool(ctx, opts = {}) {
  // Rankings file follows ctx.cp so a `--cp 2500` run composes
  // opponents from Ultra League movesets, not Great League ones.
  const rankingsFile = opts.rankingsFile ?? `src/data/rankings/all/overall/rankings-${ctx.cp}.json`;
  const raw =
    opts.rankingsEntries ?? JSON.parse(readFileSync(path.join(ctx.vendorRoot, rankingsFile), 'utf8'));
  const pool = [];
  for (const entry of raw) {
    const moveset = entry.moveset;
    if (!Array.isArray(moveset) || moveset.length < 2) continue;
    pool.push({
      speciesId: entry.speciesId,
      fastMove: moveset[0],
      chargedMoves: moveset.slice(1),
      score: typeof entry.score === 'number' ? entry.score : 0,
    });
  }
  pool.sort((a, b) => b.score - a.score || (a.speciesId < b.speciesId ? -1 : a.speciesId > b.speciesId ? 1 : 0));
  const cap = opts.metaPoolSize ?? DEFAULT_META_POOL_SIZE;
  return cap > 0 ? pool.slice(0, cap) : pool;
}

/**
 * Which member of an unordered built trio should lead, as an index into
 * `members`. With `roleScores` (src/meta/roles.js's loader) this is the member
 * carrying the highest `lead` prior from pvpoke's OWN published leads
 * rankings -- a real answer to "who leads this team", not a coin flip. Without
 * it, a seeded-random slot, so the function is still total and still
 * deterministic. Ties break to the lowest index.
 *
 * @param {import('./teams.js').MetaMon[]} members
 * @param {Map<string, {lead:number}>|null|undefined} roleScores
 * @param {() => number} rng
 * @returns {number}
 */
export function pickLeadIndex(members, roleScores, rng) {
  if (!roleScores) return Math.floor(rng() * members.length) % members.length;
  let bestIdx = 0;
  let bestScore = -Infinity;
  members.forEach((m, i) => {
    const score = roleScores.get(m.speciesId)?.lead ?? 0;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  });
  return bestIdx;
}

/** Rotate `leadIndex` into slot 0 (swapping with whatever was there), so `members[0]` is always the lead. */
export function orderMembersByLead(members, leadIndex) {
  if (leadIndex === 0) return members.slice();
  const ordered = members.slice();
  [ordered[0], ordered[leadIndex]] = [ordered[leadIndex], ordered[0]];
  return ordered;
}

/** Stable id + display name for a lead-ordered sampled trio. Positional, so the SAME three species with a DIFFERENT lead is a different id -- which is the point: the lead is part of the team's identity. */
export function describeSampledTeam(ctx, members) {
  return {
    id: `sampled-${members.map((m) => m.speciesId).join('-')}`,
    name: members.map((m) => displayName(ctx, m)).join(' / '),
  };
}

/**
 * Compose one random 3-mon team from `pool`, weighted by `weights` (a
 * Map<speciesId, number> from loadUsageWeights), with no two members sharing
 * a base species (shadow/base = same species). A pool entry that fails to
 * build (e.g. a gamemaster edge case) is dropped from further consideration
 * and a replacement is drawn -- "skip-and-resample", never a
 * hard crash on one bad species.
 *
 * @param {object} ctx
 * @param {() => number} rng
 * @param {Array<{speciesId: string, fastMove: string, chargedMoves: string[]}>} pool
 * @param {Map<string, number>} weights
 * @param {{ excludeBaseIds?: Set<string>, size?: number }} [opts]
 *   `excludeBaseIds` additionally bars those base species (used by the
 *   opponent GA's member-swap mutation, which must not re-draw a species the
 *   surviving two members already carry).
 * @returns {import('./teams.js').MetaMon[]} exactly `size` (default TEAM_SIZE) built members.
 */
export function composeSampledTeam(ctx, rng, pool, weights, opts = {}) {
  const size = opts.size ?? TEAM_SIZE;
  let available = pool.filter((e) => (weights.get(e.speciesId) ?? 0) > 0);
  const chosenBaseIds = new Set(opts.excludeBaseIds ?? []);
  const members = [];

  while (members.length < size) {
    const candidates = available.filter((e) => !chosenBaseIds.has(baseIdOf(e.speciesId)));
    if (candidates.length === 0) {
      throw new Error(
        `sampleOpponentTeams: ran out of distinct-species candidates while composing a team (${members.length}/${size} built)`
      );
    }
    const [pick] = pickWeighted(rng, candidates, (e) => weights.get(e.speciesId) ?? 0, 1);
    try {
      const built = buildMetaMon(ctx, pick);
      members.push(built);
      chosenBaseIds.add(baseIdOf(pick.speciesId));
    } catch {
      // Skip-and-resample: this entry doesn't build (rare gamemaster edge
      // case) -- remove it permanently so the next draw doesn't retry it.
      available = available.filter((e) => e !== pick);
    }
  }
  return members;
}

/**
 * Compose one sampled opponent team, lead-ordered and fully labeled --
 * `composeSampledTeam` plus lead assignment plus id/name. This is the single
 * place a fresh sampled opponent comes into existence (gen-0 draws in
 * `sampleOpponentTeams`, and immigrant draws in src/meta/opponentPool.js).
 *
 * @returns {{id:string, name:string, members:object[], leadIndex:0, label:'sampled'}}
 */
export function composeSampledOpponent(ctx, rng, pool, weights, roleScores) {
  const raw = composeSampledTeam(ctx, rng, pool, weights);
  const members = orderMembersByLead(raw, pickLeadIndex(raw, roleScores, rng));
  return { ...describeSampledTeam(ctx, members), members, leadIndex: 0, label: 'sampled' };
}

/**
 * @typedef {import('./teams.js').MetaTeam & { label: 'curated' | 'sampled', leadIndex: number }} SampledOpponentTeam
 */

/**
 * Sample the opponent-team pool: a mixture of pvpoke's curated
 * teams for the run's league and randomly-composed teams weighted toward the current meta.
 * Deterministic under a fixed `seed` -- same inputs always produce the same
 * teams, in the same order.
 *
 * @param {object} ctx - from initEngine (src/engine/harness.js)
 * @param {{
 *   count: number,
 *   weights: Map<string, number>,
 *   seed?: number|string,
 *   curatedRatio?: number,
 *   curated?: import('./teams.js').MetaTeam[],
 *   roleScores?: Map<string, {lead:number}>,
 *   metaPoolSize?: number,
 *   rankingsFile?: string,
 *   rankingsEntries?: Array<object>,
 * }} params
 *   `curatedRatio` (default 0.4) is the target
 *   fraction of `count` drawn from `curated` (default: loadMetaTeams(ctx));
 *   the remainder is composed by weighted sampling. Both halves are
 *   gracefully capped (curated draw capped at `curated.length`; the sampled
 *   half can't run out since the meta pool is `metaPoolSize` species deep).
 *   `roleScores` (src/meta/roles.js) picks each sampled team's designated
 *   lead from pvpoke's own leads rankings instead of at random.
 *   `metaPoolSize` caps the sampled half's species pool (see
 *   DEFAULT_META_POOL_SIZE). `rankingsFile`/`rankingsEntries` override the
 *   moveset pool source (testability, mirrors src/meta/usage.js's `*Entries`
 *   pattern).
 * @returns {SampledOpponentTeam[]} labeled curated + sampled teams, in that
 *   order (curated first, then sampled) -- NOT battle order; callers treat
 *   this as an unordered opponent pool. Every team has `members[0]` as its
 *   designated lead and `leadIndex: 0`.
 */
export function sampleOpponentTeams(ctx, params) {
  const {
    count,
    weights,
    seed,
    curatedRatio = DEFAULT_CURATED_RATIO,
    curated,
    roleScores,
    metaPoolSize,
    rankingsFile,
    rankingsEntries,
  } = params;
  const rng = rngFromSeed(seed, 'sampleOpponentTeams');

  const curatedPool = curated ?? loadMetaTeams(ctx);
  const curatedCount = Math.min(Math.round(count * curatedRatio), curatedPool.length, count);
  // A curated team draws at its tier's relative weight: full for a
  // ladder-observed (untagged/meta) team, reduced for a second-hand
  // tier:"recommended" team and reduced further for tier:"off-meta" -- see
  // teams.js's CURATED_TIER_WEIGHTS for the documented ratios. A team without a
  // `tier` field (e.g. a caller-supplied test fixture) counts as full weight.
  const curatedWeightOf = curatedTierWeight;
  const chosenCurated = pickWeighted(rng, curatedPool, curatedWeightOf, curatedCount).map((team) => ({
    ...team,
    label: 'curated',
    leadIndex: team.leadIndex ?? 0,
  }));

  const sampledCount = count - chosenCurated.length;
  const movesetPool = loadMovesetPool(ctx, { rankingsFile, rankingsEntries, metaPoolSize });
  const sampledTeams = [];
  for (let i = 0; i < sampledCount; i++) {
    sampledTeams.push(composeSampledOpponent(ctx, rng, movesetPool, weights, roleScores));
  }

  return [...chosenCurated, ...sampledTeams];
}
