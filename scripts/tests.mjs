// JavaScript Document
//
// Picks which test files a run covers, and hands them to node's own test
// runner. There is no test framework here and no config file to hold this:
// `node --test` takes a list of files and nothing else, so the tier lives in
// a script rather than in a `testPathIgnorePatterns`-style setting.
//
// A file is in the SLOW tier when its source carries a `@slow` marker in its
// header comment. The marker sits in the test file itself so it travels with
// the tests it describes, and so `grep -l @slow test/` always answers "what
// does `npm test` leave out?" without reading package.json.
//
//   node scripts/tests.mjs            # fast tier: everything unmarked
//   node scripts/tests.mjs slow       # only the @slow files
//   node scripts/tests.mjs all        # the union -- required before a push
//   node scripts/tests.mjs changed    # only what this working tree touches
//
// Extra arguments are forwarded to node, so
// `node scripts/tests.mjs slow --test-name-pattern=deterministic` works.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

/** How far into a file the `@slow` marker is allowed to be. */
const MARKER_LINES = 40;

const MODES = new Set(['fast', 'slow', 'all', 'changed']);

/**
 * Every test file in test/, as repo-relative paths.
 *
 * @returns {string[]}
 */
export function allTestFiles() {
  return readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join('test', f));
}

/**
 * Is this file marked `@slow`?
 *
 * @param {string} file - repo-relative.
 * @returns {boolean}
 */
export function isSlow(file) {
  const head = readFileSync(path.join(ROOT, file), 'utf8').split('\n', MARKER_LINES);
  return head.some((line) => line.includes('@slow'));
}

/**
 * The test files worth running for the current working-tree changes: any test
 * file that changed, plus any test file that imports a changed module.
 *
 * Deliberately generous -- a test file counts as touching a module if it
 * mentions that module's path anywhere, so a helper pulled in indirectly
 * still drags its tests in. Falls back to the fast tier when nothing maps,
 * because "no tests" is never the useful answer to "did I break something?".
 *
 * @param {string[]} files - every test file, repo-relative.
 * @returns {string[]}
 */
export function changedTestFiles(files) {
  let changed = [];
  try {
    const merge = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    changed = execFileSync('git', ['diff', '--name-only', merge, '--'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
  } catch {
    changed = execFileSync('git', ['diff', '--name-only', 'HEAD', '--'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
  }
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((l) => l.slice(3).trim());
  const touched = [...new Set([...changed, ...dirty])].filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
  if (touched.length === 0) return files.filter((f) => !isSlow(f));

  // Match on the module PATH, not its basename: half of src/ is an
  // index.js, and matching that bare word drags in every test in the repo.
  const stems = touched
    .filter((f) => !f.endsWith('.test.js'))
    .map((f) => f.replace(/\.m?js$/, ''))
    .filter((s) => s.length > 2);
  const picked = files.filter((f) => {
    if (touched.includes(f)) return true;
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    return stems.some((stem) => src.includes(stem));
  });
  return picked.length > 0 ? picked : files.filter((f) => !isSlow(f));
}

/**
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {{mode: string, files: string[], nodeArgs: string[]}}
 */
export function plan(argv) {
  const mode = MODES.has(argv[0]) ? argv[0] : 'fast';
  const nodeArgs = argv.slice(MODES.has(argv[0]) ? 1 : 0);
  const files = allTestFiles();
  const picked =
    mode === 'all' ? files
      : mode === 'slow' ? files.filter(isSlow)
        : mode === 'changed' ? changedTestFiles(files)
          : files.filter((f) => !isSlow(f));
  return { mode, files: picked, nodeArgs };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { mode, files, nodeArgs } = plan(process.argv.slice(2));
  if (files.length === 0) {
    console.error(`tests: no test files in the "${mode}" tier`);
    process.exit(1);
  }
  console.error(`tests: ${mode} tier -- ${files.length} file(s)`);
  const run = spawnSync(process.execPath, ['--test', ...nodeArgs, ...files], { cwd: ROOT, stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
