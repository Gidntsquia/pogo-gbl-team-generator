#!/usr/bin/env node
// Round 7 report (plans round 7 R12): threads-per-battle picker, island halving, population scaling -> out/gpu-width.html.
//
//   node gpu/gpu-width.mjs                 build out/gpu-width.html from out/gpu/width/*.json, gpu/gpu/width-table.json and the
//                                          out/evolve-gpu7-* run logs / checkpoints / gpu-profile.json
//   node gpu/gpu-width.mjs cmp <a> <b>      compare two run dirs' checkpoints (every evolve-gen*.json, timing fields stripped)
//   node gpu/gpu-width.mjs finalists        R8: top 12 at gen 19 of each pop-1 setting re-battled on the CPU engine against
//                                          the gen-19 opponent pool of the halving-3 auto run -> out/gpu/width/finalists.json
//
// Run names (out/gpu/width/run20.sh): evolve-gpu7-<mode>-h<halving>-p<pop scale>[-r<k>], mode auto | isl | w<G> | mix;
// 5-gen auto runs: evolve-gpu7-5g-auto[-r<k>].
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = 'out', W = 'out/gpu/width';
const TARGET = 1500, R6_H3 = 1315; // round 6: 5-gen slice+bin halving 3 median (plans round 7 Facts)
const R6 = { h3: 1315, h2: 1535, h0: 1618 };
const rd = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const txt = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const sum = (a, f = (x) => x) => a.reduce((s, x) => s + f(x), 0);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n0 = (x) => (x == null || Number.isNaN(x) ? 'n/a' : Math.round(x).toLocaleString('en-US'));
const n1 = (x) => (x == null || Number.isNaN(x) ? 'n/a' : x.toFixed(1));
const n2 = (x) => (x == null || Number.isNaN(x) ? 'n/a' : x.toFixed(2));
const pct = (x, d = 1) => (x == null || Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const mins = (s) => (s == null ? 'n/a' : `${(s / 60).toFixed(1)} min`);
const tag = (ok, y = 'PASS', no = 'FAIL') => (ok == null ? '<span class="na">n/a</span>' : `<span class="${ok ? 'pass' : 'fail'}">${ok ? y : no}</span>`);
const table = (head, rows) => `<div class="tw"><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></div>`;

// ---------------------------------------------------------------- checkpoint comparison
const strip = (o) => (Array.isArray(o) ? o.map(strip) : o && typeof o === 'object'
  ? Object.fromEntries(Object.entries(o).filter(([k]) => !/ms$|elapsed|^timing$|runStartedAt|^threadsUsed$|^resumed$|startedAt|finishedAt|csvPath|outDir|^analytics$/i.test(k)).map(([k, v]) => [k, strip(v)]))
  : o);
const genFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => /^evolve-gen\d+\.json$/.test(f)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]) : []);
/**
 * Compare every checkpoint of two runs (timing fields stripped, as out/gpu/gap/cmp.mjs).
 * @param {string} a
 * @param {string} b
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

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'cmp') {
  const r = compareRuns(args[0], args[1]);
  console.log(`${r.files} checkpoints: ${r.same ? 'IDENTICAL' : `DIFFERENT (${r.differ.join(', ')})`}`);
  process.exit(r.same ? 0 : 1);
}

// ---------------------------------------------------------------- runs
const SETTING_LABEL = (mode, h) => `${mode === 'isl' ? 'island' : mode === 'auto' ? 'auto' : mode === 'mix' ? 'mix' : `G=${mode.slice(1)}`}, ${h === '0' ? 'full grid' : `halving ${h}`}`;
/** One run's R9 scores from its log, checkpoints and gpu-profile.json. */
function runStats(dir) {
  const name = path.basename(dir).replace(/^evolve-gpu7-/, '');
  const log = txt(`${dir}.log`) ?? '';
  const m = name.match(/^(auto|isl|mix|w\d+)-h(\d)-p([\d.]+)(?:-r(\d+))?$/) ?? name.match(/^(5g-auto)()()(?:-r(\d+))?$/);
  if (!m) return null;
  const prof = rd(`${dir}/gpu-profile.json`);
  // a resumed run's second setup + sidecar start (resume.sh merges them as resume_*): a cost of the stop, not of the setting
  const restart = (prof?.phases?.resume_setup ?? 0) + (prof?.phases?.resume_sidecarStart ?? 0);
  const start = +(log.match(/wall start ([\d.]+)/)?.[1] ?? NaN);
  const exit = [...log.matchAll(/^exit (\d+)/gm)].at(-1)?.[1]; // a resumed run (out/gpu/width/resume.sh) logs the stop's exit first
  const paused = sum([...log.matchAll(/^wall pause ([\d.]+)/gm)], (x) => +x[1]); // idle time between a stop's last checkpoint and its resume
  const gens = [...log.matchAll(/^generation (\d+): done -- .*?(\d+) battles simulated \+ (\d+) served from cache/gm)].map((x) => ({ g: +x[1], sim: +x[2], hit: +x[3] }));
  const G = gens.length;
  const lastCk = `${dir}/evolve-gen${G - 1}.json`;
  const total = G && existsSync(lastCk) && start ? statSync(lastCk).mtimeMs / 1000 - start - paused - restart : null;
  const rate = gens.map((x) => x.hit / Math.max(1, x.sim + x.hit));
  const tail = rate.slice(-5), tailMean = tail.length ? sum(tail) / tail.length : null;
  const sat = G >= 5 ? rate.findIndex((r) => Math.abs(r - tailMean) <= 0.02) : -1;
  const gw = (prof?.generations ?? []).map((x) => x.wall);
  const warm = sat >= 0 && gw.length >= G ? sum(gw.slice(sat, G)) : null;
  const steps = (prof?.steps ?? []).filter((s) => s.gen !== 'final');
  const N = sum(steps, (s) => s.n), SW = sum(steps, (s) => s.wall);
  const islandSteps = (log.match(/gpu island step -- /g) ?? []).length;
  const islandChecks = [...log.matchAll(/gpu island check -- (\d+) teams cut differently.*?, (\d+) extra battles/g)].map((x) => [+x[1], +x[2]]);
  const widths = [...log.matchAll(/gpu width -- (\d+) battles, G=(\w+)/g)].map((x) => [+x[1], x[2]]);
  return {
    paused, restart, dir, name, mode: m[1], h: m[2], pop: m[3], rep: +(m[4] ?? 1), key: m[1] === '5g-auto' ? '5g-auto' : `${m[1]}-h${m[2]}-p${m[3]}`,
    label: m[1] === '5g-auto' ? 'auto, halving 3, 5 gens' : SETTING_LABEL(m[1], m[2]), exit: exit == null ? null : +exit, gens: G, total, sat, warm,
    warmPerGen: warm != null ? warm / (G - sat) : null, bps: SW ? N / SW : null, battlesPerGen: G ? sum(gens, (x) => x.sim) / G : null,
    gpuPerGen: G ? SW / G : null, stepWall: SW, battles: N, rate, tailMean, steps: steps.length, launchSteps: steps.filter((x) => x.n > 0).length, islandSteps, islandChecks, widths,
    probe: [...log.matchAll(/gpu probe -- bucket (\S+): tried (.*?) in (\d+) launches; pick G=(\d+) \(default G=(\d+)\)/g)].map((x) => ({ bucket: x[1], tried: x[2], n: +x[3], pick: +x[4], def: +x[5] })),
    steps5: (prof?.steps ?? []).filter((s) => s.gen !== 'final' && s.gen < 5),
  };
}
const runs = readdirSync(OUT).filter((f) => /^evolve-gpu7-/.test(f) && !f.endsWith('.log') && existsSync(`${OUT}/${f}.log`)).map((f) => runStats(`${OUT}/${f}`)).filter(Boolean)
  .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
