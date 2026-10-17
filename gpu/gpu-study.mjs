// Round 9 GPU study page (plans round 9 R9): out/gpu-study.html, one thread in four sections plus a glossary.
//
//   node gpu/gpu-study.mjs        (no GPU; reads out/ only)
//
// Reference run set (R7): the interleaved A/B r9-ab-{default,tail,certain}-{1..3} (out/gpu/study/r9chain.sh). Every number
// outside a captioned table or chart comes from those runs. Numbers go through num(key, ...) as <span data-k="key">; a
// verdict word goes through verdict(key) as <b data-verdict="key">. Both are written to out/gpu/study/page-numbers.json and
// gpu/gpu/study/check_page.py recomputes them from the raw files. Round-8 material lives in out/gpu/study/detail/ (written
// by gpu/gpu/study/round8-page.mjs).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { runStats } from './gpu/study/runs.mjs';

const S = 'out/gpu/study';
const rd = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const txt = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const sum = (a, f = (x) => x) => a.reduce((s, x) => s + f(x), 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const et = (sec) => new Date(sec * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
const etDay = (sec) => new Date(sec * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// ---------------------------------------------------------------- numbers
const NUMS = {};
/**
 * Format a number and register it for check_page.py.
 * @param {string} key label; the same key must show the same text everywhere on the page
 * @param {number|null} v raw value
 * @param {number|string} [fmt] decimals, or ',' (thousands, no decimals)
 * @param {{sign?: boolean, unit?: string, svg?: boolean}} [o] sign: leading + for positives; unit: appended text (inside the
 *   span); svg: a <tspan> for use inside SVG <text>
 * @returns {string}
 */
function num(key, v, fmt = 1, o = {}) {
  if (v == null || Number.isNaN(v)) return o.svg ? '<tspan class="na">n/a</tspan>' : '<span class="na">n/a</span>';
  let t = fmt === ',' ? Math.round(v).toLocaleString('en-US') : (+v).toFixed(fmt);
  if (/^-0(\.0*)?$/.test(t)) t = t.slice(1);
  if (o.sign && +t.replace(/,/g, '') > 0) t = `+${t}`;
  t = t.replace(/^-/, '−') + (o.unit ?? '');
  if (NUMS[key] && NUMS[key].t !== t) throw new Error(`page: label ${key} would show two values: ${NUMS[key].t} and ${t}`);
  NUMS[key] = { v, t };
  return o.svg ? `<tspan class="v" data-k="${esc(key)}">${t}</tspan>` : `<span class="v" data-k="${esc(key)}">${t}</span>`;
}
const VERDICTS = {};
/** A verdict word ("faster" / "slower" / "no gain") tied to the A/B number it sums up. */
function verdict(key, word) {
  VERDICTS[key] = word;
  return `<b class="vd vd-${word.replace(' ', '')}" data-verdict="${esc(key)}">${word}</b>`;
}

// ---------------------------------------------------------------- inputs
const VARIANTS = [
  { id: 'default', label: 'default', env: '(no study flag)' },
  { id: 'tail', label: 'tail filler', env: 'POGO_GPU_STUDY=tail' },
  { id: 'certain', label: 'tail + certain feed', env: 'POGO_GPU_STUDY=tail,certain' },
];
const chainLog = txt(`${S}/r9chain.log`);
const rounds = [1, 2, 3, 4, 5].filter((i) => VARIANTS.every((v) => existsSync(`out/evolve-gpu8-r9-ab-${v.id}-${i}.log`)));
const ab = Object.fromEntries(VARIANTS.map((v) => [v.id, rounds.map((i) => runStats(`out/evolve-gpu8-r9-ab-${v.id}-${i}`))]));
const okRun = (r) => r && r.exit === 0 && r.warmPerGen != null;
const stat = (id) => {
  const rs = ab[id].filter(okRun);
  const w = rs.map((r) => r.warmPerGen);
  return { n: rs.length, runs: rs, mean: mean(w), spread: w.length ? Math.max(...w) - Math.min(...w) : null, tail: mean(rs.map((r) => r.tailShare)) };
};
const ST = Object.fromEntries(VARIANTS.map((v) => [v.id, stat(v.id)]));
const verdictOf = (id) => {
  const d = ST[id].mean - ST.default.mean;
  const beats = Math.abs(d) > ST[id].spread && Math.abs(d) > ST.default.spread;
  return { d, beats, word: !beats ? 'no gain' : d < 0 ? 'faster' : 'slower' };
};
const refStart = ab.default[0]?.start;
const REF = refStart ? `the A/B started ${etDay(refStart)} ${et(refStart)} ET` : 'the A/B (not run yet)';
const full = Object.fromEntries(VARIANTS.map((v) => [v.id, existsSync(`out/evolve-gpu8-r9-full-${v.id}.log`) ? runStats(`out/evolve-gpu8-r9-full-${v.id}`) : null]));
const fullEnd = (id) => { const m = txt(`out/evolve-gpu8-r9-full-${id}.log`).match(/wall end ([\d.]+)/); return m ? +m[1] : null; };
const det = txt(`${S}/det-r9.txt`);
const detOk = (flag) => new RegExp(`POGO_GPU_STUDY=${flag} 5-gen vs default 5-gen: IDENTICAL`).test(det);
const verifyLog = (f) => txt(`${S}/tail/verify3v3-${f}.log`);
const verifyOk = (f) => { const l = verifyLog(f); return /per-matchup winner agreement 100\.00%/.test(l) && /flagged invalid in total: 0/.test(l) && /^exit 0/m.test(l); };
const TL = rd(`${S}/prof/tail-timeline.json`)?.launches ?? {};
const NCU = rd(`${S}/prof/ncu/summary.json`) ?? {};

// ---------------------------------------------------------------- drawing
const W = 360;
const svg = (h, inner, label) => `<svg viewBox="0 0 ${W} ${h}" class="fig" role="img" aria-label="${esc(label)}">${inner}</svg>`;
const tx = (x, y, s, cls = '', anchor = 'start') => `<text x="${x}" y="${y}" text-anchor="${anchor}"${cls ? ` class="${cls}"` : ''}>${s}</text>`;
const table = (head, rows, caption) => `<div class="tw"><table>${caption ? `<caption>${caption}</caption>` : ''}<tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></div>`;
const COL = { default: 'var(--c4)', tail: 'var(--c0)', certain: 'var(--c1)' };

/** Busy SMs over the launch, one strip per variant (clock timers from the tail kernel's segment records). */
function timelinePicture(launch) {
  const L = TL[launch];
  if (!L) return '<p class="mut">SM timeline: not run yet.</p>';
  const modes = VARIANTS.filter((v) => L[v.id === 'default' ? 'off' : v.id]);
  const span = Math.max(...modes.map((v) => L[v.id === 'default' ? 'off' : v.id].main_span_s));
  const x0 = 8, x1 = W - 8, hS = 46, sms = L.off.sms;
  let g = '', y = 6;
  for (const v of modes) {
    const r = L[v.id === 'default' ? 'off' : v.id];
    const bw = ((x1 - x0) * (r.main_span_s / span)) / r.busy_sms.length;
    g += tx(x0, y + 12, `${v.id === 'certain' ? 'certain feed' : v.label}: SMs busy ${num(`tl.${launch}.${v.id}.active`, r.sm_active_share_pct, 1, { unit: '%', svg: true })} of the launch, ends at ${num(`tl.${launch}.${v.id}.span`, r.main_span_s, 2, { unit: ' s', svg: true })}`, 's');
    y += 16;
    r.busy_sms.forEach((b, k) => {
      const hm = (r.busy_sms_main[k] / sms) * hS, hp = (r.busy_sms_pool_only[k] / sms) * hS;
      g += `<rect x="${(x0 + k * bw).toFixed(2)}" y="${(y + hS - hm).toFixed(2)}" width="${(bw + 0.3).toFixed(2)}" height="${hm.toFixed(2)}" fill="var(--c4)"/>`;
      if (hp > 0) g += `<rect x="${(x0 + k * bw).toFixed(2)}" y="${(y + hS - hm - hp).toFixed(2)}" width="${(bw + 0.3).toFixed(2)}" height="${hp.toFixed(2)}" fill="${COL[v.id]}"/>`;
    });
    g += `<line x1="${x0}" x2="${x1}" y1="${y + hS}" y2="${y + hS}" stroke="var(--line)"/>`;
    y += hS + 10;
  }
  g += tx(x0, y + 6, `grey: SMs with this round's battles`, 's');
  g += tx(x0, y + 20, `colour: SMs with only next-round battles`, 's');
  g += tx(x0, y + 34, `full height = ${sms} SMs`, 's');
  return svg(y + 40, g, `busy SMs over the ${launch} launch, each variant`);
}

/** One metric card: three plain-words lines and a bar per row against NVIDIA's healthy range. */
function metricCard(m) {
  const rows = m.rows.filter((r) => r.v != null || r.why);
  const max = m.max ?? 100;
  const x0 = 104, x1 = W - 52, X = (v) => x0 + (Math.min(v, max) / max) * (x1 - x0);
  let g = '';
  const top = 4, bot = top + rows.length * 19;
  if (m.healthy) {
    const a = X(m.healthy.lo ?? 0), b = X(m.healthy.hi ?? max);
    g += `<rect x="${a}" y="${top - 2}" width="${b - a}" height="${bot - top + 4}" fill="var(--ok)" opacity="0.15"/>`;
    g += tx(4, bot + 14, `green = healthy (NVIDIA): ${m.healthy.lo ?? 0}${m.unit}${m.healthy.hi != null ? `-${m.healthy.hi}${m.unit}` : ' or more'}`, 's');
  } else g += tx(4, bot + 14, 'NVIDIA names no healthy range for this one', 's');
  rows.forEach((r, i) => {
    const y = top + i * 19;
    g += tx(4, y + 13, esc(r.label), 's');
    if (r.v == null) { g += tx(x0, y + 13, esc(r.why), 's'); return; }
    g += `<rect x="${x0}" y="${y + 2}" width="${Math.max(1, X(r.v) - x0)}" height="13" rx="2" fill="${r.col}"/>` + tx(X(r.v) + 4, y + 13, num(r.key, r.v, m.dec ?? 1, { unit: m.unit, svg: true }), 's');
  });
  return `<div class="mc"><div class="nm">${esc(m.name)}</div>
<p><span class="l">What it is:</span> ${m.what}</p><p><span class="l">Ours:</span> ${m.ours}</p><p><span class="l">For speed:</span> ${m.means}</p>
${svg(bot + 20, g, m.name)}</div>`;
}

// ---------------------------------------------------------------- content
const vT = verdictOf('tail'), vC = verdictOf('certain');
const s = (id, k = 'mean') => num(`ab.${id}.${k}`, ST[id][k], 2, { unit: ' s' });
const delta = (id) => num(`ab.${id}.delta`, verdictOf(id).d, 2, { sign: true, unit: ' s' });
const pct = (key, v, d = 1) => num(key, v, d, { unit: '%' });
const tailPct = (id) => pct(`ab.${id}.tailshare`, ST[id].tail == null ? null : 100 * ST[id].tail);
const tlog = (id) => {
  const rs = ST[id].runs, t = rs.map((r) => r.tailLog).filter(Boolean);
  const f = (k) => mean(t.map((x) => x[k]));
  return { speculated: f('speculated'), kept: f('kept'), discarded: f('discarded'), served: f('served'), certain: f('certain'), launches: f('launches') };
};
const TLg = { tail: tlog('tail'), certain: tlog('certain') };
const n5 = NCU['5k'] ?? {}, n10 = NCU['10k'] ?? {}, n36 = NCU['36k'] ?? {}, vOn = NCU.variants?.['5k-tailon'] ?? {}, vOff = NCU.variants?.['5k-tailoff'] ?? {};
const has = (o) => o.tool && o.tool !== 'no Nsight';
const stallOf = (o, r) => o.top5_stalls?.find((x) => x.reason === r)?.share_pct ?? null;
const longSb = stallOf(n5, 'long_scoreboard');
const tl10 = TL['10k'] ?? {};
const activeGain = tl10.tail && tl10.off ? tl10.tail.sm_active_share_pct - tl10.off.sm_active_share_pct : null;
const spanGain = tl10.tail && tl10.off ? tl10.tail.main_span_s - tl10.off.main_span_s : null;

const verdictLine = (id, v) => `${VARIANTS.find((x) => x.id === id).label}: ${delta(id)} per warm generation, ${verdict(`ab.${id}.delta`, v.word)}${v.beats ? ' (beats both spreads)' : ' (within the spread)'}.`;

const summary = [
  `Both tail fillers give the same teams as default, run for run.`,
  `Warm time per generation: default ${s('default')}, tail filler ${s('tail')} (${verdict('ab.tail.delta', vT.word)}), certain feed ${s('certain')} (${verdict('ab.certain.delta', vC.word)}).`,
  `Idle SMs get busier (${num('tl.10k.default.active', tl10.off?.sm_active_share_pct, 1, { unit: '%' })} to ${num('tl.10k.tail.active', tl10.tail?.sm_active_share_pct, 1, { unit: '%' })} on a 10k launch); launches still end with their longest battle.`,
  `Each battle spends most of its time waiting on its own memory: ${pct('ncu.5k.stall.long_scoreboard', longSb)} of warp waits are memory loads.`,
  `Keep the default. The next build is battle state in fast on-chip memory.`,
];
const sup = (...k) => `<p class="sup">Supports summary point${k.length > 1 ? 's' : ''} ${k.join(' and ')}.</p>`;

const abRows = VARIANTS.map((v) => {
  const st = ST[v.id];
  return [v.label, ...rounds.map((i) => { const r = ab[v.id][i - 1]; return okRun(r) ? num(`run.r9-ab-${v.id}-${i}.warm`, r.warmPerGen, 2) : `exit ${r?.exit ?? '-'}`; }),
    num(`ab.${v.id}.mean`, st.mean, 2, { unit: ' s' }), num(`ab.${v.id}.spread`, st.spread, 2, { unit: ' s' }), v.id === 'default' ? '' : delta(v.id)];
});
const fullRows = VARIANTS.map((v) => {
  const r = full[v.id];
  if (!r) return [v.label, 'not run', '', '', ''];
  const end = fullEnd(v.id);
  return [v.label, r.exit === 0 ? num(`full.${v.id}.min`, r.total / 60, 1) : `exit ${r.exit}`, `${et(r.start)}-${end ? et(end) : '?'}`, num(`full.${v.id}.warm`, r.warmPerGen, 2), num(`full.${v.id}.gens`, r.gens, 0)];
});
const fullD = (id) => (full[id]?.total && full.default?.total ? (full[id].total - full.default.total) / 60 : null);

const ncuRow = (label, o, f, key, col) => ({ label, v: has(o) ? f(o) : null, why: has(o) ? null : 'no Nsight', key, col });
const metrics = [
  {
    name: 'Issue-slot use', unit: '%', healthy: { lo: 20, hi: 60 },
    what: 'share of cycles in which an SM starts an instruction.',
    ours: `${pct('ncu.5k.issue', n5.issue_slot_use_pct)} on the 5k launch: most cycles nothing is ready to run.`,
    means: 'warps are waiting, and there are too few of them to cover the wait.',
    rows: [ncuRow('5k default', n5, (o) => o.issue_slot_use_pct, 'ncu.5k.issue', COL.default), ncuRow('5k tail filler', vOn, (o) => o.issue_slot_use_pct, 'ncu.5kon.issue', COL.tail), ncuRow('10k default', n10, (o) => o.issue_slot_use_pct, 'ncu.10k.issue', COL.default)],
  },
  {
    name: 'Achieved occupancy', unit: '%', healthy: { lo: 60 },
    what: 'warps resident on an SM, as a share of the 48 it can hold.',
    ours: `${pct('ncu.5k.occ', n5.achieved_occupancy_pct)}: each thread needs so many registers that only 8 warps fit.`,
    means: 'with few warps, a wait on memory leaves the SM idle.',
    rows: [ncuRow('5k default', n5, (o) => o.achieved_occupancy_pct, 'ncu.5k.occ', COL.default), ncuRow('5k tail filler', vOn, (o) => o.achieved_occupancy_pct, 'ncu.5kon.occ', COL.tail), ncuRow('10k default', n10, (o) => o.achieved_occupancy_pct, 'ncu.10k.occ', COL.default)],
  },
  {
    name: 'Local memory share of L1 traffic', unit: '%', healthy: null,
    what: 'bytes of per-thread local memory (each battle\'s own state) among all bytes through L1.',
    ours: `${pct('ncu.5k.localshare', n5.local_share_of_l1_bytes_pct, 2)}, or ${num('ncu.5k.localgb', n5.local_bytes_gb, 0, { unit: ' GB' })} in a ${num('ncu.5k.kernel', n5.kernel_s_at_base_clock, 1, { unit: ' s' })} launch.`,
    means: 'battle state is the traffic; moving it on-chip removes most of it.',
    rows: [ncuRow('5k default', n5, (o) => o.local_share_of_l1_bytes_pct, 'ncu.5k.localshare', COL.default), ncuRow('5k tail filler', vOn, (o) => o.local_share_of_l1_bytes_pct, 'ncu.5kon.localshare', COL.tail), ncuRow('10k default', n10, (o) => o.local_share_of_l1_bytes_pct, 'ncu.10k.localshare', COL.default)], dec: 2,
  },
  {
    name: 'L1 hit rate', unit: '%', healthy: null,
    what: 'share of L1 requests answered by L1, the small cache inside each SM.',
    ours: `${pct('ncu.5k.l1', n5.l1_hit_pct)}; each miss waits for L2.`,
    means: 'each miss is a long wait (the "long scoreboard" stall).',
    rows: [ncuRow('5k default', n5, (o) => o.l1_hit_pct, 'ncu.5k.l1', COL.default), ncuRow('5k tail filler', vOn, (o) => o.l1_hit_pct, 'ncu.5kon.l1', COL.tail), ncuRow('10k default', n10, (o) => o.l1_hit_pct, 'ncu.10k.l1', COL.default)],
  },
  {
    name: 'L2 hit rate', unit: '%', healthy: null,
    what: 'share of L2 requests answered by L2, the cache all SMs share.',
    ours: `${pct('ncu.5k.l2', n5.l2_hit_pct)}; the rest go to the GPU's main memory.`,
    means: 'a miss here waits longer still, for main memory; more battles at once share the same L2.',
    rows: [ncuRow('5k default', n5, (o) => o.l2_hit_pct, 'ncu.5k.l2', COL.default), ncuRow('5k tail filler', vOn, (o) => o.l2_hit_pct, 'ncu.5kon.l2', COL.tail), ncuRow('10k default', n10, (o) => o.l2_hit_pct, 'ncu.10k.l2', COL.default)],
  },
  {
    name: 'SM-active share', unit: '%', healthy: null,
    what: 'share of the launch in which an SM has a battle to run, averaged over the 68 SMs.',
    ours: `Default ${num('tl.10k.default.active', tl10.off?.sm_active_share_pct, 1, { unit: '%' })} on the 10k launch; the gap is the tail.`,
    means: 'the filler raises it; the launch time stays set by the longest battle.',
    rows: ['5k', '10k', '36k'].flatMap((l) => VARIANTS.map((v) => {
      const r = TL[l]?.[v.id === 'default' ? 'off' : v.id];
      return { label: `${l} ${v.id === 'default' ? 'default' : v.id === 'tail' ? 'tail' : '+certain'}`, v: r?.sm_active_share_pct ?? null, why: 'not run', key: `tl.${l}.${v.id}.active`, col: COL[v.id] };
    })),
  },
];

const stallBars = () => {
  const st = n5.top5_stalls ?? [];
  if (!st.length) return '';
  const x0 = 118, x1 = W - 46, X = (v) => x0 + (v / 60) * (x1 - x0);
  let g = '';
  st.forEach((x, i) => {
    const y = 4 + i * 19;
    g += tx(4, y + 13, esc(x.reason.replace(/_/g, ' ')), 's');
    g += `<rect x="${x0}" y="${y + 2}" width="${X(x.share_pct) - x0}" height="13" rx="2" fill="var(--c0)"/>` + tx(X(x.share_pct) + 4, y + 13, num(`ncu.5k.stall.${x.reason}`, x.share_pct, 1, { unit: '%', svg: true }), 's');
  });
  return svg(4 + st.length * 19 + 4, g, 'why warps wait, 5k launch');
};

const glossary = [
  ['GPU', 'the graphics card; here an RTX 3080 runs the battle simulator.'],
  ['SM', 'one of the GPU\'s 68 cores. Each runs several warps and switches between them.'],
  ['warp', '32 threads that run the same instruction together. Each thread runs one battle.'],
  ['launch', 'one batch of battles sent to the GPU. It ends when its last battle ends.'],
  ['halving round', 'one step of the team search: all teams fight a few opponents, the bottom half is cut, the rest go on.'],
  ['tail', 'the end of a launch, after half its battles are done, while the slowest ones finish and most SMs sit idle.'],
  ['tail share', 'the tail\'s time as a share of a generation\'s time.'],
  ['tail filler', 'POGO_GPU_STUDY=tail: idle SMs run the next round\'s likely battles early. Their results are only reused.'],
  ['certain feed', 'POGO_GPU_STUDY=tail,certain: adds next-round battles of teams already sure to pass the cut.'],
  ['warm s/gen', 'mean seconds per generation once the battle cache is full (from the saturation generation).'],
  ['saturation generation', 'the first generation whose cache hit rate is within 2 points of the final level.'],
  ['spread', 'the slowest minus the fastest of a variant\'s A/B runs: the noise.'],
  ['memo hit', 'a battle answered from the cache instead of being simulated again.'],
  ['stall', 'a cycle in which a warp has an instruction but cannot run it yet.'],
  ['long scoreboard', 'the stall where a warp waits for data from L1, L2 or main memory.'],
  ['local memory', 'per-thread memory in the GPU\'s main memory, cached in L1 and L2. Battle state lives there.'],
  ['L1, L2', 'caches: L1 is small and inside each SM, L2 is larger and shared by all SMs.'],
  ['Nsight Compute', 'NVIDIA\'s profiler; it reads the GPU\'s hardware counters.'],
  ['no Nsight', 'no profiler numbers: the 36k replay reset the display driver, and the profiler cannot replay a launch the host feeds while it runs.'],
  ['width', 'how many threads share one battle (G). G=1 is one battle per thread.'],
];

// ---------------------------------------------------------------- page
const tlCaption = `Replay of a 10k launch dumped from a round-8 run, through the tail kernel three ways (tail-timeline.json).`;
const ncuCaption = `Nsight Compute on dumped 5k and 10k launches (summary.json). 36k and the certain feed: no Nsight (see glossary).`;
const body = `
<header><h1>GPU round 9: filling the tail ⏱️</h1>
<p class="mut">Reference runs: ${esc(REF)} (r9-ab-*). Numbers in a captioned table or chart come from the run its caption names.</p></header>

<section id="summary"><h2>Summary 📌</h2><ol>${summary.map((x, i) => `<li id="s${i + 1}">${x}</li>`).join('')}</ol></section>

<section id="built"><h2>What I built and what it gained 🔧</h2>
${sup(1, 2, 3)}
<p>A generation runs about ${num('ab.default.launches', mean(ST.default.runs.map((r) => r.gpuPerGen != null ? (rd(`${r.dir}/gpu-profile.json`)?.steps ?? []).filter((x) => x.gen !== 'final').reduce((a, x) => a + (x.launches?.length ?? 0), 0) / r.gens : 0)), 0)} GPU launches. Each one ends with a tail, when most SMs wait for the last slow battles.</p>
<p>The tail filler gives idle SMs the next round's battles of the teams most likely to pass the cut.</p>
<p>A result is used only if the next round asks for that battle.</p>
<p>The certain feed adds the battles of teams that are already sure to pass, sent into the running launch through a queue.</p>
<h3>Same results</h3>
<ul>
<li>Checkpoints of a 5-generation run with the same seed: tail filler ${detOk('tail') ? '<b class="ok">identical</b>' : '<b class="bad">differ</b>'} to default, certain feed ${detOk('tail,certain') ? '<b class="ok">identical</b>' : '<b class="bad">differ</b>'}.</li>
<li>Winner check against the CPU engine: tail filler ${verifyOk('tail') ? '<b class="ok">all agree, 0 flagged</b>' : '<b class="bad">failed</b>'}, certain feed ${verifyOk('tail-certain') ? '<b class="ok">all agree, 0 flagged</b>' : '<b class="bad">failed</b>'}.</li>
</ul>
<h3>Time per generation</h3>
<p>${num('ab.rounds', rounds.length, 0)} rounds, each running default, tail filler and certain feed back to back, 10 generations each.</p>
${table(['variant', ...rounds.map((i) => `round ${i}`), 'mean', 'spread', 'vs default'], abRows, 'Warm seconds per generation, reference A/B')}
<ul><li>${verdictLine('tail', vT)}</li><li>${verdictLine('certain', vC)}</li></ul>
<p class="mut">A change counts as a gain only if it is larger than both its own spread and the default's.</p>
<h3>Tail share</h3>
<p>Tail share: default ${tailPct('default')}, tail filler ${tailPct('tail')}, certain feed ${tailPct('certain')}.</p>
<p>Per launch the filler ran ${num('ab.tail.spec', TLg.tail.speculated / Math.max(1, TLg.tail.launches), 0)} battles early on average; ${pct('ab.tail.keptpct', 100 * TLg.tail.kept / Math.max(1, TLg.tail.speculated), 0)} finished before the launch ended and ${pct('ab.tail.servedpct', 100 * TLg.tail.served / Math.max(1, TLg.tail.speculated), 0)} were later used.</p>
${timelinePicture('10k')}
<p class="cap">${tlCaption}</p>
<h3>Full runs</h3>
${table(['variant', 'total min', 'ET', 'warm s/gen', 'gens'], fullRows, 'One full standard run each (r9-full-*, recipes/standard.json generation count), back to back after the A/B')}
<p class="cap">Full-run difference vs default: tail filler ${num('full.tail.dmin', fullD('tail'), 1, { sign: true, unit: ' min' })}, certain feed ${num('full.certain.dmin', fullD('certain'), 1, { sign: true, unit: ' min' })}. One run each, so no spread.</p>
</section>

<section id="facts"><h2>Three facts that explain it 🔬</h2>
${sup(3, 4)}
<h3>1. A launch ends with its longest battle</h3>
<p>The filler fills idle SMs, but it cannot make the longest battle finish sooner.</p>
<p>On the 10k launch it raised SM-active share by ${num('tl.10k.activegain', activeGain, 1, { sign: true, unit: ' points' })} and moved the launch end by ${num('tl.10k.spangain', spanGain, 2, { sign: true, unit: ' s' })}.</p>
<p>The extra battles share L1, L2 and main memory with this round's battles, so they compete for the same waits of fact 2.</p>
<h3>2. Each battle waits on its own memory</h3>
<p>A battle's state (teams, HP, energy, the lookahead tree) lives in local memory. Nsight Compute shows what that costs:</p>
${stallBars()}
<p class="cap">Why warps wait on the 5k launch: share of all stall cycles (Nsight Compute, summary.json).</p>
${metrics.map(metricCard).join('\n')}
<p class="cap">${ncuCaption}</p>
<h3>3. Width does not matter</h3>
<p>Giving one battle several threads did not help: the width picker chooses G=1 at every launch size on this GPU.</p>
<p class="mut">Round-8 width runs: <a href="gpu/study/detail/round8-prototypes.html">What the prototypes changed</a>.</p>
</section>

<section id="todo"><h2>What to do 🚀</h2>
${sup(5)}
<ul>
<li>Run today with the default: <code>bash scripts/sim.sh &lt;csv&gt; --gpu</code> (halving 3, island halving off).</li>
<li>Flag to try: <code>POGO_GPU_STUDY=stack</code> (smaller battle state, round 8). The tail flags stay off.</li>
<li>Build next: keep each battle's hot state in on-chip shared memory, to cut the memory waits of fact 2.</li>
</ul>
</section>

<section id="glossary"><h2>Glossary 📚</h2><dl class="gl">${glossary.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join('')}</dl></section>

<section id="more"><h2>More detail</h2><ul class="links">
<li><a href="gpu/study/detail/round8-decide.html">Round 8 candidate changes</a></li>
<li><a href="gpu/study/detail/round8-time.html">Round 8: where the time goes</a></li>
<li><a href="gpu/study/detail/round8-prototypes.html">Round 8 prototype runs</a></li>
<li><a href="gpu/study/detail/round8-background.html">Round 8 sources and terms</a></li>
<li><a href="gpu/study/detail/round9-runs.html">Round 9 runs, logs and counts</a></li>
</ul></section>
<footer><p class="mut" id="indep">${esc(txt(`${S}/review/footer.txt`).trim() || 'independent check: not run yet')}</p></footer>`;

const css = `:root{--link:#1f5fc4;--bg:#fff;--fg:#1d2330;--mut:#5b6577;--line:#d9dee7;--card:#f4f6f9;--ok:#157347;--bad:#b42318;--c0:#2f6fdb;--c1:#e0832a;--c2:#3aa676;--c4:#9aa3b2}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--link:#8ab4ff;--bg:#14171d;--fg:#e6e9ef;--mut:#9aa3b2;--line:#2c3340;--card:#1c2028;--ok:#4cc38a;--bad:#ff7b72;--c0:#6ea0ff;--c1:#f2a65a;--c2:#5ccf98;--c4:#6b7383}}
:root[data-theme="dark"]{--link:#8ab4ff;--bg:#14171d;--fg:#e6e9ef;--mut:#9aa3b2;--line:#2c3340;--card:#1c2028;--ok:#4cc38a;--bad:#ff7b72;--c0:#6ea0ff;--c1:#f2a65a;--c2:#5ccf98;--c4:#6b7383}
*{box-sizing:border-box}a{color:var(--link)}body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif,'Noto Color Emoji';margin:0 auto;max-width:720px;padding:16px}
h1{font-size:1.4rem;margin:.2rem 0 .4rem}h2{font-size:1.2rem;margin:2rem 0 .3rem;border-bottom:1px solid var(--line);padding-bottom:4px}h3{font-size:1.05rem;margin:1.3rem 0 .3rem}
p{margin:.4rem 0}ul,ol{padding-left:1.3rem;margin:.3rem 0}li{margin:.35rem 0}.mut,.cap{color:var(--mut)}.cap{font-size:13.5px}.na{color:var(--mut)}
code{font-size:.85em;background:var(--card);padding:1px 4px;border-radius:3px;word-break:break-word}
.sup{display:inline-block;font-size:13px;color:var(--mut);border:1px solid var(--line);border-radius:12px;padding:1px 9px;margin:.2rem 0}
#summary{background:var(--card);border-radius:10px;padding:4px 14px 8px}#summary h2{border:0;margin-top:.6rem}
.vd{white-space:nowrap}.vd-faster{color:var(--ok)}.vd-slower{color:var(--bad)}.ok{color:var(--ok)}.bad{color:var(--bad)}
svg.fig{width:100%;height:auto;background:var(--card);border-radius:8px;margin:.5rem 0 .2rem;display:block}svg.fig text{fill:var(--fg);font-size:12px}svg.fig .s{font-size:11.5px}
.mc{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:.6rem 0}.mc .nm{font-weight:700}.mc p{margin:.15rem 0;font-size:14.5px;line-height:1.4}.mc .l{color:var(--mut)}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13.5px;margin:.4rem 0}caption{text-align:left;color:var(--mut);font-size:13px;padding-bottom:3px}
th,td{border:1px solid var(--line);padding:4px 5px;text-align:left;vertical-align:top}th{background:var(--card)}
dl.gl dt{font-weight:700;margin-top:.5rem}dl.gl dd{margin:0}footer{margin-top:2rem;border-top:1px solid var(--line)}`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GPU Round9 study</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Color+Emoji&display=swap"><style>${css}</style></head><body>${body}</body></html>`;
writeFileSync('out/gpu-study.html', html);

// ---------------------------------------------------------------- detail page: every round-9 run and count
mkdirSync(`${S}/detail`, { recursive: true });
const allR9 = [...VARIANTS.flatMap((v) => ab[v.id]), ...VARIANTS.map((v) => full[v.id])].filter(Boolean);
const dRows = allR9.map((r) => [esc(r.name), esc(r.env || '(defaults)'), r.exit, r.gens, r.sat, r.warmPerGen?.toFixed(2) ?? '', r.total?.toFixed(1) ?? '', r.start ? `${etDay(r.start)} ${et(r.start)}` : '',
  r.tailShare != null ? (100 * r.tailShare).toFixed(1) : '', r.tailLog ? `${r.tailLog.speculated} / ${r.tailLog.kept} / ${r.tailLog.discarded} / ${r.tailLog.served}` : '']);
const detail = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GPU Round9 runs</title><style>${css}</style></head><body>
<p><a href="../../../gpu-study.html">Back to the round 9 page</a></p><h1>Round 9 runs</h1>
<p>Every run of the round-9 chain (out/gpu/study/r9chain.log). Runs are out/evolve-gpu8-&lt;name&gt; with their .log.</p>
${table(['run', 'env', 'exit', 'gens', 'sat gen', 'warm s/gen', 'total s', 'start ET', 'tail share %', 'speculated / kept / discarded / served'], dRows, 'Round 9 runs')}
<h2>Identity</h2><pre>${esc(det)}</pre>
<h2>Winner check (verify_3v3 through the tail kernel)</h2>${['tail', 'tail-certain'].map((f) => `<h3>${f}</h3><pre>${esc(verifyLog(f).split('\n').filter((l) => /tail kernel|real gen-0, all|flagged invalid|agreement|^exit|^start|^end/.test(l)).join('\n'))}</pre>`).join('')}
<h2>Chain log</h2><pre>${esc(chainLog)}</pre></body></html>`;
writeFileSync(`${S}/detail/round9-runs.html`, detail);

// ---------------------------------------------------------------- inputs for the checkers
writeFileSync(`${S}/page-numbers.json`, JSON.stringify({ reference: REF, rounds, numbers: NUMS, verdicts: VERDICTS }, null, 1));
writeFileSync(`${S}/runs.json`, JSON.stringify({ reference: REF, ab: Object.fromEntries(VARIANTS.map((v) => [v.id, ab[v.id]])), full }, null, 1));
console.log(`wrote out/gpu-study.html: ${Object.keys(NUMS).length} numbers, ${Object.keys(VERDICTS).length} verdicts; reference ${REF}; rounds ${rounds.join(',') || 'none'}`);
