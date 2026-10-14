// Node-side client for gpu/sidecar.py. Not imported by src/.
//   node gpu/client.mjs [--data ../out/gpu] [--count 1000] [--op 3v3|1v1] [--transport binary|json]
// Library use: `const c = await GpuSidecar.start(); await c.setStatic(monsJson); const {out, cols} = await c.batch3(idx, dyn, seeds)`.
// Binary transport: 24-byte LE header + raw LE arrays (layout in gpu/gpu/wire.py), thousands of battles per message.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

const MAGIC = 0x31504247, HDR = 24, D_N = 17;
export const OP = { PING: 1, STATIC: 2, BATCH3: 3, BATCH1: 4, FILE: 5, STREAMS: 6, QUIT: 9 };
const here = path.dirname(fileURLToPath(import.meta.url));
const header = (op, n = 0, arg = 0, a = 0, b = 0) => { const h = Buffer.alloc(HDR); [MAGIC, op, n, arg, a, b].forEach((v, i) => h.writeUInt32LE(v >>> 0, i * 4)); return h; };

/** dyn row for one mon, same order as gpu/gpu/pack.py pack_dyn (D_N = 17 doubles). */
export function dynRow(e, out, o) {
  out[o] = e.startHp; out[o + 1] = e.startEnergy; out[o + 2] = e.startCooldown; out[o + 3] = e.startingShields;
  out[o + 4] = e.startStatBuffs[0]; out[o + 5] = e.startStatBuffs[1];
  out[o + 6] = e.nativeStatBuffs[0]; out[o + 7] = e.nativeStatBuffs[1];
  out[o + 8] = Number(e.priority); out[o + 9] = e.turnsToKO; out[o + 10] = Number(e.baitShields);
  out[o + 11] = Number(e.farmEnergy); out[o + 12] = Number(e.optimizeMoveTiming);
  out[o + 15] = e.startForm ?? 0; out[o + 16] = e.origForm ?? 0;
}

/**
 * Pack 3v3 battles ({teamA, teamB, leadA, leadB, seed}, mons as describeMon rows) into the BATCH3 payload arrays.
 * Each team is ordered lead-first (battleTeams does the same). Returns {idx: Int32Array(n*6), dyn: Float64Array(n*6*17), seeds: Uint32Array(n)}.
 */
export function packBattles(battles) {
  const n = battles.length;
  const idx = new Int32Array(n * 6), dyn = new Float64Array(n * 6 * D_N), seeds = new Uint32Array(n);
  battles.forEach((b, i) => {
    [[0, b.teamA, b.leadA], [1, b.teamB, b.leadB]].forEach(([side, team, lead]) => {
      const order = [lead, ...[0, 1, 2].filter((j) => j !== lead)];
      order.forEach((j, k) => { idx[i * 6 + side * 3 + k] = team[j].mon; dynRow(team[j], dyn, (i * 6 + side * 3 + k) * D_N); });
    });
    seeds[i] = b.seed >>> 0;
  });
  return { idx, dyn, seeds };
}

