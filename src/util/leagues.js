// JavaScript Document
//
// CP cap (+ optional cup) -> format identity. One place to answer the
// questions the earlier CP-cap plumbing deliberately deferred as design
// decisions rather than mechanical path substitutions:
//   - which vendor/pvpoke meta GROUP file represents "the meta" at this
//     cp+cup (src/data/groups/<group>.json -- used by src/scoring/index.js's
//     loadMeta for the 1v1 pruning meta and by src/meta/usage.js's weight
//     universe),
//   - which rankings directory the cp+cup pair reads from, and
//   - what to call the format in reports.
//
// The group names are pvpoke's own: great/ultra/master are the CP-capped
// "open" formats pvpoke ranks under the same "all" cup the engine uses by
// default (see src/engine/harness.js's initEngine); a cup such as
// "willpower" pairs with its own group of the same name and its own
// rankings directory (src/data/rankings/<cup>/).
//
// No battle math, no data loading -- pure naming (resolveFormat does read
// vendor/pvpoke/src/data/gamemaster/formats.json to look up cup:cp pairs,
// but never touches rankings/battle data itself).

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_VENDOR_ROOT = path.resolve(__dirname, '../../vendor/pvpoke');

const LEAGUES = Object.freeze({
  500: { name: 'Little Cup', group: 'little' },
  1500: { name: 'Great League', group: 'great' },
  2500: { name: 'Ultra League', group: 'ultra' },
  10000: { name: 'Master League', group: 'master' },
});

export const DEFAULT_CP = 1500;
export const DEFAULT_CUP = 'all';

/**
 * Resolve a `{ cp, cup }` pair into its format identity: display name, meta
 * group file, and rankings directory.
 *
 * `cup === 'all'` (the default) is exactly today's CP-capped "open format"
 * behaviour, byte-for-byte: `name`/`group` come from the CP table above and
 * `rankingsDir` is `'all'`. Any other cup is looked up in vendor/pvpoke's
 * `src/data/gamemaster/formats.json` by its `{cup, cp}` pair; `name` is the
 * format's `title`, `group` is its `meta`, and `rankingsDir` is the cup name
 * itself (honouring `cups[].rankingAlias` when pvpoke defines one, same as
 * `GameMaster.loadRankingData` does -- e.g. `gobattleleague`/
 * `championshipseries` both alias to the `all` rankings).
 *
 * @param {{ cp?: number, cup?: string, vendorRoot?: string }} [opts]
 * @returns {{ cp: number, cup: string, name: string, group: string, rankingsDir: string }}
 * @throws if `cup` is `'all'` and `cp` isn't a cap pvpoke ships data for; if
 *   `cup` isn't `'all'` and no `{cup, cp}` pair exists in formats.json; or if
 *   the resolved rankings directory has no `overall/rankings-<cp>.json`
 *   (formats with `hideRankings` ship no file).
 */
export function resolveFormat({ cp = DEFAULT_CP, cup = DEFAULT_CUP, vendorRoot = DEFAULT_VENDOR_ROOT } = {}) {
  if (cup === DEFAULT_CUP) {
    const league = LEAGUES[cp];
    if (!league) {
      throw new Error(
        `resolveFormat: unsupported cp ${cp} -- pvpoke ships ${Object.keys(LEAGUES).join('/')}`
      );
    }
    return { cp, cup, name: league.name, group: league.group, rankingsDir: 'all' };
  }

  const formatsPath = path.join(vendorRoot, 'src/data/gamemaster/formats.json');
  const formats = readVendoredJson(formatsPath);
  const format = formats.find((f) => f.cup === cup && f.cp === cp);
  if (!format) {
    const pairs = formats.map((f) => `${f.cup}:${f.cp}`).join(', ');
    throw new Error(
      `resolveFormat: no format for cup="${cup}" cp=${cp} -- valid cup:cp pairs are ${pairs}`
    );
  }

  const cupsDir = path.join(vendorRoot, 'src/data/gamemaster/cups');
  const cupPath = path.join(cupsDir, `${cup}.json`);
  let rankingsDir = cup;
  if (existsSync(cupPath)) {
    const cupData = readVendoredJson(cupPath);
    if (cupData.rankingAlias) rankingsDir = cupData.rankingAlias;
  }

  const rankingsPath = path.join(
    vendorRoot,
    `src/data/rankings/${rankingsDir}/overall/rankings-${cp}.json`
  );
  if (!existsSync(rankingsPath)) {
    throw new Error(
      `resolveFormat: no vendored rankings for cup="${cup}" cp=${cp} (expected ${rankingsPath})`
    );
  }

  return { cp, cup, name: format.title, group: format.meta, rankingsDir };
}

/**
 * @param {number} [cp] - CP cap; defaults to Great League's 1500.
 * @returns {{ cp: number, cup: string, name: string, group: string, rankingsDir: string }}
 * @throws if `cp` isn't a cap pvpoke ships data for.
 */
export function leagueForCp(cp = DEFAULT_CP) {
  return resolveFormat({ cp });
}

/**
 * JSON.parse a vendored file, stripping a leading UTF-8 BOM if present (some
 * vendored data files, e.g. src/data/groups/willpower.json at the pinned
 * commit, are saved with one; Node's JSON.parse rejects it). Defensive-only
 * -- never touches the vendored file itself.
 * @param {string} filePath
 * @returns {any}
 */
export function readVendoredJson(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
}

/**
 * The vendored rankings path for `ctx`'s format and a ranking category
 * ('overall', 'leads', 'closers', 'switches'), relative to vendorRoot. The
 * one place every loader that used to hardcode `rankings/all/...` builds its
 * path from now, so `ctx.cp`/`ctx.cup` can't drift between them (see
 * src/engine/harness.js's initEngine, which is where `ctx.cup` comes from).
 *
 * @param {{ cp: number, cup?: string, vendorRoot?: string }} ctx
 * @param {string} [category] - defaults to 'overall'.
 * @returns {string} path relative to vendorRoot, e.g.
 *   "src/data/rankings/willpower/leads/rankings-1500.json".
 */
export function rankingsPath(ctx, category = 'overall') {
  const format = resolveFormat({ cp: ctx.cp, cup: ctx.cup ?? DEFAULT_CUP, vendorRoot: ctx.vendorRoot });
  return `src/data/rankings/${format.rankingsDir}/${category}/rankings-${ctx.cp}.json`;
}

/** Supported CP caps, ascending -- for CLI help/validation messages. */
export const SUPPORTED_CPS = Object.freeze(Object.keys(LEAGUES).map(Number).sort((a, b) => a - b));
