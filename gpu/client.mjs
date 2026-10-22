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
/** The sidecar could not start (no NVIDIA device, cupy or uv missing, died while booting): the run may fall back to the CPU. */
export class GpuStartError extends Error {}
export const OP = { PING: 1, STATIC: 2, BATCH3: 3, BATCH1: 4, FILE: 5, STREAMS: 6, BATCH3T: 7, ISLAND: 8, QUIT: 9, TAIL: 10, PEEK: 11, FEED: 12 };
const TAGGED_OK = 16, TAGGED_ERR = 17;
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

/**
 * ISLAND request body (plans round 7 R7; layout = gpu/gpu/island.py parse). `teams`: nC candidate teams then nO opponent teams,
 * each [mon descriptors] already ordered lead-first. Battle id = (c * nO + o) * 2 + seat (seat 0: candidate is team A).
 * @param {{teams: object[][], nC: number, nO: number, rounds: number, keep: number, seeds: Uint32Array, canon: Int32Array,
 *   known: Int32Array, order: number[], sizes: number[], islStart: number[], members: number[]}} job
 * @returns {Uint8Array}
 */
export function packIsland(job) {
  const { teams, nC, nO, rounds, keep, seeds, canon, known, order, sizes, islStart, members } = job;
  const nT = nC + nO, nB = nC * nO * 2, nIsl = islStart.length - 1;
  const pad = (nT * 3) % 2 ? 4 : 0;
  const bytes = 32 + nT * 12 + pad + nT * 3 * D_N * 8 + nB * 12 + (nO + rounds + nIsl + 1 + nC) * 4;
  const buf = new ArrayBuffer(bytes);
  let off = 0;
  const i32 = (n) => { const a = new Int32Array(buf, off, n); off += n * 4; return a; };
  const meta = i32(8);
  meta.set([nC, nO, rounds, nIsl, Math.round(keep * 1e6)]);
  const tIdx = i32(nT * 3);
  off += pad;
  const tDyn = new Float64Array(buf, off, nT * 3 * D_N); off += nT * 3 * D_N * 8;
  teams.forEach((team, t) => team.forEach((d, k) => { tIdx[t * 3 + k] = d.mon; dynRow(d, tDyn, (t * 3 + k) * D_N); }));
  new Uint32Array(buf, off, nB).set(seeds); off += nB * 4;
  i32(nB).set(canon);
  i32(nB).set(known);
  i32(nO).set(order);
  i32(rounds).set(sizes);
  i32(nIsl + 1).set(islStart);
  i32(nC).set(members);
  if (off !== bytes) throw new Error(`packIsland: wrote ${off} of ${bytes} bytes`);
  return new Uint8Array(buf);
}

/**
 * TAIL request body (EXPERIMENTAL, round 9 study POGO_GPU_STUDY=tail; layout = gpu/gpu/study/tail/variant.py parse): this round's
 * battles plus the next round's pool, both as packBattles output.
 * @param {{main: {idx: Int32Array, dyn: Float64Array, seeds: Uint32Array}, pool: {idx: Int32Array, dyn: Float64Array, seeds: Uint32Array},
 *   mainTag: Int32Array, poolTeam: Int32Array, priorPts: Float32Array, priorN: Float32Array, keepK: number, spec: boolean, certain: boolean}} job
 * @returns {Uint8Array}
 */
