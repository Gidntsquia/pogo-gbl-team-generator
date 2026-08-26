// JavaScript Document
//
// Video collection importer: a screen recording of Pokemon GO's appraisal
// screen in, one row per Pokemon out, in the same generic CSV shape
// src/importer already reads.
//
//   scan.swift   decode frames, OCR text, run-length encode bar pixels
//     -> frame.js   accept/reject each frame, read CP + species + IVs
//     -> group.js   collapse consecutive agreeing frames into one Pokemon
//     -> level.js   derive the level, and cross-check CP/HP against the IVs
//     -> csv.js     write name,atk,def,sta,shadow,level,cp
//
// What is read from where:
//   CP       the "CP 1498" text above the Pokemon (Vision OCR)
//   species  the caught-location caption ("This Trevenant was caught on...")
//            -- never the name above the stats, which is the trainer's own
//            nickname and is usually a rank percentage
//   IVs      the three appraisal bars, measured in pixels (see bars.js)
//   level    solved for, from species + IVs + CP + max HP (see level.js)
//   shadow   stated by the caption when present ("This Shadow Machamp...")
//
// Recording advice worth passing on to a user: open the appraisal, and rest
// about a second on each Pokemon before swiping. Frames mid-swipe are thrown
// away by design.

import { probeVideo, DEFAULT_REGION } from './probe.js';
import { readFrame } from './frame.js';
import { groupReadings, mergeDuplicates } from './group.js';
import { createCaptionResolver } from './species.js';
import { IV_SNAP_WARN } from './bars.js';

/**
 * @typedef {object} ScannedMon
 * @property {string} speciesId
 * @property {string} name
 * @property {{atk: number, def: number, hp: number}} ivs
 * @property {boolean} shadow
 * @property {boolean} purified
 * @property {number} cp
 * @property {number} [maxHp]
 * @property {string[]} types - the type badges read off the card, which is
 *   what settles a form the caption left open when the stats cannot.
 * @property {number} [level] - derived; absent when it could not be solved.
 * @property {'exact'|'ambiguous'|'none'|'skipped'} levelStatus
 * @property {number} frames - how many frames this Pokemon was read from.
 * @property {number} tStart
 * @property {number} tEnd
 */

/**
 * Scan a Pokemon GO screen recording into collection rows.
 *
 * @param {string} videoPath
 * @param {object} [opts]
 * @param {number} [opts.interval=0.25] seconds between sampled frames.
 * @param {{x: number, y: number, w: number, h: number}} [opts.region]
 * @param {boolean} [opts.deriveLevels=true] solve each mon's level (boots the
 *   pvpoke engine; set false for a faster, level-less scan).
 * @param {number} [opts.cp=1500] CP cap used only to boot the engine.
 * @param {(progress: {frames: number, accepted: number, t: number}) => void} [opts.onProgress]
 * @returns {Promise<{mons: ScannedMon[], warnings: string[], stats: {frames: number, accepted: number, rejected: Record<string, number>}}>}
 */
export async function scanVideo(videoPath, opts = {}) {
  return scanFrames(
    probeVideo(videoPath, {
      interval: opts.interval,
      region: opts.region ?? DEFAULT_REGION,
      signal: opts.signal,
    }),
    { ...opts, source: videoPath }
  );
}

/**
 * The whole pipeline downstream of decoding, over any iterable of frames.
 * `scanVideo` is this fed by the Swift probe; tests feed it recorded frames.
 *
 * @param {AsyncIterable<import('./probe.js').Frame>|Iterable<import('./probe.js').Frame>} source
 * @param {object} [opts] - as scanVideo, minus the decoding options.
 * @returns {Promise<{mons: ScannedMon[], warnings: string[], stats: object}>}
 */
