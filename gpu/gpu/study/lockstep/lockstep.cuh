// Round 8 study fork "lockstep": RL-simulator style scheduling of the SAME battle code (battle_init / battle_steps / battle_write,
// save_state's state = B3 + Run). Appended after the production sources compiled with SLICE (needs SLOT_WORDS, gtimer).
// One launch = one time slice: every still-running battle in the active list advances up to T loop iterations, then either
// writes its row (finished) or saves its state and appends itself to the next launch's active list (compaction by one
// warp-aggregated atomic per warp, so the list keeps warp order). The host relaunches over the new list until it is empty.
// soa = 1: state word w of battle bi lives at save[w * stride + bi] (adjacent threads -> adjacent words, coalesced);
// soa = 0: save[bi * SLOT_WORDS + w] (the production slot layout).
// cnt[k] = active battles of slice k (cnt[0] set by the host, cnt[k+1] counted by slice k), so no counter needs a reset.

static __device__ __forceinline__ void ls_save(unsigned long long* save, int stride, int soa, int bi, const B3& b, const Run& r) {
  const unsigned long long* pb = reinterpret_cast<const unsigned long long*>(&b);
  const unsigned long long* pr = reinterpret_cast<const unsigned long long*>(&r);
  const int nb = (int)(sizeof(B3) / 8), nr = (int)(sizeof(Run) / 8);
  if (soa) {
    for (int i = 0; i < nb; i++) __stcg(save + (long long)i * stride + bi, pb[i]);
    for (int i = 0; i < nr; i++) __stcg(save + (long long)(nb + i) * stride + bi, pr[i]);
  } else {
    unsigned long long* slot = save + (long long)bi * SLOT_WORDS;
    for (int i = 0; i < nb; i++) __stcg(slot + i, pb[i]);
    for (int i = 0; i < nr; i++) __stcg(slot + nb + i, pr[i]);
  }
}

static __device__ __forceinline__ void ls_load(const unsigned long long* save, int stride, int soa, int bi, B3& b, Run& r) {
  unsigned long long* pb = reinterpret_cast<unsigned long long*>(&b);
  unsigned long long* pr = reinterpret_cast<unsigned long long*>(&r);
  const int nb = (int)(sizeof(B3) / 8), nr = (int)(sizeof(Run) / 8);
  if (soa) {
    for (int i = 0; i < nb; i++) pb[i] = __ldcg(save + (long long)i * stride + bi);
    for (int i = 0; i < nr; i++) pr[i] = __ldcg(save + (long long)(nb + i) * stride + bi);
  } else {
    const unsigned long long* slot = save + (long long)bi * SLOT_WORDS;
    for (int i = 0; i < nb; i++) pb[i] = __ldcg(slot + i);
    for (int i = 0; i < nr; i++) pr[i] = __ldcg(slot + nb + i);
  }
}

// One battle of slice k: act[g] is a queue position p (state slot); the battle is order[p]. started[p]: 0 fresh, 1 state saved.
// Not finished -> state saved, p appended to nxt (counted in cnt[k + 1]). stamps[k * 2 + 0/1]: min start / max end %globaltimer
// of slice k (host initialises min to ~0). Called by all threads of a warp that have g < n (warp-aggregated append).
static __device__ __forceinline__ void ls_one(const double* st, const int* monIdx, const double* dyn, const unsigned* seeds, int* out,
                                              const int* order, const int* act, int* nxt, unsigned* cnt, int k, int T,
                                              unsigned long long* save, int stride, int soa, int* started, unsigned long long* stamps, int g) {
  unsigned long long t0 = gtimer();
  const int p = act[g];
  const int bi = order[p];
  B3 b;
  Run r;
  if (started[p]) ls_load(save, stride, soa, p, b, r);
  else { r.tStart = t0; battle_init(b, r, st, monIdx, dyn, seeds, bi, 0); started[p] = 1; }
  const bool done = battle_steps(b, r, T);
  if (done) battle_write(b, r, out, bi);
  else ls_save(save, stride, soa, p, b, r);
  // warp-aggregated append: one atomic per converged group of lanes, lanes keep their order
  const unsigned m = __activemask();
  const unsigned want = __ballot_sync(m, !done);
  const int lane = threadIdx.x & 31;
  const int leaderLane = __ffs(m) - 1;
  unsigned base = 0;
  if (lane == leaderLane && want) base = atomicAdd(&cnt[k + 1], (unsigned)__popc(want));
  base = __shfl_sync(m, base, leaderLane);
  if (!done) nxt[base + __popc(want & ((1u << lane) - 1u))] = p;
  unsigned long long t1 = gtimer();
  atomicMin(stamps + 2 * k, t0);
  atomicMax(stamps + 2 * k + 1, t1);
}

