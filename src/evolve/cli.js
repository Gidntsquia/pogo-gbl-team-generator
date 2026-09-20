import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { defaultThreadCount } from '../engine/parallel.js';
import { DEFAULT_VENDOR_ROOT } from '../engine/pvpokeLoader.js';
import { DEFAULT_SELECTION_TRAILING } from '../teams/evolve.js';
import { resolveFormat } from '../util/leagues.js';
import { UserError } from '../util/userError.js';
import { DEFAULTS, FITNESS_MODES } from './config.js';
import { FINAL_FRESH_WHEN_NO_CURATED } from './finalPass.js';
import { formatTeamMembers, pct } from './format.js';
import { DEFAULT_FITNESS_WEIGHTS } from './fitness.js';
import { runEvolution } from './run.js';

export const HELP = `pogo-gbl-team-generator evolve -- genetic-algorithm team search

Usage:
  node scripts/evolve.mjs <collection.csv> [options]

Examples:
  node scripts/evolve.mjs fixtures/sample-pokegenie.csv --generations 3 --population 24
                          a few-minute trial run on the bundled sample collection
  node scripts/evolve.mjs my.csv --cp 2500 --threads 4     Ultra League on 4 threads
  node scripts/evolve.mjs my.csv --deadline-minutes 30     time-boxed search
  scripts/sim.sh my.csv --name mine --hours 1              the full recipe, detached

Options:
  --config PATH           JSON file of {"flag-name": value} pairs (dashed
                            flag names as keys, e.g. {"snowball-weight": 0.2}),
                            applied before individual flags -- an explicit
                            CLI flag always overrides the same key from
                            --config. Lets a recipe collapse to one flag
                            instead of a dozen; see recipes/standard.json
                                                                       (default: none)
  --population N         GA population size                        (default ${DEFAULTS.population})
  --opponents-per-gen M   opponent teams sampled each generation     (default ${DEFAULTS.opponentsPerGen})
                            every pairing battles both directions (candidate-
                            as-A and opponent-as-A, mirrored), so battles per
                            generation = 2 x population x opponents-per-gen
  --generations G         generation cap                            (default ${DEFAULTS.generations})
  --seed S                PRNG seed                                 (default "${DEFAULTS.seed}")
  --threads N             battle via ONE persistent worker-pool executor
                            shared across every generation; this CLI
                            defaults to max(1, cpus-1) capped at 8 (each
                            worker boots its own engine context, so more
                            threads costs memory, not just CPU) -- pass
                            --threads 1 for the serial reference mode, or
                            a value above 8 if the machine has memory to
                            spare                                        (default ${defaultThreadCount()} on this machine)
  --profile                capture a per-worker CPU profile (node:inspector)
                            spanning the whole run, written to
                            <out-dir>/worker-*.cpuprofile and
                            <out-dir>/profile-summary.json on a clean exit
                            (Ctrl-C/kill skips the flush -- only a normal or
                            --deadline-minutes stop captures data). Also adds
                            a live per-generation line: each worker's
                            current+peak heap, scenario-memo size, and
                            mon-cache size, polled between generations for
                            mid-run memory/speed debugging. Process RSS
                            is always logged every generation regardless.
                            Requires --threads > 0 (a no-op in serial mode)
  --deadline-minutes D    optional wall-clock budget (stop before the next
                            generation once past it; no self-tuning)   (default: none)
  --seed-from PATH        pre-bake generation 0's population + opponent pool
                            from another run's evolve-gen<N>.json checkpoint
                            instead of sampling fresh. Ignored if --out-dir
                            already has a matching in-place resume. This is
                            also how to "resume with different flags": point
                            --out-dir at a NEW directory and --seed-from at
                            the old run's checkpoint -- the new run gets its
                            own checkpoint chain from generation 0, seeded
                            with that population, under whatever new flags
                            you pass                                   (default: none)
  --force-fresh           allow starting fresh in an --out-dir whose
                            evolve-gen0.json config doesn't match this run's
                            flags, discarding it (without this, a config
                            mismatch is a hard error instead of a silent
                            overwrite -- see the resume-refusal message)
                                                                         (default: off)
  --cp N                  CP cap / league                            (default ${DEFAULTS.cp})
  --cup NAME              pvpoke cup id (e.g. willpower); restricts candidates,
                            opponents, movesets, usage weights, role priors,
                            and meta group to that cup's format          (default: ${DEFAULTS.cup})
  --halving-rounds R       EXPERIMENTAL Sequential Halving: each generation reveals the
                            opponents in R growing slices (1/2^(R-1) .. all) and drops the
                            weaker teams after each, so cut teams skip most battles.
                            R=3 is roughly half the battles, R=4 a third; 0/1 = off
                            (the full grid)                            (default: off)
  --halving-keep F         fraction of teams kept after each halving round
                            (needs --halving-rounds)                   (default: 0.5)
  --fixed-opponents        freeze the opponent pool: one draw, never evolved
                            and never resized                          (default: off)
  --elites N               last-generation teams (by trailing-mean fitness)
                            given the final evaluation pass; not part of the
                            checkpoint fingerprint, so a finished run can be
                            re-rendered with more                      (default ${DEFAULTS.elites})
  --selection-trailing N   generations each team's fitness is averaged over
                            before the cull/mutation ranking and the finalist
                            pick; 1 = rank on the single generation
                                        (default: DEFAULT_SELECTION_TRAILING, ${DEFAULT_SELECTION_TRAILING})
  --final-archive N        final pass: strongest evolved opponents from the
                            whole run, held out of the generations the
                            finalists were selected on                (default ${DEFAULTS.finalArchive})
  --final-fresh N          final pass: fresh meta-composed opponents never
                            fought during the run -- kept low/off by default,
                            these are essentially random legal teams, not
                            opponent-GA-selected ones (default ${DEFAULTS.finalFresh}, or ${FINAL_FRESH_WHEN_NO_CURATED} at --curated-ratio 0)
  --pool P                 candidate sampling pool size, in species (top P
                            by pvpoke rank)             (default: no cap, whole deduped collection)
  --curated-ratio R        curated-vs-evolved opponent mix             (default ${DEFAULTS.curatedRatio})
  --population-final-ratio R  candidate population at the LAST generation as
                            a fraction of --population; the opponent count
                            grows to match, holding the per-generation
                            battle grid flat                           (default ${DEFAULTS.populationFinalRatio})
  --opponent-meta-pool N   composed opponents are built from the top N species
                            of pvpoke's own overall ranking (0 = the full
                            field; default: the full field under --meta-mode)  (default ${DEFAULTS.opponentMetaPool})
  --no-battle-cache        re-simulate every pairing instead of memoizing
                            identical ones (identical pairings are
                            deterministic, so the memo returns the same
                            numbers -- this is an escape hatch, not a
                            correctness knob)                          (default: cache on)
  --exclude a,b            species ids excluded from candidate teams   (default: none)
  --ban a,b                species ids banned FORMAT-WIDE for a cup rule
                            (e.g. "no Mimikyu, no Cramorant"): dropped from
                            candidate teams AND from the opponent side (whole
                            curated teams containing one, and the composed/
                            evolved-opponent moveset pool). Matched by BASE
                            species id, so a shadow variant is caught too
                            (not a distinct battle/regional-form id --
                            same "base species" rule the rest of this repo
                            uses)                                       (default: none)
  --difficulty D           AI difficulty 0-3 override                 (default: engine default, 3)
  --out PATH               final Markdown report path                 (default <out-dir>/my-teams-evolve.md)
  --html PATH              final HTML report path                     (default <out-dir>/${DEFAULTS.html})
  --no-evolutions          score mons only in the form you own (never evolve them)
  --no-html                skip writing the HTML report
  --out-dir DIR            checkpoints + DONE marker + default reports (default "${DEFAULTS.outDir}")
  --fitness classic|battle-reality  metric selection/mutation/convergence
                            act on -- 'battle-reality' blends win rate with
                            a snowball term and a closer term
                            (default "${DEFAULTS.fitness}")
  --death-rate R           candidate cull fraction per generation
                            (default: src/teams/evolve.js DEFAULT_DEATH_RATE)
  --mutation-floor R       lowest per-survivor mutation chance    (default: DEFAULT_MUTATION_FLOOR)
  --mutation-ceil R        highest per-survivor mutation chance   (default: DEFAULT_MUTATION_CEIL)
  --mutation-floor-start R  hot-start mutation floor at generation 0,
                            annealed linearly down to --mutation-floor (or
                            its default) by the last generation   (default: no anneal)
  --mutation-ceil-start R   hot-start mutation ceil at generation 0, same
                            linear anneal to --mutation-ceil      (default: no anneal)
  --immigrant-fraction R   fresh-immigrant share of the population (default: DEFAULT_IMMIGRANT_FRACTION)
  --opponent-death-rate R            opponent-side cull fraction per generation;
                            mutants can only fill the seats the cull opens,
                            so raise this alongside the mutation rates
                                        (default: DEFAULT_OPPONENT_DEATH_RATE, 0.15)
  --opponent-mutation-floor R        opponent-side mutation floor  (default: DEFAULT_OPPONENT_MUTATION_FLOOR, 0.02)
  --opponent-mutation-ceil R         opponent-side mutation ceil   (default: DEFAULT_OPPONENT_MUTATION_CEIL, 0.2)
  --opponent-mutation-floor-start R  hot-start opponent floor at generation 0,
                            annealed linearly to --opponent-mutation-floor
                                                                   (default: no anneal)
  --opponent-mutation-ceil-start R   hot-start opponent ceil, same anneal to
                            --opponent-mutation-ceil               (default: no anneal)
  --opponent-immigrant-fraction R    opponent-side fresh-immigrant share of
                            the evolvable pool (default: DEFAULT_OPPONENT_IMMIGRANT_FRACTION, 0.08)
  --conv-window N          convergence: consecutive zero-churn generations
                            required                              (default: DEFAULT_CONVERGENCE_WINDOW)
  --conv-top-n N           convergence: size of the top set that must not
                            churn                                 (default: DEFAULT_CONVERGENCE_TOP_N)
  --archetype-beta R       sublinear discount on a crowded opponent
                            archetype's total weight (src/meta/archetypes.js);
                            0 = flat/raw mean, 1 = one-vote-per-archetype
                                                       (default ${DEFAULTS.archetypeBeta})
  --opponent-strength-gamma G  scale each opponent's vote in a candidate's
                            win rate by (that opponent's own win rate)^G, so
                            beating a strong team counts more than beating a
                            weak singleton; 0 = off        (default ${DEFAULTS.opponentStrengthGamma})
  --candidate-strength-gamma G  symmetric, other side of the same ledger:
                            scale each candidate's vote in an opponent's
                            fitness by (that candidate's own win rate)^G, so
                            an opponent that only beat weak candidates
                            doesn't outscore one that beat strong ones;
                            0 = off                (default ${DEFAULTS.candidateStrengthGamma})
  --snowball-weight R      candidate-side fitness weight on snowballScore
                            (own fraction of decided lead exchanges won),
                            on top of winRate=1; see --opponent-snowball-weight
                            for the opponent-side equivalent
                                                       (default ${DEFAULT_FITNESS_WEIGHTS.snowball})
  --closer-weight R        candidate-side fitness weight on closerScore (mean
                            role-prior closer score of the team's two back
                            members), on top of winRate=1; disabled by
                            default (see docs/plans/2026-09-08-fitness-restructure.md)
                                                       (default ${DEFAULT_FITNESS_WEIGHTS.closer})
  --consistency-weight R   candidate-side fitness weight on consistencyScore
                            (worst-quartile per-archetype win rate), on top of
                            winRate=1; disabled by default (same restructure
                            doc as --closer-weight)   (default ${DEFAULT_FITNESS_WEIGHTS.consistency})
  --shared-weakness-weight R  candidate-side fitness weight on
                            sharedWeaknessScore: rank-weighted PvPoke top-200
                            type exposure, softened double weaknesses, partial
                            resistance credit, and selected-move type coverage;
                            on top of winRate=1, battle-reality fitness only,
                            disabled by default, try 0.10-0.20
                            (see src/teams/typeCoverage.js)
                                                       (default ${DEFAULT_FITNESS_WEIGHTS.sharedWeakness})
  --opponent-snowball-weight R  opponent-side equivalent of --snowball-weight,
                            fed the opponent's OWN lead-exchange ledger; blends
                            into src/meta/opponentPool.js's fitness alongside
                            its plain win rate (Jaxon 2026-09-17, symmetry)
                                                       (default ${DEFAULT_FITNESS_WEIGHTS.snowball})
  --opponent-closer-weight R  opponent-side equivalent of --closer-weight
                                                       (default ${DEFAULT_FITNESS_WEIGHTS.closer})
  --opponent-consistency-weight R  opponent-side equivalent of
                            --consistency-weight (worst-quartile win rate
                            across the CANDIDATE archetypes this opponent
                            fought)                    (default ${DEFAULT_FITNESS_WEIGHTS.consistency})
  --opponent-shared-weakness-weight R  opponent-side equivalent of
                            --shared-weakness-weight  (default ${DEFAULT_FITNESS_WEIGHTS.sharedWeakness})
  --core-rivalry R         each better team sharing a two-species core costs
                            a team R x (field's fitness range) before the
                            cull ranks it, in the population and the opponent
                            pool alike; 0 = off             (default ${DEFAULTS.coreRivalry})
  --similar-rivalry S      weight of a maximally similar different-species
                            member in --core-rivalry, relative to the identical
                            species; similarity is pvpoke's own "Similar
                            Pokemon" score (types, moves, traits; 0..1); only a
                            team's most crowded core is charged; 0 = exact
                            cores only                      (default ${DEFAULTS.similarRivalry})
  --similar-floor F        pvpoke similarity at or below which two species are
                            unrelated for --similar-rivalry; above it the match
                            scales linearly (Feraligatr vs Empoleon ~0.55,
                            Charizard vs Blaziken ~0.62)    (default ${DEFAULTS.similarFloor})
  --no-opponent-fitness-normalised  disable frequency-normalised opponent
                            fitness (each candidate's contribution to an
                            opponent's win-rate ledger weighted down by its
                            most-common member's population share); restores
                            the old flat mean                    (default: normalised on)
  --random-opponent-lead   assign every composed opponent a uniform-random
                            lead instead of pvpoke's lead-prior winner,
                            matching the candidate side's own random lead
                            assignment. Use for meta-vs-meta runs, where both
                            sides are meant to be symmetrical -- otherwise the
                            opponent side's realistic leads give it an
                            unearned fitness edge from generation 0 on
                                                                (default: off)
  --check                  validate the flags, the collection path and vendor/pvpoke, then
                            exit without running anything
  --help                   print this help and exit
`;

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function fitnessFlag(value) {
  if (value === undefined) return DEFAULTS.fitness;
  if (!FITNESS_MODES.includes(value)) throw usageError(`--fitness must be one of ${FITNESS_MODES.join('|')}, got "${value}"`);
  return value;
}

