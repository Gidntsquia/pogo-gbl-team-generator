#!/usr/bin/env node
// Token-cost evaluation of the pogo-sim MCP server vs plain Bash.
//
//   node scripts/mcp-token-cost.mjs offline [--report-run NAME] [--status-run NAME]
//       Runs the four tasks both ways on smoke-size sims (mcp-cost-off-*), tokenizes what Claude
//       would see, writes out/mcp-token-cost/offline.{json,md}. Removes its test runs.
//   node scripts/mcp-token-cost.mjs sessions [--last 20] [--exclude ID] [--until ISO]
//       Reads session logs (read only), writes out/mcp-token-cost/sessions.{json,md}
//       including cycles and the amortized projection (needs offline.json; uses live/ if present).
//   node scripts/mcp-token-cost.mjs live [--run NAME]
//       Four tasks x two ways in fresh `claude -p` sessions; writes out/mcp-token-cost/live/*.json.
//   node scripts/mcp-token-cost.mjs live-clean    removes mcp-cost-* runs from out/
//
// Tokenizer: no API key in this environment, so counts are chars / CPT, where CPT is calibrated
// against real session `usage` (see calibrate()). With ANTHROPIC_API_KEY set the count-tokens
// endpoint is used instead (not exercised here).

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRICES, PRICES_DATE, convert, groupCycles, mean, readJsonl, summarizeSession, detectRole,
  tallyUsage, isRawStatusOpener, LIFECYCLE,
} from './mcp-token-cost-lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'out');
const DIR = path.join(OUT, 'mcp-token-cost');
const LOGS = path.join(os.homedir(), '.claude/projects/-home-jaxon-files-pogo-gbl-team-generator');
const BASH_LIMIT = 30000; // assumed Claude Code Bash output cap (chars); checked against live runs
const CSV = 'fixtures/sample-pokegenie.csv';
const SMOKE = { generations: 3, population: 12, threads: 2, 'opponents-per-gen': 8 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const write = (f, s) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, s); };
const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const usd = (n) => `$${fmt(n, n < 1 ? 3 : 2)}`;

// ---------- tokenizer ----------

/**
 * Chars-per-token for tool-result text, calibrated on real sessions: for each assistant turn with
 * one tool call, (next turn's prompt tokens - this turn's prompt tokens - this turn's output) is
 * the token size of the tool result in between; divide that result's chars by it.
 * @param {string[]} files session jsonl paths
 * @returns {{cpt: number, pairs: number, chars: number, tokens: number}}
 */
export function calibrate(files) {
  let chars = 0; let tokens = 0; let pairs = 0;
  for (const f of files) {
    const recs = readJsonl(f);
    const results = new Map();
    for (const r of recs) {
      if (r.type !== 'user' || !Array.isArray(r.message?.content)) continue;
      for (const c of r.message.content) {
        if (c.type !== 'tool_result') continue;
        const text = Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join('') : String(c.content ?? '');
        results.set(c.tool_use_id, text.length);
      }
    }
    const msgs = new Map();
    for (const r of recs) {
      if (r.type !== 'assistant' || !r.message?.usage) continue;
      const prev = msgs.get(r.message.id);
      if (!prev) msgs.set(r.message.id, { m: r.message, order: msgs.size });
      else prev.m = { ...r.message, content: [...prev.m.content, ...r.message.content] };
    }
    const list = [...msgs.values()].map((x) => x.m);
    const prompt = (m) => (m.usage.input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0);
    for (let i = 0; i + 1 < list.length; i++) {
      const uses = list[i].content.filter((c) => c.type === 'tool_use');
      if (uses.length !== 1 || !results.has(uses[0].id)) continue;
      const d = prompt(list[i + 1]) - prompt(list[i]) - (list[i].usage.output_tokens ?? 0);
      if (d < 50 || results.get(uses[0].id) < 200) continue;
      chars += results.get(uses[0].id); tokens += d; pairs++;
    }
  }
  return { cpt: chars / tokens, pairs, chars, tokens };
}

function recentFiles(n, { exclude = [], until } = {}) {
  return readdirSync(LOGS).filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, id: f.replace('.jsonl', ''), m: statSync(path.join(LOGS, f)).mtimeMs }))
    .filter((x) => !exclude.includes(x.id) && (!until || x.m <= Date.parse(until)))
    .sort((a, b) => b.m - a.m).slice(0, n);
}

// ---------- shell / mcp helpers ----------

/** Run a command as Claude's Bash tool would; return the transcript text Claude sees. */
function bash(cmd, timeout = 900000) {
  const r = spawnSync('bash', ['-c', cmd], { cwd: REPO, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 });
  let out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (out.length > BASH_LIMIT) out = `${out.slice(0, BASH_LIMIT)}\n... [${out.length - BASH_LIMIT} chars truncated]`;
  return `$ ${cmd}\n${out}`.trimEnd();
}

