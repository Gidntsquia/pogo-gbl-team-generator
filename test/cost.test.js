// JavaScript Document
//
// src/cost/powerup.js -- power-up (build) cost arithmetic. Pure module, so
// every test here is a plain function call: no engine, no vendor data, no I/O.
//
// The first four tests are the ones that actually pin the transcribed cost
// table: they reproduce the four totals published alongside it. Get any band
// boundary wrong and at least one of them moves.

import test from 'node:test';
import assert from 'node:assert/strict';

import { powerUpCost, teamBuildCost, MAX_PAID_LEVEL, MAX_LEVEL } from '../src/cost/powerup.js';
import { renderReport, renderReportHtml, renderSummary } from '../src/report/index.js';

test('level 1 -> 40 matches the published 270,000 Stardust / 304 Candy total', () => {
  const c = powerUpCost(1, 40);
  assert.equal(c.stardust, 270000);
  assert.equal(c.candy, 304);
  assert.equal(c.candyXl, 0);
  assert.equal(c.steps, 78);
});

test('level 40 -> 50 matches the published 250,000 Stardust / 296 Candy XL total', () => {
  const c = powerUpCost(40, 50);
  assert.equal(c.stardust, 250000);
  assert.equal(c.candy, 0, 'levels 40+ spend Candy XL, never ordinary Candy');
  assert.equal(c.candyXl, 296);
  assert.equal(c.steps, 20);
});

test('shadow 40 -> 50 costs the published 360 Candy XL (per-step x1.2, rounded up)', () => {
  const c = powerUpCost(40, 50, { shadow: true });
  assert.equal(c.candyXl, 360);
  assert.equal(c.stardust, 300000);
});

test('purified 40 -> 50 costs the published 272 Candy XL (per-step x0.9, rounded up)', () => {
  const c = powerUpCost(40, 50, { purified: true });
  assert.equal(c.candyXl, 272);
  assert.equal(c.stardust, 225000);
});

test('lucky halves Stardust and leaves Candy alone', () => {
  const plain = powerUpCost(1, 40);
  const lucky = powerUpCost(1, 40, { lucky: true });
  assert.equal(lucky.stardust, plain.stardust / 2);
  assert.equal(lucky.candy, plain.candy);
});

test('a single half-level step costs exactly its band', () => {
  assert.deepEqual(powerUpCost(1, 1.5), { stardust: 200, candy: 1, candyXl: 0, steps: 1 });
  assert.deepEqual(powerUpCost(39.5, 40), { stardust: 10000, candy: 15, candyXl: 0, steps: 1 });
  assert.deepEqual(powerUpCost(40, 40.5), { stardust: 10000, candy: 0, candyXl: 10, steps: 1 });
  assert.deepEqual(powerUpCost(49.5, 50), { stardust: 15000, candy: 0, candyXl: 20, steps: 1 });
});

test('Stardust and Candy bands are deliberately offset at level 25/26', () => {
  // Stardust steps up to 4000 at 25; Candy only steps up to 4 at 26.
  assert.equal(powerUpCost(24.5, 25).stardust, 3500);
  assert.equal(powerUpCost(25, 25.5).stardust, 4000);
  assert.equal(powerUpCost(25.5, 26).candy, 3);
  assert.equal(powerUpCost(26, 26.5).candy, 4);
});

test('a mon already at or past the target costs nothing', () => {
  assert.deepEqual(powerUpCost(30, 30), { stardust: 0, candy: 0, candyXl: 0, steps: 0 });
  assert.deepEqual(powerUpCost(40, 25), { stardust: 0, candy: 0, candyXl: 0, steps: 0 });
});

test('the Best Buddy level (50 -> 51) is free, not a paid power-up', () => {
  assert.deepEqual(powerUpCost(50, 51), { stardust: 0, candy: 0, candyXl: 0, steps: 0 });
  assert.deepEqual(powerUpCost(49.5, 51), powerUpCost(49.5, MAX_PAID_LEVEL));
});

