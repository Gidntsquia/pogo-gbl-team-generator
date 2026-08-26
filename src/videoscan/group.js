// JavaScript Document
//
// Collapses the per-frame readings of a scanned video into one entry per
// Pokemon. Pure -- takes plain reading objects, returns plain groups.
//
// A recording is a swipe through a box: each Pokemon holds still for a few
// frames, then a transition sweeps past in which the panel is animating, two
// cards are on screen, or nothing is readable at all. Those transition frames
// come in as nulls (frame.js refuses to read them), so a Pokemon is simply a
// run of consecutive readable frames that agree.

/** Unreadable frames this many in a row or fewer are a blink, not a swipe. */
const DEFAULT_GAP_TOLERANCE = 3;

/**
 * @typedef {object} Reading
 * @property {number} t
 * @property {string} speciesId
 * @property {string} name
 * @property {boolean} shadow
 * @property {boolean} purified
 * @property {number} cp
 * @property {number} [maxHp]
 * @property {{atk: number, def: number, hp: number}} ivs
 * @property {number[]} deltas - per-stat distance from a whole IV, 0-0.5.
 */

/**
 * @param {({t: number, reading: Reading|null})[]} frames - in time order.
 * @param {{gapTolerance?: number}} [opts]
 * @returns {{speciesId: string, name: string, shadow: boolean, purified: boolean, cp: number,
 *   maxHp: number|undefined, ivs: {atk: number, def: number, hp: number}, frames: number,
 *   tStart: number, tEnd: number, maxDelta: number, ivDisagreement: boolean}[]}
 */
export function groupReadings(frames, opts = {}) {
  const gapTolerance = opts.gapTolerance ?? DEFAULT_GAP_TOLERANCE;
  const groups = [];
  let current = null;
  let gap = 0;

  for (const { reading } of frames) {
    if (!reading) {
      gap += 1;
      if (gap > gapTolerance) current = null;
      continue;
    }
    gap = 0;
    if (current && !sameMon(current, reading)) current = null;
    if (!current) {
      current = { first: reading, readings: [] };
      groups.push(current);
    }
    current.readings.push(reading);
  }

  return groups.map(summarize);
}

/**
 * Is this frame still the same Pokemon as the group it follows?
 *
 * Identity is species + shadow + max HP, and deliberately NOT the IVs or the
 * CP. Pokemon GO *animates* the appraisal bars filling up when a card
 * arrives, so the first frame or two of a Pokemon genuinely shows shorter
 * bars than the real IVs -- split on that and one Pokemon becomes two rows.
 * The CP text is no better: the Pokemon's own animation is drawn over it, so
 * it flickers between the real number and a truncated one. Max HP sits inside
 * the white card where nothing covers it, and does not animate.
 */
function sameMon(group, reading) {
  const first = group.first;
  if (first.speciesId !== reading.speciesId) return false;
  if (first.shadow !== reading.shadow) return false;
  if (first.maxHp !== undefined && reading.maxHp !== undefined) return first.maxHp === reading.maxHp;
  // No HP on one side: fall back to CP, and to species alone if neither
  // number was legible.
  if (first.cp !== undefined && reading.cp !== undefined) return first.cp === reading.cp;
  return true;
}

function summarize(group) {
  const rs = group.readings;
  // The whole IV triple is voted on together, not stat by stat: while the
  // bars are still animating in, all three are short at once, so the settled
  // reading is a single repeated triple rather than three separate medians.
  const ivs = mode(rs.map((r) => r.ivs), (iv) => `${iv.atk}/${iv.def}/${iv.hp}`);
  const settled = rs.filter((r) => ['atk', 'def', 'hp'].every((k) => r.ivs[k] === ivs[k]));
  const ivDisagreement = settled.length !== rs.length;
  return {
    speciesId: group.first.speciesId,
    name: group.first.name,
    shadow: group.first.shadow,
    purified: group.first.purified,
    // Every distinct CP the frames offered, commonest first -- index.js picks
    // between them using the stats, because any one of them may be a number
    // the Pokemon's animation cut in half.
    cpVotes: votes(rs.map((r) => r.cp).filter((v) => v !== undefined)),
    maxHp: mode(rs.map((r) => r.maxHp).filter((v) => v !== undefined), String),
    ivs,
    frames: rs.length,
    tStart: rs[0].t,
    tEnd: rs[rs.length - 1].t,
    // Measured over the frames that agree with the chosen reading only: a
    // frame caught while the bars were still animating in is mid-way between
    // two whole IVs by definition, and saying so about every card is noise.
    maxDelta: Math.max(...settled.flatMap((r) => r.deltas)),
    ivDisagreement,
  };
}

/**
 * Distinct values with their counts, commonest first; ties broken towards the
 * value seen latest, since a card's early frames are the animating ones.
 */
function votes(values) {
  const counts = new Map();
  values.forEach((value, i) => {
    const seen = counts.get(value) ?? { value, count: 0, last: -1 };
    counts.set(value, { value, count: seen.count + 1, last: i });
  });
  return [...counts.values()].sort((a, b) => b.count - a.count || b.last - a.last);
}

function mode(values, keyOf) {
  if (values.length === 0) return undefined;
  const counts = new Map();
  values.forEach((value, i) => {
    const key = keyOf(value);
    const seen = counts.get(key) ?? { value, count: 0, last: -1 };
    counts.set(key, { value, count: seen.count + 1, last: i });
  });
  return [...counts.values()].sort((a, b) => b.count - a.count || b.last - a.last)[0].value;
}

/**
 * Merge groups that describe an identical Pokemon (same species, shadow
 * status, CP and IVs).
 *
 * Two cases land here and they are not the same. Back-to-back groups are one
 * Pokemon whose run of frames was split by a long unreadable stretch (a
 * finger over the screen, a slow animation) -- merged silently, because
 * nothing happened. A repeat with a *different* Pokemon in between means the
 * recording swiped back over one already scanned; that one is reported,
 * because two genuinely distinct Pokemon with identical species, CP and IVs
 * would look exactly the same here and only the trainer can tell.
 *
 * @param {ReturnType<typeof groupReadings>} groups
 * @returns {{mons: ReturnType<typeof groupReadings>, merged: string[]}}
 */
export function mergeDuplicates(groups) {
  const byKey = new Map();
  const merged = [];
  let lastKey = null;
  for (const group of groups) {
    const key = [group.speciesId, group.shadow, group.maxHp, group.ivs.atk, group.ivs.def, group.ivs.hp].join('|');
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, group);
      lastKey = key;
      continue;
    }
    seen.frames += group.frames;
    seen.tEnd = Math.max(seen.tEnd, group.tEnd);
    if (seen.maxHp === undefined) seen.maxHp = group.maxHp;
    seen.cpVotes = [...seen.cpVotes, ...group.cpVotes];
    seen.ivDisagreement = seen.ivDisagreement || group.ivDisagreement;
    seen.maxDelta = Math.max(seen.maxDelta, group.maxDelta);
    if (key !== lastKey && !merged.includes(group.name)) merged.push(group.name);
    lastKey = key;
  }
  return { mons: [...byKey.values()], merged };
}