export async function scanFrames(source, opts = {}) {
  const resolveCaption = createCaptionResolver();
  const warnings = [];
  const rejected = {};
  const frames = [];
  let accepted = 0;

  for await (const frame of source) {
    const result = readFrame(frame, { resolveCaption });
    if (result.reading) {
      accepted += 1;
    } else {
      const key = result.detail ? `${result.reason}: "${result.detail}"` : result.reason;
      rejected[key] = (rejected[key] ?? 0) + 1;
    }
    frames.push({ t: frame.t, reading: result.reading, hint: result.hint });
    opts.onProgress?.({ frames: frames.length, accepted, t: frame.t });
  }

  if (frames.length === 0) throw new Error(`No frames decoded from ${opts.source ?? 'input'}`);

  const { mons: groups, merged } = mergeDuplicates(groupReadings(frames, opts));
  for (const name of merged) {
    warnings.push(
      `${name}: appeared more than once in the recording with identical CP and IVs -- ` +
        'written as one row (if you really own two, add the second by hand)'
    );
  }

  // Shadow is the one thing on a collection row that the appraisal screen
  // simply does not state (see frame.js). Saying so is not optional noise: a
  // shadow Pokemon written as an ordinary one looks completely normal in the
  // CSV, so the trainer has to be told which rows were never actually
  // checked, not left to assume the scan checked all of them.
  const shadows = groups.filter((g) => g.shadow);
  warnings.push(
    `Shadow could not be read for ${groups.length - shadows.length} of ${groups.length} Pokemon -- ` +
      'Pokemon GO only says "PURIFY" / "SHADOW BONUS" with the appraisal panel CLOSED, and ' +
      `the recording showed that for ${shadows.length}${shadows.length ? ` (${shadows.map((g) => g.name).join(', ')})` : ''}. ` +
      'Every other row is written as not shadow whether it is or not -- set the flag by hand for any you know of.'
  );

  for (const key of Object.keys(rejected)) {
    if (key.startsWith('unrecognized species')) {
      warnings.push(`Could not match a species name read from the video -- ${key.slice('unrecognized species: '.length)}`);
    }
  }

  const mons = groups.map((group) => ({
    speciesId: group.speciesId,
    name: group.name,
    ivs: group.ivs,
    shadow: group.shadow,
    purified: group.purified,
    cp: group.cpVotes[0]?.value,
    maxHp: group.maxHp,
    types: group.types ?? [],
    levelStatus: 'skipped',
    frames: group.frames,
    tStart: group.tStart,
    tEnd: group.tEnd,
  }));

  for (const [i, group] of groups.entries()) {
    const mon = mons[i];
    if (group.frames === 1) {
      warnings.push(
        `${mon.name}: read from a single frame -- rest a little longer on each ` +
          'Pokemon, or rescan with a smaller --interval, if this row looks wrong'
      );
    }
    if (group.maxDelta > IV_SNAP_WARN) {
      warnings.push(
        `${mon.name}: an appraisal bar measured ${group.maxDelta.toFixed(2)} of an IV ` +
          'away from a whole number -- the reading may be off by one'
      );
    }
  }

  if (opts.deriveLevels !== false) {
    await resolveStats(mons, groups, warnings, opts.cp ?? 1500);
  } else {
    // Which form a caption meant is settled by the CP/HP arithmetic, so
    // --no-level leaves it at the likeliest guess rather than an answer.
    for (const group of groups) {
      if ((group.candidates?.length ?? 0) > 1) {
        warnings.push(
          `${group.name}: the caption never says which form and --no-level skipped the ` +
            'arithmetic that would settle it -- wrote the likeliest, rescan without --no-level to be sure'
        );
      }
    }
  }

  return { mons, warnings, stats: { frames: frames.length, accepted, rejected } };
}

/**
 * Settle each scanned Pokemon's form, CP and level against pvpoke's own CP math.
 *
 * CP, max HP and the three IVs over-determine each other, and that redundancy
 * is the only defence this scanner has against its three unavoidable misreads:
 * the Pokemon's animation is drawn over the CP text, the appraisal bars animate
 * in, and the caught-location caption never names a form ("This Corsola was
 * caught on ..." for a Galarian one). So rather than trusting the CP that was
 * read, we ask which CP this Pokemon *could* have -- given its species, its
 * IVs, and the max HP printed inside the card where nothing covers it -- and
 * check the readings against that, once per form the caption could have meant.
 */
