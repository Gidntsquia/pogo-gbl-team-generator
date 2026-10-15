// CUDA port of the full 3v3 battle: pvpoke's emulate-mode Battle.js step loop driven by two TrainingAI instances
// (difficulty 3 "Champion"), plus the engine's own wrappers (src/engine/battle/aiWrappers.js, clockWrappers.js,
// scenarioMemo.js wrapRunScenario) and the seeded mulberry32 stream of src/engine/teamBattle.js.
// One 3v3 battle per thread. Included after pvp1v1.cuh and battle1v1.cuh (the 1v1 simulate() is the AI's lookahead).
//
// Vendor sources ported (vendor/pvpoke/src/js/):
//   battle/Battle.js        setNewPokemon 82-120, start 215-274, step 278-605, getTurnAction 720-788, queueAction 793-837,
//                           processAction 842-1012, useMove 1016-1650 (emulate + sandbox path)
//   training/TrainingAI.js  evaluateMatchup 633-813, runScenario 815-957, chooseOption 971-990, processStrategy 992-1020,
//                           decideAction 1030-1129, decideSwitch 1131-1179, decideShield 1181-1378, calculatePotentialDamage 1380-1404
//   pokemon/Player.js       decrementSwitchTimer 108, getRemainingPokemon 163
// Engine wrappers re-implemented: wrapThrowAndGo (aiWrappers.js 140), wrapShieldBanking (325), wrapSwitchCost (415),
//   wrapBattleClock (clockWrappers.js 40), p0.decrementSwitchTimer override and battle.forceSwitch override (teamBattle.js 288-340).
// AI decision arithmetic runs in double in both builds; only the battle simulation uses REAL.
// Form changers (Aegislash, Mimikyu, Cramorant, Morpeko) are ported; difficulty != 3 is not (the engine only uses Champion).

#define F_GUARD 32          // turn loop guard tripped
#define F_BADSTATE 64       // internal consistency check failed
#define F_INVALID_MASK (F_UNSUPPORTED | F_POOL_OVERFLOW | F_STACK_OVERFLOW | F_MOVES_OVERFLOW | F_GUARD | F_BADSTATE)

// action types
#define A_FAST 0
#define A_CHARGED 1
#define A_SWITCH 2
// phases
#define P_NEUTRAL 0
#define P_SUSPEND_CHARGED 1
#define P_ANIMATING 2
#define P_SUSPEND_SWITCH 3
#define P_GAME_OVER 4
// strategies (TrainingAI option names)
#define ST_NONE (-1)
#define ST_DEFAULT 0
#define ST_SWITCH_BASIC 1
#define ST_SWITCH_FARM 2
#define ST_FARM 3
#define ST_BAIT 4
// scenario types
#define SC_BOTH_BAIT 0
#define SC_NEITHER_BAIT 1
#define SC_NO_BAIT 2
#define SC_FARM 3
// timers
#define K_ANIM 1
#define K_USE 2
#define K_NEUTRAL 3
#define K_FORCE 4
#define K_QSWITCH 5

#define MAXTM 16
#define MAXACT 8

struct Act { int actor, type, turn, value, prio, processed, valid; };
struct Timer { int at, id, kind, a, b, c, d; };
struct Ply { int shields, switchTimer, priority, curStrat, prevStrat, turnLastEval; double noBaitAvg; };

struct B3 {
  Mon mon[6];
  Ply pl[2];
  int act[2];
  int turns, lastProcessed, phase, usePriority;
  Act ta[MAXACT]; int nta;       // turnActions
  Act qa[MAXACT]; int nqa;       // queuedActions
  Act ac[MAXACT]; int nac;       // actions (queueAction)
  int prevCharged;               // previousTurnActions has a charged action
  Timer tm[MAXTM]; int ntm; int nextId; int clock;
  int phActors[2], nPh, phaseTimeout;
  unsigned rng;
  int chargedUsed, lastChargedTurn, roundCharged, roundShield, playerUseShield;
  int flags, innerSims, draws, poolMax, simDraws;
  Sim sc;                        // scratch 1v1 battle for runScenario
  int curAi;                     // Battle.js actionIndex: index of the action after the one being processed
  Move gm;                       // scratch Gulp Missile move
  int* dbg; int ndbg;            // optional event trace (verification aid), null in production
};

// ------------------------------------------------------------------ small helpers

__device__ double rnd(B3* b) {  // mulberry32 (src/engine/battle/virtualClock.js)
  b->rng += 0x6d2b79f5u;
  unsigned a = b->rng;
  unsigned t = (a ^ (a >> 15)) * (1u | a);
  t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
  b->draws++;
  return (double)(t ^ (t >> 14)) / 4294967296.0;
}
__device__ __forceinline__ int jsRound(double x) { return (int)floor(x + 0.5); }  // Math.round
__device__ __forceinline__ int floorDivD(int a, int c) { return (int)floor((double)a / (double)c); }

__device__ int remaining(const B3* b, int p) {
  int n = 0;
  for (int i = 0; i < 3; i++) if (b->mon[p * 3 + i].hp > 0) n++;
  return n;
}
__device__ __forceinline__ int nCharged(const Mon* m) {
  int n = 0;
  for (int k = 0; k < 3; k++) if (m->ch[k].present) n++;
  return n;
}

// chooseOption: bucket of integer weights, ALWAYS one draw. Returns the index of the chosen option.
__device__ int chooseOption(B3* b, const int* w, int n) {
  int total = 0;
  for (int i = 0; i < n; i++) if (w[i] > 0) total += w[i];
  double u = rnd(b);
  if (total == 0) return 0;
  int idx = (int)floor(u * (double)total);
  int acc = 0;
  for (int i = 0; i < n; i++) {
    if (w[i] > 0) acc += w[i];
    if (idx < acc) return i;
  }
  return n - 1;
}

// ------------------------------------------------------------------ scheduler (virtualClock.js makeScheduler)

__device__ int sched(B3* b, int delay, int kind, int a, int bb, int c, int d) {
  if (b->ntm >= MAXTM) { b->flags |= F_BADSTATE; return 0; }
  Timer* t = &b->tm[b->ntm++];
  t->at = b->clock + delay; t->id = b->nextId++; t->kind = kind; t->a = a; t->b = bb; t->c = c; t->d = d;
  return t->id;
}
__device__ void clearTimer(B3* b, int id) {
  for (int i = 0; i < b->ntm; i++) if (b->tm[i].id == id) { b->tm[i] = b->tm[--b->ntm]; return; }
}

