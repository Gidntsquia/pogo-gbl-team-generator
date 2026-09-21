#!/usr/bin/env node
// Control-vs-idea comparison for search experiments (see plans/WORKER_NOTES.md).
//
//   node scripts/compare-search.mjs run    [--arms control,h3,h4] [--seeds s1,s2,s3] [--top 5] [--heldout 60]
//   node scripts/compare-search.mjs report               (writes out/research-integration.{md,html} from results)
//
// `run`: for every arm x seed, launches the real `scripts/evolve.mjs` (same flags, same seed,
// only the arm's switches differ) into out/research/<arm>-<seed>/, then scores each run's
// top finalists against ONE fixed held-out opponent set neither search ever fought (composed
// from seed "heldout", both directions, unweighted). Results land in out/research/results.json;
// finished cells are reused, so an interrupted run resumes by rerunning the same command.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseEvolveArgs } from '../src/evolve/cli.js';
import { buildEvolveSetup } from '../src/evolve/setup.js';
import { evaluateTeamsInOrder } from '../src/evolve/evaluate.js';
import { composeFreshOpponents } from '../src/evolve/finalPass.js';
import { ownLeadPairing } from '../src/evolve/fitness.js';
import { createExecutor } from '../src/engine/parallel.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// --dir DIR (default out/research) keeps a reproduction run apart from the original cells.
const dirArg = process.argv.indexOf('--dir');
const OUT = path.resolve(ROOT, dirArg >= 0 ? process.argv[dirArg + 1] : path.join('out', 'research'));
const CSV = path.join(OUT, 'meta-collection-1500.csv');
const RESULTS = path.join(OUT, 'results.json');

/** Arms: the control is the untouched search (no switches). */
export const ARMS = {
  control: ['--halving-rounds', '0'],
  h2: ['--halving-rounds', '2'],
  h3: ['--halving-rounds', '3'],
  h4: ['--halving-rounds', '4'],
};

/** Same for every arm. Short-run scale: minutes per run on 8 threads. */
export const BASE_FLAGS = [
  '--meta-mode', '--no-evolutions', '--curated-ratio', '0', '--pool', '100', '--opponent-meta-pool', '100',
  '--generations', '8', '--population', '40', '--opponents-per-gen', '30', '--elites', '8',
  '--final-archive', '10', '--final-fresh', '10', '--threads', '8',
];

function flagValue(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

function ensureCollection() {
  if (existsSync(CSV)) return;
  mkdirSync(OUT, { recursive: true });
  const r = spawnSync('node', ['scripts/build-meta-collection.mjs', '--cp', '1500', '--out', CSV], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('could not build the meta collection');
}

function runCell(arm, seed) {
  const dir = path.join(OUT, `${arm}-${seed}`);
  if (!existsSync(path.join(dir, 'evolve-result.json'))) {
    const argv = ['scripts/evolve.mjs', CSV, '--seed', seed, ...BASE_FLAGS, ...ARMS[arm], '--out-dir', dir, '--force-fresh'];
    console.log(`[${arm} ${seed}] ${argv.join(' ')}`);
    const r = spawnSync('nice', ['-n', '10', 'node', ...argv], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) throw new Error(`evolve failed for ${arm} ${seed}`);
  }
  const result = JSON.parse(readFileSync(path.join(dir, 'evolve-result.json'), 'utf8'));
  const gens = result.generationRecords;
  const genBattles = gens.reduce((s, g) => s + g.timing.battleCount, 0);
  const genMs = gens.reduce((s, g) => s + g.timing.elapsedMs, 0);
  return {
    arm, seed, dir,
    generations: gens.length,
    genBattles,
    genSeconds: genMs / 1000,
    totalBattles: genBattles + (result.eliteTiming?.battleCount ?? 0),
    totalSeconds: result.totalElapsedMs / 1000,
    finalists: result.elites.map((e) => e.signature),
  };
}

function teamFromSignature(sig) {
  const [lead, rest] = sig.split('||');
  return [lead, ...rest.split('|')];
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === 'report') {
    const data = JSON.parse(readFileSync(RESULTS, 'utf8'));
    const { renderReport } = await import('./compare-search-report.mjs');
    renderReport(data, path.join(ROOT, 'out'));
    return;
  }
  if (cmd !== 'run') {
    console.error('usage: compare-search.mjs run|report');
    process.exit(2);
  }
  const arms = flagValue(argv, '--arms', 'control,h3,h4').split(',');
  const seeds = flagValue(argv, '--seeds', 's1,s2,s3').split(',');
  const top = Number(flagValue(argv, '--top', '5'));
  const heldoutCount = Number(flagValue(argv, '--heldout', '60'));
  ensureCollection();

  const cells = [];
  for (const seed of seeds) for (const arm of arms) cells.push(runCell(arm, seed));

  // Held-out scoring: same collection build, same opponents for every cell.
  const { csvPath, opts } = parseEvolveArgs([CSV, ...BASE_FLAGS, '--out-dir', path.join(OUT, '_heldout')]);
  const setup = await buildEvolveSetup(csvPath, { ...opts, onLog: () => {} });
  const heldout = composeFreshOpponents(setup.ctx, {
    count: heldoutCount, seed: 'heldout', movesetPool: setup.movesetPool, weights: setup.weights,
    roleScores: setup.opponentLeadRoleScores, usedIds: [],
  });
  const executor = createExecutor({ threads: 8, vendorRoot: setup.ctx.vendorRoot, continueOnError: true, cp: setup.ctx.cp, cup: setup.ctx.cup });
  try {
    for (const cell of cells) {
      const teams = cell.finalists.slice(0, top).map(teamFromSignature);
      const run = await evaluateTeamsInOrder(setup.ctx, {
        teams, matrix: setup.deduped, opponents: heldout, pairingsFor: ownLeadPairing,
        difficulty: setup.difficulty, executor, roleScores: setup.roleScores, cache: setup.battleCache,
      });
      cell.heldout = run.results.map((r) => r.rawWinRate); // unweighted, both directions
      cell.heldoutTop1 = cell.heldout[0];
      cell.heldoutMeanTop = cell.heldout.reduce((s, x) => s + x, 0) / cell.heldout.length;
      console.log(`[${cell.arm} ${cell.seed}] held-out top1 ${(cell.heldoutTop1 * 100).toFixed(1)}%  top${top} mean ${(cell.heldoutMeanTop * 100).toFixed(1)}%  ${cell.genBattles} battles ${cell.genSeconds.toFixed(0)}s`);
    }
  } finally {
    await executor.close();
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(RESULTS, JSON.stringify({ arms, seeds, top, heldoutCount, baseFlags: BASE_FLAGS, armFlags: ARMS, cells }, null, 2));
  console.log(`wrote ${RESULTS}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