async function mcpClient() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const c = new Client({ name: 'mcp-token-cost', version: '1' });
  await c.connect(new StdioClientTransport({ command: 'node', args: ['mcp/server.mjs'], cwd: REPO }));
  return c;
}
const textOf = (r) => r.content.map((x) => x.text ?? JSON.stringify(x)).join('\n');
/** Call a pogo-sim tool; return the text Claude Code would put in the tool result. */
async function call(c, name, args) {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 900000 });
  return { name, args, text: textOf(r) };
}
const pidAlive = (name) => {
  try { process.kill(Number(readFileSync(path.join(OUT, `evolve-${name}.pid`), 'utf8')), 0); return true; } catch { return false; }
};
async function waitDead(name, ms = 900000) {
  const t0 = Date.now();
  while (pidAlive(name) && Date.now() - t0 < ms) await sleep(5000);
  return !pidAlive(name);
}
const gensOf = (name) => (existsSync(path.join(OUT, `evolve-${name}`))
  ? readdirSync(path.join(OUT, `evolve-${name}`)).filter((f) => /^evolve-gen\d+\.json$/.test(f)) : []);
async function waitGens(name, n, ms = 900000) {
  const t0 = Date.now();
  while (gensOf(name).length < n && pidAlive(name) && Date.now() - t0 < ms) await sleep(3000);
  return gensOf(name).length >= n;
}
function cleanRuns(prefix = 'mcp-cost-') {
  for (const f of existsSync(OUT) ? readdirSync(OUT) : []) {
    if (!f.startsWith(`evolve-${prefix}`)) continue;
    const pidf = f.endsWith('.pid') ? path.join(OUT, f) : null;
    if (pidf) { try { process.kill(Number(readFileSync(pidf, 'utf8')), 'SIGTERM'); } catch { /* gone */ } }
    rmSync(path.join(OUT, f), { recursive: true, force: true });
  }
}
const smokeFlags = Object.entries(SMOKE).map(([k, v]) => `--${k} ${v}`).join(' ');

// ---------- offline ----------

