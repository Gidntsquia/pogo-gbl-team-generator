// Round 8 run scoring (plans round 8 R8), shared by gpu/gpu-study.mjs and gpu/gpu/study/check_page.py's inputs.
//
//   node gpu/gpu/study/runs.mjs            print one row per out/evolve-gpu8-* run (warm s/gen, saturation gen, total wall, b/s)
//   node gpu/gpu/study/runs.mjs --json     the same rows as JSON (written by gpu/gpu-study.mjs to out/gpu/study/runs.json)
//
// Definitions (round 7, gpu/gpu-width.mjs runStats): memo hit rate per gen = served / (simulated + served);
// saturation gen = first gen whose hit rate is within 2 pp of the mean of the final 5 gens; warm s/gen = mean of
// gpu-profile.json generations[].wall from the saturation gen to the end; total wall = last checkpoint mtime - "wall start";
// b/s = battles / step wall over all non-final steps.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const rd = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const txt = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const sum = (a, f = (x) => x) => a.reduce((s, x) => s + f(x), 0);

/**
 * Score one round-8 run directory (out/evolve-gpu8-<name>).
 * @param {string} dir run directory; its log is `${dir}.log`
 * @returns {object|null} row with name, env, exit, gens, sat, warmPerGen, total, bps, genWalls, rate, battles, tailShare, tailLog, start
 */
export function runStats(dir) {
  const name = path.basename(dir).replace(/^evolve-gpu8-/, '');
  const log = txt(`${dir}.log`);
  if (!log) return null;
  const env = (log.match(/^env: (.*?) HALVING=/m)?.[1] ?? '').trim();
  const prof = rd(`${dir}/gpu-profile.json`);
  const start = +(log.match(/wall start ([\d.]+)/)?.[1] ?? NaN);
  const exit = [...log.matchAll(/^exit (\d+)/gm)].at(-1)?.[1];
  const gens = [...log.matchAll(/^generation (\d+): done -- .*?(\d+) battles simulated \+ (\d+) served from cache/gm)].map((x) => ({ g: +x[1], sim: +x[2], hit: +x[3] }));
  const G = gens.length;
  const lastCk = `${dir}/evolve-gen${G - 1}.json`;
  const total = G && existsSync(lastCk) && start ? statSync(lastCk).mtimeMs / 1000 - start : null;
  const rate = gens.map((x) => x.hit / Math.max(1, x.sim + x.hit));
  const tail = rate.slice(-5), tailMean = tail.length ? sum(tail) / tail.length : null;
  const sat = G >= 5 ? rate.findIndex((r) => Math.abs(r - tailMean) <= 0.02) : -1;
  const genWalls = (prof?.generations ?? []).map((x) => x.wall);
  const warm = sat >= 0 && genWalls.length >= G ? sum(genWalls.slice(sat, G)) : null;
  const steps = (prof?.steps ?? []).filter((s) => s.gen !== 'final');
  const N = sum(steps, (s) => s.n), SW = sum(steps, (s) => s.wall);
  // tail share (round 9): time after half a launch's main battles ended (gpu-profile buckets.tail) / gen wall, warm gens
  const warmG = sat >= 0 ? (prof?.generations ?? []).slice(sat, G) : [];
  const tailShare = warmG.length ? sum(warmG, (g) => g.buckets?.tail ?? 0) / sum(warmG, (g) => g.wall) : null;
  // tail-filler log lines (POGO_GPU_STUDY=tail[,certain]): totals over the run
  const tl = [...log.matchAll(/gpu tail -- pool (\d+), speculated (\d+) \((\d+) certain\), kept (\d+), discarded (\d+), overrun (-?\d+)us, served (\d+)/g)];
  const served2 = [...log.matchAll(/gpu tail -- served (\d+) from the previous launch \(no pool/g)];
  const tailLog = tl.length ? {
    launches: tl.length, pool: sum(tl, (x) => +x[1]), speculated: sum(tl, (x) => +x[2]), certain: sum(tl, (x) => +x[3]),
    kept: sum(tl, (x) => +x[4]), discarded: sum(tl, (x) => +x[5]), served: sum(tl, (x) => +x[7]) + sum(served2, (x) => +x[1]),
  } : null;
  const fork = name.split('-')[0];
  return {
    name, fork, env, exit: exit == null ? null : +exit, gens: G, sat, tailMean, rate, genWalls,
    warmPerGen: warm != null ? warm / (G - sat) : null, total, bps: SW ? N / SW : null, battles: N, stepWall: SW,
    gpuPerGen: G ? SW / G : null, tailShare, tailLog, start, dir,
  };
}

/** Every out/evolve-gpu8-* run with a log, sorted by name. @returns {object[]} */
export function allRuns(out = 'out') {
  return readdirSync(out).filter((f) => /^evolve-gpu8-/.test(f) && !f.endsWith('.log') && existsSync(`${out}/${f}.log`))
    .map((f) => runStats(`${out}/${f}`)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
}

// checkpoint comparison, same rule as gpu/gpu-width.mjs compareRuns (timing fields stripped)
const strip = (o) => (Array.isArray(o) ? o.map(strip) : o && typeof o === 'object'
  ? Object.fromEntries(Object.entries(o).filter(([k]) => !/ms$|elapsed|^timing$|runStartedAt|^threadsUsed$|^resumed$|startedAt|finishedAt|csvPath|outDir|^analytics$/i.test(k)).map(([k, v]) => [k, strip(v)]))
  : o);
const genFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => /^evolve-gen\d+\.json$/.test(f)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]) : []);
/**
 * Compare every checkpoint of two run dirs, timing fields stripped.
 * @param {string} a run dir
 * @param {string} b run dir
 * @returns {{same: boolean, files: number, differ: string[]}}
 */
export function compareRuns(a, b) {
  const fa = genFiles(a), fb = new Set(genFiles(b));
  const differ = [];
  for (const f of fa) {
    if (!fb.has(f)) { differ.push(`${f} missing`); continue; }
    if (JSON.stringify(strip(rd(`${a}/${f}`))) !== JSON.stringify(strip(rd(`${b}/${f}`)))) differ.push(f);
  }
  return { same: fa.length > 0 && fa.length === fb.size && !differ.length, files: fa.length, differ };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const rows = allRuns();
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
  else for (const r of rows) console.log(`${r.name.padEnd(24)} exit ${r.exit} gens ${r.gens} sat ${r.sat} warm ${r.warmPerGen?.toFixed(2)} s/gen total ${r.total?.toFixed(1)} s ${Math.round(r.bps)} b/s  walls ${r.genWalls.map((w) => w.toFixed(1)).join(' ')}`);
}
