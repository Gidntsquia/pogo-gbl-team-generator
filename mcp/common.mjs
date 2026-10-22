// Shared helpers for the pogo-sim MCP servers (server.mjs = kept tools, server-extra.mjs = the rest).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

export {
  z, execFileSync, spawn, existsSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, path,
  REPO, flagsToArgv, simShArgv, configToArgv, latestGen, buildStatus, processTree,
};

const pexec = promisify(execFile);
export const OUT = path.join(REPO, 'out');
export const PIN = '415436c1af47389c299104a83d46be0df5fa5f08';
let flagTable = null;
/** evolve.mjs flag table, parsed from `--help` once. */
export function flags() {
  flagTable ??= parseHelpFlags(execFileSync('node', ['scripts/evolve.mjs', '--help'], { cwd: REPO, encoding: 'utf8' }));
  return flagTable;
}

export const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
export const pidOf = (n) => { try { return Number(readFileSync(path.join(OUT, `evolve-${n}.pid`), 'utf8')); } catch { return null; } };
export const isLive = (n) => { const p = pidOf(n); return p !== null && alive(p); };
export const dirOf = (n) => path.join(OUT, `evolve-${n}`);
export const logOf = (n) => path.join(OUT, `evolve-${n}.log`);
export const gens = (n) => (existsSync(dirOf(n)) ? readdirSync(dirOf(n)) : []);
export const readLog = (n) => (existsSync(logOf(n)) ? readFileSync(logOf(n), 'utf8') : '');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const safeName = (n) => { if (!/^[\w.-]+$/.test(n)) throw new Error(`bad run name "${n}"`); return n; };

export function runNames() {
  const names = new Set();
  for (const f of existsSync(OUT) ? readdirSync(OUT) : []) {
    const m = /^evolve-(.+?)(\.pid)?$/.exec(f);
    if (m && !/\.(log|bak|stop)/.test(f) && !/\.bak/.test(m[1]) && (m[2] || statSync(path.join(OUT, f)).isDirectory())) names.add(m[1]);
  }
  return [...names].sort();
}

export function runState(n) {
  const p = pidOf(n);
  if (p !== null && alive(p)) return `RUNNING (pid ${p})`;
  if (existsSync(path.join(dirOf(n), 'evolve-DONE'))) return 'DONE';
  return 'STOPPED';
}

export const reply = (text, json) => ({
  content: [{ type: 'text', text: json === undefined ? text : `${text}\n\n${JSON.stringify(json, null, 2)}` }],
});
export const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: String(msg).split('\n').filter(Boolean).slice(-2).join('\n') }] });

