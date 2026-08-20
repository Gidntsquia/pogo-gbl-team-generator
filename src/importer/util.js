/**
 * Small, dependency-free parsing helpers shared by the Poke Genie and
 * generic CSV row mappers.
 */

/**
 * Parse a numeric CSV cell. Blank/whitespace-only/non-numeric values become
 * `undefined` rather than `NaN` so callers can use `??` to fall back cleanly
 * and so optional NormalizedMon fields (cp, level) can be omitted-in-spirit.
 *
 * @param {string|undefined} value
 * @returns {number|undefined}
 */
export function parseNumber(value) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  if (s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'y']);

/**
 * Parse a boolean-ish CSV cell. Recognizes 1/true/yes/y (case-insensitive)
 * as true; everything else (including blank) is false.
 *
 * @param {string|undefined} value
 * @returns {boolean}
 */
export function parseBoolFlag(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return TRUTHY.has(s);
}

/**
 * Parse Poke Genie's "Shadow/Purified" column. The exact export encoding
 * isn't publicly documented; commonly cited as a numeric code
 * (0 = normal, 1 = shadow, 2 = purified), but exports may also use the
 * plain text label instead. This handles both, plus loose substring
 * matches, so it's correct either way.
 *
 * @param {string|undefined} value
 * @returns {{ shadow: boolean, purified: boolean }}
 */
export function parseShadowPurified(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (s === '' || s === '0' || s === 'normal' || s === 'none') {
    return { shadow: false, purified: false };
  }
  if (s === '1' || s === 'shadow') return { shadow: true, purified: false };
  if (s === '2' || s === 'purified') return { shadow: false, purified: true };
  if (s.includes('shadow')) return { shadow: true, purified: false };
  if (s.includes('purif')) return { shadow: false, purified: true };
  return { shadow: false, purified: false };
}
