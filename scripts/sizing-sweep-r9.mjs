#!/usr/bin/env node
// Round-9 driver (plans/PLAN.md, amended live by the user): joint search over (population, pool, K) for
// the actual local-optimum recipe at 90% certainty. DEVIATION FROM PLAN.md's literal "knee" (doubling/
// halving) definition, per explicit user instruction: doubling/halving only ever re-tests points we
// already know are inferior (o500, p400, ...) and can only land on round power-of-2 values. Instead this
// is Hooke-Jeeves-style pattern search with a shrinking multiplicative step per dimension: from the
// current point, probe +step% and -step% (holding the other two dims fixed); if either neighbor is a
// significant (90% CI wholly > 0) held-out-quality improvement, move there and keep the same step size
// (exploit); if neither improves, halve the step and retry from the same point. A dimension is converged
// once its step is below STEP_MIN (or would move by <1 unit). The search stops once all three dims are
// converged -- landing on whatever integers the local optimum actually is, not the nearest power of 2.
//
//   node scripts/sizing-sweep-r9.mjs [--dir out/sizing-cells-r9]
//
// Resumable: rerunning reads out/sizing-cells-r9/state.json and each dir's results.json and picks up
// where it left off; it runs nothing once state.json says "found" or "not found".
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argi = process.argv.indexOf('--dir');
const DIR = path.resolve(ROOT, argi >= 0 ? process.argv[argi + 1] : path.join('out', 'sizing-cells-r9'));
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'sweep.log');

// Existing post-fix cell dirs (read-only; never rerun a setting+seed already there).
export const PRIOR_DIRS = ['out/sampled-k-ab-r3', 'out/sizing-cells', 'out/sizing-cells-r8'];
// Known sleep/pause-inflated cells (plans/PLAN.md Facts): excluded from cost, kept for quality.
export const INFLATED = new Set(['k10/s6', 'k10/s7', 'p400/s6']);

export const MAX_SEEDS_PER_POINT_PAIR = 40; // per-comparison seed cap; hitting it counts as "no significant improvement"
export const SEEDS_PER_STEP = 3; // seeds added to each side per CI check that is still inconclusive
export const MAX_PASSES = 400; // safety valve; each pass can shrink one dim's step, so needs headroom
export const STEP_INIT = 0.30; // starting probe size: +/-30% of the current value
export const STEP_MIN = 0.04; // below this fraction, a dimension is converged

const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); appendFileSync(LOG, l + '\n'); };

// ---- t-distribution 90% two-sided critical values (df 1..30, else normal 1.645). ----
const T90 = [0, 6.314, 2.920, 2.353, 2.132, 2.015, 1.943, 1.895, 1.860, 1.833, 1.812, 1.796, 1.782, 1.771, 1.761, 1.753,
  1.746, 1.740, 1.734, 1.729, 1.725, 1.721, 1.717, 1.714, 1.711, 1.708, 1.706, 1.703, 1.701, 1.699, 1.697];
function tCrit(df) { return df >= 30 ? 1.645 : T90[Math.max(1, Math.round(df))]; }

function mean(xs) { return xs.reduce((s, x) => s + x, 0) / xs.length; }
function sd(xs) { const m = mean(xs); return xs.length < 2 ? 0 : Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)); }

/** Welch's t 90% CI for mean(b) - mean(a), both in percentage points. Returns {lo, hi, df} or null if underpowered. */
export function welchCI(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const ma = mean(a), mb = mean(b), sa = sd(a), sb = sd(b);
  const va = sa * sa / a.length, vb = sb * sb / b.length;
  const se = Math.sqrt(va + vb);
  if (se === 0) return { lo: mb - ma, hi: mb - ma, df: a.length + b.length - 2 };
  const df = (va + vb) ** 2 / ((va * va) / (a.length - 1) + (vb * vb) / (b.length - 1));
  const t = tCrit(df);
  return { lo: mb - ma - t * se, hi: mb - ma + t * se, df };
}

// ---- point <-> arm name. Sizing arms already in compare-search.mjs's ARMS are reused by name so their
// existing cells are picked up; anything else gets the dynamic c<pop>o<pool>k<K> name. ----
const NAMED_POINTS = {
  '200/50/50': 'o50', '200/500/50': 'o500', '50/50/50': 'p50', '100/50/50': 'p100', '400/50/50': 'p400',
  '200/100/50': 'o100', '200/200/50': 'o200', '200/50/10': 'k10', '200/50/25': 'k25',
};
function armName(pop, pool, k) {
  const key = `${pop}/${pool}/${k}`;
  return NAMED_POINTS[key] ?? `c${pop}o${pool}k${k}`;
}

