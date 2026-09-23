#!/usr/bin/env node
// Unattended driver for the Hoeffding Races A/B (plans/PLAN.md, 2026-09-22).
//   node scripts/hoeffding-overnight.mjs [--dir out/hoeffding-ab]     # rerun the same command to resume
// Short seeds only: s1, s2, ... one pair (control + idea) at a time; after every batch of 10 the
// fixed stop rule in hoeffding-stats.mjs is applied. Stops at a decisive verdict, the 100-seed cap,
// or when the 8h budget (sum of new cells' wall time) cannot fit another pair.
// Each pair is `compare-search.mjs run` for that seed, so finished cells are always reused.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { pairedRows, stopStatus, BUDGET_SECONDS, CAP_SEEDS } from './hoeffding-stats.mjs';
import { STOP_RULE } from './compare-hoeffding-report.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const i = process.argv.indexOf('--dir');
const DIR = path.resolve(ROOT, i >= 0 ? process.argv[i + 1] : 'out/hoeffding-ab');
const RESULTS = path.join(DIR, 'results.json');
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); appendFileSync(path.join(DIR, 'overnight.log'), l + '\n'); };

const load = () => existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : { cells: [] };
const spent = () => load().cells.reduce((s, c) => s + (c.wallSeconds ?? 0), 0);
const seeds = (n, from = 1) => Array.from({ length: n }, (_, k) => `s${from + k}`);
function pair(arms, seed) {
  const r = spawnSync('node', ['scripts/compare-search.mjs', 'run', '--dir', path.relative(ROOT, DIR), '--arms', arms, '--seeds', seed, '--top', '5', '--heldout', '60'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Error(`run failed for ${arms} ${seed}`);
}

log(STOP_RULE);
log(`start; budget ${BUDGET_SECONDS}s, spent so far ${spent().toFixed(0)}s`);

// Short seeds in pairs until the stop rule says stop.
for (let n = 1; n <= CAP_SEEDS; n++) {
  const s = `s${n}`;
  const rows = () => pairedRows(load().cells, seeds(CAP_SEEDS), 'base', 'hoeffding');
  const have = rows().some((r) => r.seed === s);
  if (!have) {
    const shorts = load().cells.filter((c) => (c.arm === 'base' || c.arm === 'hoeffding') && c.wallSeconds);
    const est = shorts.length ? shorts.reduce((a, c) => a + c.wallSeconds, 0) / (shorts.length / 2) : 400;
    if (spent() + est > BUDGET_SECONDS) { log(`budget reached at ${rows().length} short seeds (spent ${spent().toFixed(0)}s, next pair ~${est.toFixed(0)}s)`); break; }
    if (stopStatus(rows()).stop) break;
    pair('base,hoeffding', s);
    log(`short ${s} done; spent ${spent().toFixed(0)}s`);
  }
  const st = stopStatus(rows());
  if (rows().length >= 10 && rows().length % 10 === 0) log(`check at n=${rows().length}: ${st.result.verdict} mean ${(st.result.mean * 100).toFixed(2)} range ${(st.result.lower * 100).toFixed(2)}..${(st.result.upper * 100).toFixed(2)} battleRatio ${st.result.battleRatio.toFixed(2)}`);
  if (st.stop) { log(`stop at n=${st.at}: ${st.result.verdict}`); break; }
}
log('finished');
