// JavaScript Document
//
// Power-up (build) cost for a Pokemon: how much Stardust and Candy it takes to
// bring one from the level it is at today to the level the simulator plays it
// at. Pure arithmetic over a fixed published cost table -- no engine, no I/O,
// no battle math, so it unit-tests standalone.
//
// WHY THIS EXISTS: src/engine/harness.js's buildPokemon always levels a mon to
// the highest level whose CP still fits under the league cap. That is the
// right thing to simulate (it's what the mon *would* be if you built it), but
// it means a recommended team can quietly assume a lot of investment you
// haven't made yet. Attaching the Stardust/Candy bill to each ranked team lets
// you decide whether a team is worth building before you spend anything.
//
// SOURCE OF THE TABLE: the published per-half-level power-up costs (Bulbapedia
// "Stardust" / power-up cost table). Neither this repo nor vendor/pvpoke ships
// one -- pvpoke only carries per-species `thirdMoveCost` -- so the bands below
// are transcribed rather than derived. They are pinned by the two totals the
// tests assert, which are the figures published alongside the table:
//   level  1 -> 40:  270,000 Stardust + 304 Candy
//   level 40 -> 50:  250,000 Stardust + 296 Candy XL
//
// The Stardust and Candy bands deliberately do NOT line up (Stardust changes
// at 25, Candy at 26); that asymmetry is in the real table and is exactly what
// makes those two totals come out right.

/** Levels 40+ consume Candy XL instead of ordinary Candy. */
const XL_CANDY_LEVEL = 40;

/**
 * Highest level a power-up can pay for. Level 51 exists only as the free
 * Best Buddy boost, so a 50 -> 51 step costs nothing.
 */
export const MAX_PAID_LEVEL = 50;

/** Absolute level ceiling (50, or 51 while the mon is your Best Buddy). */
export const MAX_LEVEL = 51;

// [fromLevelInclusive, fromLevelInclusive, cost] -- cost of the ONE power-up
// that takes a mon from any half-level in the band to the next half-level.
const STARDUST_BANDS = [
  [1, 2.5, 200], [3, 4.5, 400], [5, 6.5, 600], [7, 8.5, 800], [9, 10.5, 1000],
  [11, 12.5, 1300], [13, 14.5, 1600], [15, 16.5, 1900], [17, 18.5, 2200], [19, 20.5, 2500],
  [21, 22.5, 3000], [23, 24.5, 3500], [25, 26.5, 4000], [27, 28.5, 4500], [29, 30.5, 5000],
  [31, 32.5, 6000], [33, 34.5, 7000], [35, 36.5, 8000], [37, 38.5, 9000], [39, 39.5, 10000],
  [40, 40.5, 10000], [41, 42.5, 11000], [43, 44.5, 12000], [45, 46.5, 13000],
  [47, 48.5, 14000], [49, 49.5, 15000],
];

const CANDY_BANDS = [
  [1, 10.5, 1], [11, 20.5, 2], [21, 25.5, 3], [26, 30.5, 4],
  [31, 32.5, 6], [33, 34.5, 8], [35, 36.5, 10], [37, 38.5, 12], [39, 39.5, 15],
  // Candy XL from level 40 up.
  [40, 41.5, 10], [42, 43.5, 12], [44, 45.5, 15], [46, 47.5, 17], [48, 49.5, 20],
];

function bandValue(bands, level, what) {
  for (const [lo, hi, cost] of bands) {
    if (level >= lo && level <= hi) return cost;
  }
  throw new Error(`powerUpCost: no ${what} band covers level ${level}`);
}

/**
 * Per-power-up cost multiplier. Shadow Pokemon cost 20% more Stardust and
 * Candy, purified 10% less; the multiplier is applied to each individual
 * power-up and rounded UP, which is what reproduces the published Shadow
 * (360 Candy XL) and Purified (272 Candy XL) level-40->50 totals. Lucky
 * Pokemon separately cost half Stardust (Candy is unaffected).
 */
function multiplierFor({ shadow, purified }) {
  if (shadow) return 1.2;
  if (purified) return 0.9;
  return 1;
}

function isHalfLevel(x) {
  return typeof x === 'number' && Number.isFinite(x) && Number.isInteger(x * 2);
}

/**
 * Stardust and Candy needed to power one Pokemon up from `fromLevel` to
 * `toLevel`.
 *
 * A mon already at or above the target costs nothing (the simulator simply
 * plays it at the level the CP cap allows). Steps at level 40 and above spend
 * Candy XL rather than ordinary Candy, so the two are reported separately --
 * Candy XL can't be bought, which is often the deciding factor.
 *
 * @param {number} fromLevel - the mon's current level (half-levels, 1..51).
 * @param {number} toLevel - the level the simulator plays it at (1..51).
 * @param {{shadow?: boolean, purified?: boolean, lucky?: boolean}} [opts]
 * @returns {{stardust: number, candy: number, candyXl: number, steps: number}}
 */
