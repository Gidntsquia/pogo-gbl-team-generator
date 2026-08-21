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

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildMetaMon, buildRecommendedMon } from '../scoring/index.js';

// pvpoke's own "GO Battle League" curated Great League (CP 1500) preset set:
// 25 three-mon teams, each member with an explicit fast + two charged moves.
// This is the file pvpoke's Training mode offers as the "GO Battle League"
// opponent presets, so it tracks the live meta as the pin is bumped.
const DEFAULT_TEAMS_FILE = 'src/data/training/teams/gobattleleague/1500.json';

// GOALS T10b: community-curated Great League teams (top-player recommended +
// off-meta), committed at the repo root (not vendor -- this is our own data,
// not pvpoke's). Path is relative to the process cwd, mirroring
// src/meta/usage.js's `data/meta-usage.json` snapshot convention (both assume
// the CLI/tests run from repo root).
const DEFAULT_COMMUNITY_FILE = 'data/meta-teams-community.json';

// Community teams tagged tier:"off-meta" get a reduced relative weight when
// sampleOpponentTeams draws from the curated pool (documented per GOALS T10b:
// "reduced, documented sampling weight (e.g. half) relative to untagged
// (meta) teams"). Exported so sampleTeams.js's curated draw can share it
// instead of re-deriving the same number.
export const OFF_META_CURATED_WEIGHT = 0.5;

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

/** Build the pvpoke-preset half of the curated pool (previously loadMetaTeams' whole body). */
function buildVendorTeams(ctx, teamsFile) {
  const presets = readTeamPresets(ctx, teamsFile);
  const teams = [];
  for (const preset of presets) {
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
    teams.push({ id, name, tier: 'meta', members });
  }
  return teams;
}

/**
 * @typedef {object} CommunityTeamEntry - one entry in data/meta-teams-community.json.
 * @property {string} id
 * @property {string} [name]
 * @property {'off-meta'} [tier] - absent = regular (untagged) meta team.
 * @property {string[]} members - exactly 3 pvpoke speciesIds ("_shadow" suffix for shadow forms).
 */

/** Read+parse the community teams file (or opts.communityEntries); [] if the file is absent. */
function readCommunityEntries(opts) {
  if (opts.communityEntries) return opts.communityEntries;
  const filePath = opts.communityFile ?? DEFAULT_COMMUNITY_FILE;
  if (!existsSync(filePath)) return [];
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  return Array.isArray(raw.teams) ? raw.teams : [];
}

/**
 * Load GOALS T10b's community-curated Great League teams
 * (data/meta-teams-community.json: top-player-recommended teams plus a
 * lower-weight "off-meta" tier), building every member via
 * buildRecommendedMon (pvpoke's own recommended moveset -- these entries only
 * name species membership, not full presets like the vendor training file).
 *
 * Unlike loadMetaTeams' vendor presets, a community entry that fails to
 * resolve (a speciesId absent from the pinned gamemaster -- expected for a
 * few JP ids like arctibax) drops the WHOLE team rather than the one member:
 * two mons isn't a team. A data edit introducing a bad id therefore degrades
 * gracefully (warns to stderr, keeps running) instead of crashing a run.
 *
 * @param {object} ctx - from initEngine (src/engine/harness.js)
 * @param {{ communityFile?: string, communityEntries?: CommunityTeamEntry[] }} [opts]
 *   `communityEntries` overrides reading the file entirely (testability,
 *   mirrors the `*Entries` pattern used elsewhere in this project).
 * @returns {MetaTeam[]} ids namespaced "community:<entry id>" so they can
 *   never collide with a vendor-preset id; `tier` is 'off-meta' or 'meta'.
 */
export function loadCommunityTeams(ctx, opts = {}) {
  const entries = readCommunityEntries(opts);
  const teams = [];
  for (const entry of entries) {
    if (!Array.isArray(entry.members) || entry.members.length !== TEAM_SIZE) {
      process.stderr.write(
        `loadCommunityTeams: skipping "${entry.id}" -- expected ${TEAM_SIZE} members, got ${entry.members?.length ?? 0}\n`
      );
      continue;
    }
    const members = [];
    let unresolved = null;
    for (const speciesId of entry.members) {
      const built = buildRecommendedMon(ctx, speciesId);
      if (!built) {
        unresolved = speciesId;
        break;
      }
      members.push(built);
    }
    if (unresolved) {
      process.stderr.write(
        `loadCommunityTeams: dropping "${entry.id}" -- unresolvable speciesId "${unresolved}"\n`
      );
      continue;
    }
    teams.push({
      id: `community:${entry.id}`,
      name: entry.name ?? members.map((m) => displayName(ctx, m)).join(' / '),
      tier: entry.tier ?? 'meta',
      members,
    });
  }
  return teams;
}

/**
 * Load the curated Great League opponent-team pool and build every member
 * into a battle-ready pvpoke Pokemon: pvpoke's own "GO Battle League" preset
 * teams (buildVendorTeams), plus GOALS T10b's community-curated teams
 * (loadCommunityTeams), merged vendor-first then community-meta then
 * community-off-meta.
 *
 * That ordering IS the exhaustive path's off-meta cap (per GOALS T10b:
 * "the exhaustive path may cap how many off-meta teams it includes"):
 * off-meta teams sort last, so a typical small `limit` (the exhaustive CLI
 * path's default `--meta 5`) never reaches them at all -- they only surface
 * once a caller asks for enough teams to exhaust the vendor + community-meta
 * pool ahead of them (25 vendor + up to 17 community-meta under the pinned
 * data). An unlimited/full call still returns every off-meta team.
 *
 * Each member is a distinct built instance, so a returned team can be handed
 * straight to `battleTeams` as one side. `battleTeams` fullResets every mon at
 * the start of each battle, so the same MetaTeam may be reused as the opponent
 * across many candidate battles.
 *
 * @param {object} ctx - from initEngine (src/engine/harness.js)
 * @param {{ limit?: number, teamsFile?: string, communityFile?: string,
 *           communityEntries?: CommunityTeamEntry[], includeCommunity?: boolean }} [opts]
 *   `limit` caps how many teams are built (default: all), sliced off the
 *   merged (vendor + community) list -- see the ordering note above.
 *   `teamsFile` overrides which pvpoke training-teams file is read (default:
 *   the GO Battle League Great League presets); path is relative to
 *   ctx.vendorRoot. `communityFile`/`communityEntries` are forwarded to
 *   loadCommunityTeams. `includeCommunity: false` restores the pre-T10b
 *   vendor-only pool (testability / an explicit opt-out).
 * @returns {MetaTeam[]}
 */
export function loadMetaTeams(ctx, opts = {}) {
  const teamsFile = opts.teamsFile ?? DEFAULT_TEAMS_FILE;
  const vendorTeams = buildVendorTeams(ctx, teamsFile);

  const community = opts.includeCommunity === false ? [] : loadCommunityTeams(ctx, opts);
  const communityMeta = community.filter((t) => t.tier !== 'off-meta');
  const communityOffMeta = community.filter((t) => t.tier === 'off-meta');

  const merged = [...vendorTeams, ...communityMeta, ...communityOffMeta];
  return typeof opts.limit === 'number' ? merged.slice(0, opts.limit) : merged;
}
