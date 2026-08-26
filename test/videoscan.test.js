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
import { countCpBoxes, readCp, readMaxHp, readSpeciesCaptions, readTypes, readsShadow } from '../src/videoscan/text.js';
import { createCaptionResolver } from '../src/videoscan/species.js';
import { createFormResolver, DEFAULT_FORMS } from '../src/videoscan/forms.js';
import { readFrame } from '../src/videoscan/frame.js';
import { readsPurifyButton } from '../src/videoscan/purify.js';
import { auraMeasure, auraVerdict } from '../src/videoscan/aura.js';
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
    candidates: [{ speciesId: 'trevenant', name: 'Trevenant', types: ['ghost', 'grass'] }],
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
    candidates: [{ speciesId: 'machamp', name: 'Machamp', types: ['fighting'] }],
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
  const singleFrame = warnings.filter((w) => /read from a single frame/.test(w));
  assert.equal(singleFrame.length, 2);
  // Every scan also states how much of its shadow column it actually
  // checked, and names the rows it could not check. These frames predate the
  // strip the button is read from, so neither Pokemon can be checked.
  const shadow = warnings.filter((w) => /^Shadow /.test(w));
  assert.deepEqual(
    shadow.map((w) => /^Shadow read/.test(w)),
    [true, false]
  );
  assert.match(shadow[1], /could NOT be read at all for 2 of 2 Pokemon/);
  assert.equal(warnings.length, singleFrame.length + shadow.length, warnings.join('\n'));
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

// ------------------------------------------------------------------ forms --

// Seven frames covering the four ways a form gets settled: a species with no
// unqualified gamemaster entry whose forms differ only by type (Oricorio), one
// the CP/HP arithmetic settles outright (Galarian Corsola), one nothing on
// screen can settle (Morpeko), and a mid-swipe frame whose caption and card
// are two different Pokemon (Honchkrow's caption over Omanyte's card).
const FORM_FRAMES = readFrames('form-frames.jsonl');
const scanForms = () => scanFrames(FORM_FRAMES);

test('readTypes reads the badge row however Vision truncates it', () => {
  const card = (...badges) => [
    { x: 0.42, y: 0.469, w: 0.17, h: 0.02, c: 1, s: '101 / 101 HP' },
    ...badges.map((s, i) => ({ x: 0.2 + i * 0.2, y: 0.565, w: 0.1, h: 0.02, c: 1, s })),
  ];
  assert.deepEqual(readTypes(card('GHOST')), ['ghost']);
  // A dot-below on the O, a three-letter stump, and a dual type in one box.
  assert.deepEqual(readTypes(card('GHỌ')), ['ghost']);
  assert.deepEqual(readTypes(card('ROC')), ['rock']);
  assert.deepEqual(readTypes(card('ROCK / WATER|')), ['rock', 'water']);
});

test('readTypes ignores the labels that share the badge row', () => {
  const boxes = [
    { x: 0.42, y: 0.469, w: 0.17, h: 0.02, c: 1, s: '101 / 101 HP' },
    { x: 0.13, y: 0.565, w: 0.14, h: 0.02, c: 1, s: 'HEAVIEST' },
    { x: 0.4, y: 0.565, w: 0.12, h: 0.02, c: 1, s: 'DARK' },
    { x: 0.8, y: 0.565, w: 0.14, h: 0.02, c: 1, s: 'SHORTEST' },
    { x: 0.15, y: 0.663, w: 0.2, h: 0.02, c: 1, s: 'STARDUST' },
  ];
  assert.deepEqual(readTypes(boxes), ['dark']);
});

test('readTypes needs the HP text to know where the badge row is', () => {
  assert.deepEqual(readTypes([{ x: 0.4, y: 0.565, w: 0.12, h: 0.02, c: 1, s: 'DARK' }]), []);
});

test('createFormResolver lists the forms a bare species name could mean', () => {
  const forms = createFormResolver();
  // The unqualified entry first: an ordinary Rattata is likelier than an
  // Alolan one, and it is what the caption literally said.
  assert.deepEqual(
    forms.byName('Raticate').map((f) => f.speciesId),
    ['raticate', 'raticate_alolan']
  );
  // No unqualified entry exists, so the documented default leads instead.
  assert.equal(forms.byName('Morpeko')[0].speciesId, DEFAULT_FORMS.morpeko);
  assert.equal(forms.byName('Lycanroc')[0].speciesId, DEFAULT_FORMS.lycanroc);
  assert.equal(forms.byName('Nidoran').length, 0);
});

