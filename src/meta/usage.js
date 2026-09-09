// JavaScript Document
//
// Per-species meta usage weights, powering the weighted samplers in
// src/meta/sampleTeams.js and src/teams/sample.js. Usage weight is
// Zipf-style over RANK POSITION (not raw score): a species is ranked by
// pvpoke's own 0-100 ranking score for ctx.cp (vendored
// vendor/pvpoke/src/data/rankings/all/overall/rankings-<cp>.json, cp from
// ctx.cp; Great League/1500 by default), sorted descending (ties broken by
// speciesId), optionally overridden by a committed freshness snapshot
// (data/meta-usage.json, written by scripts/refresh-usage.mjs). No battle
// math here -- this is pure arithmetic over pvpoke's own published ranking
// scores.
//
// Rank-position weighting replaced a raw-score power law (score/100)^gamma
// in Sep 2026: over a wide field (e.g. top 400) pvpoke scores run a shallow
// 92->78, so a power law leaves the draw nearly flat -- rank #1 barely
// outdrew rank #400. Weighting by RANK instead of score reliably produces a
// "meaningfully likelier" top of the list regardless of how bunched the
// underlying scores are.
//
// The meta GROUP file follows ctx.cp via src/util/leagues.js
// (groups/great.json at 1500, groups/ultra.json at 2500), same as the
// rankings/training files below.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_CP, leagueForCp } from '../util/leagues.js';

// Default snapshot path, relative to the process cwd -- mirrors src/cli.js's
// "out/report.md" convention (both assume the CLI/tests run from repo root).
const DEFAULT_SNAPSHOT_PATH = 'data/meta-usage.json';

// Zipf-style weight over 1-based rank position r:
//   weight(r) ∝ 1 / (r + k)^alpha
// alpha=1, k=20 sanity numbers over a 400-species pool (normaliser is
// H(400+k) - H(k) ~= 3.05 for k=20): rank 1 ~= 1.6% of draws, rank 10 ~= 1.1%,
// rank 50 ~= 0.47%, rank 100 ~= 0.27%, rank 400 ~= 0.08%. Top 20 ~= 23% of
// draws, top 100 ~= 59%. k damps the curve near rank 1 (without it, rank 1
// would draw a full alpha-th of the total weight budget on its own); alpha
// controls how fast weight decays with rank. k was 5 (rank 1 ~= 3.9%, top 20
// ~= 36%) until 2026-09-09: on the v2 meta-vs-meta run the opponent GA
// amplified that into Tinkaton on 15-34% of opponent teams and halved the
// pool's distinct species (204 -> ~80), so the curve was flattened.
const DEFAULT_RANK_ALPHA = 1.0;
const DEFAULT_RANK_OFFSET = 20;

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** Default training-teams file for ctx's CP cap, mirroring src/meta/teams.js. */
function defaultTrainingFile(ctx) {
  return `src/data/training/teams/gobattleleague/${ctx.cp}.json`;
}

/** Default vendored rankings file for ctx's CP cap. */
function defaultRankingsFile(ctx) {
  return `src/data/rankings/all/overall/rankings-${ctx.cp}.json`;
}

/** Default meta group file for ctx's CP cap. */
function defaultGroupFile(ctx) {
  return `src/data/groups/${leagueForCp(ctx.cp).group}.json`;
}

function readTrainingSpeciesIds(raw) {
  const presets = Array.isArray(raw) ? raw : raw.presets;
  const ids = new Set();
  for (const preset of presets ?? []) {
    for (const mon of preset.pokemon ?? []) ids.add(mon.speciesId);
  }
  return ids;
}

/**
 * The species universe a usage weight is computed for: every species with a
 * resolvable score (the whole rankings/snapshot field -- 1000+ species under
 * the pinned vendor commit, most of them fringe picks) UNION every entry in
 * the meta group for ctx.cp and the curated training teams, so those two
 * pools are always covered even if a caller-supplied score source happens to
 * be narrower than the full field (e.g. `opts.rankingsEntries` in a test).
 *
 * Using the full field (rather than restricting to groupEntries/training
 * alone) matters for the anchor sanity check below: great.json + the
 * training teams are ALREADY a curated top-tier slice (scores cluster
 * ~85-94), so "above the median" of just that slice would be close to a coin
 * flip. Against the full field's median (~74, well below any meta anchor's
 * score), "above median" is a meaningful signal. It also matches the whole
 * point of the sampling initiative: the opponent/candidate
 * samplers need a WIDE weighted pool to draw from, not just the ~50-mon
 * curated slice.
 */
function collectSpeciesUniverse(ctx, opts, scoreBySpecies) {
  const groupEntries =
    opts.groupEntries ?? readJson(path.join(ctx.vendorRoot, opts.groupFile ?? defaultGroupFile(ctx)));
  const trainingIds =
    opts.trainingSpeciesIds ??
    readTrainingSpeciesIds(readJson(path.join(ctx.vendorRoot, opts.trainingFile ?? defaultTrainingFile(ctx))));

  const ids = new Set(scoreBySpecies.keys());
  for (const g of groupEntries) ids.add(g.speciesId);
  for (const id of trainingIds) ids.add(id);
  return ids;
}

/**
 * @typedef {object} UsageSnapshot
 * @property {string} fetchedAt - ISO timestamp of the live fetch.
 * @property {string} source - where the scores came from (a URL, typically).
 * @property {Array<{speciesId: string, score: number}>} entries
 */

