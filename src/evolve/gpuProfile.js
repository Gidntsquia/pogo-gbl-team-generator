// Time attribution for `evolve --gpu` (gpu-profile.json in the run's out dir).
//
// Every second of a generation lands in exactly one bucket. Per battle step (one executor.run call):
//   plan      evaluate.js step (1): memo lookups + building the pending specs
//   pack      describe + pack the GPU share (node)
//   transport sidecar round trip minus the kernel span (pipe I/O, numpy, host<->device copies)
//   kernel    kernel span up to the moment half its battles have finished
//   tail      kernel span after that (fewer than 50% of its battles still running)
//   waitCpu   GPU side done, still waiting for the CPU share
//   flagged   serial CPU re-run of rows the kernel flagged invalid
//   map       executor.run bookkeeping: splitting specs by device, mapping kernel rows to results
//   accumulate evaluate.js step (3): fitness bookkeeping
// Per generation, outside the steps: `ga` (fitness/history + advanceSides, timed around the code),
// `checkpoint` (writeCheckpoint), `report` (generations analytics). Every bucket is a measured interval, none is a
// remainder: `unattributed` = generation wall minus every bucket (halving bookkeeping between rounds, timer gaps).
// Timing only: nothing here feeds a checkpoint or a result.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export const STEP_BUCKETS = ['plan', 'pack', 'transport', 'kernel', 'tail', 'waitCpu', 'flagged', 'map', 'accumulate'];
export const GEN_BUCKETS = [...STEP_BUCKETS, 'ga', 'checkpoint', 'report'];

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * @param {string} outDir - run out dir; the profile is rewritten to `<outDir>/gpu-profile.json` after each generation.
 * @param {object} [meta] - static facts recorded once (cpu share, batch limit, ...).
 * @returns {object} sink: step(rec), noteEval(rec), beginGen(g), endGen(rec), setPhase(name, ms), write().
 */
export function createGpuProfile(outDir, meta = {}) {
  const file = path.join(outDir, 'gpu-profile.json');
  const data = { formatVersion: 1, meta, phases: {}, steps: [], generations: [] };
  let gen = 'setup';
  let lastStep = null;
  return {
    file,
    data,
    /** One executor.run record (seconds in `buckets`, plus counts and launch details). */
    step(rec) {
      lastStep = { gen, ...rec };
      data.steps.push(lastStep);
    },
    /** evaluate.js's plan/accumulate times for the call that just finished (merged into its step). */
    noteEval({ planMs, accumulateMs, ranStep, memoHits }) {
      if (!ranStep || !lastStep || lastStep.evalNoted) {
        lastStep = { gen, n: 0, memoHits, buckets: Object.fromEntries(STEP_BUCKETS.map((b) => [b, 0])), wall: 0 };
        data.steps.push(lastStep);
      }
      lastStep.evalNoted = true;
      lastStep.buckets.plan = planMs / 1000;
      lastStep.buckets.accumulate = accumulateMs / 1000;
      lastStep.wall += (planMs + accumulateMs) / 1000;
    },
    beginGen(g) { gen = g; },
    /** Close generation `gen`: rec = {wall, ga, checkpoint, report} in seconds. */
    endGen(rec) {
      const steps = data.steps.filter((s) => s.gen === gen);
      const buckets = Object.fromEntries(STEP_BUCKETS.map((b) => [b, sum(steps.map((s) => s.buckets[b] ?? 0))]));
      buckets.ga = rec.ga; buckets.checkpoint = rec.checkpoint; buckets.report = rec.report;
      const attributed = sum(Object.values(buckets));
      data.generations.push({
        gen, wall: rec.wall, buckets, unattributed: rec.wall - attributed,
        steps: steps.length, battles: sum(steps.map((s) => s.n ?? 0)), gpuBattles: sum(steps.map((s) => s.gpu ?? 0)),
        cpuBattles: sum(steps.map((s) => s.cpu ?? 0)), flaggedRows: sum(steps.map((s) => s.flaggedRows ?? 0)),
      });
      this.write();
    },
    /** Whole-run phases outside the generation loop (setup, sidecarStart, finalPass, outputs), seconds. */
    setPhase(name, s) { data.phases[name] = s; },
    write() { writeFileSync(file, JSON.stringify(data, null, 1)); },
  };
}
