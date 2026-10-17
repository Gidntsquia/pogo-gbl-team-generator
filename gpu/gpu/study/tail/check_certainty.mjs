// Round 9 R5: the JS certainty port (certainty.mjs) against certainty.py on captured runs.
//   node gpu/gpu/study/tail/check_certainty.mjs out/gpu/study/early/cap-h2 out/gpu/study/early/cap-h3 out/gpu/study/early/cap-h3g10
// For each capture: runs dump_bounds.py (Python bounds + certain sets at 5 instants per round), computes the same with the JS
// port from the same capture files, prints the largest |JS - Python| bound difference and the certain-set mismatches, and writes
// out/gpu/study/tail/certainty-check.json. Exit 1 on a difference above 1e-9 or any certain-set mismatch.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRound, bounds, certainTeams } from './certainty.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const caps = process.argv.slice(2);
const report = [];
let bad = false;
for (const c of caps) {
  const dir = path.resolve(c);
  const tmp = path.join(root, 'out/gpu/study/tail', `bounds-${path.basename(dir)}.json`);
  mkdirSync(path.dirname(tmp), { recursive: true });
  execFileSync('uv', ['run', 'python', '-m', 'gpu.study.tail.dump_bounds', dir, tmp], { cwd: path.join(root, 'gpu'), stdio: ['ignore', 'inherit', 'inherit'] });
  const py = JSON.parse(readFileSync(tmp, 'utf8'));
  const capDir = path.join(dir, 'cap');
  const files = readdirSync(capDir).sort();
  const evals = files.filter((f) => f.startsWith('eval-')).map((f) => JSON.parse(readFileSync(path.join(capDir, f), 'utf8')));
  const launches = files.filter((f) => f.startsWith('launch-') && f.endsWith('.json')).map((f) => {
    const meta = JSON.parse(readFileSync(path.join(capDir, f), 'utf8'));
    const b = readFileSync(path.join(capDir, f.replace('.json', '.bin')));
    const out = new Int32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    const end = new Float64Array(meta.n);
    const u = (x) => BigInt(x >>> 0);
    let s0 = null;
    const st = [];
    for (let i = 0; i < meta.n; i++) {
      const o = i * meta.cols;
      const s = u(out[o + 20]) | (u(out[o + 21]) << 32n), e = u(out[o + 22]) | (u(out[o + 23]) << 32n);
      st.push(s); if (s0 === null || s < s0) s0 = s;
      end[i] = Number(e);
    }
    return end.map((e) => (e - Number(s0)) / 1e9);
  });
  let worst = 0, mism = 0, inst = 0, certainSum = 0;
  for (const row of py) {
    const ev = evals[row.eval];
    const end = launches[ev.launch0];
    const R = prepareRound(ev);
    const fwd = (ix, r) => (end[ix] <= row.t ? { wp: R.fwp[r], ex: R.fex[r] } : null);
    const rev = (ix, r) => (end[ix] <= row.t ? { wp: R.vwp[r], ex: R.vex[r] } : null);
    const { lo, hi } = bounds(R, fwd, rev);
    const c = certainTeams(lo, hi, ev.round.keep);
    for (let i = 0; i < lo.length; i++) worst = Math.max(worst, Math.abs(lo[i] - row.lo[i]), Math.abs(hi[i] - row.hi[i]));
    for (let i = 0; i < c.length; i++) if (c[i] !== row.certain[i]) mism += 1;
    certainSum += c.reduce((a, v) => a + v, 0);
    inst += 1;
  }
  const ok = worst <= 1e-9 && mism === 0;
  bad ||= !ok;
  report.push({ capture: path.relative(root, dir), instants: inst, maxAbsDiff: worst, certainMismatches: mism, certainTeamsTotal: certainSum, equal: ok });
  console.log(`${path.relative(root, dir)}: ${inst} instants, max |JS - Python| = ${worst.toExponential(2)}, certain-set mismatches ${mism} (certain teams summed ${certainSum}) -> ${ok ? 'EQUAL' : 'DIFFERENT'}`);
}
writeFileSync(path.join(root, 'out/gpu/study/tail/certainty-check.json'), JSON.stringify(report, null, 1));
process.exit(bad ? 1 : 0);
