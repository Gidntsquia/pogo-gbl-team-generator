import { DEFAULT_OPPONENT_MUTATION_FLOOR, DEFAULT_OPPONENT_MUTATION_CEIL } from '../meta/opponentPool.js';
import { DEFAULT_MUTATION_FLOOR, DEFAULT_MUTATION_CEIL } from '../teams/evolve.js';

/** Smallest population the schedule will shrink to, whatever the ratio says -- below this the GA has no gene pool left to work with. Itself capped by `--population`: the floor may not INFLATE a run the caller deliberately asked to keep small (a `--population 8` smoke run must stay at 8). */
const MIN_SCHEDULED_POPULATION = 12;

/**
 * Candidate population for generation `g`: a straight linear ramp from the
 * configured `population` down to `population * populationFinalRatio` at the
 * last allowed generation.
 */
export function populationAt(g, config) {
  const G = Math.max(1, config.generations);
  const t = G > 1 ? Math.min(1, g / (G - 1)) : 0;
  const ratio = 1 - t * (1 - config.populationFinalRatio);
  const floor = Math.min(MIN_SCHEDULED_POPULATION, config.population);
  return Math.max(floor, Math.min(config.population, Math.round(config.population * ratio)));
}

/**
 * Candidate mutation floor/ceil for the generation being evolved FROM `g`
 * (i.e. the rates `nextGeneration` uses when producing generation g+1): a
 * straight linear anneal from the optional hot-start values
 * (`--mutation-floor-start` / `--mutation-ceil-start`) at generation 0 down
 * to the standard floor/ceil (`--mutation-floor` / `--mutation-ceil`, or
 * src/teams/evolve.js's defaults) at the last allowed generation -- same
 * ramp shape and indexing as {@link populationAt}. With no start value set,
 * each rate is constant across the run (the pre-anneal behavior, exactly).
 * Pure function of (g, config), so a resumed run recomputes the same rates.
 *
 * @param {number} g - generation index.
 * @param {object} config - resolved run config (buildRunConfig shape).
 * @returns {{mutationFloor: number, mutationCeil: number}}
 */
export function mutationRatesAt(g, config) {
  const endFloor = config.mutationFloor ?? DEFAULT_MUTATION_FLOOR;
  const endCeil = config.mutationCeil ?? DEFAULT_MUTATION_CEIL;
  const startFloor = config.mutationFloorStart ?? endFloor;
  const startCeil = config.mutationCeilStart ?? endCeil;
  const G = Math.max(1, config.generations);
  const t = G > 1 ? Math.min(1, g / (G - 1)) : 1;
  return {
    mutationFloor: startFloor + t * (endFloor - startFloor),
    mutationCeil: startCeil + t * (endCeil - startCeil),
  };
}

/**
 * Opponent-side mutation floor/ceil for the generation being evolved FROM
 * `g` -- the same linear anneal as {@link mutationRatesAt}, driven by the
 * `--opponent-mutation-*` flags and falling back to
 * src/meta/opponentPool.js's defaults. With nothing set the opponent GA runs
 * at its constant defaults, exactly as before these flags existed.
 *
 * @param {number} g - generation index.
 * @param {object} config - resolved run config (buildRunConfig shape).
 * @returns {{mutationFloor: number, mutationCeil: number}}
 */
export function opponentMutationRatesAt(g, config) {
  const endFloor = config.opponentMutationFloor ?? DEFAULT_OPPONENT_MUTATION_FLOOR;
  const endCeil = config.opponentMutationCeil ?? DEFAULT_OPPONENT_MUTATION_CEIL;
  const startFloor = config.opponentMutationFloorStart ?? endFloor;
  const startCeil = config.opponentMutationCeilStart ?? endCeil;
  const G = Math.max(1, config.generations);
  const t = G > 1 ? Math.min(1, g / (G - 1)) : 1;
  return {
    mutationFloor: startFloor + t * (endFloor - startFloor),
    mutationCeil: startCeil + t * (endCeil - startCeil),
  };
}

/**
 * Opponent-pool size for generation `g`: DERIVED from the population so the
 * per-generation battle grid (population x opponents) stays at its gen-0
 * value. That is what makes the trade cost-neutral -- the run does not get
 * slower as it narrows, it just re-spends the same battles on a better
 * question.
 */
export function opponentsAt(g, config) {
  const budget = config.population * config.opponentsPerGen;
  return Math.max(1, Math.round(budget / populationAt(g, config)));
}
