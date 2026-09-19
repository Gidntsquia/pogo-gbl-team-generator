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
