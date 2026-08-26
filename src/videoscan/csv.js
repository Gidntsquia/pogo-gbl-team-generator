// JavaScript Document
//
// Writes scanned Pokemon out in this project's generic collection format --
// the same `name,atk,def,sta,shadow,level,cp` header src/importer already
// reads, so a scanned video drops straight into the normal
// pipeline: `node scripts/scan-video.mjs box.mp4 --out out/box.csv` then
// `node src/cli.js out/box.csv`.

const HEADER = ['name', 'atk', 'def', 'sta', 'shadow', 'level', 'cp'];

function escapeCell(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {{name: string, ivs: {atk: number, def: number, hp: number}, shadow: boolean,
 *   level?: number, cp?: number}[]} mons
 * @returns {string} CSV text, newline-terminated.
 */
export function toCsv(mons) {
  const lines = [HEADER.join(',')];
  for (const mon of mons) {
    lines.push(
      [
        mon.name,
        mon.ivs.atk,
        mon.ivs.def,
        mon.ivs.hp,
        // The importer's parseBoolFlag reads an empty cell as false, so a
        // non-shadow row stays blank rather than writing a noisy "0".
        mon.shadow ? '1' : '',
        mon.level ?? '',
        mon.cp ?? '',
      ]
        .map(escapeCell)
        .join(',')
    );
  }
  return `${lines.join('\n')}\n`;
}

export { HEADER as CSV_HEADER };