test('createFormResolver leaves out forms you could never have caught', () => {
  const ids = (name) => createFormResolver().byName(name).map((f) => f.speciesId);
  // Megas are a battle transformation ...
  assert.deepEqual(ids('Charizard'), ['charizard']);
  // ... and `lanturnw` is pvpoke's second copy of Lanturn for an alternative
  // moveset, not a form of anything.
  assert.deepEqual(ids('Lanturn'), ['lanturn']);
});

test('createCaptionResolver offers every form a bare caption could mean', () => {
  const resolve = createCaptionResolver();
  assert.deepEqual(
    resolve('Corsola').candidates.map((c) => c.speciesId),
    ['corsola', 'corsola_galarian']
  );
  // A caption that named the form for itself leaves nothing to settle.
  assert.deepEqual(
    resolve('Galarian Corsola').candidates.map((c) => c.speciesId),
    ['corsola_galarian']
  );
});

test('createCaptionResolver keeps a species gamemaster only knows by its forms', () => {
  // These used to be dropped as "unrecognized species": gamemaster has no
  // unqualified "Oricorio", only its four dance forms.
  const oricorio = createCaptionResolver()('Oricorio');
  assert.equal(oricorio.candidates.length, 4);
  assert.ok(oricorio.candidates.every((c) => c.speciesId.startsWith('oricorio_')));
});

test('scanFrames settles a form the caption never states from the CP and HP', async () => {
  const { mons } = await scanForms();
  const corsola = mons.find((m) => /Corsola/.test(m.name));
  // Read off the screen: CP 831, 101 max HP, 13/10/15. No level of an
  // ordinary Corsola produces those; a Galarian one does, at level 20.
  assert.equal(corsola.speciesId, 'corsola_galarian');
  assert.equal(corsola.cp, 831);
  assert.equal(corsola.level, 20);
});

test('scanFrames settles stat-identical forms by the type badge on the card', async () => {
  const { mons, warnings } = await scanForms();
  const oricorio = mons.find((m) => /Oricorio/.test(m.name));
  // All four Oricorio are 196/145/181, so the numbers cannot choose; the
  // electric badge means this is the Pom-Pom one.
  assert.equal(oricorio.speciesId, 'oricorio_pom_pom');
  assert.deepEqual(oricorio.types, ['electric']);
  assert.ok(
    warnings.some((w) => /Oricorio \(Pom-Pom\).*electric.*badge/.test(w)),
    warnings.join('\n')
  );
});

test('scanFrames says so when nothing on screen can pick the form', async () => {
  const { mons, warnings } = await scanForms();
  const morpeko = mons.find((m) => /Morpeko/.test(m.name));
  // Full Belly and Hangry are identical in stats and in type, so the row is
  // written as the form Pokemon GO stores and the guess is declared.
  assert.equal(morpeko.speciesId, 'morpeko_full_belly');
  assert.ok(
    warnings.some((w) => /Morpeko \(Full Belly\).*nothing on screen separates/.test(w)),
    warnings.join('\n')
  );
});

test('readFrame rejects a frame whose caption and card are different Pokemon', () => {
  const resolveCaption = createCaptionResolver();
  // Mid-swipe: Honchkrow's caption has scrolled in over Omanyte's card, and
  // Omanyte's CP text is already too mangled for the two-CP check to catch.
  const midSwipe = FORM_FRAMES.find((f) => Math.abs(f.t - 219.3333) < 0.01);
  const result = readFrame(midSwipe, { resolveCaption });
  assert.equal(result.reading, null);
  assert.match(result.reason, /type badge/);
});

test('scanFrames does not invent a Pokemon out of a mid-swipe frame', async () => {
  const { mons } = await scanForms();
  // One Honchkrow, at the CP and HP its own card showed -- not a second,
  // CP-less one carrying the HP of the card it was swiping past.
  const honchkrow = mons.filter((m) => /Honchkrow/.test(m.name));
  assert.equal(honchkrow.length, 1);
  assert.deepEqual(
    { cp: honchkrow[0].cp, maxHp: honchkrow[0].maxHp, level: honchkrow[0].level },
    { cp: 1143, maxHp: 123, level: 15 }
  );
});

