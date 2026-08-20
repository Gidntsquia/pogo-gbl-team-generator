import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { importCollection } from '../src/importer/index.js';
import { parseCsv } from '../src/importer/csv.js';
import { createSpeciesResolver } from '../src/importer/gamemaster.js';
import { parseNumber, parseBoolFlag, parseShadowPurified } from '../src/importer/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const POKEGENIE_FIXTURE = path.join(FIXTURES_DIR, 'sample-pokegenie.csv');
const GENERIC_FIXTURE = path.join(FIXTURES_DIR, 'sample-generic.csv');

/** Write `content` to a fresh temp CSV file and return its path. */
function writeTempCsv(content) {
  const dir = mkdtempSync(path.join(tmpdir(), 'importer-test-'));
  const file = path.join(dir, 'sample.csv');
  writeFileSync(file, content, 'utf8');
  return file;
}

// --------------------------------------------------------------- csv.js --

test('parseCsv: quoted commas, doubled-quote escapes, CRLF line endings', () => {
  const text = 'a,b,c\r\n1,"hello, world",3\r\n"quo""ted",5,6\r\n';
  assert.deepEqual(parseCsv(text), [
    ['a', 'b', 'c'],
    ['1', 'hello, world', '3'],
    ['quo"ted', '5', '6'],
  ]);
});

test('parseCsv: embedded newline inside a quoted field is preserved', () => {
  assert.deepEqual(parseCsv('a,b\n"line1\nline2",2\n'), [
    ['a', 'b'],
    ['line1\nline2', '2'],
  ]);
});

