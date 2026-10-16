import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeIslands, islandCuts } from '../src/evolve/islandHalving.js';

test('makeIslands: a seeded partition into near-equal ascending islands', () => {
  const a = makeIslands(70, 32, 's'), b = makeIslands(70, 32, 's');
  assert.deepEqual(a, b);
  assert.deepEqual([...a.members].sort((x, y) => x - y), Array.from({ length: 70 }, (_, i) => i));
  const sizes = a.islStart.slice(1).map((v, k) => v - a.islStart[k]);
  assert.deepEqual(sizes, [23, 23, 24]);
  for (let k = 0; k < 3; k++) {
    const isl = a.members.slice(a.islStart[k], a.islStart[k + 1]);
    assert.deepEqual(isl, [...isl].sort((x, y) => x - y));
  }
  assert.notDeepEqual(makeIslands(70, 32, 't').members, a.members);
});

test('islandCuts: local cuts by win points, ties to the lower index, missing battles fetched', async () => {
  // 8 teams in 2 islands, 4 opponents in 3 rounds (slices 1, 2, 4). Team c beats every opponent o < c, ties o == c % 4.
  const nC = 8, nO = 4, order = [2, 0, 3, 1], sizes = [1, 2, 4];
  const islStart = [0, 4, 8], members = [0, 2, 5, 7, 1, 3, 4, 6];
  const known = new Map();
  const truth = (b) => {
    const c = Math.floor(b / 2 / nO), o = (b >> 1) % nO, seat = b & 1;
    if (o === c % 4) return 2;
    const candWins = o < c;
    return candWins === (seat === 0) ? 0 : 1;
  };
  let fetched = 0;
  const { aliveByRound, cutAt } = await islandCuts(
    { nC, nO, order, sizes, keep: 0.5, islStart, members },
    (b) => known.get(b),
    async (bids) => { fetched += bids.length; bids.forEach((b) => known.set(b, truth(b))); },
  );
  assert.equal(aliveByRound[0].length, 8);
  assert.equal(aliveByRound[1].length, 4);
  assert.equal(aliveByRound[2].length, 2);
  // round 0, opponent 2: island A {0,2,5,7}: 5 and 7 win -> keep 5, 7; island B {1,3,4,6}: 3, 4, 6 win (6 ties? 6%4=2 -> tie)
  // -> points 3:4, 4:4, 6:2 -> keep 3, 4
  assert.deepEqual(aliveByRound[1], [3, 4, 5, 7]);
  assert.equal(cutAt[0], 0);
  assert.equal(cutAt[6], 0);
  assert.equal(fetched, 8 * 1 * 2 + 4 * 1 * 2 + 2 * 2 * 2);
});
