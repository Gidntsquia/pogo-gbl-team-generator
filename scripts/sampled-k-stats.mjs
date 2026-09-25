// Arms, statistics and the FIXED stop rule for the fixed-K sampled-combats A/B (plans/PLAN.md round 2).
// Written before any seed ran; the rule is not tuned afterwards.
//
// Arms (every cell: short-cell settings of compare-search.mjs BASE_FLAGS, Halving R=3):
//   base   control: today's default, 40 candidates / 30 opponents, no sampling
//   k10eq  equal-cost: K=10, 300 opponents, candidates sized so battles/run are within 10% of control
//   o50    opponent sweep, small: K=50, 200 candidates, 50 opponents  (everyone fights everyone)
//   o500   opponent sweep, large / big arm: K=50, 200 candidates, 500 opponents
//   c40    candidate sweep, small: K=50, 40 candidates, 500 opponents
//   c320   candidate sweep, large: K=50, 320 candidates, 500 opponents
//
// Stop rule. Seeds run one at a time, all six arms per seed. From seed MIN_SEEDS on, after every
// seed, take the paired held-out quality difference on the seeds finished and its 95% range (Student t).
//   Per arm vs control: KEEP if the whole range is above 0; DROP if the whole range is below 0 or
//     inside +-1 point (no meaningful difference counts as drop); else undecided.
//   Per sweep (large minus small): YES if the whole range is above 0; NO if the whole range is below 0
//     or inside +-1 point; else undecided.
//   Stop when every arm and both sweeps are decided, at CAP_SEEDS seeds, or when the 10 h compute budget
//   (summed wall time of new cells) cannot fit another seed. At the end an undecided arm gets the plain
//   reading (KEEP only if its mean gain is at least +1 point, else DROP); an undecided sweep is
//   reported CAN'T TELL -- never read as a direction.
import { verdictAt, mean, sd, t95 } from './sampled-stats.mjs';
import { pairedRows } from './hoeffding-stats.mjs';

export { verdictAt, mean, sd, t95, pairedRows };
export const MIN_SEEDS = 3;
export const CAP_SEEDS = 12;
export const BAND = 0.01;
export const CAP_KEEP_GAIN = 0.01;
export const BUDGET_SECONDS = 10 * 3600;
export const COST_TOLERANCE = 0.1;
export const CONTROL = 'base';
export const IDEA_ARMS = ['k10eq', 'o50', 'o500', 'c40', 'c320'];
export const SWEEPS = [
  { key: 'opponents', title: 'More opponents', small: 'o50', large: 'o500', smallSize: 50, largeSize: 500, unit: 'opponents (200 candidates)' },
  { key: 'candidates', title: 'More candidates', small: 'c40', large: 'c320', smallSize: 40, largeSize: 320, unit: 'candidates (500 opponents)' },
];

/** Decision from a paired-difference verdict: 'yes' | 'no' | 'undecided' (sweep wording). */
export function sweepDecision(v, band = BAND) {
  if (v.lower > 0) return 'yes';
  if (v.upper < 0 || (v.lower >= -band && v.upper <= band)) return 'no';
  return 'undecided';
}
const armDecision = (v) => (v.verdict === 'unclear' ? null : v.verdict === 'keep' ? 'keep' : 'drop');

const armRows = (cells, seeds, a) => pairedRows(cells, seeds, CONTROL, a);
const sweepRows = (cells, seeds, s) => pairedRows(cells, seeds, s.small, s.large);

/** Seeds finished for all six arms. */
export function finishedSeeds(cells, seeds) {
  return Math.min(...IDEA_ARMS.map((a) => armRows(cells, seeds, a).length));
}

/** Rule applied at n finished seeds: per-arm and per-sweep decisions (null = undecided). */
export function decisionsAt(cells, seeds, n) {
  const arms = {}, sweeps = {};
  for (const a of IDEA_ARMS) { const r = armRows(cells, seeds, a); arms[a] = n >= 2 ? armDecision(verdictAt(r, n)) : null; }
  for (const s of SWEEPS) { const r = sweepRows(cells, seeds, s); const d = n >= 2 ? sweepDecision(verdictAt(r, n)) : 'undecided'; sweeps[s.key] = d === 'undecided' ? null : d; }
  return { arms, sweeps };
}

export function allDecided(cells, seeds) {
  const n = finishedSeeds(cells, seeds);
  if (n < MIN_SEEDS) return false;
  const d = decisionsAt(cells, seeds, n);
  return Object.values(d.arms).every(Boolean) && Object.values(d.sweeps).every(Boolean);
}

/** Final arm answer once the run ended: rule verdict if decided, else the plain reading. Never unclear. */
export function finalArm(rows, n, ended) {
  const v = verdictAt(rows, n);
  const d = n >= MIN_SEEDS ? armDecision(v) : null;
  if (d) return { label: d, result: v, ruleFired: true };
  const label = v.mean >= CAP_KEEP_GAIN ? 'keep' : 'drop';
  const why = `${ended === 'cap' ? `${CAP_SEEDS}-seed cap reached` : `the compute budget ended the run at ${n} seed(s)`} without the rule firing; plain reading (KEEP only if the mean gain is at least +${CAP_KEEP_GAIN * 100} point) is ${label.toUpperCase()}`;
  return { label, result: { ...v, verdict: label, why }, ruleFired: false };
}

/** Final sweep answer: yes / no / can't tell. */
export function finalSweep(rows, n) {
  const v = verdictAt(rows, n);
  const d = n >= MIN_SEEDS ? sweepDecision(v) : 'undecided';
  return { answer: d === 'undecided' ? "can't tell" : d, result: v };
}

export const STOP_RULE = `Stop rule (fixed before any seed ran, not tuned afterwards). Control: today's default (40 candidates / 30 opponents, Sequential Halving R=3, no sampling). Five idea arms, all with fixed-K sampled combats and Halving R=3: an equal-cost arm (K=10, 300 opponents, candidates sized so mean battles per run are within ${COST_TOLERANCE * 100}% of the control's), an opponent sweep (K=50, 200 candidates, 50 and 500 opponents) and a candidate sweep (K=50, 500 opponents, 40 and 320 candidates). The sweep arms' cost grows with size and is reported, not matched. Quality is the mean held-out win rate of each run's top 5 finalists. Seeds run one at a time, all six arms per seed. From seed ${MIN_SEEDS} on, after every seed, take the 95% range (Student t) of each paired quality difference: arm minus control for each idea arm, larger minus smaller size for each sweep. Per arm: KEEP if the whole range is above 0; DROP if it is below 0 or inside +-${BAND * 100} point (no meaningful difference counts as drop). Per sweep: YES (quality is higher at the larger size) if the whole range is above 0; NO if it is below 0 or inside +-${BAND * 100} point; otherwise undecided. The run stops when every arm and both sweeps are decided, at ${CAP_SEEDS} seeds, or when the ${BUDGET_SECONDS / 3600}-hour compute budget (summed wall time) cannot fit another seed. An arm still undecided then gets the plain reading: KEEP only if its mean gain is at least +${CAP_KEEP_GAIN * 100} point, else DROP. A sweep still undecided is reported CAN'T TELL; no direction is read into noise.`;
