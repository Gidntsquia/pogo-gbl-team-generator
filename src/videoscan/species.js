// JavaScript Document
//
// Turns the words a caught-location caption uses for a Pokemon into a pvpoke
// gamemaster species, plus the shadow/purified flags the caption states.
//
// Species matching itself is delegated entirely to the collection importer's
// existing resolver (src/importer/gamemaster.js) so the video path and the
// CSV path can never disagree about what "Weezing (Galarian)" is.
//
// One thing the caption cannot do is name a *form*: Pokemon GO writes "This
// Corsola was caught on ..." whether the Corsola is Galarian or not, and for
// species gamemaster models only as forms (Oricorio, Morpeko, Lycanroc ...)
// there is no unqualified entry to land on at all. So a caption resolves to a
// *list* of possible species -- forms.js orders them, index.js settles them
// against the CP and HP on screen.

import { createSpeciesResolver } from '../importer/gamemaster.js';
import { createFormResolver } from './forms.js';

// Regional form adjectives Pokemon GO puts *before* the species name in
// prose ("This Galarian Weezing was caught..."), which the importer's
// resolver expects as a separate `form` field.
const LEADING_FORMS = ['alolan', 'galarian', 'hisuian', 'paldean'];
const LEADING_STATUS = { shadow: 'shadow', purified: 'purified' };

/**
 * @typedef {object} CaptionSpecies
 * @property {string} speciesId - the likeliest reading, and the one the rest
 *   of the pipeline groups frames by.
 * @property {string} name
 * @property {boolean} shadow
 * @property {boolean} purified
 * @property {{speciesId: string, name: string, types: string[]}[]} candidates
 *   every species this caption could mean, likeliest first. Length 1 for the
 *   overwhelming majority of Pokemon; longer only for a species with forms
 *   the caption does not distinguish.
 */

/**
 * @returns {(caption: string) => (CaptionSpecies|null)}
 */
export function createCaptionResolver() {
  const resolveSpecies = createSpeciesResolver();
  const forms = createFormResolver();

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
      // A caption that named a form for itself is already unambiguous; only a
      // bare name leaves a choice of forms open.
      const family = form ? [] : forms.byName(name);
      if (hit) {
        const self = forms.byId(hit.speciesId) ?? { speciesId: hit.speciesId, name: hit.speciesName, types: [] };
        return {
          speciesId: self.speciesId,
          name: self.name,
          shadow,
          purified,
          candidates: family.length > 1 ? family : [self],
        };
      }
      // No unqualified entry, but gamemaster knows this species by its forms:
      // "Oricorio", "Morpeko", "Lycanroc". Take the likeliest for now.
      if (family.length > 0) {
        return { speciesId: family[0].speciesId, name: family[0].name, shadow, purified, candidates: family };
      }
    }
    return null;
  };
}
