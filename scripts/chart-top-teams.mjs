// Animated line chart of the top teams' win rates across an evolve run.
//
// Usage:
//   node scripts/chart-top-teams.mjs <out-dir> [--top N] [--out PATH]
//
// <out-dir> is a scripts/evolve.mjs checkpoint directory. The teams charted
// are EVERY team that cracked any generation's top N by fitness
// (analytics.topTeams), so the chart shows challengers rising and dying, not
// just the survivors. Teams that also hold a spot in evolve-ranking.json (the
// final weighted elites ranking) carry that rank; the rest rank null and
// renderers draw them as the muted field. Each team's line is its RAW
// per-generation win rate (winRateBySignature), with gaps for generations the
// team was not alive. Output is one self-contained HTML file (inline SVG +
// JS, opens via file://) with play/pause and a scrubber.
//
// The series-extraction core and the chart's markup/script live in
// src/report/raceChart.js, shared with scripts/evolve.mjs's own HTML report
// (which embeds the same chart straight from a just-finished run's in-memory
// generationRecords, with no file reads at all). This file's own job is
// purely the file-reading CLI wrapper.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { buildTopTeamSeries, renderChartHtml } from '../src/report/raceChart.js';

export { renderChartHtml };

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * Collect the chart's data from a checkpoint directory -- reads every
 * out/evolve-gen<N>.json in order plus evolve-ranking.json (when present),
 * then hands them to {@link buildTopTeamSeries}.
 *
 * @param {string} outDir - evolve checkpoint directory.
 * @param {number} topCount - per-generation top-set size to union over.
 * @returns {{teams: Array<{name: string, rank: number|null, series: Array<number|null>}>,
 *   generations: number}} series[g] is the team's gen-g win rate or null.
 */
export function collectTopTeamSeries(outDir, topCount) {
  const checkpoints = [];
  for (let g = 0; ; g += 1) {
    const p = path.join(outDir, `evolve-gen${g}.json`);
    if (!existsSync(p)) break;
    checkpoints.push(readJson(p));
  }
  if (checkpoints.length === 0) {
    throw new Error(`no evolve-gen*.json checkpoints found in ${outDir}`);
  }

  const rankingPath = path.join(outDir, 'evolve-ranking.json');
  const rankingEntries = existsSync(rankingPath) ? readJson(rankingPath) : [];
  const data = buildTopTeamSeries(checkpoints, rankingEntries, topCount);
  if (data.teams.length === 0) throw new Error(`no teams to trace in ${outDir}`);
  return data;
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { top: { type: 'string' }, out: { type: 'string' } },
  });
  const outDir = positionals[0];
  if (!outDir) {
    process.stderr.write('Usage: node scripts/chart-top-teams.mjs <out-dir> [--top N] [--out PATH]\n');
    process.exitCode = 2;
    return;
  }
  const topCount = values.top ? Number(values.top) : 10;
  const data = collectTopTeamSeries(outDir, topCount);
  const title = `Top ${data.teams.length} teams by generation -- ${path.basename(path.resolve(outDir))}`;
  const outPath = values.out ?? path.join(outDir, 'top-teams-animation.html');
  writeFileSync(outPath, renderChartHtml(data, title), 'utf8');
  process.stdout.write(`Animation written to ${outPath} (${data.teams.length} teams, ${data.generations} generations)\n`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main(process.argv.slice(2));
}
