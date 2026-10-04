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
  fitCost, chooseNext, BOUNDS, trustBounds, MAX_CELL_SECONDS, BUDGET_SECONDS, WINDOW_DOUBLINGS, loadAllCells, tQuantile,
  budgetRecipe, RUN_GENERATIONS, runGenerations,
} from './sizing-lib-r10.mjs';
import { ensureScores, qualityAt, loadStore } from './heldout-store-r10.mjs';

const R10_DIR = path.join(ROOT, R10_REL);
const STATE = path.join(R10_DIR, 'state.json');
const CSV = path.join(R10_DIR, 'meta-collection-1500.csv');
const SOURCE_CSV = path.join(ROOT, 'out', 'sizing-cells-r9', 'meta-collection-1500.csv');
// One battle cache shared by every new cell (evolve --battle-cache-file): a battle's result depends only on
// the pairing, so cells reuse each other's battles with identical results. Asked for by the user 2026-09-28.
const BATTLE_CACHE_FILE = path.join(R10_DIR, 'battle-cache.json');
const CONFIRM_SEEDS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
const MAX_HOURS_DEFAULT = 72;

function loadState() {
  if (!existsSync(STATE)) return { status: 'running', startedAt: new Date().toISOString(), newCellSeconds: 0, confirm: null };
  return JSON.parse(readFileSync(STATE, 'utf8'));
}
function saveState(s) { mkdirSync(R10_DIR, { recursive: true }); const tmp = STATE + '.tmp'; writeFileSync(tmp, JSON.stringify(s, null, 2)); renameSync(tmp, STATE); }
/** Save `s`, but keep a stop request that arrived on disk while the (possibly long) work producing `s` ran. */
function saveStateKeepingStop(s) { const onDisk = loadState(); saveState(onDisk.status === 'stop-requested' ? { ...s, status: 'stop-requested' } : s); }

function loadR10Cells() {
  if (!existsSync(R10_CELLS)) return [];
  return JSON.parse(readFileSync(R10_CELLS, 'utf8')).cells;
}
function saveR10Cells(cells) { mkdirSync(R10_DIR, { recursive: true }); const tmp = R10_CELLS + '.tmp'; writeFileSync(tmp, JSON.stringify({ cells }, null, 2)); renameSync(tmp, R10_CELLS); }

