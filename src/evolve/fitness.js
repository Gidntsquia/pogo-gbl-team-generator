
export const LEADS = [0, 1, 2];

const CANDIDATE_LEAD = 0;

/**
 * Resolve an opponent team's designated lead index. Every opponent now
 * carries one explicitly: curated teams by src/meta/teams.js's file-wide
 * member-index-0-is-lead doctrine, and composed teams because
 * src/meta/sampleTeams.js rotates the chosen lead into slot 0 at composition
 * time (from pvpoke's own published `leads` rankings) and stamps
 * `leadIndex: 0`. The `?? 0` is the vendor-preset case, which shares the same
 * doctrine without stamping the field.
 */
function opponentLeadIndex(opp) {
  return opp.leadIndex ?? 0;
}

/**
 * Own-lead-locked single pairing: candidate's team[0] vs. the opponent's
 * declared lead. Exported (plans/WORKER_NOTES.md Item 3) so a study script
 * can feed `evaluateTeamsInOrder` the exact same pairing generator
 * `runEvolution`'s per-generation battles use, instead of a reimplementation.
 */
export function ownLeadPairing(opp) {
  return [{ leadA: CANDIDATE_LEAD, leadB: opponentLeadIndex(opp) }];
}

/**
 * Turn a `battleTeams` result fought with team A and team B swapped back into
 * one that reads as if the CANDIDATE had been team A all along (plans/
 * WORKER_NOTES.md Item 2 -- the fitness-symmetry fix). `winner` flips a<->b
 * (a tie stays a tie); `survivorsHp.{a,b,aPerMon,bPerMon}` swap; every
 * `summary` field whose name ends in `A` or `B` (both team-specific: leadA/
 * leadB, remainingA/B, throwAndGoSwitchesA/B, shieldsDeclinedA/B,
 * costlySwitchesA/B, freeSwitchesA/B, leadFaintTurnA/B, shieldsRemainingA/B)
 * swaps with its `B`/`A` partner; everything else (turns, duration,
 * difficulty, seed, endedBy, ...) is battle-wide and copied as-is. Throws if
 * an `A`/`B`-suffixed key has no partner -- a silent one-sided swap would
 * credit a battle to the wrong side rather than fail loudly. Pure: no battle
 * math, just relabeling an already-fought result (never edits
 * `vendor/pvpoke`, per AGENTS.md).
 * @param {object} r - a `battleTeams` result
 * @returns {object} the same battle, relabeled so its own team A is the side
 *   that was actually team B when it was fought
 */
export function mirrorBattleResult(r) {
  const winner = r.winner === 'tie' ? 'tie' : r.winner === 'a' ? 'b' : 'a';
  const survivorsHp = {
    a: r.survivorsHp.b,
    b: r.survivorsHp.a,
    aPerMon: r.survivorsHp.bPerMon,
    bPerMon: r.survivorsHp.aPerMon,
  };
  const summary = {};
  const done = new Set();
  for (const key of Object.keys(r.summary)) {
    if (done.has(key)) continue;
    if (key.endsWith('A') || key.endsWith('B')) {
      const otherSuffix = key.endsWith('A') ? 'B' : 'A';
      const pairKey = `${key.slice(0, -1)}${otherSuffix}`;
      if (!(pairKey in r.summary)) {
        throw new Error(`mirrorBattleResult: summary key "${key}" has no "${pairKey}" partner to swap with`);
      }
      summary[key] = r.summary[pairKey];
      summary[pairKey] = r.summary[key];
      done.add(key);
      done.add(pairKey);
    } else {
      summary[key] = r.summary[key];
    }
  }
  return { winner, survivorsHp, summary };
}

/**
 * Which side's ORIGINAL lead fainted first (lost the lead exchange), from
 * `battleTeams`' summary.
 * @returns {'a'|'b'|'simultaneous'|'none'}
 */
export function leadExchangeLoser(summary) {
  const { leadFaintTurnA: ta, leadFaintTurnB: tb } = summary;
  if (ta === null && tb === null) return 'none';
  if (ta === null) return 'b';
  if (tb === null) return 'a';
  if (ta === tb) return 'simultaneous';
  return ta < tb ? 'a' : 'b';
}