// Host-relaunched form: one launch = one slice over act[0 .. cnt[k]). spread = lanes per warp that take a battle (1..32): warp w
// runs list entries [w * spread, (w + 1) * spread), so a short list is spread over many warps (fewer battles per warp = less
// divergence: a warp runs its lanes' different code paths one after another). spread <= 0: ceil(n / warpsInGrid), from the device count.
extern "C" __global__ void battle3v3_lockstep(const double* st, const int* monIdx, const double* dyn, const unsigned* seeds, int* out,
                                              const int* order, const int* act, int* nxt, unsigned* cnt, int k, int T, unsigned long long* save,
                                              int stride, int soa, int* started, unsigned long long* stamps, int spread) {
  const unsigned n = *(volatile unsigned*)(cnt + k);
  const int lane = threadIdx.x & 31, warp = (blockIdx.x * blockDim.x + threadIdx.x) >> 5;
  if (spread <= 0) { const int nw = gridDim.x * blockDim.x / 32; spread = imin(32, imax(1, (int)((n + nw - 1) / nw))); }
  if (lane >= spread) return;
  const int g = warp * spread + lane;
  if ((unsigned)g >= n) return;
  ls_one(st, monIdx, dyn, seeds, out, order, act, nxt, cnt, k, T, save, stride, soa, started, stamps, g);
}

// Software grid barrier; valid only when every block of the grid is resident at once (host launches the occupancy limit).
// bar[0] = arrivals, bar[1] = generation.
static __device__ __forceinline__ void ls_barrier(unsigned* bar, unsigned nblocks) {
  __syncthreads();
  if (threadIdx.x == 0) {
    volatile unsigned* gen = bar + 1;
    const unsigned g0 = *gen;
    __threadfence();
    if (atomicAdd(&bar[0], 1u) == nblocks - 1u) { atomicExch(&bar[0], 0u); __threadfence(); atomicAdd(&bar[1], 1u); }
    else { while (*gen == g0) __nanosleep(200); }
    __threadfence();
  }
  __syncthreads();
}

// Persistent form: one launch; the resident grid strides over each slice's list, then waits at a grid barrier for the next.
// res[0] = slices run.
extern "C" __global__ void battle3v3_lockstep_persist(const double* st, const int* monIdx, const double* dyn, const unsigned* seeds, int* out,
                                                      const int* order, int* list0, int* list1, unsigned* cnt, int maxSlices, int T,
                                                      unsigned long long* save, int stride, int soa, int* started, unsigned long long* stamps,
                                                      unsigned* bar, int* res, int spread) {
  const int nth = gridDim.x * blockDim.x;
  for (int k = 0; k < maxSlices; k++) {
    const unsigned n = *(volatile unsigned*)(cnt + k);
    if (n == 0u) { if (blockIdx.x == 0 && threadIdx.x == 0) res[0] = k; return; }
    const int* act = (k & 1) ? list1 : list0;
    int* nxt = (k & 1) ? list0 : list1;
    // spread the list evenly: sp lanes per warp take a battle (see battle3v3_lockstep), warps stride over the list
    const int nw = nth / 32, lane = threadIdx.x & 31, warp = (blockIdx.x * blockDim.x + threadIdx.x) >> 5;
    const int sp = spread > 0 ? spread : imin(32, imax(1, (int)((n + nw - 1) / nw)));
    if (lane < sp)
      for (int w = warp; (unsigned)(w * sp) < n; w += nw) {
        const int g = w * sp + lane;
        if ((unsigned)g < n) ls_one(st, monIdx, dyn, seeds, out, order, act, nxt, cnt, k, T, save, stride, soa, started, stamps, g);
      }
    ls_barrier(bar, gridDim.x);
  }
  if (blockIdx.x == 0 && threadIdx.x == 0) res[0] = -1;
}
