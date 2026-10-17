// EXPERIMENTAL (round 9 GPU study, POGO_GPU_STUDY=tail): the battles a halving round's launch may run speculatively in its
// tail. While round r's battles finish, the GPU has idle workers; the next round's battles of the teams likely to survive
// (every alive team against the opponents round r+1 reveals) can run there. Their results are only ever used as memo hits in
// round r+1 (served by the GPU executor for exactly the specs that round asks for), so the run's output does not change.
//
// Only called by src/evolve/halving.js when the executor has `speculate` (the GPU executor with that study flag on).

/**
 * Battles of `teams` x `opponents` in evaluateTeamsInOrder's planning order (forward then reversed seat per pairing), minus
 * keys already cached and duplicates: exactly that call's pendingSpecs/pendingKeys for the same cache state.
 * @param {object} cache battle cache (keyFor, get)
 * @param {object[][]} teamSpecs per team its members' specs
 * @param {object[]} opponents opponent teams ({members: [{spec}]})
 * @param {(opp: object) => Array<{leadA:number, leadB:number}>} pairingsFor
 * @param {number} difficulty
 * @param {Set<string>} [skip] keys to leave out as well (and the set every queued key is added to)
 * @returns {Array<{key: string, spec: object, team: number, seat: 0|1}>}
 */
export function plannedBattles(cache, teamSpecs, opponents, pairingsFor, difficulty, skip = new Set()) {
  const out = [];
  const add = (key, teamA, leadA, teamB, leadB, team, seat) => {
    if (skip.has(key)) return;
    skip.add(key);
    if (cache.get(key) !== undefined) return;
    out.push({ key, spec: { teamA, teamB, leadA, leadB, difficulty }, team, seat });
  };
  teamSpecs.forEach((teamASpec, t) => {
    for (const opp of opponents) {
      const teamBSpec = opp.members.map((m) => m.spec);
      for (const { leadA, leadB } of pairingsFor(opp)) {
        add(cache.keyFor(teamASpec, leadA, teamBSpec, leadB, difficulty), teamASpec, leadA, teamBSpec, leadB, t, 0);
        add(cache.keyFor(teamBSpec, leadB, teamASpec, leadA, difficulty), teamBSpec, leadB, teamASpec, leadA, t, 1);
      }
    }
  });
  return out;
}

/**
 * Speculation job for halving round r (r < rounds - 1): this round's fresh battles tagged by team and seat (for the kernel's
 * partial win rate), the pool of next-round battles, each team's win points from earlier rounds' opponents (memo), and the
 * cut size.
 * @param {object} cache
 * @param {{teams: string[][], matrix: object, opponents: object[], pairingsFor: Function, difficulty: number}} params
 * @param {number[]} alive team indices alive in round r (evaluate order)
 * @param {number[]} order seeded opponent order
 * @param {number[]} sizes halvingSlices
 * @param {number} r
 * @param {number} keep
 * @returns {{main: object[], pool: object[], priorPts: Float32Array, priorN: Float32Array, keep: number, keepK: number, keyFor: Function}}
 */
export function tailJob(cache, params, alive, order, sizes, r, keep) {
  const { teams, matrix, opponents, pairingsFor, difficulty } = params;
  const specs = alive.map((i) => teams[i].map((key) => matrix.builtMons[key].spec));
  const cur = order.slice(0, sizes[r]).map((j) => opponents[j]);
  const queued = new Set();
  const main = plannedBattles(cache, specs, cur, pairingsFor, difficulty, queued);
  const pool = plannedBattles(cache, specs, order.slice(sizes[r], sizes[r + 1]).map((j) => opponents[j]), pairingsFor, difficulty, new Set(queued));
  // win points each team already holds from opponents seen before round r (all memo hits now)
  const priorPts = new Float32Array(alive.length), priorN = new Float32Array(alive.length);
  const prev = order.slice(0, r > 0 ? sizes[r - 1] : 0).map((j) => opponents[j]);
  specs.forEach((teamASpec, t) => {
    for (const opp of prev) {
      const teamBSpec = opp.members.map((m) => m.spec);
      for (const { leadA, leadB } of pairingsFor(opp)) {
        const f = cache.get(cache.keyFor(teamASpec, leadA, teamBSpec, leadB, difficulty));
        const v = cache.get(cache.keyFor(teamBSpec, leadB, teamASpec, leadA, difficulty));
        if (f !== undefined) { priorPts[t] += f.winner === 'a' ? 1 : f.winner === 'tie' ? 0.5 : 0; priorN[t] += 1; }
        if (v !== undefined) { priorPts[t] += v.winner === 'b' ? 1 : v.winner === 'tie' ? 0.5 : 0; priorN[t] += 1; }
      }
    }
  });
  return {
    main, pool, priorPts, priorN, keep, keepK: Math.max(1, Math.ceil(alive.length * keep)),
    keyFor: (s) => cache.keyFor(s.teamA, s.leadA, s.teamB, s.leadB, s.difficulty),
  };
}
