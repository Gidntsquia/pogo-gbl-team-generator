// src/engine/gpuTail.js through the GPU executor (round 9 study, POGO_GPU_STUDY=tail): a launch's finished pool rows answer
// exactly the next call's specs with the same results a plain launch gives, and leave that call's GPU launch. Stub sidecar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initEngine } from '../src/engine/harness.js';

process.env.POGO_GPU_STUDY = 'tail';
const { createGpuExecutor } = await import('../src/engine/gpuExecutor.js');

const IVS = { atk: 0, def: 15, hp: 15 };
const team = (ids) => ids.map((speciesId) => ({ speciesId, ivs: IVS }));
const A = team(['azumarill', 'registeel', 'altaria']), B = team(['magikarp', 'sunkern', 'feebas']);
const spec = (leadA, leadB) => ({ teamA: A, teamB: B, leadA, leadB });
const keyFor = (s) => `${s.leadA}:${s.leadB}`;
// a row's winner is a function of its packed lead mons, so a result served for the wrong spec would differ
const row = (out, k, idx, i) => { out[k * 24] = (idx[i * 6] + 2 * idx[i * 6 + 3]) % 3; out[k * 24 + 18] = -1; out[k * 24 + 19] = -1; };

test('pool rows finished in one launch are served to the next call, which launches only the rest', async () => {
  const ctx = await initEngine();
  const cpu = { run: async (specs) => specs.map(() => ({ ok: true, value: { winner: 'cpu' } })), stats: async () => [], close: async () => [] };
  const sent = [];
  const sidecar = {
    setStatic: async () => {},
    batch3: async ({ seeds, idx }) => { sent.push(seeds.length); const out = new Int32Array(seeds.length * 24); for (let i = 0; i < seeds.length; i++) row(out, i, idx, i); return { out, cols: 24, kernelUs: 1, pieces: 1 }; },
    tailStart: async (body) => {
      const m = new Int32Array(body.buffer, body.byteOffset, 8), [n, nP] = m;
      const idx = new Int32Array(body.buffer, body.byteOffset + 32, (n + nP) * 6);
      sent.push(n);
      const w = new Int32Array(16 + nP + (n + nP) * 24);
      w[0] = n; w[1] = nP; w[2] = nP; w[3] = nP - 1; w[4] = 1;
      for (let p = 0; p < nP; p++) w[16 + p] = p === 0 ? 0 : 1; // pool battle 0 was discarded (still running at the end)
      for (let k = 0; k < n + nP; k++) { const o = new Int32Array(24); row(o, 0, idx, k); w.set(o, 16 + nP + k * 24); }
      return { tag: 1, done: Promise.resolve({ words: w, kernelUs: 1 }) };
    },
  };
  const logs = [];
  const ex = await createGpuExecutor({ ctx, cpuExecutor: cpu, cpuShare: 0, sidecar, log: (l) => logs.push(l) });
  const plain = await createGpuExecutor({ ctx, cpuExecutor: cpu, cpuShare: 0, sidecar });
  const main = [spec(0, 0), spec(0, 1)], next = [spec(0, 2), spec(1, 0), spec(2, 2)];
  const pool = [spec(0, 2), spec(1, 0), spec(1, 1)]; // spec(1,1) is speculated but not asked for; spec(0,2) is the discarded one
  ex.speculate({ main: main.map((s, t) => ({ key: keyFor(s), team: t, seat: 0 })), pool: pool.map((s) => ({ key: keyFor(s), spec: s, team: 0 })),
    priorPts: new Float32Array(2), priorN: new Float32Array(2), keep: 0.5, keepK: 1, keyFor });
  const r0 = await ex.run(main);
  sent.length = 0;
  const r1 = await ex.run(next);
  assert.deepEqual(sent, [2]); // spec(1,0) came from the pool; spec(0,2) (discarded) and spec(2,2) launched
  const p0 = await plain.run(main), p1 = await plain.run(next);
  assert.deepEqual(r0.map((s) => s.value), p0.map((s) => s.value));
  assert.deepEqual(r1.map((s) => s.value), p1.map((s) => s.value));
  assert.ok(logs.some((l) => /gpu tail -- pool 3, speculated 3 \(0 certain\), kept 2, discarded 1/.test(l)), logs.join('\n'));
  assert.ok(logs.some((l) => /served 1 from the previous launch/.test(l)), logs.join('\n'));
});
