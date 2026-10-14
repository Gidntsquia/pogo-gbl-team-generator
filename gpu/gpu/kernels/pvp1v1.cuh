// CUDA port of pvpoke's 1v1 `Battle.simulate()` (simulate mode, sandbox=false, buffChanceModifier=-1)
// as TrainingAI.runScenario uses it. One battle per thread.
//
// Vendor sources ported (vendor/pvpoke/src/js/):
//   battle/Battle.js        start 215-262, step 268-606, simulate 612-668, getTurnAction 697-775, processAction 842-1013,
//                           useMove 1016-1650
//   battle/DamageCalculator.js  damage()
//   battle/actions/ActionLogic.js  decideAction 6-1032, wouldShield 1154-1264
//   pokemon/Pokemon.js      reset 1924-1937, resetMoves 711-878, initializeMove 880-912, getStab 701-708,
//                           applyStatBuffs 2085, getEffectiveStat 2099, getStatBuffMultiplier 2121, getBattleRating 2142
// REAL is double for the logic-exactness build and float for the float32 build.
// Not ported (flagged in `flags`): form-changing mons (Aegislash, Mimikyu, Cramorant, Morpeko, ...).

#ifndef REAL
#define REAL float
#endif

#define M_N 25
#define S_N 130
#define D_N 15
#ifndef MAXQ
#define MAXQ 1536    // DP pool / queue capacity (overflow flagged)
#endif
#define MAXMV 48     // planned-move list capacity

#define F_UNSUPPORTED 1
#define F_POOL_OVERFLOW 2
#define F_STACK_OVERFLOW 4
#define F_MOVES_OVERFLOW 8
#define F_TIMEOUT 16

#define K_STAB ((REAL)1.2000000476837158203125)
#define K_SE ((REAL)1.60000002384185791015625)
#define K_BONUS ((REAL)1.2999999523162841796875)

struct Move {
  int present, power, energy, gain, cd, turns, type, pct, megaMove, hasBuffs, b0, b1, target;
  int bs0, bs1, bo0, bo1, selfDeb, selfBuf, selfAtkDeb, selfDefDeb, instant, code;
  REAL chance;
  REAL stab, dpe, meter;
  int damage;
  int meterDefined;
};

struct Mon {
  REAL atk, def;
  int hpMax, t0, t1, shadow;
  REAL sAtk, sDef;
  REAL eff[18];
  int special, mega, megaLevel, formChange;
  Move fast;
  Move ch[3];
  int startHp, startEnergy, startCd, startShields, ssb0, ssb1, nsb0, nsb1, priority, turnsToKO, bait, farm, opt, e_sb0, e_sb1;
  // runtime
  int hp, energy, cooldown, shields, sb0, sb1, hasActed, faintSource, index;
  int csi, shUsed;  // chargedSinceSwitchIn (throw-and-go wrapper), battleStats.shieldsUsed (3v3 only)
  int act[3], nact, best, fastest;
};

__device__ __forceinline__ int imin(int a, int b) { return a < b ? a : b; }
__device__ __forceinline__ int imax(int a, int b) { return a > b ? a : b; }
// Math.ceil(a / b) for integer a and b > 0
__device__ __forceinline__ int ceilDiv(int a, int b) { return a >= 0 ? (a + b - 1) / b : -((-a) / b); }

__device__ void loadMove(Move* m, const double* r) {
  m->present = (int)r[0]; m->power = (int)r[1]; m->energy = (int)r[2]; m->gain = (int)r[3]; m->cd = (int)r[4];
  m->turns = (int)r[5]; m->type = (int)r[6]; m->pct = (int)r[7]; m->megaMove = (int)r[8]; m->hasBuffs = (int)r[9];
  m->b0 = (int)r[10]; m->b1 = (int)r[11]; m->target = (int)r[12]; m->bs0 = (int)r[13]; m->bs1 = (int)r[14];
  m->bo0 = (int)r[15]; m->bo1 = (int)r[16]; m->chance = (REAL)r[17]; m->selfDeb = (int)r[18]; m->selfBuf = (int)r[19];
  m->selfAtkDeb = (int)r[20]; m->selfDefDeb = (int)r[21]; m->instant = (int)r[22]; m->code = (int)r[23];
  m->stab = 1; m->dpe = 0; m->meter = 0; m->damage = 0; m->meterDefined = 0;
}

