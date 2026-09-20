import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_META_POOL_SIZE, baseIdOf } from '../meta/sampleTeams.js';
import {
  DEFAULT_ARCHETYPE_BETA,
  DEFAULT_CORE_RIVALRY,
  DEFAULT_SIMILAR_RIVALRY,
  DEFAULT_SIMILAR_FLOOR,
} from '../meta/archetypes.js';
import { DEFAULT_SELECTION_TRAILING } from '../teams/evolve.js';
import { DEFAULT_FITNESS_WEIGHTS, FITNESS_SEMANTICS } from './fitness.js';

export const DEFAULTS = Object.freeze({
  population: 100,
  opponentsPerGen: 20,
  generations: 15,
  seed: 'pogo-gbl-team-generator-evolve',
  cp: 1500,
  cup: 'all',
  elites: 10,
  // 0.66 (Jaxon 2026-08-26, down from the 0.70 his real runs were passing).
  // Curated teams are the only OBSERVED-reality anchor in the opponent pool,
  // so they stay the majority; the extra 4 points go to the evolving half,
  // which is now composed from a meta-capped species pool and gets stronger
  // over the run instead of being random filler.
  curatedRatio: 0.66,
  // Candidate population at the LAST generation, as a fraction of the
  // gen-0 population (Jaxon 2026-08-26: "cull the candidate team count and
  // correspondingly increase the opponent team count ... so we can spend more
  // time refining the strongest teams instead of wasting resources on teams
  // that are too weak"). Opponent count is then DERIVED to hold
  // population x opponents -- the per-generation battle grid -- flat, so the
  // run's cost per generation does not change as the trade is made. See
  // populationAt/opponentsAt.
  populationFinalRatio: 0.4,
  // Species pool the sampled half of the opponent pool is composed from: the
  // top N of pvpoke's own overall ranking for the run's CP cap. See
  // src/meta/sampleTeams.js's META-CAPPED POOL note.
  opponentMetaPool: DEFAULT_META_POOL_SIZE,
  // Final-pass held-out strata (see the header note): the archive is capped
  // at this many of the strongest never-recently-fought evolved opponents the
  // opponent GA actually bred -- real, selected-for-fitness teams, so 400
  // puts the binomial standard error of a finalist's win% near 1.8 points
  // (the s2 run's single-generation number carried ~3.6) for real weight.
  // `finalFresh` defaults to 0 (see finalFreshDefault): a freshly meta
  // -composed team is drawn from the same weighted-random sampler that seeds
  // immigrants, with none of the opponent GA's generations of selection
  // behind it, so in bulk it is closer to a random legal team than a strong
  // one -- padding the pass with hundreds of them would mostly measure a
  // finalist's win rate against mediocrity. Neither is in the checkpoint
  // fingerprint: they change only the final pass.
  finalArchive: 400,
  finalFresh: 0,
  outDir: 'out',
  html: 'my-teams-evolve.html', // resolved against outDir unless --html/opts.html is absolute or explicit
  // Flipped to 'battle-reality' as the DEFAULT -- backed by a real A/B
  // (out/evolve-ab-classic vs out/evolve-ab-reality, same seed/collection/
  // opponents): battle-reality's top-10 showed the exact shift Jaxon's
  // original directive asked for (Stunfisk (Galarian)/Azumarill's dominance
  // fell from 5/7 of 10 top teams to 2/5; Skarmory -- absent from classic's
  // top 10 entirely -- entered twice as a back-line closer pick; Medicham rose
  // 2 -> 5). `--fitness classic` remains a fully-supported escape hatch
  // (standing rule for this initiative).
  fitness: 'battle-reality',
  // Sublinear per-archetype discount on candidate-side opponent weighting
  // (src/meta/archetypes.js) and on the elites-pass consistency score's
  // archetype grouping. See archetypeWeights' doc comment for the beta=0/1
  // extremes.
  archetypeBeta: DEFAULT_ARCHETYPE_BETA,
  // Frequency-normalised opponent fitness (see computeCandidateWeights):
  // down-weights a candidate team's contribution to an opponent's fitness by
  // the candidate's own most-common member's share of the population, so an
  // opponent isn't rewarded 15x for beating a 15%-share core instead of a
  // 1%-share one. On by default; --no-opponent-fitness-normalised restores
  // the old flat mean for comparison.
  opponentFitnessNormalised: true,
  // Opponent-strength weighting of each candidate's win rate (2026-09-09,
  // see evaluateTeamsInOrder): opponent j's vote is scaled by
  // (its own win rate against the population)^gamma, so beating a weak
  // singleton that barely wins anything itself earns little and beating a
  // strong team earns the most. 0 = off (every opponent votes equally).
  opponentStrengthGamma: 1,
  // Symmetric candidate-strength weighting of each opponent's fitness
  // (2026-09-17, see evaluateTeamsInOrder): mirrors opponentStrengthGamma on
  // the other side of the same ledger -- a candidate's vote toward an
  // opponent's fitness is scaled by (that candidate's own raw win rate
  // across the whole generation)^gamma, so an opponent that only ever beats
  // weak candidates doesn't outscore one that had to earn its wins. Without
  // this, opponentStrengthGamma alone discounted candidates' wins over weak
  // opponents but gave opponents no equivalent discount for beating weak
  // candidates, which pulled candidate fitness systematically below
  // opponent fitness on the same battles. 0 = off (every candidate votes
  // equally, the old behaviour).
  candidateStrengthGamma: 1,
  // Core rivalry on both GAs (src/meta/archetypes.js coreRivalryFitness):
  // each better team sharing a two-species core costs a team this fraction
  // of the field's fitness range before the cull ranks it -- a penalty
  // rather than a death sentence, so a second variant that plays differently
  // and fights well still survives. A team that is a better team's shadow
  // variant (whole-team similarity 0.9) pays 2.8 steps instead of 1 -- high,
  // but not fatal; only an exact duplicate dies outright, whatever R is.
  // Keeps a strong core from filling the pool with its own trailing
  // near-duplicates (the v2 run's opponent pool was 81% mutants of a few
  // cores by gen 59). 0 = off.
  coreRivalry: DEFAULT_CORE_RIVALRY,
  // SIMILAR cores in that penalty, scored by pvpoke's own "Similar Pokemon"
  // metric (src/engine/similarity.js: shared types, moves and traits,
  // normalised 0..1). Member pairs at or below `similarFloor` are unrelated;
  // above it they count linearly up to `similarRivalry` of an identical
  // species (Feraligatr vs Empoleon ~0.55 raw -> ~0.3 with the defaults).
  // A team is charged only for its most crowded core, never for two or
  // three at once. similarRivalry 0 = exact cores only.
  similarRivalry: DEFAULT_SIMILAR_RIVALRY,
  similarFloor: DEFAULT_SIMILAR_FLOOR,
  // Opponent composition normally rotates pvpoke's own published lead-prior
  // winner into slot 0 (composeSampledOpponent -> pickLeadIndex), while the
  // candidate side always assigns a uniform-random lead (assignLead /
  // buildLeadRotation) and only converges on a good one through selection.
  // For a meta-vs-meta run -- both sides drawing from the same pool, meant to
  // be symmetrical (see RUNBOOK's Symmetry rule) -- that gives the opponent
  // side a lead-quality head start the candidate side never gets, which
  // showed up as a persistent opponent-fitness-over-candidate-fitness gap
  // from generation 0 onward (2026-09-17, Jaxon). `--random-opponent-lead`
  // makes opponent composition assign a random lead too (roleScores omitted
  // from every composeSampledOpponent call), matching the candidate side
  // exactly. Off by default -- the standard recipe (real collection vs a
  // co-evolving meta) wants the opponent side's leads realistic, not random.
  randomOpponentLead: false,
});

