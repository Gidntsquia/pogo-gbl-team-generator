// Export pvpoke's own view of real battles as flat JSON for the CUDA kernels.
//
//   node gpu/export-matchups.mjs [--specs out/gpu/gen0-specs.json] [--out out/gpu]
//                                [--battles N] [--fixtures]
//
// Imports nothing outside src/engine/ and src/scoring/ (R10). Writes:
//   <out>/mons.json    table of distinct static mon descriptors (stats, types, effectiveness, moves);
//                       sims/battles refer to them by index and add only the per-call state
//   <out>/sims.json     every distinct 1v1 `Battle.simulate()` the TrainingAI ran inside the
//                       exported 3v3 battles (scenario memo OFF so each is really executed):
//                       entry state of both mons + pvpoke's results for that exact state
//   <out>/battles.json  the 3v3 battles: six full mon descriptors, leads, difficulty, seed,
//                       and `battleTeams`' result (winner, survivorsHp, summary)
// Battle specs come from gpu/dump-gen0-specs.mjs (real gen-0 candidates vs opponents) and,
// with --fixtures, the test/e2e.test.js mirror / dominant-team fixtures.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { initEngine, buildPokemon, simBattle } from '../src/engine/harness.js';
import { battleTeams, initTeamBattle } from '../src/engine/teamBattle.js';
import { applyGroupMoveset } from '../src/scoring/index.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const specsPath = opt('specs', 'out/gpu/gen0-specs.json');
const outDir = opt('out', 'out/gpu');
const maxBattles = Number(opt('battles', 1e9));
const withFixtures = args.includes('--fixtures');
const fixturesOnly = args.includes('--fixtures-only');
const rankingsN = Number(opt('rankings', 0)); // top-N rankings-1500 species, all ordered pairs (shields 1/1)

// ---------------------------------------------------------------- descriptors

const TYPES = ['bug', 'dark', 'dragon', 'electric', 'fairy', 'fighting', 'fire', 'flying', 'ghost', 'grass', 'ground', 'ice', 'normal', 'poison', 'psychic', 'rock', 'steel', 'water'];
const typeId = (t) => (t ? TYPES.indexOf(String(t).toLowerCase()) : -1);
const BUFF_TARGET = { none: 0, self: 1, opponent: 2, both: 3 };

function describeMove(m) {
  if (!m) return null;
  return {
    id: m.moveId,
    type: typeId(m.type),
    power: m.power,
    energy: m.energy,
    energyGain: m.energyGain,
    cooldown: m.cooldown,
    turns: m.turns,
    percentHp: m.damageMethod === 'percentMaxHP' ? 1 : 0,
    megaMove: m.isMegaMove ? 1 : 0,
    buffs: m.buffs ? [m.buffs[0], m.buffs[1]] : null,
    buffTarget: BUFF_TARGET[m.buffTarget] ?? 0,
    buffsSelf: m.buffsSelf ? [m.buffsSelf[0], m.buffsSelf[1]] : null,
    buffsOpponent: m.buffsOpponent ? [m.buffsOpponent[0], m.buffsOpponent[1]] : null,
    buffApplyChance: m.buffs ? m.buffApplyChance : 0,
    selfDebuffing: m.selfDebuffing ? 1 : 0,
    selfBuffing: m.selfBuffing ? 1 : 0,
    selfAttackDebuffing: m.selfAttackDebuffing ? 1 : 0,
    selfDefenseDebuffing: m.selfDefenseDebuffing ? 1 : 0,
    instant: m.tags && m.tags.includes('instant') ? 1 : 0,
    ignoresFaint: m.tags && m.tags.includes('ignoresFaint') ? 1 : 0,
    formChange: m.formChange ? 1 : 0,
  };
}

const monTable = [];
const monIndex = new Map();
function internMon(st) {
  const key = JSON.stringify(st);
  let i = monIndex.get(key);
  if (i === undefined) {
    i = monTable.length;
    monTable.push(st);
    monIndex.set(key, i);
  }
  return i;
}

