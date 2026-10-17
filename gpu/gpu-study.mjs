// Round 8 report (plans round 8 R10/R12): profile-first GPU study -> out/gpu-study.html.
//
//   node gpu/gpu-study.mjs
//
// Reads only out/gpu/study/ (fork results, prof metrics, lit sources, chain log, fork log), the chain's runs
// out/evolve-gpu8-*, the width calibration out/gpu/width-calib-*.json and the round-7 island/auto runs it cites.
// Every number on the page is emitted through num(key, value) as <span data-k="key" data-v="raw">; it is also written to
// out/gpu/study/page-numbers.json. gpu/gpu/study/check_page.py recomputes each key from the source files on its own and
// fails on any mismatch (out/gpu/study/check.log).
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { allRuns, runStats, compareRuns } from './gpu/study/runs.mjs';

const OUT = 'out', S = 'out/gpu/study';
const rd = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const txt = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const sum = (a, f = (x) => x) => a.reduce((s, x) => s + f(x), 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- numbers: every page number goes through num()
const NUMS = {};
/**
 * Format a number for the page and register it for check_page.py.
 * @param {string} key source key (see check_page.py for each family)
 * @param {number|null} v raw value
 * @param {number|string} [fmt] decimals, or '%' (v is a 0..1 share, 0 decimals) / '%1' (1 decimal) / ',' (thousands, 0 decimals)
 * @param {object} [o] {sign: true} prints a leading + for positives
 * @returns {string} HTML span, or "n/a"
 */
function num(key, v, fmt = 1, o = {}) {
  if (v == null || Number.isNaN(v)) return '<span class="na">n/a</span>';
  let t;
  if (fmt === '%') t = `${Math.round(v * 100)}%`;
  else if (fmt === '%1') t = `${(v * 100).toFixed(1)}%`;
  else if (fmt === ',') t = Math.round(v).toLocaleString('en-US');
  else t = (+v).toFixed(fmt);
  if (o.sign && v > 0) t = `+${t}`;
  t = t.replace(/^-/, '−');
  NUMS[key] = { v, t, fmt };
  return `<span class="v" data-k="${esc(key)}" data-f="${fmt}${o.sign ? '+' : ''}">${t}</span>`;
}

// ---------------------------------------------------------------- inputs
const chainLog = txt(`${S}/chain.log`);
const parseStages = (log, k0 = 0) => [...log.matchAll(/^== done (\d+) (\w+) (\S+) (\S+) exit (\d+) (.*)$/gm)].map((m) => ({ k: k0 + +m[1], kind: m[2], fork: m[3], name: m[4], rc: +m[5], at: m[6] }));
// the overnight chain, then the interleaved A/B chain of the next morning (out/gpu/study/ab.sh: base, stack, occ-ni, repeated)
const abLog = txt(`${S}/ab.log`);
const abStages = parseStages(abLog, 1000);
const nightStages = parseStages(chainLog);
const chainStages = nightStages.concat(abStages);
// only runs the chain made count (forks' own dump runs share the out/evolve-gpu8- prefix)
const chainRunNames = new Set(chainStages.filter((c) => c.kind === 'run').map((c) => c.name));
const runs = allRuns(OUT).filter((r) => chainRunNames.has(r.name));
const chainStarts = [...chainLog.matchAll(/^== stage (\d+) (\w+) (\S+) (\S+).* start (.*)$/gm)].map((m) => ({ k: +m[1], name: m[4], at: m[5] }));
const forkLines = txt(`${S}/forks.jsonl`).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const forkDirs = existsSync(S) ? readdirSync(S, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
const results = Object.fromEntries(forkDirs.map((f) => [f, rd(`${S}/${f}/result.json`)]).filter(([, r]) => r));
const sources = rd(`${S}/lit/sources.json`) ?? [];
const prof = rd(`${S}/prof/metrics.json`);
const calibFile = existsSync(`${OUT}/gpu`) ? readdirSync(`${OUT}/gpu`).find((f) => /^width-calib-.*\.json$/.test(f)) : null;
const calib = calibFile ? rd(`${OUT}/gpu/${calibFile}`) : null;

// settings = run names without the trailing -a/-b/-c/-d
const setOf = (name) => name.replace(/-([a-z]|\d+)$/, '');
const settings = {};
for (const r of runs) (settings[setOf(r.name)] ??= []).push(r);
const okRuns = (rs) => rs.filter((r) => r.exit === 0 && r.warmPerGen != null);
const setWarm = (s) => mean(okRuns(settings[s] ?? []).map((r) => r.warmPerGen));
const BASE = 'base';
const baseRuns = okRuns(settings[BASE] ?? []);
const baseWarm = setWarm(BASE);
const r7 = Object.fromEntries(['isl-h3-p1', 'isl-h3-p1-r2', 'auto-h3-p1', 'auto-h3-p1-r2'].map((n) => [n, runStats(`${OUT}/evolve-gpu7-${n}`)]));
const r7isl = mean(['isl-h3-p1', 'isl-h3-p1-r2'].map((n) => r7[n]?.warmPerGen).filter((x) => x != null));
const r7auto = mean(['auto-h3-p1', 'auto-h3-p1-r2'].map((n) => r7[n]?.warmPerGen).filter((x) => x != null));

// controls: production-path runs (same checkpoints as base-a). The GPU got faster through the night (base-a 21:18 vs runs
// after 23:30 ~1.3 s/gen apart), so each card is compared with the 2 control runs nearest in chain order to each of its runs.
const CTRL_RE = /^base-[a-z]$|-prod-[a-z]$|^cpushare-share0-[a-z]$|^ab-base-\d+$/;
const stageK = Object.fromEntries(chainStages.map((c) => [c.name, c.k]));
const ctrlRuns = okRuns(runs.filter((r) => CTRL_RE.test(r.name))).sort((a, b) => stageK[a.name] - stageK[b.name]);
const nearCtrl = (names) => {
  const pick = new Set();
  for (const n of names) [...ctrlRuns].sort((a, b) => Math.abs(stageK[a.name] - stageK[n]) - Math.abs(stageK[b.name] - stageK[n]) || stageK[a.name] - stageK[b.name]).slice(0, 2).forEach((r) => pick.add(r));
  return [...pick];
};
const ctrlSets = {};
// a set is same-setting control runs made back to back (each within 5 chain stages of the previous one), so base-a/b
// (21:18 ET) and base-c/d (04:44 ET) are two sets: the drift between them is not run-to-run noise
const lastK = {};
for (const r of ctrlRuns) {
  const st = setOf(r.name), k = stageK[r.name];
  const key = lastK[st] != null && k - lastK[st].k <= 5 ? lastK[st].key : `${st}@${k}`;
  lastK[st] = { k, key };
  (ctrlSets[key] ??= []).push(r.warmPerGen);
}
// noise = largest spread between same-setting control runs made back to back
const ctrlNoise = Object.values(ctrlSets).filter((v) => v.length >= 2).map((v) => Math.max(...v) - Math.min(...v));
// cards: every fork's cards; measured = mean warm of the card's runs minus the mean of its nearest control runs
const cards = Object.entries(results).flatMap(([fork, r]) => (r.cards ?? []).map((c) => ({ ...c, fork })));
for (const c of cards) {
  const rs = okRuns(runs.filter((r) => (c.runs ?? []).includes(r.name) && !CTRL_RE.test(r.name))); // a card's own -prod- runs are controls
  c.measuredWarm = rs.length ? mean(rs.map((r) => r.warmPerGen)) : null;
  c.ctrl = rs.length ? nearCtrl(rs.map((r) => r.name)) : [];
  c.ctrlWarm = c.ctrl.length ? mean(c.ctrl.map((r) => r.warmPerGen)) : null;
  c.measured = c.measuredWarm != null && c.ctrlWarm != null ? c.measuredWarm - c.ctrlWarm : null;
  c.nRuns = rs.length;
  c.ownRuns = rs;
  // noise defense (amendment 2026-10-17): the spread of the card's own runs and of its same-hour production runs; a gain
  // counts as "not noise" only when it is larger than both spreads
  const spread = (xs) => (xs.length >= 2 ? Math.max(...xs) - Math.min(...xs) : 0);
  c.ownSpread = spread(rs.map((r) => r.warmPerGen));
  c.ctrlSpread = spread(c.ctrl.map((r) => r.warmPerGen));
  c.clears = c.measured != null ? Math.abs(c.measured) > Math.max(c.ownSpread, c.ctrlSpread) : null;
  c.verified = /^100(\.0+)?%.*\b0 flagged/.test(c.verify_agreement ?? '');
  const p = c.predicted_s_per_gen ?? [];
  c.mid = p.length === 2 ? (p[0] + p[1]) / 2 : null;
  c.rankKey = c.measured != null ? c.measured : c.mid ?? 99;
}
// a literature idea a fork already built and measured is not a "build next" pick: coop-search is what the split fork
// prototyped (verify PASS, bench 2.4-4x slower), so it ranks with the dropped ones and points at that result.
const BUILT_BY = { 'coop-search': 'split' };
for (const c of cards) if (BUILT_BY[c.id] && results[BUILT_BY[c.id]]) {
  c.rankKey = 99; c.builtBy = BUILT_BY[c.id];
  c.do_next = `Drop: the ${c.builtBy} fork built this (card "${results[c.builtBy].cards[0].name}") and it ran slower; see that card.`;
}
cards.sort((a, b) => a.rankKey - b.rankKey || a.id.localeCompare(b.id));
// R5: 6-12 cards on the page. The six candidates the plan names always stay; the rest fill up to 12 in rank order, and
// lower-ranked ones move to a collapsed "Also looked at" list (name, verdict and do-next only).
const NAMED = ['compact-state', 'queue-kernel', 'route-longest-to-cpu', 'two-stream-overlap', 'lockstep', 'width-calib'];
const MAXC = 12;
const shownSet = new Set(cards.filter((c) => NAMED.includes(c.id)));
for (const c of cards) { if (shownSet.size >= MAXC) break; shownSet.add(c); }
const allCards = [...cards];
const extraCards = cards.filter((c) => !shownSet.has(c));
cards.splice(0, cards.length, ...cards.filter((c) => shownSet.has(c)));
const noise = ctrlNoise.length ? Math.max(...ctrlNoise) : null;
const wins = cards.filter((c) => c.measured != null && c.verified && c.measured < -(noise ?? 0));
const bestWin = wins[0] ?? null;
const topUntested = cards.find((c) => !c.tested && !c.builtBy) ?? null;

// ---------------------------------------------------------------- morning A/B (out/gpu/study/ab.sh): base, stack, occ-ni interleaved
// Each setting's runs are spread across the chain, so GPU drift hits all three alike; the gain is a setting's mean minus the
// base mean, and it "clears noise" when it is larger than both settings' own run-to-run spread.
const AB_SET = { 'compact-state': 'ab-stack', 'noinline-cold': 'ab-occni' };
// short plain names for the one-line summary
const SHORT = { 'compact-state': 'battle state on-chip', 'noinline-cold': 'cold helpers as calls' };
const abBase = okRuns(settings['ab-base'] ?? []);
const abSpread = (rs) => (rs.length >= 2 ? Math.max(...rs.map((r) => r.warmPerGen)) - Math.min(...rs.map((r) => r.warmPerGen)) : 0);
const AB = {};
for (const [id, st] of Object.entries(AB_SET)) {
  const rs = okRuns(settings[st] ?? []);
  if (!rs.length || !abBase.length) continue;
  const warm = mean(rs.map((r) => r.warmPerGen)), bw = mean(abBase.map((r) => r.warmPerGen));
  AB[id] = { set: st, rs, warm, base: bw, d: warm - bw, spread: abSpread(rs), baseSpread: abSpread(abBase), rounds: Math.min(rs.length, abBase.length) };
  AB[id].clears = Math.abs(AB[id].d) > Math.max(AB[id].spread, AB[id].baseSpread);
}
for (const c of allCards) if (AB[c.id]) c.ab = AB[c.id];
const abWins = cards.filter((c) => c.ab && c.verified && c.ab.d < 0 && c.ab.clears).sort((a, b) => a.ab.d - b.ab.d);
const abBaseWarm = abBase.length ? mean(abBase.map((r) => r.warmPerGen)) : null;

// ---------------------------------------------------------------- plain words per card (amendment 2026-10-17): one-line meaning
// and a short "do next" that reads in full at phone width; the fork's full do-next line stays under the card's details.
const PLAIN = {
  'route-longest-to-cpu': ['A launch ends when its slowest battle ends; let the CPU take the few slowest so the GPU finishes sooner.', 'Not now (slower, see gain); first test whether the slow battles can be predicted.'],
  early: ['While a halving round\'s last battles finish, start the next round for teams already certain to survive.', 'Only as an add-on to the tail-filling card below; on its own it measured slower.'],
  'coop-search': ['A battle\'s look-ahead search is done once per thread today; share it between the threads of one battle instead.', 'Drop: the split fork built it and it ran slower (see that card).'],
  'spec-next-round': ['Use the idle end of a launch to battle the teams most likely to reach the next round; keep what turned out needed.', 'Measure first: replay round-1 launches and count how many likely survivors really survive.'],
  wavefront: ['Break the one big GPU program into small ones per battle phase so each needs fewer registers.', 'Needs the Nsight counters (issue-slot use) first; the battle state is big to pass between stages.'],
  'regroup-phase': ['Put battles that are at the same kind of step next to each other so a warp\'s 32 threads agree more often.', 'Only if Nsight shows fewer than 24 of 32 threads busy per step; not measured yet.'],
  'cuda-graphs': ['Record the launch sequence once and replay it, to save launch overhead.', 'Drop: launch overhead is microseconds; our launches last seconds.'],
  lockstep: ['Every launch moves every unfinished battle a few steps, then stops; RL simulators work this way.', 'Drop: measured slower (gain line above).'],
  'noinline-cold': ['Rarely used battle code (switch-ins, saving state) becomes separate calls, so the main loop needs fewer registers.', 'Implement in production (11 one-word edits), then find which of the two edit groups gives the gain.'],
  occupancy: ['Force the compiler to use fewer registers per thread so more battles are loaded per GPU core.', 'Drop: the forced register spills cost more than the extra loaded warps gain.'],
  'pool-small': ['Give each battle a quarter of its scratch space; re-run the few that overflow.', 'Drop: measured slower; scratch size is not what limits speed.'],
  'stack-limit': ['Reserve less GPU memory per thread for the same work.', 'Optional memory saving only; not a speed change.'],
  'queue-kernel': ['Each thread runs one whole battle, then takes the next from a shared list.', 'Drop: measured slower; a launch still waits for its longest battle.'],
  split: ['The threads of one battle each take one shield case of its look-ahead.', 'Drop: the cases depend on each other, so most guesses are wasted; its bench ran slower.'],
  'compact-state': ['Store each battle\'s data in smaller number types so more of it fits the fast cache next to the GPU core.', 'Implement in production: port the compact Move/Mon and range checks, re-run verify_3v3 and one A/B.'],
  'compact-records': ['The same trick for the turn and timer records: smaller number types.', 'Verify and A/B together with the compact battle state next round.'],
  'shared-state': ['Put the battle data in the GPU core\'s own fast memory; it does not fit.', 'Drop unless the scratch pool shrinks first.'],
  'two-stream-overlap': ['Do the CPU-side copying and prep while the GPU is still busy with the previous batch.', 'Drop: measured slower; CPU-side work is a small part of a generation anyway.'],
  'width-calib': ['Measure once per GPU how many threads per battle run fastest and save it to a file.', 'Done this round: auto reads the file (G=1 on this GPU).'],
};
for (const c of allCards) if (!PLAIN[c.id]) console.warn('no plain-words line for card', c.id);
// ---------------------------------------------------------------- styles
const css = `ol.src{font-size:.9em;padding-left:2em}ol.src .says,ol.src .why{margin:.15em 0}:root{--link:#1f5fc4;--bg:#fff;--fg:#1d2330;--mut:#5b6577;--line:#d9dee7;--card:#f4f6f9;--ok:#157347;--bad:#b42318;--warn:#a15c00;--c0:#2f6fdb;--c1:#e0832a;--c2:#3aa676;--c3:#a259c4;--c4:#8a94a6}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--link:#8ab4ff;--bg:#14171d;--fg:#e6e9ef;--mut:#9aa3b2;--line:#2c3340;--card:#1c2028;--ok:#4cc38a;--bad:#ff7b72;--warn:#e3b341;--c0:#6ea0ff;--c1:#f2a65a;--c2:#5ccf98;--c3:#c792ea;--c4:#77808f}}
:root[data-theme="dark"]{--link:#8ab4ff;--bg:#14171d;--fg:#e6e9ef;--mut:#9aa3b2;--line:#2c3340;--card:#1c2028;--ok:#4cc38a;--bad:#ff7b72;--warn:#e3b341;--c0:#6ea0ff;--c1:#f2a65a;--c2:#5ccf98;--c3:#c792ea;--c4:#77808f}
*{box-sizing:border-box}a{color:var(--link)}body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;margin:0 auto;max-width:860px;padding:16px}
h1{font-size:1.45rem;margin:.2rem 0}h2{font-size:1.2rem;margin-top:2.2rem;border-bottom:1px solid var(--line);padding-bottom:4px}
h2 .n{display:inline-block;background:var(--c0);color:var(--bg);border-radius:50%;width:1.6em;height:1.6em;text-align:center;line-height:1.6em;font-size:.8em;margin-right:.4em}
p{margin:.4rem 0}.mut,small{color:var(--mut)}.na{color:var(--mut)}code{font-size:.85em;background:var(--card);padding:1px 4px;border-radius:3px;word-break:break-word}
.rec{background:var(--card);border:2px solid var(--c0);border-radius:10px;padding:10px 14px;margin:1rem 0}.rec h2{margin:.2rem 0 .4rem;border:0;font-size:1.15rem}
.rec ol{padding-left:1.3rem;margin:.3rem 0}.rec li{margin:.55rem 0}.rec .gain{color:var(--ok);font-weight:700}.rec .cmd{display:block;margin-top:2px}
.ba{display:flex;gap:10px;flex-wrap:wrap;margin:.6rem 0}.ba div{flex:1 1 140px;background:var(--bg);border-radius:8px;padding:6px 10px;text-align:center}.ba b{display:block;font-size:1.5rem}
ol.rank{list-style:none;padding:0;margin:.5rem 0;counter-reset:r}ol.rank>li{counter-increment:r;border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:.5rem 0}
ol.rank>li>.t::before{content:counter(r) ". ";font-weight:700;color:var(--c0)}.t{font-weight:700}.badge{display:inline-block;font-size:12px;border-radius:10px;padding:0 7px;margin-left:4px;vertical-align:middle}
.b-test{background:var(--c2);color:var(--bg)}.b-un{background:var(--c4);color:var(--bg)}.b-fail{background:var(--bad);color:var(--bg)}
.next{margin-top:3px}.next::before{content:"Do next → ";color:var(--c0);font-weight:600}
.sum{background:var(--card);border-radius:10px;padding:10px 14px;margin:1rem 0}.sum h2{margin:.2rem 0 .4rem;border:0;font-size:1.15rem}.sum ol{padding-left:1.3rem;margin:.3rem 0}.sum li{margin:.4rem 0}
.mean{color:var(--mut);margin:.1rem 0 .3rem;font-size:14.5px}.data{font-size:13.5px;margin:.2rem 0}.data .l{color:var(--mut)}.rec table,.rank table{font-size:13px;margin:.3rem 0}.rec .tw,.rank .tw{overflow-x:visible}.rec td,.rank td{word-break:normal}
svg.fig{width:100%;height:auto;background:var(--card);border-radius:8px;margin:.5rem 0;display:block}svg.fig text{fill:var(--fg);font-size:13px}svg.fig .s{fill:var(--mut);font-size:11.5px}svg.fig .h{font-weight:700}
ul.find{margin:.4rem 0;padding-left:1.2rem}ul.find li{margin:.25rem 0}.sup{display:inline-block;font-size:13px;color:var(--mut);border:1px solid var(--line);border-radius:12px;padding:1px 9px;margin:.3rem 0}
.sup a{text-decoration:none}.q{font-weight:600;margin:.3rem 0}
.mc{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:.6rem 0}.mc .nm{font-weight:700}.mc p{margin:.15rem 0;font-size:14px;line-height:1.4}.mc .l{color:var(--mut);display:inline-block;min-width:5.5em}
details{margin:.6rem 0}summary{cursor:pointer;color:var(--mut)}.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13.5px;margin:.4rem 0}th,td{border:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}th{background:var(--card)}
.ok{color:var(--ok);font-weight:700}.bad{color:var(--bad);font-weight:700}dl.gl dt{font-weight:700;margin-top:.5rem}dl.gl dd{margin:0 0 0 .2rem}
.nav{margin:.2rem 0;padding-left:1.4rem}.def{border-bottom:1px dotted var(--mut)}.defs{font-size:13.5px;color:var(--mut);border-left:3px solid var(--line);padding:2px 0 2px 8px;margin:.3rem 0}.defs span{display:block}.defs b{color:var(--fg)}.term{font-weight:600}`;

// ---------------------------------------------------------------- glossary: defined inline where first used, and at the end
const GLOSS = {
  thread: 'the GPU\'s smallest worker; it runs one copy of the battle code. Also called a lane.',
  lane: 'another word for a thread: one of the 32 slots of a warp.',
  warp: '32 threads that always run the same instruction together; if their battles need different steps, the others wait.',
  kernel: 'the program the GPU runs (here: the battle simulator, written in CUDA).',
  launch: 'one batch of battles handed to the GPU at once; it ends when its slowest battle ends.',
  occupancy: 'the share of the 48 warp slots of an SM (one of the GPU\'s 68 cores) that are filled; more filled slots hide waits.',
  register: 'the fastest storage, private to a thread; each SM has a fixed number, so more per thread means fewer threads loaded.',
  'local memory': 'a thread\'s private overflow space (its "stack"); it lives in the slow main GPU memory, only cached.',
  stall: 'a cycle in which a warp is ready to run but waits, e.g. for memory to arrive.',
  stream: 'a queue of GPU work; two streams let two launches, or a copy and a launch, overlap.',
  bucket: 'a range of launch sizes (e.g. 2,500–5,000 battles) that share one width setting.',
  width: 'G, how many threads run one battle together. They repeat the same work, so a wider battle is not split up.',
  'warm generation': 'a generation after the battle cache has filled; its time is the score here.',
};
const seen = new Set();
/** A glossary term in running text; autoDefine() adds its definition at its first appearance on the page. */
const T = (term, shown = term) => shown;
const TERMS = Object.keys(GLOSS).sort((a, b) => b.length - a.length);
const termRe = new RegExp(`\\b(${TERMS.map((t) => t.replace(/ /g, '\\s+')).join('|')})(e?s)?\\b`, 'gi');
const SKIP = new Set(['svg', 'code', 'h1', 'h2', 'summary', 'th', 'a', 'title', 'style', 'dt', 'dd', 'script']);
/**
 * Walk the page HTML in document order and give each glossary term its plain-words definition, in brackets, at its
 * first appearance in running text (not inside charts, code, headings, links or the glossary).
 * @param {string} html
 * @returns {string}
 */
function autoDefine(html) {
  const stack = [], pending = [];
  const flush = () => (pending.length ? `<div class="defs">${pending.splice(0).map(([w, k]) => `<span><b>${w}</b>: ${GLOSS[k]}</span>`).join('')}</div>` : '');
  return html.split(/(<[^>]+>)/).map((seg) => {
    const m = seg.match(/^<(\/?)([a-zA-Z0-9]+)[^>]*?(\/?)>$/);
    if (m) {
      const tag = m[2].toLowerCase();
      if (m[1]) {
        const i = stack.lastIndexOf(tag);
        if (i >= 0) stack.length = i;
        if (tag === 'li') return flush() + seg; // inside the list item
        if (tag === 'p') return seg + flush(); // right after the paragraph
        return seg;
      }
      if (!m[3] && !/^(br|img|meta|link|hr|input|rect|circle|line|path)$/.test(tag)) stack.push(tag);
      return seg;
    }
    if (seg.startsWith('<') || stack.some((t) => SKIP.has(t)) || !stack.some((t) => t === 'p' || t === 'li')) return seg;
    return seg.replace(termRe, (w, base) => {
      const k = base.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(k)) return w;
      seen.add(k);
      pending.push([w, k]);
      return `<span class="term def">${w}</span>`;
    });
  }).join('');
}

// ---------------------------------------------------------------- small helpers
const ul = (items) => `<ul class="find">${items.filter(Boolean).slice(0, 3).map((x) => `<li>${x}</li>`).join('')}</ul>`;
/** The "supports" tag under a step: 's2' = summary point 2, 3 = recommendation line 3. */
const sup = (...ids) => `<p class="sup">supports: ${ids.map((n) => (String(n).startsWith('s') ? `<a href="#sum-${String(n).slice(1)}">summary point ${String(n).slice(1)}</a>` : `<a href="#rec-${n}">recommendation line ${n}</a>`)).join(', ')}</p>`;
const table = (head, rows) => `<div class="tw"><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c ?? ''}</td>`).join('')}</tr>`).join('')}</table></div>`;
const STEPS = [];
const step = (id, title, body) => { STEPS.push({ id, title }); return `<section id="${id}"><h2><span class="n">${STEPS.length}</span>${title}</h2>${body}</section>`; };
const W = 360; // every chart is drawn 360 units wide so it is legible at 390 px without zoom
const svg = (h, inner, label) => `<svg viewBox="0 0 ${W} ${h}" class="fig" role="img" aria-label="${esc(label)}">${inner}</svg>`;
const tx = (x, y, s, cls = '', anchor = 'start', extra = '') => `<text x="${x}" y="${y}" text-anchor="${anchor}"${cls ? ` class="${cls}"` : ''}${extra}>${s}</text>`;
const plain = (h) => String(h).replace(/<[^>]+>/g, '');
/** num() for SVG text: a tspan with the same data-k registration. */
const nt = (key, v, fmt = 1, o = {}) => num(key, v, fmt, o).replace(/^<span/, '<tspan').replace(/<\/span>$/, '</tspan>');