test('parseCsv: strips a leading BOM and tolerates a missing trailing newline', () => {
  assert.deepEqual(parseCsv('﻿a,b\n1,2'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

// -------------------------------------------------------------- util.js --

test('parseNumber: blank/undefined/non-numeric -> undefined, else a number', () => {
  assert.equal(parseNumber(''), undefined);
  assert.equal(parseNumber('   '), undefined);
  assert.equal(parseNumber(undefined), undefined);
  assert.equal(parseNumber('abc'), undefined);
  assert.equal(parseNumber('12'), 12);
  assert.equal(parseNumber('12.5'), 12.5);
});

test('parseBoolFlag: 1/true/yes/y case-insensitive, everything else false', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'Yes', 'y', 'Y']) {
    assert.equal(parseBoolFlag(v), true, `expected true for ${v}`);
  }
  for (const v of ['0', 'false', 'no', '', undefined, 'n']) {
    assert.equal(parseBoolFlag(v), false, `expected false for ${String(v)}`);
  }
});

test('parseShadowPurified: numeric codes and text labels', () => {
  assert.deepEqual(parseShadowPurified(undefined), { shadow: false, purified: false });
  assert.deepEqual(parseShadowPurified('0'), { shadow: false, purified: false });
  assert.deepEqual(parseShadowPurified('1'), { shadow: true, purified: false });
  assert.deepEqual(parseShadowPurified('2'), { shadow: false, purified: true });
  assert.deepEqual(parseShadowPurified('Shadow'), { shadow: true, purified: false });
  assert.deepEqual(parseShadowPurified('Purified'), { shadow: false, purified: true });
});

// -------------------------------------------------------- gamemaster.js --

test('species resolver: forms, gendered species, punctuation, size/letter variants', () => {
  const resolve = createSpeciesResolver();
  const cases = [
    [{ name: 'Rattata' }, 'rattata'],
    [{ name: 'Rattata', form: 'Alola' }, 'rattata_alolan'],
    [{ name: 'Rattata', form: 'Alolan' }, 'rattata_alolan'],
    [{ name: 'Stunfisk', form: 'Galar' }, 'stunfisk_galarian'],
    [{ name: 'Stunfisk', form: 'Galarian' }, 'stunfisk_galarian'],
    [{ name: "Farfetch'd" }, 'farfetchd'],
    [{ name: 'Mr. Mime' }, 'mr_mime'],
    [{ name: 'Mr Mime' }, 'mr_mime'],
    [{ name: 'Ho-Oh' }, 'ho_oh'],
    [{ name: 'Flabébé' }, 'flabebe'],
    [{ name: 'Nidoran', gender: 'Female' }, 'nidoran_female'],
    [{ name: 'Nidoran', gender: 'Male' }, 'nidoran_male'],
    [{ name: 'Nidoran♀' }, 'nidoran_female'], // Nidoran♀
    [{ name: 'Nidoran♂' }, 'nidoran_male'], // Nidoran♂
    [{ name: 'Unown', form: 'F' }, 'unown'],
    [{ name: 'Spinda', form: '3' }, 'spinda'],
    [{ name: 'Pumpkaboo' }, 'pumpkaboo_average'], // no form stated -> defaults to Average
    [{ name: 'Pumpkaboo', form: 'Small' }, 'pumpkaboo_small'],
    [{ name: 'Gourgeist', form: 'Super' }, 'gourgeist_super'],
  ];
  for (const [input, expected] of cases) {
    const got = resolve(input);
    assert.ok(got, `expected a match for ${JSON.stringify(input)}`);
    assert.equal(got.speciesId, expected, JSON.stringify(input));
  }
});

test('species resolver: unmatched or empty name resolves to null, never throws', () => {
  const resolve = createSpeciesResolver();
  assert.equal(resolve({ name: 'Freakemon' }), null);
  assert.equal(resolve({ name: '' }), null);
  assert.equal(resolve({ name: 'Nidoran' }), null); // ambiguous gender, no signal
});

// -------------------------------------------- importCollection: Poke Genie --

test('importCollection: auto-detects Poke Genie format and imports all valid rows', () => {
  const { mons, warnings } = importCollection(POKEGENIE_FIXTURE);
  assert.equal(mons.length, 14); // 15 data rows - 1 unmatchable junk row
  assert.equal(warnings.length, 1);
});

test('importCollection: Poke Genie warning path names the row number and value', () => {
  const { warnings } = importCollection(POKEGENIE_FIXTURE);
  assert.match(warnings[0], /Row 16/);
  assert.match(warnings[0], /Freakemon/);
});

test('importCollection: Poke Genie form matching (Alolan, Galarian)', () => {
  const { mons } = importCollection(POKEGENIE_FIXTURE);
  const marowak = mons.find((m) => m.sourceRow === 4);
  assert.ok(marowak);
  assert.equal(marowak.speciesId, 'marowak_alolan');
  assert.equal(marowak.name, 'Marowak (Alolan)');

  const stunfiskGalar = mons.find((m) => m.sourceRow === 5);
  assert.ok(stunfiskGalar);
  assert.equal(stunfiskGalar.speciesId, 'stunfisk_galarian');
});

test('importCollection: Poke Genie tricky punctuation names resolve', () => {
  const { mons } = importCollection(POKEGENIE_FIXTURE);
  const farfetchd = mons.find((m) => m.sourceRow === 9);
  assert.ok(farfetchd);
  assert.equal(farfetchd.speciesId, 'farfetchd');

  const mrMime = mons.find((m) => m.sourceRow === 10);
  assert.ok(mrMime);
  assert.equal(mrMime.speciesId, 'mr_mime');
});

test('importCollection: Poke Genie shadow/purified/lucky flags and IVs', () => {
  const { mons } = importCollection(POKEGENIE_FIXTURE);

  const shadowSwampert = mons.find((m) => m.sourceRow === 6);
  assert.ok(shadowSwampert);
  assert.equal(shadowSwampert.speciesId, 'swampert');
  assert.equal(shadowSwampert.shadow, true);
  assert.equal(shadowSwampert.purified, false);
  assert.deepEqual(shadowSwampert.ivs, { atk: 14, def: 9, hp: 13 });

  const purifiedStunfisk = mons.find((m) => m.sourceRow === 7);
  assert.ok(purifiedStunfisk);
  assert.equal(purifiedStunfisk.speciesId, 'stunfisk'); // base, not Galarian
  assert.equal(purifiedStunfisk.shadow, false);
  assert.equal(purifiedStunfisk.purified, true);

  const luckySkarmory = mons.find((m) => m.sourceRow === 8);
  assert.ok(luckySkarmory);
  assert.equal(luckySkarmory.lucky, true);
  assert.equal(luckySkarmory.shadow, false);
  assert.equal(luckySkarmory.purified, false);

  // Spot-check a plain row's flags are all false and IVs map correctly
  // (also exercises the "HP" column NOT being confused with the Sta IV
  // column -- Azumarill's ivs.hp must be its 0-15 Sta IV, 14, not its
  // derived HP stat, 118).
  const azumarill1 = mons.find((m) => m.sourceRow === 2);
  assert.ok(azumarill1);
  assert.deepEqual(azumarill1.ivs, { atk: 1, def: 15, hp: 14 });
  assert.equal(azumarill1.shadow, false);
  assert.equal(azumarill1.purified, false);
  assert.equal(azumarill1.lucky, false);
  assert.equal(azumarill1.bestBuddy, false);
  assert.equal(azumarill1.cp, 1494);
  assert.equal(azumarill1.level, 25.5);
});

test('importCollection: Poke Genie format recognizes a manually-added "Best Buddy" column', () => {
  // Real Poke Genie exports carry no Best Buddy column (see the
  // POKEGENIE_FIXTURE header) -- this is the opportunistic path a user
  // would exercise by hand-adding the column themselves (documented in
  // README.md). Confirms the recognition actually round-trips end to
  // end, not just that the default is false when the column is absent.
  const csv = writeTempCsv(
    'Name,Atk IV,Def IV,Sta IV,Best Buddy\n' +
      'Azumarill,1,15,14,Yes\n' +
      'Medicham,15,14,14,No\n'
  );
  const { mons, warnings } = importCollection(csv);
  assert.equal(warnings.length, 0);

  const azumarill = mons.find((m) => m.speciesId === 'azumarill');
  assert.ok(azumarill);
  assert.equal(azumarill.bestBuddy, true);

  const medicham = mons.find((m) => m.speciesId === 'medicham');
  assert.ok(medicham);
  assert.equal(medicham.bestBuddy, false);
});

test('importCollection: Poke Genie duplicates (same species, different IVs) are both kept', () => {
  const { mons } = importCollection(POKEGENIE_FIXTURE);
  const azumarills = mons.filter((m) => m.speciesId === 'azumarill');
  assert.equal(azumarills.length, 2);
  assert.notDeepEqual(azumarills[0].ivs, azumarills[1].ivs);
});

test('importCollection: Great League staples Azumarill and Medicham import correctly', () => {
  const { mons } = importCollection(POKEGENIE_FIXTURE);
  assert.ok(mons.some((m) => m.speciesId === 'azumarill'));
  assert.ok(mons.some((m) => m.speciesId === 'medicham'));
});

// ----------------------------------------------- importCollection: generic --

test('importCollection: auto-detects the generic format', () => {
  const { mons, warnings } = importCollection(GENERIC_FIXTURE);
  assert.equal(mons.length, 5);
  assert.equal(warnings.length, 0);
});

test('importCollection: generic format maps name/atk/def/sta/shadow/level/cp by header', () => {
  const { mons } = importCollection(GENERIC_FIXTURE);

  const registeel = mons.find((m) => m.speciesId === 'registeel');
  assert.ok(registeel);
  assert.deepEqual(registeel.ivs, { atk: 0, def: 15, hp: 14 });
  assert.equal(registeel.level, 20);
  assert.equal(registeel.cp, 1428);
  assert.equal(registeel.shadow, false);

  const nidoqueen = mons.find((m) => m.speciesId === 'nidoqueen');
  assert.ok(nidoqueen);
  assert.equal(nidoqueen.shadow, true, 'shadow column "true" should parse as shadow');

  const charjabug = mons.find((m) => m.speciesId === 'charjabug');
  assert.ok(charjabug);
  assert.equal(charjabug.shadow, false, 'shadow column "false" should parse as not-shadow');
  assert.equal(charjabug.level, undefined);
  assert.equal(charjabug.cp, undefined);
});

test('importCollection: generic format recognizes a manually-added "bestbuddy" column', () => {
  const csv = writeTempCsv(
    'name,atk,def,sta,bestbuddy\n' + 'Azumarill,1,15,14,true\n' + 'Medicham,15,14,14,false\n'
  );
  const { mons, warnings } = importCollection(csv);
  assert.equal(warnings.length, 0);

  const azumarill = mons.find((m) => m.speciesId === 'azumarill');
  assert.ok(azumarill);
  assert.equal(azumarill.bestBuddy, true);

  const medicham = mons.find((m) => m.speciesId === 'medicham');
  assert.ok(medicham);
  assert.equal(medicham.bestBuddy, false);
});

test('importCollection: generic format resolves a parenthetical form written into the name column', () => {
  const { mons } = importCollection(GENERIC_FIXTURE);
  const stunfisk = mons.find((m) => m.speciesId === 'stunfisk_galarian');
  assert.ok(stunfisk, 'expected "Stunfisk (Galarian)" to resolve to the Galarian speciesId');
});

// ---------------------------------------------------------- edge cases --

test('importCollection: unrecognized header throws instead of silently misparsing', () => {
  const file = writeTempCsv('foo,bar,baz\n1,2,3\n');
  assert.throws(() => importCollection(file), /Unrecognized CSV format/);
});

test('importCollection: blank/junk lines in an otherwise generic CSV are skipped, not warned', () => {
  const file = writeTempCsv('name,atk,def,sta\nRegisteel,0,15,14\n\n,,,\n');
  const { mons, warnings } = importCollection(file);
  assert.equal(mons.length, 1);
  assert.equal(warnings.length, 0);
});

test('importCollection: a row with missing/non-numeric IVs is skipped with a warning, not thrown', () => {
  const file = writeTempCsv('name,atk,def,sta\nRegisteel,0,15,14\nUmbreon,,15,15\n');
  const { mons, warnings } = importCollection(file);
  assert.equal(mons.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Row 3/);
  assert.match(warnings[0], /Umbreon/);
});

test('importCollection: generic format tolerates extra/reordered columns', () => {
  const file = writeTempCsv(
    'nickname,name,atk,def,sta,note\n' + 'Sparky,Umbreon,3,15,15,favorite\n'
  );
  // "name" is still found by header name even with unrelated columns
  // before/after it and a "nickname" column that must NOT be confused
  // with "name".
  const { mons, warnings } = importCollection(file);
  assert.equal(warnings.length, 0);
  assert.equal(mons.length, 1);
  assert.equal(mons[0].speciesId, 'umbreon');
});
