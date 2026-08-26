#!/usr/bin/env node
// JavaScript Document
//
// Video collection importer CLI (src/videoscan).
//
// Turns a Pokemon GO screen recording -- the appraisal screen, swiped from
// Pokemon to Pokemon -- into a collection CSV this project's main pipeline
// already reads.
//
// Usage:
//   node scripts/scan-video.mjs <video.mp4> [options]
//
// Options:
//   --out PATH      CSV output path                 (default out/scanned.csv)
//   --interval S    seconds between sampled frames  (default 0.25)
//   --no-level      skip level derivation (faster; leaves the level column blank)
//   --json PATH     also write the full per-Pokemon detail as JSON
//   --quiet         only print the summary line
//   --help
//
// Recording tips: open a Pokemon, tap Appraise so the three stat bars show,
// then swipe through the box resting about a second on each Pokemon. Frames
// caught mid-swipe are discarded on purpose.
//
// Then feed the result to the team generator:
//   node src/cli.js out/scanned.csv

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { scanVideo } from '../src/videoscan/index.js';
import { toCsv } from '../src/videoscan/csv.js';

function parseArgs(argv) {
  const opts = { out: 'out/scanned.csv', interval: 0.25, deriveLevels: true, quiet: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--out':
        opts.out = argv[++i];
        break;
      case '--json':
        opts.json = argv[++i];
        break;
      case '--interval':
        opts.interval = Number(argv[++i]);
        break;
      case '--no-level':
        opts.deriveLevels = false;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
        rest.push(arg);
    }
  }
  opts.video = rest[0];
  return opts;
}

const USAGE = `Usage: node scripts/scan-video.mjs <video.mp4> [--out out/scanned.csv]
                                   [--interval 0.25] [--no-level] [--json PATH] [--quiet]`;

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (opts.help || !opts.video) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 2);
  }
  if (!Number.isFinite(opts.interval) || opts.interval <= 0) {
    console.error('--interval must be a positive number of seconds');
    process.exit(2);
  }

  const started = Date.now();
  const { mons, warnings, stats } = await scanVideo(opts.video, {
    interval: opts.interval,
    deriveLevels: opts.deriveLevels,
    onProgress: opts.quiet
      ? undefined
      : ({ frames, accepted, t }) => {
          process.stderr.write(`\rscanning ${t.toFixed(1)}s  frames ${frames}  readable ${accepted}   `);
        },
  });
  if (!opts.quiet) process.stderr.write('\r\x1b[K');

  const csv = toCsv(mons);
  mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  writeFileSync(opts.out, csv);
  if (opts.json) {
    mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    writeFileSync(opts.json, `${JSON.stringify({ mons, warnings, stats }, null, 2)}\n`);
  }

  if (!opts.quiet) {
    for (const mon of mons) {
      const level = mon.level === undefined ? '  ?  ' : `L${String(mon.level).padEnd(4)}`;
      console.log(
        `${mon.name.padEnd(22)} CP ${String(mon.cp).padStart(4)}  ${level}  ` +
          `${mon.ivs.atk}/${mon.ivs.def}/${mon.ivs.hp}${mon.shadow ? '  shadow' : ''}`
      );
    }
    if (warnings.length) {
      console.log('');
      for (const w of warnings) console.log(`warning: ${w}`);
    }
    const skipped = Object.entries(stats.rejected)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${n}x ${reason}`)
      .join(', ');
    if (skipped) console.log(`\nskipped frames: ${skipped}`);
  }

  console.log(
    `\n${mons.length} Pokemon from ${stats.accepted}/${stats.frames} readable frames ` +
      `in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${opts.out}`
  );
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
