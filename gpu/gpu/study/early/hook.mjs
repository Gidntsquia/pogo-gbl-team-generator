// Measurement-only Node loader (fork "early"): NODE_OPTIONS="--import <this file>" with EARLY_CAP=<dir>.
// Rewrites three production modules IN MEMORY at load time (no file on disk changes) to record:
//   halving.js     -> which halving round each evaluateTeamsInOrder call is
//   evaluate.js    -> per planned pairing: team, opponent, fresh-battle index (or memo), candidate-side win points and
//                     lead exchange for both seats; per team the roster-only blend terms and the final fitness
//   gpuExecutor.js -> every launch's raw output rows (cols 20..23 = per-battle start/end %globaltimer)
// Results are not changed: the injected code only reads values.
import { register } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.env.EARLY_CAP;
if (dir) {
  mkdirSync(dir, { recursive: true });
  let nEval = 0, nLaunch = 0;
  globalThis.__early = {
    round: null,
    launch(n, out, cols) {
      const a = out instanceof Int32Array ? out : Int32Array.from(out);
      writeFileSync(path.join(dir, `launch-${String(nLaunch).padStart(4, '0')}.bin`), Buffer.from(a.buffer, a.byteOffset, a.byteLength));
      writeFileSync(path.join(dir, `launch-${String(nLaunch).padStart(4, '0')}.json`), JSON.stringify({ n, cols }));
      nLaunch += 1;
    },
    get launches() { return nLaunch; },
    evalCall(rec) {
      rec.round = globalThis.__early.round;
      globalThis.__early.round = null;
      writeFileSync(path.join(dir, `eval-${String(nEval).padStart(4, '0')}.json`), JSON.stringify(rec));
      nEval += 1;
    },
  };
  register(new URL('data:text/javascript,' + encodeURIComponent(`
const subs = {
  'src/evolve/halving.js': [[
    'const sub = await evaluateTeamsInOrder(ctx, {',
    'globalThis.__early && (globalThis.__early.round = { r, rounds, sizes, keep, alive: alive.slice() });\\n    const sub = await evaluateTeamsInOrder(ctx, {']],
  'src/engine/gpuExecutor.js': [[
    'const timing = kernelTiming(r.out, r.cols, part.length);',
    'const timing = kernelTiming(r.out, r.cols, part.length); globalThis.__early?.launch(part.length, r.out, r.cols);']],
  'src/evolve/evaluate.js': [[
    'const tPlan0 = performance.now();',
    'const tPlan0 = performance.now(); const __launch0 = globalThis.__early?.launches;'], [
    '  executor?.noteEval?.({ planMs, accumulateMs: performance.now() - tAcc0, ranStep, memoHits });',
    \`  if (globalThis.__early) {
    const fresh = new Map(pendingKeys.map((k, i) => [k, i]));
    const ex = (r) => { const e = leadExchangeLoser(r.summary); return e === 'b' ? 1 : e === 'a' ? -1 : 0; };
    const wp = (r) => (r.winner === 'a' ? 1 : r.winner === 'tie' ? 0.5 : 0);
    const plan = [];
    let c = 0;
    prepared.forEach(({ oppPlans }, t) => { for (const { oppIndex, pairings } of oppPlans) for (let q = 0; q < pairings.length; q++) {
      const { fwdKey, revKey } = planKeys[c++];
      const f = outcomeFor(fwdKey), v = outcomeFor(revKey);
      const fv = f.ok ? f.value : null, rv = v.ok ? mirrorBattleResult(v.value) : null;
      plan.push([t, oppIndex, fresh.has(fwdKey) ? fresh.get(fwdKey) : -1, fresh.has(revKey) ? fresh.get(revKey) : -1,
        fv ? wp(fv) : -1, fv ? ex(fv) : 0, rv ? wp(rv) : -1, rv ? ex(rv) : 0]);
    } });
    globalThis.__early.evalCall({ nTeams: teams.length, nOpp: opponents.length, nFresh: pendingKeys.length, ranStep,
      launch0: __launch0, launch1: globalThis.__early.launches, errorCount,
      gamma: opponentStrengthGamma, candGamma: candidateStrengthGamma,
      weights: { snowball: snowballWeight, closer: closerWeight, consistency: consistencyWeight, sharedWeakness: sharedWeaknessWeight },
      oppWeights: opponentWeights ? opponents.map((_, j) => opponentWeights[j] ?? 1) : null,
      oppGroups: opponentArchetypeGroups ? opponents.map((_, j) => opponentArchetypeGroups[j] ?? null) : null,
      teamKeys: teams.map((k) => k.join('+')),
      closer: results.map((r) => r.closerScore), shared: results.map((r) => r.sharedWeaknessScore),
      winRate: results.map((r) => r.winRate), blend: results.map((r) => r.blendFitness), plan });
  }
  executor?.noteEval?.({ planMs, accumulateMs: performance.now() - tAcc0, ranStep, memoHits });\`]],
};
export async function load(url, context, nextLoad) {
  const res = await nextLoad(url, context);
  for (const [tail, reps] of Object.entries(subs)) {
    if (!url.endsWith(tail)) continue;
    let src = typeof res.source === 'string' ? res.source : Buffer.from(res.source).toString('utf8');
    for (const [a, b] of reps) {
      if (!src.includes(a)) throw new Error('early hook: anchor not found in ' + tail + ': ' + a.slice(0, 60));
      src = src.replace(a, b);
    }
    return { ...res, source: src };
  }
  return res;
}
`)));
}
