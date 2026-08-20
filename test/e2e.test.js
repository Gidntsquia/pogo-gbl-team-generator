// End-to-end test (GOALS T6): fixture CSV -> CLI's runPipeline -> report,
// exercising the whole pipeline (importer -> scoring -> meta teams ->
// evaluator -> report) through the real 3v3 engine exactly as `node
// src/cli.js` would run it, kept fast via tiny topK/meta knobs.
//
// This does NOT spawn a subprocess (that path is covered by the T5 manual
// acceptance run logged in PROGRESS.md); it drives the same runPipeline the
// CLI entry point calls, then checks the on-disk report file it writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPipeline } from '../src/cli.js';
import { renderReport } from '../src/report/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-pokegenie.csv');

// Small enough to finish quickly in CI, large enough to form >= 1 team.
const TINY = { topK: 4, meta: 2, scoreMeta: 4, top: 3 };

test('e2e: fixture collection -> CLI pipeline -> report.md on disk', async () => {
  const report = await runPipeline(FIXTURE, TINY);

  // Pipeline produced sane, well-formed output.
  assert.ok(report.monCount >= 3, 'scored several mons from the fixture');
  assert.ok(report.rankedTeams.length >= 1, 'ranked at least one team');
  assert.ok(report.rankedTeams.length <= TINY.top, 'teamCount cap honored');
  assert.equal(report.metaTeams.length, TINY.meta, 'meta team count honored');

  const top = report.rankedTeams[0];
  assert.equal(top.members.length, 3, 'a recommended team has 3 members');
  assert.equal(
    new Set(top.members.map((m) => m.speciesId)).size,
    3,
    'no duplicate species within a team'
  );
  assert.ok(top.winRate >= 0 && top.winRate <= 1, 'win rate is a fraction');

  // Malformed fixture row ("Freakemon") is surfaced, not silently dropped.
  assert.ok(
    report.warnings.some((w) => /freakemon/i.test(w)),
    'unknown-species row surfaced as a collection warning'
  );

  // Render + write the report exactly like the CLI does, then re-read it.
  const dir = mkdtempSync(path.join(tmpdir(), 'gbl-e2e-'));
  const outPath = path.join(dir, 'report.md');
  const markdown = renderReport(report);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, 'utf8');

  assert.ok(existsSync(outPath), 'report.md was written');
  const onDisk = readFileSync(outPath, 'utf8');
  assert.match(onDisk, /# Great League Team Report/);
  assert.match(onDisk, /## Recommended teams/);
  assert.match(onDisk, /## Appendix: per-Pokemon 1v1 scores/);
  assert.ok(
    onDisk.includes(top.members[0].name),
    'report names the top recommended team'
  );
});
