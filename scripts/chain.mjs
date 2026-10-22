#!/usr/bin/env node
// Chain: meta-vs-meta run -> per-cup curated file -> standard run. Driven by scripts/chain.sh.
//
//   scripts/chain.sh --name N --cup C <csv> [--meta-generations G] [--generations G] [--candidates 50]
//     [--opponents 50] [--threads N] [--cpu-only] [--dry-run] [-- extra sim.sh flags]
//   (internal) node scripts/chain.mjs --run-detached ...   the detached driver
//
// State: out/chain-<name>.json {cup, csv, stage 1|2|3, status running|done|failed, metaRun, stdRun,
// startedAt, stageTimes}. Log: out/chain-<name>.log. Nothing is retried; a failed stage stops the chain.
// `--continue` (used by the MCP resume_sim) attaches to the run of the recorded stage if it is live,
// and never re-runs a finished stage.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STAGE_NAMES = ['meta', 'curated', 'standard'];

const et = (d = new Date()) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'medium' }).format(d) + ' ET';

export const statePath = (name, out = 'out') => path.join(out, `chain-${name}.json`);
export const readState = (name, out = 'out') => {
  try { return JSON.parse(readFileSync(statePath(name, out), 'utf8')); } catch { return null; }
};

/** Parse chain argv. @returns {object} */
export function parseArgs(argv) {
  const o = { extra: [], cpuOnly: false, dryRun: false, continue: false, detached: false, candidates: 50, opponents: 50 };
  const val = { '--name': 'name', '--cup': 'cup', '--meta-generations': 'metaGenerations', '--generations': 'generations',
    '--candidates': 'candidates', '--opponents': 'opponents', '--threads': 'threads', '--population': 'population' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.extra = argv.slice(i + 1); break; }
    if (val[a]) o[val[a]] = argv[++i];
    else if (a === '--cpu-only') o.cpuOnly = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--continue') o.continue = true;
    else if (a === '--run-detached') o.detached = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else o.csv = a;
  }
  return o;
}

/** The three stage commands (argv arrays) for chain options. */
export function stageCommands(o) {
  const common = (a) => {
    if (o.threads) a.push('--threads', String(o.threads));
    a.push('--population', String(o.population ?? 300));
    if (o.cpuOnly) a.push('--cpu-only');
    return a;
  };
  const metaRun = `${o.name}-meta`, stdRun = `${o.name}-std`;
  const curatedFile = `data/meta-teams-community-${o.cup}.json`;
  const s1 = common(['bash', 'scripts/sim.sh', '--meta', '--name', metaRun, '--cup', o.cup]);
  s1.push('--generations', String(o.metaGenerations ?? 100));
  const s2 = ['node', 'scripts/build-curated-from-meta.mjs', `out/evolve-${metaRun}`, '--cup', o.cup,
    '--candidates', String(o.candidates), '--opponents', String(o.opponents), '--out', curatedFile];
  const s3 = common(['bash', 'scripts/sim.sh', o.csv, '--name', stdRun, '--cup', o.cup]);
  s3.push('--generations', String(o.generations ?? 100));
  if (o.extra.length) { s1.push('--', ...o.extra); s3.push('--', ...o.extra); }
  return { metaRun, stdRun, curatedFile, commands: [s1, s2, s3] };
}

