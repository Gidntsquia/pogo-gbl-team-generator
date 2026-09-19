import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { filterEligibleMons } from '../src/util/eligibility.js';

describe('filterEligibleMons', () => {
  test('cup "all" (eligibleSpeciesIds === null) is a no-op: everything passes, no warnings', () => {
    const ctx = { cup: 'all', eligibleSpeciesIds: null };
    const mons = [{ speciesId: 'azumarill' }, { speciesId: 'gardevoir' }, { speciesId: 'medicham' }];
    const result = filterEligibleMons(ctx, mons);
    assert.deepEqual(result.mons, mons);
    assert.deepEqual(result.warnings, []);
  });

  test('drops ineligible mons and warns, by name when present', () => {
    const ctx = {
      cup: 'willpower',
      eligibleSpeciesIds: new Set(['medicham', 'sableye', 'annihilape']),
      battle: { getCup: () => ({ title: 'Willpower Cup' }) },
    };
    const mons = [
      { speciesId: 'medicham', name: 'Meddy' },
      { speciesId: 'azumarill', name: 'Azu' },
      { speciesId: 'sableye' },
      { speciesId: 'annihilape' },
    ];
    const result = filterEligibleMons(ctx, mons);
    assert.deepEqual(
      result.mons.map((m) => m.speciesId),
      ['medicham', 'sableye', 'annihilape']
    );
    assert.deepEqual(result.warnings, ['Azu (azumarill): not eligible for Willpower Cup']);
  });

  test('checks the shadow-suffixed id for shadow mons', () => {
    const ctx = {
      cup: 'willpower',
      eligibleSpeciesIds: new Set(['medicham', 'sableye_shadow', 'annihilape']),
    };
    const mons = [
      { speciesId: 'sableye', shadow: true }, // eligible via sableye_shadow
      { speciesId: 'sableye', shadow: false }, // NOT eligible: base id isn't in the set
      { speciesId: 'medicham', shadow: false },
      { speciesId: 'annihilape', shadow: false },
    ];
    const result = filterEligibleMons(ctx, mons);
    assert.deepEqual(
      result.mons.map((m) => `${m.speciesId}${m.shadow ? '_shadow' : ''}`),
      ['sableye_shadow', 'medicham', 'annihilape']
    );
  });

  test('throws when fewer than 3 mons survive', () => {
    const ctx = { cup: 'willpower', eligibleSpeciesIds: new Set(['medicham', 'sableye']) };
    const mons = [{ speciesId: 'medicham' }, { speciesId: 'azumarill' }, { speciesId: 'gardevoir' }];
    assert.throws(() => filterEligibleMons(ctx, mons), /only 1 mon\(s\) eligible/);
  });
});
