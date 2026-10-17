"""Fork "early": exact certainty test for the halving cut, applied to captured runs (hook.mjs / capture.sh).

    python -m gpu.study.early.certainty <capture dir> [--out <json>]

For each halving round r < R-1 of each generation it replays the round's GPU launch in time order (per-battle end stamps,
output cols 20..23) and, at each instant t, bounds every team's fitness over ALL possible outcomes of the battles not yet
finished. A team is "certain" at t when fewer than S = ceil(n * keep) other teams can still reach its worst case:
then it advances whatever the unfinished battles do, so its next-round battles could start at t without changing the cut.

Bounds (all sound, i.e. never tighter than the truth; see summary.md):
  opponent strength s_k = 1 - (candidate win points vs k) / (battles vs k)   (gamma = 1, the standard command)
    in [1 - (P_k + U_k)/B_k, 1 - P_k/B_k]: unfinished battles vs k all won / all lost by the candidates;
  winRate_i = sum_k w_k s_k P_ik / sum_k w_k s_k B_ik: lowest with P_ik at its floor and the s box at its worst vertex
    (exact linear-fractional minimum over the box, by the sorted-prefix rule), highest symmetrically;
  consistency_i = 25th percentile of per-archetype rates sum r_ik s_k / sum s_k: each group bounded the same way, the
    percentile is monotone in each group;
  snowball_i = W/(W+L) of decided lead exchanges: [W/(W+L+U), (W+U)/(W+L+U)] (plus the winRate fallback if W+L = 0);
  closer, shared weakness: roster-only constants.
Each term's box is taken independently for each team (a team's own unfinished battles also move s_k), which only widens it.
"""
import json
import math
import os
import sys

import numpy as np

EPS = 1e-9


def load_capture(d):
    cap = os.path.join(d, "cap")
    evals = [json.load(open(os.path.join(cap, f))) for f in sorted(os.listdir(cap)) if f.startswith("eval-")]
    launches = []
    for f in sorted(os.listdir(cap)):
        if f.startswith("launch-") and f.endswith(".json"):
            meta = json.load(open(os.path.join(cap, f)))
            out = np.fromfile(os.path.join(cap, f[:-5] + ".bin"), "<i4").reshape(meta["n"], meta["cols"])
            launches.append(out)
    return evals, launches


def stamps(out):
    o = out.astype(np.int64) & 0xFFFFFFFF
    s, e = o[:, 20] | (o[:, 21] << 32), o[:, 22] | (o[:, 23] << 32)
    t0 = s.min()
    return (s - t0) / 1e9, (e - t0) / 1e9


def lf_min(a, b, lo, hi):
    """min over s in [lo,hi]^K of sum(a s) / sum(b s) (b > 0). Optimal s: hi where a/b is below the optimum, lo above."""
    order = np.argsort(a / b, kind="stable")
    a, b, lo, hi = a[order], b[order], lo[order], hi[order]
    # prefix j: first j at hi, rest at lo
    na = np.concatenate([[0], np.cumsum(a * hi)]) + (np.sum(a * lo) - np.concatenate([[0], np.cumsum(a * lo)]))
    nb = np.concatenate([[0], np.cumsum(b * hi)]) + (np.sum(b * lo) - np.concatenate([[0], np.cumsum(b * lo)]))
    ok = nb > 0
    return float(np.min(na[ok] / nb[ok])) if ok.any() else 0.0


def lf_max(a, b, lo, hi):
    return -lf_min(-a, b, lo, hi)


def lf_min_rows(a, b, lo, hi):
    """Row-wise lf_min for [M, K] arrays; padding entries have a = b = 0 (they add nothing)."""
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.where(b > 0, a / np.where(b > 0, b, 1), np.inf)
    o = np.argsort(r, axis=1, kind="stable")
    tk = lambda x: np.take_along_axis(x, o, 1)
    a, b, lo, hi = tk(a), tk(b), tk(lo), tk(hi)
    z = np.zeros((a.shape[0], 1))
    ca_hi = np.concatenate([z, np.cumsum(a * hi, 1)], 1); ca_lo = np.concatenate([z, np.cumsum(a * lo, 1)], 1)
    cb_hi = np.concatenate([z, np.cumsum(b * hi, 1)], 1); cb_lo = np.concatenate([z, np.cumsum(b * lo, 1)], 1)
    na = ca_hi + (ca_lo[:, -1:] - ca_lo)
    nb = cb_hi + (cb_lo[:, -1:] - cb_lo)
    with np.errstate(divide="ignore", invalid="ignore"):
        q = np.where(nb > 0, na / np.where(nb > 0, nb, 1), np.inf)
    m = q.min(1)
    return np.where(np.isfinite(m), m, 0.0)


