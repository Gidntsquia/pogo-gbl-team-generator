// Animated line chart of the top teams' win rates across an evolve run.
//
// Usage:
//   node scripts/chart-top-teams.mjs <out-dir> [--top N] [--out PATH]
//
// <out-dir> is a scripts/evolve.mjs checkpoint directory. The teams charted
// are the top N of evolve-ranking.json (the final weighted elites ranking)
// when it exists, else the last generation's top N by fitness. Each team's
// line is its RAW per-generation win rate (winRateBySignature), with gaps for
// generations the team was not alive. Output is one self-contained HTML file
// (inline SVG + JS, opens via file://) with play/pause and a scrubber.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const PALETTE = [
  '#e6194b', '#3c78d8', '#3cb44b', '#ff8c00', '#911eb4',
  '#00a8a8', '#b8860b', '#f032e6', '#7f8c1f', '#800000',
];

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function teamSignature(team) {
  return `${team[0]}||${[...team.slice(1)].sort().join('|')}`;
}

/**
 * Collect the chart's data from a checkpoint directory: which teams to trace
 * (final ranking when available) and each one's per-generation win rate.
 *
 * @param {string} outDir - evolve checkpoint directory.
 * @param {number} topCount - how many teams to trace.
 * @returns {{teams: Array<{name: string, rank: number, series: Array<number|null>}>,
 *   generations: number}} series[g] is the team's gen-g win rate or null.
 */
export function collectTopTeamSeries(outDir, topCount) {
  const checkpoints = [];
  for (let g = 0; ; g += 1) {
    const p = path.join(outDir, `evolve-gen${g}.json`);
    if (!existsSync(p)) break;
    const cp = readJson(p);
    checkpoints.push({
      winRateBySignature: cp.winRateBySignature ?? {},
      topTeams: cp.analytics?.topTeams ?? [],
      fitness: cp.fitness ?? [],
      population: cp.population ?? [],
    });
  }
  if (checkpoints.length === 0) {
    throw new Error(`no evolve-gen*.json checkpoints found in ${outDir}`);
  }

  let tracked;
  const rankingPath = path.join(outDir, 'evolve-ranking.json');
  if (existsSync(rankingPath)) {
    tracked = readJson(rankingPath)
      .slice(0, topCount)
      .map((e) => ({ name: e.name, rank: e.rank, signature: e.signature }));
  } else {
    // Fallback for a dir whose run predates evolve-ranking.json: the last
    // generation's top teams by fitness (analytics.topTeams carries names).
    const last = checkpoints[checkpoints.length - 1];
    tracked = last.topTeams.slice(0, topCount).map((t) => ({
      name: t.members.map((m) => m.name).join(' / '),
      rank: t.rank,
      signature: teamSignature(t.members.map((m) => m.key)),
    }));
  }
  if (tracked.length === 0) throw new Error(`no teams to trace in ${outDir}`);

  const teams = tracked.map((t) => ({
    name: t.name,
    rank: t.rank,
    series: checkpoints.map((cp) => cp.winRateBySignature[t.signature] ?? null),
  }));
  return { teams, generations: checkpoints.length };
}

/**
 * Render the collected series as a self-contained animated HTML page.
 *
 * @param {{teams: Array<{name: string, rank: number, series: Array<number|null>}>,
 *   generations: number}} data - from collectTopTeamSeries.
 * @param {string} title - page heading.
 * @returns {string} HTML document text.
 */
