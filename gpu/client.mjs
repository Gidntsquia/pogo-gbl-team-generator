// Node-side client for gpu/sidecar.py (JSON lines over stdin/stdout). Not imported by src/.
//   node gpu/client.mjs [--data ../out/gpu] [--count 1000] [--op 3v3|1v1]
// Spawns the sidecar via uv, does a ping and one batch round trip, prints the latency, then quits it.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const dir = path.dirname(fileURLToPath(import.meta.url));
const child = spawn('uv', ['run', 'python', '-m', 'gpu.sidecar'], { cwd: dir, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } });
const rl = createInterface({ input: child.stdout });
const waiting = [];
rl.on('line', (l) => waiting.shift()?.(JSON.parse(l)));
child.on('exit', (code) => { if (waiting.length) { console.error(`sidecar exited (${code}) before answering`); process.exit(1); } });
const ready = new Promise((res) => waiting.push(res));
const call = (req) => new Promise((res) => { waiting.push(res); child.stdin.write(JSON.stringify(req) + '\n'); });

const first = await Promise.race([ready, new Promise((r) => child.on('exit', () => r(null)))]);
if (!first) { process.exit(1); }
const t0 = performance.now();
await call({ op: 'ping' });
const pingMs = performance.now() - t0;
const op = opt('op', '3v3');
const count = Number(opt('count', 1000));
const t1 = performance.now();
const r = await call({ op, real: 'float', data: opt('data', '../out/gpu'), start: 0, count });
const rtMs = performance.now() - t1;
if (!r.ok) { console.error(r.error); child.stdin.end(); process.exit(1); }
console.log(`sidecar ping ${pingMs.toFixed(1)} ms; ${op} x${r.n}: round trip ${rtMs.toFixed(0)} ms (kernel side ${r.ms.toFixed(0)} ms, JSON/pipe overhead ${(rtMs - r.ms).toFixed(0)} ms)`);
child.stdin.write(JSON.stringify({ op: 'quit' }) + '\n');
child.stdin.end();
setTimeout(() => process.exit(0), 200);
