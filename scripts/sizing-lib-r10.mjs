// Round-10 sizing library (plans/PLAN.md round 10): cell loading, the one fitted model over all cells, the
// knee rule, and cell placement. Pure except loadAllCells (reads out/). Used by sizing-sweep-r10.mjs
// (the batch) and sizing-report-r10.mjs (the report).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
/** Post-fix cell dirs from rounds 3-9 (read-only). Pre-fix out/sampled-k-ab/ is never used. */
export const PRIOR_DIRS = ['out/sampled-k-ab-r3', 'out/sizing-cells', 'out/sizing-cells-r8', 'out/sizing-cells-r9'];
export const R10_REL = 'out/sizing-cells-r10';
export const R10_CELLS = path.join(ROOT, R10_REL, 'cells.json');
/** Known sleep/pause-inflated cells (plans/PLAN.md Facts): kept for quality, excluded from cost. */
export const KNOWN_INFLATED = ['k10/s6', 'k10/s7', 'p400/s6'];
/** Cells whose wall time is off for a non-sleep reason (a resume), per Facts: excluded from cost too. */
export const KNOWN_OFF = ['k10/s1', 'p50/s1'];
export const TOP = 5;
export const FULL_GENERATIONS = 8;

/** Sizes of the pre-named sizing arms, so a new cell at one of these settings reuses the arm name. */
export const NAMED = {
  '200/50/50': 'o50', '200/500/50': 'o500', '50/50/50': 'p50', '100/50/50': 'p100', '400/50/50': 'p400',
  '200/100/50': 'o100', '200/200/50': 'o200', '200/50/10': 'k10', '200/50/25': 'k25',
};

/** Arm name for a setting (named arm when one exists, else c<pop>o<pool>k<K>), suffixed -g<G> if cheap. */
export function armName({ pop, pool, k }, generations = FULL_GENERATIONS) {
  const base = NAMED[`${pop}/${pool}/${k}`] ?? `c${pop}o${pool}k${k}`;
  return generations === FULL_GENERATIONS ? base : `${base}-g${generations}`;
}

/** Sizes from a cell's evolve flags (population, opponents-per-gen = pool, sampled-opponents = K). */
export function sizesFromFlags(flags) {
  const v = (name) => { const i = flags.lastIndexOf(name); return i >= 0 ? Number(flags[i + 1]) : null; };
  return { pop: v('--population'), pool: v('--opponents-per-gen'), k: v('--sampled-opponents'), generations: v('--generations') ?? FULL_GENERATIONS };
}

function summarizeRun(dir) {
  const result = JSON.parse(readFileSync(path.join(dir, 'evolve-result.json'), 'utf8'));
  const gens = result.generationRecords;
  const genBattles = gens.reduce((s, g) => s + g.timing.battleCount, 0);
  return {
    generations: gens.length,
    genBattles,
    genSeconds: gens.reduce((s, g) => s + g.timing.elapsedMs, 0) / 1000,
    totalBattles: genBattles + (result.eliteTiming?.battleCount ?? 0),
    totalSeconds: result.totalElapsedMs / 1000,
    finalists: result.elites.map((e) => e.signature),
  };
}

/**
 * Every usable cell, oldest dir first: the saved results.json cells of PRIOR_DIRS, run dirs in those dirs
 * that finished evolve but never reached results.json (round 9's stop; flagged `recovered`, no wall time),
 * and this round's cells (out/sizing-cells-r10/cells.json). Each cell: {key, arm, seed, dir, source,
 * sizes:{pop,pool,k}, generations, cheap, genBattles, totalBattles, wallSeconds|null, costSeconds|null,
 * finalists, old60|null, inflated:string|null}.
 * @returns {object[]}
 */
export async function loadAllCellsAsync() {
  const { cellFlags } = await import('./compare-search.mjs');
  return loadAllCells(cellFlags);
}

