#!/usr/bin/env node
// Build the recipe A/B comparison report (plans/PLAN.md requirement 9) from the sims' out dirs,
// the chain's attempts file and the curated-100 scores.
//   node scripts/recipe-ab-report.mjs [--smoke]   -> out/recipe-ab[-smoke].{md,html}
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { simDefs, wallTime, quality, verdict, overlap, fmtMs, speciesOf, corePairs, QUALITY_TOP_N } from './recipe-ab-lib.mjs';

const smoke = process.argv.includes('--smoke');
const tag = smoke ? 'recipe-ab-smoke' : 'recipe-ab';
const stateDir = path.join('out', tag);
const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

const attemptsAll = existsSync(path.join(stateDir, 'attempts.jsonl'))
  ? readFileSync(path.join(stateDir, 'attempts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const scores = readJson(path.join(stateDir, 'curated100.json'));

const defs = simDefs(smoke);
const sims = defs.map((def) => {
  const dir = path.join('out', `evolve-${def.name}`);
  const result = readJson(path.join(dir, 'evolve-result.json'));
  const complete = existsSync(path.join(dir, 'evolve-DONE')) && !!result;
  const gens = existsSync(dir)
    ? readdirSync(dir).filter((f) => /^evolve-gen\d+\.json$/.test(f)).map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b) : [];
  const timings = gens.map((g) => readJson(path.join(dir, `evolve-gen${g}.json`))?.timing).filter(Boolean);
  const config = result?.config ?? (gens.length ? readJson(path.join(dir, 'evolve-gen0.json'))?.config : null);
  const attempts = attemptsAll.filter((a) => a.sim === def.name).map((a) => ({ start: a.start, end: a.end, exit: a.exit }));
  const finalMs = complete ? result.eliteTiming?.elapsedMs ?? 0 : 0;
  const { runningMs, downtimeMs } = wallTime(timings, finalMs, attempts);
  const sum = (k) => timings.reduce((s, t) => s + (t[k] ?? 0), 0) + (complete ? result.eliteTiming?.[k] ?? 0 : 0);
  const simulated = sum('battleCount');
  const cached = sum('cachedCount');
  const sc = scores?.sims?.[def.name];
  return {
    def, dir, complete, config, result, attempts, runningMs, downtimeMs, simulated, cached, relaunches: Math.max(0, attempts.length - 1),
    gensDone: gens.length, lastGen: gens.length ? gens[gens.length - 1] : null, gen0Ms: timings[0]?.elapsedMs ?? null, finalMs,
    scored: sc ?? null, quality: sc ? quality(sc.map((s) => s.curatedWinRate)) : null,
    msPerBattle: simulated ? (runningMs / simulated) : null,
  };
});

const L = [];
const q = (s) => (s.complete && s.quality != null ? { quality: s.quality, wallMs: s.runningMs } : null);
L.push(`# Recipe A/B: old standard vs halving vs new standard${smoke ? ' (SMOKE RUN, tiny sizes, not a result)' : ''}`, '');
L.push('## Verdicts', '');
for (const [a, b, what] of [[0, 1, 'does halving cost quality?'], [1, 2, 'does the new sizing?']]) {
  const v = verdict(q(sims[a]), q(sims[b]));
  const qa = sims[a].quality, qb = sims[b].quality;
  L.push(`- **sim ${a + 1} vs sim ${b + 1}** (${what}): **${v.verdict}**` + (v.gap == null
    ? ` -- needs ${!q(sims[a]) ? `sim ${a + 1}` : `sim ${b + 1}`}, which is incomplete or unscored.`
    : ` -- quality ${pct(qa)} vs ${pct(qb)} (gap ${(v.gap * 100).toFixed(1)} pts), wall time ${fmtMs(sims[a].runningMs)} vs ${fmtMs(sims[b].runningMs)}.`));
}
L.push('', `Quality = mean curated-100 win rate of a sim's top ${QUALITY_TOP_N} finalists. Rule: later sim is "keep" if not lower by more than 3 points and its wall time is lower; "worse" if lower by more than 3 points; otherwise "not distinguishable".`, '');
L.push('## Read this first', '',
  '- The curated 100 teams were fought by all three sims during the search, so the curated-100 win rates are shared, not unseen, opponents.',
  '- Each recipe ran once. Run-to-run spread in finalist quality is about 3 points (round 10), so gaps under 3 points are noise.', '');

L.push('## Per sim', '');
const hdr = ['', ...sims.map((s) => `sim ${s.def.n}: ${s.def.name}${s.relaunches ? ' (RELAUNCHED)' : ''}${s.complete ? '' : ' (INCOMPLETE)'}`)];
const c = (s, f) => (s.config ? f(s.config) : 'n/a');
const rows = [
  ['population schedule', (s) => c(s, (k) => `${k.population} -> ${Math.round(k.population * k.populationFinalRatio)} (final ratio ${k.populationFinalRatio})`)],
  ['opponents per gen', (s) => c(s, (k) => k.opponentsPerGen)],
  ['K (sampled opponents)', (s) => c(s, (k) => k.sampledOpponents ?? 'off')],
  ['halving rounds', (s) => c(s, (k) => k.halvingRounds ?? 0)],
  ['seed', (s) => c(s, (k) => k.seed)],
  ['stop reason', (s) => (s.complete ? s.result.stopReason : 'incomplete')],
  ['generations completed', (s) => `${s.gensDone}${s.complete ? '' : ` (last: gen ${s.lastGen ?? 'none'})`}`],
  ['running wall time', (s) => fmtMs(s.runningMs)],
  ['downtime (excluded)', (s) => fmtMs(s.downtimeMs)],
  ['battles simulated', (s) => s.simulated.toLocaleString('en-US')],
  ['battles served from cache', (s) => s.cached.toLocaleString('en-US')],
  ['mean ms per simulated battle', (s) => (s.msPerBattle == null ? 'n/a' : s.msPerBattle.toFixed(1))],
  ['gen-0 time', (s) => fmtMs(s.gen0Ms)],
  ['final-pass time', (s) => (s.complete ? fmtMs(s.finalMs) : 'n/a')],
  ['relaunches', (s) => s.relaunches],
  ['top-5 curated-100 quality', (s) => pct(s.quality)],
];
L.push(`| ${hdr.join(' | ')} |`, `|${hdr.map(() => '---').join('|')}|`);
for (const [name, f] of rows) L.push(`| ${name} | ${sims.map((s) => String(f(s))).join(' | ')} |`);
L.push('');

L.push('## Top 12 teams side by side', '',
  'Teams are lead first. Marks: `T` same team (lead species + set of others) also in another sim\'s top 12, `C` a two-species core also appears in another sim\'s top 12, `S` n species shared with another sim.', '');
const tops = {};
for (const s of sims) if (s.complete) tops[s.def.name] = s.result.elites.slice(0, 12);
const ov = overlap(Object.fromEntries(Object.entries(tops).map(([n, es]) => [n, es.map((e) => e.members.map((m) => m.speciesId ?? speciesOf(m.key)))])));
for (const s of sims) {
  L.push(`### sim ${s.def.n}: ${s.def.name}`, '');
  if (!tops[s.def.name]) { L.push('incomplete -- no finalists.', ''); continue; }
  L.push('| # | team (lead first) | final-pass score | curated-100 | marks |', '|---|---|---|---|---|');
  tops[s.def.name].forEach((e, i) => {
    const m = ov.marks[s.def.name][i];
    const marks = [m.teamIn.length ? `T:${m.teamIn.join(',')}` : '', m.coresIn.length ? `C:${m.coresIn.length}` : '', m.speciesShared.length ? `S:${m.speciesShared.length}` : ''].filter(Boolean).join(' ');
    const cw = s.scored?.find((x) => x.signature === e.signature)?.curatedWinRate;
    L.push(`| ${i + 1} | ${e.members.map((x) => x.name).join(' / ')} | ${pct(e.combinedScore)} | ${pct(cw)} | ${marks} |`);
  });
  L.push('');
}
L.push('Shared between pairs of sims (top 12 each):', '', '| pair | teams | two-species cores | species |', '|---|---|---|---|');
for (const p of ov.pairs) L.push(`| ${p.a} / ${p.b} | ${p.teams} | ${p.cores} | ${p.species} |`);
if (!ov.pairs.length) L.push('| (fewer than two complete sims) | n/a | n/a | n/a |');
L.push('');

L.push('## All finalists ranked by curated-100 win rate', '', '| rank | sim | team (lead first) | curated-100 |', '|---|---|---|---|');
const all = [];
for (const s of sims) if (s.complete && s.scored) for (const f of s.scored) {
  const e = s.result.elites.find((x) => x.signature === f.signature);
  all.push({ sim: s.def.name, team: (e?.members ?? []).map((x) => x.name).join(' / '), wr: f.curatedWinRate });
}
all.sort((a, b) => b.wr - a.wr).forEach((r, i) => L.push(`| ${i + 1} | ${r.sim} | ${r.team} | ${pct(r.wr)} |`));
if (!all.length) L.push('| - | - | no scored finalists | - |');
L.push('');

const md = L.join('\n');
const outBase = path.join('out', tag);
writeFileSync(`${outBase}.md`, md);

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
const html = [];
let table = null;
for (const line of L) {
  if (line.startsWith('|')) {
    if (!table) { table = []; }
    if (/^\|[-| ]+\|$/.test(line)) continue;
    table.push(line.slice(1, -1).split('|').map((x) => x.trim()));
    continue;
  }
  if (table) {
    html.push('<table>' + table.map((r, i) => `<tr>${r.map((x) => `<${i ? 'td' : 'th'}>${inline(x)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('') + '</table>');
    table = null;
  }
  if (line.startsWith('# ')) html.push(`<h1>${inline(line.slice(2))}</h1>`);
  else if (line.startsWith('## ')) html.push(`<h2>${inline(line.slice(3))}</h2>`);
  else if (line.startsWith('### ')) html.push(`<h3>${inline(line.slice(4))}</h3>`);
  else if (line.startsWith('- ')) html.push(`<p>&bull; ${inline(line.slice(2))}</p>`);
  else if (line) html.push(`<p>${inline(line)}</p>`);
}
if (table) html.push('<table>' + table.map((r, i) => `<tr>${r.map((x) => `<${i ? 'td' : 'th'}>${inline(x)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('') + '</table>');
writeFileSync(`${outBase}.html`, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recipe A/B</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 16px;background:#fff;color:#111}table{border-collapse:collapse;margin:1rem 0;display:block;overflow-x:auto}td,th{border:1px solid #bbb;padding:4px 8px;text-align:left}th{background:#eee}@media(prefers-color-scheme:dark){body{background:#151515;color:#eee}td,th{border-color:#555}th{background:#2a2a2a}}</style>
${html.join('\n')}`);
console.log(`[report] wrote ${outBase}.md and ${outBase}.html`);