export const FITNESS_MODES = ['classic', 'battle-reality'];

/**
 * How the final ranking blends the two win-rate measurements
 * (Jaxon 2026-08-26). `elitePass` is the dedicated final pass -- every elite
 * against the SAME broad opponent set (the full curated pool plus the run's
 * strongest evolved opponents), which makes it the only directly comparable,
 * apples-to-apples number the run produces, so it carries the majority.
 * `recent` is the team's mean win rate across the last few generations, which
 * is measured against a moving opponent pool and is therefore not comparable
 * team-to-team in absolute terms -- but it averages over several independent
 * opponent draws, so it carries information the single elites pass cannot:
 * whether a team is durably good or just had a favorable final matchup set.
 */
export const RANKING_WEIGHTS = Object.freeze({ elitePass: 0.7, recent: 0.3 });

/** Trailing window selection and the finalist pick average over (see the header note; `--selection-trailing`). */
export function selectionTrailingOf(config) {
  return Math.max(1, config.selectionTrailing ?? DEFAULT_SELECTION_TRAILING);
}

/**
 * Canonical JSON-serializable REQUESTED inputs for a run -- compared against
 * a checkpoint's `config` on resume (key-order stable and deliberately conservative).
 * `deadlineMinutes`, `threads` and `battleCache` are excluded on purpose:
 * none changes what any generation COMPUTES (deadline only decides whether to
 * stop before starting the next one; threads and the memo cache are pure
 * performance knobs), so changing any of them between runs must not
 * invalidate an existing checkpoint.
 */
