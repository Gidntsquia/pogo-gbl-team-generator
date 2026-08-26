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
