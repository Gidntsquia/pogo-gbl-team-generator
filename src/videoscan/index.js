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
    frames.push({ t: frame.t, reading: result.reading });
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
  }

  return { mons, warnings, stats: { frames: frames.length, accepted, rejected } };
}

/**
 * Settle each scanned Pokemon's CP and level against pvpoke's own CP math.
 *
 * CP, max HP and the three IVs over-determine each other, and that redundancy
 * is the only defence this scanner has against its two unavoidable misreads:
 * the Pokemon's animation is drawn over the CP text, and the appraisal bars
 * animate in. So rather than trusting the CP that was read, we ask which CP
 * this Pokemon *could* have -- given its species, its IVs, and the max HP
 * printed inside the card where nothing covers it -- and check the readings
 * against that.
 */
async function resolveStats(mons, groups, warnings, cp) {
  const { initEngine } = await import('../engine/harness.js');
  const { createLevelDeriver } = await import('./level.js');
  const ctx = await initEngine({ cp });
  const deriveLevel = createLevelDeriver(ctx);

  for (const [i, mon] of mons.entries()) {
    const votes = groups[i].cpVotes;
    const key = { speciesId: mon.speciesId, shadow: mon.shadow, ivs: mon.ivs };

    if (mon.maxHp !== undefined) {
      const possible = deriveLevel({ ...key, maxHp: mon.maxHp });
      const chosen = chooseCp(votes, possible.cps);
      if (chosen) {
        if (chosen.reconstructed) {
          warnings.push(
            `${mon.name}: the CP text read as ${votes.map((v) => v.value).join('/')} -- the Pokemon's ` +
              `animation covers it. ${chosen.cp} is the only CP that fits ${mon.maxHp} HP with ` +
              `${mon.ivs.atk}/${mon.ivs.def}/${mon.ivs.hp}, so that is what was written`
          );
        }
        mon.cp = chosen.cp;
      } else if (possible.status === 'none') {
        warnings.push(
          `${mon.name}: no level gives ${mon.maxHp} HP with IVs ` +
            `${mon.ivs.atk}/${mon.ivs.def}/${mon.ivs.hp} -- this row is probably misread, check it`
        );
      } else {
        warnings.push(
          `${mon.name} (CP ${mon.cp}): could not settle the CP -- ${mon.maxHp} HP allows ` +
            `${[...new Set(possible.cps)].join(', ')} and the screen read ` +
            `${votes.map((v) => v.value).join('/')}`
        );
      }
    }

    if (mon.cp === undefined) {
      warnings.push(`${mon.name}: no CP could be read or derived -- row written without one`);
      mon.levelStatus = 'none';
      continue;
    }

    let fit = deriveLevel({ ...key, cp: mon.cp, maxHp: mon.maxHp });
    if (fit.status === 'none' && mon.maxHp !== undefined) {
      // Separate "the HP text was misread" from "the IVs are wrong": only the
      // second is alarming.
      const cpOnly = deriveLevel({ ...key, cp: mon.cp });
      if (cpOnly.status !== 'none') {
        warnings.push(
          `${mon.name} (CP ${mon.cp}): CP and IVs agree but the "${mon.maxHp} HP" reading does not -- ` +
            'level taken from CP alone'
        );
        fit = cpOnly;
      }
    }
    mon.level = fit.level;
    mon.levelStatus = fit.status;

    if (fit.status === 'none') {
      warnings.push(
        `${mon.name} (CP ${mon.cp}): no level produces CP ${mon.cp} with IVs ` +
          `${mon.ivs.atk}/${mon.ivs.def}/${mon.ivs.hp} -- this row is probably misread, check it before using it`
      );
    } else if (fit.status === 'ambiguous') {
      warnings.push(
        `${mon.name} (CP ${mon.cp}): levels ${fit.candidates.join(', ')} all fit -- wrote ${fit.level}`
      );
    }
  }
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
