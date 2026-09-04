// JavaScript Document
//
// Meta scoring matrix: battles a Pokemon collection against the current meta
// for ctx's CP cap (vendor/pvpoke/src/data/groups/<league>.json -- great.json
// at the default CP 1500, ultra.json at 2500; see src/util/leagues.js) across three
// shield scenarios (0/0, 1/1, 2/2) using src/engine/harness.js's headless
// pvpoke simulator. No battle math or move-selection logic is reimplemented
// here -- every rating comes from harness.js's simBattle (itself pvpoke's own
// Battle.simulate()), and meta movesets are applied to each built meta mon
// using only pvpoke's own Pokemon#selectMove / #resetMoves methods (see
// applyGroupMoveset below), the same call sequence pvpoke's own
// Pokemon#selectRecommendedMoveset uses internally.
//
// See src/engine/README.md for the engine API (buildPokemon/simBattle) this
// module builds on.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildPokemon, simBattle } from '../engine/harness.js';
import { leagueForCp } from '../util/leagues.js';

const SHADOW_SUFFIX = '_shadow';

// [ratingsKey, shields1, shields2] -- shields are symmetric (user mon is
// always p1, so shields[0] applies to the user mon and shields[1] to the
// meta mon in every scenario).
const SHIELD_SCENARIOS = [
  ['s00', 0, 0],
  ['s11', 1, 1],
  ['s22', 2, 2],
];

// Per-mon score = mean over meta of weighted battle rating
// (0.25*s00 + 0.50*s11 + 0.25*s22).
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
 * @property {string} [lineageKey] - shared by every form of one physical
 *   Pokemon (see src/evolution/index.js); absent on a collection that was
 *   never expanded, in which case each mon is its own lineage.
 * @property {object} [evolution] - present only on an evolved variant added by
 *   src/evolution/index.js: `{fromSpeciesId, fromName, steps, candy, items, buddyKm}`.
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
 * @property {{speciesId:string, ivs:IVSpread, shadow:boolean, bestBuddy:boolean}} spec
 *   plain-data mirror of the params `pokemon` was built from --
 *   this is exactly the `MonSpec` shape src/engine/parallel.js's runBattles
 *   needs, since a live Pokemon instance can't cross a worker_thread boundary.
 *   Meta mons are never Best Buddy, so this is always `bestBuddy: false` here.
 */

/** The meta group file for ctx's CP cap: "great" at 1500, "ultra" at 2500, etc. */
function defaultGroupFile(ctx) {
  return leagueForCp(ctx.cp).group;
}

