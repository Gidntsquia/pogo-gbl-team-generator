#!/usr/bin/env node
// Round-9 driver (plans/PLAN.md): joint gradient-descent-like search over (population, pool, K) for the
// knee recipe at 90% certainty. Coordinate descent: for each of the three sizes in turn, compare the
// current point to 2x and 0.5x that size (holding the other two fixed), using a Welch 90% CI on the mean
// held-out-quality gain. A size is "resolved" when both checks in requirement 2 pass (or it is exempt).
// Moving a size invalidates the other two sizes' resolved status (the point changed), so the loop repeats
// until one full pass resolves all three at once, or a per-comparison seed cap is hit without resolving
// (search stops, answer is "not found").
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

export const THRESHOLD = 1.0; // pt of held-out quality per doubling
export const MAX_SEEDS_PER_POINT_PAIR = 40; // per-comparison seed cap; hitting it -> "not found"
export const SEEDS_PER_STEP = 3; // seeds added to each side per CI check that is still inconclusive
export const MAX_PASSES = 200; // safety valve against a cycling point; a real cycle would itself mean "not found"

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
 * Compare point B (2x or 0.5x on one dim) to point A. Adds seeds in batches of SEEDS_PER_STEP to
 * whichever side has fewer until the 90% CI on (B - A) resolves (fully above/below THRESHOLD) or the
 * per-comparison cap is hit. Returns {resolved, ci, aArm, bArm} — resolved is 'above' | 'below' | false.
 */