export function packTail(job) {
  const { main, pool, mainTag, poolTeam, priorPts, priorN, keepK } = job;
  const n = main.seeds.length, nP = pool.seeds.length, nT = priorPts.length;
  let ints = 8 + n * 6 + nP * 6 + n + nP + n + nP + nT + nT;
  const pad = ints % 2 ? 4 : 0;
  const bytes = ints * 4 + pad + (n + nP) * 6 * D_N * 8;
  const buf = new ArrayBuffer(bytes);
  let off = 0;
  const put = (Ctor, src, cnt) => { const a = new Ctor(buf, off, cnt); a.set(src); off += cnt * Ctor.BYTES_PER_ELEMENT; };
  put(Int32Array, [n, nP, nT, keepK, (job.spec === false ? 0 : 1) | (job.certain ? 2 : 0), 0, 0, 0], 8);
  put(Int32Array, main.idx, n * 6); put(Int32Array, pool.idx, nP * 6);
  put(Int32Array, mainTag, n); put(Int32Array, poolTeam, nP);
  put(Uint32Array, main.seeds, n); put(Uint32Array, pool.seeds, nP);
  put(Float32Array, priorPts, nT); put(Float32Array, priorN, nT);
  off += pad;
  put(Float64Array, main.dyn, n * 6 * D_N); put(Float64Array, pool.dyn, nP * 6 * D_N);
  if (off !== bytes) throw new Error(`packTail: wrote ${off} of ${bytes} bytes`);
  return new Uint8Array(buf);
}