async function resolveStats(mons, groups, warnings, cp) {
  const { initEngine } = await import('../engine/harness.js');
  const { createLevelDeriver } = await import('./level.js');
  const ctx = await initEngine({ cp });
  const deriveLevel = createLevelDeriver(ctx);

  for (const [i, mon] of mons.entries()) {
    const group = groups[i];
    const votes = group.cpVotes;
    const candidates = group.candidates?.length
      ? group.candidates
      : [{ speciesId: mon.speciesId, name: mon.name, types: [] }];

    const tried = candidates.map((candidate, rank) =>
      settleAs(candidate, rank, mon, votes, group.types ?? [], deriveLevel)
    );
    const best = tried.reduce((a, b) => (compareFits(a, b) <= 0 ? a : b));

    if (candidates.length > 1) {
      mon.speciesId = best.candidate.speciesId;
      mon.name = best.candidate.name;
      const note = formWarning(best, tried, group.types ?? []);
      if (note) warnings.push(note);
    }

    // Everything below is reported for the form that was chosen, in the same
    // words it would have used had there only ever been one.
    if (mon.maxHp !== undefined) {
      if (best.chosen) {
        if (best.chosen.reconstructed) {
          warnings.push(
            `${mon.name}: the CP text read as ${votes.map((v) => v.value).join('/')} -- the Pokemon's ` +
              `animation covers it. ${best.chosen.cp} is the only CP that fits ${mon.maxHp} HP with ` +
              `${mon.ivs.atk}/${mon.ivs.def}/${mon.ivs.hp}, so that is what was written`
          );
        }
      } else if (best.possible.status === 'none') {
        warnings.push(
          `${mon.name}: no level gives ${mon.maxHp} HP with IVs ` +
            `${mon.ivs.atk}/${mon.ivs.def}/${mon.ivs.hp} -- this row is probably misread, check it`
        );
      } else {
        warnings.push(
          `${mon.name} (CP ${best.cp}): could not settle the CP -- ${mon.maxHp} HP allows ` +
            `${[...new Set(best.possible.cps)].join(', ')} and the screen read ` +
            `${votes.map((v) => v.value).join('/')}`
        );
      }
    }
    mon.cp = best.cp;

    if (mon.cp === undefined) {
      warnings.push(`${mon.name}: no CP could be read or derived -- row written without one`);
      mon.levelStatus = 'none';
      continue;
    }

    if (best.hpIgnored) {
      warnings.push(
        `${mon.name} (CP ${mon.cp}): CP and IVs agree but the "${mon.maxHp} HP" reading does not -- ` +
          'level taken from CP alone'
      );
    }
    mon.level = best.fit.level;
    mon.levelStatus = best.fit.status;

    if (best.fit.status === 'none') {
      warnings.push(
        `${mon.name} (CP ${mon.cp}): no level produces CP ${mon.cp} with IVs ` +
          `${mon.ivs.atk}/${mon.ivs.def}/${mon.ivs.hp} -- this row is probably misread, check it before using it`
      );
    } else if (best.fit.status === 'ambiguous') {
      warnings.push(
        `${mon.name} (CP ${mon.cp}): levels ${best.fit.candidates.join(', ')} all fit -- wrote ${best.fit.level}`
      );
    }
  }
}

/**
 * Read one Pokemon as if it were a particular form, and report how well that
 * reading holds together. Emits nothing: resolveStats warns only about the
 * form it ends up keeping.
 *
 * @param {{speciesId: string, name: string, types: string[]}} candidate
 * @param {number} rank - the caption's own preference order (see forms.js).
 * @param {{ivs: object, shadow: boolean, maxHp?: number}} mon
 * @param {{value: number, count: number}[]} votes - CPs read off the screen.
 * @param {string[]} types - type badges read off the screen.
 * @param {ReturnType<import('./level.js').createLevelDeriver>} deriveLevel
 */
function settleAs(candidate, rank, mon, votes, types, deriveLevel) {
  const key = { speciesId: candidate.speciesId, shadow: mon.shadow, ivs: mon.ivs };
  let possible = { status: 'none', cps: [], candidates: [] };
  let chosen = null;
  if (mon.maxHp !== undefined) {
    possible = deriveLevel({ ...key, maxHp: mon.maxHp });
    chosen = chooseCp(votes, possible.cps);
  }
  const cp = chosen ? chosen.cp : votes[0]?.value;

  let fit = { status: 'none', candidates: [], cps: [] };
  let hpIgnored = false;
  if (cp !== undefined) {
    fit = deriveLevel({ ...key, cp, maxHp: mon.maxHp });
    if (fit.status === 'none' && mon.maxHp !== undefined) {
      // Separate "the HP text was misread" from "the IVs are wrong": only the
      // second is alarming. A form that needs this concession is also a worse
      // explanation than one that does not (see compareFits).
      const cpOnly = deriveLevel({ ...key, cp });
      if (cpOnly.status !== 'none') {
        fit = cpOnly;
        hpIgnored = true;
      }
    }
  }

  return {
    candidate,
    rank,
    mon,
    cp,
    chosen,
    possible,
    fit,
    hpIgnored,
    // A badge Vision actually read names this card's own type, so a form that
    // cannot have it is ruled out -- the only thing that separates Oricorio's
    // four forms, which are stat-for-stat identical.
    typeOk: types.length === 0 || candidate.types.length === 0 || types.every((t) => candidate.types.includes(t)),
  };
}

