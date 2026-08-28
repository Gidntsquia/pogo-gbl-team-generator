// Tests for src/report/raceChart.js -- the shared core of the animated
// "win rate by generation" race chart (scripts/chart-top-teams.mjs's
// standalone CLI and scripts/evolve.mjs's embedded report both funnel
// through buildTopTeamSeries/renderChartInner/renderChartHtml). Pure
// data-shaping over tiny hand-built checkpoint-shaped fixtures -- no file
// reads, no engine, no battles.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildTopTeamSeries, renderChartHtml, renderChartInner, teamSignature } from '../src/report/raceChart.js';

function topTeamsEntry(keys, names) {
  return { members: keys.map((key, i) => ({ key, name: names[i] })) };
}

test('teamSignature matches scripts/evolve.mjs\'s own lead-aware identity (lead first, rest sorted)', () => {
  assert.equal(teamSignature(['a1', 'a3', 'a2']), 'a1||a2|a3');
  assert.equal(teamSignature(['a1', 'a2', 'a3']), teamSignature(['a1', 'a3', 'a2']), 'back-slot order does not affect identity');
});

test('buildTopTeamSeries: ranked-first ordering, per-generation gaps as null, and a ranking-only team still included', () => {
  const sigA = teamSignature(['a1', 'a2', 'a3']);
  const sigB = teamSignature(['b1', 'b2', 'b3']);
  const sigC = teamSignature(['c1', 'c2', 'c3']); // final-ranked but never cracked a per-gen top-N

  const checkpoints = [
    {
      winRateBySignature: { [sigA]: 0.6, [sigB]: 0.5 },
      analytics: { topTeams: [topTeamsEntry(['a1', 'a2', 'a3'], ['Alpha', 'Bravo', 'Charlie']), topTeamsEntry(['b1', 'b2', 'b3'], ['Delta', 'Echo', 'Foxtrot'])] },
    },
    {
      // Team B died before this generation (bred out); team C is alive but
      // was never in a per-generation top-N (its final rank comes from the
      // elites pass, not raw fitness).
      winRateBySignature: { [sigA]: 0.68, [sigC]: 0.6 },
      analytics: { topTeams: [topTeamsEntry(['a1', 'a2', 'a3'], ['Alpha', 'Bravo', 'Charlie'])] },
    },
  ];
  const rankingEntries = [
    { signature: sigA, rank: 1, name: 'Alpha (Lead) / Bravo / Charlie' },
    { signature: sigC, rank: 2, name: 'Golf (Lead) / Hotel / India' },
  ];

  const data = buildTopTeamSeries(checkpoints, rankingEntries, 10);

  assert.equal(data.generations, 2);
  assert.equal(data.topCount, 10);
  assert.equal(data.teams.length, 3, 'A (ranked), B (unranked field), C (ranking-only) all present');

  // Ranked teams sort first, by rank.
  assert.equal(data.teams[0].rank, 1);
  assert.equal(data.teams[0].name, 'Alpha / Bravo / Charlie');
  assert.deepEqual(data.teams[0].series, [0.6, 0.68]);

  const teamC = data.teams.find((t) => t.rank === 2);
  assert.ok(teamC, 'the ranking-only team is included even though it never appeared in topTeams');
  assert.equal(teamC.name, 'Golf / Hotel / India', 'the "(Lead)" suffix from the ranking entry name is stripped');
  assert.deepEqual(teamC.series, [null, 0.6], 'null before the generation it first appears alive in');

  const teamB = data.teams.find((t) => t.name === 'Delta / Echo / Foxtrot');
  assert.ok(teamB);
  assert.equal(teamB.rank, null, 'never made the final ranking -- unranked field');
  assert.deepEqual(teamB.series, [0.5, null], 'null after the generation it died in');
});

test('buildTopTeamSeries: no checkpoints is a safe empty result, not a throw', () => {
  const data = buildTopTeamSeries([], [], 10);
  assert.deepEqual(data, { teams: [], generations: 0, topCount: 10 });
});

test('renderChartInner/renderChartHtml: embeds one series entry per generation, no NaN, and topCount is not hardcoded', () => {
  const sigA = teamSignature(['a1', 'a2', 'a3']);
  const checkpoints = [
    { winRateBySignature: { [sigA]: 0.55 }, analytics: { topTeams: [topTeamsEntry(['a1', 'a2', 'a3'], ['Alpha', 'Bravo', 'Charlie'])] } },
    { winRateBySignature: { [sigA]: 0.6 }, analytics: { topTeams: [topTeamsEntry(['a1', 'a2', 'a3'], ['Alpha', 'Bravo', 'Charlie'])] } },
    { winRateBySignature: { [sigA]: 0.62 }, analytics: { topTeams: [topTeamsEntry(['a1', 'a2', 'a3'], ['Alpha', 'Bravo', 'Charlie'])] } },
  ];
  const data = buildTopTeamSeries(checkpoints, [{ signature: sigA, rank: 1, name: 'Alpha / Bravo / Charlie' }], 5);

  const fragment = renderChartInner(data);
  assert.match(fragment, /id="chart"/);
  assert.match(fragment, /"generations":3/);
  assert.match(fragment, /"topCount":5/, 'the per-generation top-N used is carried through, not hardcoded to 10 in the script');
  assert.doesNotMatch(fragment, /NaN/);
  assert.doesNotMatch(fragment, /undefined/);

  const page = renderChartHtml(data, 'Test chart');
  assert.match(page, /<!doctype html>/);
  assert.match(page, /Test chart/);
  assert.match(page, /id="chart"/);
});

test('renderChartInner: zero teams (empty run) renders without throwing or producing NaN axis bounds', () => {
  const data = buildTopTeamSeries([], [], 10);
  const fragment = renderChartInner(data);
  assert.match(fragment, /id="chart"/);
  assert.doesNotMatch(fragment, /NaN/);
});