function loadCells(dir) {
  const f = path.join(dir, 'results.json');
  if (!existsSync(f)) return [];
  return JSON.parse(readFileSync(f, 'utf8')).cells;
}
/** Merge prior (read-only) dirs + this round's dir. */
function allCells() {
  const cells = [];
  for (const d of PRIOR_DIRS) for (const c of loadCells(path.join(ROOT, d))) cells.push({ ...c, dir: d });
  for (const c of loadCells(DIR)) cells.push({ ...c, dir: path.relative(ROOT, DIR) });
  return cells;
}
function qualityFor(arm) {
  return allCells().filter((c) => c.arm === arm && c.heldoutMeanTop != null).map((c) => c.heldoutMeanTop * 100);
}
function seedCountFor(arm) { return qualityFor(arm).length; }

function minPop(pool, k) { return Math.max(1, Math.ceil(pool / k)); }

function runSeeds(arm, n) {
  const have = new Set(allCells().filter((c) => c.arm === arm).map((c) => c.seed));
  const need = [];
  for (let i = 1; need.length < n; i++) { const s = `s${i}`; if (!have.has(s)) need.push(s); }
  mkdirSync(DIR, { recursive: true });
  const r = spawnSync('node', ['scripts/compare-search.mjs', 'run', '--dir', path.relative(ROOT, DIR), '--arms', arm, '--seeds', need.join(','), '--top', '5', '--heldout', '60'],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`compare-search run failed for ${arm} seeds ${need.join(',')}`);
}

/**
 * Does point B beat point A by a statistically significant (90% CI wholly > 0) held-out-quality margin?
 * Adds seeds in batches of SEEDS_PER_STEP to whichever side has fewer until the 90% CI on (B - A)
 * resolves fully above/at-or-below 0, or the per-comparison seed cap is hit (treated as "no", i.e. not a
 * confirmed improvement -- the search just shrinks its step rather than stopping).
 * Returns {beats: true|false, ci}.
 */
function probeBeats(aArm, bArm) {
  ensureArmsKnown(aArm, bArm);
  for (;;) {
    const a = qualityFor(aArm), b = qualityFor(bArm);
    const ci = welchCI(a, b);
    if (ci) {
      if (ci.lo > 0) { log(`  ${bArm} vs ${aArm}: gain 90% CI [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}] pt -- significant improvement`); return { beats: true, ci }; }
      if (ci.hi <= 0) { log(`  ${bArm} vs ${aArm}: gain 90% CI [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}] pt -- not better`); return { beats: false, ci }; }
      log(`  ${bArm} vs ${aArm}: gain 90% CI [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}] pt -- inconclusive, n=${a.length}/${b.length}`);
    } else {
      log(`  ${bArm} vs ${aArm}: not enough seeds yet (n=${a.length}/${b.length})`);
    }
    if (Math.min(a.length, b.length) >= MAX_SEEDS_PER_POINT_PAIR) { log(`  ${bArm} vs ${aArm}: seed cap ${MAX_SEEDS_PER_POINT_PAIR} reached, treating as not a confirmed improvement`); return { beats: false, ci, capped: true }; }
    if (a.length <= b.length) runSeeds(aArm, a.length + SEEDS_PER_STEP); else runSeeds(bArm, b.length + SEEDS_PER_STEP);
  }
}

function clampPoint(pop, pool, k) {
  pop = Math.max(1, Math.round(pop));
  pool = Math.max(1, Math.round(pool));
  k = Math.max(1, Math.min(Math.round(k), pool));
  if (pop < minPop(pool, k)) pop = minPop(pool, k);
  return { pop, pool, k };
}

// compare-search.mjs registers dynamic arms lazily on `cellFlags`/`run`; import it so ARMS gets populated
// the same way `run` would, keeping results.json's armFlags record accurate.
import { ensureArm } from './compare-search.mjs';
function ensureArmsKnown(...names) { for (const n of names) ensureArm(n); }

function saveState(state) { mkdirSync(DIR, { recursive: true }); writeFileSync(STATE, JSON.stringify(state, null, 2)); }
function loadState() { return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null; }

