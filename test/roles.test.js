// Tests for src/meta/roles.js -- per-species lead/closer/switch role priors
// sourced from pvpoke's own vendored leads/closers/switches rankings.
//
// Verifies: shape/normalization (values in [0,1]), determinism,
// cp-awareness (1500 vs 2500 read different files and disagree), the
// mimikyu-top-decile anchor in leads+closers at cp 1500 (the module's own
// anchor: mimikyu is #1 in leads/closers/switches under the pinned commit),
// and snapshot-preference + corrupt-snapshot fallback via a temp file.
//
// No network access anywhere in this suite (no fetch script exists for this
// loader yet -- see src/meta/roles.js's header comment).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { initEngine } from '../src/engine/harness.js';
import { loadRoleScores } from '../src/meta/roles.js';

const ctx = await initEngine();

// A small, hand-built universe so shape/determinism/snapshot tests don't
// depend on the full vendored data set.
const FAKE_OPTS = {
  leadEntries: [
    { speciesId: 'alpha', score: 90 },
    { speciesId: 'beta', score: 50 },
  ],
  closerEntries: [
    { speciesId: 'alpha', score: 20 },
    { speciesId: 'beta', score: 80 },
  ],
  switchEntries: [
    { speciesId: 'alpha', score: 60 },
    { speciesId: 'beta', score: 40 },
  ],
};

test('returns normalized {lead, closer, switch} in [0,1] per species, covering the entries union', () => {
  const scores = loadRoleScores(ctx, FAKE_OPTS);
  assert.deepEqual(new Set(scores.keys()), new Set(['alpha', 'beta']));
  assert.deepEqual(scores.get('alpha'), { lead: 0.9, closer: 0.2, switch: 0.6 });
  assert.deepEqual(scores.get('beta'), { lead: 0.5, closer: 0.8, switch: 0.4 });
  for (const entry of scores.values()) {
    for (const role of ['lead', 'closer', 'switch']) {
      assert.ok(entry[role] >= 0 && entry[role] <= 1, `${role} score in [0,1]`);
    }
  }
});

test('a species present in only some role entries gets 0 for the missing role(s), not dropped', () => {
  const scores = loadRoleScores(ctx, {
    leadEntries: [{ speciesId: 'onlyLead', score: 77 }],
    closerEntries: [],
    switchEntries: [],
  });
  assert.ok(scores.has('onlyLead'));
  assert.deepEqual(scores.get('onlyLead'), { lead: 0.77, closer: 0, switch: 0 });
});

test('is deterministic across repeated calls', () => {
  const a = loadRoleScores(ctx, FAKE_OPTS);
  const b = loadRoleScores(ctx, FAKE_OPTS);
  assert.deepEqual([...a.entries()], [...b.entries()]);
});

test('cp-awareness: cp 1500 and cp 2500 read different vendored files and can disagree', async () => {
  const ctx2500 = await initEngine({ cp: 2500 });
  const scores1500 = loadRoleScores(ctx);
  const scores2500 = loadRoleScores(ctx2500);

  // Both should resolve a real, sizeable universe from the vendored data.
  assert.ok(scores1500.size > 500);
  assert.ok(scores2500.size > 500);

  // At least one shared species should have a different lead/closer/switch
  // profile between leagues (Great League vs Ultra League role rankings are
  // computed independently by pvpoke) -- proves the cp actually changed
  // which files were read, not just returning the same data twice.
  let anyDifferent = false;
  for (const [speciesId, entry1500] of scores1500) {
    const entry2500 = scores2500.get(speciesId);
    if (entry2500 && JSON.stringify(entry1500) !== JSON.stringify(entry2500)) {
      anyDifferent = true;
      break;
    }
  }
  assert.ok(anyDifferent, 'cp 1500 vs cp 2500 role scores should differ for at least one shared species');
});

test('mimikyu is a top-decile lead AND closer at cp 1500 (role-prior anchor)', () => {
  const scores = loadRoleScores(ctx);
  const mimikyu = scores.get('mimikyu');
  assert.ok(mimikyu, 'mimikyu should resolve in the cp-1500 role universe');

  const decile = (role) => {
    const sorted = [...scores.values()].map((e) => e[role]).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.9)];
  };
  assert.ok(mimikyu.lead >= decile('lead'), 'mimikyu should sit in the top decile of lead scores');
  assert.ok(mimikyu.closer >= decile('closer'), 'mimikyu should sit in the top decile of closer scores');
});

test('a present+parseable snapshot is preferred over the vendored rankings files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'meta-roles-'));
  const snapshotPath = path.join(dir, 'meta-roles.json');
  try {
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        fetchedAt: '2026-08-22T00:00:00Z',
        source: 'test-fixture',
        cp: 1500,
        categories: {
          lead: [{ speciesId: 'alpha', score: 5 }, { speciesId: 'beta', score: 95 }],
          closer: [{ speciesId: 'alpha', score: 5 }, { speciesId: 'beta', score: 95 }],
          switch: [{ speciesId: 'alpha', score: 5 }, { speciesId: 'beta', score: 95 }],
        },
      })
    );
    const scores = loadRoleScores(ctx, { snapshotPath });
    assert.ok(scores.get('beta').lead > scores.get('alpha').lead, 'snapshot scores (beta>alpha) should win');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a snapshot fetched for a different cp is ignored (falls back to vendored) without throwing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'meta-roles-wrongcp-'));
  const snapshotPath = path.join(dir, 'meta-roles.json');
  try {
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        fetchedAt: '2026-08-22T00:00:00Z',
        source: 'test-fixture',
        cp: 2500,
        categories: {
          lead: [{ speciesId: 'mimikyu', score: 1 }],
          closer: [{ speciesId: 'mimikyu', score: 1 }],
          switch: [{ speciesId: 'mimikyu', score: 1 }],
        },
      })
    );
    // ctx is a cp-1500 context -- the cp-2500 snapshot must be ignored.
    const scores = loadRoleScores(ctx, { snapshotPath });
    assert.ok(scores.get('mimikyu').lead > 0.9, 'falls back to the real cp-1500 vendored data, not the wrong-cp snapshot');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing snapshot path falls back to vendored/entries without throwing', () => {
  const scores = loadRoleScores(ctx, { ...FAKE_OPTS, snapshotPath: '/nonexistent/path/does-not-exist.json' });
  assert.deepEqual(scores.get('alpha'), { lead: 0.9, closer: 0.2, switch: 0.6 });
});

test('a corrupt (unparseable) snapshot falls back to vendored/entries without throwing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'meta-roles-corrupt-'));
  const snapshotPath = path.join(dir, 'meta-roles.json');
  try {
    writeFileSync(snapshotPath, '{ this is not valid JSON');
    const scores = loadRoleScores(ctx, { ...FAKE_OPTS, snapshotPath });
    assert.deepEqual(scores.get('alpha'), { lead: 0.9, closer: 0.2, switch: 0.6 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a structurally-invalid snapshot (missing categories) falls back without throwing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'meta-roles-badshape-'));
  const snapshotPath = path.join(dir, 'meta-roles.json');
  try {
    writeFileSync(snapshotPath, JSON.stringify({ fetchedAt: 'x', source: 'y' }));
    const scores = loadRoleScores(ctx, { ...FAKE_OPTS, snapshotPath });
    assert.deepEqual(scores.get('alpha'), { lead: 0.9, closer: 0.2, switch: 0.6 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