/** Everything a battle reads off one Pokemon, as plain numbers. `entry` adds the live state at the call. */
function describeMon(p, entry) {
  const st = {
    species: p.speciesId,
    atk: p.stats.atk,
    def: p.stats.def,
    hpMax: p.stats.hp,
    types: [typeId(p.types[0]), typeId(p.types[1] === 'none' ? null : p.types[1])],
    shadow: p.shadowType === 'shadow' ? 1 : 0,
    shadowAtk: p.shadowAtkMult,
    shadowDef: p.shadowDefMult,
    // defensive effectiveness vs each attacking type, in TYPES order
    eff: TYPES.map((t) => p.typeEffectiveness[t]),
    // form changers (Mimikyu, Cramorant, Aegislash, ...) are not ported: flagged so the kernel can skip them
    formChange: p.formChange ? 1 : 0,
    megaLevel: p.megaLevel,
    mega: typeof p.hasTag === 'function' && p.hasTag('mega') ? 1 : 0,
    // ActionLogic hard-codes Melmetal vs Cresselia (1/2); Cramorant (3) is a form changer
    special: p.speciesName === 'Melmetal' ? 1 : p.speciesName === 'Cresselia' ? 2 : p.speciesId === 'cramorant' ? 3 : 0,
    fast: describeMove(p.fastMove),
    charged: [0, 1, 2].map((i) => describeMove(p.chargedMoves[i])),
    name: p.speciesName,
  };
  const d = {
    mon: internMon(st),
    startHp: p.startHp,
    startEnergy: p.startEnergy,
    startCooldown: p.startCooldown,
    startingShields: p.startingShields,
    startStatBuffs: [p.startStatBuffs[0], p.startStatBuffs[1]],
    nativeStatBuffs: [p.nativeStatBuffs[0], p.nativeStatBuffs[1]],
    priority: p.priority,
    turnsToKO: p.turnsToKO,
    baitShields: p.baitShields,
    farmEnergy: p.farmEnergy ? 1 : 0,
    optimizeMoveTiming: p.optimizeMoveTiming ? 1 : 0,
  };
  if (entry) d.statBuffs = [p.statBuffs[0], p.statBuffs[1]];
  return d;
}

// ----------------------------------------------------------------- rebuilding

const ctx = await initEngine();
initTeamBattle(ctx);

function build(spec) {
  const p = buildPokemon(ctx, { speciesId: spec.speciesId, ivs: spec.ivs, shadow: !!spec.shadow, bestBuddy: !!spec.bestBuddy });
  if (spec.fastMove) applyGroupMoveset(p, { fastMove: spec.fastMove, chargedMoves: spec.chargedMoves });
  return p;
}
const buildTeam = (specs) => specs.map(build);

// ------------------------------------------------------------ 1v1 capture hook

const sims = [];
const simIndex = new Map();
let currentBattleId = null;
let rawSimCount = 0;
let lastEntryKey = null;
let capturing = false;
const vmMath = ctx.__teamBattle.vmMath;

const hook = {
  begin(b) {
    const [p0, p1] = b.getPokemon();
    const entry = [describeMon(p0, true), describeMon(p1, true)];
    const saved = vmMath.random;
    const state = { entry, saved, draws: 0 };
    vmMath.random = () => {
      state.draws++;
      return saved();
    };
    return state;
  },
  end(b, state) {
    vmMath.random = state.saved;
    rawSimCount++;
    lastEntryKey = state.entry;
    const key = JSON.stringify(state.entry);
    if (simIndex.has(key)) return;
    const [p0, p1] = b.getPokemon();
    const r = b.getBattleRatings();
    const res = {
      rating: [r[0], r[1]],
      hp: [p0.hp, p1.hp],
      energy: [p0.energy, p1.energy],
      shields: [p0.shields, p1.shields],
      buffs: [[p0.statBuffs[0], p0.statBuffs[1]], [p1.statBuffs[0], p1.statBuffs[1]]],
      turns: b.getTurns(),
      turnsToKO: [p0.turnsToKO, p1.turnsToKO],
      draws: state.draws,
    };
    simIndex.set(key, sims.length);
    sims.push({ battle: currentBattleId, entry: state.entry, result: res });
  },
};
ctx.context.__simHook = hook;
// Wrap the vm-global Battle so every `new Battle()` the TrainingAI makes records its simulate() calls.
// (teamBattle.js builds its own top-level Battle from ctx.Battle, the unwrapped original.)
import vm from 'node:vm';
vm.runInContext(
  `(function () {
    const Orig = Battle;
    Battle = function () {
      const b = new Orig();
      const sim = b.simulate;
      b.simulate = function () {
        const st = __simHook.begin(b);
        const out = sim.apply(b, arguments);
        __simHook.end(b, st);
        return out;
      };
      return b;
    };
    Battle.prototype = Orig.prototype;
  })()`,
  ctx.context,
);

