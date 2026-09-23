// Report for the Hoeffding Races A/B (control = today's default search, halving R=3; idea =
// the same run with --hoeffding-races instead, halving off). Pure function of saved data
// (results.json for the chosen-setting A/B, plus the round-3 diagnosis checkpoints and the
// round-4 setting-probe results): rerun with `node scripts/compare-search.mjs report --dir
// out/hoeffding-ab-cut` and the same bytes come out (round 4, plans/PLAN.md). Writes exactly
// one report file, out/hoeffding-ab.md, plus the narrowing-chart image it embeds.
// Statistics and the stop rule: hoeffding-stats.mjs.
import { writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { mean, pairedRows, verdictAt, stopStatus, checkpoints, capReading, t95, BATCH, CAP_SEEDS, BAND, QUALITY_LOSS_BOUND, CHEAPER_RATIO, BUDGET_SECONDS } from './hoeffding-stats.mjs';

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const pts = (x, d = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}`;
const num = (s) => Number(s.slice(1));
const seedsOf = (cells, arm) => [...new Set(cells.filter((c) => c.arm === arm).map((c) => c.seed))].sort((a, b) => num(a) - num(b));

export const STOP_RULE = `Stop rule (fixed before the extra seeds ran, not tuned afterwards; the same shape as the Nash/informativeness rounds, adapted for a SPEED idea with both a quality bound and a battle-saving bar). After every batch of ${BATCH} seeds (${BATCH}, ${2 * BATCH}, ... up to ${CAP_SEEDS}), take the 95% range of the paired quality difference (idea minus control, Student t) and the mean battle-count ratio (idea / control). KEEP if the idea is quality-better beyond the seed spread, OR if it is at least ${((1 - CHEAPER_RATIO) * 100).toFixed(0)}% cheaper in battles and the quality-loss bound is no worse than ${(QUALITY_LOSS_BOUND * 100).toFixed(0)} points (the Sequential Halving R=3 precedent). DROP if quality is worse beyond the seed spread, or there is no clear battle saving and no quality gain. NO MEANINGFUL DIFFERENCE (counts as drop) if quality is inside +-${BAND * 100} point AND battles are not meaningfully fewer (<5% saved). Otherwise add another batch. At ${CAP_SEEDS} seeds or the 8-hour budget, whichever comes first, the answer is a plain KEEP/DROP reading against the keep bar above -- never left unclear.`;

const LABEL = { keep: 'KEEP', drop: 'DROP', 'no meaningful difference': 'NO MEANINGFUL DIFFERENCE' };

/**
 * Overall answer from the short-run pairs under the fixed rule. Never returns "unclear" or
 * "pending": once the driver has stopped (rule fired, cap hit, or the 8h budget ran out first),
 * the report reads a plain keep/drop against the same keep bar the stop rule uses at the cap
 * (round 4 requirement -- "never pending").
 */
export function overall(rows) {
  const st = stopStatus(rows);
  if (st.stop) return { label: st.result.verdict, at: st.at, result: st.result, ruleFired: !st.result.atCap };
  // Budget stopped the driver before the rule fired on a full batch: read the same keep bar
  // against whatever seeds finished, same as the 100-seed cap reading.
  const v = verdictAt(rows);
  const reading = capReading(v);
  return { label: reading, at: rows.length, result: { ...v, verdict: reading, why: `budget stopped the driver at ${rows.length} seed(s) before a batch checkpoint fired; plain reading against the keep bar (>=20% fewer battles and a quality-loss bound within 3 points) is ${reading.toUpperCase()}, not a statistically clean stop-rule fire`, atCap: true }, ruleFired: false };
}

const secs = (h) => `${(h / 3600).toFixed(2)} h`;

/** How the 95% range of the quality difference narrowed as seeds were added -- written to an SVG file. */
function rangeSvg(rows) {
  const W = 640, H = 300, L = 46, R = W - 16, T = 40, B = 262;
  const N = rows.length;
  const series = [];
  for (let k = 5; k <= N; k++) series.push(verdictAt(rows, k));
  if (series.length < 2) return null;
  const ext = Math.max(BAND * 2, ...series.flatMap((v) => [Math.abs(v.lower), Math.abs(v.upper)])) * 1.1;
  const x = (n) => L + ((n - 5) / Math.max(1, N - 5)) * (R - L);
  const y = (v) => (T + B) / 2 - (v / ext) * ((B - T) / 2);
  const band = series.map((v, k) => `${k ? 'L' : 'M'}${x(v.n).toFixed(1)},${y(v.upper).toFixed(1)}`).join('') + series.slice().reverse().map((v) => `L${x(v.n).toFixed(1)},${y(v.lower).toFixed(1)}`).join('') + 'Z';
  const line = series.map((v, k) => `${k ? 'L' : 'M'}${x(v.n).toFixed(1)},${y(v.mean).toFixed(1)}`).join('');
  const ticks = [];
  for (let v = -Math.floor(ext * 100 / 2) * 2; v <= ext * 100 + 1e-9; v += 2) ticks.push(`<line x1="${L}" x2="${R}" y1="${y(v / 100)}" y2="${y(v / 100)}" class="grid"/><text x="${L - 6}" y="${y(v / 100) + 4}" class="tick" text-anchor="end">${v > 0 ? '+' : ''}${v}</text>`);
  const cps = checkpoints(N).map((n) => `<line x1="${x(n)}" x2="${x(n)}" y1="${T}" y2="${B}" class="cp"/><text x="${x(n)}" y="${B + 16}" class="tick" text-anchor="middle">${n}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="How the range narrowed as seeds were added">
<style>.grid{stroke:#dcdcd3}.tick{fill:#6b6b64;font-size:11px}.head{fill:#1d1d1b;font-size:14px;font-weight:600}.zone{fill:#2f7d4f22}.zero{stroke:#1d1d1b;stroke-width:1.5}.band{fill:#c2571a;fill-opacity:.25}.mline{fill:none;stroke:#c2571a;stroke-width:2.5}.cp{stroke:#dcdcd3;stroke-dasharray:3 3}</style>
<rect width="${W}" height="${H}" fill="#fafaf7"/>
<text x="0" y="16" class="head">How the answer narrowed as seeds were added (idea minus control, points of team quality)</text>
<text x="0" y="30" class="tick">Above 0 = idea better. Shaded band = 95% range; green strip = "no meaningful difference" zone.</text>
<rect x="${L}" y="${y(BAND)}" width="${R - L}" height="${y(-BAND) - y(BAND)}" class="zone"/>${ticks.join('')}${cps}
<line x1="${L}" x2="${R}" y1="${y(0)}" y2="${y(0)}" class="zero"/><path d="${band}" class="band"/><path d="${line}" class="mline"/>
<text x="${(L + R) / 2}" y="${B + 34}" class="tick" text-anchor="middle">seeds run (same seeds for both arms) &#8594;</text></svg>`;
}

/** Third arm: no pruning at all (halving off, hoeffding off) -- "compared to nothing". */
function noPruneSection(cells, seeds, top, heldoutCount) {
  if (!seeds.length) return [];
  const get = (arm, seed) => cells.find((c) => c.arm === arm && c.seed === seed);
  const rows = seeds.map((s) => ({ seed: s, n: get('control', s), b: get('base', s), h: get('hoeffding', s) })).filter((r) => r.n?.heldoutMeanTop != null && r.b?.heldoutMeanTop != null && r.h?.heldoutMeanTop != null);
  if (!rows.length) return [];
  const armMean = (k) => (a) => mean(rows.map((r) => r[a][k]));
  const arms = [['none', 'No pruning (halving off, hoeffding off)', 'n'], ['base', "Sequential Halving (today's default)", 'b'], ['hoeffding', 'Hoeffding Races', 'h']];
  const line = (label, key) => `| ${label} | ${armMean('genBattles')(key).toFixed(0)} | ${armMean('genSeconds')(key).toFixed(0)} | ${pct(armMean('heldoutMeanTop')(key))} |`;
  const note = `Same ${rows.length} seed${rows.length === 1 ? '' : 's'} (a prefix of the short-run seed list) run a third way: no pruning at all -- every team battles every opponent in every generation, the "compared to nothing" baseline both Halving and Hoeffding Races are trying to beat.`;
  return ['## Compared to no pruning at all', '', note, '',
    '| arm | battles/run | seconds/run | quality (top ' + top + ' vs ' + heldoutCount + ' held-out) |', '|---|---|---|---|',
    ...arms.map(([, label, key]) => line(label, key)), ''];
}

/**
 * Round 3 diagnosis (plans/PLAN.md): pure function of saved probe checkpoints under
 * `out/hoeffding-ab/_diagnosis/<label>-genN.json` (real short-cell `evolve.mjs --hoeffding-races`
 * runs, a few minutes each, committed as data -- not a batch of the A/B). Each checkpoint's
 * `timing.hoeffding.roundsDetail` (src/evolve/hoeffding.js) says, per round: teams alive
 * before/after, how many were cut, and the cull-line interval width that explains a zero-cut round.
 */
function cutDiagnosisSection() {
  const dir = path.join('out', 'hoeffding-ab', '_diagnosis');
  if (!existsSync(dir)) return [];
  const labels = [
    { key: 'default', title: "Default settings (chunk=10, keep=0.5, confidence=0.95 -- round 3's A/B idea arm)" },
    { key: 'loose', title: 'Loosened settings (chunk=10, keep=0.5, confidence=0.5)' },
  ];
  const rowsFor = (key) => {
    const files = readdirSync(dir).filter((f) => f.startsWith(`${key}-gen`) && f.endsWith('.json')).sort();
    return files.map((f) => {
      const cp = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      const h = cp.timing?.hoeffding;
      return h ? { generation: cp.generation, h, battleCount: cp.timing.battleCount } : null;
    }).filter(Boolean);
  };
  const sections = labels.map(({ key, title }) => ({ key, title, rows: rowsFor(key) })).filter((s) => s.rows.length);
  if (!sections.length) return [];
  const note = 'Real probe runs (`evolve.mjs --hoeffding-races`, short-cell settings, a few generations, minutes each -- not a batch of the A/B), checkpoints saved under `out/hoeffding-ab/_diagnosis/`. "Battles skipped" is `cutBattlesSkipped` from `src/evolve/hoeffding.js` -- the exact count of pairings never fought because a team was cut -- not a comparison to real battle counts, which also move with the persistent cross-generation battle cache and would misattribute caching as pruning. Wilson-interval width at the cull line explains a zero-cut round directly: at n=10 battles the interval spans roughly +-0.40 (40 points), far wider than the real spread between mid-pack teams, so nothing is ever cut; at n=20 it narrows to about +-0.30 -- still too wide.';
  const md = ['## Round-3 diagnosis detail: does `--hoeffding-races` ever skip battles?', '', note, ''];
  for (const s of sections) {
    md.push(`### ${s.title}`, '');
    for (const { generation, h, battleCount } of s.rows) {
      md.push(`**Generation ${generation}** -- ${battleCount} real battles fought this generation; ${h.cutBattlesSkipped} battles skipped specifically because a team was cut (${h.roundsDetail.reduce((sum, d) => sum + d.cutCount, 0)} team(s) cut, of ${h.roundsDetail[0]?.aliveBefore ?? '?'} alive at the start):`, '');
      md.push('| round | opponents seen | alive before | alive after | cut | cull-line interval width |', '|---|---|---|---|---|---|');
      for (const d of h.roundsDetail) md.push(`| ${d.round} | ${d.opponentsSeen} | ${d.aliveBefore} | ${d.aliveAfter} | ${d.cutCount} | ${d.cullLineIntervalWidth != null ? d.cullLineIntervalWidth.toFixed(2) : '(final round, no check)'} |`);
      md.push('');
    }
  }
  return md;
}

/**
 * Round-4 setting probe (plans/PLAN.md requirement 1): reads `out/hoeffding-probe/results.json`
 * (`compare-search.mjs run --dir out/hoeffding-probe --arms base,conf50,conf60,...`) and reports,
 * per confidence setting, battles/run vs the Halving base cell on the same seed, plus which one
 * was chosen (closest to base) and why.
 */
function settingProbeSection() {
  const file = path.join('out', 'hoeffding-probe', 'results.json');
  if (!existsSync(file)) return { md: [], chosen: null };
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const baseCell = data.cells.find((c) => c.arm === 'base');
  if (!baseCell) return { md: [], chosen: null };
  const probeArms = data.arms.filter((a) => a !== 'base' && a !== 'control');
  const rows = probeArms.map((a) => {
    const c = data.cells.find((x) => x.arm === a);
    if (!c) return null;
    const confFlagIdx = (data.armFlags[a] ?? []).indexOf('--hoeffding-confidence');
    const confidence = confFlagIdx >= 0 ? data.armFlags[a][confFlagIdx + 1] : '0.95';
    return { arm: a, confidence, battles: c.genBattles, ratio: c.genBattles / baseCell.genBattles };
  }).filter(Boolean);
  if (!rows.length) return { md: [], chosen: null };
  const chosen = rows.slice().sort((a, b) => Math.abs(a.ratio - 1) - Math.abs(b.ratio - 1))[0];
  const md = ['## Setting probe: which `--hoeffding-confidence` cuts about as much as Halving?', '',
    `Short probe (1 seed, few generations) at several confidence values, same seed as the Halving base cell (${baseCell.genBattles} battles). The setting whose battle count is closest to Halving's is chosen for the A/B below, so quality is compared at equal cost.`, '',
    '| confidence | battles | ratio to Halving |', '|---|---|---|',
    `| (Halving, base) | ${baseCell.genBattles} | 1.00 |`,
    ...rows.map((r) => `| ${r.confidence} | ${r.battles} | ${r.ratio.toFixed(2)} |`), '',
    `**Chosen: confidence ${chosen.confidence}** (ratio ${chosen.ratio.toFixed(2)}, closest to Halving's cost).`, ''];
  return { md, chosen };
}

/** One-paragraph summary of the OLD 0.95 A/B (out/hoeffding-ab/results.json), if present. */
function old95Section() {
  const file = path.join('out', 'hoeffding-ab', 'results.json');
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const seeds = seedsOf(data.cells, 'base');
  const rows = pairedRows(data.cells, seeds, 'base', 'hoeffding');
  if (!rows.length) return [];
  const bR = mean(rows.map((x) => x.i.genBattles / x.c.genBattles));
  return ['## The old confidence-0.95 result: never cut anything', '',
    `The original 60-seed A/B (\`out/hoeffding-ab/\`) ran \`--hoeffding-confidence 0.95\` (the flag's default) and cut essentially zero battles: mean battles/run ${mean(rows.map((x) => x.i.genBattles)).toFixed(0)} vs Halving's ${mean(rows.map((x) => x.c.genBattles)).toFixed(0)} (ratio ${bR.toFixed(2)}) -- it cost the same as no pruning and proved nothing about the pruning mechanism itself (see the round-3 diagnosis below for why). It is kept here for the record, not as evidence either way.`, ''];
}

export function renderHoeffdingReport(data, outDir) {
  const { top, heldoutCount, cells } = data;
  const shortSeeds = seedsOf(cells, 'base');
  const rows = pairedRows(cells, shortSeeds, 'base', 'hoeffding');
  const noPruneSeeds = seedsOf(cells, 'control');
  const ov = rows.length ? overall(rows) : null;
  const r = ov?.result;
  const n = rows.length;

  const bR = rows.length ? mean(rows.map((x) => x.i.genBattles / x.c.genBattles)) : null;
  const armStats = (rs) => ({ cB: mean(rs.map((x) => x.c.genBattles)), iB: mean(rs.map((x) => x.i.genBattles)), cS: mean(rs.map((x) => x.c.genSeconds)), iS: mean(rs.map((x) => x.i.genSeconds)) });
  const S = rows.length ? armStats(rows) : null;
  const newSecs = cells.filter((c) => c.wallSeconds != null).reduce((s, c) => s + c.wallSeconds, 0);

  const hoeffdingConfidence = (() => {
    const flags = data.armFlags?.hoeffding ?? [];
    const i = flags.indexOf('--hoeffding-confidence');
    return i >= 0 ? flags[i + 1] : '0.95 (default)';
  })();

  const oneSentence = `Round 3 found that the original A/B's idea arm (\`--hoeffding-confidence 0.95\`, the flag's default) cut essentially zero battles -- a setting issue, not a bug (the Wilson interval at that confidence is too wide at these battle counts to ever cross the cull line); a separate bug in the confidence-to-z-score mapping (\`zFor()\`) was also fixed in round 3, but it did not affect 0.95, only lower confidence values. This round's A/B runs at \`--hoeffding-confidence ${hoeffdingConfidence}\`, chosen by the setting probe below to cut about as many battles as Sequential Halving.`;

  const probe = settingProbeSection();

  let verdictMd = [];
  if (ov) {
    const nCtl = mean(rows.map((x) => x.c.heldoutMeanTop)), nidea = mean(rows.map((x) => x.i.heldoutMeanTop));
    const headline = `Hoeffding Races (confidence ${hoeffdingConfidence}) scored ${pts(r.mean)} points of team quality against Sequential Halving over ${r.n} seed(s) (Halving ${pct(mean(rows.slice(0, r.n).map((x) => x.c.heldoutMeanTop)))}, Hoeffding ${pct(mean(rows.slice(0, r.n).map((x) => x.i.heldoutMeanTop)))}); ahead in ${r.wins} of ${r.n}. 95% range: ${pts(r.lower)} to ${pts(r.upper)} points. It fights ${pct(r.battleRatio, 0)} of Halving's battles and costs ${pct(r.timeRatio, 0)} of Halving's run time.`;
    const stopLine = ov.ruleFired ? `Stopped at ${ov.at} seed(s): the stop rule fired.` : `Driver stopped at ${ov.at} seed(s) before a batch checkpoint fired (budget or cap); reading the plain keep bar instead of leaving it unclear, per the stop rule.`;
    verdictMd = [`## Verdict: ${LABEL[ov.label]}`, '', `${r.why}.`, headline, '', stopLine, '', STOP_RULE, '',
      '## Short runs (8 generations, population 40)', '', `Control = Sequential Halving R=3 (today's default, hoeffding off). Idea = identical run with \`--hoeffding-races --hoeffding-confidence ${hoeffdingConfidence}\` instead (halving off). ${n} seeds, same seeds for both arms, 30 opponents per generation, meta mode. Quality = mean unweighted win rate (both seats) of each run's top ${top} finalists against ${heldoutCount} fresh meta teams (seed "heldout") that neither arm's search fought.`, '',
      'Checks after each batch:', '', ...(() => { const cps = checkpoints(n).map((k) => ({ k, v: verdictAt(rows, k) })); return ['| seeds | mean diff (pts) | 95% range (pts) | battle ratio | reading |', '|---|---|---|---|---|', ...cps.map(({ k, v }) => `| ${k} | ${pts(v.mean)} | ${pts(v.lower)} to ${pts(v.upper)} | ${v.battleRatio.toFixed(2)} | ${v.verdict} |`)]; })(), '',
      `Averages over all ${n} seed(s): control ${pct(nCtl)}, idea ${pct(nidea)}, difference ${pts(nidea - nCtl, 2)} points; battles per run ${S.cB.toFixed(0)} vs ${S.iB.toFixed(0)} (ratio ${bR.toFixed(2)}); wall time per run ${S.cS.toFixed(0)} s vs ${S.iS.toFixed(0)} s (ratio ${pct(mean(rows.map((x) => x.i.genSeconds / x.c.genSeconds)), 0)}).`, '',
      '| seed | control battles | idea battles | control secs | idea secs | control held-out | idea held-out | control top1 | idea top1 |', '|---|---|---|---|---|---|---|---|---|',
      ...rows.map((x) => `| ${x.seed} | ${x.c.genBattles} | ${x.i.genBattles} | ${x.c.genSeconds.toFixed(0)} | ${x.i.genSeconds.toFixed(0)} | ${pct(x.c.heldoutMeanTop)} | ${pct(x.i.heldoutMeanTop)} | ${pct(x.c.heldoutTop1)} | ${pct(x.i.heldoutTop1)} |`), ''];
  } else {
    verdictMd = ['## Verdict: not started', '', 'No A/B cells found yet for the chosen setting.', ''];
  }

  // Chart image, embedded relative to out/hoeffding-ab.md.
  const svg = rows.length >= 5 ? rangeSvg(rows) : null;
  const imgPath = path.join('out', 'hoeffding-ab.narrowed.svg');
  const chartMd = [];
  if (svg) {
    writeFileSync(imgPath, svg);
    chartMd.push('## How the answer narrowed', '',
      '![How the range of the quality difference narrowed as seeds were added](hoeffding-ab.narrowed.svg)', '',
      'Caption: the dark line is the running mean quality difference (Hoeffding minus Halving); the shaded band is its 95% range at each seed count; the green horizontal strip is the "no meaningful difference" zone (+-1 point) -- once the whole band clears the strip in one direction, the stop rule fires.', '');
  }

  // Per-generation cut table from a real cell of the new A/B (not just the round-3 probes).
  let cutTableMd = [];
  const hoeffdingCell = cells.find((c) => c.arm === 'hoeffding' && c.dir);
  if (hoeffdingCell) {
    const resultFile = path.join(hoeffdingCell.dir, 'evolve-result.json');
    if (existsSync(resultFile)) {
      const result = JSON.parse(readFileSync(resultFile, 'utf8'));
      const gens = (result.generationRecords ?? []).filter((g) => g.timing?.hoeffding);
      if (gens.length) {
        cutTableMd.push(`## Cut table: seed ${hoeffdingCell.seed}, confidence ${hoeffdingConfidence}`, '',
          `Per-generation cuts from a real cell of this A/B (\`${hoeffdingCell.dir}\`), not the round-3 probe checkpoints.`, '');
        gens.forEach((g, genIndex) => {
          const h = g.timing.hoeffding;
          const cutCount = h.roundsDetail.reduce((s, d) => s + d.cutCount, 0);
          cutTableMd.push(`**Generation ${genIndex}** -- ${g.timing.battleCount} real battles fought; ${h.cutBattlesSkipped} battles skipped by cuts (${cutCount} team(s) cut, of ${h.roundsDetail[0]?.aliveBefore ?? '?'} alive):`, '');
          cutTableMd.push('| round | opponents seen | alive before | alive after | cut | cull-line interval width |', '|---|---|---|---|---|---|');
          for (const d of h.roundsDetail) cutTableMd.push(`| ${d.round} | ${d.opponentsSeen} | ${d.aliveBefore} | ${d.aliveAfter} | ${d.cutCount} | ${d.cullLineIntervalWidth != null ? d.cullLineIntervalWidth.toFixed(2) : '(final round, no check)'} |`);
          cutTableMd.push('');
        });
      }
    }
  }

  const cell = (a) => {
    const own = data.armFlags[a] ?? [];
    const over = new Set(own.filter((x) => x.startsWith('--')));
    const base = [];
    for (let i = 0; i < data.baseFlags.length; i++) {
      if (over.has(data.baseFlags[i])) { if (i + 1 < data.baseFlags.length && !data.baseFlags[i + 1].startsWith('--')) i++; continue; }
      base.push(data.baseFlags[i]);
    }
    return `node scripts/evolve.mjs out/hoeffding-ab-cut/meta-collection-1500.csv --seed <seed> ${[...base, ...own].join(' ')} --out-dir out/hoeffding-ab-cut/${a}-<seed> --force-fresh`;
  };
  const runCmds = ['bash scripts/setup.sh', 'node scripts/hoeffding-overnight.mjs --dir out/hoeffding-ab-cut   # unattended driver: seeds under the stop rule; rerun to resume', `node scripts/compare-search.mjs run --dir out/hoeffding-ab-cut --arms base,hoeffding --seeds ${shortSeeds.join(',') || 's1'} --top ${top ?? 5} --heldout ${heldoutCount ?? 60}`, 'node scripts/compare-search.mjs report --dir out/hoeffding-ab-cut   # from saved results: same numbers'];

  const md = ['# Hoeffding Races vs the current default search (experimental)', '',
    oneSentence, '',
    ...probe.md,
    ...verdictMd,
    ...old95Section(),
    ...noPruneSection(cells, noPruneSeeds, top ?? 5, heldoutCount ?? 60),
    ...cutTableMd,
    ...chartMd,
    ...cutDiagnosisSection(),
    '## Cost', '', `Wall time of all new runs in this A/B (short seeds beyond any already-scored ones, including held-out scoring): ${secs(newSecs)} of the ${secs(BUDGET_SECONDS)} budget.`, '',
    '## Rerun', '', '```', ...runCmds, '```', '', `Short cell: \`${cell('base')}\` (control) or \`${cell('hoeffding')}\` (idea).`, ''];
  writeFileSync(path.join(outDir, 'hoeffding-ab.md'), md.join('\n'));
  console.log(`wrote ${path.join(outDir, 'hoeffding-ab.md')}`);
}
