// JavaScript Document
//
// Tests for the video collection importer (src/videoscan).
//
// The platform-specific half (decoding frames with AVFoundation, OCR with
// Vision) lives entirely in scan.swift + probe.js and is not exercised here;
// everything downstream of it is pure and is tested two ways: against
// hand-built runs that pin the exact measurement rules, and against
// fixtures/videoscan/appraisal-frames.jsonl -- four real frames recorded off
// a Pokemon GO screen recording, two showing a Pokemon and two caught
// mid-swipe.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { classifyRun, readBarRow, readAppraisal } from '../src/videoscan/bars.js';
import { countCpBoxes, readCp, readMaxHp, readSpeciesCaptions } from '../src/videoscan/text.js';
import { createCaptionResolver } from '../src/videoscan/species.js';
import { readFrame } from '../src/videoscan/frame.js';
import { chooseCp, scanFrames } from '../src/videoscan/index.js';
import { groupReadings, mergeDuplicates } from '../src/videoscan/group.js';
import { toCsv } from '../src/videoscan/csv.js';
import { createLevelDeriver } from '../src/videoscan/level.js';
import { initEngine } from '../src/engine/harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readFrames = (name) =>
  readFileSync(path.resolve(__dirname, `../fixtures/videoscan/${name}`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

// Four frames off a 384x832 recording: two Pokemon and two mid-swipe.
const FRAMES = readFrames('appraisal-frames.jsonl');
// Three frames off a full-resolution 1206x2622 recording. Between them they
// carry the three things phone-resolution footage does that the downscaled
// clip above does not: bar segments separated by visible gaps, a maxed stat
// drawn in red instead of orange, and a CP the Pokemon's animation covers.
// Rows outside y 1950-2350 are trimmed to keep the fixture small.
const ULTRA_FRAMES = readFrames('ultra-frames.jsonl');
const CHANDELURE = { t: 12, ivs: { atk: 2, def: 7, hp: 15 }, cp: 960, maxHp: 75, level: 11 };
const STUNFISK = { ivs: { atk: 15, def: 15, hp: 12 }, cp: 354, maxHp: 80, level: 6 };

// The two frames in the fixture that show a Pokemon standing still, and the
// values a human reads off those same two screens.
const TREVENANT = { t: 0, ivs: { atk: 8, def: 14, hp: 10 }, cp: 1498, maxHp: 128, level: 21.5 };
const FERALIGATR = { t: 5.8667, ivs: { atk: 0, def: 5, hp: 9 }, cp: 1498, maxHp: 125, level: 20.5 };
const frameAt = (t) => FRAMES.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));

const FRAME_WIDTH = 384;
const WHITE = [252, 253, 252];
const FILL = [240, 165, 78];
const TRACK = [226, 226, 226];
const BAR_X = 46;
const BAR_W = 134;

/** One row of a bar filled `fillPx` of its `BAR_W` pixels. */
function barRow(fillPx) {
  const runs = [[0, BAR_X, ...WHITE]];
  if (fillPx > 0) runs.push([BAR_X, fillPx, ...FILL]);
  if (fillPx < BAR_W) runs.push([BAR_X + fillPx, BAR_W - fillPx, ...TRACK]);
  runs.push([BAR_X + BAR_W, 40, ...WHITE]);
  return runs;
}

/**
 * The same bar as Pokemon GO actually draws it: three segments with a few
 * pixels of card background showing between them.
 */
function segmentedBarRow(fillPx, gap = 4) {
  const segment = (BAR_W - 2 * gap) / 3;
  const runs = [[0, BAR_X, ...WHITE]];
  let x = BAR_X;
  let remaining = fillPx;
  for (let i = 0; i < 3; i++) {
    const width = Math.round(BAR_X + (i + 1) * segment + i * gap) - x;
    const filled = Math.max(0, Math.min(width, remaining));
    if (filled > 0) runs.push([x, filled, ...FILL]);
    if (filled < width) runs.push([x + filled, width - filled, ...TRACK]);
    remaining -= width;
    x += width;
    if (i < 2) {
      runs.push([x, gap, ...WHITE]);
      x += gap;
      remaining -= gap;
    }
  }
  runs.push([x, 40, ...WHITE]);
  return runs;
}