__device__ void loadMon(Mon* p, const double* s, const double* d, int index) {
  p->atk = (REAL)s[0]; p->def = (REAL)s[1]; p->hpMax = (int)s[2]; p->t0 = (int)s[3]; p->t1 = (int)s[4];
  p->shadow = (int)s[5]; p->sAtk = (REAL)s[6]; p->sDef = (REAL)s[7];
  for (int i = 0; i < 18; i++) p->eff[i] = (REAL)s[8 + i];
  p->special = (int)s[26]; p->mega = (int)s[27]; p->megaLevel = (int)s[28]; p->formChange = (int)s[29];
  loadMove(&p->fast, s + 30);
  for (int k = 0; k < 3; k++) loadMove(&p->ch[k], s + 30 + M_N * (1 + k));
  p->startHp = (int)d[0]; p->startEnergy = (int)d[1]; p->startCd = (int)d[2]; p->startShields = (int)d[3];
  p->ssb0 = (int)d[4]; p->ssb1 = (int)d[5]; p->nsb0 = (int)d[6]; p->nsb1 = (int)d[7]; p->priority = (int)d[8];
  p->turnsToKO = (int)d[9]; p->bait = (int)d[10]; p->farm = (int)d[11]; p->opt = (int)d[12];
  p->e_sb0 = (int)d[13]; p->e_sb1 = (int)d[14];
  p->index = index; p->hasActed = 0; p->faintSource = 0; p->csi = 0; p->shUsed = 0;
  p->hp = p->startHp; p->energy = p->startEnergy; p->cooldown = p->startCd; p->shields = p->startShields;
  p->sb0 = p->e_sb0; p->sb1 = p->e_sb1;
  p->nact = 0; p->best = -1; p->fastest = -1;
}

// ------------------------------------------------------------------ stats and damage

__device__ __forceinline__ REAL buffMult(int s) {
  return s > 0 ? (REAL)(4 + s) / (REAL)4 : (REAL)4 / (REAL)(4 - s);
}
__device__ __forceinline__ REAL effStat(const Mon* p, int idx) {
  REAL m = buffMult(idx == 0 ? p->sb0 : p->sb1);
  if (p->shadow) m *= (idx == 0 ? p->sAtk : p->sDef);
  return (idx == 0 ? p->atk : p->def) * m;
}
__device__ __forceinline__ int clampBuff(int v) { return v > 4 ? 4 : (v < -4 ? -4 : v); }
__device__ __forceinline__ void applyBuffs(Mon* p, int a, int d) {
  p->sb0 = clampBuff(p->sb0 + a);
  p->sb1 = clampBuff(p->sb1 + d);
}

__device__ int calcDamage(const Mon* a, const Mon* d, const Move* m) {
  if (m->pct) return (int)floor(((REAL)m->power / (REAL)100) * (REAL)d->hpMax) + 1;
  REAL eff = d->eff[m->type];
  REAL atk = effStat(a, 0);
  REAL def = effStat(d, 1);
  REAL mega = (REAL)1;
  if (a->mega && m->megaMove) {
    const REAL tbl[4] = {(REAL)1, (REAL)1.10000002384185791015625, (REAL)1.2000000476837158203125, (REAL)1.2999999523162841796875};
    mega = tbl[a->megaLevel - 1];
  }
  REAL v = (REAL)m->power * m->stab;
  v = v * (atk / def);
  v = v * eff;
  v = v * (REAL)1;
  v = v * mega;
  v = v * (REAL)0.5;
  v = v * K_BONUS;
  return (int)floor(v) + 1;
}

// ------------------------------------------------------------------ move setup (Pokemon.js)

__device__ void initializeMove(Mon* self, const Mon* opp, Move* m) {
  m->stab = (m->type == self->t0 || m->type == self->t1) ? K_STAB : (REAL)1;
  m->damage = calcDamage(self, opp, m);
  if (m->energy > 0) {
    m->dpe = (REAL)m->damage / (REAL)m->energy;
    if (m->hasBuffs) {
      REAL buffEffect = 0;
      if (m->target == 1 && m->b0 > 0) buffEffect = (REAL)m->b0 * ((REAL)80 / (REAL)m->energy);
      else if (m->target == 2 && m->b1 < 0) buffEffect = (REAL)abs(m->b1) * ((REAL)80 / (REAL)m->energy);
      REAL multiplier = 1;
      if (buffEffect > 0) multiplier = ((REAL)4 + buffEffect * m->chance) / (REAL)4;
      m->dpe *= multiplier;
    }
  }
}

__device__ void rotateAct(Mon* p) {
  int f = p->act[0];
  for (int i = 1; i < p->nact; i++) p->act[i - 1] = p->act[i];
  p->act[p->nact - 1] = f;
}

