// JavaScript Document
//
// Meta opponent team pool. Loads pvpoke's own curated Great League 3v3 teams
// (vendor/pvpoke/src/data/training/teams/gobattleleague/1500.json) and builds
// each member into a battle-ready pvpoke Pokemon via the scoring module's
// buildMetaMon (which itself only calls pvpoke's own Pokemon methods -- no
// battle math or moveset logic is reimplemented here).
//
// These teams are the opponent pool the 3v3 evaluator (T4) battles every
// candidate team against. See PLAN.md's Rev 2 section: "Meta opponents are
// real teams: pvpoke ships curated Great League teams in
// vendor/pvpoke/src/data/training/".

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildMetaMon } from '../scoring/index.js';

// pvpoke's own "GO Battle League" curated Great League (CP 1500) preset set:
// 25 three-mon teams, each member with an explicit fast + two charged moves.
// This is the file pvpoke's Training mode offers as the "GO Battle League"
// opponent presets, so it tracks the live meta as the pin is bumped.
const DEFAULT_TEAMS_FILE = 'src/data/training/teams/gobattleleague/1500.json';

const TEAM_SIZE = 3;

/**
 * @typedef {object} MetaMon - see src/scoring/index.js's buildMetaMon.
 * @property {string} speciesId
 * @property {string} baseSpeciesId
 * @property {boolean} shadow
 * @property {string} fastMove
 * @property {string[]} chargedMoves
 * @property {object} pokemon - built, battle-ready pvpoke Pokemon instance.
 */

/**
 * @typedef {object} MetaTeam
 * @property {string} id - stable id derived from the members' speciesIds,
 *   e.g. "azumarill-registeel-altaria". Stable across runs (positional order
 *   is preserved from the source file); safe to key report tables on.
 * @property {string} name - human label (Title-Cased species names joined by
 *   " / "), e.g. "Azumarill / Registeel / Altaria".
 * @property {MetaMon[]} members - exactly 3 built MetaMon (battle-ready).
 */

/**
 * @typedef {object} TeamPreset - one entry in a pvpoke training teams file.
 * @property {Array<{speciesId: string, fastMove: string, chargedMoves: string[], shadowType?: string}>} pokemon
 * @property {number} [weight]
 */

/** Read and parse a pvpoke training-teams JSON file into raw presets. */
function readTeamPresets(ctx, teamsFile) {
  const filePath = path.join(ctx.vendorRoot, teamsFile);
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  // The gobattleleague file is `{ presets: [...] }`; some other training
  // files are a bare `[...]` array of slot objects. Only the presets shape is
  // used by the MVP, but accept both so a different teamsFile can be swapped
  // in without a code change.
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.presets)) return raw.presets;
  throw new Error(`loadMetaTeams: unrecognized training-teams shape in ${teamsFile}`);
}

/** Title-case a pvpoke speciesId fragment for display ("_shadow" already stripped upstream). */
function titleCase(part) {
  return part
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Prefer pvpoke's own display name (gamemaster speciesName) for a built mon,
 * falling back to a title-cased speciesId when it's unavailable.
 */
function displayName(ctx, metaMon) {
  const data = ctx.gm.getPokemonById(metaMon.pokemon.speciesId);
  return data?.speciesName ?? titleCase(metaMon.speciesId);
}

/**
 * Load the curated Great League meta teams and build every member into a
 * battle-ready pvpoke Pokemon.
 *
 * Each member is a distinct built instance, so a returned team can be handed
 * straight to `battleTeams` as one side. `battleTeams` fullResets every mon at
 * the start of each battle, so the same MetaTeam may be reused as the opponent
 * across many candidate battles.
 *
 * @param {object} ctx - from initEngine (src/engine/harness.js)
 * @param {{ limit?: number, teamsFile?: string }} [opts]
 *   `limit` caps how many teams are built (default: all). `teamsFile`
 *   overrides which pvpoke training-teams file is read (default: the GO
 *   Battle League Great League presets); path is relative to ctx.vendorRoot.
 * @returns {MetaTeam[]}
 */
export function loadMetaTeams(ctx, opts = {}) {
  const teamsFile = opts.teamsFile ?? DEFAULT_TEAMS_FILE;
  const presets = readTeamPresets(ctx, teamsFile);
  const limited = typeof opts.limit === 'number' ? presets.slice(0, opts.limit) : presets;

  const teams = [];
  for (const preset of limited) {
    const roster = preset.pokemon;
    if (!Array.isArray(roster) || roster.length !== TEAM_SIZE) {
      // Skip malformed / non-3v3 presets rather than crash: keeps a partially
      // valid file usable. (The gobattleleague file is uniformly 3-mon.)
      continue;
    }
    const members = roster.map((entry) =>
      buildMetaMon(ctx, {
        speciesId: entry.speciesId,
        fastMove: entry.fastMove,
        chargedMoves: entry.chargedMoves,
      })
    );
    const id = members.map((m) => m.speciesId).join('-');
    const name = members.map((m) => displayName(ctx, m)).join(' / ');
    teams.push({ id, name, members });
  }
  return teams;
}
