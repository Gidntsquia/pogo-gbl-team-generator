import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { importCollection } from '../importer/index.js';
import { expandEvolutions } from '../evolution/index.js';
import { filterEligibleMons } from '../util/eligibility.js';
import { initEngine, buildPokemon } from '../engine/harness.js';
import { buildCollection, buildMetaMon, applyGroupMoveset } from '../scoring/index.js';
import { loadUsageWeights } from '../meta/usage.js';
import { loadMovesetPool } from '../meta/sampleTeams.js';
import { createSimilarity } from '../engine/similarity.js';
import { loadMetaTeams } from '../meta/teams.js';
import { dedupeByRank, buildRankedPool } from '../teams/rankedPool.js';
import { usageIdOf } from '../teams/sample.js';
import { resolveFormat } from '../util/leagues.js';
import { loadRoleScores } from '../meta/roles.js';
import { buildTypeCoverageContext } from '../teams/typeCoverage.js';
import { DEFAULTS, FITNESS_MODES, buildRunConfig, hashFile } from './config.js';
import { FITNESS_SEMANTICS, TYPE_COVERAGE_META_SIZE } from './fitness.js';
import { BATTLE_CACHE_MAX_ENTRIES, createBattleCache, createNullBattleCache } from './cache.js';
import { expandBanToCandidateSpeciesIds, filterBannedCuratedTeams, filterBannedMovesetPool } from './bans.js';