__device__ void resetMoves(Mon* p, const Mon* opp) {
  initializeMove(p, opp, &p->fast);
  for (int k = 0; k < 3; k++) if (p->ch[k].present) initializeMove(p, opp, &p->ch[k]);
  p->nact = 0;
  p->best = -1;
  p->fastest = -1;
  for (int k = 0; k < 3; k++) {
    if (!p->ch[k].present) continue;
    Move* m = &p->ch[k];
    m->meterDefined = 0;
    if (m->hasBuffs && m->chance < (REAL)1) {
      m->meter = m->chance;
      m->meterDefined = 1;
      if (m->chance == (REAL)0.5) m->meter = 0;
    }
    p->act[p->nact++] = k;
  }
  if (p->nact == 0) return;
  // stable sort ascending by energy
  for (int i = 1; i < p->nact; i++) {
    int v = p->act[i];
    int j = i - 1;
    while (j >= 0 && p->ch[p->act[j]].energy > p->ch[v].energy) { p->act[j + 1] = p->act[j]; j--; }
    p->act[j + 1] = v;
  }
  p->fastest = p->act[0];
  if (p->nact > 1) {
    for (int i = 1; i < p->nact; i++) {
      Move* a0 = &p->ch[p->act[0]];
      Move* ai = &p->ch[p->act[i]];
      if (ai->energy == a0->energy && !ai->selfDeb) {
        if (ai->hasBuffs || ai->damage > a0->damage) rotateAct(p);
      }
      a0 = &p->ch[p->act[0]]; ai = &p->ch[p->act[i]];
      if (ai->energy == a0->energy && a0->hasBuffs && ai->hasBuffs && !ai->selfDeb && a0->hasBuffs && ai->chance > a0->chance) rotateAct(p);
      a0 = &p->ch[p->act[0]]; ai = &p->ch[p->act[i]];
      if (a0->code == 1 /*FOCUS_BLAST*/ && ai->code == 2 /*ZAP_CANNON*/) {
        if (ai->dpe - a0->dpe > (REAL)(-0.3)) {
          a0->hasBuffs = 1; a0->b0 = 0; a0->b1 = 0; a0->target = 1; a0->selfDeb = 1;
        } else {
          a0->hasBuffs = 0; a0->target = 0; a0->selfDeb = 0;
        }
      }
      a0 = &p->ch[p->act[0]]; ai = &p->ch[p->act[i]];
      if (ai->energy - a0->energy <= 10 && !ai->selfDeb) {
        if (ai->selfBuf && a0->dpe - ai->dpe < (REAL)0.3) rotateAct(p);
      }
      a0 = &p->ch[p->act[0]]; ai = &p->ch[p->act[i]];
      if (ai->energy - a0->energy <= 10 && a0->selfAtkDeb && !ai->selfDeb) rotateAct(p);
      a0 = &p->ch[p->act[0]]; ai = &p->ch[p->act[i]];
      if (ai->energy - a0->energy <= 10 && a0->selfDeb && a0->energy > 50 && !ai->selfDeb) rotateAct(p);
      a0 = &p->ch[p->act[0]]; ai = &p->ch[p->act[i]];
      if (ai->energy - a0->energy <= 5 && ai->selfBuf) rotateAct(p);
    }
  }
  p->best = p->act[0];
  Move* b = &p->ch[p->best];
  b->dpe = (REAL)b->damage / (REAL)b->energy;
  for (int i = 0; i < p->nact; i++) {
    Move* m = &p->ch[p->act[i]];
    b = &p->ch[p->best];
    m->dpe = (REAL)m->damage / (REAL)m->energy;
    if (((m->dpe - b->dpe > (REAL)0.03) && m->code != 4 /*SUPER_POWER*/) || (m->dpe - b->dpe > (REAL)0.3)) {
      if (!b->selfBuf || (b->selfBuf && m->dpe - b->dpe > (REAL)0.3)) { p->best = p->act[i]; b = &p->ch[p->best]; }
    }
    REAL diff = m->dpe - b->dpe;
    if (fabs(diff) < (REAL)0.03 && b->hasBuffs && m->hasBuffs && m->chance > b->chance && !m->selfDeb) { p->best = p->act[i]; b = &p->ch[p->best]; }
    if (p->ch[p->act[i]].code == 3 /*OBSTRUCT*/) { p->best = p->act[i]; b = &p->ch[p->best]; }
  }
  Move* a0 = &p->ch[p->act[0]];
  b = &p->ch[p->best];
  if (a0->code == 3 && a0->energy - b->energy <= 5 && a0->dpe / b->dpe > (REAL)0.2) p->best = p->act[0];
}

__device__ void resetMon(Mon* p, const Mon* opp) {
  p->hp = p->startHp;
  p->energy = p->startEnergy;
  p->cooldown = p->startCd;
  p->shields = p->startShields;
  p->sb0 = p->ssb0; p->sb1 = p->ssb1;
  p->faintSource = 0;
  applyBuffs(p, p->nsb0, p->nsb1);
  resetMoves(p, opp);
}

// ------------------------------------------------------------------ ActionLogic

// Math.floor-free helpers for the shield decision
__device__ bool wouldShield(const Mon* attacker_c, const Mon* defender_c, Move* move, Mon* attacker, Mon* defender) {
  (void)attacker_c; (void)defender_c;
  bool useShield = false;
  int damage = calcDamage(attacker, defender, move);
  move->damage = damage;
  int postMoveHP = defender->hp - damage;
  int mb0 = 0, mb1 = 0;
  if (move->hasBuffs) { mb0 = move->b0; mb1 = move->b1; }
  int c0, c1;
  if (mb0 > 0) { c0 = attacker->sb0; c1 = attacker->sb1; applyBuffs(attacker, mb0, mb1); }
  else { c0 = defender->sb0; c1 = defender->sb1; applyBuffs(defender, mb0, mb1); }
  int fastDamage = calcDamage(attacker, defender, &attacker->fast);
  int fastAttacks = ceilDiv(move->energy - imax(attacker->energy - move->energy, 0), attacker->fast.gain) + 1;
  int fastAttackDamage = fastAttacks * fastDamage;
  int cycleDamage = (fastAttackDamage + 1) * defender->shields;
  if (postMoveHP <= cycleDamage) useShield = true;
  if (mb0 > 0) { attacker->sb0 = c0; attacker->sb1 = c1; }
  else { defender->sb0 = c0; defender->sb1 = c1; }
  REAL fastDPT = (REAL)fastDamage / (REAL)attacker->fast.turns;
  for (int i = 0; i < 3; i++) {
    if (!attacker->ch[i].present) continue;
    Move* cm = &attacker->ch[i];
    if (attacker->energy + cm->energy >= cm->energy) {
      int chargedDamage = calcDamage(attacker, defender, cm);
      if ((REAL)chargedDamage >= (REAL)defender->hp / (REAL)1.4 && fastDPT > (REAL)1.5) useShield = true;
      if (chargedDamage >= defender->hp - cycleDamage) useShield = true;
    }
  }
  if (move->selfAtkDeb && ((REAL)move->damage / (REAL)defender->hp > (REAL)0.55)) useShield = true;
  if (attacker->bait == 2) useShield = true;
  return useShield;
}