/** Synchronous form; pass compare-search.mjs's cellFlags (import it once in the caller). */
export function loadAllCells(cellFlags) {
  const cells = [];
  for (const rel of PRIOR_DIRS) {
    const dir = path.join(ROOT, rel);
    const file = path.join(dir, 'results.json');
    if (!existsSync(file)) continue;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const seen = new Set();
    for (const c of data.cells) {
      if (!c.finalists || c.heldoutMeanTop == null) continue;
      seen.add(`${c.arm}-${c.seed}`);
      const flags = data.armFlags?.[c.arm] ? [...data.baseFlags, ...data.armFlags[c.arm]] : cellFlags(c.arm);
      cells.push(makeCell({ ...c, dir: rel, source: 'results.json', flags, wallSeconds: c.wallSeconds, old60: c.heldoutMeanTop }));
    }
    for (const name of readdirSync(dir)) {
      const m = /^(.+)-(s\d+)$/.exec(name);
      if (!m || seen.has(name) || !existsSync(path.join(dir, name, 'evolve-result.json'))) continue;
      const [, arm, seed] = m;
      cells.push(makeCell({ arm, seed, dir: rel, source: 'recovered', flags: cellFlags(arm), ...summarizeRun(path.join(dir, name)), wallSeconds: null, old60: null }));
    }
  }
  if (existsSync(R10_CELLS)) {
    for (const c of JSON.parse(readFileSync(R10_CELLS, 'utf8')).cells) cells.push(makeCell({ ...c, dir: R10_REL, source: 'round 10', old60: null }));
  }
  return cells;
}

function makeCell(c) {
  const s = c.sizes ?? sizesFromFlags(c.flags);
  const sizes = { pop: s.pop, pool: s.pool, k: s.k };
  const generations = c.generations ?? s.generations ?? FULL_GENERATIONS;
  const key = `${c.arm}/${c.seed}`;
  let inflated = null;
  if (KNOWN_INFLATED.includes(key)) inflated = 'sleep/pause (Facts)';
  else if (KNOWN_OFF.includes(key)) inflated = 'resume (Facts)';
  else if (c.inflated) inflated = c.inflated;
  return {
    key, arm: c.arm, seed: c.seed, dir: c.dir, source: c.source, sizes, generations,
    cheap: generations !== FULL_GENERATIONS,
    genBattles: c.genBattles, totalBattles: c.totalBattles,
    // Battles a cell took from the shared cross-cell battle cache instead of simulating (cells from
    // 2026-09-28 on). genBattles/totalBattles count only simulated battles; the *Standalone figures are what
    // the cell would have simulated on its own, which is the cost the recipe carries for a real run.
    sharedCacheBattles: c.sharedCacheBattles ?? 0,
    genBattlesStandalone: c.genBattles + (c.sharedCacheGenBattles ?? 0),
    totalBattlesStandalone: c.totalBattles + (c.sharedCacheBattles ?? 0),
    wallSeconds: c.wallSeconds ?? null,
    // Cost in seconds: measured wall time for saved cells; evolve's own elapsed time for recovered cells.
    costSeconds: c.wallSeconds ?? c.totalSeconds ?? null,
    finalists: c.finalists, old60: c.old60 ?? null, inflated,
  };
}

// ---------------------------------------------------------------- statistics

export function mean(xs) { return xs.reduce((s, x) => s + x, 0) / xs.length; }
export function sd(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Standard normal quantile (Acklam's rational approximation, |error| < 1.2e-9). */
export function normQuantile(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - lo) return -normQuantile(1 - p);
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Student-t quantile via the Cornish-Fisher expansion (error < 1e-4 for df >= 5). */
export function tQuantile(p, df) {
  const z = normQuantile(p);
  const z3 = z ** 3, z5 = z ** 5, z7 = z ** 7;
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3);
}

/** Inverse of a symmetric positive-definite matrix by Gauss-Jordan with partial pivoting. */
export function invert(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) throw new Error('model matrix is singular: the cells do not identify every term');
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f !== 0) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map((row) => row.slice(n));
}

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const matVec = (M, v) => M.map((row) => dot(row, v));

// ---------------------------------------------------------------- the model

/**
 * Model terms. x = log2 of each size, with K capped at the pool (K >= pool means every candidate fights the
 * whole pool, so K above the pool changes nothing). Quadratic in each log size plus the three pairwise
 * interactions:
 *   quality = b0 + sum_i (b_i x_i + c_i x_i^2) + sum_{i<j} d_ij x_i x_j
 * so the gain per doubling of size i is b_i + c_i (2 x_i + 1) + sum_j d_ij x_j: it changes with the size
 * itself (a knee when c_i < 0) AND with the other two sizes. The interactions were added 2026-09-28 after
 * the additive form recommended pop 8 at pool/K 1000: it had learned "pop barely helps" from hundreds of
 * pop-12 cells at K 3 (where fitness from 3 opponents is too noisy for selection to use a bigger
 * population) and "K helps a lot" from pop-200 cells, then added the two. Measured: pop 12 at pool = K
 * 384 scored 56.7, 5 pt under the additive prediction and 3.7 pt under pop 200/50/50 (WORKER_NOTES.md).
 */
