// Round-10 sizing batch (plans/PLAN.md round 10, requirement 7): one unattended, resumable command that
// runs new full-cost evolve cells at settings sizing-lib-r10.mjs's chooseNext() picks, re-scores every
// cell (old and new) on the round's larger held-out set, refits the one model, and re-runs the knee tests
// -- stopping itself when a recipe is found (all three sizes pass) or when the fit shows it cannot be
// found within the sizes evolve accepts (chooseNext returns null: every knee test already passes, or no
// candidate in BOUNDS would move an undecided test). A user stop (--stop) or crash loses at most the cell
// in progress; state lives in out/sizing-cells-r10/state.json plus cells.json, so a rerun after a stop
// finds every cell already recorded and runs 0 new cells.
//
//   node scripts/sizing-sweep-r10.mjs run [--n 300] [--max-hours 72]     the batch (foreground; wrap in
//                                                                        caffeinate/nohup to run unattended)
//   node scripts/sizing-sweep-r10.mjs --stop                            request a stop before the next cell
//
// Launch (per requirement 7 -- full speed, 8 threads, Mac kept awake, no interim reports):
//   caffeinate -i nohup node scripts/sizing-sweep-r10.mjs run > out/sizing-cells-r10/sweep.log 2>&1 &
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  ROOT, R10_REL, R10_CELLS, TOP, FULL_GENERATIONS, armName, features, ols, kneeTests, kneeEstimate,
  fitCost, chooseNext, BOUNDS, loadAllCells, tQuantile,
} from './sizing-lib-r10.mjs';
import { ensureScores, qualityAt, loadStore } from './heldout-store-r10.mjs';

const R10_DIR = path.join(ROOT, R10_REL);
const STATE = path.join(R10_DIR, 'state.json');
const CSV = path.join(R10_DIR, 'meta-collection-1500.csv');
const SOURCE_CSV = path.join(ROOT, 'out', 'sizing-cells-r9', 'meta-collection-1500.csv');
const CONFIRM_SEEDS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
const MAX_HOURS_DEFAULT = 72;

function loadState() {
  if (!existsSync(STATE)) return { status: 'running', startedAt: new Date().toISOString(), newCellSeconds: 0, confirm: null };
  return JSON.parse(readFileSync(STATE, 'utf8'));
}
function saveState(s) { mkdirSync(R10_DIR, { recursive: true }); const tmp = STATE + '.tmp'; writeFileSync(tmp, JSON.stringify(s, null, 2)); renameSync(tmp, STATE); }

function loadR10Cells() {
  if (!existsSync(R10_CELLS)) return [];
  return JSON.parse(readFileSync(R10_CELLS, 'utf8')).cells;
}
function saveR10Cells(cells) { mkdirSync(R10_DIR, { recursive: true }); const tmp = R10_CELLS + '.tmp'; writeFileSync(tmp, JSON.stringify({ cells }, null, 2)); renameSync(tmp, R10_CELLS); }

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

/** Run one new full-cost cell at `sizes` with a fresh seed; returns the cell record (no held-out score yet). */
function runNewCell(sizes, seed, generations = FULL_GENERATIONS) {
  if (!existsSync(CSV)) { mkdirSync(R10_DIR, { recursive: true }); copyFileSync(SOURCE_CSV, CSV); }
  const arm = armName(sizes, generations);
  const dir = path.join(R10_DIR, `${arm}-${seed}`);
  const flags = [
    '--meta-mode', '--no-evolutions', '--curated-ratio', '0', '--pool', '100', '--opponent-meta-pool', '100',
    '--generations', String(generations), '--population', String(sizes.pop), '--opponents-per-gen', String(sizes.pool),
    '--sampled-opponents', String(sizes.k), '--population-final-ratio', '1', '--elites', '8',
    '--final-archive', '10', '--final-fresh', '10', '--threads', '8',
  ];
  if (!existsSync(path.join(dir, 'evolve-result.json'))) {
    const argv = ['scripts/evolve.mjs', CSV, '--seed', seed, ...flags, '--out-dir', dir, '--force-fresh'];
    log(`running cell ${arm}/${seed}: ${argv.join(' ')}`);
    const t0 = Date.now();
    const r = spawnSync('nice', ['-n', '10', 'node', ...argv], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) throw new Error(`evolve failed for ${arm} ${seed}`);
    var wallSeconds = (Date.now() - t0) / 1000;
  }
  const result = JSON.parse(readFileSync(path.join(dir, 'evolve-result.json'), 'utf8'));
  const gens = result.generationRecords;
  const genBattles = gens.reduce((s, g) => s + g.timing.battleCount, 0);
  return {
    arm, seed, sizes, generations,
    genBattles, totalBattles: genBattles + (result.eliteTiming?.battleCount ?? 0),
    totalSeconds: result.totalElapsedMs / 1000,
    wallSeconds: wallSeconds ?? null,
    finalists: result.elites.map((e) => e.signature),
  };
}

function fitAll(cells, n) {
  const full = cells.filter((c) => !c.cheap && c.quality != null);
  const X = full.map((c) => features(c.sizes));
  const y = full.map((c) => c.quality);
  return { fit: ols(X, y), full, n };
}

