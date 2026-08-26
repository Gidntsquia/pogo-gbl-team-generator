// Tests for scripts/evolve.mjs (the evolutionary team search driver).
// Drives the exported `runEvolution` in-process (no subprocess, no network)
// with tiny knobs (ticket-specified: pop 6, 2 gens, 2 opponents) so the real
// pvpoke 3v3 engine still runs but the battle count stays small -- mirrors
// test/tournament.test.js's approach to scripts/tournament.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runEvolution } from '../scripts/evolve.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-pokegenie.csv');

// Ticket-specified tiny knobs: pop 6, 2 gens, 2 opponents.
const TINY = {
  scoreMeta: 4,
  pool: 8,
  population: 6,
  opponentsPerGen: 2,
  generations: 2,
  eliteCount: 3,
  seed: 'evolve-test-seed',
};

function tmpOutDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Order-independent team signature (matches scripts/evolve.mjs's own sig convention). */
function teamSig(team) {
  return team.members.map((m) => m.key).sort().join('|');
}

// Shared fresh run (module scope, same pattern test/tournament.test.js uses).
const SHARED_DIR = tmpOutDir('gbl-evolve-shared-');
const SHARED_REPORT = path.join(SHARED_DIR, 'my-teams-evolve.md');
const shared = await runEvolution(FIXTURE, { ...TINY, outDir: SHARED_DIR, out: SHARED_REPORT });

test('completes and produces a well-formed report + all checkpoints + analytics + DONE marker', () => {
  assert.equal(shared.generationRecords.length, TINY.generations, 'ran the full generation cap (no early convergence expected at 2 gens)');
  assert.equal(shared.stopReason, `generations cap reached (${TINY.generations})`);

  assert.ok(shared.elites.length >= 1, 'named >= 1 elite team');
  assert.ok(shared.elites.length <= TINY.eliteCount, 'eliteCount cap honored');

  const top = shared.elites[0];
  assert.equal(top.members.length, 3, 'a team has 3 members');
  assert.equal(new Set(top.members.map((m) => m.speciesId)).size, 3, 'team members are distinct species');
  assert.ok(top.winRate >= 0 && top.winRate <= 1, 'win rate in [0,1]');
  assert.ok(top.bestLead && typeof top.bestLead.name === 'string', 'bestLead present (locked-lead: always resolves to team[0])');
  assert.ok(Array.isArray(top.hardestOpponents) && top.hardestOpponents.length <= 5, 'up to 5 hardest opponents');

  for (let i = 1; i < shared.elites.length; i++) {
    const a = shared.elites[i - 1];
    const b = shared.elites[i];
    assert.ok(a.winRate > b.winRate || (a.winRate === b.winRate && a.avgHpMargin >= b.avgHpMargin), 'elites sorted best-first');
  }

  assert.ok(existsSync(SHARED_REPORT), 'report.md written');
  const md = readFileSync(SHARED_REPORT, 'utf8');
  assert.match(md, /Evolutionary Team Search Report/);
  assert.match(md, /## Generation-by-generation summary/);
  assert.match(md, /## Species trajectory/);
  assert.match(md, /## Top cores/);
  assert.match(md, /## Elite team detail/);
  assert.ok(md.includes(top.members[0].name), 'report names the top team');

  assert.ok(shared.importWarnings.some((w) => /freakemon/i.test(w)), 'unknown-species row surfaced as a warning');
  assert.match(md, /## Collection warnings/);

  assert.ok(shared.htmlPath, 'htmlPath recorded on the result');
  assert.ok(existsSync(shared.htmlPath), 'report.html written');
  const html = readFileSync(shared.htmlPath, 'utf8');
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<title>/i);
  assert.match(html, /Evolutionary Team Search Report/);
  assert.match(html, /<h2>Generation-by-generation summary<\/h2>/);
  assert.match(html, /<h2>Species trajectory/);
  assert.match(html, /<h2>Top cores/);
  assert.match(html, /<h2>Elite team detail<\/h2>/);
  assert.ok(html.includes(top.members[0].name), 'HTML report names the top team');
  assert.doesNotMatch(html, /<script/i);

  for (let g = 0; g < TINY.generations; g++) {
    const p = path.join(SHARED_DIR, `evolve-gen${g}.json`);
    assert.ok(existsSync(p), `generation ${g} checkpoint written`);
    const cp = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(cp.generation, g);
    assert.ok(Array.isArray(cp.population) && cp.population.length >= 1, `generation ${g} checkpoint has a population`);
    assert.equal(cp.population.length, cp.fitness.length, 'fitness is positional (one entry per population member)');
    assert.ok(cp.timing && cp.timing.battleCount > 0, `generation ${g} checkpoint has timing`);
  }

  assert.ok(existsSync(shared.donePath), 'DONE marker written');
  const done = readFileSync(shared.donePath, 'utf8');
  assert.match(done, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'DONE starts with an ISO timestamp');
  assert.match(done, /Evolution complete/);
});

test('out/evolve-generations.json has the expected analytics shape', () => {
  const p = path.join(SHARED_DIR, 'evolve-generations.json');
  assert.ok(existsSync(p), 'analytics file written');
  const analytics = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(analytics.length, TINY.generations);

  analytics.forEach((g, i) => {
    assert.equal(g.generation, i);
    assert.ok(typeof g.battleCount === 'number' && g.battleCount > 0);
    assert.ok(typeof g.meanFitness === 'number' && g.meanFitness >= 0 && g.meanFitness <= 1);
    assert.ok(typeof g.maxFitness === 'number' && g.maxFitness >= g.meanFitness);
    assert.ok(Array.isArray(g.speciesStats) && g.speciesStats.length > 0, 'per-species representation/meanFitness present');
    for (const s of g.speciesStats) {
      assert.ok(typeof s.speciesId === 'string');
      assert.ok(s.representation > 0 && s.representation <= 1);
    }
    assert.ok(Array.isArray(g.topCores), 'elite core-pair counts present (even if empty on a tiny population)');

    // Generation 0 has no PRIOR generation to compute survival/origin from
    // (it's the first-ever population); generation 1 (this run's last, since
    // isLastAllowedGeneration skips computing an outgoing lineage) also has
    // none, by this driver's own design (no next generation is ever computed
    // for the run's final allowed generation).
    if (i === analytics.length - 1) {
      assert.equal(g.originCounts, null, 'no outgoing lineage from the final generation (nextGeneration is never called for it)');
      assert.equal(g.survivalBySpecies, null);
    } else {
      assert.ok(g.originCounts, 'origin counts present for a non-final generation');
      assert.equal(g.originCounts.survived + g.originCounts.mutant + g.originCounts.immigrant, TINY.population, 'origin counts sum to the population size');
    }
  });
});

test('deterministic: two fresh runs with the same seed produce identical elite rankings', async () => {
  const outDir = tmpOutDir('gbl-evolve-det-');
  const other = await runEvolution(FIXTURE, { ...TINY, outDir, out: path.join(outDir, 'r.md') });

  const sigsShared = shared.elites.map(teamSig);
  const sigsOther = other.elites.map(teamSig);
  assert.deepEqual(sigsOther, sigsShared, 'same seed -> identical elite team order');

  const ratesShared = shared.elites.map((t) => t.winRate);
  const ratesOther = other.elites.map((t) => t.winRate);
  assert.deepEqual(ratesOther, ratesShared, 'same seed -> identical win rates (battles are seeded, not wall-clock random)');

  const analyticsShared = JSON.parse(readFileSync(path.join(SHARED_DIR, 'evolve-generations.json'), 'utf8'));
  const analyticsOther = JSON.parse(readFileSync(path.join(outDir, 'evolve-generations.json'), 'utf8'));
  assert.deepEqual(
    analyticsOther.map((g) => g.meanFitness),
    analyticsShared.map((g) => g.meanFitness),
    'same seed -> identical per-generation mean fitness'
  );
});

test('a different seed produces a different population trajectory', async () => {
  const outDir = tmpOutDir('gbl-evolve-diffseed-');
  const other = await runEvolution(FIXTURE, { ...TINY, seed: 'a-totally-different-seed', outDir, out: path.join(outDir, 'r.md') });
  const sigsShared = shared.elites.map(teamSig);
  const sigsOther = other.elites.map(teamSig);
  assert.notDeepEqual(sigsOther, sigsShared);
});

test('resume: deleting only the generation-1 checkpoint re-runs just that generation (generation 0 skipped)', async () => {
  const gen0Path = path.join(SHARED_DIR, 'evolve-gen0.json');
  const gen1Path = path.join(SHARED_DIR, 'evolve-gen1.json');

  const mtime0Before = statSync(gen0Path).mtimeMs;
  const gen1Before = JSON.parse(readFileSync(gen1Path, 'utf8'));

  rmSync(gen1Path);
  rmSync(shared.donePath);

  const logs = [];
  const resumed = await runEvolution(FIXTURE, {
    ...TINY,
    outDir: SHARED_DIR,
    out: SHARED_REPORT,
    onLog: (msg) => logs.push(msg),
  });

  assert.equal(statSync(gen0Path).mtimeMs, mtime0Before, 'generation 0 checkpoint untouched (skipped, not rewritten)');
  assert.ok(
    logs.some((l) => /resuming -- 1 generation\(s\) already complete/i.test(l)),
    'log shows generation 0 was resumed/skipped'
  );

  assert.ok(existsSync(gen1Path), 'generation 1 checkpoint rewritten');
  assert.ok(existsSync(resumed.donePath), 'DONE marker rewritten');

  // Same seed + same config -> generation 1 recomputes to the same result.
  assert.deepEqual(
    resumed.generationRecords[1].fitness,
    gen1Before.fitness,
    'resumed generation 1 reproduces the same fitness values as the original run'
  );
  assert.ok(resumed.elites.length >= 1, 'resumed run still produces elite teams');
});

test('opts.threads (persistent worker-pool executor) produces a well-formed run with no battle errors on a clean fixture', async () => {
  const threadedDir = tmpOutDir('gbl-evolve-threaded-');
  const threaded = await runEvolution(FIXTURE, {
    ...TINY,
    outDir: threadedDir,
    out: path.join(threadedDir, 'r.md'),
    threads: 2,
  });

  assert.equal(threaded.generationRecords.length, TINY.generations);
  for (const r of threaded.generationRecords) {
    assert.equal(r.threadsUsed, 2, 'threadsUsed recorded on every generation checkpoint');
    assert.equal(r.timing.errorCount, 0, 'no battle-batch errors on a clean fixture run');
  }
  assert.ok(threaded.elites.length >= 1);

  const report = readFileSync(threaded.reportPath, 'utf8');
  assert.match(report, /threads: 2 \(worker-pool executor\)/);
});

test('opts.noHtml skips writing the HTML report; opts.html sends it to a custom path', async () => {
  const noHtmlDir = tmpOutDir('gbl-evolve-nohtml-');
  const noHtmlResult = await runEvolution(FIXTURE, { ...TINY, outDir: noHtmlDir, out: path.join(noHtmlDir, 'r.md'), noHtml: true });
  assert.equal(noHtmlResult.htmlPath, null, 'htmlPath is null when noHtml is set');
  assert.ok(!existsSync(path.join(noHtmlDir, 'my-teams-evolve.html')), 'no HTML file written');

  const customDir = tmpOutDir('gbl-evolve-customhtml-');
  const customHtmlPath = path.join(customDir, 'custom-report.html');
  const customResult = await runEvolution(FIXTURE, {
    ...TINY,
    outDir: customDir,
    out: path.join(customDir, 'r.md'),
    html: customHtmlPath,
  });
  assert.equal(customResult.htmlPath, customHtmlPath);
  assert.ok(existsSync(customHtmlPath), 'HTML written to the custom path');
});

test('locked leads : every elite team\'s bestLead is its team[0] (member order preserved end to end)', () => {
  for (const t of shared.elites) {
    assert.equal(t.bestLead.key, t.members[0].key, 'bestLead resolves to the first-listed member, the designated lead');
  }
});

test('resuming refuses an old-format (pre-lock) checkpoint instead of silently misreading it', async () => {
  const outDir = tmpOutDir('gbl-evolve-oldformat-');
  const out = path.join(outDir, 'r.md');
  await runEvolution(FIXTURE, { ...TINY, outDir, out });

  const gen0Path = path.join(outDir, 'evolve-gen0.json');
  const cp = JSON.parse(readFileSync(gen0Path, 'utf8'));
  assert.equal(cp.formatVersion, 2, 'sanity: a freshly-written checkpoint carries the current format version');
  delete cp.formatVersion; // simulate a pre-lock checkpoint (config schema is unchanged, so it would otherwise match)
  writeFileSync(gen0Path, JSON.stringify(cp, null, 2), 'utf8');
  rmSync(path.join(outDir, 'evolve-DONE'));

  await assert.rejects(
    () => runEvolution(FIXTURE, { ...TINY, outDir, out }),
    /checkpoint format/i,
    'resuming an unversioned/old-format checkpoint throws a clear error instead of silently resuming'
  );
});

// Battle-reality fitness blend (snowball +
// closer terms), --fitness classic|battle-reality. A later change flipped the
// DEFAULT to 'battle-reality' (see DEFAULTS.fitness's own comment + the A/B
// measurement) -- `shared` (no explicit `fitness` in TINY) now runs
// battle-reality by default; classic is tested explicitly below.
test('battle-reality fitness components (snowball/closer/blendFitness) are always computed, regardless of --fitness mode', () => {
  for (const t of shared.elites) {
    assert.ok(Number.isInteger(t.exchangeWon) && t.exchangeWon >= 0, 'exchangeWon is a non-negative count');
    assert.ok(Number.isInteger(t.exchangeLost) && t.exchangeLost >= 0, 'exchangeLost is a non-negative count');
    assert.ok(t.exchangeWon + t.exchangeLost <= t.battles, 'decided exchanges cannot exceed battles fought');
    assert.ok(t.snowballScore >= 0 && t.snowballScore <= 1, 'snowballScore in [0,1]');
    assert.ok(t.closerScore >= 0 && t.closerScore <= 1, 'closerScore in [0,1]');
    assert.ok(t.blendFitness >= 0 && t.blendFitness <= 1, 'blendFitness in [0,1]');
  }
  const md = readFileSync(SHARED_REPORT, 'utf8');
  assert.match(md, /Snowball score:/, 'report surfaces the snowball score');
  assert.match(md, /Closer score:/, 'report surfaces the closer score');
  assert.match(md, /fitness: battle-reality/, 'Settings line names the default fitness mode (flipped to battle-reality)');
});

test('--fitness classic still computes the battle-reality components (report-only; the GA itself consumes plain winRate)', async () => {
  const outDir = tmpOutDir('gbl-evolve-classicdefault-');
  const classic = await runEvolution(FIXTURE, { ...TINY, outDir, out: path.join(outDir, 'r.md'), fitness: 'classic' });
  assert.equal(classic.config.fitness, 'classic');
  for (const t of classic.elites) {
    assert.ok(t.snowballScore >= 0 && t.snowballScore <= 1, 'snowballScore still computed under classic mode');
    assert.ok(t.closerScore >= 0 && t.closerScore <= 1, 'closerScore still computed under classic mode');
  }
  const md = readFileSync(classic.reportPath, 'utf8');
  assert.match(md, /Snowball score:/);
  assert.match(md, /Closer score:/);
  assert.match(md, /fitness: classic/);
});

test('--fitness battle-reality: config fingerprint records the mode, run completes, and fitness values differ from classic winRate in general', async () => {
  const outDir = tmpOutDir('gbl-evolve-blend-');
  const blended = await runEvolution(FIXTURE, { ...TINY, outDir, out: path.join(outDir, 'r.md'), fitness: 'battle-reality' });

  assert.equal(blended.config.fitness, 'battle-reality');
  assert.equal(blended.generationRecords.length, TINY.generations);

  const gen0 = JSON.parse(readFileSync(path.join(outDir, 'evolve-gen0.json'), 'utf8'));
  assert.equal(gen0.config.fitness, 'battle-reality', 'checkpoint config fingerprint records the fitness mode');
  // fitness[i] should equal blendFitness reconstructed from winRate/snowballScore/closerScore for every
  // population member this generation -- i.e. the GA is actually consuming the blend, not silently
  // falling back to winRate. (population/fitness are positional and parallel by construction.)
  for (const t of blended.elites) {
    const reconstructed = 0.6 * t.winRate + 0.3 * t.snowballScore + 0.1 * t.closerScore;
    assert.ok(Math.abs(t.blendFitness - reconstructed) < 1e-9, 'blendFitness matches the documented weight formula');
  }

  const md = readFileSync(blended.reportPath, 'utf8');
  assert.match(md, /fitness: battle-reality \(weights: winRate=0\.6, snowball=0\.3, closer=0\.1\)/);

  // A checkpoint written under a different --fitness mode must NOT be silently
  // resumed as if it were the requested mode (fitness is part of buildRunConfig,
  // so configsMatch already diverges -- this just confirms the resume scan
  // correctly starts fresh rather than reusing generation 0's population).
  // Explicit 'classic' here (TINY's implicit default is now
  // battle-reality, same as `blended` above -- an implicit-default second run
  // would now MATCH and legitimately resume rather than exercise the mismatch).
  const classicOnSameDir = await runEvolution(FIXTURE, { ...TINY, outDir, out: path.join(outDir, 'r2.md'), fitness: 'classic' });
  assert.equal(classicOnSameDir.config.fitness, 'classic');
});

test('--fitness with an unrecognized value throws a clear error', async () => {
  const outDir = tmpOutDir('gbl-evolve-badfitness-');
  await assert.rejects(
    () => runEvolution(FIXTURE, { ...TINY, outDir, out: path.join(outDir, 'r.md'), fitness: 'nonsense' }),
    /opts\.fitness must be one of/i
  );
});

// "Lead / Back / Back" report naming, plus the
// snowballIndex/comebackIndex/designatedCloser metrics distinct from the
// fitness blend's own snowballScore/closerScore components.
test('reports name teams "Lead / Back / Back" (member[0] first, marked as lead)', () => {
  const top = shared.elites[0];
  const [lead, ...backs] = top.members;

  const md = readFileSync(SHARED_REPORT, 'utf8');
  assert.ok(md.includes(`${lead.name} (Lead) / ${backs.map((b) => b.name).join(' / ')}`), 'Markdown report uses the Lead/Back/Back format for the top team');
  assert.match(md, /Team \(Lead \/ Back \/ Back\)/, 'top-teams table header names the format');

  const html = readFileSync(shared.htmlPath, 'utf8');
  assert.ok(html.includes(`${lead.name} <em>(Lead)</em> / ${backs.map((b) => b.name).join(' / ')}`), 'HTML report uses the same Lead/Back/Back format');
});

test('snowballIndex/comebackIndex/designatedCloser are present on every elite (null when unmeasured, else in [0,1])', () => {
  for (const t of shared.elites) {
    assert.ok(t.snowballIndex === null || (t.snowballIndex >= 0 && t.snowballIndex <= 1), 'snowballIndex is null or in [0,1]');
    assert.ok(t.comebackIndex === null || (t.comebackIndex >= 0 && t.comebackIndex <= 1), 'comebackIndex is null or in [0,1]');
    if (t.snowballIndex !== null) assert.ok(t.exchangeWon > 0, 'a non-null snowballIndex implies at least one won exchange');
    if (t.comebackIndex !== null) assert.ok(t.exchangeLost > 0, 'a non-null comebackIndex implies at least one lost exchange');

    assert.ok(t.designatedCloser === null || typeof t.designatedCloser.name === 'string', 'designatedCloser is null or a named member');
    if (t.designatedCloser) {
      const backKeys = t.members.slice(1).map((m) => m.key);
      assert.ok(backKeys.includes(t.designatedCloser.key), 'designatedCloser is one of the two back members, never the lead');
      assert.ok(t.designatedCloser.closer >= 0 && t.designatedCloser.closer <= 1, 'designatedCloser.closer is a normalized role prior');
    }
  }

  const md = readFileSync(SHARED_REPORT, 'utf8');
  assert.match(md, /Snowball index:/, 'report surfaces the snowball index');
  assert.match(md, /Comeback index:/, 'report surfaces the comeback index');
  assert.match(md, /Designated closer:/, 'report surfaces the designated closer');
  const html = readFileSync(shared.htmlPath, 'utf8');
  assert.match(html, /Snowball index:/);
  assert.match(html, /Comeback index:/);
  assert.match(html, /Designated closer:/);
});

test('out/evolve-generations.json carries per-generation topTeams with the new fields', () => {
  const p = path.join(SHARED_DIR, 'evolve-generations.json');
  const analytics = JSON.parse(readFileSync(p, 'utf8'));
  for (const g of analytics) {
    assert.ok(Array.isArray(g.topTeams) && g.topTeams.length > 0, 'topTeams present and non-empty');
    assert.ok(g.topTeams.length <= 10, 'topTeams capped at 10, same as topCores\' eliteIdx');
    g.topTeams.forEach((t, i) => {
      assert.equal(t.rank, i + 1, 'rank is 1-based and matches array order');
      assert.ok(Array.isArray(t.members) && t.members.length === 3, 'each topTeams entry names its 3 members');
      assert.ok(typeof t.fitness === 'number', 'fitness recorded');
      assert.ok(t.winRate === null || (t.winRate >= 0 && t.winRate <= 1));
      assert.ok(t.snowballIndex === null || (t.snowballIndex >= 0 && t.snowballIndex <= 1));
      assert.ok(t.comebackIndex === null || (t.comebackIndex >= 0 && t.comebackIndex <= 1));
      assert.ok('designatedCloser' in t, 'designatedCloser key present even when null');
    });
    // Ranked best-fitness-first, matching how eliteIdx/rankedIdx was built.
    for (let i = 1; i < g.topTeams.length; i++) {
      assert.ok(g.topTeams[i - 1].fitness >= g.topTeams[i].fitness, 'topTeams sorted best-fitness-first');
    }
  }
});

test('--fixed-opponents reuses the same opponent draw for every generation', async () => {
  const outDir = tmpOutDir('gbl-evolve-fixed-');
  const result = await runEvolution(FIXTURE, { ...TINY, fixedOpponents: true, outDir, out: path.join(outDir, 'r.md') });

  assert.equal(result.generationRecords.length, TINY.generations);
  const gen0 = JSON.parse(readFileSync(path.join(outDir, 'evolve-gen0.json'), 'utf8'));
  const gen1 = JSON.parse(readFileSync(path.join(outDir, 'evolve-gen1.json'), 'utf8'));
  assert.equal(gen0.opponentCount, gen1.opponentCount, 'same opponent count reused (fixed draw)');
});