export function buildRunConfig(csvPath, opts) {
  for (const key of [
    'snowballWeight', 'closerWeight', 'consistencyWeight', 'sharedWeaknessWeight',
    'opponentSnowballWeight', 'opponentCloserWeight', 'opponentConsistencyWeight', 'opponentSharedWeaknessWeight',
  ]) {
    if (opts[key] !== undefined && (!Number.isFinite(opts[key]) || opts[key] < 0)) {
      throw new Error(`evolve: opts.${key} must be a non-negative finite number`);
    }
  }
  return {
    csvPath: path.resolve(csvPath),
    // Meta mode forces expansion off: the meta collection already lists every
    // ranked build as its own row, and expansion would fold a ranked
    // pre-evolution (Morgrem, Zweilous, ...) into its evolved form's lineage,
    // deleting a build the opponent side still fields.
    evolutions: opts.metaMode ? false : opts.evolutions ?? true,
    // undefined = no cap, whole deduped collection (buildRankedPool).
    pool: opts.pool ?? undefined,
    seed: String(opts.seed ?? DEFAULTS.seed),
    cp: opts.cp ?? DEFAULTS.cp,
    // Part of the fingerprint: a resume with a different cup must start
    // fresh rather than reuse a population bred from a different candidate/
    // opponent pool (and rankings/format that would make the memo's cached
    // battle outcomes meaningless for the new format).
    cup: opts.cup ?? DEFAULTS.cup,
    curatedRatio: opts.curatedRatio ?? DEFAULTS.curatedRatio,
    excludeSpecies: [...(opts.excludeSpecies ?? [])].sort(),
    // Format-wide ban ("no Mimikyu, no Cramorant"), normalized to BASE
    // species ids up front (see the `--ban` helpers above) so a checkpoint's
    // fingerprint is stable whatever form the caller happened to type --
    // always in the fingerprint (like excludeSpecies), never opt-in, since it
    // changes both sides of what every generation computes.
    banSpecies: [...new Set((opts.banSpecies ?? []).map(baseIdOf))].sort(),
    difficulty: opts.difficulty ?? null,
    population: opts.population ?? DEFAULTS.population,
    opponentsPerGen: opts.opponentsPerGen ?? DEFAULTS.opponentsPerGen,
    generations: opts.generations ?? DEFAULTS.generations,
    fixedOpponents: !!opts.fixedOpponents,
    eliteCount: opts.eliteCount ?? DEFAULTS.elites,
    // Both change what every generation COMPUTES (the schedule decides each
    // generation's population/opponent counts; the meta-pool cap decides which
    // species a composed opponent can be made of), so both are part of the
    // checkpoint fingerprint.
    populationFinalRatio: opts.populationFinalRatio ?? DEFAULTS.populationFinalRatio,
    // Meta mode: both sides draw the whole ranked field unless a cap is passed (0 = no cap).
    opponentMetaPool: opts.opponentMetaPool ?? (opts.metaMode ? 0 : DEFAULTS.opponentMetaPool),
    // Part of the fingerprint -- resuming a 'classic' run's
    // checkpoints under 'battle-reality' (or vice versa) would silently graft
    // a different generation's fitness semantics onto a population that was
    // selected/mutated under the other one.
    fitness: opts.fitness ?? DEFAULTS.fitness,
    // Both change what every generation's battles WEIGH (archetypeBeta feeds
    // both opponentWeights and consistencyScore; opponentFitnessNormalised
    // changes which ledger opponentFitness reads), so both are part of the
    // checkpoint fingerprint -- resuming under a different value would
    // silently graft a different fitness semantics onto a population
    // selected/mutated under the old one.
    archetypeBeta: opts.archetypeBeta ?? DEFAULTS.archetypeBeta,
    opponentFitnessNormalised: opts.opponentFitnessNormalised ?? DEFAULTS.opponentFitnessNormalised,
    // Meta-vs-meta mode: both sides share one species universe, so the
    // candidate side draws from the whole ranked field, like the opponent
    // side. Part of the fingerprint.
    metaMode: !!opts.metaMode,
    // Changes what a composed opponent's lead IS, not just a weighting --
    // resuming under a different value would silently regenerate every
    // future opponent with a different lead policy than the ones already in
    // the pool. Part of the fingerprint for the same reason as the two above.
    randomOpponentLead: opts.randomOpponentLead ?? DEFAULTS.randomOpponentLead,
    // Fingerprint of the grouping/weighting semantics themselves (not a
    // knob): bumped 2026-09-09 when archetypeGroups moved from transitive
    // union-find to dominant-core-pair grouping and computeCandidateWeights
    // moved its clamp after mean-normalisation, so the v2 checkpoints
    // written under the old semantics start fresh instead of resuming.
    // Bumped again to v6 the same day when computeCandidateWeights switched
    // from species-share normalisation to the shared archetype-pair
    // crowding scheme (src/ga/core.js crowdingWeights) and opponent
    // selection started reading trailing-mean fitness instead of raw
    // single-generation fitness -- both change what a generation's numbers
    // MEAN, not just how they're computed, so a v5 checkpoint must not
    // resume under v6 semantics.
    // Bumped to v7 2026-09-10 when computeBlendFitness stopped returning an
    // unnormalized weighted sum (weights.winRate + consistency + snowball +
    // closer summing above 1 inflated blendFitness well past true winRate,
    // e.g. observed 90.5% blend vs 65.3% real winRate with
    // --snowball-weight 0.2 --closer-weight 0.1 --consistency-weight 0.1) --
    // now divides by the weight total, so a v6 checkpoint's elites were
    // selected under the inflated scale and must not resume under v7. Bumped
    // to v8 when shared weakness changed from an absolute severity-product
    // load with a fixed cap to rank-weighted top-200 exposure with simulated
    // lead counterplay; to v9 when the expensive matchup table was replaced
    // by selected-move type coverage; to v10 when the double lead/back-average
    // normalization (which structurally capped ordinary shared weaknesses
    // near a 0.8-0.95 score, indistinguishable from clean teams) was replaced
    // with per-shared-type risk terms normalized against a fixed global
    // worst case (the worst defensive typing PvPoke's chart can produce at
    // all, not each lead's own typing); to v11 when raw type prevalence (an
    // 18x top-to-bottom range in real top-200 data, e.g. Water at 1 vs Rock
    // at 0.055) was found to swamp the other three weights and was blended
    // down via PREVALENCE_INFLUENCE so a rare attacking type still costs most
    // of a common one's weight. Bumped to v12 2026-09-17 when
    // candidateStrengthGamma was added to weight each candidate's
    // contribution to an opponent's fitness by that candidate's own raw win
    // rate -- opponentFitness values under v11 are not comparable to v12's.
    // Bumped to v13 2026-09-18 (plans/WORKER_NOTES.md Item 2/3) when every
    // pairing started battling BOTH directions (candidate-as-A and
    // opponent-as-A, the latter mirrored back through mirrorBattleResult and
    // tallied identically) instead of only candidate-as-A -- removes the
    // measured ~1.9pt team-A seat bias structurally. battles/generation is
    // now 2 x population x opponents-per-gen, and the final elites pass
    // battles both directions too. v12 checkpoints have half as many battles
    // per pairing and a seat-biased fitness scale; they are not
    // resume-compatible.
    fitnessSemantics: FITNESS_SEMANTICS,
    opponentStrengthGamma: opts.opponentStrengthGamma ?? DEFAULTS.opponentStrengthGamma,
    candidateStrengthGamma: opts.candidateStrengthGamma ?? DEFAULTS.candidateStrengthGamma,
    snowballWeight: opts.snowballWeight ?? DEFAULT_FITNESS_WEIGHTS.snowball,
    closerWeight: opts.closerWeight ?? DEFAULT_FITNESS_WEIGHTS.closer,
    consistencyWeight: opts.consistencyWeight ?? DEFAULT_FITNESS_WEIGHTS.consistency,
    coreRivalry: opts.coreRivalry ?? DEFAULTS.coreRivalry,
    similarRivalry: opts.similarRivalry ?? DEFAULTS.similarRivalry,
    similarFloor: opts.similarFloor ?? DEFAULTS.similarFloor,
    // Canonicalize omitted and explicit zero weights. v7 already rejects
    // older scoring semantics; changing this weight must also reject resume.
    sharedWeaknessWeight: opts.sharedWeaknessWeight ?? DEFAULT_FITNESS_WEIGHTS.sharedWeakness,
    // Opponent-side equivalents of the four weights above (Jaxon 2026-09-17:
    // "add opponent side versions of the candidate side flags so that we can
    // have a symmetrical sim"). Same computeBlendFitness, same zero default
    // (an unconfigured run's opponent fitness is unchanged plain win rate),
    // fed the opponent's OWN ledger (see evaluateTeamsInOrder's opponentTally
    // extension) instead of a candidate's.
    opponentSnowballWeight: opts.opponentSnowballWeight ?? DEFAULT_FITNESS_WEIGHTS.snowball,
    opponentCloserWeight: opts.opponentCloserWeight ?? DEFAULT_FITNESS_WEIGHTS.closer,
    opponentConsistencyWeight: opts.opponentConsistencyWeight ?? DEFAULT_FITNESS_WEIGHTS.consistency,
    opponentSharedWeaknessWeight: opts.opponentSharedWeaknessWeight ?? DEFAULT_FITNESS_WEIGHTS.sharedWeakness,
    // GA-rate / convergence overrides enter the fingerprint ONLY when set:
    // they change what every generation computes, but leaving them out when
    // absent keeps every pre-flag checkpoint dir resumable.
    ...(opts.deathRate !== undefined ? { deathRate: opts.deathRate } : {}),
    ...(opts.mutationFloor !== undefined ? { mutationFloor: opts.mutationFloor } : {}),
    ...(opts.mutationCeil !== undefined ? { mutationCeil: opts.mutationCeil } : {}),
    ...(opts.mutationFloorStart !== undefined ? { mutationFloorStart: opts.mutationFloorStart } : {}),
    ...(opts.mutationCeilStart !== undefined ? { mutationCeilStart: opts.mutationCeilStart } : {}),
    ...(opts.opponentDeathRate !== undefined ? { opponentDeathRate: opts.opponentDeathRate } : {}),
    ...(opts.opponentMutationFloor !== undefined ? { opponentMutationFloor: opts.opponentMutationFloor } : {}),
    ...(opts.opponentMutationCeil !== undefined ? { opponentMutationCeil: opts.opponentMutationCeil } : {}),
    ...(opts.opponentMutationFloorStart !== undefined ? { opponentMutationFloorStart: opts.opponentMutationFloorStart } : {}),
    ...(opts.opponentMutationCeilStart !== undefined ? { opponentMutationCeilStart: opts.opponentMutationCeilStart } : {}),
    ...(opts.opponentImmigrantFraction !== undefined ? { opponentImmigrantFraction: opts.opponentImmigrantFraction } : {}),
    ...(opts.immigrantFraction !== undefined ? { immigrantFraction: opts.immigrantFraction } : {}),
    // Selection smoothing window (see the header note). Only-when-set, like
    // the rates above, so every pre-2026-09-05 checkpoint dir still resumes --
    // it then continues under the smoothed default from the resume point.
    // Sequential Halving (src/evolve/halving.js). Only-when-on: an off run's config is byte-identical
    // to before, and a checkpoint written under halving refuses to resume without it (and vice versa).
    ...(opts.halvingRounds > 1
      ? { halvingRounds: opts.halvingRounds, halvingKeep: opts.halvingKeep ?? 0.5 }
      : {}),
    ...(opts.selectionTrailing !== undefined ? { selectionTrailing: opts.selectionTrailing } : {}),
    ...(opts.convWindow !== undefined || opts.convTopN !== undefined
      ? {
          convergence: {
            ...(opts.convWindow !== undefined ? { window: opts.convWindow } : {}),
            ...(opts.convTopN !== undefined ? { topN: opts.convTopN } : {}),
          },
        }
      : {}),
    // NOT in the fingerprint, deliberately: `battleCache`, `threads` and
    // `deadlineMinutes` -- all three are pure speed knobs that cannot change a
    // battle's outcome (the memo returns what a re-simulation would return,
    // and worker count has been bit-identical to serial since the 2026-08-22
    // engine fix), so toggling one mid-run must not invalidate hours of
    // checkpoints.
  };
}

