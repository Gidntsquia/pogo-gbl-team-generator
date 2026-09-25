// Round-3 opponent-sweep stats and report (scripts/sampled-k-r3-stats.mjs, compare-sampled-k-report.mjs):
// the unchanged stop rule on synthetic cells, and the report is byte-identical across renders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decisionAt, finishedSeeds, STOP_RULE } from '../scripts/sampled-k-r3-stats.mjs';
import { renderSampledKReport } from '../scripts/compare-sampled-k-report.mjs';

const cell = (arm, seed, q) => ({ arm, seed, genBattles: 1000, genSeconds: 10, heldoutMeanTop: q, wallSeconds: 5, finalists: [] });
const cellsFor = (diffs) => diffs.flatMap((d, k) => [cell('o50', `s${k + 1}`, 0.5), cell('o500', `s${k + 1}`, 0.5 + d)]);
const seeds = Array.from({ length: 20 }, (_, k) => `s${k + 1}`);

test('stop rule: YES above 0, NO inside +-2 points, undecided otherwise, nothing before 2 seeds', () => {
  const yes = cellsFor([0.05, 0.06, 0.055, 0.05]);
  const no = cellsFor([0.002, -0.003, 0.001, 0]);
  const band2 = cellsFor([0.015, -0.012, 0.014, -0.013, 0.012, -0.011]); // outside +-1, inside +-2
  const wide = cellsFor([0.1, -0.08, 0.05]);
  assert.equal(finishedSeeds(yes, seeds), 4);
  assert.equal(decisionAt(yes, seeds, 4), 'yes');
  assert.equal(decisionAt(no, seeds, 4), 'no');
  assert.equal(decisionAt(band2, seeds, 6), 'no');
  assert.equal(decisionAt(wide, seeds, 3), 'undecided');
  assert.equal(decisionAt(cellsFor([0.1]), seeds, 1), 'undecided');
  assert.match(STOP_RULE, /24 seeds in total, or 12 hours/);
});

test('report renders the round-3 answer and is byte-identical across renders', () => {
  const r2 = { arms: ['base', 'k10eq', 'o50', 'o500', 'c40', 'c320'], seeds: ['s1', 's2', 's3'], top: 5, heldoutCount: 60, baseFlags: ['--generations', '8', '--population', '40', '--opponents-per-gen', '30'], armFlags: { base: ['--halving-rounds', '3'], k10eq: ['--sampled-opponents', '10'], o50: ['--sampled-opponents', '50'], o500: ['--sampled-opponents', '50'], c40: ['--sampled-opponents', '50'], c320: ['--sampled-opponents', '50'] }, cells: [] };
  ['s1', 's2', 's3'].forEach((s, k) => { for (const a of r2.arms) r2.cells.push(cell(a, s, 0.5 + k * 0.01 + (a === 'base' ? 0 : 0.02))); });
  const r3 = { cells: cellsFor([0.05, 0.06, 0.055, 0.05]) };
  const a = mkdtempSync(path.join(tmpdir(), 'r3a-')), b = mkdtempSync(path.join(tmpdir(), 'r3b-'));
  renderSampledKReport(r2, a, r3);
  renderSampledKReport(r2, b, r3);
  const html = readFileSync(path.join(a, 'sampled-k-ab.html'), 'utf8');
  assert.equal(html, readFileSync(path.join(b, 'sampled-k-ab.html'), 'utf8'));
  assert.match(html, /More opponents \(50 to 500\): YES/);
  assert.match(html, /5-seed results, produced before the determinism fix/);
});