function nextSeedFor(cells, arm) {
  let i = 1;
  const used = new Set(cells.filter((c) => c.arm === arm).map((c) => c.seed));
  while (used.has(`r${i}`)) i++;
  return `r${i}`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--stop')) {
    const s = loadState();
    s.status = 'stop-requested';
    saveState(s);
    console.log('stop requested; the batch will exit after its current cell (or immediately if idle)');
    return;
  }
  if (argv[0] !== 'run') { console.error('usage: sizing-sweep-r10.mjs run [--n 300] [--max-hours 72] | --stop'); process.exit(2); }
  const nI = argv.indexOf('--n');
  const N = Number(nI >= 0 ? argv[nI + 1] : 300);
  const mhI = argv.indexOf('--max-hours');
  const maxHours = Number(mhI >= 0 ? argv[mhI + 1] : MAX_HOURS_DEFAULT);

  let state = loadState();
  if (state.status === 'stopped-by-user' || state.status === 'found' || state.status === 'not-found') {
    log(`already ${state.status}; rerun does nothing (delete out/sizing-cells-r10/state.json to force a fresh batch)`);
    return;
  }
  state.status = 'running';
  saveState(state);
  const t0 = Date.now();

  for (;;) {
    // Check for a stop request at the top of every iteration.
    state = loadState();
    if (state.status === 'stop-requested') { state.status = 'stopped-by-user'; saveState(state); log('stopped by user request'); return; }
    if ((Date.now() - t0) / 3600000 > maxHours) { state.status = 'not-found'; state.reason = `exceeded --max-hours ${maxHours}`; saveState(state); log(state.reason); return; }

    const { cellFlags } = await import('./compare-search.mjs');
    const priorCells = loadAllCells(cellFlags).filter((c) => c.source !== 'round 10');
    const r10 = loadR10Cells();

    // Ensure every cell (prior + this round's) has a held-out quality at N.
    const allCells = [...priorCells, ...r10.map((c) => ({ ...c, sizes: c.sizes }))];
    const sigsNeeded = allCells.flatMap((c) => c.finalists.slice(0, TOP));
    log(`ensuring held-out scores at n=${N} for ${new Set(sigsNeeded).size} distinct finalists`);
    const store = await ensureScores(sigsNeeded, N, log);

    function withQuality(c) {
      const q = qualityAt(store, c.finalists.slice(0, TOP), N);
      return { ...c, quality: q ? q.meanTop : null, cheap: c.generations !== FULL_GENERATIONS };
    }
    const scoredPrior = priorCells.map(withQuality);
    const scoredR10 = r10.map(withQuality);
    const full = [...scoredPrior, ...scoredR10].filter((c) => !c.cheap && c.quality != null && !c.inflated);

    const { fit } = fitAll(full, N);
    const recipe = kneeEstimate(fit, BOUNDS).sizes;
    const tests = kneeTests(fit, recipe);
    const passAll = Object.values(tests).every((t) => t.pass);
    log(`fit n=${full.length} full-cost cells; residual sd=${fit.residSd.toFixed(4)}; recipe estimate=${JSON.stringify(recipe)}; passAll=${passAll}`);

    if (passAll && !state.confirm) {
      // Run confirmation seeds at the recipe.
      log(`recipe candidate found: running ${CONFIRM_SEEDS.length} confirmation seeds at ${JSON.stringify(recipe)}`);
      const confirmCells = [];
      for (const seed of CONFIRM_SEEDS) {
        const arm = armName(recipe);
        if (r10.some((c) => c.arm === arm && c.seed === seed)) continue;
        const cell = runNewCell(recipe, seed);
        r10.push(cell);
        saveR10Cells(r10);
        confirmCells.push(cell);
      }
      const sigs2 = confirmCells.flatMap((c) => c.finalists.slice(0, TOP));
      const store2 = await ensureScores(sigs2, N, log);
      const confirmQ = confirmCells.map((c) => qualityAt(store2, c.finalists.slice(0, TOP), N).meanTop);
      const confirmMean = confirmQ.reduce((a, b) => a + b, 0) / confirmQ.length;
      const xr = features(recipe);
      const est = xr.reduce((s, x, i) => s + x * fit.beta[i], 0);
      const se = Math.sqrt(xr.reduce((s, x, i) => s + x * fit.cov[i].reduce((s2, v, j) => s2 + v * xr[j], 0), 0));
      const t = tQuantile(0.95, fit.df);
      const lo = est - t * se, hi = est + t * se;
      const inside = confirmMean >= lo && confirmMean <= hi;
      state.confirm = { recipe, confirmMean, predLo: lo, predHi: hi, inside, n: N };
      saveState(state);
      if (inside) { state.status = 'found'; saveState(state); log(`FOUND: recipe ${JSON.stringify(recipe)} confirmed (mean ${confirmMean.toFixed(4)} in [${lo.toFixed(4)}, ${hi.toFixed(4)}])`); return; }
      log(`confirmation missed the predicted range (mean ${confirmMean.toFixed(4)} vs [${lo.toFixed(4)}, ${hi.toFixed(4)}]); continuing the search`);
      state.confirm = null;
      saveState(state);
      continue;
    }

    const cost = fitCost(full);
    const next = chooseNext(fit, tests, recipe, cost);
    if (!next) { state.status = 'not-found'; state.reason = 'no candidate setting within evolve-accepted bounds would move any still-undecided knee test'; saveState(state); log(state.reason); return; }
    const arm = armName(next.sizes);
    const seed = nextSeedFor(r10, arm);
    log(`placing next cell at ${JSON.stringify(next.sizes)} (arm ${arm}, seed ${seed}), expected ${next.seconds.toFixed(0)} s`);
    const cell = runNewCell(next.sizes, seed);
    r10.push(cell);
    saveR10Cells(r10);
    state.newCellSeconds = (state.newCellSeconds ?? 0) + (cell.wallSeconds ?? cell.totalSeconds ?? 0);
    saveState(state);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
