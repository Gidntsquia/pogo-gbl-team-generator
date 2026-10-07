// pogo-sim-extra: everything outside the sim lifecycle (raw launch, reports, analysis scripts, checks).
// Off by default in Claude Code; see RUNBOOK.md "MCP server" for how to enable it.
import {
  z, execFileSync, existsSync, readdirSync, readFileSync, statSync, path, REPO, makeServer, flags, flagsToArgv, reply, fail, sh,
  safeName, waitFirstLine, writeLaunch, launchDetached, guardLaunch, PIN, ensureReport,
} from './common.mjs';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

const { server, tool, start } = makeServer('pogo-sim-extra');

tool('run_raw', 'LAUNCHES a detached `node scripts/evolve.mjs` with any flags (names exactly as in --help, no --). Unknown flags are rejected with the nearest valid name. Starts a long-running process.',
  {
    name: z.string(), collection: z.string(),
    flags: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
  },
  async (a) => {
    const n = safeName(a.name);
    const argv = [a.collection, ...flagsToArgv(a.flags, flags())];
    if (!argv.includes('--out-dir')) argv.push('--out-dir', `out/evolve-${n}`);
    if (!argv.includes('--seed')) argv.push('--seed', n);
    guardLaunch(n);
    const check = await sh('node', ['scripts/evolve.mjs', ...argv, '--check']);
    if (!check.ok) return fail(check.out);
    writeLaunch(n, argv, { via: 'run_raw' });
    const pid = launchDetached(n, argv);
    const first = await waitFirstLine(n, pid);
    return reply(`Launched detached run '${n}' (pid ${pid}).\n${first}`, { name: n, pid, command: `node scripts/evolve.mjs ${argv.join(' ')}`, firstLine: first });
  });

tool('list_collections', 'List collection CSVs (repo root and fixtures/) with row counts.', {}, async () => {
  const rows = [];
  for (const d of ['.', 'fixtures']) {
    for (const f of readdirSync(path.join(REPO, d))) {
      if (!f.endsWith('.csv')) continue;
      const p = path.join(d, f);
      rows.push({ path: p, rows: readFileSync(path.join(REPO, p), 'utf8').split('\n').filter(Boolean).length - 1 });
    }
  }
  return reply(rows.map((r) => `${r.path}: ${r.rows} rows`).join('\n'), rows);
});

// ---- reports ----

server.registerResource('run-report', new ResourceTemplate('pogo-sim://runs/{name}/report.html', { list: undefined }), { description: 'Final HTML report of a run', mimeType: 'text/html' }, async (uri, { name }) => {
  const r = await ensureReport(safeName(String(name)));
  if (r.err) throw new Error(r.err);
  return { contents: [{ uri: uri.href, mimeType: 'text/html', text: readFileSync(r.html, 'utf8') }] };
});

const script = (file, build) => async (a) => {
  const r = await sh('node', [file, ...build(a)]);
  return r.ok ? reply(r.out.split('\n').slice(-25).join('\n')) : fail(r.out);
};
tool('render_report', 'Re-render a run\'s reports from evolve-result.json.', { name: z.string() }, script('scripts/render-report.mjs', (a) => [`out/evolve-${safeName(a.name)}`]));
tool('chart_top_teams', 'Race chart of the top teams of a run.', { name: z.string(), top: z.number().optional(), out: z.string().optional() },
  script('scripts/chart-top-teams.mjs', (a) => [`out/evolve-${safeName(a.name)}`, ...(a.top ? ['--top', String(a.top)] : []), ...(a.out ? ['--out', a.out] : [])]));
tool('fitness_sides', 'Candidate-vs-opponent fitness side comparison for a run.', { name: z.string() },
  script('scripts/fitness-sides.mjs', (a) => [`out/evolve-${safeName(a.name)}`]));
tool('symmetry_gap', 'scripts/symmetry-gap.mjs report --label L [--minus B].', { label: z.string(), minus: z.string().optional() },
  script('scripts/symmetry-gap.mjs', (a) => ['report', '--label', a.label, ...(a.minus ? ['--minus', a.minus] : [])]));
