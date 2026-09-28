// Round-10 held-out store (plans/PLAN.md round 10, requirement 1): every distinct finalist team is scored
// once, per opponent, against the held-out set composed exactly as compare-search.mjs does it (seed
// "heldout", both directions, unweighted, each team at its own lead). The store keeps one win rate per
// (team, opponent), so a cell's quality at any held-out size N is the mean over its top-5 teams of their
// mean over opponents 0..N-1. composeFreshOpponents(count=N) is a prefix of count=M>N (checked on load),
// so opponents 0..59 are the old 60-opponent set and the old numbers are reproducible from this store.
//
//   node scripts/heldout-store-r10.mjs --n 300 [--arms o50]      score every known cell's teams to N
//
// The store lives in out/sizing-cells-r10/heldout-store.json and is written after every batch, so a stop
// loses at most one batch.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const R10_DIR = path.join(ROOT, 'out', 'sizing-cells-r10');
export const STORE = path.join(R10_DIR, 'heldout-store.json');
export const CSV = path.join(R10_DIR, 'meta-collection-1500.csv');
const SOURCE_CSV = path.join(ROOT, 'out', 'sizing-cells-r9', 'meta-collection-1500.csv');
const TEAMS_PER_BATCH = 12;

/** Load the store (or an empty one). Shape: {seed, opponentIds[], teams: {signature: (number|null)[]}}. */
export function loadStore() {
  if (!existsSync(STORE)) return { seed: 'heldout', opponentIds: [], teams: {} };
  return JSON.parse(readFileSync(STORE, 'utf8'));
}

function saveStore(store) {
  mkdirSync(R10_DIR, { recursive: true });
  const tmp = STORE + '.tmp';
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, STORE);
}

/**
 * Held-out quality of one team list at size n from the store: mean over teams of the team's mean win
 * rate over opponents 0..n-1. Returns null if any team lacks n scores.
 * @param {object} store
 * @param {string[]} signatures top-k finalist signatures
 * @param {number} n
 * @returns {{meanTop:number, perTeam:number[]}|null}
 */
export function qualityAt(store, signatures, n) {
  const perTeam = [];
  for (const sig of signatures) {
    const row = store.teams[sig];
    if (!row || row.length < n) return null;
    let s = 0, k = 0;
    for (let i = 0; i < n; i++) if (row[i] != null) { s += row[i]; k++; }
    perTeam.push(s / k);
  }
  return { meanTop: perTeam.reduce((a, b) => a + b, 0) / perTeam.length, perTeam };
}

function teamFromSignature(sig) {
  const [lead, rest] = sig.split('||');
  return [lead, ...rest.split('|')];
}

let scorer = null;
async function getScorer(n) {
  if (scorer && scorer.heldout.length >= n) return scorer;
  if (scorer) await scorer.executor.close();
  if (!existsSync(CSV)) { mkdirSync(R10_DIR, { recursive: true }); copyFileSync(SOURCE_CSV, CSV); }
  const { parseEvolveArgs } = await import('../src/evolve/cli.js');
  const { buildEvolveSetup } = await import('../src/evolve/setup.js');
  const { composeFreshOpponents } = await import('../src/evolve/finalPass.js');
  const { createExecutor } = await import('../src/engine/parallel.js');
  const { BASE_FLAGS } = await import('./compare-search.mjs');
  const { csvPath, opts } = parseEvolveArgs([CSV, ...BASE_FLAGS, '--out-dir', path.join(R10_DIR, '_heldout')]);
  const setup = await buildEvolveSetup(csvPath, { ...opts, onLog: () => {} });
  const heldout = composeFreshOpponents(setup.ctx, {
    count: n, seed: 'heldout', movesetPool: setup.movesetPool, weights: setup.weights,
    roleScores: setup.opponentLeadRoleScores, usedIds: [],
  });
  if (heldout.length < n) throw new Error(`held-out composer produced only ${heldout.length} of ${n} opponents`);
  const executor = createExecutor({ threads: 8, vendorRoot: setup.ctx.vendorRoot, continueOnError: true, cp: setup.ctx.cp, cup: setup.ctx.cup });
  scorer = { setup, heldout, executor };
  return scorer;
}