/**
 * How well one reading explains the screen, best first. The stats come before
 * the type badge deliberately: the badge is a single OCR box that Vision
 * truncates half the time, while CP, max HP and three IVs have to agree
 * simultaneously and almost never do so for the wrong form.
 */
function scoreFit(r) {
  return [
    r.fit.status === 'none' ? 0 : 1, // a form that produces no level at all is out
    r.hpIgnored ? 0 : 1, // ... then one that explains the CP *and* the HP
    r.chosen && !r.chosen.reconstructed ? 1 : 0, // ... and the CP as literally read
    r.fit.status === 'exact' ? 1 : 0,
    r.typeOk ? 1 : 0, // ... and only then the badge, to break what is left
  ];
}

/**
 * Do two readings explain the screen equally well? `upTo` limits the
 * comparison to the leading criteria -- 4 is "the numbers alone cannot tell
 * these two apart", which is the question the type badge exists to answer.
 */
function tiedFit(a, b, upTo = Infinity) {
  const [x, y] = [scoreFit(a), scoreFit(b)];
  return x.every((v, i) => i >= upTo || v === y[i]);
}

/**
 * Which of two readings of the same Pokemon is the better explanation.
 * Negative means `a` wins; a genuine tie falls back to the caption's own
 * preference order (an ordinary Rattata over an Alolan one -- see forms.js).
 */
function compareFits(a, b) {
  const [x, y] = [scoreFit(a), scoreFit(b)];
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
  return a.rank - b.rank;
}

/**
 * Why one form was written rather than the others the caption allowed --
 * raised only when the answer was not simply "the numbers said so": either a
 * form other than the obvious one won, or nothing on screen could separate
 * them and a default had to be taken (see DEFAULT_FORMS).
 *
 * @returns {string|null} null when the choice needs no explaining.
 */
function formWarning(best, tried, types) {
  const rest = tried.filter((t) => t !== best);
  const tied = rest.filter((t) => tiedFit(t, best));
  const tiedOnNumbers = rest.filter((t) => tiedFit(t, best, 4));
  const lead = `${best.candidate.name}: the caught-location caption never says which form`;

  if (tied.length > 0) {
    return (
      `${lead}, and nothing on screen separates it from ${tied.map((t) => t.candidate.name).join(', ')} -- ` +
      'wrote the form Pokemon GO stores by default; correct the row by hand if it is one of the others'
    );
  }
  if (tiedOnNumbers.length > 0) {
    return (
      `${lead} and its stats fit ${tiedOnNumbers.length + 1} of them equally -- the "${types.join('/')}" ` +
      `badge on the card is ${best.candidate.name} and not ${tiedOnNumbers.map((t) => t.candidate.name).join(', ')}`
    );
  }
  if (best.rank === 0) return null; // the likeliest form, and the numbers agree
  return (
    `${lead} -- of ${tried.length}, only this one has a level that gives CP ${best.cp}` +
    (best.mon.maxHp === undefined ? '' : ` and ${best.mon.maxHp} HP`) +
    ` with ${best.mon.ivs.atk}/${best.mon.ivs.def}/${best.mon.ivs.hp} ` +
    `(not ${rest.map((t) => t.candidate.name).join(', ')})`
  );
}

/**
 * Pick this Pokemon's CP from what the screen said and what its stats allow.
 *
 * @param {{value: number, count: number}[]} votes - CPs read, commonest first.
 * @param {number[]} possible - CPs its species/IVs/HP permit.
 * @returns {{cp: number, reconstructed: boolean}|null}
 */
export function chooseCp(votes, possible) {
  const allowed = [...new Set(possible)];
  if (allowed.length === 0) return null;

  // Best case: a CP that was actually read is one the stats allow.
  const agreed = votes.find((v) => allowed.includes(v.value));
  if (agreed) return { cp: agreed.value, reconstructed: false };

  // Otherwise the number on screen was cut off. A truncated reading is still
  // evidence: "96" narrows 968 vs 1968 the way no other signal can.
  const partial = allowed.filter((cp) =>
    votes.some((v) => {
      const [whole, read] = [String(cp), String(v.value)];
      return whole !== read && (whole.startsWith(read) || whole.endsWith(read));
    })
  );
  if (partial.length === 1) return { cp: partial[0], reconstructed: true };
  if (allowed.length === 1) return { cp: allowed[0], reconstructed: true };
  return null;
}