// ---------------------------------------------------------------- step: where the time goes (R3)
const BK = [
  ['host', 'host prep + copy', 'var(--c4)', (b) => (b.plan ?? 0) + (b.pack ?? 0) + (b.transport ?? 0)],
  ['kernel', 'GPU: battles running', 'var(--c0)', (b) => b.kernel ?? 0],
  ['tail', 'GPU: tail (last battles)', 'var(--c1)', (b) => b.tail ?? 0],
  ['post', 'host: read results', 'var(--c3)', (b) => (b.map ?? 0) + (b.accumulate ?? 0) + (b.waitCpu ?? 0) + (b.flagged ?? 0)],
  ['ga', 'CPU: GA + checkpoint', 'var(--c2)', (b) => (b.ga ?? 0) + (b.checkpoint ?? 0) + (b.report ?? 0)],
];
const profRun = baseRuns[0] ?? null;
const profJ = profRun ? rd(`${profRun.dir}/gpu-profile.json`) : null;
const warmGens = profJ && profRun.sat >= 0 ? profJ.generations.filter((g) => g.gen >= profRun.sat) : [];
const genSplit = Object.fromEntries(BK.map(([k, , , f]) => [k, mean(warmGens.map((g) => f(g.buckets)))]));
const genOther = mean(warmGens.map((g) => g.wall - sum(BK, ([, , , f]) => f(g.buckets))));
const genWallMean = mean(warmGens.map((g) => g.wall));
const exGen = warmGens.find((g) => g.steps === 3 && g.gen >= (profRun?.sat ?? 0)) ?? null;
const exSteps = exGen ? profJ.steps.filter((s) => s.gen === exGen.gen) : [];
function stackRow(y, parts, scale, x0, label, keyBase, total) {
  let x = x0, g = tx(4, y + 15, label, 'h');
  for (const [k, , col, v] of parts) { const w = v * scale; g += `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="22" fill="${col}"><title>${k} ${v.toFixed(2)} s</title></rect>`; x += w; }
  return g + tx(x + 4, y + 15, `${nt(`${keyBase}.wall`, total, 1)} s`, 's');
}
function timePicture() {
  if (!warmGens.length) return '';
  const x0 = 62, maxW = Math.max(...exSteps.map((s) => s.wall), genWallMean), sc = (W - x0 - 46) / maxW;
  let g = tx(4, 16, `Seconds per warm generation (${esc(profRun.name)})`, 'h');
  g += stackRow(26, BK.map(([k, l, c]) => [l, k, c, genSplit[k]]).concat([['other', 'other', 'var(--line)', genOther]]), sc, x0, 'avg gen', `gen.${profRun.name}.mean`, genWallMean);
  g += tx(4, 72, `Its 3 launches (gen ${nt(`gen.${profRun.name}.ex`, exGen.gen, 0)})`, 'h');
  exSteps.forEach((s, i) => {
    const y = 82 + i * 30;
    g += stackRow(y, BK.slice(0, 4).map(([k, l, c, f]) => [l, k, c, f(s.buckets)]), sc, x0, `${nt(`launch.${profRun.name}.${exGen.gen}.${i}.n`, s.n, ',')}`, `launch.${profRun.name}.${exGen.gen}.${i}`, s.wall);
  });
  let ly = 82 + exSteps.length * 30 + 10;
  BK.forEach(([, l, c], i) => { const cx = 4 + (i % 2) * 180, cy = ly + Math.floor(i / 2) * 18; g += `<rect x="${cx}" y="${cy}" width="12" height="12" fill="${c}"/>` + tx(cx + 17, cy + 10, l, 's'); });
  ly += Math.ceil(BK.length / 2) * 18 + 4;
  return svg(ly, g, 'where a warm generation\'s time goes');
}
const tailShare = genWallMean ? genSplit.tail / genWallMean : null;
const gpuShare = genWallMean ? (genSplit.kernel + genSplit.tail) / genWallMean : null;
const stepTime = () => step('time', 'Where a generation\'s time goes', `
<p class="q">The standard sim (halving 3, population 1×) spends ${num(`gen.${profRun?.name}.mean.wall`, genWallMean, 1)} s per warm generation. Which part is the GPU?</p>
${timePicture()}
${ul([
    `The GPU is busy for ${num(`gen.${profRun?.name}.mean.gpushare`, gpuShare, '%')} of a generation; host work and the genetic algorithm (GA) together take ${num(`gen.${profRun?.name}.mean.hostga`, genWallMean ? (genSplit.host + genSplit.post + genSplit.ga) / genWallMean : null, '%')}.`,
    `${num(`gen.${profRun?.name}.mean.tailshare`, tailShare, '%')} is "tail": the GPU waits on a ${T('launch')}'s last, longest battles while most of it sits idle.`,
    `So the GPU side is the whole game: speed comes from finishing battles faster, not from the CPU side.`,
  ])}
