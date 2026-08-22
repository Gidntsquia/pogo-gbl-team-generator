// JavaScript Document
//
// GOALS T28 (PLAN.md Rev 6, "battle-reality fitness"): per-species role
// priors -- lead / closer / switch -- sourced from pvpoke's OWN published
// role-specific rankings, which are already vendored:
// vendor/pvpoke/src/data/rankings/all/{leads,closers,switches}/rankings-<cp>.json
// (also {overall,chargers,attackers,consistency}, not consumed here).
// REVISED 2026-08-22 by Jaxon away from an earlier design that would have
// run our own asymmetric-shield 1v1 sims (see GOALS.md's T28 history) --
// pvpoke already publishes exactly these role rankings under its own
// scenario weightings (gamemaster.json's rankingScenarios: leads =
// [1,1] starting shields/[0,0] energy; closers = [0,0] shields/[0,0]
// energy; switches = [1,1] shields/[4,0] energy), so there is no reason to
// reproduce that work with our own battles.
//
// Honest scope: these are SPECIES-level priors computed by pvpoke under its
// own recommended movesets, not instance-specific truth. A user's own IVs,
// current moves, and how a mon actually performs in OUR real 3v3 battles
// still come from src/scoring's matrix and src/teams' evaluateTeams -- role
// scores only weight sampling/fitness (GOALS T29) and label the report
// appendix; they never replace a real battle result.
//
// Same cp-aware path pattern as src/meta/usage.js (post-T18b: rankings file
// keyed off ctx.cp) and the SAME optional live-refresh-snapshot design as
// T9's usage loader: a cp-tagged committed snapshot (data/meta-roles.json)
// is preferred when present+valid; a missing/corrupt/wrong-cp snapshot
// falls back to the vendored files without ever throwing or touching the
// network (no network access anywhere in THIS file -- a live-fetch
// companion script, if wanted later, is out of this ticket's scope, which
// only asks for "the same optional live-refresh snapshot design").

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_CP } from '../util/leagues.js';

const DEFAULT_SNAPSHOT_PATH = 'data/meta-roles.json';

// Role name -> the vendored rankings category folder it reads from.
const CATEGORY_FOLDER = { lead: 'leads', closer: 'closers', switch: 'switches' };
const ROLES = Object.keys(CATEGORY_FOLDER);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** Default vendored rankings file for one role at ctx's CP cap. */
function defaultRankingsFile(ctx, role) {
  return `src/data/rankings/all/${CATEGORY_FOLDER[role]}/rankings-${ctx.cp}.json`;
}

/**
 * @typedef {object} RoleSnapshot
 * @property {string} fetchedAt - ISO timestamp of the live fetch.
 * @property {string} source - where the scores came from (a URL, typically).
 * @property {number} [cp] - the CP cap this snapshot was fetched for.
 * @property {{lead: Array<{speciesId:string,score:number}>, closer: Array, switch: Array}} categories
 */

/**
 * Read+validate a committed role-score snapshot. Returns null (never
 * throws) on a missing file, unparseable JSON, or a shape that doesn't
 * match RoleSnapshot -- any of those fall back to the vendored rankings
 * files, same contract as src/meta/usage.js's loadSnapshot.
 *
 * @param {string} snapshotPath
 * @returns {RoleSnapshot | null}
 */