/** Value flags that must be non-negative integers: [flag, default] (default undefined = leave unset). */
const INT_FLAGS = [
  ['population', DEFAULTS.population],
  ['opponents-per-gen', DEFAULTS.opponentsPerGen],
  ['generations', DEFAULTS.generations],
  ['deadline-minutes'],
  ['cp', DEFAULTS.cp],
  ['elites', DEFAULTS.elites],
  ['final-archive', DEFAULTS.finalArchive],
  ['final-fresh'], // unset so finalFreshDefault's curated-ratio-aware fallback applies
  ['pool'], // unset so buildRankedPool's "no cap" fallback applies
  ['opponent-meta-pool'], // unset so buildRunConfig picks 100, or the full field under --meta-mode
  ['difficulty'],
  ['conv-window'],
  ['halving-rounds'], // unset/0 = off: every team fights every opponent
  ['conv-top-n'],
];

/** Value flags that must be fractions in [0,1]. */
const FRACTION_FLAGS = [
  ['curated-ratio', DEFAULTS.curatedRatio],
  ['population-final-ratio', DEFAULTS.populationFinalRatio],
  ['death-rate'],
  ['mutation-floor'],
  ['mutation-ceil'],
  ['mutation-floor-start'],
  ['mutation-ceil-start'],
  ['immigrant-fraction'],
  ['opponent-death-rate'],
  ['opponent-mutation-floor'],
  ['opponent-mutation-ceil'],
  ['opponent-mutation-floor-start'],
  ['opponent-mutation-ceil-start'],
  ['opponent-immigrant-fraction'],
  ['archetype-beta'],
];