export const SIZE_KEYS = ['pop', 'pool', 'k'];
export const TERM_NAMES = ['intercept', 'log2 pop', 'log2 pool', 'log2 K', '(log2 pop)^2', '(log2 pool)^2', '(log2 K)^2',
  'log2 pop x log2 pool', 'log2 pop x log2 K', 'log2 pool x log2 K'];
/** Coefficient index of the interaction between sizes i and j (0 pop, 1 pool, 2 k). */
const PAIR_INDEX = { '0,1': 7, '0,2': 8, '1,2': 9 };
export function pairIndex(i, j) { return PAIR_INDEX[i < j ? `${i},${j}` : `${j},${i}`]; }

export function logSizes({ pop, pool, k }) {
  return [Math.log2(pop), Math.log2(pool), Math.log2(Math.min(k, pool))];
}

/** Feature row for a setting. Log sizes are centered on the round 7-9 baseline (200/50/50). */
export function features(sizes) {
  const x = logSizes(sizes);
  const c = logSizes({ pop: 200, pool: 50, k: 50 });
  const z = x.map((v, i) => v - c[i]);
  return [1, z[0], z[1], z[2], z[0] ** 2, z[1] ** 2, z[2] ** 2, z[0] * z[1], z[0] * z[2], z[1] * z[2]];
}

/**
 * Ordinary least squares.
 * @param {number[][]} X rows of features
 * @param {number[]} y
 * @returns {{beta:number[], cov:number[][], XtXinv:number[][], residSd:number, df:number, n:number, residuals:number[]}}
 */
export function ols(X, y) {
  const p = X[0].length, n = X.length;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let r = 0; r < n; r++) for (let i = 0; i < p; i++) {
    Xty[i] += X[r][i] * y[r];
    for (let j = 0; j < p; j++) XtX[i][j] += X[r][i] * X[r][j];
  }
  const XtXinv = invert(XtX);
  const beta = matVec(XtXinv, Xty);
  const residuals = y.map((v, r) => v - dot(X[r], beta));
  const df = n - p;
  const s2 = residuals.reduce((s, e) => s + e * e, 0) / df;
  return { beta, cov: XtXinv.map((row) => row.map((v) => v * s2)), XtXinv, residSd: Math.sqrt(s2), df, n, residuals };
}

/** Estimate, standard error and 90% two-sided range of a linear contrast of the coefficients. */
export function contrast(fit, cvec) {
  const est = dot(cvec, fit.beta);
  const se = Math.sqrt(dot(cvec, matVec(fit.cov, cvec)));
  const t = tQuantile(0.95, fit.df);
  return { est, se, lo: est - t * se, hi: est + t * se };
}

/** Contrast vector for quality(to) - quality(from). */
export function diffVec(from, to) {
  const a = features(from), b = features(to);
  return b.map((v, i) => v - a[i]);
}

/**
 * One point of quality in the units the model is fit in. Quality is a win-rate fraction (0..1; the report
 * prints it x100), so 1 pt is 0.01 -- NOT 1, which would be 100 pts and make every knee test unpassable.
 */
export const ONE_PT = 0.01;

/** Minimum population evolve accepts for a pool and K (src/evolve/cli.js: population >= ceil(pool/K)). */
export function minPop(pool, k) { return Math.ceil(pool / Math.min(k, pool)); }

/**
 * The two knee tests for each size at a setting: gain from doubling it (must be wholly < 1 pt) and gain
 * from half its value up to it (must be wholly > 1 pt). Exemptions: pop's lower test at evolve's minimum
 * population; pool's lower test when pool <= K (halving the pool would also cut K); K's lower test at K = 1;
 * pool's lower test at pool = 1. When K >= pool, K's upper test doubles pool and K together.
 * @returns {{[size:string]: {up:object|null, down:object|null, upExempt:string|null, downExempt:string|null, pass:boolean, upTo:object, halfFrom:object}}}
 */
