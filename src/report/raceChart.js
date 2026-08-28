// JavaScript Document
//
// Shared core of the animated "win rate by generation" race chart. Two
// callers funnel through here:
//   - scripts/chart-top-teams.mjs -- a standalone CLI that reads a finished
//     run's out/evolve-gen<N>.json checkpoint files + evolve-ranking.json off
//     disk and writes a full standalone HTML page.
//   - scripts/evolve.mjs's own HTML report (renderEvolveReportHtml) -- reads
//     the SAME shape of data straight out of the in-memory
//     `result.generationRecords` / `result.elites` a run just produced (no
//     extra file reads; the checkpoint files and this data are one and the
//     same, see runEvolution's `record` object), and embeds the chart as a
//     fragment inside a larger page.
//
// Pure formatting/data-shaping: no engine, no I/O (chart-top-teams.mjs still
// owns reading files off disk; this module never touches the filesystem).

// Stroke colors for the final top-10 (or fewer); cycles if there are more.
// Ranks 1-3 deliberately match the podium/standings medal hues (gold/silver/
// bronze) so a line's color reads as the SAME fact everywhere on the page --
// the rest of the field uses a curated earth/jewel-tone set rather than a
// default primary-color rainbow.
export const PALETTE = [
  '#B8892B', '#8B927E', '#9C6B3E', '#2E6F95', '#7A4FC9',
  '#C1461F', '#3F7D3B', '#B23A6B', '#4A5FA5', '#6B7A22',
];

/** Same lead-aware team identity src/teams/evolve.js and scripts/evolve.mjs use. */
export function teamSignature(team) {
  return `${team[0]}||${[...team.slice(1)].sort().join('|')}`;
}

/**
 * Build the chart's series data: every team that ever appeared in a
 * generation's top `topCount` by fitness, with its full per-generation
 * win-rate series, plus (when a final ranking is supplied) its rank. Ordered:
 * ranked teams first (by rank), then the field by total top-N appearances
 * descending.
 *
 * Pure function over already-loaded/in-memory data -- no file reads, so it
 * works identically whether `checkpoints` came from JSON.parse(readFileSync
 * (evolve-gen<N>.json)) or straight from a live run's `result.generationRecords`
 * (same shape: each entry needs only `winRateBySignature` and
 * `analytics.topTeams`).
 *
 * @param {Array<{winRateBySignature?: Record<string, number>,
 *   analytics?: {topTeams?: Array<{members: Array<{key:string, name:string}>}>}}>} checkpoints
 *   - one entry per generation, in generation order.
 * @param {Array<{signature: string, rank: number, name: string}>} rankingEntries
 *   - the final weighted ranking (1-based `rank`); teams here that never
 *     cracked a per-generation top-N are still included, ranked, with an
 *     all-null series before the generation they first appear alive.
 * @param {number} topCount - per-generation top-set size to union over.
 * @returns {{teams: Array<{name: string, rank: number|null, series: Array<number|null>}>,
 *   generations: number}} series[g] is the team's gen-g win rate, or null
 *   for a generation the team was not alive in.
 */
export function buildTopTeamSeries(checkpoints, rankingEntries, topCount) {
  if (checkpoints.length === 0) return { teams: [], generations: 0, topCount };

  // Union of every generation's top-N (first-seen order; names come from the
  // same analytics entries).
  const bySignature = new Map();
  for (const cp of checkpoints) {
    const topTeams = cp.analytics?.topTeams ?? [];
    for (const t of topTeams.slice(0, topCount)) {
      const signature = teamSignature(t.members.map((m) => m.key));
      let entry = bySignature.get(signature);
      if (!entry) {
        entry = { name: t.members.map((m) => m.name).join(' / '), signature, appearances: 0 };
        bySignature.set(signature, entry);
      }
      entry.appearances += 1;
    }
  }

  const rankBySignature = new Map((rankingEntries ?? []).map((e) => [e.signature, e.rank]));
  // A final-ranking team can miss every per-generation top-N (the final rank
  // blends the elites pass in; raw fitness never had it that high) -- include
  // it anyway, so the chart always carries the whole final ranking.
  for (const e of rankingEntries ?? []) {
    if (!bySignature.has(e.signature)) {
      bySignature.set(e.signature, { name: e.name.replace(' (Lead)', ''), signature: e.signature, appearances: 0 });
    }
  }

  const teams = [...bySignature.values()]
    .map((t) => ({
      name: t.name,
      rank: rankBySignature.get(t.signature) ?? null,
      appearances: t.appearances,
      series: checkpoints.map((cp) => (cp.winRateBySignature ?? {})[t.signature] ?? null),
    }))
    .sort((a, b) => {
      if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
      if (a.rank !== null) return -1;
      if (b.rank !== null) return 1;
      return b.appearances - a.appearances;
    });
  return { teams, generations: checkpoints.length, topCount };
}

