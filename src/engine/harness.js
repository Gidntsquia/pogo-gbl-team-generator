// JavaScript Document
//
// Headless pvpoke battle-engine harness. Boots pvpoke's real Great League
// (CP 1500) simulator (see pvpokeLoader.js / README.md) and exposes three
// functions: initEngine, buildPokemon, simBattle. No battle math is
// reimplemented here -- every number in the returned results comes from
// executing vendor/pvpoke's own code.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadPvpokeEngine } from './pvpokeLoader.js';

const GREAT_LEAGUE_CP = 1500;
const DEFAULT_MAX_LEVEL = 50;
const BEST_BUDDY_MAX_LEVEL = 51;

/**
 * @typedef {{ atk: number, def: number, hp: number }} IVSpread
 */

/**
 * Boot a headless pvpoke battle engine for Great League (CP 1500).
 *
 * Loads vendor/pvpoke's own JS into a vm sandbox (pvpokeLoader.js) and reads
 * gamemaster + the Great League "all"/"overall" ranking data directly from
 * vendor/pvpoke/src/data as JSON -- pvpoke's own ajax loading is never used.
 * The ranking data both drives buildPokemon's recommended-moveset selection
 * (pvpoke's own `selectRecommendedMoveset`) and is what test/engine.test.js
 * validates simBattle's output against.
 *
 * @param {{ vendorRoot?: string }} [opts]
 * @returns {Promise<object>} ctx -- pass to buildPokemon/simBattle
 */
export async function initEngine(opts = {}) {
  const { context, GameMaster, Battle, Pokemon, vendorRoot } = loadPvpokeEngine(opts);

  const gm = GameMaster.getInstance();

  const gamemasterPath = path.join(vendorRoot, 'src/data/gamemaster.json');
  gm.data = JSON.parse(readFileSync(gamemasterPath, 'utf8'));
  gm.createSearchMaps();

  // Great League (CP 1500), cup "all" -- the same file the acceptance
  // criteria validates against (vendor/pvpoke/src/data/rankings/all/overall/
  // rankings-1500.json), and the same cup Battle()'s own default
  // (`{name: "all", exclude: [{filterType: "tag", values: ["mega"]}]}`)
  // already matches, so nothing here ever calls battle.setCup().
  const rankingsPath = path.join(
    vendorRoot,
    'src/data/rankings/all/overall/rankings-1500.json'
  );
  const rankings = JSON.parse(readFileSync(rankingsPath, 'utf8'));
  // Key format matches Pokemon.js's own selectRecommendedMoveset:
  // `cupName + category + battle.getCP()`.
  gm.rankings[`alloverall${GREAT_LEAGUE_CP}`] = rankings;

  // One shared Battle instance, reused across every buildPokemon/simBattle
  // call -- mirrors pvpoke's own battle/rankers/Ranker.js, which keeps a
  // single `battle` alive across thousands of simulated matchups rather than
  // constructing a fresh one per battle. Battle()'s defaults (cp: 1500,
  // levelCap: 50, cup: "all") are exactly Great League, so no setup calls
  // are needed here either.
  const battle = new Battle();

  return { context, GameMaster, Battle, Pokemon, gm, battle, vendorRoot, rankings };
}

function assertValidIVs(ivs) {
  for (const key of ['atk', 'def', 'hp']) {
    const v = ivs?.[key];
    if (!Number.isInteger(v) || v < 0 || v > 15) {
      throw new Error(`buildPokemon: ivs.${key} must be an integer 0-15, got ${v}`);
    }
  }
}

/**
 * Build a battle-ready pvpoke Pokemon at the highest level (cap 50, or 51
 * with bestBuddy) whose CP does not exceed 1500, using the caller's exact
 * IVs and pvpoke's own recommended-moveset logic.
 *
 * @param {object} ctx - from initEngine
 * @param {{ speciesId: string, ivs: IVSpread, shadow?: boolean, bestBuddy?: boolean }} params
 *   speciesId is pvpoke's *base* gamemaster speciesId (never "..._shadow" --
 *   pass shadow: true instead; see the shadow-handling note below).
 * @returns {object} a pvpoke Pokemon instance, ready to pass to simBattle
 */
