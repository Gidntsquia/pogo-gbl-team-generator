import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICES, convert, priceFor, detectRole, groupCycles, summarizeSession, isSimOp,
} from '../scripts/mcp-token-cost-lib.mjs';

test('FE conversion scales each token class by price ratio to fable-5-1', () => {
  const t = { input: 1000, write1h: 1000, read: 1000, output: 1000 };
  const fable = convert('claude-fable-5-1', t);
  assert.equal(fable.fe, 4000);
  // sonnet-5-5: input 2/10, write 4/20, read 0.2/0.25, output 10/50
  const s = convert('claude-sonnet-5-5', t);
  assert.ok(Math.abs(s.fe - (200 + 200 + 800 + 200)) < 1e-9);
  assert.ok(Math.abs(s.usd - (2 + 4 + 0.2 + 10) / 1000) < 1e-12);
});

test('unknown model fails with a one-line error naming it', () => {
  assert.throws(() => priceFor('claude-nope-9'), (e) => e.message.includes('claude-nope-9') && !e.message.includes('\n'));
  assert.throws(() => convert('claude-nope-9', { input: 1 }), /claude-nope-9/);
  assert.ok(Object.keys(PRICES).includes('claude-opus-5-5'));
});

test('role detection from agent-setting; default interactive', () => {
  assert.equal(detectRole([{ type: 'agent-setting', agentSetting: 'evaluator' }]), 'evaluator');
  assert.equal(detectRole([{ type: 'user' }]), 'interactive');
  assert.equal(detectRole([{ type: 'agent-setting', agentSetting: 'other' }]), 'interactive');
  assert.ok(isSimOp('bash scripts/sim.sh x') && !isSimOp('ls plans'));
});

test('summarizeSession dedupes per message id and counts calls', () => {
  const mk = (id, out, content) => ({
    type: 'assistant', timestamp: '2026-10-01T00:00:00Z',
    message: { id, model: 'claude-sonnet-5-5', content, usage: { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: out, cache_creation: { ephemeral_1h_input_tokens: 10 } } },
  });
  const s = summarizeSession([
    { type: 'agent-setting', agentSetting: 'worker' },
    mk('a', 5, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'kill 5' } }]),
    mk('a', 5, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'kill 5' } }]),
    mk('b', 7, [{ type: 'tool_use', id: 't2', name: 'mcp__pogo-sim__status_sim', input: {} }]),
  ]);
  assert.deepEqual([s.turns, s.bash, s.mcp, s.simOps, s.tokens.output, s.role], [2, 1, 1, 1, 12, 'worker']);
});

test('cycle grouping: interactive counts as worker, partials labelled, empties skipped', () => {
  const S = (role, n, empty = false) => ({ role, start: `2026-10-0${n}`, empty });
  const cycles = groupCycles([
    S('worker', 1), S('evaluator', 2), // leading partial
    S('planner', 3), S('interactive', 4), S('worker', 5), S('interactive', 6, true), S('evaluator', 7), // full
    S('planner', 8), S('worker', 9), // trailing partial
  ]);
  assert.deepEqual(cycles.map((c) => [c.complete, c.sessions.length]), [[false, 2], [true, 4], [false, 2]]);
});

test('usage mapping: commands -> pogo-sim tool names', async () => {
  const { mapBashToTool, isRawStatusOpener } = await import('../scripts/mcp-token-cost-lib.mjs');
  const cases = [
    ['scripts/sim.sh status', 'status_sim'], ['tail -30 out/evolve-x.log', 'tail_log'], ['ps -o pid,rss -p 5', 'status_sim'],
    ['ls out/evolve-x/evolve-gen[0-9]*.json', 'status_sim'], ['scripts/sim.sh a.csv --name n', 'run_standard'],
    ['scripts/sim.sh --meta --name n', 'run_meta'], ['node scripts/evolve.mjs a.csv --seed 1', 'run_raw'],
    ['kill 123', 'stop_sim'], ['node scripts/evolve.mjs a.csv --resume', 'resume_sim'], ['ls out/', 'list_runs'],
    ['ls *.csv', 'list_collections'], ['node scripts/render-report.mjs out/evolve-x', 'render_report'],
    ['node scripts/symmetry-gap.mjs report --label a', 'symmetry_gap'], ['node scripts/evolve.mjs a.csv --check', 'check_sim'],
    ['journalctl -u earlyoom', 'check_oom'], ['mcp__pogo-sim__status_sim', 'status_sim'], ['git status', null],
  ];
  for (const [cmd, tool] of cases) assert.equal(mapBashToTool(cmd), tool, cmd);
  assert.ok(isRawStatusOpener('Report on sim status') && isRawStatusOpener('Check the status of the new meta vs meta sim')
    && isRawStatusOpener('Check logs/status, and give me a brief look') && !isRawStatusOpener('Fix the status page'));
});