/** Value flags that must be non-negative numbers. */
const NUMBER_FLAGS = [
  ['opponent-strength-gamma'],
  ['candidate-strength-gamma'],
  ['snowball-weight'],
  ['closer-weight'],
  ['consistency-weight'],
  ['shared-weakness-weight'],
  ['opponent-snowball-weight'],
  ['opponent-closer-weight'],
  ['opponent-consistency-weight'],
  ['opponent-shared-weakness-weight'],
  ['core-rivalry'],
  ['similar-rivalry'],
  ['similar-floor'],
  ['halving-keep'], // unset = 0.5
];

/** Value flags taken as plain strings. */
const STRING_FLAGS = [
  'config', 'seed', 'threads', 'seed-from', 'cup', 'selection-trailing', 'exclude', 'ban', 'out', 'html', 'out-dir', 'fitness',
];

/** Switches. */
const BOOLEAN_FLAGS = [
  'profile', 'force-fresh', 'fixed-opponents', 'no-battle-cache', 'no-html', 'no-evolutions', 'meta-mode',
  'no-opponent-fitness-normalised', 'random-opponent-lead', 'check', 'help',
];

/** Every flag the parser accepts (the test suite checks each appears in HELP). */
export const ACCEPTED_FLAGS = [
  ...INT_FLAGS.map(([f]) => f),
  ...FRACTION_FLAGS.map(([f]) => f),
  ...NUMBER_FLAGS.map(([f]) => f),
  ...STRING_FLAGS,
  ...BOOLEAN_FLAGS,
];

