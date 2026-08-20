/**
 * Collection importer: reads a Poke Genie export CSV or a simple generic
 * CSV and normalizes every row into a NormalizedMon ready for the engine
 * packet (see PLAN.md's Interfaces section).
 *
 * No level/CP math happens here -- IVs, level, and CP are passed through
 * exactly as the source CSV states them (or omitted if the CSV doesn't
 * state them); the engine packet (src/engine) is responsible for leveling
 * each mon to its best CP-capped configuration.
 */

import { readFileSync } from 'node:fs';
import { parseCsv } from './csv.js';
import { createSpeciesResolver } from './gamemaster.js';
import { parseNumber, parseBoolFlag, parseShadowPurified } from './util.js';

/**
 * @typedef {object} NormalizedMon
 * @property {string} speciesId - pvpoke gamemaster speciesId (base species;
 *   see gamemaster.js doc comment for why shadows resolve to the base id
 *   plus a separate `shadow` flag rather than a `*_shadow` id).
 * @property {string} name - canonical species display name (from
 *   gamemaster's speciesName, e.g. "Rattata (Alolan)"), not the raw CSV
 *   text -- this keeps display names consistent with how the rest of the
 *   pipeline (scoring/report) will refer to the same species as a meta
 *   threat.
 * @property {{ atk: number, def: number, hp: number }} ivs - 0-15 IVs.
 *   `hp` is the Stamina IV (pvpoke/gamemaster's naming for the third
 *   stat), NOT a derived HP value.
 * @property {number} [cp] - CP as stated by the source CSV, if present.
 * @property {number} [level] - trainer level as stated by the source CSV,
 *   if it states a single unambiguous value.
 * @property {boolean} shadow
 * @property {boolean} purified
 * @property {boolean} lucky
 * @property {boolean} bestBuddy
 * @property {number} sourceRow - 1-based row number in the source CSV,
 *   counting the header as row 1 (i.e. matches what a spreadsheet app
 *   would show), for tracing a warning or a mon back to its CSV line.
 */