// ------------------------------------------------------------------- run list

/** @type {{id:string, teamA:object[], teamB:object[], leadA:number, leadB:number, tag:string}[]} */
const list = [];
if (!fixturesOnly) {
  const g = JSON.parse(readFileSync(specsPath, 'utf8'));
  for (const b of g.battles.slice(0, maxBattles)) list.push({ ...b, tag: 'gen0' });
}
if (withFixtures || fixturesOnly) {
  // test/e2e.test.js fixtures: rank-1 IVs, STRONG vs WEAK and STRONG mirror, all 9 lead pairings.
  const IVS = { atk: 0, def: 15, hp: 15 };
  const mk = (ids) => ids.map((speciesId) => ({ speciesId, ivs: IVS }));
  const STRONG = mk(['azumarill', 'registeel', 'altaria']);
  const WEAK = mk(['magikarp', 'sunkern', 'feebas']);
  for (const [name, A, B] of [['dominant', STRONG, WEAK], ['mirror', STRONG, STRONG]]) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) list.push({ id: `${name}-${i}${j}`, teamA: A, teamB: B, leadA: i, leadB: j, tag: name });
  }
}

// ------------------------------------------------------------------------ run

const battles = [];
const t0 = Date.now();
for (const item of list) {
  currentBattleId = item.id;
  const teamA = buildTeam(item.teamA);
  const teamB = buildTeam(item.teamB);
  const monsA = teamA.map((p) => describeMon(p, false));
  const monsB = teamB.map((p) => describeMon(p, false));
  const simsBefore = rawSimCount;
  const result = battleTeams(ctx, { teamA, teamB, leadA: item.leadA, leadB: item.leadB, scenarioMemo: false });
  battles.push({
    id: item.id,
    tag: item.tag,
    dir: item.dir ?? null,
    teamA: monsA,
    teamB: monsB,
    leadA: item.leadA,
    leadB: item.leadB,
    difficulty: result.summary.difficulty,
    seed: result.summary.seed,
    rawInnerSims: rawSimCount - simsBefore,
    result: { winner: result.winner, survivorsHp: result.survivorsHp, summary: result.summary },
  });
}
// rankings-1500 lead scenario (test/engine.test.js): simBattle at shields 1/1 with default IVs,
// compared to pvpoke's recorded ratings. Stored as the sim's index in sims.json + the recorded ratings.
const rankingChecks = [];
if (rankingsN > 0) {
  const wctx = { ...ctx, battle: vm.runInContext('new Battle()', ctx.context) };
  const ids = ctx.rankings.slice(0, rankingsN).map((r) => r.speciesId);
  const defaults = (id) => {
    const [, atk, def, hp] = ctx.gm.getPokemonById(id).defaultIVs.cp1500;
    return { atk, def, hp };
  };
  const recorded = (row, opp) => [...row.matchups, ...row.counters].find((m) => m.opponent === opp)?.rating;
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    const rowA = ctx.rankings.find((r) => r.speciesId === a);
    const expected = recorded(rowA, b);
    if (expected === undefined) continue;
    currentBattleId = `rank-${a}-${b}`;
    const p1 = buildPokemon(ctx, { speciesId: a, ivs: defaults(a) });
    const p2 = buildPokemon(ctx, { speciesId: b, ivs: defaults(b) });
    const before = rawSimCount;
    const r = simBattle(wctx, { p1, p2, shields: [1, 1] });
    if (rawSimCount !== before + 1) continue;
    const key = JSON.stringify(lastEntryKey);
    rankingChecks.push({ a, b, sim: simIndex.get(key), expected, jsRating: r.rating1 });
  }
}
const wall = (Date.now() - t0) / 1000;
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'rankings.json'), JSON.stringify(rankingChecks));
writeFileSync(path.join(outDir, 'mons.json'), JSON.stringify(monTable));
writeFileSync(path.join(outDir, 'sims.json'), JSON.stringify(sims));
writeFileSync(path.join(outDir, 'battles.json'), JSON.stringify(battles));
console.log(`exported ${battles.length} battles, ${rawSimCount} inner sims (${sims.length} distinct) in ${wall.toFixed(1)}s -> ${outDir}/{mons,sims,battles}.json`);
process.exit(0);
