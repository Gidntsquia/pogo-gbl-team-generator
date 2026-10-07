// Detached soft-stop watcher: waits for the next checkpoint of a run, then SIGTERMs it.
// Usage: node mcp/soft-stop.mjs <name> [pollSeconds=10]
// Checkpoints are written atomically, so a SIGTERM right after one loses nothing.

import { existsSync, readdirSync, readFileSync, appendFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { REPO, latestGen, softStopDecision, processTree } from './lib.mjs';

const name = process.argv[2];
const pollMs = Math.max(1, Number(process.argv[3] ?? 10)) * 1000;
if (!name) { console.error('usage: soft-stop.mjs <name> [pollSeconds]'); process.exit(2); }

const out = path.join(REPO, 'out');
const dir = path.join(out, `evolve-${name}`);
const runPid = Number(readFileSync(path.join(out, `evolve-${name}.pid`), 'utf8'));
const stopPid = path.join(out, `evolve-${name}.stop.pid`);
const logFile = path.join(out, `evolve-${name}.stop.log`);
const log = (m) => appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`);
const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
const gen = () => latestGen(existsSync(dir) ? readdirSync(dir) : []);

writeFileSync(stopPid, String(process.pid));
const startGen = gen();
log(`watching pid ${runPid}; checkpoint gen ${startGen} at start, waiting for gen ${startGen + 1} (or DONE)`);

for (;;) {
  const d = softStopDecision({
    startGen, currentGen: gen(), done: existsSync(path.join(dir, 'evolve-DONE')), pidAlive: alive(runPid),
  });
  if (d === 'exit') { log('run already finished or gone; nothing to stop'); break; }
  if (d === 'kill') {
    const { pids } = processTree(execFileSync('ps', ['-eo', 'pid,ppid,rss'], { encoding: 'utf8' }), runPid);
    log(`checkpoint gen ${gen()} reached; SIGTERM ${pids.join(',')}`);
    for (const p of pids) { try { process.kill(p, 'SIGTERM'); } catch { /* gone */ } }
    break;
  }
  await new Promise((r) => setTimeout(r, pollMs));
}
rmSync(stopPid, { force: true });
