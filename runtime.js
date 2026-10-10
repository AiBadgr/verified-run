export function createRunClient({ apiBase, apiKey, fetchImpl = fetch }) {
  const base = apiBase.replace(/\/$/, '');
  async function request(path, options = {}) {
    const response = await fetchImpl(`${base}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...options.headers },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof body.detail === 'string' ? body.detail : body.detail?.message;
      const error = new Error(body.message || detail || `Badgr API returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }
  return {
    submit: body => request('/run', { method: 'POST', body: JSON.stringify(body) }),
    status: id => request(`/deployments/${id}`),
    logs: id => request(`/deployments/${id}/logs`),
    cancel: id => request(`/deployments/${id}`, { method: 'DELETE' }),
    // Used by badgr-verified-run (shares this file): agent jobs and artifacts.
    submitJob: body => request('/jobs', { method: 'POST', body: JSON.stringify(body) }),
    job: id => request(`/jobs/${encodeURIComponent(id)}`),
    jobLogs: id => request(`/jobs/${encodeURIComponent(id)}/logs`),
    cancelJob: id => request(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
    // 404 and 410 mean the run produced no artifact (or it expired), which is not an error.
    artifact: id => request(`/deployments/${encodeURIComponent(id)}/artifacts`).catch(error => {
      if (error.status === 404 || error.status === 410) return null;
      throw error;
    }),
  };
}

export async function waitForRun(client, id, { onLogs = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let seen = 0;
  while (true) {
    const [status, logs] = await Promise.all([client.status(id), client.logs(id)]);
    const text = Array.isArray(logs.logs) ? logs.logs.join('\n') : (logs.logs || '');
    if (text.length > seen) onLogs(text.slice(seen));
    seen = text.length;
    if (['completed', 'succeeded', 'failed', 'stopped', 'canceled'].includes(status.status)) return status;
    await sleep(3000);
  }
}

const JOB_TERMINAL = ['completed', 'succeeded', 'failed', 'stopped', 'canceled', 'cancelled', 'error'];

/** Poll an agent job (/v1/jobs) until it is terminal, streaming new log text. Returns the job. */
export async function waitForJob(client, id, { onLogs = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let seen = 0;
  while (true) {
    const job = await client.job(id);
    const logs = await client.jobLogs(id).catch(() => ({ logs: '' }));
    const text = Array.isArray(logs.logs) ? logs.logs.join('\n') : (logs.logs || '');
    if (text.length > seen) onLogs(text.slice(seen));
    seen = text.length;
    if (JOB_TERMINAL.includes(job.status)) return job;
    await sleep(5000);
  }
}
