// JavaScript Document
//
// Turns the words a caught-location caption uses for a Pokemon into a pvpoke
// gamemaster species, plus the shadow/purified flags the caption states.
//
// Species matching itself is delegated entirely to the collection importer's
// existing resolver (src/importer/gamemaster.js) so the video path and the
// CSV path can never disagree about what "Weezing (Galarian)" is.

import { createSpeciesResolver } from '../importer/gamemaster.js';

// Regional form adjectives Pokemon GO puts *before* the species name in
// prose ("This Galarian Weezing was caught..."), which the importer's
// resolver expects as a separate `form` field.
const LEADING_FORMS = ['alolan', 'galarian', 'hisuian', 'paldean'];
const LEADING_STATUS = { shadow: 'shadow', purified: 'purified' };

/**
 * @returns {(caption: string) => ({speciesId: string, name: string, shadow: boolean, purified: boolean}|null)}
 */
export function createCaptionResolver() {
  const resolveSpecies = createSpeciesResolver();

  return function resolveCaption(caption) {
    let words = String(caption ?? '').trim().split(/\s+/).filter(Boolean);
    let shadow = false;
    let purified = false;
    let form = '';

    // Strip the leading modifiers Pokemon GO prepends, in any order, before
    // handing the bare species name to the importer's resolver.
    let changed = true;
    while (changed && words.length > 1) {
      changed = false;
      const head = words[0].toLowerCase();
      if (LEADING_STATUS[head]) {
        if (LEADING_STATUS[head] === 'shadow') shadow = true;
        else purified = true;
        words = words.slice(1);
        changed = true;
      } else if (LEADING_FORMS.includes(head)) {
        form = words[0];
        words = words.slice(1);
        changed = true;
      }
    }

    // Try the longest reading first, then shorter prefixes: OCR sometimes
    // glues an extra word onto the caption, and a two-word species
    // ("Mr. Mime", "Ho-Oh") must still win over its first word alone.
    for (let take = words.length; take >= 1; take--) {
      const name = words.slice(0, take).join(' ');
      const hit = resolveSpecies(form ? { name, form } : { name });
      if (hit) return { speciesId: hit.speciesId, name: hit.speciesName, shadow, purified };
    }
    return null;
  };
}
