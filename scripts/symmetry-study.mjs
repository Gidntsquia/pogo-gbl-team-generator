#!/usr/bin/env node
/**
 * Gen-0 symmetry study (plans/WORKER_NOTES.md Item 3): isolates WHY a
 * meta-vs-meta evolve run's candidate and opponent sides start apart at
 * generation 0, before any selection runs. Reuses evolve.mjs's own setup
 * (`buildEvolveSetup`), population/pool initializers (`initPopulation`,
 * `initOpponentPool`) and the real both-directions battle path
 * (`evaluateTeamsInOrder`, `ownLeadPairing`) -- no battle math or sampling is
 * reimplemented here.
 *
 * Usage:
 *   node scripts/symmetry-study.mjs <collection.csv> <...evolve.mjs flags> \
 *     --teams 60 --seeds 5 --threads 8
 *
 * For each of `--seeds` seed pairs (default 5), prints:
 *   opp-vs-opp    -- two independently-seeded opponent pools battled against
 *                    each other (converted to the candidate-team shape so
 *                    the same battle path runs); expected ~0, its spread is
 *                    the harness's own noise floor.
 *   cand-vs-cand  -- two independently-seeded candidate populations battled
 *                    against each other (converted to the opponent-entry
 *                    shape); same purpose.
 *   G0 cand-vs-opp -- the real gen-0 gap: one seed's candidate population
 *                    against that SAME seed's opponent pool.
 *   G1 cand-species/opp-build vs opp -- the same candidate teams (species +
 *                    locked lead), each member REBUILT with the opponent
 *                    side's builder (buildMetaMon against the opponent meta
 *                    pool's own moveset), battled against the same opponent
 *                    pool. Teams with a member the opponent builder can't
 *                    build (species not in --opponent-meta-pool) are excluded
 *                    from G0 and G1 alike for that seed, and the exclusion
 *                    count is printed.
 *   build term = G0 - G1 (covered teams only); sampling term = G1.
 * Gap is always "mean raw win rate of side X - side Y", battled from both
 * seats via evaluateTeamsInOrder (mirrorBattleResult), never re-derived as
 * 1 - the other side's mean.
 */
import { createExecutor } from '../src/engine/parallel.js';
import { initPopulation } from '../src/teams/evolve.js';
import { initOpponentPool } from '../src/meta/opponentPool.js';
import { buildMetaMon } from '../src/scoring/index.js';
import { buildEvolveSetup, parseEvolveArgs, evaluateTeamsInOrder, ownLeadPairing } from './evolve.mjs';

function extractOwnFlag(argv, name, def) {
  const flag = `--${name}`;
  const idx = argv.indexOf(flag);
  if (idx === -1) return { value: def, rest: argv };
  const value = argv[idx + 1];
  const rest = [...argv.slice(0, idx), ...argv.slice(idx + 2)];
  return { value, rest };
}

