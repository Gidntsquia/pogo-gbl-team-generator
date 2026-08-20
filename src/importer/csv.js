/**
 * Minimal, dependency-free RFC4180-ish CSV parser. Handles quoted fields
 * (including embedded commas, embedded newlines, and doubled-quote escapes
 * for a literal `"`), CRLF or LF line endings, and a leading BOM.
 *
 * Intentionally not a full RFC4180 implementation (e.g. it doesn't
 * distinguish `,,` from a quoted empty field) -- just enough to read the
 * real-world CSVs this importer needs to support without adding an npm
 * dependency.
 *
 * @param {string} text - raw CSV file contents.
 * @returns {string[][]} rows of raw string cells (not yet trimmed/typed).
 */
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let sawAnyContentInRow = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    sawAnyContentInRow = false;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      sawAnyContentInRow = true;
    } else if (c === ',') {
      endField();
      sawAnyContentInRow = true;
    } else if (c === '\r') {
      // swallow; paired \n (or a lone \r) handles the line break
    } else if (c === '\n') {
      endRow();
    } else {
      field += c;
      sawAnyContentInRow = true;
    }
  }

  // Final row if the file doesn't end with a newline.
  if (sawAnyContentInRow || field !== '') {
    endRow();
  }

  // Drop fully-blank lines (common trailing newline, or stray blank rows).
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}
