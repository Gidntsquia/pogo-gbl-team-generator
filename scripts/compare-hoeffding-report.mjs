// Side-by-side report for the Hoeffding Races A/B (control = today's default search, halving
// R=3; idea = the same run with --hoeffding-races instead, halving off). Pure function of
// out/hoeffding-ab/results.json: rerun with `node scripts/compare-search.mjs report --dir
// out/hoeffding-ab` and the same bytes come out. Writes out/hoeffding-ab.{html,md}.
// Statistics and the stop rule: hoeffding-stats.mjs.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { mean, pairedRows, verdictAt, stopStatus, checkpoints, t95, BATCH, CAP_SEEDS, BAND, QUALITY_LOSS_BOUND, CHEAPER_RATIO, BUDGET_SECONDS } from './hoeffding-stats.mjs';

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const pts = (x, d = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const num = (s) => Number(s.slice(1));
const seedsOf = (cells, arm) => [...new Set(cells.filter((c) => c.arm === arm).map((c) => c.seed))].sort((a, b) => num(a) - num(b));

export const STOP_RULE = `Stop rule (fixed before the extra seeds ran, not tuned afterwards; the same shape as the Nash/informativeness rounds, adapted for a SPEED idea with both a quality bound and a battle-saving bar). After every batch of ${BATCH} seeds (${BATCH}, ${2 * BATCH}, ... up to ${CAP_SEEDS}), take the 95% range of the paired quality difference (idea minus control, Student t) and the mean battle-count ratio (idea / control). KEEP if the idea is quality-better beyond the seed spread, OR if it is at least ${((1 - CHEAPER_RATIO) * 100).toFixed(0)}% cheaper in battles and the quality-loss bound is no worse than ${(QUALITY_LOSS_BOUND * 100).toFixed(0)} points (the Sequential Halving R=3 precedent). DROP if quality is worse beyond the seed spread, or there is no clear battle saving and no quality gain. NO MEANINGFUL DIFFERENCE (counts as drop) if quality is inside +-${BAND * 100} point AND battles are not meaningfully fewer (<5% saved). Otherwise add another batch. At ${CAP_SEEDS} seeds or the 8-hour budget, whichever comes first, the answer is a plain KEEP/DROP reading against the keep bar above -- never left unclear.`;

const LABEL = { keep: 'KEEP', drop: 'DROP', 'no meaningful difference': 'NO MEANINGFUL DIFFERENCE (drop)', unclear: 'UNCLEAR (not finished)' };

/** Overall answer from the short-run pairs under the fixed rule. */
export function overall(rows) {
  const st = stopStatus(rows);
  const n = rows.length;
  if (st.stop) return { label: st.result.verdict, cls: st.result.verdict === 'keep' ? 'keep' : 'drop', at: st.at, result: st.result, done: true };
  return { label: 'unclear', cls: 'unclear', at: n, result: verdictAt(rows), done: false };
}

/** Two labelled panels: run time (bars, lower is better) and team quality (per-seed dots, higher is better). */
function chartSvg(rows, top) {
  const W = 640, H = 300, L = 150, R = W - 30;
  const parts = [];
  const tR = mean(rows.map((r) => r.i.genSeconds / r.c.genSeconds));
  const tMax = Math.max(1, tR) * 1.15;
  const tx = (v) => L + (v / tMax) * (R - L);
  parts.push(`<text x="0" y="18" class="head">Run time  (shorter bar = better)</text>`);
  parts.push(`<text x="${L - 8}" y="47" class="tick" text-anchor="end">Control</text><rect x="${L}" y="34" width="${tx(1) - L}" height="18" class="ctl"/><text x="${tx(1) + 6}" y="48" class="val">100%</text>`);
  parts.push(`<text x="${L - 8}" y="77" class="tick" text-anchor="end">Hoeffding Races</text><rect x="${L}" y="64" width="${tx(tR) - L}" height="18" class="idea"/><text x="${tx(tR) + 6}" y="78" class="val">${pct(tR, 0)}</text>`);
  const all = rows.flatMap((r) => [r.c.heldoutMeanTop, r.i.heldoutMeanTop]);
  const lo = Math.floor((Math.min(...all) - 0.01) * 20) / 20;
  const hi = Math.ceil((Math.max(...all) + 0.01) * 20) / 20;
  const qx = (q) => L + ((q - lo) / (hi - lo || 1)) * (R - L);
  parts.push(`<text x="0" y="128" class="head">Team quality  (further right = better)</text>`);
  parts.push(`<text x="0" y="144" class="tick">win rate of the top ${top} teams against opponents the search never saw; one dot per seed, line = average</text>`);
  for (let q = lo; q <= hi + 1e-9; q += 0.05) parts.push(`<line x1="${qx(q)}" x2="${qx(q)}" y1="158" y2="256" class="grid"/><text x="${qx(q)}" y="272" class="tick" text-anchor="middle">${pct(q, 0)}</text>`);
  const jit = (k) => ((k * 7) % 5) * 3 - 6;
  for (const [nm, y, cls, vals] of [['Control', 187, 'ctl', rows.map((r) => r.c.heldoutMeanTop)], ['Hoeffding Races', 231, 'idea', rows.map((r) => r.i.heldoutMeanTop)]]) {
    const m = mean(vals);
    parts.push(`<text x="${L - 8}" y="${y + 4}" class="tick" text-anchor="end">${nm}</text>`);
    vals.forEach((v, k) => parts.push(`<circle cx="${qx(v)}" cy="${y + jit(k)}" r="4" class="${cls}" fill-opacity="0.45"><title>${nm}: ${pct(v)}</title></circle>`));
    parts.push(`<line x1="${qx(m)}" x2="${qx(m)}" y1="${y - 20}" y2="${y + 20}" class="mean ${cls}s"/><text x="${qx(m)}" y="${y - 24}" class="val" text-anchor="middle">${pct(m)}</text>`);
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Run time and team quality, control versus Hoeffding Races">${parts.join('')}</svg>`;
}

/** How the 95% range of the quality difference narrowed as seeds were added. */
function rangeSvg(rows) {
  const W = 640, H = 300, L = 46, R = W - 16, T = 40, B = 262;
  const N = rows.length;
  const series = [];
  for (let k = 5; k <= N; k++) series.push(verdictAt(rows, k));
  if (!series.length) return '';
  const ext = Math.max(BAND * 2, ...series.flatMap((v) => [Math.abs(v.lower), Math.abs(v.upper)])) * 1.1;
  const x = (n) => L + ((n - 5) / Math.max(1, N - 5)) * (R - L);
  const y = (v) => (T + B) / 2 - (v / ext) * ((B - T) / 2);
  const band = series.map((v, k) => `${k ? 'L' : 'M'}${x(v.n).toFixed(1)},${y(v.upper).toFixed(1)}`).join('') + series.slice().reverse().map((v) => `L${x(v.n).toFixed(1)},${y(v.lower).toFixed(1)}`).join('') + 'Z';
  const line = series.map((v, k) => `${k ? 'L' : 'M'}${x(v.n).toFixed(1)},${y(v.mean).toFixed(1)}`).join('');
  const ticks = [];
  for (let v = -Math.floor(ext * 100 / 2) * 2; v <= ext * 100 + 1e-9; v += 2) ticks.push(`<line x1="${L}" x2="${R}" y1="${y(v / 100)}" y2="${y(v / 100)}" class="grid"/><text x="${L - 6}" y="${y(v / 100) + 4}" class="tick" text-anchor="end">${v > 0 ? '+' : ''}${v}</text>`);
  const cps = checkpoints(N).map((n) => `<line x1="${x(n)}" x2="${x(n)}" y1="${T}" y2="${B}" class="cp"/><text x="${x(n)}" y="${B + 16}" class="tick" text-anchor="middle">${n}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="How the range narrowed as seeds were added">
<text x="0" y="16" class="head">How the answer narrowed as seeds were added (idea minus control, points of team quality)</text>
<text x="0" y="30" class="tick">Above 0 = idea better. Shaded band = 95% range; green strip = "no meaningful difference" zone.</text>
<rect x="${L}" y="${y(BAND)}" width="${R - L}" height="${y(-BAND) - y(BAND)}" class="zone"/>${ticks.join('')}${cps}
<line x1="${L}" x2="${R}" y1="${y(0)}" y2="${y(0)}" class="zero"/><path d="${band}" class="band"/><path d="${line}" class="mline"/>
<text x="${(L + R) / 2}" y="${B + 34}" class="tick" text-anchor="middle">seeds run (same seeds for both arms) →</text></svg>`;
}

/** Per-seed change picture: one bar per seed, right of zero = idea better. */
function diffSvg(rows) {
  const dQ = rows.map((r) => r.i.heldoutMeanTop - r.c.heldoutMeanTop);
  const W = 640, rowH = 16, H = 40 + rows.length * rowH;
  const span = Math.max(0.02, ...dQ.map(Math.abs)) * 1.1;
  const cx = 320;
  const x = (v) => cx + (v / span) * 260;
  const bars = rows.map((r, k) => {
    const d = dQ[k];
    const y = 30 + k * rowH;
    return `<text x="${cx - 300}" y="${y + 10}" class="tick">${r.seed}</text><rect x="${Math.min(cx, x(d))}" y="${y}" width="${Math.abs(x(d) - cx)}" height="12" class="${d >= 0 ? 'idea' : 'ctl'}"/><text x="${d >= 0 ? x(d) + 5 : x(d) - 5}" y="${y + 10}" class="val" text-anchor="${d >= 0 ? 'start' : 'end'}">${pts(d)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Quality change per seed"><text x="0" y="14" class="head">Quality change per seed, in points (orange = idea better, blue = control better)</text><line x1="${cx}" x2="${cx}" y1="20" y2="${H - 2}" class="grid"/>${bars}</svg>`;
}

const secs = (h) => `${(h / 3600).toFixed(2)} h`;

export function renderHoeffdingReport(data, outDir) {
  const { top, heldoutCount, cells } = data;
  const shortSeeds = seedsOf(cells, 'base');
  const rows = pairedRows(cells, shortSeeds, 'base', 'hoeffding');
  const ov = overall(rows);
  const r = ov.result;
  const n = rows.length;
  const nCtl = mean(rows.map((x) => x.c.heldoutMeanTop)), nidea = mean(rows.map((x) => x.i.heldoutMeanTop));
  const bR = mean(rows.map((x) => x.i.genBattles / x.c.genBattles));
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const armStats = (rs) => ({ cB: mean(rs.map((x) => x.c.genBattles)), iB: mean(rs.map((x) => x.i.genBattles)), cS: mean(rs.map((x) => x.c.genSeconds)), iS: mean(rs.map((x) => x.i.genSeconds)) });
  const S = armStats(rows);
  const newCells = cells.filter((c) => c.wallSeconds != null);
  const newSecs = sum(newCells, (c) => c.wallSeconds);

  const explainerMd = [
    '## What is this, and how is it different from today?',
    '',
    "**How battles are spent today.** Each generation, `--halving-rounds` (on by default, R=3) reveals the opponent pool to the candidate teams in growing slices -- a quarter, then half, then all -- and drops the weaker half of teams after each slice. A team cut in round 1 never fights the opponents it would have seen in rounds 2 or 3. The schedule (how many rounds, how big each slice) is fixed in advance, the same every generation regardless of how close or lopsided that generation's field is.",
    '',
    '**How Hoeffding Races decides to stop battling a team.** `--hoeffding-races` (research idea #3) does the same job -- skip battles against teams that are going to lose anyway -- but on an adaptive schedule instead of a fixed one. Opponents are revealed in fixed-size chunks (`--hoeffding-chunk`, default 10). After each chunk, every still-alive team\'s win rate against the opponents fought so far gets a confidence interval (a Wilson interval: wider with fewer battles, narrower with more). The field is split at a cull line (the `--hoeffding-keep` rank, default the median team). A team is cut only when its interval\'s upper bound falls below the cull line\'s lower bound -- not just "currently behind," but "the evidence says it cannot catch up." A generation with clear early losers cuts them after the first chunk; a close generation, where every interval still overlaps, keeps everyone fighting longer.',
    '',
    '**What kind of team gets cut early, and could that be wrong?** A team that loses its first several battles badly gets a tight, low interval and is cut quickly -- usually correctly, since consistent early losses are real evidence. The risk is a team that is actually mid-pack but drew a run of hard opponents by chance in the random reveal order: with few battles seen, its interval is wide, which is exactly what protects it from an unlucky early cut (a wide interval overlaps almost anything) -- but if the interval narrows around a genuinely unlucky sample before enough opponents are seen, that team is cut on a biased slice it never gets to correct. Sequential Halving has the identical risk from its own fixed early slice; Hoeffding\'s statistical stopping rule is meant to make that risk explicit and data-driven rather than schedule-driven, not to remove it.',
    '',
    '**Does this fit "every win counts the same, overall strength vs the crowd"?** Yes, more directly than the opponent-reweighting ideas (Nash averaging, informativeness weights, both dropped for changing what a win is worth). Hoeffding Races never changes how a battle counts -- every fought pairing is still a plain win or loss, unweighted. It only decides, for a team that is already behind with growing confidence, whether the remaining battles are still worth fighting. A team that is genuinely strong will not be cut, because its interval will not fall below the cull line\'s; the only teams that lose fights they might have won are teams that were already correctly predicted to lose most of them. Whether this actually holds up, and whether it costs any team-quality at all in exchange for fewer battles, is what the numbers below measure.',
    '',
  ].join('\n');

  const explainerHtml = `<h2>What is this, and how is it different from today?</h2>
<p><b>How battles are spent today.</b> <code>--halving-rounds</code> (on by default, R=3) reveals the opponent pool in growing slices -- a quarter, then half, then all -- and drops the weaker half of teams after each slice, on a fixed schedule that is the same every generation.</p>
<p><b>How Hoeffding Races decides to stop battling a team.</b> <code>--hoeffding-races</code> (research idea #3) does the same job on an adaptive schedule: opponents revealed in fixed-size chunks, and after each chunk a team is cut only when its win-rate confidence interval (Wilson) no longer overlaps the current cull-line team's interval -- evidence it cannot catch up, not just that it is currently behind.</p>
<p><b>What kind of team gets cut early, and could that be wrong?</b> A team on a real losing streak is cut correctly. The risk is a mid-pack team that draws a run of hard opponents by chance early on; a wide (few-battles) interval protects against that, but the protection weakens as more battles narrow the interval around a biased early sample -- the same risk Sequential Halving's fixed early slice already carries.</p>
<p><b>Does this fit "every win counts the same, overall strength vs the crowd"?</b> Yes, more directly than the opponent-reweighting ideas (Nash averaging, informativeness weights, both dropped). Hoeffding Races never changes what a win is worth; it only decides whether to keep fighting a team that is already predicted to lose. Whether it actually costs any quality for the battles it saves is what the numbers below measure.</p>
`;

  const stopLine = ov.done
    ? `Stopped at ${ov.at} seeds (${'first batch check with a clear answer'}).`
    : `Not finished: ${n} short seeds so far${n < CAP_SEEDS ? '; the budget or the run stopped before the rule fired' : ''}.`;
  const headline = ov.done || n >= 10
    ? `Hoeffding Races scored ${pts(r.mean)} points of team quality against the control over ${r.n} seeds (control ${pct(mean(rows.slice(0, r.n).map((x) => x.c.heldoutMeanTop)))}, idea ${pct(mean(rows.slice(0, r.n).map((x) => x.i.heldoutMeanTop)))}); it was ahead in ${r.wins} of ${r.n}. 95% range: ${pts(r.lower)} to ${pts(r.upper)} points. It fights ${pct(r.battleRatio, 0)} of the control's battles and costs ${pct(r.timeRatio, 0)} of the control's run time.`
    : 'Too few seeds for an answer yet.';
  let capNote = '';
  if (!ov.done && r.verdict === 'unclear') {
    const tt = t95(Math.max(1, n - 1));
    const toExclude = r.mean !== 0 ? Math.ceil((tt * r.sd / Math.abs(r.mean)) ** 2) : Infinity;
    capNote = `The seed-to-seed spread is ${(r.sd * 100).toFixed(1)} points. At that spread about ${Number.isFinite(toExclude) ? toExclude : 'many'} seeds would be needed to separate a ${pts(r.mean)}-point average from the ${(QUALITY_LOSS_BOUND * 100).toFixed(0)}-point keep bound.`;
  }

  const cps = checkpoints(n).map((k) => ({ k, v: verdictAt(rows, k) }));

  const totals = `Wall time of all new runs (short seeds beyond any already-scored ones, including held-out scoring): ${secs(newSecs)} of the ${secs(BUDGET_SECONDS)} budget.`;
  const cell = (a) => {
    const own = data.armFlags[a] ?? [];
    const over = new Set(own.filter((x) => x.startsWith('--')));
    const base = [];
    for (let i = 0; i < data.baseFlags.length; i++) {
      if (over.has(data.baseFlags[i])) { if (i + 1 < data.baseFlags.length && !data.baseFlags[i + 1].startsWith('--')) i++; continue; }
      base.push(data.baseFlags[i]);
    }
    return `node scripts/evolve.mjs out/hoeffding-ab/meta-collection-1500.csv --seed <seed> ${[...base, ...own].join(' ')} --out-dir out/hoeffding-ab/${a}-<seed> --force-fresh`;
  };
  const runCmds = ['bash scripts/setup.sh', 'node scripts/hoeffding-overnight.mjs   # unattended driver: seeds under the stop rule; rerun to resume', `node scripts/compare-search.mjs run --dir out/hoeffding-ab --arms base,hoeffding --seeds ${shortSeeds.join(',')} --top ${top} --heldout ${heldoutCount}`, 'node scripts/compare-search.mjs report --dir out/hoeffding-ab   # from saved results: same numbers'];

  const tableMd = (rs) => ['| seed | control battles | idea battles | control secs | idea secs | control held-out | idea held-out | control top1 | idea top1 |', '|---|---|---|---|---|---|---|---|---|',
    ...rs.map((x) => `| ${x.seed} | ${x.c.genBattles} | ${x.i.genBattles} | ${x.c.genSeconds.toFixed(0)} | ${x.i.genSeconds.toFixed(0)} | ${pct(x.c.heldoutMeanTop)} | ${pct(x.i.heldoutMeanTop)} | ${pct(x.c.heldoutTop1)} | ${pct(x.i.heldoutTop1)} |`)];
  const cpMd = ['| seeds | mean diff (pts) | 95% range (pts) | battle ratio | reading |', '|---|---|---|---|---|', ...cps.map(({ k, v }) => `| ${k} | ${pts(v.mean)} | ${pts(v.lower)} to ${pts(v.upper)} | ${v.battleRatio.toFixed(2)} | ${v.verdict} |`)];

  const md = ['# Hoeffding Races vs the current default search (experimental)', '', explainerMd,
    `## Verdict: ${LABEL[ov.label]}`, '', ov.done ? `${r.why}.` : '', headline, '', stopLine, capNote, '', STOP_RULE, '',
    '## Short runs (8 generations, population 40)', '', `Control = today's default (Sequential Halving R=3, hoeffding off). Idea = identical run with \`--hoeffding-races\` instead (halving off, so it does not both run). ${n} seeds, same seeds for both arms, 30 opponents per generation, meta mode. Quality = mean unweighted win rate (both seats) of each run's top ${top} finalists against ${heldoutCount} fresh meta teams (seed "heldout") that neither arm's search fought.`, '',
    'Checks after each batch:', '', ...cpMd, '',
    `Averages over all ${n} seeds: control ${pct(nCtl)}, idea ${pct(nidea)}, difference ${pts(nidea - nCtl, 2)} points; battles per run ${S.cB.toFixed(0)} vs ${S.iB.toFixed(0)} (ratio ${bR.toFixed(2)}); wall time per run ${S.cS.toFixed(0)} s vs ${S.iS.toFixed(0)} s (ratio ${pct(mean(rows.map((x) => x.i.genSeconds / x.c.genSeconds)), 0)}).`, '', ...tableMd(rows), ''];
  md.push('## Cost', '', totals, '');
  md.push('## Rerun', '', '```', ...runCmds, '```', '', `Short cell: \`${cell('base')}\` (control) or \`${cell('hoeffding')}\` (idea).`, '');
  writeFileSync(path.join(outDir, 'hoeffding-ab.md'), md.join('\n'));

  const trs = (rs) => rs.map((x) => `<tr><td>${x.seed}</td><td>${x.c.genBattles}</td><td>${x.i.genBattles}</td><td>${x.c.genSeconds.toFixed(0)}s</td><td>${x.i.genSeconds.toFixed(0)}s</td><td>${pct(x.c.heldoutMeanTop)}</td><td>${pct(x.i.heldoutMeanTop)}</td><td>${pct(x.c.heldoutTop1)}</td><td>${pct(x.i.heldoutTop1)}</td></tr>`).join('');
  const thead = '<thead><tr><th>seed</th><th>battles ctl</th><th>battles idea</th><th>time ctl</th><th>time idea</th><th>quality ctl</th><th>quality idea</th><th>best team ctl</th><th>best team idea</th></tr></thead>';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hoeffding Races Test</title>
<style>
:root{--bg:#fafaf7;--fg:#1d1d1b;--mut:#6b6b64;--line:#dcdcd3;--ctl:#3b6ea5;--idea:#c2571a;--keep:#2f7d4f;--drop:#b3372f;--unc:#8a7a1f;--zone:#2f7d4f22}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe4;--mut:#9a9a90;--line:#33332f;--ctl:#7fb0e0;--idea:#f0955a;--keep:#6fcf97;--drop:#f08a82;--unc:#e0cf6a;--zone:#6fcf9726}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:760px;padding:24px 16px}
h1{font-size:22px}h2{font-size:18px;margin-top:32px}svg{width:100%;height:auto}.grid{stroke:var(--line)}.tick{fill:var(--mut);font-size:11px}
.ctl{fill:var(--ctl)}.idea{fill:var(--idea)}.head{fill:var(--fg);font-size:14px;font-weight:600}.val{fill:var(--fg);font-size:12px}.mean{stroke-width:3}.ctls{stroke:var(--ctl)}.ideas{stroke:var(--idea)}
.zone{fill:var(--zone)}.zero{stroke:var(--fg);stroke-width:1.5}.band{fill:var(--idea);fill-opacity:.25}.mline{fill:none;stroke:var(--idea);stroke-width:2.5}.cp{stroke:var(--line);stroke-dasharray:3 3}
table{border-collapse:collapse;width:100%;font-size:13px;display:block;overflow-x:auto}th,td{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left}
.v{font-size:14px;border:1px solid currentColor;border-radius:4px;padding:1px 10px;margin-left:8px;display:inline-block}.keep{color:var(--keep)}.drop{color:var(--drop)}.unclear{color:var(--unc)}
.box{border:1px solid var(--line);border-radius:8px;padding:4px 16px;margin:16px 0}details{margin:8px 0}summary{cursor:pointer;color:var(--mut)}.num{color:var(--mut);font-size:13px}code{font-size:12px}pre{white-space:pre-wrap;word-break:break-all}
</style></head><body>
<h1>Hoeffding Races vs the current search <span class="v ${ov.cls}">${esc(LABEL[ov.label])}</span></h1>
${explainerHtml}
<h2>Answer</h2>
<div class="box"><p><b>${esc(LABEL[ov.label])}.</b> ${ov.done ? esc(r.why) + '.' : ''} ${esc(headline)}</p><p>${esc(stopLine)} ${esc(capNote)}</p></div>
<h2>Short runs: ${n} seeds</h2>
${chartSvg(rows, top)}
${rangeSvg(rows)}
<p class="num">Control = today's default search (Sequential Halving, 3 rounds, hoeffding off). Same seeds for both arms. Quality = win rate of each run's top ${top} teams against ${heldoutCount} fresh meta teams neither search fought. Battles per run: ${S.cB.toFixed(0)} control vs ${S.iB.toFixed(0)} idea (ratio ${bR.toFixed(2)}); wall time per run: ${S.cS.toFixed(0)} s vs ${S.iS.toFixed(0)} s.</p>
<details><summary>Checks after each batch of ${BATCH} seeds</summary><table><thead><tr><th>seeds</th><th>mean diff (pts)</th><th>95% range (pts)</th><th>battle ratio</th><th>reading</th></tr></thead><tbody>${cps.map(({ k, v }) => `<tr><td>${k}</td><td>${pts(v.mean)}</td><td>${pts(v.lower)} to ${pts(v.upper)}</td><td>${v.battleRatio.toFixed(2)}</td><td>${esc(v.verdict)}</td></tr>`).join('')}</tbody></table></details>
<details><summary>Per-seed detail</summary>${diffSvg(rows)}<table>${thead}<tbody>${trs(rows)}</tbody></table></details>
<h2>Cost and stop rule</h2>
<p>${esc(totals)}</p>
<p class="num">${esc(STOP_RULE)}</p>
<h2>Rerun</h2><pre><code>${esc(runCmds.join('\n'))}</code></pre>
<p class="num">Short cell: <code>${esc(cell('base'))}</code> (control) or <code>${esc(cell('hoeffding'))}</code> (idea).</p>
</body></html>`;
  writeFileSync(path.join(outDir, 'hoeffding-ab.html'), html);
  console.log(`wrote ${path.join(outDir, 'hoeffding-ab.html')} and .md`);
}