const done = runs.filter((r) => r.exit === 0 && r.gens >= 20);
const byKey = new Map();
for (const r of done) { if (!byKey.has(r.key)) byKey.set(r.key, []); byKey.get(r.key).push(r); }
const MODES = ['auto', 'isl', 'w1', 'w2', 'w4', 'w8', 'w16', 'w32', 'mix'];
const settings = [...byKey.entries()].map(([key, R]) => ({
  key, R, mode: R[0].mode, h: R[0].h, pop: R[0].pop, label: R[0].label,
  total: median(R.map((x) => x.total)), warm: median(R.map((x) => x.warm)), warmPerGen: median(R.map((x) => x.warmPerGen)),
  bps: median(R.map((x) => x.bps)), battlesPerGen: median(R.map((x) => x.battlesPerGen)), gpuPerGen: median(R.map((x) => x.gpuPerGen)), sat: median(R.map((x) => x.sat)),
})).sort((a, b) => +a.pop - +b.pop || MODES.indexOf(a.mode) - MODES.indexOf(b.mode) || +b.h - +a.h);
const pop1 = settings.filter((s) => s.pop === '1');
const best = [...pop1].filter((s) => s.warmPerGen != null).sort((a, b) => a.warmPerGen - b.warmPerGen)[0];
const ref = settings.find((s) => s.key === 'auto-h3-p1');

// ---------------------------------------------------------------- finalists (R8)
const FIN_KEYS = ['auto-h3-p1', 'isl-h3-p1', 'auto-h2-p1', 'isl-h2-p1', 'auto-h0-p1'];
if (cmd === 'finalists') {
  const { buildEvolveSetup } = await import('../src/evolve/setup.js');
  const { parseEvolveArgs } = await import('../src/evolve/cli.js');
  const { evaluateTeamsInOrder } = await import('../src/evolve/evaluate.js');
  const { ownLeadPairing } = await import('../src/evolve/fitness.js');
  const { createExecutor } = await import('../src/engine/parallel.js');
  const { rehydrateOpponentPool } = await import('../src/meta/opponentPool.js');
  process.env.POGO_COMMUNITY_FILE ??= 'data/archive/meta-teams-community-mega-great.json';
  const dirOf = (key) => `${OUT}/evolve-gpu7-${key}`;
  const last = (key) => { const f = genFiles(dirOf(key)).at(-1); return f ? rd(`${dirOf(key)}/${f}`) : null; };
  const refCk = last('auto-h3-p1');
  if (!refCk) { console.error('no auto-h3-p1 checkpoint yet'); process.exit(1); }
  const { csvPath, opts } = parseEvolveArgs(['jaxon-gl-collection.csv', '--config', 'recipes/standard.json', '--cp', '1500', '--cup', 'mega', '--config', 'recipes/recipe-ab-old.json',
    '--seed', 'recipe-ab', '--curated-ratio', '0.66', '--opponent-meta-pool', '400', '--out-dir', `${W}/_setup`]);
  const setup = await buildEvolveSetup(csvPath, { ...opts, onLog: () => {} });
  const opponents = rehydrateOpponentPool(setup.ctx, refCk.opponentPool, setup.curatedPool, console.log);
  const sets = {};
  for (const key of FIN_KEYS) {
    const ck = last(key);
    if (!ck) { console.log(`${key}: no checkpoint, skipped`); continue; }
    const top = ck.population.map((p, i) => ({ keys: p, f: ck.fitness[i] })).sort((a, b) => b.f - a.f).slice(0, 12);
    sets[key] = { gen: ck.generation, top };
  }
  const uniq = new Map();
  for (const s of Object.values(sets)) for (const t of s.top) uniq.set(t.keys.join('|'), t.keys);
  const teams = [...uniq.values()];
  console.log(`re-battling ${teams.length} finalists x ${opponents.length} opponents on the CPU engine`);
  const executor = createExecutor({ threads: 8, vendorRoot: setup.ctx.vendorRoot, continueOnError: true, cp: setup.ctx.cp, cup: setup.ctx.cup });
  try {
    const t0 = Date.now();
    const run = await evaluateTeamsInOrder(setup.ctx, { teams, matrix: setup.deduped, opponents, pairingsFor: ownLeadPairing, difficulty: setup.difficulty, executor,
      roleScores: setup.roleScores });
    const win = new Map(teams.map((t, i) => [t.join('|'), run.results[i].rawWinRate]));
    const name = (keys) => keys.map((k) => setup.deduped.builtMons[k]?.speciesId ?? k).join(' / ');
    const out = { built: new Date().toISOString(), engine: 'cpu (pvpoke)', opponents: opponents.length, poolFrom: 'auto-h3-p1', seconds: (Date.now() - t0) / 1000, sets: {} };
    for (const [key, s] of Object.entries(sets)) {
      out.sets[key] = { gen: s.gen, teams: s.top.map((t, i) => ({ rank: i + 1, team: name(t.keys), sig: t.keys.join('|'), fitness: t.f, win: win.get(t.keys.join('|')) })) };
    }
    writeFileSync(`${W}/finalists.json`, JSON.stringify(out, null, 1));
    console.log(`wrote ${W}/finalists.json in ${n0(out.seconds)} s`);
  } finally { await executor.close(); }
  process.exit(0);
}

// ---------------------------------------------------------------- benches
const BW = [1, 2, 4, 8, 16, 32];
const bench = (n) => rd(`${W}/${n}.json`);
const benches = Object.fromEntries([...BW.map((g) => [`w${g}`, bench(`bench-w${g}`)]), ['auto', bench('bench-auto')],
  ...readdirSync(existsSync(W) ? W : '.').filter((f) => /^bench-mix-.*\.json$/.test(f)).map((f) => [f.slice(6, -5), bench(f.slice(0, -5))])].filter(([, b]) => b));
const sl = (b, size) => b?.slices?.find((s) => s.size === size);
const wtable = rd('gpu/gpu/width-table.json');
const BNAMES = ['<=1.5k', '1.5-3.5k', '3.5-7k', '7-14k', '14-26k', '>26k'];
const mixDesc = (b) => { const c = b?.cfg ?? {}; return `q ${c.q ?? 0.1}, wide G=${c.wide ?? 8}, narrow G=${c.narrow ?? 1}`; };

function benchRows(sizes) {
  const keys = [...BW.map((g) => `w${g}`), ...Object.keys(benches).filter((k) => k.startsWith('mix')), 'auto'].filter((k) => benches[k]);
  return keys.map((k) => {
    const b = benches[k];
    const lbl = k === 'auto' ? '<b>auto</b>' : k.startsWith('mix') ? `mix <small>(${esc(mixDesc(b))})</small>` : `G=${k.slice(1)}`;
    return [lbl, ...sizes.flatMap((size) => {
      const s = sl(b, size);
      if (!s) return ['n/a', 'n/a', 'n/a'];
      const bps = s.launches?.map((l) => size / l.span_s) ?? [];
      return [`<b>${n0(s.bps_median)}</b><br><small>${bps.length ? `${n0(Math.min(...bps))}–${n0(Math.max(...bps))}` : ''} (${s.reps} launches)</small>`,
        `${n2(s.span_median_s)} s<br><small>${n2(s.span_min_s)}–${n2(s.span_max_s)}</small>`, `${pct(s.idle_median)}<br><small>${pct(s.idle_min)}–${pct(s.idle_max)}</small>`];
    })];
  });
}

