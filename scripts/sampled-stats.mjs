// Paired-difference statistics and the FIXED stop rule for the sampled-combats A/B.
// Written before any seed ran; the rule is not tuned afterwards.
//
// Sampled combats is a QUALITY-AT-EQUAL-COST idea: each idea arm is sized so its mean battles
// per run is within 10% of the control's, so the only question is whether it finds better
// teams. Control = today's default (Halving R=3, no sampling). Four idea arms (see ARMS in
// compare-search.mjs), each judged separately against the same control on the same seeds.
//
// Stop rule, checked after every batch of BATCH seeds (10, 20, ... up to CAP_SEEDS), per arm:
//   keep   the whole 95% range of (arm - control) held-out quality is above 0
//   drop   the whole range is below 0
//   no meaningful difference (counts as drop)   the whole range lies inside -1 .. +1 point
//   otherwise unclear: add another batch. Seeds run for all five arms together; the run stops
//   when every arm has a verdict, at CAP_SEEDS, or when the compute budget cannot fit another
//   seed. An arm still unclear then gets a plain reading: KEEP only if its mean gain is at
//   least +1 point, else DROP -- never left unclear.
import { mean, sd, t95, pairedRows } from './hoeffding-stats.mjs';

export { mean, sd, t95, pairedRows };
export const BATCH = 10;
export const CAP_SEEDS = 20;
export const BAND = 0.01;
export const CAP_KEEP_GAIN = 0.01;
export const BUDGET_SECONDS = 4 * 3600;
export const COST_TOLERANCE = 0.1; // idea arms' mean battles within 10% of control's
export const CONTROL = 'base';
export const IDEA_ARMS = ['s2h0', 's2h3', 's4h0', 's4h3'];

/** Verdict from the first n rows (rows from pairedRows: {seed, c: control cell, i: idea cell}). */
export function verdictAt(rows, n = rows.length) {
  const r = rows.slice(0, n);
  const dQ = r.map((x) => x.i.heldoutMeanTop - x.c.heldoutMeanTop);
  const m = mean(dQ);
  const se = sd(dQ) / Math.sqrt(r.length);
  const h = t95(r.length - 1) * se;
  const lower = m - h, upper = m + h;
  const battleRatio = mean(r.map((x) => x.i.genBattles)) / mean(r.map((x) => x.c.genBattles));
  const timeRatio = mean(r.map((x) => x.i.genSeconds)) / mean(r.map((x) => x.c.genSeconds));
  let verdict, why;
  if (lower > 0) { verdict = 'keep'; why = 'finds better teams at the same cost, by more than the seed-to-seed spread'; }
  else if (upper < 0) { verdict = 'drop'; why = 'finds worse teams, by more than the seed-to-seed spread'; }
  else if (lower >= -BAND && upper <= BAND) { verdict = 'no meaningful difference'; why = 'the whole quality range is inside +-1 point'; }
  else { verdict = 'unclear'; why = 'the difference is still inside the seed-to-seed spread'; }
  return { n: r.length, mean: m, se, lower, upper, wins: dQ.filter((d) => d > 0).length, battleRatio, timeRatio, sd: sd(dQ), verdict, why };
}

export function checkpoints(n) {
  const pts = [];
  for (let k = BATCH; k <= n; k += BATCH) pts.push(k);
  return pts;
}

export const plainReading = (v) => (v.mean >= CAP_KEEP_GAIN ? 'keep' : 'drop');

/** Rule applied to one arm's finished seeds: {stop, at, result}. Undecided arms report stop:false. */
export function armStatus(rows) {
  for (const k of checkpoints(rows.length)) {
    const v = verdictAt(rows, k);
    if (v.verdict !== 'unclear') return { stop: true, at: k, result: v };
  }
  return { stop: false, at: rows.length, result: rows.length ? verdictAt(rows) : null };
}

/** Final answer for one arm once the run has ended (rule fired, cap, or budget): never unclear. */
export function finalReading(rows, ended) {
  const st = armStatus(rows);
  if (st.stop) return { label: st.result.verdict, at: st.at, result: st.result, ruleFired: true };
  const v = verdictAt(rows);
  const reading = plainReading(v);
  const why = ended === 'cap'
    ? `${CAP_SEEDS}-seed cap reached without the rule firing; plain reading (KEEP only if the mean gain is at least +1 point) is ${reading.toUpperCase()}`
    : `the compute budget ended the run at ${rows.length} seed(s) before the rule fired; plain reading (KEEP only if the mean gain is at least +1 point) is ${reading.toUpperCase()}`;
  return { label: reading, at: rows.length, result: { ...v, verdict: reading, why }, ruleFired: false };
}

/** True when every idea arm has a rule verdict on the seeds finished so far. */
export function allDecided(cells, seeds) {
  return IDEA_ARMS.every((a) => armStatus(pairedRows(cells, seeds, CONTROL, a)).stop);
}