/** JSON payload the chart's inline script reads -- shared by the fragment and the standalone page. */
function chartPayload(data) {
  const ranked = data.teams.filter((t) => t.rank !== null);
  return JSON.stringify({
    generations: data.generations,
    topCount: data.topCount ?? ranked.length,
    fieldCount: data.teams.length - ranked.length,
    teams: data.teams.map((t) => ({
      name: t.name,
      rank: t.rank,
      // Final-ranked teams get the strong palette; the rest of the field a
      // shared muted stroke, so 100+ lines stay readable.
      color: t.rank !== null ? PALETTE[(t.rank - 1) % PALETTE.length] : null,
      series: t.series.map((v) => (v === null ? null : Math.round(v * 1000) / 1000)),
    })),
  });
}

/**
 * Render the chart as an embeddable HTML fragment: controls, a "which team
 * is this" caption, the SVG the animation draws into, a legend list, and the
 * inline script that drives it all (play/pause, scrubber, click-to-identify
 * -- including the muted field lines). No `<html>`/`<head>`/page-level CSS:
 * the host page supplies that (see scripts/evolve.mjs's renderEvolveReportHtml
 * and renderChartHtml below for the two current hosts).
 *
 * @param {{teams: Array<{name: string, rank: number|null, series: Array<number|null>}>,
 *   generations: number}} data - from buildTopTeamSeries.
 * @returns {string} HTML fragment text.
 */