const usageError = (message, fix = 'run with --help to list every flag') => new UserError(message, fix, 2);

/** `opponents-per-gen` -> `opponentsPerGen`; the two exceptions live in KEY_OVERRIDES. */
const KEY_OVERRIDES = { elites: 'eliteCount' };
const optKey = (flag) => KEY_OVERRIDES[flag] ?? flag.replace(/-(\w)/g, (_, c) => c.toUpperCase());

function checkNumber(value, flag, ok, expectation) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !ok(n)) throw usageError(`--${flag} must be ${expectation}, got "${value}"`);
  return n;
}
const parseInt0 = (value, flag) => checkNumber(value, flag, Number.isInteger, 'a non-negative integer') ?? undefined;

function numericOpts(values) {
  const out = {};
  const each = (table, ok, expectation) => {
    for (const [flag, fallback] of table) {
      const n = checkNumber(values[flag], flag, (x) => x >= 0 && ok(x), expectation);
      out[optKey(flag)] = n ?? fallback;
    }
  };
  each(INT_FLAGS, Number.isInteger, 'a non-negative integer');
  each(FRACTION_FLAGS, (x) => x <= 1, 'a number in [0,1]');
  each(NUMBER_FLAGS, () => true, 'a non-negative number');
  return out;
}

const splitList = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