// ------------------------------------------------------------------ AI forward declarations

__device__ __noinline__ void evalMatchup(B3* b, int p);
__device__ __noinline__ int decideSwitch(B3* b, int p);
__device__ __noinline__ void forceSwitch(B3* b);
__device__ __noinline__ void queueAction(B3* b, int actor, int type, int value);

// ------------------------------------------------------------------ TrainingAI.runScenario

__device__ __noinline__ double runScenario(B3* b, int type, int gi, int gj) {
  Mon* A = &b->mon[gi];
  Mon* O = &b->mon[gj];
  int sbait0 = A->bait, sfarm0 = A->farm, sprio0 = A->priority;
  int sbait1 = O->bait, sfarm1 = O->farm, sprio1 = O->priority;
  int idx0 = A->index, idx1 = O->index;
  A->startHp = A->hp; A->startEnergy = A->energy; A->ssb0 = A->sb0; A->ssb1 = A->sb1; A->startCd = A->cooldown; A->startShields = A->shields;
  O->startHp = O->hp; O->startEnergy = O->energy; O->ssb0 = O->sb0; O->ssb1 = O->sb1; O->startCd = O->cooldown; O->startShields = O->shields;
  int sh0 = A->startShields, sh1 = O->startShields;
  A->startForm = A->form; O->startForm = O->form;   // TrainingAI.js 831, 838
  switch (type) {
    case SC_BOTH_BAIT: A->bait = 1; A->farm = 0; O->bait = 1; O->farm = 0; break;
    case SC_NEITHER_BAIT: A->bait = 0; A->farm = 0; O->bait = 0; O->farm = 0; break;
    case SC_NO_BAIT: A->bait = 0; A->farm = 0; O->bait = 0; O->farm = 0; break;
    case SC_FARM: A->bait = 1; A->farm = 1; O->bait = 1; O->farm = 0; break;
  }
  Sim* s = &b->sc;
  s->m[0] = *A; s->m[1] = *O;
  s->m[0].index = 0; s->m[1].index = 1;
  const int sw[3] = {4, 4, 1};
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
  double avg = sum / (double)totalWeight;
  s->m[0].startShields = sh0; s->m[1].startShields = sh1;
  s->m[0].startHp = A->startHp; s->m[0].startEnergy = A->startEnergy; s->m[0].startCd = A->startCd;
  s->m[1].startHp = O->startHp; s->m[1].startEnergy = O->startEnergy; s->m[1].startCd = O->startCd;
  resetMon(&s->m[0], &s->m[1]);   // pokemon.reset(), then opponent.reset(): the first sees the other's stale end-of-sim buffs
  resetMon(&s->m[1], &s->m[0]);
  s->m[0].startForm = s->m[0].origForm; s->m[1].startForm = s->m[1].origForm;   // TrainingAI.js 940, 948
  *A = s->m[0]; *O = s->m[1];
  A->index = idx0; O->index = idx1;
  A->bait = sbait0; A->farm = sfarm0; A->priority = sprio0;   // wrapRunScenario restores these
  O->bait = sbait1; O->farm = sfarm1; O->priority = sprio1;
  return avg;
}

// ------------------------------------------------------------------ TrainingAI.decideSwitch / strategy

__device__ void processStrategy(B3* b, int p, int strat) {
  Ply* pl = &b->pl[p];
  pl->prevStrat = pl->curStrat;
  pl->curStrat = strat;
  Mon* pk = &b->mon[b->act[p]];
  switch (strat) {
    case ST_SWITCH_FARM: case ST_FARM: pk->farm = 1; break;
    case ST_DEFAULT: pk->bait = 0; pk->farm = 0; break;
    case ST_BAIT: pk->bait = 1; pk->farm = 0; break;
  }
}

__device__ __noinline__ int decideSwitch(B3* b, int p) {
  Mon* poke = &b->mon[b->act[p]];
  int oppG = b->act[1 - p];
  Ply* opl = &b->pl[1 - p];
  int team[3], w[3], n = 0;
  for (int i = 0; i < 3; i++) {
    int g = p * 3 + i;
    if (b->mon[g].hp > 0 && g != b->act[p]) {
      double avg = runScenario(b, SC_NO_BAIT, g, oppG);
      int weight;
      if (avg < 500) weight = jsRound(pow(avg / 100.0, 4.0) / 20.0);
      else if (opl->switchTimer > 10 || poke->hp <= 0) weight = jsRound(pow((avg - 250.0) / 100.0, 4.0));
      else weight = jsRound(pow((1000.0 - avg) / 100.0, 4.0));
      if (weight < 1) weight = 1;
      team[n] = i; w[n] = weight; n++;
    }
  }
  // BAD_DECISION_PROTECTION: stable sort by weight descending, drop the runner-up when the leader dominates
  for (int i = 1; i < n; i++) {
    int tv = team[i], wv = w[i], j = i - 1;
    while (j >= 0 && wv > w[j]) { team[j + 1] = team[j]; w[j + 1] = w[j]; j--; }
    team[j + 1] = tv; w[j + 1] = wv;
  }
  if (n > 1 && w[0] > w[1] * 4) {
    for (int i = 2; i < n; i++) { team[i - 1] = team[i]; w[i - 1] = w[i]; }
    n--;
  }
  int pick = chooseOption(b, w, n);
  return team[pick];
}

// ------------------------------------------------------------------ TrainingAI.evaluateMatchup