/**
 * Run the full evolutionary search and write per-generation checkpoints, the
 * rolling analytics file, the final report, and the DONE marker.
 *
 * @param {string} csvPath
 * @param {{
 *   scoreMeta?:number, pool?:number, seed?:number|string, cp?:number,
 *   curatedRatio?:number, excludeSpecies?:string[], difficulty?:number,
 *   banSpecies?:string[], - format-wide ban ("no Mimikyu, no Cramorant"):
 *     matched by BASE species id (src/meta/sampleTeams.js's baseIdOf), so a
 *     shadow variant is caught too (NOT a distinct battle/regional form --
 *     see the `--ban` helpers' own comment above). Unlike excludeSpecies
 *     (candidates only), this also drops whole curated teams and
 *     moveset-pool entries containing a banned species on the opponent side.
 *     Always in the checkpoint fingerprint.
 *   population?:number, opponentsPerGen?:number, generations?:number,
 *   fixedOpponents?:boolean,
 *   eliteCount?:number, - last-generation teams sent to the final pass (by
 *     trailing-mean fitness); written into the config but ignored by
 *     configsMatch, so it may change on a re-render.
 *   selectionTrailing?:number, - generations each team's fitness is averaged
 *     over (recency-weighted, see trailingFitness) before the cull/mutation
 *     ranking and the finalist pick (default DEFAULT_SELECTION_TRAILING; 1 =
 *     rank on the single generation, the pre-2026-09-05 behavior).
 *     Only-when-set fingerprint rule.
 *   finalArchive?:number, finalFresh?:number, - final-pass held-out strata
 *     sizes (see buildOpponentArchive / composeFreshOpponents; finalArchive
 *     defaults from DEFAULTS, finalFresh from finalFreshDefault -- 0 normally,
 *     a small nonzero fallback only at --curated-ratio 0). NOT in the
 *     fingerprint: they change only the final pass.
 *   deathRate?:number, mutationFloor?:number, mutationCeil?:number,
 *   immigrantFraction?:number, - candidate-side GA rate overrides, forwarded
 *     to nextGeneration; in the checkpoint fingerprint ONLY when set.
 *   mutationFloorStart?:number, mutationCeilStart?:number, - hot-start
 *     mutation rates at generation 0, annealed linearly to the standard
 *     floor/ceil by the last allowed generation (see mutationRatesAt); same
 *     only-when-set fingerprint rule.
 *   opponentDeathRate?:number, - opponent-side cull fraction (evolvable
 *     entries only), forwarded to nextOpponentPool; only-when-set fingerprint.
 *   opponentMutationFloor?:number, opponentMutationCeil?:number,
 *   opponentMutationFloorStart?:number, opponentMutationCeilStart?:number,
 *     - opponent-side mutation rates and hot-start anneal, forwarded to
 *     nextOpponentPool (see opponentMutationRatesAt); same only-when-set
 *     fingerprint rule.
 *   opponentImmigrantFraction?:number, - opponent-side fresh-immigrant share
 *     of the evolvable portion, forwarded to nextOpponentPool; same
 *     only-when-set fingerprint rule.
 *   convWindow?:number, convTopN?:number, - convergence window / top-set-size
 *     overrides for hasConverged; same only-when-set fingerprint rule.
 *   populationFinalRatio?:number, - candidate population at the last
 *     generation, as a fraction of `population` (see populationAt).
 *   opponentMetaPool?:number, - top-N species cap on the composed half of the
 *     opponent pool (see src/meta/sampleTeams.js).
 *   battleCache?:boolean, - memoize identical pairings (default true).
 *   profile?:boolean, - capture per-worker CPU profiles into outDir on a
 *     clean exit (default false; no-op without threads). Also gates a live
 *     per-generation poll (see parallel.js's executor.stats()): with
 *     --profile, every generation's log line adds each worker's current+peak
 *     heap, scenario-memo size, and mon-cache size, for mid-run memory/speed
 *     debugging -- off by default so a normal run pays nothing for it.
 *     Process RSS is logged every generation regardless of this flag.
 *     NOT part of the checkpoint fingerprint (pure performance knob).
 *   deadlineMinutes?:number, - simple stop-before-next-generation budget;
 *     NOT part of the checkpoint config fingerprint (see buildRunConfig).
 *   threads?:number, - when set, ONE persistent
 *     src/engine/parallel.js createExecutor() pool is booted for the WHOLE
 *     run and reused across every generation AND the final elites pass.
 *     Omitted/falsy keeps the serial battleTeams loop. NOT part of the
 *     checkpoint fingerprint (pure performance knob).
 *   seedFrom?:string, - path to another run's `evolve-gen<N>.json` checkpoint
 *     to seed generation 0's population and opponent pool from, instead of
 *     initPopulation/initOpponentPool sampling fresh (pre-baked start / a
 *     "resume with different flags" -- point --out-dir at a new directory
 *     and --seed-from at the old run's checkpoint; see seedFromCheckpoint).
 *     Ignored once an in-place config-matching checkpoint resume applies.
 *   forceFresh?:boolean, - allow starting fresh in an --out-dir whose
 *     evolve-gen0.json config doesn't match this run (discarding it),
 *     instead of the default hard error (see the resume-refusal check).
 *   outDir?:string, out?:string, - out = Markdown report path.
 *   html?:string, noHtml?:boolean, - HTML report path (default
 *     <outDir>/my-teams-evolve.html) and an opt-out.
 *   onProgress?:(p:{generation:number, completed:number, total:number, startedAt:number})=>void,
 *   onLog?:(msg:string)=>void,
 * }} [opts]
 * @returns {Promise<object>} the full run result; also written to disk.
 */
/**
 * Everything a meta-vs-meta run needs before its first battle: collection
 * import, evolution expansion, cup eligibility, the collection build, the
 * candidate sampling pool, and the opponent side's curated/moveset pools and
 * (optional) shared-weakness context -- exactly the block `runEvolution` used
 * to inline before its generation loop. Extracted (plans/WORKER_NOTES.md
 * Item 3) so a study script can build the SAME gen-0 population/opponent-pool
 * inputs `runEvolution` would, via `initPopulation`/`initOpponentPool`,
 * without reimplementing any of this setup. `runEvolution` itself now just
 * calls this and destructures.
 *
 * @param {string} csvPath
 * @param {object} [opts] - same shape runEvolution accepts.
 * @returns {Promise<object>} every local this block used to produce, keyed
 *   by name (config, outDir, log, ctx, matrix, deduped, pool, curatedPool,
 *   movesetPool, typeCoverageContext, roleScores, opponentLeadRoleScores,
 *   weights, similarity, league, difficulty, collectionHash, importWarnings,
 *   candidateExcludeSpecies, banBaseIds, battleCache, threads, deadlineMs,
 *   reportPath, writeHtml, htmlPath).
 */