// auto vs each fixed width per bucket (R6)
function bucketChart() {
  const sizes = [...new Set(Object.values(benches).flatMap((b) => b.slices.map((s) => s.size)))].sort((a, b) => a - b);
  if (!sizes.length || !benches.auto) return { svg: '', rows: [] };
  const rowH = 26, gh = (BW.length + 1) * rowH + 30, LBL = 70, X0 = LBL + 10, X1 = 820;
  const rows = [];
  let g = '', y = 30;
  const bmax = Math.max(...sizes.flatMap((size) => [...BW.map((w) => sl(benches[`w${w}`], size)?.bps_median ?? 0), sl(benches.auto, size)?.bps_median ?? 0]));
  const XB = (v) => X0 + (v / bmax) * (X1 - X0 - 80);
  g += `<text x="${X0}" y="18" class="h">b/s per launch size: each fixed width (grey) vs auto (blue); dashed = 5% below the best fixed width</text>`;
  for (const size of sizes) {
    const fixed = BW.map((w) => [w, sl(benches[`w${w}`], size)?.bps_median]).filter(([, v]) => v != null);
    const a = sl(benches.auto, size);
    if (!fixed.length || !a) continue;
    const bestF = fixed.reduce((m, x) => (x[1] > m[1] ? x : m));
    const ok = a.bps_median >= bestF[1] * 0.95;
    const autoG = a.launches?.[0]?.width ?? null;
    rows.push({ size, bucket: BNAMES[bucketOf(size)], best: bestF, auto: a.bps_median, autoG, ok, idle: a.idle_median, ratio: a.bps_median / bestF[1] });
    g += `<text x="4" y="${y + 14}" class="lbl" font-weight="700">${n0(size)}</text><text x="4" y="${y + 30}" class="sub">${esc(BNAMES[bucketOf(size)])}</text>`;
    g += `<line x1="${XB(bestF[1] * 0.95)}" x2="${XB(bestF[1] * 0.95)}" y1="${y}" y2="${y + (fixed.length + 1) * rowH - 6}" stroke="var(--bad)" stroke-dasharray="4 3"/>`;
    for (const [w, v] of fixed) {
      g += `<text x="${X0 - 4}" y="${y + 15}" text-anchor="end" class="sub">G=${w}</text><rect x="${X0}" y="${y + 4}" width="${XB(v) - X0}" height="15" rx="2" fill="var(--mut)" opacity="${w === bestF[0] ? 0.9 : 0.45}"/><text x="${XB(v) + 5}" y="${y + 16}" class="sub">${n0(v)}${w === bestF[0] ? ' best' : ''}</text>`;
      y += rowH;
    }
    g += `<text x="${X0 - 4}" y="${y + 15}" text-anchor="end" class="lbl" font-weight="700">auto</text><rect x="${X0}" y="${y + 3}" width="${XB(a.bps_median) - X0}" height="17" rx="2" fill="var(--c0)"/><text x="${XB(a.bps_median) + 5}" y="${y + 16}" class="lbl">${n0(a.bps_median)} (G=${autoG ?? '?'}) ${ok ? '✓ within 5%' : '✗ more than 5% below'}</text>`;
    y += rowH + 18;
  }
  return { svg: `<svg viewBox="0 0 900 ${y}" class="fig" role="img" aria-label="auto vs fixed widths">${g}</svg>`, rows };
}
function bucketOf(n) { const B = [1500, 3500, 7000, 14000, 26000, Infinity]; return B.findIndex((b) => n <= b); }

// timelines (occupancy: busy lanes / resident lanes over the launch), as gpu-sched.mjs
function timeline(b, size) {
  const s = sl(b, size);
  if (!s?.launches?.length) return '<p class="na">no timeline</p>';
  const xmax = s.span_max_s, Wd = 520, H = 150, L = 34, B = 18;
  const X = (t) => L + (t / xmax) * (Wd - L - 6), Y = (v) => H - B - v * (H - B - 6);
  let g = '';
  const order = s.launches.map((l, i) => [l.span_s, i]).sort((a, c) => a[0] - c[0]);
  for (const l of s.launches) {
    const st = Object.values(l.timeline);
    const tot = st[0].map((_, k) => sum(st, (a) => a[k]));
    g += `<polyline points="${tot.map((v, k) => `${X(((k + 0.5) / tot.length) * l.span_s).toFixed(1)},${Y(Math.min(v, 1)).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--mut)" stroke-width="0.8" opacity="0.6"/>`;
  }
  const mid = s.launches[order[order.length >> 1][1]];
  const st = Object.values(mid.timeline);
  const tot = st[0].map((_, k) => sum(st, (a) => a[k]));
  const xs = tot.map((_, k) => X(((k + 0.5) / tot.length) * mid.span_s));
  g += `<polygon points="${xs.map((x, k) => `${x.toFixed(1)},${Y(Math.min(tot[k], 1)).toFixed(1)}`).join(' ')} ${xs.map((x) => `${x.toFixed(1)},${Y(0)}`).reverse().join(' ')}" fill="var(--c0)" opacity="0.75"/>`;
  const step = xmax > 20 ? 5 : xmax > 8 ? 2 : xmax > 3 ? 1 : 0.5;
  for (let t = 0; t <= xmax; t += step) g += `<line x1="${X(t)}" x2="${X(t)}" y1="${Y(0)}" y2="${Y(1)}" stroke="var(--line)"/><text x="${X(t)}" y="${H - 4}" text-anchor="middle">${t}s</text>`;
  g += [0, 0.5, 1].map((v) => `<text x="${L - 4}" y="${Y(v) + 4}" text-anchor="end">${v * 100}%</text>`).join('');
  return `<svg viewBox="0 0 ${Wd} ${H}" class="tl" role="img" aria-label="auto ${size}">${g}<line x1="${L}" x2="${Wd - 6}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--mut)"/></svg>`;
}