export function kneeTests(fit, s, threshold = ONE_PT) {
  const out = {};
  for (const key of SIZE_KEYS) {
    // K >= pool: doubling K alone changes nothing (the model caps K at the pool), so K's upward test doubles
    // the pool with it -- the same move kneeEstimate makes when it raises the pool to K. It used to be
    // exempt, which let a recipe whose K sat at the edge of the measured region pass with no evidence that
    // more K (and pool) stops paying (2026-09-28).
    const up = key === 'k' && s.k >= s.pool ? { ...s, pool: s.pool * 2, k: s.k * 2 } : { ...s, [key]: s[key] * 2 };
    const half = { ...s, [key]: s[key] / 2 };
    let upExempt = null, downExempt = null;
    if (key === 'pop' && s.pop / 2 < minPop(s.pool, s.k)) downExempt = `at evolve's minimum population (ceil(pool/K) = ${minPop(s.pool, s.k)})`;
    if (key === 'pool' && s.pool <= s.k) downExempt = 'pool <= K: halving the pool would also cut K';
    if ((key === 'k' || key === 'pool') && s[key] / 2 < 1) downExempt = 'at the smallest value evolve accepts (1)';
    const upC = upExempt ? null : contrast(fitForTests(fit), diffVec(s, up));
    const downC = downExempt ? null : contrast(fitForTests(fit), diffVec(half, s));
    const pass = (upExempt || upC.hi < threshold) && (downExempt || downC.lo > threshold);
    out[key] = { up: upC, down: downC, upExempt, downExempt, pass: !!pass, upTo: up, halfFrom: half };
  }
  return out;
}
function fitForTests(fit) { return fit; }

/**
 * Point-estimate knee of each size under the fitted model: the value where the fitted gain per doubling
 * crosses the threshold, placed half a doubling past the crossing so the gain from doubling and the gain
 * from halving sit symmetrically around it (that placement makes both knee tests easiest to pass).
 * Returns {sizes, status:{pop,pool,k}} where a status other than 'knee' explains why a size sits at a bound.
 */
export function kneeEstimate(fit, bounds, threshold = ONE_PT) {
  const b = fit.beta;
  const center = logSizes({ pop: 200, pool: 50, k: 50 });
  const lo = SIZE_KEYS.map((key, i) => Math.log2(bounds[key][0]) - center[i]);
  const hi = SIZE_KEYS.map((key, i) => Math.log2(bounds[key][1]) - center[i]);
  // Size i's fitted gain per doubling from centered log size v is b_i + c_i (2v + 1) + sum_j d_ij z_j; at
  // v = x - 1/2 (half a doubling below x) it is b_i + 2 c_i x + sum_j d_ij z_j. With interactions each
  // size's knee depends on the other two, so solve one size at a time with the others held, and repeat
  // until nothing moves (coordinate iteration; every step is clamped to the bounds, so it cannot run off).
  let z = [0, 0, 0];
  let status = {};
  for (let iter = 0; iter < 200; iter++) {
    const prev = z.slice();
    status = {};
    SIZE_KEYS.forEach((key, i) => {
      const bi = b[1 + i], ci = b[4 + i];
      let other = 0;
      for (let j = 0; j < 3; j++) if (j !== i) other += b[pairIndex(i, j)] * z[j];
      const slopeAt = (x) => bi + other + 2 * ci * x;
      // The knee is the smallest value past which every further doubling gains < threshold. The slope is
      // linear in x, so it is monotone: if it is still above threshold at the upper bound (concave or
      // convex) the knee lies beyond the bounds; otherwise, if it is at/below threshold at the lower bound
      // and not rising (concave or flat), every doubling from the minimum gains too little. A convex fit
      // (ci > 0) that ends below threshold at hi was below it everywhere, so it is 'minimum' too.
      if (slopeAt(hi[i]) > threshold) { z[i] = hi[i]; status[key] = 'above search bound'; return; }
      if (slopeAt(lo[i]) <= threshold || ci >= 0) { z[i] = lo[i]; status[key] = 'minimum'; return; }
      z[i] = (threshold - bi - other) / (2 * ci); status[key] = 'knee';
    });
    // The pool caps K (the model uses min(K, pool)), so a K knee above the pool knee can only be reached by
    // raising the pool to K. Lowering K to the pool instead (the old rule) threw away the K knee whenever
    // the pool's own gain was small, pinning the recipe at the search floor (WORKER_NOTES.md, 2026-09-28).
    const zk = z[2] + center[2] - center[1];
    if (zk > z[1]) { z[1] = zk; status.pool = `raised to K (${status.pool})`; }
    if (z.every((v, i) => Math.abs(v - prev[i]) < 1e-9)) break;
  }
  const val = (i) => Math.round(2 ** (z[i] + center[i]));
  let pool = val(1), k = val(2);
  if (k > pool) pool = k;
  const pop = Math.max(val(0), minPop(pool, k));
  return { sizes: { pop, pool, k }, status };
}