test('rejects levels that are not half-levels in range', () => {
  assert.throws(() => powerUpCost(1.25, 20), /half-level/);
  assert.throws(() => powerUpCost(0, 20), /half-level/);
  assert.throws(() => powerUpCost(20, MAX_LEVEL + 1), /half-level/);
  assert.throws(() => powerUpCost('20', 25), /half-level/);
});

test('teamBuildCost sums the members and keeps a per-member breakdown', () => {
  const cost = teamBuildCost([
    { key: 'a#1', name: 'A', currentLevel: 20, targetLevel: 21, shadow: false },
    { key: 'b#2', name: 'B', currentLevel: 20, targetLevel: 21, shadow: true },
    { key: 'c#3', name: 'C', currentLevel: 25, targetLevel: 25, shadow: false },
  ]);

  // 20 -> 21 is two steps: 2500 + 2500 dust, 2 + 2 candy.
  assert.deepEqual(
    cost.members.map((m) => [m.name, m.stardust, m.candy, m.candyXl, m.known]),
    [
      ['A', 5000, 4, 0, true],
      ['B', 6000, 6, 0, true], // x1.2: 3000+3000 dust, ceil(2.4)=3 candy per step
      ['C', 0, 0, 0, true],
    ]
  );
  assert.equal(cost.stardust, 11000);
  assert.equal(cost.candy, 10);
  assert.equal(cost.candyXl, 0);
  assert.equal(cost.complete, true);
});

test('teamBuildCost flags -- and never guesses -- a member with no stated level', () => {
  const cost = teamBuildCost([
    { key: 'a#1', name: 'A', currentLevel: 20, targetLevel: 21 },
    { key: 'b#2', name: 'B', currentLevel: null, targetLevel: 40 },
  ]);
  assert.equal(cost.complete, false);
  assert.equal(cost.stardust, 5000, 'the unknown member contributes nothing to the total');
  assert.equal(cost.members[1].known, false);
  assert.equal(cost.members[1].fromLevel, null);
  assert.equal(cost.members[1].toLevel, 40);
});

test('teamBuildCost adds evolution candy and surfaces the items needed', () => {
  const cost = teamBuildCost([
    { key: 'a#1', name: 'Trevenant', currentLevel: 20, targetLevel: 20,
      evolution: { fromName: 'Phantump', steps: 1, candy: 200, items: [], buddyKm: null } },
    { key: 'b#2', name: 'Scizor', currentLevel: 20, targetLevel: 20,
      evolution: { fromName: 'Scyther', steps: 1, candy: 50, items: ['Metal Coat'], buddyKm: null } },
  ]);
  assert.equal(cost.stardust, 0, 'both are already at their simulated level');
  assert.equal(cost.candy, 250, 'evolution candy is ordinary Candy, never Candy XL');
  assert.equal(cost.candyXl, 0);
  assert.equal(cost.evolveCandy, 250);
  assert.deepEqual(cost.evolveItems, ['Metal Coat']);
  assert.equal(cost.complete, true);
});

test('teamBuildCost counts evolution candy even when the level is unknown', () => {
  const cost = teamBuildCost([
    { key: 'a#1', name: 'Trevenant', currentLevel: null, targetLevel: 30,
      evolution: { fromName: 'Phantump', steps: 1, candy: 200, items: [], buddyKm: null } },
  ]);
  assert.equal(cost.candy, 200, 'evolution cost does not depend on level');
  assert.equal(cost.stardust, 0);
  assert.equal(cost.unknownLevels, 1);
  assert.equal(cost.complete, false);
});

test('teamBuildCost flags an evolution the published data does not price', () => {
  const cost = teamBuildCost([
    { key: 'a#1', name: 'Wyrdeer', currentLevel: 20, targetLevel: 20,
      evolution: { fromName: 'Stantler', steps: 1, candy: null, items: [], buddyKm: null } },
  ]);
  assert.equal(cost.candy, 0, 'an unpriced evolution is never guessed at');
  assert.equal(cost.unpricedEvolutions, 1);
  assert.equal(cost.complete, false);
  assert.equal(cost.members[0].evolvePriced, false);
});

