/**
 * Move-name-to-pvpoke-moveId resolver, for GOALS T17's current-moves mode.
 *
 * Resolves a CSV's human-readable move name (e.g. "Ice Beam") against ONE
 * species' own `fastMoves`/`chargedMoves` pool from the vendored gamemaster
 * -- never a global move-name index -- because a handful of moveIds share a
 * display name across species with a different underlying move (e.g.
 * Aegislash's "Air Slash" charged move is `AEGISLASH_CHARGE_AIR_SLASH`, a
 * different id from the common fast move `AIR_SLASH`). Scoping the lookup to
 * the resolved species' own move pool sidesteps that collision entirely
 * instead of trying to disambiguate by fast-vs-charged move stats.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GAMEMASTER_PATH = path.resolve(
  __dirname,
  '../../vendor/pvpoke/src/data/gamemaster.json'
);

/** Same normalization approach as gamemaster.js's species resolver. */
function normalizeKey(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

let cachedDefault = null;

function buildMoveData(gamemasterPath) {
  const gm = JSON.parse(readFileSync(gamemasterPath, 'utf8'));
  return {
    moveNameById: new Map(gm.moves.map((m) => [m.moveId, m.name])),
    pokemonById: new Map(gm.pokemon.map((p) => [p.speciesId, p])),
  };
}

/**
 * Build a move resolver bound to a gamemaster file (default: the vendored
 * one). The parsed index is cached at module scope for the default path,
 * mirroring gamemaster.js's species-resolver caching.
 *
 * @param {string} [gamemasterPath]
 * @returns {(input: { speciesId: string, shadow?: boolean, fastMoveName?: string, chargedMoveNames?: string[] }) => ({ fastMove: string, chargedMoves: string[] } | null)}
 *   Returns null when the species can't be found, its fast move name doesn't
 *   resolve against that species' fastMoves pool, or NEITHER charged move
 *   name resolves against its chargedMoves pool (at least one charged move
 *   is required -- pvpoke's own applyGroupMoveset needs chargedMoves[0]).
 */
export function createMoveResolver(gamemasterPath = DEFAULT_GAMEMASTER_PATH) {
  const isDefault = gamemasterPath === DEFAULT_GAMEMASTER_PATH;
  if (isDefault && cachedDefault) return cachedDefault;

  const { moveNameById, pokemonById } = buildMoveData(gamemasterPath);

  function findInPool(name, pool) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed || !pool) return undefined;
    const key = normalizeKey(trimmed);
    return pool.find((id) => normalizeKey(moveNameById.get(id) ?? '') === key);
  }

  function resolveMoves({ speciesId, shadow = false, fastMoveName, chargedMoveNames = [] }) {
    const shadowEntry = shadow ? pokemonById.get(`${speciesId}_shadow`) : undefined;
    const entry = shadowEntry ?? pokemonById.get(speciesId);
    if (!entry) return null;

    const fastMove = findInPool(fastMoveName, entry.fastMoves);
    const chargedMoves = chargedMoveNames
      .map((name) => findInPool(name, entry.chargedMoves))
      .filter(Boolean)
      .slice(0, 2);

    if (!fastMove || chargedMoves.length === 0) return null;
    return { fastMove, chargedMoves };
  }

  if (isDefault) cachedDefault = resolveMoves;
  return resolveMoves;
}