export class GpuSidecar {
  /** Spawn `python -m gpu.sidecar --binary` via uv and wait for its ready frame. Rejects if the sidecar exits first (e.g. no CUDA device). */
  static async start({ streams = 1 } = {}) {
    const child = spawn('uv', ['run', 'python', '-m', 'gpu.sidecar', '--binary'], { cwd: here, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } });
    const c = new GpuSidecar(child);
    c.#booting = true;
    await c.#frame();
    c.#booting = false;
    if (streams > 1) await c.#call(header(OP.STREAMS, 0, streams));
    return c;
  }
  #booting = false; #child; #buf = Buffer.alloc(0); #waiters = []; #dead = null; #chain = Promise.resolve();
  constructor(child) {
    this.#child = child;
    child.stdout.on('data', (d) => { this.#buf = Buffer.concat([this.#buf, d]); this.#pump(); });
    child.on('exit', (code) => { if (this.#booting) process.exit(1); /* sidecar already printed its one-line reason (no CUDA device, cupy missing) */ this.#dead = new Error(`sidecar exited (${code})`); this.#waiters.splice(0).forEach((w) => w.reject(this.#dead)); });
  }
  #pump() {
    while (this.#waiters.length) {
      if (this.#buf.length < HDR) return;
      const [magic, op, n, arg, a, b] = [0, 1, 2, 3, 4, 5].map((i) => this.#buf.readUInt32LE(i * 4));
      if (magic !== MAGIC) { this.#waiters.shift().reject(new Error('bad frame magic')); return; }
      const len = op === 1 ? n : n * a * 4;
      if (this.#buf.length < HDR + len) return;
      const payload = this.#buf.subarray(HDR, HDR + len);
      this.#buf = this.#buf.subarray(HDR + len);
      this.#waiters.shift().resolve({ status: op, n, kernelUs: arg, cols: a, pieces: b, payload });
    }
  }
  #frame() { return new Promise((resolve, reject) => { if (this.#dead) return reject(this.#dead); this.#waiters.push({ resolve, reject }); this.#pump(); }); }
  #call(...bufs) {
    const run = async () => { this.#child.stdin.write(Buffer.concat(bufs)); const r = await this.#frame(); if (r.status) throw new Error(`sidecar: ${r.payload.toString()}`); return r; };
    return (this.#chain = this.#chain.then(run, run));
  }
  async ping() { await this.#call(header(OP.PING)); }
  /** Send the static mon table once (rows of mons.json / describe.mjs monTable). */
  async setStatic(mons) { const j = Buffer.from(JSON.stringify(mons)); return this.#call(header(OP.STATIC, j.length), j); }
  /** One packed 3v3 batch -> {out: Int32Array(n*cols), cols, kernelUs, pieces}. */
  async batch3({ idx, dyn, seeds }, { real = 'float' } = {}) {
    const n = seeds.length;
    const body = [idx, dyn, seeds].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength));
    const r = await this.#call(header(OP.BATCH3, n, real === 'double' ? 1 : 0), ...body);
    return { out: new Int32Array(r.payload.buffer.slice(r.payload.byteOffset, r.payload.byteOffset + r.payload.length)), cols: r.cols, kernelUs: r.kernelUs, pieces: r.pieces };
  }
  /** One packed 1v1 batch: idx Int32Array(n*2), dyn Float64Array(n*2*17) -> {out: Int32Array(n*18), cols}. */
  async batch1({ idx, dyn }, { real = 'float' } = {}) {
    const n = idx.length / 2;
    const body = [idx, dyn].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength));
    const r = await this.#call(header(OP.BATCH1, n, real === 'double' ? 1 : 0), ...body);
    return { out: new Int32Array(r.payload.buffer.slice(r.payload.byteOffset, r.payload.byteOffset + r.payload.length)), cols: r.cols, kernelUs: r.kernelUs };
  }
  async close() { try { this.#child.stdin.write(header(OP.QUIT)); this.#child.stdin.end(); } catch { /* gone */ } setTimeout(() => this.#child.kill(), 500).unref(); }
}

/** JSON-lines fallback client: returns {call(req), close()}. */
export async function startJson() {
  const child = spawn('uv', ['run', 'python', '-m', 'gpu.sidecar'], { cwd: here, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } });
  const rl = createInterface({ input: child.stdout });
  const waiting = [];
  rl.on('line', (l) => waiting.shift()?.(JSON.parse(l)));
  let closing = false;
  child.on('exit', () => { if (!closing) process.exit(1); }); // the sidecar printed its one-line reason; a normal quit exits first via close()
  await new Promise((res) => waiting.push(res));
  return {
    call: (req) => new Promise((res) => { waiting.push(res); child.stdin.write(JSON.stringify(req) + '\n'); }),
    close() { closing = true; child.stdin.write(JSON.stringify({ op: 'quit' }) + '\n'); child.stdin.end(); setTimeout(() => child.kill(), 500).unref(); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  const dataDir = path.resolve(here, opt('data', '../out/gpu'));
  const count = Number(opt('count', 1000));
  const transport = opt('transport', 'binary');
  const battles = JSON.parse(readFileSync(path.join(dataDir, 'battles.json'), 'utf8')).slice(0, count);
  if (transport === 'json') {
    const c = await startJson();
    const t = performance.now();
    const r = await c.call({ op: '3v3', real: 'float', data: dataDir, start: 0, count });
    const ms = performance.now() - t;
    console.log(`json: 3v3 x${r.n} round trip ${ms.toFixed(0)} ms = ${(r.n / ms * 1000).toFixed(0)} b/s (kernel side ${r.ms.toFixed(0)} ms)`);
    c.close();
  } else {
    const mons = JSON.parse(readFileSync(path.join(dataDir, 'mons.json'), 'utf8'));
    const c = await GpuSidecar.start();
    const t0 = performance.now();
    await c.ping();
    const pingMs = performance.now() - t0;
    await c.setStatic(mons);
    const packed = packBattles(battles);
    const t = performance.now();
    const r = await c.batch3(packed);
    const ms = performance.now() - t;
    const n = packed.seeds.length;
    const wins = Array.from({ length: n }, (_, i) => r.out[i * r.cols]).filter((w) => w === 0).length;
    console.log(`${transport}: ping ${pingMs.toFixed(1)} ms; 3v3 x${n}: round trip ${ms.toFixed(0)} ms = ${(n / ms * 1000).toFixed(0)} b/s (kernel ${(r.kernelUs / 1000).toFixed(0)} ms, ${r.pieces} piece(s)); ${r.cols} cols/row, team-A wins ${wins}/${n}`);
    await c.close();
  }
  setTimeout(() => process.exit(0), 600);
}