function mean(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}
function sd(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

/** Raw (unweighted) win rate for side A over `run` -- mean of `results[i].rawWinRate`. */
function candRawMean(run) {
  return mean(run.results.map((r) => r.rawWinRate));
}
/** Raw (unweighted) win rate for the "opponents" side of `run` -- mean of `opponentTally[j].winRate`, its OWN per-entry tally, never `1 - candRawMean`. */
function oppRawMean(run) {
  return mean(run.opponentTally.map((t) => t.winRate));
}

/** Wrap a candidate population (array of matrix key-arrays) as OpponentEntry-shaped battle targets, using the SAME matrix's builtMons for members. */
function candidatePopulationAsOpponents(population, matrix) {
  return population.map((team, i) => ({
    id: `cand-as-opp-${i}`,
    name: `cand-as-opp-${i}`,
    leadIndex: 0,
    members: team.map((key) => {
      const b = matrix.builtMons[key];
      return { speciesId: b.speciesId, spec: b.spec };
    }),
  }));
}

/** Wrap an opponent pool (array of OpponentEntry) as candidate teams + a synthetic matrix keyed by "entryId::slot", built from each member's own spec/pokemon (already opponent-built). */
function opponentPoolAsCandidateTeams(entries) {
  const builtMons = {};
  const teams = entries.map((entry, i) => {
    return entry.members.map((m, slot) => {
      const key = `opp-as-cand-${i}::${slot}`;
      builtMons[key] = { speciesId: m.speciesId, pokemon: m.pokemon, spec: m.spec };
      return key;
    });
  });
  return { teams, matrix: { builtMons } };
}

/** Look up a candidate team member's species in the opponent meta pool by (baseSpeciesId, shadow) and rebuild it with buildMetaMon -- the opponent side's own builder. Returns null if the species isn't in the pool (opponent builder "can't build" it). */
function rebuildWithOpponentBuilder(ctx, matrix, key, movesetPool) {
  const b = matrix.builtMons[key];
  const lookupId = b.spec.shadow ? `${b.speciesId}_shadow` : b.speciesId;
  const entry = movesetPool.find((e) => e.speciesId === lookupId);
  if (!entry) return null;
  try {
    const built = buildMetaMon(ctx, entry);
    return { speciesId: built.speciesId, pokemon: built.pokemon, spec: built.spec };
  } catch {
    return null;
  }
}

async function main(argv) {
  let rest = argv;
  let teamsStr, seedsStr;
  ({ value: teamsStr, rest } = extractOwnFlag(rest, 'teams', '60'));
  ({ value: seedsStr, rest } = extractOwnFlag(rest, 'seeds', '5'));

  const parsed = parseEvolveArgs(rest);
  if (!parsed) {
    process.exit(process.exitCode ?? 1);
  }
  const { csvPath, opts } = parsed;
  const teamsCount = Number.parseInt(teamsStr, 10);
  const seedsCount = Number.parseInt(seedsStr, 10);
  if (!Number.isInteger(teamsCount) || teamsCount <= 0) throw new Error(`--teams must be a positive integer, got "${teamsStr}"`);
  if (!Number.isInteger(seedsCount) || seedsCount <= 0) throw new Error(`--seeds must be a positive integer, got "${seedsStr}"`);

  const setup = await buildEvolveSetup(csvPath, { ...opts, onLog: (msg) => process.stderr.write(`${msg}\n`) });
  const {
    config, ctx, deduped, weights, pool, candidateExcludeSpecies,
    curatedPool, movesetPool, opponentLeadRoleScores,
  } = setup;

  const threads = opts.threads;
  const threaded = typeof threads === 'number' && threads > 0;
  const executor = threaded
    ? createExecutor({ threads, vendorRoot: ctx.vendorRoot, continueOnError: true, cp: ctx.cp, cup: ctx.cup })
    : null;

  const rows = [];
  try {
    for (let i = 0; i < seedsCount; i++) {
      const seedTag = `${config.seed}-symstudy-${i}`;

      const candA = initPopulation({ matrix: deduped, pool, weights, count: teamsCount, seed: `${seedTag}-cand-a`, excludeSpecies: candidateExcludeSpecies });
      const candB = initPopulation({ matrix: deduped, pool, weights, count: teamsCount, seed: `${seedTag}-cand-b`, excludeSpecies: candidateExcludeSpecies });
      const oppA = initOpponentPool(ctx, { size: teamsCount, weights, curated: curatedPool, curatedRatio: config.curatedRatio, roleScores: opponentLeadRoleScores, movesetPool, seed: `${seedTag}-opp-a` });
      const oppB = initOpponentPool(ctx, { size: teamsCount, weights, curated: curatedPool, curatedRatio: config.curatedRatio, roleScores: opponentLeadRoleScores, movesetPool, seed: `${seedTag}-opp-b` });

      // opp-vs-opp control: oppA (as candidate teams) vs oppB (as opponents).
      const oppVsOppSrc = opponentPoolAsCandidateTeams(oppA);
      const oppVsOpp = await evaluateTeamsInOrder(ctx, {
        teams: oppVsOppSrc.teams, matrix: oppVsOppSrc.matrix, opponents: oppB, pairingsFor: ownLeadPairing, executor,
      });
      const oppVsOppGap = candRawMean(oppVsOpp) - oppRawMean(oppVsOpp);

      // cand-vs-cand control: candA vs candB (as opponents).
      const candVsCand = await evaluateTeamsInOrder(ctx, {
        teams: candA, matrix: deduped, opponents: candidatePopulationAsOpponents(candB, deduped), pairingsFor: ownLeadPairing, executor,
      });
      const candVsCandGap = candRawMean(candVsCand) - oppRawMean(candVsCand);

      // G0: the real gen-0 gap -- candA vs oppA.
      const g0Run = await evaluateTeamsInOrder(ctx, {
        teams: candA, matrix: deduped, opponents: oppA, pairingsFor: ownLeadPairing, executor,
      });
      const g0Gap = candRawMean(g0Run) - oppRawMean(g0Run);

      // G1: same candA species+lead, each member rebuilt with the opponent
      // builder, vs the same oppA. Teams with an unbuildable member are
      // dropped from BOTH g0Covered and g1 for a fair like-for-like compare.
      const diffs = [];
      let uncovered = 0;
      const g1Matrix = { builtMons: {} };
      const g1Teams = [];
      const coveredIdx = [];
      candA.forEach((team, ti) => {
        const rebuilt = team.map((key) => rebuildWithOpponentBuilder(ctx, deduped, key, movesetPool));
        if (rebuilt.some((m) => m === null)) {
          uncovered += 1;
          return;
        }
        const teamKeys = team.map((key, slot) => {
          const gKey = `g1-${ti}::${slot}`;
          g1Matrix.builtMons[gKey] = rebuilt[slot];
          const original = deduped.builtMons[key];
          if (JSON.stringify(original.spec) !== JSON.stringify(rebuilt[slot].spec)) {
            diffs.push({
              species: original.speciesId,
              candidateSpec: original.spec,
              opponentSpec: rebuilt[slot].spec,
            });
          }
          return gKey;
        });
        g1Teams.push(teamKeys);
        coveredIdx.push(ti);
      });
      const oppACovered = oppA; // opponent pool unaffected by candidate coverage
      const g1Run = g1Teams.length
        ? await evaluateTeamsInOrder(ctx, { teams: g1Teams, matrix: g1Matrix, opponents: oppACovered, pairingsFor: ownLeadPairing, executor })
        : null;
      const g1Gap = g1Run ? candRawMean(g1Run) - oppRawMean(g1Run) : null;

      // G0 over the SAME covered subset, for a fair build-term subtraction.
      const g0CoveredTeams = coveredIdx.map((ti) => candA[ti]);
      const g0Covered = g0CoveredTeams.length
        ? await evaluateTeamsInOrder(ctx, { teams: g0CoveredTeams, matrix: deduped, opponents: oppA, pairingsFor: ownLeadPairing, executor })
        : null;
      const g0CoveredGap = g0Covered ? candRawMean(g0Covered) - oppRawMean(g0Covered) : null;

      const buildTerm = g1Gap !== null ? g0CoveredGap - g1Gap : null;
      const samplingTerm = g1Gap;

      rows.push({
        seedTag, oppVsOppGap, candVsCandGap, g0Gap, g0CoveredGap, g1Gap, buildTerm, samplingTerm,
        uncovered, totalTeams: teamsCount, diffs,
      });
    }
  } finally {
    if (executor) await executor.close();
  }

  const oppVsOppVals = rows.map((r) => r.oppVsOppGap);
  const candVsCandVals = rows.map((r) => r.candVsCandGap);
  const T = 2 * Math.max(sd(oppVsOppVals), sd(candVsCandVals));

  console.log(`symmetry-study: ${seedsCount} seed(s), ${teamsCount} teams/side, collection=${csvPath}`);
  console.log('seed\topp-vs-opp\tcand-vs-cand\tG0\tG0(covered)\tG1\tbuildTerm\tsamplingTerm\tuncovered/total');
  for (const r of rows) {
    console.log(
      `${r.seedTag}\t${r.oppVsOppGap.toFixed(4)}\t${r.candVsCandGap.toFixed(4)}\t${r.g0Gap.toFixed(4)}\t` +
        `${r.g0CoveredGap === null ? 'n/a' : r.g0CoveredGap.toFixed(4)}\t${r.g1Gap === null ? 'n/a' : r.g1Gap.toFixed(4)}\t` +
        `${r.buildTerm === null ? 'n/a' : r.buildTerm.toFixed(4)}\t${r.samplingTerm === null ? 'n/a' : r.samplingTerm.toFixed(4)}\t` +
        `${r.uncovered}/${r.totalTeams}`
    );
  }
  console.log(
    `mean\t${mean(oppVsOppVals).toFixed(4)}\t${mean(candVsCandVals).toFixed(4)}\t${mean(rows.map((r) => r.g0Gap)).toFixed(4)}\t` +
      `${mean(rows.filter((r) => r.g0CoveredGap !== null).map((r) => r.g0CoveredGap)).toFixed(4)}\t` +
      `${mean(rows.filter((r) => r.g1Gap !== null).map((r) => r.g1Gap)).toFixed(4)}\t` +
      `${mean(rows.filter((r) => r.buildTerm !== null).map((r) => r.buildTerm)).toFixed(4)}\t` +
      `${mean(rows.filter((r) => r.samplingTerm !== null).map((r) => r.samplingTerm)).toFixed(4)}\t-`
  );
  console.log(`T = 2 * max(SD(opp-vs-opp), SD(cand-vs-cand)) = ${T.toFixed(4)}`);
  console.log(`SD(opp-vs-opp) = ${sd(oppVsOppVals).toFixed(4)}, SD(cand-vs-cand) = ${sd(candVsCandVals).toFixed(4)}`);

  console.log('\nPer-member build diffs (candidate build vs opponent-builder rebuild, same species):');
  for (const r of rows) {
    for (const d of r.diffs) {
      console.log(
        `  seed=${r.seedTag} species=${d.species} candidate=${JSON.stringify(d.candidateSpec)} ` +
          `opponent=${JSON.stringify(d.opponentSpec)}`
      );
    }
    if (r.diffs.length === 0) console.log(`  seed=${r.seedTag}: no spec differences among covered members`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`Error: ${err.message}\n${err.stack}\n`);
  process.exitCode = 1;
});