// User-requested cells, run in order before the picker: {"cells":[{"pop":216,"pool":100,"k":100}, ...]}.
// Edit the file while the batch runs; it is re-read before every cell.
const QUEUE = path.join(R10_DIR, 'queue.json');
function loadQueue() { return existsSync(QUEUE) ? JSON.parse(readFileSync(QUEUE, 'utf8')).cells ?? [] : []; }
function saveQueue(cells) { const tmp = QUEUE + '.tmp'; writeFileSync(tmp, JSON.stringify({ cells }, null, 2)); renameSync(tmp, QUEUE); }

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
    '--final-archive', '10', '--final-fresh', '10', '--threads', '8', '--battle-cache-file', BATTLE_CACHE_FILE,
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
    sharedCacheBattles: result.battleCacheStats?.diskHits ?? 0,
    sharedCacheGenBattles: result.battleCacheStats?.diskHitsInGenerations ?? 0,
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
      // priorCells already carry costSeconds (from sizing-lib-r10.mjs's makeCell); raw round-10 cells
      // (loadR10Cells reads cells.json directly, bypassing makeCell) only have wallSeconds/totalSeconds --
      // without this, fitCost's cost-per-cell fit silently drops every round-10 cell and never sees the
      // fixed per-process overhead that dominates its cheap corner-of-the-grid cells.
      return {
        ...c, quality: q ? q.meanTop : null, cheap: c.generations !== FULL_GENERATIONS,
        genBattlesStandalone: c.genBattles + (c.sharedCacheGenBattles ?? 0),
        costSeconds: c.costSeconds ?? c.wallSeconds ?? c.totalSeconds ?? null,
        gens: c.gens ?? runGenerations(c),
      };
    }
    const scoredPrior = priorCells.map(withQuality);
    const scoredR10 = r10.map(withQuality);
    const full = [...scoredPrior, ...scoredR10].filter((c) => !c.cheap && c.quality != null && !c.inflated);

    const { fit } = fitAll(full, N);
    const trust = trustBounds(full, BOUNDS);
    // Stopping rule since 2026-09-30 (user): the cheapest good-enough setting whose 30-generation run fits in
    // 8 h (budgetRecipe), confirmed by fresh seeds. The knee tests stay only to steer the picker after a
    // confirmation miss.
    const cost = fitCost(full);
    const pick = budgetRecipe(fit, trust, cost);
    const recipe = pick ? pick.sizes : kneeEstimate(fit, trust).sizes;
    const tests = kneeTests(fit, recipe);
    const passAll = !!pick;
    log(`fit n=${full.length} full-cost cells; residual sd=${fit.residSd.toFixed(4)}; trust upper bounds pop ${trust.pop[1]} pool ${trust.pool[1]} K ${trust.k[1]}; recipe estimate=${JSON.stringify(recipe)}${pick ? ` (predicted ${(pick.predicted * 100).toFixed(2)}, best in budget ${JSON.stringify(pick.best)} ${(pick.bestPredicted * 100).toFixed(2)}, ${RUN_GENERATIONS}-gen run ${(pick.runSeconds / 3600).toFixed(2)} h)` : ' (nothing fits the run budget)'}; passAll=${passAll}`);

    // Cells the user asked for run first, ahead of confirmation and the picker. An entry leaves the queue
    // only after its cell is recorded, so a stop or crash mid-cell re-runs it.
    const queue = loadQueue();
    if (queue.length) {
      const sizes = queue[0];
      const arm = armName(sizes);
      const seed = nextSeedFor(r10, arm);
      log(`placing queued cell at ${JSON.stringify(sizes)} (arm ${arm}, seed ${seed}; ${queue.length - 1} more queued)`);
      const cell = runNewCell(sizes, seed);
      r10.push(cell);
      saveR10Cells(r10);
      saveQueue(loadQueue().slice(1));
      state.newCellSeconds = (state.newCellSeconds ?? 0) + (cell.wallSeconds ?? cell.totalSeconds ?? 0);
      saveStateKeepingStop(state);
      continue;
    }

    // A recipe that missed confirmation is re-checked only once the fit has new cells; otherwise the same
    // fit picks the same recipe and the check repeats forever (2026-10-01: ~240k NaN misses in 3 h).
    const recipeArm = armName(recipe);
    const lastMiss = (state.confirmMisses ?? []).filter((m) => m.arm === recipeArm).at(-1);
    if (passAll && !state.confirm && !(lastMiss && lastMiss.fitN >= full.length)) {
      // Run confirmation seeds at the recipe; seeds already run (a re-check, or a stop mid-confirmation)
      // are reused rather than re-run.
      log(`recipe candidate found: confirming at ${JSON.stringify(recipe)} with ${CONFIRM_SEEDS.length} seeds`);
      const confirmCells = [];
      for (const seed of CONFIRM_SEEDS) {
        const existing = r10.find((c) => c.arm === recipeArm && c.seed === seed);
        if (existing) { confirmCells.push(existing); continue; }
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
      saveStateKeepingStop(state);
      if (inside) { state.status = 'found'; saveState(state); log(`FOUND: recipe ${JSON.stringify(recipe)} confirmed (mean ${confirmMean.toFixed(4)} in [${lo.toFixed(4)}, ${hi.toFixed(4)}])`); return; }
      log(`confirmation missed the predicted range (mean ${confirmMean.toFixed(4)} vs [${lo.toFixed(4)}, ${hi.toFixed(4)}]); continuing the search`);
      state.confirmMisses = [...(state.confirmMisses ?? []), { arm: recipeArm, recipe, confirmMean, predLo: lo, predHi: hi, fitN: full.length, at: new Date().toISOString() }];
      state.confirm = null;
      saveStateKeepingStop(state);
      continue;
    }

    const maxSeconds = MAX_CELL_SECONDS;
    // Near the recipe first; if nothing there fits the time cap, anywhere in the trusted bounds.
    const next = chooseNext(fit, tests, recipe, cost, { bounds: trust, maxSeconds, windowDoublings: WINDOW_DOUBLINGS })
      ?? chooseNext(fit, tests, recipe, cost, { bounds: trust, maxSeconds });
    if (!next) { state.status = 'not-found'; state.reason = 'no candidate setting within the trusted bounds and cell-cost cap would move any still-undecided knee test'; saveState(state); log(state.reason); return; }
    const arm = armName(next.sizes);
    const seed = nextSeedFor(r10, arm);
    log(`placing next cell at ${JSON.stringify(next.sizes)} (arm ${arm}, seed ${seed}), expected ${next.seconds.toFixed(0)} s, information ${next.gain.toFixed(3)}, information per ${BUDGET_SECONDS / 3600} h ${next.score.toFixed(3)}`);
    const cell = runNewCell(next.sizes, seed);
    r10.push(cell);
    saveR10Cells(r10);
    state.newCellSeconds = (state.newCellSeconds ?? 0) + (cell.wallSeconds ?? cell.totalSeconds ?? 0);
    // A --stop written while the cell above was running must not be clobbered by this save re-writing the
    // stale in-memory 'running' status over it.
    saveStateKeepingStop(state);
  }
}

// Exit explicitly: the held-out scorer's worker threads keep the event loop alive after main() returns, so
// without this a stopped/finished batch logs its exit but the process lingers (observed 2026-09-28).
if (import.meta.url === `file://${process.argv[1]}`) main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
