// 1v1 battle loop (Battle.js step/useMove/simulate); included after pvp1v1.cuh

struct QA { int actor, type, turn, value, prio; };  // type 0 = fast, 1 = charged

struct Sim {
  Mon m[2];
  QA q[8];
  int nq;
  int prevCharged;
  int turns, time, roundCMU, roundShield, usePriority;
  int draws, flags, poolMax;
};

__device__ void useMove(Sim* s, int ai, int di, int mvIdx) {
  Mon* a = &s->m[ai];
  Mon* d = &s->m[di];
  Move* mv = mvIdx < 0 ? &a->fast : &a->ch[mvIdx];
  int damage = calcDamage(a, d, mv);
  mv->damage = damage;
  bool charged = mvIdx >= 0;
  if (charged) {
    a->energy -= mv->energy;
    int cmt = mv->instant ? 3000 : 10000;
    if (s->usePriority && s->roundCMU > 0 && !s->roundShield) s->time += cmt;
    bool canShield = d->shields > 0 && !mv->instant;
    if (canShield) {
      bool use = true;
      if (mv->hasBuffs && mv->selfBuf) {
        if ((mv->target == 1 && mv->b0 > 0) || (mv->target == 2 && mv->b1 < 0)) use = wouldShield(a, d, mv, a, d);
        if (mv->target == 3 && (mv->bs0 > 0 || mv->bo1 < 0)) use = wouldShield(a, d, mv, a, d);
      }
      if (d->best >= 0 && d->ch[d->best].selfDefDeb) {
        if (a->shields > 0) {
          use = wouldShield(a, d, mv, a, d);
        } else if (d->best >= 0 && a->best >= 0) {
          Move* db = &d->ch[d->best];
          int fastToNextCharged = ceilDiv(db->energy - d->energy, d->fast.gain);
          int turnsToNextCharged = fastToNextCharged * d->fast.turns;
          int cycleDamage = fastToNextCharged * d->fast.damage + db->damage;
          int attackerTurns = ceilDiv(a->ch[a->act[0]].energy - a->energy, a->fast.gain) * a->fast.turns;
          if (a->atk > d->atk) attackerTurns--;
          if (turnsToNextCharged >= attackerTurns && a->hp <= cycleDamage) use = wouldShield(a, d, mv, a, d);
        }
      }
      if (use) {
        damage = 1;
        d->shields--;
        s->roundShield = 1;
        if (s->roundCMU == 0) s->time += 10000;
      }
    }
  } else {
    a->energy += a->fast.gain;
    if (a->energy > 100) a->energy = 100;
  }
  d->hp = imax(0, d->hp - damage);
  if (mv->hasBuffs) {
    s->draws++;
    bool apply = false;
    if (mv->chance == (REAL)1) apply = true;
    else if (mv->chance < (REAL)1 && mv->meterDefined) {
      int startCount = (int)floor(mv->meter);
      mv->meter += mv->chance;
      if (startCount < (int)floor(mv->meter)) apply = true;
    }
    if (apply) {
      if (mv->target == 2 || mv->target == 3) {
        int b0 = mv->target == 3 ? mv->bo0 : mv->b0, b1 = mv->target == 3 ? mv->bo1 : mv->b1;
        applyBuffs(d, b0, b1);
      }
      if (mv->target == 1 || mv->target == 3) {
        int b0 = mv->target == 3 ? mv->bs0 : mv->b0, b1 = mv->target == 3 ? mv->bs1 : mv->b1;
        applyBuffs(a, b0, b1);
      }
    }
  }
  if (d->hp <= 0) d->faintSource = charged ? 2 : 1;
}

__device__ void sortQ(QA* t, int n) {  // stable, priority descending
  for (int i = 1; i < n; i++) {
    QA v = t[i];
    int j = i - 1;
    while (j >= 0 && v.prio > t[j].prio) { t[j + 1] = t[j]; j--; }
    t[j + 1] = v;
  }
}

