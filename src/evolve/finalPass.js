import { composeSampledOpponent } from '../meta/sampleTeams.js';
import { archetypeGroups } from '../meta/archetypes.js';
import { curatedTierWeight } from '../meta/teams.js';
import { rngFromSeed } from '../util/rng.js';
import { rehydrateOpponentPool } from '../meta/opponentPool.js';
import { shadowBlindSignature, trailingFitness } from '../teams/evolve.js';
import { DEFAULTS, RANKING_WEIGHTS, selectionTrailingOf } from './config.js';
import { ownLeadPairing } from './fitness.js';
import { teamSignature } from './analytics.js';
import { evaluateTeamsInOrder } from './evaluate.js';

/**
 * Final-pass opponent weights (Jaxon 2026-08-27: "weight ladder teams more
 * than the curated/off meta teams, which should be weighted more than the
 * sample teams"). Curated opponents weigh in at their tier's
 * CURATED_TIER_WEIGHTS value (src/meta/teams.js: meta/ladder 1, recommended
 * 0.5, off-meta 0.25). The bred/composed strata (archive + fresh) together
 * carry the run's own evolved share -- a total of curatedTotal x (1 - r) / r
 * at --curated-ratio r, split evenly -- so the headline mixes real teams and
 * bred teams the way the generations that produced the finalists did (the
 * stated intent of the pre-2026-09-05 pass, which in practice fell far short
 * of it because the live pool held only a couple dozen evolvable entries).
 * With no curated teams (r = 0) every opponent weighs 1. Only the final-pass
 * win rate is weighted -- per-generation fitness and the `recent` ranking
 * term stay unweighted.
 *
 * @param {{curated: Array<object>, evolvedCount: number, curatedRatio: number}} params
 * @returns {number[]} weights, curated first then `evolvedCount` evolved.
 */
function finalPassWeights({ curated, evolvedCount, curatedRatio }) {
  const curatedWeights = curated.map((t) => curatedTierWeight(t));
  if (curated.length === 0 || evolvedCount === 0) {
    return [...curatedWeights, ...new Array(evolvedCount).fill(1)];
  }
  const curatedTotal = curatedWeights.reduce((s, w) => s + w, 0);
  const r = Math.min(Math.max(curatedRatio, 1e-9), 1);
  const each = (curatedTotal * (1 - r)) / r / evolvedCount;
  return [...curatedWeights, ...new Array(evolvedCount).fill(each)];
}

// `finalFresh` fallback when the flag is not set explicitly: 0 in the normal
// case (a curated set is in play, so the archive stratum is the only
// held-out one needed), but at --curated-ratio 0 there is no reality-check
// stratum at all, so a SMALL number of fresh teams is let in anyway -- kept
// low because a freshly composed team is essentially a random legal team,
// not one the opponent GA selected for strength (see DEFAULTS.finalFresh).
export const FINAL_FRESH_WHEN_NO_CURATED = 20;

function finalFreshDefault(config) {
  return config.curatedRatio > 0 ? DEFAULTS.finalFresh : FINAL_FRESH_WHEN_NO_CURATED;
}

/**
 * Hall-of-fame archive for the final pass: every distinct evolved opponent
 * that ever sat in a generation's pool, ranked by its mean fitness (1 - the
 * candidate win rate against it) over the generations it was measured in,
 * EXCLUDING every opponent present in the pools of the last
 * `holdoutGenerations` generations -- those are the pools the finalists'
 * selection statistic was measured on, so re-fighting them would re-measure
 * the number that chose the finalists (see the header note). Curated entries
 * are skipped here because the pass takes every curated team separately.
 * Pure: reads only what the checkpoints already store, so a finished run can
 * be re-rendered against it. Deterministic (ties on id).
 *
 * @param {Array<{opponentPool?: Array<object>, opponentFitness?: number[]}>} records
 *   oldest-first per-generation records (checkpoint shape).
 * @param {{holdoutGenerations: number, limit: number}} opts
 * @returns {{archive: Array<object>, eligible: number, seen: number, heldOut: number}}
 *   `archive` holds serialized opponent entries (rehydrate before battling)
 *   with `meanFitness` and `generations` attached, strongest first.
 */
export function buildOpponentArchive(records, { holdoutGenerations, limit }) {
  const stats = new Map();
  const heldOut = new Set();
  const cutoff = records.length - Math.max(0, holdoutGenerations);
  records.forEach((r, g) => {
    const pool = r.opponentPool ?? [];
    const fit = r.opponentFitness ?? [];
    pool.forEach((o, i) => {
      if (o.origin === 'curated') return;
      if (g >= cutoff) {
        heldOut.add(o.id);
        return;
      }
      const s = stats.get(o.id) ?? { entry: o, sum: 0, n: 0 };
      s.sum += fit[i] ?? 0;
      s.n += 1;
      stats.set(o.id, s);
    });
  });
  const ranked = [...stats.values()]
    .filter((s) => !heldOut.has(s.entry.id))
    .map((s) => ({ ...s.entry, meanFitness: s.sum / s.n, generations: s.n }))
    .sort((a, b) => b.meanFitness - a.meanFitness || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    archive: ranked.slice(0, Math.max(0, limit)),
    eligible: ranked.length,
    seen: stats.size + [...heldOut].filter((id) => !stats.has(id)).length,
    heldOut: heldOut.size,
  };
}

