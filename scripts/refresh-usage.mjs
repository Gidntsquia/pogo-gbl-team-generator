#!/usr/bin/env node
// Optional freshness layer for src/meta/usage.js: fetches pvpoke's LIVE
// Great League rankings JSON and writes a committed snapshot at
// data/meta-usage.json. Never run automatically (not by tests, not by the
// CLI) -- a human runs this deliberately to refresh usage weights between
// vendor-pin bumps. Network failure here never breaks anything downstream:
// loadUsageWeights falls back to the vendored rankings file whenever the
// snapshot is missing, unparseable, or malformed (see its
// "corrupt-snapshot fallback" behavior).
//
// Usage: node scripts/refresh-usage.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Same shape as vendor/pvpoke/src/data/rankings/all/overall/rankings-1500.json
// (pvpoke's own live GL rankings JSON; usage traces to gobattlelog.com).
const SOURCE_CP = 1500;
const SOURCE_URL = `https://pvpoke.com/data/rankings/all/overall/rankings-${SOURCE_CP}.json`;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(REPO_ROOT, 'data', 'meta-usage.json');

async function main() {
  let entries;
  try {
    const res = await fetch(SOURCE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rankings = await res.json();
    if (!Array.isArray(rankings)) throw new Error('unexpected response shape (expected an array)');
    entries = rankings
      .filter((r) => typeof r?.speciesId === 'string' && typeof r?.score === 'number')
      .map((r) => ({ speciesId: r.speciesId, score: r.score }));
  } catch (err) {
    console.error(`refresh-usage: fetch failed, snapshot NOT written (${err.message})`);
    console.error('refresh-usage: loadUsageWeights will keep using the vendored rankings file.');
    process.exitCode = 1;
    return;
  }

  // `cp` records which CP cap these scores are for: loadUsageWeights ignores
  // a snapshot whose cap doesn't match the run's (GOALS T18c), so a `--cp
  // 2500` run never silently gets Great League usage weights.
  const snapshot = { fetchedAt: new Date().toISOString(), source: SOURCE_URL, cp: SOURCE_CP, entries };
  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`refresh-usage: wrote ${entries.length} entries to ${path.relative(REPO_ROOT, OUT_PATH)}`);
}

main();
