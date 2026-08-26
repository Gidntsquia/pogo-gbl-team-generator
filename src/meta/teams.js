// JavaScript Document
//
// Meta opponent team pool. Loads pvpoke's own curated 3v3 teams
// (vendor/pvpoke/src/data/training/teams/gobattleleague/<cp>.json, cp from
// ctx.cp) and builds each member into a battle-ready pvpoke
// Pokemon via the scoring module's buildMetaMon (which itself only calls
// pvpoke's own Pokemon methods -- no battle math or moveset logic is
// reimplemented here).
//
// These teams are the opponent pool the 3v3 evaluator battles every
// candidate team against. Meta opponents are real teams: pvpoke ships
// curated Great League teams in vendor/pvpoke/src/data/training/.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildMetaMon, buildRecommendedMon } from '../scoring/index.js';

// pvpoke's own "GO Battle League" curated preset set, one file per CP cap
// (1500.json/2500.json/10000.json vendored -- great/ultra/master league,
// respectively); the Great League 1500.json is 25 three-mon teams, each
// member with an explicit fast + two charged moves. This is the file
// pvpoke's Training mode offers as the "GO Battle League" opponent presets,
// so it tracks the live meta as the pin is bumped.
function defaultTeamsFile(ctx) {
  return `src/data/training/teams/gobattleleague/${ctx.cp}.json`;
}

// Community-curated Great League teams (top-player recommended +
// off-meta), committed at the repo root (not vendor -- this is our own data,
// not pvpoke's). Path is relative to the process cwd, mirroring
// src/meta/usage.js's `data/meta-usage.json` snapshot convention (both assume
// the CLI/tests run from repo root).
const DEFAULT_COMMUNITY_FILE = 'data/meta-teams-community.json';

// That file is Great-League-only by construction (every
// team in it was recommended for GBL Season 27 Great League play), so it is
// NOT part of the curated pool at any other CP cap -- an Ultra League run
// would otherwise face GL archetypes re-built at 2500 CP, which is not a
// meaningful UL meta. A caller can still force it in with
// `includeCommunity: true`.
const COMMUNITY_FILE_CP = 1500;

/**
 * Relative draw weight per curated tier, used when sampleOpponentTeams picks
 * from the curated pool. Exported so sampleTeams.js's curated draw shares these
 * numbers instead of re-deriving them.
 *
 * The gradient is "how much does drawing this team tell me about what I will
 * actually face" (Jaxon, 2026-08-26):
 *
 * - `meta` (untagged) -- a team Jaxon fought on the GBL ladder, or one taken
 *   from PvPoke's own top-performer listings. Full weight.
 * - `recommended` -- a top player's *recommended* team, transcribed from a
 *   Reddit/YonkouJean infographic or a stream screenshot. Real teams, but
 *   second-hand and dated: what someone said to run, not what showed up across
 *   the net. Half weight.
 * - `off-meta` -- carried purely for surface diversity, not because it is
 *   likely. Quarter weight.
 *
 * A team with no `tier` field (e.g. a caller-supplied test fixture) counts as
 * full weight -- see curatedTierWeight.
 */
export const CURATED_TIER_WEIGHTS = Object.freeze({
  meta: 1,
  recommended: 0.5,
  'off-meta': 0.25,
});

/**
 * The draw weight for one curated team's tier, defaulting to full weight for an
 * untagged or unrecognized tier.
 * @param {{tier?: string}} team
 * @returns {number}
 */
