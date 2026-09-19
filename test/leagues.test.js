import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveFormat, leagueForCp, DEFAULT_CP, DEFAULT_CUP, SUPPORTED_CPS } from '../src/util/leagues.js';

describe('resolveFormat', () => {
  test('cup "all" matches leagueForCp byte-for-byte, and defaults to Great League', () => {
    for (const cp of SUPPORTED_CPS) {
      assert.deepEqual(resolveFormat({ cp }), leagueForCp(cp));
    }
    assert.deepEqual(resolveFormat(), resolveFormat({ cp: DEFAULT_CP, cup: DEFAULT_CUP }));
    assert.equal(resolveFormat().name, 'Great League');
  });

  test('unsupported cp under cup "all" throws', () => {
    assert.throws(() => resolveFormat({ cp: 9999 }), /unsupported cp 9999/);
  });

  test('a real cup (willpower) resolves title/group/rankingsDir from vendor/pvpoke', () => {
    const format = resolveFormat({ cp: 1500, cup: 'willpower' });
    assert.equal(format.name, 'Willpower Cup');
    assert.equal(format.group, 'willpower');
    assert.equal(format.rankingsDir, 'willpower');
    assert.equal(format.cup, 'willpower');
    assert.equal(format.cp, 1500);
  });

  test('little cup at cp 500 resolves (cup id and cp cap both named "little")', () => {
    const format = resolveFormat({ cp: 500, cup: 'little' });
    assert.equal(format.cup, 'little');
    assert.equal(format.cp, 500);
  });

  test('unknown cup:cp pair throws listing valid pairs', () => {
    assert.throws(
      () => resolveFormat({ cp: 1500, cup: 'not-a-real-cup' }),
      /no format for cup="not-a-real-cup" cp=1500/
    );
  });

  test('missing rankings file throws with the path in the message', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'pogo-format-test-'));
    try {
      const gmDir = path.join(tmp, 'src/data/gamemaster');
      mkdirSync(gmDir, { recursive: true });
      writeFileSync(
        path.join(gmDir, 'formats.json'),
        JSON.stringify([{ title: 'Fake Cup', cup: 'fake', cp: 1500, meta: 'fake' }])
      );
      // No cups/fake.json, no rankings/fake/overall/rankings-1500.json.
      assert.throws(
        () => resolveFormat({ cp: 1500, cup: 'fake', vendorRoot: tmp }),
        /no vendored rankings for cup="fake" cp=1500/
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('leagueForCp (thin wrapper)', () => {
  test('returns name/group for each supported cp', () => {
    assert.equal(leagueForCp(1500).name, 'Great League');
    assert.equal(leagueForCp(1500).group, 'great');
    assert.equal(leagueForCp(2500).group, 'ultra');
    assert.equal(leagueForCp(10000).group, 'master');
    assert.equal(leagueForCp(500).group, 'little');
  });

  test('throws on unsupported cp', () => {
    assert.throws(() => leagueForCp(1234));
  });
});