/**
 * Blend weights for `--fitness battle-reality` (documented judgment call --
 * a tunable blend whose numbers are chosen here;
 * not exposed as CLI flags, matching this file's own GA-TUNABLES
 * precedent above). `winRate` stays the majority component since it is the
 * only one measuring actual game outcomes; `snowball` is weighted
 * meaningfully (not a token amount) because a real-battle measurement
 * found winning the lead exchange roughly a 2.3-2.7x multiplier on win
 * probability (P(win|won)~=0.69-0.73 vs P(win|lost)~=0.27-0.31)
 * -- a strong, real signal about which
 * teams convert an early advantage, independent of whether their back line
 * ultimately closes the game out; `closer` gets the smallest share because
 * it is a SPECIES-level prior from pvpoke's own rankings, not a fact
 * about this collection's real battles the way the other two terms are.
 * `consistency` (added 2026-09-08, see docs/plans/2026-09-08-fitness-restructure.md)
 * answers "how does this team do against its worst ARCHETYPE", pulling
 * fitness back for teams that only beat the majority core and fold against
 * everything else; it takes its share out of `winRate` and `snowball` rather
 * than being tacked on, since it is itself a transform of winRate data.
 */
/**
 * See buildRunConfig's `fitnessSemantics` comment. Bumped to v14
 * (plans/PLAN.md Item 2, fitness-symmetry loop): the candidate and opponent
 * GAs now share src/ga/core.js's churn/slot-allocation accounting (churn
 * based on live population, floored immigrant reserve, post-build immigrant
 * backfill on both sides -- previously only the opponent pool had the
 * latter two), the opponent pool gained a shadowFlip mutation type for
 * parity with the candidate side, and the shared-weakness coverage lookup
 * (src/teams/typeCoverage.js) now keys by build (species+moveset) instead
 * of matrix key, so an opponent lead gets real coverage relief for the
 * first time instead of always reading the empty-map fallback.
 *
 * v16 (2026-09-19): no 1v1 scoring matrix. Candidate pool, draw weights and
 * specimen choice come from pvpoke rank alone (1/(rank+20) per species+shadow
 * build, last place when unranked); meta mode draws the whole ranked field on
 * both sides. Which teams get sampled changed, so v15 checkpoints cannot resume.
 */
export const FITNESS_SEMANTICS = 'core-pair-archetypes-v16';

export const TYPE_COVERAGE_META_SIZE = 200;

// Closer/consistency disabled for now (weights zeroed rather than removed,
// so they're a one-line revert away). Snowball is opt-in via
// --snowball-weight (candidate side only -- the opponent side has its own,
// separate win-rate fitness in src/meta/opponentPool.js, so this weight
// never touches it).
// `sharedWeakness` (added 2026-09-11) is likewise opt-in via
// --shared-weakness-weight: it rewards teams whose back line can actually be
// switched into when the lead's matchup goes bad (src/teams/typeCoverage.js).
// Unlike the other three it is a pure TYPE-CHART property of the roster, not
// a measurement of this generation's battles, so it stays off by default
// rather than quietly reshaping every run's selection pressure.
export const DEFAULT_FITNESS_WEIGHTS = Object.freeze({ winRate: 1, consistency: 0, snowball: 0, closer: 0, sharedWeakness: 0 });

/**
 * Per-team snowball score: this team's OWN fraction of DECIDED lead exchanges
 * (across its battles fought this generation) it won -- i.e. how often its
 * lead outlasts the opponent's, independent of whether the game is ultimately
 * won or lost. `exchangeWon`/`exchangeLost` exclude `'simultaneous'`/`'none'`
 * battles (a real-battle sample found ~15-21% of battles never see
 * either lead faint -- not a meaningful exchange signal either way). Falls
 * back to `winRate` (not 0 or 0.5) when a team had zero decided exchanges
 * this generation (a tiny --opponents-per-gen, or a team that only ever
 * fights to a stalemate) -- a neutral choice that doesn't bias the blend
 * toward or away from a team the sample simply couldn't measure.
 */
export function computeSnowballScore(exchangeWon, exchangeLost, winRate) {
  const decided = exchangeWon + exchangeLost;
  return decided > 0 ? exchangeWon / decided : winRate;
}

/**
 * Per-team closer score: mean of the `loadRoleScores` `closer` prior across
 * the team's two BACK members (`team[1]`/`team[2]`, i.e. `members.slice(1)`)
 * -- documented judgment call: the closer role is specifically about being
 * switched in with a shield advantage to close out a game (the shield
 * -banking findings), which is a back-line job under the locked-lead
 * convention, not the lead's. A species absent from the loader (never
 * happens for a real gamemaster speciesId under the pinned vendor commit,
 * but guarded anyway) contributes 0, not a skip -- an
 * unknown closer value is not evidence of a good one.
 */
export function computeCloserScore(members, roleScores) {
  const backs = members.slice(1);
  if (backs.length === 0) return 0;
  const sum = backs.reduce((s, m) => s + (roleScores?.get(m.speciesId)?.closer ?? 0), 0);
  return sum / backs.length;
}