/**
 * Read+validate a committed usage snapshot. Returns null (never throws) on a
 * missing file, unparseable JSON, or a shape that doesn't match
 * UsageSnapshot -- any of those fall back to the vendored rankings file.
 *
 * @param {string} snapshotPath
 * @returns {UsageSnapshot | null}
 */
function loadSnapshot(snapshotPath) {
  if (!snapshotPath || !existsSync(snapshotPath)) return null;
  try {
    const parsed = readJson(snapshotPath);
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    for (const entry of parsed.entries) {
      if (typeof entry?.speciesId !== 'string' || typeof entry?.score !== 'number') return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build the deterministic base score-per-species map: a present+parseable
 * snapshot wins over the vendored rankings file (the "prefers a
 * present+parseable snapshot over vendored" rule).
 */
function loadScoreBySpecies(ctx, opts) {
  const snapshotPath = opts.snapshotPath ?? DEFAULT_SNAPSHOT_PATH;
  const snapshot = opts.snapshotEntries
    ? { entries: opts.snapshotEntries }
    : loadSnapshot(snapshotPath);
  if (snapshot) {
    // scripts/refresh-usage.mjs only ever fetches Great League
    // scores, so a snapshot is only valid for the cap it was fetched for (a
    // snapshot written before this field existed is Great League by
    // definition). At any other cap it would silently substitute GL scores
    // for the league actually being run -- fall back to the vendored
    // rankings for that cap instead.
    const snapshotCp = snapshot.cp ?? DEFAULT_CP;
    if (opts.snapshotEntries || snapshotCp === ctx.cp) {
      return new Map(snapshot.entries.map((e) => [e.speciesId, e.score]));
    }
    process.stderr.write(
      `loadUsageWeights: ignoring ${snapshotPath} (cp ${snapshotCp}) for a cp-${ctx.cp} run -- using vendored rankings\n`
    );
  }

  const rankings =
    opts.rankingsEntries ?? readJson(path.join(ctx.vendorRoot, opts.rankingsFile ?? defaultRankingsFile(ctx)));
  return new Map(rankings.map((r) => [r.speciesId, r.score]));
}

/**
 * Compute a normalized, positive per-species usage weight for the full
 * scored field (every species in the rankings/snapshot source), guaranteed
 * to also cover every species in the meta group for ctx.cp and the
 * curated training teams (see collectSpeciesUniverse for why the universe
 * isn't restricted to just those two, narrower, pools).
 *
 * weight(species at rank r, 1-based, sorted by score descending, ties
 * broken by speciesId) ∝ 1 / (r + rankOffset)^rankAlpha. Weights are
 * normalized to sum to 1 (a probability distribution the samplers can draw
 * from directly). A species with no resolvable score (absent from both the
 * snapshot/vendored rankings) is left out of the returned map entirely
 * rather than assigned a zero weight, so callers can tell "no data" apart
 * from "legitimately weak". A species that has a score but sits outside the
 * top-N of a truncated rankings source still gets a rank (its position in
 * the full scored field), so nothing that previously had a weight loses it.
 *
 * @param {object} ctx - from initEngine (src/engine/harness.js); only
 *   ctx.vendorRoot is used (no battles, no gamemaster lookups).
 * @param {{
 *   rankAlpha?: number,
 *   rankOffset?: number,
 *   groupFile?: string,
 *   groupEntries?: Array<{speciesId: string}>,
 *   trainingFile?: string,
 *   trainingSpeciesIds?: Iterable<string>,
 *   rankingsFile?: string,
 *   rankingsEntries?: Array<{speciesId: string, score: number}>,
 *   snapshotPath?: string,
 *   snapshotEntries?: Array<{speciesId: string, score: number}>,
 * }} [opts]
 *   `*Entries`/`trainingSpeciesIds`/`snapshotEntries` override reading the
 *   corresponding vendor/snapshot file entirely (testability, mirrors
 *   src/scoring/index.js's `groupEntries` pattern). `snapshotPath` overrides
 *   the default `data/meta-usage.json` (also testability, e.g. pointing at a
 *   temp file to test the snapshot-preference / corrupt-snapshot-fallback
 *   rules without touching the repo's committed snapshot).
 * @returns {Map<string, number>} speciesId -> normalized positive weight.
 */
export function loadUsageWeights(ctx, opts = {}) {
  const rankAlpha = opts.rankAlpha ?? DEFAULT_RANK_ALPHA;
  const rankOffset = opts.rankOffset ?? DEFAULT_RANK_OFFSET;
  const scoreBySpecies = loadScoreBySpecies(ctx, opts);
  const speciesUniverse = collectSpeciesUniverse(ctx, opts, scoreBySpecies);

  const scored = [...speciesUniverse]
    .filter((id) => typeof scoreBySpecies.get(id) === 'number')
    .sort((a, b) => scoreBySpecies.get(b) - scoreBySpecies.get(a) || (a < b ? -1 : a > b ? 1 : 0));

  const raw = new Map();
  scored.forEach((speciesId, i) => {
    const rank = i + 1;
    raw.set(speciesId, 1 / Math.pow(rank + rankOffset, rankAlpha));
  });

  const total = [...raw.values()].reduce((sum, w) => sum + w, 0);
  const weights = new Map();
  for (const [speciesId, w] of raw) {
    weights.set(speciesId, total > 0 ? w / total : 0);
  }
  return weights;
}