__device__ __noinline__ void evalMatchup(B3* b, int p) {
  Mon* pk = &b->mon[b->act[p]];
  Mon* op = &b->mon[b->act[1 - p]];
  Ply* pl = &b->pl[p];
  Ply* opl = &b->pl[1 - p];
  pk->bait = 1; pk->farm = 0; op->bait = 1; op->farm = 0;
  double bothBait = runScenario(b, SC_BOTH_BAIT, b->act[p], b->act[1 - p]);
  double neitherBait = runScenario(b, SC_NEITHER_BAIT, b->act[p], b->act[1 - p]);
  double noBait = runScenario(b, SC_NO_BAIT, b->act[p], b->act[1 - p]);
  double farm = runScenario(b, SC_FARM, b->act[p], b->act[1 - p]);
  pl->noBaitAvg = noBait;
  double overall = (bothBait + neitherBait + noBait) / 3.0;
  int names[8], w[8], n = 0;
  double totalSwitch = 0;
  int remP = remaining(b, p), remO = remaining(b, 1 - p);
  if (pl->switchTimer == 0 && remP > 1) {
    double thr = 500;
    if (remO > 1) thr = 450;
    int switchWeight = (int)floor(fmax((thr - overall) / 10.0, 0.0));
    bool canCounter = false;
    if (opl->switchTimer > 30000) {
      for (int i = 0; i < 3; i++) {
        int g = p * 3 + i;
        if (b->mon[g].hp > 0 && g != b->act[p]) {
          double rating = runScenario(b, SC_NO_BAIT, g, b->act[1 - p]);
          if (rating - 500 > (fmax(overall, 500.0) - 500) * 1.2) {
            switchWeight += jsRound((rating - overall) / 10.0);
            canCounter = true;
          }
        }
      }
    }
    if (opl->switchTimer - pl->switchTimer < 30 && (double)pk->hp / (double)pk->hpMax <= 0.25 && remO > 1) switchWeight = 0;
    names[n] = ST_SWITCH_BASIC; w[n++] = switchWeight;
    totalSwitch += switchWeight;
    // SWITCH_FARM
    double dpt = (double)op->fast.damage / ((double)op->fast.cd / 500.0);
    double ppt = (dpt / (double)pk->hpMax) * 100.0;
    double wf = pow((double)jsRound(fmax(3.0 - ppt, 0.0)), 2.0);
    if (pl->prevStrat == ST_SWITCH_FARM) wf = 0;
    if (ppt > 3) wf = 0;
    if ((double)op->fast.gain / ((double)op->fast.cd / 500.0) < 3) wf = 0;
    if ((double)pk->hp / (double)pk->hpMax < 0.5 && remO > 1) wf = 0.1;
    if (canCounter) wf = 0.1;
    if ((double)pk->hp / (double)pk->hpMax < 0.25) wf = 0;
    totalSwitch += switchWeight * wf;
    names[n] = ST_SWITCH_FARM; w[n++] = (int)floor(switchWeight * wf);
  }
  if (totalSwitch < 10) {
    names[n] = ST_DEFAULT; w[n++] = 1;
    if (op->shields > 0 && nCharged(pk) > 1) {
      int baitWeight = imax(jsRound((bothBait - noBait) / 20.0), 1);
      if (bothBait >= 500 && nCharged(pk) == 2) {
        if (fabs((double)pk->ch[0].dpe - (double)pk->ch[1].dpe) <= 0.1) baitWeight += 5;
      }
      if (pl->shields < opl->shields) baitWeight += 2;
      if (overall < 250) baitWeight = 1;
      if (pk->best >= 0 && pk->ch[pk->best].code == 5 /*SKULL_BASH*/ && remP > 1) baitWeight = 0;
      if ((double)pk->hp / (double)pk->hpMax < 0.25 && pk->energy < 70) baitWeight = 0;
      names[n] = ST_BAIT; w[n++] = baitWeight;
      int biggest = 0;
      for (int k = 0; k < 3; k++) if (pk->ch[k].present && pk->ch[k].damage > biggest) biggest = pk->ch[k].damage;
      bool boost = false;
      for (int k = 0; k < 3; k++) {
        const Move* m = &pk->ch[k];
        if (m->present && m->hasBuffs && (double)m->chance >= 0.5 && !m->selfDeb) boost = true;
      }
      if ((double)biggest < (double)pk->hp * 0.9 && !boost) {
        names[n] = ST_DEFAULT; w[n++] = (int)ceil((double)pk->hp / (double)biggest);
      }
    }
    int farmWeight = jsRound((farm - 600.0) / 20.0);
    if (op->energy < 20 && farm > 500) farmWeight += 12;
    if (remO < 2) farmWeight = 0;
    if (farmWeight >= 15) farmWeight *= 5;
    names[n] = ST_FARM; w[n++] = farmWeight;
  }
  int pick = chooseOption(b, w, n);
  // options.filter(name)[0]: the first option carrying the picked option's name
  int name = names[pick];
  processStrategy(b, p, name);
  pl->turnLastEval = b->turns;
}

// ------------------------------------------------------------------ TrainingAI.decideShield (+ wrapShieldBanking)

__device__ double turnsToChargedMove(const Mon* m, int energy) {
  int cheapest = 1 << 30; bool any = false;
  for (int k = 0; k < 3; k++) if (m->ch[k].present) { any = true; if (m->ch[k].energy < cheapest) cheapest = m->ch[k].energy; }
  if (!any) return 1e300;
  double ept = (double)m->fast.gain / ((double)m->fast.cd / 500.0);
  if (!(ept > 0)) return 1e300;
  return (double)imax(cheapest - energy, 0) / ept;
}

