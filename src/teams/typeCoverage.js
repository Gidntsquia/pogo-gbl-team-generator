// JavaScript Document
//
// Lead-aware defensive type coverage for candidate teams. The score is a
// bounded, rank-weighted expectation over attacking types represented in
// PvPoke's top 200, rather than an uncalibrated count divided by a magic cap.
// PvPoke supplies every type multiplier, ranking, and moveset; this module
// only combines those signals.

import { buildMetaMon } from '../scoring/index.js';

const SUPER_EFFECTIVE = 1.6;
const DOUBLE_SEVERITY = 2;
const LEAD_WEIGHT_SINGLE = 1.6;
const LEAD_WEIGHT_DOUBLE = 2.56;
const WEAKNESS_THRESHOLD = 1.3; // safely between PvPoke's discrete 1 and 1.6 values
const MOVE_COVERAGE_RELIEF = 0.8;
// A back member not sharing the lead's weakness can only ever fully switch
// in if it resists that type completely; dampen how much credit a partial
// resist gets so resistance can't erase a shared weakness's cost on its own.
const RESISTANCE_RELIEF = 0.7;
// Raw prevalence (see computeTypePrevalence) ranges the full 0..1 -- Rock sits
// at ~0.055 vs Water's 1 in real top-200 data -- which let prevalence alone
// swing a contribution by ~18x and swamped the other three weights. Blending
// it down to this influence means the least-prevalent type still costs
// (1 - PREVALENCE_INFLUENCE) of a fully-prevalent one, not next to nothing.
const PREVALENCE_INFLUENCE = 0.2;

/**
 * Fixed tuning divisor for the raw summed load, chosen empirically (not
 * derived from the type chart) so a normal team's load lands well inside
 * [0,1] before the final clamp.
 */
const LOAD_NORMALIZATION_DIVISOR = 3;

/**
 * Relative weakness severity. A single weakness is 1; a double weakness is
 * 2, reflecting that two typings contributed to it.
 */
export function weaknessSeverity(multiplier) {
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new TypeError('Defensive effectiveness must be a positive finite number');
  }
  if (!(multiplier > WEAKNESS_THRESHOLD)) return 0;
  // PvPoke's values contain float noise around 1.6 and 2.56. Snap those two
  // real chart states to stable relative severities rather than leaking the
  // noise into checkpoints and equality-sensitive diagnostics.
  return multiplier > 2 ? DOUBLE_SEVERITY : 1;
}

/**
 * Lead weakness weight, scaled to [0,1] against the strongest possible
 * weakness (a real double weakness, 2.56x). A single weakness (1.6x) weighs
 * 1.6/2.56; a double weighs the full 2.56/2.56 = 1.
 */
function leadWeaknessWeight(severity) {
  const multiplier = severity === DOUBLE_SEVERITY ? LEAD_WEIGHT_DOUBLE : LEAD_WEIGHT_SINGLE;
  return multiplier / LEAD_WEIGHT_DOUBLE;
}

/** Defensive attacking-type -> relative-severity map for a built Pokémon. */
export function weaknessProfile(pokemon) {
  const profile = new Map();
  const effectiveness = pokemon?.typeEffectiveness;
  if (!effectiveness || typeof effectiveness !== 'object' || Object.keys(effectiveness).length === 0) {
    throw new TypeError('Shared-weakness scoring requires a defensive typeEffectiveness map');
  }
  for (const type of Object.keys(effectiveness)) {
    const severity = weaknessSeverity(effectiveness[type]);
    if (severity > 0) profile.set(type, severity);
  }
  return profile;
}

function defensiveEffectiveness(pokemon, type) {
  const multiplier = pokemon?.typeEffectiveness?.[type];
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new TypeError(`Shared-weakness scoring requires defensive effectiveness for type "${type}"`);
  }
  return multiplier;
}