/** Read a `--config` JSON file of {"flag-name": value}; explicit CLI flags win over it. */
function applyConfigFile(values) {
  let fileValues;
  try {
    fileValues = JSON.parse(readFileSync(values.config, 'utf8'));
  } catch (err) {
    throw usageError(`cannot read --config "${values.config}": ${err.message}`, 'pass a JSON file of {"flag-name": value} pairs, e.g. recipes/standard.json');
  }
  for (const [key, val] of Object.entries(fileValues)) {
    if (!ACCEPTED_FLAGS.includes(key)) throw usageError(`unknown key "${key}" in --config ${values.config}`, 'keys are flag names without the leading dashes; see --help');
    if (values[key] === undefined) values[key] = val;
  }
}

/**
 * CLI flag parsing only: argv -> {csvPath, opts}, where `opts` is exactly the
 * object `runEvolution` accepts, or `null` when the caller should just exit
 * (`--help` was printed). Throws UserError on bad input, so a study script can
 * accept the same argv shape without re-declaring the flags.
 *
 * @param {string[]} argv
 * @returns {{csvPath: string, opts: object}|null}
 */
export function parseEvolveArgs(argv) {
  const options = {};
  for (const flag of [...INT_FLAGS.map(([f]) => f), ...FRACTION_FLAGS.map(([f]) => f), ...NUMBER_FLAGS.map(([f]) => f), ...STRING_FLAGS]) {
    options[flag] = { type: 'string' };
  }
  for (const flag of BOOLEAN_FLAGS) options[flag] = { type: 'boolean' };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options });
  } catch (err) {
    const flag = /'(--[\w-]+)/.exec(err.message)?.[1] ?? '';
    throw usageError(err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? `unknown option ${flag}` : err.message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    say(HELP);
    return null;
  }
  if (values.config) applyConfigFile(values);
  if (positionals.length === 0) {
    throw usageError(
      'no collection CSV given',
      'node scripts/evolve.mjs <collection.csv>  (try fixtures/sample-pokegenie.csv; all flags: --help)'
    );
  }

  const opts = {
    ...numericOpts(values),
    seed: values.seed ?? DEFAULTS.seed,
    threads: values.threads !== undefined ? parseInt0(values.threads, 'threads') : defaultThreadCount(),
    profile: !!values.profile,
    seedFrom: values['seed-from'],
    forceFresh: !!values['force-fresh'],
    cup: values.cup ?? DEFAULTS.cup,
    fixedOpponents: !!values['fixed-opponents'],
    selectionTrailing:
      values['selection-trailing'] !== undefined ? Math.max(1, parseInt0(values['selection-trailing'], 'selection-trailing')) : undefined,
    evolutions: !values['no-evolutions'],
    battleCache: !values['no-battle-cache'],
    excludeSpecies: splitList(values.exclude),
    banSpecies: splitList(values.ban),
    outDir: values['out-dir'] ?? DEFAULTS.outDir,
    out: values.out,
    html: values.html,
    noHtml: !!values['no-html'],
    fitness: fitnessFlag(values.fitness),
    metaMode: !!values['meta-mode'],
    opponentFitnessNormalised: values['no-opponent-fitness-normalised'] ? false : undefined,
    randomOpponentLead: values['random-opponent-lead'] ? true : undefined,
  };
  return { csvPath: positionals[0], opts, checkOnly: !!values.check };
}

