// JavaScript Document
//
// Evolution expansion: let a collection compete as the Pokemon it could
// become, not only as the Pokemon it is today.
//
// WHY: src/engine/harness.js levels every mon up to the league's CP cap but
// never evolves it, so a Phantump was only ever simulated as a Phantump. That
// silently writes off most of a collection -- an unevolved mon usually can't
// reach the CP cap at all, so it loses every matchup for a reason that has
// nothing to do with whether it's worth building.
//
// WHAT THIS DOES: for every mon in the collection, add one extra candidate per
// species it can still evolve into (transitively -- Timburr yields Gurdurr
// AND Conkeldurr), carrying the same IVs, level, and shadow/purified/lucky
// flags, because evolving in Pokemon GO changes none of those. Every form is
// then scored normally and the pipeline picks whichever one actually performs
// (src/teams/index.js's dedupeBestPerSpecies collapses a lineage down to its
// best-scoring form), so "evolve it if the current form isn't viable" falls
// out of the existing ranking rather than needing a hand-tuned viability rule.
//
// Every variant shares its source row's `lineageKey`, which is what stops a
// team from fielding both Phantump and Trevenant off the same physical
// Pokemon.
//
// Evolution data comes from vendor/pvpoke's own `family.evolutions`; the candy
// costs come from ../cost/evolutionCandy.json (see
// scripts/build-evolution-costs.mjs -- pvpoke parses the official GAME_MASTER
// but drops the costs). No battle math and no network here.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COST_PATH = path.resolve(HERE, '../cost/evolutionCandy.json');

/**
 * Shadow Pokemon cost 20% more candy to evolve, rounded up -- the same rule
 * src/cost/powerup.js applies to power-ups. Purified costs come from the
 * official GAME_MASTER's own `candyCostPurified` field where it exists (it is
 * not always exactly 0.9x, so it is read rather than derived).
 */
const SHADOW_CANDY_MULTIPLIER = 1.2;

let cachedCosts = null;

function costTable() {
  if (!cachedCosts) cachedCosts = JSON.parse(readFileSync(COST_PATH, 'utf8'));
  return cachedCosts;
}

/**
 * @typedef {object} EvolutionStep
 * @property {string} from - parent speciesId.
 * @property {string} to - child speciesId.
 * @property {number|null} candy - candy for this one step, multipliers
 *   applied; null when the official GAME_MASTER doesn't price this pair (see
 *   `_unpriced` in evolutionCandy.json) -- never guessed.
 * @property {string|null} item - required evolution item, e.g. "Sinnoh Stone".
 * @property {number|null} buddyKm - buddy km required before evolving.
 */

/**
 * @typedef {object} EvolutionTarget
 * @property {string} speciesId - the evolved species.
 * @property {string} speciesName - its display name.
 * @property {number} steps - how many evolutions away it is.
 * @property {number|null} candy - total candy for the whole path (null if any
 *   step is unpriced).
 * @property {string[]} items - evolution items needed along the path.
 * @property {number|null} buddyKm - largest buddy-km requirement on the path.
 * @property {EvolutionStep[]} path
 */

function stepCost(from, to, { shadow = false, purified = false } = {}) {
  const entry = costTable().pairs[`${from}>${to}`];
  if (!entry) return { candy: null, item: null, buddyKm: null };
  let candy = entry.candy;
  if (shadow) candy = Math.ceil(candy * SHADOW_CANDY_MULTIPLIER);
  else if (purified && entry.purifiedCandy != null) candy = entry.purifiedCandy;
  return { candy, item: entry.item ?? null, buddyKm: entry.buddyKm ?? null };
}

/**
 * Every species `speciesId` can still evolve into, transitively.
 *
 * Unreleased species and ids vendor/pvpoke names but doesn't ship an entry for
 * are skipped (the engine couldn't build them). Traversal is cycle-guarded:
 * pvpoke's family data is a DAG today, but a single bad pair would otherwise
 * hang the run.
 *
 * @param {object} ctx - from initEngine (uses ctx.gm only).
 * @param {string} speciesId - base (non-shadow) speciesId to start from.
 * @param {{shadow?: boolean, purified?: boolean}} [opts] - candy multipliers.
 * @returns {EvolutionTarget[]} nearest-first; empty for a fully-evolved mon.
 */