/**
 * Search bounds: every setting the batch may place a cell at, and the range the knee estimate may pick from.
 * Floors raised 2026-09-28 at the user's request (pop 8 -> 50, pool 5 -> 25, K 2 -> 25): the batch had put
 * 391 of 688 cells at pop 12 / K 3, where fitness from a handful of opponents is too noisy for selection
 * to work, and none at pop >= 50 with K >= 100, where the answer lies.
 */
export const BOUNDS = { pop: [50, 1600], pool: [25, 1000], k: [25, 1000] };

/** Candidate settings for new cells: half-doubling (x sqrt 2) grid within BOUNDS, K <= pool, pop >= min. */
export function candidateGrid() {
  const vals = (lo, hi) => { const out = []; for (let e = Math.log2(lo); e <= Math.log2(hi) + 1e-9; e += 0.5) out.push(Math.round(2 ** e)); return [...new Set(out)]; };
  const out = [];
  for (const pop of vals(BOUNDS.pop[0], 1600)) for (const pool of vals(BOUNDS.pool[0], 800)) for (const k of vals(BOUNDS.k[0], 800)) {
    if (k > pool) continue;
    if (pop < minPop(pool, k)) continue;
    out.push({ pop, pool, k });
  }
  return out;
}

/**
 * Fit a cost model: log2(genBattles) quadratic in log sizes, from full-cost cells. Seconds from battles via
 * a two-parameter linear fit (fixed per-process overhead + measured seconds-per-battle) over cells with a
 * clean wall time, not a single overhead-free ratio: at small battle counts (this round's search-floor
 * cells: ~230-460 battles) a fresh `node scripts/evolve.mjs` process's own startup/module-load/pvpoke-VM-boot
 * cost (measured ~17 s, independent of battle count) dominates and a pure per-battle rate underprices these
 * cells by 3x+ -- which is what drove round 10's chooseNext to spend its whole batch re-sampling the
 * cheapest grid point instead of the settings that still decide the knee tests (see WORKER_NOTES.md).
 */
export function fitCost(cells) {
  const full = cells.filter((c) => !c.cheap);
  // Battles model on standalone counts (what a setting costs without the shared cache); the seconds fit
  // below regresses wall time on the battles actually simulated, so both halves stay honest.
  const fb = ols(full.map((c) => features(c.sizes)), full.map((c) => Math.log2(c.genBattlesStandalone ?? c.genBattles)));
  const timed = full.filter((c) => c.costSeconds != null && !c.inflated);
  const n = timed.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const c of timed) { sx += c.genBattles; sy += c.costSeconds; sxx += c.genBattles * c.genBattles; sxy += c.genBattles * c.costSeconds; }
  const secPerBattle = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const overheadSeconds = Math.max(0, (sy - secPerBattle * sx) / n);
  return {
    secPerBattle, overheadSeconds,
    battles: (sizes, generations = FULL_GENERATIONS) => 2 ** dot(features(sizes), fb.beta) * (generations / FULL_GENERATIONS),
    // Overhead is a fixed per-process cost (Node startup, pvpoke VM boot), paid once per cell regardless of
    // how few battles it runs -- it does not scale down with `generations` the way battle time does.
    seconds(sizes, generations = FULL_GENERATIONS) { return overheadSeconds + this.battles(sizes, generations) * secPerBattle; },
  };
}

/** Longest a picked cell may take, unless the current recipe itself costs more (it must be run to confirm anyway). */
export const MAX_CELL_SECONDS = 3 * 3600;

