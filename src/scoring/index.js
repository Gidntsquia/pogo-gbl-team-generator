// JavaScript Document
//
// Meta scoring matrix: battles a Pokemon collection against the current
// Great League meta (vendor/pvpoke/src/data/groups/great.json) across three
// shield scenarios (0/0, 1/1, 2/2) using src/engine/harness.js's headless
// pvpoke simulator. No battle math or move-selection logic is reimplemented
// here -- every rating comes from harness.js's simBattle (itself pvpoke's own
// Battle.simulate()), and meta movesets are applied to each built meta mon
// using only pvpoke's own Pokemon#selectMove / #resetMoves methods (see
// applyGroupMoveset below), the same call sequence pvpoke's own
// Pokemon#selectRecommendedMoveset uses internally.
//
// See PLAN.md's "Interfaces" section for the Matrix contract this module's
// scoreCollection produces, and src/engine/README.md for the engine API
// (buildPokemon/simBattle) this module builds on.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildPokemon, simBattle } from '../engine/harness.js';

const DEFAULT_GROUP_FILE = 'great';
const SHADOW_SUFFIX = '_shadow';

// [ratingsKey, shields1, shields2] -- shields are symmetric (user mon is
// always p1, so shields[0] applies to the user mon and shields[1] to the
// meta mon in every scenario) per PLAN.md's "shields 0v0 / 1v1 / 2v2".
const SHIELD_SCENARIOS = [
  ['s00', 0, 0],
  ['s11', 1, 1],
  ['s22', 2, 2],
];

// PLAN.md: "Per-mon score = mean over meta of weighted battle rating
// (0.25*s00 + 0.50*s11 + 0.25*s22)."
const SCORE_WEIGHTS = Object.freeze({ s00: 0.25, s11: 0.5, s22: 0.25 });

/**
 * @typedef {{ atk: number, def: number, hp: number }} IVSpread
 */

/**
 * @typedef {object} NormalizedMon
 * @property {string} speciesId - pvpoke gamemaster speciesId (base species,
 *   never "..._shadow" -- see the `shadow` flag).
 * @property {string} name - display name.
 * @property {IVSpread} ivs
 * @property {number} [cp]
 * @property {number} [level]
 * @property {boolean} shadow
 * @property {boolean} purified
 * @property {boolean} lucky
 * @property {boolean} bestBuddy
 * @property {number} sourceRow
 */

/**
 * @typedef {object} GroupEntry
 * @property {string} speciesId - as written in the vendor/pvpoke group file;
 *   keeps its "..._shadow" suffix when the entry is a Shadow Pokemon.
 * @property {string} fastMove
 * @property {string[]} chargedMoves
 * @property {string} [shadowType]
 */

/**
 * @typedef {object} MetaMon
 * @property {string} speciesId - the group entry's ORIGINAL id (with
 *   "_shadow" suffix kept, if any) -- this is the id used as the meta/ratings
 *   key throughout this module.
 * @property {string} baseSpeciesId - speciesId with any "_shadow" suffix
 *   stripped -- what gets passed to buildPokemon.
 * @property {boolean} shadow
 * @property {string} fastMove
 * @property {string[]} chargedMoves
 * @property {object} pokemon - the built, battle-ready pvpoke Pokemon
 *   instance (moveset already applied), safe to reuse across many simBattle
 *   calls.
 */

/** Read one vendor/pvpoke meta group file (default: Great League's great.json) as raw entries. */
function readGroupEntries(ctx, groupFile) {
  const groupPath = path.join(ctx.vendorRoot, 'src/data/groups', `${groupFile}.json`);
  return JSON.parse(readFileSync(groupPath, 'utf8'));
}

/**
 * Mirrors src/engine/harness.js's buildPokemon shadow-lookup exactly (see its
 * "needsManualShadow" comment): prefer a real "<id>_shadow" gamemaster entry
 * when pvpoke ships one, else fall back to the base id (buildPokemon itself
 * then applies the shadow atk/def multipliers by hand via setShadowType).
 * Duplicated here (rather than imported) because harness.js doesn't expose it
 * standalone; it's a two-line Map lookup, not battle math.
 */
function resolveLookupId(gm, baseSpeciesId, shadow) {
  if (!shadow) return baseSpeciesId;
  const shadowId = `${baseSpeciesId}${SHADOW_SUFFIX}`;
  return gm.pokemonMap.has(shadowId) ? shadowId : baseSpeciesId;
}

