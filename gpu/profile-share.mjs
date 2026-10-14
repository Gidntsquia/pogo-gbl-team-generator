// Summarise worker cpuprofiles: self-time share per function group (how much a GPU could absorb).
// usage: node gpu/profile-share.mjs <profile dir>
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
const dir = process.argv[2] ?? 'out/evolve-gpu-profile';
const self = new Map();
let total = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith('.cpuprofile'))) {
  const p = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const dt = p.timeDeltas;
  p.samples.forEach((id, i) => {
    const n = byId.get(id);
    const k = `${n.callFrame.functionName || '(anon)'} ${path.basename(n.callFrame.url)}`;
    self.set(k, (self.get(k) ?? 0) + dt[i]);
    total += dt[i];
  });
}
const rows = [...self].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log(`total sampled ${(total / 1e6).toFixed(0)} s`);
for (const [k, v] of rows) console.log(`${(100 * v / total).toFixed(1).padStart(5)}%  ${(v / 1e6).toFixed(0).padStart(6)} s  ${k}`);
