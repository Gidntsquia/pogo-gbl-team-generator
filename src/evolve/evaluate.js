import { teamBuildCost } from '../cost/powerup.js';
import { battleTeams } from '../engine/teamBattle.js';
import { computeSharedWeaknessScore } from '../teams/typeCoverage.js';
import { computeCoreBreakExposure, teamBaseSpecies } from './breakExposure.js';
import { memberDisplayName, reportMemberDetail } from './format.js';
import {
  DEFAULT_FITNESS_WEIGHTS,
  LEADS,
  computeBlendFitness,
  computeCloserScore,
  computeComebackIndex,
  computeConsistencyScore,
  computeSnowballIndex,
  computeSnowballScore,
  leadExchangeLoser,
  mirrorBattleResult,
  pickDesignatedCloser,
} from './fitness.js';
import { createNullBattleCache } from './cache.js';

/**
 * Battle every team in `teams` against every opponent, in INPUT ORDER (not
 * sorted -- src/teams/evolve.js's nextGeneration needs fitness[i] to
 * correspond to population[i]).
 *
 * Structure: (1) plan every pairing and reduce it to a cache key; (2) run the
 * DISTINCT, not-already-cached pairings once, threaded or serial; (3) walk the
 * plan again and accumulate per-team and per-opponent statistics from the
 * outcome map. Step 2 is where the memo cache (and, with it, the whole
 * saving from re-fighting an unchanged grid) lives; steps 1 and 3 are the
 * same bookkeeping this function always did.
 *
 * @param {object} ctx
 * @param {{
 *   teams: string[][], matrix: object, opponents: object[],
 *   pairingsFor: (opp: object) => Array<{leadA:number, leadB:number}>,
 *   difficulty?: number, trackLeads?: boolean, executor?: object,
 *   onLog?: (msg:string)=>void, roleScores?: Map<string, object>,
 *   cache?: object, opponentWeights?: number[], candidateWeights?: number[],
 *   opponentArchetypeGroups?: number[], opponentStrengthGamma?: number,
 *   candidateStrengthGamma?: number, typeCoverageContext?: object,
 * }} params -- `opponentWeights[j]` (optional, parallel to `opponents`)
 *   weights opponent j's battles in each team's `winRate`; with
 *   `opponentStrengthGamma` > 0 (default 0 = off) that weight is further
 *   multiplied by (opponent j's own raw win rate against every team in this
 *   call)^gamma, so a vote from an opponent that barely wins anything counts
 *   for little and a vote from a strong one counts most -- computed from the
 *   same battles in a second pass, no extra fights; raw counts
 *   (`battles`, per-opponent tallies) are never weighted. `candidateStrengthGamma`
 *   (default 0 = off) is the symmetric term on the OTHER side of the same
 *   ledger: each opponent's `weightedWinPoints`/`weightedBattles` (below) is
 *   further scaled by (that candidate's own raw win rate across every
 *   opponent in this call)^gamma, so an opponent that only ever beats weak
 *   candidates doesn't outscore one that beat strong ones -- same second-pass
 *   shape as `opponentStrengthGamma`, no extra fights. `candidateWeights[i]`
 *   (optional, parallel to `teams`) weights team i's contribution to
 *   `opponentTally[j].weightedWinPoints`/`weightedBattles` (frequency-
 *   normalised opponent fitness, only ever passed from the per-generation
 *   loop -- the elites pass does not evolve opponents). `opponentArchetypeGroups[j]`
 *   (optional, parallel to `opponents`, from src/meta/archetypes.js) tags
 *   each `perMeta` entry with its opponent's archetype group id, so
 *   consistencyScore can be computed below. `sharedWeaknessWeight`
 *   (default 0) is the blend weight on src/teams/typeCoverage.js's per-team
 *   shared-weakness score, which is precomputed and reported when enabled.
 * @returns {Promise<{results:object[], opponentTally:Array<{winPoints:number, battles:number}>,
 *   opponentStrength:number[], battleCount:number, cachedCount:number, errorCount:number, elapsedMs:number,
 *   startedAt:number, finishedAt:number}>}
 *   `opponentTally[j]` is the CANDIDATE side's ledger against `opponents[j]`
 *   across every team battled -- src/meta/opponentPool.js turns it into that
 *   opponent's fitness (`1 - winPoints/battles`) at no extra battle cost.
 *   `battleCount` counts battles actually SIMULATED; `cachedCount` counts
 *   pairings served from the memo (both are reported, so a run's speedup is
 *   visible rather than implied).
 */