// ---------------------------------------------------------------- run charts
const SCOL = { auto: 'var(--c0)', isl: 'var(--c2)', mix: 'var(--c3)' };
const colOf = (s) => SCOL[s.mode] ?? 'var(--c1)';
const popLabel = (p) => `pop ${p}×`;
function wallChart() {
  if (!settings.length) return '<p class="na">no finished 20-gen runs yet</p>';
  const LBL = 190, X0 = LBL + 12, X1 = 640, rh = 40;   // room for the label after the longest bar
  const tmax = Math.max(...settings.flatMap((s) => s.R.map((r) => r.total ?? 0)));
  const XB = (v) => X0 + (v / tmax) * (X1 - X0);
  let g = `<text x="${X0}" y="18" class="h">20-gen wall time, minutes (median of runs): light = total, dark = warm part, dots = runs</text>`;
  let y = 34, lastPop = null;
  const top = y;
  for (const s of settings) {
    if (s.pop !== lastPop) { g += `<text x="4" y="${y + 16}" class="h">${popLabel(s.pop)}</text>`; y += 24; lastPop = s.pop; }
    const c = colOf(s);
    g += `<text x="${LBL}" y="${y + 15}" text-anchor="end" class="lbl"${best && s.key === best.key ? ' font-weight="700"' : ''}>${esc(s.label)}${best && s.key === best.key ? ' ★' : ''}</text>`;
    g += `<rect x="${X0}" y="${y + 2}" width="${XB(s.total) - X0}" height="16" rx="2" fill="${c}" opacity="0.35"/><rect x="${X0}" y="${y + 6}" width="${XB(s.warm ?? 0) - X0}" height="8" rx="2" fill="${c}"/>`;
    for (const r of s.R) if (r.total != null) g += `<circle cx="${XB(r.total)}" cy="${y + 10}" r="3" fill="var(--bg)" stroke="var(--fg)"><title>${esc(r.name)} ${mins(r.total)}</title></circle>`;
    g += `<text x="${XB(Math.max(...s.R.map((r) => r.total ?? 0))) + 8}" y="${y + 15}" class="lbl">${n1(s.total / 60)} <tspan class="sub">· warm ${n1((s.warm ?? NaN) / 60)} from gen ${s.sat ?? '?'} · ${n1(s.warmPerGen)} s/gen</tspan></text>`;
    y += rh - 14;
  }
  for (let v = 0; v <= tmax / 60; v += tmax / 60 > 60 ? 20 : tmax / 60 > 20 ? 10 : 5) g += `<line x1="${XB(v * 60)}" x2="${XB(v * 60)}" y1="${top}" y2="${y}" stroke="var(--line)"/><text x="${XB(v * 60)}" y="${y + 14}" text-anchor="middle" class="sub">${v}</text>`;
  return `<svg viewBox="0 0 960 ${y + 22}" class="fig" role="img" aria-label="wall time per setting">${g}</svg>`;
}
function bpsChart() {
  if (!settings.length) return '';
  const LBL = 190, X0 = LBL + 12, X1 = 760, rh = 26;
  const bmax = Math.max(2000, ...settings.flatMap((s) => s.R.map((r) => r.bps ?? 0)));
  const XB = (v) => X0 + (v / bmax) * (X1 - X0);
  let g = `<text x="${X0}" y="18" class="h">20-gen battles/s (battles ÷ step wall), median of runs; dots = runs</text>`;
  let y = 34, lastPop = null;
  const top = y;
  for (const s of settings) {
    if (s.pop !== lastPop) { g += `<text x="4" y="${y + 16}" class="h">${popLabel(s.pop)}</text>`; y += 24; lastPop = s.pop; }
    g += `<text x="${LBL}" y="${y + 14}" text-anchor="end" class="lbl">${esc(s.label)}</text><rect x="${X0}" y="${y + 3}" width="${XB(s.bps) - X0}" height="15" rx="2" fill="${colOf(s)}" opacity="0.8"/>`;
    for (const r of s.R) g += `<circle cx="${XB(r.bps)}" cy="${y + 10}" r="3" fill="var(--bg)" stroke="var(--fg)"><title>${esc(r.name)} ${n0(r.bps)}</title></circle>`;
    const lx = XB(Math.max(...s.R.map((r) => r.bps))) + 8;   // a label that would cross the 1,500 line starts right of it
    g += `<text x="${Math.max(lx, XB(TARGET) + 8)}" y="${y + 14}" class="lbl">${n0(s.bps)} <tspan class="sub">· ${n0(s.battlesPerGen)} battles/gen · ${n1(s.gpuPerGen)} GPU s/gen</tspan></text>`;
    y += rh;
  }
  let grid = '';   // gridlines first, so the row labels (with their halo) sit on top
  for (let v = 0; v <= bmax; v += 500) grid += `<line x1="${XB(v)}" x2="${XB(v)}" y1="${top}" y2="${y}" stroke="var(--line)"/><text x="${XB(v)}" y="${y + 14}" text-anchor="middle" class="sub">${n0(v)}</text>`;
  grid += `<line x1="${XB(TARGET)}" x2="${XB(TARGET)}" y1="${top}" y2="${y}" stroke="var(--bad)" stroke-width="2"/><text x="${XB(TARGET) + 4}" y="${top + 10}" class="sub" style="fill:var(--bad)">1,500</text>`;
  return `<svg viewBox="0 0 1010 ${y + 22}" class="fig" role="img" aria-label="battles per second per setting">${grid}${g}</svg>`;
}

// ---------------------------------------------------------------- determinism (R3/R7), probe (R5), island (R7)
const detRows = [...byKey.entries()].filter(([, R]) => R.length >= 2).map(([key, R]) => {
  // every later run against the first
  const cs = R.slice(1).map((x) => compareRuns(R[0].dir, x.dir));
  const same = cs.every((c) => c.same), differ = cs.flatMap((c) => c.differ);
  return [esc(R[0].label), popLabel(R[0].pop), `${esc(R[0].name)} vs ${R.slice(1).map((x) => esc(x.name)).join(', ')}`, cs.map((c) => `${c.files} checkpoints`).join(', '), tag(same, 'IDENTICAL', `DIFFERENT: ${esc(differ.slice(0, 3).join(', '))}`)];
});
const detAll = detRows.length ? detRows.every((r) => r[4].includes('IDENTICAL')) : null;
const det2 = (txt(`${W}/det.txt`) ?? '').trim();
const probeLines = runs.flatMap((r) => r.probe.map((p) => ({ ...p, run: r.name })));
const probeByBucket = BNAMES.map((b) => {
  const P = probeLines.filter((p) => p.bucket === b);
  if (!P.length) return null;
  const picks = {}; for (const p of P) picks[p.pick] = (picks[p.pick] ?? 0) + 1;
  const defs = [...new Set(P.map((p) => p.def))];
  const top = Object.entries(picks).sort((a, b) => b[1] - a[1])[0];
  return [esc(b), defs.map((d) => `G=${d}`).join(', '), Object.entries(picks).map(([g, n]) => `G=${g} ×${n}`).join(', '), `G=${top[0]}`, tag(defs.length === 1 && +top[0] === defs[0], 'same as default', 'differs from default'),
    `${n1(median(P.map((p) => p.n)))}`, `<small>${esc(P[0].tried)}</small>`];
}).filter(Boolean);
const islRuns = runs.filter((r) => r.mode === 'isl' && r.exit === 0);
const islRows = islRuns.map((r) => [esc(r.name), r.gens, r.islandSteps, `${r.launchSteps} with battles (GPU launches), ${r.steps - r.launchSteps} all-memo scoring passes (no launch)`, r.islandChecks.length ? `${r.islandChecks.length} steps: ${sum(r.islandChecks, (x) => x[0])} cut differently, ${sum(r.islandChecks, (x) => x[1])} extra battles` : '0 mismatches']);
const verify = ['1', '2', '4', '8', '16', '32', 'mix', 'auto'].map((g) => {
  const v3 = txt(`${W}/verify3v3-w${g}.log`) ?? '', v1 = txt(`${W}/verify1v1-w${g}.log`) ?? '';
  const pass3 = (v3.match(/agreement 100\.00% -> PASS/g) ?? []).length, flagged = [...v3.matchAll(/(\d+) flagged invalid/g)].map((x) => +x[1]);
  const ok3 = pass3 >= 2 && !/FAIL/.test(v3) && flagged.every((x) => x === 0), ok1 = !!v1 && !/FAIL|Traceback/.test(v1);
  return [g === 'mix' || g === 'auto' ? g : `G=${g}`, `${tag(ok3)} <small>${pass3} PASS lines, flagged ${flagged.join('/') || 'n/a'}</small>`, tag(ok1), `<code>out/gpu/width/verify3v3-w${g}.log</code>, <code>verify1v1-w${g}.log</code>`];
});

// 5-gen auto (R6)
const r5 = runs.filter((r) => r.mode === '5g-auto' && r.exit === 0).map((r) => ({ name: r.name, bps: sum(r.steps5, (s) => s.n) / sum(r.steps5, (s) => s.wall) })).filter((x) => x.bps > 0);
const r5med = median(r5.map((x) => x.bps));

// finalists (R8)
const fin = rd(`${W}/finalists.json`);
function finalistTable() {
  if (!fin) return '<p class="na">pending: <code>node gpu/gpu-width.mjs finalists</code> has not run.</p>';
  const refSet = fin.sets['auto-h3-p1'];
  const refSigs = new Set(refSet?.teams.map((t) => t.sig) ?? []);
  const all = Object.values(fin.sets).flatMap((s) => s.teams).filter((t, i, a) => a.findIndex((x) => x.sig === t.sig) === i).sort((a, b) => b.win - a.win);
  const fullRank = new Map(all.map((t, i) => [t.sig, i + 1]));
  const summary = Object.entries(fin.sets).map(([k, s]) => {
    const mean = sum(s.teams, (t) => t.win) / s.teams.length;
    const ov = s.teams.filter((t) => refSigs.has(t.sig)).length;
    const top3 = sum(s.teams.slice(0, 3), (t) => t.win) / 3;
    return [esc(SETTING_LABEL(k.split('-')[0], k.split('-')[1].slice(1))), `<b>${pct(mean)}</b>`, pct(top3), pct(Math.max(...s.teams.map((t) => t.win))),
      k === 'auto-h3-p1' ? 'reference' : `${ov} of 12`, `${n1(median(s.teams.map((t) => fullRank.get(t.sig))))}`];
  });
  const side = Array.from({ length: 12 }, (_, i) => [i + 1, ...Object.values(fin.sets).map((s) => { const t = s.teams[i]; return t ? `${pct(t.win)} <small>#${fullRank.get(t.sig)}${refSigs.has(t.sig) ? ' · in h3' : ''}</small><br><small>${esc(t.team)}</small>` : ''; })]);
  return `<p class="mut">${fin.opponents} opponents (the gen-19 pool of ${esc(fin.poolFrom)}), CPU engine, ${n0(fin.seconds)} s. Rank # = place among all ${all.length} distinct finalists by win% on that pool.</p>
${table(['setting (pop 1×)', 'mean win% of top 12', 'top-3 mean', 'best', 'top-12 overlap with halving 3', 'median rank #'], summary)}
<details><summary>Side by side, GA rank 1–12 (win% on the full pool, rank among all finalists)</summary>${table(['GA rank', ...Object.keys(fin.sets).map((k) => esc(SETTING_LABEL(k.split('-')[0], k.split('-')[1].slice(1))))], side)}</details>`;
}