__device__ __noinline__ bool decideShield(B3* b, int atkG, int defG, int mvIdx) {
  Mon* att = &b->mon[atkG];
  Mon* def = &b->mon[defG];
  int p = def->index;
  Ply* pl = &b->pl[p];
  double currentRating = runScenario(b, SC_NO_BAIT, defG, atkG);
  int range = 0;  // Champion energyGuessRange
  int estimated = att->energy + ((int)floor(rnd(b) * (double)(range * 2)) - range);
  int minEnergy = 100;
  for (int k = 0; k < 3; k++) if (att->ch[k].present && att->ch[k].energy < minEnergy) minEnergy = att->ch[k].energy;
  if (estimated < minEnergy) estimated = minEnergy;
  int mv[3], nm = 0;
  for (int k = 0; k < 3; k++) if (att->ch[k].present && estimated >= att->ch[k].energy) mv[nm++] = k;
  // sort by the STORED move damage, descending, stable (the damage recomputed in the loop is assigned to an array property)
  for (int i = 1; i < nm; i++) {
    int v = mv[i], j = i - 1;
    while (j >= 0 && att->ch[v].damage > att->ch[mv[j]].damage) { mv[j + 1] = mv[j]; j--; }
    mv[j + 1] = v;
  }
  int remP = remaining(b, p);
  int gw[3];
  for (int i = 0; i < nm; i++) {
    const Move* m = &att->ch[mv[i]];
    int mw = 1;
    if (i == 0 && (double)att->hp / (double)att->hpMax <= 0.25) {
      mw += 8;
      if (m->code == 7 /*ACID_SPRAY*/) mw += 12;
    }
    if (i == 0) mw += pl->shields;
    if (remP == 1 && m->damage >= def->hp) mw += 4;
    if (i == 1) {
      const Move* m0 = &att->ch[mv[0]];
      if (m->damage < m0->damage && m->energy >= m0->energy && m->code != 7) gw[0] += 20;
    }
    gw[i] = mw;
  }
  const Move* move = &att->ch[mv[nm > 0 ? chooseOption(b, gw, nm) : 0]];
  int yes = 4, no = 4;  // level 3
  int moveDamage = move->damage;
  int fastDamage = att->fast.damage;
  int dw = imin(jsRound(((double)moveDamage / fmax((double)def->hp, (double)def->hpMax / 2.0)) * 10.0), 10);
  if (dw >= 5) yes += (dw - 3) * (pl->shields + 1);
  else no += (8 - dw) * 2;
  if (dw >= 6 || moveDamage + fastDamage * 2 >= def->hp) {
    if (remP > 1) {
      double yr = currentRating - 400, nr = 400 - currentRating;
      if ((double)def->hp / (double)def->hpMax < 0.35) { yr = currentRating - 500; nr = 500 - currentRating; }
      if (pl->switchTimer > 0 && remP > 1) { yr *= 2; nr *= 2; }
      yes += jsRound((yr / 100.0) * dw);
      no += jsRound((nr / 100.0) * (10 - dw));
    } else {
      yes += dw;
      no -= dw;
    }
  }
  for (int k = 0; k < 3; k++) {
    if (!def->ch[k].present) continue;
    double turnsAway = ceil((double)(def->ch[k].energy - def->energy) / (double)def->fast.gain) * ((double)def->fast.cd / 500.0);
    if ((moveDamage >= att->hp || (double)moveDamage >= (double)def->hpMax * 0.8) && turnsAway <= 1) yes += 4;  // ADVANCED_SHIELDING
  }
  if (remP > 1 && att->startShields >= def->startShields && def->shUsed > 0) {
    yes = jsRound((double)yes / 2.0);  // the `currentScenario < 500` follow-up compares an object, never true
  }
  if (remP == 1) { yes *= 2; no = jsRound((double)no / 4.0); }
  // BAD_DECISION_PROTECTION (IEEE division, as in JS)
  double yd = (double)yes, nd = (double)no;
  if (yd / nd >= 4.0) no = 0;
  else if (nd / yd >= 4.0) yes = 0;
  int ow[2] = {yes, no};
  bool decision = chooseOption(b, ow, 2) == 0;
  // wrapShieldBanking
  if (decision && remP > 1) {
    int incomingDamage = calcDamage(att, def, &att->ch[mvIdx]);
    int incomingEnergy = att->ch[mvIdx].energy;
    int fd = calcDamage(att, def, &att->fast);
    int fk = -1;
    for (int k = 0; k < 3; k++) if (att->ch[k].present && (fk < 0 || att->ch[k].energy < att->ch[fk].energy)) fk = k;
    int fuDamage = fk >= 0 ? calcDamage(att, def, &att->ch[fk]) : 0;
    int fuEnergy = fk >= 0 ? att->ch[fk].energy : 0;
    bool tank = false;
    if (!((double)incomingDamage > (double)def->hpMax * 0.5)) {
      int hpAfter = def->hp - incomingDamage;
      if (hpAfter > 0) {
        double tta = turnsToChargedMove(def, 0);
        if ((tta < 1e299)) {
          double chip = (double)fd / ((double)att->fast.cd / 500.0);
          double inWindow = chip > 0 ? chip * tta : 0;
          if (fk >= 0 && fuEnergy > 0 && fuDamage > 0) {
            double ept = (double)att->fast.gain / ((double)att->fast.cd / 500.0);
            int energyLeft = imax(att->energy - incomingEnergy, 0);
            double banked = ept > 0 ? ept * tta : 0;
            int throws = (int)floor(((double)energyLeft + banked) / (double)fuEnergy);
            int unblocked = imax(throws - def->shields, 0);
            inWindow += (double)unblocked * (double)fuDamage;
          }
          tank = (double)hpAfter > inWindow;
        }
      }
    }
    if (tank) return false;
  }
  return decision;
}

// ------------------------------------------------------------------ TrainingAI.decideAction (+ wrapThrowAndGo)

__device__ int potentialDamage(const Mon* attacker, const Mon* defender, int energy) {
  bool any = false; int best = 0;
  for (int k = 0; k < 3; k++) {
    if (!attacker->ch[k].present) continue;
    int cnt = floorDivD(energy, attacker->ch[k].energy);
    int d = cnt * calcDamage(attacker, defender, &attacker->ch[k]);
    if (!any || d > best) best = d;
    any = true;
  }
  return any ? best : 0;
}

__device__ __noinline__ Act aiDecide(B3* b, int p, int turn) {
  Mon* poke = &b->mon[b->act[p]];
  Mon* opp = &b->mon[b->act[1 - p]];
  Ply* pl = &b->pl[p];
  Act a; a.actor = p; a.turn = turn; a.value = 0; a.prio = poke->priority; a.processed = 0; a.valid = 0; a.type = A_FAST;
  int remP = remaining(b, p);
  // wrapThrowAndGo: outermost
  if (poke->hp > 0 && poke->csi >= 2 && pl->switchTimer == 0 && remP > 1 && opp->hp > 0) {
    double dps = (double)opp->fast.damage / ((double)opp->fast.cd / 500.0);
    if (dps > 0 && (double)poke->hp / dps < turnsToChargedMove(poke, poke->energy)) {
      int choice = decideSwitch(b, p);
      a.type = A_SWITCH; a.value = choice;
      return a;
    }
  }
  resetMoves(poke, opp);
  int extra = floorDivD(poke->fast.cd - opp->cooldown, opp->fast.cd);
  if (pl->curStrat != ST_SWITCH_BASIC && pl->curStrat != ST_SWITCH_FARM) extra++;
  if (opp->cooldown > 0 && opp->cooldown < poke->fast.cd) extra = imax(extra, 1);
  int futureEnergy = opp->energy + extra * opp->fast.gain;
  int futureDamage = potentialDamage(opp, poke, futureEnergy);
  if (futureDamage >= poke->hp && pl->curStrat == ST_FARM) processStrategy(b, p, ST_DEFAULT);
  bool have = false;
  Act act = a;
  bool isSwitch = pl->curStrat == ST_SWITCH_BASIC || pl->curStrat == ST_SWITCH_FARM;
  if (isSwitch && pl->switchTimer == 0) {
    bool perform = false;
    if (pl->curStrat == ST_SWITCH_BASIC && (double)(turn - pl->turnLastEval) >= 0.4) perform = true;
    if (pl->curStrat == ST_SWITCH_FARM) {
      if (futureDamage >= poke->hp || (double)futureDamage >= (double)poke->hpMax * 0.14) perform = true;
      if ((double)poke->hp / (double)poke->hpMax < 0.2) perform = true;
    }
    if (perform) {
      int choice = decideSwitch(b, p);
      act.type = A_SWITCH; act.value = choice; have = true;
    }
  }
  // OVERFARM
  if (pl->noBaitAvg > 450 && !isSwitch && remaining(b, 1 - p) > 1) {
    int chance = 2 + jsRound((50.0 - (double)opp->energy) / 10.0);
    if (futureDamage >= poke->hp || (double)futureDamage >= (double)poke->hpMax * 0.15) chance = -1;
    if (poke->energy == 100) chance = -1;
    for (int k = 0; k < 3; k++) if (poke->ch[k].present && (poke->ch[k].code == 6 || poke->ch[k].code == 7)) chance = -1;
    if ((double)poke->hp / (double)poke->hpMax < 0.2) chance = -1;
    if (floor(rnd(b) * (double)chance) > 0) { act.type = A_FAST; act.value = 0; have = true; }
  }
  resetMoves(poke, opp);
  if (!have) {
    int queuedFast = 0;
    for (int k = 0; k < b->nqa; k++) if (b->qa[k].actor == p && b->qa[k].type == A_FAST) queuedFast++;
    int mv = decideAction(poke, opp, b->turns, queuedFast, &b->flags, &b->poolMax, 1);
    if (mv >= 0) { act.type = A_CHARGED; act.value = mv; }
    else { act.type = A_FAST; act.value = 0; }
  }
  return act;
}

