#!/usr/bin/env node
// JavaScript Document
//
// GOALS T13: multi-stage overnight tournament runner. A 3-stage funnel that
// ranks the user's candidate teams with progressively more opponents, so the
// final ranking rests on far more battles per finalist than a single flat
// run could afford in a fixed time budget:
//
//   Stage 1: WIDE   -- --s1-candidates candidates x --s1-opponents opponents,
//                       3 battles/pair (leadA = 0,1,2; leadB seeded-random).
//   Stage 2: MEDIUM -- top --s2-top of stage 1 x FRESH --s2-opponents,
//                       same 3-battle scheme.
//   Stage 3: DEEP   -- top --s3-top of stage 2 x FRESH --s3-opponents
//                       (curated-ratio forced high enough to include the
//                       WHOLE curated/community pool), full 9 leadA x leadB
//                       pairings for fine-grained final rankings + bestLead.
//
// Shared setup mirrors src/cli.js's sampled path exactly (importer ->
// scoreCollection -> dedupeBestPerSpecies -> loadUsageWeights -> sampling),
// per PLAN.md Rev 3. No battle math is reimplemented anywhere in this file:
// every win/loss/HP number comes from battleTeams (src/engine/teamBattle.js,
// pvpoke's own emulate engine). `evaluateTeams` (src/teams/index.js) is
// intentionally NOT used here even though it exists and is frozen -- its
// fixed 9-lead-pairing scheme only matches stage 3, and it has no per-battle
// error handling, which this run's ROBUSTNESS requirement needs uniformly
// across all three stages (one bad matchup must never kill an overnight
// run). Instead, `runFunnelStage` below mirrors evaluateTeams' combinatorics
// / bookkeeping conventions (mean win rate: win=1, tie=0.5, loss=0; tiebreak
// mean surviving-HP margin; bestLead/safeSwap derivation) directly against
// battleTeams, with a pluggable lead-pairing scheme so stages 1-2 and stage 3
// share one implementation.
//
// Fixed-side convention (same as src/teams/index.js): every candidate is
// always battled as team A. pvpoke's emulate mode has a small residual
// player-1 side edge; because every candidate sees the same fixed side, that
// constant offset cancels in the RELATIVE ranking (which is all a funnel
// cares about -- who advances), even though absolute win% carries it.
//
// Usage:
//   node scripts/tournament.mjs <collection.csv> [options]
//
// Flags (defaults):
//   --score-meta S       1v1-pruning meta size                  (20)
//   --pool P              sampling pool size (best-scoring, deduped) (40)
//   --seed S               PRNG seed (stage suffixes -s1/-s2/-s3;
//                           candidate sampling: -candidates)    ("pogo-gbl-team-generator-tournament")
//   --curated-ratio R      curated-vs-sampled opponent mix, stages 1-2 only
//                           (stage 3 always forces full curated inclusion -- see below) (0.4)
//   --s1-candidates N      stage 1 candidate teams sampled       (500)
//   --s1-opponents M       stage 1 opponent teams sampled        (50)
//   --s2-top N             candidates advancing stage 1 -> 2     (100)
//   --s2-opponents M       stage 2 opponent teams (fresh sample) (200)
//   --s3-top N             candidates advancing stage 2 -> 3     (10)
//   --s3-opponents M       stage 3 opponent teams (fresh sample) (500)
//   --deadline-minutes D   overall wall-clock budget; stage 2/3 opponent
//                           counts self-tune to fit after stage 1 and again
//                           after stage 2 (see "DEADLINE SELF-TUNING" below) (450)
//   --exclude a,b          species ids excluded from candidate teams (none)
//   --difficulty D         AI difficulty 0-3 override               (engine default, 3)
//   --threads N            GOALS T15c: battle through the worker-pool executor
//                           (src/engine/parallel.js), batched per candidate;
//                           omit for the original serial battleTeams loop
//                           (default: not set, i.e. serial)
//   --out PATH             final Markdown report path         (<out-dir>/my-teams-tournament.md)
//   --out-dir DIR          checkpoints + DONE marker + default report dir ("out")
//   --help                 print this help and exit
//
// BUDGET MATH: battles = candidates x opponents x 3 (stages 1-2, seeded-
// random leadB) or x 9 (stage 3, full leadA x leadB). At the flag defaults:
// stage1 500x50x3=75,000, stage2 100x200x3=60,000, stage3 10x500x9=45,000 --
// 180,000 battles total. Measured rates vary by machine (~172ms/battle in
// the sandbox, ~73ms/battle on Jaxon's local Mac per PROGRESS.md's T14 note)
// -- at the sandbox rate that's ~8.6h, MORE than the 450-minute (7.5h)
// default deadline; deadline self-tuning (stage 2/3 only -- stage 1 is
// NEVER scaled, see below) is what keeps an overnight run from blowing past
// --deadline-minutes when that happens. Size --s1-candidates/--s1-opponents
// to your own time budget up front; nothing here protects stage 1's runtime.
//
// DEADLINE SELF-TUNING (design notes, since the ticket left the exact
// formula to this worker's judgment -- recorded here for the next reader):
// after stage 1 finishes (resumed-from-checkpoint counts as "finished" for
// this purpose -- its timing is read from the checkpoint), measure
// ms/battle = stage1 elapsed / stage1 battle count. Reserve a projected
// stage-3 cost at ITS CURRENT (flag) opponent count using that same rate,
// subtract from the remaining deadline budget, and see how many stage-2
// opponents fit in what's left; scale stage 2's opponent count DOWN to fit
// (floor 60) if it doesn't, never up. After stage 2 finishes, re-measure
// ms/battle from stage 2's OWN timing (usually close to stage 1's but
// measured fresh rather than assumed), recompute the true remaining budget,
// and size stage 3 to fit: scale DOWN (floor 100) if it doesn't fit, or UP
// (capped at 2x its flag value) if there's enough surplus to more than
// double it. Stage 1 itself is never tuned -- the ticket only specifies
// tuning "after stage 1 (and again after stage 2)", i.e. for stages 2 and 3.
//
// ROBUSTNESS: each stage writes out/tournament-s{1,2,3}.json (config + full
// stage rankings + timing) as soon as it finishes. On startup, a stage whose
// checkpoint's `config` deep-equals this run's resolved config (same CSV,
// same seed, same every flag -- see buildRunConfig/configsMatch) is skipped
// entirely (not even rewritten) and its checkpoint is loaded instead, so a
// crashed/interrupted overnight run resumes exactly where it left off
// without repeating finished stages. Individual battle errors are caught,
// logged, and counted (skip-and-continue) rather than aborting a stage.
// out/tournament-DONE is written LAST, only on a fully successful run.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { importCollection } from '../src/importer/index.js';
import { initEngine } from '../src/engine/harness.js';
import { battleTeams } from '../src/engine/teamBattle.js';
import { runBattles } from '../src/engine/parallel.js';
import { scoreCollection, computeWeightedScore } from '../src/scoring/index.js';
import { loadMetaTeams } from '../src/meta/teams.js';
import { loadUsageWeights } from '../src/meta/usage.js';
import { sampleOpponentTeams } from '../src/meta/sampleTeams.js';
import { sampleCandidateTeams } from '../src/teams/sample.js';
import { dedupeBestPerSpecies } from '../src/teams/index.js';
import { rngFromSeed } from '../src/util/rng.js';

