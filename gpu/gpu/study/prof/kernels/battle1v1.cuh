// 1v1 battle loop (Battle.js step/useMove/simulate); included after pvp1v1.cuh

struct QA { int actor, type, turn, value, prio; };  // type 0 = fast, 1 = charged

struct Sim {
  Mon m[2];
  QA q[8];
  int nq;
  int prevCharged;
  int turns, time, roundCMU, roundShield, usePriority;
  int draws, flags, poolMax;
  Move gm;          // scratch for the Gulp Missile move (action value >= 100)
  QA ins;           // charged action inserted by Gulp Missile
  int hasIns;
};

// Action value >= 100 names a Gulp Missile move (static rows 0 = ARROKUDA, 1 = PIKACHU); else a charged slot index.
__device__ __forceinline__ Move* chargedOf(Move* scratch, Mon* p, int value) {
  if (value >= 100) { loadMove(scratch, p->tbl + (long long)(value - 100) * S_N + 30); return scratch; }
  return &p->ch[value];
}
__device__ __forceinline__ bool fcAttackerTrigger(const Mon* a, const Move* mv) {   // Battle.js 1548-1549
  switch (a->fc) {
    case 5: return mv->code == 8 || mv->code == 9;
    case 6: return mv->code == 20;
    case 7: return mv->code == 21;
    case 8: return true;
  }
  return false;
}

__device__ void useMove(Sim* s, int ai, int di, int mvIdx) {
  Mon* a = &s->m[ai];
  Mon* d = &s->m[di];
  Move* mv = mvIdx < 0 ? &a->fast : chargedOf(&s->gm, a, mvIdx);
  if (mvIdx >= 0 && a->fc == 2 && a->form != 0) changeForm(a, d, 0);   // pre-attack form change (Battle.js 1024)
  int damage = calcDamage(a, d, mv);
  mv->damage = damage;
  bool charged = mvIdx >= 0;
  bool defenderUsedShield = false;
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
      // sandbox = false: save shields for Aegislash shield / Cramorant gulping, don't shield early Dives (Battle.js 1121-1136)
      if (d->kind == 1 && d->form == 1 && damage * 2 < d->hp) use = wouldShield(a, d, mv, a, d);
      if (d->kind == 3 && d->form >= 1 && (double)damage * 2.2 < (double)d->hp) use = wouldShield(a, d, mv, a, d);
      if (a->kind == 3 && (double)damage / (double)d->hp < 0.33) use = wouldShield(a, d, mv, a, d);
      if (use) {
        damage = 1;
        d->shields--;
        s->roundShield = 1;
        defenderUsedShield = true;
        if (d->fc == 1 && d->form != 1) changeForm(d, a, 1);
        if (s->roundCMU == 0) s->time += 10000;
      }
    }
    if (d->fc == 3 && !defenderUsedShield && !mv->instant) {   // Mimikyu disguise (Battle.js 1274)
      damage = 1;
      s->roundShield = 1;
      if (s->roundCMU == 0) s->time += 10000;
    }
  } else {
    int gain = a->fast.gain;
    if (a->kind == 1 && a->form == 1) gain = 6;
    a->energy += gain;
    if (a->energy > 100) a->energy = 100;
  }
  if (a->kind == 1 && a->form == 1 && mv->gain > 0) damage = 1;
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
  // post-attack form changes (Battle.js 1548-1627)
  if (charged && a->fc >= 5 && a->fc <= 8 && fcAttackerTrigger(a, mv)) {
    int ns = 0;
    if (a->fc == 5) ns = ((double)a->hp / (double)a->hpMax > 0.5) ? 1 : 2;
    else if (a->fc == 8) ns = 1;
    if (a->form != ns) changeForm(a, d, ns);
  }
  if (charged && d->kind == 3 && d->form >= 1 && !defenderUsedShield && !mv->instant) {
    s->ins.actor = di; s->ins.type = 1; s->ins.turn = s->turns;
    s->ins.value = d->form == 1 ? 100 : 101;
    s->ins.prio = d->priority;
    s->hasIns = 1;
  }
  if (charged && d->fc == 3 && d->form != 1 && !defenderUsedShield && !mv->instant) changeForm(d, a, 1);
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
      PROF_T0
      int mv = decideAction(p, o, s->turns, queuedFast, &s->flags, &s->poolMax, 0);
      PROF_T1(1)
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
  QA ta[10];
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
    s->hasIns = 0;
    if (a.type == 1) anyCharged = 1;
    Mon* p = &s->m[a.actor];
    Mon* o = &s->m[1 - a.actor];
    bool valid = false;
    if (a.type == 0) {
      valid = true;
      if (o->hp < 1) valid = false;
      if (p->hp < 1 && p->faintSource == 2) valid = false;
    } else {
      Move* mv = chargedOf(&s->gm, p, a.value);
      if (p->energy >= mv->energy) valid = true;
      if (s->usePriority && p->hp <= 0 && p->faintSource == 2 && a.value < 100) valid = false;   // Gulp Missile ignoresFaint
    }
    if (!valid) continue;
    if (a.type == 0) {
      useMove(s, a.actor, 1 - a.actor, -1);
    } else {
      if (p->energy >= chargedOf(&s->gm, p, a.value)->energy) {
        useMove(s, a.actor, 1 - a.actor, a.value);
        s->roundCMU++;
      }
    }
    if (s->hasIns) {   // turnActions.splice(actionIndex, 0, action): right after the current action
      for (int x = nt; x > k + 1; x--) ta[x] = ta[x - 1];
      ta[k + 1] = s->ins; nt++;
      s->hasIns = 0;
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
  s->usePriority = s->m[0].atk != s->m[1].atk || (s->m[0].kind == 3 && s->m[1].kind == 3);   // Battle.js 257
  s->time = 0;
  s->turns = 1;
  s->nq = 0;
  s->prevCharged = 0;
  s->draws = 0;
  while (true) {
    prof_site(1);
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
    loadMon(&s.m[i], srow, dyn + ((long long)t * 2 + i) * D_N, i, st);
  }
  int* o = out + (long long)t * OUT_N;
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
