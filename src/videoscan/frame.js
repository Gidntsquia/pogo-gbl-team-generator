// JavaScript Document
//
// Decides whether one sampled frame shows exactly one Pokemon's appraisal
// screen, and if so reads it. Pure: takes a Frame (see probe.js) and returns
// a Reading (see group.js) or a rejection reason.
//
// The bar for accepting a frame is deliberately high. During a swipe two
// cards overlap, the panel scales, and a bar measured off one card next to a
// CP read off the other would produce a plausible-looking row that is simply
// wrong -- far worse than dropping the frame, because the next frame will
// show the same Pokemon standing still anyway.

import { readAppraisal } from './bars.js';
import { countCpBoxes, readCp, readMaxHp, readSpeciesCaptions, readTypes, readsShadow } from './text.js';

/**
 * @param {import('./probe.js').Frame} frame
 * @param {{resolveCaption: (caption: string) => object|null}} deps
 * @returns {{reading: import('./group.js').Reading}|{reading: null, reason: string, detail?: string,
 *   hint?: import('./group.js').Hint}}
 */
export function readFrame(frame, { resolveCaption }) {
  // Shadow is not on the appraisal screen at all. Pokemon GO only draws the
  // PURIFY button and the SHADOW BONUS note on the detail page BEHIND the
  // panel, so the frames that say a Pokemon is shadow are exactly the frames
  // with no bars to read -- and, once the panel has slid down far enough to
  // uncover them, no caught-location caption either. Both of those are
  // rejections here, which is why shadow never reached the CSV.
  //
  // Such a frame still shows the card's CP and max HP, and that pair is
  // enough to say WHICH Pokemon it is talking about (group.js matches on it).
  // So the marker leaves as a hint attached to the rejection, rather than
  // being thrown away with the frame.
  const cp = readCp(frame.text);
  const maxHp = readMaxHp(frame.text);
  const hint =
    readsShadow(frame.text) && countCpBoxes(frame.text) === 1 && cp !== undefined && maxHp !== undefined
      ? { cp, maxHp, shadow: true }
      : undefined;
  const reject = (reason, detail) => ({ reading: null, reason, ...(detail ? { detail } : {}), ...(hint ? { hint } : {}) });

  const captions = readSpeciesCaptions(frame.text);
  if (countCpBoxes(frame.text) > 1 || captions.length > 1) {
    return reject('mid-swipe (two Pokemon on screen)');
  }

  if (captions.length === 0) {
    return reject('no "This <species> was caught..." caption visible');
  }

  const species = resolveCaption(captions[0]);
  if (!species) {
    return reject('unrecognized species', captions[0]);
  }

  // The type badges belong to the card the CP and HP were read off. If they
  // name a type this species cannot have, the caption and the card are two
  // different Pokemon: the swipe has moved one card far enough that its CP
  // text is unreadable (so the two-CP check above missed it) while the
  // incoming card's caption is already legible.
  const types = readTypes(frame.text);
  const possible = new Set(species.candidates.flatMap((c) => c.types));
  if (types.length > 0 && possible.size > 0 && !types.every((t) => possible.has(t))) {
    return reject('mid-swipe (type badge belongs to another Pokemon)');
  }

  const appraisal = readAppraisal(frame.rows, frame.w);
  if (!appraisal) return reject('appraisal bars not readable');

  return {
    reading: {
      t: frame.t,
      speciesId: species.speciesId,
      name: species.name,
      candidates: species.candidates,
      types,
      shadow: species.shadow,
      purified: species.purified,
      // Both optional. The Pokemon's own animation is drawn *over* the CP
      // text, so on a frame where a wing or a flame crosses it the number
      // comes back short ("96" for 968) or not at all -- which is why CP is
      // resolved per Pokemon, across frames and against the stats, rather
      // than trusted per frame (see index.js).
      cp,
      maxHp,
      ivs: appraisal.ivs,
      deltas: appraisal.deltas,
    },
  };
}