// ------------------------------------------------------------------ Battle.js pieces

__device__ __noinline__ void setNewPokemon(B3* b, int g, int idx) {
  Mon* pk = &b->mon[g];
  pk->csi = 0;   // wrapThrowAndGo
  if (b->turns > 1) resetMon(pk, &b->mon[b->act[1 - idx]], 1);   // poke.reset(true): opponent = pokemon[other index]
  pk->index = idx;
  b->act[idx] = g;
  pk->shields = b->pl[idx].shields;
  pk->startShields = b->pl[idx].shields;
  pk->priority = b->pl[idx].priority;
  if (b->act[0] >= 0 && b->act[1] >= 0) {
    for (int i = 0; i < 2; i++) {
      resetMoves(&b->mon[b->act[i]], &b->mon[b->act[1 - i]]);
      evalMatchup(b, i);
    }
  }
}

__device__ void decrementSwitchTimer(B3* b, int p) {
  Ply* pl = &b->pl[p];
  bool ev = pl->switchTimer <= 500 && pl->switchTimer > 0;
  pl->switchTimer = imax(pl->switchTimer - 500, 0);
  if (ev) evalMatchup(b, p);
}

__device__ __noinline__ void queueAction(B3* b, int actor, int type, int value) {
  for (int i = 0; i < b->nac; i++) {
    if (b->ac[i].actor == actor) {
      if (b->ac[i].type != A_SWITCH || type == A_SWITCH) {
        for (int k = i + 1; k < b->nac; k++) b->ac[k - 1] = b->ac[k];
        b->nac--;
        break;
      } else {
        return;
      }
    }
  }
  if (b->nac >= MAXACT) { b->flags |= F_BADSTATE; return; }
  Act a; a.actor = actor; a.type = type; a.turn = b->turns; a.value = value; a.prio = b->mon[b->act[actor]].priority; a.processed = 0; a.valid = 0;
  b->ac[b->nac++] = a;
  if (type == A_SWITCH && b->phase == P_SUSPEND_SWITCH) {
    int answered = 0;
    for (int i = 0; i < b->nPh; i++)
      for (int n = 0; n < b->nac; n++)
        if (b->ac[n].type == A_SWITCH && b->ac[n].actor == b->phActors[i]) answered++;
    if (answered == b->nPh) {
      clearTimer(b, b->phaseTimeout);
      b->phase = P_NEUTRAL;
    }
  }
}

__device__ __noinline__ void forceSwitch(B3* b) {
  for (int i = 0; i < 2; i++) {
    if (b->mon[b->act[i]].hp <= 0) {
      int choice = decideSwitch(b, i);
      queueAction(b, i, A_SWITCH, choice);
    }
  }
}