${sup('s1', 1, 4)}
<details><summary>Per-generation numbers (every generation of ${esc(profRun?.name ?? '')})</summary>${profJ ? table(['gen', 'wall s', ...BK.map(([, l]) => l), 'battles'], profJ.generations.map((g) => [g.gen, g.wall.toFixed(2), ...BK.map(([, , , f]) => f(g.buckets).toFixed(2)), g.battles])) : ''}<p class="mut">From ${esc(profRun?.dir ?? '')}/gpu-profile.json; warm = from saturation generation ${profRun?.sat}.</p></details>`);

// ---------------------------------------------------------------- step: profiler readout (R1/R2)
/** One metric card: three lines + a bar of each launch's value against NVIDIA's healthy range. */
function metricCard(m) {
  const vals = m.values ?? [];
  const L = prof?.launches ?? [];
  const known = vals.filter((v) => v != null);
  const isPct = /^%/.test(m.unit ?? '');
  const max = m.scaleMax ?? (isPct ? 100 : m.unit === 'threads of 32' ? 32 : Math.max(...known, m.healthy?.lo ?? 0, m.healthy?.hi ?? 0) * 1.15 || 1);
  const x0 = 46, x1 = W - 54, X = (v) => x0 + (Math.min(v, max) / max) * (x1 - x0);
  const fmt = isPct ? 1 : m.unit === 'threads of 32' ? 1 : m.unit === 'bytes' ? ',' : 2;
  let g = '';
  const h = m.healthy;
  const top = 6, rows = Math.max(1, L.length), bot = top + rows * 20;
  if (h && (h.lo != null || h.hi != null)) {
    const a = X(h.lo ?? 0), b = X(h.hi ?? max);
    g += `<rect x="${a}" y="${top - 2}" width="${b - a}" height="${bot - top + 4}" fill="var(--ok)" opacity="0.14"/>`;
    g += tx(Math.min(Math.max((a + b) / 2, 110), W - 110), bot + 14, `healthy (NVIDIA): ${h.lo != null ? `≥ ${h.lo}` : ''}${h.lo != null && h.hi != null ? ' and ' : ''}${h.hi != null ? `≤ ${h.hi}` : ''}`, 's', 'middle');
  } else g += tx(x0, bot + 14, 'NVIDIA names no healthy range for this one', 's');
  L.forEach((l, i) => {
    const v = vals[i], y = top + i * 20;
    g += tx(4, y + 13, esc(l.id), 's');
    if (v == null) { g += tx(x0, y + 13, 'not measured', 's'); return; }
    g += `<rect x="${x0}" y="${y + 2}" width="${X(v) - x0}" height="13" rx="2" fill="var(--c0)"/>` + tx(X(v) + 4, y + 13, `${nt(`prof.${m.id}.${l.id}`, v, fmt)}${isPct ? '%' : ''}`, 's');
  });
  return `<div class="mc"><div class="nm">${esc(m.name)}</div>
