// CLI + report pipeline tests.
//
// Drives runPipeline (the CLI's exported pipeline) with tiny knobs so the real
// 3v3 engine still runs but the battle count stays small, plus pure-formatting
// checks on the report renderer. The full-size default CLI run is exercised by
// hand in the manual verify steps, not here (too slow for the suite). Covers
// BOTH the sampled path (now the default) and the --exhaustive path (the old
// behavior, still available).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPipeline } from '../src/cli.js';
import { renderReport, renderReportHtml, renderSummary } from '../src/report/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-pokegenie.csv');

// Small enough to run fast, large enough to form >= 1 candidate team. Default
// (sampled) mode -- no `exhaustive` flag, matching what a bare `node
// src/cli.js <csv>` run does.
const SAMPLED_TINY = { candidates: 4, opponents: 2, pool: 6, scoreMeta: 4, top: 3, seed: 'cli-test-seed' };
// --exhaustive opt-in path (the older behavior).
const EXHAUSTIVE_TINY = { exhaustive: true, topK: 4, meta: 2, scoreMeta: 4, top: 3 };

// runPipeline is the whole cost of this file -- a real engine run, tiny but
// not free -- and several tests below want the SAME run: a plain SAMPLED_TINY
// report is the baseline that the currentMoves and cp=2500 tests compare
// against, and the thing both renderers are handed. Nothing here mutates a
// report, so running each distinct settings object once and sharing it is
// indistinguishable from re-running it, minus the minute it costs.
//
// Deliberately NOT used for the rejection test: that one needs a fresh call
// to reject, not a cached promise.
const pipelineRuns = new Map();
function pipeline(opts) {
  const key = JSON.stringify(opts);
  if (!pipelineRuns.has(key)) pipelineRuns.set(key, runPipeline(FIXTURE, opts));
  return pipelineRuns.get(key);
}

function assertWellFormedReport(report, expectedMetaCount, expectedTopCap) {
  assert.ok(report.rankedTeams.length >= 1, 'expected at least one ranked team');
  assert.ok(report.rankedTeams.length <= expectedTopCap, 'teamCount cap honored');
  assert.equal(report.metaTeams.length, expectedMetaCount, 'opponent/meta count honored');
  assert.ok(report.monCount >= 3, 'expected several scored mons from the fixture');

  const top = report.rankedTeams[0];
  assert.equal(top.members.length, 3, 'a team has 3 members');
  const species = new Set(top.members.map((m) => m.speciesId));
  assert.equal(species.size, 3, 'team members are all distinct species');
  assert.ok(top.winRate >= 0 && top.winRate <= 1, 'win rate in [0,1]');
  assert.equal(top.perMeta.length, expectedMetaCount, 'perMeta has one row per meta team');
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
}

test('runPipeline (sampled, default path) produces ranked teams and a well-formed report', async () => {
  const report = await pipeline(SAMPLED_TINY);
  assertWellFormedReport(report, SAMPLED_TINY.opponents, SAMPLED_TINY.top);

  assert.equal(report.settings.mode, 'sampled', 'default path reports mode: sampled');
  assert.equal(report.settings.seed, SAMPLED_TINY.seed, 'seed carried through to settings');
  assert.equal(report.settings.poolSize, SAMPLED_TINY.pool, 'pool size carried through to settings');
  for (const m of report.metaTeams) {
    assert.ok(m.label === 'curated' || m.label === 'sampled', `opponent team labeled curated/sampled, got ${m.label}`);
  }
});

test('runPipeline (currentMoves) forwards the opt-in flag and surfaces it in settings', async () => {
  const withoutFlag = await pipeline(SAMPLED_TINY);
  assert.equal(withoutFlag.settings.currentMoves, false, 'defaults to off');

  const report = await pipeline({ ...SAMPLED_TINY, currentMoves: true });
  assertWellFormedReport(report, SAMPLED_TINY.opponents, SAMPLED_TINY.top);
  assert.equal(report.settings.currentMoves, true);
  // Real fixture rows resolve to a moveset for most mons; scoring may add a
  // fallback-note warning for any that don't -- either way the pipeline must
  // still complete and rank teams (never a hard failure from this flag).
  assert.ok(report.rankedTeams.length >= 1);

  const md = renderReport(report);
  assert.match(md, /currentMoves=on/);
  const html = renderReportHtml(report);
  assert.match(html, /currentMoves=on/);
});

