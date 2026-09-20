import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { initOpponentPool, rehydrateOpponentPool } from '../meta/opponentPool.js';
import { initPopulation } from '../teams/evolve.js';
import { teamSignature } from './analytics.js';

// Bump whenever a checkpoint's on-disk SHAPE changes in a way `config`
// -matching alone can't detect (see the ROBUSTNESS comment above). v2 = the
// locked-lead population representation: `team[0]`
// is a designated lead, not an arbitrary array slot. v3 = the persistent,
// evolving opponent pool: a checkpoint now also carries the serialized
// opponent pool it was measured against and the pool it handed to the next
// generation, plus per-team win rates keyed by team signature (the input to
// the trailing-generations ranking term). A v2 checkpoint has none of that
// and cannot be resumed.
export const CHECKPOINT_FORMAT_VERSION = 3;

/**
 * Pre-baked start / cross-flag "resume": load generation 0's population and
 * opponent pool from ANOTHER run's checkpoint file (`--seed-from`) instead of
 * sampling fresh via initPopulation/initOpponentPool. This is deliberately
 * NOT a config-matching resume -- the whole point is to let a new run start
 * a few generations in with different flags (population size, curated-ratio,
 * mutation rates, even a different-but-similar collection), which the
 * strict `configsMatch` in-place resume (see the main resume scan above)
 * cannot do without silently overwriting the source checkpoints. Point
 * `--out-dir` at a NEW directory and `--seed-from` at the old run's
 * checkpoint you want to branch from (e.g.
 * `out/evolve-old/evolve-gen42.json`); the new run gets its own fresh
 * checkpoint chain from generation 0, seeded with that population.
 *
 * Species keys that no longer resolve against the CURRENT collection
 * (checked the same way `assertCollectionMatchesCheckpoint` does, but as a
 * per-team filter rather than a hard stop -- a "similar" seed collection is
 * expected to differ) are dropped; if the collection hash also differs this
 * is logged, not thrown, since seeding across collections is the point.
 * Short of the target count, `initPopulation` tops up the remainder;
 * long, the fittest are kept (by the checkpoint's own last-measured
 * fitness, oldest members with no fitness score sorted last).
 *
 * @param {object} params
 * @param {string} params.seedPath - path to a `evolve-gen<N>.json` checkpoint
 * @param {object} params.ctx - engine context (for rehydrateOpponentPool)
 * @param {object} params.deduped - this run's scored/deduped matrix
 * @param {string[]} params.pool - this run's candidate sampling pool
 * @param {Map<string,number>} params.weights
 * @param {number} params.populationCount - target gen-0 population size
 * @param {number} params.opponentCount - target gen-0 opponent pool size
 * @param {Array<object>} params.curatedPool
 * @param {string[]} params.candidateExcludeSpecies
 * @param {string} params.seed
 * @param {(msg:string)=>void} params.log
 * @returns {{population: string[][], opponentPool: object[]}}
 */
export function seedFromCheckpoint({
  seedPath,
  ctx,
  deduped,
  pool,
  weights,
  populationCount,
  opponentCount,
  curatedPool,
  candidateExcludeSpecies,
  seed,
  log,
}) {
  if (!existsSync(seedPath)) {
    throw new Error(`evolve: --seed-from ${seedPath} does not exist`);
  }
  const cp = JSON.parse(readFileSync(seedPath, 'utf8'));
  if (cp.formatVersion !== CHECKPOINT_FORMAT_VERSION) {
    throw new Error(
      `evolve: --seed-from ${seedPath} is checkpoint format ${cp.formatVersion ?? '(unversioned)'} but this ` +
        `code expects format ${CHECKPOINT_FORMAT_VERSION}. Re-run the source simulation with current code first.`
    );
  }
  const seedPopulation = cp.nextPopulation ?? [];
  const valid = [];
  let dropped = 0;
  for (const team of seedPopulation) {
    const ok = team.every((key) => {
      const speciesOfKey = key.slice(0, key.lastIndexOf('#'));
      const built = deduped.builtMons[key];
      return built && built.speciesId === speciesOfKey;
    });
    if (ok) valid.push(team);
    else dropped += 1;
  }
  if (dropped > 0) {
    log(`evolve: --seed-from dropped ${dropped}/${seedPopulation.length} seed team(s) whose species no longer resolve in this collection`);
  }
  // `cp.fitness` is index-aligned to `cp.population` (the checkpoint's last-scored
  // generation), not `nextPopulation` -- look each seed team up by signature so
  // elites carried over unchanged land their real fitness; bred offspring with no
  // match (undefined) sort last, per this function's own JSDoc.
  const fitnessBySignature = new Map(
    (cp.population ?? []).map((team, i) => [teamSignature(team), cp.fitness?.[i]])
  );
  const sortedValid = [...valid].sort((a, b) => {
    const fa = fitnessBySignature.get(teamSignature(a));
    const fb = fitnessBySignature.get(teamSignature(b));
    if (fa === undefined && fb === undefined) return 0;
    if (fa === undefined) return 1;
    if (fb === undefined) return -1;
    return fb - fa;
  });
  let population = sortedValid.slice(0, populationCount);
  if (population.length < populationCount) {
    const topUp = initPopulation({
      matrix: deduped,
      pool,
      weights,
      count: populationCount - population.length,
      seed: `${seed}-seed-topup`,
      excludeSpecies: candidateExcludeSpecies,
    });
    population = [...population, ...topUp];
  }

  let opponentPool = cp.nextOpponentPool ? rehydrateOpponentPool(ctx, cp.nextOpponentPool, curatedPool, log) : [];
  if (opponentPool.length > opponentCount) {
    opponentPool = opponentPool.slice(0, opponentCount);
  } else if (opponentPool.length < opponentCount) {
    const fresh = initOpponentPool(ctx, {
      size: opponentCount - opponentPool.length,
      weights,
      curated: [],
      curatedRatio: 0,
      roleScores: undefined,
      movesetPool: undefined,
      seed: `${seed}-seed-opponent-topup`,
    }).filter(Boolean);
    opponentPool = [...opponentPool, ...fresh];
  }

  log(
    `evolve: seeded from ${seedPath} -- population ${population.length} (${valid.length} carried over), ` +
      `opponent pool ${opponentPool.length}`
  );
  return { population, opponentPool };
}

export function checkpointPath(outDir, generation) {
  return path.join(outDir, `evolve-gen${generation}.json`);
}

export function readCheckpoint(outDir, generation) {
  const p = checkpointPath(outDir, generation);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function writeCheckpoint(outDir, generation, data) {
  mkdirSync(outDir, { recursive: true });
  const finalPath = checkpointPath(outDir, generation);
  // Write to a temp file then rename over the final path -- rename is atomic
  // on POSIX, so a SIGTERM (e.g. from earlyoom) landing mid-write can
  // only ever leave a stray .tmp file, never a truncated checkpoint that
  // readCheckpoint's catch-and-return-null would silently treat as absent.
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmpPath, finalPath);
}

export function writeGenerationsAnalytics(outDir, generationRecords) {
  mkdirSync(outDir, { recursive: true });
  const analyticsOnly = generationRecords.map((r) => ({
    generation: r.generation,
    resumed: !!r.resumed,
    battleCount: r.timing.battleCount,
    errorCount: r.timing.errorCount,
    elapsedMs: r.timing.elapsedMs,
    msPerBattle: r.timing.msPerBattle,
    ...r.analytics,
  }));
  writeFileSync(path.join(outDir, 'evolve-generations.json'), JSON.stringify(analyticsOnly, null, 2), 'utf8');
}
