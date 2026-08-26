// JavaScript Document
//
// Reads shadow off the purple smoke Pokemon GO draws around a shadow
// Pokemon, for the Pokemon whose PURIFY / POWER UP button is hidden behind
// the appraisal panel and so cannot be read by purify.js.
//
// The aura is the obvious thing to a person looking at the screen and the
// hardest thing to measure, because none of what makes it obvious survives
// on its own:
//
//  - Not its colour. GO's detail-page backgrounds cycle through a purple
//    night sky, a navy dusk and a tan afternoon; a violet background is
//    ordinary, and Gengar, Espeon, Muk and Nidoking are violet Pokemon.
//  - Not darkness alone. Half the backgrounds are dark.
//  - Not movement. Water and rain backgrounds are animated.
//
// What does survive is that the aura is *local*. The background is a smooth
// vertical gradient, so on an ordinary card the strip beside the Pokemon's
// feet is the same hue and much the same brightness as the strip below the
// CP text, whatever those are. The aura sits only around the Pokemon, and it
// both darkens the background there and pushes it towards blue. So every
// measurement here is a comparison of two places on the same frame, never an
// absolute colour -- which is what lets it survive a purple background and a
// purple Pokemon at once.
//
// Measured against the 257 Pokemon in this project's two test recordings
// whose button could be read, and which therefore have an answer that does
// not come from this file: 26 shadow, 231 not. Every one of them is called
// correctly, as is the one Pokemon out of the remaining 136 that Jaxon has
// since checked by hand and found this file had wrong (see BLUE_MIN).

/**
 * How much a point of blue shift is worth against a point of darkening,
 * with darkening as a 0..1 fraction. Both halves are needed -- blue shift
 * alone confuses a shadow with Weezing on a night sky, darkening alone
 * confuses one with any dark background -- and this is the ratio that opens
 * the widest gap between the two populations.
 */
const DARK_WEIGHT = 320;

/**
 * Above this, every one of the 257 was shadow; the highest ordinary Pokemon
 * reached 228 and the lowest shadow kept 240.
 */
export const SHADOW_MIN = 234;

/**
 * The one case the score alone gets wrong, and the way back.
 *
 * A Pokemon whose sprite fills the frame -- Muk is the case in these
 * recordings -- leaves no background beside its feet to measure, so the
 * lower boxes land on the Pokemon itself. The darkening then collapses even
 * though the aura is plainly there, and the score is measuring the wrong
 * thing. What still shows is the blue: the smoke tints the sprite's own
 * edges too, further than any of the 231 ordinary Pokemon managed (the
 * highest was 64, a Hisuian Braviary lit magenta from behind).
 *
 * The collapsed darkening is what makes this branch apply, not a second
 * chance for any Pokemon the score turned down. A card whose darkening came
 * out in the ordinary range had real background in its boxes, so the score
 * measured what it was meant to and its answer stands -- which is what keeps
 * a Galarian Rapidash, blue-shifted to 68 on a violet background but
 * darkened a perfectly ordinary 0.48, from being called shadow.
 *
 * With this branch the rule gets all 26 shadows and none of the 231
 * ordinary Pokemon whose button could be read, plus the Rapidash.
 */
const BLUE_MIN = 68;
const BLUE_DARKENING = [0.3, 0.43];

/**
 * Measure one frame's aura.
 *
 * @param {number[][]} [boxes] - the four means of probe.js's AURA_BOXES:
 *   background left and right below the CP text, then left and right beside
 *   the Pokemon's feet.
 * @returns {{blueShift: number, darkening: number}|undefined} undefined when
 *   the frame carries no boxes.
 */
export function auraMeasure(boxes) {
  if (!Array.isArray(boxes) || boxes.length < 4) return undefined;
  const pair = (a, b) => [0, 1, 2].map((i) => (boxes[a][i] + boxes[b][i]) / 2);
  const ref = pair(0, 1);
  const ring = pair(2, 3);
  const sum = (c) => c[0] + c[1] + c[2];
  return {
    // Blue measured against green rather than against the whole colour: of
    // the three channel pairs it is the one a dim background moves least.
    blueShift: ring[2] - ring[1] - (ref[2] - ref[1]),
    darkening: 1 - sum(ring) / (sum(ref) + 1),
  };
}

/**
 * Decide shadow for one Pokemon from the aura of all its frames.
 *
 * Each quantity is medianed over the frames before the rule is applied, not
 * after: a frame caught as the card slides carries a piece of the
 * neighbouring Pokemon's background, and one such frame drags a mean across
 * a threshold while it cannot move a median past the frames either side.
 *
 * @param {({blueShift: number, darkening: number}|undefined)[]} measures
 * @returns {boolean|undefined} undefined only when no frame could be
 *   measured at all.
 */
export function auraVerdict(measures) {
  const ok = measures.filter((m) => m && Number.isFinite(m.blueShift) && Number.isFinite(m.darkening));
  if (ok.length === 0) return undefined;
  const median = (pick) => {
    const v = ok.map(pick).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const blueShift = median((m) => m.blueShift);
  const darkening = median((m) => m.darkening);
  if (blueShift + DARK_WEIGHT * darkening >= SHADOW_MIN) return true;
  const collapsed = darkening >= BLUE_DARKENING[0] && darkening <= BLUE_DARKENING[1];
  return collapsed && blueShift >= BLUE_MIN;
}