<p><span class="l">What it is:</span> ${esc(m.what)}</p><p><span class="l">Ours:</span> ${esc(m.ours)}</p><p><span class="l">For speed:</span> ${esc(SHORT_MEANS[m.id] ?? m.means)}</p>
${svg(bot + 22, g, m.name)}<details><summary>How measured</summary><small>${esc(m.method ?? '')}</small></details></div>`;
}
// page rule: no paragraph over 3 lines at phone width; shorter wording for the prof fork's longest line
const SHORT_MEANS = { warp_exec_efficiency: 'one battle per thread (width 1): a warp\'s threads take different branches and it runs each in turn' };
function stallPicture() {
  const st = (prof?.stalls ?? []).filter((s) => (s.share ?? []).some((v) => v != null));
  if (!st.length) return (prof?.stalls ?? []).length ? `<p class="mut">Stall reasons (why warps wait): not measured, they need the blocked counters.</p>` : '';
  const L = prof.launches, x0 = 150, x1 = W - 40;
  let g = tx(4, 16, 'Why warps wait: top stall reasons (share of waits)', 'h'), y = 28;
  st.forEach((s, i) => {
    g += tx(4, y + 12, esc(s.reason), '');
    L.forEach((l, j) => {
      const v = s.share?.[j];
      if (v == null) return;
      g += `<rect x="${x0}" y="${y + j * 11}" width="${v * (x1 - x0)}" height="9" fill="${['var(--c0)', 'var(--c1)', 'var(--c3)'][j % 3]}"/>` + tx(x0 + v * (x1 - x0) + 3, y + j * 11 + 8, nt(`stall.${i}.${l.id}`, v, '%'), 's');
    });
    y += L.length * 11 + 10;
  });
  L.forEach((l, j) => { g += `<rect x="${4 + j * 90}" y="${y + 2}" width="10" height="10" fill="${['var(--c0)', 'var(--c1)', 'var(--c3)'][j % 3]}"/>` + tx(18 + j * 90, y + 11, esc(l.id), 's'); });
  return svg(y + 20, g, 'top stall reasons');
}
const M = Object.fromEntries((prof?.metrics ?? []).map((m) => [m.id, m]));
const profLaunchIds = (prof?.launches ?? []).map((l) => l.id);
const mv = (id, i) => M[id]?.values?.[i] ?? null;
const lastI = profLaunchIds.length - 1;

// ---------------------------------------------------------------- step: prototype runs (R7/R8)
const setNames = Object.keys(settings).filter((s) => okRuns(settings[s]).length);
const cardOfSet = (s) => allCards.find((c) => (c.runs ?? []).some((n) => setOf(n) === s));
const setLabel = (s) => (s === BASE ? 'baseline (today\'s defaults)' : cardOfSet(s)?.name ?? s);
const setRows = setNames.map((s) => ({ s, warm: setWarm(s), rs: okRuns(settings[s]), card: cardOfSet(s) })).sort((a, b) => (a.s === BASE ? -1 : b.s === BASE ? 1 : a.warm - b.warm));
// each tested setting against the production runs made nearest it in time (the GPU drifted ~1.3 s/gen overnight, so one
// fixed baseline would credit early-vs-late differences to the prototypes)
const varTag = (r) => (r.env || '').split(/\s+/).filter((e) => e && !/^(POGO_GPU_STUDY|POGO_GPU_\w*LOG|POGO_GPU_WIDTH_CALIB)=/.test(e))
  .map((e) => e.replace(/^POGO_GPU_|^CPU_SHARE=/, (m) => (m === 'CPU_SHARE=' ? 'share ' : '')).toLowerCase()).join(' ');
// chart labels are never cut: a label longer than one chart line is wrapped onto a second line (amendment 2026-10-17)
const CHARS = 58; // characters that fit one 360-unit chart line at the small font
const wrap = (t, n = CHARS) => { const out = []; let line = ''; for (const w of String(t).split(' ')) { if (line && (line + ' ' + w).length > n) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w; } if (line) out.push(line); return out; };
const AB_RE = /^ab-/;
const deltaRows = setNames.filter((st) => st !== BASE && !AB_RE.test(st) && !okRuns(settings[st]).some((r) => CTRL_RE.test(r.name))).map((st) => {
  const rs = okRuns(settings[st]), ctrl = nearCtrl(rs.map((r) => r.name)), cw = mean(ctrl.map((r) => r.warmPerGen));
  const tag = st === 'width-selfcal' ? 'builds its file' : st === 'streams-time' ? 'timing log only' : varTag(rs[0]);
  return { s: st, rs, ctrl, cw, d: setWarm(st) - cw, label: `${cardOfSet(st)?.name ?? st}${tag ? ` (${tag})` : ''}` };
}).sort((a, b) => a.d - b.d);
function runsPicture() {
  if (!deltaRows.length) return '';
  const all = deltaRows.flatMap((r) => [r.d, ...r.rs.map((x) => x.warmPerGen - r.cw)]);
  const lim = Math.ceil(Math.max(2, ...all.map(Math.abs)) / 2) * 2, x0 = 8, x1 = W - 8, X = (v) => x0 + ((v + lim) / (2 * lim)) * (x1 - x0), LH = 13;
  const labels = deltaRows.map((r) => wrap(r.label));
  let g = tx(4, 16, 'Change in s per warm generation', 'h') + tx(4, 30, 'vs production runs made the same hour', 's'), top = 40;
  const rowH = (i) => labels[i].length * LH + 24;
  const bot = top + sum(deltaRows.map((_, i) => rowH(i))), nz = noise ?? 0;
  g += `<rect x="${X(-nz)}" y="${top}" width="${X(nz) - X(-nz)}" height="${bot - top}" fill="var(--fg)" opacity="0.07"/>`;
  for (let v = -lim; v <= lim; v += lim <= 4 ? 1 : 2) g += `<line x1="${X(v)}" x2="${X(v)}" y1="${top}" y2="${bot}" stroke="var(--line)"/>` + tx(X(v), bot + 13, v > 0 ? `+${v}` : v, 's', 'middle');
  let y = top;
  deltaRows.forEach((r, i) => {
    const col = r.d < -nz ? 'var(--c2)' : r.d > nz ? 'var(--c1)' : 'var(--c0)';
    labels[i].forEach((l, j) => { g += tx(x0, y + 11 + j * LH, esc(l), 's'); });
    const by = y + labels[i].length * LH + 2;
    g += `<rect x="${X(Math.min(0, r.d))}" y="${by}" width="${Math.abs(X(r.d) - X(0))}" height="14" rx="2" fill="${col}"/>`;
    for (const x of r.rs) g += `<circle cx="${X(x.warmPerGen - r.cw)}" cy="${by + 7}" r="3" fill="var(--fg)"><title>${esc(x.name)} ${x.warmPerGen.toFixed(2)} s</title></circle>`;
    const right = r.d >= 0;
    const inside = right && X(r.d) > x1 - 60;
    if (inside) g += tx(X(r.d) - 4, by + 12, `${nt(`delta.${r.s}`, r.d, 1, { sign: true })} s`, 'h', 'end', ' style="fill:#fff"');
    else g += tx(right ? Math.max(X(r.d), ...r.rs.map((x) => X(x.warmPerGen - r.cw))) + 6 : Math.min(X(r.d), ...r.rs.map((x) => X(x.warmPerGen - r.cw))) - 6, by + 12, `${nt(`delta.${r.s}`, r.d, 1, { sign: true })} s`, 'h', right ? 'start' : 'end');
    y += rowH(i);
  });
  g += `<line x1="${X(0)}" x2="${X(0)}" y1="${top}" y2="${bot}" stroke="var(--fg)"/>`;
  g += tx(4, bot + 30, 'left = faster · dots = each run · grey = noise', 's') + tx(4, bot + 44, 'green = faster than noise · orange = slower', 's');
  return svg(bot + 52, g, 'change in warm seconds per generation per tested setting');
}
// morning A/B picture: one dot per run, in chain order, one row per setting; defaults vs the two overnight wins
function abPicture() {
  const sets = [['ab-base', 'defaults', 'var(--c4)'], ...Object.values(AB).map((a) => [a.set, allCards.find((c) => c.ab === a)?.name ?? a.set, 'var(--c2)'])];
  const rs = sets.flatMap(([s]) => okRuns(settings[s] ?? []));
  if (!rs.length) return '';
  const ws = rs.map((r) => r.warmPerGen), lo = Math.floor(Math.min(...ws) * 2) / 2 - 0.25, hi = Math.ceil(Math.max(...ws) * 2) / 2 + 0.25;
  const x0 = 8, x1 = W - 8, X = (v) => x0 + ((v - lo) / (hi - lo)) * (x1 - x0), LH = 13;
  let g = tx(4, 16, 'Morning A/B: warm s per generation, each run', 'h') + tx(4, 30, 'settings interleaved, so drift hits all three alike', 's'), y = 40;
  const top = y;
  for (const [s, label, col] of sets) {
    const lines = wrap(label), runsOf = okRuns(settings[s] ?? []);
    lines.forEach((l, j) => { g += tx(x0, y + 11 + j * LH, esc(l), 's'); });
    const by = y + lines.length * LH + 2, m = mean(runsOf.map((r) => r.warmPerGen));
    if (runsOf.length) {
      const a = Math.min(...runsOf.map((r) => r.warmPerGen)), b = Math.max(...runsOf.map((r) => r.warmPerGen));
      g += `<rect x="${X(a)}" y="${by}" width="${Math.max(2, X(b) - X(a))}" height="14" rx="2" fill="${col}" opacity="0.35"/>`;
      g += `<line x1="${X(m)}" x2="${X(m)}" y1="${by - 2}" y2="${by + 16}" stroke="var(--fg)" stroke-width="2"/>`;
      for (const r of runsOf) g += `<circle cx="${X(r.warmPerGen)}" cy="${by + 7}" r="3.5" fill="var(--fg)"><title>${esc(r.name)} ${r.warmPerGen.toFixed(2)} s</title></circle>`;
      g += tx(X(b) + 8 > x1 - 70 ? X(a) - 6 : X(b) + 8, by + 12, `mean ${nt(`ab.${s}.warm`, m, 2)}`, 'h', X(b) + 8 > x1 - 70 ? 'end' : 'start');
    }
    y += lines.length * LH + 24;
  }
  const bot = y;
  for (let v = Math.ceil(lo * 2) / 2; v <= hi; v += 0.5) g += `<line x1="${X(v)}" x2="${X(v)}" y1="${top}" y2="${bot}" stroke="var(--line)"/>` + tx(X(v), bot + 13, v.toFixed(1), 's', 'middle');
  g += tx(4, bot + 30, 'dots = runs · shaded = spread (min to max) · bar = mean', 's');
  return svg(bot + 38, g, 'morning A/B runs');
}
const runRow = (r) => [esc(r.name), esc(r.env || '(defaults)'), r.exit, r.gens, num(`run.${r.name}.sat`, r.sat, 0), num(`run.${r.name}.warm`, r.warmPerGen, 2), num(`run.${r.name}.total`, r.total, 0), num(`run.${r.name}.bps`, r.bps, ',')];
const baseFirst = nightStages.find((c) => c.kind === 'run'), baseLast = [...nightStages].reverse().find((c) => c.kind === 'run');
const baseDrift = (() => {
  const b = baseRuns.slice().sort((a, c) => (chainStages.find((x) => x.name === a.name)?.k ?? 0) - (chainStages.find((x) => x.name === c.name)?.k ?? 0));
  if (b.length < 3) return null;
  const first = mean(b.slice(0, 2).map((r) => r.warmPerGen)), last = mean(b.slice(-2).map((r) => r.warmPerGen));
  return { first, last, d: last / first - 1 };
})();

// ---------------------------------------------------------------- step: fork log (R6)
const tParse = (s) => { const m = String(s).match(/(\d{4}-\d\d-\d\d) (\d\d):(\d\d):(\d\d)/); return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`).getTime() / 1000 : null; };
const hhmm = (s) => String(s).match(/(\d\d:\d\d)/)?.[1] ?? '?';
const forks = (() => {
  const by = {};
  for (const l of forkLines) {
    const f = (by[l.fork] ??= { fork: l.fork, start: null, finish: null, produced: '' });
    if (l.event === 'start' && !f.start) f.start = l.at;
    if (l.event === 'finish') { f.finish = l.at; f.produced = l.produced ?? f.produced; }
  }
  return Object.values(by).sort((a, b) => (tParse(a.start) ?? 0) - (tParse(b.start) ?? 0));
})();
function forkPicture() {
  if (!forks.length) return '';
  const ts = forks.flatMap((f) => [tParse(f.start), tParse(f.finish)]).filter(Boolean).concat(chainStages.map((c) => tParse(c.at)).filter(Boolean));
  const t0 = Math.min(...ts), t1 = Math.max(...ts), x0 = 74, x1 = W - 8, X = (t) => x0 + ((t - t0) / Math.max(1, t1 - t0)) * (x1 - x0), rh = 17;
  let g = tx(4, 16, 'Research forks (one bar each, US Eastern time)', 'h'), top = 26;
  forks.forEach((f, i) => {
    const y = top + i * rh, a = tParse(f.start), b = tParse(f.finish) ?? t1;
    g += tx(4, y + 11, esc(f.fork), 's') + `<rect x="${X(a)}" y="${y + 2}" width="${Math.max(2, X(b) - X(a))}" height="11" rx="2" fill="${f.finish ? 'var(--c0)' : 'var(--c4)'}"/>`;
  });
  const y = top + forks.length * rh + 4;
  g += tx(4, y + 11, 'chain runs', 's');
  for (const c of chainStages) { const b = tParse(c.at); g += `<line x1="${X(b)}" x2="${X(b)}" y1="${y + 1}" y2="${y + 14}" stroke="${c.rc ? 'var(--bad)' : 'var(--c2)'}" stroke-width="1.5"/>`; }
  const hours = []; for (let t = Math.ceil(t0 / 3600) * 3600; t <= t1; t += 3600) hours.push(t);
  for (const [i, t] of hours.entries()) g += (i % 2 ? '' : tx(X(t), y + 30, new Date(t * 1000).toTimeString().slice(0, 5), 's', 'middle')) + `<line x1="${X(t)}" x2="${X(t)}" y1="${top}" y2="${y + 18}" stroke="var(--line)"/>`;
  return svg(y + 38, g, 'fork timeline');
}