/** A synthetic appraisal panel: three bars, five rows each, evenly stacked. */
function barRows(fillPxPerBar) {
  const rows = [];
  fillPxPerBar.forEach((fillPx, bar) => {
    for (let i = 0; i < 5; i++) rows.push({ y: 600 + bar * 30 + i, runs: barRow(fillPx) });
  });
  return rows;
}

const ivPx = (iv) => Math.round((iv / 15) * BAR_W);

// ------------------------------------------------------------------ bars --

test('classifyRun separates the orange fill, the grey track, and everything else', () => {
  assert.equal(classifyRun([0, 40, 240, 163, 80]), 'fill');
  assert.equal(classifyRun([0, 40, 226, 226, 226]), 'track');
  assert.equal(classifyRun([0, 40, 231, 224, 216]), 'track');
  assert.equal(classifyRun([0, 40, 252, 253, 252]), 'other'); // card background
  assert.equal(classifyRun([0, 40, 128, 214, 148]), 'other'); // the green HP bar
});

test('readBarRow measures the filled fraction of a bar', () => {
  const bar = readBarRow(barRow(67), FRAME_WIDTH);
  assert.equal(bar.x0, BAR_X);
  assert.equal(bar.width, BAR_W);
  assert.equal(bar.fillEnd, BAR_X + 67);
  assert.equal(bar.fraction, 67 / BAR_W);
});

test('readBarRow handles a completely empty and a completely full bar', () => {
  assert.equal(readBarRow(barRow(0), FRAME_WIDTH).fraction, 0);
  assert.equal(readBarRow(barRow(BAR_W), FRAME_WIDTH).fraction, 1);
});

test('readBarRow rejects a row whose fill does not run left to right', () => {
  const runs = [
    [0, BAR_X, ...WHITE],
    [BAR_X, 40, ...FILL],
    [BAR_X + 40, 40, ...TRACK],
    [BAR_X + 80, 54, ...FILL], // fill after track: not a progress bar
    [BAR_X + BAR_W, 40, ...WHITE],
  ];
  assert.equal(readBarRow(runs, FRAME_WIDTH), null);
});

test('readBarRow ignores a bar-like shape too narrow to be an appraisal bar', () => {
  const runs = [
    [0, 46, ...WHITE],
    [46, 12, ...FILL],
    [58, 8, ...TRACK],
    [66, 40, ...WHITE],
  ];
  assert.equal(readBarRow(runs, FRAME_WIDTH), null);
});

test('readAppraisal reads every IV from 0 to 15 back off a drawn bar', () => {
  for (let iv = 0; iv <= 15; iv++) {
    const read = readAppraisal(barRows([ivPx(iv), ivPx(iv), ivPx(iv)]), FRAME_WIDTH);
    assert.deepEqual(read.ivs, { atk: iv, def: iv, hp: iv }, `IV ${iv}`);
  }
});

test('readAppraisal labels the three bars top to bottom as attack, defense, hp', () => {
  const read = readAppraisal(barRows([ivPx(3), ivPx(11), ivPx(15)]), FRAME_WIDTH);
  assert.deepEqual(read.ivs, { atk: 3, def: 11, hp: 15 });
});

test('readAppraisal refuses a screen showing two panels of bars at once', () => {
  const rows = [...barRows([ivPx(3), ivPx(11), ivPx(15)])];
  // A second card sliding in: three more bars at the same width and left edge.
  for (let bar = 0; bar < 3; bar++) {
    for (let i = 0; i < 5; i++) rows.push({ y: 700 + bar * 30 + i, runs: barRow(ivPx(9)) });
  }
  assert.equal(readAppraisal(rows, FRAME_WIDTH), null);
});