export async function buildEvolveSetup(csvPath, opts = {}) {
  if (opts.fitness !== undefined && !FITNESS_MODES.includes(opts.fitness)) {
    throw new Error(`evolve: opts.fitness must be one of ${FITNESS_MODES.join('|')}, got "${opts.fitness}"`);
  }
  const config = buildRunConfig(csvPath, opts);
  const outDir = opts.outDir ?? DEFAULTS.outDir;
  const reportPath = opts.out ?? path.join(outDir, 'my-teams-evolve.md');
  const writeHtml = opts.noHtml !== true;
  const htmlPath = opts.html ?? path.join(outDir, DEFAULTS.html);
  mkdirSync(outDir, { recursive: true });

  const log = (msg) => opts.onLog?.(msg);
  const difficulty = config.difficulty ?? undefined;
  const threads = opts.threads;
  const deadlineMs = typeof opts.deadlineMinutes === 'number' ? opts.deadlineMinutes * 60000 : null;

  log(`evolve: starting (collection=${config.csvPath}, cp=${config.cp}, cup=${config.cup}, out-dir=${outDir}, report=${reportPath})`);

  const { mons: importedMons, warnings: importWarnings } = importCollection(csvPath, { cp: config.cp });
  // Written into every checkpoint (not the fingerprint) so a resume against a
  // rewritten CSV fails with a real message -- see assertCollectionMatchesCheckpoint.
  const collectionHash = hashFile(csvPath);
  const ctx = await initEngine({ cp: config.cp, cup: config.cup });
  // One pvpoke similarity scorer (memoised per species/moveset pair) shared by both GAs' core rivalry.
  const similarity = createSimilarity();
  const league = resolveFormat({ cp: config.cp, cup: config.cup });
  // Each mon also competes as anything it can
  // evolve into, so the GA can pick a form you don't own yet. Part of the run
  // config below, so flipping it starts a new checkpoint rather than resuming
  // one whose population was bred from a different candidate pool.
  const expanded = config.evolutions
    ? expandEvolutions(ctx, importedMons)
    : { mons: importedMons, warnings: [] };
  // Cup eligibility filter, always after evolution
  // expansion (see src/util/eligibility.js's header for why order matters).
  const eligible = filterEligibleMons(ctx, expanded.mons);
  const mons = eligible.mons;
  // Meta mode: every candidate fields the exact moveset pvpoke's rankings file
  // lists for that build -- the moveset the opponent side composes with --
  // instead of pvpoke's auto-selected one (they differ for a few builds, e.g.
  // morpeko_full_belly's Aura Wheel type). Logged as build parity below.
  if (config.metaMode) {
    const rankedMoves = new Map(loadMovesetPool(ctx, { metaPoolSize: 0 }).map((e) => [e.speciesId, e]));
    for (const mon of mons) {
      const ranked = rankedMoves.get(`${mon.speciesId}${mon.shadow ? '_shadow' : ''}`);
      if (ranked) mon.moves = { fastMove: ranked.fastMove, chargedMoves: ranked.chargedMoves };
    }
  }
  // No 1v1 scoring anywhere in an evolve run: mons are only BUILT here, and
  // both the pool and every sampling weight come from pvpoke's own rank for
  // the build (`weights`). A data/meta-usage.json snapshot is ignored on
  // purpose -- sampling is pure pvpoke rank.
  const { built, warnings: buildWarnings } = buildCollection(ctx, mons, { currentMoves: config.metaMode });
  const allBuilt = {};
  for (const b of built) {
    const { key, ...rest } = b;
    allBuilt[key] = rest;
  }
  const weights = loadUsageWeights(ctx, { ignoreSnapshot: true });
  // keepShadowVariants is implicit: dedupeByRank keys by (species, shadow), so
  // the GA's shadow-flip mutation still has both specimens of a species.
  const deduped = { builtMons: dedupeByRank(allBuilt, weights), warnings: buildWarnings };
  const matrix = { mons: built, warnings: buildWarnings };
  const banBaseIds = new Set(config.banSpecies);
  // --ban is format-wide: on the candidate side it is folded into
  // excludeSpecies (expanded from base ids to every concrete speciesId the
  // collection actually has, so a shadow variant can't sneak through
  // --exclude's exact-match check) BEFORE the sampling pool is built, so a
  // banned species never enters `pool` in the first place.
  const candidateExcludeSpecies = banBaseIds.size
    ? [...new Set([...config.excludeSpecies, ...expandBanToCandidateSpeciesIds(deduped.builtMons, banBaseIds)])]
    : config.excludeSpecies;
  // --meta-mode (meta-vs-meta): the collection IS the ranked field, so the
  // candidate pool is the SAME set as the opponent's (every ranked build, or
  // the top --pool of them). A real-collection run pools the player's mons and
  // ranks each by its own species+shadow build's pvpoke rank (last place when
  // pvpoke does not rank it).
  let pool;
  if (config.metaMode) {
    const rankedEntries = filterBannedMovesetPool(loadMovesetPool(ctx, { metaPoolSize: config.pool ?? 0 }), banBaseIds);
    const rankedIds = new Set(rankedEntries.map((e) => e.speciesId));
    const exclude = new Set(candidateExcludeSpecies);
    pool = Object.keys(deduped.builtMons)
      .filter((key) => {
        const b = deduped.builtMons[key];
        return !exclude.has(b.speciesId) && rankedIds.has(usageIdOf(b));
      })
      .sort();
    log(`evolve: meta mode -- candidate species pool = ${pool.length} of pvpoke's top ${rankedIds.size} ranked builds`);
    // Build parity: a candidate and an opponent of the same ranked build must
    // be the same fighter (IVs, level, CP, moveset). Logged, not assumed.
    const describe = (pk) =>
      `${pk.ivs?.atk}/${pk.ivs?.def}/${pk.ivs?.hp} L${pk.level} cp${pk.cp} ${pk.fastMove?.moveId}+${(pk.chargedMoves ?? []).map((m) => m.moveId).sort().join(',')}`;
    const byRankedId = new Map(pool.map((key) => {
      const b = deduped.builtMons[key];
      return [`${b.speciesId}${b.spec?.shadow ? '_shadow' : ''}`, b];
    }));
    const mismatches = [];
    for (const entry of rankedEntries) {
      const cand = byRankedId.get(entry.speciesId);
      if (!cand) { mismatches.push(`${entry.speciesId}: no candidate build`); continue; }
      // Rebuilt fresh from the spec (what a worker thread battles with): the
      // matrix's own instance has already fought 1v1s, and a form-changer
      // (Morpeko) carries its mid-battle move swap on the object.
      const fresh = buildPokemon(ctx, cand.spec);
      if (cand.spec.fastMove) applyGroupMoveset(fresh, cand.spec);
      const a = describe(fresh);
      const o = describe(buildMetaMon(ctx, entry).pokemon);
      if (a !== o) mismatches.push(`${entry.speciesId}: candidate ${a} vs opponent ${o}`);
    }
    log(`evolve: meta mode -- build parity: ${rankedEntries.length - mismatches.length}/${rankedEntries.length} ranked builds identical on both sides`);
    for (const m of mismatches.slice(0, 20)) log(`evolve: meta mode -- build mismatch: ${m}`);
  } else {
    pool = buildRankedPool(deduped.builtMons, weights, config.pool, candidateExcludeSpecies);
  }
  const roleScores = loadRoleScores(ctx); // lead/closer/switch priors, cheap local-file read
  // Fed to composeSampledOpponent (initOpponentPool/nextOpponentPool/
  // composeFreshOpponents) only -- omitting roleScores there makes
  // pickLeadIndex fall back to a uniform-random lead (src/meta/sampleTeams.js),
  // matching the candidate side's assignLead/buildLeadRotation. `roleScores`
  // itself stays real everywhere else (evaluateTeamsInOrder's closer score is
  // a separate, already-symmetric fitness term).
  const opponentLeadRoleScores = config.randomOpponentLead ? null : roleScores;
  // The opponent side's two fixed inputs, both loaded once for the whole run:
  // every curated team for this CP cap (the pool the opponent GA's protected
  // entries are drawn from, and the opponent set the final elites pass uses in
  // full), and the meta-capped species pool composed teams are built out of.
  // Both are filtered by --ban here, once, so every downstream use (the
  // per-generation opponent pool AND the final elites pass for curatedPool;
  // initOpponentPool/nextOpponentPool and their mutation/immigrant draws for
  // movesetPool) sees an already-clean pool -- see the --ban helpers above.
  const curatedPool = filterBannedCuratedTeams(loadMetaTeams(ctx), banBaseIds);
  // Under a cup (or a heavy --ban) the curated set can filter down to nothing.
  // Treat that exactly like an explicit --curated-ratio 0: every downstream
  // read of config.curatedRatio (initOpponentPool, nextOpponentPool,
  // finalFreshDefault, the final elites pass) sees the forced value, since
  // they all read this same config object.
  if (curatedPool.length === 0 && config.curatedRatio > 0) {
    log(
      `evolve: curated opponent pool is empty after cup/ban filtering -- forcing curated-ratio 0 for this run ` +
        `(was ${config.curatedRatio})`
    );
    config.curatedRatio = 0;
  }
  const movesetPool = filterBannedMovesetPool(
    loadMovesetPool(ctx, { metaPoolSize: config.opponentMetaPool }),
    banBaseIds
  );
  // Shared weakness is opt-in, so its cheap top-200 type/moveset table is
  // built only when it can affect selection. No additional battles run here.
  let typeCoverageContext = null;
  if (config.sharedWeaknessWeight > 0) {
    const coverageEntries = loadMovesetPool(ctx, { metaPoolSize: TYPE_COVERAGE_META_SIZE });
    log(
      `evolve: building shared-weakness context -- ${Object.keys(deduped.builtMons).length} candidate movesets ` +
        `against ${coverageEntries.length} PvPoke-ranked type profiles (no battles)`
    );
    typeCoverageContext = buildTypeCoverageContext(ctx, deduped.builtMons, coverageEntries, weights);
  }
  const battleCache = opts.battleCache === false ? createNullBattleCache() : createBattleCache(BATTLE_CACHE_MAX_ENTRIES);
  log(
    `evolve: shared setup done -- ${matrix.mons.length} mons built (no 1v1 scoring), sampling pool of ${pool.length} species, ` +
      `${curatedPool.length} curated opponent teams, opponent meta pool of ${movesetPool.length} species, league=${league.name}`
  );
  log(`evolve: fitness semantics ${FITNESS_SEMANTICS}, meta mode ${config.metaMode ? 'on' : 'off'}`);

  return {
    config, outDir, reportPath, writeHtml, htmlPath, log, difficulty, threads, deadlineMs,
    importedMons, importWarnings, expanded, eligible, collectionHash, ctx, similarity, league, matrix, deduped, weights,
    banBaseIds, candidateExcludeSpecies, pool, roleScores, opponentLeadRoleScores,
    curatedPool, movesetPool, typeCoverageContext, battleCache,
  };
}
