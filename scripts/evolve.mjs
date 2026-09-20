#!/usr/bin/env node
// Genetic-algorithm team search CLI. Run `node scripts/evolve.mjs --help` for every flag.
// The implementation lives in src/evolve/ (see the module map in CLAUDE.md).
import { main } from '../src/evolve/cli.js';
import { reportCliError } from '../src/util/userError.js';

main(process.argv.slice(2)).catch(reportCliError);