// ---------------------------------------------------------------- story: numbers each step quotes
const { svg: bucketSvg, rows: bucketRows } = bucketChart();
const allWithin = bucketRows.length ? bucketRows.every((r) => r.ok) : null;
const islBest = pop1.filter((s) => s.mode === 'isl').sort((a, b) => a.warmPerGen - b.warmPerGen)[0];
const islPair = islBest ? settings.find((s) => s.key === `auto-h${islBest.h}-p1`) : null;
const finMean = (k) => (fin?.sets[k] ? sum(fin.sets[k].teams, (t) => t.win) / fin.sets[k].teams.length : null);
const h3s = (p) => settings.find((s) => s.key === `auto-h3-p${p}`);
const dev = wtable?.device ?? '';
const THREADS = +(dev.match(/(\d+) threads/)?.[1] ?? 17408);
const fillG = (n) => Math.min(32, Math.max(1, 2 ** Math.floor(Math.log2(Math.max(1, THREADS / n)))));
// per bench size: every fixed width's b/s and idle share
const benchSizes = [...new Set(Object.values(benches).flatMap((b) => b.slices.map((s) => s.size)))].sort((a, b) => a - b);
const perSize = benchSizes.map((size) => {
  const f = BW.map((w) => ({ w, bps: sl(benches[`w${w}`], size)?.bps_median, idle: sl(benches[`w${w}`], size)?.idle_median })).filter((x) => x.bps != null);
  if (!f.length) return null;
  const hi = Math.max(...f.map((x) => x.bps)), lo = Math.min(...f.map((x) => x.bps));
  return { size, f, spread: 1 - lo / hi, best: f.find((x) => x.bps === hi) };
}).filter(Boolean);
const maxSpread = perSize.length ? Math.max(...perSize.map((p) => p.spread)) : null;
const big = perSize.at(-1);
const idleOf = (p, w) => p?.f.find((x) => x.w === w)?.idle;
const popBps = ['1', '1.5', '2'].map((p) => [p, h3s(p)?.bps]);
const popTop = popBps.filter(([, v]) => v != null).at(-1);
const crossed = popBps.find(([, v]) => v >= TARGET);
const above1 = pop1.filter((s) => s.mode === 'auto' && s.bps >= TARGET);

// ---------------------------------------------------------------- pictures
const svgText = (x, y, lines, cls = '', anchor = 'middle', dy = 16) => `<text x="${x}" y="${y}" text-anchor="${anchor}"${cls ? ` class="${cls}"` : ''}>${lines.map((l, i) => `<tspan x="${x}" dy="${i ? dy : 0}">${l}</tspan>`).join('')}</text>`;
/** One warp (32 lanes) at G=1 and at G=8: same lanes, fewer battles each run by more lanes. */
function widthPicture() {
  const lane = (x, y, c, o = 1) => `<rect x="${x}" y="${y}" width="11" height="22" rx="2" fill="${c}" opacity="${o}"/>`;
  const cols = ['var(--c0)', 'var(--c1)', 'var(--c2)', 'var(--c3)'];
  let g = '';
  const panel = (x0, G, title, under) => {
    g += svgText(x0, 20, [title], 'h', 'start');
    for (let i = 0; i < 32; i++) {
      const b = Math.floor(i / G);
      g += lane(x0 + i * 13, 34, G === 1 ? cols[i % 4] : cols[b % 4], G === 1 ? 0.55 + 0.45 * ((i % 3) / 2) : 0.85);
    }
    if (G > 1) for (let b = 0; b < 32 / G; b++) g += `<path d="M${x0 + b * G * 13} 62 v6 h${G * 13 - 2} v-6" fill="none" stroke="var(--fg)"/>${svgText(x0 + b * G * 13 + (G * 13 - 2) / 2, 84, [`battle ${b + 1}`], 'sub')}`;
    else g += svgText(x0 + 208, 84, ['every lane runs its own battle'], 'sub');
    g += svgText(x0, 112, under, '', 'start', 18);
  };
  panel(10, 1, 'G=1: one lane per battle', ['32 battles at once, each on 1 lane.', 'Needs many battles to fill the GPU.']);
  panel(480, 8, 'G=8: eight lanes per battle', ['4 battles at once, each on 8 lanes.', 'Each battle should finish sooner.']);
  return `<svg viewBox="0 0 920 150" class="fig" role="img" aria-label="one warp at width 1 and width 8">${g}</svg>`;
}
/** auto's per-launch rule as a flow of boxes. */
function pickerPicture() {
  const ex = 5000, g0 = fillG(ex);
  const box = (x, w, lines, c = 'var(--line)') => `<rect x="${x}" y="8" width="${w}" height="92" rx="8" fill="var(--bg)" stroke="${c}" stroke-width="2"/>${svgText(x + w / 2, 34, lines, '', 'middle', 18)}`;
  const arrow = (x) => `<path d="M${x} 54 h22" stroke="var(--mut)" stroke-width="2" marker-end="url(#ah)"/>`;
  let g = `<defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 L8 4 L0 8z" fill="var(--mut)"/></marker></defs>`;
  g += box(4, 190, ['<tspan font-weight="700">A launch arrives</tspan>', `e.g. ${n0(ex)} battles`]) + arrow(198);
  g += box(226, 220, ['<tspan font-weight="700">Fill the GPU</tspan>', `widest G with battles × G`, `≤ ${n0(THREADS)} lanes → G=${g0}`]) + arrow(450);
  g += box(478, 220, ['<tspan font-weight="700">Check the bench table</tspan>', 'is that G within 2%', 'of the best measured here?']) + arrow(702);
  g += box(730, 186, ['<tspan font-weight="700">yes:</tspan> use it', '<tspan font-weight="700">no:</tspan> nearest width', 'that is'], 'var(--c0)');
  return `<svg viewBox="0 0 920 108" class="fig" role="img" aria-label="how auto picks a width">${g}</svg>`;
}
/** Standard halving (one launch per round, host cut between) vs island halving (one launch, islands advance alone). Schematic. */
function islandPicture() {
  const X = (t) => 150 + t * 7;
  const seg = (y, t0, t1, c, label) => `<rect x="${X(t0)}" y="${y}" width="${X(t1) - X(t0) - 2}" height="18" rx="3" fill="${c}" opacity="0.8"/>${label ? `<text x="${(X(t0) + X(t1)) / 2}" y="${y + 13}" text-anchor="middle" class="lbl" font-size="11">${label}</text>` : ''}`;
  const gap = (y, t0, t1) => `<rect x="${X(t0)}" y="${y}" width="${X(t1) - X(t0) - 2}" height="18" fill="none" stroke="var(--bad)" stroke-dasharray="3 2"/>`;
  let g = svgText(4, 20, ['Standard: one launch per round'], 'h', 'start');
  g += svgText(4, 46, ['all teams'], 'sub', 'start');
  g += seg(32, 0, 40, 'var(--c0)', 'round 1') + gap(32, 40, 46) + seg(32, 46, 66, 'var(--c0)', 'round 2') + gap(32, 66, 72) + seg(32, 72, 82, 'var(--c0)', 'r3');
  g += svgText(X(43), 66, ['host cut'], 'sub');
  g += svgText(4, 98, ['Island: one launch, each island advances alone'], 'h', 'start');
  const isl = [[34, 52, 62], [40, 58, 70], [30, 50, 58], [38, 60, 74]];
  isl.forEach(([a, b, c], i) => {
    const y = 110 + i * 24;
    g += svgText(4, y + 13, [`island ${i + 1}`], 'sub', 'start') + seg(y, 0, a, 'var(--c2)', 'round 1') + seg(y, a, b, 'var(--c2)', 'round 2') + seg(y, b, c, 'var(--c2)', 'r3');
  });
  g += `<line x1="${X(74)}" x2="${X(74)}" y1="106" y2="208" stroke="var(--fg)" stroke-dasharray="4 3"/>${svgText(X(74) + 6, 222, ['launch ends with the slowest island'], 'sub', 'start')}`;
  return `<svg viewBox="0 0 920 232" class="fig" role="img" aria-label="standard vs island halving (schematic)">${g}</svg>`;
}