// ---------------------------------------------------------------- ranked list + recommendation
const fmtRange = (c) => (c.predicted_s_per_gen?.length === 2 ? `${num(`card.${c.id}.lo`, c.predicted_s_per_gen[0], 1, { sign: true })} to ${num(`card.${c.id}.hi`, c.predicted_s_per_gen[1], 1, { sign: true })} s` : 'n/a');
const badge = (c) => (c.tested ? (c.verified ? '<span class="badge b-test">tested</span>' : '<span class="badge b-fail">tested, check failed</span>') : '<span class="badge b-un">not tested</span>');
// one short data clause: drop file references, cut at ';', then at the last ' and ' before 115 chars (3 phone lines)
const shortData = (t) => {
  let x = firstSentence(t).replace(/\s*\((?:out|docs|gpu)\/[^)]*\)/g, '').split(';')[0].trim();
  if (x.length > 115) { const i = x.lastIndexOf(' and ', 115); if (i > 40) x = x.slice(0, i); }
  return x.replace(/[,:]$/, '');
};
const firstSentence = (t) => String(t ?? '').split(/(?<=[.;])\s/)[0];
const warmList = (rs) => rs.map((r) => num(`run.${r.name}.warm`, r.warmPerGen, 2)).join(' · ');
const yesNo = (b) => (b ? '<span class="ok">yes</span>' : '<span class="bad">no</span>');
/**
 * The data a card's gain rests on, shown before the gain (amendment 2026-10-17): for a measured card a small table of its
 * runs and of the production runs made the same hour (and the morning A/B when it has one), each with its spread; for a
 * predicted card the first sentence of the fork's evidence.
 */
function cardData(c) {
  if (c.measured == null) return `<p class="data"><span class="l">Data:</span> ${esc(shortData(c.evidence))}</p>`;
  const rows = [
    ['this change, overnight', warmList(c.ownRuns), num(`card.${c.id}.ownspread`, c.ownSpread, 2)],
    ['defaults, same hour', warmList(c.ctrl), num(`card.${c.id}.ctrlspread`, c.ctrlSpread, 2)],
  ];
  if (c.ab) rows.push(['this change, morning A/B', warmList(c.ab.rs), num(`ab.${c.ab.set}.spread`, c.ab.spread, 2)], ['defaults, morning A/B', warmList(abBase), num('ab.ab-base.spread', c.ab.baseSpread, 2)]);
  return table(['warm s per generation', 'runs', 'spread'], rows);
}
/** The gain and, beside it, why it is not noise: the gain against both spreads in the table above. */
const gainLine = (c) => {
  if (c.measured == null) return `<b>Predicted:</b> ${fmtRange(c)} per warm generation (not measured).`;
  let t = `<b>Measured:</b> ${num(`card.${c.id}.measured`, c.measured, 1, { sign: true })} s per warm generation (mean of ${num(`card.${c.id}.nruns`, c.nRuns, 0)} runs minus same-hour defaults). Larger than both spreads: ${yesNo(c.clears)}.`;
  if (c.ab) t += `</div><div><b>Morning A/B:</b> ${num(`ab.${c.ab.set}.delta`, c.ab.d, 1, { sign: true })} s over ${num(`ab.${c.ab.set}.rounds`, c.ab.rounds, 0)} interleaved rounds; larger than both spreads: ${yesNo(c.ab.clears)}.`;
  return t;
};
/** The one-line "Do next": an overnight win that the morning A/B could not separate from noise is re-measured, not shipped. */
const abVeto = (c) => (c.ab && !c.ab.clears ? `Not yet: the A/B read ${num(`ab.${c.ab.set}.delta`, c.ab.d, 1, { sign: true })} s, within noise; run a longer one first.` : null);
const WIDTH_APPLIED = /load_calib/.test(txt('gpu/gpu/width.py'));
const nextShort = (c) => (c.builtBy ? esc(`Drop: the ${c.builtBy} fork built this and it ran slower; see its card.`) : abVeto(c) ?? esc(PLAIN[c.id]?.[1] ?? firstSentence(c.do_next)));
function cardLi(c) {
  return `<li id="card-${esc(c.id)}"><div class="t">${esc(c.name)} ${badge(c)}</div>
<p class="mean">${esc(PLAIN[c.id]?.[0] ?? '')}</p>
${cardData(c)}<div>${gainLine(c)}</div><div class="next">${nextShort(c)}</div>
<details><summary>Why, evidence, what it touches, risk</summary>
<p><b>Do next, in full:</b> ${esc(c.do_next)}</p>
<p><b>Why it could be faster:</b> ${esc(c.mechanism)}</p><p><b>Evidence:</b> ${esc(c.evidence)}</p><p><b>Touches:</b> ${esc(c.touches)}</p><p><b>Risk:</b> ${esc(c.risk)}</p>
${c.tested ? `<p><b>Check:</b> verify_3v3 ${esc(c.verify_agreement || 'not run')} (<code>${esc(c.verify || '')}</code>); runs ${(c.runs ?? []).map(esc).join(', ') || 'none'}</p>` : ''}
<p class="mut">from fork ${esc(c.fork)} · ${esc(`out/gpu/study/${c.fork}/result.json`)}</p></details></li>`;
}