/**
 * Turn a rank-weighted top-meta list into a relative attacking-type prevalence
 * scale in [0,1]: the single most common attacking type scores 1, and every
 * other type scores its share of that maximum. A dual-type Pokémon splits its
 * weight between its two types, so every ranked Pokémon contributes the same
 * total mass.
 *
 * Normalizing by the max (rather than the sum across ~18 types) is deliberate:
 * a sum-to-1 distribution caps every type's weight near 1/18 regardless of how
 * dominant it actually is, which mutes the shared-weakness score into a narrow
 * band near 1 and makes it nearly inert as a fitness term. Scaling by the
 * dominant type instead lets a genuinely common shared weakness cost close to
 * its full uncapped severity.
 */
export function computeTypePrevalence(rankedMons, speciesWeights) {
  const raw = new Map();
  for (const mon of rankedMons ?? []) {
    const types = [...new Set((mon.pokemon?.types ?? []).filter((t) => t && t !== 'none'))];
    if (types.length === 0) continue;
    const weight = speciesWeights?.get(mon.speciesId) ?? 0;
    if (!(weight > 0)) continue;
    for (const type of types) raw.set(type, (raw.get(type) ?? 0) + weight / types.length);
  }
  const max = Math.max(0, ...raw.values());
  if (!(max > 0)) throw new TypeError('Type prevalence requires at least one positively weighted ranked Pokemon');
  return new Map([...raw].map(([type, value]) => [type, value / max]));
}

/**
 * Fraction of each ranked threat type that at least one of the lead's selected
 * fast/charged moves hits super effectively. This reads PvPoke's already-built
 * defensive effectiveness maps, so dual-type cancellations are respected
 * without simulating any additional battles.
 */
export function computeLeadCoverageScores(leadPokemon, rankedMons, speciesWeights) {
  const totals = new Map();
  const moves = [leadPokemon.fastMove, ...(leadPokemon.chargedMoves ?? [])].filter(Boolean);
  for (const mon of rankedMons) {
    const weight = speciesWeights.get(mon.speciesId) ?? 0;
    if (!(weight > 0)) continue;
    const covered = moves.some((move) => (mon.pokemon.typeEffectiveness?.[move.type] ?? 1) > WEAKNESS_THRESHOLD);
    for (const type of new Set((mon.pokemon.types ?? []).filter((t) => t && t !== 'none'))) {
      const current = totals.get(type) ?? { coveredWeight: 0, weight: 0 };
      if (covered) current.coveredWeight += weight;
      current.weight += weight;
      totals.set(type, current);
    }
  }
  return new Map([...totals].map(([type, value]) => [type, value.coveredWeight / value.weight]));
}

/**
 * A built mon's coverage lookup key: its exact build (species + fast +
 * charged moves), NOT the matrix's per-collection-row userMonKey. Two builds
 * with the same moveset hit the same threats regardless of which side (or
 * which collection row) produced them, so this is the one key both
 * `leadCoverageByKey` and `computeSharedWeaknessScore`'s lookup use --
 * candidate members (`matrix.builtMons[key]`) and opponent members
 * (`buildMetaMon`'s return) are both shaped `{speciesId, fastMove,
 * chargedMoves}`, so the same function keys both sides identically.
 */
export function coverageBuildKey(built) {
  return `${built.speciesId}|${built.fastMove}|${[...(built.chargedMoves ?? [])].sort().join(',')}`;
}

/** Build the run-wide top-meta prevalence and exact-build move-coverage maps. */
export function buildTypeCoverageContext(ctx, builtMons, rankedEntries, speciesWeights) {
  const rankedMons = rankedEntries.map((entry) => buildMetaMon(ctx, entry));
  const typeWeights = computeTypePrevalence(rankedMons, speciesWeights);
  const leadCoverageByKey = new Map();
  for (const built of Object.values(builtMons)) {
    leadCoverageByKey.set(coverageBuildKey(built), computeLeadCoverageScores(built.pokemon, rankedMons, speciesWeights));
  }
  return { metaSize: rankedMons.length, typeWeights, leadCoverageByKey };
}

