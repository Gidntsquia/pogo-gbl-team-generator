import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHelpFlags, flagsToArgv, simShArgv, configToArgv, softStopDecision, buildStatus, parseLog, processTree, latestGen,
} from '../mcp/lib.mjs';

const HELP = `Options:
  --population N         GA population
  --halving-rounds R       Sequential
  --hoeffding-races        EXPERIMENTAL, off
  --ban a,b                species
  --fitness classic|battle-reality  metric
  --no-html                skip
`;
const flags = parseHelpFlags(HELP);

test('help table: value flags vs booleans', () => {
  assert.equal(flags.get('population').takesValue, true);
  assert.equal(flags.get('ban').takesValue, true);
  assert.equal(flags.get('fitness').takesValue, true);
  assert.equal(flags.get('hoeffding-races').takesValue, false);
  assert.equal(flags.get('no-html').takesValue, false);
});

test('flagsToArgv maps values and rejects typos with a suggestion', () => {
  assert.deepEqual(flagsToArgv({ population: 10, 'no-html': true, ban: ['a', 'b'] }, flags), ['--population', '10', '--no-html', '--ban', 'a,b']);
  assert.throws(() => flagsToArgv({ populaton: 1 }, flags), /did you mean "population"/);
});

test('simShArgv: standard vs meta, extra after --', () => {
  const std = simShArgv({ csv: 'x.csv', name: 'n', hours: 2, extra: { 'no-html': true }, dry_run: true }, 'standard', flags);
  assert.deepEqual(std, ['x.csv', '--name', 'n', '--hours', '2', '--threads', '8', '--dry-run', '--', '--no-html']);
  const meta = simShArgv({ name: 'm', meta_pool: 0 }, 'meta', flags);
  assert.equal(meta[0], '--meta');
  assert.ok(meta.join(' ').includes('--meta-pool 0'));
});

test('configToArgv rebuilds flags; absent halving means off', () => {
  const cfg = { csvPath: '/a.csv', population: 30, seed: 's', cup: 'mega', banSpecies: ['x'], metaMode: true, snowballWeight: 0.4, sampledOpponents: 400 };
  const { argv, usedLaunch } = configToArgv(cfg, { argv: ['--final-fresh', '20', '--threads', '8'] });
  const s = argv.join(' ');
  assert.ok(s.startsWith('/a.csv'));
  for (const frag of ['--population 30', '--seed s', '--cup mega', '--ban x', '--meta-mode', '--snowball-weight 0.4', '--sampled-opponents 400', '--halving-rounds 0', '--final-fresh 20']) assert.ok(s.includes(frag), frag);
  assert.deepEqual(usedLaunch, ['final-fresh']);
  assert.ok(!configToArgv({ ...cfg, halvingRounds: 3, halvingKeep: 0.5 }).argv.join(' ').includes('--halving-rounds 0'));
});

test('soft-stop decision (fake clock = injected state)', () => {
  const base = { startGen: 4, done: false, pidAlive: true };
  assert.equal(softStopDecision({ ...base, currentGen: 4 }), 'wait');
  assert.equal(softStopDecision({ ...base, currentGen: 5 }), 'kill');
  assert.equal(softStopDecision({ ...base, currentGen: 4, done: true }), 'exit');
  assert.equal(softStopDecision({ ...base, currentGen: 4, pidAlive: false }), 'exit');
  assert.equal(latestGen(['evolve-gen2.json', 'evolve-gen10.json', 'x']), 10);
});

test('status from a fixture checkpoint + log', () => {
  const cp = {
    generation: 3, threadsUsed: 8, config: { generations: 10, cup: 'all', cp: 1500, population: 5 }, timing: { msPerBattle: 20 },
    analytics: {
      topTeams: [{ rank: 1, members: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], fitness: 0.6, winRate: 0.5, snowballIndex: 0.7, consistencyScore: 0.4 }],
      speciesStats: [{ speciesId: 'a', meanFitness: 0.4, representation: 0.1 }, { speciesId: 'b', meanFitness: 0.6, representation: 0.2 }],
      toughestOpponents: [{ name: 'O', origin: 'curated', fitness: 0.7 }],
    },
    opponentPool: [{ members: [{ speciesId: 'q' }, { speciesId: 'r' }] }, { members: [{ speciesId: 'q' }] }],
    opponentFitness: [0.5, 0.7],
  };
  const log = 'generation 2: done -- mean fitness 1%, x, 100 battles simulated + 50 served from cache (both), 1m 30s elapsed, process RSS 2000MB\n'
    + 'generation 3: done -- mean fitness 1%, x, 120 battles simulated + 60 served from cache (both), 2m 0s elapsed, process RSS 2100MB';
  const s = buildStatus(cp, log, 15);
  assert.equal(s.checkpointGeneration, 3);
  assert.equal(s.topSpecies[0].species, 'b');
  assert.deepEqual(s.topOpponentSpecies[0], { species: 'q', meanFitness: 0.6, representation: 1 });
  assert.equal(s.memory.lastLoggedRssMB, 2100);
  assert.equal(s.speed.etaMinutes, 10.5); // 6 remaining x mean(90s,120s)=105s
  assert.equal(parseLog(log).length, 2);
});

test('processTree sums descendants', () => {
  const ps = '  PID  PPID   RSS\n 1 0 1024\n 2 1 2048\n 3 2 1024\n 9 0 5000';
  const t = processTree(ps, 1);
  assert.deepEqual([...t.pids].sort(), [1, 2, 3]);
  assert.equal(t.rssMB, 4);
});