export function buildPokemon(ctx, { speciesId, ivs, shadow = false, bestBuddy = false }) {
  assertValidIVs(ivs);
  const { Pokemon, gm, battle } = ctx;

  let lookupId = speciesId;
  let needsManualShadow = false;
  if (shadow) {
    const shadowId = `${speciesId}_shadow`;
    if (gm.pokemonMap.has(shadowId)) {
      // Preferred path: pvpoke ships a real "<id>_shadow" gamemaster entry
      // for every species that has actually been released as Shadow, with
      // its own (already-correct) move pool, tags, and rankings row.
      lookupId = shadowId;
    } else {
      // Fallback: species pvpoke has never modeled as Shadow (e.g.
      // Azumarill, Medicham -- never released as Shadow in-game). Build the
      // base species and apply the shadow atk/def multipliers by hand below
      // via setShadowType, so shadow: true still does something faithful
      // for these instead of silently being ignored or throwing.
      needsManualShadow = true;
    }
  }

  const pokemon = new Pokemon(lookupId, 0, battle);
  if (!pokemon.data) {
    throw new Error(`buildPokemon: unknown speciesId "${lookupId}"`);
  }

  pokemon.ivs.atk = ivs.atk;
  pokemon.ivs.def = ivs.def;
  pokemon.ivs.hp = ivs.hp;
  pokemon.isCustom = true;

  const maxLevel = bestBuddy ? BEST_BUDDY_MAX_LEVEL : DEFAULT_MAX_LEVEL;
  const targetCP = battle.getCP(); // 1500

  // Port of the level-search inner loop from pvpoke's own
  // Pokemon.generateIVCombinations (vendor/pvpoke/src/js/pokemon/Pokemon.js):
  // step level up by half-levels while CP stays under the cap, then step
  // back one half-level if the last step overshot. We can't call
  // generateIVCombinations itself here because it always sweeps the entire
  // 0-15 IV cube (4096 combinations) looking for the *best* combo by some
  // sort stat, rather than solving for the one caller-supplied IV spread
  // buildPokemon receives -- so instead we drive pvpoke's own
  // calculateCP()/getCPMByLevel() through the same loop shape pvpoke uses
  // internally. This is the one piece of "glue" logic in this file; the CP
  // math itself (calculateCP, getCPMByLevel) is entirely pvpoke's.
  let level = pokemon.baseLevelFloor;
  let cpm = pokemon.getCPMByLevel(level);
  let calcCP = 0;
  while (level < maxLevel && calcCP < targetCP) {
    level += 0.5;
    cpm = pokemon.getCPMByLevel(level);
    calcCP = pokemon.calculateCP(cpm, ivs.atk, ivs.def, ivs.hp);
  }
  if (calcCP > targetCP) {
    level -= 0.5;
    cpm = pokemon.getCPMByLevel(level);
    calcCP = pokemon.calculateCP(cpm, ivs.atk, ivs.def, ivs.hp);
  }

  if (level > pokemon.levelCap) pokemon.levelCap = level;
  pokemon.setLevel(level, false);
  // initialize(false): targetCP is falsy, so this skips pvpoke's own
  // default-IV branch entirely (gated on `targetCP && !isCustom`) and just
  // recomputes stats/hp/cp from the ivs/level set above, auto-detects the
  // "shadow" tag (for species that are *always* shadow), fills in a
  // placeholder moveset, and calls resetMoves(). The moveset is overridden
  // immediately below.
  pokemon.initialize(false);

  if (needsManualShadow) {
    pokemon.setShadowType('shadow');
  }

  // pvpoke's own recommended-moveset logic: looks up this species' entry in
  // the Great League "all"/"overall" rankings preloaded by initEngine and
  // selects its recorded moveset; falls back to autoSelectMoves() (pvpoke's
  // usage-weighted heuristic, also its own code) when the species isn't in
  // the rankings (e.g. scored below the ranking cutoff). Both branches are
  // pvpoke's own logic -- see Pokemon.js.
  pokemon.selectRecommendedMoveset('overall');

  return pokemon;
}

/**
 * Run one pvpoke battle simulation between two buildPokemon results and
 * return pvpoke's own battle ratings.
 *
 * p1 and p2 must be distinct Pokemon instances: pvpoke's Battle#setNewPokemon
 * mutates `.index` on whatever object it's given, so passing the same object
 * as both sides corrupts the simulation. For a mirror match, call
 * buildPokemon twice with identical params to get two independent instances.
 *
 * @param {object} ctx - from initEngine
 * @param {{ p1: object, p2: object, shields: [number, number] }} params
 * @returns {{ rating1: number, rating2: number, hp1: number, hp2: number, turns: number }}
 */
export function simBattle(ctx, { p1, p2, shields }) {
  if (p1 === p2) {
    throw new Error(
      'simBattle: p1 and p2 must be distinct Pokemon instances ' +
        '(build the same species twice for a mirror match)'
    );
  }
  const { battle } = ctx;

  battle.setNewPokemon(p1, 0, false);
  battle.setNewPokemon(p2, 1, false);
  p1.setShields(shields[0]);
  p2.setShields(shields[1]);

  // battle.simulate() -> start() reads the startingShields values just set
  // above into the live shield counters (and resets hp/energy/cooldown),
  // then runs the full turn-by-turn loop using pvpoke's own ActionLogic AI
  // on both sides until one Pokemon faints or the 240s time limit hits.
  battle.simulate();

  const [rating1, rating2] = battle.getBattleRatings();

  return {
    rating1,
    rating2,
    hp1: p1.hp,
    hp2: p2.hp,
    // Number of half-second turns simulated. battle.getTurns() has already
    // advanced one past the last processed turn by the time simulate()
    // returns (Battle.step() increments it after processing), so subtract
    // 1 to report the turn the battle actually ended on.
    turns: battle.getTurns() - 1,
  };
}