/**
 * Rank-weighted shared-weakness score in [0,1]. A type only counts at all if
 * at least one back member is also weak to it (a shared weakness); each such
 * type then contributes one risk term, the product of four independent
 * weights:
 *
 *  - lead severity: 1 for an ordinary weakness, 1.6 for a real double
 *    weakness (the actual 2.56/1.6 damage ratio), scaled to [0,1] by the max.
 *  - prevalence: how common that attacking type is across PvPoke's
 *    rank-weighted top 200 (1 = the single most common type; see
 *    computeTypePrevalence), blended down by PREVALENCE_INFLUENCE so a
 *    rarely-seen attacking type still costs most of a common one's weight
 *    instead of raw prevalence (which spans a ~18x range top to bottom)
 *    swamping the other three factors.
 *  - coverage: reduced by up to 80% if the lead's own fast/charged moveset
 *    hits Pokémon of that type super effectively (it can shrug the type off
 *    offensively even though it's weak to it).
 *  - resistance: reduced by whatever fraction of damage the OTHER back
 *    member (the one not sharing the weakness) resists, since it can safely
 *    switch in. No mitigation if every back shares the weakness.
 *
 * Risk terms are summed into a raw load, then scaled by a fixed empirical
 * divisor (LOAD_NORMALIZATION_DIVISOR) and clamped to [0,1] -- a tuning
 * constant, not a derived worst-case ceiling.
 * When no context is supplied, prevalence defaults to 1 (worst case) and
 * coverage defaults to none.
 */
export function computeSharedWeaknessScore(members, context = {}) {
  const empty = { score: 1, load: 0, sharedTypes: [] };
  if (!members || members.length < 2) return empty;

  const leadProfile = weaknessProfile(members[0].pokemon);
  if (leadProfile.size === 0) return empty;
  const backs = members.slice(1);
  const suppliedTypeWeights = context.typeWeights instanceof Map && context.typeWeights.size > 0;
  const leadCoverage = context.leadCoverage ?? context.leadCoverageByKey?.get(coverageBuildKey(members[0])) ?? new Map();
  const sharedTypes = [];
  let load = 0;

  for (const [type, leadSeverity] of leadProfile) {
    const backMultipliers = backs.map((back) => defensiveEffectiveness(back.pokemon, type));
    const shared = backMultipliers.some((m) => weaknessSeverity(m) > 0);
    if (!shared) continue;

    const nonSharing = backMultipliers.filter((m) => weaknessSeverity(m) === 0);
    const resistanceOffset = nonSharing.length
      ? nonSharing.reduce((sum, m) => sum + Math.max(0, 1 - m), 0) / nonSharing.length
      : 0;

    const leadWeight = leadWeaknessWeight(leadSeverity);
    const prevalence = suppliedTypeWeights ? context.typeWeights.get(type) ?? 0 : 1;
    const prevalenceWeight = 1 - PREVALENCE_INFLUENCE * (1 - prevalence);
    const coverage = Math.max(0, Math.min(1, leadCoverage.get(type) ?? 0));
    const coverageOffset = MOVE_COVERAGE_RELIEF * coverage;
    const resistanceRelief = RESISTANCE_RELIEF * resistanceOffset;
    const contribution = leadWeight * prevalenceWeight * (1 - coverageOffset) * (1 - resistanceRelief);
    load += contribution;
    sharedTypes.push({
      type,
      leadSeverity,
      resistanceOffset,
      prevalence,
      prevalenceWeight,
      leadCoverage: coverage,
      coverageOffset,
      contribution,
    });
  }

  const normalizedLoad = Math.max(0, Math.min(1, load / LOAD_NORMALIZATION_DIVISOR));
  return { score: 1 - normalizedLoad, load: normalizedLoad, sharedTypes };
}