/**
 * pvpoke's own default (max-stat-product) IV spread for CP 1500, read
 * directly from gamemaster data rather than recomputed. Layout verified in
 * vendor/pvpoke/src/js/pokemon/Pokemon.js (the "gamemaster" IV-strategy
 * branch of Pokemon#initialize): `defaultIVs.cp1500 == [level, atk, def, hp]`.
 */
function defaultCp1500Ivs(ctx, lookupId) {
  const combo = ctx.gm.getPokemonById(lookupId)?.defaultIVs?.cp1500;
  if (!combo) {
    throw new Error(`loadMeta: no gamemaster defaultIVs.cp1500 for "${lookupId}"`);
  }
  const [, atk, def, hp] = combo;
  return { atk, def, hp };
}

/**
 * Apply an explicit fast/charged moveset to a live pvpoke Pokemon using only
 * pvpoke's own Pokemon#selectMove / #resetMoves -- the exact sequence
 * pvpoke's own Pokemon#selectRecommendedMoveset uses internally (vendor/pvpoke/
 * src/js/pokemon/Pokemon.js, ~line 1000), just fed a caller-supplied moveset
 * instead of one read from pvpoke's rankings data. No move-selection logic
 * (which move is "best", movepool legality, etc.) is reimplemented here.
 */
function applyGroupMoveset(pokemon, { fastMove, chargedMoves }) {
  pokemon.selectMove('fast', fastMove);
  pokemon.selectMove('charged', chargedMoves[0], 0);
  if (chargedMoves.length > 1) {
    pokemon.selectMove('charged', chargedMoves[1], 1);
  } else {
    pokemon.selectMove('charged', 'none', 1);
  }
  pokemon.resetMoves();
}

/**
 * Build ONE meta/group entry (`{speciesId, fastMove, chargedMoves}`) into a
 * battle-ready pvpoke Pokemon with that exact moveset, at pvpoke's own default
 * CP-1500 IV spread. Shared with src/meta/teams.js so the "_shadow" suffix
 * handling, default-IV lookup and moveset application exist in exactly one
 * place.
 *
 * @param {object} ctx - from initEngine (src/engine/harness.js)
 * @param {GroupEntry} entry
 * @returns {MetaMon}
 */
export function buildMetaMon(ctx, entry) {
  const shadow = entry.speciesId.endsWith(SHADOW_SUFFIX);
  const baseSpeciesId = shadow ? entry.speciesId.slice(0, -SHADOW_SUFFIX.length) : entry.speciesId;
  const lookupId = resolveLookupId(ctx.gm, baseSpeciesId, shadow);
  const ivs = defaultCp1500Ivs(ctx, lookupId);

  const pokemon = buildPokemon(ctx, { speciesId: baseSpeciesId, ivs, shadow });
  applyGroupMoveset(pokemon, entry);

  return {
    speciesId: entry.speciesId,
    baseSpeciesId,
    shadow,
    fastMove: entry.fastMove,
    chargedMoves: entry.chargedMoves,
    pokemon,
  };
}

/**
 * Build ONE Pokemon from a bare speciesId (no explicit moveset), for opponent
 * sources that name only team membership rather than a full preset (e.g.
 * GOALS T10b's community-curated team file) -- unlike buildMetaMon, this
 * doesn't call applyGroupMoveset; buildPokemon already applies pvpoke's own
 * recommended moveset internally (Pokemon#selectRecommendedMoveset), so no
 * moveset logic is duplicated here either.
 *
 * @param {object} ctx - from initEngine (src/engine/harness.js)
 * @param {string} speciesId - may carry the "_shadow" suffix.
 * @returns {MetaMon | null} null if speciesId doesn't resolve against the
 *   pinned gamemaster (caller decides whether that's fatal for its team).
 */
export function buildRecommendedMon(ctx, speciesId) {
  const shadow = speciesId.endsWith(SHADOW_SUFFIX);
  const baseSpeciesId = shadow ? speciesId.slice(0, -SHADOW_SUFFIX.length) : speciesId;
  const lookupId = resolveLookupId(ctx.gm, baseSpeciesId, shadow);
  if (!ctx.gm.getPokemonById(lookupId)) return null;

  const ivs = defaultCp1500Ivs(ctx, lookupId);
  const pokemon = buildPokemon(ctx, { speciesId: baseSpeciesId, ivs, shadow });

  return {
    speciesId,
    baseSpeciesId,
    shadow,
    fastMove: pokemon.fastMove.moveId,
    chargedMoves: Array.from(pokemon.chargedMoves).map((m) => m.moveId),
    pokemon,
  };
}