/** Compare the curated count the standard run logged with the team count in the per-cup file. */
export function checkCurated(logText, fileJson) {
  const m = /shared setup done[^\n]*?(\d+) curated opponent teams/.exec(logText);
  const loaded = m ? Number(m[1]) : null;
  const n = Array.isArray(fileJson?.teams) ? fileJson.teams.length : 0;
  return { ok: loaded !== null && loaded > 0 && loaded === n, loaded, n };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
const pidOf = (run, out) => { try { return Number(readFileSync(path.join(out, `evolve-${run}.pid`), 'utf8')); } catch { return null; } };

/**
 * Run the stages. `deps` lets tests stub process work:
 * {launch(stage, cmd) -> pid|null, wait(run) -> Promise, buildCurated(cmd) -> {status}, readLog(run), out}
 */
export async function runChain(o, deps) {
  const out = deps.out ?? 'out';
  const { metaRun, stdRun, curatedFile, commands } = stageCommands(o);
  const logFile = path.join(out, `chain-${o.name}.log`);
  const log = (m) => { const l = `${et()} [chain ${o.name}] ${m}`; console.log(l); };
  let st = readState(o.name, out);
  if (!st || !o.continue) {
    st = { opts: { metaGenerations: o.metaGenerations, generations: o.generations, population: o.population, candidates: o.candidates, opponents: o.opponents, threads: o.threads, cpuOnly: o.cpuOnly, extra: o.extra }, cup: o.cup, csv: o.csv, stage: 1, status: 'running', metaRun, stdRun, startedAt: new Date().toISOString(), stageTimes: {} };
  }
  const save = () => writeFileSync(statePath(o.name, out), JSON.stringify(st, null, 2) + '\n');
  const fail = (why) => { st.status = 'failed'; st.failure = why; save(); log(`FAILED at stage ${st.stage} (${STAGE_NAMES[st.stage - 1]}): ${why}`); return false; };
  st.status = 'running'; delete st.failure; save();
  const done = (run) => existsSync(path.join(out, `evolve-${run}`, 'evolve-DONE'));

  for (let stage = st.stage; stage <= 3; stage++) {
    st.stage = stage; st.stageTimes[stage] = { ...st.stageTimes[stage], start: et() }; save();
    log(`stage ${stage}/3 (${STAGE_NAMES[stage - 1]}) start`);
    if (stage === 2) {
      if (!done(metaRun)) return fail(`${metaRun} has no evolve-DONE`);
      if (deps.exists(curatedFile)) log(`${curatedFile} already exists; skipping build`);
      else {
        const r = deps.buildCurated(commands[1]);
        if (r.status !== 0) return fail(`build-curated-from-meta exited ${r.status}`);
      }
    } else {
      const run = stage === 1 ? metaRun : stdRun;
      if (!done(run)) {
        if (!(o.continue && deps.live(run))) {
          const pid = deps.launch(stage, commands[stage - 1]);
          if (!pid) return fail(`sim.sh did not launch ${run}`);
        }
        await deps.wait(run, stage);
      }
      if (!done(run)) return fail(`${run} exited without evolve-DONE (killed, OOM or sidecar death)`);
      if (stage === 3) {
        const c = checkCurated(deps.readLog(stdRun), deps.readJson(curatedFile));
        log(`curated: ${c.loaded} loaded of ${c.n}`);
        if (!c.ok) return fail(`curated count mismatch: ${c.loaded} loaded of ${c.n}`);
      }
    }
    st.stageTimes[stage].end = et(); save();
    log(`stage ${stage}/3 done`);
  }
  st.status = 'done'; save(); log('chain done');
  return true;
}

function realDeps(o) {
  const out = 'out';
  return {
    out,
    exists: (p) => existsSync(path.join(REPO, p)),
    readJson: (p) => { try { return JSON.parse(readFileSync(path.join(REPO, p), 'utf8')); } catch { return null; } },
    readLog: (run) => { try { return readFileSync(path.join(out, `evolve-${run}.log`), 'utf8'); } catch { return ''; } },
    live: (run) => { const p = pidOf(run, out); return p !== null && alive(p); },
    launch: (stage, cmd) => {
      const r = spawnSync(cmd[0], cmd.slice(1), { cwd: REPO, encoding: 'utf8' });
      appendFileSync(path.join(out, `chain-${o.name}.log`), (r.stdout ?? '') + (r.stderr ?? ''));
      if (r.status !== 0) return null;
      return pidOf(cmd[cmd.indexOf('--name') + 1], out);
    },
    wait: async (run, stage) => {
      while (true) {
        const p = pidOf(run, out);
        if (p === null || !alive(p)) return;
        await sleep(5000);
      }
    },
    buildCurated: (cmd) => {
      const r = spawnSync(cmd[0], cmd.slice(1), { cwd: REPO, encoding: 'utf8' });
      appendFileSync(path.join(out, `chain-${o.name}.log`), (r.stdout ?? '') + (r.stderr ?? ''));
      return { status: r.status };
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (!o.name || (!o.continue && (!o.cup || !o.csv))) {
    console.error('usage: chain.sh --name N --cup C <csv> [--meta-generations G] [--generations G] [--candidates N] [--opponents N] [--threads N] [--cpu-only] [--dry-run] [-- extra]');
    process.exit(2);
  }
  process.chdir(REPO);
  mkdirSync('out', { recursive: true });
  if (o.continue && !o.csv) {
    const s = readState(o.name);
    if (!s) { console.error(`no chain state out/chain-${o.name}.json`); process.exit(2); }
    o.csv = s.csv; o.cup = s.cup;
    Object.assign(o, s.opts ?? {}); // original sizes/flags, not defaults
  }
  const { commands } = stageCommands(o);
  if (o.dryRun) {
    commands.forEach((c, i) => console.log(`stage ${i + 1}: ${c.join(' ')}`));
    process.exit(0);
  }
  if (!o.detached) {
    // validate both sim.sh commands before detaching (typos fail here, not in a log)
    for (const i of o.continue ? [] : [0, 2]) {
      const r = spawnSync(commands[i][0], [...commands[i].slice(1), '--dry-run'], { cwd: REPO, encoding: 'utf8' });
      if (r.status !== 0) { const t = ((r.stderr || '') + (r.stdout || '')).trim().split('\n'); console.error(t.filter((l) => /^(error|fix):/.test(l)).join('\n') || t.slice(-3).join('\n')); process.exit(1); }
    }
    const logFile = `out/chain-${o.name}.log`;
    const first = `${et()} [chain ${o.name}] launching (cup ${o.cup}, csv ${o.csv}, meta ${o.name}-meta -> ${o.name}-std)`;
    if (!o.continue) writeFileSync(logFile, first + '\n');
    else appendFileSync(logFile, first.replace('launching', 'continuing') + '\n');
    const args = [fileURLToPath(import.meta.url), ...process.argv.slice(2), '--run-detached'];
    const fd = (await import('node:fs')).openSync(logFile, 'a');
    const child = spawn('node', args, { cwd: REPO, detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    writeFileSync(`out/chain-${o.name}.pid`, String(child.pid));
    console.log(first);
    console.log(`[chain] pid ${child.pid}; meta run ${o.name}-meta, standard run ${o.name}-std; state out/chain-${o.name}.json; log ${logFile}`);
    process.exit(0);
  }
  const ok = await runChain(o, realDeps(o));
  process.exit(ok ? 0 : 1);
}
