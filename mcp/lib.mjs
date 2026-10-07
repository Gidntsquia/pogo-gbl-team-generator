// Pure helpers for the pogo-sim MCP server: flag table, command assembly,
// checkpoint -> flags mapping, status parsing, soft-stop decision. No I/O here
// except where noted, so test/mcp.test.js can cover it without spawning sims.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parse `evolve.mjs --help` into a flag table.
 * @param {string} help
 * @returns {Map<string, {takesValue: boolean}>} flag name (no `--`) -> info
 */
export function parseHelpFlags(help) {
  const flags = new Map();
  for (const line of help.split('\n')) {
    const m = /^ {2}--([a-z][\w-]*)(?:[ ,]+(\S+))?/.exec(line);
    if (!m) continue;
    const tok = m[2] ?? '';
    const raw = m[2] ?? '';
    const takesValue = !/^EXPERIMENTAL/.test(raw) && (/^[A-Z]+$/.test(tok) || /[,|]/.test(tok));
    flags.set(m[1], { takesValue });
  }
  return flags;
}

/** Levenshtein distance (small strings). */
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** Nearest valid flag name to `name`. */
export function nearestFlag(name, flags) {
  let best = null;
  let bestD = Infinity;
  for (const f of flags.keys()) {
    const dist = lev(name, f);
    if (dist < bestD) { best = f; bestD = dist; }
  }
  return best;
}

/**
 * Turn {flag: value} into argv. Booleans: true -> `--flag`, false/null skipped.
 * Throws an Error with the nearest valid name on an unknown key.
 * @param {Record<string, unknown>} obj
 * @param {Map<string, {takesValue: boolean}>} flags
 * @returns {string[]}
 */
export function flagsToArgv(obj, flags) {
  const argv = [];
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = k.replace(/^--/, '');
    const info = flags.get(key);
    if (!info) throw new Error(`unknown evolve.mjs flag "${k}" -- did you mean "${nearestFlag(key, flags)}"?`);
    if (v === undefined || v === null || v === false) continue;
    if (info.takesValue) argv.push(`--${key}`, Array.isArray(v) ? v.join(',') : String(v));
    else argv.push(`--${key}`);
  }
  return argv;
}

/**
 * Build the `scripts/sim.sh` argv for run_standard / run_meta.
 * @param {object} a tool args
 * @param {'standard'|'meta'} kind
 * @param {Map} flags evolve flag table (for `extra`)
 * @returns {string[]}
 */
export function simShArgv(a, kind, flags) {
  const argv = [];
  if (kind === 'meta') argv.push('--meta');
  else if (a.csv) argv.push(a.csv);
  const opt = (flag, v) => { if (v !== undefined && v !== null && v !== '') argv.push(flag, String(v)); };
  opt('--name', a.name);
  opt('--cup', a.cup);
  opt('--cp', a.cp);
  if (a.ban?.length) argv.push('--ban', Array.isArray(a.ban) ? a.ban.join(',') : a.ban);
  opt('--hours', a.hours);
  opt('--threads', a.threads ?? 8);
  opt('--generations', a.generations);
  opt('--population', a.population);
  if (kind === 'meta') opt('--meta-pool', a.meta_pool);
  if (a.quick) argv.push('--quick');
  if (a.dry_run) argv.push('--dry-run');
  const extra = flagsToArgv(a.extra, flags);
  if (extra.length) argv.push('--', ...extra);
  return argv;
}