function resolveComparison(aArm, bArm) {
  ensureArmsKnown(aArm, bArm);
  for (;;) {
    const a = qualityFor(aArm), b = qualityFor(bArm);
    const ci = welchCI(a, b);
    if (ci) {
      if (ci.lo > THRESHOLD) { log(`  ${bArm} vs ${aArm}: gain 90% CI [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}] pt -- wholly above ${THRESHOLD}`); return { resolved: 'above', ci }; }
      if (ci.hi < THRESHOLD) { log(`  ${bArm} vs ${aArm}: gain 90% CI [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}] pt -- wholly below ${THRESHOLD}`); return { resolved: 'below', ci }; }
      log(`  ${bArm} vs ${aArm}: gain 90% CI [${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}] pt -- straddles ${THRESHOLD}, n=${a.length}/${b.length}`);
    } else {
      log(`  ${bArm} vs ${aArm}: not enough seeds yet (n=${a.length}/${b.length})`);
    }
    if (Math.min(a.length, b.length) >= MAX_SEEDS_PER_POINT_PAIR) { log(`  ${bArm} vs ${aArm}: seed cap ${MAX_SEEDS_PER_POINT_PAIR} reached without resolving`); return { resolved: false, ci }; }
    if (a.length <= b.length) runSeeds(aArm, a.length + SEEDS_PER_STEP); else runSeeds(bArm, b.length + SEEDS_PER_STEP);
  }
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
  let resolved = state?.resolved ?? { pop: false, pool: false, k: false };
  const path_ = state?.path ?? [];
  log(`round-9 sweep starting from pop=${P.pop} pool=${P.pool} k=${P.k}, resolved=${JSON.stringify(resolved)}`);

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (resolved.pop && resolved.pool && resolved.k) {
      log(`FOUND: pop=${P.pop} pool=${P.pool} k=${P.k}`);
      saveState({ status: 'found', point: P, resolved, path: path_ });
      return;
    }
    let movedThisPass = false;
    for (const dim of ['pop', 'pool', 'k']) {
      if (resolved[dim]) continue;
      const v = P[dim];
      const exemptLo = dim === 'pop' ? v <= minPop(P.pool, P.k) : dim === 'k' ? v >= P.pool : v <= 1;
      const exemptHi = dim === 'k' ? v >= P.pool : false;
      const vHi = exemptHi ? v : v * 2;
      const vLo = exemptLo ? v : Math.max(1, Math.round(v / 2));

      const point = (pop, pool, k) => ({ pop, pool, k: Math.min(k, pool) });
      const cur = point(P.pop, P.pool, P.k);
      const curArm = armName(cur.pop, cur.pool, cur.k);
      log(`pass ${pass}: checking ${dim} at ${curArm} (pop=${cur.pop} pool=${cur.pool} k=${cur.k})`);

      let upperOk = exemptHi ? 'above' : null; // 'above' means: doubling still gains >=1pt (keep growing); exempt at K>=pool means no upper check needed
      let hiResult = null;
      if (!exemptHi) {
        const hi = dim === 'pop' ? point(vHi, cur.pool, cur.k) : dim === 'pool' ? point(cur.pop, vHi, cur.k) : point(cur.pop, cur.pool, vHi);
        const hiArm = armName(hi.pop, hi.pool, hi.k);
        if (minPop(hi.pool, hi.k) > hi.pop) { log(`  ${hiArm} invalid (pop < ceil(pool/K)); treating doubling as unresolved, moving up cautiously`); upperOk = 'above'; }
        else { hiResult = resolveComparison(curArm, hiArm); upperOk = hiResult.resolved === false ? 'stuck' : hiResult.resolved; }
      }

      if (upperOk === 'stuck') { saveState({ status: 'not-found', reason: `${dim} doubling from ${curArm} did not resolve within the seed cap`, point: P, resolved, path: path_ }); log('NOT FOUND: seed cap hit; stopping'); return; }
      if (upperOk === 'above') {
        // doubling still gains >=1pt -- grow this dim and keep going
        P = dim === 'pop' ? point(vHi, P.pool, P.k) : dim === 'pool' ? point(P.pop, vHi, P.k) : point(P.pop, P.pool, vHi);
        resolved = { pop: false, pool: false, k: false };
        path_.push({ pass, dim, action: 'grow', to: { ...P }, arm: armName(P.pop, P.pool, P.k) });
        movedThisPass = true;
        log(`  -> growing ${dim} to ${P[dim]}: new point pop=${P.pop} pool=${P.pool} k=${P.k}`);
        break; // re-evaluate from the new point next dim pass
      }

      // upperOk === 'below' (or exempt): doubling gains <1pt. Now check the lower side, unless exempt.
      if (exemptLo) {
        resolved[dim] = true;
        log(`  ${dim}=${v} resolved (exempt from lower check: ${dim === 'pop' ? 'at evolve minimum' : dim === 'k' ? 'K>=pool' : 'at floor'})`);
        continue;
      }
      const lo = dim === 'pop' ? point(vLo, cur.pool, cur.k) : dim === 'pool' ? point(cur.pop, vLo, cur.k) : point(cur.pop, cur.pool, vLo);
      const loArm = armName(lo.pop, lo.pool, lo.k);
      if (minPop(lo.pool, lo.k) > lo.pop) { log(`  ${loArm} invalid; treating ${dim}=${v} as exempt on the low side`); resolved[dim] = true; continue; }
      const loResult = resolveComparison(loArm, curArm); // gain from growing lo -> cur
      if (loResult.resolved === false) { saveState({ status: 'not-found', reason: `${dim} halving check from ${curArm} did not resolve within the seed cap`, point: P, resolved, path: path_ }); log('NOT FOUND: seed cap hit; stopping'); return; }
      if (loResult.resolved === 'above') { resolved[dim] = true; log(`  ${dim}=${v} resolved (upper<1pt, lower>1pt)`); continue; }
      // gain from growing to current was <1pt too -- shrink
      P = dim === 'pop' ? point(vLo, P.pool, P.k) : dim === 'pool' ? point(P.pop, vLo, P.k) : point(P.pop, P.pool, vLo);
      resolved = { pop: false, pool: false, k: false };
      path_.push({ pass, dim, action: 'shrink', to: { ...P }, arm: armName(P.pop, P.pool, P.k) });
      movedThisPass = true;
      log(`  -> shrinking ${dim} to ${P[dim]}: new point pop=${P.pop} pool=${P.pool} k=${P.k}`);
      break;
    }
    saveState({ status: 'running', point: P, resolved, path: path_ });
    if (!movedThisPass && (resolved.pop && resolved.pool && resolved.k)) break;
  }
  if (resolved.pop && resolved.pool && resolved.k) {
    log(`FOUND: pop=${P.pop} pool=${P.pool} k=${P.k}`);
    saveState({ status: 'found', point: P, resolved, path: path_ });
  } else {
    log(`NOT FOUND: max passes (${MAX_PASSES}) reached without a stable joint resolution`);
    saveState({ status: 'not-found', reason: `max passes (${MAX_PASSES}) reached`, point: P, resolved, path: path_ });
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
