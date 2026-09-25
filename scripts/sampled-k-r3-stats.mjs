// Arms, statistics and the stop rule for the opponent-sweep rerun (plans/PLAN.md round 3).
// Same rule as round 2 (sampled-k-stats.mjs), applied to one question: does quality rise from 50 to 500
// opponents (K=50, 200 candidates)? Only o50 and o500 run; results live in out/sampled-k-ab-r3/results.json,
// round 2's cells in out/sampled-k-ab/results.json stay untouched.
import { verdictAt, mean, sd, t95, pairedRows, sweepDecision, MIN_SEEDS, BAND, SWEEPS } from './sampled-k-stats.mjs';

export { verdictAt, mean, sd, t95, pairedRows, sweepDecision, MIN_SEEDS, BAND };
// Round 4: the opponent sweep alone uses a +-2 point band; round 2's arm verdicts keep +-1 (BAND).
export const SWEEP_BAND = 0.02;
export const CAP_SEEDS = 24;
export const BUDGET_SECONDS = 12 * 3600;
// Seeds s1..s8 are round 3's cells; their wall time does not count against the round-4 budget.
export const R3_SEEDS = 8;
export const seedNum = (s) => Number(String(s).slice(1));
/** Summed wall time of round-4 cells (seed > R3_SEEDS). */
export const newSpent = (cells) => cells.filter((c) => seedNum(c.seed) > R3_SEEDS).reduce((t, c) => t + (c.wallSeconds ?? 0), 0);
export const SMALL = 'o50';
export const LARGE = 'o500';
export const SWEEP = SWEEPS[0];
export const R3_DIR = 'out/sampled-k-ab-r3';
export const R2_DIR = 'out/sampled-k-ab';

/** Seeds finished for both arms. */
export const finishedSeeds = (cells, seeds) => pairedRows(cells, seeds, SMALL, LARGE).length;

/** 'yes' | 'no' | 'undecided' at n finished seeds (n < 2 is undecided). */
export function decisionAt(cells, seeds, n) {
  return n >= 2 ? sweepDecision(verdictAt(pairedRows(cells, seeds, SMALL, LARGE), n), SWEEP_BAND) : 'undecided';
}

export const STOP_RULE = `Stop rule (round 4: same as rounds 2-3 except the band is widened to +-${SWEEP_BAND * 100} points, for this sweep only; round 2's arm verdicts keep +-${BAND * 100}). Question: is held-out quality higher with 500 opponents than with 50 (K=50, 200 candidates, Sequential Halving R=3, --population-final-ratio 1)? Quality is the mean held-out win rate of each run's top 5 finalists. Seeds run one at a time (s1-s${R3_SEEDS} are round 3's cells, kept; s${R3_SEEDS + 1} onward are new), both arms on the same seeds. After every seed, take the paired 95% range (Student t) of 500-opponent quality minus 50-opponent quality: YES if the whole range is above 0; NO if it is below 0 or inside +-${SWEEP_BAND * 100} points; otherwise undecided (keep adding seeds). Caps: ${CAP_SEEDS} seeds in total, or ${BUDGET_SECONDS / 3600} hours of summed wall time for the new (round-4) cells, whichever comes first; a seed already running at the limit may finish; at a cap with the rule unfired the answer is CAN'T TELL.`;