def lf_max_rows(a, b, lo, hi):
    return -lf_min_rows(-a, b, lo, hi)


def percentile_rows(v, p):
    """Row-wise percentile (linear) of [M, G] sorted along axis 1."""
    n = v.shape[1]
    if n == 1:
        return v[:, 0]
    idx = p * (n - 1)
    lo, hi = math.floor(idx), math.ceil(idx)
    return v[:, lo] + (v[:, hi] - v[:, lo]) * (idx - lo)


def percentile(sorted_vals, p):
    n = len(sorted_vals)
    if n == 1:
        return sorted_vals[0]
    idx = p * (n - 1)
    lo, hi = math.floor(idx), math.ceil(idx)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (idx - lo)


class Round:
    """One evaluateTeamsInOrder call of a halving round, with per-battle known/unknown state."""

    def __init__(self, ev, end):
        self.ev = ev
        p = np.array(ev["plan"], dtype=np.float64)
        self.team, self.opp = p[:, 0].astype(int), p[:, 1].astype(int)
        self.fi, self.vi = p[:, 2].astype(int), p[:, 3].astype(int)
        self.fwp, self.fex, self.vwp, self.vex = p[:, 4], p[:, 5], p[:, 6], p[:, 7]
        assert (self.fwp >= 0).all() and (self.vwp >= 0).all(), "battle errors in capture"
        self.nT, self.nO = ev["nTeams"], ev["nOpp"]
        self.end = end  # per fresh battle end time (s), or None for a round with no launch
        w = ev["weights"]
        self.cw, self.sw, self.clw, self.shw = w["consistency"], w["snowball"], w["closer"], w["sharedWeakness"]
        self.ow = np.array(ev["oppWeights"] if ev["oppWeights"] else [1.0] * self.nO)
        self.og = ev["oppGroups"] or [None] * self.nO
        assert ev["gamma"] == 1, "bounds written for opponent-strength-gamma 1 (candidate-strength-gamma only reweights the opponent side)"

    def known_at(self, t):
        def k(ix):
            out = np.ones(len(ix), bool)
            m = ix >= 0
            if self.end is not None:
                out[m] = self.end[ix[m]] <= t
            else:
                out[m] = True
            return out
        return k(self.fi), k(self.vi)

    def bounds(self, t):
        """Vectorized version of bounds_ref (same math; checked equal in selftest)."""
        kf, kv = self.known_at(t)
        nT, nO = self.nT, self.nO
        P = np.zeros((nT, nO)); U = np.zeros((nT, nO)); B = np.zeros((nT, nO))
        W = np.zeros(nT); L = np.zeros(nT); UX = np.zeros(nT)
        for known, wp, ex in ((kf, self.fwp, self.fex), (kv, self.vwp, self.vex)):
            np.add.at(B, (self.team, self.opp), 1)
            np.add.at(P, (self.team[known], self.opp[known]), wp[known])
            np.add.at(U, (self.team[~known], self.opp[~known]), 1)
            np.add.at(W, self.team[known], ex[known] == 1)
            np.add.at(L, self.team[known], ex[known] == -1)
            np.add.at(UX, self.team[~known], 1)
        assert (B > 0).all(), "every team fights every opponent of the slice"
        Bk = B.sum(0); Pk = P.sum(0); Uk = U.sum(0)
        s_lo = np.maximum(0, 1 - (Pk + Uk) / Bk)
        s_hi = np.maximum(0, 1 - Pk / Bk)
        SL, SH = np.broadcast_to(s_lo, (nT, nO)), np.broadcast_to(s_hi, (nT, nO))
        wr_lo = lf_min_rows(self.ow * P, self.ow * B, SL, SH)
        wr_hi = lf_max_rows(self.ow * (P + U), self.ow * B, SL, SH)
        if not hasattr(self, "_gidx"):
            groups = {}
            for k, g in enumerate(self.og):
                if g is not None:
                    groups.setdefault(g, []).append(k)
            gl = list(groups.values())
            mx = max((len(x) for x in gl), default=1)
            gi = np.full((len(gl), mx), -1)
            for j, ks in enumerate(gl):
                gi[j, :len(ks)] = ks
            self._gidx = gi
        gi = self._gidx
        G, mx = gi.shape
        valid = gi >= 0
        gk = np.where(valid, gi, 0)
        live = (s_hi[gk] > 0) & valid                      # [G, mx]
        counted = live.any(1)                              # group can be counted in some outcome
        may_drop = bool(((s_lo[gk] <= 0) & valid & counted[:, None]).any())
        rl = (P / B)[:, gk]; rh = ((P + U) / B)[:, gk]      # [nT, G, mx]
        one = np.broadcast_to(valid.astype(float), (nT, G, mx))
        slo = np.broadcast_to(np.where(valid, s_lo[gk], 0), (nT, G, mx)); shi = np.broadcast_to(np.where(valid, s_hi[gk], 0), (nT, G, mx))
        flat = lambda x: np.ascontiguousarray(x[:, counted]).reshape(-1, mx)
        nG = int(counted.sum())
        if nG >= 4:
            glo = lf_min_rows(flat(rl * one), flat(one), flat(slo), flat(shi)).reshape(nT, nG)
            ghi = lf_max_rows(flat(rh * one), flat(one), flat(slo), flat(shi)).reshape(nT, nG)
            c_lo = percentile_rows(np.sort(glo, 1), 0.25); c_hi = percentile_rows(np.sort(ghi, 1), 0.25)
        else:
            c_lo, c_hi = wr_lo, wr_hi
        if may_drop:
            c_lo = np.minimum(np.minimum(c_lo, wr_lo), 0.0); c_hi = np.maximum(np.maximum(c_hi, wr_hi), 1.0)
        D = W + L + UX
        with np.errstate(divide="ignore", invalid="ignore"):
            sn_lo = np.where(D > 0, W / np.where(D > 0, D, 1), wr_lo); sn_hi = np.where(D > 0, (W + UX) / np.where(D > 0, D, 1), wr_hi)
        z = (W + L == 0) & (D > 0)
        sn_lo = np.where(z, np.minimum(sn_lo, wr_lo), sn_lo); sn_hi = np.where(z, np.maximum(sn_hi, wr_hi), sn_hi)
        cl = np.array([np.nan if x is None else x for x in self.ev["closer"]], float)
        sh = np.array([np.nan if x is None else x for x in self.ev["shared"]], float)
        cl_lo, cl_hi = np.where(np.isnan(cl), wr_lo, cl), np.where(np.isnan(cl), wr_hi, cl)
        sh_lo, sh_hi = np.where(np.isnan(sh), wr_lo, sh), np.where(np.isnan(sh), wr_hi, sh)
        tot = 1 + self.cw + self.sw + self.clw + self.shw
        lo = (wr_lo + self.cw * c_lo + self.sw * sn_lo + self.clw * cl_lo + self.shw * sh_lo) / tot
        hi = (wr_hi + self.cw * c_hi + self.sw * sn_hi + self.clw * cl_hi + self.shw * sh_hi) / tot
        return lo, hi

    def bounds_ref(self, t):
        kf, kv = self.known_at(t)
        nT, nO = self.nT, self.nO
        P = np.zeros((nT, nO)); U = np.zeros((nT, nO)); B = np.zeros((nT, nO))
        W = np.zeros(nT); L = np.zeros(nT); UX = np.zeros(nT)
        for known, wp, ex in ((kf, self.fwp, self.fex), (kv, self.vwp, self.vex)):
            np.add.at(B, (self.team, self.opp), 1)
            np.add.at(P, (self.team[known], self.opp[known]), wp[known])
            np.add.at(U, (self.team[~known], self.opp[~known]), 1)
            np.add.at(W, self.team[known], ex[known] == 1)
            np.add.at(L, self.team[known], ex[known] == -1)
            np.add.at(UX, self.team[~known], 1)
        Bk = B.sum(0); Pk = P.sum(0); Uk = U.sum(0)
        s_lo = np.maximum(0, 1 - (Pk + Uk) / Bk)
        s_hi = np.maximum(0, 1 - Pk / Bk)
        lo = np.zeros(nT); hi = np.zeros(nT)
        groups = {}
        for k, g in enumerate(self.og):
            if g is not None:
                groups.setdefault(g, []).append(k)
        for i in range(nT):
            m = B[i] > 0
            a_lo, a_hi, b = self.ow[m] * P[i, m], self.ow[m] * (P[i, m] + U[i, m]), self.ow[m] * B[i, m]
            wr = (lf_min(a_lo, b, s_lo[m], s_hi[m]), lf_max(a_hi, b, s_lo[m], s_hi[m]))
            # consistency
            glo, ghi, may_drop = [], [], False
            for g, ks in groups.items():
                ks = [k for k in ks if B[i, k] > 0]
                if not ks:
                    continue
                ks = np.array(ks)
                if (s_hi[ks] <= 0).all():
                    continue  # every opponent of the group has strength 0 in every outcome: group never counted
                if (s_lo[ks] <= 0).any():
                    may_drop = True
                r_lo, r_hi = P[i, ks] / B[i, ks], (P[i, ks] + U[i, ks]) / B[i, ks]
                one = np.ones(len(ks))
                glo.append(lf_min(r_lo, one, s_lo[ks], s_hi[ks])); ghi.append(lf_max(r_hi, one, s_lo[ks], s_hi[ks]))
            if len(glo) >= 4:
                cons = (percentile(sorted(glo), 0.25), percentile(sorted(ghi), 0.25))
            else:
                cons = wr
            if may_drop:
                cons = (min(cons[0], wr[0], 0.0), max(cons[1], wr[1], 1.0))
            # snowball
            if W[i] + L[i] + UX[i] > 0:
                sn = (W[i] / (W[i] + L[i] + UX[i]), (W[i] + UX[i]) / (W[i] + L[i] + UX[i]))
                if W[i] + L[i] == 0:
                    sn = (min(sn[0], wr[0]), max(sn[1], wr[1]))
            else:
                sn = wr
            cl = self.ev["closer"][i]
            sh = self.ev["shared"][i]
            tot = 1 + self.cw + self.sw + self.clw + self.shw
            shl, shh = (sh, sh) if sh is not None else wr
            cll, clh = (cl, cl) if cl is not None else wr
            lo[i] = (wr[0] + self.cw * cons[0] + self.sw * sn[0] + self.clw * cll + self.shw * shl) / tot
            hi[i] = (wr[1] + self.cw * cons[1] + self.sw * sn[1] + self.clw * clh + self.shw * shh) / tot
        return lo, hi

    def certain(self, lo, hi, keep):
        S = max(1, math.ceil(self.nT * keep))
        # j can finish at or above i's floor -> a threat. i certain if threats among others < S.
        hs = np.sort(hi)
        threats = len(hi) - np.searchsorted(hs, lo - EPS, side="left")  # count hi_j >= lo_i - eps (includes i itself)
        threats -= (hi >= lo - EPS)  # remove i itself
        return threats < S, S