/** Run a repo script; returns {ok, out}. Errors surface as the script's last 1-2 lines. */
export async function sh(cmd, args, timeout = 600000) {
  try {
    const { stdout, stderr } = await pexec(cmd, args, { cwd: REPO, timeout, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, out: (stdout + stderr).trim() };
  } catch (e) {
    return { ok: false, out: ((e.stderr || '') + (e.stdout || '') || e.message).trim() };
  }
}
export const wrap = (fn) => async (a) => { try { return await fn(a ?? {}); } catch (e) { return fail(e.message); } };

export function resolveName(name) {
  if (name) return safeName(name);
  const running = runNames().filter(isLive);
  if (running.length === 1) return running[0];
  throw new Error(running.length ? `several runs live (${running.join(', ')}); pass name` : `no run live; pass name (runs: ${runNames().join(', ') || 'none'})`);
}

/** Launch time (ms) of a run: launch.json `at`, else newest checkpoint `runStartedAt`, else run dir mtime. */
export function launchTime(n) {
  const d = dirOf(n);
  try { const t = Date.parse(JSON.parse(readFileSync(path.join(d, 'launch.json'), 'utf8')).at); if (!Number.isNaN(t)) return t; } catch { /* fall through */ }
  try {
    const g = latestGen(gens(n));
    if (g >= 0) { const t = Date.parse(JSON.parse(readFileSync(path.join(d, `evolve-gen${g}.json`), 'utf8')).runStartedAt); if (!Number.isNaN(t)) return t; }
  } catch { /* fall through */ }
  try { return statSync(d).mtimeMs; } catch { return 0; }
}

/**
 * status_sim run choice: explicit name, else the live run, else (several live) the most recently launched.
 * @returns {{name: string, others: string[]}} `others` = other live runs
 */
export function resolveStatusName(name) {
  if (name) return { name: safeName(name), others: [] };
  const running = runNames().filter(isLive).sort((a, b) => launchTime(b) - launchTime(a));
  if (!running.length) {
    throw new Error(`no run live; pass name (runs: ${runNames().map((n) => `${n} ${runState(n)}`).join(', ') || 'none'})`);
  }
  return { name: running[0], others: running.slice(1) };
}

/** Wait up to 60 s for the first generation-0/resuming line (or the process dying). */
export async function waitFirstLine(n, pid, offset = 0) {
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

export function writeLaunch(n, argv, extra = {}) {
  mkdirSync(dirOf(n), { recursive: true });
  writeFileSync(path.join(dirOf(n), 'launch.json'), JSON.stringify({ argv, at: new Date().toISOString(), ...extra }, null, 2));
}

/** Detached `node scripts/evolve.mjs argv`, log to out/evolve-n.log, pid to out/evolve-n.pid. */
export function launchDetached(n, argv, { append = false } = {}) {
  mkdirSync(OUT, { recursive: true });
  const fd = openSync(logOf(n), append ? 'a' : 'w');
  const child = spawn('node', ['scripts/evolve.mjs', ...argv], { cwd: REPO, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  writeFileSync(path.join(OUT, `evolve-${n}.pid`), String(child.pid));
  return child.pid;
}

export function guardLaunch(n) {
  if (isLive(n)) throw new Error(`run '${n}' is already in progress (pid ${pidOf(n)})`);
  if (!existsSync(path.join(REPO, 'vendor/pvpoke'))) throw new Error('vendor/pvpoke is missing -- run the preflight tool first');
}


/** Create a server and its `tool(name, description, shape, fn)` registrar. */
export function makeServer(name) {
  const server = new McpServer({ name, version: '1.0.0' });
  const tool = (n, description, shape, fn) => server.registerTool(n, { description, inputSchema: shape }, wrap(fn));
  return { server, tool, start: () => server.connect(new StdioServerTransport()) };
}
const extraSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional()
  ;
export const commonShape = {
  name: z.string().optional(), cup: z.string().optional(), cp: z.number().optional(),
  ban: z.array(z.string()).optional(),
  hours: z.number().optional(), threads: z.number().optional(),
  generations: z.number().optional(), population: z.number().optional(),
  quick: z.boolean().optional(), cpuOnly: z.boolean().optional(),
  dry_run: z.boolean().optional(), extra: extraSchema,
};

export async function launchViaSim(a, kind) {
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

/** Path of a run's HTML report, rendering it first when missing or older than evolve-result.json. */
export async function ensureReport(n) {
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

// ---- chains (scripts/chain.sh): out/chain-<name>.json state ----
export const chainStatePath = (c) => path.join(OUT, `chain-${c}.json`);
export function readChain(c) { try { return JSON.parse(readFileSync(chainStatePath(c), 'utf8')); } catch { return null; } }
/** Chain names with a state file. */
export function chainNames() {
  return (existsSync(OUT) ? readdirSync(OUT) : []).map((f) => /^chain-(.+)\.json$/.exec(f)?.[1]).filter(Boolean).sort();
}
/** The chain a run belongs to, as {name, state, stage} (or null). */
export function chainOfRun(n) {
  for (const c of chainNames()) {
    const st = readChain(c);
    if (st && (st.metaRun === n || st.stdRun === n)) return { name: c, state: st, stage: st.metaRun === n ? 1 : 3 };
  }
  return null;
}
export const STAGE_LABEL = ['meta', 'curated', 'standard'];
/** argv for scripts/chain.sh from run_chain input. */
export function chainArgv(a) {
  const argv = ['--name', a.name, '--cup', a.cup, a.csv];
  const opt = (f, v) => { if (v !== undefined && v !== null && v !== '') argv.push(f, String(v)); };
  opt('--meta-generations', a.meta_generations); opt('--generations', a.generations);
  opt('--candidates', a.candidates); opt('--opponents', a.opponents); opt('--threads', a.threads ?? 8);
  if (a.cpuOnly) argv.push('--cpu-only');
  if (a.dry_run) argv.push('--dry-run');
  const extra = flagsToArgv(a.extra, flags());
  if (extra.length) argv.push('--', ...extra);
  return argv;
}
export async function runChainTool(a) {
  const name = safeName(a.name);
  guardLaunch(`${name}-meta`);
  guardLaunch(`${name}-std`);
  const r = await sh('bash', ['scripts/chain.sh', ...chainArgv(a)], 180000);
  if (!r.ok) return fail(r.out);
  if (a.dry_run) return reply(`dry run, nothing launched:\n${r.out.trim()}`, { argv: chainArgv(a), commands: r.out.trim().split('\n') });
  const pid = Number(/pid (\d+)/.exec(r.out)?.[1]);
  const first = r.out.trim().split('\n')[0];
  return reply(`Chain '${name}' launched (pid ${pid}): ${name}-meta -> curated -> ${name}-std.\n${first}`,
    { name, metaRun: `${name}-meta`, stdRun: `${name}-std`, pid, firstLine: first });
}