/**
 * `count` fresh meta-composed opponents for the final pass, none of which
 * carries an id in `usedIds` (every opponent the run ever fielded), so the
 * stratum is genuinely never-fought. Same composer the opponent GA's
 * immigrants use; seeded, so a re-render draws the same teams.
 */
function composeFreshOpponents(ctx, { count, seed, movesetPool, weights, roleScores, usedIds }) {
  const rng = rngFromSeed(`${seed}-final-fresh`);
  const used = new Set(usedIds);
  const out = [];
  const maxAttempts = count * 20 + 50;
  for (let attempts = 0; out.length < count && attempts < maxAttempts; attempts++) {
    const team = composeSampledOpponent(ctx, rng, movesetPool, weights, roleScores);
    if (used.has(team.id)) continue;
    used.add(team.id);
    out.push({ ...team, origin: 'fresh', label: 'fresh' });
  }
  return out;
}

/** Unweighted win rate per final-pass stratum (`perMeta[].label`: curated / archive / fresh). */
export function winRateByStratum(perMeta) {
  const acc = new Map();
  for (const m of perMeta ?? []) {
    const key = m.label ?? 'other';
    const cur = acc.get(key) ?? { sum: 0, n: 0 };
    cur.sum += m.winRate;
    cur.n += 1;
    acc.set(key, cur);
  }
  return Object.fromEntries([...acc.entries()].map(([k, v]) => [k, { winRate: v.sum / v.n, battles: v.n }]));
}

/**
 * How many trailing generations the `recent` term above averages over: the
 * last 5, or the last quarter of the run when fewer than 20 generations
 * actually ran (the two rules agree exactly at 20). At least 1 either way, so
 * a 1-generation run still produces a number rather than a null.
 */
const RECENT_WINDOW_GENERATIONS = 5;

const RECENT_WINDOW_MIN_GENERATIONS = 20;

function recentWindowSize(generationsRun) {
  if (generationsRun >= RECENT_WINDOW_MIN_GENERATIONS) return RECENT_WINDOW_GENERATIONS;
  return Math.max(1, Math.ceil(generationsRun / 4));
}

/**
 * Pick the finalists: the last generation's top `eliteCount` by the same
 * trailing mean selection ranks on (not the last draw), keeping only the
 * fitter of any shadow twins (same species and lead, differing only in who is
 * shadow) -- a twin bred in the final generation never faced its rival.
 *
 * @returns {{eliteIdx: number[], eliteTeams: Array, selectionAtEnd: number[], trailing: number}}
 */
function selectFinalists(env, state) {
  const { config, deduped, log } = env;
  const { history, lastEvaluated } = state;
  const trailing = selectionTrailingOf(config);
  const selectionAtEnd = trailingFitness(history, trailing);
  const rankedIdx = lastEvaluated.population
    .map((_, i) => i)
    .sort((a, b) => selectionAtEnd[b] - selectionAtEnd[a] || a - b);
  const seenShadowBlind = new Set();
  const eliteIdx = [];
  for (const i of rankedIdx) {
    if (eliteIdx.length >= config.eliteCount) break;
    const signature = shadowBlindSignature(lastEvaluated.population[i], deduped);
    if (seenShadowBlind.has(signature)) continue;
    seenShadowBlind.add(signature);
    eliteIdx.push(i);
  }
  const eliteTeams = eliteIdx.map((i) => lastEvaluated.population[i]);
  log(
    `evolve: finalists -- top ${eliteTeams.length} of ${lastEvaluated.population.length} last-generation teams ` +
      `by ${trailing}-generation mean fitness`
  );
  return { eliteIdx, eliteTeams, selectionAtEnd, trailing };
}

/**
 * The final pass's opponent set: every curated team at its declared lead, the
 * held-out ARCHIVE (strongest evolved opponents of the whole run, minus those
 * in the pools the finalists' trailing mean was measured on) and FRESH
 * meta-composed teams no candidate ever fought. Re-grading finalists against
 * the pool that just selected them would be a winner's curse.
 */
