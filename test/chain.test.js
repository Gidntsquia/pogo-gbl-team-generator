import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, stageCommands, checkCurated, runChain } from '../scripts/chain.mjs';
import { chainArgv } from '../mcp/common.mjs';

const opts = (more = []) => parseArgs(['--name', 'x', '--cup', 'fantasy', 'c.csv', ...more]);

test('stageCommands: three stages, names, explicit sizes, cpu-only on both runs', () => {
  const { commands, metaRun, stdRun } = stageCommands(opts(['--cpu-only', '--threads', '4']));
  assert.equal([metaRun, stdRun].join(), 'x-meta,x-std');
  assert.ok(commands[0].join(' ').includes('--meta --name x-meta --cup fantasy'));
  assert.ok(commands[1].join(' ').includes('out/evolve-x-meta --cup fantasy') && commands[1].includes('data/meta-teams-community-fantasy.json'));
  assert.ok(commands[2].join(' ').includes('c.csv --name x-std --cup fantasy'));
  for (const i of [0, 2]) {
    const c = commands[i].join(' ');
    assert.ok(/--population 300 --generations 100|--generations 100/.test(c) && c.includes('--cpu-only') && c.includes('--threads 4') && !c.includes('--hours'));
  }
});

test('checkCurated: loaded must equal file count and be > 0', () => {
  const log = (n) => `evolve: shared setup done -- 5 mons built, sampling pool of 3 species, ${n} curated opponent teams, opponent`;
  assert.equal(checkCurated(log(7), { teams: new Array(7) }).ok, true);
  assert.equal(checkCurated(log(6), { teams: new Array(7) }).ok, false);
  assert.equal(checkCurated(log(0), { teams: [] }).ok, false);
  assert.equal(checkCurated('', { teams: new Array(7) }).ok, false);
});

function harness({ metaOk = true, stdLoaded = 2 } = {}) {
  const out = mkdtempSync(path.join(tmpdir(), 'chain-'));
  const files = new Set();
  const calls = [];
  const done = (r) => { mkdirSync(path.join(out, `evolve-${r}`), { recursive: true }); writeFileSync(path.join(out, `evolve-${r}`, 'evolve-DONE'), ''); };
  const deps = {
    out,
    exists: (p) => files.has(p),
    readJson: () => ({ teams: [1, 2] }),
    readLog: () => `shared setup done -- 1 mons, ${stdLoaded} curated opponent teams`,
    live: () => false,
    launch: (stage) => { calls.push(`launch${stage}`); return 1; },
    wait: async (run, stage) => { if (stage === 1 && !metaOk) return; done(run); },
    buildCurated: () => { calls.push('build'); files.add('data/meta-teams-community-fantasy.json'); return { status: 0 }; },
  };
  return { out, deps, calls, done };
}

test('runChain: stages in order, state transitions, done', async () => {
  const h = harness();
  assert.equal(await runChain(opts(), h.deps), true);
  assert.deepEqual(h.calls, ['launch1', 'build', 'launch3']);
  const st = JSON.parse(readFileSync(path.join(h.out, 'chain-x.json'), 'utf8'));
  assert.equal(st.status, 'done'); assert.equal(st.stage, 3);
  assert.deepEqual(Object.keys(st.stageTimes), ['1', '2', '3']);
  rmSync(h.out, { recursive: true });
});

test('runChain: killed meta stage -> failed at stage 1, nothing after; --continue skips finished stages', async () => {
  const h = harness({ metaOk: false });
  assert.equal(await runChain(opts(), h.deps), false);
  let st = JSON.parse(readFileSync(path.join(h.out, 'chain-x.json'), 'utf8'));
  assert.equal(st.status, 'failed'); assert.equal(st.stage, 1);
  assert.deepEqual(h.calls, ['launch1']);
  h.done('x-meta'); // run resumed and finished
  h.deps.live = (r) => false;
  assert.equal(await runChain(opts(['--continue']), h.deps), true);
  assert.deepEqual(h.calls, ['launch1', 'build', 'launch3']);
  rmSync(h.out, { recursive: true });
});

test('runChain: curated count mismatch fails the chain', async () => {
  const h = harness({ stdLoaded: 1 });
  assert.equal(await runChain(opts(), h.deps), false);
  assert.match(JSON.parse(readFileSync(path.join(h.out, 'chain-x.json'), 'utf8')).failure, /mismatch/);
  rmSync(h.out, { recursive: true });
});

test('run_chain argv', () => {
  assert.deepEqual(chainArgv({ name: 'n', cup: 'fantasy', csv: 'a.csv', dry_run: true, cpuOnly: true }),
    ['--name', 'n', '--cup', 'fantasy', 'a.csv', '--threads', '8', '--cpu-only', '--dry-run']);
});