const DEFAULTS = Object.freeze({
  scoreMeta: 20,
  pool: 40,
  seed: 'pogo-gbl-team-generator-tournament',
  curatedRatio: 0.4,
  s1Candidates: 500,
  s1Opponents: 50,
  s2Top: 100,
  s2Opponents: 200,
  s3Top: 10,
  s3Opponents: 500,
  deadlineMinutes: 450,
  outDir: 'out',
});

// Deadline self-tuning floors/caps (documented in the header comment above).
const S2_MIN_OPPONENTS = 60;
const S3_MIN_OPPONENTS = 100;
const S3_SCALE_UP_CAP = 2; // stage 3 opponents may scale up to at most 2x its flag value
// Used only if a stage somehow measures 0 battles (e.g. every battle in it
// errored) -- keeps tuning math finite rather than dividing by zero. Close
// to the sandbox-measured ~172ms/battle figure (PROGRESS.md 2026-08-20),
// rounded up for a conservative (slower) fallback assumption.
const FALLBACK_MS_PER_BATTLE = 200;

const LEADS = [0, 1, 2];

// ---------------------------------------------------------------------------
// Small pure formatting helpers (no engine, no I/O).
// ---------------------------------------------------------------------------

/** 0..1 win rate (or null for "no battles in this bucket") as a percentage string. */
function pct(x) {
  return x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`;
}

/** Signed HP margin to one decimal, e.g. "+12.4" / "-3.0". */
function signed(x) {
  const s = x.toFixed(1);
  return x > 0 ? `+${s}` : s;
}

/** Milliseconds -> "1h 23m 04s" (omits leading zero units). */
function formatDuration(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const totalSec = Math.round(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (h || m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Lead-pairing schemes (stages 1-2 vs stage 3) -- pure combinatorics, no
// battle math. leadB for stages 1-2 is derived via src/util/rng.js from
// (stage seed, candidate signature, opponent id, leadA), so it is fully
// deterministic and independent of iteration/resume order.
// ---------------------------------------------------------------------------

/**
 * Ticket's stage-1/2 scheme: "leadB = seeded-random per (candidateKey,
 * opponentId, leadA)". A candidate team has 3 keys, not 1, so "candidateKey"
 * is read here as the team's canonical signature (its 3 userMonKeys, sorted
 * and joined) -- documented interpretation, since a 3-mon team has no single
 * natural "key" otherwise.
 */
function pickLeadB(stageSeed, candidateSig, opponentId, leadA) {
  const rng = rngFromSeed(`${stageSeed}|leadB|${candidateSig}|${opponentId}|${leadA}`);
  return Math.floor(rng() * LEADS.length);
}

/** 3 pairings: leadA = 0, 1, 2 (each exactly once), leadB seeded-random per pairing. */
function threeRandomPairings(stageSeed, candidateSig, opponentId) {
  return LEADS.map((leadA) => ({ leadA, leadB: pickLeadB(stageSeed, candidateSig, opponentId, leadA) }));
}

/** All 9 leadA x leadB combinations (stage 3's "full 9 lead pairings"). */
function ninePairings() {
  const out = [];
  for (const leadA of LEADS) {
    for (const leadB of LEADS) out.push({ leadA, leadB });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run config (the checkpoint "fingerprint") + checkpoint I/O.
// ---------------------------------------------------------------------------

/**
 * The canonical, JSON-serializable set of REQUESTED inputs for a run (never
 * post-deadline-tuning effective values) -- this is what a checkpoint's
 * `config` is compared against on resume. Built the same way every time (same
 * key order) so `JSON.stringify` comparison in configsMatch is reliable.
 *
 * Deliberately conservative: ALL fields (including deadlineMinutes, which
 * only actually influences stages 2-3) share one fingerprint, so changing any
 * flag between runs invalidates every stage rather than trying to reason
 * about which stages a given flag could possibly affect. Simpler to reason
 * about and never silently wrong; documented in the T13 report as a
 * deliberate simplicity-over-cleverness tradeoff.
 */
function buildRunConfig(csvPath, opts) {
  return {
    csvPath: path.resolve(csvPath),
    scoreMeta: opts.scoreMeta ?? DEFAULTS.scoreMeta,
    pool: opts.pool ?? DEFAULTS.pool,
    seed: String(opts.seed ?? DEFAULTS.seed),
    curatedRatio: opts.curatedRatio ?? DEFAULTS.curatedRatio,
    excludeSpecies: [...(opts.excludeSpecies ?? [])].sort(),
    difficulty: opts.difficulty ?? null,
    s1Candidates: opts.s1Candidates ?? DEFAULTS.s1Candidates,
    s1Opponents: opts.s1Opponents ?? DEFAULTS.s1Opponents,
    s2Top: opts.s2Top ?? DEFAULTS.s2Top,
    s2Opponents: opts.s2Opponents ?? DEFAULTS.s2Opponents,
    s3Top: opts.s3Top ?? DEFAULTS.s3Top,
    s3Opponents: opts.s3Opponents ?? DEFAULTS.s3Opponents,
    deadlineMinutes: opts.deadlineMinutes ?? DEFAULTS.deadlineMinutes,
  };
}

function configsMatch(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkpointPath(outDir, stage) {
  return path.join(outDir, `tournament-s${stage}.json`);
}

/** Read+parse a stage checkpoint; null on missing file OR corrupt JSON (never throws -- treated as absent, will be recomputed and overwritten). */
function readCheckpoint(outDir, stage) {
  const p = checkpointPath(outDir, stage);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeCheckpoint(outDir, stage, data) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(checkpointPath(outDir, stage), JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Deadline self-tuning (see header comment for the algorithm rationale).
// ---------------------------------------------------------------------------

/** Decide stage 2's effective opponent count from stage 1's measured rate + remaining budget. Never scales UP (only stage 3 may, per the ticket). */
function tuneStage2(remainingMs, msPerBattle, cfg) {
  const s3ReserveMs = cfg.s3Top * cfg.s3Opponents * 9 * msPerBattle;
  const availableForS2 = remainingMs - s3ReserveMs;
  const battlesPerOpponent = cfg.s2Top * 3;
  const maxAffordable = Math.floor(availableForS2 / (battlesPerOpponent * msPerBattle));

  if (maxAffordable >= cfg.s2Opponents) return { opponents: cfg.s2Opponents, note: null };

  const opponents = Math.max(S2_MIN_OPPONENTS, maxAffordable);
  const risk = opponents === S2_MIN_OPPONENTS && maxAffordable < S2_MIN_OPPONENTS
    ? ' -- hit the floor, deadline may still be missed' : '';
  const note =
    `stage 2: opponents scaled DOWN ${cfg.s2Opponents} -> ${opponents} (measured ` +
    `${msPerBattle.toFixed(1)}ms/battle in stage 1; ${formatDuration(Math.max(0, availableForS2))} available ` +
    `after reserving ${formatDuration(s3ReserveMs)} for stage 3 at its current opponent count)${risk}`;
  return { opponents, note };
}

/** Decide stage 3's effective opponent count from stage 2's measured rate + remaining budget. May scale UP to at most 2x its flag value on a big surplus. */
function tuneStage3(remainingMs, msPerBattle, cfg) {
  const battlesPerOpponent = cfg.s3Top * 9;
  const maxAffordable = Math.floor(remainingMs / (battlesPerOpponent * msPerBattle));

  if (maxAffordable < cfg.s3Opponents) {
    const opponents = Math.max(S3_MIN_OPPONENTS, maxAffordable);
    const risk = opponents === S3_MIN_OPPONENTS && maxAffordable < S3_MIN_OPPONENTS
      ? ' -- hit the floor, deadline may still be missed' : '';
    const note =
      `stage 3: opponents scaled DOWN ${cfg.s3Opponents} -> ${opponents} (measured ` +
      `${msPerBattle.toFixed(1)}ms/battle in stage 2; only ${formatDuration(Math.max(0, remainingMs))} remaining)${risk}`;
    return { opponents, note };
  }

  if (maxAffordable >= cfg.s3Opponents * S3_SCALE_UP_CAP) {
    const opponents = cfg.s3Opponents * S3_SCALE_UP_CAP;
    const note =
      `stage 3: opponents scaled UP ${cfg.s3Opponents} -> ${opponents} (surplus budget: measured ` +
      `${msPerBattle.toFixed(1)}ms/battle in stage 2, ${formatDuration(remainingMs)} remaining -- capped at ` +
      `${S3_SCALE_UP_CAP}x the requested opponent count)`;
    return { opponents, note };
  }

  return { opponents: cfg.s3Opponents, note: null };
}

/**
 * Stage 3's curatedRatio needs to be high enough that sampleOpponentTeams'
 * own math -- `curatedCount = min(round(count*curatedRatio), curatedPool.length,
 * count)` (src/meta/sampleTeams.js) -- resolves to curatedPool.length, i.e.
 * the WHOLE curated/community pool (58 teams under the pinned data as of
 * this fire, measured via loadMetaTeams(ctx).length -- verified empirically,
 * not hardcoded here). Adding 0.5 to the numerator guarantees
 * `Math.round(count*ratio) >= curatedPoolSize` even after floating-point
 * division/multiplication rounding, as long as count >= curatedPoolSize
 * (true whenever the effective stage-3 opponent count is at least
 * S3_MIN_OPPONENTS=100, comfortably above the measured 58 -- if a caller
 * explicitly passes --s3-opponents below the curated pool size, full
 * inclusion is mathematically impossible and this gracefully degrades to
 * "as many curated teams as fit", logged plainly by the caller).
 */
function curatedRatioForFullInclusion(curatedPoolSize, opponentCount) {
  if (curatedPoolSize <= 0) return 0;
  if (opponentCount <= 0) return 1;
  return Math.min(1, (curatedPoolSize + 0.5) / opponentCount);
}

// ---------------------------------------------------------------------------
// Sampling pool (mirrors src/cli.js's private buildSamplingPool -- not
// exported there, so reimplemented here verbatim; pure list-ranking, no
// battle math, no engine calls).
// ---------------------------------------------------------------------------

/** Best-scoring `poolSize` userMonKeys, deduped to one per species, `excludeSpecies` removed. Mirrors src/teams/index.js's buildCandidates sort so every path ranks identically. */
function buildSamplingPool(deduped, poolSize, excludeSpecies) {
  const exclude = new Set(excludeSpecies);
  return Object.keys(deduped.ratings)
    .filter((key) => !exclude.has(deduped.builtMons[key].speciesId))
    .map((key) => ({ key, score: computeWeightedScore(deduped.ratings[key]) }))
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, poolSize)
    .map((m) => m.key);
}

// ---------------------------------------------------------------------------
// The shared stage runner: battles every candidate against every opponent
// via the given lead-pairing scheme, ranks by mean win rate (tiebreak mean
// surviving-HP margin) -- same conventions as evaluateTeams (src/teams/
// index.js), which this mirrors for the bookkeeping without calling it (see
// the header comment for why: uniform per-battle error handling across all
// 3 stages). Every actual battle result comes from battleTeams, imported
// unmodified from src/engine/teamBattle.js.
// ---------------------------------------------------------------------------

/**
 * @param {object} ctx - from initEngine; ctx.vendorRoot is used by the threaded path to boot worker engine contexts.
 * @param {{
 *   candidates: string[][], matrix: object,
 *   opponents: Array<{id:string, name:string, label?:string, members:Array<{pokemon:object, spec:object}>}>,
 *   pairingsFor: (candidateSig:string, opponentId:string) => Array<{leadA:number, leadB:number}>,
 *   difficulty?: number,
 *   trackLeads?: boolean, - compute bestLead/safeSwap/perMeta/hardestOpponents/curated-vs-sampled (stage 3 only)
 *   threads?: number, - GOALS T15c: when set, every battle for a given candidate (across
 *     all its opponents/pairings) is batched into ONE src/engine/parallel.js
 *     runBattles() call instead of driving battleTeams() serially. Batched per
 *     CANDIDATE (not per whole stage) so a failure only costs that candidate's
 *     battles, not the whole stage.
 *   onProgress?: (p:{completed:number, total:number, startedAt:number}) => void,
 *   onLog?: (msg:string) => void,
 * }} params
 * @returns {Promise<{ rankings: object[], battleCount: number, errorCount: number, elapsedMs: number, startedAt: number, finishedAt: number }>}
 */
async function runFunnelStage(ctx, params) {
  const { candidates, matrix, opponents, pairingsFor, difficulty, trackLeads = false, threads, onProgress, onLog } = params;
  const threaded = typeof threads === 'number' && threads > 0;

  const startedAt = Date.now();
  const results = [];
  let battleCount = 0;
  let errorCount = 0;

  for (let idx = 0; idx < candidates.length; idx++) {
    const keys = candidates[idx];
    const members = keys.map((key) => {
      const b = matrix.builtMons[key];
      return { key, speciesId: b.speciesId, name: b.name, pokemon: b.pokemon, spec: b.spec };
    });
    const teamA = members.map((m) => m.pokemon);
    const teamASpec = members.map((m) => m.spec);
    const candidateSig = [...keys].sort().join('|');

    let winPoints = 0;
    let hpSum = 0;
    let battles = 0;
    let candidateErrors = 0;
    const perMeta = [];
    const leadWins = [0, 0, 0];
    const leadBattles = [0, 0, 0];
    const swapHpSum = [0, 0, 0];
    const swapHpCount = [0, 0, 0];

    // Pairings are seeded off (candidateSig, opponent.id) -- pure/deterministic,
    // so computing them once up front and reusing below (rather than calling
    // pairingsFor twice) is just an optimization, not a correctness dependency.
    const oppPlans = opponents.map((opp) => ({ opp, pairings: pairingsFor(candidateSig, opp.id) }));

    // Threaded path: batch this candidate's entire battle set (every opponent x
    // every pairing) into one runBattles() call, in the exact (opponent, pairing)
    // order oppPlans/pairings iterate below, so results line up 1:1 by position.
    // runBattles rejects the WHOLE batch on any single bad spec (src/engine/
    // parallel.js) -- there is no partial-batch result to recover -- so a
    // failure here is counted as an error for EVERY battle in THIS candidate's
    // batch. That is coarser than the serial path's per-battle skip-and-continue
    // (one bad matchup no longer costs just itself, it costs its whole
    // candidate), but it preserves the ticket's actual invariant -- one bad
    // candidate/matchup can never take down the whole overnight run -- and was
    // an explicitly authorized tradeoff (GOALS T15c: "either wrap per-battle or
    // batch per-candidate with a try/catch around each runBattles call").
    let threadedResults = null;
    if (threaded) {
      const specs = [];
      for (const { opp, pairings } of oppPlans) {
        const teamBSpec = opp.members.map((m) => m.spec);
        for (const { leadA, leadB } of pairings) {
          specs.push({ teamA: teamASpec, teamB: teamBSpec, leadA, leadB, difficulty });
        }
      }
      if (specs.length > 0) {
        try {
          threadedResults = await runBattles(specs, { threads, vendorRoot: ctx.vendorRoot });
        } catch (err) {
          errorCount += specs.length;
          candidateErrors += specs.length;
          onLog?.(
            `battle batch error (candidate's ${specs.length} battles skipped): ` +
              `candidate=[${members.map((m) => m.name).join('/')}]: ${err.message}`
          );
          threadedResults = new Array(specs.length).fill(null);
        }
      } else {
        threadedResults = [];
      }
    }
    let planIdx = 0;

    for (const { opp, pairings } of oppPlans) {
      const teamB = opp.members.map((m) => m.pokemon);

      let oppWinPoints = 0;
      let oppHpSum = 0;
      let oppBattles = 0;
      let oppWins = 0;
      let oppLosses = 0;
      let oppTies = 0;

      for (const { leadA, leadB } of pairings) {
        let r;
        if (threaded) {
          r = threadedResults[planIdx++];
          if (r == null) continue; // part of a failed batch; already counted above
        } else {
          try {
            r = battleTeams(ctx, { teamA, teamB, leadA, leadB, difficulty });
          } catch (err) {
            errorCount += 1;
            candidateErrors += 1;
            onLog?.(
              `battle error (skipped): candidate=[${members.map((m) => m.name).join('/')}] ` +
                `opponent="${opp.name}" leadA=${leadA} leadB=${leadB}: ${err.message}`
            );
            continue;
          }
        }

        battleCount += 1;
        battles += 1;
        oppBattles += 1;
        const margin = r.survivorsHp.a - r.survivorsHp.b;
        hpSum += margin;
        oppHpSum += margin;
        if (r.winner === 'a') {
          winPoints += 1;
          oppWinPoints += 1;
          oppWins += 1;
        } else if (r.winner === 'tie') {
          winPoints += 0.5;
          oppWinPoints += 0.5;
          oppTies += 1;
        } else {
          oppLosses += 1;
        }

        if (trackLeads) {
          if (r.winner === 'a') leadWins[leadA] += 1;
          else if (r.winner === 'tie') leadWins[leadA] += 0.5;
          leadBattles[leadA] += 1;

          // battleTeams reorders teamA as [lead, ...rest] (engine's
          // orderWithLead); survivorsHp.aPerMon comes back in THAT order --
          // map back to original member indices (same technique as
          // src/teams/index.js's safeSwap tracking).
          const orderedIndices = [leadA, ...LEADS.filter((i) => i !== leadA)];
          r.survivorsHp.aPerMon.forEach((hp, k) => {
            const memberIdx = orderedIndices[k];
            if (memberIdx === leadA) return; // only non-lead (switched-in) appearances count
            const maxHp = members[memberIdx].pokemon.stats.hp;
            swapHpSum[memberIdx] += maxHp > 0 ? hp / maxHp : 0;
            swapHpCount[memberIdx] += 1;
          });
        }
      }

      if (oppBattles > 0) {
        perMeta.push({
          metaTeamId: opp.id,
          name: opp.name,
          label: opp.label ?? null,
          wins: oppWins,
          losses: oppLosses,
          ties: oppTies,
          winRate: oppWinPoints / oppBattles,
          avgHpMargin: oppHpSum / oppBattles,
        });
      }
    }

    const winRate = battles > 0 ? winPoints / battles : 0;
    const avgHpMargin = battles > 0 ? hpSum / battles : 0;

    const entry = {
      members: members.map(({ key, speciesId, name }) => ({ key, speciesId, name })),
      winRate,
      avgHpMargin,
      battles,
      errors: candidateErrors,
    };

    if (trackLeads) {
      const leadStats = members.map((m, i) => ({
        index: i,
        key: m.key,
        speciesId: m.speciesId,
        name: m.name,
        winRate: leadBattles[i] > 0 ? leadWins[i] / leadBattles[i] : 0,
      }));
      // argmax, first-on-ties (matches src/teams/index.js's bestBy convention).
      entry.bestLead = leadStats.reduce((best, l) => (!best || l.winRate > best.winRate ? l : best), null);

      const swapStats = members
        .map((m, i) => ({
          index: i,
          key: m.key,
          speciesId: m.speciesId,
          name: m.name,
          avgHpPct: swapHpCount[i] > 0 ? swapHpSum[i] / swapHpCount[i] : 0,
        }))
        .filter((s) => s.index !== entry.bestLead.index);
      entry.safeSwap = swapStats.length
        ? swapStats.reduce((best, s) => (!best || s.avgHpPct > best.avgHpPct ? s : best), null)
        : null;

      entry.perMeta = perMeta;
      entry.hardestOpponents = [...perMeta]
        .sort((a, b) => a.winRate - b.winRate || a.avgHpMargin - b.avgHpMargin)
        .slice(0, 5);

      let curatedPoints = 0;
      let curatedBattles = 0;
      let sampledPoints = 0;
      let sampledBattles = 0;
      for (const pm of perMeta) {
        const battlesHere = pm.wins + pm.losses + pm.ties;
        const points = pm.wins + 0.5 * pm.ties;
        if (pm.label === 'curated') {
          curatedPoints += points;
          curatedBattles += battlesHere;
        } else if (pm.label === 'sampled') {
          sampledPoints += points;
          sampledBattles += battlesHere;
        }
      }
      entry.winRateCurated = curatedBattles > 0 ? curatedPoints / curatedBattles : null;
      entry.battlesCurated = curatedBattles;
      entry.winRateSampled = sampledBattles > 0 ? sampledPoints / sampledBattles : null;
      entry.battlesSampled = sampledBattles;
    }

    results.push(entry);

    const completed = idx + 1;
    if (completed % 10 === 0 || completed === candidates.length) {
      onProgress?.({ completed, total: candidates.length, startedAt });
    }
  }

  results.sort((a, b) => b.winRate - a.winRate || b.avgHpMargin - a.avgHpMargin);
  return { rankings: results, battleCount, errorCount, elapsedMs: Date.now() - startedAt, startedAt, finishedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Report + DONE-marker rendering (pure formatting, no I/O).
// ---------------------------------------------------------------------------

function renderTournamentReport(result) {
  const { config, stage1, stage2, stage3, finalRankings, importWarnings } = result;
  const out = [];

  out.push('# Great League Overnight Tournament Report');
  out.push('');
  out.push(`Collection: \`${result.collectionPath}\``);
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push(`Run started: ${result.runStartedAt}`);
  out.push('');
  out.push(
    'Three-stage funnel: a wide sample of candidate teams is progressively narrowed against a ' +
      'growing, more thorough set of opponent teams, so the final ranking reflects far more battles ' +
      "per finalist than a single flat run could afford. Every battle runs through pvpoke's own 3v3 " +
      'emulate engine (`battleTeams`, `src/engine/teamBattle.js`) -- no battle math is reimplemented here.'
  );
  out.push('');
  out.push(
    '> **Reading the win%:** every candidate is always evaluated as team A (the fixed-side convention ' +
      "from `src/teams/index.js`), so pvpoke emulate mode's small residual player-1 edge is a constant " +
      'offset shared by every team -- it cancels in the *relative* ranking (all a funnel needs to decide ' +
      'who advances), but absolute win% carries that constant offset.'
  );
  out.push('');

  out.push('## Settings');
  out.push('');
  out.push(`- Seed: \`${config.seed}\` (stage opponent seeds: \`-s1\`/\`-s2\`/\`-s3\`; candidate sampling: \`-candidates\`)`);
  out.push(
    `- score-meta=${config.scoreMeta}, pool=${config.pool}, curated-ratio=${config.curatedRatio} ` +
      '(stages 1-2 only; stage 3 always forces full curated/community-pool inclusion, see below)'
  );
  out.push(`- deadline-minutes=${config.deadlineMinutes}`);
  if (config.excludeSpecies.length) out.push(`- excluded species: ${config.excludeSpecies.join(', ')}`);
  if (config.difficulty !== null) out.push(`- AI difficulty override: ${config.difficulty}`);
  out.push('');
  out.push('| Stage | Candidates | Opponents (requested -> effective) | Leads/pair | Battles run | Errors |');
  out.push('| --- | --- | ---: | --- | ---: | ---: |');
  out.push(
    `| 1 | ${config.s1Candidates} sampled | ${config.s1Opponents} -> ${stage1.opponentCount.effective} | ` +
      `3 (leadA 0/1/2, leadB seeded-random) | ${stage1.timing.battleCount} | ${stage1.timing.errorCount} |`
  );
  out.push(
    `| 2 | top ${config.s2Top} of stage 1 | ${config.s2Opponents} -> ${stage2.opponentCount.effective} | ` +
      `3 (leadA 0/1/2, leadB seeded-random) | ${stage2.timing.battleCount} | ${stage2.timing.errorCount} |`
  );
  out.push(
    `| 3 | top ${config.s3Top} of stage 2 | ${config.s3Opponents} -> ${stage3.opponentCount.effective} | ` +
      `9 (full leadA x leadB) | ${stage3.timing.battleCount} | ${stage3.timing.errorCount} |`
  );
  out.push('');

  out.push('## Stage funnel summary');
  out.push('');
  for (const [label, s] of [
    ['Stage 1', stage1],
    ['Stage 2', stage2],
    ['Stage 3', stage3],
  ]) {
    out.push(
      `**${label}**${s.resumed ? ' _(resumed from checkpoint -- not re-run)_' : ''}: ${s.rankings.length} teams ranked, ` +
        `${s.timing.battleCount} battles (${s.timing.errorCount} errors), ${formatDuration(s.timing.elapsedMs)} elapsed, ` +
        `${s.timing.msPerBattle.toFixed(1)}ms/battle.`
    );
  }
  out.push('');
  if (result.adjustments.length === 0) {
    out.push('_No deadline adjustments were needed -- every stage ran at its requested opponent count._');
  } else {
    out.push('**Deadline adjustments:**');
    for (const a of result.adjustments) out.push(`- ${a}`);
  }
  out.push('');
  out.push(
    `Total elapsed: ${formatDuration(result.totalElapsedMs)} of a ${config.deadlineMinutes}-minute ` +
      `(${formatDuration(config.deadlineMinutes * 60000)}) budget.`
  );
  out.push('');
  const s3Curated = stage3.opponents.filter((o) => o.label === 'curated').length;
  const s3Sampled = stage3.opponents.length - s3Curated;
  out.push(
    `Stage 3 opponent pool: ${stage3.curatedPoolSize} curated/community teams available; ${s3Curated} included ` +
      `as curated${s3Curated < stage3.curatedPoolSize ? ' _(fewer than the full pool -- see stage 3 log/warnings)_' : ' (the FULL curated pool)'}, ` +
      `${s3Sampled} weighted-random sampled (${stage3.opponents.length} total).`
  );
  out.push('');

  out.push(`## Top ${finalRankings.length} teams (stage 3 results)`);
  out.push('');
  if (finalRankings.length === 0) {
    out.push('_No finalist teams were produced._');
    out.push('');
  } else {
    out.push('| Rank | Team | Stage-3 win% | Best lead | vs curated | vs sampled | Avg HP margin |');
    out.push('| --- | --- | ---: | --- | ---: | ---: | ---: |');
    finalRankings.forEach((t, i) => {
      out.push(
        `| ${i + 1} | ${t.members.map((m) => m.name).join(', ')} | ${pct(t.winRate)} | ${t.bestLead.name} | ` +
          `${pct(t.winRateCurated)} | ${pct(t.winRateSampled)} | ${signed(t.avgHpMargin)} |`
      );
    });
    out.push('');
  }

  out.push('## Per-team detail');
  out.push('');
  finalRankings.forEach((t, i) => {
    out.push(`### ${i + 1}. ${t.members.map((m) => m.name).join(', ')}`);
    out.push('');
    out.push(`- **Stage-3 win rate:** ${pct(t.winRate)} across ${t.battles} battles (${t.errors} errors)`);
    out.push(`- **Best lead:** ${t.bestLead.name} (${pct(t.bestLead.winRate)} when leading)`);
    if (t.safeSwap) {
      out.push(`- **Safest first switch:** ${t.safeSwap.name} (avg ${pct(t.safeSwap.avgHpPct)} HP remaining when switched in)`);
    }
    out.push(`- **Avg surviving-HP margin:** ${signed(t.avgHpMargin)}`);
    out.push(`- **Win% vs curated-only opponents:** ${pct(t.winRateCurated)} (${t.battlesCurated} battles)`);
    out.push(`- **Win% vs sampled-only opponents:** ${pct(t.winRateSampled)} (${t.battlesSampled} battles)`);
    out.push('');
    out.push('5 hardest stage-3 opponents (by win%):');
    out.push('');
    out.push('| Opponent | Win% | W | L | T | HP margin |');
    out.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const h of t.hardestOpponents) {
      out.push(
        `| ${h.name}${h.label ? ` _(${h.label})_` : ''} | ${pct(h.winRate)} | ${h.wins} | ${h.losses} | ${h.ties} | ${signed(h.avgHpMargin)} |`
      );
    }
    out.push('');
  });

  out.push('## Collection warnings');
  out.push('');
  if (importWarnings.length === 0) {
    out.push('_None -- every row imported and scored cleanly._');
  } else {
    for (const w of importWarnings) out.push(`- ${w}`);
  }
  out.push('');

  return out.join('\n');
}

