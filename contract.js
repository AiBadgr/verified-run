/**
 * Minimal Remote Execution Adapter contract.
 *
 * This is deliberately a request translator, not an SDK or execution layer.
 * Adapters collect context from their host tool, then translate it into the
 * existing Badgr `POST /v1/run` request shape with this function.
 */
export function toCustomRunJob(request) {
  const {
    source, ref, command, maxCost, maxRuntimeMinutes,
    resource = 'cpu', env = {}, name = '',
  } = request;

  if (!source || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(source)) {
    throw new Error('source must be a GitHub repository URL');
  }
  if (!ref) throw new Error('ref is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(ref) || ref.includes('..') || ref.includes('@{')) {
    throw new Error('ref must be a valid Git commit or ref name');
  }
  if (!Array.isArray(command) || command.length === 0 || command.some(arg => typeof arg !== 'string')) {
    throw new Error('command must be a non-empty argv array');
  }
  if (!Number.isFinite(maxCost) || maxCost <= 0) throw new Error('max-cost must be a positive number');
  if (!Number.isFinite(maxRuntimeMinutes) || maxRuntimeMinutes <= 0) {
    throw new Error('max-runtime must be a positive number');
  }

  return {
    github_url: source,
    github_ref: ref,
    command_argv: command,
    max_cost_usd: maxCost,
    max_runtime_seconds: maxRuntimeMinutes * 60,
    ...(resource === 'gpu' ? { gpu: 'AUTO' } : { compute: 'cpu', no_gpu: true }),
    ...(name ? { name } : {}),
    env: { ...env },
  };
}
