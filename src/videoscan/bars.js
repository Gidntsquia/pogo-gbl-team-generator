// JavaScript Document
//
// Appraisal-bar reader: turns the run-length-encoded pixel rows produced by
// scan.swift into the three 0-15 IVs Pokemon GO draws as Attack / Defense /
// HP bars on the appraisal screen.
//
// Everything here is pure -- it takes plain run arrays, so every rule below
// is unit-testable against a recorded frame fixture with no video, no Swift,
// and no screen involved (test/videoscan.test.js).
//
// A run is [x, length, r, g, b], and scan.swift guarantees the runs of one
// row tile that row's x span with no holes. That gapless property is what
// makes the measurement below a simple ratio: the appraisal bar is drawn as
// three equal segments with hairline gaps between them, and those gaps are
// small and evenly spaced enough that (filled px / total bar px) * 15 lands
// within ~0.2 of the true integer IV at every value from 0 to 15.

/** Minimum bar width, as a fraction of the frame width. */
const MIN_BAR_FRACTION = 0.12;
/**
 * The bar is drawn as three segments with a hairline of card background
 * between them. At phone resolution that hairline is a handful of pixels, so
 * a break this narrow is part of the bar rather than the end of it.
 */
const MAX_SEGMENT_GAP_FRACTION = 0.012;
/**
 * Rows in one band must agree on left edge / width to this many pixels --
 * scaled to the frame, because a bar's anti-aliased ends wander by more
 * pixels on a full-resolution phone recording than on a downscaled one.
 */
const BAND_X_TOLERANCE_FRACTION = 0.006;
const BAND_WIDTH_TOLERANCE_FRACTION = 0.008;
const bandTolerances = (frameWidth) => ({
  x: Math.max(3, Math.round(BAND_X_TOLERANCE_FRACTION * frameWidth)),
  width: Math.max(4, Math.round(BAND_WIDTH_TOLERANCE_FRACTION * frameWidth)),
});
/** A band needs at least this many rows to be a bar rather than a stray line. */
const MIN_BAND_ROWS = 3;
/** How far a measured IV may sit from a whole number before we flag it. */
export const IV_SNAP_WARN = 0.32;

/**
 * @typedef {[number, number, number, number, number]} Run [x, length, r, g, b]
 */

/**
 * Classify one run as the bar's filled part, its empty track, or neither.
 *
 * `fill` is warm and strongly non-neutral. Pokemon GO draws it orange
 * (~rgb(240,165,78)) for most stats but switches to red (~rgb(220,126,131))
 * for a stat that is maxed at 15 -- both are matched here, which is why the
 * test is "red channel dominant and far from grey" rather than anything
 * specific to orange. Note red-for-maxed is slightly *blue* of orange
 * (b > g), so the check must not require r >= g >= b.
 *
 * `track` is the flat light grey behind the fill. Everything else -- the
 * white card, the hairline between bar segments, the green health bar under
 * the nickname, artwork -- is `other` and can never be part of a bar.
 *
 * @param {Run} run
 * @returns {'fill'|'track'|'other'}
 */
export function classifyRun(run) {
  const [, , r, g, b] = run;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (r > 150 && r >= g && r - Math.min(g, b) >= 60) return 'fill';
  if (max - min <= 24 && r >= 190 && r <= 243) return 'track';
  return 'other';
}

/**
 * Measure the single widest bar in one row of runs.
 *
 * A bar is a chain of fill/track runs, optionally broken by the hairline gaps
 * between its three segments, in which every fill run precedes every track
 * run. Pokemon GO fills these bars strictly left to right, so a chain that
 * alternates is some other UI element (or a misread) and is rejected rather
 * than guessed at.
 *
 * The filled amount is measured by *position* -- how far along the bar the
 * fill reaches -- not by summing filled pixels, so the segment gaps swallowed
 * inside the filled part are counted exactly as the game draws them.
 *
 * @param {Run[]} runs - one row, in ascending x.
 * @param {number} frameWidth
 * @returns {{x0: number, x1: number, width: number, fillEnd: number, fraction: number}|null}
 */
export function readBarRow(runs, frameWidth) {
  const minWidth = Math.max(12, Math.round(MIN_BAR_FRACTION * frameWidth));
  const maxGap = Math.max(3, Math.round(MAX_SEGMENT_GAP_FRACTION * frameWidth));
  let best = null;
  let chain = [];
  let pendingGap = [];

  const flush = () => {
    if (chain.length) {
      const measured = measureChain(chain);
      if (measured && measured.width >= minWidth && (!best || measured.width > best.width)) {
        best = measured;
      }
    }
    chain = [];
    pendingGap = [];
  };

  for (const run of runs) {
    const kind = classifyRun(run);
    if (kind === 'other') {
      // A narrow break mid-bar is a segment divider; hold it, and keep it
      // only if the bar turns out to continue past it.
      if (chain.length && run[1] <= maxGap) pendingGap.push(run);
      else flush();
      continue;
    }
    // The last pixel seen so far is the held-back gap when there is one --
    // not the last accepted run, or every segment divider would look like a
    // hole in the bar and cut it short.
    const tail = pendingGap.length ? pendingGap[pendingGap.length - 1] : chain[chain.length - 1];
    // scan.swift emits gapless runs, but be explicit: a chain must be
    // physically contiguous, never two bars merged across a hole.
    if (tail && tailEnd(tail) !== run[0]) flush();
    for (const gap of pendingGap) chain.push({ run: gap, kind: 'gap' });
    pendingGap = [];
    chain.push({ run, kind });
  }
  flush();
  return best;
}