test('runPipeline (--cp 2500) runs Ultra League end to end and labels the report', async () => {
  const great = await pipeline(SAMPLED_TINY);
  assert.equal(great.settings.cp, 1500, 'default run is Great League');
  assert.equal(great.settings.league, 'Great League');
  const greatMd = renderReport(great);
  assert.match(greatMd, /# Great League Team Report/);
  assert.doesNotMatch(greatMd, /cp=/, 'the default cap is not spelled out in the settings line');

  const ultra = await pipeline({ ...SAMPLED_TINY, cp: 2500 });
  assertWellFormedReport(ultra, SAMPLED_TINY.opponents, SAMPLED_TINY.top);
  assert.equal(ultra.settings.cp, 2500);
  assert.equal(ultra.settings.league, 'Ultra League');

  // The community teams file is Great-League-only, so it is out of the
  // opponent pool at 2500 (src/meta/teams.js's documented Ultra League decision).
  for (const m of ultra.metaTeams) {
    assert.doesNotMatch(m.id, /^community:/, 'GL community teams excluded at cp 2500');
  }

  const md = renderReport(ultra);
  assert.match(md, /# Ultra League Team Report/);
  assert.match(md, /cp=2500/);
  const html = renderReportHtml(ultra);
  assert.match(html, /<h1>Ultra League Team Report<\/h1>/);
  assert.match(html, /cp=2500/);
});

test('runPipeline rejects an unsupported --cp before doing any work', async () => {
  await assert.rejects(() => runPipeline(FIXTURE, { ...SAMPLED_TINY, cp: 1234 }), /unsupported cp 1234/);
});

test('runPipeline (--exhaustive) still produces the old C(topK,3) + curated-only behavior', async () => {
  const report = await pipeline(EXHAUSTIVE_TINY);
  assertWellFormedReport(report, EXHAUSTIVE_TINY.meta, EXHAUSTIVE_TINY.top);

  assert.equal(report.settings.mode, 'exhaustive', 'explicit --exhaustive reports mode: exhaustive');
  assert.equal(report.settings.topK, EXHAUSTIVE_TINY.topK, 'topK carried through to settings');
  for (const m of report.metaTeams) {
    assert.equal(m.label, null, 'exhaustive opponent teams are unlabeled (curated-only pool)');
  }
});

test('renderReport writes a Markdown report that names >= 1 team (sampled, default path)', async () => {
  const report = await pipeline(SAMPLED_TINY);
  const md = renderReport(report);

  assert.match(md, /# Great League Team Report/);
  assert.match(md, /## Recommended teams/);
  assert.match(md, /## Appendix: per-Pokemon 1v1 scores/);
  assert.match(md, /mode=sampled/, 'settings line reports sampled mode');
  assert.match(md, /seed=cli-test-seed/, 'settings line surfaces the seed for reproducibility');

  // Names at least one recommended team (its first member's display name).
  const firstMember = report.rankedTeams[0].members[0].name;
  assert.ok(md.includes(firstMember), 'report names a recommended team member');
  assert.match(md, /Safest first switch:/, 'report surfaces the safe-swap pick per team');

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

test('renderReportHtml writes a self-contained HTML report naming >= 1 team (sampled, default path)', async () => {
  const report = await pipeline(SAMPLED_TINY);
  const html = renderReportHtml(report);

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<title>/i);
  assert.match(html, /Great League Team Report/);
  assert.match(html, /mode=sampled/, 'settings line reports sampled mode');
  assert.match(html, /seed=cli-test-seed/, 'settings line surfaces the seed for reproducibility');

  const firstMember = report.rankedTeams[0].members[0].name;
  assert.ok(html.includes(firstMember), 'report names a recommended team member');
  assert.match(html, /Safest first switch:/, 'report surfaces the safe-swap pick per team');

  // No external resources -- opens from disk via file:// with no network.
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /https?:\/\//i);

  // Round-trip through a temp file (mirrors what the CLI writes to out/).
  const dir = mkdtempSync(path.join(tmpdir(), 'gbl-cli-html-'));
  const outPath = path.join(dir, 'report.html');
  writeFileSync(outPath, html, 'utf8');
  assert.ok(existsSync(outPath));
  assert.ok(readFileSync(outPath, 'utf8').length > 0);
});

test('renderReportHtml escapes untrusted report text (collection warnings)', () => {
  const input = {
    collectionPath: 'x.csv',
    monCount: 1,
    metaTeams: [{ id: 'a', name: 'A' }],
    warnings: ['<script>alert(1)</script> & "quoted"'],
    settings: { topK: 5, candidateCount: 0, scoreMeta: 10 },
    monScores: [],
    rankedTeams: [],
  };
  const html = renderReportHtml(input);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test('renderReportHtml handles the no-candidates case without throwing', () => {
  const input = {
    collectionPath: 'x.csv',
    monCount: 2,
    metaTeams: [{ id: 'a', name: 'A' }],
    warnings: [],
    settings: { topK: 5, candidateCount: 0, scoreMeta: 10 },
    monScores: [{ speciesId: 'azumarill', name: 'Azumarill', score: 611.2, leadIn: 'beats x' }],
    rankedTeams: [],
  };
  const html = renderReportHtml(input);
  assert.match(html, /No candidate teams could be formed/);
});

test('renderReport settings line uses the old topK/candidates shape for --exhaustive', async () => {
  const report = await pipeline(EXHAUSTIVE_TINY);
  const md = renderReport(report);

  assert.doesNotMatch(md, /mode=sampled/, 'exhaustive report does not claim sampled mode');
  assert.match(md, new RegExp(`topK=${EXHAUSTIVE_TINY.topK}`), 'settings line reports topK');
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