function buildFinalOpponents(env, state, trailing, teamCount) {
  const { config, opts, log, ctx, weights, opponentLeadRoleScores, curatedPool, movesetPool } = env;
  const { generationRecords } = state;
  const holdoutGenerations = Math.min(trailing, generationRecords.length);
  const archiveBuilt = buildOpponentArchive(generationRecords, {
    holdoutGenerations,
    limit: opts.finalArchive ?? DEFAULTS.finalArchive,
  });
  const archiveOpponents = rehydrateOpponentPool(ctx, archiveBuilt.archive, curatedPool, log).map((e) => ({
    ...e,
    label: 'archive',
  }));
  const everFielded = new Set();
  for (const r of generationRecords) for (const o of r.opponentPool ?? []) everFielded.add(o.id);
  const freshOpponents = composeFreshOpponents(ctx, {
    count: opts.finalFresh ?? finalFreshDefault(config),
    seed: config.seed,
    movesetPool,
    weights,
    roleScores: opponentLeadRoleScores,
    usedIds: everFielded,
  });
  // --curated-ratio 0 means no curated teams, so the final pass skips them too.
  const eliteCurated =
    config.curatedRatio > 0 ? curatedPool.map((t) => ({ ...t, label: 'curated', leadIndex: t.leadIndex ?? 0 })) : [];
  const eliteOpponents = [...eliteCurated, ...archiveOpponents, ...freshOpponents];
  const eliteOpponentWeights = finalPassWeights({
    curated: eliteCurated,
    evolvedCount: archiveOpponents.length + freshOpponents.length,
    curatedRatio: config.curatedRatio,
  });
  log(
    `evolve: final pass -- ${teamCount} teams x ${eliteOpponents.length} opponents ` +
      `(${eliteCurated.length} curated in full, ${archiveOpponents.length} archive held out of the last ` +
      `${holdoutGenerations} generation(s) [${archiveBuilt.eligible} eligible of ${archiveBuilt.seen} distinct evolved ` +
      `opponents seen], ${freshOpponents.length} fresh never fought before), each at its own lead`
  );
  return {
    eliteCurated, archiveOpponents, freshOpponents, eliteOpponents, eliteOpponentWeights, holdoutGenerations, archiveBuilt,
  };
}

/**
 * Final pass: battle the finalists against the held-out opponent set and rank
 * them on a blend of that pass (comparable across teams) and each team's mean
 * win rate over the last few generations (averages several independent
 * opponent draws). See RANKING_WEIGHTS / recentWindowSize.
 *
 * @returns {Promise<object>} elites, eliteRun, eliteOpponents and ranking facts for the report.
 */
export async function runFinalPass(env, state) {
  const { config, log, difficulty, executor, roleScores, deduped, typeCoverageContext, battleCache } = env;
  const { generationRecords } = state;
  const { eliteIdx, eliteTeams, selectionAtEnd, trailing } = selectFinalists(env, state);
  const opp = buildFinalOpponents(env, state, trailing, eliteTeams.length);
  const eliteRun = await evaluateTeamsInOrder(env.ctx, {
    teams: eliteTeams,
    matrix: deduped,
    opponents: opp.eliteOpponents,
    pairingsFor: ownLeadPairing,
    difficulty,
    opponentStrengthGamma: config.opponentStrengthGamma,
    snowballWeight: config.snowballWeight,
    closerWeight: config.closerWeight,
    consistencyWeight: config.consistencyWeight,
    sharedWeaknessWeight: config.sharedWeaknessWeight,
    typeCoverageContext,
    trackLeads: true,
    executor,
    onLog: log,
    roleScores,
    cache: battleCache,
    opponentWeights: opp.eliteOpponentWeights,
    // Archetype grouping only feeds each finalist's consistencyScore; it is not part of combinedScore.
    opponentArchetypeGroups: archetypeGroups(opp.eliteOpponents),
  });

  const recentWindow = recentWindowSize(generationRecords.length);
  const recentRecords = generationRecords.slice(-recentWindow);
  const recentWinRateFor = (signature) => {
    let sum = 0;
    let n = 0;
    for (const r of recentRecords) {
      const v = r.winRateBySignature?.[signature];
      if (typeof v === 'number') {
        sum += v;
        n += 1;
      }
    }
    return n > 0 ? { mean: sum / n, generations: n } : null;
  };
  const elites = eliteRun.results
    .map((r, i) => {
      // A team newer than the window (a final-generation immigrant) ranks on its final-pass win rate alone.
      const recent = recentWinRateFor(teamSignature(eliteTeams[i]));
      const combinedScore = recent
        ? RANKING_WEIGHTS.elitePass * r.winRate + RANKING_WEIGHTS.recent * recent.mean
        : r.winRate;
      return {
        ...r,
        sourceIndex: eliteIdx[i],
        signature: teamSignature(eliteTeams[i]),
        selectionFitness: selectionAtEnd[eliteIdx[i]],
        winRateByStratum: winRateByStratum(r.perMeta),
        recentWinRate: recent?.mean ?? null,
        recentGenerations: recent?.generations ?? 0,
        combinedScore,
      };
    })
    .sort((a, b) => b.combinedScore - a.combinedScore || b.winRate - a.winRate || b.avgHpMargin - a.avgHpMargin);
  return { elites, eliteRun, opp, recentWindow, trailing };
}