export function computeBlendFitness(
  { winRate, snowballScore, closerScore, consistencyScore, sharedWeaknessScore },
  weights = DEFAULT_FITNESS_WEIGHTS
) {
  const consistency = consistencyScore ?? winRate;
  const consistencyWeight = weights.consistency ?? 0;
  // A team whose shared-weakness score was never computed (an older
  // checkpoint's entry replayed through this function) contributes its own
  // winRate at that weight, the same neutral fallback computeSnowballScore
  // uses -- not 0, which would read as "maximally locked" on no evidence.
  const sharedWeakness = sharedWeaknessScore ?? winRate;
  const sharedWeaknessWeight = weights.sharedWeakness ?? 0;
  const totalWeight = weights.winRate + consistencyWeight + weights.snowball + weights.closer + sharedWeaknessWeight;
  const blend =
    weights.winRate * winRate +
    consistencyWeight * consistency +
    weights.snowball * (snowballScore ?? winRate) +
    weights.closer * (closerScore ?? winRate) +
    sharedWeaknessWeight * sharedWeakness;
  return totalWeight > 0 ? blend / totalWeight : 0;
}

/**
 * Linear-interpolated percentile of a SORTED numeric array (ascending),
 * p in [0,1]. Deterministic, no ties-breaking needed (arithmetic mean of
 * the two bracketing values).
 */
export function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac;
}

/**
 * Per-team consistency score (added 2026-09-08 -- see
 * docs/plans/2026-09-08-fitness-restructure.md, section D): the 25th
 * percentile of the team's mean win rate PER ARCHETYPE (see
 * src/meta/archetypes.js), i.e. "what does this team do against its worst
 * archetype", scale-free rather than a mean-minus-std. Fewer than 4
 * archetypes in the sample is too few for a percentile to mean anything, so
 * consistencyScore falls back to the team's overall winRate in that case.
 *
 * @param {Array<{winRate: number, archetypeGroup: number|null, strength?: number}>} perMeta -
 *   per-opponent results for one team this pass, each tagged with its
 *   opponent's archetype group id (null if no grouping was supplied).
 * @param {number} winRate - this team's overall (weighted) win rate, the
 *   fallback when there are too few archetypes to percentile over.
 * @returns {{consistencyScore: number, archetypeWinRates: number[]}}
 */
export function computeConsistencyScore(perMeta, winRate) {
  const byGroup = new Map();
  for (const p of perMeta) {
    if (p.archetypeGroup === null || p.archetypeGroup === undefined) continue;
    // Each opponent's vote inside its archetype carries its strength weight
    // (perMeta[].strength, 1 when strength weighting is off).
    const w = p.strength ?? 1;
    if (!(w > 0)) continue;
    const cur = byGroup.get(p.archetypeGroup) ?? { sum: 0, n: 0 };
    cur.sum += p.winRate * w;
    cur.n += w;
    byGroup.set(p.archetypeGroup, cur);
  }
  const archetypeWinRates = [...byGroup.values()].map((v) => v.sum / v.n);
  if (archetypeWinRates.length < 4) return { consistencyScore: winRate, archetypeWinRates };
  const sorted = [...archetypeWinRates].sort((a, b) => a - b);
  return { consistencyScore: percentile(sorted, 0.25), archetypeWinRates };
}

/**
 * P(win the game | won the lead exchange) -- `null` (not 0) when the team had
 * zero decided-and-won exchanges this run: the sample can't measure it, which
 * is different from measuring a 0% conversion rate.
 */
export function computeSnowballIndex(winsGivenExchangeWon, exchangeWon) {
  return exchangeWon > 0 ? winsGivenExchangeWon / exchangeWon : null;
}

/** P(win the game | lost the lead exchange) -- the "comeback" rate. `null` when never measured (same reasoning as {@link computeSnowballIndex}). */
export function computeComebackIndex(winsGivenExchangeLost, exchangeLost) {
  return exchangeLost > 0 ? winsGivenExchangeLost / exchangeLost : null;
}

/**
 * Designated closer: of the team's two BACK members, whichever carries the
 * HIGHER role-prior `closer` score (same "closing is a back-line job"
 * rationale as {@link computeCloserScore}, but reporting the standout member
 * rather than the pair's mean). `null` if the team has no back members. A
 * missing role-score (never happens for a real gamemaster speciesId under
 * the pinned vendor commit, but guarded anyway) counts
 * as 0, same convention as computeCloserScore.
 * @returns {{key:string, speciesId:string, name:string, closer:number}|null}
 */
export function pickDesignatedCloser(members, roleScores) {
  const backs = members.slice(1);
  if (backs.length === 0) return null;
  return backs.reduce((best, m) => {
    const closer = roleScores?.get(m.speciesId)?.closer ?? 0;
    return !best || closer > best.closer ? { key: m.key, speciesId: m.speciesId, name: m.name, closer } : best;
  }, null);
}