/** camelCase config key -> evolve.mjs flag. Keys not listed are handled in configToArgv. */
const SIMPLE = {
  seed: 'seed', cp: 'cp', cup: 'cup', curatedRatio: 'curated-ratio', difficulty: 'difficulty',
  population: 'population', opponentsPerGen: 'opponents-per-gen', generations: 'generations',
  eliteCount: 'elites', populationFinalRatio: 'population-final-ratio', opponentMetaPool: 'opponent-meta-pool',
  fitness: 'fitness', archetypeBeta: 'archetype-beta', opponentStrengthGamma: 'opponent-strength-gamma',
  candidateStrengthGamma: 'candidate-strength-gamma', snowballWeight: 'snowball-weight', closerWeight: 'closer-weight',
  consistencyWeight: 'consistency-weight', sharedWeaknessWeight: 'shared-weakness-weight',
  opponentSnowballWeight: 'opponent-snowball-weight', opponentCloserWeight: 'opponent-closer-weight',
  opponentConsistencyWeight: 'opponent-consistency-weight', opponentSharedWeaknessWeight: 'opponent-shared-weakness-weight',
  coreRivalry: 'core-rivalry', similarRivalry: 'similar-rivalry', similarFloor: 'similar-floor',
  pool: 'pool', deathRate: 'death-rate', mutationFloor: 'mutation-floor', mutationCeil: 'mutation-ceil',
  mutationFloorStart: 'mutation-floor-start', mutationCeilStart: 'mutation-ceil-start',
  opponentDeathRate: 'opponent-death-rate', opponentMutationFloor: 'opponent-mutation-floor',
  opponentMutationCeil: 'opponent-mutation-ceil', opponentMutationFloorStart: 'opponent-mutation-floor-start',
  opponentMutationCeilStart: 'opponent-mutation-ceil-start', opponentImmigrantFraction: 'opponent-immigrant-fraction',
  immigrantFraction: 'immigrant-fraction', halvingRounds: 'halving-rounds', halvingKeep: 'halving-keep',
  hoeffdingChunk: 'hoeffding-chunk', hoeffdingKeep: 'hoeffding-keep', hoeffdingConfidence: 'hoeffding-confidence',
  sampledCombats: 'sampled-combats', sampledOpponents: 'sampled-opponents', selectionTrailing: 'selection-trailing',
};

/**
 * Rebuild the evolve.mjs argv that produced a checkpoint `config`.
 * Fingerprint keys stored "only when on" (halving, hoeffding, sampled, GA rates)
 * mean "absent = off/default"; halving is on by default so its absence becomes
 * `--halving-rounds 0`. Returns the argv plus `fallbacks`: non-fingerprint flags
 * (final-fresh, final-archive, battle-cache-file, ...) that only launch.json knows.
 * @param {object} config checkpoint config
 * @param {object} [launch] parsed launch.json ({argv}) to take non-fingerprint flags from
 * @returns {{argv: string[], usedLaunch: string[]}}
 */
export function configToArgv(config, launch) {
  const argv = [config.csvPath];
  for (const [key, flag] of Object.entries(SIMPLE)) {
    const v = config[key];
    if (v === undefined || v === null) continue;
    argv.push(`--${flag}`, String(v));
  }
  if (config.halvingRounds === undefined) argv.push('--halving-rounds', '0');
  if (config.hoeffdingRaces) argv.push('--hoeffding-races');
  if (config.evolutions === false && !config.metaMode) argv.push('--no-evolutions');
  if (config.metaMode) argv.push('--meta-mode', '--no-evolutions');
  if (config.randomOpponentLead) argv.push('--random-opponent-lead');
  if (config.fixedOpponents) argv.push('--fixed-opponents');
  if (config.opponentFitnessNormalised === false) argv.push('--no-opponent-fitness-normalised');
  if (config.excludeSpecies?.length) argv.push('--exclude', config.excludeSpecies.join(','));
  if (config.banSpecies?.length) argv.push('--ban', config.banSpecies.join(','));
  if (config.convergence?.window !== undefined) argv.push('--conv-window', String(config.convergence.window));
  if (config.convergence?.topN !== undefined) argv.push('--conv-top-n', String(config.convergence.topN));
  const usedLaunch = [];
  // Non-fingerprint flags: only the launch record knows them.
  const NON_FP = ['final-fresh', 'final-archive', 'battle-cache-file', 'no-battle-cache', 'deadline-minutes', 'no-html', 'profile'];
  const la = launch?.argv ?? [];
  for (let i = 0; i < la.length; i++) {
    const m = /^--(.+)$/.exec(la[i]);
    if (!m || !NON_FP.includes(m[1])) continue;
    const takes = la[i + 1] !== undefined && !la[i + 1].startsWith('--');
    argv.push(la[i], ...(takes ? [la[i + 1]] : []));
    usedLaunch.push(m[1]);
  }
  return { argv, usedLaunch };
}

/** Newest `evolve-gen<N>.json` number from a list of file names, or -1. */
export function latestGen(files) {
  let best = -1;
  for (const f of files) {
    const m = /^evolve-gen(\d+)\.json$/.exec(f);
    if (m) best = Math.max(best, Number(m[1]));
  }
  return best;
}

/**
 * Soft-stop decision: stop once a checkpoint newer than the one seen at start exists, or the run is done.
 * @param {{startGen: number, currentGen: number, done: boolean, pidAlive: boolean}} s
 * @returns {'wait'|'kill'|'exit'}
 */
export function softStopDecision({ startGen, currentGen, done, pidAlive }) {
  if (!pidAlive || done) return 'exit';
  return currentGen > startGen ? 'kill' : 'wait';
}

