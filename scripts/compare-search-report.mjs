// Renders out/research-integration.{md,html} from out/research/results.json
// (written by `scripts/compare-search.mjs run`). Picture first: per tried idea a
// control-vs-idea chart across seeds, then the numbers, then a one-line verdict.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const IDEA_LABEL = {
  h2: 'Sequential Halving, 2 rounds',
  h3: 'Sequential Halving, 3 rounds',
  h4: 'Sequential Halving, 4 rounds',
};

/** Ideas from out/research-report.md and out/speed-report.md that were NOT built, with the reason. */
export const NOT_TRIED = [
  ['Nash averaging (research #2)', 'Changes what fitness means (opponent weights from a maximin mixture) and needs smoothing on a noisy 3v3 matrix; it needs its own diagnostic pass first. Not built this round.'],
  ['Hoeffding Races (#3)', 'Same insertion point and goal as Sequential Halving; the research report says pick one of the two. Halving was picked (fixed schedule, no per-team statistics to tune).'],
  ['MAP-Elites archive (#4)', 'Diversity, not speed or team quality; needs chosen descriptors. Not built.'],
  ['Coevolution evaluation methods (#5)', 'Informativeness weights are computed from the same candidate set they weight (circular); would change fitness meaning. Not built.'],
  ['PSRO / alpha-Rank (#6)', 'Needs a full payoff table per generation and a solver; the larger change. Not built.'],
  ['Spinning-top games (#7)', 'Descriptive analysis only; no in-app change. Not built.'],
  ['Prioritised fictitious self-play (#8)', 'Changes fitness away from meta win rate, against docs/fitness-symmetry.md. Not built.'],
  ['Hyperband (#9)', 'A bracketed variant of Sequential Halving; only worth it if halving shows first-slice noise hurting. Not built.'],
  ['Novelty search (#10)', 'Diversity bonus that competes with the existing core-rivalry penalty. Not built.'],
  ['Surrogate models (#11)', 'General overview, no evidence for discrete co-evolving targets. Not built.'],
  ['VGC-Bench (#12)', 'Doubles with hidden information; does not transfer to GBL 3v3. Not built.'],
  ['Pokemon AI at rank 33 (#13)', 'Nothing measurable to build. Not built.'],
  ['POET (#14)', 'Would starve the pool of real meta threats; not built.'],
  ['More threads (speed #1)', 'Already the default (--threads 8); no change.'],
  ['Larger scenario memo (speed #2)', 'Measured earlier: no wall-clock gain for 5x the memory. Dropped.'],
  ['Persisted battle cache (speed #3)', 'Only helps reruns of identical builds and seeds, not new searches. Not built.'],
  ['Cheaper final pass (speed #4)', 'Already tunable with --elites / --final-archive / --final-fresh; no new code needed.'],
  ['Fork pvpoke hot paths (speed #5)', 'Forbidden: vendor/pvpoke is read-only and battle math is never reimplemented.'],
  ['Lower population / opponents (speed #6)', 'Existing flags, trades quality for time by hand; halving is the adaptive version.'],
];

const T_ONE_SIDED_95 = { 1: 6.31, 2: 2.92, 3: 2.35, 4: 2.13, 5: 2.02, 6: 1.94, 7: 1.89 };
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;

/** Paired-by-seed comparison of one arm against the control. */
export function compareArm(cells, arm, seeds) {
  const get = (a, s) => cells.find((c) => c.arm === a && c.seed === s);
  const rows = seeds.map((s) => ({ seed: s, c: get('control', s), i: get(arm, s) })).filter((r) => r.c && r.i);
  const dQ = rows.map((r) => r.i.heldoutMeanTop - r.c.heldoutMeanTop);
  const dQ1 = rows.map((r) => r.i.heldoutTop1 - r.c.heldoutTop1);
  const battleRatio = rows.map((r) => r.i.genBattles / r.c.genBattles);
  const timeRatio = rows.map((r) => r.i.genSeconds / r.c.genSeconds);
  const t = T_ONE_SIDED_95[rows.length - 1] ?? 1.7;
  const se = sd(dQ) / Math.sqrt(rows.length);
  const m = mean(dQ);
  const lower = m - t * se;
  const upper = m + t * se;
  const cheaper = mean(battleRatio) <= 0.8 && Math.max(...battleRatio) < 0.95;
  let verdict;
  let why;
  if (lower > 0) {
    verdict = 'keep';
    why = 'better team quality beyond seed spread';
  } else if (cheaper && lower >= -0.03) {
    verdict = 'keep';
    why = `${pct(1 - mean(battleRatio), 0)} fewer battles, team quality not worse than -3 points`;
  } else if (upper < 0) {
    verdict = 'drop';
    why = 'team quality worse beyond seed spread';
  } else if (!cheaper) {
    verdict = 'drop';
    why = 'no clear compute saving and no quality gain';
  } else {
    verdict = 'unclear';
    why = 'compute saved, but a quality loss larger than 3 points cannot be ruled out at this seed count';
  }
  return { arm, rows, dQ, dQ1, meanQ: m, se, lower, upper, battleRatio, timeRatio, verdict, why };
}