/**
 * Load the current Great League meta and build each entry exactly once,
 * using pvpoke's own default CP-1500 IV spread and the group's specified
 * moveset (not pvpoke's recommended-moveset heuristic).
 *
 * @param {object} ctx - from initEngine (src/engine/harness.js)
 * @param {{ metaLimit?: number, groupEntries?: GroupEntry[], groupFile?: string }} [opts]
 *   `metaLimit` caps how many group entries are built (default: all).
 *   `groupEntries` overrides reading a vendor group file entirely -- lets
 *   callers (tests, or a future --cp/cup flag) inject an arbitrary small
 *   group without touching vendor data or relying on great.json's on-disk
 *   ordering. `groupFile` picks a different vendor/pvpoke/src/data/groups/*.json
 *   (default `"great"`); unused by the MVP CLI but free to expose.
 * @returns {MetaMon[]}
 */
export function loadMeta(ctx, opts = {}) {
  const rawEntries = opts.groupEntries ?? readGroupEntries(ctx, opts.groupFile ?? DEFAULT_GROUP_FILE);
  const entries = typeof opts.metaLimit === 'number' ? rawEntries.slice(0, opts.metaLimit) : rawEntries;

  return entries.map((entry) => buildMetaMon(ctx, entry));
}

/**
 * Pure weighted-mean arithmetic behind each mon's `score`, split out so it's
 * testable against a hand-built fake ratings set with no engine involved.
 *
 * @param {Object<string, {s00:number, s11:number, s22:number}>} ratingsBySpecies
 *   e.g. one `ratings[userMonKey]` entry from scoreCollection's output.
 * @returns {number} mean over meta of (0.25*s00 + 0.50*s11 + 0.25*s22), rounded to 1 decimal.
 */
export function computeWeightedScore(ratingsBySpecies) {
  const rows = Object.values(ratingsBySpecies);
  if (rows.length === 0) return 0;
  const sum = rows.reduce(
    (acc, r) => acc + SCORE_WEIGHTS.s00 * r.s00 + SCORE_WEIGHTS.s11 * r.s11 + SCORE_WEIGHTS.s22 * r.s22,
    0
  );
  return Math.round((sum / rows.length) * 10) / 10;
}

/**
 * Short human "top wins/losses" string for one mon, e.g.
 * "beats azumarill, medicham; loses to registeel" -- top 2-3 meta opponents
 * by 1v1 (s11) rating margin, favoring up to 2 wins + 1 loss when both exist.
 * A "win" is s11 > 500, a "loss" is s11 < 500 (pvpoke's own rating scale: the
 * two ratings in a matchup always sum to 1000).
 *
 * @param {Object<string, {s00:number, s11:number, s22:number}>} ratingsBySpecies
 * @returns {string}
 */
export function computeLeadIn(ratingsBySpecies) {
  const rows = Object.entries(ratingsBySpecies).map(([speciesId, r]) => ({ speciesId, s11: r.s11 }));
  const wins = rows.filter((r) => r.s11 > 500).sort((a, b) => b.s11 - a.s11);
  const losses = rows.filter((r) => r.s11 < 500).sort((a, b) => a.s11 - b.s11);

  const MAX_TOTAL = 3;
  const MAX_WINS = 2;
  let winsShown = wins.slice(0, MAX_WINS);
  let lossesShown = losses.slice(0, MAX_TOTAL - winsShown.length);
  if (winsShown.length + lossesShown.length < MAX_TOTAL) {
    // One category ran out early (e.g. this mon beats everything in the
    // subset) -- backfill from the other so up to 3 entries are still shown.
    winsShown = wins.slice(0, MAX_TOTAL - lossesShown.length);
  }

  const parts = [];
  if (winsShown.length) parts.push(`beats ${winsShown.map((r) => r.speciesId).join(', ')}`);
  if (lossesShown.length) parts.push(`loses to ${lossesShown.map((r) => r.speciesId).join(', ')}`);
  return parts.join('; ');
}

