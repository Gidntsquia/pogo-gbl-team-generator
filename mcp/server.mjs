// pogo-sim: stdio MCP server wrapping scripts/sim.sh, scripts/evolve.mjs and the analysis scripts.
// It never fights battles; every run is launched detached so killing this server never kills a sim.

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync, readdirSync, readFileSync, writeFileSync, statSync, openSync, mkdirSync,
} from 'node:fs';
import path from 'node:path';
import {
  REPO, parseHelpFlags, flagsToArgv, simShArgv, configToArgv, latestGen, buildStatus, processTree,
} from './lib.mjs';

const pexec = promisify(execFile);
const OUT = path.join(REPO, 'out');
const PIN = 'e87448291024aff808f21a2e5f74e69f68b521df';

let flagTable = null;
/** evolve.mjs flag table, parsed from `--help` once. */
function flags() {
  flagTable ??= parseHelpFlags(execFileSync('node', ['scripts/evolve.mjs', '--help'], { cwd: REPO, encoding: 'utf8' }));
  return flagTable;
}

const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
const pidOf = (n) => { try { return Number(readFileSync(path.join(OUT, `evolve-${n}.pid`), 'utf8')); } catch { return null; } };
const isLive = (n) => { const p = pidOf(n); return p !== null && alive(p); };
const dirOf = (n) => path.join(OUT, `evolve-${n}`);
const logOf = (n) => path.join(OUT, `evolve-${n}.log`);
const gens = (n) => (existsSync(dirOf(n)) ? readdirSync(dirOf(n)) : []);
const readLog = (n) => (existsSync(logOf(n)) ? readFileSync(logOf(n), 'utf8') : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeName = (n) => { if (!/^[\w.-]+$/.test(n)) throw new Error(`bad run name "${n}"`); return n; };

function runNames() {
  const names = new Set();
  for (const f of existsSync(OUT) ? readdirSync(OUT) : []) {
    const m = /^evolve-(.+?)(\.pid)?$/.exec(f);
    if (m && !/\.(log|bak|stop)/.test(f) && !/\.bak/.test(m[1]) && (m[2] || statSync(path.join(OUT, f)).isDirectory())) names.add(m[1]);
  }
  return [...names].sort();
}

function runState(n) {
  const p = pidOf(n);
  if (p !== null && alive(p)) return `RUNNING (pid ${p})`;
  if (existsSync(path.join(dirOf(n), 'evolve-DONE'))) return 'DONE';
  return 'STOPPED';
}

const reply = (text, json) => ({
  content: [{ type: 'text', text: json === undefined ? text : `${text}\n\n${JSON.stringify(json, null, 2)}` }],
});
const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: String(msg).split('\n').filter(Boolean).slice(-2).join('\n') }] });

