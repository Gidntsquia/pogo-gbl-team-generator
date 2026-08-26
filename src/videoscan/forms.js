// JavaScript Document
//
// Which gamemaster species a caught-location caption could possibly mean.
//
// Pokemon GO's caption states the *base* species and nothing else: a Galarian
// Corsola, a Hisuian Typhlosion and an Alolan Raticate all say "This Corsola
// / Typhlosion / Raticate was caught on ...", and a Pa'u Oricorio just says
// "Oricorio". So a caption alone cannot pick between a species' forms -- and
// for the form-only species (Oricorio, Lycanroc, Morpeko ...) gamemaster has
// no unqualified entry to fall back on, which is why those used to be dropped
// as "unrecognized species" entirely.
//
// This module answers the narrower question the caption *can* answer: which
// gamemaster entries are in the running. index.js then settles it against the
// numbers on screen -- CP, max HP and the IVs over-determine each other, so a
// wrong form usually cannot produce the CP and HP that were read at any level
// (see resolveForm there).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GAMEMASTER_PATH = path.resolve(__dirname, '../../vendor/pvpoke/src/data/gamemaster.json');

/**
 * Entries that are not a form of anything you could have caught: battle-only
 * transformations, and pvpoke's own second copies of a species (`lanturnw`,
 * `cradily_b`) which exist to rank an alternative moveset.
 */
const EXCLUDED_TAGS = new Set(['mega', 'primal', 'gigantamax', 'duplicate']);

/**
 * The form to assume for a family gamemaster models *only* as forms, when the
 * screen genuinely cannot tell them apart -- Morpeko's two forms have
 * identical stats and identical types, so no amount of CP/HP arithmetic will
 * ever separate them and a documented default is the honest answer.
 *
 * Each is the form Pokemon GO stores a caught Pokemon as outside of battle.
 * Families that DO have an unqualified gamemaster entry (Meowstic -> the male
 * `meowstic`, Zygarde -> the 50% `zygarde`) need no entry here: that entry is
 * preferred automatically.
 */
export const DEFAULT_FORMS = {
  aegislash: 'aegislash_shield',
  basculegion: 'basculegion_male',
  burmy: 'burmy_plant',
  cherrim: 'cherrim_overcast',
  darmanitan: 'darmanitan_standard',
  enamorus: 'enamorus_incarnate',
  gourgeist: 'gourgeist_average',
  indeedee: 'indeedee_male',
  keldeo: 'keldeo_ordinary',
  lycanroc: 'lycanroc_midday',
  meloetta: 'meloetta_aria',
  minior: 'minior_meteor',
  morpeko: 'morpeko_full_belly',
  oricorio: 'oricorio_baile',
  pumpkaboo: 'pumpkaboo_average',
  shaymin: 'shaymin_land',
  tatsugiri: 'tatsugiri_curly',
  urshifu: 'urshifu_single_strike',
  wormadam: 'wormadam_plant',
  zacian: 'zacian_hero',
  zamazenta: 'zamazenta_hero',
};

function normalizeKey(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

let cached = null;

/**
 * Group every catchable gamemaster species by its base name.
 *
 * @param {string} [gamemasterPath]
 * @returns {Map<string, {speciesId: string, name: string, types: string[]}[]>}
 *   normalized base name -> its forms, most likely first.
 */
export function buildFormIndex(gamemasterPath = DEFAULT_GAMEMASTER_PATH) {
  const gm = JSON.parse(readFileSync(gamemasterPath, 'utf8'));
  const families = new Map();

  for (const p of gm.pokemon) {
    // Shadow is a flag on the row, not a species (see importer/gamemaster.js).
    if (p.speciesId.endsWith('_shadow')) continue;
    if ((p.tags ?? []).some((t) => EXCLUDED_TAGS.has(t))) continue;
    const base = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(p.speciesName)?.[1] ?? p.speciesName;
    const key = normalizeKey(base);
    if (!families.has(key)) families.set(key, []);
    families.get(key).push({
      speciesId: p.speciesId,
      name: p.speciesName,
      types: (p.types ?? []).filter((t) => t && t !== 'none'),
    });
  }

  for (const [key, forms] of families) {
    // Preference order, best first: the unqualified entry (an ordinary
    // Rattata is far likelier than an Alolan one, and it is what the caption
    // literally said), then this family's documented default, then whatever
    // order gamemaster lists them in.
    const rank = (f) => (f.speciesId === key ? 0 : f.speciesId === DEFAULT_FORMS[key] ? 1 : 2);
    forms.sort((a, b) => rank(a) - rank(b));
  }
  return families;
}

/**
 * @typedef {object} FormResolver
 * @property {(name: string) => {speciesId: string, name: string, types: string[]}[]} byName
 *   every gamemaster species a bare caption name could be referring to, most
 *   likely first; empty when the name matches no species at all.
 * @property {(speciesId: string) => {speciesId: string, name: string, types: string[]}|undefined} byId
 *   one species by its gamemaster id, for the types it is drawn with.
 */

/**
 * @param {string} [gamemasterPath]
 * @returns {FormResolver}
 */
export function createFormResolver(gamemasterPath) {
  if (!gamemasterPath && cached) return cached;
  const families = buildFormIndex(gamemasterPath);
  const byId = new Map();
  for (const forms of families.values()) for (const f of forms) byId.set(f.speciesId, f);
  const resolver = {
    byName: (name) => families.get(normalizeKey(name)) ?? [],
    byId: (speciesId) => byId.get(speciesId),
  };
  if (!gamemasterPath) cached = resolver;
  return resolver;
}