// --------------------------------------------------------------- reporting --
//
// The report is a pure formatter, so these render a hand-built TeamResult
// rather than running the pipeline.

function reportInput(buildCost) {
  return {
    collectionPath: 'x.csv',
    monCount: 3,
    metaTeams: [{ id: 'a', name: 'A' }],
    warnings: [],
    settings: { topK: 5, candidateCount: 1, scoreMeta: 10 },
    monScores: [],
    rankedTeams: [
      {
        members: [{ name: 'Chandelure' }, { name: 'Stunfisk' }, { name: 'Trevenant' }],
        winRate: 0.72,
        avgHpMargin: 12.4,
        bestLead: { name: 'Stunfisk', winRate: 0.8 },
        perMeta: [],
        hardestTeams: [],
        ...(buildCost ? { buildCost } : {}),
      },
    ],
  };
}

const SAMPLE_COST = teamBuildCost([
  { key: 'chandelure#1', name: 'Chandelure', currentLevel: 11, targetLevel: 24.5 },
  { key: 'stunfisk#2', name: 'Stunfisk', currentLevel: 6, targetLevel: 27, shadow: true },
  {
    key: 'trevenant#3',
    name: 'Trevenant',
    currentLevel: null,
    targetLevel: 30,
    evolution: { fromName: 'Phantump', steps: 1, candy: 200, items: [], buddyKm: null },
  },
]);

test('renderSummary shows the build cost under each team', () => {
  const summary = renderSummary(reportInput(SAMPLE_COST));
  assert.match(summary, /build cost: [\d,]+ Stardust \+ [\d,]+ Candy/);
  assert.match(summary, /excludes 1 member whose collection row stated no level/);
});

test('renderReport tables the per-member build cost and a team total', () => {
  const md = renderReport(reportInput(SAMPLE_COST));
  assert.match(md, /\*\*Build cost:\*\*/);
  assert.match(md, /\| Member \| Evolve \| Level \| Stardust \| Candy \| Candy XL \|/);
  assert.match(md, /\| Chandelure \| - \| 11 → 24\.5 \|/);
  assert.match(md, /\| Trevenant \| from Phantump \(200 candy\) \| \? → 30 \| unknown \| 200 \| unknown \|/);
  assert.match(md, new RegExp(`\\*\\*${SAMPLE_COST.stardust.toLocaleString('en-US')}\\*\\*`));
  assert.match(md, /plus the Candy to evolve it/);
});

test('renderReportHtml tables the per-member build cost', () => {
  const html = renderReportHtml(reportInput(SAMPLE_COST));
  assert.match(html, /<th>Stardust<\/th><th>Candy<\/th><th>Candy XL<\/th>/);
  assert.match(html, /Chandelure<\/td><td>&mdash;<\/td><td>11 &rarr; 24\.5<\/td>/);
  assert.match(html, /plus the Candy to evolve it/);
});

test('a team with no buildCost renders exactly as before (no cost markup)', () => {
  const md = renderReport(reportInput(null));
  const html = renderReportHtml(reportInput(null));
  const summary = renderSummary(reportInput(null));
  for (const text of [md, html, summary]) {
    assert.ok(!/Build cost|build cost/.test(text), 'no build-cost markup without buildCost');
  }
});

test('a fully-built team reads as "already built", not as a zero bill', () => {
  const cost = teamBuildCost([
    { key: 'a#1', name: 'A', currentLevel: 30, targetLevel: 25 },
    { key: 'b#2', name: 'B', currentLevel: 25, targetLevel: 25 },
    { key: 'c#3', name: 'C', currentLevel: 40, targetLevel: 40 },
  ]);
  const summary = renderSummary(reportInput(cost));
  assert.match(summary, /build cost: none -- already built/);
});
