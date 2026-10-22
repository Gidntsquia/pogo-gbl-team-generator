// Compare GPU vs CPU on the first N slice specs: winner, survivor HP, and lead-faint turns (the snowball inputs).
//   node gpu/lead-faint-check.mjs [specs.json] [N]
import { readFileSync } from 'node:fs';
import { createExecutor } from '../src/engine/parallel.js';
import { initEngine } from '../src/engine/harness.js';
import { createGpuExecutor } from '../src/engine/gpuExecutor.js';

const specsPath = process.argv[2] ?? 'out/gpu/slice-specs.json', N = Number(process.argv[3] ?? 2000);
const specs = JSON.parse(readFileSync(specsPath, 'utf8')).battles.slice(0, N).map((b) => ({ teamA: b.teamA, teamB: b.teamB, leadA: b.leadA, leadB: b.leadB }));
const ctx = await initEngine();
const cpu = createExecutor({ threads: 8, continueOnError: true });
const gx = await createGpuExecutor({ ctx, cpuExecutor: createExecutor({ threads: 1, continueOnError: true }), cpuShare: 0, log: console.log });
const [c, g] = [await cpu.run(specs), await gx.run(specs)];
const cnt = { win: 0, hpTotal: 0, perMon: 0, lfA: 0, lfB: 0, exchange: 0 };
const ex = (s) => (s.leadFaintTurnA === null && s.leadFaintTurnB === null ? 'none' : s.leadFaintTurnA === null ? 'b' : s.leadFaintTurnB === null ? 'a' : s.leadFaintTurnA === s.leadFaintTurnB ? 'sim' : s.leadFaintTurnA < s.leadFaintTurnB ? 'a' : 'b');
c.forEach((r, i) => {
  const a = r.value, b = g[i].value;
  if (a.winner !== b.winner) cnt.win++;
  if (a.survivorsHp.a !== b.survivorsHp.a || a.survivorsHp.b !== b.survivorsHp.b) cnt.hpTotal++;
  if (a.summary.leadFaintTurnA !== b.summary.leadFaintTurnA) cnt.lfA++;
  if (a.summary.leadFaintTurnB !== b.summary.leadFaintTurnB) cnt.lfB++;
  if (ex(a.summary) !== ex(b.summary)) cnt.exchange++;
});
console.log(`N=${N} mismatches:`, cnt);
await cpu.close(); await gx.close(); process.exit(0);
