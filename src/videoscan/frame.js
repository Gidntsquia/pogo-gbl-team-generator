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
import { countCpBoxes, readCp, readMaxHp, readSpeciesCaptions } from './text.js';

/**
 * @param {import('./probe.js').Frame} frame
 * @param {{resolveCaption: (caption: string) => object|null}} deps
 * @returns {{reading: import('./group.js').Reading}|{reading: null, reason: string, detail?: string}}
 */
export function readFrame(frame, { resolveCaption }) {
  const captions = readSpeciesCaptions(frame.text);
  if (countCpBoxes(frame.text) > 1 || captions.length > 1) {
    return { reading: null, reason: 'mid-swipe (two Pokemon on screen)' };
  }

  if (captions.length === 0) {
    return { reading: null, reason: 'no "This <species> was caught..." caption visible' };
  }

  const species = resolveCaption(captions[0]);
  if (!species) {
    return { reading: null, reason: 'unrecognized species', detail: captions[0] };
  }

  const appraisal = readAppraisal(frame.rows, frame.w);
  if (!appraisal) return { reading: null, reason: 'appraisal bars not readable' };

  return {
    reading: {
      t: frame.t,
      speciesId: species.speciesId,
      name: species.name,
      shadow: species.shadow,
      purified: species.purified,
      // Both optional. The Pokemon's own animation is drawn *over* the CP
      // text, so on a frame where a wing or a flame crosses it the number
      // comes back short ("96" for 968) or not at all -- which is why CP is
      // resolved per Pokemon, across frames and against the stats, rather
      // than trusted per frame (see index.js).
      cp: readCp(frame.text),
      maxHp: readMaxHp(frame.text),
      ivs: appraisal.ivs,
      deltas: appraisal.deltas,
    },
  };
}