/**
 * Does a checkpoint's stored config describe the same run as this one?
 * `eliteCount` is still WRITTEN into every config (the report prints it) but
 * ignored here: it decides only how many last-generation teams enter the final
 * pass, never what a generation computes, so `--elites 30` must be able to
 * re-render a finished run's final pass without invalidating its checkpoints.
 * Stripping it on both sides keeps every older checkpoint (which stored it)
 * matching too.
 */
export function configsMatch(a, b) {
  const strip = ({ eliteCount, ...rest }) => rest;
  return JSON.stringify(strip(a ?? {})) === JSON.stringify(strip(b ?? {}));
}

/** Which config keys differ between a stale checkpoint and this run, for a resume-refusal error message. */
export function describeConfigMismatch(stale, current) {
  const keys = new Set([...Object.keys(stale ?? {}), ...Object.keys(current ?? {})]);
  keys.delete('eliteCount');
  const diffs = [];
  for (const key of keys) {
    const a = (stale ?? {})[key];
    const b = (current ?? {})[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${key}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
  return diffs.length > 0 ? diffs.join(', ') : 'unknown difference';
}

/**
 * Guard for the one input the config fingerprint cannot see: the collection's
 * CONTENT. Candidate keys are `${speciesId}#${sourceRow}` (src/scoring), so a
 * checkpoint's population only means something against the exact CSV it was
 * bred from. The 2026-09-09 `meta-vs-meta-newseason-v3` resume crashed with
 * `Cannot read properties of undefined (reading 'speciesId')` because sim.sh
 * --meta rebuilt out/meta-collection-1500.csv from a newer vendor pin whose
 * rankings order had shifted: every `speciesId#row` still parsed, but pointed
 * at a different species' row. Two checks, either of which throws a message
 * naming the actual cause instead of an undefined-property crash:
 *
 *  1. `collectionHash` (sha256 of the CSV bytes, written into every
 *     checkpoint alongside `config`, NOT part of the fingerprint so pre-hash
 *     checkpoint dirs still resume) must match when the checkpoint has one.
 *  2. Every key in the population to resume must resolve in the freshly
 *     built candidate lookup (`deduped.builtMons`) to the same speciesId the
 *     key names -- the fallback for checkpoints written before the hash.
 *
 * @param {object} args
 * @param {string[][]} args.population - teams (member keys) to resume from
 * @param {Record<string, {speciesId: string}>} args.builtMons - the freshly built lookup
 * @param {string|undefined} args.checkpointHash - `collectionHash` from the checkpoint, if any
 * @param {string} args.collectionHash - sha256 of the CSV about to be used
 * @param {string} args.csvPath - for the error text
 * @throws {Error} when the collection no longer matches the checkpoint
 */
export function assertCollectionMatchesCheckpoint({ population, builtMons, checkpointHash, collectionHash, csvPath }) {
  const hint =
    `Candidate keys are speciesId#csvRow, so a run can only resume against the byte-identical ` +
    `collection it started from (${csvPath}). Restore that file (for --meta runs: the CSV built ` +
    `from the vendor pin the run launched under), or delete the checkpoints to start fresh.`;
  if (checkpointHash && checkpointHash !== collectionHash) {
    throw new Error(
      `evolve: collection changed since the checkpoint was written ` +
        `(checkpoint sha256 ${checkpointHash.slice(0, 12)}, current ${collectionHash.slice(0, 12)}). ${hint}`
    );
  }
  const stale = [];
  for (const team of population) {
    for (const key of team) {
      const speciesOfKey = key.slice(0, key.lastIndexOf('#'));
      const built = builtMons[key];
      if (!built || built.speciesId !== speciesOfKey) stale.push(key);
    }
  }
  if (stale.length > 0) {
    const distinct = [...new Set(stale)];
    throw new Error(
      `evolve: ${distinct.length} candidate key(s) in the checkpoint population no longer resolve in the ` +
        `collection (e.g. ${distinct.slice(0, 5).join(', ')}). ${hint}`
    );
  }
}

export function hashFile(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}