def analyse(d, steps=60):
    evals, launches = load_capture(d)
    gens, cur = [], None
    for ev in evals:
        if ev["round"] is None:
            continue
        if ev["round"]["r"] == 0:
            cur = []
            gens.append(cur)
        cur.append(ev)
    rows = []
    for g, rounds in enumerate(gens):
        R = rounds[0]["round"]["rounds"]
        keep = rounds[0]["round"]["keep"]
        for r in range(R - 1):
            if r + 1 >= len(rounds) or rounds[r + 1]["launch1"] > len(launches):
                break  # capture cut short (timeout): incomplete generation
            ev, nx = rounds[r], rounds[r + 1]
            li = list(range(ev["launch0"], ev["launch1"]))
            assert len(li) <= 1, f"gen {g} round {r}: {len(li)} launches"
            end = stamps(launches[li[0]])[1] if li else None
            start = stamps(launches[li[0]])[0] if li else None
            assert end is None or len(end) == ev["nFresh"], (len(end), ev["nFresh"])
            rd = Round(ev, end)
            # check: full knowledge reproduces the recorded fitness and the real cut
            lo, hi = rd.bounds(math.inf)
            err = float(np.max(np.abs(lo - np.array(ev["blend"])))), float(np.max(np.abs(hi - np.array(ev["blend"]))))
            alive = ev["round"]["alive"]
            nxt_alive = set(nx["round"]["alive"])
            cert_full, S = rd.certain(lo, hi, keep)
            true_adv = np.array([alive[i] in nxt_alive for i in range(rd.nT)])
            # next round's fresh battles per team (global idx)
            nxp = np.array(nx["plan"])
            nx_alive = nx["round"]["alive"]
            nx_li = list(range(nx["launch0"], nx["launch1"]))
            nx_end = stamps(launches[nx_li[0]])[1] if nx_li else None
            span = float(end.max()) if end is not None else 0.0
            nx_span = float(nx_end.max()) if nx_end is not None else 0.0
            # battle -> owning next-round teams (global); a battle is releasable once any owner is certain
            owners = {}
            for row in nxp:
                tg = nx_alive[int(row[0])]
                for ix in (int(row[2]), int(row[3])):
                    if ix >= 0:
                        owners.setdefault(ix, set()).add(tg)
            times = sorted(set([0.0] + list(np.quantile(end, np.linspace(0, 1, steps + 1))))) if end is not None else [0.0]
            curve = []
            for t in times:
                lo_t, hi_t = rd.bounds(t)
                c, _ = rd.certain(lo_t, hi_t, keep)
                assert not (c & ~true_adv).any(), "certainty test admitted a team that was cut"
                cg = {alive[i] for i in np.nonzero(c)[0]}
                rel = [ix for ix, own in owners.items() if own & cg]
                curve.append({"t": round(float(t), 4), "done": int((end <= t).sum()) if end is not None else 0,
                              "certain": int(c.sum()), "released": len(rel),
                              "released_work_s": round(float(sum(nx_end[ix] for ix in rel)) if nx_end is not None else 0.0, 3)})
            rows.append({"gen": g, "round": r, "teams": rd.nT, "survivors": S, "fresh": ev["nFresh"], "span_s": round(span, 3),
                         "p50_end_s": round(float(np.median(end)), 3) if end is not None else 0,
                         "p90_end_s": round(float(np.quantile(end, 0.9)), 3) if end is not None else 0,
                         "next_fresh": nx["nFresh"], "next_span_s": round(nx_span, 3),
                         "check_fitness_maxerr": err, "check_cut_equal": bool((cert_full == true_adv).all()),
                         "curve": curve,
                         "end_s": [round(float(x), 4) for x in end] if end is not None else [],
                         "start_s": [round(float(x), 4) for x in start] if start is not None else [],
                         "owners": {str(k): sorted(v) for k, v in owners.items()},
                         "next_end_s": [round(float(x), 4) for x in nx_end] if nx_end is not None else [],
                         "next_start_s": [round(float(x), 4) for x in stamps(launches[nx_li[0]])[0]] if nx_li else [],
                         "alive": alive})
    return rows


