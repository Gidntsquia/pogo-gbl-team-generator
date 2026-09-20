#!/usr/bin/env node
// Re-renders a completed evolve run's my-teams-evolve.md/.html from the
// evolve-result.json a run writes alongside them (see runEvolution in
// evolve.mjs) -- no sim, no battles, just re-running the report templates.
// Use this after a report-rendering fix (wording, a new section, a bug in
// renderEvolveReport/renderEvolveReportHtml) instead of re-running the whole
// evolve recipe just to pick up the fix.
//
// Usage: node scripts/render-report.mjs <out-dir>
//   <out-dir>  a directory containing evolve-result.json (e.g. out/evolve-jet-standard-1)

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderEvolveReportHtml } from '../src/evolve/reportHtml.js';
import { renderEvolveReport } from '../src/evolve/reportMd.js';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node scripts/render-report.mjs <out-dir>');
  process.exit(1);
}

const resultPath = path.join(outDir, 'evolve-result.json');
const result = JSON.parse(readFileSync(resultPath, 'utf8'));

const reportPath = result.reportPath ?? path.join(outDir, 'my-teams-evolve.md');
writeFileSync(reportPath, renderEvolveReport(result), 'utf8');
console.log(`report written to ${reportPath}`);

if (result.htmlPath) {
  writeFileSync(result.htmlPath, renderEvolveReportHtml(result), 'utf8');
  console.log(`HTML report written to ${result.htmlPath}`);
}