/** Close the worker pool (call once at the end of a process that scored anything). */
export async function closeScorer() {
  if (scorer) await scorer.executor.close();
  scorer = null;
}

/**
 * Make sure every signature has at least n per-opponent scores, scoring only what is missing.
 * @param {string[]} signatures
 * @param {number} n
 * @param {(msg:string)=>void} [log]
 * @returns {Promise<object>} the updated store
 */
export async function ensureScores(signatures, n, log = console.log) {
  const store = loadStore();
  const todo = [...new Set(signatures)].filter((s) => (store.teams[s]?.length ?? 0) < n);
  if (todo.length === 0) return store;
  const { setup, heldout, executor } = await getScorer(n);
  const ids = heldout.slice(0, n).map((t) => t.id);
  store.opponentIds.forEach((id, i) => { if (i < n && id !== ids[i]) throw new Error(`held-out opponent ${i} changed: ${id} vs ${ids[i]}`); });
  if (store.opponentIds.length < n) store.opponentIds = ids;
  const { evaluateTeamsInOrder } = await import('../src/evolve/evaluate.js');
  const { ownLeadPairing } = await import('../src/evolve/fitness.js');
  // Group by how many scores each team already has so a batch scores one opponent slice.
  const groups = new Map();
  for (const s of todo) { const have = store.teams[s]?.length ?? 0; if (!groups.has(have)) groups.set(have, []); groups.get(have).push(s); }
  let done = 0;
  const t0 = Date.now();
  for (const [have, sigs] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const opponents = heldout.slice(have, n);
    for (let i = 0; i < sigs.length; i += TEAMS_PER_BATCH) {
      const batch = sigs.slice(i, i + TEAMS_PER_BATCH);
      const run = await evaluateTeamsInOrder(setup.ctx, {
        teams: batch.map(teamFromSignature), matrix: setup.deduped, opponents, pairingsFor: ownLeadPairing,
        difficulty: setup.difficulty, executor, roleScores: setup.roleScores, cache: setup.battleCache,
        trackLeads: true,
      });
      run.results.forEach((r, j) => {
        // perMeta is pushed in opponents[] order (ownLeadPairing always yields
        // battles>0, so no opponent is skipped) -- p.oppIndex is wiped to
        // undefined by evaluate.js before entry.perMeta is attached, so the
        // array position IS the opponent index, not the field.
        if (r.perMeta.length !== opponents.length) throw new Error(`perMeta length ${r.perMeta.length} != opponents ${opponents.length}`);
        const row = r.perMeta.map((m) => m.winRate);
        store.teams[batch[j]] = [...(store.teams[batch[j]] ?? []).slice(0, have), ...row];
      });
      saveStore(store);
      done += batch.length;
      const el = (Date.now() - t0) / 1000;
      log(`held-out store: ${done}/${todo.length} teams to n=${n} (${el.toFixed(0)} s, ~${(el / done * (todo.length - done)).toFixed(0)} s left)`);
    }
  }
  return store;
}

async function main() {
  const argv = process.argv.slice(2);
  const nI = argv.indexOf('--n');
  const n = Number(nI >= 0 ? argv[nI + 1] : 300);
  const aI = argv.indexOf('--arms');
  const arms = aI >= 0 ? new Set(argv[aI + 1].split(',')) : null;
  const { loadAllCellsAsync } = await import('./sizing-lib-r10.mjs');
  const cells = (await loadAllCellsAsync()).filter((c) => !arms || arms.has(c.arm));
  const sigs = cells.flatMap((c) => c.finalists.slice(0, 5));
  await ensureScores(sigs, n);
  await closeScorer();
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
