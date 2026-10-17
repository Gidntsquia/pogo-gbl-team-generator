// ------------------------------------------------------------------ round 9 tail filler (POGO_GPU_STUDY=tail[,certain])
// EXPERIMENTAL, off by default. Appended after battle3v3.cuh (compiled with SLICE for its helpers). Same requeue scheduler as
// battle3v3_slice mode 0 at G = 1 for the MAIN battles (this halving round), plus a POOL of the NEXT round's battles (every
// current team x the next slice's new opponents x both seats) appended at rows nMain..nMain+nPool-1.
//
// Pool work, run only by a lane whose warp holds no main battle (wmain[warp] == 0; a different battle in the same warp would
// run one after the other with the main one and slow it):
//   certain tier: pool indices the host appends to cq[] while the launch runs (tctl[T_CQTAIL]; teams certain to survive the
//                 cut, gpu/gpu/study/tail/certainty.mjs). Taken first, from the launch start.
//   spec tier:    once main battles not finished <= thr (host: half the workers), the first lane to see it ranks the teams by
//                 partial win rate ((prior + this launch's finished main battles) points / battles), keeps the top keepK and
//                 lists their pool battles in host order. Lanes take them by ticket.
// A pool battle is claimed with atomicCAS (the two tiers can list the same one). Every lane leaves as soon as the last main
// battle ends (C_LIVE == 0): pool battles still running are discarded. A lane notices only between battle steps, and one
// step can take over a second (2.4 s measured on a main battle of the 5k launch), so the host does not wait for the grid to
// exit: it reads the rows the moment C_LIVE is 0 (variant.py done / tail_collect) and the late lanes finish in the
// background. Pool lanes run only on an SM with no main battle (wmain is per SM) and hold at most
// (lanes alive - main battles left) battles, so a requeued main slice always finds a free lane. Battle math is the same code; a finished pool row equals the row the next round would compute.
#ifdef TAIL
#define T_STATE 0     // spec tier: 0 not started, 1 being ranked, 2 list ready
#define T_NSPEC 1     // spec list length
#define T_SHEAD 2     // spec tickets
#define T_CQHEAD 3    // certain-queue tickets
#define T_CQTAIL 4    // certain-queue entries (written by the host during the launch)
#define T_STARTED 5   // pool battles claimed
#define T_DONE 6      // pool battles finished
#define T_FROMCQ 7    // pool battles claimed from the certain queue
#define T_EXIT 8      // u64 (8,9): last lane exit, %globaltimer
#define T_MAINEND 10  // u64 (10,11): last main battle end
#define T_SPECAT 12   // u64 (12,13): when the spec tier was ranked
#define T_DONECQ 14   // pool battles finished that came from the certain queue
#define T_HELD 15     // pool battles held by a lane now (claimed, not finished or dropped)
#define T_NCTL 20

// A main row is final once mdone[row] = 1: battle_write, a fence, then the flag. The host's peek copies mdone first and the rows
// after it, so every row it sees flagged is complete.
static __device__ __forceinline__ void tail_write(const B3& b, const Run& r, int* out, int t, int* mdone) {
  battle_write(b, r, out, t);
  __threadfence();
  *(volatile int*)(mdone + t) = 1;
}

// Rank the teams and list the spec tier (one lane). score = points / battles over the prior rounds' battles and this launch's
// finished main battles; the top keepK (ties: lower index) are kept; their pool battles go to the list in host order.
static __device__ void tail_rank(int nT, int keepK, const float* priorPts, const float* priorN, const float* tPts, const float* tN,
                                 int* chosen, int nPool, const int* poolTeam, const int* poolOrder, int* specList, unsigned* tctl) {
  for (int i = 0; i < nT; i++) chosen[i] = 0;
  for (int k = 0; k < keepK && k < nT; k++) {
    int best = -1;
    float bs = -1.f;
    for (int i = 0; i < nT; i++) {
      if (chosen[i]) continue;
      float n = priorN[i] + *(volatile const float*)(tN + i);
      float s = n > 0.f ? (priorPts[i] + *(volatile const float*)(tPts + i)) / n : 0.5f;
      if (s > bs) { bs = s; best = i; }
    }
    if (best < 0) break;
    chosen[best] = 1;
  }
  int m = 0;
  for (int q = 0; q < nPool; q++) {
    int p = poolOrder[q];
    if (chosen[poolTeam[p]]) specList[m++] = p;
  }
  tctl[T_NSPEC] = (unsigned)m;
  *(unsigned long long*)(tctl + T_SPECAT) = gtimer();
  __threadfence();
  atomicExch(&tctl[T_STATE], 2u);
}

