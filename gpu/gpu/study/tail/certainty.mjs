// Round 9 study (POGO_GPU_STUDY=tail,certain): JS port of gpu/gpu/study/early/certainty.py's exact certainty test for the halving
// cut (Round.bounds_ref + Round.certain), so the executor can run it while a launch is still going. Checked equal to the Python
// on the three captures by check_certainty.mjs. Not imported by src/ except lazily by the GPU executor under that study flag.
//
// A team is "certain" at a moment when fewer than S = ceil(nT * keep) other teams can still reach its worst-case fitness over
// every outcome of the battles not yet finished: it survives the cut whatever those battles do, so its next-round battles can
// start now without changing anything.

const EPS = 1e-9;

/**
 * Static part of one halving round (one evaluateTeamsInOrder call). `plan` rows: [team, opp, fwdFresh, revFresh, fwdWp, fwdEx,
 * revWp, revEx] (fresh = index of the step's spec, -1 = memo hit with its wp/ex given; wp = candidate win points 1/0.5/0, ex = lead
 * exchange +1 won / -1 lost / 0 none, both read as "candidate is team A").
 * @param {{plan: number[][], nTeams: number, nOpp: number, weights: {consistency:number, snowball:number, closer:number, sharedWeakness:number},
 *   oppWeights: number[]|null, oppGroups: (number|null)[]|null, gamma: number, closer: (number|null)[], shared: (number|null)[]}} ev
 */
export function prepareRound(ev) {
  if (ev.gamma !== 1) throw new Error('certainty: bounds are written for opponent-strength-gamma 1');
  const m = ev.plan.length;
  const col = (c, T) => T.from(ev.plan, (r) => r[c]);
  const groups = new Map();
  (ev.oppGroups ?? []).forEach((g, k) => { if (g !== null && g !== undefined) { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(k); } });
  return {
    m, nT: ev.nTeams, nO: ev.nOpp, team: col(0, Int32Array), opp: col(1, Int32Array), fi: col(2, Int32Array), vi: col(3, Int32Array),
    fwp: col(4, Float64Array), fex: col(5, Float64Array), vwp: col(6, Float64Array), vex: col(7, Float64Array),
    ow: Float64Array.from({ length: ev.nOpp }, (_, k) => (ev.oppWeights ? ev.oppWeights[k] : 1)),
    groups: [...groups.values()], w: ev.weights, closer: ev.closer, shared: ev.shared,
  };
}

/** min over s in [lo,hi]^K of sum(a s) / sum(b s), b >= 0: the sorted-prefix rule (certainty.py lf_min). */
export function lfMin(a, b, lo, hi) {
  const K = a.length;
  const ord = Array.from({ length: K }, (_, i) => i);
  const key = ord.map((i) => a[i] / b[i]);
  ord.sort((x, y) => (key[x] < key[y] ? -1 : key[x] > key[y] ? 1 : x - y)); // numpy argsort kind="stable"
  let sumLoA = 0, sumLoB = 0;
  for (let i = 0; i < K; i++) { sumLoA += a[ord[i]] * lo[ord[i]]; sumLoB += b[ord[i]] * lo[ord[i]]; }
  // prefix j: first j at hi, the rest at lo (same accumulation order as the numpy cumsums)
  let best = Infinity, cHiA = 0, cHiB = 0, cLoA = 0, cLoB = 0;
  for (let j = 0; j <= K; j++) {
    const na = cHiA + (sumLoA - cLoA), nb = cHiB + (sumLoB - cLoB);
    if (nb > 0 && na / nb < best) best = na / nb;
    if (j < K) { const i = ord[j]; cHiA += a[i] * hi[i]; cHiB += b[i] * hi[i]; cLoA += a[i] * lo[i]; cLoB += b[i] * lo[i]; }
  }
  return Number.isFinite(best) ? best : 0;
}

export const lfMax = (a, b, lo, hi) => -lfMin(a.map((x) => -x), b, lo, hi);

function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const idx = p * (n - 1), lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Fitness bounds of every team given which fresh battles are finished (certainty.py Round.bounds_ref).
 * @param {object} R prepareRound result
 * @param {(fresh: number, row: number) => {wp: number, ex: number}|null} freshFwd result of fresh spec `fresh` (plan row `row`)
 *   read with the candidate as team A, or null while it runs; freshRev the same for the reversed seat, in the candidate's view.
 * @returns {{lo: Float64Array, hi: Float64Array}}
 */