test('readAppraisal returns null when fewer than three bars are on screen', () => {
  assert.equal(readAppraisal(barRows([ivPx(3), ivPx(11)]), FRAME_WIDTH), null);
});

test('readAppraisal reads the recorded frames the way a human reads the screen', () => {
  for (const expected of [TREVENANT, FERALIGATR]) {
    const frame = frameAt(expected.t);
    const read = readAppraisal(frame.rows, frame.w);
    assert.deepEqual(read.ivs, expected.ivs, `frame t=${frame.t}`);
    // Every bar should land close to a whole IV; a large gap means the
    // measurement is drifting and the reading is a coin flip.
    for (const delta of read.deltas) assert.ok(delta < 0.25, `delta ${delta} at t=${frame.t}`);
  }
});

// ------------------------------------------------------------------ text --

test('readCp reads the CP however Vision happens to split it', () => {
  assert.equal(readCp([{ x: 0.3, y: 0.09, w: 0.2, h: 0.03, c: 1, s: 'CP1498' }]), 1498);
  assert.equal(readCp([{ x: 0.3, y: 0.09, w: 0.2, h: 0.03, c: 1, s: 'CP 1498' }]), 1498);
  assert.equal(
    readCp([
      { x: 0.3, y: 0.09, w: 0.05, h: 0.03, c: 1, s: 'CP' },
      { x: 0.36, y: 0.091, w: 0.15, h: 0.03, c: 1, s: '1498' },
    ]),
    1498
  );
  assert.equal(readCp([{ x: 0.3, y: 0.5, w: 0.2, h: 0.03, c: 1, s: '71.71kg' }]), undefined);
});

test('readCp takes the highest CP on screen when a swipe shows two', () => {
  const boxes = [
    { x: 0.3, y: 0.42, w: 0.2, h: 0.03, c: 1, s: 'CP1122' },
    { x: 0.3, y: 0.09, w: 0.2, h: 0.03, c: 1, s: 'CP1498' },
  ];
  assert.equal(readCp(boxes), 1498);
  assert.equal(countCpBoxes(boxes), 2);
});

test('readMaxHp reads the max side of the HP text', () => {
  assert.equal(readMaxHp([{ x: 0.4, y: 0.47, w: 0.2, h: 0.02, c: 1, s: '96 / 128 HP' }]), 128);
  assert.equal(readMaxHp([{ x: 0.4, y: 0.47, w: 0.2, h: 0.02, c: 1, s: '128 / 128 HP|' }]), 128);
  assert.equal(readMaxHp([{ x: 0.4, y: 0.47, w: 0.2, h: 0.02, c: 1, s: 'HEAVIEST' }]), undefined);
});

test('readSpeciesCaptions reads the species out of the caught-location caption', () => {
  const boxes = [
    { x: 0.28, y: 0.44, w: 0.44, h: 0.03, c: 1, s: '©Trevena91.1' }, // the nickname, ignored
    { x: 0.06, y: 0.92, w: 0.84, h: 0.02, c: 1, s: 'This Trevenant was caught on 10/21/2022' },
    { x: 0.06, y: 0.95, w: 0.67, h: 0.03, c: 1, s: 'around Olney, MD, United States.' },
  ];
  assert.deepEqual(readSpeciesCaptions(boxes), ['Trevenant']);
});

test('readSpeciesCaptions finds one caption per card on screen', () => {
  const boxes = [
    { x: 0.06, y: 0.92, w: 0.84, h: 0.02, c: 1, s: 'This Trevenant was caught on 10/21/2022' },
    { x: 0.06, y: 0.95, w: 0.8, h: 0.02, c: 1, s: 'This Feraligatr was caught on 9/23/2022' },
  ];
  assert.equal(readSpeciesCaptions(boxes).length, 2);
});

