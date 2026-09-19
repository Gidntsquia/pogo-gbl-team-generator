#!/usr/bin/env node
/**
 * Measure how far apart the candidate and opponent sides of a meta-vs-meta
 * evolve run land, on a fixed BASE config, across several seeds -- the one
 * repeatable check `plans/PLAN.md` ("fitness-symmetry" loop) is built around.
 *
 * `run --label L [--seeds s1,s2,...] [--population N --opponents-per-gen N]
 *   [-- extra evolve flags]`
 *   Runs BASE once per seed into `out/evolve-symgap-<L>-<seed>`, logging to
 *   `out/evolve-symgap-<L>-<seed>.log`, one seed at a time (never alongside
 *   another evolve run). Skips a seed whose directory already holds the
 *   configured final generation's checkpoint.
 *
 * `report --label L`
 *   Reads only each run's checkpoint `analytics` blocks (gen 0 and the final
 *   generation) and prints, per seed: gen-0 gap, final-generation gap and
 *   all-generation mean gap, for blend fitness, weighted win rate and raw
 *   win rate (candidate minus opponent, sign preserved -- never averaged as
 *   |gap|, which would hide which side is ahead). Then mean, SD and SE
 *   across seeds, a verdict line, and writes the same numbers to
 *   `out/symmetry-gap-<L>.json`. Exits 0 only if |mean final blend|,
 *   |mean final raw|, |mean all-gen blend| and |mean all-gen raw| are all
 *   <= 0.02; exits 1 otherwise (including when a seed's run directory is
 *   missing or short of checkpoints -- never silently excluded).
 *
 * `report --label A --minus B`
 *   Prints the per-seed paired difference (A's final-gen gap) - (B's
 *   final-gen gap), for blend and raw, with mean and SE. Requires the same
 *   seed set in both labels.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(REPO_ROOT, 'out');
const BASE_CSV = join(OUT_DIR, 'meta-collection-willpower-1500.csv');
const THRESHOLD = 0.02;
const DEFAULT_SEEDS = ['s1', 's2', 's3', 's4', 's5'];

// BASE config from plans/PLAN.md, as flag pairs (population/opponents-per-gen
// overridable, seed always overridden per run).
const BASE_FLAGS = [
  '--cp', '1500',
  '--cup', 'willpower',
  '--curated-ratio', '0',
  '--population', '60',
  '--opponents-per-gen', '60',
  '--generations', '8',
  '--pool', '70',
  '--opponent-meta-pool', '70',
  '--fitness', 'battle-reality',
  '--archetype-beta', '0.5',
  '--random-opponent-lead',
  '--opponent-strength-gamma', '1',
  '--candidate-strength-gamma', '1',
  '--snowball-weight', '0.4',
  '--closer-weight', '0.1',
  '--consistency-weight', '0.2',
  '--core-rivalry', '0.2',
  '--similar-rivalry', '1',
  '--similar-floor', '0.35',
  '--shared-weakness-weight', '0.2',
  '--opponent-snowball-weight', '0.4',
  '--opponent-closer-weight', '0.1',
  '--opponent-consistency-weight', '0.2',
  '--opponent-shared-weakness-weight', '0.2',
  '--death-rate', '0.2',
  '--mutation-floor', '0.05',
  '--mutation-ceil', '0.4',
  '--mutation-floor-start', '0.15',
  '--mutation-ceil-start', '0.6',
  '--opponent-death-rate', '0.2',
  '--opponent-mutation-floor', '0.05',
  '--opponent-mutation-ceil', '0.4',
  '--opponent-mutation-floor-start', '0.15',
  '--opponent-mutation-ceil-start', '0.6',
  '--opponent-immigrant-fraction', '0.08',
  '--immigrant-fraction', '0.08',
  '--population-final-ratio', '1',
  // Meta mode (Item 3): both sides draw from one species universe. Labels `base`..`finalv14`
  // predate it and were run without; `meta3`, `final`, `real` passed it as an extra flag.
  '--meta-mode',
  '--threads', '8',
];

function usage() {
  process.stderr.write(
    'usage:\n' +
      '  node scripts/symmetry-gap.mjs run --label L [--seeds s1,s2,...] [--population N --opponents-per-gen N] [-- extra evolve flags]\n' +
      '  node scripts/symmetry-gap.mjs report --label L\n' +
      '  node scripts/symmetry-gap.mjs report --label A --minus B\n',
  );
}

function parseFlags(argv) {
  const out = { extra: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out.extra = argv.slice(i + 1);
      break;
    } else if (a === '--label') {
      out.label = argv[++i];
    } else if (a === '--minus') {
      out.minus = argv[++i];
    } else if (a === '--seeds') {
      out.seeds = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--population') {
      out.population = argv[++i];
    } else if (a === '--opponents-per-gen') {
      out.opponentsPerGen = argv[++i];
    } else {
      out.extra.push(a);
    }
  }
  return out;
}

function runDirFor(label, seed) {
  return join(OUT_DIR, `evolve-symgap-${label}-${seed}`);
}

function finalGenIndex(flags) {
  const idx = flags.lastIndexOf('--generations');
  const n = idx >= 0 ? Number(flags[idx + 1]) : 8;
  return n - 1;
}

function checkpointExists(dir, gen) {
  return existsSync(join(dir, `evolve-gen${gen}.json`));
}

function cmdRun(opts) {
  if (!opts.label) {
    process.stderr.write('run: --label is required\n');
    process.exit(2);
  }
  const seeds = opts.seeds ?? DEFAULT_SEEDS;
  const flags = [...BASE_FLAGS];
  if (opts.population) {
    flags.push('--population', opts.population, '--opponents-per-gen', opts.opponentsPerGen ?? opts.population);
  } else if (opts.opponentsPerGen) {
    flags.push('--opponents-per-gen', opts.opponentsPerGen);
  }
  flags.push(...opts.extra);
  const finalGen = finalGenIndex(flags);

  for (const seed of seeds) {
    const dir = runDirFor(opts.label, seed);
    if (checkpointExists(dir, finalGen)) {
      console.log(`symmetry-gap: ${dir} already has gen ${finalGen}, skipping`);
      continue;
    }
    mkdirSync(OUT_DIR, { recursive: true });
    const logPath = `${dir}.log`;
    const args = [
      'scripts/evolve.mjs',
      BASE_CSV,
      '--seed', seed,
      '--out-dir', dir,
      ...flags,
    ];
    console.log(`symmetry-gap: running seed ${seed} -> ${dir} (log ${logPath})`);
    const result = spawnSync(process.execPath, args, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    writeFileSync(logPath, (result.stdout ?? '') + (result.stderr ?? ''), 'utf8');
    if (result.status !== 0) {
      console.error(`symmetry-gap: seed ${seed} failed (exit ${result.status}); see ${logPath}`);
      process.exit(1);
    }
    if (!checkpointExists(dir, finalGen)) {
      console.error(`symmetry-gap: seed ${seed} finished but ${dir}/evolve-gen${finalGen}.json is missing`);
      process.exit(1);
    }
  }
}

function readAnalytics(dir) {
  const genFiles = readdirSync(dir)
    .map((name) => {
      const m = name.match(/^evolve-gen(\d+)\.json$/);
      return m ? { name, gen: Number(m[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.gen - b.gen);
  return genFiles.map(({ name, gen }) => {
    const cp = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const a = cp.analytics ?? {};
    return {
      gen,
      blendGap: numDiff(a.meanFitness, a.opponentMeanFitness),
      weightedGap: numDiff(a.candidateWeightedWinRateMean, a.opponentWeightedWinRateMean),
      rawGap: numDiff(a.candidateRawWinRateMean, a.opponentRawWinRateMean),
      fitnessSemantics: cp.config?.fitnessSemantics,
    };
  });
}

function numDiff(a, b) {
  return typeof a === 'number' && typeof b === 'number' ? a - b : undefined;
}

function mean(xs) {
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}
function sd(xs) {
  if (xs.length < 2) return undefined;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}
function se(xs) {
  const s = sd(xs);
  return s === undefined ? undefined : s / Math.sqrt(xs.length);
}
function fmt(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : 'n/a';
}

function seedDirsForLabel(label) {
  if (!existsSync(OUT_DIR)) return [];
  return readdirSync(OUT_DIR)
    .filter((name) => name.startsWith(`evolve-symgap-${label}-`) && !name.endsWith('.log'))
    .map((name) => ({ seed: name.slice(`evolve-symgap-${label}-`.length), dir: join(OUT_DIR, name) }));
}

function cmdReport(opts) {
  if (!opts.label) {
    process.stderr.write('report: --label is required\n');
    process.exit(2);
  }
  const entries = seedDirsForLabel(opts.label).sort((a, b) => a.seed.localeCompare(b.seed));
  if (entries.length === 0) {
    console.error(`symmetry-gap: no out/evolve-symgap-${opts.label}-* directories found`);
    process.exit(1);
  }

  const perSeed = [];
  let anyMissing = false;
  for (const { seed, dir } of entries) {
    const rows = readAnalytics(dir);
    if (rows.length === 0) {
      console.error(`symmetry-gap: ${dir} has no checkpoints`);
      anyMissing = true;
      continue;
    }
    const gen0 = rows[0];
    const final = rows[rows.length - 1];
    const allBlend = rows.map((r) => r.blendGap).filter((v) => v !== undefined);
    const allRaw = rows.map((r) => r.rawGap).filter((v) => v !== undefined);
    perSeed.push({
      seed,
      dir,
      generations: rows.length,
      gen0Blend: gen0.blendGap,
      gen0Raw: gen0.rawGap,
      finalBlend: final.blendGap,
      finalWeighted: final.weightedGap,
      finalRaw: final.rawGap,
      allGenBlendMean: allBlend.length ? mean(allBlend) : undefined,
      allGenRawMean: allRaw.length ? mean(allRaw) : undefined,
      fitnessSemantics: final.fitnessSemantics,
    });
  }

  if (opts.minus) {
    return cmdReportMinus(opts, perSeed);
  }

  console.log(`symmetry-gap report --label ${opts.label}`);
  console.log('seed\tgen0Blend\tgen0Raw\tfinalBlend\tfinalWeighted\tfinalRaw\tallGenBlendMean\tallGenRawMean\tsemantics');
  for (const r of perSeed) {
    console.log(
      [r.seed, fmt(r.gen0Blend), fmt(r.gen0Raw), fmt(r.finalBlend), fmt(r.finalWeighted), fmt(r.finalRaw), fmt(r.allGenBlendMean), fmt(r.allGenRawMean), r.fitnessSemantics ?? 'n/a'].join('\t'),
    );
  }

  const finalBlends = perSeed.map((r) => r.finalBlend).filter((v) => v !== undefined);
  const finalRaws = perSeed.map((r) => r.finalRaw).filter((v) => v !== undefined);
  const allBlends = perSeed.map((r) => r.allGenBlendMean).filter((v) => v !== undefined);
  const allRaws = perSeed.map((r) => r.allGenRawMean).filter((v) => v !== undefined);

  const summary = {
    label: opts.label,
    seeds: perSeed.map((r) => r.seed),
    meanFinalBlend: finalBlends.length ? mean(finalBlends) : undefined,
    seFinalBlend: se(finalBlends),
    meanFinalRaw: finalRaws.length ? mean(finalRaws) : undefined,
    seFinalRaw: se(finalRaws),
    meanAllGenBlend: allBlends.length ? mean(allBlends) : undefined,
    seAllGenBlend: se(allBlends),
    meanAllGenRaw: allRaws.length ? mean(allRaws) : undefined,
    seAllGenRaw: se(allRaws),
    perSeed,
  };

  console.log('');
  console.log(
    `mean final blend gap: ${fmt(summary.meanFinalBlend)} (SE ${fmt(summary.seFinalBlend)})  ` +
      `mean final raw gap: ${fmt(summary.meanFinalRaw)} (SE ${fmt(summary.seFinalRaw)})`,
  );
  console.log(
    `mean all-gen blend gap: ${fmt(summary.meanAllGenBlend)} (SE ${fmt(summary.seAllGenBlend)})  ` +
      `mean all-gen raw gap: ${fmt(summary.meanAllGenRaw)} (SE ${fmt(summary.seAllGenRaw)})`,
  );

  const within = (v) => typeof v === 'number' && Math.abs(v) <= THRESHOLD;
  const pass =
    !anyMissing &&
    perSeed.length > 0 &&
    within(summary.meanFinalBlend) &&
    within(summary.meanFinalRaw) &&
    within(summary.meanAllGenBlend) &&
    within(summary.meanAllGenRaw);

  console.log(pass ? 'VERDICT: PASS (<= 0.02 on all four)' : 'VERDICT: FAIL');

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `symmetry-gap-${opts.label}.json`), JSON.stringify(summary, null, 2), 'utf8');

  process.exit(pass ? 0 : 1);
}

function cmdReportMinus(opts, perSeedA) {
  const entriesB = seedDirsForLabel(opts.minus).sort((a, b) => a.seed.localeCompare(b.seed));
  const perSeedB = entriesB.map(({ seed, dir }) => {
    const rows = readAnalytics(dir);
    const final = rows[rows.length - 1];
    return { seed, finalBlend: final?.blendGap, finalRaw: final?.rawGap };
  });

  const byA = new Map(perSeedA.map((r) => [r.seed, r]));
  const byB = new Map(perSeedB.map((r) => [r.seed, r]));
  const commonSeeds = [...byA.keys()].filter((s) => byB.has(s));
  if (commonSeeds.length === 0) {
    console.error(`symmetry-gap: no common seeds between ${opts.label} and ${opts.minus}`);
    process.exit(1);
  }

  console.log(`symmetry-gap --minus: (${opts.label}) - (${opts.minus}), final-generation gaps`);
  console.log('seed\tblendDiff\trawDiff');
  const blendDiffs = [];
  const rawDiffs = [];
  for (const seed of commonSeeds) {
    const a = byA.get(seed);
    const b = byB.get(seed);
    const blendDiff = numDiff(a.finalBlend, b.finalBlend);
    const rawDiff = numDiff(a.finalRaw, b.finalRaw);
    if (blendDiff !== undefined) blendDiffs.push(blendDiff);
    if (rawDiff !== undefined) rawDiffs.push(rawDiff);
    console.log([seed, fmt(blendDiff), fmt(rawDiff)].join('\t'));
  }
  console.log('');
  console.log(
    `mean blend diff: ${fmt(mean(blendDiffs))} (SE ${fmt(se(blendDiffs))})  ` +
      `mean raw diff: ${fmt(mean(rawDiffs))} (SE ${fmt(se(rawDiffs))})`,
  );
  process.exit(0);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'run') {
    cmdRun(parseFlags(rest));
  } else if (cmd === 'report') {
    cmdReport(parseFlags(rest));
  } else {
    usage();
    process.exit(2);
  }
}

main();