def selftest(d):
    """bounds (vectorized) == bounds_ref (per-team loop) on every round of a capture, at 5 instants each."""
    evals, launches = load_capture(d)
    worst = 0.0
    for ev in evals:
        if ev["round"] is None or ev["launch1"] == ev["launch0"]:
            continue
        end = stamps(launches[ev["launch0"]])[1]
        rd = Round(ev, end)
        for t in np.quantile(end, [0.5, 0.9, 0.97, 0.995, 1.0]):
            a, b = rd.bounds(t), rd.bounds_ref(t)
            worst = max(worst, float(np.abs(a[0] - b[0]).max()), float(np.abs(a[1] - b[1]).max()))
    print(f"selftest: max |vectorized - reference| = {worst:.2e}")
    return worst


def main():
    d = sys.argv[1]
    if "--selftest" in sys.argv:
        return selftest(d)
    out = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else os.path.join(d, "certainty.json")
    rows = analyse(d)
    json.dump(rows, open(out, "w"))
    for r in rows:
        c = r["curve"]
        pick = [x for x in c if x["done"] >= 0.5 * r["fresh"]][:1] + [x for x in c if x["done"] >= 0.9 * r["fresh"]][:1] + c[-2:-1]
        print(f"gen {r['gen']} round {r['round']}: {r['teams']} teams keep {r['survivors']}, {r['fresh']} battles span {r['span_s']}s "
              f"(p50 end {r['p50_end_s']}, p90 {r['p90_end_s']}); next {r['next_fresh']} battles {r['next_span_s']}s; "
              f"check err {r['check_fitness_maxerr'][0]:.1e}/{r['check_fitness_maxerr'][1]:.1e} cut-equal {r['check_cut_equal']}")
        for x in pick:
            print(f"   t={x['t']:.3f}s done {x['done']}: certain {x['certain']}/{r['survivors']}, next-round battles releasable {x['released']}/{r['next_fresh']}")


if __name__ == "__main__":
    main()
