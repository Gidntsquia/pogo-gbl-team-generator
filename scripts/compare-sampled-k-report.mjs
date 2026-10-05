// Report for the fixed-K sampled-combats A/B (plans/PLAN.md round 2). Pure function of saved data
// (results.json + arm flags): `node scripts/compare-search.mjs report --dir out/sampled-k-ab` gives the
// same bytes every time. Writes exactly one file, out/sampled-k-ab.html (charts embedded as SVG data URIs).
// Statistics, arms and the stop rule: sampled-k-stats.mjs.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import * as R3 from './sampled-k-r3-stats.mjs';
import { mean, sd, t95, pairedRows, verdictAt, finalArm, finalSweep, allDecided, finishedSeeds, STOP_RULE, MIN_SEEDS, CAP_SEEDS, BUDGET_SECONDS, COST_TOLERANCE, CONTROL, IDEA_ARMS, SWEEPS } from './sampled-k-stats.mjs';

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const pts = (x, d = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}`;
const num = (s) => Number(s.slice(1));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hours = (s) => `${(s / 3600).toFixed(2)} h`;
const LABEL = { keep: 'KEEP', drop: 'DROP' };
const NAMES = {
  base: 'Control (today)',
  k10eq: 'Equal cost, K=10',
  o50: 'K=50, 200 cand x 50 opp',
  o500: 'K=50, 200 cand x 500 opp (big arm)',
  c40: 'K=50, 40 cand x 500 opp',
  c320: 'K=50, 320 cand x 500 opp',
};

const flagOf = (flags, name) => { const i = flags.indexOf(name); return i >= 0 ? flags[i + 1] : undefined; };
function armFlags(data, arm) {
  const own = data.armFlags[arm] ?? [];
  const over = new Set(own.filter((x) => x.startsWith('--')));
  const base = [];
  for (let i = 0; i < data.baseFlags.length; i++) {
    if (over.has(data.baseFlags[i])) { if (i + 1 < data.baseFlags.length && !data.baseFlags[i + 1].startsWith('--')) i++; continue; }
    base.push(data.baseFlags[i]);
  }
  return [...base, ...own];
}
const sizesOf = (data, a) => { const f = armFlags(data, a); return `${flagOf(f, '--population')} candidates / ${flagOf(f, '--opponents-per-gen')} opponents${flagOf(f, '--sampled-opponents') ? `, K=${flagOf(f, '--sampled-opponents')}` : ', no sampling'}`; };

const F = 'font-family="system-ui,Helvetica,Arial,sans-serif"';
const tx = (x, y, s, o = '') => `<text x="${x}" y="${y}" ${F} ${o.includes('font-size') ? '' : 'font-size="12" '}${o.includes('fill') ? '' : 'fill="#222" '}${o}>${esc(s)}</text>`;

/** Quality vs size: one point per size (mean with 95% range across seeds), control as a dashed line, cost per point. */
function sizeChart(title, xLabel, points, ctl) {
  const W = 760, H = 330, L = 70, R = 730, T = 60, B = 250;
  const all = [ctl.lo, ctl.hi, ...points.flatMap((p) => [p.lo, p.hi])];
  const lo = Math.floor((Math.min(...all) * 100 - 1) / 2) * 2, hi = Math.ceil((Math.max(...all) * 100 + 1) / 2) * 2;
  const y = (v) => B - ((v * 100 - lo) / (hi - lo)) * (B - T);
  const xs = points.map((_, k) => L + ((k + 0.5) / points.length) * (R - L));
  const o = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}"><rect width="${W}" height="${H}" fill="#fff"/>`, tx(L, 24, title, 'font-weight="600" font-size="14"')];
  for (let g = lo; g <= hi; g += 2) o.push(`<line x1="${L}" y1="${y(g / 100).toFixed(1)}" x2="${R}" y2="${y(g / 100).toFixed(1)}" stroke="#e5e7eb"/>`, tx(L - 8, (y(g / 100) + 4).toFixed(1), `${g}%`, 'text-anchor="end" font-size="11" fill="#666"'));
  o.push(`<rect x="${L}" y="${y(ctl.hi).toFixed(1)}" width="${R - L}" height="${(y(ctl.lo) - y(ctl.hi)).toFixed(1)}" fill="#9ca3af" opacity="0.25"/>`,
    `<line x1="${L}" y1="${y(ctl.m).toFixed(1)}" x2="${R}" y2="${y(ctl.m).toFixed(1)}" stroke="#374151" stroke-dasharray="5 4" stroke-width="2"/>`,
    tx(R - 4, (y(ctl.m) - 6).toFixed(1), `control ${pct(ctl.m)} (${ctl.cost})`, 'text-anchor="end" font-size="11" font-weight="600"'));
  points.forEach((p, k) => {
    const c = '#1d4ed8';
    o.push(`<line x1="${xs[k]}" y1="${y(p.lo).toFixed(1)}" x2="${xs[k]}" y2="${y(p.hi).toFixed(1)}" stroke="${c}" stroke-width="3"/>`,
      `<line x1="${xs[k] - 8}" y1="${y(p.lo).toFixed(1)}" x2="${xs[k] + 8}" y2="${y(p.lo).toFixed(1)}" stroke="${c}" stroke-width="3"/>`,
      `<line x1="${xs[k] - 8}" y1="${y(p.hi).toFixed(1)}" x2="${xs[k] + 8}" y2="${y(p.hi).toFixed(1)}" stroke="${c}" stroke-width="3"/>`,
      `<circle cx="${xs[k]}" cy="${y(p.m).toFixed(1)}" r="6" fill="${c}"/>`,
      tx(xs[k] + 14, (y(p.m) + 4).toFixed(1), pct(p.m), 'font-size="12" font-weight="700"'),
      tx(xs[k], B + 22, String(p.size), 'text-anchor="middle" font-size="13" font-weight="600"'),
      tx(xs[k], B + 40, `${p.cost} control cost`, 'text-anchor="middle" font-size="11" fill="#444"'));
  });
  o.push(tx((L + R) / 2, H - 14, xLabel, 'text-anchor="middle" font-size="12" fill="#444"'), '</svg>', '');
  return o.join('\n');
}
const img = (svg, alt) => `<img class="chart" alt="${esc(alt)}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`;
const table = (head, body) => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