async function offline() {
  const reportRun = arg('report-run', 'jaxon-colormega-1');
  const statusRun = arg("status-run", "jaxon-mega-great-1");
  const files = recentFiles(20).map((x) => path.join(LOGS, x.f));
  const cal = calibrate(files);
  const tok = (s) => Math.round(s.length / cal.cpt);
  const rows = [];
  const add = (task, way, parts) => {
    const text = parts.join('\n');
    rows.push({ task, way, chars: text.length, tokens: tok(text), calls: parts.length, excerpt: text.slice(0, 1500) });
  };
  cleanRuns();
  const c = await mcpClient();
  try {
    const { tools } = await c.listTools();
    const schemaText = JSON.stringify(tools);
    const schema = { tools: tools.length, chars: schemaText.length, tokens: tok(schemaText), perTool: tools.map((t) => [t.name, tok(JSON.stringify(t))]) };
    const M = 'mcp-cost-off-m'; const B = 'mcp-cost-off-b';

    // launch
    const mLaunch = await call(c, 'run_standard', { csv: CSV, name: M, generations: SMOKE.generations, population: SMOKE.population, threads: SMOKE.threads, extra: { 'opponents-per-gen': SMOKE['opponents-per-gen'] } });
    add('launch', 'mcp', [`${mLaunch.name} ${JSON.stringify(mLaunch.args)}\n${mLaunch.text}`]);
    const launchCmd = `scripts/sim.sh ${CSV} --name ${B} ${smokeFlags.replace('--opponents-per-gen 8', '--opponents-per-gen 8')}`;
    const b1 = bash("sed -n '95,558p' RUNBOOK.md");
    const b2 = bash(`${launchCmd} --dry-run`);
    const b3 = bash(launchCmd);
    const b4 = bash(`until grep -q "generation 0: battling" out/evolve-${B}.log; do sleep 5; done; tail -3 out/evolve-${B}.log`);
    add('launch', 'bash', [b1, b2, b3, b4]);

    // status (on the two live smoke runs)
    await waitGens(M, 1); await waitGens(B, 1);
    const st = await call(c, 'status_sim', { name: M });
    add('status', 'mcp', [`${st.name} ${JSON.stringify(st.args)}\n${st.text}`]);
    const statusBash = (n) => [
      bash(`tail -30 out/evolve-${n}.log`),
      bash(`f=$(ls out/evolve-${n}/evolve-gen[0-9]*.json | sort -V | tail -1); node -e "const j=JSON.parse(require('fs').readFileSync('$f','utf8'));console.log(JSON.stringify({gen:j.generation,timing:j.timing,analytics:j.analytics},null,1))"`),
      bash(`ps -o pid,etime,rss -p "$(cat out/evolve-${n}.pid)"`),
    ];
    add('status', 'bash', statusBash(B));
    if (existsSync(path.join(OUT, `evolve-${statusRun}`))) {
      const st2 = await call(c, 'status_sim', { name: statusRun });
      add('status (full 100-gen run)', 'mcp', [`${st2.name} ${JSON.stringify(st2.args)}\n${st2.text}`]);
      add('status (full 100-gen run)', 'bash', statusBash(statusRun));
    }

    // stop + resume
    const ms1 = await call(c, 'stop_sim', { name: M, mode: 'after_generation', poll_seconds: 5 });
    const stopped = await waitDead(M);
    const stopNote = stopped ? '' : '[run did not stop within 15 min]';
    const mr = await call(c, 'resume_sim', { name: M, threads: SMOKE.threads });
    add('stop+resume', 'mcp', [`${ms1.name} ${JSON.stringify(ms1.args)}\n${ms1.text}${stopNote}`, `${mr.name} ${JSON.stringify(mr.args)}\n${mr.text}`]);
    const kill = [
      bash(`ls out/evolve-${B}/`),
      bash(`kill "$(cat out/evolve-${B}.pid)"; sleep 3; ls out/evolve-${B}/`),
      bash(`f=$(ls out/evolve-${B}/evolve-gen[0-9]*.json | sort -V | tail -1); node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('$f','utf8')).config))"`),
      bash(`cp out/evolve-${B}.log out/evolve-${B}.log.1; ${launchCmd}; sleep 15; grep resuming out/evolve-${B}.log`),
    ];
    add('stop+resume', 'bash', kill);

    // report
    const gr = await call(c, 'status_sim', { name: reportRun, top: 1 }); // report path is the last line of a DONE run's status
    add('report', 'mcp', [`${gr.name} ${JSON.stringify(gr.args)}\n${gr.text}`]);
    const html = `out/evolve-${reportRun}/my-teams-evolve.html`;
    add('report', 'bash', [
      bash(`ls -la out/evolve-${reportRun}/*.html`),
      bash(`test out/evolve-${reportRun}/evolve-result.json -nt ${html} && node scripts/render-report.mjs out/evolve-${reportRun}; echo "$PWD/${html}"`),
    ]);
    const catHtml = bash(`cat ${html}`);
    rows.push({ task: 'report: cat the HTML (pre-round-2 style, Bash cap applied)', way: 'bash', chars: catHtml.length, tokens: tok(catHtml), calls: 1, excerpt: catHtml.slice(0, 600) });
    const fullHtml = readFileSync(path.join(REPO, html), 'utf8');
    rows.push({ task: 'report: HTML inlined whole (pre-round-2 MCP resource, no cap)', way: 'mcp', chars: fullHtml.length, tokens: tok(fullHtml), calls: 1, excerpt: '(whole file)' });

    await waitDead(M, 600000); await waitDead(B, 600000);
    const result = { generatedAt: new Date().toISOString(), tokenizer: `chars / ${cal.cpt.toFixed(3)} (calibrated on ${cal.pairs} tool results from the last 20 sessions; no API key, so no count-tokens endpoint)`, cpt: cal.cpt, calibration: cal, bashLimitChars: BASH_LIMIT, schema, rows, smoke: SMOKE, source: 'offline tokenizer' };
    write(path.join(DIR, 'offline.json'), JSON.stringify(result, null, 2));
    write(path.join(DIR, 'offline.md'), offlineMd(result));
    console.log(`wrote ${path.join(DIR, 'offline.md')}`);
  } finally {
    await c.close().catch(() => {});
    cleanRuns();
  }
}

/** Pairs rows by task. @returns {{task:string, mcp:object, bash:object}[]} */
export function pairRows(rows) {
  const tasks = [...new Set(rows.map((r) => r.task))];
  return tasks.map((task) => ({ task, mcp: rows.find((r) => r.task === task && r.way === 'mcp'), bash: rows.find((r) => r.task === task && r.way === 'bash') }));
}

