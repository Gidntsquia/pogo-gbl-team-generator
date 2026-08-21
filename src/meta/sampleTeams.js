// JavaScript Document
//
// Weighted opponent-team sampler (GOALS T10, PLAN.md Rev 3). Builds the
// opponent side of the sampling initiative: a mixture of pvpoke's own curated
// teams for the run's CP cap (src/meta/teams.js) plus randomly-composed 3-mon teams
// drawn from a WIDE species pool, weighted toward the current meta via
// src/meta/usage.js's per-species weights.
//
// No battle math here -- movesets are read verbatim from pvpoke's own
// vendored rankings file (the same "recommended moveset" pvpoke's own UI
// shows) and applied via src/scoring/index.js's buildMetaMon, which itself
// only calls pvpoke's own Pokemon#selectMove/#resetMoves. The only new logic
// in this file is which species get chosen and in what order -- pure
// sampling machinery (src/util/rng.js), not simulation.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildMetaMon } from '../scoring/index.js';
import { loadMetaTeams, OFF_META_CURATED_WEIGHT } from './teams.js';
import { pickWeighted, rngFromSeed } from '../util/rng.js';

const DEFAULT_CURATED_RATIO = 0.4;
const TEAM_SIZE = 3;
const SHADOW_SUFFIX = '_shadow';

/** Strip the "_shadow" suffix pvpoke uses to key shadow variants, so base/shadow forms of the same species count as one species for dedup purposes (matches T4's team-evaluator rule). */
function baseIdOf(speciesId) {
  return speciesId.endsWith(SHADOW_SUFFIX) ? speciesId.slice(0, -SHADOW_SUFFIX.length) : speciesId;
}

function titleCase(part) {
  return part
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Prefer pvpoke's own gamemaster display name, falling back to a title-cased speciesId. */
function displayName(ctx, metaMon) {
  const data = ctx.gm.getPokemonById(metaMon.pokemon.speciesId);
  return data?.speciesName ?? titleCase(metaMon.speciesId);
}

/**
 * The wide moveset-having species pool a sampled opponent team is composed
 * from: every entry in pvpoke's own vendored rankings file for ctx.cp,
 * mapped to a buildMetaMon-ready `{speciesId, fastMove, chargedMoves}` using
 * that entry's own `moveset` field (pvpoke's own top recommended moveset --
 * the same field pvpoke's rankings UI shows, not a heuristic reimplemented
 * here). This is intentionally the FULL rankings field (1000+ species, not
 * just the ~50-mon great.json/training curated slice) so it lines up with
 * src/meta/usage.js's weight universe -- see usage.js's collectSpeciesUniverse
 * comment for why a narrow pool defeats the point of weighted sampling.
 *
 * @param {object} ctx - from initEngine (src/engine/harness.js)
 * @param {{ rankingsFile?: string, rankingsEntries?: Array<object> }} [opts]
 * @returns {Array<{speciesId: string, fastMove: string, chargedMoves: string[]}>}
 */
function loadMovesetPool(ctx, opts = {}) {
  // Rankings file follows ctx.cp (GOALS T18c) so a `--cp 2500` run composes
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
    });
  }
  return pool;
}

/**
 * Compose one random 3-mon team from `pool`, weighted by `weights` (a
 * Map<speciesId, number> from loadUsageWeights), with no two members sharing
 * a base species (shadow/base = same species). A pool entry that fails to
 * build (e.g. a gamemaster edge case) is dropped from further consideration
 * and a replacement is drawn -- "skip-and-resample" per the ticket, never a
 * hard crash on one bad species.
 *
 * @param {object} ctx
 * @param {() => number} rng
 * @param {Array<{speciesId: string, fastMove: string, chargedMoves: string[]}>} pool
 * @param {Map<string, number>} weights
 * @returns {import('./teams.js').MetaMon[]} exactly TEAM_SIZE built members.
 */
function composeSampledTeam(ctx, rng, pool, weights) {
  let available = pool.filter((e) => (weights.get(e.speciesId) ?? 0) > 0);
  const chosenBaseIds = new Set();
  const members = [];

  while (members.length < TEAM_SIZE) {
    const candidates = available.filter((e) => !chosenBaseIds.has(baseIdOf(e.speciesId)));
    if (candidates.length === 0) {
      throw new Error(
        `sampleOpponentTeams: ran out of distinct-species candidates while composing a team (${members.length}/${TEAM_SIZE} built)`
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
 * @typedef {import('./teams.js').MetaTeam & { label: 'curated' | 'sampled' }} SampledOpponentTeam
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
 *   rankingsFile?: string,
 *   rankingsEntries?: Array<object>,
 * }} params
 *   `curatedRatio` (default 0.4, documented in PLAN.md Rev 3) is the target
 *   fraction of `count` drawn from `curated` (default: loadMetaTeams(ctx));
 *   the remainder is composed by weighted sampling. Both halves are
 *   gracefully capped (curated draw capped at `curated.length`; the sampled
 *   half can't run out since the rankings pool is ~1000+ species deep).
 *   `rankingsFile`/`rankingsEntries` override the moveset pool source
 *   (testability, mirrors src/meta/usage.js's `*Entries` pattern).
 * @returns {SampledOpponentTeam[]} labeled curated + sampled teams, in that
 *   order (curated first, then sampled) -- NOT battle order; callers treat
 *   this as an unordered opponent pool.
 */
export function sampleOpponentTeams(ctx, params) {
  const { count, weights, seed, curatedRatio = DEFAULT_CURATED_RATIO, curated, rankingsFile, rankingsEntries } =
    params;
  const rng = rngFromSeed(seed, 'sampleOpponentTeams');

  const curatedPool = curated ?? loadMetaTeams(ctx);
  const curatedCount = Math.min(Math.round(count * curatedRatio), curatedPool.length, count);
  // GOALS T10b: a curated team tagged tier:"off-meta" draws at a reduced
  // relative weight vs untagged (meta) teams -- see teams.js's
  // OFF_META_CURATED_WEIGHT for the documented ratio. A team without a `tier`
  // field (e.g. a caller-supplied test fixture) counts as full weight.
  const curatedWeightOf = (team) => (team.tier === 'off-meta' ? OFF_META_CURATED_WEIGHT : 1);
  const chosenCurated = pickWeighted(rng, curatedPool, curatedWeightOf, curatedCount).map((team) => ({
    ...team,
    label: 'curated',
  }));

  const sampledCount = count - chosenCurated.length;
  const movesetPool = loadMovesetPool(ctx, { rankingsFile, rankingsEntries });
  const sampledTeams = [];
  for (let i = 0; i < sampledCount; i++) {
    const members = composeSampledTeam(ctx, rng, movesetPool, weights);
    const id = `sampled-${members.map((m) => m.speciesId).join('-')}`;
    const name = members.map((m) => displayName(ctx, m)).join(' / ');
    sampledTeams.push({ id, name, members, label: 'sampled' });
  }

  return [...chosenCurated, ...sampledTeams];
}