// ---------------------------------------------------------------- step: profiler readout (R1/R2)
const sass = rd(`${S}/prof/sass/sass-counts.json`);
const sassRes = (k) => { const m = (sass?.res_usage ?? '').match(new RegExp(`battle3v3_slice:\\s*\\n?\\s*.*?\\b${k}:(\\d+)`)); return m ? +m[1] : null; };
const noNsight = /ERR_NVGPUCTRPERM/.test(txt(`${S}/prof/ncu-attempt.log`)) || /no counters|ERR_NVGPUCTRPERM/.test(JSON.stringify(prof?.stalls ?? ''));
const occA = (i) => mv('achieved_occupancy', i), wee = (i) => mv('warp_exec_efficiency', i), sma = (i) => mv('sm_active_share', i);
const stepProf = () => step('profile', 'What the GPU profile says', `
<p class="q">Three real launches (${profLaunchIds.map(esc).join(', ')} battles) were replayed with timers in the ${T('kernel')}. How busy is the GPU?</p>
${noNsight ? `<p class="mut">No Nsight: Windows blocks its counters (ERR_NVGPUCTRPERM). Clock timers stand in; the rest says "not measured".</p>` : ''}
${ul([
    occA(lastI) != null ? `${T('occupancy', 'Occupancy')}: only ${num(`prof.achieved_occupancy.${profLaunchIds[lastI]}`, occA(lastI), 1)}% of possible ${T('warp')}s loaded on the 36k launch (NVIDIA: under 60% is low).` : '',
    sassRes('REG') != null ? `Why: ${num('sass.reg', sassRes('REG'), 0)} ${T('register')}s and ${num('sass.stack', sassRes('STACK'), ',')} B of ${T('local memory')} per ${T('thread')}; ${num('sass.localshare', sass?.local_share_of_static_instr, '%')} of instructions move local memory.` : '',
    wee(lastI) != null ? `Threads per warp step: ${num(`prof.warp_exec_efficiency.${profLaunchIds[0]}`, wee(0), 1)} to ${num(`prof.warp_exec_efficiency.${profLaunchIds[lastI]}`, wee(lastI), 1)} of 32 do useful work (healthy: 24+); the rest wait on battles at other turns.` : '',
    sma(1) != null ? `The SMs (the GPU's 68 cores) are busy for ${num(`prof.sm_active_share.${profLaunchIds[1]}`, sma(1), 0)}% of the 10k launch: the rest is tail, waiting on the last battles.` : '',
  ])}
${sup('s2', 4)}
${(prof?.metrics ?? []).map(metricCard).join('')}
${stallPicture()}
<details><summary>Raw profiler files</summary><p class="mut">${['metrics.json', 'timeline.json', 'sm-timeline.json', 'lanes-time.json', 'gen-split.json', 'ncu-attempt.log'].filter((f) => existsSync(`${S}/prof/${f}`)).map((f) => `<code>out/gpu/study/prof/${f}</code>`).join(' · ')}</p></details>`);

// ---------------------------------------------------------------- step: width calibration (R9)
const CB = calib?.buckets ?? [];
const widths = calib?.widths ?? [1, 2, 4, 8, 16, 32];
const noMatter = CB.filter((b) => b.pick === 1 && Math.max(...Object.values(b.ratio_to_g1_median ?? { 1: 1 })) <= 1.03);
function calibPicture() {
  if (!CB.length) return '';
  const x0 = 70, x1 = W - 10, lo = 0.8, hi = 1.2, X = (v) => x0 + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (x1 - x0), rh = 16;
  let g = tx(4, 16, 'Speed vs G=1, same battles', 'h'), y = 30;
  for (const [i, b] of CB.entries()) {
    const top = y;
    g += tx(4, y + 12, esc(b.name ?? b.bucket), 'h');
    for (const G of widths) {
      const r = b.ratio_to_g1_median?.[G] ?? b.ratio_to_g1_median?.[String(G)];
      if (r == null) continue;
      y += rh;
      g += tx(x0 - 6, y + 9, `G=${G}`, 's', 'end') + `<rect x="${X(Math.min(1, r))}" y="${y}" width="${Math.abs(X(r) - X(1))}" height="11" fill="${r >= 1 ? 'var(--c2)' : 'var(--c1)'}"/>` + tx(r >= 1 ? X(r) + 3 : X(r) - 3, y + 9, nt(`calib.${i}.ratio.${G}`, r, 2), 's', r >= 1 ? 'start' : 'end');
    }
    g += `<rect x="${X(0.97)}" y="${top + 16}" width="${X(1.03) - X(0.97)}" height="${y - top + 0}" fill="var(--fg)" opacity="0.07"/>`;
    y += rh + 8;
  }
  g += `<line x1="${X(1)}" x2="${X(1)}" y1="28" y2="${y - 8}" stroke="var(--fg)"/>` + tx(X(1), y + 6, '1.00 = as fast as G=1 · grey = within 3%', 's', 'middle');
  return svg(y + 14, g, 'width calibration per bucket');
}
const calibLog = (() => { // the --gpu run that shows the load or the calibration line (written after the production patch)
  for (const f of [`${S}/width/load-line.log`, `${S}/width/calib-line.log`]) { const t = txt(f); const m = t.match(/^.*(calibration loaded|calibrating width for).*$/m); if (m) return { f, line: m[0].trim() }; }
  return null;
})();
const stepWidth = () => step('width', `${T('width', 'Width')}: same battles, every width`, `
<p class="q">Do G threads per battle finish a launch sooner? Same battles re-run at G = 1–32, 10+ launches per ${T('bucket')}.</p>
${calibPicture()}
${ul([
    CB.length ? `${num('calib.nomatter', noMatter.length, 0)} of ${num('calib.nbuckets', CB.length, 0)} buckets: no width beats G=1 by over 3%, so <b>width does not matter here</b>; auto uses G=1.` : 'Calibration not built yet.',
    CB.length ? `Largest gap between the best and worst width in any bucket: ${num('calib.maxspread', Math.max(...CB.map((b) => b.spread_pct ?? 0)), 1)}%; run-to-run noise on the same launch: up to ${num('calib.maxnoise', Math.max(...CB.map((b) => b.noise_pct ?? 0)), 1)}%.` : '',
    calibLog ? `Saved once per GPU; a <code>--gpu</code> run logs <code>${esc(calibLog.line.replace(/^gpu width -- /, '').replace(/:.*$/, ''))}</code> (or builds the file on its first run).` : `The pick is saved once per GPU in <code>out/gpu/${esc(calibFile ?? 'width-calib-<gpu>.json')}</code>.`,
  ])}
${sup('s5', 2)}
<details><summary>Calibration table (median battles per second per width)</summary>${CB.length ? table(['bucket', 'launches', ...widths.map((G) => `G=${G}`), 'winner', 'spread %', 'noise %', 'pick'], CB.map((b, i) => [esc(b.name ?? b.bucket), num(`calib.${i}.launches`, b.launches, 0), ...widths.map((G) => (b.bps_median?.[G] ?? b.bps_median?.[String(G)])?.toFixed(0)), `G=${b.winner}`, (b.spread_pct ?? 0).toFixed(1), (b.noise_pct ?? 0).toFixed(1), `G=${b.pick}`])) + `<p class="mut">${esc(calib?.method ?? '')}</p>` : ''}</details>`);

// ---------------------------------------------------------------- step: prototype runs (R7/R8)
const genChoice = (() => {
  const b = baseRuns.slice(0, 2);
  if (b.length < 2) return '';
  return `10 generations per run: the cache fills by generation ${b[0].sat === b[1].sat ? num(`run.${b[0].name}.sat`, b[0].sat, 0) : `${num(`run.${b[0].name}.sat`, b[0].sat, 0)}–${num(`run.${b[1].name}.sat`, b[1].sat, 0)}`}; same-seed baselines agree to ${num('base.ab', Math.abs(b[0].warmPerGen - b[1].warmPerGen), 2)} s.`;
})();
const stepRuns = () => step('runs', 'Prototype runs in the overnight chain', `
<p class="q">Each prototype ran twice or more, same seed, alone on the GPU, scored by seconds per ${T('warm generation')}.</p>
${runsPicture()}
${ul([
    baseWarm != null ? `Production time per generation moved ${baseDrift ? num('base.drift', baseDrift.d, '%1', { sign: true }) : 'n/a'} overnight, so each bar is against production runs made near it.` : '',
    bestWin ? `Only battle-code changes are left of zero; the best reads ${num(`card.${bestWin.id}.measured`, bestWin.measured, 1, { sign: true })} s. Step 5 re-tests the wins against defaults.` : `No verified prototype beat the baseline by more than its noise (±${num('base.noise', noise, 2)} s).`,
    genChoice,
  ])}
${sup('s3', 's4', 3)}
<details><summary>Every overnight run (warm s/gen, saturation gen, total wall, battles per second)</summary>${table(['run', 'settings', 'exit', 'gens', 'saturation gen', 'warm s/gen', 'total wall s', 'b/s'], runs.filter((r) => !AB_RE.test(r.name)).map(runRow))}</details>`);

// ---------------------------------------------------------------- step: morning A/B (amendment 2026-10-17: not noise)
const abRuns = runs.filter((r) => AB_RE.test(r.name));
const stepAB = () => step('ab', 'Are the gains real? Morning A/B', `
<p class="q">Defaults and both overnight wins ran again, interleaved, ${num('ab.rounds', abBase.length, 0)} rounds each. Do the wins beat the spread?</p>
${abPicture()}
${ul([
    ...Object.values(AB).map((a) => { const c = allCards.find((x) => x.ab === a); return `${esc(c?.name ?? a.set)} ${num(`ab.${a.set}.delta`, a.d, 1, { sign: true })} s ${a.clears ? 'beats' : 'is within'} both spreads (${num(`ab.${a.set}.spread`, a.spread, 2)} / ${num('ab.ab-base.spread', abSpread(abBase), 2)} s): ${a.clears ? 'not noise' : 'maybe noise'}.`; }),
    abBase.length ? `Defaults today: ${warmList(abBase)} s, against ${num(`run.${baseRuns.at(-1)?.name}.warm`, baseRuns.at(-1)?.warmPerGen, 2)} s at the end of the overnight chain.` : 'The A/B has not run yet.',
  ])}
