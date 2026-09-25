#!/usr/bin/env node
// Unattended driver for the round-3 opponent sweep (plans/PLAN.md round 3): o50 and o500 only, seeds s1..,
// stop rule in sampled-k-r3-stats.mjs. Rerun the same command to resume (finished cells are reused).
//   node scripts/sampled-k-r3-sweep.mjs [--dir out/sampled-k-ab-r3]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { STOP_RULE, MIN_SEEDS, SWEEP_BAND, CAP_SEEDS, BUDGET_SECONDS, SMALL, LARGE, R3_DIR, R2_DIR, finishedSeeds, decisionAt, newSpent, R3_SEEDS, verdictAt, pairedRows } from './sampled-k-r3-stats.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const i = process.argv.indexOf('--dir');
const DIR = path.resolve(ROOT, i >= 0 ? process.argv[i + 1] : R3_DIR);
mkdirSync(DIR, { recursive: true });
const CSV = path.join(DIR, 'meta-collection-1500.csv');
// Same collection file as round 2 so the two rounds fight identical inputs.
if (!existsSync(CSV) && existsSync(path.join(ROOT, R2_DIR, 'meta-collection-1500.csv'))) copyFileSync(path.join(ROOT, R2_DIR, 'meta-collection-1500.csv'), CSV);
const RESULTS = path.join(DIR, 'results.json');
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); appendFileSync(path.join(DIR, 'sweep.log'), l + '\n'); };
const load = () => existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : { cells: [] };
const spent = () => newSpent(load().cells);
const seeds = Array.from({ length: CAP_SEEDS }, (_, k) => `s${k + 1}`);
const done = () => finishedSeeds(load().cells, seeds);
function runSeed(seed) {
  const r = spawnSync('node', ['scripts/compare-search.mjs', 'run', '--dir', path.relative(ROOT, DIR), '--arms', `${SMALL},${LARGE}`, '--seeds', seed, '--top', '5', '--heldout', '60'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Error(`run failed for ${seed}`);
}

log(STOP_RULE);
log(`caps: ${CAP_SEEDS} seeds total or ${BUDGET_SECONDS / 3600} h summed wall time for new cells (s${R3_SEEDS + 1}+); band +-${SWEEP_BAND * 100} pts; threads 8; round-4 spent so far ${spent().toFixed(0)}s, ${done()} seed(s) finished`);
let why = `seed cap (${CAP_SEEDS}) reached`;
for (let n = R3_SEEDS; n <= CAP_SEEDS; n++) { // s1..s8 are round 3's finished cells; checks start there
  if (done() < n) {
    if (spent() >= BUDGET_SECONDS) { why = `time budget: ${spent().toFixed(0)}s spent (limit ${BUDGET_SECONDS}s)`; log(`budget reached at ${done()} seeds`); break; }
    runSeed(`s${n}`);
    log(`s${n} done; spent ${spent().toFixed(0)}s`);
  }
  const len = done();
  if (len >= MIN_SEEDS) {
    const cells = load().cells, d = decisionAt(cells, seeds, len), v = verdictAt(pairedRows(cells, seeds, SMALL, LARGE), len);
    log(`check n=${len}: ${d} mean ${(v.mean * 100).toFixed(2)} range ${(v.lower * 100).toFixed(2)}..${(v.upper * 100).toFixed(2)}`);
    if (d !== 'undecided') { why = `rule fired (${d.toUpperCase()}) at ${len} seeds`; break; }
  }
}
log(`finished: ${why}`);