export class GpuSidecar {
  /** Spawn `python -m gpu.sidecar --binary` via uv and wait for its ready frame. Rejects if the sidecar exits first (e.g. no CUDA device). */
  static async start({ streams = 1 } = {}) {
    const child = spawn('uv', ['run', 'python', '-m', 'gpu.sidecar', '--binary'], { cwd: here, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } });
    const c = new GpuSidecar(child);
    c.#booting = true;
    // the sidecar's own one-line `gpu: <reason>` is held back while it boots, so a CPU fallback prints one line, not two
    createInterface({ input: child.stderr }).on('line', (l) => { if (c.#booting && l.startsWith('gpu:')) c.#reason = l.replace(/^gpu:\s*/, ''); else process.stderr.write(l + '\n'); });
    child.on('error', (e) => { c.#reason ??= e.code === 'ENOENT' ? 'uv not found' : `sidecar did not start (${e.message})`; c.#dead = new GpuStartError(c.#reason); c.#waiters.splice(0).forEach((w) => w.reject(c.#dead)); });
    try { await c.#frame(); } catch (e) { throw e instanceof GpuStartError ? e : new GpuStartError(c.#reason ?? e.message); } finally { c.#booting = false; }
    if (streams > 1) await c.#call(header(OP.STREAMS, 0, streams));
    return c;
  }
  #booting = false; #reason = null; #child; #buf = Buffer.alloc(0); #waiters = []; #tagged = new Map(); #nextTag = 1; #dead = null; #chain = Promise.resolve();
  constructor(child) {
    this.#child = child;
    child.stdout.on('data', (d) => { this.#buf = Buffer.concat([this.#buf, d]); this.#pump(); });
    child.on('exit', (code) => { this.#dead = this.#booting ? new GpuStartError(this.#reason ?? `sidecar exited (${code}) before it was ready`) : new Error(`sidecar exited (${code})`); this.#waiters.splice(0).forEach((w) => w.reject(this.#dead)); for (const w of this.#tagged.values()) w.reject(this.#dead); this.#tagged.clear(); });
  }
  #pump() {
    while (this.#waiters.length || this.#tagged.size) {
      if (this.#buf.length < HDR) return;
      const [magic, op, n, arg, a, b] = [0, 1, 2, 3, 4, 5].map((i) => this.#buf.readUInt32LE(i * 4));
      if (magic !== MAGIC) { (this.#waiters.shift() ?? this.#tagged.values().next().value)?.reject(new Error('bad frame magic')); return; }
      const len = op === 1 || op === TAGGED_ERR ? n : n * a * 4;
      if (this.#buf.length < HDR + len) return;
      const payload = this.#buf.subarray(HDR, HDR + len);
      this.#buf = this.#buf.subarray(HDR + len);
      if (op === TAGGED_OK || op === TAGGED_ERR) { // reply to a tagged BATCH3T, any order: b = tag
        const w = this.#tagged.get(b);
        this.#tagged.delete(b);
        if (op === TAGGED_ERR) w?.reject(new Error(`sidecar: ${payload.toString()}`));
        else w?.resolve({ status: 0, n, kernelUs: arg, cols: a, pieces: 1, payload });
        continue;
      }
      this.#waiters.shift()?.resolve({ status: op, n, kernelUs: arg, cols: a, pieces: b, payload });
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
  /**
   * Tagged, asynchronous 3v3 batch (round 6, R2): written at once, not queued behind earlier calls, so several launches are in
   * flight on the sidecar's CUDA streams together. Resolves like batch3 when this batch's launch ends (pieces = 1).
   */
  async batch3Async({ idx, dyn, seeds }, { real = 'float' } = {}) {
    if (this.#dead) throw this.#dead;
    const n = seeds.length, tag = this.#nextTag++;
    const body = [idx, dyn, seeds].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength));
    const p = new Promise((resolve, reject) => this.#tagged.set(tag, { resolve, reject }));
    await this.#chain.catch(() => {}); // after any untagged call already written (its reply stays FIFO)
    this.#child.stdin.write(Buffer.concat([header(OP.BATCH3T, n, real === 'double' ? 1 : 0, tag), ...body]));
    const r = await p;
    return { out: new Int32Array(r.payload.buffer.slice(r.payload.byteOffset, r.payload.byteOffset + r.payload.length)), cols: r.cols, kernelUs: r.kernelUs, pieces: 1 };
  }
  /**
   * Island halving job (plans round 7 R7; body layout in gpu/gpu/island.py parse) -> {words: Int32Array, kernelUs, rows}.
   * words = info[4] (G, span us, rows run, tasks) | status[nB] | icut[nC] | run rows (B_OUT cols each, battle-id order).
   */
  async island(body, { real = 'float' } = {}) {
    const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    const r = await this.#call(header(OP.ISLAND, buf.length, real === 'double' ? 1 : 0), buf);
    return { words: new Int32Array(r.payload.buffer.slice(r.payload.byteOffset, r.payload.byteOffset + r.payload.length)), kernelUs: r.kernelUs, rows: r.pieces };
  }
  /**
   * EXPERIMENTAL (round 9 study, POGO_GPU_STUDY=tail): start one TAIL launch (packTail body). Returns {tag, done} at once; `done`
   * resolves to {words: Int32Array, kernelUs} when the launch ends (words = info[16] | pool done[nPool] | rows). While it runs,
   * peek(tag) / feed(tag, idx) talk to it.
   */
  async tailStart(body, { real = 'float' } = {}) {
    if (this.#dead) throw this.#dead;
    const tag = this.#nextTag++;
    const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    const p = new Promise((resolve, reject) => this.#tagged.set(tag, { resolve, reject }));
    await this.#chain.catch(() => {});
    this.#child.stdin.write(Buffer.concat([header(OP.TAIL, buf.length, real === 'double' ? 1 : 0, tag), buf]));
    const done = p.then((r) => ({ words: new Int32Array(r.payload.buffer.slice(r.payload.byteOffset, r.payload.byteOffset + r.payload.length)), kernelUs: r.kernelUs }));
    return { tag, done };
  }
  /** Main rows finished so far in TAIL launch `tag` -> Int32Array(n*4): winner, leadFaintA, leadFaintB, done (0/1). */
  async peek(tag) {
    const r = await this.#call(header(OP.PEEK, 0, 0, tag));
    return new Int32Array(r.payload.buffer.slice(r.payload.byteOffset, r.payload.byteOffset + r.payload.length));
  }
  /** Append pool indices to TAIL launch `tag`'s certain queue -> count fed. */
  async feed(tag, poolIdx) {
    const a = Int32Array.from(poolIdx);
    const r = await this.#call(header(OP.FEED, a.length, 0, tag), Buffer.from(a.buffer));
    return r.n;
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
  const child = spawn('uv', ['run', 'python', '-m', 'gpu.sidecar'], { cwd: here, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } });
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
