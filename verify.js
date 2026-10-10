/**
 * Builds the remote script and turns its log markers into verified results.
 *
 * A check is "verified" only when its exit marker was printed by the remote
 * script. A check with no marker (job killed, timed out, log truncated) is
 * "unverified", never "passed".
 */

const MARKER = /^::BADGR_(TASK|CHECK)::(\d+)::(-?\d+)\s*$/gm;

export function shq(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/** Each line is a command; an optional `[name]` prefix names it. */
export function parseChecks(text = '') {
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      const m = /^\[([^\]]+)\]\s*(.+)$/.exec(line);
      return m ? { name: m[1], command: m[2] } : { name: line, command: line };
    });
}

export function buildRemoteScript({ task, checks }) {
  const lines = ['set +e', 'failed=0'];
  if (task) {
    lines.push(`bash -lc ${shq(task)}`, 'code=$?', 'echo "::BADGR_TASK::0::$code"', '[ "$code" -ne 0 ] && failed=1');
  }
  checks.forEach((c, i) => {
    lines.push(`bash -lc ${shq(c.command)}`, 'code=$?', `echo "::BADGR_CHECK::${i}::$code"`, '[ "$code" -ne 0 ] && failed=1');
  });
  lines.push('exit $failed');
  return lines.join('\n');
}

export function parseResults({ logText = '', checks, task, jobStatus }) {
  const exits = { TASK: new Map(), CHECK: new Map() };
  for (const m of logText.matchAll(MARKER)) exits[m[1]].set(Number(m[2]), Number(m[3]));

  const results = checks.map((c, i) => {
    const exit = exits.CHECK.get(i);
    const state = exit === undefined ? 'unverified' : exit === 0 ? 'passed' : 'failed';
    return { name: c.name, command: c.command, exit_code: exit ?? null, state };
  });
  const taskExit = exits.TASK.get(0);
  const taskState = !task ? 'skipped' : taskExit === undefined ? 'unverified' : taskExit === 0 ? 'passed' : 'failed';

  const jobOk = ['completed', 'succeeded'].includes(jobStatus);
  const verified = jobOk
    && results.length > 0
    && results.every(r => r.state === 'passed')
    && (taskState === 'passed' || taskState === 'skipped');
  return { verified, task: { state: taskState, exit_code: taskExit ?? null }, checks: results };
}

export function summaryMarkdown({ result, jobId, cost, runUrl, artifactUrl }) {
  const icon = { passed: 'PASS', failed: 'FAIL', unverified: 'UNVERIFIED', skipped: 'SKIPPED' };
  const rows = result.checks.map(c => `| ${c.name.replaceAll('|', '\\|')} | ${icon[c.state]} | ${c.exit_code ?? ''} |`);
  return [
    `## Badgr verified run: ${result.verified ? 'VERIFIED' : 'NOT VERIFIED'}`,
    '',
    `Task: ${icon[result.task.state]}`,
    '',
    '| Check | Result | Exit code |',
    '|---|---|---|',
    ...rows,
    '',
    `Job: \`${jobId}\`${cost !== undefined && cost !== '' ? ` | Cost: $${cost}` : ''}`,
    runUrl ? `Evidence: ${runUrl}` : '',
    artifactUrl ? `Artifacts: ${artifactUrl}` : 'Artifacts: none produced',
  ].filter(l => l !== '').join('\n');
}