/** out/tournament-DONE content: ISO timestamp + a short exit summary (ticket-specified). Written LAST, only on a fully successful run. */
function renderDoneMarker(result) {
  const lines = [new Date().toISOString()];
  lines.push(`Tournament complete: ${result.config.s1Candidates} -> ${result.config.s2Top} -> ${result.config.s3Top} funnel.`);
  const top = result.finalRankings[0];
  if (top) {
    lines.push(
      `Top team: ${top.members.map((m) => m.name).join(', ')} (${pct(top.winRate)} stage-3 win rate vs ` +
        `${result.stage3.opponentCount.effective} opponents, best lead ${top.bestLead.name}).`
    );
  } else {
    lines.push('No finalist teams were produced.');
  }
  const totalErrors = result.stage1.timing.errorCount + result.stage2.timing.errorCount + result.stage3.timing.errorCount;
  lines.push(`Battle errors: ${totalErrors} across all stages (skip-and-continue; see report for details).`);
  lines.push(`Total elapsed: ${formatDuration(result.totalElapsedMs)}.`);
  lines.push(`Report: ${result.reportPath}`);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Main pipeline.
// ---------------------------------------------------------------------------

/**
 * Run the full 3-stage overnight tournament and write checkpoints + the
 * final report + DONE marker. Exported so test/tournament.test.js can drive
 * it in-process with a tiny opts object (same pattern as src/cli.js's
 * runPipeline) -- the CLI's main() below just parses argv into this same
 * opts shape.
 *
 * @param {string} csvPath
 * @param {{
 *   scoreMeta?:number, pool?:number, seed?:number|string, curatedRatio?:number,
 *   excludeSpecies?:string[], difficulty?:number,
 *   s1Candidates?:number, s1Opponents?:number,
 *   s2Top?:number, s2Opponents?:number,
 *   s3Top?:number, s3Opponents?:number,
 *   deadlineMinutes?:number,
 *   threads?:number, - GOALS T15c: battles run through src/engine/parallel.js's
 *     worker-pool executor, batched per candidate (see runFunnelStage). Omitted/
 *     falsy keeps the original serial battleTeams loop. NOT part of the
 *     checkpoint config fingerprint (buildRunConfig) -- it's a pure performance
 *     knob (same requested battle set either way; only avgHpMargin can drift a
 *     little, per src/engine/README.md's "Known limitation" section, same
 *     caveat GOALS T15b already documented for evaluateTeams), so changing
 *     --threads between runs must NOT invalidate an existing checkpoint.
 *   outDir?:string, out?:string,
 *   onProgress?:(p:{stage:number, completed:number, total:number, startedAt:number})=>void,
 *   onLog?:(msg:string)=>void,
 * }} [opts]
 * @returns {Promise<object>} the full run result (see inline shape below); also written to disk.
 */
export async function runTournament(csvPath, opts = {}) {
  const config = buildRunConfig(csvPath, opts);
  const outDir = opts.outDir ?? DEFAULTS.outDir;
  const reportPath = opts.out ?? path.join(outDir, 'my-teams-tournament.md');
  mkdirSync(outDir, { recursive: true });

  const log = (msg) => opts.onLog?.(msg);
  const progressFor = (stageNum) => (p) => opts.onProgress?.({ stage: stageNum, ...p });
  const difficulty = config.difficulty ?? undefined;
  const threads = opts.threads;

  log(`tournament: starting (collection=${config.csvPath}, out-dir=${outDir}, report=${reportPath})`);

  // ---- Shared setup (once) -- mirrors src/cli.js's sampled runPipeline path. ----
  const { mons, warnings: importWarnings } = importCollection(csvPath);
  const ctx = await initEngine();
  const matrix = scoreCollection(ctx, mons, { metaLimit: config.scoreMeta });
  const deduped = dedupeBestPerSpecies(matrix);
  const weights = loadUsageWeights(ctx);
  const pool = buildSamplingPool(deduped, config.pool, config.excludeSpecies);
  log(`tournament: shared setup done -- ${matrix.mons.length} mons scored, sampling pool of ${pool.length} species`);

  const adjustments = [];

  // ============================== Stage 1 ================================
  const s1Checkpoint = readCheckpoint(outDir, 1);
  let runStartedAtMs;
  let stage1;

  if (s1Checkpoint && configsMatch(s1Checkpoint.config, config)) {
    runStartedAtMs = new Date(s1Checkpoint.runStartedAt).getTime();
    stage1 = { ...s1Checkpoint, resumed: true };
    log(
      `stage 1: resuming from checkpoint (skipped) -- ${stage1.rankings.length} candidates ranked, ` +
        `${stage1.timing.battleCount} battles, ${stage1.timing.msPerBattle.toFixed(1)}ms/battle measured originally`
    );
  } else {
    runStartedAtMs = Date.now();
    log(
      `stage 1: sampling ${config.s1Candidates} candidates from a pool of ${pool.length}, ${config.s1Opponents} ` +
        `opponents (seed ${config.seed}-s1)`
    );

    const s1CandidateTeams = sampleCandidateTeams({
      matrix: deduped,
      pool,
      weights,
      count: config.s1Candidates,
      // One-time candidate sampling seed (documented choice: the ticket only
      // specifies fresh per-stage seeds for OPPONENTS -- candidates are
      // progressively narrowed by battle performance across stages, never
      // resampled, so one deterministic seed namespace suffices).
      seed: `${config.seed}-candidates`,
      excludeSpecies: config.excludeSpecies,
    });
    const s1Opponents = sampleOpponentTeams(ctx, {
      count: config.s1Opponents,
      weights,
      seed: `${config.seed}-s1`,
      curatedRatio: config.curatedRatio,
    });

    const run = await runFunnelStage(ctx, {
      candidates: s1CandidateTeams,
      matrix: deduped,
      opponents: s1Opponents,
      pairingsFor: (sig, oppId) => threeRandomPairings(`${config.seed}-s1`, sig, oppId),
      difficulty,
      threads,
      onProgress: progressFor(1),
      onLog: log,
    });

    stage1 = {
      stage: 1,
      config,
      runStartedAt: new Date(runStartedAtMs).toISOString(),
      opponentCount: { requested: config.s1Opponents, effective: config.s1Opponents },
      opponents: s1Opponents.map((o) => ({ id: o.id, name: o.name, label: o.label ?? null })),
      rankings: run.rankings,
      timing: {
        startedAt: new Date(run.startedAt).toISOString(),
        finishedAt: new Date(run.finishedAt).toISOString(),
        elapsedMs: run.elapsedMs,
        battleCount: run.battleCount,
        errorCount: run.errorCount,
        msPerBattle: run.battleCount > 0 ? run.elapsedMs / run.battleCount : FALLBACK_MS_PER_BATTLE,
      },
      adjustments: [],
      resumed: false,
    };
    writeCheckpoint(outDir, 1, stage1);
    log(
      `stage 1: done -- ${stage1.rankings.length} candidates ranked, ${stage1.timing.battleCount} battles ` +
        `(${stage1.timing.errorCount} errors), ${formatDuration(stage1.timing.elapsedMs)} elapsed, ` +
        `${stage1.timing.msPerBattle.toFixed(1)}ms/battle`
    );
  }

  // ---- Deadline tuning: stage 2's effective opponent count ----
  const deadlineMs = config.deadlineMinutes * 60000;
  const msPerBattle1 = stage1.timing.msPerBattle > 0 ? stage1.timing.msPerBattle : FALLBACK_MS_PER_BATTLE;
  const remainingAfterS1 = deadlineMs - (Date.now() - runStartedAtMs);
  const s2Tuning = tuneStage2(remainingAfterS1, msPerBattle1, config);
  if (s2Tuning.note) {
    adjustments.push(s2Tuning.note);
    log(s2Tuning.note);
  }
  const s2OpponentsEffective = s2Tuning.opponents;

  // ============================== Stage 2 ================================
  const s2Checkpoint = readCheckpoint(outDir, 2);
  let stage2;

  if (s2Checkpoint && configsMatch(s2Checkpoint.config, config)) {
    stage2 = { ...s2Checkpoint, resumed: true };
    log(
      `stage 2: resuming from checkpoint (skipped) -- ${stage2.rankings.length} candidates ranked, ` +
        `${stage2.timing.battleCount} battles, ${stage2.timing.msPerBattle.toFixed(1)}ms/battle measured originally`
    );
  } else {
    const s2CandidateTeams = stage1.rankings.slice(0, config.s2Top).map((r) => r.members.map((m) => m.key));
    log(
      `stage 2: battling top ${s2CandidateTeams.length} of stage 1 against ${s2OpponentsEffective} FRESH opponents ` +
        `(seed ${config.seed}-s2)`
    );

    const s2OpponentsSampled = sampleOpponentTeams(ctx, {
      count: s2OpponentsEffective,
      weights,
      seed: `${config.seed}-s2`,
      curatedRatio: config.curatedRatio,
    });

    const run = await runFunnelStage(ctx, {
      candidates: s2CandidateTeams,
      matrix: deduped,
      opponents: s2OpponentsSampled,
      pairingsFor: (sig, oppId) => threeRandomPairings(`${config.seed}-s2`, sig, oppId),
      difficulty,
      threads,
      onProgress: progressFor(2),
      onLog: log,
    });

    stage2 = {
      stage: 2,
      config,
      runStartedAt: new Date(runStartedAtMs).toISOString(),
      opponentCount: { requested: config.s2Opponents, effective: s2OpponentsEffective },
      opponents: s2OpponentsSampled.map((o) => ({ id: o.id, name: o.name, label: o.label ?? null })),
      rankings: run.rankings,
      timing: {
        startedAt: new Date(run.startedAt).toISOString(),
        finishedAt: new Date(run.finishedAt).toISOString(),
        elapsedMs: run.elapsedMs,
        battleCount: run.battleCount,
        errorCount: run.errorCount,
        msPerBattle: run.battleCount > 0 ? run.elapsedMs / run.battleCount : FALLBACK_MS_PER_BATTLE,
      },
      adjustments: s2Tuning.note ? [s2Tuning.note] : [],
      resumed: false,
    };
    writeCheckpoint(outDir, 2, stage2);
    log(
      `stage 2: done -- ${stage2.rankings.length} candidates ranked, ${stage2.timing.battleCount} battles ` +
        `(${stage2.timing.errorCount} errors), ${formatDuration(stage2.timing.elapsedMs)} elapsed, ` +
        `${stage2.timing.msPerBattle.toFixed(1)}ms/battle`
    );
  }

  // ---- Deadline tuning: stage 3's effective opponent count ----
  const msPerBattle2 = stage2.timing.msPerBattle > 0 ? stage2.timing.msPerBattle : FALLBACK_MS_PER_BATTLE;
  const remainingAfterS2 = deadlineMs - (Date.now() - runStartedAtMs);
  const s3Tuning = tuneStage3(remainingAfterS2, msPerBattle2, config);
  if (s3Tuning.note) {
    adjustments.push(s3Tuning.note);
    log(s3Tuning.note);
  }
  const s3OpponentsEffective = s3Tuning.opponents;

  // ============================== Stage 3 ================================
  const s3Checkpoint = readCheckpoint(outDir, 3);
  let stage3;

  if (s3Checkpoint && configsMatch(s3Checkpoint.config, config)) {
    stage3 = { ...s3Checkpoint, resumed: true };
    log(
      `stage 3: resuming from checkpoint (skipped) -- ${stage3.rankings.length} finalists ranked, ` +
        `${stage3.timing.battleCount} battles, ${stage3.timing.msPerBattle.toFixed(1)}ms/battle measured originally`
    );
  } else {
    const s3CandidateTeams = stage2.rankings.slice(0, config.s3Top).map((r) => r.members.map((m) => m.key));

    const curatedPool = loadMetaTeams(ctx);
    const curatedRatio3 = curatedRatioForFullInclusion(curatedPool.length, s3OpponentsEffective);
    if (curatedPool.length > s3OpponentsEffective) {
      log(
        `stage 3: curated pool (${curatedPool.length} teams) exceeds the opponent count (${s3OpponentsEffective}) -- ` +
          `full curated inclusion is not possible this run; capping curated draws at ${s3OpponentsEffective} ` +
          `(raise --s3-opponents above ${curatedPool.length} for full curated coverage).`
      );
    }
    log(
      `stage 3: battling top ${s3CandidateTeams.length} of stage 2 against ${s3OpponentsEffective} FRESH opponents ` +
        `(seed ${config.seed}-s3, curated-ratio=${curatedRatio3.toFixed(3)} for full-pool inclusion), full 9 lead pairings`
    );

    const s3OpponentsSampled = sampleOpponentTeams(ctx, {
      count: s3OpponentsEffective,
      weights,
      seed: `${config.seed}-s3`,
      curatedRatio: curatedRatio3,
      curated: curatedPool,
    });
    const actualCuratedCount = s3OpponentsSampled.filter((o) => o.label === 'curated').length;
    log(
      `stage 3: opponent pool assembled -- ${actualCuratedCount}/${curatedPool.length} curated teams included, ` +
        `${s3OpponentsSampled.length - actualCuratedCount} weighted-random sampled ` +
        `(${s3OpponentsSampled.length} total) -- verified against sampleOpponentTeams' actual curatedCount math.`
    );

    const run = await runFunnelStage(ctx, {
      candidates: s3CandidateTeams,
      matrix: deduped,
      opponents: s3OpponentsSampled,
      pairingsFor: () => ninePairings(),
      difficulty,
      trackLeads: true,
      threads,
      onProgress: progressFor(3),
      onLog: log,
    });

    stage3 = {
      stage: 3,
      config,
      runStartedAt: new Date(runStartedAtMs).toISOString(),
      opponentCount: { requested: config.s3Opponents, effective: s3OpponentsEffective },
      opponents: s3OpponentsSampled.map((o) => ({ id: o.id, name: o.name, label: o.label ?? null })),
      curatedPoolSize: curatedPool.length,
      rankings: run.rankings,
      timing: {
        startedAt: new Date(run.startedAt).toISOString(),
        finishedAt: new Date(run.finishedAt).toISOString(),
        elapsedMs: run.elapsedMs,
        battleCount: run.battleCount,
        errorCount: run.errorCount,
        msPerBattle: run.battleCount > 0 ? run.elapsedMs / run.battleCount : FALLBACK_MS_PER_BATTLE,
      },
      adjustments: s3Tuning.note ? [s3Tuning.note] : [],
      resumed: false,
    };
    writeCheckpoint(outDir, 3, stage3);
    log(
      `stage 3: done -- ${stage3.rankings.length} finalists ranked, ${stage3.timing.battleCount} battles ` +
        `(${stage3.timing.errorCount} errors), ${formatDuration(stage3.timing.elapsedMs)} elapsed, ` +
        `${stage3.timing.msPerBattle.toFixed(1)}ms/battle`
    );
  }

  const result = {
    collectionPath: csvPath,
    reportPath,
    outDir,
    donePath: path.join(outDir, 'tournament-DONE'),
    config,
    runStartedAt: new Date(runStartedAtMs).toISOString(),
    importWarnings,
    stage1,
    stage2,
    stage3,
    finalRankings: stage3.rankings,
    adjustments,
    totalElapsedMs: Date.now() - runStartedAtMs,
  };

  const markdown = renderTournamentReport(result);
  mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  writeFileSync(reportPath, markdown, 'utf8');
  log(`report written to ${reportPath}`);

  // Written LAST, only after the report is safely on disk -- signals a fully
  // successful run to anything monitoring the overnight job.
  writeFileSync(result.donePath, renderDoneMarker(result), 'utf8');
  log(`tournament: DONE (${result.donePath})`);

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

const HELP = `pogo-gbl-team-generator tournament -- overnight 3-stage funnel (500 -> 100 -> 10 by default)

Usage:
  node scripts/tournament.mjs <collection.csv> [options]

Options:
  --score-meta S       1v1-pruning meta size                       (default ${DEFAULTS.scoreMeta})
  --pool P              sampling pool size                          (default ${DEFAULTS.pool})
  --seed S              PRNG seed                                   (default "${DEFAULTS.seed}")
  --curated-ratio R     curated-vs-sampled opponent mix, stages 1-2 (default ${DEFAULTS.curatedRatio})
  --s1-candidates N     stage 1 candidate teams sampled             (default ${DEFAULTS.s1Candidates})
  --s1-opponents M      stage 1 opponent teams sampled              (default ${DEFAULTS.s1Opponents})
  --s2-top N            candidates advancing stage 1 -> 2           (default ${DEFAULTS.s2Top})
  --s2-opponents M      stage 2 opponent teams (fresh sample)       (default ${DEFAULTS.s2Opponents})
  --s3-top N            candidates advancing stage 2 -> 3           (default ${DEFAULTS.s3Top})
  --s3-opponents M      stage 3 opponent teams (fresh sample)       (default ${DEFAULTS.s3Opponents})
  --deadline-minutes D  overall wall-clock budget (self-tuning)     (default ${DEFAULTS.deadlineMinutes})
  --exclude a,b         species ids excluded from candidate teams   (default: none)
  --difficulty D        AI difficulty 0-3 override                 (default: engine default, 3)
  --threads N           battle via the worker-pool executor, batched per
                          candidate (src/engine/parallel.js); omit for serial (default: not set, i.e. serial)
  --out PATH            final Markdown report path                 (default <out-dir>/my-teams-tournament.md)
  --out-dir DIR         checkpoints + DONE marker + default report  (default "${DEFAULTS.outDir}")
  --help                print this help and exit
`;

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function intFlag(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer, got "${value}"`);
  }
  return n;
}

function fractionFlag(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`--${name} must be a number in [0,1], got "${value}"`);
  }
  return n;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'score-meta': { type: 'string' },
        pool: { type: 'string' },
        seed: { type: 'string' },
        'curated-ratio': { type: 'string' },
        's1-candidates': { type: 'string' },
        's1-opponents': { type: 'string' },
        's2-top': { type: 'string' },
        's2-opponents': { type: 'string' },
        's3-top': { type: 'string' },
        's3-opponents': { type: 'string' },
        'deadline-minutes': { type: 'string' },
        exclude: { type: 'string' },
        difficulty: { type: 'string' },
        threads: { type: 'string' },
        out: { type: 'string' },
        'out-dir': { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    say(HELP);
    if (positionals.length === 0 && !values.help) process.exitCode = 2;
    return;
  }

  const csvPath = positionals[0];
  const opts = {
    scoreMeta: intFlag(values['score-meta'], 'score-meta', DEFAULTS.scoreMeta),
    pool: intFlag(values.pool, 'pool', DEFAULTS.pool),
    seed: values.seed ?? DEFAULTS.seed,
    curatedRatio: fractionFlag(values['curated-ratio'], 'curated-ratio', DEFAULTS.curatedRatio),
    excludeSpecies: values.exclude ? values.exclude.split(',').map((s) => s.trim()).filter(Boolean) : [],
    difficulty: values.difficulty !== undefined ? intFlag(values.difficulty, 'difficulty', undefined) : undefined,
    threads: values.threads !== undefined ? intFlag(values.threads, 'threads', undefined) : undefined,
    s1Candidates: intFlag(values['s1-candidates'], 's1-candidates', DEFAULTS.s1Candidates),
    s1Opponents: intFlag(values['s1-opponents'], 's1-opponents', DEFAULTS.s1Opponents),
    s2Top: intFlag(values['s2-top'], 's2-top', DEFAULTS.s2Top),
    s2Opponents: intFlag(values['s2-opponents'], 's2-opponents', DEFAULTS.s2Opponents),
    s3Top: intFlag(values['s3-top'], 's3-top', DEFAULTS.s3Top),
    s3Opponents: intFlag(values['s3-opponents'], 's3-opponents', DEFAULTS.s3Opponents),
    deadlineMinutes: intFlag(values['deadline-minutes'], 'deadline-minutes', DEFAULTS.deadlineMinutes),
    outDir: values['out-dir'] ?? DEFAULTS.outDir,
    out: values.out,
  };

  // pvpoke's vendored engine prints a few debug lines (e.g. "loading
  // gamemaster") via the host console during init/scoring/battling; silence
  // log/info/debug so stdout stays clean (this file uses process.stdout.write
  // via say()). warn/error still surface. teamBattle silences its own vm
  // console during battles independently. Same approach as src/cli.js.
  const realLog = console.log;
  console.log = () => undefined;
  console.info = () => undefined;
  console.debug = () => undefined;

  let result;
  try {
    result = await runTournament(csvPath, {
      ...opts,
      onLog: (msg) => process.stderr.write(`${msg}\n`),
      onProgress: ({ stage, completed, total, startedAt }) => {
        if (completed % 10 !== 0 && completed !== total) return;
        const p = Math.floor((completed / total) * 100);
        const elapsed = Date.now() - startedAt;
        const etaMs = completed > 0 ? (elapsed / completed) * (total - completed) : NaN;
        process.stderr.write(
          `\r[stage ${stage}] ${completed}/${total} (${p}%) ETA ${formatDuration(etaMs)}   ` + (completed === total ? '\n' : '')
        );
      },
    });
  } finally {
    console.log = realLog;
  }

  say(`Tournament complete. ${result.finalRankings.length} finalist team(s) ranked.`);
  if (result.finalRankings[0]) {
    const top = result.finalRankings[0];
    say(`Top team: ${top.members.map((m) => m.name).join(', ')} -- ${pct(top.winRate)} stage-3 win rate.`);
  }
  say('');
  say(`Full report written to ${result.reportPath}`);
  say(`Done marker written to ${result.donePath}`);
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`\nError: ${err.message}\n`);
    process.exitCode = 1;
  });
}
