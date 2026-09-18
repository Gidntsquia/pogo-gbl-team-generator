#!/usr/bin/env node
// JavaScript Document
//
// One-off experiment (plans/PLAN.md "Find the cause of the candidate/
// opponent fitness asymmetry", Item 1): battle the same K candidates and K
// opponents from one evolve checkpoint generation from BOTH seats, so the
// ~5-8pt candidate/opponent fitness gap documented in RUNBOOK.md "Known
// artifact" and src/engine/README.md "Balance / tolerance" can be decomposed
// into (a) a side bias intrinsic to pvpoke emulate mode (team A vs team B),
// (b) a real population-strength difference between the candidate and
// opponent GA populations, and (c) moveset mismatches for species shared by
// both sides. No battle math here -- every result comes from battleTeams
// (src/engine/teamBattle.js), pvpoke's own emulate engine, run in BOTH
// directions per pairing.
//
// Reuses the exact shared-setup path scripts/evolve.mjs's main() uses
// (importCollection -> expandEvolutions -> filterEligibleMons ->
// scoreCollection -> dedupeBestPerSpecies for the candidate side;
// rehydrateOpponentPool + loadMetaTeams for the opponent side) so the K
// candidates/opponents pulled from the checkpoint are built exactly the way
// the run itself built them -- no re-derivation, no new sampling.
//
// Usage:
//   node scripts/side-bias-study.mjs <out/evolve-dir> --gen N --sample K
//     [--threads T] [--moveset-source candidate]
//
// --moveset-source candidate overrides each COMPOSED (non-curated) opponent
// member's moveset with the candidate side's own moveset for that species
// (only meaningful once Item 4 lands; until then it is a no-op left for
// forward compatibility -- see plans/WORKER_NOTES.md "Item 4").
//
// No caching: forward and reversed battles are distinct pairings (their cache
// keys would differ anyway, since teamA/teamB and leadA/leadB are swapped),
// so nothing here would ever hit a cache -- creating one would only spend
// memory for no reuse.

import { readFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { parseArgs } from 'node:util';

import { importCollection } from '../src/importer/index.js';
import { expandEvolutions } from '../src/evolution/index.js';
import { filterEligibleMons } from '../src/util/eligibility.js';
import { initEngine } from '../src/engine/harness.js';
import { battleTeams } from '../src/engine/teamBattle.js';
import { createExecutor } from '../src/engine/parallel.js';
import { scoreCollection } from '../src/scoring/index.js';
import { dedupeBestPerSpecies } from '../src/teams/index.js';
import { rehydrateOpponentPool } from '../src/meta/opponentPool.js';
import { loadMetaTeams } from '../src/meta/teams.js';
import { baseIdOf } from '../src/meta/sampleTeams.js';
import { filterBannedCuratedTeams } from './evolve.mjs';

const CANDIDATE_LEAD = 0;

function opponentLeadIndex(opp) {
  return opp.leadIndex ?? 0;
}

function readCheckpointFile(dir, gen) {
  const p = join(dir, `evolve-gen${gen}.json`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** Candidate's own recommended moveset for a built matrix entry, read off the live pvpoke Pokemon instance (never stored as plain fields -- src/scoring/index.js's scoreCollection doesn't apply an explicit moveset unless --current-moves). */
function candidateMoveset(built) {
  return {
    fastMove: built.pokemon.fastMove.moveId,
    chargedMoves: Array.from(built.pokemon.chargedMoves).map((m) => m.moveId),
  };
}

function movesetsEqual(a, b) {
  if (a.fastMove !== b.fastMove) return false;
  if (a.chargedMoves.length !== b.chargedMoves.length) return false;
  const as = [...a.chargedMoves].sort();
  const bs = [...b.chargedMoves].sort();
  return as.every((m, i) => m === bs[i]);
}

async function main(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      gen: { type: 'string' },
      sample: { type: 'string' },
      threads: { type: 'string' },
      'moveset-source': { type: 'string', default: 'own' },
    },
  });

  const dir = positionals[0];
  if (!dir || values.gen === undefined || values.sample === undefined) {
    console.error(
      'usage: node scripts/side-bias-study.mjs <out/evolve-dir> --gen N --sample K [--threads T] [--moveset-source candidate]'
    );
    process.exit(1);
  }
  const gen = Number(values.gen);
  const K = Number(values.sample);
  const threads = values.threads !== undefined ? Number(values.threads) : 0;
  const movesetSource = values['moveset-source'] ?? 'own';

  const cp = readCheckpointFile(dir, gen);
  const config = cp.config;

  // ---- shared setup, mirroring scripts/evolve.mjs's main() exactly --------
  const { mons: importedMons } = importCollection(config.csvPath, { cp: config.cp });
  const ctx = await initEngine({ cp: config.cp, cup: config.cup });
  const expanded = config.evolutions ? expandEvolutions(ctx, importedMons) : { mons: importedMons, warnings: [] };
  const eligible = filterEligibleMons(ctx, expanded.mons);
  const matrix = scoreCollection(ctx, eligible.mons, { metaLimit: config.scoreMeta });
  const deduped = dedupeBestPerSpecies(matrix, { keepShadowVariants: true });
  const banBaseIds = new Set(config.banSpecies ?? []);
  const curatedPool = filterBannedCuratedTeams(loadMetaTeams(ctx), banBaseIds);

  // ---- pull the first K candidates / opponents of generation N, no RNG ----
  if (!Array.isArray(cp.population) || cp.population.length < K) {
    throw new Error(`side-bias-study: gen ${gen} checkpoint has only ${cp.population?.length ?? 0} candidates, need ${K}`);
  }
  if (!Array.isArray(cp.opponentPool) || cp.opponentPool.length < K) {
    throw new Error(`side-bias-study: gen ${gen} checkpoint has only ${cp.opponentPool?.length ?? 0} opponents, need ${K}`);
  }
  const candidateKeyLists = cp.population.slice(0, K);
  const opponents = rehydrateOpponentPool(ctx, cp.opponentPool.slice(0, K), curatedPool, () => {});

  const candidates = candidateKeyLists.map((keys) => keys.map((key) => deduped.builtMons[key]));

  // ---- moveset parity: shared species between the K candidates and K opponents ----
  const candidateBySpecies = new Map(); // `${baseSpeciesId}|${shadow}` -> built candidate entry
  for (const members of candidates) {
    for (const b of members) {
      const shadow = !!b.spec?.shadow;
      candidateBySpecies.set(`${baseIdOf(b.speciesId)}|${shadow}`, b);
    }
  }
  const opponentSpeciesSeen = new Map(); // same key -> opponent member
  for (const opp of opponents) {
    for (const m of opp.members) {
      opponentSpeciesSeen.set(`${baseIdOf(m.speciesId)}|${!!m.shadow}`, m);
    }
  }
  const sharedKeys = [...opponentSpeciesSeen.keys()].filter((k) => candidateBySpecies.has(k));
  const mismatches = [];
  for (const key of sharedKeys) {
    const cand = candidateMoveset(candidateBySpecies.get(key));
    const opp = opponentSpeciesSeen.get(key);
    const oppMoveset = { fastMove: opp.fastMove, chargedMoves: opp.chargedMoves };
    if (!movesetsEqual(cand, oppMoveset)) {
      mismatches.push({ speciesId: key.split('|')[0], candidate: cand, opponent: oppMoveset });
    }
  }

  // --moveset-source candidate: forward-compat hook only (see header comment).
  // Applying it here would require the same override evolve.mjs itself uses
  // once Item 4 exists (plans/PLAN.md Item 4); until then this flag is
  // accepted but does not change battles, and is not exercised by Item 1's
  // own endpoint command.
  if (movesetSource !== 'own' && movesetSource !== 'candidate') {
    throw new Error(`side-bias-study: unknown --moveset-source "${movesetSource}" (expected "own" or "candidate")`);
  }

  // ---- battle every (candidate, opponent) pair in BOTH directions ----------
  const threadedExec = threads > 0 ? createExecutor({ threads, vendorRoot: ctx.vendorRoot, continueOnError: true, cp: ctx.cp, cup: ctx.cup }) : null;

  const specsList = []; // {teamA, teamB, leadA, leadB, difficulty, dir:'fwd'|'rev', i, j}
  for (let i = 0; i < candidates.length; i++) {
    const teamASpec = candidates[i].map((m) => m.spec);
    for (let j = 0; j < opponents.length; j++) {
      const teamBSpec = opponents[j].members.map((m) => m.spec);
      const leadB = opponentLeadIndex(opponents[j]);
      specsList.push({ teamA: teamASpec, teamB: teamBSpec, leadA: CANDIDATE_LEAD, leadB, difficulty: config.difficulty ?? undefined, dir: 'fwd', i, j });
      specsList.push({ teamA: teamBSpec, teamB: teamASpec, leadA: leadB, leadB: CANDIDATE_LEAD, difficulty: config.difficulty ?? undefined, dir: 'rev', i, j });
    }
  }

  let results;
  if (threadedExec) {
    const slots = await threadedExec.run(specsList.map(({ teamA, teamB, leadA, leadB, difficulty }) => ({ teamA, teamB, leadA, leadB, difficulty })));
    results = slots.map((slot, idx) => {
      if (!slot.ok) throw new Error(`side-bias-study: battle failed for ${specsList[idx].dir} pairing i=${specsList[idx].i} j=${specsList[idx].j}: ${slot.error.message}`);
      return slot.value;
    });
    await threadedExec.close();
  } else {
    const teamACache = candidates.map((members) => members.map((m) => m.pokemon));
    const teamBCache = opponents.map((opp) => opp.members.map((m) => m.pokemon));
    results = specsList.map((s) => {
      const teamA = s.dir === 'fwd' ? teamACache[s.i] : teamBCache[s.j];
      const teamB = s.dir === 'fwd' ? teamBCache[s.j] : teamACache[s.i];
      return battleTeams(ctx, { teamA, teamB, leadA: s.leadA, leadB: s.leadB, difficulty: s.difficulty });
    });
  }

  function aWinPoints(r) {
    if (r.winner === 'a') return 1;
    if (r.winner === 'tie') return 0.5;
    return 0;
  }

  let fwdSum = 0;
  let fwdCount = 0;
  let revSum = 0;
  let revCount = 0;
  // pairing sums for the identity check / N
  const pairA = new Map(); // `${i}|${j}` -> forward A(candidate) win points
  const pairB = new Map(); // `${i}|${j}` -> reversed A(opponent) win points

  results.forEach((r, idx) => {
    const s = specsList[idx];
    const pts = aWinPoints(r);
    if (s.dir === 'fwd') {
      fwdSum += pts;
      fwdCount += 1;
      pairA.set(`${s.i}|${s.j}`, pts);
    } else {
      revSum += pts;
      revCount += 1;
      pairB.set(`${s.i}|${s.j}`, pts);
    }
  });

  const F = fwdSum / fwdCount;
  const R = revSum / revCount;
  const S = (F + R) / 2 - 0.5;
  let nSum = 0;
  let nCount = 0;
  for (const key of pairA.keys()) {
    const a = pairA.get(key);
    const b = pairB.get(key);
    nSum += (a + (1 - b)) / 2;
    nCount += 1;
  }
  const N = nSum / nCount;
  const P = N - 0.5;
  const totalBattles = fwdCount + revCount;

  let verdict;
  const sBig = Math.abs(S) >= 0.01;
  const pBig = Math.abs(P) >= 0.01;
  if (sBig && pBig) verdict = 'both';
  else if (sBig) verdict = 'side-bias';
  else if (pBig) verdict = 'population';
  else verdict = 'neither';

  console.log(`forward candidate-as-A win rate: ${F.toFixed(4)}`);
  console.log(`reversed opponent-as-A win rate: ${R.toFixed(4)}`);
  console.log(`side bias S (team-A win rate over all 2K^2 battles minus 0.5): ${S.toFixed(4)}`);
  console.log(`candidate side-neutral win rate: ${N.toFixed(4)}`);
  console.log(`population gap P (N minus 0.5): ${P.toFixed(4)}`);
  console.log(`moveset mismatches: ${mismatches.length} of ${sharedKeys.length} shared species`);
  for (const m of mismatches) {
    console.log(
      `  ${m.speciesId}: candidate=${m.candidate.fastMove}/${m.candidate.chargedMoves.join('+')} ` +
        `opponent=${m.opponent.fastMove}/${m.opponent.chargedMoves.join('+')}`
    );
  }
  console.log(`battles: ${totalBattles}`);
  console.log(`verdict: ${verdict}`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`\nError: ${err.message}\n${err.stack}\n`);
    process.exitCode = 1;
  });
}