function offlineMd(r) {
  const L = [`# MCP vs Bash token cost: offline (${r.generatedAt.slice(0, 10)})`, '',
    `Tokenizer: ${r.tokenizer}. Source of every count below: offline tokenizer.`, '',
    `Schema overhead: ${r.schema.tools} tools, ${fmt(r.schema.chars)} chars of tools/list JSON = ${fmt(r.schema.tokens)} tokens if sent in full on every turn.`, '',
    '| task | MCP tokens | Bash tokens | saving | Bash calls |', '|---|---:|---:|---:|---:|'];
  for (const p of pairRows(r.rows)) {
    if (!p.mcp || !p.bash) continue;
    L.push(`| ${p.task} | ${fmt(p.mcp.tokens)} | ${fmt(p.bash.tokens)} | ${fmt(p.bash.tokens - p.mcp.tokens)} | ${p.bash.calls} |`);
  }
  const html = r.rows.find((x) => x.task.startsWith('report: HTML inlined'));
  const cat = r.rows.find((x) => x.task.startsWith('report: cat'));
  L.push('', `Inlined HTML: ${fmt(html.tokens)} tokens uncapped (the old get_report); Bash \`cat\` with the ${fmt(r.bashLimitChars)}-char cap: ${fmt(cat.tokens)} tokens.`);
  L.push('', '## Excerpts', '');
  for (const x of r.rows) L.push(`### ${x.task} (${x.way}, ${fmt(x.tokens)} tokens)`, '```', x.excerpt, '```', '');
  return L.join('\n');
}

// ---------- sessions ----------

function allRoleCounts() {
  const counts = { planner: 0, worker: 0, evaluator: 0, interactive: 0 };
  for (const f of readdirSync(LOGS).filter((x) => x.endsWith('.jsonl'))) {
    const head = readFileSync(path.join(LOGS, f), 'utf8').slice(0, 4000).split('\n').slice(0, 6).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    counts[detectRole(head)]++;
  }
  return counts;
}

function sessions() {
  const n = Number(arg('last', 20));
  const exclude = process.argv.flatMap((a, i, v) => (a === '--exclude' ? [v[i + 1]] : []));
  const picked = recentFiles(n + 50, { exclude, until: arg('until') });
  const list = [];
  for (const x of picked) {
    const recs = readJsonl(path.join(LOGS, x.f));
    const firstUser = recs.find((r) => r.type === 'user');
    const prompt = typeof firstUser?.message?.content === 'string' ? firstUser.message.content : '';
    if (prompt.startsWith('[mcp-cost-live]')) continue; // our own calibration sessions
    const s = summarizeSession(recs);
    list.push({ id: x.id, date: (s.start ?? new Date(x.m).toISOString()).slice(0, 16), ...s });
    if (list.length === n) break;
  }
  const cycles = groupCycles(list);
  const off = existsSync(path.join(DIR, 'offline.json')) ? JSON.parse(readFileSync(path.join(DIR, 'offline.json'), 'utf8')) : null;
  const liveDir = path.join(DIR, 'live');
  const live = existsSync(liveDir) ? readdirSync(liveDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(liveDir, f), 'utf8'))) : [];
  const roleCounts = allRoleCounts();
  const proj = off ? project(list, cycles, off, live, roleCounts) : null;
  const res = { generatedAt: new Date().toISOString(), pricesDate: PRICES_DATE, prices: PRICES, excluded: exclude, sessions: list.map(({ byModel, ...r }) => r), cycles: cycles.map((c) => ({ complete: c.complete, roles: c.sessions.map((s) => s.role), fe: c.sessions.reduce((a, s) => a + s.fe, 0), usd: c.sessions.reduce((a, s) => a + s.usd, 0) })), roleCounts, projection: proj };
  write(path.join(DIR, 'sessions.json'), JSON.stringify(res, null, 2));
  write(path.join(DIR, 'sessions.md'), sessionsMd(res));
  console.log(`wrote ${path.join(DIR, 'sessions.md')}`);
}

/**
 * Net saving per session by role. Per sim task, saving = Bash result tokens - MCP result tokens,
 * each charged as a cache write at entry plus a cache read on every later turn (half the session's
 * turns on average). Schema overhead: written once, read on every later turn (eager mode), or only
 * the tool names plus one ToolSearch load when the schema is deferred.
 */