function loadSnapshot(snapshotPath) {
  if (!snapshotPath || !existsSync(snapshotPath)) return null;
  try {
    const parsed = readJson(snapshotPath);
    if (!parsed || typeof parsed.categories !== 'object' || parsed.categories === null) return null;
    for (const role of ROLES) {
      const entries = parsed.categories[role];
      if (!Array.isArray(entries)) return null;
      for (const entry of entries) {
        if (typeof entry?.speciesId !== 'string' || typeof entry?.score !== 'number') return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build the deterministic speciesId -> raw 0-100 score map for one role,
 * preferring a present+parseable+cp-matching snapshot over the vendored
 * rankings file (same preference rule as src/meta/usage.js's
 * loadScoreBySpecies).
 */
function loadRoleScoreBySpecies(ctx, opts, role) {
  const overrideKey = `${role}Entries`; // leadEntries / closerEntries / switchEntries
  if (opts[overrideKey]) {
    return new Map(opts[overrideKey].map((e) => [e.speciesId, e.score]));
  }

  const snapshotPath = opts.snapshotPath ?? DEFAULT_SNAPSHOT_PATH;
  const snapshot = opts.snapshotCategories
    ? { categories: opts.snapshotCategories, cp: opts.snapshotCp }
    : loadSnapshot(snapshotPath);
  if (snapshot) {
    const snapshotCp = snapshot.cp ?? DEFAULT_CP;
    if (opts.snapshotCategories || snapshotCp === ctx.cp) {
      return new Map(snapshot.categories[role].map((e) => [e.speciesId, e.score]));
    }
    process.stderr.write(
      `loadRoleScores: ignoring ${snapshotPath} (cp ${snapshotCp}) for a cp-${ctx.cp} run -- using vendored rankings\n`
    );
  }

  const fileKey = `${role}File`; // leadFile / closerFile / switchFile
  const rankings = readJson(
    path.join(ctx.vendorRoot, opts[fileKey] ?? defaultRankingsFile(ctx, role))
  );
  return new Map(rankings.map((r) => [r.speciesId, r.score]));
}

/**
 * Per-species role priors from pvpoke's own published leads/closers/
 * switches rankings, normalized to pvpoke's own 0-100 score / 100 -> [0,1]
 * (NOT normalized to sum to 1 like src/meta/usage.js's sampling weights --
 * these are independent per-role priors meant to be read/compared directly,
 * e.g. in a report column, not drawn from as a probability distribution).
 *
 * The species universe is the union of whichever species appear in ANY of
 * the three role rankings (in practice, under the pinned vendor commit, all
 * three cover the identical ~1,144-species field at every supported cp --
 * confirmed directly before writing this loader). A species present in some
 * but not all three roles (possible with caller-supplied `opts.*Entries`
 * overrides, e.g. in tests) gets 0 for whichever role has no entry, rather
 * than being dropped -- 0 is a legitimate low prior for a role, and this
 * loader's whole point is one combined {lead, closer, switch} object per
 * species, not three separately-keyed maps a caller has to intersect.
 *
 * @param {object} ctx - from initEngine() (src/engine/harness.js); only
 *   ctx.cp and ctx.vendorRoot are used (no battles, no gamemaster lookups).
 * @param {{
 *   leadFile?: string, closerFile?: string, switchFile?: string,
 *   leadEntries?: Array<{speciesId:string,score:number}>,
 *   closerEntries?: Array<{speciesId:string,score:number}>,
 *   switchEntries?: Array<{speciesId:string,score:number}>,
 *   snapshotPath?: string,
 *   snapshotCategories?: {lead:Array, closer:Array, switch:Array},
 *   snapshotCp?: number,
 * }} [opts]
 *   `*File`/`*Entries` override reading the corresponding vendor file
 *   entirely (testability, mirrors src/meta/usage.js's `rankingsEntries`
 *   pattern). `snapshotPath` overrides the default `data/meta-roles.json`
 *   (testability -- e.g. pointing at a temp file to test the
 *   snapshot-preference / corrupt-snapshot-fallback rules without touching
 *   the repo's committed snapshot); `snapshotCategories`/`snapshotCp`
 *   inject a snapshot's content directly, bypassing the filesystem.
 * @returns {Map<string, {lead:number, closer:number, switch:number}>}
 *   speciesId -> role priors, each in [0,1].
 */
export function loadRoleScores(ctx, opts = {}) {
  const byRole = {};
  for (const role of ROLES) {
    byRole[role] = loadRoleScoreBySpecies(ctx, opts, role);
  }

  const universe = new Set();
  for (const role of ROLES) for (const speciesId of byRole[role].keys()) universe.add(speciesId);

  const result = new Map();
  for (const speciesId of universe) {
    const entry = {};
    for (const role of ROLES) {
      const rawScore = byRole[role].get(speciesId);
      entry[role] = typeof rawScore === 'number' ? Math.max(rawScore, 0) / 100 : 0;
    }
    result.set(speciesId, entry);
  }
  return result;
}
