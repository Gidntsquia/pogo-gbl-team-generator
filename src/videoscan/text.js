// JavaScript Document
//
// Pulls the fields the appraisal screen states in words -- CP, species, and
// current/max HP -- out of one frame's OCR boxes. Pure: it takes the plain
// text boxes scan.swift emits and never touches a video or the filesystem.
//
// The species comes from the caught-location caption at the bottom of the
// screen ("This Trevenant was caught on 10/21/2022 around ..."), NOT from the
// name shown above the stats: that name is the *nickname*, and a PvP player's
// nicknames are usually rank percentages ("Trevena91.1"), not species.

/** Vision reads the (c) form badge and stray glyphs into the caption; drop them. */
const CAPTION_RE = /\bthis\s+(.+?)\s+(?:was|is|were)\b/i;
const CP_RE = /^cp\s*([0-9]{1,5})$/i;
const HP_RE = /^([0-9]{1,4})\s*[/|]\s*([0-9]{1,4})\s*hp\b/i;

/** pvpoke gamemaster type names, as printed on the appraisal screen badges. */
const POKEMON_TYPES = [
  'normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground',
  'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy',
];
/**
 * How far below the HP text the type badges sit, as a fraction of frame
 * height. Measured at 0.10 on a downscaled 384x832 recording and 0.14 on a
 * full-resolution 1206x2622 one (which fits an extra league tag in between);
 * 0.16 clears both and still stops above the stardust/candy row.
 */
const TYPE_BAND_DEPTH = 0.16;

/**
 * @typedef {{x: number, y: number, w: number, h: number, c: number, s: string}} TextBox
 *   x/y/w/h normalized 0-1 with a TOP-LEFT origin.
 */

function clean(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Read the CP shown above the Pokemon.
 *
 * Vision usually returns "CP1498" as one box; when the label and the number
 * land in separate boxes we join a bare "CP" with the nearest number box on
 * the same line. Whichever candidate sits highest on screen wins -- mid-swipe
 * there can be a second, outgoing card lower down.
 *
 * @param {TextBox[]} boxes
 * @returns {number|undefined}
 */
export function readCp(boxes) {
  const candidates = [];
  for (const box of boxes) {
    const m = CP_RE.exec(clean(box.s).replace(/\s+/g, ''));
    if (m) candidates.push({ y: box.y, cp: Number(m[1]) });
  }
  if (candidates.length === 0) {
    for (const label of boxes) {
      if (!/^cp$/i.test(clean(label.s))) continue;
      const number = boxes.find(
        (b) => b !== label && /^[0-9]{1,5}$/.test(clean(b.s)) && Math.abs(b.y - label.y) < label.h
      );
      if (number) candidates.push({ y: label.y, cp: Number(clean(number.s)) });
    }
  }
  candidates.sort((a, b) => a.y - b.y);
  const cp = candidates[0]?.cp;
  return Number.isFinite(cp) && cp > 0 && cp < 10000 ? cp : undefined;
}

/**
 * How many separate CP readings the frame contains. Two means two cards are
 * on screen at once (mid-swipe) and nothing in the frame can be trusted to
 * belong to a single Pokemon.
 *
 * @param {TextBox[]} boxes
 * @returns {number}
 */
export function countCpBoxes(boxes) {
  return boxes.filter((b) => CP_RE.test(clean(b.s).replace(/\s+/g, ''))).length;
}

/**
 * Read max HP ("128 / 128 HP"). Used only to cross-check the IV reading
 * against a derived level, never as an IV itself.
 *
 * @param {TextBox[]} boxes
 * @returns {number|undefined}
 */
export function readMaxHp(boxes) {
  for (const box of boxes) {
    const m = HP_RE.exec(clean(box.s));
    if (m) {
      const max = Number(m[2]);
      if (max > 0 && max < 1000) return max;
    }
  }
  return undefined;
}

/**
 * Read the species out of the caught-location caption.
 *
 * Returns the raw caption words (e.g. "Trevenant", "Galarian Weezing",
 * "Shadow Machamp") -- turning those into a gamemaster species is
 * species.js's job.
 *
 * @param {TextBox[]} boxes
 * @returns {string[]} one entry per caption found, in reading order. More
 *   than one means two cards are on screen.
 */
export function readSpeciesCaptions(boxes) {
  const found = [];
  for (const box of boxes) {
    const m = CAPTION_RE.exec(clean(box.s));
    if (!m) continue;
    const words = m[1]
      .replace(/[^\p{L}\p{N}'.\-’ ]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (words) found.push(words);
  }
  return found;
}

/**
 * Every Pokemon type name Pokemon GO prints on the badge row just under the
 * HP text ("FIRE", "GHOST"). Used two ways downstream: to pick between a
 * species' forms when their stats cannot (Oricorio's four forms differ only
 * by type), and to catch a frame whose caption and card belong to different
 * Pokemon (frame.js).
 *
 * Vision truncates these badges constantly -- "GHOST" comes back as "GHỌ",
 * "ROCK" as "ROC", and a dual type as one box, "ROCK / WATER" -- so each box
 * is split on the separator, stripped to bare letters, and matched as a
 * prefix either way round. A token that could be two types is dropped rather
 * than guessed at.
 *
 * @param {TextBox[]} boxes
 * @returns {string[]} lowercase pvpoke type names, in reading order.
 */
export function readTypes(boxes) {
  const hp = boxes.find((b) => HP_RE.test(clean(b.s)));
  if (!hp) return [];
  const found = [];
  // The badge row sits a fixed fraction of the card below the HP text; the
  // window stops short of the stardust/candy row beneath it.
  const inBand = boxes
    .filter((b) => b.y > hp.y && b.y < hp.y + TYPE_BAND_DEPTH)
    .sort((a, b) => a.x - b.x);
  for (const box of inBand) {
    for (const raw of String(box.s ?? '').split(/[/|,·•]+/)) {
      const token = raw
        .normalize('NFD')
        .replace(/[^A-Za-z]/g, '')
        .toLowerCase();
      if (token.length < 3) continue;
      const hits = POKEMON_TYPES.filter((t) => t.startsWith(token) || token.startsWith(t));
      if (hits.length === 1 && !found.includes(hits[0])) found.push(hits[0]);
    }
  }
  return found;
}

/**
 * Text Pokemon GO draws only for a shadow Pokemon: the PURIFY button and the
 * SHADOW BONUS note under its moves.
 *
 * Neither is on the appraisal screen. Both live on the detail page *behind*
 * it, so they are visible only on a frame where the appraisal panel is shut
 * -- exactly the frames readFrame throws away for having no bars. That is why
 * shadow cannot be read off the same frame as the IVs, and why the marker is
 * carried separately (see frame.js and group.js).
 */
const SHADOW_RE = /\bPURIF|\bSHADOW\s*BONUS\b/i;

/**
 * Does this frame show the detail page's shadow markings?
 *
 * One-way: true means shadow, false means only that this frame does not say
 * so -- which is the case for every appraisal frame of every Pokemon,
 * shadow or not.
 *
 * @param {TextBox[]} boxes
 * @returns {boolean}
 */
export function readsShadow(boxes) {
  return boxes.some((b) => SHADOW_RE.test(String(b.s ?? '')));
}