/** Parse the per-generation `done` log lines. */
export function parseLog(text) {
  const gens = [];
  for (const line of text.split('\n')) {
    const m = /generation (\d+): done -- .*?(\d+) battles simulated \+ (\d+) served from cache.*?(?:(\d+)m )?(\d+)s elapsed, process RSS (\d+)MB/.exec(line);
    if (m) {
      gens.push({
        gen: Number(m[1]), simulated: Number(m[2]), cached: Number(m[3]),
        elapsedSec: Number(m[4] ?? 0) * 60 + Number(m[5]), rssMB: Number(m[6]),
      });
    }
  }
  return gens;
}

const round = (x, n = 4) => (typeof x === 'number' ? Number(x.toFixed(n)) : x);

/**
 * Build the status report body from a checkpoint object and log text.
 * @param {object} cp parsed checkpoint
 * @param {string} logText
 * @param {number} top
 */
export function buildStatus(cp, logText, top = 15) {
  const a = cp.analytics ?? {};
  const teams = (a.topTeams ?? []).slice(0, top).map((t) => ({
    rank: t.rank,
    members: t.members.map((m) => m.name ?? m.speciesId ?? m),
    fitness: round(t.fitness), winRate: round(t.winRate),
    snowball: round(t.snowballIndex), consistency: round(t.consistencyScore),
  }));
  const species = [...(a.speciesStats ?? [])]
    .sort((x, y) => y.meanFitness - x.meanFitness).slice(0, top)
    .map((s) => ({ species: s.speciesId, meanFitness: round(s.meanFitness), representation: round(s.representation) }));
  const oppTeams = (a.toughestOpponents ?? []).slice(0, top)
    .map((o) => ({ name: o.name, origin: o.origin, fitness: round(o.fitness) }));
  // opponent species: mean fitness + representation across opponentPool members
  const agg = new Map();
  (cp.opponentPool ?? []).forEach((team, i) => {
    const fit = cp.opponentFitness?.[i];
    for (const m of team.members ?? []) {
      const e = agg.get(m.speciesId) ?? { n: 0, sum: 0 };
      e.n += 1; e.sum += fit ?? 0; agg.set(m.speciesId, e);
    }
  });
  const poolSize = cp.opponentPool?.length || 1;
  const oppSpecies = [...agg.entries()]
    .map(([id, e]) => ({ species: id, meanFitness: round(e.sum / e.n), representation: round(e.n / poolSize) }))
    .sort((x, y) => y.meanFitness - x.meanFitness).slice(0, top);
  const logGens = parseLog(logText);
  const last5 = logGens.slice(-5);
  const meanElapsed = last5.length ? last5.reduce((s, g) => s + g.elapsedSec, 0) / last5.length : null;
  const gen = latestGenOf(cp);
  const remaining = Math.max(0, (cp.config?.generations ?? 0) - 1 - gen);
  const lastLog = logGens.at(-1);
  return {
    checkpointGeneration: gen,
    generations: cp.config?.generations,
    config: {
      csv: cp.config?.csvPath, cup: cp.config?.cup, cp: cp.config?.cp, population: cp.config?.population,
      opponentsPerGen: cp.config?.opponentsPerGen, sampledOpponents: cp.config?.sampledOpponents, threads: cp.threadsUsed,
    },
    topTeams: teams, topSpecies: species, topOpponentTeams: oppTeams, topOpponentSpecies: oppSpecies,
    speed: {
      lastGenElapsedSec: lastLog?.elapsedSec ?? null,
      msPerBattle: round(cp.timing?.msPerBattle, 2),
      battlesSimulated: lastLog?.simulated ?? cp.timing?.battleCount,
      battlesCached: lastLog?.cached ?? cp.timing?.cachedCount,
      etaMinutes: meanElapsed === null ? null : round((remaining * meanElapsed) / 60, 1),
    },
    memory: { lastLoggedRssMB: lastLog?.rssMB ?? null },
  };
}

function latestGenOf(cp) {
  return cp.generation ?? -1;
}

/** Descendant pids of `root` from `ps -eo pid,ppid,rss` output; also total RSS (MB) incl. root. */
export function processTree(psOut, root) {
  const rows = psOut.trim().split('\n').slice(1).map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  const rss = new Map();
  for (const [pid, ppid, r] of rows) {
    rss.set(pid, r);
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  const pids = [];
  const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    if (!rss.has(p)) continue;
    pids.push(p);
    stack.push(...(kids.get(p) ?? []));
  }
  return { pids, rssMB: Math.round(pids.reduce((s, p) => s + (rss.get(p) ?? 0), 0) / 1024) };
}