struct BState { int energy, oppHealth, turn, oppShields, buffs, link, mv; };
struct TState { int hp, opEnergy, turn, shields; };

__device__ int movesOf(const BState* pool, int s, int* out) {
  // returns count; moves in order of use
  int tmp[MAXMV + 4];
  int n = 0;
  int cur = s;
  while (cur >= 0) {
    if (pool[cur].mv >= 0) { if (n < MAXMV + 4) tmp[n] = pool[cur].mv; n++; }
    cur = pool[cur].link;
  }
  if (n > MAXMV) n = MAXMV;
  for (int i = 0; i < n; i++) out[i] = tmp[n - 1 - i];
  return n;
}

// returns charged-move index to throw, or -1 for a fast move
__device__ __noinline__ int decideAction(Mon* poke, Mon* opp, int turns, int queuedFastOfPoke, int* flags, int* poolMax) {
  bool winsCMP = poke->atk >= opp->atk;
  int fastDamage = calcDamage(poke, opp, &poke->fast);
  int oppFastDamage = calcDamage(opp, poke, &opp->fast);
  bool hasNonDebuff = false;
  if (poke->nact < 1) return -1;
  if (poke->energy < poke->ch[poke->fastest].energy || poke->farm) return -1;
  int ready[3];
  for (int n = 0; n < poke->nact; n++) {
    Move* m = &poke->ch[poke->act[n]];
    if (!m->selfDeb) hasNonDebuff = true;
    if (poke->energy >= m->energy) ready[n] = 0;
    else ready[n] = ceilDiv(m->energy - poke->energy, poke->fast.gain) * poke->fast.turns;
  }
  const int INF = 100000;
  int turnsToLive = INF;
  TState st[96];
  int sp = 0;
  if (opp->cooldown != 0) {
    st[sp++] = TState{poke->hp - oppFastDamage, opp->energy + opp->fast.gain, opp->cooldown / 500, poke->shields};
  } else {
    st[sp++] = TState{poke->hp, opp->energy, 0, poke->shields};
  }
  while (sp != 0) {
    TState cs = st[--sp];
    if (cs.hp > oppFastDamage) {
      if (winsCMP) { if (cs.turn > poke->fast.turns) continue; }
      else { if (cs.turn > poke->fast.turns + 1) continue; }
    }
    if (cs.shields != 0) {
      if (cs.opEnergy >= opp->ch[opp->fastest].energy) {
        if (sp >= 94) { *flags |= F_STACK_OVERFLOW; return -1; }
        st[sp++] = TState{cs.hp - 1, cs.opEnergy - opp->ch[opp->fastest].energy, cs.turn + 1, cs.shields - 1};
      }
    } else {
      for (int n = 0; n < opp->nact; n++) {
        Move* om = &opp->ch[opp->act[n]];
        if (cs.opEnergy >= om->energy) {
          int moveDamage = calcDamage(opp, poke, om);
          if (moveDamage >= cs.hp) {
            turnsToLive = imin(cs.turn, turnsToLive);
            if (poke->atk > opp->atk && opp->fast.cd % poke->fast.cd == 0) turnsToLive++;
            break;
          }
          if (sp >= 94) { *flags |= F_STACK_OVERFLOW; return -1; }
          st[sp++] = TState{cs.hp - moveDamage, cs.opEnergy - om->energy, cs.turn + 1, cs.shields};
        }
      }
    }
    if (cs.hp - oppFastDamage <= 0) {
      turnsToLive = imin(cs.turn + opp->fast.turns, turnsToLive);
      break;
    } else {
      if (sp >= 94) { *flags |= F_STACK_OVERFLOW; return -1; }
      st[sp++] = TState{cs.hp - oppFastDamage, cs.opEnergy + opp->fast.gain, cs.turn + opp->fast.turns, cs.shields};
    }
  }
  // turnsToLive != -1 is always true in JS
  if (poke->hp <= opp->fast.damage * 2 && opp->fast.cd == 500) turnsToLive--;
  if (poke->hp <= opp->fast.damage && opp->cooldown > 0 && opp->fast.cd > 500) {
    turnsToLive = opp->cooldown / 500;
    if (opp->hp > poke->fast.damage) turnsToLive--;
  }
  if (poke->hp <= opp->fast.damage && opp->cooldown == 0 && opp->fast.cd <= poke->fast.cd + 500) {
    if (opp->hp > poke->fast.damage) turnsToLive--;
  }
  if (turnsToLive * 500 < poke->fast.cd || (turnsToLive * 500 == poke->fast.cd && !winsCMP) ||
      (turnsToLive * 500 == poke->fast.cd && poke->hp <= opp->fast.damage)) {
    int maxIdx = 0;
    int prevDamage = -1;
    for (int n = poke->nact - 1; n >= 0; n--) {
      if (ready[n] == 0) {
        Move* m = &poke->ch[poke->act[n]];
        int moveDamage = calcDamage(poke, opp, m);
        if (moveDamage > prevDamage) { maxIdx = poke->act[n]; prevDamage = moveDamage; }
        if (poke->energy >= m->energy * 2 && poke->atk > opp->atk && moveDamage * 2 > prevDamage) {
          maxIdx = poke->act[n]; prevDamage = moveDamage * 2;
        }
      }
    }
    if (prevDamage == -1) return -1;
    return maxIdx;
  }
  // lethal charged move
  if (!poke->farm && opp->shields == 0) {
    for (int n = 0; n < poke->nact; n++) {
      Move* m = &poke->ch[poke->act[n]];
      int moveIndex = poke->act[n];
      if (poke->energy >= m->energy) {
        int moveDamage = calcDamage(poke, opp, m);
        if (opp->hp <= moveDamage && !m->selfDeb && (n == 0 || (n == 1 && !poke->bait)) && opp->hp > poke->fast.damage) return moveIndex;
      }
    }
  }
  // optimize move timing
  if (poke->opt) {
    int targetCooldown = 500;
    if (poke->fast.cd >= 2000) targetCooldown = 1000;
    if (poke->fast.cd >= 1500 && opp->fast.cd == 2500) targetCooldown = 1000;
    if (poke->fast.cd == 1000 && opp->fast.cd == 2000) targetCooldown = 1000;
    if (poke->fast.cd == opp->fast.cd) targetCooldown = 0;
    if (poke->fast.cd % opp->fast.cd == 0 && poke->fast.cd > opp->fast.cd) targetCooldown = 0;
    if ((opp->cooldown == 0 || opp->cooldown > targetCooldown) && targetCooldown > 0) {
      bool optimizeTiming = true;
      if (poke->hp <= opp->fast.damage) optimizeTiming = false;
      int queuedFastMoves = queuedFastOfPoke + 1;
      if (poke->energy + poke->fast.gain * queuedFastMoves > 100) optimizeTiming = false;
      int turnsPlanned = poke->fast.turns + (poke->energy / poke->ch[poke->act[0]].energy);
      if (poke->atk < opp->atk) turnsPlanned++;
      if (turnsPlanned > turnsToLive) optimizeTiming = false;
      if (opp->shields == 0) {
        for (int n = 0; n < poke->nact; n++) {
          Move* m = &poke->ch[poke->act[n]];
          m->damage = calcDamage(poke, opp, m);
          if (poke->energy >= m->energy && m->damage >= opp->hp) { optimizeTiming = false; break; }
        }
      }
      for (int n = 0; n < opp->nact; n++) {
        Move* om = &opp->ch[opp->act[n]];
        int fastMovesFromCharged = ceilDiv(om->energy - opp->energy, opp->fast.gain);
        int fastMovesInFastMove = poke->fast.cd / opp->fast.cd;
        int turnsFromMove = fastMovesFromCharged * opp->fast.turns + 1;
        om->damage = calcDamage(opp, poke, om);
        int moveDamage = om->damage + opp->fast.damage * fastMovesInFastMove;
        if (poke->shields > 0) moveDamage = 1 + opp->fast.damage * fastMovesInFastMove;
        if (turnsFromMove <= poke->fast.turns && moveDamage >= poke->hp) { optimizeTiming = false; break; }
      }
      int fastMovesInFastMove2 = (poke->fast.cd + 500) / opp->fast.cd;
      if (poke->hp <= opp->fast.damage * fastMovesInFastMove2) optimizeTiming = false;
      if (optimizeTiming) return -1;
    }
  }
  // simple selection when a KO is many cycles away
  int bestChargedDamage = calcDamage(poke, opp, &poke->ch[poke->best]);
  Move* bm = &poke->ch[poke->best];
  int bestCycleDamage = bestChargedDamage + fastDamage * ceilDiv(bm->energy, poke->fast.gain);
  REAL minimumCycleThreshold = 2;
  if (bm->selfDeb && bm->energy > poke->ch[poke->fastest].energy && bm->dpe / poke->ch[poke->fastest].dpe < (REAL)2) minimumCycleThreshold = (REAL)1.1;
  if ((REAL)opp->hp / (REAL)bestCycleDamage > minimumCycleThreshold) {
    int selected = poke->best;
    if (poke->nact > 1) {
      for (int i = 0; i < poke->nact; i++) {
        Move* b2 = &poke->ch[poke->best];
        Move* ai = &poke->ch[poke->act[i]];
        if (b2->selfDeb && !ai->selfDeb && (poke->ch[selected].dpe / ai->dpe < (REAL)2)) selected = poke->act[i];
        if (poke->bait && opp->shields > 0 && !poke->ch[poke->act[0]].selfDeb &&
            wouldShield(poke, opp, &poke->ch[poke->act[i]], poke, opp)) selected = poke->act[0];
      }
    }
    if (poke->energy < poke->ch[selected].energy) return -1;
    if (poke->ch[selected].selfDeb) {
      int energyToReach = poke->energy + ((100 - poke->energy) / poke->fast.gain) * poke->fast.gain;
      if (poke->energy < energyToReach) return -1;
    }
    return selected;
  }

  // dynamic programming over throw plans
  BState pool[MAXQ];
  int queue[MAXQ];
  int qn = 0, pn = 0;
  int stateCount = 0;
  int finalState = -1;
  pool[pn] = BState{poke->energy, opp->hp, 0, opp->shields, 0, -1, -1};
  queue[qn++] = pn++;
  while (qn != 0) {
    if (stateCount >= 500) return -1;
    stateCount++;
    int cur = queue[0];
    for (int x = 1; x < qn; x++) queue[x - 1] = queue[x];
    qn--;
    BState* cs = &pool[cur];
    cs->buffs = imin(4, cs->buffs);
    cs->buffs = imax(-4, cs->buffs);
    if (cs->oppHealth <= 0) { finalState = cur; break; }
    int dready[3];
    for (int n = 0; n < poke->nact; n++) {
      Move* m = &poke->ch[poke->act[n]];
      if (cs->energy >= m->energy) dready[n] = 0;
      else dready[n] = ceilDiv(m->energy - cs->energy, poke->fast.gain) * poke->fast.turns;
    }
    for (int n = 0; n < poke->nact; n++) {
      Move* am = &poke->ch[poke->act[n]];
      cs = &pool[cur];
      int sb0s = poke->sb0, sb1s = poke->sb1;
      applyBuffs(poke, cs->buffs, 0);
      int moveDamage = calcDamage(poke, opp, am);
      int fastSimDamage = calcDamage(poke, opp, &poke->fast);
      poke->sb0 = sb0s; poke->sb1 = sb1s;
      if (hasNonDebuff && poke->special == 1 && opp->special == 2) {
        if (am->selfDeb && am->b1 < 1 && (REAL)opp->hp > (REAL)moveDamage * ((REAL)1 + (REAL)4 / ((REAL)4 - (REAL)am->b0))) continue;
      }
      // farm-down state
      int movesToFarmDown = ceilDiv(cs->oppHealth, fastSimDamage);
      int farmTurn = cs->turn + movesToFarmDown * poke->fast.turns;
      if (pn >= MAXQ) { *flags |= F_POOL_OVERFLOW; return -1; }
      {
        int i = 0;
        if (qn != 0) {
          while (pool[queue[i]].turn <= farmTurn) { i++; if (i == qn) break; }
        }
        pool[pn] = BState{cs->energy + poke->fast.gain * movesToFarmDown, 0, farmTurn, cs->oppShields, cs->buffs, cur, -1};
        for (int x = qn; x > i; x--) queue[x] = queue[x - 1];
        queue[i] = pn++;
        qn++;
      }
      cs = &pool[cur];
      int attackMult = cs->buffs;
      if (am->chance > 0 && am->target == 1) {
        if (am->chance == (REAL)1) attackMult += am->b0;
      }
      if (am->chance > 0 && am->target == 2) {
        if (am->chance == (REAL)1) attackMult -= am->b1;
      }
      if (dready[n] == 0) {
        int newOppHealth = cs->oppHealth - moveDamage;
        if (cs->oppShields > 0) newOppHealth = cs->oppHealth - 1;
        int newShields = cs->oppShields;
        if (newShields > 0) newShields--;
        int i = 0;
        bool insertElement = true;
        while (i < qn && pool[queue[i]].turn == cs->turn + 1) {
          BState* q = &pool[queue[i]];
          if (q->oppHealth == newOppHealth && q->buffs == attackMult) {
            if (q->energy == (cs->energy - am->energy)) {
              int DPDebuffs = 0, currDebuffs = 0;
              int mv[MAXMV];
              int cnt = movesOf(pool, queue[i], mv);
              for (int x = 0; x < cnt; x++) {
                Move* mm = &poke->ch[mv[x]];
                if (mm->selfDeb) DPDebuffs++;
                if (mm->chance == (REAL)1 && mm->target == 1 && mm->b0 + mm->b1 > 0) DPDebuffs--;
              }
              int cnt2 = movesOf(pool, cur, mv);
              for (int x = 0; x < cnt2; x++) {
                Move* mm = &poke->ch[mv[x]];
                if (mm->selfDeb) currDebuffs++;
                if (mm->chance == (REAL)1 && mm->target == 1 && mm->b0 + mm->b1 > 0) currDebuffs--;
              }
              if (am->selfDeb) currDebuffs++;
              if (am->chance == (REAL)1 && am->target == 1 && am->b0 + am->b1 > 0) currDebuffs--;
              if (DPDebuffs > currDebuffs) {
                for (int x = i + 1; x < qn; x++) queue[x - 1] = queue[x];
                qn--;
              } else { insertElement = false; i++; }
            } else { insertElement = false; i++; }
          } else { i++; }
        }
        if (insertElement) {
          i = 0;
          while (i < qn && pool[queue[i]].turn <= cs->turn + 1) { i++; }
          if (pn >= MAXQ) { *flags |= F_POOL_OVERFLOW; return -1; }
          pool[pn] = BState{cs->energy - am->energy, newOppHealth, cs->turn + 1, newShields, attackMult, cur, poke->act[n]};
          for (int x = qn; x > i; x--) queue[x] = queue[x - 1];
          queue[i] = pn++;
          qn++;
        }
        if (am->selfDeb && am->b0 < 0 && am->energy * 2 <= 100) {
          int newTurn = ceilDiv(am->energy * 2 - cs->energy, poke->fast.gain) * poke->fast.turns;
          int newEnergy = (newTurn / poke->fast.turns) * poke->fast.gain + cs->energy - am->energy;
          if (newTurn != 0) {
            int nh = cs->oppHealth - fastSimDamage * (newTurn / poke->fast.turns);
            if (cs->oppShields > 0) nh = nh - 1; else nh = nh - moveDamage;
            newTurn += cs->turn + 1;
            int j = 0;
            while (j < qn && pool[queue[j]].turn <= newTurn) { j++; }
            if (pn >= MAXQ) { *flags |= F_POOL_OVERFLOW; return -1; }
            pool[pn] = BState{newEnergy, nh, newTurn, newShields, attackMult, cur, poke->act[n]};
            for (int x = qn; x > j; x--) queue[x] = queue[x - 1];
            queue[j] = pn++;
            qn++;
          }
        }
      } else {
        int newEnergy = cs->energy - am->energy + poke->fast.gain * (dready[n] / poke->fast.turns);
        int newOppHealth = cs->oppHealth - moveDamage - fastSimDamage * (dready[n] / poke->fast.turns);
        if (cs->oppShields > 0) newOppHealth = cs->oppHealth - fastSimDamage * (dready[n] / poke->fast.turns) - 1;
        int newTurn = cs->turn + dready[n] + 1;
        int newShields = cs->oppShields;
        if (newShields > 0) newShields--;
        {
          int i = 0;
          while (i < qn && pool[queue[i]].turn < newTurn) { i++; }
          if (pn >= MAXQ) { *flags |= F_POOL_OVERFLOW; return -1; }
          pool[pn] = BState{newEnergy, newOppHealth, newTurn, newShields, attackMult, cur, poke->act[n]};
          for (int x = qn; x > i; x--) queue[x] = queue[x - 1];
          queue[i] = pn++;
          qn++;
        }
        if (am->selfDeb && am->b0 < 0 && am->energy * 2 <= 100) {
          newTurn = ceilDiv(am->energy * 2 - cs->energy, poke->fast.gain) * poke->fast.turns;
          newEnergy = (newTurn / poke->fast.turns) * poke->fast.gain + cs->energy - am->energy;
          newOppHealth = cs->oppHealth - fastSimDamage * (newTurn / poke->fast.turns);
          if (cs->oppShields > 0) newOppHealth = newOppHealth - 1; else newOppHealth = newOppHealth - moveDamage;
          newTurn += cs->turn + 1;
          int i = 0;
          while (i < qn && pool[queue[i]].turn < newTurn) { i++; }
          if (pn >= MAXQ) { *flags |= F_POOL_OVERFLOW; return -1; }
          pool[pn] = BState{newEnergy, newOppHealth, newTurn, newShields, attackMult, cur, poke->act[n]};
          for (int x = qn; x > i; x--) queue[x] = queue[x - 1];
          queue[i] = pn++;
          qn++;
        }
      }
    }
  }
  if (pn > *poolMax) *poolMax = pn;
  if (finalState < 0) return -1;
  poke->turnsToKO = turns + pool[finalState].turn;

  int moves[MAXMV];
  int nm = movesOf(pool, finalState, moves);
  if (nm == 0) {
    // farm down plan: use the boost move if there is one
    int boost = -1;
    for (int i = 0; i < 3; i++) {
      Move* m = &poke->ch[i];
      if (m->present && m->hasBuffs && m->chance >= (REAL)0.5 && !m->selfDeb) boost = i;
    }
    if (boost < 0) return -1;
    moves[nm++] = boost;
  }
  bool debuffingMove = false;
  int mostExpensive = moves[0];
  for (int i = 0; i < nm; i++) {
    if (poke->ch[moves[i]].selfDeb) debuffingMove = true;
    if (poke->ch[moves[i]].energy > poke->ch[mostExpensive].energy) mostExpensive = moves[i];
  }
  (void)mostExpensive;
  Move* A0 = &poke->ch[poke->act[0]];
  if (poke->bait && opp->shields > 0 && poke->nact > 1) {
    for (int i = 1; i < poke->nact; i++) {
      Move* ai = &poke->ch[poke->act[i]];
      if (poke->energy < ai->energy && ai->dpe > poke->ch[moves[0]].dpe) {
        bool bait = true;
        if (ai->dpe / A0->dpe <= (REAL)1.5 && A0->selfBuf) bait = false;
        if (bait) return -1;
      }
    }
  }
  if (poke->bait && opp->shields > 0 && poke->nact > 1) {
    for (int i = 1; i < poke->nact; i++) {
      Move* ai = &poke->ch[poke->act[i]];
      Move* m0 = &poke->ch[moves[0]];
      REAL dpeRatio = ((REAL)ai->damage / (REAL)ai->energy) / ((REAL)m0->damage / (REAL)m0->energy);
      if (poke->energy >= ai->energy && dpeRatio > (REAL)1.5) {
        if (!wouldShield(poke, opp, ai, poke, opp)) moves[0] = poke->act[i];
      }
    }
  }
  if (!(poke->bait && false)) {
    if (!poke->bait || (opp->shields == 0 && debuffingMove == false)) {
      // stable insertion sort by damage, descending
      int dmg[MAXMV];
      for (int i = 0; i < nm; i++) dmg[i] = calcDamage(poke, opp, &poke->ch[moves[i]]);
      for (int i = 1; i < nm; i++) {
        int v = moves[i], dv = dmg[i];
        int j = i - 1;
        while (j >= 0 && dv > dmg[j]) { moves[j + 1] = moves[j]; dmg[j + 1] = dmg[j]; j--; }
        moves[j + 1] = v; dmg[j + 1] = dv;
      }
    }
  }
  A0 = &poke->ch[poke->act[0]];
  Move* M0 = &poke->ch[moves[0]];
  if (opp->shields > 0 && poke->nact > 1 && A0->energy <= M0->energy && A0->dpe > M0->dpe && !A0->selfDeb) { moves[0] = poke->act[0]; }
  M0 = &poke->ch[moves[0]];
  if (opp->shields == 0 && poke->nact > 1 && M0->selfDeb && M0->energy > 50 && ((REAL)poke->hp / (REAL)poke->hpMax) > (REAL)0.5 && ((REAL)M0->damage / (REAL)opp->hp) < (REAL)0.8) moves[0] = poke->act[0];
  M0 = &poke->ch[moves[0]];
  if (poke->nact > 1 && A0->energy == M0->energy && A0->dpe > M0->dpe && !A0->selfDeb) moves[0] = poke->act[0];
  M0 = &poke->ch[moves[0]];
  if (poke->nact > 1 && A0->energy - 10 <= M0->energy && A0->dpe > M0->dpe && M0->selfDeb && !A0->selfDeb) moves[0] = poke->act[0];
  M0 = &poke->ch[moves[0]];
  if (poke->nact > 1 && A0->energy - M0->energy <= 5 && A0->dpe > M0->dpe && A0->selfBuf) moves[0] = poke->act[0];
  if (poke->bait && opp->shields > 0 && poke->nact > 1) {
    for (int i = 1; i < poke->nact; i++) {
      Move* ai = &poke->ch[poke->act[i]];
      M0 = &poke->ch[moves[0]];
      if (poke->energy >= ai->energy && ai->dpe > M0->dpe) {
        if (M0->selfDeb && !ai->selfDeb) moves[0] = poke->act[i];
      }
    }
  }
  M0 = &poke->ch[moves[0]];
  if (opp->shields == 0 && poke->nact > 1 && M0->selfDeb) {
    for (int i = 1; i < poke->nact; i++) {
      Move* ai = &poke->ch[poke->act[i]];
      M0 = &poke->ch[moves[0]];
      if (ai->dpe > M0->dpe && !ai->selfDeb) moves[0] = poke->act[i];
    }
  }
  if (opp->shields > 0 && poke->nact > 1) {
    for (int i = 1; i < poke->nact; i++) {
      Move* ai = &poke->ch[poke->act[i]];
      if (A0->selfDeb && !ai->selfDeb) {
        if (poke->bait || (opp->hp - A0->damage > 10)) {
          if (ai->energy - A0->energy <= 10 && ai->dpe / A0->dpe > (REAL)0.7) moves[0] = poke->act[i];
        }
      }
    }
  }
  M0 = &poke->ch[moves[0]];
  if (M0->selfDeb && poke->shields == 0 && poke->energy < 100 && opp->best >= 0) {
    Move* ob = &opp->ch[opp->best];
    if (opp->energy >= ob->energy && !wouldShield(opp, poke, ob, opp, poke) && !A0->selfBuf) return -1;
  }
  M0 = &poke->ch[moves[0]];
  if (M0->selfDeb) {
    int targetEnergy = (100 / M0->energy) * M0->energy;
    if (poke->energy < targetEnergy) {
      int moveDamage = calcDamage(poke, opp, M0);
      if ((opp->hp > moveDamage || opp->shields != 0) && (poke->hp > opp->fast.damage * 2 || opp->fast.cd - poke->fast.cd > 500)) return -1;
    } else if (poke->bait && opp->shields > 0 && A0->energy - M0->energy <= 10 && !A0->selfDeb) {
      if (A0->selfBuf || wouldShield(poke, opp, M0, poke, opp)) moves[0] = poke->act[0];
    }
  }
  if (poke->energy >= poke->ch[moves[0]].energy) return moves[0];
  return -1;
}