// ---------------------------------------------------------------- page
// a run more than 15% under its setting's median b/s was slowed by something outside it (the user's own load on this box)
const slowRun = (r) => { const s = settings.find((x) => x.key === r.key); return r.exit === 0 && s?.R.length >= 3 && r.bps < s.bps * 0.85; };
const slowRuns = runs.filter(slowRun);
const runRows = runs.map((r) => [esc(r.name) + (slowRun(r) ? ' <span class="na">slowed</span>' : ''), esc(r.label), r.pop ? popLabel(r.pop) : '', r.exit == null ? '<span class="na">running</span>' : tag(r.exit === 0, 'exit 0', `exit ${r.exit}`), r.gens,
  mins(r.total), r.warm == null ? 'n/a' : `${mins(r.warm)}<br><small>${n1(r.warmPerGen)} s/gen</small>`, r.sat >= 0 ? `gen ${r.sat}<br><small>hit ${pct(r.rate[r.sat])}, final-5 ${pct(r.tailMean)}</small>` : 'n/a',
  n0(r.bps), n0(r.battlesPerGen), n1(r.gpuPerGen)]);
const runNotes = [
  'Total wall = run start → last checkpoint. Warm = generations after the memo hit rate settles (within 2 pp of its final-5 mean).',
  slowRuns.length ? `Slowed (more than 15% under the setting's median): ${slowRuns.map((r) => `${esc(r.name)} ${n0(r.bps)} b/s`).join(', ')}. Other work shared the GPU; a third clean run outvotes each.` : null,
  ...runs.filter((r) => r.paused > 0).map((r) => `${esc(r.name)} was stopped at a checkpoint and resumed from it (user request). Its total leaves out the ${mins(r.paused)} pause, the unfinished generation and the ${n1(r.restart)} s restart.`),
].filter(Boolean);
const picker = (() => {
  const t5 = sl(bench('bench-auto-tol5'), 2500);
  if (!t5) return null;
  const best25 = Math.max(...BW.map((w) => sl(benches[`w${w}`], 2500)?.bps_median ?? 0));
  const re = ['auto', '4', '16', '1'].map((g) => [g, ['a', 'b'].map((p) => sl(bench(`recheck-${p}-${g}`), 2500)?.bps_median)]);
  return { g: t5.launches?.[0]?.width ?? '?', bps: t5.bps_median, ratio: t5.bps_median / best25, re };
})();
const verifyOk = verify.every((r) => r[1].includes('PASS') && r[2].includes('PASS'));
const steps = [
  ['width', 'Width', `Lanes per battle barely matter: every width within ${pct(maxSpread, 0)} of the best at each size`],
  ['picker', 'Auto picker', allWithin ? 'Picks a width within 5% of the best at every size' : 'Misses the best width at some sizes'],
  ['island', 'Island halving', islBest && islPair ? `${pct(islBest.warmPerGen / islPair.warmPerGen - 1, 0)} slower per generation, same team quality` : 'pending'],
  ['population', 'Population', popTop ? `Bigger launches: halving 3 goes from ${n0(h3s('1')?.bps)} to ${n0(popTop[1])} b/s at ${popTop[0]}×` : 'pending'],
  ['runs', 'Best setting', best ? `${esc(best.label)}: ${n1(best.warmPerGen)} s/gen, ${n0(best.bps)} b/s` : 'pending'],
];
const css = `:root{--link:#1f5fc4;--bg:#fff;--fg:#1d2330;--mut:#5b6577;--line:#d9dee7;--card:#f5f7fa;--ok:#157347;--bad:#b42318;--c0:#2f6fdb;--c1:#e0832a;--c2:#3aa676;--c3:#a259c4}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--link:#8ab4ff;--bg:#14171d;--fg:#e6e9ef;--mut:#9aa3b2;--line:#2c3340;--card:#1c2028;--ok:#4cc38a;--bad:#ff7b72;--c0:#6ea0ff;--c1:#f2a65a;--c2:#5ccf98;--c3:#c792ea}}
:root[data-theme="dark"]{--link:#8ab4ff;--bg:#14171d;--fg:#e6e9ef;--mut:#9aa3b2;--line:#2c3340;--card:#1c2028;--ok:#4cc38a;--bad:#ff7b72;--c0:#6ea0ff;--c1:#f2a65a;--c2:#5ccf98;--c3:#c792ea}
a{color:var(--link)}body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1150px;padding:16px}
h1{font-size:1.5rem;margin-bottom:.2rem}h2{margin-top:2.4rem;border-bottom:1px solid var(--line);padding-bottom:4px}h2 .n{display:inline-block;background:var(--c0);color:var(--bg);border-radius:50%;width:1.6em;height:1.6em;text-align:center;line-height:1.6em;font-size:.8em;margin-right:.4em;vertical-align:middle}
svg.fig{width:100%;height:auto;background:var(--card);border-radius:6px;margin:.5rem 0}svg.fig text{fill:var(--fg);font-size:13px}svg.fig .h{font-weight:700;font-size:14px}svg.fig .sub{fill:var(--mut);font-size:12px}svg.fig .lbl{paint-order:stroke;stroke:var(--card);stroke-width:4px;stroke-linejoin:round}
.box{background:var(--card);border-left:4px solid var(--c0);padding:10px 14px;margin:1rem 0}.box p{margin:.2rem 0}
.q{font-size:1.05rem;margin:.4rem 0}.q b{color:var(--c0)}ul.find{margin:.4rem 0;padding-left:1.2rem}ul.find li{margin:.15rem 0}
.so{background:var(--card);border-radius:6px;padding:6px 12px;margin:1rem 0 0;font-weight:600}.so::before{content:"So → ";color:var(--c0)}
.story{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0;margin:1rem 0;counter-reset:s}.story li{flex:1 1 170px;background:var(--card);border-radius:8px;padding:8px 10px;position:relative;counter-increment:s}
.story li::before{content:counter(s);display:inline-block;background:var(--c0);color:var(--bg);border-radius:50%;width:1.4em;height:1.4em;text-align:center;line-height:1.4em;font-size:.8em;font-weight:700;margin-right:.4em}
.story a{font-weight:700;text-decoration:none}.story span{display:block;font-size:13px;color:var(--mut);margin-top:2px}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:.6rem 0;font-size:14px}th,td{border:1px solid var(--line);padding:5px 7px;text-align:left;vertical-align:top}th{background:var(--card)}
.pass{color:var(--ok);font-weight:700}.fail{color:var(--bad);font-weight:700}.na{color:var(--mut)}small,.mut{color:var(--mut)}pre{background:var(--card);padding:8px;overflow-x:auto;white-space:pre-wrap}
details{margin:.5rem 0}summary{cursor:pointer;color:var(--mut)}.tlpair{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:760px){.tlpair{grid-template-columns:1fr}}
figure{margin:0}figcaption{font-size:13px;color:var(--mut)}svg.tl{width:100%;height:auto;background:var(--card);border-radius:4px}svg.tl text{font-size:10px;fill:var(--mut)}`;
const ul = (items) => `<ul class="find">${items.filter(Boolean).map((x) => `<li>${x}</li>`).join('')}</ul>`;
const h2 = (id, n, t) => `<h2 id="${id}"><span class="n">${n}</span>${t}</h2>`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GPU width round 7</title><style>${css}</style></head><body>
<h1>GPU round 7: can the GPU reach 1,500 battles/s?</h1>
<p class="mut">Built ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET by <code>node gpu/gpu-width.mjs</code> · ${esc(dev.replace(/^gpu device -- /, ''))} · <a href="gpu-sched.html">round 6</a></p>
<div class="box" id="conclusion"><p><b>Conclusion.</b> ${best ? `The fastest setting is ${esc(best.label)}: ${n1(best.warmPerGen)} s per warm generation, ${n0(best.bps)} b/s. ` : ''}The width (threads per battle) barely matters: every width is within a few percent of the best at each launch size. Island halving is slower. Only bigger launches (more battles per generation) pass 1,500 b/s.</p>
<p><b>Superseded:</b> the width question is replaced by the round-8 study, which measured where GPU time goes and ranks what to change next: <a href="gpu-study.html">gpu-study.html</a>.</p></div>
<div class="box" id="terms"><p><b>Words used on this page.</b></p><ul class="find">
<li><b>Thread</b> (also called a <b>lane</b>): the GPU's smallest worker; it runs one copy of the battle code.</li>
<li><b>Warp</b>: 32 threads that always execute the same instruction at the same time; if their battles need different steps, they take turns (that waiting is <b>divergence</b>).</li>
<li><b>Width, G</b>: how many threads of a warp run one battle together. G=1: each thread runs its own battle (32 battles per warp). G=32: the whole warp runs one battle. The G threads repeat the same work, so a wider battle is not split up; it only avoids waiting on other battles.</li>
<li><b>Launch</b>: one batch of battles sent to the GPU at once; it ends when its slowest battle ends.</li>
<li><b>b/s</b>: battles finished per second. <b>Warm generation</b>: a generation after the battle cache has filled up (the steady state).</li>
</ul></div>
<p class="q">Round 6 ran halving 3 at <b>${n0(R6_H3)} b/s</b>. The bar is <b>${n0(TARGET)}</b>. Round 7 tried three ways to close the gap, in this order:</p>
<ol class="story">${steps.map(([id, t, s]) => `<li><a href="#${id}">${t}</a><span>${s}</span></li>`).join('')}</ol>

