"""Build the study "split" kernel copy (gpu/gpu/study/split/kernels/) from the production .cuh files by text patches.

    python3 gpu/gpu/study/split/make_kernel.py

Patches battle3v3.cuh only (pvp1v1.cuh and battle1v1.cuh are copied unchanged):
  - B3 gets the group fields sG/sL/sM (threads per battle, this thread's index in the group, the group's lane mask);
  - runScenario: under #define SPLIT, a group of G > 1 threads splits the shield-combination sims of one call (see the comment
    in the patched code); under #define SPLIT_PROF, per-battle counters (cycles inside runScenario, ideal split time at
    G = 2/4/8, calls by number of combinations, per decision type) are written to g_prof by the slice kernel;
  - battle_init_teams takes the group fields; the ring-requeue slice path passes G, its thread index and mask.
Without SPLIT / SPLIT_PROF the patched source computes exactly what production does.
"""
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "..", "..", "kernels"))
DST = os.path.join(HERE, "kernels")


def rep(s, old, new, count=1):
    assert s.count(old) == count, (old[:80], s.count(old))
    return s.replace(old, new)


def patch(s):
    s = rep(s, """  int* dbg; int ndbg;            // optional event trace (verification aid), null in production
};""", """  int* dbg; int ndbg;            // optional event trace (verification aid), null in production
  // round 8 study "split": the group of sG threads (this one is thread sL of it, sM = the group's lane mask) that runs this
  // battle; sG > 1 lets runScenario hand its shield-combination sims to different threads of the group (SPLIT build only).
  int sG, sL; unsigned sM; int sPad;
#ifdef SPLIT_PROF
  unsigned long long pTot, pSc, pIdeal[3], pDecT[4];
  int pCalls, pCombos, pC[10], pDecN[4], pDecS[4], pCaller, pAcc, pRej;
#endif
};""")
    loop_old = """  const int sw[3] = {4, 4, 1};
  double sum = 0; int totalWeight = 0;
  for (int i = 0; i <= sh0; i++) {
    for (int n = 0; n <= sh1; n++) {
      s->m[0].startShields = i; s->m[1].startShields = n;
      s->flags = 0; s->poolMax = 0;
      simulate1v1(s);
      b->flags |= (s->flags & F_INVALID_MASK);
      if (s->poolMax > b->poolMax) b->poolMax = s->poolMax;
      b->innerSims++;
      b->rng += (unsigned)s->draws * 0x6d2b79f5u;  // each buff roll of a lookahead advances the seeded stream
      b->draws += s->draws;
      int rating = battleRating(&s->m[0], &s->m[1]);
      int w = sw[i] * sw[n];
      totalWeight += w;
      sum += (double)rating * (double)w;
    }
  }
"""
    loop_new = """  const int sw[3] = {4, 4, 1};
  double sum = 0; int totalWeight = 0;
  const int C = (sh0 + 1) * (sh1 + 1);
#ifdef SPLIT_PROF
  b->pCalls++; b->pCombos += C; b->pC[C < 10 ? C : 9]++; b->pDecS[b->pCaller] += C;
  unsigned long long pt0 = clock64();
#endif
#ifdef SPLIT
  if (b->sG > 1 && C > 1) {
    // Split: thread l of the group runs combination k0 + l, all of them starting from the state the group holds at the chunk
    // start (the exact start of combination k0). Combination j > k0 really starts from the end state of combination j - 1
    // (simulate1v1 resets each mon against the other's end-of-sim state), so thread l checks that state, after the same reset,
    // equals the one it used; the first mismatch ends the chunk and that combination runs again in the next chunk from its true
    // start. Results are added in combination order and the group adopts the end state of the last accepted combination, so
    // b ends exactly as the one-thread loop leaves it.
    const int G = b->sG, l = b->sL;
    const int lbase = (int)(threadIdx.x & 31) - l;
    const unsigned gbits = G == 32 ? 0xffffffffu : ((1u << G) - 1u);
    Sim base, X, Y;
    int k0 = 0;
    while (k0 < C) {
      __syncwarp(b->sM);
      base = *s;
      const int j = k0 + l;
      int rating = 0, dr = 0, fl = 0, pm = 0;
      if (j < C) {
        s->m[0].startShields = j / (sh1 + 1); s->m[1].startShields = j % (sh1 + 1);
        s->flags = 0; s->poolMax = 0;
        simulate1v1(s);
        rating = battleRating(&s->m[0], &s->m[1]); dr = s->draws; fl = s->flags; pm = s->poolMax;
      }
      __syncwarp(b->sM);
      grpShiftUp(&X, s, b);
      bool ok = true;
      if (l > 0 && j < C) {
        Y = base;
        prepSim(&X, j / (sh1 + 1), j % (sh1 + 1));
        prepSim(&Y, j / (sh1 + 1), j % (sh1 + 1));
        ok = sameMons(&X, &Y);
#ifdef SPLIT_PROF
        if (!ok && g_mism) mismWords(&X, &Y);
#endif
      }
      unsigned bad = (__ballot_sync(b->sM, !ok) >> lbase) & gbits;
      int nv = imin(G, C - k0);
      if (bad) nv = imin(nv, __ffs(bad) - 1);
      for (int q = 0; q < nv; q++) {
        const int jq = k0 + q;
        const int rq = __shfl_sync(b->sM, rating, q, G), dq = __shfl_sync(b->sM, dr, q, G);
        const int fq = __shfl_sync(b->sM, fl, q, G), pq = __shfl_sync(b->sM, pm, q, G);
        b->flags |= (fq & F_INVALID_MASK);
        if (pq > b->poolMax) b->poolMax = pq;
        b->innerSims++;
        b->rng += (unsigned)dq * 0x6d2b79f5u;
        b->draws += dq;
        const int w = sw[jq / (sh1 + 1)] * sw[jq % (sh1 + 1)];
        totalWeight += w;
        sum += (double)rq * (double)w;
      }
#ifdef SPLIT_PROF
      b->pAcc += nv - 1; if (k0 + nv < C && nv < G) b->pRej++;
#endif
      grpBcast(s, s, nv - 1, b);
      k0 += nv;
    }
  } else
#endif
  {
#ifdef SPLIT_PROF
  unsigned long long dd[9];
#endif
  for (int i = 0; i <= sh0; i++) {
    for (int n = 0; n <= sh1; n++) {
      s->m[0].startShields = i; s->m[1].startShields = n;
      s->flags = 0; s->poolMax = 0;
#ifdef SPLIT_PROF
      unsigned long long q0 = clock64();
#endif
      simulate1v1(s);
#ifdef SPLIT_PROF
      dd[i * (sh1 + 1) + n] = clock64() - q0;
#endif
      b->flags |= (s->flags & F_INVALID_MASK);
      if (s->poolMax > b->poolMax) b->poolMax = s->poolMax;
      b->innerSims++;
      b->rng += (unsigned)s->draws * 0x6d2b79f5u;  // each buff roll of a lookahead advances the seeded stream
      b->draws += s->draws;
      int rating = battleRating(&s->m[0], &s->m[1]);
      int w = sw[i] * sw[n];
      totalWeight += w;
      sum += (double)rating * (double)w;
    }
  }
#ifdef SPLIT_PROF
  for (int gk = 0; gk < 3; gk++) {   // ideal split time at G = 2, 4, 8: sum over chunks of the chunk's longest sim
    const int GG = 2 << gk;
    for (int c0 = 0; c0 < C; c0 += GG) {
      unsigned long long mx = 0;
      for (int q = c0; q < C && q < c0 + GG; q++) if (dd[q] > mx) mx = dd[q];
      b->pIdeal[gk] += mx;
    }
  }
#endif
  }
#ifdef SPLIT_PROF
  { unsigned long long d = clock64() - pt0; b->pSc += d; b->pDecT[b->pCaller] += d; }
#endif
"""
    s = rep(s, loop_old, loop_new)
    helpers = """#ifdef SPLIT_PROF
__device__ unsigned long long* g_prof;   // 32 words per battle, written by the slice kernel's leader (study "split")
__device__ unsigned* g_mism;             // per 32-bit word of Sim::m[2]: how often it differed when a split guess was rejected
__device__ void mismWords(const Sim* x, const Sim* y) {
  const unsigned* a = reinterpret_cast<const unsigned*>(&x->m[0]);
  const unsigned* c = reinterpret_cast<const unsigned*>(&y->m[0]);
  for (int i = 0; i < (int)(2 * sizeof(Mon) / 4); i++) if (a[i] != c[i]) atomicAdd(&g_mism[i], 1u);
}
#endif
#ifdef SPLIT
// every thread of the battle's group gets thread `from`'s *src in *dst (whole struct, 32-bit words)
template <typename T> __device__ __forceinline__ void grpBcast(T* dst, const T* src, int from, const B3* b) {
  const unsigned* ps = reinterpret_cast<const unsigned*>(src);
  unsigned* pd = reinterpret_cast<unsigned*>(dst);
  for (int i = 0; i < (int)(sizeof(T) / 4); i++) pd[i] = __shfl_sync(b->sM, ps[i], from, b->sG);
}
// thread l of the group gets thread l-1's *src in *dst (thread 0 its own)
template <typename T> __device__ __forceinline__ void grpShiftUp(T* dst, const T* src, const B3* b) {
  const unsigned* ps = reinterpret_cast<const unsigned*>(src);
  unsigned* pd = reinterpret_cast<unsigned*>(dst);
  for (int i = 0; i < (int)(sizeof(T) / 4); i++) pd[i] = __shfl_up_sync(b->sM, ps[i], 1, b->sG);
}
// the two resets simulate1v1 starts with, for combination (i, n); then fields every stepBattle sets before reading them
__device__ void prepSim(Sim* t, int i, int n) {
  t->m[0].startShields = i; t->m[1].startShields = n;
  resetMon(&t->m[0], &t->m[1]);
  resetMon(&t->m[1], &t->m[0]);
  t->m[0].hasActed = 0; t->m[1].hasActed = 0;
}
__device__ bool sameMons(const Sim* x, const Sim* y) {
  const unsigned* a = reinterpret_cast<const unsigned*>(&x->m[0]);
  const unsigned* c = reinterpret_cast<const unsigned*>(&y->m[0]);
  bool eq = true;
  for (int i = 0; i < (int)(2 * sizeof(Mon) / 4); i++) eq &= a[i] == c[i];
  return eq;
}
#endif

"""
    s = rep(s, "__device__ __noinline__ double runScenario(B3* b, int type, int gi, int gj) {",
            helpers + "__device__ __noinline__ double runScenario(B3* b, int type, int gi, int gj) {")
    for fn, tag, nxt in (("int decideSwitch(B3* b, int p) {", 1, "  Mon* poke"), ("void evalMatchup(B3* b, int p) {", 0, "  Mon* pk"),
                         ("bool decideShield(B3* b, int atkG, int defG, int mvIdx) {", 2, "  Mon* att")):
        s = rep(s, f"__device__ __noinline__ {fn}\n{nxt}",
                f"__device__ __noinline__ {fn}\n#ifdef SPLIT_PROF\n  b->pCaller = {tag}; b->pDecN[{tag}]++;\n#endif\n{nxt}")
    # group fields through battle_init
    s = rep(s, """                                                         const double* dyB, unsigned seed, int* dbgp) {
  b.flags = 0;""", """                                                         const double* dyB, unsigned seed, int* dbgp,
                                                         int sg = 1, int sl = 0, unsigned sm = 0xffffffffu) {
  b.sG = sg; b.sL = sl; b.sM = sm;
#ifdef SPLIT_PROF
  b.pTot = b.pSc = 0; for (int k = 0; k < 3; k++) b.pIdeal[k] = 0;
  for (int k = 0; k < 4; k++) { b.pDecT[k] = 0; b.pDecN[k] = 0; b.pDecS[k] = 0; }
  for (int k = 0; k < 10; k++) b.pC[k] = 0;
  b.pCalls = b.pCombos = b.pAcc = b.pRej = 0; b.pCaller = 3;
#endif
  b.flags = 0;""")
    s = rep(s, """static __device__ __forceinline__ void battle_init(B3& b, Run& r, const double* st, const int* monIdx, const double* dyn, const unsigned* seeds, int t, int* dbgp) {
  battle_init_teams(b, r, st, monIdx + (long long)t * 6, dyn + (long long)t * 6 * D_N, monIdx + (long long)t * 6 + 3,
                    dyn + ((long long)t * 6 + 3) * D_N, seeds[t], dbgp);""",
            """static __device__ __forceinline__ void battle_init(B3& b, Run& r, const double* st, const int* monIdx, const double* dyn, const unsigned* seeds, int t, int* dbgp,
                                                   int sg = 1, int sl = 0, unsigned sm = 0xffffffffu) {
  battle_init_teams(b, r, st, monIdx + (long long)t * 6, dyn + (long long)t * 6 * D_N, monIdx + (long long)t * 6 + 3,
                    dyn + ((long long)t * 6 + 3) * D_N, seeds[t], dbgp, sg, sl, sm);""")
    # ring requeue path: pass the group, re-set it after a resume (the save holds the leader's), time the battle
    s = rep(s, """        if (saved) load_state(save + (long long)s * SLOT_WORDS, b, r);
        else { r.tStart = t0; if (leader) note_deadline(ctl, t0 + (unsigned long long)predNs[bi]); battle_init(b, r, st, monIdx, dyn, seeds, bi, 0); }
        int before = r.guard;
        bool done = battle_steps(b, r, budget);""", """#ifdef SPLIT_PROF
        unsigned long long c0 = clock64();
#endif
        if (saved) { load_state(save + (long long)s * SLOT_WORDS, b, r); b.sG = G; b.sL = glane; b.sM = gmask; }
        else { r.tStart = t0; if (leader) note_deadline(ctl, t0 + (unsigned long long)predNs[bi]); battle_init(b, r, st, monIdx, dyn, seeds, bi, 0, G, glane, gmask); }
        int before = r.guard;
        bool done = battle_steps(b, r, budget);
#ifdef SPLIT_PROF
        b.pTot += clock64() - c0;
#endif""")
    s = rep(s, """          if (leader) {
            battle_write(b, r, out, bi);
            seg_rec(ctl0, segs, segCap, who, 0, bi, t0, gtimer());""", """          if (leader) {
            battle_write(b, r, out, bi);
#ifdef SPLIT_PROF
            if (g_prof) {
              unsigned long long* pp = g_prof + (long long)bi * 32;
              pp[0] = b.pTot; pp[1] = b.pSc; pp[2] = b.pIdeal[0]; pp[3] = b.pIdeal[1]; pp[4] = b.pIdeal[2];
              for (int k = 0; k < 4; k++) { pp[5 + k] = b.pDecT[k]; pp[21 + k] = b.pDecN[k]; pp[25 + k] = b.pDecS[k]; }
              pp[9] = b.pCalls; pp[10] = b.pCombos;
              for (int k = 0; k < 10; k++) pp[11 + k] = b.pC[k];
              pp[29] = b.pAcc; pp[30] = b.pRej; pp[31] = b.innerSims;
            }
#endif
            seg_rec(ctl0, segs, segCap, who, 0, bi, t0, gtimer());""")
    return s


def main():
    os.makedirs(DST, exist_ok=True)
    for f in ("pvp1v1.cuh", "battle1v1.cuh"):
        shutil.copyfile(os.path.join(SRC, f), os.path.join(DST, f))
    s = open(os.path.join(SRC, "battle3v3.cuh")).read()
    open(os.path.join(DST, "battle3v3.cuh"), "w").write(patch(s))
    print("wrote", DST)


if __name__ == "__main__":
    main()
