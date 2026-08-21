// Tests for src/meta/usage.js -- per-species meta usage weights.
//
// Verifies: normalization (positive, sums to 1), determinism, monotonic in
// score, Aug 2026 meta anchors sit above the median weight, a present+
// parseable snapshot is preferred over the vendored rankings file, and a
// missing/corrupt snapshot falls back to vendored without throwing.
//
// No network access anywhere in this suite -- scripts/refresh-usage.mjs (the
// only thing that touches the network) is never invoked here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { initEngine } from '../src/engine/harness.js';
import { loadUsageWeights } from '../src/meta/usage.js';

const ctx = await initEngine();

// A small, hand-built species universe so normalization/monotonicity tests
// don't depend on the full vendored data set.
const FAKE_UNIVERSE_OPTS = {
  groupEntries: [{ speciesId: 'alpha' }, { speciesId: 'beta' }, { speciesId: 'gamma' }],
  trainingSpeciesIds: ['gamma', 'delta'], // delta only appears via training teams
  rankingsEntries: [
    { speciesId: 'alpha', score: 90 },
    { speciesId: 'beta', score: 50 },
    { speciesId: 'gamma', score: 10 },
    { speciesId: 'delta', score: 70 },
  ],
};

test('weights are positive, cover the group+training union, and normalize to 1', () => {
  const weights = loadUsageWeights(ctx, FAKE_UNIVERSE_OPTS);
  assert.deepEqual(new Set(weights.keys()), new Set(['alpha', 'beta', 'gamma', 'delta']));
  let sum = 0;
  for (const w of weights.values()) {
    assert.ok(w > 0, 'every weight is strictly positive');
    sum += w;
  }
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights should sum to 1, got ${sum}`);
});

test('is deterministic across repeated calls', () => {
  const a = loadUsageWeights(ctx, FAKE_UNIVERSE_OPTS);
  const b = loadUsageWeights(ctx, FAKE_UNIVERSE_OPTS);
  assert.deepEqual([...a.entries()], [...b.entries()]);
});

test('weight is monotonic in score (higher score -> strictly higher weight)', () => {
  const weights = loadUsageWeights(ctx, FAKE_UNIVERSE_OPTS);
  // Source scores: alpha 90 > delta 70 > beta 50 > gamma 10.
  assert.ok(weights.get('alpha') > weights.get('delta'));
  assert.ok(weights.get('delta') > weights.get('beta'));
  assert.ok(weights.get('beta') > weights.get('gamma'));
});

test('a species absent from the score source is left out of the map entirely', () => {
  const weights = loadUsageWeights(ctx, {
    groupEntries: [{ speciesId: 'alpha' }, { speciesId: 'unscored' }],
    trainingSpeciesIds: [],
    rankingsEntries: [{ speciesId: 'alpha', score: 90 }],
  });
  assert.ok(weights.has('alpha'));
  assert.ok(!weights.has('unscored'));
});

test('gamma spreads high-score mons further above low-score ones (not winner-take-all)', () => {
  const opts = FAKE_UNIVERSE_OPTS;
  const lowGamma = loadUsageWeights(ctx, { ...opts, gamma: 1 });
  const highGamma = loadUsageWeights(ctx, { ...opts, gamma: 5 });
  const ratioLow = lowGamma.get('alpha') / lowGamma.get('gamma');
  const ratioHigh = highGamma.get('alpha') / highGamma.get('gamma');
  assert.ok(ratioHigh > ratioLow, 'a higher gamma should widen the top/bottom weight ratio');
});

test('Aug 2026 meta anchors resolve via the gamemaster and sit above the median weight', () => {
  // token-set match so display-name formatting differences ("Galarian
  // Stunfisk" vs "Stunfisk (Galarian)") don't matter -- only the underlying
  // set of words does.
  const tokenKey = (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .sort()
      .join(' ');
  const nameIndex = new Map();
  for (const p of ctx.gm.data.pokemon) {
    const key = tokenKey(p.speciesName);
    if (!nameIndex.has(key)) nameIndex.set(key, p.speciesId);
  }

  const anchorNames = [
    'Clodsire',
    'Azumarill',
    'Galarian Stunfisk',
    'Morpeko (Full Belly)',
    'Mandibuzz',
    'Gastrodon',
    'Annihilape',
    'Feraligatr',
  ];
  const anchorIds = anchorNames.map((n) => {
    const id = nameIndex.get(tokenKey(n));
    assert.ok(id, `anchor "${n}" should resolve to a real gamemaster speciesId`);
    return id;
  });

  const weights = loadUsageWeights(ctx);
  const presentAnchors = anchorIds.filter((id) => weights.has(id));
  // Mandibuzz/Gastrodon aren't in great.json or the curated training teams
  // under the pinned vendor commit -- absent from the weight universe by
  // design (T9: "drop any absent from the pinned data").
  assert.ok(presentAnchors.length >= 6, `expected most anchors present, got ${presentAnchors.length}`);

  const sorted = [...weights.values()].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  for (const id of presentAnchors) {
    assert.ok(weights.get(id) > median, `${id} should sit above the median weight`);
  }
});

test('a present+parseable snapshot is preferred over the vendored rankings file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'meta-usage-'));
  const snapshotPath = path.join(dir, 'meta-usage.json');
  try {
    // Flip alpha/gamma's relative standing vs. the vendored/fake rankings
    // entries used elsewhere in this file, so a passing weight can only mean
    // the snapshot (not the rankingsEntries fallback) was actually read.
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        fetchedAt: '2026-08-21T00:00:00Z',
        source: 'test-fixture',
        entries: [
          { speciesId: 'alpha', score: 5 },
          { speciesId: 'beta', score: 50 },
          { speciesId: 'gamma', score: 95 },
          { speciesId: 'delta', score: 70 },
        ],
      })
    );
    const weights = loadUsageWeights(ctx, { ...FAKE_UNIVERSE_OPTS, snapshotPath });
    assert.ok(weights.get('gamma') > weights.get('alpha'), 'snapshot scores (gamma>alpha) should win');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing snapshot path falls back to vendored/rankingsEntries without throwing', () => {
  const weights = loadUsageWeights(ctx, {
    ...FAKE_UNIVERSE_OPTS,
    snapshotPath: '/nonexistent/path/does-not-exist.json',
  });
  assert.ok(weights.get('alpha') > weights.get('gamma'), 'falls back to rankingsEntries (alpha>gamma there)');
});

test('a corrupt (unparseable) snapshot falls back to vendored/rankingsEntries without throwing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'meta-usage-corrupt-'));
  const snapshotPath = path.join(dir, 'meta-usage.json');
  try {
    writeFileSync(snapshotPath, '{ this is not valid JSON');
    const weights = loadUsageWeights(ctx, { ...FAKE_UNIVERSE_OPTS, snapshotPath });
    assert.ok(weights.get('alpha') > weights.get('gamma'), 'falls back past the corrupt snapshot');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a structurally-invalid snapshot (missing entries array) falls back without throwing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'meta-usage-badshape-'));
  const snapshotPath = path.join(dir, 'meta-usage.json');
  try {
    writeFileSync(snapshotPath, JSON.stringify({ fetchedAt: 'x', source: 'y' }));
    const weights = loadUsageWeights(ctx, { ...FAKE_UNIVERSE_OPTS, snapshotPath });
    assert.ok(weights.get('alpha') > weights.get('gamma'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