// Four frames from the one place in either recording where the appraisal
// panel was slid shut: a shadow Exploud, and the Morpeko swiped past just
// before it (which must not catch the marker).
const SHADOW_FRAMES = readFrames('shadow-frames.jsonl');

test('readsShadow finds the markings Pokemon GO only draws behind the appraisal panel', () => {
  const box = (s) => ({ x: 0.5, y: 0.5, w: 0.1, h: 0.02, c: 1, s });
  assert.equal(readsShadow([box('PURIFY'), box('POWER UP')]), true);
  assert.equal(readsShadow([box('Bite'), box('SHADOW BONUS')]), true);
  // Vision cuts the button text short on the frames where it is animating.
  assert.equal(readsShadow([box('PURIF')]), true);
  // An ordinary appraisal frame says nothing either way -- of a shadow
  // Pokemon as much as any other.
  assert.equal(readsShadow([box('CP807'), box('115 / 115 HP'), box('Attack')]), false);
});

// Real pixels off the two test recordings: for purify.js the sliver of page
// above the appraisal panel, for aura.js the four background patches, one
// entry per frame of the card. Each Pokemon here has an answer that does not
// come from the code under test -- the button says so outright, or the aura
// is plain to see in the frame.
const SIGNALS = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/videoscan/shadow-signals.json'), 'utf8'));
const verdict = (name) => auraVerdict(SIGNALS.aura[name].frames.map(auraMeasure));

test('readsPurifyButton tells PURIFY from POWER UP through the appraisal panel', () => {
  // The band is eight pixels tall under a cream veil and carries no legible
  // text at all; what is left is that PURIFY is pink and POWER UP is green.
  assert.equal(readsPurifyButton(SIGNALS.button.pink.strip), true);
  assert.equal(readsPurifyButton(SIGNALS.button.green.strip), false);
  // Scrolled past the buttons there is nothing to read, and saying "not
  // shadow" here would be a guess dressed as a reading.
  assert.equal(readsPurifyButton(SIGNALS.button.hidden.strip), undefined);
  assert.equal(readsPurifyButton(undefined), undefined);
});

test('auraVerdict finds the smoke around a shadow whose button never showed', () => {
  // Gallade's page is scrolled past its buttons on every frame, so the aura
  // is the only thing left that knows. Mewtwo is the same case on a white
  // background rather than a dark one.
  assert.equal(verdict('gallade'), true);
  assert.equal(verdict('mewtwo'), true);
  // Muk fills its own frame, leaving no background beside it to darken --
  // caught by the blue in the smoke instead (see aura.js).
  assert.equal(verdict('muk'), true);
  // That second route is for a collapsed measurement, not a second chance:
  // this Rapidash is as blue as Muk on a violet background, darkens like any
  // ordinary card, and is not shadow.
  assert.equal(verdict('rapidash'), false);
  assert.equal(auraVerdict([]), undefined);
});

test('auraVerdict is not fooled by a purple Pokemon or a purple background', () => {
  // The three hardest ordinary Pokemon in 231: a violet Sableye on near
  // black, a violet Weezing on a night sky, and a Braviary lit magenta from
  // behind -- the closest any of them came to reading as shadow.
  assert.equal(verdict('sableye'), false);
  assert.equal(verdict('weezing'), false);
  assert.equal(verdict('braviary'), false);
});

test('scanFrames reads shadow off the frames it cannot read as an appraisal', async () => {
  const { mons } = await scanFrames(SHADOW_FRAMES);
  // The frames that say PURIFY / SHADOW BONUS have no bars AND no
  // caught-location caption, so every one of them is rejected as a reading.
  // The CP and max HP still on screen are what tie the marker back to the
  // Exploud read a few frames earlier.
  const exploud = mons.find((m) => /Exploud/.test(m.name));
  assert.equal(exploud.shadow, true);
  assert.equal(exploud.cp, 807);

  // The Pokemon on screen immediately before it does not catch the marker.
  const morpeko = mons.find((m) => /Morpeko/.test(m.name));
  assert.equal(morpeko.shadow, false);
});