const CSS = `:root{--bg:#fff;--fg:#1a1a1a;--mute:#5b6470;--line:#d9dee5;--acc:#1d4ed8;--card:#f5f7fa}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e8eaee;--mute:#9aa3af;--line:#2c323b;--acc:#7aa2ff;--card:#1b2027}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}h1{font-size:1.6rem;margin:0 0 4px}h2{font-size:1.2rem;margin:32px 0 8px;border-top:1px solid var(--line);padding-top:16px}h3{font-size:1rem;margin:20px 0 6px}
.verdict{font-size:1.1rem;font-weight:700;color:var(--acc)}.bottom{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px}
img.chart{width:100%;height:auto;background:#fff;border-radius:6px;border:1px solid var(--line)}figcaption,.mute{color:var(--mute);font-size:.9rem}
table{border-collapse:collapse;width:100%;font-size:.9rem;margin:8px 0}th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left}.scroll{overflow-x:auto}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px;overflow-x:auto;font-size:.8rem}code{font-family:ui-monospace,Menlo,monospace}`;

const armCell = (cells, a, seeds) => seeds.map((s) => cells.find((c) => c.arm === a && c.seed === s));
/** Mean of an arm's held-out quality with its 95% range across seeds. */
function qualityOf(cs) {
  const q = cs.map((c) => c.heldoutMeanTop), m = mean(q), h = q.length > 1 ? t95(q.length - 1) * sd(q) / Math.sqrt(q.length) : 0;
  return { m, lo: m - h, hi: m + h };
}