const tailEnd = (entry) => (Array.isArray(entry) ? entry[0] + entry[1] : entry.run[0] + entry.run[1]);

function measureChain(chain) {
  let seenTrack = false;
  let fillEnd = chain[0].run[0];
  for (const { run, kind } of chain) {
    if (kind === 'fill') {
      if (seenTrack) return null; // fill after track: not a left-to-right bar
      fillEnd = run[0] + run[1];
    } else if (kind === 'track') {
      seenTrack = true;
    }
  }
  const x0 = chain[0].run[0];
  const last = chain[chain.length - 1].run;
  const x1 = last[0] + last[1];
  const width = x1 - x0;
  if (width <= 0) return null;
  return { x0, x1, width, fillEnd, fraction: (fillEnd - x0) / width };
}

/**
 * Collect measured rows into vertical bands -- one band per drawn bar.
 *
 * @param {{y: number, runs: Run[]}[]} rows - as emitted by scan.swift.
 * @param {number} frameWidth
 * @returns {{yStart: number, yEnd: number, x0: number, width: number, rows: number, fraction: number}[]}
 */
export function findBands(rows, frameWidth) {
  const tolerance = bandTolerances(frameWidth);
  const bands = [];
  let current = null;

  for (const row of [...rows].sort((a, b) => a.y - b.y)) {
    const bar = readBarRow(row.runs, frameWidth);
    if (!bar) {
      current = null;
      continue;
    }
    // Compared against the *previous row*, not the band's first row: a bar's
    // top and bottom rows are anti-aliased and read a few pixels narrow, so a
    // band's measured width drifts smoothly from one row to the next. Anchor
    // the test to the first row and those edge rows split off into bands of
    // their own -- which then look exactly like a second panel of bars.
    const contiguous =
      current &&
      row.y - current.yEnd <= 2 &&
      Math.abs(bar.x0 - current.x0) <= tolerance.x &&
      Math.abs(bar.width - current.width) <= tolerance.width;
    if (contiguous) {
      current.yEnd = row.y;
      current.x0 = bar.x0;
      current.width = bar.width;
      current.fractions.push(bar.fraction);
    } else {
      current = { yStart: row.y, yEnd: row.y, x0: bar.x0, width: bar.width, fractions: [bar.fraction] };
      bands.push(current);
    }
  }

  return bands
    .filter((b) => b.fractions.length >= MIN_BAND_ROWS)
    .map((b) => ({
      yStart: b.yStart,
      yEnd: b.yEnd,
      x0: b.x0,
      width: b.width,
      rows: b.fractions.length,
      // Median, not mean: the top and bottom rows of a bar are anti-aliased
      // and read a little short, and a median ignores them outright.
      fraction: median(b.fractions),
    }));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Read the three appraisal IVs out of one frame's rows.
 *
 * The three bars are the only trio of same-width, same-left-edge bands on the
 * screen, and Pokemon GO always draws them top-to-bottom as Attack, Defense,
 * HP -- so once the trio is isolated, the order is the labelling. (The green
 * health bar under the nickname is a different width at a different x, and
 * is not orange, so it never joins the trio.)
 *
 * @param {{y: number, runs: Run[]}[]} rows
 * @param {number} frameWidth
 * @returns {{ivs: {atk: number, def: number, hp: number}, deltas: number[], bands: object[]}|null}
 *   null when the frame does not show a readable appraisal panel.
 */
export function readAppraisal(rows, frameWidth) {
  const bands = findBands(rows, frameWidth);
  if (bands.length < 3) return null;

  const trio = pickTrio(bands, bandTolerances(frameWidth));
  if (!trio) return null;

  const values = trio.map((b) => b.fraction * 15);
  const ivs = values.map((v) => Math.min(15, Math.max(0, Math.round(v))));
  const deltas = values.map((v, i) => Math.abs(v - ivs[i]));
  return {
    ivs: { atk: ivs[0], def: ivs[1], hp: ivs[2] },
    deltas,
    bands: trio,
  };
}

/**
 * Pick the three bands that are the appraisal bars: same left edge, same
 * width, stacked. Returns them in top-to-bottom order, or null when no such
 * trio exists (or when more than one trio's worth of matching bands is on
 * screen, which happens mid-swipe with two cards visible and must not be
 * read as one Pokemon).
 */
function pickTrio(bands, tolerance) {
  const groups = [];
  for (const band of bands) {
    const group = groups.find(
      (g) =>
        Math.abs(g[0].x0 - band.x0) <= tolerance.x &&
        Math.abs(g[0].width - band.width) <= tolerance.width
    );
    if (group) group.push(band);
    else groups.push([band]);
  }
  const candidates = groups.filter((g) => g.length === 3);
  if (candidates.length !== 1) return null;
  return candidates[0].sort((a, b) => a.yStart - b.yStart);
}
