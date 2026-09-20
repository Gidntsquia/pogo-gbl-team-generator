import { baseIdOf } from '../meta/sampleTeams.js';

/** True if any of `speciesIds` has a base form in `banBaseIds`. */
function anyBaseIdBanned(speciesIds, banBaseIds) {
  return speciesIds.some((id) => banBaseIds.has(baseIdOf(id)));
}

/**
 * Every concrete speciesId present in `builtMons` (a buildCollection/dedupe
 * -shaped `{key: {speciesId}}` map, e.g. `dedupeBestPerSpecies`'s output)
 * whose base id (baseIdOf) is banned. Used to expand a `--ban` base-id list
 * into the exact-match `excludeSpecies` candidate teams already honor end to
 * end (src/teams/sample.js's buildScoredPool, src/teams/evolve.js's
 * initPopulation/nextGeneration) -- so a shadow variant the user happens to
 * own can't sneak a banned species onto a candidate team.
 *
 * @param {Record<string, {speciesId: string}>} builtMons
 * @param {Iterable<string>} banBaseIds
 * @returns {string[]}
 */
export function expandBanToCandidateSpeciesIds(builtMons, banBaseIds) {
  const banSet = banBaseIds instanceof Set ? banBaseIds : new Set(banBaseIds);
  if (banSet.size === 0) return [];
  const ids = new Set();
  for (const built of Object.values(builtMons)) {
    if (banSet.has(baseIdOf(built.speciesId))) ids.add(built.speciesId);
  }
  return [...ids];
}

/**
 * Drop WHOLE curated teams (src/meta/teams.js's loadMetaTeams output)
 * containing any banned base species -- a cup rule removes the team
 * entirely, not just the one banned member. Applying this once to the
 * `curatedPool` variable at load time reaches every use site downstream: the
 * per-generation opponent pool (initOpponentPool/nextOpponentPool's
 * `curated` param) and the final elites pass (`eliteCurated`).
 *
 * @param {import('../src/meta/teams.js').MetaTeam[]} teams
 * @param {Iterable<string>} banBaseIds
 * @returns {import('../src/meta/teams.js').MetaTeam[]}
 */
export function filterBannedCuratedTeams(teams, banBaseIds) {
  const banSet = banBaseIds instanceof Set ? banBaseIds : new Set(banBaseIds);
  if (banSet.size === 0) return teams;
  return teams.filter((t) => !anyBaseIdBanned(t.members.map((m) => m.speciesId), banSet));
}

/**
 * Drop banned-base-species entries from a moveset pool
 * (src/meta/sampleTeams.js's loadMovesetPool output). Applying this once to
 * the `movesetPool` variable reaches every composed-opponent path that
 * variable is threaded into: initOpponentPool, nextOpponentPool, and (through
 * nextOpponentPool's own `movesetPool` param) its buildMemberSwap mutation
 * and immigrant draws -- none of them load their own copy.
 *
 * @param {Array<{speciesId: string}>} pool
 * @param {Iterable<string>} banBaseIds
 * @returns {Array<{speciesId: string}>}
 */
export function filterBannedMovesetPool(pool, banBaseIds) {
  const banSet = banBaseIds instanceof Set ? banBaseIds : new Set(banBaseIds);
  if (banSet.size === 0) return pool;
  return pool.filter((e) => !banSet.has(baseIdOf(e.speciesId)));
}