/** Round 3: the opponent sweep rerun after the determinism fix. Returns {bottom, section, headline}. */
function round3Block(data, r3) {
  const cells3 = r3.cells;
  const seeds = [...new Set(cells3.map((c) => c.seed))].sort((a, b) => num(a) - num(b));
  const n = R3.finishedSeeds(cells3, seeds);
  if (!n) return { bottom: '<p>No finished round-3 seeds yet.</p>', section: '' };
  const used = seeds.slice(0, n);
  const spent = R3.newSpent(cells3);
  const rnd = (sd) => (R3.seedNum(sd) > R3.R3_SEEDS ? 'round 4' : 'round 3');
  const swRows = pairedRows(cells3, seeds, R3.SMALL, R3.LARGE).slice(0, n);
  const v = verdictAt(swRows, n), d = R3.decisionAt(cells3, seeds, n);
  const answer = n >= MIN_SEEDS && d !== 'undecided' ? d.toUpperCase() : "CAN'T TELL";
  const width = (v.upper - v.lower) * 100;
  const stop = n >= MIN_SEEDS && d !== 'undecided' ? `the stop rule fired (${answer}) after seed ${n}` : n >= R3.CAP_SEEDS ? `the ${R3.CAP_SEEDS}-seed cap was reached with the rule unfired` : `the ${R3.BUDGET_SECONDS / 3600}-hour round-4 compute budget ended the run (${hours(spent)} spent on new cells) with the rule unfired`;
  const ctlCells = data.cells.filter((c) => c.arm === CONTROL);
  const armVs = (a) => { const rows = pairedRows([...ctlCells, ...cells3], seeds, CONTROL, a); return { rows, v: rows.length >= 2 ? verdictAt(rows, rows.length) : null }; };
  const vs = { o50: armVs('o50'), o500: armVs('o500') };
  const armLine = (a) => {
    const x = vs[a]; if (!x.v) return `<li>${esc(NAMES[a])}: too few seeds against the control.</li>`;
    const lab = x.v.verdict === 'unclear' ? (x.v.mean >= 0.01 ? 'KEEP (plain reading)' : 'DROP (plain reading)') : LABEL[x.v.verdict === 'keep' ? 'keep' : 'drop'];
    return `<li><b>${esc(NAMES[a])} vs control: ${lab}.</b> ${pts(x.v.mean)} points on the ${x.rows.length} seeds both have (95% range ${pts(x.v.lower)} to ${pts(x.v.upper)}, width ${((x.v.upper - x.v.lower) * 100).toFixed(1)}).</li>`;
  };
  const q = (a) => qualityOf(used.map((s) => cells3.find((c) => c.arm === a && c.seed === s)));
  const B = (a) => mean(used.map((s) => cells3.find((c) => c.arm === a && c.seed === s).genBattles));
  const ctlUsed = used.map((s) => ctlCells.find((c) => c.seed === s)).filter(Boolean);
  const cQ = qualityOf(ctlUsed), cB = mean(ctlUsed.map((c) => c.genBattles));
  const cost = (a) => `${(B(a) / cB).toFixed(1)}x`;
  const chart = sizeChart('Held-out quality vs opponent population (200 candidates, K=50; after the fix)', 'opponent pool size', [R3.SMALL, R3.LARGE].map((a, k) => ({ ...q(a), size: k ? 500 : 50, cost: cost(a) })), { ...cQ, cost: '1.0x' });
  const bottom = `<p class="verdict">More opponents (50 to 500): ${esc(answer)}.</p>
<p>Is held-out quality higher with 500 opponents than with 50? ${answer === 'YES' ? 'Yes' : answer === 'NO' ? 'No' : "Can't tell"}: 500 minus 50 is <b>${pts(v.mean)} points</b>, 95% range <b>${pts(v.lower)} to ${pts(v.upper)}</b>, width <b>${width.toFixed(1)} points</b> (round 2's width was 11.2 points on 5 seeds; round 3's was 6.2 on 8). The sweep answer uses a <b>+-2 point band</b> (NO if the whole range is inside +-2 points; widened in round 4; the other arms below keep +-1). Paired on <b>${n} seeds</b> (s1 to s${n}; s1-s${R3.R3_SEEDS} round 3, the rest round 4), all run after the determinism fix, ahead on ${v.wins} of ${n}. The run stopped because ${esc(stop)}.</p>
<p><b>Per arm vs control</b>, on the seeds both have (control cells are round 2's, run before the fix):</p><ul>${armLine('o50')}${armLine('o500')}</ul>
<p><b>Not rerun:</b> the equal-cost arm (K=10), the 40-candidate and 320-candidate arms and the candidate sweep are round 2's <b>5-seed results, produced before the determinism fix</b> (see section 3). Their numbers can change when rerun.</p>
<figure>${img(chart, 'Quality versus opponent population size, rerun after the fix')}<figcaption>Mean held-out quality (dot) with 95% range across ${n} seeds (bar) at 50 and 500 opponents; dashed line = control (round 2, pre-fix). Cost under each point.</figcaption></figure>`;
  const perSeed = table(['seed', 'round', 'control (round 2)', '50 opponents', '500 opponents', '500 minus 50 (pts)'], used.map((s) => {
    const a = cells3.find((c) => c.arm === R3.SMALL && c.seed === s), b = cells3.find((c) => c.arm === R3.LARGE && c.seed === s), c = ctlCells.find((x) => x.seed === s);
    return [s, rnd(s), c ? pct(c.heldoutMeanTop) : '-', pct(a.heldoutMeanTop), pct(b.heldoutMeanTop), pts(b.heldoutMeanTop - a.heldoutMeanTop)];
  }));
  const r2 = data.cells.filter((c) => c.arm === 'o50' || c.arm === 'o500');
  const r2Seeds = [...new Set(r2.map((c) => c.seed))].sort((a, b) => num(a) - num(b));
  const r2Rows = pairedRows(r2, r2Seeds, R3.SMALL, R3.LARGE), r2v = verdictAt(r2Rows, r2Rows.length);
  const oldTable = table(['seed', 'round 2, 50 opp (pre-fix)', 'round 2, 500 opp (pre-fix)', 'round 3, 50 opp', 'round 3, 500 opp'], r2Seeds.map((s) => {
    const g = (cs, a) => { const c = cs.find((x) => x.arm === a && x.seed === s); return c ? pct(c.heldoutMeanTop) : '-'; };
    return [s, g(r2, 'o50'), g(r2, 'o500'), g(cells3, 'o50'), g(cells3, 'o500')];
  }));
  const battles = table(['seed', '50 opp battles', '500 opp battles'], used.map((s) => [`${s} (${rnd(s)})`, cells3.find((c) => c.arm === R3.SMALL && c.seed === s).genBattles, cells3.find((c) => c.arm === R3.LARGE && c.seed === s).genBattles]));
  const section = `<h2>2. Rounds 3 and 4: opponent sweep after the determinism fix</h2>
<p><b>Why a rerun.</b> Round 2 could give different results for the same seed at different thread counts. Cause: pvpoke's scenario memo replayed cached lookaheads for form-changing Pokemon (Mimikyu, Cramorant, Aegislash, ...), which cannot restore the in-battle form change, so results depended on which battles a worker had already run. The memo now skips those Pokemon, and serial and threaded runs match (8-generation checks at 8 vs 1 threads). Round 2's numbers all came from the unfixed code.</p>
<p>Arms: 50 and 500 opponents, both K=50, 200 candidates, Halving R=3, 8 generations, held-out top-5 mean as before, seeds s1 to s${n}, threads 8, same flags as round 2. Round 3 ran s1-s${R3.R3_SEEDS} (the old s1 to s5 were rerun, not reused; round 2's cells are kept in <code>out/sampled-k-ab/results.json</code>); round 4 added s${R3.R3_SEEDS + 1} onward. Round-4 cells took ${hours(spent)} (limit ${R3.BUDGET_SECONDS / 3600} h).</p>
<div class="scroll">${table(['sweep', 'seeds', 'mean diff (pts)', '95% range (pts)', 'range width (pts)', '500 ahead on', 'answer'], [['50 to 500 opponents', String(n), pts(v.mean), `${pts(v.lower)} to ${pts(v.upper)}`, width.toFixed(1), `${v.wins} of ${n}`, answer]])}</div>
<h3>Held-out quality per seed (rounds 3 and 4)</h3><div class="scroll">${perSeed}</div>
<h3>Round 2 (pre-fix) next to round 3, same seeds</h3><p class="mute">Round 2's 500 minus 50 was ${pts(r2v.mean)} points (95% range ${pts(r2v.lower)} to ${pts(r2v.upper)}, width ${((r2v.upper - r2v.lower) * 100).toFixed(1)}) on ${r2Rows.length} seeds.</p><div class="scroll">${oldTable}</div>
<h3>Battles per seed (round 3)</h3><div class="scroll">${battles}</div>
<h3>Opponent-sweep stop rule (round 4, +-2 point band)</h3><p>${esc(R3.STOP_RULE)}</p>
<p>Rerun: <code>node scripts/sampled-k-r3-sweep.mjs</code> (resumable), then <code>node scripts/compare-search.mjs report --dir out/sampled-k-ab</code>.</p>`;
  return { bottom, section };
}

