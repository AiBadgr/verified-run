# Badgr Verified Run

Run a coding task on Badgr, then verify it with your own checks. The Action returns per-check results, logs, cost and artifacts, under hard cost and runtime caps.

```yaml
- uses: aibadgr/verified-run@v1
  with:
    task: npx some-agent --fix-failing-tests
    checks: |
      [unit] npm test
      [lint] npm run lint
      npm run build
    max-cost: 2
    max-runtime: 30
  env:
    BADGR_API_KEY: ${{ secrets.BADGR_API_KEY }}
```

## What "verified" means

The remote job runs `task` (optional), then each check, and prints an exit marker after each one. `verified` is `true` only when the job finished, the task did not fail, and **every** check printed a passing marker. A check with no marker (job killed, timed out, logs cut off) is reported `unverified`, never `passed`. At least one check is required.

## Launch mode (agent jobs)

Set `agent` to run the task as a Badgr agent job (`POST /v1/jobs`, type `agent`) instead of a command: `task` becomes the agent's instruction, and all `checks` are joined with `&&` into the job's verification command.

```yaml
- uses: aibadgr/verified-run@v1
  with:
    agent: claude
    task: Fix the failing tests without changing their assertions
    checks: |
      npm test
      npm run lint
    max-cost: 3
    max-runtime: 30
  env:
    BADGR_API_KEY: ${{ secrets.BADGR_API_KEY }}
```

`verified` is `true` when the agent job finishes `completed` or `succeeded`. Because the job is verified by one combined command, per-check exit codes are not available in this mode: every check shares the job's result. The `receipt` output holds the job's receipt JSON, and `cost` its accrued cost. Artifacts are not returned in this mode. Supported agents: `claude`, `codex`, `cline`, `opencode`, `commandcode`, `playwright`, subject to which are enabled on the Badgr side.

## Inputs

| Input | Required | Description |
|---|---|---|
| `checks` | yes | One command per line. Prefix with `[name]` to name it. |
| `max-cost` | yes | Hard cost cap in USD. |
| `task` | no | Command that does the work. Leave empty to only verify. |
| `agent` | no | Launch mode: run the task as a Badgr agent job. |
| `max-runtime` | no | Minutes, default 60. |
| `resource` | no | `cpu` (default) or `gpu`. |
| `source`, `ref` | no | Default to the triggering repository and commit. |
| `github-token` | no | For private repositories. |

## Outputs

`verified`, `checks` (JSON: name, command, exit_code, state), `receipt` (launch mode), `job-id`, `status`, `cost`, `run-url`, `artifact-url` (empty when the job produced none). A summary table is written to the job summary. The step fails when the run is not verified.

## Behavior notes

- If the Action loses contact with the job while waiting, it cancels the job so nothing keeps billing.
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the step env are forwarded to the remote job; all secrets are masked in logs.
- The task and checks run on Badgr, not on the GitHub runner. They see the repository at `ref`, not uncommitted runner state.
- Artifacts come from the existing job artifact endpoint and expire per Badgr's retention.

## Publishing

This folder is the source for the public `aibadgr/verified-run` repo. Its `contract.js` and `runtime.js` are one-line shims that re-export `packages/badgr-run-action`, so that code exists once. Run `scripts/export-badgr-verified-run.sh [out-dir]` to build the self-contained tree: it copies the real shared files over the shims and refuses to finish if a shim slips through. Creating the repo, tagging `v1` and selecting the Marketplace listing are manual steps. `private: true` in `package.json` only prevents an accidental npm publish.
