"""Pack the exporter's JSON (mons.json / sims.json) into the flat arrays the CUDA kernels read.

Layout constants must match gpu/kernels/pvp1v1.cuh (M_N, S_N, D_N)."""
import json
import numpy as np

M_N, S_N, D_N = 25, 144, 17
MOVE_CODES = {"FOCUS_BLAST": 1, "ZAP_CANNON": 2, "OBSTRUCT": 3, "SUPER_POWER": 4,
              "SKULL_BASH": 5, "POWER_UP_PUNCH": 6, "ACID_SPRAY": 7,
              "DIVE": 8, "SURF": 9, "AURA_WHEEL_ELECTRIC": 10, "AURA_WHEEL_DARK": 11,
              "AEGISLASH_CHARGE_AIR_SLASH": 12, "AEGISLASH_CHARGE_PSYCHO_CUT": 13, "AIR_SLASH": 14, "PSYCHO_CUT": 15,
              "GULP_MISSILE_ARROKUDA": 20, "GULP_MISSILE_PIKACHU": 21}


def pack_move(m):
    r = np.zeros(M_N)
    if not m:
        return r
    r[0] = 1
    r[1], r[2], r[3], r[4], r[5], r[6] = m["power"], m["energy"], m["energyGain"], m["cooldown"], m["turns"], m["type"]
    r[7] = m["percentHp"]
    r[8] = m["megaMove"]
    if m["buffs"] is not None:
        r[9] = 1
        r[10], r[11] = m["buffs"]
    r[12] = m["buffTarget"]
    if m["buffsSelf"]:
        r[13], r[14] = m["buffsSelf"]
    if m["buffsOpponent"]:
        r[15], r[16] = m["buffsOpponent"]
    r[17] = float("nan") if m["buffApplyChance"] is None else (m["buffApplyChance"] or 0)
    r[18], r[19], r[20], r[21] = m["selfDebuffing"], m["selfBuffing"], m["selfAttackDebuffing"], m["selfDefenseDebuffing"]
    r[22] = m["instant"]
    r[23] = MOVE_CODES.get(m["id"], 0)
    return r


def pack_static(mon):
    r = np.zeros(S_N)
    r[0], r[1], r[2] = mon["atk"], mon["def"], mon["hpMax"]
    r[3], r[4] = mon["types"]
    r[5], r[6], r[7] = mon["shadow"], mon["shadowAtk"], mon["shadowDef"]
    r[8:26] = mon["eff"]
    r[26], r[27], r[28], r[29] = mon["special"], mon["mega"], mon["megaLevel"], mon["formChange"]
    r[30:30 + M_N] = pack_move(mon["fast"])
    for k in range(3):
        o = 30 + M_N * (1 + k)
        r[o:o + M_N] = pack_move(mon["charged"][k])
    # form changers: kind, live slot, group snapshot rows, formChange code, own-fc flag, native buffs of the form
    r[130], r[131] = mon.get("kind", 0), mon.get("slot", 0)
    r[132:136] = mon.get("forms", [0, 0, 0, 0])
    r[136], r[137], r[138] = mon.get("fcCode", 0), mon.get("fcOwn", 0), mon.get("hasNative", 0)
    r[139], r[140] = mon.get("native", [0, 0])
    return r


def pack_dyn(e, with_entry=True):
    r = np.zeros(D_N)
    r[0], r[1], r[2], r[3] = e["startHp"], e["startEnergy"], e["startCooldown"], e["startingShields"]
    r[4], r[5] = e["startStatBuffs"]
    r[6], r[7] = e["nativeStatBuffs"]
    r[8], r[9], r[10], r[11], r[12] = e["priority"], e["turnsToKO"], e["baitShields"], e["farmEnergy"], e["optimizeMoveTiming"]
    if with_entry and "statBuffs" in e:
        r[13], r[14] = e["statBuffs"]
    r[15], r[16] = e.get("startForm", 0), e.get("origForm", 0)
    return r


def load_static(path):
    mons = json.load(open(path))
    return np.stack([pack_static(m) for m in mons])


def load_sims(path, limit=None):
    """Returns (monIdx int32 [n,2], dyn float64 [n,2,D_N], expected int32 [n,18], sims list)."""
    sims = json.load(open(path))
    if limit:
        sims = sims[:limit]
    n = len(sims)
    idx = np.zeros((n, 2), np.int32)
    dyn = np.zeros((n, 2, D_N))
    exp = np.zeros((n, 18), np.int32)
    for i, s in enumerate(sims):
        for k in range(2):
            idx[i, k] = s["entry"][k]["mon"]
            dyn[i, k] = pack_dyn(s["entry"][k])
        r = s["result"]
        exp[i] = [r["rating"][0], r["rating"][1], r["hp"][0], r["hp"][1], r["energy"][0], r["energy"][1],
                  r["shields"][0], r["shields"][1], r["buffs"][0][0], r["buffs"][0][1], r["buffs"][1][0], r["buffs"][1][1],
                  r["turns"], r["turnsToKO"][0], r["turnsToKO"][1], r["draws"], 0, 0]
    return idx, dyn, exp, sims


FIELDS = ["rating0", "rating1", "hp0", "hp1", "energy0", "energy1", "shields0", "shields1",
          "atkBuff0", "defBuff0", "atkBuff1", "defBuff1", "turns", "turnsToKO0", "turnsToKO1", "rngDraws"]
