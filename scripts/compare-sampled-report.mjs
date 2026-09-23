// Report for the sampled-combats A/B (control = today's default search, Halving R=3, no sampling;
// four idea arms = sampled 1/2 and 1/4, each with Halving off and on, sizes raised to hold the
// cost). Pure function of saved data (results.json and each cell's evolve-result.json): rerun
// `node scripts/compare-search.mjs report --dir out/sampled-ab` and the same bytes come out.
// Writes exactly one file, out/sampled-ab.html, chart embedded as a data-URI image.
// Statistics and the stop rule: sampled-stats.mjs.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { mean, pairedRows, checkpoints, verdictAt, finalReading, allDecided, BATCH, CAP_SEEDS, BAND, CAP_KEEP_GAIN, BUDGET_SECONDS, COST_TOLERANCE, CONTROL, IDEA_ARMS } from './sampled-stats.mjs';

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const pts = (x, d = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}`;
const num = (s) => Number(s.slice(1));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hours = (s) => `${(s / 3600).toFixed(2)} h`;
const LABEL = { keep: 'KEEP', drop: 'DROP', 'no meaningful difference': 'NO MEANINGFUL DIFFERENCE (counts as drop)' };
const NAMES = {
  s2h0: 'Sample 1/2, Halving off',
  s2h3: 'Sample 1/2, Halving on',
  s4h0: 'Sample 1/4, Halving off',
  s4h3: 'Sample 1/4, Halving on',
};

export const STOP_RULE = `Stop rule (fixed before any seed ran, not tuned afterwards). Control: today's default, Sequential Halving R=3, no sampling. Each of the four idea arms is judged separately against it on the same seeds, and is sized so its mean battles per run is within ${COST_TOLERANCE * 100}% of the control's, so the only question is quality. After every batch of ${BATCH} seeds (${BATCH}, ${2 * BATCH}, ... up to ${CAP_SEEDS}), take the 95% range of the paired held-out quality difference (arm minus control, Student t). KEEP if the whole range is above 0. DROP if the whole range is below 0. NO MEANINGFUL DIFFERENCE (counts as drop) if the whole range is inside +-${BAND * 100} point. Otherwise add another batch. All five arms run each seed; the run stops when every arm has a verdict, at ${CAP_SEEDS} seeds, or when the ${BUDGET_SECONDS / 3600}-hour compute budget cannot fit another seed. An arm still undecided then gets a plain reading: KEEP only if its mean gain is at least +${CAP_KEEP_GAIN * 100} point, else DROP.`;

const flagOf = (flags, name) => { const i = flags.indexOf(name); return i >= 0 ? flags[i + 1] : undefined; };
/** Effective flags of an arm: BASE_FLAGS with the arm's own values replacing any it also sets, then the arm's flags. */
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

function chartSvg(items, nSeeds) {
  const F = 'font-family="system-ui,Helvetica,Arial,sans-serif"';
  const rowH = 44, top = 70, W = 760, H = top + items.length * rowH + 40;
  const t = (x, y, s, o = '') => `<text x="${x}" y="${y}" ${F} ${o.includes('font-size') ? '' : 'font-size="12" '}${o.includes('fill') ? '' : 'fill="#222" '}${o}>${s}</text>`;
  const x1 = (v) => 200 + (Math.min(1.5, Math.max(0.5, v)) - 0.5) * 180; // battle ratio 0.5..1.5 -> 200..380
  const x2 = (v) => 470 + ((Math.min(6, Math.max(-6, v)) + 6) / 12) * 270; // points -6..+6 -> 470..740
  const o = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Sampled combats vs Halving: cost and quality per arm">`,
    `<rect width="${W}" height="${H}" fill="#fff"/>`,
    t(200, 24, 'Cost: battles per run, control = 1.00', 'font-weight="600"'),
    t(470, 24, 'Quality vs control (points), 95% range', 'font-weight="600"'),
    `<line x1="${x1(1)}" y1="${top - 14}" x2="${x1(1)}" y2="${top + items.length * rowH - 10}" stroke="#888" stroke-dasharray="3 3"/>`, t(x1(1), top - 20, '1.00', 'text-anchor="middle" font-size="11"'),
    `<line x1="${x2(0)}" y1="${top - 14}" x2="${x2(0)}" y2="${top + items.length * rowH - 10}" stroke="#888" stroke-dasharray="3 3"/>`, t(x2(0), top - 20, 'equal', 'text-anchor="middle" font-size="11"')];
  items.forEach((it, k) => {
    const y = top + k * rowH + 14;
    const c = it.label === 'keep' ? '#15803d' : '#c2410c';
    o.push(t(8, y + 4, esc(it.name), 'font-size="12" font-weight="600"'));
    o.push(`<rect x="${x1(0.5)}" y="${y - 10}" width="${(x1(it.r.battleRatio) - x1(0.5)).toFixed(1)}" height="20" fill="#1d4ed8"/>`);
    o.push(t(x1(it.r.battleRatio) + 6, y + 4, it.r.battleRatio.toFixed(2), 'font-size="12" font-weight="700"'));
    const lo = it.r.lower * 100, hi = it.r.upper * 100, m = it.r.mean * 100;
    o.push(`<line x1="${x2(lo).toFixed(1)}" y1="${y}" x2="${x2(hi).toFixed(1)}" y2="${y}" stroke="${c}" stroke-width="3"/>`);
    o.push(`<circle cx="${x2(m).toFixed(1)}" cy="${y}" r="6" fill="${c}"/>`);
    o.push(t(x2(m).toFixed(1), y - 10, `${m >= 0 ? '+' : ''}${m.toFixed(1)} ${it.label === 'keep' ? 'KEEP' : 'DROP'}`, 'text-anchor="middle" font-size="11" font-weight="700"'));
  });
  o.push(t(8, H - 12, `${nSeeds} seeds, same seeds for every arm`, 'font-size="11"'), '</svg>', '');
  return o.join('\n');
}

