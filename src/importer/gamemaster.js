import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GAMEMASTER_PATH = path.resolve(
  __dirname,
  '../../vendor/pvpoke/src/data/gamemaster.json'
);

// Poke Genie's Form column (per the packet spec) writes the *region* name
// for Alolan forms ("Alola") but the *adjective* for the others
// ("Galarian", "Hisuian", "Paldean"), which already matches pvpoke's
// gamemaster.json speciesName convention of "<Name> (<Adjective>)". Map
// every plausible spelling to the adjective gamemaster actually uses.
const FORM_ALIASES = {
  alola: 'Alolan',
  alolan: 'Alolan',
  galar: 'Galarian',
  galarian: 'Galarian',
  hisui: 'Hisuian',
  hisuian: 'Hisuian',
  paldea: 'Paldean',
  paldean: 'Paldean',
};

// Species whose gamemaster entries only exist as size/cosmetic-form
// variants (no unqualified base entry). If a CSV doesn't specify a form for
// one of these, default to the most common one rather than failing to match.
const SIZE_DEFAULT_FORM = {
  pumpkaboo: 'Average',
  gourgeist: 'Average',
};

let cachedIndex = null;

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Collapse a species/form string down to a bare lowercase alphanumeric key
 * so punctuation, spacing, and case differences between a CSV's text and
 * gamemaster's speciesName never prevent a match (e.g. "Farfetch'd",
 * "Mr. Mime", "Flabébé", "Ho-Oh" all normalize losslessly against
 * gamemaster's own spellings).
 *
 * @param {string} s
 * @returns {string}
 */
function normalizeKey(s) {
  return stripDiacritics(String(s ?? ''))
    .replace(/♀/g, ' female')
    .replace(/♂/g, ' male')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function registerKey(map, key, entry) {
  if (key && !map.has(key)) map.set(key, entry);
}

function buildIndex(gamemasterPath = DEFAULT_GAMEMASTER_PATH) {
  const gm = JSON.parse(readFileSync(gamemasterPath, 'utf8'));
  const byName = new Map();

  // Shadow status is carried on NormalizedMon as its own flag (see
  // resolveSpecies doc comment / importer report), so the species index is
  // built only from base (non "_shadow") entries -- every shadow speciesId
  // in gamemaster.json has a non-shadow counterpart to fall back to.
  const baseMons = gm.pokemon.filter((p) => !p.speciesId.endsWith('_shadow'));

  // Pass 1: canonical speciesName always wins a key collision.
  for (const p of baseMons) {
    registerKey(byName, normalizeKey(p.speciesName), p);
  }

  // Pass 2: also register a "Form Base" ordering (e.g. "Alolan Rattata" in
  // addition to "Rattata (Alolan)") as an alias, for hand-written generic
  // CSVs that put the form word first. Never overrides a canonical key.
  for (const p of baseMons) {
    const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(p.speciesName);
    if (m) {
      const [, base, form] = m;
      registerKey(byName, normalizeKey(`${form} ${base}`), p);
    }
  }

  return byName;
}

function detectNidoranGender(name, form, gender) {
  const hay = `${name} ${form} ${gender}`;
  if (/♀|female|\bf\b/i.test(hay)) return 'Female';
  if (/♂|male|\bm\b/i.test(hay)) return 'Male';
  // "Nidoran*" (a common mangled export of the ♀/♂ glyph) or otherwise no
  // gender signal anywhere: there's no safe default here -- guessing wrong
  // would silently corrupt battle stats for a real species -- so we return
  // null and let the caller fail to match (-> warning) instead.
  return null;
}

function buildCandidateNames({ name, form, gender }) {
  const rawName = String(name ?? '').trim();
  const rawForm = String(form ?? '').trim();
  const rawGender = String(gender ?? '').trim();
  const candidates = [];
  if (!rawName) return candidates;

  // Unown and Spinda: gamemaster models every letter/pattern as the same
  // single species, so any trailing form/letter text is irrelevant.
  const baseOnlyMatch = /^(unown|spinda)\b/i.exec(rawName);
  if (baseOnlyMatch) {
    candidates.push(baseOnlyMatch[1]);
    return candidates;
  }

  // Nidoran: gendered species with no unqualified "Nidoran" entry.
  if (/^nidoran/i.test(rawName)) {
    const genderWord = detectNidoranGender(rawName, rawForm, rawGender);
    if (genderWord) {
      candidates.push(`Nidoran ${genderWord}`);
      return candidates;
    }
    // Ambiguous: fall through. "Nidoran" alone won't be in the index, so
    // this deliberately resolves to an unmatched-row warning below.
  }

  const normalizedForm = rawForm.toLowerCase();
  const effectiveForm =
    FORM_ALIASES[normalizedForm] ||
    rawForm ||
    SIZE_DEFAULT_FORM[rawName.toLowerCase()] ||
    '';

  if (effectiveForm && !/^normal$/i.test(effectiveForm)) {
    candidates.push(`${rawName} (${effectiveForm})`);
    candidates.push(`${rawName} ${effectiveForm}`);
    candidates.push(`${effectiveForm} ${rawName}`);
  }
  candidates.push(rawName);
  return candidates;
}

/**
 * Build a species resolver bound to pvpoke's vendored gamemaster.json.
 * The parsed index is cached at module scope (gamemaster.json is ~1.7MB and
 * static for the process lifetime), so repeated calls are cheap.
 *
 * @returns {(input: { name: string, form?: string, gender?: string }) => ({ speciesId: string, speciesName: string } | null)}
 *   Resolves to the **base** (non-shadow) speciesId -- see importer report
 *   for why: pvpoke gamemaster.json represents shadows as separate
 *   `<id>_shadow` species, but this project's engine API
 *   (`buildPokemon(ctx, { speciesId, ivs, shadow, bestBuddy })`) takes a
 *   base speciesId plus a `shadow` boolean, so that's the convention
 *   NormalizedMon uses too.
 */
export function createSpeciesResolver() {
  if (!cachedIndex) cachedIndex = buildIndex();
  const byName = cachedIndex;

  return function resolveSpecies({ name, form, gender }) {
    const candidates = buildCandidateNames({ name, form, gender });
    for (const candidate of candidates) {
      const entry = byName.get(normalizeKey(candidate));
      if (entry) return { speciesId: entry.speciesId, speciesName: entry.speciesName };
    }
    return null;
  };
}