export function renderChartInner(data) {
  const payload = chartPayload(data);
  return `<div class="controls">
  <button id="play">Pause</button>
  <input id="scrub" type="range" min="0" value="0" step="1">
  <span id="genlabel"></span>
</div>
<p id="picked">Click or tap any line — grey ones too — to see which team it is.</p>
<svg id="chart" viewBox="0 0 960 480" role="img" aria-label="win rate by generation"></svg>
<ul class="legend" id="legend"></ul>
<script>
const DATA = ${payload};
const W = 960, H = 480, M = { top: 16, right: 16, bottom: 34, left: 46 };
const iw = W - M.left - M.right, ih = H - M.top - M.bottom;
const gens = DATA.generations;
const all = DATA.teams.flatMap(t => t.series).filter(v => v !== null);
const ymin = all.length ? Math.max(0, Math.floor((Math.min(...all) - 0.02) * 20) / 20) : 0;
const ymax = all.length ? Math.min(1, Math.ceil((Math.max(...all) + 0.02) * 20) / 20) : 1;
const x = g => M.left + (gens <= 1 ? 0 : (g / (gens - 1)) * iw);
const y = v => M.top + (1 - (v - ymin) / (ymax - ymin || 1)) * ih;
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
  el('path', { fill: 'none', stroke: t.color ?? 'rgba(127,127,127,0.4)',
    'stroke-width': t.color ? 2.25 : 1.1, 'stroke-linejoin': 'round' })
);
const cursor = el('line', { stroke: 'rgba(127,127,127,0.7)', 'stroke-dasharray': '4 3',
  y1: M.top, y2: H - M.bottom, x1: x(0), x2: x(0) });
// Invisible wide twins of every line, appended last so they sit on top: the
// tap target for identifying a line (the 1.1px field strokes are unhittable).
const hitPaths = DATA.teams.map((t, i) => {
  const hp = el('path', { fill: 'none', stroke: 'transparent', 'stroke-width': 12,
    'stroke-linejoin': 'round' });
  hp.style.pointerEvents = 'stroke';
  hp.style.cursor = 'pointer';
  hp.addEventListener('click', (ev) => { ev.stopPropagation(); select(i); });
  return hp;
});
const picked = document.getElementById('picked');
const pickedHint = picked.textContent;
let sel = null;
function describe(t) {
  let peak = -1, peakGen = 0, first = null, last = null;
  t.series.forEach((v, g) => {
    if (v === null) return;
    if (first === null) first = g;
    last = g;
    if (v > peak) { peak = v; peakGen = g; }
  });
  const head = t.rank !== null ? '#' + t.rank + ' ' + t.name : t.name;
  const fate = t.rank !== null ? 'final top ' + DATA.teams.filter(x => x.rank !== null).length : 'bred out (never made the final ranking)';
  return head + ' \\u2014 ' + fate + '; alive gens ' + first + '\\u2013' + last +
    ', peak ' + Math.round(peak * 100) + '% (gen ' + peakGen + ')';
}
function select(i) {
  if (sel !== null) {
    const t0 = DATA.teams[sel];
    paths[sel].setAttribute('stroke', t0.color ?? 'rgba(127,127,127,0.4)');
    paths[sel].setAttribute('stroke-width', t0.color ? 2.25 : 1.1);
  }
  if (i === null || i === sel) { sel = null; picked.textContent = pickedHint; return; }
  sel = i;
  const t = DATA.teams[i];
  paths[i].setAttribute('stroke', t.color ?? 'currentColor');
  paths[i].setAttribute('stroke-width', 3.25);
  svg.appendChild(paths[i]);
  for (const hp of hitPaths) svg.appendChild(hp);
  picked.textContent = describe(t);
}
svg.addEventListener('click', () => select(null));
const legend = document.getElementById('legend');
for (const t of DATA.teams) {
  if (t.color === null) continue;
  const li = document.createElement('li');
  const sw = document.createElement('span');
  sw.className = 'swatch';
  sw.style.background = t.color;
  li.appendChild(sw);
  li.appendChild(document.createTextNode('#' + t.rank + ' ' + t.name));
  legend.appendChild(li);
}
if (DATA.fieldCount > 0) {
  const li = document.createElement('li');
  const sw = document.createElement('span');
  sw.className = 'swatch';
  sw.style.background = 'rgba(127,127,127,0.4)';
  li.appendChild(sw);
  li.appendChild(document.createTextNode('+' + DATA.fieldCount + " more teams that cracked a generation's top " + DATA.topCount));
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
scrub.max = Math.max(0, gens - 1);
let shown = 0, playing = gens > 1, last = 0;
function draw() {
  DATA.teams.forEach((t, i) => {
    const d = dFor(t.series, shown);
    paths[i].setAttribute('d', d);
    hitPaths[i].setAttribute('d', d);
  });
  cursor.setAttribute('x1', x(shown));
  cursor.setAttribute('x2', x(shown));
  scrub.value = shown;
  genlabel.textContent = 'gen ' + shown + ' / ' + Math.max(0, gens - 1);
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
</script>`;
}

/**
 * Render the collected series as a complete, self-contained animated HTML
 * page (used by scripts/chart-top-teams.mjs's standalone CLI).
 *
 * @param {{teams: Array<{name: string, rank: number, series: Array<number|null>}>,
 *   generations: number}} data - from buildTopTeamSeries.
 * @param {string} title - page heading.
 * @returns {string} HTML document text.
 */
export function renderChartHtml(data, title) {
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
  #picked { min-height: 1.5em; margin: 0.4rem 0 0.3rem; font-size: 0.92rem; color: rgba(127,127,127,0.95); }
</style>
</head>
<body>
<h1>${title}</h1>
${renderChartInner(data)}
</body>
</html>
`;
}
