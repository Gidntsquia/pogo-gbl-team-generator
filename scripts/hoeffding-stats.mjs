// Paired-difference statistics and the FIXED stop rule for the Hoeffding Races A/B.
// Written before the extra seeds were run; the rule is not tuned afterwards.
//
// Hoeffding Races is a SPEED idea (same as Sequential Halving, research idea #1), not a
// quality idea -- it exists to skip battles, and any quality change is a side effect of
// which teams get cut early. The rule below is the halving precedent
// (scripts/compare-search-report.mjs's compareArm, RUNBOOK's "R=3 quality matched the
// full grid" bar) restated as a fixed batch rule instead of a single 10-seed check:
//
// Stop rule, checked after every batch of BATCH seeds (10, 20, ... up to CAP_SEEDS):
//   keep      hoeffding is >=20% cheaper in battles AND the 95% range of (idea - control)
//             quality does not rule out more than a 3-point loss (lower bound >= -3pt),
//             OR quality is better beyond the seed-to-seed spread regardless of cost
//   drop      quality is worse beyond the seed-to-seed spread, or there is no clear
//             battle saving (<20% fewer battles) and no quality gain
//   no meaningful difference (counts as drop)
//             the whole quality range lies inside -1 .. +1 point AND battles are not
//             meaningfully fewer (<5% saved) -- i.e. neither the speed nor the quality
//             half of the idea shows up at all
//   otherwise add another batch; at the cap (or when the budget is spent) the answer
//   is a plain keep/drop reading, never left unclear.
export const BATCH = 10;
export const CAP_SEEDS = 100;
export const BAND = 0.01; // 1 point of win rate, quality "no meaningful difference" band
export const QUALITY_LOSS_BOUND = -0.03; // -3 points, the halving R=3 precedent
export const CHEAPER_RATIO = 0.8; // >=20% fewer battles
export const BUDGET_SECONDS = 8 * 3600;

// Two-sided 95% Student t critical values, df 1..30; normal-based expansion beyond.
const T = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
export function t95(df) {
  if (df < 1) return Infinity;
  if (df <= 30) return T[df - 1];
  const z = 1.96;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df);
}

export const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
export const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

/** Paired rows for a (control arm, idea arm) pair, in the given seed order; only seeds where both exist. */
export function pairedRows(cells, seeds, ctlArm, ideaArm) {
  const get = (a, s) => cells.find((c) => c.arm === a && c.seed === s);
  return seeds.map((s) => ({ seed: s, c: get(ctlArm, s), i: get(ideaArm, s) })).filter((r) => r.c && r.i && r.c.heldoutMeanTop != null && r.i.heldoutMeanTop != null);
}

/**
 * Verdict from the first n rows: both the quality difference (idea minus control) and the
 * battle-count ratio (idea / control).
 * @returns {{n:number, mean:number, se:number, lower:number, upper:number, wins:number, battleRatio:number, timeRatio:number, verdict:string, why:string}}
 */
export function verdictAt(rows, n = rows.length) {
  const r = rows.slice(0, n);
  const dQ = r.map((x) => x.i.heldoutMeanTop - x.c.heldoutMeanTop);
  const m = mean(dQ);
  const se = sd(dQ) / Math.sqrt(r.length);
  const h = t95(r.length - 1) * se;
  const lower = m - h, upper = m + h;
  const battleRatio = mean(r.map((x) => x.i.genBattles / x.c.genBattles));
  const timeRatio = mean(r.map((x) => x.i.genSeconds / x.c.genSeconds));
  const cheaper = battleRatio <= CHEAPER_RATIO;
  let verdict, why;
  if (lower > 0) {
    verdict = 'keep'; why = 'Hoeffding Races finds better teams, by more than the seed-to-seed spread, regardless of cost';
  } else if (cheaper && lower >= QUALITY_LOSS_BOUND) {
    verdict = 'keep'; why = `${((1 - battleRatio) * 100).toFixed(0)}% fewer battles, team quality not worse than 3 points (the Sequential Halving R=3 bar)`;
  } else if (upper < 0) {
    verdict = 'drop'; why = 'Hoeffding Races finds worse teams, by more than the seed-to-seed spread';
  } else if (!cheaper && m <= 0.005) {
    verdict = 'drop'; why = 'no clear battle saving (<20% fewer) and no quality gain';
  } else if (lower >= -BAND && upper <= BAND && battleRatio > 0.95) {
    verdict = 'no meaningful difference'; why = 'quality difference is inside +-1 point AND battles are not meaningfully fewer (<5% saved) -- neither half of the idea shows up';
  } else {
    verdict = 'unclear'; why = 'the difference is still inside the seed-to-seed spread, or the battle saving is real but the quality bound is not yet inside the keep threshold';
  }
  return { n: r.length, mean: m, se, lower, upper, wins: dQ.filter((d) => d > 0).length, battleRatio, timeRatio, sd: sd(dQ), verdict, why };
}

/** Batch checkpoints available for `n` finished seeds: 10, 20, ... plus n itself when it is the last one. */
export function checkpoints(n) {
  const pts = [];
  for (let k = BATCH; k <= n; k += BATCH) pts.push(k);
  return pts;
}

/**
 * Plain keep-or-drop reading of a range that never resolved statistically, applied only at the
 * 100-seed cap so the report never ends on "unclear". Not a statistically clean call -- the note
 * text says so -- but a definite one: the halving keep bar (cheaper AND lower bound >= -3pt)
 * decides; otherwise DROP.
 */
export function capReading(v) {
  if (v.battleRatio <= CHEAPER_RATIO && v.lower >= QUALITY_LOSS_BOUND) return 'keep';
  return 'drop';
}

/** Fixed rule applied to finished seeds. Returns {stop, at, result}: stop=true when a decisive verdict or the cap was reached. */
export function stopStatus(rows) {
  for (const k of checkpoints(rows.length)) {
    const v = verdictAt(rows, k);
    if (v.verdict !== 'unclear') return { stop: true, at: k, result: v };
  }
  if (rows.length >= CAP_SEEDS) {
    const v = verdictAt(rows, CAP_SEEDS);
    const reading = capReading(v);
    return { stop: true, at: CAP_SEEDS, result: { ...v, verdict: reading, why: `100-seed cap reached without the stop rule firing; plain reading against the keep bar (>=20% fewer battles and a quality-loss bound within 3 points) is ${reading.toUpperCase()}, not a statistically clean stop-rule fire`, atCap: true } };
  }
  return { stop: false, at: rows.length, result: verdictAt(rows) };
}