function project(list, cycles, off, live, roleCounts) {
  const pairs = pairRows(off.rows).filter((p) => ['launch', 'status', 'stop+resume', 'report'].includes(p.task));
  const savePerTask = mean(pairs.map((p) => p.bash.tokens - p.mcp.tokens));
  const callsPerTask = mean(pairs.map((p) => p.bash.calls));
  const liveSaving = live.length >= 8 ? mean(['launch', 'status', 'stop-resume', 'report'].map((t) => {
    const a = live.find((x) => x.task === t && x.way === 'bash'); const b = live.find((x) => x.task === t && x.way === 'mcp');
    return a && b ? a.fe - b.fe : 0;
  })) : null;
  const byRole = {};
  for (const role of ['planner', 'worker', 'evaluator']) {
    const group = list.filter((s) => !s.empty && (role === 'worker' ? ['worker', 'interactive'].includes(s.role) : s.role === role));
    if (!group.length) { byRole[role] = null; continue; }
    const models = {};
    for (const s of group) for (const [m, t] of Object.entries(s.byModel)) models[m] = (models[m] ?? 0) + t.turns;
    const model = Object.entries(models).sort((a, b) => b[1] - a[1])[0][0];
    const turns = mean(group.map((s) => s.turns));
    const tasks = mean(group.map((s) => s.simOps)) / callsPerTask;
    const cost = (tokens) => convert(model, tokens);
    // one token of context: cache write once, then read on the remaining turns
    const ctx = (t, reads) => cost({ write1h: t, read: t * reads });
    const resultFe = ctx(savePerTask * tasks, turns / 2);
    const eager = ctx(off.schema.tokens, Math.max(0, turns - 1));
    const names = off.schema.tools * 12; // tool names only when deferred (approximation)
    const deferred = ctx(names, Math.max(0, turns - 1));
    byRole[role] = {
      model, sessions: group.length, meanTurns: turns, meanSimOpBashCalls: mean(group.map((s) => s.simOps)), tasksPerSession: tasks,
      grossFe: resultFe.fe, grossUsd: resultFe.usd,
      schemaEagerFe: eager.fe, schemaEagerUsd: eager.usd, schemaDeferredFe: deferred.fe, schemaDeferredUsd: deferred.usd,
      netEagerFe: resultFe.fe - eager.fe, netEagerUsd: resultFe.usd - eager.usd,
      netDeferredFe: resultFe.fe - deferred.fe, netDeferredUsd: resultFe.usd - deferred.usd,
    };
  }
  const perCycle = (key) => {
    // every sampled cycle counts, so cycles with many worker runs weigh in; each cycle is charged a
    // planner and an evaluator once, plus its real number of worker/interactive runs
    return mean(cycles.map((c) => ['planner', 'evaluator'].reduce((a, role) => a + (byRole[role] ? byRole[role][key] : 0), 0)
      + c.sessions.filter((s) => ['worker', 'interactive'].includes(s.role)).length * (byRole.worker ? byRole.worker[key] : 0)));
  };
  // per-role breakdown of the mean complete cycle: sessions of that role in the cycle x per-session net
  const perCycleRoles = {};
  for (const role of ['planner', 'worker', 'evaluator']) {
    // a cycle has one planner and one evaluator by definition; worker/interactive runs vary, so
    // average their real count over every sampled cycle (complete or partial)
    const n = role === 'worker' ? mean(cycles.map((c) => c.sessions.filter((s) => ['worker', 'interactive'].includes(s.role)).length)) : 1;
    const r = byRole[role];
    perCycleRoles[role] = { sessions: n, ...Object.fromEntries(['netEagerFe', 'netEagerUsd', 'netDeferredFe', 'netDeferredUsd'].map((k) => [k, r ? r[k] * n : 0])) };
  }
  const projectTotal = (key) => ['planner', 'worker', 'evaluator'].reduce((a, role) => a + (byRole[role] ? byRole[role][key] * (role === 'worker' ? roleCounts.worker + roleCounts.interactive : roleCounts[role]) : 0), 0);
  const keys = ['netEagerFe', 'netEagerUsd', 'netDeferredFe', 'netDeferredUsd'];
  return {
    savePerTaskTokens: savePerTask, callsPerTask, liveSavingFePerTask: liveSaving, byRole,
    perCycle: Object.fromEntries(keys.map((k) => [k, perCycle(k)])), perCycleRoles,
    wholeProject: Object.fromEntries(keys.map((k) => [k, projectTotal(k)])),
    wholeProjectSessions: roleCounts, extrapolation: true,
  };
}