${sup('s4', 3)}
<details><summary>Every A/B run</summary>${table(['run', 'settings', 'exit', 'gens', 'saturation gen', 'warm s/gen', 'total wall s', 'b/s'], abRuns.map(runRow))}<p class="mut">Chain: <code>out/gpu/study/ab.sh</code>, log <code>out/gpu/study/ab.log</code>.</p></details>`);

// ---------------------------------------------------------------- step: literature (R4)
const appliesN = (a) => sources.filter((s) => s.applies === a).length;
function litPicture() {
  if (!sources.length) return '';
  const cats = [['yes', 'applies', 'var(--c2)'], ['partly', 'partly applies', 'var(--c0)'], ['no', 'no', 'var(--c4)']];
  let x = 4, g = tx(4, 16, `${sources.length} sources: do they fit this sim?`, 'h');
  const sc = (W - 8) / sources.length;
  for (const [a, l, c] of cats) { const n = appliesN(a); if (!n) continue; g += `<rect x="${x}" y="26" width="${n * sc - 2}" height="22" rx="3" fill="${c}"/>` + tx(x + 4, 42, `${nt(`lit.${a}`, n, 0)} ${l}`, 's', 'start', ' style="fill:var(--bg)"'); x += n * sc; }
  return svg(56, g, 'literature fit');
}
const litEv = rd(`${S}/lit/evidence-profile.json`);
const LIT_SHORT = [
  litEv ? `Tail: ${num('lit.tail', litEv.aggregate.tail_share_of_wall, '%1')} of a warm round-7 generation; longest battle ${num('lit.maxp50', litEv.aggregate.max_over_p50_median, 1)}x the median.` : '',
  'NVIDIA: under 60% occupancy is low; under 24 of 32 threads busy is heavy divergence.',
  'Splitting one search over a thread group is the published width fix (BPIDA*); our extra threads only duplicate work.',
];
// one-line applies text for the phone page; the source's full finding and reasoning sit under "What it found"
const WHY_SHORT = {
  'https://docs.nvidia.com/nsight-compute/ComputeTriage/index.html': 'Source of the healthy ranges on the metric bars; our 16.7% occupancy is far under its 60% line.',
  'https://research.nvidia.com/publication/2009-08_understanding-efficiency-ray-traversal-gpus': 'We already pull battles from a queue; its new idea, giving idle threads speculative work, is the next-round card.',
  'https://research.nvidia.com/publication/2013-07_megakernels-considered-harmful-wavefront-path-tracing-gpus': 'Our kernel is the big kind they warn about, but our battle state is too large to pass between stages cheaply.',
  'https://klasses.cs.uchicago.edu/archive/2016/winter/32001-1/papers/AStudyofPersistentThreadsStyleGPUProgrammingforGPGPUWorkloads.pdf': 'Battles take seconds, so launch and queue overhead (microseconds) is not where our time goes.',
  'https://arxiv.org/abs/1705.02843': 'The published way to split one battle\'s search over its G threads instead of repeating it.',
  'https://hgpu.org/?p=5727': 'Caps what regrouping battles by phase could give: a modest gain at best.',
  'https://arxiv.org/abs/2206.10558': 'Same wait on the slowest item; we can\'t return early, but can start next-round work in the tail.',
  'https://arxiv.org/abs/2108.13976': 'Same one-battle-per-group layout, but their steps are short and equal; lockstep won\'t fix our tail.',
  'https://arxiv.org/abs/2108.10470': 'Their gain is cutting CPU-GPU copies; ours take 0.2 s of a 10.9 s generation.',
  'https://developer.nvidia.com/blog/cuda-graphs/': '3 launches per generation, seconds each: graphs would save microseconds.',
  'https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/index.html': 'Explains why our 35 KB stack in local memory is slow; the basis of the on-chip-state card.',
  'https://docs.nvidia.com/cuda/ampere-tuning-guide/index.html': 'RTX 3080 limits: our 254 registers allow 8 of 48 warps per SM.',
};
const stepLit = () => step('lit', 'What other GPU simulators do', `
<p class="q">How do other projects run many uneven-length simulations on one GPU?</p>
${litPicture()}
${ul(LIT_SHORT)}
${sup('s1', 's2', 4)}
<ol class="src">${sources.slice(0, 12).map((s) => `<li><a href="${esc(s.url)}">${esc(s.title)}</a> <span class="mut">(${esc(s.year)})</span><div class="why"><b>${s.applies === 'yes' ? 'Applies' : s.applies === 'partly' ? 'Partly applies' : 'Does not apply'}:</b> ${esc(WHY_SHORT[s.url] ?? s.why)}</div><details><summary>What it found</summary><div class="says">${esc(s.says)}</div><div class="says">${esc(s.why)}</div></details></li>`).join('')}</ol>`);

// ---------------------------------------------------------------- step: forks (R6)
const stepForks = () => step('forks', 'How the overnight search ran', `
<p class="q">${num('forks.n', forks.length, 0)} research forks worked in parallel; only the chain timed runs, one at a time.</p>
${forkPicture()}
${ul([
    `${num('forks.done', forks.filter((f) => f.finish).length, 0)} of ${num('forks.n', forks.length, 0)} forks finished; ${num('chain.stages', nightStages.length, 0)} chain stages ran, ${num('chain.failed', nightStages.filter((c) => c.rc).length, 0)} failed.`,
    baseFirst && baseLast ? `The chain ran from ${esc(hhmm(chainStarts[0]?.at))} to ${esc(hhmm(nightStages.at(-1)?.at))} ET, baseline first (${esc(baseFirst.name)}) and last (${esc(baseLast.name)}).` : '',
  ])}
${sup('s3', 's4', 3)}
<details><summary>Fork log (US Eastern)</summary>${table(['fork', 'start', 'finish', 'produced'], forks.map((f) => [esc(f.fork), esc(f.start ?? ''), esc(f.finish ?? 'running'), esc(f.produced)]))}</details>
<details><summary>Chain stages</summary>${table(['#', 'kind', 'name', 'exit', 'done at'], nightStages.map((c) => [c.k, c.kind, esc(c.name), c.rc, esc(c.at)]))}</details>`);

// ---------------------------------------------------------------- step: correctness (R7 gate, R14)
const protoCards = allCards.filter((c) => c.tested); // every prototype, also ones in "Also looked at"
const detRows = runs.filter((r) => r.name !== baseRuns[0]?.name && r.exit === 0).map((r) => ({ r, c: baseRuns[0] ? compareRuns(baseRuns[0].dir, r.dir) : null }));
const detSame = detRows.filter((d) => d.c?.same).length;
const detDiffer = detRows.filter((d) => !d.c?.same);
if (detDiffer.some((d) => !/^cpushare-/.test(d.r.name))) console.warn('non-cpushare run differs from base:', detDiffer.map((d) => d.r.name).join(' '));
const r7det = txt(`${S}/det-r7.txt`).trim();
const shortAgree = (a) => { const p = (a ?? '').match(/[\d.]+%/), f = (a ?? '').match(/(\d+) flagged/); return p ? `${p[0]}${f ? `, ${f[1]} flagged` : ''}` : 'not run'; };
function checkPicture() {
  if (!protoCards.length) return '';
  let g = tx(4, 16, 'Does each prototype give the same answers?', 'h'), y = 28;
  for (const c of protoCards) {
    const ok = c.verified;
    g += `<circle cx="12" cy="${y + 7}" r="7" fill="${ok ? 'var(--ok)' : 'var(--bad)'}"/>` + tx(12, y + 11, ok ? '✓' : '✗', '', 'middle', ' style="fill:var(--bg);font-size:11px"') + tx(26, y + 11, esc(c.name), 's') + tx(W - 6, y + 11, esc(shortAgree(c.verify_agreement)), 's', 'end');
    y += 20;
  }
  return svg(y + 4, g, 'verify results');
}
const stepCheck = () => step('check', 'Do the prototypes give the same results?', `
<p class="q">A prototype counts only if every winner matches the CPU engine and the same seed gives the same teams.</p>
${checkPicture()}
${ul([
    `${num('check.verified', protoCards.filter((c) => c.verified).length, 0)} of ${num('check.tested', protoCards.length, 0)} tested prototypes match the CPU engine on every battle (verify_3v3: 100% winner agreement, 0 flagged).`,
    detRows.length ? `${num('det.same', detSame, 0)} of ${num('det.n', detRows.length, 0)} chain runs gave checkpoints identical to ${esc(baseRuns[0]?.name)} (same seed, timing ignored).` : '',
    detDiffer.length ? `The ${num('det.differ', detDiffer.length, 0)} others are CPU-share runs: CPU battles shift results slightly; same-share runs match.` : '',
    r7det ? esc(r7det) : '',
  ])}
