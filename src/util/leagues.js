// JavaScript Document
//
// CP cap -> league identity (GOALS T18c). One place to answer the two
// questions T18b deliberately deferred as design decisions rather than
// mechanical path substitutions:
//   - which vendor/pvpoke meta GROUP file represents "the meta" at this cap
//     (src/data/groups/<group>.json -- used by src/scoring/index.js's loadMeta
//     for the 1v1 pruning meta and by src/meta/usage.js's weight universe), and
//   - what to call the league in reports.
//
// The group names are pvpoke's own: great/ultra/master are the CP-capped
// "open" formats pvpoke ranks under the same "all" cup the engine uses (see
// src/engine/harness.js's initEngine), so the mapping is 1:1 with the CP caps
// pvpoke ships rankings for.
//
// No battle math, no data loading -- pure naming.

const LEAGUES = Object.freeze({
  500: { name: 'Little Cup', group: 'little' },
  1500: { name: 'Great League', group: 'great' },
  2500: { name: 'Ultra League', group: 'ultra' },
  10000: { name: 'Master League', group: 'master' },
});

export const DEFAULT_CP = 1500;

/**
 * @param {number} [cp] - CP cap; defaults to Great League's 1500.
 * @returns {{ cp: number, name: string, group: string }}
 * @throws if `cp` isn't a cap pvpoke ships data for.
 */
export function leagueForCp(cp = DEFAULT_CP) {
  const league = LEAGUES[cp];
  if (!league) {
    throw new Error(
      `leagueForCp: unsupported cp ${cp} -- pvpoke ships ${Object.keys(LEAGUES).join('/')}`
    );
  }
  return { cp, ...league };
}

/** Supported CP caps, ascending -- for CLI help/validation messages. */
export const SUPPORTED_CPS = Object.freeze(Object.keys(LEAGUES).map(Number).sort((a, b) => a - b));