/**
 * Fail early, with the fix, on the environment problems a new user hits:
 * pvpoke not downloaded, collection file missing, cp/cup pair pvpoke does not ship.
 *
 * @param {string} csvPath
 * @param {{cp: number, cup: string}} opts
 */
export function checkEnvironment(csvPath, opts) {
  if (!existsSync(DEFAULT_VENDOR_ROOT)) {
    throw new UserError("vendor/pvpoke is missing (pvpoke's battle engine and data)", 'npm run setup   (or: bash scripts/setup.sh)', 1);
  }
  if (!existsSync(csvPath)) {
    throw new UserError(
      `collection file not found: ${csvPath}`,
      'check the path; a sample collection is at fixtures/sample-pokegenie.csv',
      1
    );
  }
  try {
    resolveFormat({ cp: opts.cp, cup: opts.cup });
  } catch (err) {
    throw usageError(err.message.replace(/^resolveFormat: /, ''), 'use --cp 500|1500|2500|10000 and, for a cup, one of the cup:cp pairs listed above');
  }
}

/** CLI entry: parse, check the environment, run, print the summary. Errors surface as UserError/Error for the caller to report. */
export async function main(argv) {
  const parsed = parseEvolveArgs(argv);
  if (!parsed) return;
  const { csvPath, opts, checkOnly } = parsed;
  checkEnvironment(csvPath, opts);
  if (checkOnly) {
    say('ok: flags, collection and vendor/pvpoke look fine');
    return;
  }

  const realLog = console.log;
  console.log = () => undefined;
  console.info = () => undefined;
  console.debug = () => undefined;

  let result;
  try {
    result = await runEvolution(csvPath, {
      ...opts,
      onLog: (msg) => process.stderr.write(`${msg}\n`),
      onProgress: () => {},
    });
  } finally {
    console.log = realLog;
  }

  say(`Evolution complete. ${result.generationRecords.length} generation(s) run (${result.stopReason}).`);
  if (result.elites[0]) {
    const top = result.elites[0];
    say(
      `Top team: ${formatTeamMembers(top.members)} -- score ${pct(top.combinedScore)} ` +
        `(${pct(top.winRate)} elites-pass win rate, ${pct(top.recentWinRate)} over the last ${result.ranking.recentWindow} generation(s)).`
    );
  }
  say('');
  say(`Full report written to ${result.reportPath}`);
  if (result.htmlPath) say(`HTML report written to ${result.htmlPath}`);
  say(`Done marker written to ${result.donePath}`);
}
