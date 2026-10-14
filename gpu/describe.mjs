// Descriptors: everything the CUDA kernels read off a built Pokemon, as plain numbers (shared by the exporter and the
// slice driver). `makeDescriber(ctx)` returns the interning table and describeMon(); imports only src/engine, src/scoring.
import { buildPokemon } from '../src/engine/harness.js';
import { applyGroupMoveset } from '../src/scoring/index.js';

export function makeDescriber(ctx) {

  const TYPES = ['bug', 'dark', 'dragon', 'electric', 'fairy', 'fighting', 'fire', 'flying', 'ghost', 'grass', 'ground', 'ice', 'normal', 'poison', 'psychic', 'rock', 'steel', 'water'];
  const typeId = (t) => (t ? TYPES.indexOf(String(t).toLowerCase()) : -1);
  const BUFF_TARGET = { none: 0, self: 1, opponent: 2, both: 3 };

  function describeMove(m) {
    if (!m) return null;
    return {
      id: m.moveId,
      type: typeId(m.type),
      power: m.power,
      energy: m.energy,
      energyGain: m.energyGain,
      cooldown: m.cooldown,
      turns: m.turns,
      percentHp: m.damageMethod === 'percentMaxHP' ? 1 : 0,
      megaMove: m.isMegaMove ? 1 : 0,
      buffs: m.buffs ? [m.buffs[0], m.buffs[1]] : null,
      buffTarget: BUFF_TARGET[m.buffTarget] ?? 0,
      buffsSelf: m.buffsSelf ? [m.buffsSelf[0], m.buffsSelf[1]] : null,
      buffsOpponent: m.buffsOpponent ? [m.buffsOpponent[0], m.buffsOpponent[1]] : null,
      buffApplyChance: m.buffs ? (m.buffApplyChance ?? null) : 0,   // null = undefined (Aegislash shield's mutated moves)
      selfDebuffing: m.selfDebuffing ? 1 : 0,
      selfBuffing: m.selfBuffing ? 1 : 0,
      selfAttackDebuffing: m.selfAttackDebuffing ? 1 : 0,
      selfDefenseDebuffing: m.selfDefenseDebuffing ? 1 : 0,
      instant: m.tags && m.tags.includes('instant') ? 1 : 0,
      ignoresFaint: m.tags && m.tags.includes('ignoresFaint') ? 1 : 0,
      formChange: m.formChange ? 1 : 0,
    };
  }

  const monTable = [];
  const monIndex = new Map();
  function internMon(st) {
    const key = JSON.stringify(st);
    let i = monIndex.get(key);
    if (i === undefined) {
      i = monTable.length;
      monTable.push(st);
      monIndex.set(key, i);
    }
    return i;
  }

  // ------------------------------------------------------------- form changers
  // Families: slot order is what the kernel's changeForm() indexes (see gpu/gpu/kernels/pvp1v1.cuh).
  const FAMILIES = {
    aegislash: { kind: 1, forms: ['aegislash_blade', 'aegislash_shield'] },
    mimikyu: { kind: 2, forms: ['mimikyu', 'mimikyu_busted'] },
    cramorant: { kind: 3, forms: ['cramorant', 'cramorant_gulping', 'cramorant_gorging'] },
    morpeko: { kind: 4, forms: ['morpeko_full_belly', 'morpeko_hangry'] },
  };
  const familyOf = (p) => {
    const id = p.originalFormId || p.speciesId;
    for (const f of Object.values(FAMILIES)) if (f.forms.includes(id)) return f;
    return null;
  };
  const slotOf = (p, formId) => {
    const f = familyOf(p);
    return f ? Math.max(0, f.forms.indexOf(formId ?? p.originalFormId)) : 0;
  };
  /** fc code: which formChange object a mon carries (0 none); resetOnSwitch is implied by the code. */
  function fcCodeOf(fc) {
    if (!fc) return 0;
    if (fc.trigger === 'activate_shield') return 1;
    if (fc.trigger === 'activate_charged') return 2;
    if (fc.trigger === 'charged_move_damage' && fc.effect === 'protect') return 3;
    if (fc.trigger === 'none') return 4;
    if (fc.trigger === 'charged_move' && fc.alternativeFormId === 'variable') return 5;
    if (fc.trigger === 'charged_move' && fc.moveId === 'GULP_MISSILE_ARROKUDA') return 6;
    if (fc.trigger === 'charged_move' && fc.moveId === 'GULP_MISSILE_PIKACHU') return 7;
    if (fc.type === 'toggle') return 8;
    throw new Error('unknown formChange ' + JSON.stringify(fc));
  }
  const snapshotCache = new Map();
  /** Fresh per-form snapshot rows of the mon's family, built by really calling pvpoke's changeForm. */
  function formSnapshots(p, fam) {
    const orig = p.originalFormId;
    const origMove = { AEGISLASH_CHARGE_AIR_SLASH: 'AIR_SLASH', AEGISLASH_CHARGE_PSYCHO_CUT: 'PSYCHO_CUT', AURA_WHEEL_DARK: 'AURA_WHEEL_ELECTRIC' };
    const fast = origMove[p.fastMove.moveId] ?? p.fastMove.moveId;
    const charged = p.chargedMoves.filter(Boolean).map((m) => origMove[m.moveId] ?? m.moveId).filter((m) => m !== 'GULP_MISSILE_ARROKUDA' && m !== 'GULP_MISSILE_PIKACHU');
    const key = JSON.stringify([orig, p.ivs, p.shadowType === 'shadow', p.level > 40, fast, charged]);
    let rows = snapshotCache.get(key);
    if (rows) return rows;
    rows = fam.forms.map((formId) => {
      const q = buildPokemon(ctx, { speciesId: orig, ivs: { atk: p.ivs.atk, def: p.ivs.def, hp: p.ivs.hp }, shadow: p.shadowType === 'shadow', bestBuddy: p.level > 40 });
      applyGroupMoveset(q, { fastMove: fast, chargedMoves: charged });
      if (formId !== orig) q.changeForm(formId);
      const gmForm = ctx.gm.getPokemonById(formId);
      const nat = gmForm.nativeStatBuffs;
      const row = describeMonStatic(q);
      row.fcCode = fcCodeOf(q.formChange);
      row.fcOwn = gmForm.formChange ? 1 : 0;
      row.hasNative = nat ? 1 : 0;
      row.native = nat ? [nat[0], nat[1]] : [0, 0];
      return internMon(row);
    });
    snapshotCache.set(key, rows);
    return rows;
  }
  function formInfo(p) {
    const fam = familyOf(p);
    if (!fam && p.formChange) throw new Error(`unsupported form changer ${p.speciesId}: not one of Aegislash, Mimikyu, Cramorant, Morpeko`);
    if (!fam) return { kind: 0, slot: 0, forms: [0, 0, 0, 0], fcCode: fcCodeOf(p.formChange), fcOwn: 0, hasNative: 0, native: [0, 0] };
    const snaps = formSnapshots(p, fam);
    const slot = Math.max(0, fam.forms.indexOf(p.activeFormId));
    const gmForm = ctx.gm.getPokemonById(p.activeFormId);
    const nat = gmForm.nativeStatBuffs;
    return { kind: fam.kind, slot, forms: [snaps[0], snaps[1], snaps[2] ?? 0, 0], fcCode: fcCodeOf(p.formChange), fcOwn: gmForm.formChange ? 1 : 0, hasNative: nat ? 1 : 0, native: nat ? [nat[0], nat[1]] : [0, 0] };
  }

  /** Everything a battle reads off one Pokemon, as plain numbers. `entry` adds the live state at the call. */
  function describeMonStatic(p) {
    return {
      species: p.speciesId,
      atk: p.stats.atk,
      def: p.stats.def,
      hpMax: p.stats.hp,
      types: [typeId(p.types[0]), typeId(p.types[1] === 'none' ? null : p.types[1])],
      shadow: p.shadowType === 'shadow' ? 1 : 0,
      shadowAtk: p.shadowAtkMult,
      shadowDef: p.shadowDefMult,
      // defensive effectiveness vs each attacking type, in TYPES order
      eff: TYPES.map((t) => p.typeEffectiveness[t]),
      formChange: p.formChange ? 1 : 0,
      megaLevel: p.megaLevel,
      mega: typeof p.hasTag === 'function' && p.hasTag('mega') ? 1 : 0,
      // ActionLogic hard-codes Melmetal vs Cresselia (1/2)
      special: p.speciesName === 'Melmetal' ? 1 : p.speciesName === 'Cresselia' ? 2 : 0,
      fast: describeMove(p.fastMove),
      charged: [0, 1, 2].map((i) => describeMove(p.chargedMoves[i])),
      name: p.speciesName,
    };
  }
  function describeMon(p, entry) {
    const st = { ...describeMonStatic(p), ...formInfo(p) };
    const d = {
      mon: internMon(st),
      startForm: slotOf(p, p.startFormId),
      origForm: slotOf(p, p.originalFormId),
      startHp: p.startHp,
      startEnergy: p.startEnergy,
      startCooldown: p.startCooldown,
      startingShields: p.startingShields,
      startStatBuffs: [p.startStatBuffs[0], p.startStatBuffs[1]],
      nativeStatBuffs: [p.nativeStatBuffs[0], p.nativeStatBuffs[1]],
      priority: p.priority,
      turnsToKO: p.turnsToKO,
      baitShields: p.baitShields,
      farmEnergy: p.farmEnergy ? 1 : 0,
      optimizeMoveTiming: p.optimizeMoveTiming ? 1 : 0,
    };
    if (entry) d.statBuffs = [p.statBuffs[0], p.statBuffs[1]];
    return d;
  }


  // Static rows 0 and 1 are reserved for the two Gulp Missile moves (Cramorant's extraChargedMovePool entries):
  // the kernel inserts them as the defender's instant charged action. They sit in the `fast` slot of a dummy descriptor.
  {
    const c = buildPokemon(ctx, { speciesId: 'cramorant', ivs: { atk: 0, def: 15, hp: 15 } });
    for (const id of ['GULP_MISSILE_ARROKUDA', 'GULP_MISSILE_PIKACHU']) {
      const mv = c.extraChargedMovePool.find((m) => m.moveId === id);
      internMon({ ...describeMonStatic(c), species: id, name: id, fast: describeMove(mv), charged: [null, null, null], kind: 0, slot: 0, forms: [0, 0, 0, 0], fcCode: 0, fcOwn: 0, hasNative: 0, native: [0, 0] });
    }
  }

  return { describeMon, describeMonStatic, describeMove, internMon, monTable };
}
