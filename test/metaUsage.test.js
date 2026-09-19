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

test('rank weighting: ratio between adjacent ranks matches ((r2+k)/(r1+k))^alpha', () => {
  // Source scores: alpha 90 (rank 1) > delta 70 (rank 2) > beta 50 (rank 3) > gamma 10 (rank 4).
  const weights = loadUsageWeights(ctx, FAKE_UNIVERSE_OPTS);
  const expectedRatio = Math.pow((2 + 20) / (1 + 20), 1.0); // rank1 vs rank2, default alpha=1, k=20
  const actualRatio = weights.get('alpha') / weights.get('delta');
  assert.ok(Math.abs(actualRatio - expectedRatio) < 1e-9, `expected ratio ${expectedRatio}, got ${actualRatio}`);
});

test('rankAlpha widens the top/bottom weight ratio (higher alpha = more top-heavy)', () => {
  const opts = FAKE_UNIVERSE_OPTS;
  const lowAlpha = loadUsageWeights(ctx, { ...opts, rankAlpha: 0.5 });
  const highAlpha = loadUsageWeights(ctx, { ...opts, rankAlpha: 3 });
  const ratioLow = lowAlpha.get('alpha') / lowAlpha.get('gamma');
  const ratioHigh = highAlpha.get('alpha') / highAlpha.get('gamma');
  assert.ok(ratioHigh > ratioLow, 'a higher rankAlpha should widen the top/bottom weight ratio');
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
  // design (the loader drops any species absent from the pinned data).
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
    const ignored = loadUsageWeights(ctx, { ...FAKE_UNIVERSE_OPTS, snapshotPath, ignoreSnapshot: true });
    assert.deepEqual(ignored, loadUsageWeights(ctx, FAKE_UNIVERSE_OPTS), 'ignoreSnapshot reads pure rankings');
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

test('under a cup, weights are computed from the cup rankings/group files, not Great League', async () => {
  const wpCtx = await initEngine({ cp: 1500, cup: 'willpower' });
  const weights = loadUsageWeights(wpCtx);
  // medicham/sableye are Willpower-eligible; azumarill/gardevoir are not
  // (off-type / id-banned) so they must be entirely absent from the universe.
  assert.ok(weights.has('medicham'));
  assert.ok(weights.has('sableye'));
  assert.ok(!weights.has('azumarill'));
  assert.ok(!weights.has('gardevoir'));
});

test('a Great-League snapshot (no "cup" field) is ignored under a cup ctx', async () => {
  const wpCtx = await initEngine({ cp: 1500, cup: 'willpower' });
  const dir = mkdtempSync(path.join(tmpdir(), 'meta-usage-wrongcup-'));
  const snapshotPath = path.join(dir, 'meta-usage.json');
  try {
    // cp matches (1500) but cup is implicitly 'all' -- must still fall back.
    writeFileSync(
      snapshotPath,
      JSON.stringify({ cp: 1500, entries: [{ speciesId: 'medicham', score: 100 }, { speciesId: 'sableye', score: 1 }] })
    );
    const weights = loadUsageWeights(wpCtx, { snapshotPath });
    // Real vendored willpower rankings should win instead of the snapshot's
    // score inversion -- just assert it didn't throw and returned real data.
    assert.ok(weights.size > 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
