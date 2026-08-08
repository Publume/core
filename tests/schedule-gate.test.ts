import { describe, expect, test } from 'bun:test'
import { checkScheduledGeneration, shouldRunScheduledGeneration } from '../scripts/schedule-gate'

const run = (id: number, createdAt: string) => ({ id, createdAt })

describe('scheduled generation gate', () => {
  test('skips when a successful dispatch is newer than the previous schedule', () => {
    expect(
      shouldRunScheduledGeneration(
        [run(3, '2026-08-10T00:00:00Z'), run(1, '2026-08-09T00:00:00Z')],
        [run(2, '2026-08-09T23:50:00Z')],
        3,
      ),
    ).toBe(false)
  })

  test('runs when the latest successful dispatch was already covered', () => {
    expect(
      shouldRunScheduledGeneration(
        [run(4, '2026-08-11T00:00:00Z'), run(3, '2026-08-10T00:00:00Z')],
        [run(2, '2026-08-09T23:50:00Z')],
        4,
      ),
    ).toBe(true)
  })

  test('runs when no successful dispatch exists', () => {
    expect(shouldRunScheduledGeneration([run(1, '2026-08-10T00:00:00Z')], [], 1)).toBe(true)
  })

  test('lets a dispatch cover the first scheduled run', () => {
    expect(shouldRunScheduledGeneration([run(2, '2026-08-10T00:00:00Z')], [run(1, '2026-08-09T23:50:00Z')], 2)).toBe(
      false,
    )
  })

  test('queries successful dispatch and schedule history from their owning workflows', async () => {
    const requests: URL[] = []
    const fetchFn = async (input: string | URL | Request) => {
      const url = new URL(String(input))
      requests.push(url)
      const workflowRuns = url.pathname.endsWith('/schedule.yml/runs')
        ? [
            { id: 3, created_at: '2026-08-10T00:00:00Z' },
            { id: 1, created_at: '2026-08-09T00:00:00Z' },
          ]
        : [{ id: 2, created_at: '2026-08-09T23:50:00Z' }]
      return new Response(JSON.stringify({ workflow_runs: workflowRuns }))
    }

    expect(
      await checkScheduledGeneration({
        repository: 'owner/core',
        currentRunId: 3,
        token: 'test-token',
        fetchFn,
      }),
    ).toBe(false)
    expect(requests.map((url) => `${url.pathname}?${url.searchParams.toString()}`)).toEqual([
      '/repos/owner/core/actions/workflows/schedule.yml/runs?event=schedule&per_page=10',
      '/repos/owner/core/actions/workflows/generate.yml/runs?event=repository_dispatch&status=success&per_page=10',
    ])
  })
})
