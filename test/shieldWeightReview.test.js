// Tests for scripts/shield-weight-review.mjs (the shield-scenario
// weighting review). Keeps battle counts tiny (small topK/opponents/schemes)
// so this stays fast while still exercising the real pvpoke engine end to
// end -- the actual larger-scale findings come from a
// one-off run, not asserted here.
//
// Run with: node --test test/shieldWeightReview.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runShieldWeightReview } from '../scripts/shield-weight-review.mjs';
import { initEngine } from '../src/engine/harness.js';

const TINY_SCHEMES = [
  { name: 'current', weights: { s00: 0.25, s11: 0.5, s22: 0.25 } },
  { name: 'pure-1v1', weights: { s00: 0, s11: 1, s22: 0 } },
];

test('runShieldWeightReview produces a well-formed report for a tiny run', async () => {
  const ctx = await initEngine();
  const report = await runShieldWeightReview(ctx, {
    topK: 3,
    metaLimit: 3,
    opponents: 2,
    schemes: TINY_SCHEMES,
  });

  assert.equal(report.topK, 3);
  assert.equal(report.metaLimit, 3);
  assert.equal(report.opponentTeamCount, 2);
  assert.ok(report.collectionMonCount > 0);
  assert.equal(report.schemes.length, 2);

  for (const s of report.schemes) {
    assert.ok(s.topKSpecies.length <= 3);
    assert.ok(new Set(s.topKSpecies).size === s.topKSpecies.length, 'topK species are distinct');
    if (s.candidateTeamCount > 0) {
      assert.ok(s.meanWinRate >= 0 && s.meanWinRate <= 1);
      assert.ok(s.bestWinRate >= 0 && s.bestWinRate <= 1);
      assert.ok(s.bestWinRate >= s.meanWinRate - 1e-9, 'best win rate is at least the mean');
      assert.equal(s.bestTeam.length, 3);
    } else {
      assert.equal(s.meanWinRate, null);
      assert.equal(s.bestWinRate, null);
      assert.equal(s.bestTeam, null);
    }
  }
});

test('runShieldWeightReview is deterministic: same params reproduce an identical report', async () => {
  const ctx = await initEngine();
  const opts = { topK: 3, metaLimit: 3, opponents: 2, schemes: TINY_SCHEMES };
  const a = await runShieldWeightReview(ctx, opts);
  const b = await runShieldWeightReview(ctx, opts);
  assert.deepEqual(b, a, 'same inputs -> identical report (no unseeded randomness anywhere in this pipeline)');
});

test('rejects a weighting scheme whose weights do not sum to 1', async () => {
  const ctx = await initEngine();
  await assert.rejects(
    () =>
      runShieldWeightReview(ctx, {
        topK: 3,
        metaLimit: 3,
        opponents: 2,
        schemes: [{ name: 'bad', weights: { s00: 0.5, s11: 0.5, s22: 0.5 } }],
      }),
    /weights must sum to 1/
  );
});

test('throws a clear error when opponents exceeds the curated meta-team pool size', async () => {
  const ctx = await initEngine();
  await assert.rejects(
    () => runShieldWeightReview(ctx, { topK: 3, metaLimit: 3, opponents: 10_000, schemes: TINY_SCHEMES }),
    /curated meta pool only has/
  );
});
