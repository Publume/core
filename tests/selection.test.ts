import { describe, expect, it } from 'bun:test'
import type { Candidate } from '../src/domain/content'
import { candidateReports } from '../src/domain/content'
import { selectAdmittedCandidates, selectCandidates } from '../src/domain/selection'

function candidate(sourceId: string, externalId: string, canonicalUrl: string, publishedAt: string): Candidate {
  return {
    sourceId,
    externalId,
    canonicalUrl,
    title: externalId,
    content: `${externalId} discovery summary`,
    publishedAt,
    contentOrigin: 'source-summary',
  }
}

describe('candidate admission', () => {
  it('merges the same canonical URL before evidence fetching', () => {
    const sharedUrl = 'https://news.example/story'
    const selected = selectCandidates(
      [
        candidate('source-a', 'a-1', sharedUrl, '2026-08-08T10:00:00.000Z'),
        candidate('source-b', 'b-1', sharedUrl, '2026-08-08T10:01:00.000Z'),
      ],
      new Map([
        ['source-a', 'https://a.example/feed'],
        ['source-b', 'https://b.example/feed'],
      ]),
      {},
      new Set(),
      'config',
      { maxItemAgeHours: 24, maxCandidatesPerRun: 10 },
      new Date('2026-08-08T11:00:00.000Z'),
    )

    expect(selected.candidatePool).toHaveLength(1)
    const merged = selected.candidatePool[0]
    expect(merged).toBeDefined()
    if (!merged) throw new Error('Expected one merged candidate')
    expect(candidateReports(merged)).toHaveLength(2)
  })

  it('keeps source and category diversity when admission scores compete', () => {
    const candidates = [
      candidate('source-a', 'a-1', 'https://a.example/1', '2026-08-08T10:03:00.000Z'),
      candidate('source-a', 'a-2', 'https://a.example/2', '2026-08-08T10:02:00.000Z'),
      candidate('source-b', 'b-1', 'https://b.example/1', '2026-08-08T10:01:00.000Z'),
    ]
    const selected = selectAdmittedCandidates(
      candidates,
      [
        { index: 0, score: 0.99, category: 'Security', reason: 'High value' },
        { index: 1, score: 0.98, category: 'Security', reason: 'High value' },
        { index: 2, score: 0.8, category: 'Policy', reason: 'Distinct source and topic' },
      ],
      2,
    )

    expect(selected.map(({ externalId }) => externalId)).toEqual(['a-1', 'b-1'])
  })
})