// --------------------------------------------------------------- species --

test('createCaptionResolver maps caption wording onto gamemaster species', () => {
  const resolve = createCaptionResolver();
  assert.deepEqual(resolve('Trevenant'), {
    speciesId: 'trevenant',
    name: 'Trevenant',
    shadow: false,
    purified: false,
  });
  assert.equal(resolve('Galarian Weezing').speciesId, 'weezing_galarian');
  assert.equal(resolve('Alolan Ninetales').speciesId, 'ninetales_alolan');
  assert.equal(resolve('Mr. Mime').speciesId, 'mr_mime');
});

test('createCaptionResolver reads shadow and purified off the caption', () => {
  const resolve = createCaptionResolver();
  assert.deepEqual(resolve('Shadow Machamp'), {
    speciesId: 'machamp',
    name: 'Machamp',
    shadow: true,
    purified: false,
  });
  const purified = resolve('Purified Shadow Machamp');
  assert.equal(purified.purified, true);
  assert.equal(purified.shadow, true);
});

test('createCaptionResolver returns null rather than guessing at a misread name', () => {
  assert.equal(createCaptionResolver()('Trevenanty Blurb'), null);
});

// ----------------------------------------------------------------- frame --

test('readFrame reads a recorded frame end to end', () => {
  const resolveCaption = createCaptionResolver();
  const { reading } = readFrame(frameAt(TREVENANT.t), { resolveCaption });
  assert.equal(reading.name, 'Trevenant');
  assert.equal(reading.cp, TREVENANT.cp);
  assert.equal(reading.maxHp, TREVENANT.maxHp);
  assert.deepEqual(reading.ivs, TREVENANT.ivs);
  assert.equal(reading.shadow, false);
});

test('readFrame rejects the recorded mid-swipe frames', () => {
  const resolveCaption = createCaptionResolver();
  const stillT = [TREVENANT.t, FERALIGATR.t].map((t) => frameAt(t).t);
  const transitions = FRAMES.filter((f) => !stillT.includes(f.t));
  assert.ok(transitions.length >= 2, 'fixture should contain mid-swipe frames');
  for (const frame of transitions) {
    const result = readFrame(frame, { resolveCaption });
    assert.equal(result.reading, null, `t=${frame.t} should be rejected`);
    assert.ok(result.reason);
  }
});

test('readFrame refuses a frame with two Pokemon on it', () => {
  const frame = structuredClone(frameAt(TREVENANT.t));
  frame.text.push({ x: 0.05, y: 0.42, w: 0.2, h: 0.03, c: 1, s: 'CP1122' });
  const result = readFrame(frame, { resolveCaption: createCaptionResolver() });
  assert.equal(result.reading, null);
  assert.match(result.reason, /mid-swipe/);
});

// ----------------------------------------------------------------- group --

const reading = (t, over = {}) => ({
  t,
  speciesId: 'trevenant',
  name: 'Trevenant',
  shadow: false,
  purified: false,
  cp: 1498,
  maxHp: 128,
  ivs: { atk: 8, def: 14, hp: 10 },
  deltas: [0.05, 0.02, 0.15],
  ...over,
});

test('groupReadings collapses a run of agreeing frames into one Pokemon', () => {
  const groups = groupReadings([0, 0.25, 0.5].map((t) => ({ t, reading: reading(t) })));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].frames, 3);
  assert.deepEqual(groups[0].ivs, { atk: 8, def: 14, hp: 10 });
});

test('groupReadings starts a new Pokemon when the reading changes', () => {
  const groups = groupReadings([
    { t: 0, reading: reading(0) },
    { t: 0.25, reading: null },
    { t: 0.5, reading: reading(0.5, { speciesId: 'feraligatr', name: 'Feraligatr' }) },
  ]);
  assert.deepEqual(
    groups.map((g) => g.name),
    ['Trevenant', 'Feraligatr']
  );
});