export function evolutionTargets(ctx, speciesId, opts = {}) {
  const { gm } = ctx;
  const out = [];
  const seen = new Set([speciesId]);
  const queue = [{ id: speciesId, path: [] }];

  while (queue.length) {
    const { id, path: sofar } = queue.shift();
    const entry = gm.getPokemonById(id);
    for (const child of entry?.family?.evolutions ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      const childEntry = gm.getPokemonById(child);
      if (!childEntry || childEntry.released === false) continue;

      const step = { from: id, to: child, ...stepCost(id, child, opts) };
      const nextPath = [...sofar, step];
      const candies = nextPath.map((s) => s.candy);
      out.push({
        speciesId: child,
        speciesName: childEntry.speciesName,
        steps: nextPath.length,
        candy: candies.includes(null) ? null : candies.reduce((a, b) => a + b, 0),
        items: [...new Set(nextPath.map((s) => s.item).filter(Boolean))],
        buddyKm: nextPath.reduce((max, s) => (s.buddyKm > (max ?? 0) ? s.buddyKm : max), null),
        path: nextPath,
      });
      queue.push({ id: child, path: nextPath });
    }
  }

  return out;
}

/**
 * The lineage a mon belongs to: every form derived from one physical Pokemon
 * (one CSV row) shares this, so src/teams/dedupeBestPerSpecies can keep only
 * the best form of it and no team can ever field two forms of the same mon.
 *
 * @param {{sourceRow?: number, speciesId: string}} mon
 * @returns {string}
 */
export function lineageKeyFor(mon) {
  return mon.sourceRow !== undefined ? `row${mon.sourceRow}` : `species:${mon.speciesId}`;
}

/**
 * Expand a normalized collection with one extra entry per species each mon
 * could evolve into.
 *
 * Evolving in Pokemon GO preserves IVs, level, and the shadow/purified/lucky/
 * Best Buddy flags, so those carry over verbatim. Two fields deliberately do
 * NOT: `cp` (recomputed by the engine from the evolved base stats, and the
 * CSV's value would be wrong for the new species) and `moves` (the evolved
 * form has a different movepool, so `--current-moves` falls back to pvpoke's
 * recommended moveset for the variant, with a warning).
 *
 * Existing entries are returned unchanged apart from gaining a `lineageKey`.
 *
 * @param {object} ctx - from initEngine.
 * @param {import('../scoring/index.js').NormalizedMon[]} mons
 * @returns {{mons: object[], warnings: string[]}} `mons` is the original list
 *   followed by the evolved variants; each variant carries an `evolution`
 *   field describing where it came from and what it costs.
 */
export function expandEvolutions(ctx, mons) {
  const out = [];
  const warnings = [];

  for (const mon of mons) {
    const lineageKey = lineageKeyFor(mon);
    out.push({ ...mon, lineageKey });

    let targets;
    try {
      targets = evolutionTargets(ctx, mon.speciesId, {
        shadow: !!mon.shadow,
        purified: !!mon.purified,
      });
    } catch (err) {
      warnings.push(`${mon.name} (row ${mon.sourceRow}): could not read evolutions -- ${err.message}`);
      continue;
    }

    for (const target of targets) {
      if (target.candy === null) {
        warnings.push(
          `${mon.name} -> ${target.speciesName}: no published evolution candy cost, ` +
            'so this variant is scored but its build cost excludes the evolution'
        );
      }
      if (mon.moves) {
        warnings.push(
          `${mon.name} -> ${target.speciesName}: evolved forms have a different movepool, ` +
            "so this variant uses pvpoke's recommended moveset rather than your current moves"
        );
      }
      const { cp, moves, ...rest } = mon;
      out.push({
        ...rest,
        speciesId: target.speciesId,
        name: target.speciesName,
        lineageKey,
        evolution: {
          fromSpeciesId: mon.speciesId,
          fromName: mon.name,
          steps: target.steps,
          candy: target.candy,
          items: target.items,
          buddyKm: target.buddyKm,
        },
      });
    }
  }

  return { mons: out, warnings };
}
