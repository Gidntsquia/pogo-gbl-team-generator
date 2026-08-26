// JavaScript Document
//
// Runs scan.swift (see that file's header) over a video and yields one parsed
// observation per sampled frame. This is the only module in src/videoscan
// that touches a subprocess or the platform -- everything else is pure and
// testable against recorded frames.
//
// macOS only: frame decoding is AVFoundation and the text recognizer is
// Apple's Vision framework, both of which ship with the OS, which is why this
// feature needs no npm dependency, no ffmpeg, and no OCR install.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { platform } from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCAN_SWIFT_PATH = path.join(HERE, 'scan.swift');
/** Compiled helper lives with the other build artifacts (CLAUDE.md: out/). */
const BIN_DIR = path.resolve(HERE, '../../out/.videoscan');

/**
 * Region of the frame whose pixels are run-length encoded, normalized with a
 * TOP-LEFT origin. Pokemon GO draws the appraisal panel in the lower-left of
 * the screen; keeping the region off the right-hand side skips the trainer
 * avatar, which is the only large photographic area near the bars.
 */
export const DEFAULT_REGION = { x: 0, y: 0.55, w: 0.62, h: 0.45 };

/**
 * @typedef {object} Frame
 * @property {number} t - presentation timestamp in seconds.
 * @property {number} w
 * @property {number} h
 * @property {import('./text.js').TextBox[]} text
 * @property {{y: number, runs: number[][]}[]} rows
 */

/**
 * Decode and analyse a video, yielding one Frame per sampled timestamp.
 *
 * @param {string} videoPath
 * @param {{interval?: number, region?: {x: number, y: number, w: number, h: number}, signal?: AbortSignal}} [opts]
 * @returns {AsyncGenerator<Frame>}
 */
export async function* probeVideo(videoPath, opts = {}) {
  if (platform !== 'darwin') {
    throw new Error(
      'videoscan needs macOS: it decodes frames with AVFoundation and reads ' +
        'text with the Vision framework, both of which are macOS system frameworks.'
    );
  }
  try {
    if (!statSync(videoPath).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`No video file at ${videoPath}`);
  }
  const interval = opts.interval ?? 0.25;
  const region = opts.region ?? DEFAULT_REGION;

  const [command, leadingArgs] = await scanCommand();
  const child = spawn(
    command,
    [...leadingArgs, videoPath, String(interval), String(region.x), String(region.y), String(region.w), String(region.h)],
    { stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal }
  );

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
  });

  const exited = new Promise((resolve, reject) => {
    child.on('error', (err) =>
      reject(
        err.code === 'ENOENT'
          ? new Error("videoscan needs the `swift` command (install Xcode Command Line Tools: xcode-select --install)")
          : err
      )
    );
    child.on('close', (code) => resolve(code));
  });

  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      if (!line.startsWith('{')) continue;
      yield JSON.parse(line);
    }
  } finally {
    // Consumers may stop early (--limit); don't leave a decoder running.
    if (child.exitCode === null) child.kill();
  }

  const code = await exited;
  if (code !== 0 && code !== null) {
    throw new Error(`scan.swift exited ${code}: ${swiftDiagnostics(stderr) || 'no output'}`);
  }
}

/**
 * Run the helper as a compiled binary, building it once and caching it under
 * out/ keyed by the source's own hash (so editing scan.swift rebuilds it and
 * an old build is never silently reused).
 *
 * This is worth the one-time ~10s build: `swift file.swift` runs the script
 * unoptimized, and the helper's inner loop touches every pixel of the region
 * in every sampled frame. On a full-resolution phone recording that is the
 * difference between roughly 80 seconds and 15 for the same output.
 *
 * @returns {Promise<[string, string[]]>} command and the args that precede
 *   the caller's own -- falls back to interpreting the script when the
 *   compiler is unavailable or the build fails.
 */
async function scanCommand() {
  const fallback = ['swift', [SCAN_SWIFT_PATH]];
  let binary;
  try {
    const hash = createHash('sha256').update(readFileSync(SCAN_SWIFT_PATH)).digest('hex').slice(0, 16);
    binary = path.join(BIN_DIR, `scan-${hash}`);
    if (existsSync(binary)) return [binary, []];
    mkdirSync(BIN_DIR, { recursive: true });
  } catch {
    return fallback;
  }

  const built = await new Promise((resolve) => {
    const build = spawn('swiftc', ['-O', SCAN_SWIFT_PATH, '-o', binary], { stdio: 'ignore' });
    build.on('error', () => resolve(false));
    build.on('close', (code) => resolve(code === 0));
  });
  return built && existsSync(binary) ? [binary, []] : fallback;
}

/**
 * Swift script mode writes deprecation warnings to stderr, each followed by
 * the offending source line -- and those echoed source lines contain the very
 * words we search for, so they have to go first, before anything is matched.
 */
function swiftDiagnostics(stderr) {
  return stderr
    .split('\n')
    .filter((l) => !/^\s*(\d+\s*\||\||[\^~`])/.test(l))
    .filter((l) => !/\.swift:\d+:\d+:\s*(warning|note)/i.test(l))
    .filter((l) => /error|failed|no video track|no frames decoded/i.test(l))
    .join('\n')
    .trim();
}