${sup('s4', 3)}
<details><summary>Checkpoint comparison per run</summary>${table(['run', 'checkpoints', 'vs ' + esc(baseRuns[0]?.name ?? 'base')], detRows.map((d) => [esc(d.r.name), d.c?.files, d.c?.same ? '<span class="ok">IDENTICAL</span>' : `<span class="bad">DIFFERENT ${esc((d.c?.differ ?? []).slice(0, 3).join(', '))}</span>`]))}</details>`);

// ---------------------------------------------------------------- recommendation box (R10a, R12: action + gain + command per line)
const CMD = 'node scripts/evolve.mjs <collection.csv> --config recipes/standard.json --halving-rounds 3 --gpu --out-dir out/<name>';
const nextCards = cards.filter((c) => !(c.measured != null && c.measured >= -(noise ?? 0) && c.verified)).filter((c) => c !== bestWin && !AB[c.id]).slice(0, 2);
const addOn = nextCards.find((c) => /only as a later add-on/.test(c.do_next ?? ''));
const lead = nextCards.find((c) => c !== addOn) ?? nextCards[0];
// the change to turn on: the morning A/B's larger verified win that clears both spreads; else the overnight best win
const turnOn = abWins[0] ?? bestWin;
const envOf = (c) => (runs.find((r) => (c.runs ?? []).includes(r.name))?.env ?? '').split(/\s+/).filter((x) => /^POGO_GPU_STUDY=|^POGO_GPU_/.test(x)).join(' ') || '(see card)';
const abTable = () => (abBase.length ? table(['warm s per generation, morning A/B', 'each run', 'mean', 'spread'], [
  ['defaults', warmList(abBase), num('ab.ab-base.warm', abBaseWarm, 2), num('ab.ab-base.spread', abSpread(abBase), 2)],
  ...Object.values(AB).map((a) => [esc(allCards.find((c) => c.ab === a)?.name ?? a.set), warmList(a.rs), num(`ab.${a.set}.warm`, a.warm, 2), num(`ab.${a.set}.spread`, a.spread, 2)]),
]) : '<p class="mut">Morning A/B not run yet.</p>');
const REC = [
  {
    act: 'Run the standard sim on the GPU with island halving off (the default) and halving 3, as today.',
    data: table(['warm s per generation, round 7', 'run 1', 'run 2'], [['island halving on', num('r7.run.isl-h3-p1', r7['isl-h3-p1']?.warmPerGen, 2), num('r7.run.isl-h3-p1-r2', r7['isl-h3-p1-r2']?.warmPerGen, 2)], ['island off (default)', num('r7.run.auto-h3-p1', r7['auto-h3-p1']?.warmPerGen, 2), num('r7.run.auto-h3-p1-r2', r7['auto-h3-p1-r2']?.warmPerGen, 2)]]),
    gain: r7isl != null && r7auto != null ? `island on costs ${num('r7.islcost', r7isl - r7auto, 1, { sign: true })} s per warm generation (${num('r7.isl', r7isl, 1)} vs ${num('r7.auto', r7auto, 1)} s); both pairs agree to well under that.` : '',
    cmd: CMD,
  },
  {
    act: CB.length && noMatter.length === CB.length ? 'Leave width on auto: width does not matter here, so auto now runs one thread per battle (G=1) everywhere.' : 'Leave width on auto: it now uses the measured winner per launch size and G=1 where widths tie.',
    data: CB.length ? table(['launch size', 'launches', 'best width', 'vs G=1'], CB.map((b, i) => { const r = b.ratio_to_g1_median ?? { 1: 1 }; const G = Object.keys(r).sort((x, y) => r[y] - r[x])[0]; return [esc(b.name ?? b.bucket), num(`calib.${i}.launches`, b.launches, 0), `G=${esc(G)}`, num(`calib.${i}.ratio.${G}`, r[G], 2)]; })) : '',
    gain: CB.length ? `best width beats G=1 by at most ${num('calib.bestgain', Math.max(0, ...CB.map((b) => (Math.max(...Object.values(b.ratio_to_g1_median ?? { 1: 1 })) - 1))), '%1')} in any bucket, under the 3% line (step 3).` : 'calibration not built yet',
    cmd: `nothing to add; built once per GPU into out/gpu/${calibFile ?? 'width-calib-<gpu>.json'} (delete it to re-measure)`,
  },
  turnOn
    ? {
      act: `Turn on "${esc(turnOn.name)}" (passes the same-answers check).${abWins.length > 1 ? ` "${esc(abWins[1].name)}" is a close second; they are separate kernel edits, so merge both next round.` : ''}`,
      data: turnOn.ab ? abTable() : cardData(turnOn),
      gain: turnOn.ab
        ? `${num(`ab.${turnOn.ab.set}.delta`, turnOn.ab.d, 1, { sign: true })} s per warm generation in the A/B (${num(`ab.${turnOn.ab.set}.rounds`, turnOn.ab.rounds, 0)} rounds), more than both spreads; overnight ${num(`card.${turnOn.id}.measured`, turnOn.measured, 1, { sign: true })} s (step 4).`
        : `${num(`card.${turnOn.id}.measured`, turnOn.measured, 1, { sign: true })} s per warm generation over ${num(`card.${turnOn.id}.nruns`, turnOn.nRuns, 0)} runs; confirm in one A/B (step 4)`,
      cmd: `add ${envOf(turnOn)} before the command`,
    }
    : { act: 'No prototype is worth turning on yet: none beat the baseline by more than run-to-run noise.', data: abTable(), gain: `0 s now (noise ±${num('base.noise', noise, 2)} s per generation)`, cmd: 'keep the command above unchanged' },
  {
    // a card whose own fork says "keep it only as a later add-on" rides on the other card instead of leading
    act: addOn && nextCards.length === 2 ? `Build next round: "${esc(lead.name)}" (measure first), with "${esc(addOn.name)}" as its add-on.` : nextCards.length ? `Build next round: ${nextCards.map((c) => `"${esc(c.name)}"`).join(', then ')}.` : 'Build next round: the top card of the ranked list below.',
    data: `<p class="data"><span class="l">Data:</span> tail (the GPU waiting on a launch's last battles) is ${num(`gen.${profRun?.name}.mean.tail`, genSplit.tail, 1)} of ${num(`gen.${profRun?.name}.mean.wall`, genWallMean, 1)} s per warm generation, ${num(`gen.${profRun?.name}.mean.tailshare`, tailShare, '%')} (step 1).</p>`,
    gain: addOn && nextCards.length === 2 ? `predicted ${fmtRange(lead)} per generation (${fmtRange(addOn)} more with the add-on); measure first.` : nextCards[0] ? `predicted ${nextCards[0].measured != null ? num(`card.${nextCards[0].id}.measured`, nextCards[0].measured, 1, { sign: true }) + ' s (measured)' : fmtRange(nextCards[0])} per warm generation` : '',
    cmd: 'claude --agent planner "round 9: build ' + (lead ? esc(lead.id) : 'the top card') + ' from out/gpu-study.html"',
  },
];
// before/after: the morning A/B's defaults vs the change to turn on (same chain, interleaved); else the overnight same-hour pair
const before = turnOn?.ab ? turnOn.ab.base : bestWin ? bestWin.ctrlWarm : baseWarm, after = turnOn?.ab ? turnOn.ab.warm : bestWin ? bestWin.measuredWarm : baseWarm;
const recBox = () => `<div class="rec" id="rec"><h2>Recommendation for the standard sim</h2>
<div class="ba"><div>now (today's defaults${turnOn?.ab ? ', morning A/B' : ', same hour'})<b>${num('rec.before', before, 1)} s</b>per warm generation</div><div>with line 3 turned on<b>${num('rec.after', after, 1)} s</b>per warm generation</div></div>
<ol>${REC.map((r, i) => `<li id="rec-${i + 1}"><b>${r.act}</b>${r.data}<div><span class="gain">Gain:</span> ${r.gain}</div><code class="cmd">${esc(r.cmd)}</code></li>`).join('')}</ol>
<p class="mut">The data sits above each gain. Halving rounds stay at 3, as asked.</p></div>`;

// ---------------------------------------------------------------- summary (amendment 2026-10-17): <= 5 one-line points, first on the page
const SCHED = ['queue', 'lockstep', 'streams', 'cpushare-auto', 'pool', 'lockstep-t128'];
const summary = () => {
  const sched = deltaRows.filter((r) => SCHED.includes(r.s)).sort((a, b) => a.d - b.d);
  const abList = abWins.map((c) => `${esc(SHORT[c.id] ?? c.name.toLowerCase())} ${num(`ab.${c.ab.set}.delta`, c.ab.d, 1, { sign: true })} s`).join(', ');
  // plain words only: no glossary term, so each point stays one short sentence (terms are defined where the steps use them)
  const pts = [
    `The GPU does ${num(`gen.${profRun?.name}.mean.gpushare`, gpuShare, '%')} of each generation's work; ${num(`gen.${profRun?.name}.mean.tailshare`, tailShare, '%')} of it is waiting on a batch's last battles (step 1).`,
    sassRes('REG') != null ? `Per-battle memory is so large that only ${num(`prof.achieved_occupancy.${profLaunchIds[lastI]}`, occA(lastI), 1)}% of GPU slots fill; forcing it smaller ran slower (steps 2, 4).` : '',
    sched.length ? `Every scheduling idea (work list, lockstep, two queues, CPU share) ran slower: ${num(`delta.${sched[0].s}`, sched[0].d, 1, { sign: true })} to ${num(`delta.${sched.at(-1).s}`, sched.at(-1).d, 1, { sign: true })} s (step 4).` : '',
    abWins.length ? `Faster, beyond run-to-run spread: ${abList} (step 5).` : bestWin ? `Faster overnight, A/B not yet confirmed: ${esc(SHORT[bestWin.id] ?? bestWin.name.toLowerCase())} ${num(`card.${bestWin.id}.measured`, bestWin.measured, 1, { sign: true })} s (steps 4, 5).` : 'No prototype beat today\'s defaults by more than run-to-run spread (steps 4, 5).',
    CB.length ? `Workers per battle (width) does not matter: best case ${num('calib.bestgain', Math.max(0, ...CB.map((b) => (Math.max(...Object.values(b.ratio_to_g1_median ?? { 1: 1 })) - 1))), '%1')} faster; auto uses one per battle (step 3).` : '',
  ].filter(Boolean).slice(0, 5);
  return `<section id="summary" class="sum"><h2>What the overnight experiments found</h2><ol>${pts.map((p, i) => `<li id="sum-${i + 1}">${p}</li>`).join('')}</ol></section>`;
};
const rankList = () => `<section id="ranked"><h2>Changes to pick from, fastest first</h2>
<p class="mut">${num('cards.n', cards.length, 0)} candidates, by measured gain (else by predicted). Under each: meaning, data, gain, what to do.</p>
<ol class="rank">${cards.map(cardLi).join('')}</ol>
${extraCards.length ? `<details><summary>Also looked at (${extraCards.length}, lower ranked)</summary><ul>${extraCards.map((c) => `<li><b>${esc(c.name)}</b> <span class="mut">(${esc(c.fork)}${c.tested ? ', tested' : ''})</span>: ${esc(c.do_next)}</li>`).join('')}</ul></details>` : ''}</section>`;

// ---------------------------------------------------------------- assemble
const order = [stepTime, stepProf, stepWidth, stepRuns, stepAB, stepCheck, stepLit, stepForks];
const top = summary() + autoDefine(recBox() + rankList());
const body = order.map((f) => autoDefine(f())).join('\n');
const gloss = `<section id="glossary"><h2>Glossary</h2><dl class="gl">${Object.entries(GLOSS).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></section>`;
const nav = `<nav class="mut">Steps: <ol class="nav">${STEPS.map((s) => `<li><a href="#${s.id}">${plain(s.title)}</a></li>`).join('')}<li><a href="#glossary">Glossary</a></li></ol></nav>`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GPU Study Round8</title><style>${css}</style></head><body>
<h1>GPU round 8: where the time goes and what to change</h1>
<p class="mut">Built ${esc(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' }))} ET · numbers re-checked: <code>out/gpu/study/check.log</code> · <a href="gpu-width.html">round 7 page</a></p>
${top}
${nav}
${body}
${gloss}
</body></html>`;
writeFileSync(`${OUT}/gpu-study.html`, html);
writeFileSync(`${S}/page-numbers.json`, JSON.stringify(NUMS, null, 1));
writeFileSync(`${S}/runs.json`, JSON.stringify(runs.map(({ rate, genWalls, ...r }) => ({ ...r, rate, genWalls })), null, 1));
console.log(`wrote ${OUT}/gpu-study.html: ${cards.length} cards, ${runs.length} runs, ${Object.keys(NUMS).length} checked numbers, ${STEPS.length} steps`);
