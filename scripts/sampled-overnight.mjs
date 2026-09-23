#!/usr/bin/env node
// Unattended driver for the sampled-combats A/B (plans/PLAN.md, 2026-09-23).
//   node scripts/sampled-overnight.mjs [--dir out/sampled-ab]     # rerun the same command to resume
// One seed at a time, all five arms (control + four idea arms); after every batch of 10 seeds the
// fixed stop rule in sampled-stats.mjs is applied. Stops when every arm has a verdict, at the seed
// cap, or when the 4 h budget (sum of new cells' wall time) cannot fit another seed. Finished cells
// are reused, so a rerun resumes.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pairedRows, armStatus, allDecided, BUDGET_SECONDS, CAP_SEEDS, CONTROL, IDEA_ARMS } from './sampled-stats.mjs';
import { STOP_RULE } from './compare-sampled-report.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const i = process.argv.indexOf('--dir');
const DIR = path.resolve(ROOT, i >= 0 ? process.argv[i + 1] : 'out/sampled-ab');
mkdirSync(DIR, { recursive: true });
const RESULTS = path.join(DIR, 'results.json');
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); appendFileSync(path.join(DIR, 'overnight.log'), l + '\n'); };
const load = () => existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : { cells: [] };
const spent = () => load().cells.reduce((s, c) => s + (c.wallSeconds ?? 0), 0);
const seeds = (n) => Array.from({ length: n }, (_, k) => `s${k + 1}`);
const done = () => Math.min(...IDEA_ARMS.map((a) => pairedRows(load().cells, seeds(CAP_SEEDS), CONTROL, a).length));
function runSeed(seed) {
  const r = spawnSync('node', ['scripts/compare-search.mjs', 'run', '--dir', path.relative(ROOT, DIR), '--arms', [CONTROL, ...IDEA_ARMS].join(','), '--seeds', seed, '--top', '5', '--heldout', '60'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Error(`run failed for ${seed}`);
}

log(STOP_RULE);
log(`start; budget ${BUDGET_SECONDS}s, spent so far ${spent().toFixed(0)}s`);
for (let n = 1; n <= CAP_SEEDS; n++) {
  const s = `s${n}`;
  if (done() < n) {
    const est = done() ? spent() / done() : 1500;
    if (spent() + est > BUDGET_SECONDS) { log(`budget reached at ${done()} seeds (spent ${spent().toFixed(0)}s, next seed ~${est.toFixed(0)}s)`); break; }
    runSeed(s);
    log(`${s} done; spent ${spent().toFixed(0)}s`);
  }
  const len = done();
  if (len >= 10 && len % 10 === 0) {
    for (const a of IDEA_ARMS) {
      const st = armStatus(pairedRows(load().cells, seeds(CAP_SEEDS), CONTROL, a));
      const v = st.result;
      log(`check at n=${len} ${a}: ${st.stop ? v.verdict : 'unclear'} mean ${(v.mean * 100).toFixed(2)} range ${(v.lower * 100).toFixed(2)}..${(v.upper * 100).toFixed(2)} battleRatio ${v.battleRatio.toFixed(2)}`);
    }
    if (allDecided(load().cells, seeds(CAP_SEEDS))) { log(`stop at n=${len}: every arm decided`); break; }
  }
}
log('finished');
