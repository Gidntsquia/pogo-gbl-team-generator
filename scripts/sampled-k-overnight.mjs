#!/usr/bin/env node
// Unattended driver for the fixed-K sampled-combats A/B (plans/PLAN.md round 2).
//   node scripts/sampled-k-overnight.mjs [--dir out/sampled-k-ab]     # rerun the same command to resume
// One seed at a time, all six arms. After every seed from MIN_SEEDS on, the fixed stop rule in
// sampled-k-stats.mjs is applied. Stops when everything is decided, at the seed cap, or when the
// 10 h budget (sum of new cells' wall time) cannot fit another seed. Finished cells are reused.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { STOP_RULE, MIN_SEEDS, CAP_SEEDS, BUDGET_SECONDS, CONTROL, IDEA_ARMS, SWEEPS, finishedSeeds, decisionsAt, allDecided, verdictAt, pairedRows } from './sampled-k-stats.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const i = process.argv.indexOf('--dir');
const DIR = path.resolve(ROOT, i >= 0 ? process.argv[i + 1] : 'out/sampled-k-ab');
mkdirSync(DIR, { recursive: true });
const RESULTS = path.join(DIR, 'results.json');
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); appendFileSync(path.join(DIR, 'overnight.log'), l + '\n'); };
const load = () => existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : { cells: [] };
const spent = () => load().cells.reduce((s, c) => s + (c.wallSeconds ?? 0), 0);
const seeds = Array.from({ length: CAP_SEEDS }, (_, k) => `s${k + 1}`);
const done = () => finishedSeeds(load().cells, seeds);
function runSeed(seed) {
  const r = spawnSync('node', ['scripts/compare-search.mjs', 'run', '--dir', path.relative(ROOT, DIR), '--arms', [CONTROL, ...IDEA_ARMS].join(','), '--seeds', seed, '--top', '5', '--heldout', '60'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Error(`run failed for ${seed}`);
}

log(STOP_RULE);
log(`start; budget ${BUDGET_SECONDS}s, spent so far ${spent().toFixed(0)}s`);
for (let n = 1; n <= CAP_SEEDS; n++) {
  if (done() < n) {
    const est = done() ? spent() / done() : 0;
    if (est && spent() + est > BUDGET_SECONDS) { log(`budget reached at ${done()} seeds (spent ${spent().toFixed(0)}s, next seed ~${est.toFixed(0)}s)`); break; }
    runSeed(`s${n}`);
    log(`s${n} done; spent ${spent().toFixed(0)}s`);
  }
  const len = done();
  if (len >= MIN_SEEDS) {
    const cells = load().cells, d = decisionsAt(cells, seeds, len);
    for (const a of IDEA_ARMS) { const v = verdictAt(pairedRows(cells, seeds, CONTROL, a), len); log(`check n=${len} ${a}: ${d.arms[a] ?? 'undecided'} mean ${(v.mean * 100).toFixed(2)} range ${(v.lower * 100).toFixed(2)}..${(v.upper * 100).toFixed(2)} battleRatio ${v.battleRatio.toFixed(2)}`); }
    for (const s of SWEEPS) { const v = verdictAt(pairedRows(cells, seeds, s.small, s.large), len); log(`check n=${len} sweep ${s.key}: ${d.sweeps[s.key] ?? 'undecided'} mean ${(v.mean * 100).toFixed(2)} range ${(v.lower * 100).toFixed(2)}..${(v.upper * 100).toFixed(2)}`); }
    if (allDecided(cells, seeds)) { log(`stop at n=${len}: every arm and sweep decided`); break; }
  }
}
log('finished');