export function renderSampledKReport(data, outDir, round3) {
  const { top, heldoutCount, cells } = data;
  const seeds = [...new Set(cells.filter((c) => c.arm === CONTROL).map((c) => c.seed))].sort((a, b) => num(a) - num(b));
  const n = finishedSeeds(cells, seeds);
  const newSecs = cells.filter((c) => c.wallSeconds != null).reduce((s, c) => s + c.wallSeconds, 0);
  const ended = n >= CAP_SEEDS ? 'cap' : 'budget';
  let bottom = '<p>No finished seeds for all arms yet.</p>', body = '';
  if (n) {
    const used = seeds.slice(0, n);
    const cellsBy = Object.fromEntries([CONTROL, ...IDEA_ARMS].map((a) => [a, armCell(cells, a, used)]));
    const rowsBy = Object.fromEntries(IDEA_ARMS.map((a) => [a, pairedRows(cells, seeds, CONTROL, a).slice(0, n)]));
    const fin = Object.fromEntries(IDEA_ARMS.map((a) => [a, finalArm(rowsBy[a], n, ended)]));
    const swp = Object.fromEntries(SWEEPS.map((s) => [s.key, finalSweep(pairedRows(cells, seeds, s.small, s.large).slice(0, n), n)]));
    const B = (a) => mean(cellsBy[a].map((c) => c.genBattles)), S = (a) => mean(cellsBy[a].map((c) => c.genSeconds));
    const ratio = (a) => B(a) / B(CONTROL);
    const cQ = qualityOf(cellsBy[CONTROL]);
    const ratioTxt = (a) => `${ratio(a).toFixed(1)}x`;
    const ctlChart = (a) => ({ ...cQ, cost: '1.0x' , a });
    const wide = (a) => `${((fin[a].result.upper - fin[a].result.lower) * 100).toFixed(1)}`;
    const eqOk = Math.abs(ratio('k10eq') - 1) <= COST_TOLERANCE;

    const answerText = (s) => {
      const r = swp[s.key].result, ans = swp[s.key].answer;
      const diff = `${pts(r.mean)} points (95% range ${pts(r.lower)} to ${pts(r.upper)}, width ${((r.upper - r.lower) * 100).toFixed(1)}), at ${ratio(s.large) / ratio(s.small) < 1 ? '' : ''}${(B(s.large) / B(s.small)).toFixed(1)}x the battles of the smaller size`;
      return `<li><b>${esc(s.title)} (${s.smallSize} to ${s.largeSize} ${esc(s.unit)}): ${ans === "can't tell" ? "CAN'T TELL" : ans.toUpperCase()}</b> -- is quality higher at the larger size? ${diff}.</li>`;
    };
    const armLines = IDEA_ARMS.map((a) => {
      const r = fin[a].result;
      return `<li><b>${esc(NAMES[a])}: ${LABEL[fin[a].label]}.</b> ${pts(r.mean)} points vs control (95% range ${pts(r.lower)} to ${pts(r.upper)}, width ${wide(a)}) at ${ratioTxt(a)} the control's battles.</li>`;
    });
    const oppChart = sizeChart('Held-out quality vs opponent population (200 candidates, K=50)', 'opponent pool size', SWEEPS[0] && [SWEEPS[0].small, SWEEPS[0].large].map((a, k) => ({ ...qualityOf(cellsBy[a]), size: k ? SWEEPS[0].largeSize : SWEEPS[0].smallSize, cost: ratioTxt(a) })), { ...cQ, cost: '1.0x' });
    const candChart = sizeChart('Held-out quality vs candidate population (500 opponents, K=50)', 'candidate population size', [SWEEPS[1].small, SWEEPS[1].large].map((a, k) => ({ ...qualityOf(cellsBy[a]), size: k ? SWEEPS[1].largeSize : SWEEPS[1].smallSize, cost: ratioTxt(a) })), { ...cQ, cost: '1.0x' });
    const yes = (k) => swp[k].answer;
    const headline = `More opponents: ${yes('opponents') === "can't tell" ? "can't tell" : yes('opponents')}. More candidates: ${yes('candidates') === "can't tell" ? "can't tell" : yes('candidates')}.`;
    bottom = `<p class="verdict">${esc(headline)}</p>
<ul>${SWEEPS.map(answerText).join('\n')}</ul>
<p><b>Per arm vs control</b> (paired on the same ${n} seeds):</p>
<ul>${armLines.join('\n')}</ul>
<p>Control is today's default (${esc(sizesOf(data, CONTROL))}, Halving R=3): ${B(CONTROL).toFixed(0)} battles and ${S(CONTROL).toFixed(0)} s per run, held-out quality ${pct(cQ.m)}. The equal-cost arm's mean battles are ${ratioTxt('k10eq')} the control's (${eqOk ? 'within' : 'OUTSIDE'} the ${COST_TOLERANCE * 100}% band). Sweep arms cost more by design; the multiple is shown on every line and chart point.</p>
<figure>${img(oppChart, 'Quality versus opponent population size with control marked')}<figcaption>Mean held-out quality (dot) with its 95% range across seeds (bar) at 50 and 500 opponents; dashed line and grey band = control. Cost under each point.</figcaption></figure>
<figure>${img(candChart, 'Quality versus candidate population size with control marked')}<figcaption>Same at 40 and 320 candidates. Cost under each point.</figcaption></figure>`;

    const rowFor = (a) => {
      const r = fin[a].result, q = qualityOf(cellsBy[a]);
      return [NAMES[a], sizesOf(data, a), `${B(a).toFixed(0)} (${ratioTxt(a)})`, `${S(a).toFixed(0)} s`, `${pct(q.m)} (${pct(q.lo)} to ${pct(q.hi)})`, `${pts(r.mean)} (${pts(r.lower)} to ${pts(r.upper)}), width ${wide(a)}`, `${r.wins} of ${r.n}`, LABEL[fin[a].label]];
    };
    const perSeed = table(['seed', 'control', ...IDEA_ARMS.map((a) => NAMES[a])], used.map((s, k) => [s, ...[CONTROL, ...IDEA_ARMS].map((a) => pct(cellsBy[a][k].heldoutMeanTop))]));
    const perSeedBattles = table(['seed', 'control', ...IDEA_ARMS.map((a) => NAMES[a])], used.map((s, k) => [s, ...[CONTROL, ...IDEA_ARMS].map((a) => cellsBy[a][k].genBattles)]));
    const sweepRows = SWEEPS.map((s) => { const r = swp[s.key].result; return [s.title, `${s.smallSize} -> ${s.largeSize}`, `${pts(r.mean)}`, `${pts(r.lower)} to ${pts(r.upper)}`, `${((r.upper - r.lower) * 100).toFixed(1)}`, `${r.wins} of ${r.n}`, swp[s.key].answer]; });
    const decided = allDecided(cells, seeds);
    const cellCmd = (a) => `node scripts/evolve.mjs out/sampled-k-ab/meta-collection-1500.csv --seed <seed> ${armFlags(data, a).join(' ')} --out-dir out/sampled-k-ab/${a}-<seed> --force-fresh`;
    const runCmds = ['bash scripts/setup.sh', 'node scripts/sampled-k-overnight.mjs --dir out/sampled-k-ab   # unattended driver under the stop rule; rerun to resume',
      `node scripts/compare-search.mjs run --dir out/sampled-k-ab --arms ${[CONTROL, ...IDEA_ARMS].join(',')} --seeds ${seeds.join(',')} --top ${top ?? 5} --heldout ${heldoutCount ?? 60}`,
      'node scripts/compare-search.mjs report --dir out/sampled-k-ab   # from saved results: same numbers, writes out/sampled-k-ab.html'];

    const blk = round3 ? round3Block(data, round3) : null;
    body = `<h2>1. What fixed-K sampling does</h2>
<p>Today every generation every candidate team battles every team in the opponent pool, so cost grows with candidates x opponents. <b>Fixed-K sampling</b> caps that: each candidate fights only K opponents, whatever the pool sizes. The opponent pool is split at random into ceil(opponents / K) blocks of at most K, the candidates into the same number of groups, and each group fights one block. Every candidate fights about K opponents, and every opponent is fought by a group of candidates, so nobody ends a generation without a fitness. Sequential Halving (R=3) runs inside each group's block. If K is at least the opponent pool, everyone fights everyone (that is the 50-opponent arm).</p>
<p><b>What bigger sizes buy.</b> A candidate measured against only K opponents is scored less precisely, but the pools can grow without the cost growing with them: more candidates search more of the collection, and more opponents make each generation's opponent sample more varied. Cost per generation is about candidates x K, not candidates x opponents.</p>
<p>The sweep arms keep their sizes literal for the whole run (<code>--population-final-ratio 1</code>: no shrinking of the candidate population while the opponent pool grows), so "40 candidates" means 40 all run long. The control keeps today's default schedule (40 candidates shrinking to 16 while opponents grow from 30).</p>
${blk ? blk.section : ''}
<h2>3. Round 2 numbers (5 seeds, all six arms, before the determinism fix)</h2>
${round3 ? `<div class="bottom">${bottom}</div>` : ''}
<p>Quality is the mean win rate (both seats) of each run's top ${top} finalists against ${heldoutCount} fresh meta teams that no search fought. Short cells: ${esc(flagOf(armFlags(data, CONTROL), '--generations'))} generations, meta mode. ${decided ? 'The stop rule fired for every arm and both sweeps.' : `The ${ended === 'cap' ? 'seed cap' : 'compute budget'} ended the run at ${n} seeds before the rule fired for everything; undecided arms got the plain reading and undecided sweeps are "can't tell".`}</p>
<div class="scroll">${table(['arm', 'sizes', 'battles per run', 'wall per run', 'held-out quality (95% range)', 'vs control, pts (95% range)', 'ahead on', 'verdict'], [[NAMES[CONTROL], sizesOf(data, CONTROL), `${B(CONTROL).toFixed(0)} (1.0x)`, `${S(CONTROL).toFixed(0)} s`, `${pct(cQ.m)} (${pct(cQ.lo)} to ${pct(cQ.hi)})`, '', '', ''], ...IDEA_ARMS.map(rowFor)])}</div>
<h3>Sweeps: larger minus smaller size (paired on seeds)</h3>
<div class="scroll">${table(['sweep', 'size', 'mean diff (pts)', '95% range (pts)', 'range width (pts)', 'larger ahead on', 'higher at larger size?'], sweepRows)}</div>
<h3>Held-out quality per seed</h3><div class="scroll">${perSeed}</div>
<h3>Battles per seed</h3><div class="scroll">${perSeedBattles}</div>
<h2>Appendix</h2>
<h3>Stop rule</h3><p>${esc(STOP_RULE)}</p>
<h3>Cost and rerun</h3><p>New runs took ${hours(newSecs)} of the ${hours(BUDGET_SECONDS)} compute budget (including held-out scoring).</p>
<pre><code>${esc(runCmds.join('\n'))}</code></pre>
<p>Short cells:</p><pre><code>${esc([CONTROL, ...IDEA_ARMS].map((a) => `# ${a}\n${cellCmd(a)}`).join('\n'))}</code></pre>`;
  } else {
    body = `<h2>Appendix</h2><p>${esc(STOP_RULE)}</p>`;
  }
  if (round3 && n) bottom = round3Block(data, round3).bottom;
  const file = path.join(outDir, 'sampled-k-ab.html');
  writeFileSync(file, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixed-K Sampled Combats</title><style>${CSS}</style></head><body><main><h1>Fixed-K sampled combats: do bigger populations help? (experimental)</h1><h2 style="border:0;margin-top:8px">Bottom line</h2><div class="bottom">${bottom}</div>${body}</main></body></html>\n`);
  console.log(`wrote ${file}`);
}