function normalizeHeader(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * @param {string[]} headerRow
 * @returns {Map<string, number>} normalized header name -> column index
 *   (first occurrence wins on a duplicate header name).
 */
function buildHeaderIndex(headerRow) {
  const index = new Map();
  headerRow.forEach((raw, i) => {
    const key = normalizeHeader(raw);
    if (key && !index.has(key)) index.set(key, i);
  });
  return index;
}

/**
 * Look up a row cell by normalized header name, trying each candidate
 * name in order. This is the mechanism that makes every field mapping
 * BY HEADER NAME rather than column position, and tolerant of a few
 * plausible real-world header spellings.
 *
 * @param {string[]} row
 * @param {Map<string, number>} headerIndex
 * @param {...string} names
 * @returns {string|undefined}
 */
function cell(row, headerIndex, ...names) {
  for (const name of names) {
    const i = headerIndex.get(name);
    if (i !== undefined && row[i] !== undefined) return row[i];
  }
  return undefined;
}

function isBlankRow(row) {
  return row.every((c) => String(c ?? '').trim() === '');
}

// ---------------------------------------------------------------- format --

/**
 * Detect which supported CSV format a header row belongs to, purely from
 * column-name signatures (never from column position/count), so extra or
 * reordered columns never break detection.
 *
 * @param {Map<string, number>} headerIndex
 * @returns {'pokegenie'|'generic'|null}
 */
function detectFormat(headerIndex) {
  const has = (name) => headerIndex.has(name);
  // Poke Genie's unmistakable signature: three separate per-stat IV
  // columns. Its "HP" column is the *derived* stat, not an IV, so it's
  // deliberately excluded from this signature (and from the IV mapping
  // below -- see mapPokeGenieRow).
  if (has('atk iv') && has('def iv') && has('sta iv')) return 'pokegenie';
  // Generic format, exactly per PLAN.md: name,atk,def,sta[,shadow][,level][,cp]
  if (has('name') && has('atk') && has('def') && has('sta')) return 'generic';
  return null;
}

// ------------------------------------------------------------ Poke Genie --

/**
 * Poke Genie can state an exact level (Level Min === Level Max) or only
 * narrow a scan to a range. We only pass through a level when the CSV
 * states a single unambiguous value -- guessing from a range would be
 * level/CP math this packet deliberately doesn't do.
 */
function readPokeGenieLevel(row, headerIndex) {
  const single = parseNumber(cell(row, headerIndex, 'level'));
  if (single !== undefined) return single;
  const min = parseNumber(cell(row, headerIndex, 'level min'));
  const max = parseNumber(cell(row, headerIndex, 'level max'));
  if (min !== undefined && min === max) return min;
  return undefined;
}

/**
 * @returns {NormalizedMon|null} null if the row was unusable (pushes a
 *   warning explaining why).
 */
function mapPokeGenieRow(row, headerIndex, rowNumber, resolveSpecies, warnings) {
  const name = String(cell(row, headerIndex, 'name') ?? '').trim();
  const form = String(cell(row, headerIndex, 'form') ?? '').trim();
  const gender = String(cell(row, headerIndex, 'gender') ?? '').trim();

  if (!name) {
    warnings.push(`Row ${rowNumber}: missing Name -- skipped`);
    return null;
  }

  const resolved = resolveSpecies({ name, form, gender });
  if (!resolved) {
    const label = form ? `${name} (${form})` : name;
    warnings.push(`Row ${rowNumber}: no species match for "${label}" -- skipped`);
    return null;
  }

  const atk = parseNumber(cell(row, headerIndex, 'atk iv', 'attack iv'));
  const def = parseNumber(cell(row, headerIndex, 'def iv', 'defense iv'));
  // NOT aliased to bare "hp": Poke Genie's "HP" column is the derived stat
  // (tens-hundreds), a completely different scale from the 0-15 Stamina
  // IV. Falling back to it here would silently corrupt every downstream
  // battle sim for this mon.
  const hp = parseNumber(cell(row, headerIndex, 'sta iv', 'stamina iv'));
  if (atk === undefined || def === undefined || hp === undefined) {
    warnings.push(`Row ${rowNumber}: missing/invalid IVs for "${name}" -- skipped`);
    return null;
  }

  const { shadow, purified } = parseShadowPurified(
    cell(row, headerIndex, 'shadow/purified', 'shadow / purified', 'status')
  );

  return {
    speciesId: resolved.speciesId,
    name: resolved.speciesName,
    ivs: { atk, def, hp },
    cp: parseNumber(cell(row, headerIndex, 'cp')),
    level: readPokeGenieLevel(row, headerIndex),
    shadow,
    purified,
    lucky: parseBoolFlag(cell(row, headerIndex, 'lucky')),
    // Not in the packet's documented Poke Genie column list, but if a
    // real export does carry Best Buddy status under a plausible header,
    // recognize it opportunistically rather than silently dropping it.
    bestBuddy: parseBoolFlag(cell(row, headerIndex, 'best buddy', 'buddy')),
    sourceRow: rowNumber,
  };
}

// --------------------------------------------------------------- generic --

/**
 * @returns {NormalizedMon|null}
 */
function mapGenericRow(row, headerIndex, rowNumber, resolveSpecies, warnings) {
  const name = String(cell(row, headerIndex, 'name') ?? '').trim();
  if (!name) {
    warnings.push(`Row ${rowNumber}: missing name -- skipped`);
    return null;
  }

  const resolved = resolveSpecies({ name });
  if (!resolved) {
    warnings.push(`Row ${rowNumber}: no species match for "${name}" -- skipped`);
    return null;
  }

  const atk = parseNumber(cell(row, headerIndex, 'atk'));
  const def = parseNumber(cell(row, headerIndex, 'def'));
  // No competing "derived HP" column exists in this format, so a bare
  // "hp"/"stamina" header is an unambiguous alias for the Stamina IV.
  const hp = parseNumber(cell(row, headerIndex, 'sta', 'stamina', 'hp'));
  if (atk === undefined || def === undefined || hp === undefined) {
    warnings.push(`Row ${rowNumber}: missing/invalid IVs for "${name}" -- skipped`);
    return null;
  }

  return {
    speciesId: resolved.speciesId,
    name: resolved.speciesName,
    ivs: { atk, def, hp },
    cp: parseNumber(cell(row, headerIndex, 'cp')),
    level: parseNumber(cell(row, headerIndex, 'level')),
    shadow: parseBoolFlag(cell(row, headerIndex, 'shadow')),
    // purified/bestBuddy aren't in PLAN.md's documented generic column
    // list ([,shadow][,level][,cp] only); recognized opportunistically if
    // present, and default to false (matching the documented shape)
    // otherwise -- never fabricated.
    purified: parseBoolFlag(cell(row, headerIndex, 'purified')),
    lucky: parseBoolFlag(cell(row, headerIndex, 'lucky')),
    bestBuddy: parseBoolFlag(cell(row, headerIndex, 'bestbuddy', 'best buddy', 'buddy')),
    sourceRow: rowNumber,
  };
}

// ----------------------------------------------------------------- public --

/**
 * Import a Pokemon collection CSV (Poke Genie export or generic format,
 * auto-detected from the header row) into normalized mons ready for the
 * engine packet.
 *
 * Never throws on bad *row* data -- an unmatched species, missing IVs, or
 * a blank name become a warning and the row is skipped, so one bad row
 * never loses the rest of the collection. Only a problem with the file
 * itself (unreadable path, or a header that matches neither supported
 * format) throws.
 *
 * @param {string} csvPath - path to the CSV file.
 * @returns {{ mons: NormalizedMon[], warnings: string[] }}
 */
export function importCollection(csvPath) {
  const text = readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  const warnings = [];

  if (rows.length === 0) {
    return { mons: [], warnings: ['CSV file is empty'] };
  }

  const headerIndex = buildHeaderIndex(rows[0]);
  const format = detectFormat(headerIndex);
  if (!format) {
    throw new Error(
      'Unrecognized CSV format -- header row matches neither the Poke Genie ' +
        'export (needs Atk IV/Def IV/Sta IV columns) nor the generic format ' +
        `(needs name/atk/def/sta columns). Got header: ${rows[0].join(', ')}`
    );
  }

  const resolveSpecies = createSpeciesResolver();
  const mapRow = format === 'pokegenie' ? mapPokeGenieRow : mapGenericRow;
  const mons = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (isBlankRow(row)) continue;
    const rowNumber = i + 1; // spreadsheet-style: header occupies row 1
    const mon = mapRow(row, headerIndex, rowNumber, resolveSpecies, warnings);
    if (mon) mons.push(mon);
  }

  return { mons, warnings };
}
