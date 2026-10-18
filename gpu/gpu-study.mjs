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
import { runStats, compareRuns } from './gpu/study/runs.mjs';

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
  { id: 'certain', label: 'certain feed', env: 'POGO_GPU_STUDY=tail,certain' },
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
  // one shared time axis: every strip is drawn on the same seconds scale
  for (let t = 0; t <= span; t += 2) {
    const x = x0 + ((x1 - x0) * t) / span;
    g += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y - 10}" y2="${y - 5}" stroke="var(--mut)"/>` + tx(x, y + 6, `${t} s`, 's', t === 0 ? 'start' : 'middle');
  }
  y += 16;
  g += tx(x0, y + 6, `grey: SMs with this round's battles`, 's');
  g += tx(x0, y + 20, `colour: SMs with only next-round battles`, 's');
  g += tx(x0, y + 34, `full height = ${sms} SMs`, 's');
  return svg(y + 40, g, `busy SMs over the ${launch} launch, each variant`);
}

/** One metric card: three plain-words lines and a bar per row against NVIDIA's healthy range. */
function metricCard(m) {
  const rows = m.rows.filter((r) => r.v != null || r.why);
  const max = m.max ?? 100;
  const x0 = 122, x1 = W - 52, X = (v) => x0 + (Math.min(v, max) / max) * (x1 - x0);
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

const fullW = (id) => (full[id]?.warmPerGen != null && full.default?.warmPerGen != null ? full[id].warmPerGen - full.default.warmPerGen : null);
const fullWall = (id) => (full[id]?.start && fullEnd(id) ? fullEnd(id) - full[id].start : null);
const fullD = (id) => (fullWall(id) != null && fullWall('default') != null ? (fullWall(id) - fullWall('default')) / 60 : null);
const verdictLine = (id, v) => `${VARIANTS.find((x) => x.id === id).label}: ${delta(id)} per warm generation, ${verdict(`ab.${id}.delta`, v.word)}${v.beats ? ' (beats both spreads)' : ' (within the spread)'}.`;

const summary = [
  `The tail filler and the certain feed run next-round battles early and give the same teams as default.`,
  `Warm time per generation: default ${s('default')}, tail filler ${s('tail')} (${verdict('ab.tail.delta', vT.word)}), certain feed ${s('certain')} (${verdict('ab.certain.delta', vC.word)}).`,
  `In the 19:44 ET replay, SMs are busier (${num('tl.10k.default.active', tl10.off?.sm_active_share_pct, 1, { unit: '%' })} to ${num('tl.10k.tail.active', tl10.tail?.sm_active_share_pct, 1, { unit: '%' })} on 10k); a launch still ends with its longest battle.`,
  `Nsight on the 5k launch (10:37 ET run): ${pct('ncu.5k.stall.long_scoreboard', longSb)} of warp cycles wait on memory loads, mostly battle state.`,
  `Keep the default: the 100-gen tail-filler run took ${num('full.tail.dmin', fullD('tail'), 2, { sign: true, unit: ' min' })} (one run); the certain feed had ${verdict('ab.certain.delta', vC.word)}.`,
];
const sup = (...k) => `<p class="sup">Supports summary point${k.length > 1 ? 's' : ''} ${k.length > 1 ? `${k.slice(0, -1).join(', ')} and ${k.at(-1)}` : k[0]}.</p>`;

const abRows = VARIANTS.map((v) => {
  const st = ST[v.id];
  return [v.label, ...rounds.map((i) => { const r = ab[v.id][i - 1]; return okRun(r) ? num(`run.r9-ab-${v.id}-${i}.warm`, r.warmPerGen, 2) : `exit ${r?.exit ?? '-'}`; }),
  ];
});
const abSum = VARIANTS.map((v) => [v.label, num(`ab.${v.id}.mean`, ST[v.id].mean, 2, { unit: ' s' }), num(`ab.${v.id}.spread`, ST[v.id].spread, 2, { unit: ' s' }), v.id === 'default' ? '' : delta(v.id)]);
const fullRows = VARIANTS.map((v) => {
  const r = full[v.id];
  if (!r) return [v.label, 'not run', '', '', ''];
  const end = fullEnd(v.id);
  return [v.label, r.exit === 0 ? num(`full.${v.id}.min`, fullWall(v.id) / 60, 2) : `exit ${r.exit}`, `${et(r.start)}-${end ? et(end) : '?'}`, num(`full.${v.id}.warm`, r.warmPerGen, 2), num(`full.${v.id}.gens`, r.gens, 0)];
});
const fullSame = (id) => {
  if (!full[id] || !full.default) return '<b class="bad">not run</b>';
  const c = compareRuns(full.default.dir, full[id].dir);
  return c.same ? `<b class="ok">identical</b> (${c.files} checkpoints)` : `<b class="bad">differ</b> (${c.differ.length} of ${c.files} checkpoints)`;
};

const ncuRow = (label, o, f, key, col) => ({ label, v: has(o) ? f(o) : null, why: has(o) ? null : 'no Nsight', key, col });
const metrics = [
  {
    name: 'Issue-slot use', unit: '%', healthy: { lo: 20, hi: 60 },
    what: 'share of cycles in which an SM starts an instruction.',
    ours: `${pct('ncu.5k.issue', n5.issue_slot_use_pct)} on the 5k launch: most cycles nothing is ready to run.`,
    means: 'warps are waiting, and there are too few of them to cover the wait.',
    rows: [ncuRow('5k default', n5, (o) => o.issue_slot_use_pct, 'ncu.5k.issue', COL.default), ncuRow('5k tail filler', vOn, (o) => o.issue_slot_use_pct, 'ncu.5kon.issue', COL.tail), ncuRow('10k default', n10, (o) => o.issue_slot_use_pct, 'ncu.10k.issue', COL.default), ncuRow('36k default', n36, (o) => o.issue_slot_use_pct, 'ncu.36k.issue', COL.default)],
  },
  {
    name: 'Achieved occupancy', unit: '%', healthy: { lo: 60 },
    what: 'warps loaded on an SM at once, as a share of the 48 it can hold.',
    ours: `${pct('ncu.5k.occ', n5.achieved_occupancy_pct)}: each thread needs so many registers (its fastest storage) that only 8 warps fit.`,
    means: 'with few warps, a wait on memory leaves the SM idle.',
    rows: [ncuRow('5k default', n5, (o) => o.achieved_occupancy_pct, 'ncu.5k.occ', COL.default), ncuRow('5k tail filler', vOn, (o) => o.achieved_occupancy_pct, 'ncu.5kon.occ', COL.tail), ncuRow('10k default', n10, (o) => o.achieved_occupancy_pct, 'ncu.10k.occ', COL.default), ncuRow('36k default', n36, (o) => o.achieved_occupancy_pct, 'ncu.36k.occ', COL.default)],
  },
  {
    name: 'Local memory share of L1 traffic', unit: '%', healthy: null,
    what: 'bytes of per-thread local memory (each battle\'s own state) among all bytes through L1, the small cache inside each SM.',
    ours: `${pct('ncu.5k.localshare', n5.local_share_of_l1_bytes_pct, 2)}, or ${num('ncu.5k.localgb', n5.local_bytes_gb, 0, { unit: ' GB' })} in a ${num('ncu.5k.kernel', n5.kernel_s_at_base_clock, 1, { unit: ' s' })} launch.`,
    means: 'battle state is the traffic; a smaller state means fewer bytes to wait for.',
    rows: [ncuRow('5k default', n5, (o) => o.local_share_of_l1_bytes_pct, 'ncu.5k.localshare', COL.default), ncuRow('5k tail filler', vOn, (o) => o.local_share_of_l1_bytes_pct, 'ncu.5kon.localshare', COL.tail), ncuRow('10k default', n10, (o) => o.local_share_of_l1_bytes_pct, 'ncu.10k.localshare', COL.default), ncuRow('36k default', n36, (o) => o.local_share_of_l1_bytes_pct, 'ncu.36k.localshare', COL.default)], dec: 2,
  },
  {
    name: 'L1 hit rate', unit: '%', healthy: null,
    what: 'share of L1 requests answered by L1, the small cache inside each SM.',
    ours: `${pct('ncu.5k.l1', n5.l1_hit_pct)}; each miss waits for L2, the larger cache all SMs share.`,
    means: 'each miss is a long wait (the "long scoreboard" stall).',
    rows: [ncuRow('5k default', n5, (o) => o.l1_hit_pct, 'ncu.5k.l1', COL.default), ncuRow('5k tail filler', vOn, (o) => o.l1_hit_pct, 'ncu.5kon.l1', COL.tail), ncuRow('10k default', n10, (o) => o.l1_hit_pct, 'ncu.10k.l1', COL.default), ncuRow('36k default', n36, (o) => o.l1_hit_pct, 'ncu.36k.l1', COL.default)],
  },
  {
    name: 'L2 hit rate', unit: '%', healthy: null,
    what: 'share of L2 requests answered by L2, the cache all SMs share.',
    ours: `${pct('ncu.5k.l2', n5.l2_hit_pct)}; the rest go to the GPU's main memory.`,
    means: 'a miss here waits longer still, for main memory.',
    rows: [ncuRow('5k default', n5, (o) => o.l2_hit_pct, 'ncu.5k.l2', COL.default), ncuRow('5k tail filler', vOn, (o) => o.l2_hit_pct, 'ncu.5kon.l2', COL.tail), ncuRow('10k default', n10, (o) => o.l2_hit_pct, 'ncu.10k.l2', COL.default), ncuRow('36k default', n36, (o) => o.l2_hit_pct, 'ncu.36k.l2', COL.default)],
  },
  {
    name: 'SM-active share', unit: '%', healthy: null,
    what: 'share of the launch in which an SM has a battle to run, averaged over the 68 SMs (from the replay\'s timing records).',
    ours: `default ${num('tl.10k.default.active', tl10.off?.sm_active_share_pct, 1, { unit: '%' })} on the 10k launch; the gap is the tail.`,
    means: 'the filler raises it; the launch time stays set by the longest battle.',
    rows: ['5k', '10k', '36k'].flatMap((l) => VARIANTS.map((v) => {
      const r = TL[l]?.[v.id === 'default' ? 'off' : v.id];
      return { label: `${l} ${v.label}`, v: r?.sm_active_share_pct ?? null, why: 'not run', key: `tl.${l}.${v.id}.active`, col: COL[v.id] };
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
  return svg(4 + st.length * 19 + 4, g, 'where warp cycles go, 5k launch');
};

const glossary = [
  ['GPU', 'the graphics card; here an RTX 3080 runs the battle simulator.'],
  ['SM', 'one of the GPU\'s 68 cores. Each runs several warps and switches between them.'],
  ['warp', '32 threads that run the same instruction together. Each thread runs one battle.'],
  ['launch', 'one batch of battles sent to the GPU. It ends when its last battle ends.'],
  ['halving round', 'one cut inside a generation: all teams fight a few opponents, the bottom half is cut, the rest go on.'],
  ['tail', 'the end of a launch, from when half its battles are done until the last one ends. SMs run out of work one by one.'],
  ['tail share', 'the tail\'s time as a share of a generation\'s time, summed over a run\'s warm generations.'],
  ['tail filler', 'POGO_GPU_STUDY=tail: idle SMs run the next round\'s likely battles early. Their results are only reused.'],
  ['certain feed', 'POGO_GPU_STUDY=tail,certain: adds next-round battles of teams already sure to pass the cut.'],
  ['cache hit rate', 'share of battles answered from saved results instead of simulated (a program cache, apart from L1 and L2).'],
  ['warm s/gen', 'mean seconds per generation from the saturation generation on, once the cache hit rate has levelled off.'],
  ['saturation generation', 'the first generation whose cache hit rate is within 2 points of the mean of the last 5 generations.'],
  ['spread', 'the slowest minus the fastest of a variant\'s A/B runs: the noise.'],
  ['A/B', 'the same 10-generation run for each variant, repeated in passes.'],
  ['pass', 'default, tail filler and certain feed, run back to back.'],
  ['stall', 'a cycle in which a warp has an instruction but cannot run it yet.'],
  ['long scoreboard', 'the stall where a warp waits for data from L1, L2 or main memory.'],
  ['local memory', 'per-thread memory in the GPU\'s main memory, cached in L1 and L2. Battle state lives there.'],
  ['L1, L2', 'caches: L1 is small and inside each SM, L2 is larger and shared by all SMs.'],
  ['Nsight Compute', 'NVIDIA\'s profiler; it reads the GPU\'s hardware counters.'],
  ['no Nsight', 'no profiler numbers for this launch (reasons below).'],
  ['no Nsight: 36k', 'the profiled run failed twice with "LaunchFailed (CUDA error 999)" and reset the display driver.'],
  ['no Nsight: 5k tail filler', 'its profiled replay failed with "LaunchFailed" (13:36 ET, before the fixes) and was not repeated.'],
  ['host', 'the CPU side of the program, which sends battles to the GPU and reads results.'],
  ['no Nsight: certain feed', 'the host feeds it while it runs; the profiler cannot replay that.'],
  ['generation', 'one step of the team search: new teams are made, then cut down in several halving rounds.'],
  ['checkpoint', 'the saved state of a run after each generation (evolve-genN.json).'],
  ['seed', 'the number that fixes every random choice of a run.'],
  ['CPU engine', 'pvpoke\'s battle code, run on the CPU: the reference the GPU must match.'],
  ['winner check', 'the same battles re-run on the CPU engine. A battle is flagged when the GPU result is invalid.'],
  ['5k, 10k launch', 'two real launches recorded in a round-8 run, of 4,788 and 10,920 battles.'],
  ['36k launch', 'the three launches of that run\'s generation 0 merged into one, 36,000 battles.'],
  ['replay', 'a recorded launch run again on its own, with timing records for every battle.'],
  ['tail kernel', 'the GPU program with the tail filler built in.'],
  ['pool', 'the next-round battles the filler may run early in a launch.'],
  ['SM-active share', 'the share of a launch in which an SM has a battle to run, averaged over the 68 SMs.'],
  ['late wait', 'time the next launch waits for the filler\'s unfinished early battles.'],
  ['round', 'short for halving round, except in "round 8" and "round 9".'],
  ['round 8, round 9', 'study rounds of this GPU work. Round 8 measured where the time goes; round 9 built the tail filler.'],
  ['lookahead', 'the search a battle runs to pick each move. A filler battle checks whether to stop between searches.'],
  ['stream', 'a GPU work queue. Work on one stream runs in order.'],
  ['registers', 'the fastest per-thread storage on an SM. A thread that needs many leaves room for fewer warps.'],
];

// ---------------------------------------------------------------- page
const tlCaption = `Replay of the 10k launch three ways through the tail kernel (tail-timeline.json, 19:44 ET).</p><p class="cap">The tail kernel is the GPU program with the filler built in. Its pool is a stand-in: the ${num('tl.10k.tail.pool', tl10.tail?.pool, 0)} battles of the 5k launch.`;
const ncuCaption = `First five cards: Nsight Compute runs of 2026-10-17 (summary.json): 5k at 10:37 ET, 10k at 10:50 ET.</p><p class="cap">The 10k run stopped at pass 25 of 42; its values come from passes 1-24.</p><p class="cap">The 36k launch (generation 0's three launches merged) has no Nsight.</p><p class="cap">SM-active share: replay timing records (tail-timeline.json).</p><p class="cap">Healthy ranges: <a href="https://docs.nvidia.com/nsight-compute/ComputeTriage/index.html">NVIDIA's Compute Triage guide</a>, as read in round 8.`;
const body = `
<header><h1>GPU round 9: filling the tail ⏱️</h1>
<p class="mut">Reference runs: ${esc(REF)} (r9-ab-*). A captioned table or chart uses the runs its caption names.</p></header>

<section id="summary"><h2>Summary 📌</h2><ol>${summary.map((x, i) => `<li id="s${i + 1}">${x}</li>`).join('')}</ol>
<p class="cap">Words in the summary:</p><ul class="cap"><li>default: the current code, both new flags off.</li><li>round: one cut inside a generation; the bottom half of the teams is dropped. The next round fights the rest.</li><li>launch: one batch of battles sent to the GPU. 5k and 10k are recorded launches of 4,788 and 10,920 battles.</li><li>tail filler: idle GPU cores run next-round battles early. Certain feed: adds battles of teams sure to pass.</li><li>SM: one of the GPU's 68 cores. Replay: a recorded launch run again alone, with timers.</li><li>warm: from the generation on which the share of battles answered from saved results levels off.</li><li>Nsight: NVIDIA's profiler. A warp is 32 battles run together.</li></ul></section>

<section id="built"><h2>What I built and what it gained 🔧</h2>
${sup(1, 2, 3)}
<p>A generation runs about ${num('ab.default.launches', mean(ST.default.runs.map((r) => r.gpuPerGen != null ? (rd(`${r.dir}/gpu-profile.json`)?.steps ?? []).filter((x) => x.gen !== 'final').reduce((a, x) => a + (x.launches?.length ?? 0), 0) / r.gens : 0)), 0)} GPU launches. Each ends with a tail: once half its battles are done, SMs run out of work one by one.</p>
<p>The tail filler gives idle SMs the next round's battles of the teams most likely to pass the cut.</p>
<p>A result is used only if the next round asks for that battle.</p>
<p>It starts once half of the launch's threads (one per battle) have no battle left (<code>POGO_GPU_TAIL_IDLE=0.5</code>, the default).</p>
<p>I picked 0.5 by hand and did not try other values.</p>
<p>The certain feed adds the battles of teams that are already sure to pass, sent into the running launch through a queue.</p>
<h3>Same results</h3>
<p>The 5-generation and winner checks ran 18:31-18:34 ET, just before the A/B (files det-r9.txt, verify3v3-tail*.log).</p>
<p>A checkpoint is a run's saved state after each generation. The seed fixes every random choice.</p>
<p>The winner check re-runs the battles on the CPU engine, pvpoke's own battle code.</p>
<ul>
<li>Checkpoints of a 5-generation run with the same seed: tail filler ${detOk('tail') ? '<b class="ok">identical</b>' : '<b class="bad">differ</b>'} to default, certain feed ${detOk('tail,certain') ? '<b class="ok">identical</b>' : '<b class="bad">differ</b>'}.</li>
<li>100-generation runs vs default: tail filler ${fullSame('tail')}, certain feed ${fullSame('certain')}.</li>
<li>Winner check against the CPU engine: tail filler ${verifyOk('tail') ? '<b class="ok">all agree, 0 flagged</b>' : '<b class="bad">failed</b>'}, certain feed ${verifyOk('tail-certain') ? '<b class="ok">all agree, 0 flagged</b>' : '<b class="bad">failed</b>'}.</li>
</ul>
<h3>Four bugs the runs found</h3>
<p>Runs failed or slowed down, so all four were fixed.</p>
<p>Every tail and certain-feed run on this page was made after the fixes, except the failed 5k profile.</p>
<p>Times and exits below are from r9chain.log and the fix commits (all ET, 2026-10-17).</p>
<p>A read of results could start before the launch's inputs were uploaded and return old values. It now waits for the uploads.</p>
<p>Unfinished early battles ran on past the launch end and slowed the next launch. </p>
<p>They now stop within one lookahead, the move search a battle runs each turn.</p>
<p>Both were fixed in the 13:49 commit.</p>
<p>The 100-generation tail and certain-feed runs before it failed (exit 1 at 13:17 and 13:35).</p>
<p>A new stream (GPU work queue) per launch blocked memory reuse. Late generations took up to 150 times as long.</p>
<p>Now one stream serves all (18:06 commit).</p>
<p>Before it, the 100-generation tail run took 134 min (14:26-16:39); after it, ${fullWall('tail') != null ? (fullWall('tail') / 60).toFixed(1) : '?'} min.</p>
<p>Timing records read while late battles ran could hold old bytes. The buffer is now cleared each launch (18:31 commit).</p>
<p>Before it, the third certain-feed A/B run crashed (exit 1 at 18:28).</p>
<p>The next launch waits for unfinished early battles (the late wait). In the A/B: ${num('ab.tail.latewait', ST.tail.runs.length ? mean(ST.tail.runs.map((r) => (r.tailLog?.lateWaitS ?? 0) / r.gens)) : null, 2, { unit: ' s' })} per generation with the tail filler.</p>
<h3>Time per generation</h3>
<p>${num('ab.rounds', rounds.length, 0)} passes, each running default, tail filler and certain feed back to back, 10 generations each.</p>
${table(['variant', ...rounds.map((i) => `pass ${i}`)], abRows, 'Warm seconds per generation, one run per pass')}
${table(['variant', 'mean', 'spread', 'vs default'], abSum, 'The same runs: mean, spread (slowest minus fastest) and change')}
<ul><li>${verdictLine('tail', vT)}</li><li>${verdictLine('certain', vC)}</li></ul>
<p class="mut">A change counts as a gain only if it is larger than both its own spread and the default's.</p>
<h3>Tail share</h3>
<p>Tail share is the tail's time as a share of generation time, over the warm generations.</p>
<p>A/B means: default ${tailPct('default')}, tail filler ${tailPct('tail')}, certain feed ${tailPct('certain')}.</p>
<p>The filler runs its battles in the tail. Why the share rises is not measured.</p>
<p>A pool is the set of next-round battles the filler may run. Per launch with a pool, the filler ran ${num('ab.tail.spec', TLg.tail.speculated / Math.max(1, TLg.tail.launches), 0)} battles early on average.</p>
<p>Of those, ${pct('ab.tail.keptpct', 100 * TLg.tail.kept / Math.max(1, TLg.tail.speculated), 0)} finished before the launch ended and ${pct('ab.tail.servedpct', 100 * TLg.tail.served / Math.max(1, TLg.tail.speculated), 0)} were later used.</p>
${timelinePicture('10k')}
<p class="cap">${tlCaption}</p>
<p class="more">More: <a href="gpu/study/detail/round9-runs.html">every round-9 run, log and count</a></p>
</section>

<section id="facts"><h2>Three facts that explain it 🔬</h2>
${sup(3, 4, 5)}
<h3>1. A launch ends with its longest battle</h3>
<p>The filler fills idle SMs, but it cannot make the longest battle finish sooner.</p>
<p>SM-active share is the share of a launch in which an SM has a battle to run.</p>
<p>Source: the round-9 replay of the 10k launch (19:44 ET).</p>
<p>There the filler raised it by ${num('tl.10k.activegain', activeGain, 1, { sign: true, unit: ' percentage points' })} and moved the launch end by ${num('tl.10k.spangain', spanGain, 2, { sign: true, unit: ' s' })}.</p>
<p class="more">More: <a href="gpu/study/detail/round8-time.html">round 8, where the time goes</a></p>
<h3>2. Each battle waits on its own memory</h3>
<p>A battle's state (teams, HP, energy, the lookahead tree) lives in local memory.</p>
<p>Local memory is each thread's own space in the GPU's main memory.</p>
<p>It is reached through L1, a small cache in each SM, and L2, a larger cache all SMs share.</p>
<p>Nsight Compute shows what that costs:</p>
${stallBars()}
<p class="cap">Where warp cycles go on the 5k launch (Nsight Compute run, 10:37 ET; summary.json).</p><p class="cap">A stall is a cycle in which a warp cannot run its next instruction yet.</p>
<ul class="cap"><li>long scoreboard: waiting on memory.</li><li>wait: a fixed pause after an instruction.</li><li>no instruction: the next instruction is not fetched yet.</li><li>selected: the cycle an instruction issues.</li><li>branch resolving: waiting for a jump target.</li></ul>
${metrics.map(metricCard).join('\n')}
<p class="cap">${ncuCaption}</p>
<h3>3. The 10-generation gain did not show in a 100-generation run</h3>
<p>The A/B runs 10 generations. A full run is 100.</p>
${table(['variant', 'wall min', 'ET', 'warm s/gen', 'gens'], fullRows, 'One full run each with the A/B\'s command and settings, 100 generations, after the A/B (r9-full-*). Default was rerun last.')}
<p class="cap">Wall min: run start to process exit, from the wall start and wall end lines of each log.</p>
<p class="cap">Full-run difference vs default: tail filler ${num('full.tail.dmin', fullD('tail'), 2, { sign: true, unit: ' min' })}, certain feed ${num('full.certain.dmin', fullD('certain'), 2, { sign: true, unit: ' min' })}.</p>
<p>The late wait in the 100-generation tail-filler run was ${num('full.tail.latewait', full.tail?.tailLog?.lateWaitS ?? null, 2, { unit: ' s' })} in total.</p>
<p>Each variant has one 100-generation run, so these differences have no noise measure. The filler did not save time in its run.</p>
</section>

<section id="todo"><h2>What to do 🚀</h2>
${sup(5)}
<ul>
<li>Run today with the default: <code>bash scripts/sim.sh &lt;csv&gt; --gpu</code> (its defaults).</li>
<li>Flag to try: <code>POGO_GPU_STUDY=stack</code> (smaller battle state, round 8).</li>
<li>Tail flags stay off: the tail filler's gain did not show in the 100-generation run (fact 3) and the certain feed had ${verdict('ab.certain.delta', vC.word)}.</li>
<li>Build next: cut more bytes from each battle's state, the source of fact 2's waits.</li>
</ul>
<p class="more">More: <a href="gpu/study/detail/round8-decide.html">round 8 candidate changes</a></p>
</section>

<section id="glossary"><h2>Glossary 📚</h2><dl class="gl">${glossary.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join('')}</dl>
<p class="more">More: <a href="gpu/study/detail/round8-background.html">round 8 sources and terms</a></p></section>

<footer><p class="mut" id="indep">${esc(txt(`${S}/review/footer.txt`).trim() || 'independent check: not run yet')}</p></footer>`;

const css = `:root{--link:#1f5fc4;--bg:#fff;--fg:#1d2330;--mut:#5b6577;--line:#d9dee7;--card:#f4f6f9;--ok:#157347;--bad:#b42318;--c0:#2f6fdb;--c1:#e0832a;--c2:#3aa676;--c4:#9aa3b2}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--link:#8ab4ff;--bg:#14171d;--fg:#e6e9ef;--mut:#9aa3b2;--line:#2c3340;--card:#1c2028;--ok:#4cc38a;--bad:#ff7b72;--c0:#6ea0ff;--c1:#f2a65a;--c2:#5ccf98;--c4:#6b7383}}
:root[data-theme="dark"]{--link:#8ab4ff;--bg:#14171d;--fg:#e6e9ef;--mut:#9aa3b2;--line:#2c3340;--card:#1c2028;--ok:#4cc38a;--bad:#ff7b72;--c0:#6ea0ff;--c1:#f2a65a;--c2:#5ccf98;--c4:#6b7383}
*{box-sizing:border-box}a{color:var(--link)}body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif,'Noto Color Emoji';margin:0 auto;max-width:720px;padding:16px}
h1{font-size:1.4rem;margin:.2rem 0 .4rem}h2{font-size:1.2rem;margin:2rem 0 .3rem;border-bottom:1px solid var(--line);padding-bottom:4px}h3{font-size:1.05rem;margin:1.3rem 0 .3rem}
p{margin:.4rem 0}ul,ol{padding-left:1.3rem;margin:.3rem 0}li{margin:.35rem 0}.mut,.cap{color:var(--mut)}.cap{font-size:13.5px}.na{color:var(--mut)}
code{font-size:.85em;background:var(--card);padding:1px 4px;border-radius:3px;word-break:break-word}
.more{font-size:14px}.sup{display:inline-block;font-size:13px;color:var(--mut);border:1px solid var(--line);border-radius:12px;padding:1px 9px;margin:.2rem 0}
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
