#!/usr/bin/env node
// Round-8 driver (plans/PLAN.md): more seeds for the arms whose knee calls straddle the threshold (candidate population and K).
//   node scripts/sizing-sweep-r8.mjs [--dir out/sizing-cells-r8]
// New cells go in their own dir, next to round 7's out/sizing-cells (untouched). Each arm starts at the first seed round 7
// did not finish for it (FIRST_SEED), so no arm+seed repeats a post-fix cell. Seeds run in rounds (cheap arms first) so arms
// stay balanced. The 18 h budget is summed wallSeconds of cells in this dir only; a cell starts only if spent + that arm's
// slowest finished cell (or a guess) still fits. Rerun the same command to resume; it runs nothing once the budget is spent.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const ARMS = ['k10', 'p50', 'k25', 'p100', 'p400'];
export const FIRST_SEED = { k10: 7, p50: 6, k25: 6, p100: 6, p400: 6 }; // round 7 finished k10 s1-s6, the rest s1-s5
export const BUDGET_SECONDS = 18 * 3600;
export const MAX_SEED = 21;
const GUESS = { k10: 700, p50: 500, k25: 1200, p100: 1000, p400: 4800 }; // until an arm has a cell here (above round-7 means)

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const i = process.argv.indexOf('--dir');
const DIR = path.resolve(ROOT, i >= 0 ? process.argv[i + 1] : 'out/sizing-cells-r8');
const RESULTS = path.join(DIR, 'results.json');
const load = () => (existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')).cells : []);
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); appendFileSync(path.join(DIR, 'sweep.log'), l + '\n'); };
const spent = () => load().reduce((t, c) => t + (c.wallSeconds ?? 0), 0);
const finished = (arm, seed) => load().some((c) => c.arm === arm && c.seed === seed && c.heldoutMeanTop != null);
const estimate = (arm) => { const w = load().filter((c) => c.arm === arm).map((c) => c.wallSeconds); return w.length ? Math.max(...w) : GUESS[arm]; };

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(DIR, { recursive: true });
  log(`round-8 sweep: arms ${ARMS.join(',')}, budget ${BUDGET_SECONDS}s summed wall time, spent so far ${spent().toFixed(0)}s`);
  let ran = 0;
  for (let n = 6; n <= MAX_SEED; n++) {
    for (const arm of ARMS) {
      const seed = `s${n}`;
      if (n < FIRST_SEED[arm] || finished(arm, seed)) continue;
      if (spent() + estimate(arm) > BUDGET_SECONDS) { log(`skip ${arm} ${seed}: ${spent().toFixed(0)}s spent + estimate ${estimate(arm).toFixed(0)}s would pass ${BUDGET_SECONDS}s`); continue; }
      const r = spawnSync('node', ['scripts/compare-search.mjs', 'run', '--dir', path.relative(ROOT, DIR), '--arms', arm, '--seeds', seed, '--top', '5', '--heldout', '60'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
      if (r.status !== 0) throw new Error(`run failed for ${arm} ${seed}`);
      ran++;
      log(`${arm} ${seed} done; spent ${spent().toFixed(0)}s`);
    }
  }
  log(`finished: ${ran} new cell(s) this invocation; ${spent().toFixed(0)}s summed wall time in total`);
}