function sessionsMd(r) {
  const L = [`# Session analysis (${r.generatedAt.slice(0, 10)})`, '', `Prices: ${r.pricesDate}, https://platform.claude.com/docs/en/about-claude/pricing. FE = tokens x (model price / claude-fable-5-1 price) per class. Source: session logs (aggregate counts only).`, '',
    '| session | date (UTC) | role | models | turns | input | cache write | cache read | output | FE tokens | $ | Bash | MCP | sim-op Bash |', '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const s of r.sessions) {
    L.push(`| ${s.id.slice(0, 8)} | ${s.date} | ${s.role}${s.role === 'interactive' ? ' (as worker)' : ''}${s.empty ? ' (empty)' : ''} | ${s.models.join(', ') || '-'} | ${s.turns} | ${fmt(s.tokens.input)} | ${fmt(s.tokens.write5m + s.tokens.write1h)} | ${fmt(s.tokens.read)} | ${fmt(s.tokens.output)} | ${fmt(s.fe)} | ${usd(s.usd)} | ${s.bash} | ${s.mcp} | ${s.simOps} |`);
  }
  L.push('', '## Cycles (planner -> workers/interactive -> evaluator)', '', '| # | complete | sessions | roles | FE tokens | $ |', '|---:|---|---:|---|---:|---:|');
  r.cycles.forEach((c, i) => L.push(`| ${i + 1} | ${c.complete ? 'yes' : 'partial'} | ${c.roles.length} | ${c.roles.join(' > ')} | ${fmt(c.fe)} | ${usd(c.usd)} |`));
  const full = r.cycles.filter((c) => c.complete);
  const cnt = (role) => mean(full.map((c) => c.roles.filter((x) => (role === 'worker' ? ['worker', 'interactive'].includes(x) : x === role)).length));
  L.push('', `Complete cycles: ${full.length}; mean sessions per complete cycle: planner ${cnt('planner').toFixed(1)}, worker/interactive ${cnt('worker').toFixed(1)}, evaluator ${cnt('evaluator').toFixed(1)}; mean FE tokens per complete cycle: ${fmt(mean(full.map((c) => c.fe)))}. The projection below uses worker/interactive runs per cycle over all ${r.cycles.length} cycles (complete and partial): ${r.cycles.map((c) => c.roles.filter((x) => x === 'worker' || x === 'interactive').length).join(', ')} (mean ${mean(r.cycles.map((c) => c.roles.filter((x) => x === 'worker' || x === 'interactive').length)).toFixed(1)}).`);
  const p = r.projection;
  if (p) {
    const pc = p.perCycle;
    const verdict = (a, b) => `${a > 0 ? 'saves' : 'costs'} ${fmt(Math.abs(a))} FE tokens (${usd(Math.abs(b))})`;
    L.push('', '## Bottom line: does the server save tokens?', '',
      `${pc.netDeferredFe > 0 ? 'Yes' : 'No'}, modestly. Per plan->worker->eval cycle the server ${verdict(pc.netDeferredFe, pc.netDeferredUsd)} when tool schemas load on demand (how Claude Code ran in the live sessions), and ${verdict(pc.netEagerFe, pc.netEagerUsd)} if all schemas are sent every turn. Extrapolation, not a measurement.`, '',
      '## Projection per plan->worker->eval cycle (extrapolation from these sessions)', '',
      'How to read the numbers: a POSITIVE value means the MCP server saves that much (Bash would cost more); a NEGATIVE value means the MCP server costs more than Bash.', '',
      '| role in cycle | sessions per cycle | MCP saves FE (deferred schema) | MCP saves $ (deferred) | MCP saves FE (full schema) | MCP saves $ (full) |', '|---|---:|---:|---:|---:|---:|');
    for (const [role, b] of Object.entries(p.perCycleRoles)) L.push(`| ${role} | ${b.sessions.toFixed(1)} | ${fmt(b.netDeferredFe)} | ${usd(b.netDeferredUsd)} | ${fmt(b.netEagerFe)} | ${usd(b.netEagerUsd)} |`);
    L.push(`| **cycle total** | | ${fmt(pc.netDeferredFe)} | ${usd(pc.netDeferredUsd)} | ${fmt(pc.netEagerFe)} | ${usd(pc.netEagerUsd)} |`, '',
      'Why signs differ: a role pays the schema once per session whether or not it runs sims. Planners run few sim operations, so with the full schema their saving is smaller than the schema cost (negative in FE). Dollars and FE tokens can disagree in sign because FE weights each token class by the model price relative to Fable while dollars use the role model\'s own prices, and cache reads are cheap in dollars. Live single runs can also be negative (report: the MCP agent spent an extra turn loading schemas) because one run is noisy.', '',
      '### Per role, per session (secondary)', '', 'Same sign rule: positive = MCP saves, negative = MCP costs more.', '',
      `Sim-ops frequency counts Bash calls mentioning sim.sh, evolve.mjs, out/evolve-, render-report or kill; one task = ${p.callsPerTask.toFixed(1)} Bash calls (mean of the Bash transcripts). Saving per task: ${fmt(p.savePerTaskTokens)} tokens offline${p.liveSavingFePerTask === null ? '' : `, ${fmt(p.liveSavingFePerTask)} FE tokens live`}.`, '',
      '| role | model | sessions | turns/session | tasks/session | Bash results MCP avoids (FE) | schema cost (full, FE) | MCP saves FE (full schema) | MCP saves $ (full) | MCP saves FE (deferred) | MCP saves $ (deferred) |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const [role, b] of Object.entries(p.byRole)) {
      if (!b) { L.push(`| ${role} | - | 0 | | | | | | | | |`); continue; }
      L.push(`| ${role} | ${b.model} | ${b.sessions} | ${b.meanTurns.toFixed(0)} | ${b.tasksPerSession.toFixed(2)} | ${fmt(b.grossFe)} | ${fmt(b.schemaEagerFe)} | ${fmt(b.netEagerFe)} | ${usd(b.netEagerUsd)} | ${fmt(b.netDeferredFe)} | ${usd(b.netDeferredUsd)} |`);
    }
    L.push('',
      `Whole project (${Object.entries(p.wholeProjectSessions).map(([k, v]) => `${v} ${k}`).join(', ')} sessions; extrapolation from the sampled per-role means): MCP saves ${fmt(p.wholeProject.netEagerFe)} FE tokens / ${usd(p.wholeProject.netEagerUsd)} (full schema) or ${fmt(p.wholeProject.netDeferredFe)} FE tokens / ${usd(p.wholeProject.netDeferredUsd)} (deferred); a negative number would mean MCP costs more.`);
  }
  return L.join('\n');
}