tool('build_curated_from_meta', 'Build a curated team set from a meta run dir.', {
  out_dir: z.string(), cup: z.string(), candidates: z.number().optional(), opponents: z.number().optional(),
}, script('scripts/build-curated-from-meta.mjs', (a) => [a.out_dir, '--cup', a.cup, ...(a.candidates ? ['--candidates', String(a.candidates)] : []), ...(a.opponents ? ['--opponents', String(a.opponents)] : [])]));
tool('build_shared_collection', 'Intersect two collection CSVs into a shared-pool CSV.', { csvA: z.string(), csvB: z.string(), out: z.string(), cp: z.number().optional() },
  script('scripts/build-shared-collection.mjs', (a) => [a.csvA, a.csvB, '--out', a.out, ...(a.cp ? ['--cp', String(a.cp)] : [])]));
tool('build_meta_collection', 'Build the meta collection CSV for a cup/cp.', { cup: z.string().optional(), cp: z.number().optional(), out: z.string().optional() },
  script('scripts/build-meta-collection.mjs', (a) => [...(a.cp ? ['--cp', String(a.cp)] : []), ...(a.cup ? ['--cup', a.cup] : []), ...(a.out ? ['--out', a.out] : [])]));
tool('refresh_usage', 'Fetches live GL rankings into data/meta-usage.json (network; deliberate, human-triggered).', { confirm: z.boolean() },
  async (a) => (a.confirm === true ? script('scripts/refresh-usage.mjs', () => [])(a) : fail('pass confirm:true')));

// ---- preflight & checks ----
tool('preflight', 'Runs scripts/setup.sh and checks branch, pvpoke pin and the three pinned move values.', {}, async () => {
  const checks = [];
  const setup = await sh('bash', ['scripts/setup.sh']);
  checks.push({ check: 'setup.sh', pass: setup.ok, detail: setup.out.split('\n').slice(-1)[0] });
  const br = await sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  checks.push({ check: 'branch is main', pass: br.out === 'main', detail: br.out });
  const head = await sh('git', ['-C', 'vendor/pvpoke', 'rev-parse', 'HEAD']);
  checks.push({ check: 'pvpoke pin', pass: head.out === PIN, detail: head.out });
  const gm = await sh('node', ['-e', `
    const m=JSON.parse(require('fs').readFileSync('vendor/pvpoke/src/data/gamemaster.json','utf8')).moves;
    const g=(id)=>{const x=m.find(y=>y.moveId===id);return x&&[x.power,x.energy,x.energyGain].join('/')};
    console.log(['BODY_SLAM','BUBBLE_BEAM','INFESTATION'].map(g).join(' '))`]);
  checks.push({ check: 'moves BODY_SLAM 65/40/0, BUBBLE_BEAM 50/50/0, INFESTATION 10/0/12', pass: gm.ok && gm.out === '65/40/0 50/50/0 10/0/12', detail: gm.out });
  return reply(checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.check}${c.pass ? '' : ` (${c.detail})`}`).join('\n'), checks);
});

tool('smoke_test', 'Runs a ~1-2 minute foreground smoke sim (2 generations, population 12) and returns the last log lines.', { csv: z.string().optional() }, async (a) => {
  const dir = `out/smoke-mcp`;
  const r = await sh('node', ['scripts/evolve.mjs', a.csv ?? 'fixtures/sample-pokegenie.csv', '--generations', '2', '--population', '12',
    '--opponents-per-gen', '8', '--threads', '2', '--out-dir', dir, '--force-fresh', '--no-html'], 300000);
  return r.ok ? reply(r.out.split('\n').slice(-8).join('\n')) : fail(r.out);
});

tool('check_sim', 'Validates a proposed evolve flag set (--check): nothing runs.', { collection: z.string(), flags: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional() }, async (a) => {
  const r = await sh('node', ['scripts/evolve.mjs', a.collection, ...flagsToArgv(a.flags, flags()), '--check']);
  return r.ok ? reply(`ok\n${r.out.split('\n').slice(-5).join('\n')}`) : fail(r.out);
});

await start();
