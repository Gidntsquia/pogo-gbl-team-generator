// Shared definitions + pure helpers for the recipe A/B chain (plans/PLAN.md, 2026-10-04).
//   node scripts/recipe-ab-lib.mjs args <1|2|3> [--smoke]   -> sim.sh argument line for that sim
//   node scripts/recipe-ab-lib.mjs name <1|2|3> [--smoke]   -> run name
// Imported by recipe-ab-check.mjs, recipe-ab-score.mjs, recipe-ab-report.mjs and test/recipeAb.test.js.

export const SEED = 'recipe-ab';
export const QUALITY_TOP_N = 5;
export const VERDICT_MARGIN = 0.03;
export const COLLECTION = 'jaxon-gl-collection.csv';

/** Flags shared by all three sims (requirement 2). */
const SHARED_PASSTHROUGH = [
  '--seed', SEED, '--curated-ratio', '0.66', '--opponent-meta-pool', '400', '--archetype-beta', '0.5',
  '--opponent-strength-gamma', '1', '--similar-rivalry', '1', '--similar-floor', '0.35',
];

/** The three sims: expected effective settings (real sizes, or tiny smoke sizes). */
export function simDefs(smoke = false) {
  const prefix = smoke ? 'recipe-ab-smoke' : 'recipe-ab';
  const gens = smoke ? 3 : 100;
  const old = smoke
    ? { population: 30, finalRatio: 0.4, opponents: 12, k: null }
    : { population: 300, finalRatio: 0.4, opponents: 120, k: null };
  const nu = smoke
    ? { population: 20, finalRatio: 1, opponents: 40, k: 10 }
    : { population: 200, finalRatio: 1, opponents: 566, k: 400 };
  return [
    { n: 1, name: `${prefix}-old-nohalving`, recipe: 'recipes/recipe-ab-old.json', halving: 0, generations: gens, ...old },
    { n: 2, name: `${prefix}-old-halving`, recipe: 'recipes/recipe-ab-old.json', halving: 3, generations: gens, ...old },
    { n: 3, name: `${prefix}-new`, recipe: 'recipes/standard.json', halving: 3, generations: gens, ...nu },
  ];
}

/** Argument list for scripts/sim.sh (without --dry-run / --fg). */
export function simArgs(def, smoke = false) {
  const threads = smoke ? '4' : '8';
  const a = [COLLECTION, '--name', def.name, '--cup', 'mega', '--threads', threads,
    '--population', String(def.population), '--generations', String(def.generations),
    '--mutation-floor-start', '0.15', '--mutation-ceil-start', '0.6', '--',
    '--config', def.recipe, ...SHARED_PASSTHROUGH,
    '--population-final-ratio', String(def.finalRatio), '--halving-rounds', String(def.halving)];
  if (smoke) a.push('--opponents-per-gen', String(def.opponents));
  if (smoke && def.k) a.push('--sampled-opponents', String(def.k));
  return a;
}

/**
 * Running wall time of one sim: sum of per-generation elapsedMs plus the final pass's elapsedMs.
 * Downtime between an attempt's end and the next attempt's start is excluded and reported separately.
 * @param {{elapsedMs:number}[]} generationTimings
 * @param {number} finalPassMs
 * @param {{start:number,end:number}[]} attempts epoch ms, in order
 */
export function wallTime(generationTimings, finalPassMs, attempts = []) {
  const runningMs = generationTimings.reduce((s, t) => s + (t?.elapsedMs ?? 0), 0) + (finalPassMs ?? 0);
  let downtimeMs = 0;
  for (let i = 1; i < attempts.length; i++) downtimeMs += Math.max(0, attempts[i].start - attempts[i - 1].end);
  return { runningMs, downtimeMs };
}

/** Quality = mean curated-100 win rate of the top `n` finalists (they are already in rank order). */
export function quality(curatedWinRates, n = QUALITY_TOP_N) {
  const top = (curatedWinRates ?? []).slice(0, n);
  return top.length ? top.reduce((s, x) => s + x, 0) / top.length : null;
}

/**
 * Verdict for earlier vs later sim. `keep`: later quality not lower by more than the margin AND later wall time lower;
 * `worse`: lower by more than the margin; otherwise `not distinguishable`. Either side null -> `not available`.
 * @param {{quality:number|null, wallMs:number|null}|null} earlier
 * @param {{quality:number|null, wallMs:number|null}|null} later
 */
export function verdict(earlier, later, margin = VERDICT_MARGIN) {
  if (!earlier || !later || earlier.quality == null || later.quality == null) return { verdict: 'not available', gap: null };
  const gap = later.quality - earlier.quality;
  if (gap < -margin - 1e-12) return { verdict: 'worse', gap };
  if (later.wallMs != null && earlier.wallMs != null && later.wallMs < earlier.wallMs) return { verdict: 'keep', gap };
  return { verdict: 'not distinguishable', gap };
}

const lineKey = (members) => `${members[0]}||${[...members.slice(1)].sort().join('|')}`;
export function speciesOf(member) { return String(member).split('#')[0]; }
/** Two-species core = the team's two most-shared species pair; here: unordered pairs of species in the team. */
export function corePairs(members) {
  const sp = [...new Set(members.map(speciesOf))].sort();
  const out = [];
  for (let i = 0; i < sp.length; i++) for (let j = i + 1; j < sp.length; j++) out.push(`${sp[i]}+${sp[j]}`);
  return out;
}
export function teamKey(members) { return lineKey(members.map(speciesOf)); }

/**
 * Overlap of top lists. `lists` = {simName: [members[]]}. Returns per-team marks and pairwise shared counts.
 * Team identity = lead species + set of other species (rows ignored); core = any unordered species pair; species = any.
 */
export function overlap(lists) {
  const names = Object.keys(lists);
  const sets = {};
  for (const n of names) {
    sets[n] = {
      teams: new Set(lists[n].map(teamKey)),
      cores: new Set(lists[n].flatMap(corePairs)),
      species: new Set(lists[n].flatMap((m) => m.map(speciesOf))),
    };
  }
  const pairs = [];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const [a, b] = [sets[names[i]], sets[names[j]]];
    const inter = (x, y) => [...x].filter((v) => y.has(v)).length;
    pairs.push({ a: names[i], b: names[j], teams: inter(a.teams, b.teams), cores: inter(a.cores, b.cores), species: inter(a.species, b.species) });
  }
  const marks = {};
  for (const n of names) {
    marks[n] = lists[n].map((members) => {
      const others = names.filter((o) => o !== n);
      return {
        teamIn: others.filter((o) => sets[o].teams.has(teamKey(members))),
        coresIn: [...new Set(corePairs(members).flatMap((c) => others.filter((o) => sets[o].cores.has(c)).map((o) => `${c}@${o}`)))],
        speciesShared: [...new Set(members.map(speciesOf))].filter((s) => others.some((o) => sets[o].species.has(s))),
      };
    });
  }
  return { marks, pairs };
}

export const fmtMs = (ms) => {
  if (ms == null) return 'n/a';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, nStr, flag] = process.argv.slice(2);
  const smoke = flag === '--smoke';
  const def = simDefs(smoke).find((d) => d.n === Number(nStr));
  if (!def || !['args', 'name'].includes(cmd)) { console.error('usage: recipe-ab-lib.mjs args|name <1|2|3> [--smoke]'); process.exit(2); }
  console.log(cmd === 'name' ? def.name : simArgs(def, smoke).join(' '));
}