// ---------- live ----------

const TASKS = {
  status: (n) => `[mcp-cost-live] The evolve run named ${n} is running. Report its current generation, memory use, and the three best candidate teams so far. Do nothing else.`,
  launch: (n) => `[mcp-cost-live] Launch a standard evolve sim on fixtures/sample-pokegenie.csv named ${n} with generations 3, population 12, threads 2 and opponents-per-gen 8, and tell me when generation 0 has started. Do nothing else.`,
  'stop-resume': (n) => `[mcp-cost-live] The evolve run ${n} is running. Stop it cleanly after its next completed generation, then resume it with the same settings, and confirm it resumed. Do nothing else.`,
  report: (n) => `[mcp-cost-live] Give me the path of the final HTML report for the finished run ${n}. Do nothing else.`,
};

async function live() {
  const reportRun = arg('run', 'jaxon-colormega-1');
  mkdirSync(path.join(DIR, 'live'), { recursive: true });
  cleanRuns();
  const noMcp = JSON.stringify({ mcpServers: {} });
  const ways = { mcp: ['--mcp-config', JSON.stringify({ mcpServers: { 'pogo-sim': JSON.parse(readFileSync(path.join(REPO, '.mcp.json'), 'utf8')).mcpServers['pogo-sim'] } }), '--strict-mcp-config'], bash: ['--mcp-config', noMcp, '--strict-mcp-config'] };
  const extra = { mcp: ' Use the pogo-sim MCP tools for this.', bash: ' Use only Bash and scripts/sim.sh; no MCP tools exist.' };
  for (const [task, mk] of Object.entries(TASKS)) {
    for (const [way, flags] of Object.entries(ways)) {
      cleanRuns();
      const name = `mcp-cost-live-${task}-${way}`;
      let target = task === 'report' ? reportRun : name;
      if (task === 'status' || task === 'stop-resume') {
        // a smoke run to act on, started outside the measured session
        bash(`scripts/sim.sh ${CSV} --name ${name} ${smokeFlags}`);
        await waitGens(name, 1);
        target = name;
      }
      const sid = crypto.randomUUID();
      const t0 = Date.now();
      const r = spawnSync('claude', ['-p', mk(target) + extra[way], '--session-id', sid, '--model', 'claude-sonnet-5-5', '--output-format', 'json', '--permission-mode', 'bypassPermissions', ...flags], { cwd: REPO, encoding: 'utf8', timeout: 1200000 });
      const file = path.join(LOGS, `${sid}.jsonl`);
      const s = existsSync(file) ? summarizeSession(readJsonl(file)) : null;
      const res = {
        task, way, sessionId: sid, wallSeconds: Math.round((Date.now() - t0) / 1000), exit: r.status,
        tokens: s?.tokens ?? null, fe: s?.fe ?? null, usd: s?.usd ?? null, turns: s?.turns ?? null, bashCalls: s?.bash ?? null, mcpCalls: s?.mcp ?? null,
        answer: (() => { try { return String(JSON.parse(r.stdout).result).slice(0, 300); } catch { return (r.stderr ?? '').slice(0, 300); } })(),
        source: 'live session',
      };
      write(path.join(DIR, 'live', `${task}-${way}.json`), JSON.stringify(res, null, 2));
      console.log(task, way, res.turns, res.fe && Math.round(res.fe));
      cleanRuns();
    }
  }
}

// ---------- usage + raw-status ----------

const ALL_TOOLS = ['run_standard', 'run_meta', 'run_raw', 'status_sim', 'list_runs', 'list_collections', 'tail_log', 'stop_sim', 'cancel_stop',
  'resume_sim', 'get_report', 'render_report', 'chart_top_teams', 'fitness_sides', 'symmetry_gap', 'build_curated_from_meta',
  'build_shared_collection', 'build_meta_collection', 'refresh_usage', 'preflight', 'smoke_test', 'check_sim', 'check_oom'];