/** Read one vendor/pvpoke meta group file (default: the group for ctx.cp) as raw entries. */
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
 * pvpoke's own default (max-stat-product) IV spread for ctx's CP cap (1500 by
 * default, or whatever `initEngine({ cp })` was called with), read directly
 * from gamemaster data rather than recomputed. Layout verified
 * in vendor/pvpoke/src/js/pokemon/Pokemon.js (the "gamemaster" IV-strategy
 * branch of Pokemon#initialize): `defaultIVs.cp<N> == [level, atk, def, hp]`.
 *
 * Note: gamemaster also carries an alternate `cp2500l40` spread (a
 * level-40-capped variant) for some species alongside `cp2500` -- an existing
 * engine test already settled which one `rankings-2500.json` assumes by
 * reproducing its ratings bit-for-bit using `cp2500` (not `cp2500l40`), so
 * this function uses the plain `cp<N>` key for every cap, matching that
 * verified result rather than re-deriving it.
 */
function defaultIvsForCp(ctx, lookupId) {
  const cpKey = `cp${ctx.cp}`;
  const combo = ctx.gm.getPokemonById(lookupId)?.defaultIVs?.[cpKey];
  if (!combo) {
    throw new Error(`loadMeta: no gamemaster defaultIVs.${cpKey} for "${lookupId}"`);
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
 *
 * Exported so src/engine/parallelWorker.js can reapply the same
 * explicit moveset after rebuilding a Pokemon from a plain-data MonSpec --
 * buildPokemon alone always applies pvpoke's RECOMMENDED moveset, which is
 * not necessarily what a buildMetaMon-built mon (e.g. a curated preset team
 * member) was actually carrying.
 */
export function applyGroupMoveset(pokemon, { fastMove, chargedMoves }) {
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
 * IV spread for ctx's CP cap. Shared with src/meta/teams.js so the "_shadow" suffix
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
  const ivs = defaultIvsForCp(ctx, lookupId);

  const pokemon = buildPokemon(ctx, { speciesId: baseSpeciesId, ivs, shadow });
  applyGroupMoveset(pokemon, entry);

  return {
    speciesId: entry.speciesId,
    baseSpeciesId,
    shadow,
    fastMove: entry.fastMove,
    chargedMoves: entry.chargedMoves,
    pokemon,
    // fastMove/chargedMoves included (unlike buildRecommendedMon's spec below)
    // because this mon carries an EXPLICIT moveset, not pvpoke's recommended
    // one -- see applyGroupMoveset's export comment above.
    spec: { speciesId: baseSpeciesId, ivs, shadow, bestBuddy: false, fastMove: entry.fastMove, chargedMoves: entry.chargedMoves },
  };
}

/**
 * @typedef {object} MoveOverride - a PARTIAL explicit moveset. Either field may
 *   be omitted, in which case that half of pvpoke's recommended moveset stands:
 *   an observation that named only a fast move ("Empoleon with Waterfall")
 *   should not also silently restate the charged moves.
 * @property {string} [fastMove] - gamemaster move id, e.g. "WATERFALL".
 * @property {string[]} [chargedMoves] - 1 or 2 gamemaster move ids.
 */

// applyGroupMoveset writes at most two charged-move slots (pvpoke Pokemon carry
// at most two), so an override naming more than two is truncated with a warning.
const MAX_CHARGED_MOVES = 2;

/** Is `moveId` in a movepool pvpoke itself computed for this Pokemon? */
function inMovePool(pool, moveId) {
  return pool.some((m) => m.moveId === moveId);
}

/** Elementwise move-id comparison (order matters -- slot 0 is the primary charged move). */
function sameMoveList(a, b) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Merge a MoveOverride over the recommended moveset pvpoke already selected for
 * `pokemon`, then apply the result via applyGroupMoveset.
 *
 * Every named move is checked against `pokemon.fastMovePool` /
 * `chargedMovePool` -- the movepools pvpoke's own Pokemon#initialize built from
 * gamemaster (Frustration/Return included for a shadow). Reading those is a
 * membership test, not reimplemented legality logic. The check is NOT optional:
 * pvpoke's Pokemon#selectMove ADDS an unrecognized move id to the movepool
 * rather than rejecting it, so an unvalidated typo would silently produce an
 * opponent carrying a move the species cannot learn.
 *
 * Degrades rather than throws, matching how the community-team loader treats
 * bad data: an unlearnable move is warned about on stderr and that slot keeps
 * pvpoke's recommendation. An override is only ever an annotation on top of a
 * team that is already valid without it.
 *
 * @returns {{fastMove: string, chargedMoves: string[]} | null} null when the
 *   override changed nothing (all of it was invalid, or it merely restated the
 *   recommendation) -- the caller then treats the mon as a plain recommended
 *   build, so its worker-side spec stays moveset-free and shares a build cache
 *   entry with every other recommended build of the same species.
 */
function resolveMoveOverride(pokemon, recommended, override, label) {
  const warn = (msg) => process.stderr.write(`buildRecommendedMon: ${label} ${msg}\n`);

  let fastMove = recommended.fastMove;
  if (override.fastMove) {
    if (inMovePool(pokemon.fastMovePool, override.fastMove)) {
      fastMove = override.fastMove;
    } else {
      warn(`cannot learn fast move "${override.fastMove}" -- keeping recommended "${fastMove}"`);
    }
  }

  let chargedMoves = recommended.chargedMoves;
  if (override.chargedMoves) {
    const legal = override.chargedMoves.filter((moveId) => {
      if (inMovePool(pokemon.chargedMovePool, moveId)) return true;
      warn(`cannot learn charged move "${moveId}" -- dropping it from the override`);
      return false;
    });
    if (legal.length > MAX_CHARGED_MOVES) {
      warn(`override named ${legal.length} charged moves -- keeping the first ${MAX_CHARGED_MOVES}`);
    }
    if (legal.length > 0) {
      chargedMoves = legal.slice(0, MAX_CHARGED_MOVES);
    } else {
      warn(`override named no learnable charged move -- keeping recommended [${chargedMoves.join(', ')}]`);
    }
  }

  if (fastMove === recommended.fastMove && sameMoveList(chargedMoves, recommended.chargedMoves)) {
    return null;
  }

  applyGroupMoveset(pokemon, { fastMove, chargedMoves });
  return { fastMove, chargedMoves };
}

/**
 * Build ONE Pokemon from a bare speciesId, for opponent sources that name only
 * team membership rather than a full preset (e.g. the community-curated team
 * file). With no `override`, this doesn't call applyGroupMoveset at all:
 * buildPokemon already applies pvpoke's own recommended moveset internally
 * (Pokemon#selectRecommendedMoveset), so no moveset logic is duplicated here.
 *
 * `override` exists for the case where a curated entry recorded what a real
 * opponent was actually seen carrying and that differs from pvpoke's
 * recommendation. It is a PARTIAL moveset -- see MoveOverride -- merged over
 * the recommendation and validated against pvpoke's own movepools by
 * resolveMoveOverride, which warns and falls back per slot rather than throwing.
 *
 * @param {object} ctx - from initEngine (src/engine/harness.js)
 * @param {string} speciesId - may carry the "_shadow" suffix.
 * @param {MoveOverride | null} [override] - omit for pvpoke's recommended moveset.
 * @returns {MetaMon | null} null if speciesId doesn't resolve against the
 *   pinned gamemaster (caller decides whether that's fatal for its team).
 *   `spec` carries fastMove/chargedMoves ONLY when an override actually took
 *   effect -- src/engine/parallelWorker.js reapplies exactly that moveset when
 *   it rebuilds the mon in a worker, so a threaded run and a single-threaded
 *   run fight the same opponent.
 */
export function buildRecommendedMon(ctx, speciesId, override = null) {
  const shadow = speciesId.endsWith(SHADOW_SUFFIX);
  const baseSpeciesId = shadow ? speciesId.slice(0, -SHADOW_SUFFIX.length) : speciesId;
  const lookupId = resolveLookupId(ctx.gm, baseSpeciesId, shadow);
  if (!ctx.gm.getPokemonById(lookupId)) return null;

  const ivs = defaultIvsForCp(ctx, lookupId);
  const pokemon = buildPokemon(ctx, { speciesId: baseSpeciesId, ivs, shadow });

  const recommended = {
    fastMove: pokemon.fastMove.moveId,
    chargedMoves: Array.from(pokemon.chargedMoves).map((m) => m.moveId),
  };
  const applied = override ? resolveMoveOverride(pokemon, recommended, override, `"${speciesId}"`) : null;
  const moveset = applied ?? recommended;

  return {
    speciesId,
    baseSpeciesId,
    shadow,
    fastMove: moveset.fastMove,
    chargedMoves: moveset.chargedMoves,
    pokemon,
    spec: applied
      ? { speciesId: baseSpeciesId, ivs, shadow, bestBuddy: false, ...applied }
      : { speciesId: baseSpeciesId, ivs, shadow, bestBuddy: false },
  };
}

/**
 * Load the current meta for ctx's CP cap and build each entry exactly once,
 * using pvpoke's own default IV spread for that cap and the group's specified
 * moveset (not pvpoke's recommended-moveset heuristic).
 *
 * @param {object} ctx - from initEngine (src/engine/harness.js)
 * @param {{ metaLimit?: number, groupEntries?: GroupEntry[], groupFile?: string }} [opts]
 *   `metaLimit` caps how many group entries are built (default: all).
 *   `groupEntries` overrides reading a vendor group file entirely -- lets
 *   callers (tests, or a different cup) inject an arbitrary small group
 *   without touching vendor data or relying on great.json's on-disk ordering.
 *   `groupFile` picks a different vendor/pvpoke/src/data/groups/*.json
 *   (default: the group for ctx.cp -- "great" at 1500, "ultra" at 2500; see
 *   src/util/leagues.js).
 * @returns {MetaMon[]}
 */
export function loadMeta(ctx, opts = {}) {
  const rawEntries = opts.groupEntries ?? readGroupEntries(ctx, opts.groupFile ?? defaultGroupFile(ctx));
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
 * in `warnings` instead of crashing the run. (Design choice, since the Matrix
 * contract leaves the exact shape open: `warnings` is a field on the same
 * object scoreCollection returns, rather than a separate `{matrix, warnings}`
 * pair -- so the return value IS the Matrix, with one additional field.)
 *
 * @param {object} ctx - from initEngine (src/engine/harness.js)
 * @param {NormalizedMon[]} mons
 * @param {{
 *   metaLimit?: number,
 *   groupEntries?: GroupEntry[],
 *   groupFile?: string,
 *   meta?: MetaMon[],
 *   currentMoves?: boolean,
 *   onProgress?: (progress: {completed: number, total: number, speciesId: string}) => void,
 * }} [opts]
 *   `currentMoves` (default false = today's behavior): when true,
 *   a user mon carrying a resolved `moves` field (src/importer's
 *   current-moves column parsing) gets that EXACT moveset applied via
 *   `applyGroupMoveset` instead of pvpoke's recommended moveset (mirrors
 *   `buildMetaMon`'s own pattern -- no new move-selection logic). A mon
 *   without resolvable move data falls back to the recommended moveset with
 *   a `warnings` note, never a hard failure.
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
 *   builtMons: Object<string, {speciesId: string, name: string, pokemon: object, spec: object,
 *     currentLevel: number|null, purified: boolean, lucky: boolean,
 *     lineageKey: string, evolution: object|null}>,
 * }}
 *   `builtMons` is keyed by the same userMonKey as `ratings` and exposes the
 *   already-built, battle-ready Pokemon instance for each scored user mon --
 *   an addition to the Matrix shape (backward compatible: an additive
 *   field, existing consumers of mons/meta/ratings/warnings are unaffected).
 *   `spec` is the plain-data `{speciesId, ivs, shadow, bestBuddy}`
 *   `pokemon` was built from -- src/engine/parallel.js's runBattles needs
 *   plain-data MonSpecs (a live Pokemon can't cross a worker_thread boundary),
 *   and `bestBuddy` specifically is otherwise unrecoverable from a built
 *   Pokemon instance (only consumed at build time for the level-51 cap).
 *   `currentLevel`/`purified`/`lucky` mirror the mon's own collection row as
 *   imported (level is null when the CSV didn't state one). `pokemon.level`
 *   is the level the simulator plays it at; the gap between the two is what
 *   src/cost/powerup.js turns into the Stardust/Candy build cost reported per
 *   ranked team.
 *   The team evaluator (src/teams/index.js) takes `matrix` as
 *   one of its inputs and needs to resolve a userMonKey to something it can
 *   hand to battleTeams; the Matrix shape as originally specified had no such
 *   path (mons/ratings carry ratings data, not IVs or instances), so rather
 *   than have the evaluator re-derive/rebuild Pokemon from raw collection
 *   rows a second time, scoreCollection now reuses the instances it already
 *   builds once here.
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
      const spec = {
        speciesId: mon.speciesId,
        ivs: mon.ivs,
        shadow: !!mon.shadow,
        bestBuddy: !!mon.bestBuddy,
      };
      const pokemon = buildPokemon(ctx, spec);

      // A copy already above the level buildPokemon solved for can never
      // reach that build: power-ups only raise level and evolving preserves
      // it, so its real CP sits over the league's cap. Keeping it would
      // recommend a Pokemon the collection cannot legally field (applies to
      // base rows and to src/evolution's evolved variants alike).
      if (typeof mon.level === 'number' && mon.level > pokemon.level) {
        warnings.push(
          `skipped ${key}: over the CP cap at its own level (L${mon.level}; ` +
            `the cap allows at most L${pokemon.level}, and levels can't go down)`
        );
        continue;
      }

      if (opts.currentMoves) {
        if (mon.moves) {
          applyGroupMoveset(pokemon, mon.moves);
          spec.fastMove = mon.moves.fastMove;
          spec.chargedMoves = mon.moves.chargedMoves;
        } else {
          warnings.push(
            `${key}: current-moves mode requested but no resolvable moveset -- used pvpoke's recommended moveset instead`
          );
        }
      }

      built.push({
        key,
        speciesId: mon.speciesId,
        name: mon.name,
        pokemon,
        spec,
        // Build-cost inputs (team Stardust cost). Deliberately NOT part of
        // `spec`: spec is the plain-data MonSpec that crosses the
        // worker_thread boundary in src/engine/parallel.js and is consumed by
        // buildPokemon, which has no notion of a mon's CURRENT level. These
        // travel alongside it instead. `currentLevel` is whatever the CSV
        // stated and is null when it stated nothing -- never guessed.
        currentLevel: typeof mon.level === 'number' ? mon.level : null,
        purified: !!mon.purified,
        lucky: !!mon.lucky,
        // Set by src/evolution/index.js when this entry is an evolved variant
        // of a collection row. `lineageKey` is shared by every form of one
        // physical Pokemon so a team can never field two of them.
        lineageKey: mon.lineageKey ?? key,
        evolution: mon.evolution ?? null,
      });
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
    builtMons[user.key] = {
      speciesId: user.speciesId,
      name: user.name,
      pokemon: user.pokemon,
      spec: user.spec,
      currentLevel: user.currentLevel,
      purified: user.purified,
      lucky: user.lucky,
      lineageKey: user.lineageKey,
      evolution: user.evolution,
    };

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