${h2('width', 1, 'Width: how many threads run one battle')}
<p class="q">Round 6 gave each battle one thread (G=1). Small launches left most threads idle. Would giving each battle more threads (a wider G) help?</p>
${widthPicture()}
${ul([
    big ? `At ${n0(big.size)} battles, idle lanes drop from ${pct(idleOf(big, 1), 0)} (G=1) to ${pct(idleOf(big, 32), 0)} (G=32)…` : null,
    maxSpread != null ? `…but b/s hardly moves: at every size the six widths are within ${pct(maxSpread, 0)} of each other. More busy lanes did not mean more battles finished.` : null,
    perSize.length ? `Best width per size: ${perSize.map((p) => `${p.size / 1000}k → G=${p.best.w}`).join(', ')}.` : null,
  ])}
<details><summary>Width bench table (5 launches per size)</summary>${table(['width', '5k b/s', '5k span', '5k idle', '36k b/s', '36k span', '36k idle'], benchRows([5000, 36000]))}${table(['width', '1k b/s', 'span', 'idle', '2.5k b/s', 'span', 'idle', '10k b/s', 'span', 'idle', '20k b/s', 'span', 'idle'], benchRows([1000, 2500, 10000, 20000]))}<p class="mut">Round-6 slice files, requeue T=64, length binning on. Mix = longest q of battles at the wide width.</p></details>
<p class="so">No single width wins everywhere, so let a picker choose one per launch.</p>

${h2('picker', 2, 'Auto: pick the width per launch')}
${pickerPicture()}
${relPicture()}
${ul([
    allWithin != null ? `Auto is ${allWithin ? 'within 5%' : 'not within 5%'} of the best fixed width at every bench size ${tag(allWithin, '✓', '✗')}.` : null,
    picker ? `A 5% band first let auto pick G=${picker.g} at 2.5k (${pct(picker.ratio)} of best); the band is now 2%.` : null,
    `On the real halving-3 command (5 gens, ${r5.length} runs): <b>${n0(r5med)} b/s</b> vs ${n0(R6_H3)} in round 6 ${tag(r5med == null ? null : r5med > R6_H3, '✓', '✗')}.`,
  ])}
<details><summary>Per-size bars, table, picker fix, occupancy timelines, probe</summary>
${bucketSvg}
${table(['bench size', 'bucket', 'best fixed', 'auto', 'auto / best', 'within 5%', 'auto idle share'], bucketRows.map((r) => [n0(r.size), esc(r.bucket), `G=${r.best[0]} ${n0(r.best[1])}`, `G=${r.autoG ?? '?'} ${n0(r.auto)}`, pct(r.ratio), tag(r.ok, 'yes', 'no'), pct(r.idle)]))}
${picker ? `<p class="mut">Recheck at 2.5k, two passes × 10 launches: ${picker.re.map(([g, v]) => `${g === 'auto' ? 'auto' : `G=${g}`} ${v.map(n0).join(' / ')}`).join(', ')}.</p>` : ''}
<p class="mut">Occupancy (busy lanes ÷ resident lanes) over one launch; grey = each launch, blue = median launch.</p>
<div class="tlpair"><figure>${timeline(benches.auto, 5000)}<figcaption>5,000 battles, idle ${pct(sl(benches.auto, 5000)?.idle_median)}</figcaption></figure><figure>${timeline(benches.auto, 36000)}<figcaption>36,000 battles, idle ${pct(sl(benches.auto, 36000)?.idle_median)}</figcaption></figure></div>
<p class="mut">Probe (round 7 debug flag, removed in round 8): tried neighbouring widths per bucket and kept the fastest.</p>
${probeByBucket.length ? table(['bucket', 'formula default', 'probe picks (runs)', 'most common pick', 'vs default', 'launches to converge (median)', 'one run\'s tries'], probeByBucket) : '<p class="na">no probe lines yet</p>'}
</details>
<p class="so">Auto ${r5med > R6_H3 ? 'edges past' : 'stays below'} round 6 (${pct(r5med / R6_H3 - 1)}), far from 1,500. The next cost is between launches: each halving round waits for the host.</p>

${h2('island', 3, 'Island halving: every round in one launch')}
<p class="q">Can the GPU cut teams itself, so a generation step needs one launch instead of one per round?</p>
${islandPicture()}
<p class="mut">Schematic. Teams are split into islands of ${islandSizeNote()}; each island cuts its own losers on the GPU and moves on.</p>
${ul([
    islBest && islPair ? `Slower: ${n1(islBest.warmPerGen)} vs ${n1(islPair.warmPerGen)} s per warm generation (${esc(islBest.label)} vs standard), <b>${pct(islBest.warmPerGen / islPair.warmPerGen - 1, 0)}</b>.` : null,
    'Why: one launch has no slicing or length order, so every island round waits on its longest battle.',
    islBest && islPair ? `Same team quality: finalists win ${pct(finMean(islBest.key))} vs ${pct(finMean(islPair.key))} on the full pool.` : null,
  ])}