/** Run a repo script; returns {ok, out}. Errors surface as the script's last 1-2 lines. */
async function sh(cmd, args, timeout = 600000) {
  try {
    const { stdout, stderr } = await pexec(cmd, args, { cwd: REPO, timeout, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, out: (stdout + stderr).trim() };
  } catch (e) {
    return { ok: false, out: ((e.stderr || '') + (e.stdout || '') || e.message).trim() };
  }
}
const wrap = (fn) => async (a) => { try { return await fn(a ?? {}); } catch (e) { return fail(e.message); } };

function resolveName(name) {
  if (name) return safeName(name);
  const running = runNames().filter(isLive);
  if (running.length === 1) return running[0];
  throw new Error(running.length ? `several runs live (${running.join(', ')}); pass name` : `no run live; pass name (runs: ${runNames().join(', ') || 'none'})`);
}

/** Wait up to 60 s for the first generation-0/resuming line (or the process dying). */
async function waitFirstLine(n, pid, offset = 0) {
  for (let i = 0; i < 60; i++) {
    const t = readLog(n).slice(offset);
    const line = t.split('\n').find((l) => /generation 0: battling|resuming --|starting fresh|^error|Error:/.test(l));
    if (line && /battling|resuming/.test(line)) return line;
    if (line && /^error|Error:/.test(line)) return line;
    if (!alive(pid)) return `process exited early: ${t.trim().split('\n').slice(-2).join(' | ')}`;
    await sleep(1000);
  }
  return 'no generation-0/resuming line within 60 s (still starting; check tail_log)';
}

function writeLaunch(n, argv, extra = {}) {
  mkdirSync(dirOf(n), { recursive: true });
  writeFileSync(path.join(dirOf(n), 'launch.json'), JSON.stringify({ argv, at: new Date().toISOString(), ...extra }, null, 2));
}

/** Detached `node scripts/evolve.mjs argv`, log to out/evolve-n.log, pid to out/evolve-n.pid. */
function launchDetached(n, argv, { append = false } = {}) {
  mkdirSync(OUT, { recursive: true });
  const fd = openSync(logOf(n), append ? 'a' : 'w');
  const child = spawn('node', ['scripts/evolve.mjs', ...argv], { cwd: REPO, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  writeFileSync(path.join(OUT, `evolve-${n}.pid`), String(child.pid));
  return child.pid;
}

function guardLaunch(n) {
  if (isLive(n)) throw new Error(`run '${n}' is already in progress (pid ${pidOf(n)})`);
  if (!existsSync(path.join(REPO, 'vendor/pvpoke'))) throw new Error('vendor/pvpoke is missing -- run the preflight tool first');
}

const server = new McpServer({ name: 'pogo-sim', version: '1.0.0' });
const tool = (name, description, shape, fn) => server.registerTool(name, { description, inputSchema: shape }, wrap(fn));

const extraSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional()
  .describe('any evolve.mjs flag (name without --) -> value; true for boolean flags; passed after `--`');
const commonShape = {
  name: z.string().optional(), cup: z.string().optional(), cp: z.number().optional(),
  ban: z.array(z.string()).optional().describe('species banned format-wide, both sides'),
  hours: z.number().optional().describe('wall-clock budget'), threads: z.number().optional().describe('default 8'),
  generations: z.number().optional(), population: z.number().optional(),
  quick: z.boolean().optional().describe('3-generation foreground trial'),
  dry_run: z.boolean().optional().describe('print the evolve.mjs command, launch nothing'), extra: extraSchema,
};

async function launchViaSim(a, kind) {
  const argv = simShArgv(a, kind, flags());
  const n = a.name ? safeName(a.name) : null;
  if (n && !a.dry_run) guardLaunch(n);
  if (!existsSync(path.join(REPO, 'vendor/pvpoke'))) throw new Error('vendor/pvpoke is missing -- run the preflight tool first');
  const r = await sh('bash', ['scripts/sim.sh', ...argv], a.quick ? 600000 : 120000);
  if (!r.ok) return fail(r.out);
  const cmdLine = /\[sim\] command:\s+(.*)/.exec(r.out)?.[1];
  if (a.dry_run) return reply(`dry run, nothing launched:\n${cmdLine}`, { command: cmdLine });
  const runName = /--seed (\S+)/.exec(cmdLine ?? '')?.[1] ?? n;
  if (cmdLine) writeLaunch(runName, cmdLine.split(' '), { via: 'sim.sh', simArgs: argv });
  if (a.quick) return reply(`quick run finished:\n${r.out.split('\n').slice(-6).join('\n')}`);
  const pid = pidOf(runName);
  const first = await waitFirstLine(runName, pid);
  return reply(`Launched detached run '${runName}' (pid ${pid}).\n${first}`, {
    name: runName, outDir: dirOf(runName), log: logOf(runName), pid, firstLine: first,
  });
}

tool('run_standard', 'LAUNCHES a detached standard evolve run via scripts/sim.sh (the established recipe). Starts a long-running process.',
  { csv: z.string().describe('collection CSV path'), ...commonShape }, (a) => launchViaSim(a, 'standard'));
tool('run_meta', 'LAUNCHES a detached meta-vs-meta evolve run via scripts/sim.sh --meta (adds --meta-mode --random-opponent-lead). Starts a long-running process.',
  { ...commonShape, meta_pool: z.number().optional().describe('both species pools (default 400, 0 = full field)') },
  (a) => launchViaSim(a, 'meta'));

tool('run_raw', 'LAUNCHES a detached `node scripts/evolve.mjs` with any flags (names exactly as in --help, no --). Unknown flags are rejected with the nearest valid name. Starts a long-running process.',
  {
    name: z.string(), collection: z.string().describe('collection CSV path'),
    flags: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
  },
  async (a) => {
    const n = safeName(a.name);
    const argv = [a.collection, ...flagsToArgv(a.flags, flags())];
    if (!argv.includes('--out-dir')) argv.push('--out-dir', `out/evolve-${n}`);
    if (!argv.includes('--seed')) argv.push('--seed', n);
    guardLaunch(n);
    const check = await sh('node', ['scripts/evolve.mjs', ...argv, '--check']);
    if (!check.ok) return fail(check.out);
    writeLaunch(n, argv, { via: 'run_raw' });
    const pid = launchDetached(n, argv);
    const first = await waitFirstLine(n, pid);
    return reply(`Launched detached run '${n}' (pid ${pid}).\n${first}`, { name: n, pid, command: `node scripts/evolve.mjs ${argv.join(' ')}`, firstLine: first });
  });

// ---- status ----
function latestCheckpoint(n) {
  const g = latestGen(gens(n));
  if (g < 0) return null;
  return JSON.parse(readFileSync(path.join(dirOf(n), `evolve-gen${g}.json`), 'utf8'));
}

tool('status_sim', 'Lightweight status of a run: top candidate/opponent teams and species, speed, ETA, memory. Reads the newest checkpoint and log (no processes touched).',
  { name: z.string().optional(), top: z.number().optional().describe('default 15') },
  async (a) => {
    const n = resolveName(a.name);
    const cp = latestCheckpoint(n);
    if (!cp) return fail(`no checkpoint yet for '${n}'`);
    const logText = readLog(n);
    const s = buildStatus(cp, logText, a.top ?? 15);
    const pid = pidOf(n);
    let liveRssMB = null;
    if (pid && alive(pid)) liveRssMB = processTree(execFileSync('ps', ['-eo', 'pid,ppid,rss'], { encoding: 'utf8' }), pid).rssMB;
    const stopPid = (() => { try { return Number(readFileSync(path.join(OUT, `evolve-${n}.stop.pid`), 'utf8')); } catch { return null; } })();
    const lastLine = logText.trim().split('\n').at(-1) ?? '';
    const state = runState(n);
    s.memory.liveRssMB = liveRssMB;
    const pending = stopPid && alive(stopPid) ? ` | soft stop PENDING (watcher pid ${stopPid})` : '';
    const head = `${n}: ${state}${pending} -- checkpoint gen ${s.checkpointGeneration} of ${s.generations} (from evolve-gen${s.checkpointGeneration}.json; log line: "${lastLine.slice(0, 120)}")`;
    const lines = [
      head,
      `speed: gen ${s.speed.lastGenElapsedSec}s, ${s.speed.msPerBattle} ms/battle, ${s.speed.battlesSimulated} simulated + ${s.speed.battlesCached} cached, ETA ${s.speed.etaMinutes} min`,
      `memory: logged RSS ${s.memory.lastLoggedRssMB} MB, live ${liveRssMB ?? 'n/a'} MB`,
      'top teams:', ...s.topTeams.map((t) => `  ${t.rank}. ${t.members.join(' / ')} fit ${t.fitness} win ${t.winRate}`),
      'top candidate Pokemon:', ...s.topSpecies.map((p, i) => `  ${i + 1}. ${p.species} mean fit ${p.meanFitness} rep ${p.representation}`),
      'top opponent teams:', ...s.topOpponentTeams.map((o, i) => `  ${i + 1}. ${o.name} (${o.origin}) fit ${o.fitness}`),
      'top opponent Pokemon:', ...s.topOpponentSpecies.map((p, i) => `  ${i + 1}. ${p.species} mean fit ${p.meanFitness} rep ${p.representation}`),
    ];
    return reply(lines.join('\n'), { state, softStopPending: !!pending, logLine: lastLine, ...s });
  });

tool('list_runs', 'List every run under out/ with state, checkpoint generation and last log line.', {}, async () => {
  const rows = runNames().map((n) => ({
    name: n, state: runState(n), checkpointGen: latestGen(gens(n)), lastLog: readLog(n).trim().split('\n').at(-1) ?? '',
  }));
  return reply(rows.map((r) => `${r.name}: ${r.state}, gen ${r.checkpointGen}\n  ${r.lastLog.slice(0, 140)}`).join('\n') || 'no runs', rows);
});

tool('list_collections', 'List collection CSVs (repo root and fixtures/) with row counts.', {}, async () => {
  const rows = [];
  for (const d of ['.', 'fixtures']) {
    for (const f of readdirSync(path.join(REPO, d))) {
      if (!f.endsWith('.csv')) continue;
      const p = path.join(d, f);
      rows.push({ path: p, rows: readFileSync(path.join(REPO, p), 'utf8').split('\n').filter(Boolean).length - 1 });
    }
  }
  return reply(rows.map((r) => `${r.path}: ${r.rows} rows`).join('\n'), rows);
});

tool('tail_log', 'Last lines of a run log.', { name: z.string(), lines: z.number().optional().describe('default 30') }, async (a) => {
  const t = readLog(safeName(a.name)).trimEnd().split('\n').slice(-(a.lines ?? 30)).join('\n');
  return reply(t || '(empty log)');
});

// ---- stop / resume ----
tool('stop_sim', 'STOPS a run. mode "after_generation" starts a detached watcher (mcp/soft-stop.mjs) that waits for the next checkpoint then SIGTERMs the run. mode "hard" SIGTERMs immediately (loses the in-flight generation) and needs confirm:true.',
  { name: z.string().optional(), mode: z.enum(['after_generation', 'hard']), confirm: z.boolean().optional(), poll_seconds: z.number().optional() },
  async (a) => {
    const n = resolveName(a.name);
    const pid = pidOf(n);
    if (!pid || !alive(pid)) return fail(`run '${n}' is not running`);
    if (a.mode === 'hard') {
      if (a.confirm !== true) return fail('hard stop discards the in-flight generation; pass confirm:true');
      const { pids } = processTree(execFileSync('ps', ['-eo', 'pid,ppid,rss'], { encoding: 'utf8' }), pid);
      for (const p of pids) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
      return reply(`SIGTERM sent to ${pids.join(',')}`, { pids });
    }
    const existing = (() => { try { return Number(readFileSync(path.join(OUT, `evolve-${n}.stop.pid`), 'utf8')); } catch { return null; } })();
    if (existing && alive(existing)) return fail(`soft stop already pending (watcher pid ${existing})`);
    const startGen = latestGen(gens(n));
    const child = spawn('node', ['mcp/soft-stop.mjs', n, String(a.poll_seconds ?? 10)], {
      cwd: REPO, detached: true, stdio: 'ignore',
    });
    child.unref();
    writeFileSync(path.join(OUT, `evolve-${n}.stop.pid`), String(child.pid));
    return reply(`Soft stop armed (watcher pid ${child.pid}); will SIGTERM run ${pid} once checkpoint gen ${startGen + 1} exists. Log: out/evolve-${n}.stop.log`,
      { watcherPid: child.pid, waitingForGeneration: startGen + 1 });
  });

tool('cancel_stop', 'Kills a pending soft-stop watcher (the run keeps going).', { name: z.string().optional() }, async (a) => {
  const n = resolveName(a.name);
  const p = (() => { try { return Number(readFileSync(path.join(OUT, `evolve-${n}.stop.pid`), 'utf8')); } catch { return null; } })();
  if (!p || !alive(p)) return reply('no pending soft stop');
  process.kill(p, 'SIGTERM');
  return reply(`watcher ${p} killed`);
});

tool('resume_sim', 'LAUNCHES a detached resume of a stopped run: rebuilds flags from the latest checkpoint config (non-fingerprint flags from launch.json), same out dir and seed. Verifies the "resuming" log line.',
  { name: z.string(), threads: z.number().optional(), force_fresh: z.boolean().optional(), confirm: z.boolean().optional() },
  async (a) => {
    const n = safeName(a.name);
    guardLaunch(n);
    const g = latestGen(gens(n));
    if (g < 0) return fail(`no checkpoint for '${n}'`);
    const cp = JSON.parse(readFileSync(path.join(dirOf(n), `evolve-gen${g}.json`), 'utf8'));
    const lp = path.join(dirOf(n), 'launch.json');
    const launch = existsSync(lp) ? JSON.parse(readFileSync(lp, 'utf8')) : null;
    const { argv, usedLaunch } = configToArgv(cp.config, launch);
    argv.push('--out-dir', `out/evolve-${n}`, '--threads', String(a.threads ?? cp.threadsUsed ?? 8));
    if (a.force_fresh) {
      if (a.confirm !== true) return fail('force_fresh discards the existing checkpoints; pass confirm:true');
      argv.push('--force-fresh');
    }
    const chk = await sh('node', ['scripts/evolve.mjs', ...argv, '--check']);
    if (!chk.ok) return fail(chk.out);
    const offset = readLog(n).length;
    const pid = launchDetached(n, argv, { append: true });
    const first = await waitFirstLine(n, pid, offset);
    const tailText = readLog(n).slice(offset);
    if (/starting fresh/.test(tailText) && !a.force_fresh) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
      return fail(`resume started fresh instead of resuming; killed pid ${pid}. A flag could not be reconstructed from the checkpoint. Check launch.json / tail_log.`);
    }
    if (!/resuming/.test(first) && !a.force_fresh) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
      return fail(`resume not confirmed: ${first}`);
    }
    return reply(`Resumed '${n}' (pid ${pid}).\n${first}${usedLaunch.length ? `\n(took ${usedLaunch.join(', ')} from launch.json)` : ''}`,
      { pid, firstLine: first, argv, fromLaunchJson: usedLaunch, fallbackUsed: usedLaunch.length > 0 });
  });

// ---- reports ----
async function ensureReport(n) {
  const d = dirOf(n);
  const html = path.join(d, 'my-teams-evolve.html');
  const result = path.join(d, 'evolve-result.json');
  if (!existsSync(result) && !existsSync(html)) return { err: `run '${n}' has no evolve-result.json yet (still running?); use status_sim` };
  if (existsSync(result) && (!existsSync(html) || statSync(html).mtimeMs < statSync(result).mtimeMs)) {
    const r = await sh('node', ['scripts/render-report.mjs', `out/evolve-${n}`]);
    if (!r.ok) return { err: r.out };
  }
  return { html };
}

tool('get_report', 'Returns the final HTML report of a finished run (rendering it first if missing or stale) and returns only its absolute file path (HTML is not inlined).',
  { name: z.string() }, async (a) => {
    const n = safeName(a.name);
    const r = await ensureReport(n);
    if (r.err) return fail(r.err);
    const kb = (statSync(r.html).size / 1024).toFixed(0);
    return reply(`Report: ${r.html} (${kb} KB). Open it by path; HTML not inlined.`, { path: r.html, uri: `file://${r.html}` });
  });

server.registerResource('run-report', new ResourceTemplate('pogo-sim://runs/{name}/report.html', { list: undefined }), { description: 'Final HTML report of a run', mimeType: 'text/html' }, async (uri, { name }) => {
  const r = await ensureReport(safeName(String(name)));
  if (r.err) throw new Error(r.err);
  return { contents: [{ uri: uri.href, mimeType: 'text/html', text: readFileSync(r.html, 'utf8') }] };
});

const script = (file, build) => async (a) => {
  const r = await sh('node', [file, ...build(a)]);
  return r.ok ? reply(r.out.split('\n').slice(-25).join('\n')) : fail(r.out);
};
tool('render_report', 'Re-render a run\'s reports from evolve-result.json.', { name: z.string() }, script('scripts/render-report.mjs', (a) => [`out/evolve-${safeName(a.name)}`]));
tool('chart_top_teams', 'Race chart of the top teams of a run.', { name: z.string(), top: z.number().optional(), out: z.string().optional() },
  script('scripts/chart-top-teams.mjs', (a) => [`out/evolve-${safeName(a.name)}`, ...(a.top ? ['--top', String(a.top)] : []), ...(a.out ? ['--out', a.out] : [])]));
tool('fitness_sides', 'Candidate-vs-opponent fitness side comparison for a run.', { name: z.string() },
  script('scripts/fitness-sides.mjs', (a) => [`out/evolve-${safeName(a.name)}`]));
tool('symmetry_gap', 'scripts/symmetry-gap.mjs report --label L [--minus B].', { label: z.string(), minus: z.string().optional() },
  script('scripts/symmetry-gap.mjs', (a) => ['report', '--label', a.label, ...(a.minus ? ['--minus', a.minus] : [])]));
tool('build_curated_from_meta', 'Build a curated team set from a meta run dir.', {
  out_dir: z.string(), cup: z.string(), candidates: z.number().optional(), opponents: z.number().optional(),
}, script('scripts/build-curated-from-meta.mjs', (a) => [a.out_dir, '--cup', a.cup, ...(a.candidates ? ['--candidates', String(a.candidates)] : []), ...(a.opponents ? ['--opponents', String(a.opponents)] : [])]));
tool('build_shared_collection', 'Intersect two collection CSVs into a shared-pool CSV.', { csvA: z.string(), csvB: z.string(), out: z.string(), cp: z.number().optional() },
  script('scripts/build-shared-collection.mjs', (a) => [a.csvA, a.csvB, '--out', a.out, ...(a.cp ? ['--cp', String(a.cp)] : [])]));
tool('build_meta_collection', 'Build the meta collection CSV for a cup/cp.', { cup: z.string().optional(), cp: z.number().optional(), out: z.string().optional() },
  script('scripts/build-meta-collection.mjs', (a) => [...(a.cp ? ['--cp', String(a.cp)] : []), ...(a.cup ? ['--cup', a.cup] : []), ...(a.out ? ['--out', a.out] : [])]));
tool('refresh_usage', 'Fetches live GL rankings into data/meta-usage.json (network; deliberate, human-triggered).', { confirm: z.boolean() },
  async (a) => (a.confirm === true ? script('scripts/refresh-usage.mjs', () => [])(a) : fail('pass confirm:true')));

// ---- preflight & checks ----
tool('preflight', 'Runs scripts/setup.sh and checks branch, pvpoke pin and the three pinned move values.', {}, async () => {
  const checks = [];
  const setup = await sh('bash', ['scripts/setup.sh']);
  checks.push({ check: 'setup.sh', pass: setup.ok, detail: setup.out.split('\n').slice(-1)[0] });
  const br = await sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  checks.push({ check: 'branch is main', pass: br.out === 'main', detail: br.out });
  const head = await sh('git', ['-C', 'vendor/pvpoke', 'rev-parse', 'HEAD']);
  checks.push({ check: 'pvpoke pin', pass: head.out === PIN, detail: head.out });
  const gm = await sh('node', ['-e', `
    const m=JSON.parse(require('fs').readFileSync('vendor/pvpoke/src/data/gamemaster.json','utf8')).moves;
    const g=(id)=>{const x=m.find(y=>y.moveId===id);return x&&[x.power,x.energy,x.energyGain].join('/')};
    console.log(['BODY_SLAM','BUBBLE_BEAM','INFESTATION'].map(g).join(' '))`]);
  checks.push({ check: 'moves BODY_SLAM 65/40/0, BUBBLE_BEAM 50/50/0, INFESTATION 10/0/12', pass: gm.ok && gm.out === '65/40/0 50/50/0 10/0/12', detail: gm.out });
  return reply(checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.check}${c.pass ? '' : ` (${c.detail})`}`).join('\n'), checks);
});

tool('smoke_test', 'Runs a ~1-2 minute foreground smoke sim (2 generations, population 12) and returns the last log lines.', { csv: z.string().optional() }, async (a) => {
  const dir = `out/smoke-mcp`;
  const r = await sh('node', ['scripts/evolve.mjs', a.csv ?? 'fixtures/sample-pokegenie.csv', '--generations', '2', '--population', '12',
    '--opponents-per-gen', '8', '--threads', '2', '--out-dir', dir, '--force-fresh', '--no-html'], 300000);
  return r.ok ? reply(r.out.split('\n').slice(-8).join('\n')) : fail(r.out);
});

tool('check_sim', 'Validates a proposed evolve flag set (--check): nothing runs.', { collection: z.string(), flags: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional() }, async (a) => {
  const r = await sh('node', ['scripts/evolve.mjs', a.collection, ...flagsToArgv(a.flags, flags()), '--check']);
  return r.ok ? reply(`ok\n${r.out.split('\n').slice(-5).join('\n')}`) : fail(r.out);
});

tool('check_oom', 'Look for earlyoom kills of a run in the journal.', { name: z.string() }, async (a) => {
  const n = safeName(a.name);
  const r = await sh('bash', ['-c', `journalctl -u earlyoom --no-pager 2>/dev/null | grep -i "evolve.*${n}\\|sending SIGTERM" | tail -5`]);
  return reply(r.out || `no earlyoom entries found for '${n}' (journal may be unavailable)`);
});

await server.connect(new StdioServerTransport());