test('groupReadings takes the median when frames disagree on an IV', () => {
  const groups = groupReadings([
    { t: 0, reading: reading(0) },
    { t: 0.25, reading: reading(0.25, { ivs: { atk: 9, def: 14, hp: 10 } }) },
    { t: 0.5, reading: reading(0.5) },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ivs.atk, 8);
  assert.equal(groups[0].ivDisagreement, true);
});

test('groupReadings does not join two Pokemon across a long unreadable stretch', () => {
  const frames = [{ t: 0, reading: reading(0) }];
  for (let i = 1; i <= 5; i++) frames.push({ t: i * 0.25, reading: null });
  frames.push({ t: 1.5, reading: reading(1.5) });
  assert.equal(groupReadings(frames).length, 2);
});

test('mergeDuplicates silently rejoins one Pokemon split by a blink', () => {
  const groups = groupReadings([
    { t: 0, reading: reading(0) },
    ...Array.from({ length: 5 }, (_, i) => ({ t: 0.25 + i * 0.25, reading: null })),
    { t: 1.5, reading: reading(1.5) },
  ]);
  const { mons, merged } = mergeDuplicates(groups);
  assert.equal(mons.length, 1);
  assert.equal(mons[0].frames, 2);
  assert.deepEqual(merged, []);
});

test('mergeDuplicates reports a Pokemon the recording swiped back over', () => {
  const other = { speciesId: 'feraligatr', name: 'Feraligatr' };
  const { mons, merged } = mergeDuplicates(
    groupReadings([
      { t: 0, reading: reading(0) },
      { t: 0.25, reading: reading(0.25, other) },
      { t: 0.5, reading: reading(0.5) },
    ])
  );
  assert.equal(mons.length, 2);
  assert.deepEqual(merged, ['Trevenant']);
});

// ------------------------------------------------------------------- csv --

test('toCsv writes the generic collection format the importer already reads', () => {
  const csv = toCsv([
    { name: 'Trevenant', ivs: { atk: 8, def: 14, hp: 10 }, shadow: false, level: 21.5, cp: 1498 },
    { name: 'Machamp', ivs: { atk: 0, def: 15, hp: 15 }, shadow: true, cp: 1495 },
  ]);
  assert.equal(
    csv,
    'name,atk,def,sta,shadow,level,cp\n' + 'Trevenant,8,14,10,,21.5,1498\n' + 'Machamp,0,15,15,1,,1495\n'
  );
});

test('toCsv quotes a name containing a comma', () => {
  const csv = toCsv([{ name: 'Ho-Oh, sort of', ivs: { atk: 1, def: 2, hp: 3 }, shadow: false }]);
  assert.match(csv, /"Ho-Oh, sort of",1,2,3,,,/);
});

// ----------------------------------------------------------------- level --

test('createLevelDeriver solves the level the appraisal screen never states', async () => {
  const ctx = await initEngine();
  const deriveLevel = createLevelDeriver(ctx);

  for (const mon of [
    { speciesId: 'trevenant', ...TREVENANT },
    { speciesId: 'feraligatr', ...FERALIGATR },
  ]) {
    const fit = deriveLevel({ speciesId: mon.speciesId, ivs: mon.ivs, cp: mon.cp, maxHp: mon.maxHp });
    assert.equal(fit.status, 'exact', mon.speciesId);
    assert.equal(fit.level, mon.level, mon.speciesId);
  }
});

test('createLevelDeriver reports when no level can produce a scanned CP', async () => {
  const ctx = await initEngine();
  const deriveLevel = createLevelDeriver(ctx);
  // Same Trevenant, but with an attack IV that is off by one: CP 1498 is then
  // unreachable at any level, which is exactly the signal a misread bar gives.
  const fit = deriveLevel({
    speciesId: 'trevenant',
    ivs: { atk: 9, def: 14, hp: 10 },
    cp: 1498,
    maxHp: 128,
  });
  assert.equal(fit.status, 'none');
  assert.equal(fit.level, undefined);
});


// ---------------------------------------------- full-resolution footage --

test('classifyRun accepts the red Pokemon GO uses for a maxed stat', () => {
  // Red-for-15 is slightly *blue* of orange, so a naive r >= g >= b test
  // misses it and a maxed bar reads as an empty one.
  assert.equal(classifyRun([0, 130, 220, 126, 131]), 'fill');
  assert.equal(classifyRun([0, 130, 216, 127, 135]), 'fill');
});

test('readBarRow measures across the gaps between bar segments', () => {
  for (const iv of [0, 1, 5, 8, 10, 14, 15]) {
    const fillPx = Math.round((iv / 15) * BAR_W);
    const bar = readBarRow(segmentedBarRow(fillPx), FRAME_WIDTH);
    assert.ok(bar, `IV ${iv} should still read as one bar`);
    assert.equal(bar.width, BAR_W, `IV ${iv} width`);
    assert.equal(Math.round(bar.fraction * 15), iv, `IV ${iv}`);
  }
});

test('readBarRow still stops at a break too wide to be a segment gap', () => {
  // Two bar-coloured stretches, each too narrow to be an appraisal bar on its
  // own, with a real hole between them. Bridging that hole would invent a
  // 120px bar out of two unrelated shapes.
  const runs = [
    [0, BAR_X, ...WHITE],
    [BAR_X, 30, ...FILL],
    [BAR_X + 30, 60, ...WHITE], // a real hole, not a hairline
    [BAR_X + 90, 30, ...TRACK],
    [BAR_X + 120, 40, ...WHITE],
  ];
  assert.equal(readBarRow(runs, FRAME_WIDTH), null);
});

test('readAppraisal reads a full-resolution frame, red maxed bar included', () => {
  const frame = ULTRA_FRAMES.find((f) => f.t === CHANDELURE.t);
  const read = readAppraisal(frame.rows, frame.w);
  assert.deepEqual(read.ivs, CHANDELURE.ivs);
  for (const delta of read.deltas) assert.ok(delta < 0.25, `delta ${delta}`);
});

test('readFrame reads a frame whose CP the Pokemon is standing in front of', () => {
  const frame = ULTRA_FRAMES.find((f) => f.t === CHANDELURE.t);
  const { reading } = readFrame(frame, { resolveCaption: createCaptionResolver() });
  assert.equal(reading.name, 'Chandelure');
  assert.equal(reading.maxHp, CHANDELURE.maxHp);
  assert.deepEqual(reading.ivs, CHANDELURE.ivs);
  // What is on screen is "CP96": the 8 is behind a flame. The frame reports
  // that honestly rather than dropping out, and the CP is settled later.
  assert.equal(reading.cp, 96);
});

// -------------------------------------------------------------- CP vote --

test('chooseCp keeps a CP that was read and that the stats allow', () => {
  const chosen = chooseCp([{ value: 960, count: 5 }], [960, 968]);
  assert.deepEqual(chosen, { cp: 960, reconstructed: false });
});

test('chooseCp recovers a CP the animation cut short', () => {
  // "96" was read; only 960 both fits the stats and starts with it.
  assert.deepEqual(chooseCp([{ value: 96, count: 4 }], [960, 1122]), { cp: 960, reconstructed: true });
  // The cut can take the front instead of the back.
  assert.deepEqual(chooseCp([{ value: 498, count: 2 }], [2498, 1704]), { cp: 2498, reconstructed: true });
});

test('chooseCp takes the only possible CP when nothing legible was read', () => {
  assert.deepEqual(chooseCp([], [1498]), { cp: 1498, reconstructed: true });
});

test('chooseCp refuses to guess between equally possible CPs', () => {
  assert.equal(chooseCp([{ value: 7, count: 1 }], [1498, 1499]), null);
  assert.equal(chooseCp([{ value: 1498, count: 3 }], []), null);
});

// ---------------------------------------------- animating appraisal bars --

test('groupReadings keeps a Pokemon whole while its bars animate in', () => {
  // Pokemon GO fills the bars with an animation, so the first frame after a
  // swipe genuinely shows shorter bars than the real IVs.
  const animating = reading(0, { ivs: { atk: 4, def: 9, hp: 6 } });
  const settled = [1, 2, 3].map((t) => reading(t * 0.25));
  const groups = groupReadings([animating, ...settled].map((r) => ({ t: r.t, reading: r })));
  assert.equal(groups.length, 1, 'the animation must not split the Pokemon in two');
  assert.deepEqual(groups[0].ivs, { atk: 8, def: 14, hp: 10 });
  assert.equal(groups[0].ivDisagreement, true);
});

test('groupReadings ignores a flickering CP when deciding what is one Pokemon', () => {
  const groups = groupReadings(
    [reading(0), reading(0.25, { cp: 96 }), reading(0.5, { cp: undefined }), reading(0.75)].map((r) => ({
      t: r.t,
      reading: r,
    }))
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].cpVotes.map((v) => v.value),
    [1498, 96]
  );
});

