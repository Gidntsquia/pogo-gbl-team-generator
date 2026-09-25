#!/usr/bin/env node
// Unattended, resumable driver for the sizing round (plans/PLAN.md round 7). Rerun the same command to resume.
//   node scripts/sizing-sweep.mjs [--dir out/sizing-cells]
// One knob at a time moves off the o50 baseline (200 candidates, 50-opponent pool, K=50), whose 21 post-fix seeds
// already sit in out/sampled-k-ab-r3/. New arms run on seeds s1, s2, ... in rounds (every arm gets seed n before any
// gets n+1, cheap arms first), so the arms stay balanced. A cell starts only if summed wall time so far plus that arm's
// cost estimate (its slowest finished cell, or a guess) still fits the budget; so the 12 h cap is never exceeded.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const ARMS = ['k10', 'p50', 'k25', 'p100', 'o100', 'o200', 'p400'];
export const BUDGET_SECONDS = 12 * 3600;
export const MAX_SEEDS = 21;
// First-cell guesses (seconds), used only until an arm has a finished cell. Deliberately high.
const GUESS = { k10: 700, p50: 700, k25: 1200, p100: 1200, o100: 2400, o200: 3000, p400: 5000 };

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const i = process.argv.indexOf('--dir');
const DIR = path.resolve(ROOT, i >= 0 ? process.argv[i + 1] : 'out/sizing-cells');
const RESULTS = path.join(DIR, 'results.json');
const load = () => existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : { cells: [] };
const mine = (cells) => cells.filter((c) => ARMS.includes(c.arm));
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); appendFileSync(path.join(DIR, 'sweep.log'), l + '\n'); };
const spent = () => mine(load().cells).reduce((t, c) => t + (c.wallSeconds ?? 0), 0);
const finished = (arm, seed) => load().cells.some((c) => c.arm === arm && c.seed === seed && c.heldoutMeanTop != null);
function estimate(arm) {
  const w = mine(load().cells).filter((c) => c.arm === arm).map((c) => c.wallSeconds);
  return w.length ? Math.max(...w) : GUESS[arm];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(DIR, { recursive: true });
  log(`sizing sweep: arms ${ARMS.join(',')}, seeds s1-s${MAX_SEEDS}, budget ${BUDGET_SECONDS}s summed wall time, spent so far ${spent().toFixed(0)}s`);
  let ran = 0;
  outer: for (let n = 1; n <= MAX_SEEDS; n++) {
    let ranThisRound = false;
    for (const arm of ARMS) {
      const seed = `s${n}`;
      if (finished(arm, seed)) continue;
      if (spent() + estimate(arm) > BUDGET_SECONDS) { log(`skip ${arm} ${seed}: ${spent().toFixed(0)}s spent + estimate ${estimate(arm).toFixed(0)}s would pass ${BUDGET_SECONDS}s`); continue; }
      const r = spawnSync('node', ['scripts/compare-search.mjs', 'run', '--dir', path.relative(ROOT, DIR), '--arms', arm, '--seeds', seed, '--top', '5', '--heldout', '60'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
      if (r.status !== 0) throw new Error(`run failed for ${arm} ${seed}`);
      ran++; ranThisRound = true;
      log(`${arm} ${seed} done; spent ${spent().toFixed(0)}s`);
    }
    if (!ranThisRound && ARMS.every((a) => spent() + estimate(a) > BUDGET_SECONDS)) break outer;
  }
  log(`finished: ${ran} new cell(s) this invocation; ${spent().toFixed(0)}s summed wall time in total`);
}
