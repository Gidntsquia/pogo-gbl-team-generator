// Engine choice for one run: the GPU path is the default, with one fallback to the CPU workers when the sidecar cannot start.

/**
 * Start the GPU executor. A sidecar that cannot start (no NVIDIA device, no uv, died while booting; `err.gpuStart`) prints
 * one `gpu: <reason>, running on CPU` line, sets `config.engine = 'cpu-fallback'` (a non-fingerprint field) and returns
 * `{ executor: null }`; the caller keeps the CPU executor. Any other error propagates (exit 1, resume with the same command).
 * @param {{create: Function, ctx: object, cpuExecutor: object, config: object, log: Function, profile?: object}} a
 * @returns {Promise<{executor: object|null}>}
 */
export async function startGpuEngine({ create, ctx, cpuExecutor, config, log, profile }) {
  try {
    return { executor: await create({ ctx, cpuExecutor, cpuShare: config.gpuCpuShare, log, profile }) };
  } catch (err) {
    if (!err?.gpuStart) throw err;
    const reason = String(err.message ?? err).split('\n')[0].replace(/^gpu:\s*/, '').replace(/,? running on CPU$/, '');
    log(`gpu: ${reason}, running on CPU`);
    config.engine = 'cpu-fallback';
    return { executor: null };
  }
}