/**
 * The part of BOUNDS the data can speak for: each size may go at most one doubling past the largest value
 * measured by a full-cost cell inside the search floors (pop >= BOUNDS.pop[0], pool >= BOUNDS.pool[0],
 * min(K, pool) >= BOUNDS.k[0]). Cells below the floors don't count -- pop 1536 was measured only at K 3,
 * which says nothing about pop 1536 at K 100 (the model has a pop x K term). Added 2026-09-28 at the
 * user's request, after the fit put the recipe at the top of every bound (1600/1000/1000) with no cell
 * anywhere near it.
 * @returns {{pop:[number,number], pool:[number,number], k:[number,number]}}
 */
export function trustBounds(cells, bounds = BOUNDS) {
  const inside = cells.filter((c) => !c.cheap && c.sizes.pop >= bounds.pop[0] && c.sizes.pool >= bounds.pool[0] && Math.min(c.sizes.k, c.sizes.pool) >= bounds.k[0]);
  const out = {};
  for (const key of SIZE_KEYS) {
    const vals = inside.map((c) => (key === 'k' ? Math.min(c.sizes.k, c.sizes.pool) : c.sizes[key]));
    const top = vals.length ? Math.max(...vals) : bounds[key][0];
    out[key] = [bounds[key][0], Math.max(bounds[key][0], Math.min(bounds[key][1], 2 * top))];
  }
  return out;
}

/**
 * Choose the next setting: the candidate (inside `bounds`, costing at most `maxSeconds`) whose one extra
 * cell most shrinks the variance of the knee tests still undecided at the current knee estimate (rank-one
 * update of the OLS covariance, so no refit is needed to score a candidate). Ties go to the cheaper cell.
 *
 * Information is NOT divided by cost (the rule until 2026-09-28): cell cost spans ~1,200x across the grid
 * while information spans ~30x, so that ratio always chose the cheapest corner, whose "information" was
 * the global fit extrapolating five doublings. The cost cap plus trustBounds replace it.
 *
 * Cost is back in the score, but as information bought with a fixed budget of run time (budgetSeconds):
 * a candidate costing s seconds is scored as m = budget/s repeats of itself, and repeats of one setting
 * have diminishing returns (the rank-one gain with the row weighted by m: m(v.Ax)^2 / (1 + m x.Ax)). A
 * cheap cell repeated many times saturates at what that setting can tell, so it cannot win on price
 * alone; a cell longer than the budget counts as a fraction m < 1 of itself. Added 2026-09-29 at the
 * user's request: without it the picker spent the night on 2-3 hour pop-1600 cells ("1600 runs are far
 * too long; by intuition it is giving us less information than running other cells that go faster").
 * @returns {{sizes:object, score:number, seconds:number, gain:number}|null}
 */
export const BUDGET_SECONDS = 3600;
export function chooseNext(fit, tests, recipe, cost, { bounds = BOUNDS, maxSeconds = Infinity, grid = candidateGrid(), threshold = ONE_PT, budgetSeconds = BUDGET_SECONDS } = {}) {
  const vecs = [];
  for (const key of SIZE_KEYS) {
    const t = tests[key];
    if (t.up && !(t.up.hi < threshold)) vecs.push(diffVec(recipe, t.upTo));
    if (t.down && !(t.down.lo > threshold)) vecs.push(diffVec(t.halfFrom, recipe));
  }
  if (vecs.length === 0) return null;
  const A = fit.XtXinv;
  const base = vecs.map((v) => dot(v, matVec(A, v)));
  let best = null;
  for (const sizes of grid) {
    if (SIZE_KEYS.some((key) => sizes[key] > bounds[key][1])) continue;
    const seconds = cost.seconds(sizes);
    if (seconds > maxSeconds) continue;
    const x = features(sizes);
    const Ax = matVec(A, x);
    const denom = 1 + dot(x, Ax);
    const m = budgetSeconds / seconds;
    const denomM = 1 + m * dot(x, Ax);
    let gain = 0, score = 0;
    vecs.forEach((v, j) => { const va = dot(v, Ax) ** 2; gain += (va / denom) / base[j]; score += (m * va / denomM) / base[j]; });
    if (!best || score > best.score * (1 + 1e-9) || (score > best.score * (1 - 1e-9) && seconds < best.seconds)) best = { sizes, score, seconds, gain };
  }
  return best;
}