const IDEA_WHAT = {
  h2: 'Each generation, teams first fight only half of the opponents; the weaker half is dropped and only the survivors fight the rest.',
  h3: 'Each generation, teams first fight a quarter of the opponents, then half, then all; after each step the weaker half is dropped, so most teams never play the full schedule.',
  h4: 'Like 3 rounds, but with a still smaller first slice (an eighth of the opponents), so cuts start earlier and more battles are skipped.',
};

/** Two labelled panels: run time (bars, lower is better) and team quality (per-seed dots, higher is better). */
function chartSvg(cmp, top) {
  const W = 640;
  const H = 300;
  const L = 150;
  const R = W - 30;
  const rows = cmp.rows;
  const parts = [];
  const tR = mean(cmp.timeRatio);
  // Panel 1: time
  const tx = (v) => L + (v / 1.1) * (R - L);
  parts.push(`<text x="0" y="18" class="head">Run time  (shorter bar = better)</text>`);
  parts.push(`<text x="${L - 8}" y="47" class="tick" text-anchor="end">Control</text><rect x="${L}" y="34" width="${tx(1) - L}" height="18" class="ctl"/><text x="${tx(1) + 6}" y="48" class="val">100%</text>`);
  parts.push(`<text x="${L - 8}" y="77" class="tick" text-anchor="end">This idea</text><rect x="${L}" y="64" width="${tx(tR) - L}" height="18" class="idea"/><text x="${tx(tR) + 6}" y="78" class="val">${pct(tR, 0)}</text>`);
  // Panel 2: quality
  const all = rows.flatMap((r) => [r.c.heldoutMeanTop, r.i.heldoutMeanTop]);
  const lo = Math.floor((Math.min(...all) - 0.01) * 20) / 20;
  const hi = Math.ceil((Math.max(...all) + 0.01) * 20) / 20;
  const qx = (q) => L + ((q - lo) / (hi - lo || 1)) * (R - L);
  parts.push(`<text x="0" y="128" class="head">Team quality  (further right = better)</text>`);
  parts.push(`<text x="0" y="144" class="tick">win rate of the top ${top} teams against opponents the search never saw; one dot per seed, line = average</text>`);
  for (let q = lo; q <= hi + 1e-9; q += 0.05) parts.push(`<line x1="${qx(q)}" x2="${qx(q)}" y1="158" y2="256" class="grid"/><text x="${qx(q)}" y="272" class="tick" text-anchor="middle">${pct(q, 0)}</text>`);
  const mc = mean(rows.map((r) => r.c.heldoutMeanTop));
  const mi = mean(rows.map((r) => r.i.heldoutMeanTop));
  const jit = (k) => ((k * 7) % 5) * 3 - 6;
  for (const [label, y, cls, vals, m] of [['Control', 187, 'ctl', rows.map((r) => r.c.heldoutMeanTop), mc], ['This idea', 231, 'idea', rows.map((r) => r.i.heldoutMeanTop), mi]]) {
    parts.push(`<text x="${L - 8}" y="${y + 4}" class="tick" text-anchor="end">${label}</text>`);
    vals.forEach((v, k) => parts.push(`<circle cx="${qx(v)}" cy="${y + jit(k)}" r="5" class="${cls} dotq" fill-opacity="0.55"><title>${label}: ${pct(v)}</title></circle>`));
    parts.push(`<line x1="${qx(m)}" x2="${qx(m)}" y1="${y - 20}" y2="${y + 20}" class="mean ${cls}s"/><text x="${qx(m)}" y="${y - 24}" class="val" text-anchor="middle">${pct(m)}</text>`);
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Run time and team quality, control versus idea">${parts.join('')}</svg>`;
}

/** Plain-language quality cost line. */
function costText(c) {
  const pts = c.meanQ * 100;
  const noise = 'within seed-to-seed noise';
  const size = Math.abs(pts) < 0.05 ? 'no measurable change' : `${pts > 0 ? '+' : ''}${pts.toFixed(1)} points`;
  const inNoise = c.lower < 0 && c.upper > 0;
  return `team quality ${size} (${inNoise ? noise : 'beyond noise'}); a loss of up to ${(Math.max(0, -c.lower) * 100).toFixed(1)} points is not ruled out.`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function renderReport(data, outDir) {
  const { seeds, top, heldoutCount, cells } = data;
  const ideas = data.arms.filter((a) => a !== 'control');
  const cmps = ideas.map((a) => compareArm(cells, a, seeds));
  const flagsOf = (a) => (data.armFlags[a] ?? []).join(' ') || '(none)';
  const runCmd = `node scripts/compare-search.mjs run --arms ${data.arms.join(',')} --seeds ${seeds.join(',')} --top ${top} --heldout ${heldoutCount}`;

  // ---------- markdown ----------
  const md = ['# Search experiments: control vs ideas', ''];
  md.push(`Held-out quality = mean unweighted win rate (both seats) of each run's top ${top} finalists against ${heldoutCount} fresh meta teams (seed "heldout") that no search ever fought. Seeds: ${seeds.join(', ')}.`, '');
  for (const c of cmps) {
    md.push(`## ${IDEA_LABEL[c.arm] ?? c.arm}: ${c.verdict.toUpperCase()}`, '');
    md.push(`${c.why}.`, '');
    md.push('| seed | control battles | idea battles | control secs | idea secs | control held-out | idea held-out | control top1 | idea top1 |', '|---|---|---|---|---|---|---|---|---|');
    for (const r of c.rows) {
      md.push(`| ${r.seed} | ${r.c.genBattles} | ${r.i.genBattles} | ${r.c.genSeconds.toFixed(0)} | ${r.i.genSeconds.toFixed(0)} | ${pct(r.c.heldoutMeanTop)} | ${pct(r.i.heldoutMeanTop)} | ${pct(r.c.heldoutTop1)} | ${pct(r.i.heldoutTop1)} |`);
    }
    md.push('', `Mean battle ratio ${mean(c.battleRatio).toFixed(2)}, wall-clock ratio ${mean(c.timeRatio).toFixed(2)}; held-out quality diff ${(c.meanQ * 100).toFixed(1)} points (SE ${(c.se * 100).toFixed(1)}, 95% one-sided bounds ${(c.lower * 100).toFixed(1)} .. ${(c.upper * 100).toFixed(1)}).`, '');
  }
  md.push('## Every idea, tried or not', '', '| idea | status |', '|---|---|');
  for (const a of ideas) md.push(`| ${IDEA_LABEL[a] ?? a} (research #1) | tried, see above |`);
  for (const [n, why] of NOT_TRIED) md.push(`| ${n} | not tried: ${why} |`);
  md.push('', '## Rerun', '', '```', 'bash scripts/setup.sh', runCmd, 'node scripts/compare-search.mjs report', '```', '', `Every cell is \`node scripts/evolve.mjs out/research/meta-collection-1500.csv --seed <seed> ${data.baseFlags.join(' ')} <arm switches> --out-dir out/research/<arm>-<seed>\`; arm switches: ${ideas.map((a) => `${a} = ${flagsOf(a)}`).join('; ')}; control = none.`, '');
  writeFileSync(path.join(outDir, 'research-integration.md'), md.join('\n'));

  // ---------- html ----------
    const sections = cmps
    .map((c) => {
      const rowsHtml = c.rows
        .map(
          (r) =>
            `<tr><td>${r.seed}</td><td>${r.c.genBattles}</td><td>${r.i.genBattles}</td><td>${r.c.genSeconds.toFixed(0)}s</td><td>${r.i.genSeconds.toFixed(0)}s</td><td>${pct(r.c.heldoutMeanTop)}</td><td>${pct(r.i.heldoutMeanTop)}</td><td>${pct(r.c.heldoutTop1)}</td><td>${pct(r.i.heldoutTop1)}</td></tr>`
        )
        .join('');
      return `<section>
<h2>${esc(IDEA_LABEL[c.arm] ?? c.arm)} <span class="v ${c.verdict}">${c.verdict}</span></h2>
<p><b>What it does:</b> ${esc(IDEA_WHAT[c.arm] ?? '')}</p>
<ul class="gc"><li><b>Gain:</b> ${pct(1 - mean(c.timeRatio), 0)} less run time (${pct(1 - mean(c.battleRatio), 0)} fewer battles).</li>
<li><b>Cost:</b> ${costText(c)}</li></ul>
<p class="why"><b>Verdict (${c.verdict}):</b> ${esc(c.why)}.</p>
${chartSvg(c, top)}
<details><summary>Per-seed numbers</summary>
<table><thead><tr><th>seed</th><th>battles ctl</th><th>battles idea</th><th>time ctl</th><th>time idea</th><th>quality ctl</th><th>quality idea</th><th>best team ctl</th><th>best team idea</th></tr></thead><tbody>${rowsHtml}</tbody></table>
<p class="num">Quality difference ${(c.meanQ * 100).toFixed(1)} points, standard error ${(c.se * 100).toFixed(1)}, 95% one-sided bounds ${(c.lower * 100).toFixed(1)} to ${(c.upper * 100).toFixed(1)}. Verdict rule: keep if quality is not worse than -3 points and at least 20% fewer battles.</p></details>
</section>`;
    })
    .join('\n');
  const bottom = cmps.map((c) => `<li><b>${esc(IDEA_LABEL[c.arm] ?? c.arm)}</b>: ${c.verdict}. ${pct(1 - mean(c.timeRatio), 0)} less run time; ${costText(c)}</li>`).join('');
  const notTried = NOT_TRIED.map(([n, why]) => `<tr><td>${esc(n)}</td><td>not tried</td><td>${esc(why)}</td></tr>`).join('');
  const triedRows = ideas.map((a) => `<tr><td>${esc(IDEA_LABEL[a] ?? a)} (research #1)</td><td>tried</td><td>switch: <code>${esc(flagsOf(a))}</code></td></tr>`).join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Search Experiments</title>
<style>
:root{--bg:#fafaf7;--fg:#1d1d1b;--mut:#6b6b64;--line:#dcdcd3;--ctl:#3b6ea5;--idea:#c2571a;--keep:#2f7d4f;--drop:#b3372f;--unc:#8a7a1f}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe4;--mut:#9a9a90;--line:#33332f;--ctl:#7fb0e0;--idea:#f0955a;--keep:#6fcf97;--drop:#f08a82;--unc:#e0cf6a}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:760px;padding:24px 16px}
h1{font-size:22px}h2{font-size:18px;margin-top:36px}
svg{width:100%;height:auto}.grid{stroke:var(--line)}.tick{fill:var(--mut);font-size:11px}.axis{fill:var(--mut);font-size:12px}
.ctl{fill:var(--ctl)}.idea{fill:var(--idea)}
table{border-collapse:collapse;width:100%;font-size:13px;display:block;overflow-x:auto}th,td{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left}
.v{font-size:13px;border:1px solid currentColor;border-radius:4px;padding:1px 8px;margin-left:8px}.keep{color:var(--keep)}.drop{color:var(--drop)}.unclear{color:var(--unc)}
.why{margin:4px 0 12px}.box{border:1px solid var(--line);border-radius:8px;padding:8px 16px;margin:16px 0}.gc{margin:4px 0}.head{fill:var(--fg);font-size:14px;font-weight:600}.val{fill:var(--fg);font-size:12px}.mean{stroke-width:3}.ctls{stroke:var(--ctl)}.ideas{stroke:var(--idea)}details{margin:8px 0}summary{cursor:pointer;color:var(--mut)}.num{color:var(--mut);font-size:13px}code{font-size:12px}
</style></head><body>
<h1>Search experiments: control vs ideas</h1>
<p><b>Question:</b> can the team search finish faster without finding worse teams? "Control" is the normal search. Each idea below is an optional switch tested against it on the same inputs, ${seeds.length} times with different random seeds.</p>
<div class="box"><b>Bottom line</b><ul>${bottom}</ul>
<p class="num">Quality = win rate of each run's top ${top} teams against ${heldoutCount} fresh meta teams no search fought. Seed-to-seed spread is about 3 points, so differences under that are noise.</p></div>
${sections}
<h2>Every idea, tried or not</h2>
<table><thead><tr><th>idea</th><th>status</th><th>why / how</th></tr></thead><tbody>${triedRows}${notTried}</tbody></table>
<h2>Rerun</h2>
<pre><code>bash scripts/setup.sh
${esc(runCmd)}
node scripts/compare-search.mjs report</code></pre>
</body></html>`;
  writeFileSync(path.join(outDir, 'research-integration.html'), html);
  console.log(`wrote ${path.join(outDir, 'research-integration.html')} and .md`);
}
