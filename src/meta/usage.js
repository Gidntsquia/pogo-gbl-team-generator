// JavaScript Document
//
// Per-species meta usage weights, powering the weighted samplers in
// src/meta/sampleTeams.js (T10) and src/teams/sample.js (T11). See PLAN.md's
// Rev 3 section: usage weight = normalized (score/100)^gamma, where score is
// pvpoke's own 0-100 Great League ranking score (vendored
// vendor/pvpoke/src/data/rankings/all/overall/rankings-1500.json), optionally
// overridden by a committed freshness snapshot (data/meta-usage.json, written
// by scripts/refresh-usage.mjs). No battle math here -- this is pure
// arithmetic over pvpoke's own published ranking scores.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_GROUP_FILE = 'src/data/groups/great.json';
const DEFAULT_TRAINING_FILE = 'src/data/training/teams/gobattleleague/1500.json';
const DEFAULT_RANKINGS_FILE = 'src/data/rankings/all/overall/rankings-1500.json';

// Default snapshot path, relative to the process cwd -- mirrors src/cli.js's
// "out/report.md" convention (both assume the CLI/tests run from repo root).
const DEFAULT_SNAPSHOT_PATH = 'data/meta-usage.json';

// score/100 raised to this power. >1 spreads top-tier mons further above
// fringe ones (score ~90 vs ~50 -> weight ratio ~(0.9/0.5)^2.5 =~ 6.2x)
// without going winner-take-all (a linear score/100 base would still leave a
// ~50-scored mon at more than half a 90-scored mon's weight, too flat for
// "meaningfully likelier"; a much higher gamma starts zeroing out everything
// below the top handful, which defeats the point of sampling from a WIDE
// pool). 2.5 was picked as a middle ground -- documented here since it's the
// one tunable a future fire might want to revisit.
const DEFAULT_GAMMA = 2.5;

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
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
 * the Great League meta group and the curated training teams, so those two
 * pools are always covered even if a caller-supplied score source happens to
 * be narrower than the full field (e.g. `opts.rankingsEntries` in a test).
 *
 * Using the full field (rather than restricting to groupEntries/training
 * alone) matters for the anchor sanity check below: great.json + the
 * training teams are ALREADY a curated top-tier slice (scores cluster
 * ~85-94), so "above the median" of just that slice would be close to a coin
 * flip. Against the full field's median (~74, well below any meta anchor's
 * score), "above median" is a meaningful signal. It also matches the whole
 * point of the sampling initiative (PLAN Rev 3): the opponent/candidate
 * samplers need a WIDE weighted pool to draw from, not just the ~50-mon
 * curated slice.
 */
function collectSpeciesUniverse(ctx, opts, scoreBySpecies) {
  const groupEntries =
    opts.groupEntries ?? readJson(path.join(ctx.vendorRoot, opts.groupFile ?? DEFAULT_GROUP_FILE));
  const trainingIds =
    opts.trainingSpeciesIds ??
    readTrainingSpeciesIds(readJson(path.join(ctx.vendorRoot, opts.trainingFile ?? DEFAULT_TRAINING_FILE)));

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
 * snapshot wins over the vendored rankings file (T9's "prefers a
 * present+parseable snapshot over vendored" rule).
 */
function loadScoreBySpecies(ctx, opts) {
  const snapshotPath = opts.snapshotPath ?? DEFAULT_SNAPSHOT_PATH;
  const snapshot = opts.snapshotEntries
    ? { entries: opts.snapshotEntries }
    : loadSnapshot(snapshotPath);
  if (snapshot) {
    return new Map(snapshot.entries.map((e) => [e.speciesId, e.score]));
  }

  const rankings =
    opts.rankingsEntries ?? readJson(path.join(ctx.vendorRoot, opts.rankingsFile ?? DEFAULT_RANKINGS_FILE));
  return new Map(rankings.map((r) => [r.speciesId, r.score]));
}

/**
 * Compute a normalized, positive per-species usage weight for the full
 * scored field (every species in the rankings/snapshot source), guaranteed
 * to also cover every species in the Great League meta group and the
 * curated training teams (see collectSpeciesUniverse for why the universe
 * isn't restricted to just those two, narrower, pools).
 *
 * weight(species) ∝ (score/100)^gamma, where score is pvpoke's own 0-100
 * Great League ranking score. Weights are normalized to sum to 1 (a
 * probability distribution the T10/T11 samplers can draw from directly).
 * A species with no resolvable score (absent from both the snapshot/vendored
 * rankings) is left out of the returned map entirely rather than assigned a
 * zero weight, so callers can tell "no data" apart from "legitimately weak".
 *
 * @param {object} ctx - from initEngine (src/engine/harness.js); only
 *   ctx.vendorRoot is used (no battles, no gamemaster lookups).
 * @param {{
 *   gamma?: number,
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
  const gamma = opts.gamma ?? DEFAULT_GAMMA;
  const scoreBySpecies = loadScoreBySpecies(ctx, opts);
  const speciesUniverse = collectSpeciesUniverse(ctx, opts, scoreBySpecies);

  const raw = new Map();
  for (const speciesId of speciesUniverse) {
    const score = scoreBySpecies.get(speciesId);
    if (typeof score !== 'number') continue;
    raw.set(speciesId, Math.pow(Math.max(score, 0) / 100, gamma));
  }

  const total = [...raw.values()].reduce((sum, w) => sum + w, 0);
  const weights = new Map();
  for (const [speciesId, w] of raw) {
    weights.set(speciesId, total > 0 ? w / total : 0);
  }
  return weights;
}
