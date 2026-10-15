import test from 'node:test';
import assert from 'node:assert/strict';
import { isCpuIndex, rowToResult, createGpuExecutor } from '../src/engine/gpuExecutor.js';
import { initEngine } from '../src/engine/harness.js';

const IVS = { atk: 0, def: 15, hp: 15 };
const team = (ids) => ids.map((speciesId) => ({ speciesId, ivs: IVS }));
const spec = (i) => ({ teamA: team(['azumarill', 'registeel', 'altaria']), teamB: team(['magikarp', 'sunkern', 'feebas']), leadA: i % 3, leadB: 0 });

test('cpu share split is a fixed function of index and share', () => {
  const idx = (n, s) => Array.from({ length: n }, (_, i) => i).filter((i) => isCpuIndex(i, s));
  assert.equal(idx(1000, 0.015).length, 15);
  assert.deepEqual(idx(1000, 0.015), idx(1000, 0.015));
  assert.equal(idx(50, 0).length, 0);
  assert.equal(idx(50, 1).length, 50);
});

test('kernel row maps to the memo result shape (lead faint -1 -> null)', () => {
  const out = new Int32Array(24);
  out.set([1, 0, 2, 0, 0, 0, 50, 60, 70], 0);
  out[15] = 0; out[16] = 180; out[18] = 77; out[19] = -1;
  assert.deepEqual(rowToResult(out, 0), {
    winner: 'b', survivorsHp: { a: 0, b: 180, aPerMon: [0, 0, 0], bPerMon: [50, 60, 70] }, summary: { leadFaintTurnA: 77, leadFaintTurnB: null },
  });
});

test('run splits GPU/CPU deterministically, re-runs flagged rows on CPU, fails with a gpu: error', async () => {
  const ctx = await initEngine();
  const cpuCalls = [];
  const cpu = { run: async (specs) => { cpuCalls.push(specs.length); return specs.map(() => ({ ok: true, value: { winner: 'cpu' } })); }, stats: async () => [], close: async () => [] };
  let sent = 0;
  const sidecar = {
    setStatic: async () => {},
    batch3: async ({ seeds }) => {
      const n = seeds.length; sent += n;
      const out = new Int32Array(n * 24);
      for (let i = 0; i < n; i++) out[i * 24 + 10] = i === 3 ? 0x20 : 0; // row 3 flagged invalid
      return { out, cols: 24, kernelUs: 1, pieces: 1 };
    },
  };
  const ex = await createGpuExecutor({ ctx, cpuExecutor: cpu, cpuShare: 0.1, sidecar });
  const slots = await ex.run(Array.from({ length: 40 }, (_, i) => spec(i)));
  assert.equal(slots.length, 40);
  assert.equal(sent, 36); // 4 of 40 to CPU by share
  assert.deepEqual(cpuCalls, [4, 1]); // share run, then the one flagged row
  assert.equal(slots.filter((s) => s.value.winner === 'cpu').length, 5);
  const bad = await createGpuExecutor({ ctx, cpuExecutor: cpu, cpuShare: 0, sidecar: { setStatic: async () => {}, batch3: async () => { throw new Error('sidecar exited (1)'); } } });
  await assert.rejects(bad.run([spec(0)]), (e) => e.message === 'gpu: sidecar exited (1)' && e.gpuFatal === true);
});
