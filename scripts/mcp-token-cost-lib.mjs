// Pure helpers for scripts/mcp-token-cost.mjs: price table, Fable-Equivalent (FE) conversion,
// role detection, session parsing, cycle grouping. No network, no tokenizer.

import { readFileSync } from 'node:fs';

/**
 * USD per million tokens, per class. Source: https://platform.claude.com/docs/en/about-claude/pricing
 * fetched 2026-10-07 (standard API rates, global routing). Sessions here use the 1-hour cache.
 * `write5m` is kept for sessions that report 5-minute writes.
 * Claude Sonnet 5 is priced as Sonnet 5.5 (the page lists the same $2/$10, 0.1x cache read).
 */
export const PRICES = {
  'claude-fable-5-1': { input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50 },
  'claude-opus-5-5': { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 },
  'claude-opus-5': { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 },
  'claude-sonnet-5-5': { input: 2, write5m: 2.5, write1h: 4, read: 0.2, output: 10 },
  'claude-sonnet-5': { input: 2, write5m: 2.5, write1h: 4, read: 0.2, output: 10 },
};
export const PRICES_DATE = '2026-10-07';
export const FE_BASE = 'claude-fable-5-1';
export const CLASSES = ['input', 'write5m', 'write1h', 'read', 'output'];

/** @param {string} model @returns {object} price row; throws a 1-line error for unknown models. */
export function priceFor(model) {
  const p = PRICES[model];
  if (!p) throw new Error(`unknown model id "${model}": add it to PRICES in scripts/mcp-token-cost-lib.mjs`);
  return p;
}

/**
 * Convert per-class token counts of `model` to Fable-Equivalent tokens and dollars.
 * FE tokens = tokens x (price of model / price of claude-fable-5-1), per class.
 * @param {string} model
 * @param {Partial<Record<'input'|'write5m'|'write1h'|'read'|'output', number>>} tokens
 * @returns {{fe: number, usd: number, raw: number}}
 */
export function convert(model, tokens) {
  const p = priceFor(model);
  const base = PRICES[FE_BASE];
  let fe = 0; let usd = 0; let raw = 0;
  for (const c of CLASSES) {
    const n = tokens[c] ?? 0;
    raw += n;
    fe += n * (p[c] / base[c]);
    usd += (n * p[c]) / 1e6;
  }
  return { fe, usd, raw };
}

/**
 * Role from the session's `agent-setting` record: planner / worker / evaluator; anything else
 * (no record, other agent) is interactive, which the cycle analysis counts as a worker run.
 * @param {object[]} records parsed jsonl records
 * @returns {'planner'|'worker'|'evaluator'|'interactive'}
 */
export function detectRole(records) {
  for (const r of records) {
    if (r.type === 'agent-setting') {
      return ['planner', 'worker', 'evaluator'].includes(r.agentSetting) ? r.agentSetting : 'interactive';
    }
  }
  return 'interactive';
}

const SIM_OPS = /sim\.sh|evolve\.mjs|out\/evolve-|render-report|\bkill\b/;
/** @param {string} cmd Bash command text. @returns {boolean} true when it is a sim-ops command. */
export const isSimOp = (cmd) => SIM_OPS.test(cmd ?? '');

/**
 * Summarise one session from its parsed records. Assistant records repeat per content block, so
 * usage is taken once per message id (the largest output_tokens seen).
 * @param {object[]} records
 * @returns {object} role, models, per-class tokens, FE tokens, usd, call counts, turns
 */
export function summarizeSession(records) {
  const msgs = new Map();
  let bash = 0; let mcp = 0; let simOps = 0; let start = null;
  const seenTool = new Set();
  for (const r of records) {
    if (r.type !== 'assistant' || !r.message?.usage) continue;
    start ??= r.timestamp;
    const m = r.message;
    const prev = msgs.get(m.id);
    if (!prev || m.usage.output_tokens >= prev.usage.output_tokens) msgs.set(m.id, m);
    for (const c of m.content ?? []) {
      if (c.type !== 'tool_use' || seenTool.has(c.id)) continue;
      seenTool.add(c.id);
      if (c.name === 'Bash') { bash++; if (isSimOp(c.input?.command)) simOps++; }
      if (c.name.startsWith('mcp__pogo-sim__')) mcp++;
    }
  }
  const byModel = {};
  for (const m of msgs.values()) {
    const u = m.usage;
    const cc = u.cache_creation ?? {};
    const w1 = cc.ephemeral_1h_input_tokens ?? 0;
    const w5 = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1);
    const t = (byModel[m.model] ??= { input: 0, write5m: 0, write1h: 0, read: 0, output: 0, turns: 0 });
    t.input += u.input_tokens ?? 0;
    t.write5m += w5;
    t.write1h += w1;
    t.read += u.cache_read_input_tokens ?? 0;
    t.output += u.output_tokens ?? 0;
    t.turns++;
  }
  const tokens = { input: 0, write5m: 0, write1h: 0, read: 0, output: 0 };
  let fe = 0; let usd = 0;
  for (const [model, t] of Object.entries(byModel)) {
    const c = convert(model, t);
    fe += c.fe; usd += c.usd;
    for (const k of CLASSES) tokens[k] += t[k];
  }
  return {
    role: detectRole(records), start, models: Object.keys(byModel), byModel, tokens,
    fe, usd, turns: msgs.size, bash, mcp, simOps, empty: msgs.size === 0,
  };
}

/** @param {string} file jsonl path. @returns {object[]} parsed records (bad lines skipped). */
export function readJsonl(file) {
  const out = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* partial last line of a live session */ }
  }
  return out;
}

/**
 * Group sessions into plan -> worker -> eval cycles. Interactive sessions count as worker runs.
 * A cycle starts at a planner session and ends at the next evaluator session. Sessions before the
 * first planner, a planner that follows an unfinished cycle, and sessions after the last
 * evaluator form partial cycles (`complete: false`). Empty sessions (no assistant turns) are skipped.
 * @param {{role: string, start: string|null, empty?: boolean}[]} sessions
 * @returns {{complete: boolean, sessions: object[]}[]}
 */
export function groupCycles(sessions) {
  const ordered = sessions.filter((s) => !s.empty)
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const cycles = [];
  let cur = [];
  const close = (complete) => { if (cur.length) cycles.push({ complete, sessions: cur }); cur = []; };
  for (const s of ordered) {
    if (s.role === 'planner') {
      if (cur.length) close(false);
      cur.push(s);
    } else if (s.role === 'evaluator') {
      cur.push(s);
      close(cur[0].role === 'planner');
    } else {
      cur.push(s);
    }
  }
  close(false);
  return cycles;
}

/** @param {number[]} xs @returns {number} arithmetic mean, 0 for empty. */
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
