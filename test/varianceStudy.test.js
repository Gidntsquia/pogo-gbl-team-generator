// @slow -- replays whole battle sets to reproduce an ordering flip; ~30s on its own.
//
// Tests for scripts/variance-study.mjs (ROADMAP "TrainingAI variance study").
// Keeps the battle count tiny (2 candidates x 2 opponents x 9 pairings x a
// few orderings) so this stays fast while still exercising the real pvpoke
// engine -- the actual "how much does order matter" numbers at a realistic
// scale are recorded in PROGRESS.md from a larger, one-off run, not asserted
// here (a real engine-order-sensitivity flip is rare and not something a
// fast, tiny test should depend on seeing).
//
// Run with: node --test test/varianceStudy.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runVarianceStudy } from '../scripts/variance-study.mjs';
import { initEngine } from '../src/engine/harness.js';

test('runVarianceStudy produces a well-formed report for a tiny candidate/opponent count', async () => {
  const ctx = await initEngine();
  const report = await runVarianceStudy(ctx, { candidates: 2, opponents: 2, shuffles: 1, seed: 'test-seed' });

  assert.equal(report.candidateCount, 2);
  assert.equal(report.opponentCount, 2);
  assert.equal(report.totalBattlesPerOrdering, 2 * 2 * 9);
  assert.equal(report.orderingCount, 3); // canonical + reversed + 1 shuffle
  assert.equal(report.orderings.length, 3);
  assert.equal(report.orderings[0].name, 'canonical');
  assert.equal(report.orderings[0].flips, 0, 'baseline compared to itself never flips');

  for (const o of report.orderings) {
    assert.equal(o.winRates.length, 2, 'one win rate per candidate');
    for (const rate of o.winRates) assert.ok(rate >= 0 && rate <= 1, 'win rate in [0,1]');
    assert.ok(o.flips >= 0 && o.flips <= report.totalBattlesPerOrdering, 'flip count bounded');
  }

  const s = report.summary;
  assert.ok(s.totalFlipsAcrossNonBaselineOrderings >= 0);
  assert.ok(s.meanFlipRate >= 0 && s.meanFlipRate <= 1);
  assert.ok(s.maxWinRateDelta >= 0 && s.maxWinRateDelta <= 1);
  assert.equal(typeof s.anyRankingChanged, 'boolean');
});

test('runVarianceStudy is deterministic: same seed/params reproduce the identical report', async () => {
  const ctx = await initEngine();
  const a = await runVarianceStudy(ctx, { candidates: 2, opponents: 2, shuffles: 2, seed: 'determinism-seed' });
  const b = await runVarianceStudy(ctx, { candidates: 2, opponents: 2, shuffles: 2, seed: 'determinism-seed' });
  assert.deepEqual(b, a, 'same seed/params -> identical study results (orderings are seeded, not wall-clock random)');
});

test('throws a clear error when candidates + opponents exceeds the curated pool size', async () => {
  const ctx = await initEngine();
  await assert.rejects(
    () => runVarianceStudy(ctx, { candidates: 10_000, opponents: 10_000 }),
    /curated meta pool only has/
  );
});
