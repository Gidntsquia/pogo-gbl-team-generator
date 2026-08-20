// CLI + report pipeline tests (GOALS T5).
//
// Drives runPipeline (the CLI's exported pipeline) with tiny knobs so the real
// 3v3 engine still runs but the battle count stays small, plus pure-formatting
// checks on the report renderer. The full-size default CLI run is exercised by
// hand in the T5 verify step, not here (too slow for the suite).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPipeline } from '../src/cli.js';
import { renderReport, renderSummary } from '../src/report/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-pokegenie.csv');

// Small enough to run fast, large enough to form >= 1 candidate team.
const TINY = { topK: 4, meta: 2, scoreMeta: 4, top: 3 };

test('runPipeline produces ranked teams and a well-formed report', async () => {
  const report = await runPipeline(FIXTURE, TINY);

  assert.ok(report.rankedTeams.length >= 1, 'expected at least one ranked team');
  assert.ok(report.rankedTeams.length <= TINY.top, 'teamCount cap honored');
  assert.equal(report.metaTeams.length, TINY.meta, 'meta limit honored');
  assert.ok(report.monCount >= 3, 'expected several scored mons from the fixture');

  const top = report.rankedTeams[0];
  assert.equal(top.members.length, 3, 'a team has 3 members');
  const species = new Set(top.members.map((m) => m.speciesId));
  assert.equal(species.size, 3, 'team members are all distinct species');
  assert.ok(top.winRate >= 0 && top.winRate <= 1, 'win rate in [0,1]');
  assert.equal(top.perMeta.length, TINY.meta, 'perMeta has one row per meta team');
  assert.ok(top.bestLead && typeof top.bestLead.name === 'string', 'bestLead present');

  // Ranking is by descending win rate (tiebreak avgHpMargin).
  for (let i = 1; i < report.rankedTeams.length; i++) {
    const a = report.rankedTeams[i - 1];
    const b = report.rankedTeams[i];
    assert.ok(
      a.winRate > b.winRate || (a.winRate === b.winRate && a.avgHpMargin >= b.avgHpMargin),
      'teams sorted best-first'
    );
  }
});

test('renderReport writes a Markdown report that names >= 1 team', async () => {
  const report = await runPipeline(FIXTURE, TINY);
  const md = renderReport(report);

  assert.match(md, /# Great League Team Report/);
  assert.match(md, /## Recommended teams/);
  assert.match(md, /## Appendix: per-Pokemon 1v1 scores/);

  // Names at least one recommended team (its first member's display name).
  const firstMember = report.rankedTeams[0].members[0].name;
  assert.ok(md.includes(firstMember), 'report names a recommended team member');

  // The invalid fixture row ("Freakemon") must surface as a warning.
  assert.match(md, /## Collection warnings/);
  assert.ok(
    report.warnings.some((w) => /freakemon/i.test(w)),
    'unknown-species row surfaced as a warning'
  );

  // Round-trip through a temp file (mirrors what the CLI writes to out/).
  const dir = mkdtempSync(path.join(tmpdir(), 'gbl-cli-'));
  const outPath = path.join(dir, 'report.md');
  writeFileSync(outPath, md, 'utf8');
  assert.ok(existsSync(outPath));
  assert.ok(readFileSync(outPath, 'utf8').length > 0);
});

test('renderSummary lists the top teams and flags warnings', () => {
  const input = {
    collectionPath: 'x.csv',
    monCount: 5,
    metaTeams: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    warnings: ['skipped foo#9: speciesId not found in gamemaster'],
    settings: { topK: 5, candidateCount: 4, scoreMeta: 10 },
    monScores: [],
    rankedTeams: [
      {
        members: [{ name: 'Azumarill' }, { name: 'Registeel' }, { name: 'Altaria' }],
        winRate: 0.72,
        avgHpMargin: 12.4,
        bestLead: { name: 'Azumarill', winRate: 0.8 },
        perMeta: [],
        hardestTeams: [],
      },
    ],
  };
  const summary = renderSummary(input);
  assert.match(summary, /Azumarill, Registeel, Altaria/);
  assert.match(summary, /72%/);
  assert.match(summary, /1 collection warning/);
});

test('renderReport handles the no-candidates case without throwing', () => {
  const input = {
    collectionPath: 'x.csv',
    monCount: 2,
    metaTeams: [{ id: 'a', name: 'A' }],
    warnings: [],
    settings: { topK: 5, candidateCount: 0, scoreMeta: 10 },
    monScores: [{ speciesId: 'azumarill', name: 'Azumarill', score: 611.2, leadIn: 'beats x' }],
    rankedTeams: [],
  };
  const md = renderReport(input);
  assert.match(md, /No candidate teams could be formed/);
  assert.match(renderSummary(input), /No candidate teams/);
});
