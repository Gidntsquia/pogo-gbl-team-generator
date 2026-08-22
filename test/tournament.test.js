// Tests for scripts/tournament.mjs (GOALS T13: multi-stage overnight
// tournament runner). Drives the exported `runTournament` in-process (no
// subprocess, no network) with tiny knobs so the real pvpoke 3v3 engine still
// runs but the battle count stays small -- mirrors how test/cli.test.js
// drives src/cli.js's runPipeline.
//
// To keep the whole file well under 2 minutes, only 2.5 "full" tournament
// runs are performed in total: ONE shared fresh run at module scope (reused
// by the well-formed-report and funnel-narrows checks, same pattern
// test/sampleTeams.test.js uses for its module-level `initEngine()` call),
// ONE more fresh run (different --out-dir, same seed) for the determinism
// check, and a resume re-run against the shared run's dir that only redoes
// stage 3 (cheaper than a full run). Tests that read the shared run's
// checkpoints run BEFORE the resume test, which mutates that same directory
// -- node's test runner runs top-level tests in one file sequentially in
// declaration order by default (no concurrency opt-in here), so this
// ordering is safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTournament } from '../scripts/tournament.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-pokegenie.csv');

// Ticket-specified tiny knobs, small enough to finish fast, large enough to
// form >= 1 team at every stage from the fixture's ~13 distinct species.
const TINY = {
  scoreMeta: 4,
  pool: 8,
  deadlineMinutes: 60,
  s1Candidates: 6,
  s1Opponents: 3,
  s2Top: 3,
  s2Opponents: 4,
  s3Top: 2,
  s3Opponents: 5,
  seed: 'tournament-test-seed',
};

function tmpOutDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Order-independent team signature (matches scripts/tournament.mjs's own candidateSig convention). */
function teamSig(team) {
  return team.members.map((m) => m.key).sort().join('|');
}

// Shared fresh run (module scope -- see file header comment for why).
const SHARED_DIR = tmpOutDir('gbl-tourney-shared-');
const SHARED_REPORT = path.join(SHARED_DIR, 'my-teams-tournament.md');
const shared = await runTournament(FIXTURE, { ...TINY, outDir: SHARED_DIR, out: SHARED_REPORT });

test('completes and produces a well-formed report + all checkpoints + DONE marker', () => {
  assert.ok(shared.finalRankings.length >= 1, 'named >= 1 team');
  assert.ok(shared.finalRankings.length <= TINY.s3Top, 's3Top cap honored');

  const top = shared.finalRankings[0];
  assert.equal(top.members.length, 3, 'a team has 3 members');
  assert.equal(new Set(top.members.map((m) => m.speciesId)).size, 3, 'team members are distinct species');
  assert.ok(top.winRate >= 0 && top.winRate <= 1, 'win rate in [0,1]');
  assert.ok(top.bestLead && typeof top.bestLead.name === 'string', 'bestLead present (derived from stage-3 data)');
  assert.ok(Array.isArray(top.hardestOpponents) && top.hardestOpponents.length <= 5, 'up to 5 hardest opponents');
  assert.ok('winRateCurated' in top && 'winRateSampled' in top, 'curated/sampled win% split present');

  // Ranking is sorted best-first by win rate, tiebreak avgHpMargin.
  for (let i = 1; i < shared.finalRankings.length; i++) {
    const a = shared.finalRankings[i - 1];
    const b = shared.finalRankings[i];
    assert.ok(a.winRate > b.winRate || (a.winRate === b.winRate && a.avgHpMargin >= b.avgHpMargin), 'teams sorted best-first');
  }

  assert.ok(existsSync(SHARED_REPORT), 'report.md written');
  const md = readFileSync(SHARED_REPORT, 'utf8');
  assert.match(md, /# Great League Overnight Tournament Report/);
  assert.match(md, /## Stage funnel summary/);
  assert.match(md, /## Top \d+ teams \(stage 3 results\)/);
  assert.match(md, /## Per-team detail/);
  assert.match(md, /vs curated/i);
  assert.match(md, /vs sampled/i);
  assert.match(md, /5 hardest stage-3 opponents/i);
  assert.ok(md.includes(top.members[0].name), 'report names the top team');

  // Malformed fixture row ("Freakemon") surfaced, not silently dropped.
  assert.ok(shared.importWarnings.some((w) => /freakemon/i.test(w)), 'unknown-species row surfaced as a warning');
  assert.match(md, /## Collection warnings/);

  for (const n of [1, 2, 3]) {
    const p = path.join(SHARED_DIR, `tournament-s${n}.json`);
    assert.ok(existsSync(p), `stage ${n} checkpoint written`);
    const cp = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(cp.stage, n);
    assert.ok(Array.isArray(cp.rankings) && cp.rankings.length >= 1, `stage ${n} checkpoint has rankings`);
    assert.ok(cp.timing && cp.timing.battleCount > 0, `stage ${n} checkpoint has timing`);
  }

  assert.ok(existsSync(shared.donePath), 'DONE marker written');
  const done = readFileSync(shared.donePath, 'utf8');
  assert.match(done, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'DONE starts with an ISO timestamp');
  assert.match(done, /Tournament complete/);
});

test('stage funnel narrows: stage 2 candidates come from stage 1 top, stage 3 from stage 2 top', () => {
  const s1 = JSON.parse(readFileSync(path.join(SHARED_DIR, 'tournament-s1.json'), 'utf8'));
  const s2 = JSON.parse(readFileSync(path.join(SHARED_DIR, 'tournament-s2.json'), 'utf8'));
  const s3 = JSON.parse(readFileSync(path.join(SHARED_DIR, 'tournament-s3.json'), 'utf8'));

  const s1TopSigs = new Set(s1.rankings.slice(0, TINY.s2Top).map(teamSig));
  assert.ok(s2.rankings.length >= 1, 'stage 2 produced rankings');
  for (const r of s2.rankings) {
    assert.ok(s1TopSigs.has(teamSig(r)), 'every stage-2 candidate came from stage 1\'s top slice');
  }

  const s2TopSigs = new Set(s2.rankings.slice(0, TINY.s3Top).map(teamSig));
  assert.ok(s3.rankings.length >= 1, 'stage 3 produced rankings');
  for (const r of s3.rankings) {
    assert.ok(s2TopSigs.has(teamSig(r)), 'every stage-3 candidate came from stage 2\'s top slice');
  }
});

test('deterministic: two fresh runs with the same seed produce an identical stage-3 team order', async () => {
  const outDir = tmpOutDir('gbl-tourney-det-');
  const other = await runTournament(FIXTURE, { ...TINY, outDir, out: path.join(outDir, 'r.md') });

  const sigsShared = shared.finalRankings.map(teamSig);
  const sigsOther = other.finalRankings.map(teamSig);
  assert.deepEqual(sigsOther, sigsShared, 'same seed -> identical stage-3 team order');

  const ratesShared = shared.finalRankings.map((t) => t.winRate);
  const ratesOther = other.finalRankings.map((t) => t.winRate);
  assert.deepEqual(ratesOther, ratesShared, 'same seed -> identical win rates (battles are seeded, not wall-clock random)');
});

// GOALS T15c: wires opts.threads/--threads into runFunnelStage, batching each
// candidate's battles (across all its opponents/pairings) into one
// src/engine/parallel.js runBattles() call instead of driving battleTeams()
// serially -- same worker-pool executor GOALS T15b already wired into
// evaluateTeams. Because avgHpMargin is this file's stage-to-stage tiebreak,
// a drifted margin could in principle flip which candidates cross a stage's
// top-N cutoff if two candidates tied exactly on winRate -- to keep this test
// independent of that (a full 3-stage funnel isn't what's being verified;
// per-team battle results are), s2Top/s3Top are set >= the candidate counts
// feeding them so EVERY candidate advances through every stage regardless of
// ranking, and finalist teams are compared by team signature (not position)
// so a tie-break-driven reorder can't fail the assertion either.
//
// HISTORY (superseded, kept for context): T15c originally found win/loss
// outcomes and win rates were NOT always identical between serial and
// threaded execution at this test's scale (a narrow win became a tie in one
// real run), traced to a reused Pokemon instance's resetMoves()/
// bestChargedMove tie-break reading stale state depending on battle order.
// GOALS T20-T20b then found and fixed the distinct order-dependence
// mechanisms behind that -- most recently, stale hasActed/priority/
// baitShields/farmEnergy on bench members, which fullReset()/setRoster()
// never touch and which only the two active leads get freshly written each
// battle (see src/engine/README.md's "Known limitation" section for the full
// history, and PROGRESS.md's T20b entries for the numbers). With all of them
// fixed, serial and threaded execution of the same battles are provably
// bit-identical (verified directly: this exact test's serial vs threaded
// finalRankings now compare equal via assert.equal on both winRate and
// avgHpMargin, not just within tolerance). The tolerance constant below is
// retired.

// GOALS T21 (supersedes T15c's per-candidate batching): opts.threads now
// boots ONE persistent executor for the WHOLE run (see runTournament) and
// each stage submits its entire battle set as a single continueOnError
// run() call (see runFunnelStage) instead of one runBattles() call per
// candidate. This test also checks the threadsUsed bookkeeping (report +
// checkpoints recording the actual thread count per stage, per the ticket's
// explicit requirement).
test('opts.threads (persistent worker-pool executor, batched per stage) produces results bit-identical to the serial path', async () => {
  const THREADS_TINY = {
    scoreMeta: 4,
    pool: 8,
    deadlineMinutes: 60,
    s1Candidates: 4,
    s1Opponents: 3,
    s2Top: 4, // >= s1Candidates: no stage 1->2 narrowing, so no tie-break-dependent cutoff
    s2Opponents: 3,
    s3Top: 4, // >= s2Top: no stage 2->3 narrowing, so no tie-break-dependent cutoff
    s3Opponents: 4,
    seed: 'tournament-threads-test-seed',
  };

  const serialDir = tmpOutDir('gbl-tourney-thr-serial-');
  const serial = await runTournament(FIXTURE, { ...THREADS_TINY, outDir: serialDir, out: path.join(serialDir, 'r.md') });

  const threadedDir = tmpOutDir('gbl-tourney-thr-threaded-');
  const threaded = await runTournament(FIXTURE, {
    ...THREADS_TINY,
    outDir: threadedDir,
    out: path.join(threadedDir, 'r.md'),
    threads: 2,
  });

  const byTeam = (run) => {
    const map = new Map();
    for (const t of run.finalRankings) map.set(teamSig(t), { winRate: t.winRate, avgHpMargin: t.avgHpMargin });
    return map;
  };
  const serialByTeam = byTeam(serial);
  const threadedByTeam = byTeam(threaded);

  assert.deepEqual(
    [...threadedByTeam.keys()].sort(),
    [...serialByTeam.keys()].sort(),
    'same set of finalist teams serial vs threaded (stage narrowing disabled above)'
  );
  for (const [sig, s] of serialByTeam) {
    const t = threadedByTeam.get(sig);
    assert.equal(
      t.winRate,
      s.winRate,
      `win rate for team ${sig} should match exactly (serial=${s.winRate}, threaded=${t.winRate})`
    );
    assert.equal(
      t.avgHpMargin,
      s.avgHpMargin,
      `avgHpMargin for team ${sig} should match exactly (serial=${s.avgHpMargin}, threaded=${t.avgHpMargin})`
    );
  }

  const threadedErrors =
    threaded.stage1.timing.errorCount + threaded.stage2.timing.errorCount + threaded.stage3.timing.errorCount;
  assert.equal(threadedErrors, 0, 'no battle-batch errors on a clean fixture run');

  // GOALS T21: threadsUsed recorded per stage (report + checkpoints) --
  // serial run shows null on every stage, the threaded run shows the actual
  // thread count passed, on every stage (proof the SAME executor config
  // reached all 3 stages, not just stage 1).
  for (const s of [serial.stage1, serial.stage2, serial.stage3]) {
    assert.equal(s.threadsUsed, null, 'serial run: threadsUsed is null');
  }
  for (const s of [threaded.stage1, threaded.stage2, threaded.stage3]) {
    assert.equal(s.threadsUsed, 2, 'threaded run: threadsUsed reflects opts.threads on every stage');
  }

  const threadedReport = readFileSync(threaded.reportPath, 'utf8');
  assert.match(
    threadedReport,
    /- threads: stage1=2 \(worker-pool executor\), stage2=2 \(worker-pool executor\), stage3=2 \(worker-pool executor\)/,
    'report Settings section shows the thread count used per stage'
  );
  const serialReport = readFileSync(serial.reportPath, 'utf8');
  assert.match(
    serialReport,
    /- threads: stage1=serial, stage2=serial, stage3=serial/,
    'report Settings section shows "serial" per stage when threads is unset'
  );
});

test('resume: deleting only the stage-3 checkpoint + DONE re-runs just stage 3 (stages 1-2 skipped)', async () => {
  const s1Path = path.join(SHARED_DIR, 'tournament-s1.json');
  const s2Path = path.join(SHARED_DIR, 'tournament-s2.json');
  const s3Path = path.join(SHARED_DIR, 'tournament-s3.json');

  const mtime1Before = statSync(s1Path).mtimeMs;
  const mtime2Before = statSync(s2Path).mtimeMs;
  const s3Before = JSON.parse(readFileSync(s3Path, 'utf8'));

  rmSync(s3Path);
  rmSync(shared.donePath);

  const logs = [];
  const resumed = await runTournament(FIXTURE, {
    ...TINY,
    outDir: SHARED_DIR,
    out: SHARED_REPORT,
    onLog: (msg) => logs.push(msg),
  });

  assert.equal(statSync(s1Path).mtimeMs, mtime1Before, 'stage 1 checkpoint untouched (skipped, not rewritten)');
  assert.equal(statSync(s2Path).mtimeMs, mtime2Before, 'stage 2 checkpoint untouched (skipped, not rewritten)');
  assert.ok(
    logs.some((l) => /stage 1:.*resuming from checkpoint/i.test(l)),
    'log shows stage 1 was resumed/skipped'
  );
  assert.ok(
    logs.some((l) => /stage 2:.*resuming from checkpoint/i.test(l)),
    'log shows stage 2 was resumed/skipped'
  );
  assert.ok(
    !logs.some((l) => /stage 3:.*resuming from checkpoint/i.test(l)),
    'stage 3 was actually re-run, not resumed'
  );

  assert.ok(existsSync(s3Path), 'stage 3 checkpoint rewritten');
  assert.ok(existsSync(resumed.donePath), 'DONE marker rewritten');

  // Same seed + same config -> stage 3 recomputes to the same result.
  assert.deepEqual(
    resumed.finalRankings.map(teamSig),
    s3Before.rankings.map(teamSig),
    'resumed stage 3 reproduces the same finalist order as the original run'
  );
});