export function curatedTierWeight(team) {
  return CURATED_TIER_WEIGHTS[team.tier] ?? CURATED_TIER_WEIGHTS.meta;
}

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
 * @property {number} [leadIndex] - index into `members` naming this team's
 *   established lead; present (always 0) on community teams,
 *   absent on vendor-preset teams (whose established lead is also member
 *   index 0, by the same file-wide/vendor-preset doctrine, just not stamped
 *   as a field -- see loadCommunityTeams' doc comment).
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
 * Build the pvpoke-preset half of the curated pool (previously loadMetaTeams'
 * whole body). Jaxon 2026-08-23: pvpoke's own gobattleleague
 * preset ordering is treated as lead-bearing too -- member index 0 IS the
 * established lead, same file-wide doctrine as data/meta-teams-community.json
 * -- no `leadIndex` field is stamped here since consumers already default to
 * index 0 for any team lacking one (see loadCommunityTeams' doc comment).
 */
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
 * @typedef {string | {speciesId: string, fastMove?: string, chargedMoves?: string[]}} CommunityMember
 *   A member is normally a bare pvpoke speciesId string ("_shadow" suffix for
 *   shadow forms), which builds with pvpoke's recommended moveset. The object
 *   form additionally records what a real opponent was actually seen carrying,
 *   when that differs from the recommendation -- e.g.
 *   `{"speciesId": "empoleon", "fastMove": "WATERFALL"}`. Both move fields are
 *   optional and merge independently over the recommendation (see
 *   src/scoring/index.js's MoveOverride), so an entry states only the half it
 *   observed. Unlearnable move ids warn to stderr and fall back to the
 *   recommendation for that slot; they never drop the team.
 */

/**
 * @typedef {object} CommunityTeamEntry - one entry in data/meta-teams-community.json.
 * @property {string} id
 * @property {string} [name]
 * @property {'recommended'|'off-meta'} [tier] - absent = regular (untagged) meta team, full weight.
 * @property {CommunityMember[]} members - exactly 3.
 */

/**
 * Split one CommunityMember into the speciesId to resolve and the move override
 * to merge over pvpoke's recommendation (null when the entry names no moves).
 * @param {CommunityMember} member
 * @returns {{speciesId: string | undefined, override: object | null}}
 */
function parseCommunityMember(member) {
  if (typeof member === 'string') return { speciesId: member, override: null };
  if (!member || typeof member !== 'object') return { speciesId: undefined, override: null };
  const { speciesId, fastMove, chargedMoves } = member;
  const override = fastMove || chargedMoves ? { fastMove, chargedMoves } : null;
  return { speciesId, override };
}

/** Read+parse the community teams file (or opts.communityEntries); [] if the file is absent. */
function readCommunityEntries(opts) {
  if (opts.communityEntries) return opts.communityEntries;
  const filePath = opts.communityFile ?? DEFAULT_COMMUNITY_FILE;
  if (!existsSync(filePath)) return [];
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  return Array.isArray(raw.teams) ? raw.teams : [];
}

/**
 * Load the community-curated Great League teams
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
 * A member may also be an object naming an explicit (possibly partial) moveset
 * instead of a bare speciesId -- see CommunityMember. That is the weaker
 * failure: a bad MOVE id warns and falls back to pvpoke's recommendation for
 * that slot, leaving a still-valid 3-mon team, because the moveset is an
 * annotation on a team that resolved fine without it.
 *
 * Jaxon 2026-08-23: every entry in data/meta-teams-community.json
 * treats `members[0]` as that team's established lead (the source images/
 * screenshots' own ordering for the pre-lead-index entries; Jaxon's directly
 * -observed opponent lead for the 'jaxon-ladder-*' entries). Every returned
 * team is stamped `leadIndex: 0` so a downstream driver's own opponent-lead
 * -resolution hook (e.g. scripts/evolve.mjs's `opponentLeadIndex()`) reads it
 * as explicit declared data instead of falling through to its own default.
 *
 * @param {object} ctx - from initEngine (src/engine/harness.js)
 * @param {{ communityFile?: string, communityEntries?: CommunityTeamEntry[] }} [opts]
 *   `communityEntries` overrides reading the file entirely (testability,
 *   mirrors the `*Entries` pattern used elsewhere in this project).
 * @returns {MetaTeam[]} ids namespaced "community:<entry id>" so they can
 *   never collide with a vendor-preset id; `tier` is 'off-meta' or 'meta';
 *   `leadIndex` is always 0 (see above).
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
    for (const member of entry.members) {
      const { speciesId, override } = parseCommunityMember(member);
      // A member object with no speciesId is as fatal as an unknown one: there
      // is nothing to build, so the team drops whole (see the doc comment).
      const built = speciesId ? buildRecommendedMon(ctx, speciesId, override) : null;
      if (!built) {
        unresolved = speciesId ?? JSON.stringify(member);
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
      leadIndex: 0,
      members,
    });
  }
  return teams;
}

/**
 * Load the curated Great League opponent-team pool and build every member
 * into a battle-ready pvpoke Pokemon: pvpoke's own "GO Battle League" preset
 * teams (buildVendorTeams), plus the community-curated teams
 * (loadCommunityTeams), merged vendor-first, then the community teams in
 * descending tier weight: meta, then recommended, then off-meta.
 *
 * That ordering IS the exhaustive path's low-weight cap (the exhaustive path
 * may cap how many low-weight teams it includes): the cheaper a tier's draw
 * weight, the later it sorts, so a typical small `limit` (the exhaustive CLI
 * path's default `--meta 5`) never reaches those tiers at all -- they only
 * surface once a caller asks for enough teams to exhaust the pool ahead of
 * them (25 vendor + up to 54 community-meta under the pinned data, then 27
 * recommended, then 1 off-meta). An unlimited/full call still returns every
 * team of every tier.
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
 *   the GO Battle League presets for ctx.cp); path is relative
 *   to ctx.vendorRoot. `communityFile`/`communityEntries` are forwarded to
 *   loadCommunityTeams. `includeCommunity` defaults to true only at the
 *   Great League cap the community file was curated for: `false`
 *   restores the pre-community vendor-only pool, `true` forces the GL community
 *   teams into a non-1500 run.
 * @returns {MetaTeam[]}
 */
export function loadMetaTeams(ctx, opts = {}) {
  const teamsFile = opts.teamsFile ?? defaultTeamsFile(ctx);
  const vendorTeams = buildVendorTeams(ctx, teamsFile);

  const includeCommunity = opts.includeCommunity ?? ctx.cp === COMMUNITY_FILE_CP;
  const community = includeCommunity ? loadCommunityTeams(ctx, opts) : [];
  // Heaviest tier first; Array#sort is stable in Node, so file order is kept
  // within a tier (that is what makes a team's position reproducible run to run).
  const byTierWeight = [...community].sort((a, b) => curatedTierWeight(b) - curatedTierWeight(a));

  const merged = [...vendorTeams, ...byTierWeight];
  return typeof opts.limit === 'number' ? merged.slice(0, opts.limit) : merged;
}
