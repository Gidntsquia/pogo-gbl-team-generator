// pogo-sim: the sim lifecycle tools (launch, status, log, stop, resume). Never fights battles; every
// run is launched detached so killing this server never kills a sim. Everything else: server-extra.mjs.
import {
  z, execFileSync, spawn, existsSync, readFileSync, writeFileSync, statSync, path, OUT, REPO, makeServer, flags, alive, pidOf, isLive,
  dirOf, logOf, gens, readLog, runNames, runState, reply, fail, sh, resolveName, safeName, waitFirstLine, writeLaunch,
  launchDetached, guardLaunch, ensureReport, commonShape, launchViaSim, latestGen, buildStatus, processTree, configToArgv,
} from './common.mjs';

const { tool, start } = makeServer('pogo-sim');

tool('run_standard', 'Launch a detached standard evolve run (sim.sh recipe).',
  { csv: z.string(), ...commonShape }, (a) => launchViaSim(a, 'standard'));
tool('run_meta', 'Launch a detached meta-vs-meta evolve run.',
  { ...commonShape, meta_pool: z.number().optional() },
  (a) => launchViaSim(a, 'meta'));

function latestCheckpoint(n) {
  const g = latestGen(gens(n));
  if (g < 0) return null;
  return JSON.parse(readFileSync(path.join(dirOf(n), `evolve-gen${g}.json`), 'utf8'));
}

tool('status_sim', 'Status of a run: top teams, speed, ETA, memory; report path when DONE.',
  { name: z.string().optional(), top: z.number().optional() },
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
    let reportLine = '';
    if (runState(n) === 'DONE') { const r = await ensureReport(n); reportLine = r.html ? `\nreport: ${r.html}` : ''; }
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
    const out = reply(lines.join('\n'), { state, softStopPending: !!pending, logLine: lastLine, ...s });
    out.content[0].text += reportLine; // the report path is the last line of a DONE run's text
    return out;
  });

tool('list_runs', 'List runs with state and last log line.', {}, async () => {
  const rows = runNames().map((n) => ({
    name: n, state: runState(n), checkpointGen: latestGen(gens(n)), lastLog: readLog(n).trim().split('\n').at(-1) ?? '',
  }));
  return reply(rows.map((r) => `${r.name}: ${r.state}, gen ${r.checkpointGen}\n  ${r.lastLog.slice(0, 140)}`).join('\n') || 'no runs', rows);
});

tool('tail_log', 'Tail a run log.', { name: z.string(), lines: z.number().optional() }, async (a) => {
  const t = readLog(safeName(a.name)).trimEnd().split('\n').slice(-(a.lines ?? 30)).join('\n');
  return reply(t || '(empty log)');
});

// ---- stop / resume ----
tool('stop_sim', 'Stop a run, after the next generation or hard (needs confirm).',
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

tool('cancel_stop', 'Cancel a pending soft stop.', { name: z.string().optional() }, async (a) => {
  const n = resolveName(a.name);
  const p = (() => { try { return Number(readFileSync(path.join(OUT, `evolve-${n}.stop.pid`), 'utf8')); } catch { return null; } })();
  if (!p || !alive(p)) return reply('no pending soft stop');
  process.kill(p, 'SIGTERM');
  return reply(`watcher ${p} killed`);
});

tool('resume_sim', 'Resume a stopped run from its checkpoint config.',
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

tool('check_oom', 'Find earlyoom kills of a run.', { name: z.string() }, async (a) => {
  const n = safeName(a.name);
  const r = await sh('bash', ['-c', `journalctl -u earlyoom --no-pager 2>/dev/null | grep -i "evolve.*${n}\\|sending SIGTERM" | tail -5`]);
  return reply(r.out || `no earlyoom entries found for '${n}' (journal may be unavailable)`);
});

await start();
