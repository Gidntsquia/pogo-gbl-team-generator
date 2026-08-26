#!/usr/bin/env node
// JavaScript Document
//
// One-off generator for src/cost/evolutionCandy.json.
//
// vendor/pvpoke's gamemaster.json records WHICH species a Pokemon evolves
// into (`family.evolutions`) but not what the evolution costs -- pvpoke's own
// src/data/parseEvolution.php reads the official GAME_MASTER and deliberately
// keeps only the ids. So the candy costs come straight from the same official
// source pvpoke parses, and are baked into a small checked-in JSON file here
// rather than fetched at runtime (the CLI never touches the network).
//
// Re-run after a vendor/pvpoke bump that adds species:
//   node scripts/build-evolution-costs.mjs
//   node scripts/build-evolution-costs.mjs --gm /path/to/latest.json   (offline)
//
// Every pair written is keyed by vendor/pvpoke's OWN speciesIds and only for
// pairs pvpoke itself lists, so the file can never introduce an evolution the
// engine can't build. Pairs pvpoke lists but the official GAME_MASTER doesn't
// price are simply left out -- src/evolution/index.js reports those as an
// unknown candy cost rather than guessing one.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PVPOKE_GM = path.join(ROOT, 'vendor/pvpoke/src/data/gamemaster.json');
const OUT = path.join(ROOT, 'src/cost/evolutionCandy.json');
const GM_URL = 'https://raw.githubusercontent.com/PokeMiners/game_masters/master/latest/latest.json';

// pvpoke writes regional forms with the adjective ("_alolan"); the official
// GAME_MASTER uses the region ("_ALOLA"). Same mapping src/importer/
// gamemaster.js already applies to CSV form columns, one layer down.
const FORM_SUFFIX = {
  _alola: '_alolan',
  _galar: '_galarian',
  _hisui: '_hisuian',
  _paldea: '_paldean',
};

/** Official GAME_MASTER id -> vendor/pvpoke speciesId spelling. */
function normalizeId(id) {
  let s = String(id).toLowerCase().replace('_normal', '');
  for (const [region, adjective] of Object.entries(FORM_SUFFIX)) {
    if (s.endsWith(region)) s = s.slice(0, -region.length) + adjective;
  }
  return s;
}

/** "ITEM_METAL_COAT" -> "Metal Coat" (display only). */
function itemName(id) {
  return String(id)
    .replace(/^ITEM_/, '')
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function loadOfficialGameMaster(argv) {
  const flag = argv.indexOf('--gm');
  if (flag !== -1) {
    const file = argv[flag + 1];
    if (!file) throw new Error('--gm needs a path to an official GAME_MASTER json');
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  process.stderr.write(`Fetching ${GM_URL} ...\n`);
  const res = await fetch(GM_URL);
  if (!res.ok) throw new Error(`GAME_MASTER download failed: HTTP ${res.status}`);
  return res.json();
}

/** parentSpeciesId -> [{child, childForm, candy, purifiedCandy, item, buddyKm}] */
function indexOfficialBranches(templates) {
  const byParent = new Map();
  for (const template of templates) {
    const settings = template.data?.pokemonSettings;
    if (!settings?.evolutionBranch) continue;
    // Shadow/purified templates mirror the base one; the multipliers are
    // applied at read time in src/evolution/index.js instead.
    if (template.templateId.includes('SHADOW') || template.templateId.includes('PURIFIED')) continue;

    const parent = normalizeId(settings.form || settings.pokemonId);
    const branches = settings.evolutionBranch
      .filter((b) => b.evolution)
      .map((b) => ({
        child: normalizeId(b.evolution),
        childForm: b.form ? normalizeId(b.form) : null,
        candy: b.candyCost ?? null,
        purifiedCandy: b.candyCostPurified ?? null,
        item: b.evolutionItemRequirementId || b.evolutionItemRequirement || null,
        buddyKm: b.kmBuddyDistanceRequirement ?? null,
      }));
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(...branches);
  }
  return byParent;
}

async function main(argv) {
  const pvpoke = JSON.parse(readFileSync(PVPOKE_GM, 'utf8'));
  const byParent = indexOfficialBranches(await loadOfficialGameMaster(argv));

  const pairs = {};
  const unpriced = [];
  let total = 0;

  for (const mon of pvpoke.pokemon) {
    // Shadow entries mirror their base species' family; the shadow candy
    // multiplier is applied at read time, so only base pairs are stored.
    if (mon.speciesId.endsWith('_shadow')) continue;
    for (const child of mon.family?.evolutions ?? []) {
      total += 1;
      const branches = byParent.get(mon.speciesId) ?? [];
      const hit =
        branches.find((b) => (b.childForm || b.child) === child) ??
        branches.find((b) => b.child === child);
      if (!hit || hit.candy == null) {
        unpriced.push(`${mon.speciesId} > ${child}`);
        continue;
      }
      const entry = { candy: hit.candy };
      if (hit.purifiedCandy != null) entry.purifiedCandy = hit.purifiedCandy;
      if (hit.item) entry.item = itemName(hit.item);
      if (hit.buddyKm) entry.buddyKm = hit.buddyKm;
      pairs[`${mon.speciesId}>${child}`] = entry;
    }
  }

  const out = {
    _source: GM_URL,
    _generated: new Date().toISOString().slice(0, 10),
    _note:
      'Generated by scripts/build-evolution-costs.mjs. Keys are ' +
      '"<parentSpeciesId>><childSpeciesId>" using vendor/pvpoke speciesIds, ' +
      'restricted to pairs pvpoke itself lists in family.evolutions. ' +
      'Shadow costs are candy x1.2 (rounded up), applied at read time.',
    _unpriced: unpriced,
    pairs,
  };
  writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  process.stderr.write(
    `Wrote ${OUT}: ${Object.keys(pairs).length}/${total} pvpoke evolution pairs priced, ` +
      `${unpriced.length} left unpriced.\n`
  );
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
