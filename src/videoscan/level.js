// JavaScript Document
//
// Derives the level Pokemon GO has a scanned Pokemon at, and cross-checks the
// scan against it.
//
// The appraisal screen never states a level as a number (it's an arc), but it
// does state CP and max HP, and both are exact functions of species, IVs, and
// level. So the scanned IVs can be *verified*: if no level in the game's
// range reproduces both the CP and the HP we read, one of the three readings
// is wrong and the row is flagged rather than quietly written to the CSV.
//
// All CP math here is pvpoke's own (`calculateCP`, `getCPMByLevel`,
// `initialize`) executed against the vendored gamemaster -- nothing about the
// game's stat formulas is reimplemented in this repo (CLAUDE.md).

const MIN_LEVEL = 1;
/** Level 51 is reachable only as a best buddy; 50 is the normal cap. */
const MAX_LEVEL = 51;

/**
 * @typedef {object} LevelFit
 * @property {number} [level] - the derived level, when exactly one fits.
 * @property {number[]} candidates - every level whose CP (and HP, when known) matches.
 * @property {number[]} cps - the CP each candidate level implies, in the same
 *   order. With only `maxHp` given this is the answer to "what CP could this
 *   Pokemon possibly have?", which is how a CP the animation covered up gets
 *   recovered (see index.js).
 * @property {'exact'|'ambiguous'|'none'} status
 */

/**
 * Build a level deriver bound to a booted engine context.
 *
 * @param {object} ctx - from `initEngine` (src/engine/harness.js).
 * At least one of `cp` and `maxHp` must be given; whichever are given are
 * both required to match.
 *
 * @returns {(input: {speciesId: string, shadow?: boolean, ivs: {atk: number, def: number, hp: number}, cp?: number, maxHp?: number}) => LevelFit}
 */
export function createLevelDeriver(ctx) {
  const { Pokemon, gm, battle } = ctx;
  const cache = new Map();

  const getPokemon = (speciesId, shadow) => {
    const shadowId = `${speciesId}_shadow`;
    const lookupId = shadow && gm.pokemonMap.has(shadowId) ? shadowId : speciesId;
    if (!cache.has(lookupId)) {
      const pokemon = new Pokemon(lookupId, 0, battle);
      if (!pokemon.data) throw new Error(`createLevelDeriver: unknown speciesId "${lookupId}"`);
      cache.set(lookupId, pokemon);
    }
    return cache.get(lookupId);
  };

  return function deriveLevel({ speciesId, shadow = false, ivs, cp, maxHp }) {
    if (cp === undefined && maxHp === undefined) {
      throw new Error('deriveLevel: needs at least one of cp, maxHp to solve against');
    }
    const pokemon = getPokemon(speciesId, shadow);
    pokemon.isCustom = true;
    pokemon.ivs.atk = ivs.atk;
    pokemon.ivs.def = ivs.def;
    pokemon.ivs.hp = ivs.hp;

    const candidates = [];
    const cps = [];
    for (let level = MIN_LEVEL; level <= MAX_LEVEL; level += 0.5) {
      const cpm = pokemon.getCPMByLevel(level);
      if (!cpm) continue;
      const levelCp = pokemon.calculateCP(cpm, ivs.atk, ivs.def, ivs.hp);
      if (cp !== undefined && levelCp !== cp) continue;
      if (maxHp !== undefined) {
        // Only reached for the handful of levels still in the running, so the
        // (comparatively expensive) stat rebuild runs a few times per mon.
        if (level > pokemon.levelCap) pokemon.levelCap = level;
        pokemon.setLevel(level, false);
        pokemon.initialize(false);
        if (pokemon.stats.hp !== maxHp) continue;
      }
      candidates.push(level);
      cps.push(levelCp);
    }

    if (candidates.length === 1) return { level: candidates[0], candidates, cps, status: 'exact' };
    if (candidates.length === 0) return { candidates, cps, status: 'none' };
    return { level: candidates[0], candidates, cps, status: 'ambiguous' };
  };
}
