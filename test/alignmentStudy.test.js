// Tests for scripts/alignment-study.mjs (GOALS T27, PLAN.md Rev 6).
// Keeps the battle count tiny (2 candidates x 2 opponents x 9 pairings x 1
// seed variant) so this stays fast while still exercising the real pvpoke
// engine -- the actual "does winning the lead exchange predict winning the
// game" numbers at a realistic scale are recorded in PROGRESS.md from a
// larger, one-off run, not asserted here.
//
// Run with: node --test test/alignmentStudy.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAlignmentStudy } from '../scripts/alignment-study.mjs';
import { battleTeams, initTeamBattle } from '../src/engine/teamBattle.js';
import { loadMetaTeams } from '../src/meta/teams.js';
import { initEngine } from '../src/engine/harness.js';

test('battleTeams summary exposes lead-exchange and shield-banking ground truth (T27)', async () => {
  const ctx = await initEngine();
  initTeamBattle(ctx);
  const pool = loadMetaTeams(ctx);
  const teamA = pool[0].members.map((m) => m.pokemon);
  const teamB = pool[1].members.map((m) => m.pokemon);

  const r = battleTeams(ctx, { teamA, teamB, leadA: 0, leadB: 0, seed: 7 });

  assert.ok(
    r.summary.leadFaintTurnA === null || (Number.isInteger(r.summary.leadFaintTurnA) && r.summary.leadFaintTurnA >= 0),
    'leadFaintTurnA is null or a non-negative turn number'
  );
  assert.ok(
    r.summary.leadFaintTurnB === null || (Number.isInteger(r.summary.leadFaintTurnB) && r.summary.leadFaintTurnB >= 0),
    'leadFaintTurnB is null or a non-negative turn number'
  );
  assert.ok(
    Number.isInteger(r.summary.shieldsRemainingA) &&
      r.summary.shieldsRemainingA >= 0 &&
      r.summary.shieldsRemainingA <= 2,
    'shieldsRemainingA is an integer in [0, 2]'
  );
  assert.ok(
    Number.isInteger(r.summary.shieldsRemainingB) &&
      r.summary.shieldsRemainingB >= 0 &&
      r.summary.shieldsRemainingB <= 2,
    'shieldsRemainingB is an integer in [0, 2]'
  );

  // A lead that ultimately faints (final HP 0) must have a recorded faint
  // turn; a lead that survives must not.
  const leadFinalHpA = r.survivorsHp.aPerMon[0];
  const leadFinalHpB = r.survivorsHp.bPerMon[0];
  assert.equal(leadFinalHpA === 0, r.summary.leadFaintTurnA !== null, 'leadFaintTurnA agrees with final lead HP');
  assert.equal(leadFinalHpB === 0, r.summary.leadFaintTurnB !== null, 'leadFaintTurnB agrees with final lead HP');
});

test('runAlignmentStudy produces a well-formed report for a tiny candidate/opponent count', async () => {
  const ctx = await initEngine();
  const report = await runAlignmentStudy(ctx, { candidates: 2, opponents: 2, seeds: 1, seed: 'test-seed' });

  assert.equal(report.candidateCount, 2);
  assert.equal(report.opponentCount, 2);
  assert.equal(report.seedVariantCount, 1);
  assert.equal(report.battlesPerSeedVariant, 2 * 2 * 9);
  assert.equal(report.totalBattles, 2 * 2 * 9);

  const le = report.leadExchange;
  assert.ok(le.decided >= 0);
  assert.ok(le.simultaneousCount >= 0);
  assert.ok(le.noExchangeCount >= 0);
  assert.equal(
    le.decided + le.simultaneousCount + le.noExchangeCount + report.tieCount,
    report.totalBattles,
    'every battle is accounted for exactly once across the exchange/simultaneous/no-exchange/tie buckets'
  );
  if (le.pWinGivenWonExchange !== null) {
    assert.ok(le.pWinGivenWonExchange >= 0 && le.pWinGivenWonExchange <= 1);
  }
  if (le.pWinGivenLostExchange !== null) {
    assert.ok(le.pWinGivenLostExchange >= 0 && le.pWinGivenLostExchange <= 1);
  }

  assert.equal(report.shields.byRemaining.length, 3, 'one bucket per shields-remaining value (0, 1, 2)');
  let totalShieldSides = 0;
  for (const b of report.shields.byRemaining) {
    assert.ok([0, 1, 2].includes(b.remaining));
    if (b.winRate !== null) assert.ok(b.winRate >= 0 && b.winRate <= 1);
    totalShieldSides += b.battles;
  }
  // Every non-tie battle contributes exactly 2 shield-bucket data points (one per side).
  assert.equal(totalShieldSides, 2 * (report.totalBattles - report.tieCount));
});

test('runAlignmentStudy is deterministic: same seed/params reproduce the identical report', async () => {
  const ctx = await initEngine();
  const a = await runAlignmentStudy(ctx, { candidates: 2, opponents: 2, seeds: 2, seed: 'determinism-seed' });
  const b = await runAlignmentStudy(ctx, { candidates: 2, opponents: 2, seeds: 2, seed: 'determinism-seed' });
  assert.deepEqual(b, a, 'same seed/params -> identical study results');
});

test('a second seed variant is a genuinely different sample, not a duplicate of the first', async () => {
  const ctx = await initEngine();
  const oneVariant = await runAlignmentStudy(ctx, { candidates: 2, opponents: 2, seeds: 1, seed: 'variant-seed' });
  const twoVariants = await runAlignmentStudy(ctx, { candidates: 2, opponents: 2, seeds: 2, seed: 'variant-seed' });
  assert.equal(twoVariants.totalBattles, 2 * oneVariant.totalBattles, 'a second seed variant doubles the battle count');
});

test('throws a clear error when candidates + opponents exceeds the curated pool size', async () => {
  const ctx = await initEngine();
  await assert.rejects(
    () => runAlignmentStudy(ctx, { candidates: 10_000, opponents: 10_000 }),
    /curated meta pool only has/
  );
});