export function powerUpCost(fromLevel, toLevel, opts = {}) {
  if (!isHalfLevel(fromLevel) || fromLevel < 1 || fromLevel > MAX_LEVEL) {
    throw new Error(`powerUpCost: fromLevel must be a half-level 1..${MAX_LEVEL}, got ${fromLevel}`);
  }
  if (!isHalfLevel(toLevel) || toLevel < 1 || toLevel > MAX_LEVEL) {
    throw new Error(`powerUpCost: toLevel must be a half-level 1..${MAX_LEVEL}, got ${toLevel}`);
  }

  const multiplier = multiplierFor(opts);
  const cost = { stardust: 0, candy: 0, candyXl: 0, steps: 0 };

  // Level 50 -> 51 is the free Best Buddy boost, never a paid power-up.
  const last = Math.min(toLevel, MAX_PAID_LEVEL);
  for (let level = fromLevel; level < last; level += 0.5) {
    let dust = Math.ceil(bandValue(STARDUST_BANDS, level, 'stardust') * multiplier);
    if (opts.lucky) dust = Math.ceil(dust / 2);
    const candy = Math.ceil(bandValue(CANDY_BANDS, level, 'candy') * multiplier);

    cost.stardust += dust;
    if (level >= XL_CANDY_LEVEL) cost.candyXl += candy;
    else cost.candy += candy;
    cost.steps += 1;
  }

  return cost;
}

/**
 * @typedef {object} MemberBuildCost
 * @property {string} key - userMonKey, matching the team member it came from.
 * @property {string} name - display name.
 * @property {number|null} fromLevel - current level, or null when the
 *   collection CSV didn't state one (nothing is guessed).
 * @property {number} toLevel - the level the simulator plays this mon at.
 * @property {number} stardust
 * @property {number} candy - power-up candy plus any evolution candy.
 * @property {number} candyXl
 * @property {number} evolveCandy - the evolution part of `candy`, 0 when this
 *   member is already the form you own.
 * @property {string|null} evolveFrom - display name of the form you actually
 *   own, when this member has to be evolved to exist.
 * @property {string[]} evolveItems - evolution items the path needs
 *   (e.g. "Sinnoh Stone"), which candy alone doesn't cover.
 * @property {number|null} evolveBuddyKm - buddy km the path requires, if any.
 * @property {boolean} known - false when `fromLevel` was unavailable, in which
 *   case the power-up figures are 0 and this member is flagged in the team
 *   total. Evolution candy is still counted: it doesn't depend on level.
 * @property {boolean} evolvePriced - false when this member needs an
 *   evolution the official GAME_MASTER doesn't price (see
 *   src/cost/evolutionCandy.json's `_unpriced`).
 */

/**
 * Total build cost for a team, plus the per-member breakdown.
 *
 * Two things can make a bill partial, and both set `complete: false` rather
 * than quietly under-reporting: a member whose collection row stated no level
 * (its power-ups can't be priced) and a member that needs an evolution the
 * published data doesn't price. `evolveItems` is carried separately because
 * items are a real blocker that candy totals don't express.
 *
 * @param {Array<{key?: string, name?: string, currentLevel?: number|null,
 *   targetLevel: number, shadow?: boolean, purified?: boolean, lucky?: boolean,
 *   evolution?: {fromName?: string, candy: number|null, items?: string[],
 *   buddyKm?: number|null}|null}>} members
 * @returns {{stardust: number, candy: number, candyXl: number, evolveCandy: number,
 *   evolveItems: string[], complete: boolean, unknownLevels: number,
 *   unpricedEvolutions: number, members: MemberBuildCost[]}}
 */
export function teamBuildCost(members) {
  const out = {
    stardust: 0,
    candy: 0,
    candyXl: 0,
    evolveCandy: 0,
    evolveItems: [],
    complete: true,
    unknownLevels: 0,
    unpricedEvolutions: 0,
    members: [],
  };
  const items = new Set();

  for (const m of members) {
    const from = m.currentLevel;
    const known = isHalfLevel(from) && from >= 1 && from <= MAX_LEVEL;
    const powerUp = known
      ? powerUpCost(from, m.targetLevel, m)
      : { stardust: 0, candy: 0, candyXl: 0, steps: 0 };

    const evo = m.evolution ?? null;
    const evolvePriced = !evo || evo.candy !== null;
    const evolveCandy = evo && evo.candy !== null ? evo.candy : 0;
    const evolveItems = evo?.items ?? [];
    for (const item of evolveItems) items.add(item);

    if (!known) out.unknownLevels += 1;
    if (!evolvePriced) out.unpricedEvolutions += 1;

    out.stardust += powerUp.stardust;
    out.candy += powerUp.candy + evolveCandy;
    out.candyXl += powerUp.candyXl;
    out.evolveCandy += evolveCandy;

    out.members.push({
      key: m.key,
      name: m.name,
      fromLevel: known ? from : null,
      toLevel: m.targetLevel,
      stardust: powerUp.stardust,
      candy: powerUp.candy + evolveCandy,
      candyXl: powerUp.candyXl,
      evolveCandy,
      evolveFrom: evo?.fromName ?? null,
      evolveItems,
      evolveBuddyKm: evo?.buddyKm ?? null,
      known,
      evolvePriced,
    });
  }

  out.evolveItems = [...items];
  out.complete = out.unknownLevels === 0 && out.unpricedEvolutions === 0;
  return out;
}
