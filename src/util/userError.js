/**
 * An error caused by the user's input (a bad flag, a missing file, a setup
 * step not run) rather than a bug. CLIs print `message` and `fix` on two
 * lines and exit with `exitCode` instead of dumping a stack trace.
 */
export class UserError extends Error {
  /**
   * @param {string} message - what is wrong, one line.
   * @param {string} [fix] - what to run or change instead, one line.
   * @param {number} [exitCode] - process exit code (2 = usage error, 1 = other).
   */
  constructor(message, fix, exitCode = 2) {
    super(message);
    this.name = 'UserError';
    this.fix = fix;
    this.exitCode = exitCode;
  }
}

/**
 * Report an error the way every CLI in this repo should: user errors as
 * `error: ...` / `fix: ...`, anything else as `Error: message` (plus the stack
 * when EVOLVE_DEBUG is set), and set `process.exitCode`.
 *
 * @param {unknown} err
 */
export function reportCliError(err) {
  if (err instanceof UserError) {
    process.stderr.write(`error: ${err.message}\n`);
    if (err.fix) process.stderr.write(`fix:   ${err.fix}\n`);
    process.exitCode = err.exitCode;
    return;
  }
  process.stderr.write(`\nError: ${err?.message ?? err}\n`);
  if (process.env.EVOLVE_DEBUG && err?.stack) process.stderr.write(`${err.stack}\n`);
  process.exitCode = 1;
}