export function bounds(R, freshFwd, freshRev) {
  const { nT, nO } = R;
  const P = new Float64Array(nT * nO), U = new Float64Array(nT * nO), B = new Float64Array(nT * nO);
  const W = new Float64Array(nT), L = new Float64Array(nT), UX = new Float64Array(nT);
  const one = (r, t, k, ix, wp, ex, read) => {
    B[t * nO + k] += 1;
    const v = ix < 0 ? { wp, ex } : read(ix, r);
    if (v) {
      P[t * nO + k] += v.wp;
      if (v.ex === 1) W[t] += 1; else if (v.ex === -1) L[t] += 1;
    } else { U[t * nO + k] += 1; UX[t] += 1; }
  };
  for (let r = 0; r < R.m; r++) {
    one(r, R.team[r], R.opp[r], R.fi[r], R.fwp[r], R.fex[r], freshFwd);
    one(r, R.team[r], R.opp[r], R.vi[r], R.vwp[r], R.vex[r], freshRev);
  }
  const sLo = new Float64Array(nO), sHi = new Float64Array(nO);
  for (let k = 0; k < nO; k++) {
    let Bk = 0, Pk = 0, Uk = 0;
    for (let t = 0; t < nT; t++) { Bk += B[t * nO + k]; Pk += P[t * nO + k]; Uk += U[t * nO + k]; }
    sLo[k] = Math.max(0, 1 - (Pk + Uk) / Bk);
    sHi[k] = Math.max(0, 1 - Pk / Bk);
  }
  const { consistency: cw, snowball: sw, closer: clw, sharedWeakness: shw } = R.w;
  const tot = 1 + cw + sw + clw + shw;
  const lo = new Float64Array(nT), hi = new Float64Array(nT);
  for (let i = 0; i < nT; i++) {
    const ks = [];
    for (let k = 0; k < nO; k++) if (B[i * nO + k] > 0) ks.push(k);
    const pick = (f) => ks.map(f);
    const aLo = pick((k) => R.ow[k] * P[i * nO + k]), aHi = pick((k) => R.ow[k] * (P[i * nO + k] + U[i * nO + k]));
    const b = pick((k) => R.ow[k] * B[i * nO + k]);
    const sl = pick((k) => sLo[k]), sh = pick((k) => sHi[k]);
    const wr = [lfMin(aLo, b, sl, sh), lfMax(aHi, b, sl, sh)];
    const glo = [], ghi = [];
    let mayDrop = false;
    for (const g of R.groups) {
      const gk = g.filter((k) => B[i * nO + k] > 0);
      if (!gk.length) continue;
      if (gk.every((k) => sHi[k] <= 0)) continue;
      if (gk.some((k) => sLo[k] <= 0)) mayDrop = true;
      const ones = gk.map(() => 1), gsl = gk.map((k) => sLo[k]), gsh = gk.map((k) => sHi[k]);
      glo.push(lfMin(gk.map((k) => P[i * nO + k] / B[i * nO + k]), ones, gsl, gsh));
      ghi.push(lfMax(gk.map((k) => (P[i * nO + k] + U[i * nO + k]) / B[i * nO + k]), ones, gsl, gsh));
    }
    let cons = glo.length >= 4 ? [percentile([...glo].sort((x, y) => x - y), 0.25), percentile([...ghi].sort((x, y) => x - y), 0.25)] : wr;
    if (mayDrop) cons = [Math.min(cons[0], wr[0], 0), Math.max(cons[1], wr[1], 1)];
    let sn;
    const D = W[i] + L[i] + UX[i];
    if (D > 0) {
      sn = [W[i] / D, (W[i] + UX[i]) / D];
      if (W[i] + L[i] === 0) sn = [Math.min(sn[0], wr[0]), Math.max(sn[1], wr[1])];
    } else sn = wr;
    const cl = R.closer[i], shv = R.shared[i];
    const [cll, clh] = cl === null || cl === undefined ? wr : [cl, cl];
    const [shl, shh] = shv === null || shv === undefined ? wr : [shv, shv];
    lo[i] = (wr[0] + cw * cons[0] + sw * sn[0] + clw * cll + shw * shl) / tot;
    hi[i] = (wr[1] + cw * cons[1] + sw * sn[1] + clw * clh + shw * shh) / tot;
  }
  return { lo, hi };
}

/**
 * Teams certain to survive a cut keeping ceil(nT * keep) (certainty.py Round.certain): fewer than S other teams can reach
 * their floor.
 * @returns {Uint8Array} 1 = certain
 */
export function certainTeams(lo, hi, keep) {
  const n = lo.length;
  const S = Math.max(1, Math.ceil(n * keep));
  const hs = Float64Array.from(hi).sort();
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const thr = lo[i] - EPS;
    let a = 0, b = n; // first index with hs >= thr
    while (a < b) { const mid = (a + b) >> 1; if (hs[mid] < thr) a = mid + 1; else b = mid; }
    let threats = n - a;
    if (hi[i] >= thr) threats -= 1;
    out[i] = threats < S ? 1 : 0;
  }
  return out;
}

/** Candidate-view (wp, ex) of a kernel row read with the candidate as team A (seat 0) or team B (seat 1, mirrored). */
export function rowView(winner, lfA, lfB, seat) {
  const [ta, tb] = seat === 0 ? [lfA < 0 ? null : lfA, lfB < 0 ? null : lfB] : [lfB < 0 ? null : lfB, lfA < 0 ? null : lfA];
  const w = seat === 0 ? winner : winner === 2 ? 2 : 1 - winner;
  const wp = w === 0 ? 1 : w === 2 ? 0.5 : 0;
  // fitness.js leadExchangeLoser: the side whose lead fainted first lost the exchange; ex +1 = candidate won it
  let ex = 0;
  if (ta === null && tb === null) ex = 0;
  else if (ta === null) ex = 1;
  else if (tb === null) ex = -1;
  else if (ta !== tb) ex = ta < tb ? -1 : 1;
  return { wp, ex };
}