// Battle.useMove, emulate mode, sandbox = true, buffChanceModifier = 0
__device__ __noinline__ void useMove3(B3* b, int ai, int di, int mvIdx, int forceShield) {
  Mon* a = &b->mon[ai];
  Mon* d = &b->mon[di];
  Move* mv = mvIdx < 0 ? &a->fast : chargedOf(&b->gm, a, mvIdx);
  if (mvIdx >= 0 && a->fc == 2 && a->form != 0) changeForm(a, d, 0);   // pre-attack form change (Battle.js 1024)
  int damage = calcDamage(a, d, mv);
  mv->damage = damage;
  bool charged = mvIdx >= 0;
  bool defenderUsedShield = false;
  if (mv->energy > 0) b->chargedUsed++;   // wrapBattleClock
  if (charged) {
    a->energy -= mv->energy;
    bool canShield = d->shields > 0 && !mv->instant;
    if (canShield && forceShield && b->pl[d->index].shields > 0) {
      damage = 1;
      d->shields--;
      b->roundShield = 1;
      b->pl[d->index].shields--;
      d->shUsed++;
      defenderUsedShield = true;
      if (d->fc == 1 && d->form != 1) changeForm(d, a, 1);
    }
    if (d->fc == 3 && !defenderUsedShield && !mv->instant) { damage = 1; b->roundShield = 1; }   // Mimikyu disguise
    if (d->hp <= 0) { b->nta = 0; b->nqa = 0; }
  } else {
    int gain = a->fast.gain;
    if (a->kind == 1 && a->form == 1) gain = 6;
    a->energy += gain;
    if (a->energy > 100) a->energy = 100;
  }
  if (a->kind == 1 && a->form == 1 && mv->gain > 0) damage = 1;
  d->hp = imax(0, d->hp - damage);
  if (mv->hasBuffs) {
    double roll = rnd(b);   // Math.random() + buffChanceModifier(0) + shieldBuffModifier(0)
    if ((double)mv->chance == 1.0 || roll > 1.0 - (double)mv->chance) {
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
    Act g; g.actor = d->index; g.type = A_CHARGED; g.turn = b->turns; g.value = d->form == 1 ? 100 : 101;
    g.prio = b->pl[d->index].priority; g.processed = 0; g.valid = 0;
    if (b->nta < MAXACT) {
      int pos = imin(b->curAi, b->nta);
      for (int x = b->nta; x > pos; x--) b->ta[x] = b->ta[x - 1];
      b->ta[pos] = g; b->nta++;
    } else b->flags |= F_BADSTATE;
    b->turns--;   // emulate mode
  }
  if (charged && d->fc == 3 && d->form != 1 && !defenderUsedShield && !mv->instant) changeForm(d, a, 1);
  if (d->hp <= 0) { d->faintSource = charged ? 2 : 1; b->nqa = 0; }
  if (b->dbg && b->ndbg < 6000) { int* e = b->dbg + b->ndbg * 5; e[0] = b->turns; e[1] = ai; e[2] = mvIdx; e[3] = d->hp; e[4] = ai * 8 + di; b->ndbg++; }
  if (mv->energy > 0) {
    a->csi++;                 // wrapThrowAndGo
    b->lastChargedTurn = b->turns;   // wrapSwitchCost
  }
}

__device__ __noinline__ void fireTimer(B3* b, const Timer* t) {
  switch (t->kind) {
    case K_ANIM: b->phase = P_ANIMATING; break;
    case K_NEUTRAL: b->phase = P_NEUTRAL; break;
    case K_USE:
      useMove3(b, t->a, t->b, t->c, t->d);
      if (b->mon[t->b].hp > 0) evalMatchup(b, 1);   // players[1].getAI().evaluateMatchup(turns, pokemon[1], pokemon[0], players[0])
      break;
    case K_FORCE: forceSwitch(b); break;
    case K_QSWITCH: queueAction(b, t->a, A_SWITCH, t->b); break;
  }
}

__device__ __noinline__ void drain(B3* b) {
  int guard = 0;
  while (b->ntm > 0) {
    if (guard++ > 64) { b->flags |= F_BADSTATE; b->ntm = 0; return; }
    int best = 0;
    for (int i = 1; i < b->ntm; i++) {
      if (b->tm[i].at < b->tm[best].at || (b->tm[i].at == b->tm[best].at && b->tm[i].id < b->tm[best].id)) best = i;
    }
    Timer t = b->tm[best];
    b->tm[best] = b->tm[--b->ntm];
    b->clock = t.at;
    fireTimer(b, &t);
  }
}

__device__ __noinline__ void processAction(B3* b, int k) {
  Act* ac = &b->ta[k];
  if (!ac->valid || ac->processed) return;
  ac->processed = 1;
  Act a = *ac;
  int pg = b->act[a.actor];
  Mon* poke = &b->mon[pg];
  int oppG = b->act[1 - a.actor];
  if (a.type == A_FAST) {
    useMove3(b, pg, oppG, -1, 0);
  } else if (a.type == A_CHARGED) {
    Move* mv = chargedOf(&b->gm, poke, a.value);
    if (poke->energy >= mv->energy) {
      if (b->phase != P_SUSPEND_CHARGED) {
        bool same = false;
        for (int i = 0; i < b->nta; i++)
          if ((b->ta[i].type == A_CHARGED || b->ta[i].type == A_FAST) && b->ta[i].actor != poke->index) same = true;
        if (same) b->turns--;
        if (mv->instant) {
          b->phase = P_ANIMATING;
          sched(b, 1000, K_USE, pg, oppG, a.value, 0);
          b->phaseTimeout = sched(b, 3000, K_NEUTRAL, 0, 0, 0, 0);
        } else {
          b->phase = P_SUSPEND_CHARGED;
          // the opponent's AI decides about the shield now (its random draws happen here, before the 6 s/8 s timers fire)
          b->playerUseShield = decideShield(b, pg, oppG, a.value) ? 1 : 0;
          sched(b, 6000, K_ANIM, 0, 0, 0, 0);
          sched(b, 8000, K_USE, pg, oppG, a.value, b->playerUseShield);
          b->phaseTimeout = sched(b, 10000, K_NEUTRAL, 0, 0, 0, 0);
        }
      }
      b->roundCharged++;
    }
  } else if (a.type == A_SWITCH) {
    int p = poke->index;
    Ply* pl = &b->pl[p];
    int newG = p * 3 + a.value;
    bool afterFaint = poke->hp < 1;
    if (poke->hp > 0) {
      pl->switchTimer = 45000;
      poke->sb0 = 0; poke->sb1 = 0; poke->ssb0 = 0; poke->ssb1 = 0;
      poke->startHp = imin(poke->hp, poke->hpMax);
      poke->startEnergy = poke->energy ? imin(poke->energy, 100) : 0;
      if (poke->fc && poke->form != poke->origForm && fcResetsOnSwitch(poke->fc)) {   // Battle.js 995
        poke->startForm = poke->origForm;
        changeForm(poke, &b->mon[b->act[1 - p]], poke->origForm);
      }
    } else {
      b->mon[b->act[1 - p]].cooldown = 500;
    }
    setNewPokemon(b, newG, p);
    // wrapSwitchCost
    bool free = afterFaint || b->turns == b->lastChargedTurn;
    if (!free) {
      int inc = b->act[p];
      if (inc != pg) b->mon[inc].cooldown = 1000;
    }
  }
}

__device__ void sortTA(B3* b) {  // stable, priority descending
  for (int i = 1; i < b->nta; i++) {
    Act v = b->ta[i];
    int j = i - 1;
    while (j >= 0 && v.prio > b->ta[j].prio) { b->ta[j + 1] = b->ta[j]; j--; }
    b->ta[j + 1] = v;
  }
}

__device__ __noinline__ void step3(B3* b) {
  b->roundCharged = 0;
  b->roundShield = 0;
  bool fresh = b->turns > b->lastProcessed;
  if (fresh) b->nta = 0;
  for (int i = 0; i < 2; i++) {
    Mon* pk = &b->mon[b->act[i]];
    pk->cooldown = imax(0, pk->cooldown - 500);
    if (fresh) pk->hasActed = 0;
  }
  decrementSwitchTimer(b, 0);
  decrementSwitchTimer(b, 1);
  if (b->phase != P_NEUTRAL) return;
  int chargedLast = b->prevCharged;
  int cdSet[2] = {b->mon[b->act[0]].cooldown, b->mon[b->act[1]].cooldown};
  if (b->turns > b->lastProcessed) {
    for (int i = 0; i < 2; i++) {
      Mon* poke = &b->mon[b->act[i]];
      Mon* opp = &b->mon[b->act[1 - i]];
      Act a; bool have = false;
      a.actor = i; a.type = A_FAST; a.turn = b->turns; a.value = 0; a.prio = poke->priority; a.processed = 0; a.valid = 0;
      if (poke->cooldown == 0 && !poke->hasActed) {
        if (poke->hp > 0) {
          poke->hasActed = 1;
          a = aiDecide(b, i, b->turns);
          have = true;
        } else {
          for (int n = 0; n < b->nac; n++) {
            if (b->ac[n].actor == poke->index && !poke->hasActed) {
              a = b->ac[n];
              a.prio = poke->priority;
              have = true;
              poke->hasActed = 1;
            }
          }
        }
        if (!have) { have = true; }  // fast action, priority = poke.priority
        if (b->dbg && b->ndbg < 6000) { int* e = b->dbg + b->ndbg * 5; e[0] = b->turns; e[1] = i; e[2] = 100 + a.type; e[3] = a.value; e[4] = -1; b->ndbg++; }
        if (a.type == A_CHARGED) { a.prio += 10; if (poke->atk > opp->atk) a.prio++; }
        if (a.type == A_SWITCH) a.prio += 20;
        if (chargedLast && a.type != A_SWITCH) continue;
        if (a.type == A_SWITCH || (poke->hp > 0 && opp->hp > 0)) {
          if (a.type == A_FAST) cdSet[i] += poke->fast.cd;
          if (a.type == A_CHARGED) cdSet[i] += 500;
          if (b->nqa < MAXACT) b->qa[b->nqa++] = a; else b->flags |= F_BADSTATE;
        }
      }
    }
  }
  b->mon[b->act[0]].cooldown = cdSet[0];
  b->mon[b->act[1]].cooldown = cdSet[1];
  for (int i = 0; i < b->nqa; i++) {
    Act a = b->qa[i];
    bool valid = false;
    if (a.type == A_FAST || a.type == A_CHARGED) {
      int since = (b->turns - a.turn) * 500;
      int req = a.type == A_FAST ? b->mon[b->act[a.actor]].fast.cd - 500 : 0;
      if (since >= req || (a.type == A_FAST && chargedLast && a.turn < b->turns)) valid = true;
    }
    if (a.type == A_SWITCH) {
      valid = true;   // Battle.js 415 lowers `action.priority`, a property the sort never reads: dead code, so no change here
    }
    if (valid) {
      if (b->nta < MAXACT) b->ta[b->nta++] = a; else b->flags |= F_BADSTATE;
      for (int k = i + 1; k < b->nqa; k++) b->qa[k - 1] = b->qa[k];
      b->nqa--;
      i--;
    }
  }
  sortTA(b);
  int ai = 0;
  while (ai < b->nta) {
    if (b->phase != P_NEUTRAL) return;
    int k = ai++;
    b->curAi = ai;
    Act* a = &b->ta[k];
    Mon* poke = &b->mon[b->act[a->actor]];
    Mon* opp = &b->mon[b->act[1 - a->actor]];
    if (a->type == A_FAST) {
      a->valid = 1;
      if (opp->hp < 1) a->valid = 0;
      if (poke->hp < 1 && poke->faintSource == 2) a->valid = 0;
    } else if (a->type == A_CHARGED) {
      Move* mv = chargedOf(&b->gm, poke, a->value);
      if (poke->energy >= mv->energy) a->valid = 1;
      if (b->usePriority && poke->hp <= 0 && poke->faintSource == 2 && a->value < 100) a->valid = 0;   // Gulp Missile ignoresFaint
    } else if (a->type == A_SWITCH) {
      if ((poke->cooldown == 0 && b->pl[poke->index].switchTimer == 0) || poke->hp < 1) a->valid = 1;
    }
    if (b->dbg && b->ndbg < 6000) { int* e = b->dbg + b->ndbg * 5; e[0] = b->turns; e[1] = a->actor; e[2] = 200 + a->type; e[3] = a->valid * 1000 + a->prio; e[4] = -2; b->ndbg++; }
    processAction(b, k);
  }
  int hadCharged = 0;
  for (int i = 0; i < b->nta; i++) if (b->ta[i].type == A_CHARGED) hadCharged = 1;
  b->prevCharged = hadCharged;
  b->nta = 0;
  b->nac = 0;
  b->lastProcessed = b->turns;
  b->turns++;
  int fainted[2], nf = 0;
  for (int i = 0; i < 2; i++) {
    Mon* pk = &b->mon[b->act[i]];
    if (pk->hp <= 0) fainted[nf++] = pk->index;
    if (b->roundCharged) pk->cooldown = 500;
  }
  if (nf > 0 && b->phase == P_NEUTRAL) {
    if (remaining(b, 0) > 0 && remaining(b, 1) > 0) {
      b->phase = P_SUSPEND_SWITCH;
      b->nPh = nf;
      for (int i = 0; i < nf; i++) b->phActors[i] = fainted[i];
      if (remaining(b, 0) > 1) b->phaseTimeout = sched(b, 13000, K_FORCE, 0, 0, 0, 0);
      else forceSwitch(b);
      for (int i = 0; i < 2; i++) b->mon[b->act[i]].cooldown = 0;
      bool p1 = false;
      for (int i = 0; i < nf; i++) if (fainted[i] == 1) p1 = true;
      if (p1) {
        int choice = decideSwitch(b, 1);
        int waitTime = 500;
        if (b->pl[1].switchTimer > 0 && remaining(b, 1) > 1) {
          waitTime = imin(b->pl[1].switchTimer - 1000, 5000);
          waitTime = (int)floor(rnd(b) * (double)waitTime) + 2000;
        }
        sched(b, waitTime, K_QSWITCH, 1, choice, 0, 0);
      }
    } else {
      b->phase = P_GAME_OVER;
    }
    b->nta = 0;
    b->nqa = 0;
  }
}

// ------------------------------------------------------------------ battle setup and kernel (teamBattle.js battleTeams)

#define B_OUT 24

__device__ void freshMon(Mon* m, const double* srow, const double* drow, int player, const double* st) {
  loadMon(m, srow, drow, player, st);
  m->startHp = m->hpMax; m->startEnergy = 0; m->startCd = 0; m->startShields = 2;
  m->ssb0 = 0; m->ssb1 = 0; m->nsb0 = 0; m->nsb1 = 0;
  m->priority = 0; m->bait = 1; m->farm = 0;
  m->hp = m->hpMax; m->energy = 0; m->cooldown = 0; m->shields = 2; m->sb0 = 0; m->sb1 = 0;
  m->hasActed = 0; m->csi = 0; m->shUsed = 0; m->faintSource = 0;
}

extern "C" __global__ void battle3v3_kernel(const double* st, const int* monIdx, const double* dyn, const unsigned* seeds, int* out, int n, int dbgThread, int* dbg) {
#ifndef LANES
#define LANES 1  // threads per battle: 32 = one warp per battle, every lane runs the same battle (no divergence)
#endif
  int g = blockIdx.x * blockDim.x + threadIdx.x;
  int t = g / LANES;
  bool writer = (g % LANES) == 0;  // lanes of one battle compute identical state; one of them writes the row
  if (t >= n) return;
  unsigned long long tStart;  // profiling only: %globaltimer ns at thread start/end -> out cols 20..23 (no effect on the battle)
  asm volatile("mov.u64 %0, %%globaltimer;" : "=l"(tStart));
  B3 b;
  b.flags = 0; b.poolMax = 0; b.innerSims = 0; b.draws = 0; b.dbg = (t == dbgThread && writer) ? dbg : 0; b.ndbg = 0;
  int* o = out + (long long)t * B_OUT;
  for (int i = 0; i < 6; i++) {
    const double* srow = st + (long long)monIdx[t * 6 + i] * S_N;
    freshMon(&b.mon[i], srow, dyn + ((long long)t * 6 + i) * D_N, i / 3, st);
  }
  b.sc.flags = 0; b.sc.poolMax = 0;
  b.rng = seeds[t];
  b.ntm = 0; b.nextId = 1; b.clock = 0; b.phaseTimeout = 0; b.nPh = 0;
  b.nta = b.nqa = b.nac = 0; b.curAi = 0; b.prevCharged = 0; b.chargedUsed = 0; b.lastChargedTurn = -1;
  b.roundCharged = b.roundShield = b.playerUseShield = 0;
  for (int p = 0; p < 2; p++) {
    b.pl[p].shields = 2; b.pl[p].switchTimer = 0; b.pl[p].priority = p;
    b.pl[p].curStrat = ST_NONE; b.pl[p].prevStrat = ST_NONE; b.pl[p].turnLastEval = 0; b.pl[p].noBaitAvg = 0;
  }
  b.act[0] = -1; b.act[1] = -1;
  b.turns = 1; b.lastProcessed = 0; b.phase = P_NEUTRAL; b.usePriority = 0;
  // battle.setNewPokemon(lead A, 0); battle.setNewPokemon(lead B, 1): the second call evaluates both matchups
  setNewPokemon(&b, 0, 0);
  setNewPokemon(&b, 3, 1);
  // p0.reset(), p1.reset(), fullReset of all six (every move set initialised against the opposing lead)
  for (int p = 0; p < 2; p++) { b.pl[p].shields = 2; b.pl[p].switchTimer = 0; }
  for (int i = 0; i < 6; i++) {
    Mon* m = &b.mon[i];
    m->index = i / 3;
    m->startHp = m->hpMax; m->startEnergy = 0; m->startCd = 0; m->ssb0 = 0; m->ssb1 = 0; m->nsb0 = 0; m->nsb1 = 0;
    m->startForm = m->origForm;   // fullReset
    resetMon(m, &b.mon[b.act[1 - i / 3]]);
  }
  // battle.start()
  for (int i = 0; i < 2; i++) resetMon(&b.mon[b.act[i]], &b.mon[b.act[1 - i]]);
  b.usePriority = b.mon[b.act[0]].atk != b.mon[b.act[1]].atk || (b.mon[b.act[0]].kind == 3 && b.mon[b.act[1]].kind == 3);
  b.turns = 1; b.lastProcessed = 0; b.nqa = 0; b.nta = 0; b.prevCharged = 0;
  // second matchup evaluation, player 0 then player 1
  evalMatchup(&b, 0);
  evalMatchup(&b, 1);
  int guard = 0;
  int leadFaintA = -1, leadFaintB = -1;   // teamBattle.js leadFaintTurnA/B: first turn the designated lead (slot 0 / 3) is at 0 hp
  while (remaining(&b, 0) > 0 && remaining(&b, 1) > 0 && (b.turns - 1) * 500 + b.chargedUsed * 9500 <= 240000) {
    if (guard++ > 5000) { b.flags |= F_GUARD; break; }
#ifdef EXIT_ON_INVALID
    if (b.flags & F_INVALID_MASK) break;  // the row is discarded and re-run on the CPU anyway
#endif
    step3(&b);
    drain(&b);
    if (leadFaintA < 0 && b.mon[0].hp <= 0) leadFaintA = b.turns - 1;
    if (leadFaintB < 0 && b.mon[3].hp <= 0) leadFaintB = b.turns - 1;
  }
  int remA = remaining(&b, 0), remB = remaining(&b, 1);
  int hpA = 0, hpB = 0;
  for (int i = 0; i < 3; i++) { hpA += imax(0, b.mon[i].hp); hpB += imax(0, b.mon[3 + i].hp); }
  int winner;
  if (remA > remB) winner = 0; else if (remB > remA) winner = 1;
  else if (hpA > hpB) winner = 0; else if (hpB > hpA) winner = 1; else winner = 2;
  if (!writer) return;
  o[0] = winner; o[1] = remA; o[2] = remB;
  for (int i = 0; i < 6; i++) o[3 + i] = imax(0, b.mon[i].hp);
  o[9] = b.turns - 1; o[10] = b.flags; o[11] = b.innerSims; o[12] = b.draws; o[13] = b.poolMax;
  o[14] = b.chargedUsed; o[15] = hpA; o[16] = hpB; o[17] = b.ndbg; o[18] = leadFaintA; o[19] = leadFaintB;
  unsigned long long tEnd;
  asm volatile("mov.u64 %0, %%globaltimer;" : "=l"(tEnd));
  o[20] = (int)(tStart & 0xffffffffull); o[21] = (int)(tStart >> 32); o[22] = (int)(tEnd & 0xffffffffull); o[23] = (int)(tEnd >> 32);
}