async function main() {
  mkdirSync(DIR, { recursive: true });
  let state = loadState();
  if (state && (state.status === 'found' || state.status === 'not-found')) {
    log(`already ${state.status}; rerun after deleting ${path.relative(ROOT, STATE)} to search again`);
    return;
  }
  let P = state?.point ?? { pop: 200, pool: 50, k: 50 }; // start at the round 7-8 baseline
  let step = state?.step ?? { pop: STEP_INIT, pool: STEP_INIT, k: STEP_INIT };
  const path_ = state?.path ?? [];
  log(`round-9 pattern search starting from pop=${P.pop} pool=${P.pool} k=${P.k}, step=${JSON.stringify(step)}`);

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (step.pop < STEP_MIN && step.pool < STEP_MIN && step.k < STEP_MIN) break;
    let movedThisPass = false;
    for (const dim of ['pop', 'pool', 'k']) {
      if (step[dim] < STEP_MIN) continue;
      const cur = clampPoint(P.pop, P.pool, P.k);
      const curArm = armName(cur.pop, cur.pool, cur.k);
      const v = cur[dim];
      const hiVal = v * (1 + step[dim]);
      const loVal = v * (1 - step[dim]);
      const hi = dim === 'pop' ? clampPoint(hiVal, cur.pool, cur.k) : dim === 'pool' ? clampPoint(cur.pop, hiVal, cur.k) : clampPoint(cur.pop, cur.pool, hiVal);
      const lo = dim === 'pop' ? clampPoint(loVal, cur.pool, cur.k) : dim === 'pool' ? clampPoint(cur.pop, loVal, cur.k) : clampPoint(cur.pop, cur.pool, loVal);
      log(`pass ${pass}: probing ${dim} around ${curArm} (pop=${cur.pop} pool=${cur.pool} k=${cur.k}), step=${(step[dim] * 100).toFixed(0)}%`);

      let moved = false;
      if (hi[dim] !== v) {
        const hiArm = armName(hi.pop, hi.pool, hi.k);
        const r = probeBeats(curArm, hiArm);
        if (r.beats) {
          P = hi;
          path_.push({ pass, dim, action: 'step-up', to: { ...P }, arm: armName(P.pop, P.pool, P.k), step: step[dim] });
          log(`  -> ${dim} up to ${P[dim]}: new point pop=${P.pop} pool=${P.pool} k=${P.k}`);
          moved = true;
        }
      }
      if (!moved && lo[dim] !== v) {
        const loArm = armName(lo.pop, lo.pool, lo.k);
        const r = probeBeats(curArm, loArm);
        if (r.beats) {
          P = lo;
          path_.push({ pass, dim, action: 'step-down', to: { ...P }, arm: armName(P.pop, P.pool, P.k), step: step[dim] });
          log(`  -> ${dim} down to ${P[dim]}: new point pop=${P.pop} pool=${P.pool} k=${P.k}`);
          moved = true;
        }
      }
      if (moved) { movedThisPass = true; break; } // re-evaluate from the new point next dim
      step[dim] /= 2;
      log(`  neither neighbor of ${dim} improved; shrinking step to ${(step[dim] * 100).toFixed(1)}%`);
    }
    saveState({ status: 'running', point: P, step, path: path_ });
  }
  if (step.pop < STEP_MIN && step.pool < STEP_MIN && step.k < STEP_MIN) {
    log(`FOUND: pop=${P.pop} pool=${P.pool} k=${P.k}`);
    saveState({ status: 'found', point: P, step, path: path_ });
  } else {
    log(`NOT FOUND: max passes (${MAX_PASSES}) reached without all three dims converging`);
    saveState({ status: 'not-found', reason: `max passes (${MAX_PASSES}) reached`, point: P, step, path: path_ });
  }

  // Confirmation seeds at the recommended recipe (requirement 3): a handful of fresh seeds beyond
  // whatever the search already collected there, so the report can check measured-vs-predicted.
  const final = loadState();
  if (final.status === 'found') {
    const arm = armName(final.point.pop, final.point.pool, final.point.k);
    const have = seedCountFor(arm);
    if (have < 10) { log(`collecting confirmation seeds at ${arm} (have ${have}, want 10)`); runSeeds(arm, 10); }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((err) => { console.error(err); log(`ERROR: ${err.stack}`); process.exit(1); });