export async function evaluateTeamsInOrder(ctx, params) {
  // trackLeads' bestLead computation (below) predates the locked
  // leads and still iterates all 3 of the team's OWN lead slots -- left
  // as-is rather than redesigned. It still resolves correctly without any
  // code change: `pairingsFor` now only ever produces leadA=0 battles (see
  // ownLeadPairing above), so leadWins[1]/leadWins[2] and
  // leadBattles[1]/leadBattles[2] stay at 0 and the max-by-winRate reduce
  // below trivially always resolves to index 0 (`team[0]`, the locked lead).
  const {
    teams,
    matrix,
    opponents,
    pairingsFor,
    difficulty,
    trackLeads = false,
    executor,
    onLog,
    roleScores,
    opponentWeights = null,
    candidateWeights = null,
    opponentArchetypeGroups = null,
    candidateArchetypeGroups = null,
    opponentStrengthGamma = 0,
    candidateStrengthGamma = 0,
    snowballWeight = 0,
    closerWeight = 0,
    consistencyWeight = 0,
    sharedWeaknessWeight = 0,
    typeCoverageContext = null,
  } = params;
  const cache = params.cache ?? createNullBattleCache();
  const threaded = !!executor;
  const startedAt = Date.now();
  let battleCount = 0;
  let cachedCount = 0;
  let errorCount = 0;

  const prepared = teams.map((keys) => {
    const members = keys.map((key) => {
      const b = matrix.builtMons[key];
      return {
        key,
        speciesId: b.speciesId,
        name: memberDisplayName(b),
        pokemon: b.pokemon,
        spec: b.spec,
        // Build-cost inputs, same fields src/teams/index.js passes through:
        // where this mon is today vs the level/form the sim actually plays.
        currentLevel: b.currentLevel ?? null,
        targetLevel: b.pokemon.level,
        shadow: !!b.spec?.shadow,
        purified: !!b.purified,
        lucky: !!b.lucky,
        evolution: b.evolution ?? null,
      };
    });
    const teamASpec = members.map((m) => m.spec);
    const oppPlans = opponents.map((opp, oppIndex) => ({ opp, oppIndex, pairings: pairingsFor(opp) }));
    return { members, teamASpec, oppPlans };
  });

  // ---- (1) plan: TWO cache keys per pairing (forward + reversed seats), in
  // flat battle order -- v13's fitness-symmetry fix (plans/WORKER_NOTES.md
  // Item 2). `planKeys[i]` is `{fwdKey, revKey}`; accumulate (step 3) walks
  // this same array in the same order so the two loops stay in lockstep.
  const planKeys = [];
  const pendingKeys = [];
  const pendingSpecs = [];
  const pendingBattles = []; // serial-mode inputs, parallel to pendingSpecs
  const queued = new Set();
  function enqueue(key, teamASpec, leadA, teamBSpec, leadB, teamAPokemon, teamBPokemon) {
    if (cache.get(key) !== undefined || queued.has(key)) return;
    queued.add(key);
    pendingKeys.push(key);
    pendingSpecs.push({ teamA: teamASpec, teamB: teamBSpec, leadA, leadB, difficulty });
    pendingBattles.push({ teamA: teamAPokemon, teamB: teamBPokemon, leadA, leadB });
  }
  for (const { members, teamASpec, oppPlans } of prepared) {
    const teamA = members.map((m) => m.pokemon);
    for (const { opp, pairings } of oppPlans) {
      const teamBSpec = opp.members.map((m) => m.spec);
      const teamB = opp.members.map((m) => m.pokemon);
      for (const { leadA, leadB } of pairings) {
        const fwdKey = cache.keyFor(teamASpec, leadA, teamBSpec, leadB, difficulty);
        const revKey = cache.keyFor(teamBSpec, leadB, teamASpec, leadA, difficulty);
        planKeys.push({ fwdKey, revKey });
        enqueue(fwdKey, teamASpec, leadA, teamBSpec, leadB, teamA, teamB);
        enqueue(revKey, teamBSpec, leadB, teamASpec, leadA, teamB, teamA);
      }
    }
  }

  // ---- (2) run only the distinct, uncached pairings -----------------------
  /** @type {Map<string, {ok:true, value:object}|{ok:false, message:string}>} */
  const outcomes = new Map();
  if (threaded) {
    let slots = [];
    if (pendingSpecs.length > 0) {
      try {
        slots = await executor.run(pendingSpecs);
      } catch (err) {
        onLog?.(`battle batch error (whole generation's ${pendingSpecs.length} battles skipped): ${err.message}`);
        slots = new Array(pendingSpecs.length).fill({ ok: false, error: { message: err.message } });
      }
    }
    slots.forEach((slot, i) => {
      if (slot.ok) {
        cache.set(pendingKeys[i], slot.value);
        outcomes.set(pendingKeys[i], { ok: true, value: slot.value });
      } else {
        outcomes.set(pendingKeys[i], { ok: false, message: slot.error.message });
      }
    });
  } else {
    pendingBattles.forEach((b, i) => {
      try {
        const value = battleTeams(ctx, { ...b, difficulty });
        cache.set(pendingKeys[i], value);
        outcomes.set(pendingKeys[i], { ok: true, value });
      } catch (err) {
        outcomes.set(pendingKeys[i], { ok: false, message: err.message });
      }
    });
  }

  /** Resolve one planned pairing: this batch's fresh result, or the memo. */
  function outcomeFor(key) {
    const fresh = outcomes.get(key);
    if (fresh) return fresh;
    const hit = cache.get(key);
    return hit === undefined ? { ok: false, message: 'no result produced for this pairing' } : { ok: true, value: hit, cached: true };
  }

  // ---- (3) accumulate --------------------------------------------------
  const opponentTally = opponents.map(() => ({
    winPoints: 0, battles: 0, weightedWinPoints: 0, weightedBattles: 0, exchangeWon: 0, exchangeLost: 0,
  }));
  // Mirror of `perMeta` (candidate side's per-opponent record), one entry per
  // candidate team an opponent actually fought, so consistencyScore is
  // computable symmetrically: "how does this opponent do against its worst
  // CANDIDATE archetype" (`candidateArchetypeGroups`, parallel to `teams`,
  // from src/meta/archetypes.js -- same grouping machinery, run over the
  // candidate population instead of the opponent pool).
  const opponentPerCandidate = opponents.map(() => []);
  let cursor = 0;
  const partials = [];
  for (let idx = 0; idx < prepared.length; idx++) {
    const { members, oppPlans } = prepared[idx];
    const candWeight = candidateWeights ? (candidateWeights[idx] ?? 1) : 1;

    let winPoints = 0;
    let weightedWinPoints = 0;
    let weightedBattles = 0;
    let hpSum = 0;
    let battles = 0;
    let candidateErrors = 0;
    let exchangeWon = 0; // this candidate's lead fainted the opponent's lead first
    let exchangeLost = 0; // ...opponent's lead fainted this candidate's lead first
    let winsGivenExchangeWon = 0; // of the exchangeWon battles, how many did this candidate go on to WIN
    let winsGivenExchangeLost = 0; // ...of the exchangeLost battles, how many did it still win (a comeback)
    const perMeta = [];
    const leadWins = [0, 0, 0];
    const leadBattles = [0, 0, 0];
    const swapHpSum = [0, 0, 0];
    const swapHpCount = [0, 0, 0];

    for (const { opp, oppIndex, pairings } of oppPlans) {
      const oppWeight = opponentWeights ? (opponentWeights[oppIndex] ?? 1) : 1;
      let oppWinPoints = 0;
      let oppHpSum = 0;
      let oppBattles = 0;
      let oppWins = 0;
      let oppLosses = 0;
      let oppTies = 0;
      let oppExchangeWon = 0; // this opponent's lead fainted the candidate's lead first
      let oppExchangeLost = 0; // ...candidate's lead fainted this opponent's lead first

      // Tally ONE battle result that already reads as "candidate is team A" --
      // called once for the forward result and once for the MIRRORED reversed
      // result (mirrorBattleResult above), so both directions run through
      // identical bookkeeping (v13 fitness-symmetry fix, plans/WORKER_NOTES.md
      // Item 2). Closes over this opp-loop iteration's oppWeight/oppWinPoints/
      // etc and the team-loop's members/winPoints/etc. Counts battles (no /2):
      // a pairing now contributes 2 to `battles`/`oppBattles`, which is what
      // makes battleCount per generation exactly 2 x population x opponents.
      function tallyBattle(r, leadA, leadB) {
        battles += 1;
        weightedBattles += oppWeight;
        oppBattles += 1;
        const margin = r.survivorsHp.a - r.survivorsHp.b;
        hpSum += margin;
        oppHpSum += margin;
        if (r.winner === 'a') {
          winPoints += 1;
          weightedWinPoints += oppWeight;
          oppWinPoints += 1;
          oppWins += 1;
        } else if (r.winner === 'tie') {
          winPoints += 0.5;
          weightedWinPoints += oppWeight * 0.5;
          oppWinPoints += 0.5;
          oppTies += 1;
        } else {
          oppLosses += 1;
        }

        // Unconditional (cheap -- reads r.summary, no new
        // battles), regardless of trackLeads -- the per-generation fitness
        // loop needs this and never sets trackLeads.
        const exchange = leadExchangeLoser(r.summary);
        if (exchange === 'a') {
          exchangeLost += 1;
          if (r.winner === 'a') winsGivenExchangeLost += 1; // comeback -- lost the exchange, won the game
        } else if (exchange === 'b') {
          exchangeWon += 1;
          if (r.winner === 'a') winsGivenExchangeWon += 1; // converted the exchange into the win
        }
        if (exchange === 'a') oppExchangeWon += 1;
        else if (exchange === 'b') oppExchangeLost += 1;
        // 'simultaneous'/'none' -- excluded, not a decided exchange (see computeSnowballScore).

        if (trackLeads) {
          if (r.winner === 'a') leadWins[leadA] += 1;
          else if (r.winner === 'tie') leadWins[leadA] += 0.5;
          leadBattles[leadA] += 1;

          const orderedIndices = [leadA, ...LEADS.filter((i) => i !== leadA)];
          r.survivorsHp.aPerMon.forEach((hp, k) => {
            const memberIdx = orderedIndices[k];
            if (memberIdx === leadA) return;
            const maxHp = members[memberIdx].pokemon.stats.hp;
            swapHpSum[memberIdx] += maxHp > 0 ? hp / maxHp : 0;
            swapHpCount[memberIdx] += 1;
          });
        }
      }

      for (const { leadA, leadB } of pairings) {
        const { fwdKey, revKey } = planKeys[cursor++];
        const fwdOutcome = outcomeFor(fwdKey);
        const revOutcome = outcomeFor(revKey);
        if (!fwdOutcome.ok && !revOutcome.ok) {
          errorCount += 1;
          candidateErrors += 1;
          onLog?.(
            `battle error (skipped, both directions failed): team=[${members.map((m) => m.name).join('/')}] ` +
              `opponent="${opp.name}" leadA=${leadA} leadB=${leadB}: ${fwdOutcome.message}`
          );
          continue;
        }
        if (!fwdOutcome.ok || !revOutcome.ok) {
          // Exactly one direction errored: drop the whole pairing (a
          // half-counted pairing would reintroduce the side bias this fix
          // removes) and log once.
          errorCount += 1;
          candidateErrors += 1;
          const failed = fwdOutcome.ok ? 'reversed' : 'forward';
          const message = fwdOutcome.ok ? revOutcome.message : fwdOutcome.message;
          onLog?.(
            `battle error (${failed} direction failed, pairing dropped): team=[${members.map((m) => m.name).join('/')}] ` +
              `opponent="${opp.name}" leadA=${leadA} leadB=${leadB}: ${message}`
          );
          continue;
        }

        if (fwdOutcome.cached) cachedCount += 1;
        else battleCount += 1;
        if (revOutcome.cached) cachedCount += 1;
        else battleCount += 1;

        tallyBattle(fwdOutcome.value, leadA, leadB);
        tallyBattle(mirrorBattleResult(revOutcome.value), leadA, leadB);
      }

      if (oppBattles > 0) {
        opponentTally[oppIndex].winPoints += oppWinPoints;
        opponentTally[oppIndex].battles += oppBattles;
        opponentTally[oppIndex].weightedWinPoints += oppWinPoints * candWeight;
        opponentTally[oppIndex].weightedBattles += oppBattles * candWeight;
        opponentTally[oppIndex].exchangeWon += oppExchangeWon;
        opponentTally[oppIndex].exchangeLost += oppExchangeLost;
        opponentPerCandidate[oppIndex].push({
          archetypeGroup: candidateArchetypeGroups ? candidateArchetypeGroups[idx] ?? null : null,
          winRate: 1 - oppWinPoints / oppBattles, // this opponent's OWN win rate against this candidate
          strength: 1,
          // For the candidateStrengthGamma second pass below: this candidate's
          // index (to look up its own raw win rate once every opponent it
          // fought is known), its frequency weight, and this pair's raw tally.
          idx,
          candWeight,
          oppWinPoints,
          oppBattles,
        });
        perMeta.push({
          metaTeamId: opp.id,
          name: opp.name,
          label: opp.label ?? null,
          species: teamBaseSpecies(opp),
          wins: oppWins,
          losses: oppLosses,
          ties: oppTies,
          winRate: oppWinPoints / oppBattles,
          avgHpMargin: oppHpSum / oppBattles,
          archetypeGroup: opponentArchetypeGroups ? opponentArchetypeGroups[oppIndex] ?? null : null,
          oppIndex,
          oppWeight,
          strength: 1,
        });
      }
    }

    partials.push({
      members, perMeta, winPoints, weightedWinPoints, weightedBattles, hpSum, battles, candidateErrors,
      exchangeWon, exchangeLost, winsGivenExchangeWon, winsGivenExchangeLost,
      leadWins, leadBattles, swapHpSum, swapHpCount,
    });
  }

  // ---- (4) score: second pass, once every opponent's own win rate is known --
  // Opponent j's strength = its raw win rate against every team battled here
  // (the candidate side of the ledger inverted; same battles, no new ones).
  const opponentStrength = opponentTally.map((t) =>
    opponentStrengthGamma > 0 && t.battles > 0 ? Math.pow(Math.max(0, 1 - t.winPoints / t.battles), opponentStrengthGamma) : 1
  );
  // Symmetric candidate j's strength = its own raw win rate across every
  // opponent it fought here (the OTHER side of the same ledger opponentStrength
  // reads, unweighted, no new battles). Feeds the opponentTally reweight just
  // below, mirroring how opponentStrength feeds the candidate reweight further
  // down -- without it, only candidate fitness was discounted for cheap wins
  // over weak opposition; opponent fitness had no equivalent discount.
  const candidateStrength = partials.map((p) =>
    candidateStrengthGamma > 0 && p.battles > 0 ? Math.pow(Math.max(0, p.winPoints / p.battles), candidateStrengthGamma) : 1
  );
  if (candidateStrengthGamma > 0) {
    opponentTally.forEach((t, j) => {
      let sp = 0;
      let sb = 0;
      for (const p of opponentPerCandidate[j]) {
        const w = p.candWeight * candidateStrength[p.idx];
        sp += w * p.oppWinPoints;
        sb += w * p.oppBattles;
      }
      // Every candidate this opponent fought scored strength 0 (impossible
      // today -- strength 0 needs battles > 0 and a 0 win rate, which is a
      // valid state): fall back to the frequency-only weighting already
      // accumulated above rather than a 0/0 fitness.
      if (sb > 0) {
        t.weightedWinPoints = sp;
        t.weightedBattles = sb;
      }
    });
  }
  // Opponent-side battle-reality terms, symmetric with the candidate ones
  // above -- same helper functions, same OwnLeadPairing convention
  // (`opp.members[0]` is the opponent's own designated lead), just fed this
  // opponent's own ledger instead of a candidate's. Cheap: no extra battles,
  // closerScore/sharedWeaknessScore are pure roster lookups and
  // snowballScore/consistencyScore only re-read tallies this same pass
  // already accumulated.
  opponentTally.forEach((t, j) => {
    const oppWinRate = t.battles > 0 ? 1 - t.winPoints / t.battles : 0.5;
    t.winRate = oppWinRate;
    t.snowballScore = computeSnowballScore(t.exchangeWon, t.exchangeLost, oppWinRate);
    t.closerScore = computeCloserScore(opponents[j].members, roleScores);
    const sharedWeakness = typeCoverageContext
      ? computeSharedWeaknessScore(opponents[j].members, typeCoverageContext)
      : { score: null };
    t.sharedWeaknessScore = sharedWeakness.score;
    t.consistencyScore = computeConsistencyScore(opponentPerCandidate[j], oppWinRate).consistencyScore;
  });
  const results = [];
  for (const partial of partials) {
    const { members, perMeta, hpSum, battles, winPoints, candidateErrors, exchangeWon, exchangeLost,
      winsGivenExchangeWon, winsGivenExchangeLost, leadWins, leadBattles, swapHpSum, swapHpCount } = partial;
    let { weightedWinPoints, weightedBattles } = partial;
    if (opponentStrengthGamma > 0) {
      let sp = 0;
      let sb = 0;
      for (const p of perMeta) {
        p.strength = opponentStrength[p.oppIndex];
        const w = p.oppWeight * p.strength;
        const oppBattles = p.wins + p.losses + p.ties;
        sp += w * (p.wins + 0.5 * p.ties);
        sb += w * oppBattles;
      }
      // Every opponent lost everything (strength 0 across the board): fall
      // back to the archetype-weighted mean rather than 0/0.
      if (sb > 0) {
        weightedWinPoints = sp;
        weightedBattles = sb;
      }
    }
    for (const p of perMeta) {
      p.oppIndex = undefined;
      p.oppWeight = undefined;
    }

    // With no opponentWeights every oppWeight is 1 and this IS winPoints/battles.
    const winRate = weightedBattles > 0 ? weightedWinPoints / weightedBattles : 0;
    // Unweighted candidate win rate (plans/WORKER_NOTES.md Item 1): the same
    // ledger's `winPoints`/`battles` before any archetype/strength weighting,
    // parallel to `opponentTally[j].winRate` (also raw) below. Feeds
    // `candidateRawWinRateMean` so the two sides' raw means can be compared
    // like-for-like instead of one raw, one weighted.
    const rawWinRate = battles > 0 ? winPoints / battles : 0;
    const avgHpMargin = battles > 0 ? hpSum / battles : 0;
    const snowballScore = computeSnowballScore(exchangeWon, exchangeLost, winRate);
    const closerScore = computeCloserScore(members, roleScores);
    const sharedWeakness = typeCoverageContext
      ? computeSharedWeaknessScore(members, typeCoverageContext)
      : { score: null, sharedTypes: [] };
    const { consistencyScore, archetypeWinRates } = computeConsistencyScore(perMeta, winRate);
    const entry = {
      members: members.map((m) => ({ key: m.key, speciesId: m.speciesId, name: m.name, ...reportMemberDetail(m) })),
      buildCost: teamBuildCost(members),
      winRate,
      rawWinRate,
      avgHpMargin,
      battles,
      errors: candidateErrors,
      consistencyScore,
      archetypeCount: archetypeWinRates.length,
      // Battle-reality fitness components,
      // always computed (cheap) regardless of --fitness so the report can
      // surface them even in classic mode.
      exchangeWon,
      exchangeLost,
      snowballScore,
      closerScore,
      sharedWeaknessScore: sharedWeakness.score,
      sharedWeaknessTypes: sharedWeakness.sharedTypes,
      blendFitness: computeBlendFitness(
        { winRate, snowballScore, closerScore, consistencyScore, sharedWeaknessScore: sharedWeakness.score },
        {
          ...DEFAULT_FITNESS_WEIGHTS,
          snowball: snowballWeight,
          closer: closerWeight,
          consistency: consistencyWeight,
          sharedWeakness: sharedWeaknessWeight,
        }
      ),
      // Report-facing metrics -- see the
      // comment above computeSnowballIndex for how these differ from
      // snowballScore/closerScore above. Always computed too (cheap).
      snowballIndex: computeSnowballIndex(winsGivenExchangeWon, exchangeWon),
      comebackIndex: computeComebackIndex(winsGivenExchangeLost, exchangeLost),
      designatedCloser: pickDesignatedCloser(members, roleScores),
    };

    if (trackLeads) {
      const leadStats = members.map((m, i) => ({
        index: i,
        key: m.key,
        speciesId: m.speciesId,
        name: m.name,
        winRate: leadBattles[i] > 0 ? leadWins[i] / leadBattles[i] : 0,
      }));
      entry.bestLead = leadStats.reduce((best, l) => (!best || l.winRate > best.winRate ? l : best), null);
      const swapStats = members
        .map((m, i) => ({
          index: i,
          key: m.key,
          speciesId: m.speciesId,
          name: m.name,
          avgHpPct: swapHpCount[i] > 0 ? swapHpSum[i] / swapHpCount[i] : 0,
        }))
        .filter((s) => s.index !== entry.bestLead.index);
      entry.safeSwap = swapStats.length
        ? swapStats.reduce((best, s) => (!best || s.avgHpPct > best.avgHpPct ? s : best), null)
        : null;
      entry.perMeta = perMeta;
      entry.hardestOpponents = [...perMeta]
        .sort((a, b) => a.winRate - b.winRate || a.avgHpMargin - b.avgHpMargin)
        .slice(0, 5);
      entry.coreBreakExposure = computeCoreBreakExposure(perMeta);
    }

    results.push(entry); // positional -- NOT sorted
  }

  return {
    results,
    opponentTally,
    opponentStrength,
    battleCount,
    cachedCount,
    errorCount,
    elapsedMs: Date.now() - startedAt,
    startedAt,
    finishedAt: Date.now(),
  };
}