/** Tool-use commands of one session: Bash command text and mcp__pogo-sim__* tool names. */
function sessionCommands(recs) {
  const seen = new Set(); const out = [];
  for (const r of recs) {
    if (r.type !== 'assistant') continue;
    for (const c of r.message?.content ?? []) {
      if (c.type !== 'tool_use' || seen.has(c.id)) continue;
      seen.add(c.id);
      if (c.name === 'Bash') out.push(c.input?.command ?? '');
      else if (c.name.startsWith('mcp__pogo-sim')) out.push(c.name);
    }
  }
  return out;
}
/** First real user message: skips /clear and other local-command wrappers. */
const firstPrompt = (recs) => {
  const u = recs.find((r) => r.type === 'user' && typeof r.message?.content === 'string' && !/^\s*</.test(r.message.content));
  return u?.message?.content ?? '';
};

function usage() {
  const n = Number(arg('last', 20));
  const picked = []; 
  for (const x of recentFiles(400, {})) {
    const recs = readJsonl(path.join(LOGS, x.f));
    if (firstPrompt(recs).startsWith('[mcp-cost-live]') || !recs.some((r) => r.type === 'assistant')) continue;
    picked.push({ id: x.id, commands: sessionCommands(recs) });
    if (picked.length === n) break;
  }
  const rows = tallyUsage(picked, ALL_TOOLS);
  const md = [`# pogo-sim tool usage in the last ${picked.length} sessions (${new Date().toISOString().slice(0, 10)})`, '',
    'Each Bash call (and each mcp__pogo-sim__ call) is mapped to the tool that replaces it by command pattern. Keep = used in 4+ sessions, or a lifecycle tool kept by the "probably just #1" decision.', '',
    '| tool | sessions | calls | keep | why |', '|---|---:|---:|---|---|',
    ...rows.map((r) => `| ${r.tool} | ${r.sessions} | ${r.calls} | ${r.keep ? 'yes' : 'no'} | ${r.sessions >= 4 ? 'count >= 4' : r.lifecycle ? 'lifecycle (user decision), count < 4' : 'moved to extra'} |`)].join('\n');
  write(path.join(DIR, 'usage.json'), JSON.stringify({ sessions: picked.length, rows }, null, 2));
  write(path.join(DIR, 'usage.md'), md);
  console.log(md);
}

function rawStatus() {
  const rows = [];
  for (const x of recentFiles(2000, {})) {
    const recs = readJsonl(path.join(LOGS, x.f));
    const p = firstPrompt(recs);
    if (!isRawStatusOpener(p)) continue;
    const s = summarizeSession(recs);
    if (s.empty || s.mcp > 0) continue;
    rows.push({ id: x.id, date: (s.start ?? '').slice(0, 10), opener: p.split('\n')[0].slice(0, 60), models: s.models, turns: s.turns, bash: s.bash, tokens: s.tokens, fe: s.fe, usd: s.usd });
  }
  const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? (b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2) : 0; };
  const agg = { n: rows.length, medianFe: med(rows.map((r) => r.fe)), meanFe: mean(rows.map((r) => r.fe)), medianUsd: med(rows.map((r) => r.usd)), meanUsd: mean(rows.map((r) => r.usd)) };
  const md = ['# Raw "status" sessions (Bash only, whole session)', '', `n = ${agg.n}. Median ${fmt(agg.medianFe)} FE tokens / ${usd(agg.medianUsd)}; mean ${fmt(agg.meanFe)} FE / ${usd(agg.meanUsd)}.`, '',
    '| id | date | opening phrase | models | turns | Bash | input | cache write | cache read | output | FE | $ |', '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map((r) => `| ${r.id.slice(0, 8)} | ${r.date} | ${r.opener} | ${r.models.join(', ')} | ${r.turns} | ${r.bash} | ${fmt(r.tokens.input)} | ${fmt(r.tokens.write5m + r.tokens.write1h)} | ${fmt(r.tokens.read)} | ${fmt(r.tokens.output)} | ${fmt(r.fe)} | ${usd(r.usd)} |`)].join('\n');
  write(path.join(DIR, 'raw-status.json'), JSON.stringify({ ...agg, rows }, null, 2));
  write(path.join(DIR, 'raw-status.md'), md);
  console.log(md);
}

const cmd = process.argv[2];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (cmd === 'offline') await offline();
    else if (cmd === 'sessions') sessions();
    else if (cmd === 'live') await live();
    else if (cmd === 'usage') usage();
    else if (cmd === 'raw-status') rawStatus();
    else if (cmd === 'live-clean') cleanRuns();
    else { console.error('usage: mcp-token-cost.mjs offline | sessions [--last 20] | live | live-clean'); process.exit(2); }
  } catch (e) {
    console.error(`error: ${String(e.message).split('\n')[0]}`);
    process.exit(1);
  }
}
