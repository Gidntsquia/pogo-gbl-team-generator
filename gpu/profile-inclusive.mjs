// Inclusive share of the inner-sim call path in the worker cpuprofiles.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
const dir = process.argv[2] ?? 'out/evolve-gpu-profile';
let total = 0, inner = 0, memoWrap = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith('.cpuprofile'))) {
  const p = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const name = (id) => byId.get(id).callFrame.functionName;
  p.samples.forEach((id, i) => {
    const dt = p.timeDeltas[i];
    total += dt;
    for (let x = id; x !== undefined; x = parent.get(x)) {
      if (name(x) === 'MemoBattle.b.simulate' || name(x) === 'b.simulate') { inner += dt; break; }
    }
  });
}
console.log(`inner-sim inclusive ${(100 * inner / total).toFixed(1)}% of ${(total / 1e6).toFixed(0)} s`);