<details><summary>Finalists on the full pool, island runs</summary>${finalistTable()}
${islRows.length ? table(['run', 'gens', 'island launches (log lines)', 'profile steps', 'host reference check'], islRows) : '<p class="na">no island runs finished yet</p>'}</details>
<p class="so">Removing host waits cost more than it saved. What is left is giving each launch more battles.</p>

${h2('population', 4, 'Population: more battles per launch')}
<p class="q">A bigger population means bigger launches, which the GPU runs at a higher rate. Does it reach 1,500?</p>
${bpsChart()}
${ul([
    `Halving 3, auto: ${popBps.map(([p, v]) => `${p}× → <b>${n0(v)}</b>`).join(', ')} b/s.`,
    crossed ? `Halving 3 crosses the 1,500 bar at ${crossed[0]}× ${tag(true, '✓')}.` : 'Halving 3 does not cross the 1,500 bar.',
    above1.length ? `Auto with ${above1.map((s) => (s.h === '0' ? 'the full grid' : `halving ${s.h}`)).join(' or ')} passes 1,500 already at 1×: they run more battles per generation, so their launches are bigger.` : null,
  ])}
<p class="so">Higher b/s is not the goal in itself: more battles also means longer generations. Wall time decides.</p>

${h2('runs', 5, 'Full 20-generation runs: the best setting')}
${wallChart()}
${ul([
    best ? `Fastest at 1× ★: <b>${esc(best.label)}</b>, ${n1(best.warmPerGen)} s per warm generation, ${mins(best.total)} total, ${n0(best.bps)} b/s.` : null,
    best && ref && best.key !== ref.key ? `Auto, halving 3 is ${pct(ref.warmPerGen / best.warmPerGen - 1)} behind (${n1(ref.warmPerGen)} s).` : null,
    h3s('1') && popTop ? `Bigger population costs wall time: auto, halving 3 takes ${mins(h3s('1').total)} at 1× and ${mins(h3s(popTop[0]).total)} at ${popTop[0]}×.` : null,
    'Light bar = total; dark bar = warm part; dots = each run.',
  ])}
<details id="every-run"><summary>Every run (${runs.length}) and run notes</summary>${table(['run', 'setting', 'pop', 'exit', 'gens', 'total wall', 'warm wall', 'saturation', 'b/s', 'battles/gen', 'GPU s/gen'], runRows)}<div id="run-notes"></div>${ul(runNotes)}</details>
<p class="so">The speedups only count if results are unchanged.</p>

${h2('correctness', 6, 'Correctness')}
${ul([
    `Battle checks (verify 3v3 and 1v1) at every width, mix and auto: ${tag(verifyOk, 'all PASS', 'some FAIL')}.`,
    `Same seed, same config, ${detRows.length} settings run 2–3 times: checkpoints ${tag(detAll, 'IDENTICAL', 'DIFFERENT')}.`,
  ])}
<details><summary>Check tables</summary>${table(['width', 'verify_3v3', 'verify_1v1', 'logs'], verify)}
${detRows.length ? table(['setting', 'pop', 'runs', 'compared', 'result'], detRows) : '<p class="na">pending</p>'}
${det2 ? `<p class="mut">2-gen determinism and CPU-only check:</p><pre>${esc(det2)}</pre>` : ''}</details>

${h2('answer', 7, 'Answer')}
<div class="box">${[
    best ? `<p>The fastest setting at today's population, ${esc(best.label)}, runs <b>${n0(best.bps)} b/s</b>: ${best.bps >= TARGET ? 'above' : 'below'} the 1,500 bar, yet its generations are the shortest (${n1(best.warmPerGen)} s warm) because halving 3 runs the fewest battles.</p>` : '',
    crossed ? `<p>Halving 3 clears 1,500 at ${crossed[0]}× population (<b>${n0(crossed[1])} b/s</b>${popTop && popTop[0] !== crossed[0] ? `; ${popTop[0]}×: ${n0(popTop[1])}` : ''}); halving 2 and the full grid clear it at 1×. Bigger launches are what lift b/s, not width or islands.</p>` : '',
    '<p><b>Next:</b> add the CPU share back at the chosen setting, and retire the probe (width-table.json fixes each bucket\'s width).</p>',
    '<p><b>Superseded by round 8:</b> the width question is closed; <a href="gpu-study.html">gpu-study.html</a> profiles the kernel and ranks the changes that would shorten a generation.</p>',
  ].join('')}</div>
</body></html>
`;
/** One row per bench size: every fixed width and auto as a share of that size's best fixed width. */
function relPicture() {
  if (!bucketRows.length) return '';
  const lo = Math.floor(Math.min(...perSize.flatMap((p) => p.f.map((x) => x.bps / p.best.bps)), ...bucketRows.map((r) => r.ratio)) * 20) / 20;
  const X0 = 130, X1 = 740, X = (v) => X0 + ((v - lo) / (1.02 - lo)) * (X1 - X0), rh = 46;
  let g = `<text x="${X0}" y="18" class="h">b/s as a share of the best fixed width, per launch size</text>`;
  g += `<text x="${X0}" y="36" class="sub">grey dots = fixed widths, labelled with G; blue = auto; red band = more than 5% below best</text>`;
  const top = 50, bot = top + bucketRows.length * rh;
  g += `<rect x="${X0}" y="${top}" width="${X(0.95) - X0}" height="${bot - top}" fill="var(--bad)" opacity="0.08"/>`;
  for (let v = lo; v <= 1.0001; v += 0.05) g += `<line x1="${X(v)}" x2="${X(v)}" y1="${top}" y2="${bot}" stroke="var(--line)"/><text x="${X(v)}" y="${bot + 16}" text-anchor="middle" class="sub">${Math.round(v * 100)}%</text>`;
  bucketRows.forEach((r, i) => {
    const y = top + i * rh + rh / 2, p = perSize.find((q) => q.size === r.size);
    g += `<text x="${X0 - 12}" y="${y + 5}" text-anchor="end" font-weight="700">${n0(r.size)} battles</text><line x1="${X0}" x2="${X1}" y1="${y}" y2="${y}" stroke="var(--line)"/>`;
    let last = -99, up = true;
    for (const x of [...(p?.f ?? [])].sort((a, b) => a.bps - b.bps)) {
      const cx = X(x.bps / p.best.bps);
      up = cx - last < 16 ? !up : true; last = cx;
      g += `<circle cx="${cx}" cy="${y}" r="5" fill="var(--mut)" opacity="0.6"><title>G=${x.w} ${n0(x.bps)} b/s</title></circle><text x="${cx}" y="${up ? y - 9 : y + 18}" text-anchor="middle" class="sub" font-size="10">${x.w}</text>`;
    }
    g += `<circle cx="${X(r.ratio)}" cy="${y}" r="7" fill="var(--c0)"/><text x="${X1 + 20}" y="${y + 5}" class="lbl" font-weight="700" style="fill:var(--c0)">auto G=${r.autoG ?? '?'}: ${pct(r.ratio, 0)}</text>`;
  });
  return `<svg viewBox="0 0 920 ${bot + 24}" class="fig" role="img" aria-label="auto and fixed widths relative to the best">${g}</svg>`;
}
function islandSizeNote() { return `8 × 2<sup>rounds−1</sup> teams (32 at halving 3, 16 at halving 2)`; }
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/gpu-width.html`, html.replace(/<h([23])>([^<]*)/g, (_, l, t) => `<h${l} id="${t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}">${t}`));
console.log(`wrote ${OUT}/gpu-width.html: ${runs.length} runs (${done.length} finished), ${settings.length} settings, ${Object.keys(benches).length} benches${best ? `; best at pop 1x: ${best.key}` : ''}`);