// Next pool battle for this lane, or -1: certain queue first, then the spec list.
static __device__ int tail_take(unsigned* tctl, const int* cq, const int* specList, int* pclaim, bool* fromCq) {
  for (;;) {
    unsigned h = vload(&tctl[T_CQHEAD]);
    if (h >= vload(&tctl[T_CQTAIL])) break;
    if (atomicCAS(&tctl[T_CQHEAD], h, h + 1u) != h) continue;
    int p = __ldcg(cq + h);
    if (atomicCAS(&pclaim[p], 0, 1) == 0) { *fromCq = true; return p; }
  }
  if (vload(&tctl[T_STATE]) != 2u) return -1;
  for (;;) {
    unsigned s = vload(&tctl[T_SHEAD]);
    if (s >= vload(&tctl[T_NSPEC])) return -1;
    if (atomicCAS(&tctl[T_SHEAD], s, s + 1u) != s) continue;
    int p = __ldcg(specList + s);
    if (atomicCAS(&pclaim[p], 0, 1) == 0) { *fromCq = false; return p; }
  }
}

extern "C" __global__ void battle3v3_tail(
    const double* st, const int* monIdx, const double* dyn, const unsigned* seeds, int* out,
    const int* order, const int* serStart, int nSeries, int T,
    unsigned* ctl, int* spos, int* sstate, unsigned long long* save, unsigned long long* ring, unsigned ringCap,
    unsigned* segs, int segCap, const float* predNs,
    int nMain, int nPool, const int* mainTag, const int* poolTeam, const int* poolOrder, int nT, int keepK, unsigned thr,
    float* tPts, float* tN, const float* priorPts, const float* priorN, int* chosen, int* specList, int* pclaim, int* pdone,
    const int* cq, unsigned* tctl, int* wmain, int TS, int specOn, int* mdone) {
  const int lane = threadIdx.x & 31;
  const int gtid = blockIdx.x * blockDim.x + threadIdx.x;
  unsigned smid_;
  asm volatile("mov.u32 %0, %%smid;" : "=r"(smid_));
  const int gwarp = (int)(smid_ & 255u);  // wmain is per SM: pool warps share the SM's issue slots and L1 with its main warps
  B3 b;
  Run r;
  if (lane >= (int)ctl[C_SPREAD]) { atomicSub(&ctl[C_ALIVE], 1u); return; }  // spare lanes leave, as in production
  int held = -1;           // pool battle this lane holds (its state is in b / r), or -1
  bool heldCq = false;
  unsigned long long heldT0 = 0;
  for (;;) {
    // ---- main work first (the production requeue loop at G = 1); a lane holding a pool battle leaves the ring to the others:
    // every queued series was pushed by a lane that pops again right after, so the ring never waits on a pool lane.
    if (held < 0 && vload(&ctl[C_HEAD]) < vload(&ctl[C_TAIL])) {
      unsigned h = vload(&ctl[C_HEAD]);
      if (h >= vload(&ctl[C_TAIL]) || atomicCAS(&ctl[C_HEAD], h, h + 1u) != h) continue;
      unsigned long long v;
      bool quit = false;
      for (;;) {
        v = *(volatile unsigned long long*)(ring + (h % ringCap));
        if ((unsigned)(v >> 32) == h + 1u && (unsigned)v != 0xffffffffu) break;
        if (vload(&ctl[C_LIVE]) == 0u) { quit = true; break; }
        __nanosleep(500);
      }
      if (quit) break;
      *(volatile unsigned long long*)(ring + (h % ringCap)) = ((unsigned long long)(h + 1u) << 32) | 0xffffffffull;
      int s = (int)(v & 0xffffffffull);
      atomicAdd(&wmain[gwarp], 1);
      int budget = T;
      bool more = true;
      while (budget > 0) {
        int pos = spos[s], saved = sstate[s];
        int bi = order[serStart[s] + pos];
        unsigned long long t0 = gtimer();
        if (saved) load_state(save + (long long)s * SLOT_WORDS, b, r);
        else { r.tStart = t0; note_deadline(ctl, t0 + (unsigned long long)predNs[bi]); battle_init(b, r, st, monIdx, dyn, seeds, bi, 0); }
        int before = r.guard;
        bool done = battle_steps(b, r, budget);
        budget -= imax(1, r.guard - before);
        if (done) {
          tail_write(b, r, out, bi, mdone);
          unsigned long long t1 = gtimer();
          seg_rec(ctl, segs, segCap, gtid, 0, bi, t0, t1);
          int tg = mainTag[bi];
          if (tg >= 0) {
            int w = out[(long long)bi * B_OUT], seat = tg & 1;
            atomicAdd(&tPts[tg >> 1], w == 2 ? 0.5f : (w == seat ? 1.f : 0.f));
            atomicAdd(&tN[tg >> 1], 1.f);
          }
          atomicMax(reinterpret_cast<unsigned long long*>(tctl + T_MAINEND), t1);
          sstate[s] = 0;
          spos[s] = pos + 1;
          __threadfence();
          atomicSub(&ctl[C_LIVE], 1u);
          if (pos + 1 >= serStart[s + 1] - serStart[s]) { more = false; break; }
        } else {
          save_state(save + (long long)s * SLOT_WORDS, b, r);
          seg_rec(ctl, segs, segCap, gtid, 0, bi, t0, gtimer());
          sstate[s] = 1;
          break;
        }
      }
      atomicSub(&wmain[gwarp], 1);
      if (more) {
        __threadfence();
        unsigned p = atomicAdd(&ctl[C_TAIL], 1u);
        atomicAdd(&ctl[C_HANDOFF], 1u);
        unsigned long long* slot = ring + (p % ringCap);
        if (p >= ringCap) {
          unsigned long long want = ((unsigned long long)(p - ringCap + 1u) << 32) | 0xffffffffull;
          while (*(volatile unsigned long long*)slot != want) __nanosleep(200);
        }
        *(volatile unsigned long long*)slot = ((unsigned long long)(p + 1u) << 32) | (unsigned)s;
      }
      continue;
    }
    const unsigned live = vload(&ctl[C_LIVE]);
    if (live == 0u) break;
    if (held < 0 && vload(&ctl[C_HEAD]) < vload(&ctl[C_TAIL])) continue;  // main work appeared: take it
    // ---- pool work
    if (held < 0) {
      // spec list used up (or off) and no certain feed can come: leave like production while lanes outnumber live battles
      const bool specDone = !(specOn & 1) || (vload(&tctl[T_STATE]) == 2u && vload(&tctl[T_SHEAD]) >= vload(&tctl[T_NSPEC]));
      if (specDone && !(specOn & 2)) {
        unsigned a = vload(&ctl[C_ALIVE]);
        bool left = false;
        while (a > vload(&ctl[C_LIVE])) {
          unsigned old = atomicCAS(&ctl[C_ALIVE], a, a - 1u);
          if (old == a) { left = true; break; }
          a = old;
        }
        if (left) break;
        __nanosleep(500);
        continue;
      }
      if (*(volatile int*)(wmain + gwarp) != 0) { __nanosleep(2000); continue; }
      // ranked by a lane whose warp runs no main battle (the ranking loop would stall main lanes of its warp)
      if ((specOn & 1) && live <= thr && vload(&tctl[T_STATE]) == 0u && atomicCAS(&tctl[T_STATE], 0u, 1u) == 0u)
        tail_rank(nT, keepK, priorPts, priorN, tPts, tN, chosen, nPool, poolTeam, poolOrder, specList, tctl);
      // lane budget: pool holders + main battles not finished <= lanes alive, so every requeued main slice finds a free lane
      // at once (a lane never gives its pool battle back, and a main battle waiting in the ring would wait for it)
      if (nPool == 0 || atomicAdd(&tctl[T_HELD], 1u) + 1u + live > vload(&ctl[C_ALIVE])) {
        if (nPool) atomicSub(&tctl[T_HELD], 1u);
        __nanosleep(1000);
        continue;
      }
      held = tail_take(tctl, cq, specList, pclaim, &heldCq);
      if (held < 0) { atomicSub(&tctl[T_HELD], 1u); __nanosleep(1000); continue; }
      atomicAdd(&tctl[T_STARTED], 1u);
      if (heldCq) atomicAdd(&tctl[T_FROMCQ], 1u);
      heldT0 = gtimer();
      r.tStart = heldT0;
      battle_init(b, r, st, monIdx, dyn, seeds, nMain + held, 0);
    }
    if (*(volatile int*)(wmain + gwarp) != 0) { __nanosleep(2000); continue; }  // a main battle came to this warp: wait, state kept
    bool done = false, stop = false;
    for (int k = 0; k < TS; k++) {
      if (vload(&ctl[C_LIVE]) == 0u) { stop = true; break; }
      if (battle_steps(b, r, 1)) { done = true; break; }
    }
    if (done) {
      battle_write(b, r, out, nMain + held);
      __threadfence();  // the host may read the pool rows while late lanes still run (variant.py done/tail_collect)
      *(volatile int*)(pdone + held) = 1;
      atomicAdd(&tctl[T_DONE], 1u);
      if (heldCq) atomicAdd(&tctl[T_DONECQ], 1u);
      seg_rec(ctl, segs, segCap, gtid, 3, nMain + held, heldT0, gtimer());
      held = -1;
      atomicSub(&tctl[T_HELD], 1u);
    } else if (stop) {
      seg_rec(ctl, segs, segCap, gtid, 3, nMain + held, heldT0, gtimer());
      break;  // discarded
    }
  }
  atomicMax(reinterpret_cast<unsigned long long*>(tctl + T_EXIT), gtimer());
}
#endif
