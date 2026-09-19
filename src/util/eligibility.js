// JavaScript Document
//
// Cup eligibility filtering for the candidate side. Pure given ctx's
// eligibleSpeciesIds (see src/engine/harness.js's initEngine/isEligible) --
// no battle math, no data loading.
//
// Must run AFTER evolution expansion (src/evolution/index.js's
// expandEvolutions), never before: filtering first would cut an owned Ralts
// (eligible, psychic type) before it could ever become Gallade (also
// eligible) or Gardevoir (banned by id) -- expansion needs the whole lineage
// present to decide which forms survive.

import { isEligible } from '../engine/harness.js';

/**
 * Drop mons the cup in `ctx` doesn't allow, collecting one warning per
 * dropped mon into the same shape the importer/evolution warnings use so
 * they land in the report's existing warnings section.
 *
 * `ctx.eligibleSpeciesIds === null` (i.e. `ctx.cup === 'all'`) is a no-op:
 * every mon passes through unfiltered and no warnings are produced.
 *
 * @param {object} ctx - from initEngine
 * @param {Array<{speciesId: string, shadow?: boolean, name?: string}>} mons
 * @returns {{ mons: Array, warnings: string[] }}
 * @throws if fewer than 3 mons survive (a legal GBL team needs 3) -- the
 *   error names the format so the cause is obvious without extra digging.
 */
export function filterEligibleMons(ctx, mons) {
  if (!ctx.eligibleSpeciesIds) return { mons, warnings: [] };

  const kept = [];
  const warnings = [];
  for (const mon of mons) {
    if (isEligible(ctx, mon)) {
      kept.push(mon);
    } else {
      const label = mon.name ? `${mon.name} (${mon.speciesId})` : mon.speciesId;
      const cupName = ctx.battle?.getCup?.()?.title ?? ctx.cup;
      warnings.push(`${label}: not eligible for ${cupName}`);
    }
  }

  if (kept.length < 3) {
    throw new Error(
      `filterEligibleMons: only ${kept.length} mon(s) eligible for cup "${ctx.cup}" -- ` +
        `need at least 3 to build a team`
    );
  }

  return { mons: kept, warnings };
}