const table = (head, body) => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

const CSS = `:root{--bg:#fff;--fg:#1a1a1a;--mute:#5b6470;--line:#d9dee5;--acc:#1d4ed8;--card:#f5f7fa}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e8eaee;--mute:#9aa3af;--line:#2c323b;--acc:#7aa2ff;--card:#1b2027}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}h1{font-size:1.6rem;margin:0 0 4px}h2{font-size:1.2rem;margin:32px 0 8px;border-top:1px solid var(--line);padding-top:16px}h3{font-size:1rem;margin:20px 0 6px}
.verdict{font-size:1.1rem;font-weight:700;color:var(--acc)}.bottom{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px}
img.chart{width:100%;height:auto;background:#fff;border-radius:6px;border:1px solid var(--line)}figcaption,.mute{color:var(--mute);font-size:.9rem}
table{border-collapse:collapse;width:100%;font-size:.9rem;margin:8px 0}th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left}.scroll{overflow-x:auto}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px;overflow-x:auto;font-size:.8rem}code{font-family:ui-monospace,Menlo,monospace}`;

export function renderSampledReport(data, outDir) {
  const { top, heldoutCount, cells } = data;
  const seeds = [...new Set(cells.filter((c) => c.arm === CONTROL).map((c) => c.seed))].sort((a, b) => num(a) - num(b));
  const rowsBy = Object.fromEntries(IDEA_ARMS.map((a) => [a, pairedRows(cells, seeds, CONTROL, a)]));
  const n = Math.min(...IDEA_ARMS.map((a) => rowsBy[a].length));
  const newSecs = cells.filter((c) => c.wallSeconds != null).reduce((s, c) => s + c.wallSeconds, 0);
  const ended = n >= CAP_SEEDS ? 'cap' : 'budget';
  let bottom = '<p>No finished seeds for all arms yet.</p>';
  let body = '';

  if (n) {
    const rowsN = Object.fromEntries(IDEA_ARMS.map((a) => [a, rowsBy[a].slice(0, n)]));
    const fin = Object.fromEntries(IDEA_ARMS.map((a) => [a, finalReading(rowsN[a], ended)]));
    const ctlRows = rowsN[IDEA_ARMS[0]];
    const cB = mean(ctlRows.map((x) => x.c.genBattles)), cS = mean(ctlRows.map((x) => x.c.genSeconds));
    const cQ = mean(ctlRows.map((x) => x.c.heldoutMeanTop));
    const sizes = (a) => { const f = armFlags(data, a); return `${flagOf(f, '--population')} teams / ${flagOf(f, '--opponents-per-gen')} opponents`; };
    const ctlSizes = sizes(CONTROL);
    const summaryRows = IDEA_ARMS.map((a) => {
      const r = fin[a].result;
      const iB = mean(rowsN[a].map((x) => x.i.genBattles));
      return [NAMES[a], sizes(a), `${iB.toFixed(0)} (${r.battleRatio.toFixed(2)}x)`, pct(mean(rowsN[a].map((x) => x.i.heldoutMeanTop))), `${pts(r.mean)}  (${pts(r.lower)} to ${pts(r.upper)})`, `${r.wins} of ${r.n}`, LABEL[fin[a].label]];
    });
    const lines = IDEA_ARMS.map((a) => {
      const r = fin[a].result;
      return `<li><b>${esc(NAMES[a])}: ${LABEL[fin[a].label]}.</b> ${pts(r.mean)} points held-out quality (95% range ${pts(r.lower)} to ${pts(r.upper)}) for ${r.battleRatio.toFixed(2)}x the control's battles.</li>`;
    });
    const anyKeep = IDEA_ARMS.some((a) => fin[a].label === 'keep');
    bottom = `<p class="verdict">${anyKeep ? 'At least one arm earns KEEP.' : 'All four arms: DROP. Sampling with bigger sizes did not find better teams at the same cost.'}</p>
<ul>${lines.join('\n')}</ul>
<p>Control is today's default (${esc(ctlSizes)}, Halving R=3): ${cB.toFixed(0)} battles and ${cS.toFixed(0)} s per run, held-out quality ${pct(cQ)}. Each arm was sized to fight within ${COST_TOLERANCE * 100}% of that. ${n} seeds, same seeds for every arm.</p>
<figure><img class="chart" alt="Per arm: battles per run relative to control, and held-out quality difference with its 95% range" src="data:image/svg+xml;base64,${Buffer.from(chartSvg(IDEA_ARMS.map((a) => ({ name: NAMES[a], r: fin[a].result, label: fin[a].label })), n)).toString('base64')}"><figcaption>Left: battles per run relative to control (1.00 = same cost). Right: held-out quality difference from control (dot) with the 95% range (line); green = KEEP, orange = DROP.</figcaption></figure>`;

    const perSeed = table(['seed', 'control quality', ...IDEA_ARMS.map((a) => `${NAMES[a]} (diff, pts)`)],
      ctlRows.map((x, k) => [x.seed, pct(x.c.heldoutMeanTop), ...IDEA_ARMS.map((a) => { const y = rowsN[a][k]; return `${pct(y.i.heldoutMeanTop)} (${pts(y.i.heldoutMeanTop - y.c.heldoutMeanTop)})`; })]));
    const perSeedBattles = table(['seed', 'control battles', ...IDEA_ARMS.map((a) => `${NAMES[a]} battles`)],
      ctlRows.map((x, k) => [x.seed, x.c.genBattles, ...IDEA_ARMS.map((a) => rowsN[a][k].i.genBattles)]));
    const cp = table(['arm', 'seeds', 'mean diff (pts)', '95% range (pts)', 'battle ratio', 'reading'],
      IDEA_ARMS.flatMap((a) => checkpoints(n).map((k) => { const v = verdictAt(rowsN[a], k); return [NAMES[a], k, pts(v.mean), `${pts(v.lower)} to ${pts(v.upper)}`, v.battleRatio.toFixed(2), v.verdict]; })));
    const decided = allDecided(cells, seeds);
    const cellCmd = (a) => `node scripts/evolve.mjs out/sampled-ab/meta-collection-1500.csv --seed <seed> ${armFlags(data, a).join(' ')} --out-dir out/sampled-ab/${a}-<seed> --force-fresh`;
    const runCmds = ['bash scripts/setup.sh', 'node scripts/sampled-overnight.mjs --dir out/sampled-ab   # unattended driver under the stop rule; rerun to resume',
      `node scripts/compare-search.mjs run --dir out/sampled-ab --arms ${[CONTROL, ...IDEA_ARMS].join(',')} --seeds ${seeds.join(',')} --top ${top ?? 5} --heldout ${heldoutCount ?? 60}`,
      'node scripts/compare-search.mjs report --dir out/sampled-ab   # from saved results: same numbers, writes out/sampled-ab.html'];

    body = `<h2>1. What sampled combats does</h2>
<p>Today, every generation, every candidate team battles every team in the opponent pool. Sequential Halving (the default) cuts the weaker half of the candidates partway, so cut teams skip many battles, but the survivors still fight the whole pool.</p>
<p><b>Sampled combats</b> gives each candidate only a random share of the opponents: a half or a quarter. The opponent pool is split at random into 2 (or 4) blocks, the candidates into 2 (or 4) groups, and each group fights one block. Every candidate meets a random 1/2 (or 1/4) of the opponents, and every opponent is fought by the matching share of the candidates, so nobody ends a generation without a fitness. With Halving on, each group halves within its own block, so a candidate's slices come from its own sample.</p>
<p><b>What the bigger sizes buy.</b> A candidate that fights fewer opponents is measured less precisely, but the battles saved can be spent on more candidates (a wider search of the collection) and more opponents (a more varied meta to be measured against). Each arm's population and opponents-per-generation were raised or lowered by the same factor so its total cost stayed within ${COST_TOLERANCE * 100}% of the control's; the question is whether wider-but-noisier beats narrower-but-exact.</p>
<p>Two arms ran without Halving. Halving already cuts the control to roughly 42% of the full grid, so sampling half of the full grid costs more than the control at the control's sizes; those arms' sizes were scaled to land within the ${COST_TOLERANCE * 100}% cost band, which is why the 1/2, Halving-off arm's sizes are ${sizes('s2h0') === ctlSizes ? 'the same as' : 'not larger than'} the control's.</p>
<h2>2. Numbers</h2>
<p>Quality is the mean win rate (both seats) of each run's top ${top} finalists against ${heldoutCount} fresh meta teams that no search fought. Short cells: ${esc(flagOf(armFlags(data, CONTROL), '--generations'))} generations, meta mode. ${decided ? 'The stop rule fired for every arm.' : `The compute budget or cap ended the run at ${n} seeds before the rule fired for every arm; undecided arms got the plain reading.`}</p>
<div class="scroll">${table(['arm', 'sizes', 'battles per run', 'held-out quality', 'quality vs control, pts (95% range)', 'ahead on', 'verdict'], [[ 'Control (Halving R=3)', ctlSizes, `${cB.toFixed(0)} (1.00x)`, pct(cQ), '', '', ''], ...summaryRows])}</div>
<p class="mute">Wall time per run: control ${cS.toFixed(0)} s; ${IDEA_ARMS.map((a) => `${NAMES[a]} ${mean(rowsN[a].map((x) => x.i.genSeconds)).toFixed(0)} s`).join('; ')}.</p>
<h3>Held-out quality per seed</h3><div class="scroll">${perSeed}</div>
<h3>Battles per seed</h3><div class="scroll">${perSeedBattles}</div>
<h2>Appendix</h2>
<h3>Stop rule and checkpoints</h3><p>${esc(STOP_RULE)}</p><div class="scroll">${cp}</div>
<h3>Cost and rerun</h3><p>New runs took ${hours(newSecs)} of the ${hours(BUDGET_SECONDS)} compute budget (including held-out scoring).</p>
<pre><code>${esc(runCmds.join('\n'))}</code></pre>
<p>Short cells:</p><pre><code>${esc([CONTROL, ...IDEA_ARMS].map((a) => `# ${a}\n${cellCmd(a)}`).join('\n'))}</code></pre>`;
  } else {
    body = `<h2>Appendix</h2><p>${esc(STOP_RULE)}</p>`;
  }
  const file = path.join(outDir, 'sampled-ab.html');
  writeFileSync(file, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sampled Combats vs Halving</title><style>${CSS}</style></head><body><main><h1>Sampled combats vs Sequential Halving (experimental)</h1><h2 style="border:0;margin-top:8px">Bottom line</h2><div class="bottom">${bottom}</div>${body}</main></body></html>\n`);
  console.log(`wrote ${file}`);
}
