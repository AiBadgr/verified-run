import process from 'node:process';
import { appendFileSync } from 'node:fs';
import { toCustomRunJob } from './contract.js';
import { createRunClient, waitForRun, waitForJob } from './runtime.js';
import { buildRemoteScript, parseChecks, parseResults, summaryMarkdown } from './verify.js';

const FORWARDED_SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

export function input(name, fallback = '', env = process.env) {
  return env[`INPUT_${name.toUpperCase().replaceAll('-', '_')}`] || fallback;
}

function resolveApiBase(env = process.env) {
  return (env.BADGR_API_URL || 'https://aibadgr.com/v1').replace(/\/$/, '');
}

function resolveAppBase(env = process.env) {
  return (env.BADGR_APP_URL || resolveApiBase(env).replace(/\/v1$/, '')).replace(/\/$/, '');
}

export function maskSecrets(env = process.env, write = s => process.stdout.write(s)) {
  for (const value of [env.BADGR_API_KEY, env.GITHUB_TOKEN, env.INPUT_GITHUB_TOKEN,
    ...FORWARDED_SECRET_ENV_VARS.map(n => env[n])]) {
    if (value) write(`::add-mask::${value}\n`);
  }
}

function positive(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

export function buildRequest(env = process.env) {
  const task = input('task', '', env).trim();
  const checks = parseChecks(input('checks', '', env));
  if (checks.length === 0) throw new Error('checks is required: a run with no checks cannot be verified');
  const repository = env.GITHUB_REPOSITORY;
  const githubToken = input('github-token', '', env) || env.GITHUB_TOKEN || '';
  const request = toCustomRunJob({
    source: input('source', '', env) || (repository ? `https://github.com/${repository}` : ''),
    ref: input('ref', '', env) || env.GITHUB_SHA || '',
    command: ['bash', '-c', buildRemoteScript({ task, checks })],
    maxCost: positive('max-cost', input('max-cost', '', env)),
    maxRuntimeMinutes: positive('max-runtime', input('max-runtime', '60', env)),
    resource: input('resource', 'cpu', env) === 'gpu' ? 'gpu' : 'cpu',
    name: `Verified run ${env.GITHUB_RUN_ID || 'run'} / ${env.GITHUB_JOB || 'job'}`,
    env: {
      GITHUB_RUN_ID: env.GITHUB_RUN_ID || '',
      ...(githubToken ? { GITHUB_TOKEN: githubToken, BADGR_GITHUB_TOKEN: githubToken } : {}),
      ...Object.fromEntries(FORWARDED_SECRET_ENV_VARS.filter(k => env[k]).map(k => [k, env[k]])),
    },
  });
  return { request, task, checks };
}

function setOutput(name, value) {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    // Multi-line safe delimiter form.
    appendFileSync(out, `${name}<<BADGR_EOF\n${rendered}\nBADGR_EOF\n`);
  }
}

export function buildLaunchRequest(env = process.env) {
  const agent = input('agent', '', env);
  const instruction = input('task', '', env).trim();
  const checks = parseChecks(input('checks', '', env));
  if (!instruction) throw new Error('task is required in launch mode: it is the instruction for the agent');
  if (checks.length === 0) throw new Error('checks is required: a launch must be verifiable');
  const repository = env.GITHUB_REPOSITORY;
  const source = input('source', '', env) || (repository ? `https://github.com/${repository}` : '');
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(source)) throw new Error('source must be a GitHub repository URL');
  return {
    request: {
      type: 'agent',
      input: { repository: source, instruction, check: checks.map(c => c.command).join(' && '), agent },
      policy: {
        max_cost: positive('max-cost', input('max-cost', '', env)),
        max_runtime_minutes: positive('max-runtime', input('max-runtime', '60', env)),
      },
    },
    checks,
  };
}

const LAUNCH_OK = ['completed', 'succeeded'];

async function runLaunch({ api, env, onLogs }) {
  const { request, checks } = buildLaunchRequest(env);
  const created = await api.submitJob(request);
  const id = created.job_id;
  const runUrl = created.status_url || `${resolveAppBase(env)}/r/${id}`;
  process.stdout.write(`Badgr agent job: ${id}\nEvidence: ${runUrl}\n`);
  setOutput('job-id', id);
  setOutput('run-url', runUrl);

  let job;
  try {
    job = await waitForJob(api, id, { onLogs });
  } catch (error) {
    await api.cancelJob(id).catch(() => {});
    throw error;
  }
  const ok = LAUNCH_OK.includes(job.status);
  // The agent job is verified by one combined check command, so per-check
  // results are not available in launch mode: every check shares the job's state.
  const state = ok ? 'passed' : 'failed';
  const result = {
    verified: ok,
    task: { state, exit_code: null },
    checks: checks.map(c => ({ name: c.name, command: c.command, exit_code: null, state })),
  };
  const cost = job.accrued_cost_usd ?? job.receipt?.total_usd ?? '';
  const receipt = job.receipt ? JSON.stringify(job.receipt) : '';
  setOutput('verified', String(ok));
  setOutput('checks', result.checks);
  setOutput('status', job.status);
  setOutput('cost', String(cost));
  setOutput('receipt', receipt);
  setOutput('artifact-url', '');
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown({ result, jobId: id, cost, runUrl, artifactUrl: '' }) + '\n');
  }
  if (!ok) throw new Error(`Not verified: agent job ${job.status}${job.error?.message ? `: ${job.error.message}` : ''}`);
  return { id, result, receipt: job.receipt };
}

export async function run({ client, env = process.env, onLogs = t => process.stdout.write(t) } = {}) {
  if (!env.BADGR_API_KEY) throw new Error('BADGR_API_KEY is required');
  maskSecrets(env);
  const api = client || createRunClient({ apiBase: resolveApiBase(env), apiKey: env.BADGR_API_KEY });
  if (input('agent', '', env)) return runLaunch({ api, env, onLogs });
  const { request, task, checks } = buildRequest(env);

  const created = await api.submit(request);
  const id = created.deployment_id;
  const runUrl = created.status_url || `${resolveAppBase(env)}/r/${id}`;
  process.stdout.write(`Badgr job: ${id}\nEvidence: ${runUrl}\n`);
  setOutput('job-id', id);
  setOutput('run-url', runUrl);

  let logText = '';
  let status;
  try {
    status = await waitForRun(api, id, { onLogs: text => { logText += text; onLogs(text); } });
  } catch (error) {
    // Do not leave a billable job running when this process loses the job.
    await api.cancel(id).catch(() => {});
    throw error;
  }
  const result = parseResults({ logText, checks, task, jobStatus: status.status });

  const artifact = await api.artifact(id).catch(() => null);
  const artifactUrl = artifact?.download_url || '';
  const cost = status.accrued_cost_usd ?? '';

  setOutput('verified', String(result.verified));
  setOutput('checks', result.checks);
  setOutput('status', status.status);
  setOutput('cost', String(cost));
  setOutput('artifact-url', artifactUrl);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown({ result, jobId: id, cost, runUrl, artifactUrl }) + '\n');
  }
  if (!result.verified) {
    const bad = result.checks.filter(c => c.state !== 'passed').map(c => `${c.name} (${c.state})`);
    throw new Error(`Not verified: job ${status.status}; task ${result.task.state}; ${bad.length ? bad.join(', ') : 'all checks passed'}`);
  }
  return { id, result, artifactUrl };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  run().catch(error => { process.stderr.write(`::error::${error.message}\n`); process.exitCode = 1; });
}