test('groupReadings splits two Pokemon of one species by their max HP', () => {
  const groups = groupReadings(
    [reading(0), reading(0.25, { maxHp: 90, cp: 1200 })].map((r) => ({ t: r.t, reading: r }))
  );
  assert.equal(groups.length, 2);
});

// ------------------------------------------------------------ end to end --

test('scanFrames turns recorded frames into collection rows', async () => {
  const { mons, warnings } = await scanFrames(FRAMES);
  assert.deepEqual(
    mons.map((m) => [m.name, m.cp, m.level, m.ivs.atk, m.ivs.def, m.ivs.hp]),
    [
      ['Trevenant', 1498, 21.5, 8, 14, 10],
      ['Feraligatr', 1498, 20.5, 0, 5, 9],
    ]
  );
  // Only one frame of each Pokemon in this fixture is a still one, and the
  // scanner says so rather than presenting a one-frame read as settled.
  assert.equal(warnings.length, 2);
  for (const warning of warnings) assert.match(warning, /read from a single frame/);
});

test('scanFrames recovers an obscured CP and survives the bar animation', async () => {
  const { mons, warnings } = await scanFrames(ULTRA_FRAMES);
  assert.deepEqual(
    mons.map((m) => [m.name, m.cp, m.level, m.ivs.atk, m.ivs.def, m.ivs.hp]),
    [
      ['Chandelure', CHANDELURE.cp, CHANDELURE.level, 2, 7, 15],
      ['Stunfisk', STUNFISK.cp, STUNFISK.level, 15, 15, 12],
    ]
  );
  // The recovered CP is never silent -- it is reported so it can be checked.
  assert.ok(warnings.some((w) => /Chandelure.*animation covers it.*960/.test(w)), warnings.join('\n'));
});

test('createLevelDeriver can solve from max HP alone, listing the CPs it allows', async () => {
  const ctx = await initEngine();
  const deriveLevel = createLevelDeriver(ctx);
  const fit = deriveLevel({ speciesId: 'chandelure', ivs: CHANDELURE.ivs, maxHp: CHANDELURE.maxHp });
  assert.ok(fit.candidates.includes(CHANDELURE.level));
  assert.ok(fit.cps.includes(CHANDELURE.cp));
});

test('createLevelDeriver needs something to solve against', async () => {
  const ctx = await initEngine();
  const deriveLevel = createLevelDeriver(ctx);
  assert.throws(() => deriveLevel({ speciesId: 'trevenant', ivs: TREVENANT.ivs }), /cp, maxHp/);
});
