// JavaScript Document
//
// Reads shadow off the appraisal screen itself, from the one sliver of the
// Pokemon's own page the appraisal panel does not cover.
//
// Pokemon GO's detail page puts a row of action buttons under the
// stardust/candy line. A shadow Pokemon has two, PURIFY above POWER UP; an
// ordinary one has only POWER UP. Either way the topmost of them lands just
// above the appraisal panel, so a few pixels of it stay on screen while the
// bars are being read -- pink for PURIFY, green for POWER UP. That single
// band is the only thing on an appraisal frame that states shadow, and it
// states it both ways: pink means shadow, green means not.
//
// It is read from colour rather than from the word on the button because at
// this size there is no word left. The band is eight pixels tall on a
// 384-wide recording and the panel lays a heavy cream veil over it; Vision
// finds no text there at all. Two flat colours are still two flat colours.
//
// The veil is the reason nothing here uses an absolute colour. It is not
// uniform -- how much of the page it dims varies from card to card -- so the
// button band is always compared against a reference band of bare veil a
// little above it, and only the *difference* is judged.

/**
 * How the strip's landmarks sit relative to each other, as fractions of the
 * strip's own height so a full-resolution recording and a downscaled one
 * measure the same thing.
 */
const WHITE_RUN = 0.12; // the appraisal panel is at least this much of the strip
const REF_BAND = [0.102, 0.072]; // bare veil, above the buttons
const BTN_BAND = [0.066, 0.024]; // where the topmost button shows
/** A row this bright, and this close to neutral, is the appraisal panel. */
const PANEL_MIN = [240, 240, 236];
/**
 * How far the band's red-minus-green has to move away from the veil's before
 * the band is called a button. Measured across 393 Pokemon in two
 * recordings: PURIFY lands at +16 to +19, POWER UP at -15 to -19, and a
 * frame whose buttons are hidden sits between -4 and +4.
 */
const PINK_SHIFT = 6;
const GREEN_SHIFT = -8;
/**
 * PURIFY on its own is unmistakably pink, but on a Pokemon too expensive to
 * purify the button is drawn greyed out and the pink is faint. What survives
 * either way is that red stays clear of green in absolute terms, which the
 * cream of a hidden-button frame never manages.
 */
const PINK_MIN_RG = 30;
const GREEN_MAX_RG = 15;

const mean = (rows, a, b) => {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(rows.length - 1, Math.max(a, b));
  const out = [0, 0, 0];
  let n = 0;
  for (let y = lo; y <= hi; y++) {
    for (let i = 0; i < 3; i++) out[i] += rows[y][i];
    n++;
  }
  return n ? out.map((v) => v / n) : undefined;
};

/**
 * Find the top edge of the appraisal panel: the first row that begins a run
 * of near-white long enough to be the panel rather than a white patch of the
 * card behind it (the stardust row reads white too, for a Pokemon whose
 * candy count is short enough to leave the middle of the row empty).
 *
 * @param {number[][]} rows
 * @returns {number} row index, or -1
 */
function panelTop(rows) {
  const run = Math.max(4, Math.round(WHITE_RUN * rows.length));
  const white = (c) => c[0] >= PANEL_MIN[0] && c[1] >= PANEL_MIN[1] && c[2] >= PANEL_MIN[2];
  for (let y = 0; y + run < rows.length; y++) {
    let ok = true;
    for (let k = 0; k < run; k++) {
      if (!white(rows[y + k])) {
        ok = false;
        y += k; // nothing before the offending row can start a run either
        break;
      }
    }
    if (ok) return y;
  }
  return -1;
}

/**
 * Is the Pokemon on this frame shadow, according to its action button?
 *
 * @param {number[][]} [strip] - one mean [r,g,b] per row of STRIP_REGION.
 * @returns {boolean|undefined} true for PURIFY, false for POWER UP, and
 *   undefined when the frame does not show the band at all -- which happens
 *   whenever the page behind the panel is scrolled far enough that the
 *   buttons sit under it. Never guess from undefined: roughly a third of the
 *   frames of a normal recording land that way.
 */
export function readsPurifyButton(strip) {
  if (!Array.isArray(strip) || strip.length < 40) return undefined;
  const rows = strip;
  const top = panelTop(rows);
  const need = Math.round(REF_BAND[0] * rows.length);
  if (top < need) return undefined;

  const off = (f) => top - Math.round(f * rows.length);
  const ref = mean(rows, off(REF_BAND[0]), off(REF_BAND[1]));
  // The reference has to be veil: bright, and warm in the veil's own order.
  if (!ref || ref[0] < 200 || ref[0] <= ref[1] || ref[1] <= ref[2]) return undefined;

  // The whole band is averaged rather than its most extreme row. A button
  // fills every row of it, so the mean loses nothing; a frame with no button
  // has one or two rows of card text passing through, and picking the
  // extreme row turns that text into a verdict.
  const band = mean(rows, off(BTN_BAND[0]), off(BTN_BAND[1]));
  if (!band) return undefined;

  const rg = band[0] - band[1];
  const shift = rg - (ref[0] - ref[1]);
  if (shift >= PINK_SHIFT && rg >= PINK_MIN_RG) return true;
  if (shift <= GREEN_SHIFT && rg <= GREEN_MAX_RG) return false;
  return undefined;
}
