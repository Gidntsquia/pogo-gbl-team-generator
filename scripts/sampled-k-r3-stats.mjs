// Arms, statistics and the stop rule for the opponent-sweep rerun (plans/PLAN.md round 3).
// Same rule as round 2 (sampled-k-stats.mjs), applied to one question: does quality rise from 50 to 500
// opponents (K=50, 200 candidates)? Only o50 and o500 run; results live in out/sampled-k-ab-r3/results.json,
// round 2's cells in out/sampled-k-ab/results.json stay untouched.
import { verdictAt, mean, sd, t95, pairedRows, sweepDecision, MIN_SEEDS, BAND, SWEEPS } from './sampled-k-stats.mjs';

export { verdictAt, mean, sd, t95, pairedRows, sweepDecision, MIN_SEEDS, BAND };
export const CAP_SEEDS = 20;
export const BUDGET_SECONDS = 8 * 3600;
export const SMALL = 'o50';
export const LARGE = 'o500';
export const SWEEP = SWEEPS[0];
export const R3_DIR = 'out/sampled-k-ab-r3';
export const R2_DIR = 'out/sampled-k-ab';

/** Seeds finished for both arms. */
export const finishedSeeds = (cells, seeds) => pairedRows(cells, seeds, SMALL, LARGE).length;

/** 'yes' | 'no' | 'undecided' at n finished seeds (n < 2 is undecided). */
export function decisionAt(cells, seeds, n) {
  return n >= 2 ? sweepDecision(verdictAt(pairedRows(cells, seeds, SMALL, LARGE), n)) : 'undecided';
}

export const STOP_RULE = `Stop rule (unchanged from round 2). Question: is held-out quality higher with 500 opponents than with 50 (K=50, 200 candidates, Sequential Halving R=3, --population-final-ratio 1)? Quality is the mean held-out win rate of each run's top 5 finalists. Seeds run one at a time (s1, s2, ...), both arms on the same seeds. From seed ${MIN_SEEDS} on, after every seed, take the paired 95% range (Student t) of 500-opponent quality minus 50-opponent quality: YES if the whole range is above 0; NO if it is below 0 or inside +-${BAND * 100} point; otherwise undecided (keep adding seeds). Caps: ${CAP_SEEDS} seeds, or ${BUDGET_SECONDS / 3600} hours of summed wall time for new cells, whichever comes first; at a cap with the rule unfired the answer is CAN'T TELL. Every seed is rerun with the determinism fix (round-2 cells are kept, not reused).`;