__device__ void stepBattle(Sim* s) {
  s->roundCMU = 0;
  s->roundShield = 0;
  for (int i = 0; i < 2; i++) {
    s->m[i].cooldown = imax(0, s->m[i].cooldown - 500);
    s->m[i].hasActed = 0;
  }
  int chargedLast = s->prevCharged;
  int cdSet[2] = {s->m[0].cooldown, s->m[1].cooldown};
  for (int i = 0; i < 2; i++) {
    Mon* p = &s->m[i];
    Mon* o = &s->m[1 - i];
    if (p->cooldown == 0 && !p->hasActed) {
      p->hasActed = 1;
      int queuedFast = 0;
      for (int k = 0; k < s->nq; k++) if (s->q[k].actor == i && s->q[k].type == 0) queuedFast++;
      int mv = decideAction(p, o, s->turns, queuedFast, &s->flags, &s->poolMax);
      QA a;
      a.actor = i; a.turn = s->turns;
      if (mv >= 0) {
        a.type = 1; a.value = mv; a.prio = p->priority + 10 + (p->atk > o->atk ? 1 : 0);
      } else {
        a.type = 0; a.value = 0; a.prio = p->priority;
      }
      if (chargedLast) continue;
      if (p->hp > 0 && o->hp > 0) {
        if (a.type == 0) cdSet[i] += p->fast.cd;
        else cdSet[i] += 500;
        s->q[s->nq++] = a;
      }
    }
  }
  s->m[0].cooldown = cdSet[0];
  s->m[1].cooldown = cdSet[1];
  QA ta[8];
  int nt = 0;
  for (int k = 0; k < s->nq; k++) {
    QA a = s->q[k];
    int timeSince = (s->turns - a.turn) * 500;
    int required = a.type == 0 ? s->m[a.actor].fast.cd - 500 : 0;
    bool valid = timeSince >= required || (a.type == 0 && chargedLast && a.turn < s->turns);
    if (valid) {
      ta[nt++] = a;
      for (int x = k + 1; x < s->nq; x++) s->q[x - 1] = s->q[x];
      s->nq--;
      k--;
    }
  }
  sortQ(ta, nt);
  int anyCharged = 0;
  for (int k = 0; k < nt; k++) {
    QA a = ta[k];
    if (a.type == 1) anyCharged = 1;
    Mon* p = &s->m[a.actor];
    Mon* o = &s->m[1 - a.actor];
    bool valid = false;
    if (a.type == 0) {
      valid = true;
      if (o->hp < 1) valid = false;
      if (p->hp < 1 && p->faintSource == 2) valid = false;
    } else {
      Move* mv = &p->ch[a.value];
      if (p->energy >= mv->energy) valid = true;
      if (s->usePriority && p->hp <= 0 && p->faintSource == 2) valid = false;
    }
    if (!valid) continue;
    if (a.type == 0) {
      useMove(s, a.actor, 1 - a.actor, -1);
    } else {
      if (p->energy >= p->ch[a.value].energy) {
        useMove(s, a.actor, 1 - a.actor, a.value);
        s->roundCMU++;
      }
    }
  }
  s->prevCharged = anyCharged;
  if (s->roundCMU == 0) s->time += 500;
  else if (s->roundShield) s->time += 10000 * (s->roundCMU - 1);
  else s->time += 10000;
  for (int i = 0; i < 2; i++) if (s->roundCMU) s->m[i].cooldown = 500;
  s->turns++;
}

__device__ __noinline__ void simulate1v1(Sim* s) {
  resetMon(&s->m[0], &s->m[1]);
  resetMon(&s->m[1], &s->m[0]);
  s->usePriority = s->m[0].atk != s->m[1].atk;
  s->time = 0;
  s->turns = 1;
  s->nq = 0;
  s->prevCharged = 0;
  s->draws = 0;
  while (true) {
    stepBattle(s);
    bool cont = s->m[0].hp > 0 && s->m[1].hp > 0;
    if (s->time > 240000) { cont = false; s->flags |= F_TIMEOUT; }
    if (!cont) break;
  }
}

__device__ int battleRating(const Mon* self, const Mon* opp) {
  return (int)floor((REAL)500 * ((REAL)(opp->hpMax - opp->hp) / (REAL)opp->hpMax) + (REAL)500 * ((REAL)self->hp / (REAL)self->hpMax));
}

#ifndef NO_1V1_KERNEL
#define OUT_N 18
extern "C" __global__ void sim1v1_kernel(const double* st, const int* monIdx, const double* dyn, int* out, int n) {
  int t = blockIdx.x * blockDim.x + threadIdx.x;
  if (t >= n) return;
  Sim s;
  s.flags = 0; s.poolMax = 0;
  for (int i = 0; i < 2; i++) {
    const double* srow = st + (long long)monIdx[t * 2 + i] * S_N;
    loadMon(&s.m[i], srow, dyn + ((long long)t * 2 + i) * D_N, i);
    if (s.m[i].formChange || s.m[i].special == 3) s.flags |= F_UNSUPPORTED;
  }
  int* o = out + (long long)t * OUT_N;
  if (s.flags & F_UNSUPPORTED) { for (int i = 0; i < OUT_N; i++) o[i] = 0; o[16] = s.flags; return; }
  simulate1v1(&s);
  o[0] = battleRating(&s.m[0], &s.m[1]);
  o[1] = battleRating(&s.m[1], &s.m[0]);
  o[2] = s.m[0].hp; o[3] = s.m[1].hp;
  o[4] = s.m[0].energy; o[5] = s.m[1].energy;
  o[6] = s.m[0].shields; o[7] = s.m[1].shields;
  o[8] = s.m[0].sb0; o[9] = s.m[0].sb1; o[10] = s.m[1].sb0; o[11] = s.m[1].sb1;
  o[12] = s.turns; o[13] = s.m[0].turnsToKO; o[14] = s.m[1].turnsToKO;
  o[15] = s.draws; o[16] = s.flags; o[17] = s.poolMax;
}
#endif
