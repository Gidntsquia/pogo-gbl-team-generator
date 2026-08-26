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

import { auraVerdict } from './aura.js';

/** Unreadable frames this many in a row or fewer are a blink, not a swipe. */
const DEFAULT_GAP_TOLERANCE = 3;

/**
 * @typedef {object} Reading
 * @property {number} t
 * @property {string} speciesId
 * @property {string} name
 * @property {{speciesId: string, name: string, types: string[]}[]} candidates - every
 *   species the caption could mean (see species.js); one entry for almost all.
 * @property {string[]} types - the type badges read off this frame.
 * @property {boolean} shadow
 * @property {boolean} [button] - what the action button above the appraisal
 *   panel said (purify.js): true PURIFY, false POWER UP, undefined hidden.
 * @property {{blueShift: number, darkening: number}} [aura] - how much this
 *   frame's background looks like a shadow's purple smoke (aura.js).
 * @property {boolean} purified
 * @property {number} cp
 * @property {number} [maxHp]
 * @property {{atk: number, def: number, hp: number}} ivs
 * @property {number[]} deltas - per-stat distance from a whole IV, 0-0.5.
 */

/**
 * @typedef {object} Hint
 * @property {number} cp
 * @property {number} maxHp
 * @property {boolean} shadow
 */

/**
 * @param {({t: number, reading: Reading|null, hint?: Hint})[]} frames - in time order.
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

  const hints = [];

  for (const { reading, hint } of frames) {
    if (hint) hints.push(hint);
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

  return applyHints(groups.map(summarize), hints);
}

/**
 * Fold in what the frames around a Pokemon said that its own frames could
 * not.

 * Only shadow travels this way, and only in one direction: a hint says "this
 * Pokemon IS shadow", never that it is not. The appraisal frames a Pokemon is
 * actually read from never mention shadow either way, so a Pokemon whose
 * panel was never shut during the recording simply stays false -- index.js
 * says so in its report rather than pretending the screen was checked.
 *
 * The hint carries no species, because the frames that show the shadow
 * markings have slid the caught-location caption off screen. It carries the
 * CP and max HP still drawn on the card behind the panel, and that pair is
 * matched against a Pokemon this scan already read -- tight enough that a
 * marker glimpsed mid-swipe cannot land on the neighbouring card, since the
 * neighbour would have to share both numbers.
 *
 * @param {ReturnType<typeof summarize>[]} mons
 * @param {Hint[]} hints
 */
function applyHints(mons, hints) {
  for (const hint of hints) {
    if (!hint.shadow) continue;
    const matches = mons.filter(
      (m) => m.maxHp === hint.maxHp && m.cpVotes.some((v) => v.value === hint.cp)
    );
    if (matches.length === 1) {
      matches[0].shadow = true;
      matches[0].shadowKnown = true;
    }
  }
  return mons;
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
    candidates: group.first.candidates ?? [],
    // Vision drops one of a dual type's two badges on most frames and reads
    // both on a few, so the fullest reading wins rather than the commonest:
    // "psychic + flying" seen once says strictly more about which Oricorio
    // this is than "psychic" seen three times.
    types: bestTypes(rs.map((r) => r.types ?? [])),
    shadow: group.first.shadow || readShadow(rs).shadow === true,
    // Whether this Pokemon's shadow flag was actually read off the screen or
    // merely left at its default, and which of the two things that can say so
    // said it. index.js reports the difference rather than letting an
    // unchecked Pokemon look like a checked one.
    shadowKnown: group.first.shadow || readShadow(rs).shadow !== undefined,
    shadowSource: group.first.shadow ? 'text' : readShadow(rs).source,
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
 * What this Pokemon's frames say about shadow, from the two things on screen
 * that can say it.
 *
 * The button is asked first and is never overruled. It is the Pokemon's own
 * page stating the fact outright, where the aura is a resemblance -- and the
 * two do not fail in the same way, so the aura is exactly what is left for
 * the roughly one Pokemon in three whose button never came out from behind
 * the panel.
 *
 * @param {Reading[]} readings
 * @returns {{shadow: boolean|undefined, source: 'button'|'aura'|undefined}}
 */
function readShadow(readings) {
  const button = votedShadow(readings);
  if (button !== undefined) return { shadow: button, source: 'button' };
  const aura = auraVerdict(readings.map((r) => r.aura));
  return { shadow: aura, source: aura === undefined ? undefined : 'aura' };
}

/**
 * What this Pokemon's frames agreed the action button said.
 *
 * Two frames are required before the band is believed, and any disagreement
 * throws the whole vote away. Both guards earn their keep on real
 * recordings: a single frame caught while the panel was still sliding shows
 * the band half-drawn and reads pink on a Pokemon that is not shadow, and
 * that mistake never survives a second frame.
 *
 * @param {Reading[]} readings
 * @returns {boolean|undefined}
 */
function votedShadow(readings) {
  const pink = readings.filter((r) => r.button === true).length;
  const green = readings.filter((r) => r.button === false).length;
  if (pink >= 2 && green === 0) return true;
  if (green >= 2 && pink === 0) return false;
  return undefined;
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

/**
 * The type-badge reading to keep for a Pokemon: the longest one seen, ties
 * broken by how often it was seen.
 *
 * @param {string[][]} readings - one per frame, often empty.
 * @returns {string[]}
 */
function bestTypes(readings) {
  const seen = readings.filter((t) => t.length > 0);
  if (seen.length === 0) return [];
  const counts = new Map();
  for (const types of seen) {
    const key = types.join('+');
    counts.set(key, { types, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.types.length - a.types.length || b.count - a.count)[0].types;
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
    seen.shadowKnown = seen.shadowKnown || group.shadowKnown;
    seen.maxDelta = Math.max(seen.maxDelta, group.maxDelta);
    if (key !== lastKey && !merged.includes(group.name)) merged.push(group.name);
    lastKey = key;
  }
  return { mons: [...byKey.values()], merged };
}
