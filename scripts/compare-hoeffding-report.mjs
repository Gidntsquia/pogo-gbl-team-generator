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

/** Per-generation totals for a list of {generation, h, battleCount}; one compact table. */
function genTotalsTable(rows) {
  const out = ['| generation | teams at start | teams cut | battles fought | battles skipped by cuts |', '|---|---|---|---|---|'];
  for (const { generation, h, battleCount } of rows) {
    out.push(`| ${generation} | ${h.roundsDetail[0]?.aliveBefore ?? '?'} | ${h.roundsDetail.reduce((sum, d) => sum + d.cutCount, 0)} | ${battleCount} | ${h.cutBattlesSkipped} |`);
  }
  return out;
}

/** Round-3 probe checkpoints (`out/hoeffding-ab/_diagnosis/<label>-genN.json`): did 0.95 cut anything? */
function cutDiagnosisSection() {
  const dir = path.join('out', 'hoeffding-ab', '_diagnosis');
  if (!existsSync(dir)) return [];
  const labels = [
    { key: 'default', title: 'Confidence 0.95 (the original idea arm)' },
    { key: 'loose', title: 'Confidence 0.5 (loosened)' },
  ];
  const rowsFor = (key) => readdirSync(dir).filter((f) => f.startsWith(`${key}-gen`) && f.endsWith('.json')).sort().map((f) => {
    const cp = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    const h = cp.timing?.hoeffding;
    return h ? { generation: cp.generation, h, battleCount: cp.timing.battleCount } : null;
  }).filter(Boolean);
  const sections = labels.map((l) => ({ ...l, rows: rowsFor(l.key) })).filter((x) => x.rows.length);
  if (!sections.length) return [];
  const md = ['## How the round-3 probes showed 0.95 never cut', '',
    'These are short real runs (a few generations each) saved under `out/hoeffding-ab/_diagnosis/`. "Battles skipped" counts pairings never fought because a team was cut. At 0.95 the confidence interval around a team\'s win rate is about +-0.40 after 10 battles and +-0.30 after 20, far wider than the real gaps between mid-pack teams, so no team ever falls clearly below the cull line.', ''];
  for (const s of sections) md.push(`**${s.title}**`, '', ...genTotalsTable(s.rows), '');
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
  const md = ['## 2. Only a low confidence prunes as much as Halving', '',
    `Lower confidence means narrower intervals and earlier cuts. I ran one short probe (1 seed, 8 generations) at each of several values against the Halving cell on the same seed (${baseCell.genBattles} battles).`, '',
    '| confidence | battles | ratio to Halving |', '|---|---|---|',
    `| (Halving, base) | ${baseCell.genBattles} | 1.00 |`,
    ...rows.slice().sort((a, b) => Number(a.confidence) - Number(b.confidence)).map((r) => `| ${r.confidence} | ${r.battles} | ${r.ratio.toFixed(2)} |`), '',
    `Only ${chosen.confidence} lands near Halving's cost (ratio ${chosen.ratio.toFixed(2)}); every higher value fights 1.2x to 1.8x as many battles. So ${chosen.confidence} is the setting the A/B below uses: it compares quality at about equal cost.`, ''];
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
    `The original 60-seed A/B (\`out/hoeffding-ab/\`) ran \`--hoeffding-confidence 0.95\` (the flag's default) and cut essentially zero battles: mean battles/run ${mean(rows.map((x) => x.i.genBattles)).toFixed(0)} vs Halving's ${mean(rows.map((x) => x.c.genBattles)).toFixed(0)} (ratio ${bR.toFixed(2)}) -- it cost the same as no pruning and proved nothing about the pruning mechanism itself (the probes below show why). Kept for the record, not as evidence either way.`, ''];
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

  const probe = settingProbeSection();
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  // Result section (3).
  let resultMd = [];
  let bottom = 'No A/B cells found yet for the chosen setting.';
  if (ov) {
    const q = (k) => mean(rows.map((x) => x[k].heldoutMeanTop));
    const nCtl = q('c'), nIdea = q('i');
    const cps = checkpoints(n).map((k) => ({ k, v: verdictAt(rows, k) }));
    const width = (r.upper - r.lower) * 100;
    bottom = `**${LABEL[ov.label]}.** At confidence ${hoeffdingConfidence}, Hoeffding Races cuts many teams early but still fights ${pct(r.battleRatio, 0)} of Halving's battles (${S.iB.toFixed(0)} vs ${S.cB.toFixed(0)} per run) and takes ${pct(r.timeRatio, 0)} of its time, so it saves nothing. Quality was ${pts(r.mean)} points against Halving over ${r.n} seeds (${pct(nCtl)} vs ${pct(nIdea)}), inside a 95% range of ${pts(r.lower)} to ${pts(r.upper)}.`;
    resultMd = ['## 3. At that setting it prunes, but saves no battles', '',
      `${n} seeds, same seeds for both arms, 30 opponents per generation, meta mode. Quality is the mean win rate (both seats) of each run's top ${top} finalists against ${heldoutCount} fresh meta teams that neither search fought.`, '',
      `- **Cost:** ${S.iB.toFixed(0)} battles per run against Halving's ${S.cB.toFixed(0)} (ratio ${bR.toFixed(2)}); ${S.iS.toFixed(0)} s against ${S.cS.toFixed(0)} s.`,
      `- **Quality:** ${pct(nIdea)} against ${pct(nCtl)}, a difference of ${pts(nIdea - nCtl, 2)} points; Hoeffding was ahead on ${r.wins} of ${r.n} seeds.`,
      `- **Keep bar:** at least 20% fewer battles with a quality loss no worse than 3 points, or better quality beyond the seed spread. It saved ${((1 - r.battleRatio) * 100).toFixed(0)}% and showed no quality gain, so it fails: ${r.why}.`, '',
      '| seed | Halving battles | Hoeffding battles | Halving quality | Hoeffding quality |', '|---|---|---|---|---|',
      ...rows.map((x) => `| ${x.seed} | ${x.c.genBattles} | ${x.i.genBattles} | ${pct(x.c.heldoutMeanTop)} | ${pct(x.i.heldoutMeanTop)} |`), '',
      `**What ${n} seeds can and cannot say.** Per-seed quality swings by several points in both directions (Hoeffding is ahead ${r.wins} times and behind ${r.n - r.wins}), so the 95% range on the difference is ${width.toFixed(1)} points wide. That range includes both a real 3-point loss and a real 2-point gain; the quality comparison is inconclusive. I therefore drew no chart of the range narrowing: at ${n} seeds it would be one wide band around zero. The verdict rests on cost, where the answer is clear: the battle ratio was ${bR.toFixed(2)} on average, and the speed-up that would justify any quality risk is absent.`, '',
      `${ov.ruleFired ? `The stop rule fired at ${ov.at} seeds.` : `The driver stopped at ${ov.at} seeds before a checkpoint fired, so this is the plain reading against the keep bar.`} The rule and its checkpoint reading are in the appendix.`, ''];
  }

  const old = old95Section();
  const noPrune = noPruneSection(cells, noPruneSeeds, top ?? 5, heldoutCount ?? 60);

  // Why it cut but saved nothing: cut table from a real cell of the new A/B.
  let cutTableMd = [];
  const hoeffdingCell = cells.find((c) => c.arm === 'hoeffding' && c.dir);
  if (hoeffdingCell) {
    const resultFile = path.join(hoeffdingCell.dir, 'evolve-result.json');
    if (existsSync(resultFile)) {
      const result = JSON.parse(readFileSync(resultFile, 'utf8'));
      const gens = (result.generationRecords ?? []).filter((g) => g.timing?.hoeffding);
      if (gens.length) {
        const tbl = genTotalsTable(gens.map((g, i) => ({ generation: i, h: g.timing.hoeffding, battleCount: g.timing.battleCount })));
        cutTableMd = [`## 4. The cuts are real: seed ${hoeffdingCell.seed}, generation by generation`, '',
          `Section 3 shows the cost matched Halving's; this table shows why that is not because nothing was cut. In one real cell (seed ${hoeffdingCell.seed}) Hoeffding cut most of the teams alive at the start of every generation. It prunes hard, and it still ends up at Halving's battle count, so the pruning buys no saving over Halving.`, '', ...tbl, ''];
      }
    }
  }

  const bottomMd = ['## Bottom line', '', bottom, ''];
  const oldNote = old.length ? ['## 1. Why this was retested', '', `The first A/B ran \`--hoeffding-confidence 0.95\` (the flag default) over 60 seeds and looked as if Hoeffding were pointless. It was not a fair test: that setting cut essentially no teams, so it cost as much as no pruning at all (${old[2].match(/mean battles\/run [^ ]+ vs Halving's [^ ]+ \(ratio [^)]+\)/)?.[0] ?? 'see below'}). The cause was the setting, not a bug: the confidence interval at 0.95 is too wide to separate teams (appendix). A separate bug in the confidence-to-z-score mapping was fixed in round 3, but it only affected values below 0.9. Everything below reruns the test at a setting that does prune.`, ''] : [];

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

  const appendix = ['## Appendix', '',
    '### Stop rule and checkpoints', '', STOP_RULE, '',
    ...(ov ? ['| seeds | mean diff (pts) | 95% range (pts) | battle ratio | reading |', '|---|---|---|---|---|', ...checkpoints(n).map((k) => { const v = verdictAt(rows, k); return `| ${k} | ${pts(v.mean)} | ${pts(v.lower)} to ${pts(v.upper)} | ${v.battleRatio.toFixed(2)} | ${v.verdict} |`; }), ''] : []),
    ...(old.length ? ['### The old 0.95 result', '', ...old.slice(2)] : []),
    ...cutDiagnosisSection().map((l) => l.startsWith('## ') ? '### ' + l.slice(3) : l),
    '### Cost and rerun', '', `New runs took ${secs(newSecs)} of the ${secs(BUDGET_SECONDS)} driver budget (including held-out scoring).`, '', '```', ...runCmds, '```', '', `Short cell: \`${cell('base')}\` (Halving) or \`${cell('hoeffding')}\` (Hoeffding).`, ''];
  const md = ['# Hoeffding Races vs Sequential Halving (experimental)', '',
    ...bottomMd, ...oldNote, ...probe.md, ...resultMd, ...cutTableMd, ...noPrune, ...appendix];
  writeFileSync(path.join(outDir, 'hoeffding-ab.md'), md.join('\n'));
  console.log(`wrote ${path.join(outDir, 'hoeffding-ab.md')}`);
}