/**
 * Score a collection against the Great League meta.
 *
 * Builds every user mon and every meta mon exactly once, then reuses those
 * same built instances across the full (mons x meta x 3 shield scenarios)
 * simBattle matrix -- see src/engine/README.md's "single Battle instance
 * reused" note for why that's safe.
 *
 * Skip-with-warning: a user mon whose speciesId isn't in the vendored
 * gamemaster, or that throws out of buildPokemon for any other reason (e.g.
 * an out-of-range IV), is left out of both `mons` and `ratings` and reported
 * in `warnings` instead of crashing the run. (Design choice, since PLAN.md
 * leaves the exact shape open: `warnings` is a field on the same object
 * scoreCollection returns, rather than a separate `{matrix, warnings}` pair
 * -- so the return value IS the Matrix from PLAN.md's Interfaces section,
 * with one additional field.)
 *
 * @param {object} ctx - from initEngine (src/engine/harness.js)
 * @param {NormalizedMon[]} mons
 * @param {{
 *   metaLimit?: number,
 *   groupEntries?: GroupEntry[],
 *   groupFile?: string,
 *   meta?: MetaMon[],
 *   onProgress?: (progress: {completed: number, total: number, speciesId: string}) => void,
 * }} [opts]
 *   `meta` lets a caller pass an already-loaded MetaMon[] (from a prior
 *   loadMeta call) to skip reloading/rebuilding it -- e.g. to score several
 *   collections against one meta build, or to inject a hand-picked test
 *   meta. When omitted, scoreCollection calls `loadMeta(ctx, opts)` itself,
 *   so `metaLimit`/`groupEntries`/`groupFile` are still honored.
 *   `onProgress` fires once per user mon finished (coarse-grained on
 *   purpose: a 1000-mon collection is 1000 calls, not 150000).
 * @returns {{
 *   mons: Array<{speciesId: string, name: string, score: number, leadIn: string}>,
 *   meta: string[],
 *   ratings: Object<string, Object<string, {s00:number, s11:number, s22:number}>>,
 *   warnings: string[],
 *   builtMons: Object<string, {speciesId: string, name: string, pokemon: object}>,
 * }}
 *   `builtMons` is keyed by the same userMonKey as `ratings` and exposes the
 *   already-built, battle-ready Pokemon instance for each scored user mon --
 *   an addition to PLAN.md's Matrix shape (backward compatible: an additive
 *   field, existing consumers of mons/meta/ratings/warnings are unaffected).
 *   PLAN.md's team evaluator (src/teams/index.js, GOALS T4) takes `matrix` as
 *   one of its inputs and needs to resolve a userMonKey to something it can
 *   hand to battleTeams; the Matrix shape as originally specified had no such
 *   path (mons/ratings carry ratings data, not IVs or instances), so rather
 *   than have the evaluator re-derive/rebuild Pokemon from raw collection
 *   rows a second time, scoreCollection now reuses the instances it already
 *   builds once here. See PROGRESS.md's T4 entry for this interface note.
 */
export function scoreCollection(ctx, mons, opts = {}) {
  const { gm } = ctx;
  const meta = opts.meta ?? loadMeta(ctx, opts);
  const warnings = [];

  const built = [];
  for (const mon of mons) {
    const key = `${mon.speciesId}#${mon.sourceRow}`;
    try {
      if (!gm.getPokemonById(mon.speciesId)) {
        warnings.push(`skipped ${key}: speciesId not found in gamemaster`);
        continue;
      }
      const pokemon = buildPokemon(ctx, {
        speciesId: mon.speciesId,
        ivs: mon.ivs,
        shadow: !!mon.shadow,
        bestBuddy: !!mon.bestBuddy,
      });
      built.push({ key, speciesId: mon.speciesId, name: mon.name, pokemon });
    } catch (err) {
      warnings.push(`skipped ${key}: ${err.message}`);
    }
  }

  const ratings = {};
  const outMons = [];
  const builtMons = {};
  const total = built.length;
  let completed = 0;

  for (const user of built) {
    const perMeta = {};

    for (const metaMon of meta) {
      const scenarioRatings = {};
      for (const [ratingsKey, shield1, shield2] of SHIELD_SCENARIOS) {
        const { rating1 } = simBattle(ctx, {
          p1: user.pokemon,
          p2: metaMon.pokemon,
          shields: [shield1, shield2],
        });
        scenarioRatings[ratingsKey] = rating1;
      }
      perMeta[metaMon.speciesId] = scenarioRatings;
    }

    ratings[user.key] = perMeta;
    outMons.push({
      speciesId: user.speciesId,
      name: user.name,
      score: computeWeightedScore(perMeta),
      leadIn: computeLeadIn(perMeta),
    });
    builtMons[user.key] = { speciesId: user.speciesId, name: user.name, pokemon: user.pokemon };

    completed += 1;
    opts.onProgress?.({ completed, total, speciesId: user.speciesId });
  }

  return {
    mons: outMons,
    meta: meta.map((m) => m.speciesId),
    ratings,
    warnings,
    builtMons,
  };
}