export function renderChartHtml(data, title) {
  const payload = JSON.stringify({
    generations: data.generations,
    teams: data.teams.map((t, i) => ({
      name: t.name,
      rank: t.rank,
      color: PALETTE[i % PALETTE.length],
      series: t.series.map((v) => (v === null ? null : Math.round(v * 1000) / 1000)),
    })),
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 62rem; margin: 0 auto; padding: 1.5rem; }
  h1 { font-size: 1.3rem; line-height: 1.25; }
  svg { width: 100%; height: auto; }
  .axis line, .axis path { stroke: rgba(127,127,127,0.5); }
  .grid { stroke: rgba(127,127,127,0.18); }
  text { fill: currentColor; font-size: 12px; }
  .controls { display: flex; gap: 0.75rem; align-items: center; margin: 0.5rem 0 1rem; }
  .controls input[type=range] { flex: 1; }
  button { font: inherit; padding: 0.25rem 0.9rem; }
  .legend { display: grid; grid-template-columns: repeat(auto-fill, minmax(24rem, 1fr));
    gap: 0.15rem 1rem; list-style: none; padding: 0; margin: 0.5rem 0; }
  .legend li { display: flex; align-items: center; gap: 0.5rem; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; }
  .legend .swatch { width: 1.1em; height: 0.35em; border-radius: 0.2em; flex: none; }
</style>
</head>
<body>
<h1>${title}</h1>
<div class="controls">
  <button id="play">Pause</button>
  <input id="scrub" type="range" min="0" value="0" step="1">
  <span id="genlabel"></span>
</div>
<svg id="chart" viewBox="0 0 960 480" role="img" aria-label="win rate by generation"></svg>
<ul class="legend" id="legend"></ul>
<script>
const DATA = ${payload};
const W = 960, H = 480, M = { top: 16, right: 16, bottom: 34, left: 46 };
const iw = W - M.left - M.right, ih = H - M.top - M.bottom;
const gens = DATA.generations;
const all = DATA.teams.flatMap(t => t.series).filter(v => v !== null);
const ymin = Math.max(0, Math.floor((Math.min(...all) - 0.02) * 20) / 20);
const ymax = Math.min(1, Math.ceil((Math.max(...all) + 0.02) * 20) / 20);
const x = g => M.left + (gens <= 1 ? 0 : (g / (gens - 1)) * iw);
const y = v => M.top + (1 - (v - ymin) / (ymax - ymin)) * ih;
const svg = document.getElementById('chart');
const NS = 'http://www.w3.org/2000/svg';
function el(name, attrs, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  (parent || svg).appendChild(e);
  return e;
}
// Axes + gridlines.
for (let v = ymin; v <= ymax + 1e-9; v += 0.05) {
  el('line', { class: 'grid', x1: M.left, x2: W - M.right, y1: y(v), y2: y(v) });
  const t = el('text', { x: M.left - 8, y: y(v) + 4, 'text-anchor': 'end' });
  t.textContent = Math.round(v * 100) + '%';
}
const xstep = Math.max(1, Math.ceil(gens / 16));
for (let g = 0; g < gens; g += xstep) {
  const t = el('text', { x: x(g), y: H - M.bottom + 20, 'text-anchor': 'middle' });
  t.textContent = g;
}
const xt = el('text', { x: M.left + iw / 2, y: H - 4, 'text-anchor': 'middle' });
xt.textContent = 'generation';
// One <path> per team; the animation rewrites each path's "d" up to the
// current generation (gaps where series[g] is null).
const paths = DATA.teams.map(t =>
  el('path', { fill: 'none', stroke: t.color, 'stroke-width': 2.25, 'stroke-linejoin': 'round' })
);
const cursor = el('line', { stroke: 'rgba(127,127,127,0.7)', 'stroke-dasharray': '4 3',
  y1: M.top, y2: H - M.bottom, x1: x(0), x2: x(0) });
const legend = document.getElementById('legend');
for (const t of DATA.teams) {
  const li = document.createElement('li');
  const sw = document.createElement('span');
  sw.className = 'swatch';
  sw.style.background = t.color;
  li.appendChild(sw);
  li.appendChild(document.createTextNode('#' + t.rank + ' ' + t.name));
  legend.appendChild(li);
}
function dFor(series, upTo) {
  let d = '', pen = false;
  for (let g = 0; g <= upTo; g += 1) {
    const v = series[g];
    if (v === null) { pen = false; continue; }
    d += (pen ? ' L' : ' M') + x(g).toFixed(1) + ' ' + y(v).toFixed(1);
    pen = true;
  }
  return d.trim();
}
const scrub = document.getElementById('scrub');
const playBtn = document.getElementById('play');
const genlabel = document.getElementById('genlabel');
scrub.max = gens - 1;
let shown = 0, playing = true, last = 0;
function draw() {
  DATA.teams.forEach((t, i) => paths[i].setAttribute('d', dFor(t.series, shown)));
  cursor.setAttribute('x1', x(shown));
  cursor.setAttribute('x2', x(shown));
  scrub.value = shown;
  genlabel.textContent = 'gen ' + shown + ' / ' + (gens - 1);
}
function tick(ts) {
  if (playing) {
    if (ts - last > 180) {
      last = ts;
      shown += 1;
      if (shown >= gens) { shown = gens - 1; playing = false; playBtn.textContent = 'Replay'; }
      draw();
    }
  }
  requestAnimationFrame(tick);
}
playBtn.addEventListener('click', () => {
  if (playBtn.textContent === 'Replay') { shown = 0; playing = true; playBtn.textContent = 'Pause'; }
  else { playing = !playing; playBtn.textContent = playing ? 'Pause' : 'Play'; }
  draw();
});
scrub.addEventListener('input', () => {
  playing = false;
  playBtn.textContent = 'Play';
  shown = Number(scrub.value);
  draw();
});
draw();
requestAnimationFrame(tick);
</script>
</body>
</html>
`;
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { top: { type: 'string' }, out: { type: 'string' } },
  });
  const outDir = positionals[0];
  if (!outDir) {
    process.stderr.write('Usage: node scripts/chart-top-teams.mjs <out-dir> [--top N] [--out PATH]\n');
    process.exitCode = 2;
    return;
  }
  const topCount = values.top ? Number(values.top) : 10;
  const data = collectTopTeamSeries(outDir, topCount);
  const title = `Top ${data.teams.length} teams by generation -- ${path.basename(path.resolve(outDir))}`;
  const outPath = values.out ?? path.join(outDir, 'top-teams-animation.html');
  writeFileSync(outPath, renderChartHtml(data, title), 'utf8');
  process.stdout.write(`Animation written to ${outPath} (${data.teams.length} teams, ${data.generations} generations)\n`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main(process.argv.slice(2));
}
