// Fit GPU_RATE_MODEL (src/engine/gpuExecutor.js) from 5-gen `--gpu` runs' gpu-profile.json (plans/PLAN.md round 4, R8).
//   node gpu/fit-share.mjs --gpu out/evolve-gpu2-p1b --cpu out/evolve-gpu2-p1s   prints the model, writes out/gpu/share-fit.json
// GPU side (--gpu run, small CPU share so the GPU path is undisturbed): least squares of gpuPathS on battles sent to the
//   GPU. Measured: the fit is flat (step time is set by the slowest battles, not the count), so the model uses no
//   per-battle term and takes the SHORTEST GPU step as the time the CPU share must fit inside: battles moved to the
//   CPU do not shorten a GPU step, so a CPU share that outlasts any GPU step only adds time (a first fit to the lower
//   quartile, run out/evolve-gpu2-p1c, was 3% slower than share 0.004).
// CPU side (--cpu runs: share 0.05 and the p1c auto run, CPU counts 117-900): least squares of cpuShareS on its count
//   (CPU workers with the GPU sidecar and packing running beside them); the intercept is the per-step start cost.
// Gen-0 steps are left out (they include the cold start of both sides).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { balancedCpuCount } from '../src/engine/gpuExecutor.js';

const args = process.argv.slice(2);
const dirsOf = (flag) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));
const gpuDirs = dirsOf('--gpu'), cpuDirs = dirsOf('--cpu');
if (!gpuDirs.length || !cpuDirs.length) { console.error('usage: node gpu/fit-share.mjs --gpu <out dir> --cpu <out dir>'); process.exit(2); }
const stepsOf = (dirs) => dirs.flatMap((d) => JSON.parse(readFileSync(path.join(d, 'gpu-profile.json'), 'utf8')).steps.filter((s) => s.n > 0 && s.gen !== 0 && s.gen !== 'setup'));

/** Ordinary least squares y = a + b x. */
function ols(pts) {
  const n = pts.length, mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  const b = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const a = my - b * mx;
  const ss = pts.reduce((s, p) => s + (p[1] - a - b * p[0]) ** 2, 0), st = pts.reduce((s, p) => s + (p[1] - my) ** 2, 0);
  return { a, b, r2: 1 - ss / st, n };
}
const gs = stepsOf(gpuDirs).filter((s) => s.gpu > 0);
const g = ols(gs.map((s) => [s.gpu + s.flaggedRows, s.gpuPathS]));
const times = gs.map((s) => s.gpuPathS).sort((a, b) => a - b);
const q = (p) => times[Math.min(times.length - 1, Math.floor(p * (times.length - 1)))];
const cs = stepsOf(cpuDirs).filter((s) => s.cpu > 0);
const cpuBpsFit = cs.reduce((s, x) => s + x.cpu * x.cpu, 0) / cs.reduce((s, x) => s + x.cpu * x.cpuShareS, 0); // 1 / slope through 0
const cr = ols(cs.map((s) => [s.cpu, s.cpuShareS]));
const round = (x, d) => Number(x.toFixed(d));
const model = { gpuFixedS: round(q(0), 2), gpuPerBattleS: 0, cpuFixedS: round(Math.max(0, cr.a), 2), cpuBps: round(1 / cr.b, 1) };
const preview = [3000, 4500, 9000, 12000, 18000].map((n) => ({ n, cpu: balancedCpuCount(n, model), share: round(balancedCpuCount(n, model) / n, 4) }));
const note = `GPU (${gpuDirs.join(', ')}, gens 1+, ${g.n} steps): step time vs battles r2 ${g.r2.toFixed(2)} (slope ${(g.b * 1000).toFixed(3)} ms/battle), ` +
  `quartiles ${q(0.25).toFixed(1)} / ${q(0.5).toFixed(1)} / ${q(0.75).toFixed(1)} s, so the model is flat at the shortest step ${model.gpuFixedS} s. ` +
  `CPU (${cpuDirs.join(', ')}, ${cs.length} steps): ${model.cpuFixedS} s + battles / ${model.cpuBps} b/s beside the GPU (r2 ${cr.r2.toFixed(2)}; through 0: ${cpuBpsFit.toFixed(1)} b/s). ` +
  `Auto share: ${preview.map((p) => `${p.n.toLocaleString('en-US')} -> ${p.cpu} (${(p.share * 100).toFixed(1)}%)`).join(', ')}.`;
mkdirSync('out/gpu', { recursive: true });
writeFileSync('out/gpu/share-fit.json', JSON.stringify({ gpuDirs, cpuDirs, model, gpuFit: g, cpuFit: cr, gpuQuartiles: [q(0.25), q(0.5), q(0.75)], preview, note }, null, 2));
console.log(JSON.stringify(model));
console.log(note);
