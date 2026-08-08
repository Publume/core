import { appendFile } from 'node:fs/promises'

const githubApiVersion = '2026-03-10'

type WorkflowRun = {
  readonly id: number
  readonly createdAt: string
}

type GateOptions = {
  readonly repository: string
  readonly currentRunId: number
  readonly token: string
  readonly fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

function newestRun(runs: readonly WorkflowRun[], excludedId?: number): WorkflowRun | undefined {
  let newest: WorkflowRun | undefined
  for (const run of runs) {
    if (run.id === excludedId) continue
    if (!newest || Date.parse(run.createdAt) > Date.parse(newest.createdAt)) newest = run
  }
  return newest
}

export function shouldRunScheduledGeneration(
  scheduleRuns: readonly WorkflowRun[],
  successfulDispatchRuns: readonly WorkflowRun[],
  currentRunId: number,
): boolean {
  const latestDispatch = newestRun(successfulDispatchRuns)
  if (!latestDispatch) return true

  const previousSchedule = newestRun(scheduleRuns, currentRunId)
  if (!previousSchedule) return false
  return Date.parse(latestDispatch.createdAt) <= Date.parse(previousSchedule.createdAt)
}

function parseWorkflowRuns(value: unknown): WorkflowRun[] {
  if (!value || typeof value !== 'object' || !('workflow_runs' in value) || !Array.isArray(value.workflow_runs))
    throw new Error('GitHub returned an invalid workflow-runs response')

  return value.workflow_runs.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      !('id' in candidate) ||
      !('created_at' in candidate) ||
      typeof candidate.id !== 'number' ||
      !Number.isSafeInteger(candidate.id) ||
      typeof candidate.created_at !== 'string' ||
      !Number.isFinite(Date.parse(candidate.created_at))
    )
      throw new Error('GitHub returned an invalid workflow run')
    return { id: candidate.id, createdAt: candidate.created_at }
  })
}

async function workflowRuns(
  options: GateOptions,
  workflow: string,
  parameters: Readonly<Record<string, string>>,
): Promise<WorkflowRun[]> {
  const [owner, repository, extra] = options.repository.split('/')
  if (!owner || !repository || extra) throw new Error('GITHUB_REPOSITORY must use owner/repository format')
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/workflows/${encodeURIComponent(workflow)}/runs`,
  )
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value)

  const response = await (options.fetchFn ?? fetch)(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${options.token}`,
      'User-Agent': 'publume-schedule-gate',
      'X-GitHub-Api-Version': githubApiVersion,
    },
  })
  if (!response.ok) throw new Error(`GitHub workflow-runs request failed with status ${response.status}`)
  return parseWorkflowRuns(await response.json())
}

export async function checkScheduledGeneration(options: GateOptions): Promise<boolean> {
  const [scheduleRuns, dispatchRuns] = await Promise.all([
    workflowRuns(options, 'schedule.yml', { event: 'schedule', per_page: '10' }),
    workflowRuns(options, 'generate.yml', { event: 'repository_dispatch', status: 'success', per_page: '10' }),
  ])
  return shouldRunScheduledGeneration(scheduleRuns, dispatchRuns, options.currentRunId)
}

async function main(): Promise<void> {
  let shouldRun = true
  try {
    const currentRunId = Number(Bun.env.GITHUB_RUN_ID)
    if (!Number.isSafeInteger(currentRunId) || currentRunId < 1) throw new Error('GITHUB_RUN_ID is required')
    if (!Bun.env.GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY is required')
    if (!Bun.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required')

    shouldRun = await checkScheduledGeneration({
      repository: Bun.env.GITHUB_REPOSITORY,
      currentRunId,
      token: Bun.env.GITHUB_TOKEN,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Schedule coverage check failed; Core will run: ${message}`)
  }

  if (!Bun.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required')
  await appendFile(Bun.env.GITHUB_OUTPUT, `should_run=${shouldRun}\n`, 'utf8')
  console.log(
    shouldRun
      ? 'No newer successful repository dispatch was found.'
      : 'A newer repository dispatch succeeded; skipping Core.',
  )
}

if (import.meta.main) await main()
